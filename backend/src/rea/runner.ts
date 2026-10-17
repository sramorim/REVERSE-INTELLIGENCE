import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { TailBuffer } from '../util/common.js';

/**
 * Executes REA CLI commands as isolated child processes.
 *
 * Safety properties:
 *  - Only commands from ALLOWED_COMMANDS can run; arguments are passed as an
 *    argv array (never through a shell).
 *  - The environment is rebuilt from scratch: no credentials or proxy settings
 *    of the backend leak into the analysis process.
 *  - Optional network namespace isolation (`unshare --net`) removes network
 *    access from REA and the engines it launches.
 *  - prlimit caps open files, output file size and disables core dumps; heap
 *    limits are applied to Node.js and Java.
 *  - A wall-clock timeout and cancellation kill the whole process group.
 */

/** Static, non-executing REA commands this backend may run. */
export const ALLOWED_COMMANDS = new Set([
  'inspect-artifact',
  'extract-artifact',
  'analyze-javascript-application',
  'inspect-electron-fuses',
  'inspect-android-package',
  'search-android-classes',
  'inspect-android-class',
  'inspect-android-method',
  'trace-android-references',
  'identify-flutter-build',
  'inspect-managed-artifact',
  'inspect-managed-members',
  'inspect-managed-native-boundaries',
  'inspect-go-binary',
  'inspect-rust-binary',
  'inspect-pe-resources',
  'inspect-sqlite-database',
  'inspect-analysis-view',
  'capabilities',
  'doctor',
]);

export interface ReaProgress {
  phase: string;
  completed: number;
  total: number;
  message: string;
}

export interface RunOptions {
  command: string;
  args: string[];
  /** Working directory; also hosts HOME and TMPDIR for the child. */
  workDir: string;
  /** stdout is streamed to this file (evidence can be hundreds of MB). */
  outputPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReaProgress) => void;
  /** Allow network inside the child (only needed by `doctor`). */
  allowNetwork?: boolean;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  outputBytes: number;
  outputSha256: string;
  stderrTail: string;
  outputLimitExceeded: boolean;
}

export interface SandboxInfo {
  mode: 'netns' | 'none';
  prlimit: boolean;
  detail: string;
}

const require = createRequire(import.meta.url);

export function resolveReaEntrypoint(): string {
  const pkgJson = require.resolve('rea-agents/package.json');
  return path.join(path.dirname(pkgJson), 'scripts', 'rea.mjs');
}

export function reaPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(require.resolve('rea-agents/package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export function detectSandbox(config: Config): SandboxInfo {
  const prlimit = spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0;
  if (config.sandbox === 'none') {
    return { mode: 'none', prlimit, detail: 'Isolamento de rede desativado por configuração (RI_SANDBOX=none).' };
  }
  const probe = spawnSync('unshare', ['--net', '--map-root-user', 'true'], { stdio: 'ignore', timeout: 5000 });
  if (probe.status === 0) {
    return { mode: 'netns', prlimit, detail: 'Análises executam em namespace de rede vazio (sem acesso à rede).' };
  }
  if (config.sandbox === 'netns') {
    throw new Error('RI_SANDBOX=netns requested but `unshare --net --map-root-user` is not permitted on this host.');
  }
  return {
    mode: 'none',
    prlimit,
    detail: 'Namespaces de usuário indisponíveis; análises executam sem isolamento de rede. Use o contêiner Docker para isolamento.',
  };
}

export class ReaRunner {
  readonly entrypoint = resolveReaEntrypoint();
  readonly version = reaPackageVersion();

  constructor(
    private readonly config: Config,
    readonly sandbox: SandboxInfo,
  ) {}

  private buildEnv(workDir: string): NodeJS.ProcessEnv {
    const home = path.join(workDir, 'home');
    const tmp = path.join(workDir, 'tmp');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      NODE_OPTIONS: `--max-old-space-size=${this.config.reaNodeHeapMb}`,
      JAVA_TOOL_OPTIONS: `-Xmx${this.config.javaHeapMb}m -Djava.io.tmpdir=${tmp}`,
      REA_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    };
    if (this.config.jadxJarPath) env.REA_JADX_MCP_JAR = this.config.jadxJarPath;
    if (this.config.javaHome) env.JAVA_HOME = this.config.javaHome;
    return env;
  }

  run(options: RunOptions): Promise<RunResult> {
    if (!ALLOWED_COMMANDS.has(options.command)) {
      return Promise.reject(new Error(`REA command not allowed: ${options.command}`));
    }
    const reaArgv = [process.execPath, this.entrypoint, options.command, ...options.args, '--json'];
    let argv = reaArgv;
    if (this.sandbox.prlimit) {
      argv = [
        'prlimit',
        '--nofile=8192',
        '--core=0',
        `--fsize=${this.config.maxEvidenceBytes}`,
        '--',
        ...argv,
      ];
    }
    if (this.sandbox.mode === 'netns' && !options.allowNetwork) {
      argv = ['unshare', '--net', '--map-root-user', '--', ...argv];
    }

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const out = fs.createWriteStream(options.outputPath, { mode: 0o600 });
      const hash = crypto.createHash('sha256');
      const stderrTail = new TailBuffer(64 * 1024);
      let outputBytes = 0;
      let outputLimitExceeded = false;
      let timedOut = false;
      let cancelled = false;
      let stderrLine = '';

      const child = spawn(argv[0], argv.slice(1), {
        cwd: options.workDir,
        env: this.buildEnv(options.workDir),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
      };
      const terminate = () => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.config.maxEvidenceBytes) {
          if (!outputLimitExceeded) {
            outputLimitExceeded = true;
            terminate();
          }
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          child.stdout.pause();
          out.once('drain', () => child.stdout.resume());
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrLine += text;
        let newline: number;
        while ((newline = stderrLine.indexOf('\n')) >= 0) {
          const line = stderrLine.slice(0, newline).trim();
          stderrLine = stderrLine.slice(newline + 1);
          if (line.startsWith('{"rea_progress"')) {
            try {
              const parsed = JSON.parse(line) as { rea_progress: ReaProgress };
              options.onProgress?.(parsed.rea_progress);
              continue;
            } catch {
              /* fall through: keep as log text */
            }
          }
          if (line.length > 0) stderrTail.push(`${line}\n`);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        out.destroy();
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (stderrLine.trim()) stderrTail.push(stderrLine);
        out.end(() =>
          resolve({
            exitCode,
            signal,
            timedOut,
            cancelled,
            durationMs: Date.now() - started,
            outputBytes: Math.min(outputBytes, this.config.maxEvidenceBytes),
            outputSha256: hash.digest('hex'),
            stderrTail: stderrTail.toString(),
            outputLimitExceeded,
          }),
        );
      });
    });
  }
}

/** Structured REA failure as printed on stdout with exit status 1. */
export interface ReaError {
  code: string;
  category?: string;
  message: string;
  retryable?: boolean;
  remediation?: { action?: string };
  details?: Record<string, unknown>;
}

export function readJsonFile(filePath: string, maxBytes: number): unknown {
  const { size } = fs.statSync(filePath);
  if (size === 0) return null;
  if (size > maxBytes) {
    throw new Error(`Evidence file of ${size} bytes exceeds the in-memory parse limit (${maxBytes} bytes).`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function asReaError(value: unknown): ReaError | null {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value && !('evidence_id' in value)) {
    const v = value as ReaError;
    if (typeof v.code === 'string' && typeof v.message === 'string') return v;
  }
  return null;
}
