import path from 'node:path';
import os from 'node:os';

/**
 * Runtime configuration. Every value comes from the environment so that the
 * same build runs on a workstation, a server or inside a container.
 */
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** TLS key/cert. When both are set the server speaks HTTPS directly. */
  tlsKeyPath: string | null;
  tlsCertPath: string | null;
  /** Maximum accepted artifact size in bytes. */
  maxUploadBytes: number;
  /** Size of one resumable upload chunk accepted per request. */
  maxChunkBytes: number;
  /** Concurrent REA analyses. */
  workerConcurrency: number;
  /** Per REA command wall-clock timeout. */
  stepTimeoutMs: number;
  /** Maximum size of one REA evidence file written to disk. */
  maxEvidenceBytes: number;
  /** Evidence larger than this is not parsed in memory for normalization. */
  maxParseBytes: number;
  /** Heap limit for the REA Node.js process (MiB). */
  reaNodeHeapMb: number;
  /** Heap limit for Java engines launched by REA, e.g. JADX (MiB). */
  javaHeapMb: number;
  /** Sandbox mode for REA processes: auto | netns | none. */
  sandbox: 'auto' | 'netns' | 'none';
  jadxJarPath: string | null;
  javaHome: string | null;
  /** Trust X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
  logLevel: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function strEnv(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const sandboxRaw = (process.env.RI_SANDBOX ?? 'auto').toLowerCase();
  if (!['auto', 'netns', 'none'].includes(sandboxRaw)) {
    throw new Error(`RI_SANDBOX must be auto, netns or none, got "${sandboxRaw}"`);
  }
  const base: Config = {
    host: process.env.RI_HOST ?? '127.0.0.1',
    port: intEnv('RI_PORT', 8787),
    dataDir: path.resolve(process.env.RI_DATA_DIR ?? path.join(process.cwd(), 'data')),
    tlsKeyPath: strEnv('RI_TLS_KEY'),
    tlsCertPath: strEnv('RI_TLS_CERT'),
    maxUploadBytes: intEnv('RI_MAX_UPLOAD_MB', 1024) * 1024 * 1024,
    maxChunkBytes: intEnv('RI_MAX_CHUNK_MB', 8) * 1024 * 1024,
    workerConcurrency: intEnv('RI_WORKERS', Math.max(1, Math.min(2, os.cpus().length - 1))),
    stepTimeoutMs: intEnv('RI_STEP_TIMEOUT_S', 900) * 1000,
    maxEvidenceBytes: intEnv('RI_MAX_EVIDENCE_MB', 2048) * 1024 * 1024,
    maxParseBytes: intEnv('RI_MAX_PARSE_MB', 256) * 1024 * 1024,
    reaNodeHeapMb: intEnv('RI_REA_HEAP_MB', 4096),
    javaHeapMb: intEnv('RI_JAVA_HEAP_MB', 3072),
    sandbox: sandboxRaw as Config['sandbox'],
    jadxJarPath: strEnv('REA_JADX_MCP_JAR'),
    javaHome: strEnv('JAVA_HOME'),
    trustProxy: process.env.RI_TRUST_PROXY === '1',
    logLevel: process.env.RI_LOG_LEVEL ?? 'info',
  };
  return { ...base, ...overrides };
}
