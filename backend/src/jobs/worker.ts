import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { nowIso, type Db } from '../db.js';
import type { Storage } from '../storage.js';
import { newId } from '../util/common.js';
import { asReaError, readJsonFile, type ReaRunner, type RunResult } from '../rea/runner.js';
import type { CapabilityProbe } from '../rea/capabilities.js';
import { profileById, type Profile, type StepSpec } from '../rea/profiles.js';
import { normalizeEvidence } from '../rea/normalize.js';
import { assembleResult } from '../rea/assemble.js';
import type { Contribution, StepOutcome, StepStatus } from '../rea/model.js';

export interface AnalysisRow {
  id: string;
  project_id: string;
  artifact_id: string;
  profile: string;
  status: string;
  progress: number;
  phase: string;
  message: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  rea_version: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_path: string | null;
  counts: string;
}

export interface StepRow {
  id: string;
  analysis_id: string;
  ordinal: number;
  step_key: string;
  title: string;
  command: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  evidence_path: string | null;
  evidence_bytes: number | null;
  evidence_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  skip_reason: string | null;
}

interface ArtifactRow {
  id: string;
  file_name: string;
  size: number;
  sha256: string;
  kind: string;
  kind_detail: string;
  storage_path: string;
}

const EXTRACT_STEP: Pick<StepSpec, 'key' | 'title' | 'command'> = {
  key: 'extract',
  title: 'Extração segura do pacote',
  command: 'extract-artifact',
};

export const MAX_ATTEMPTS = 2;

/** Creates the analysis row and its planned steps (visible to clients immediately). */
export function createAnalysis(db: Db, args: { projectId: string; artifactId: string; profile: Profile }): string {
  const id = newId('ana');
  const created = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO analyses (id, project_id, artifact_id, profile, status, phase, message, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'queued', 'Aguardando execução', ?)`,
    ).run(id, args.projectId, args.artifactId, args.profile.id, created);
    const planned = [...(args.profile.extract ? [EXTRACT_STEP] : []), ...args.profile.steps];
    planned.forEach((step, i) => {
      db.prepare(
        `INSERT INTO analysis_steps (id, analysis_id, ordinal, step_key, title, command, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(newId('stp'), id, i, step.key, step.title, step.command);
    });
    db.prepare('INSERT INTO analysis_events (analysis_id, ts, level, message) VALUES (?, ?, ?, ?)').run(
      id,
      created,
      'info',
      `Análise criada com o perfil "${args.profile.title}".`,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return id;
}

export class AnalysisWorker {
  private running = new Map<string, AbortController>();
  private stopped = false;
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly runner: ReaRunner,
    private readonly capabilities: CapabilityProbe,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Requeues analyses interrupted by a previous shutdown. */
  recover(): void {
    const rows = this.db.prepare("SELECT id, attempts FROM analyses WHERE status = 'running'").all() as {
      id: string;
      attempts: number;
    }[];
    for (const row of rows) {
      if (row.attempts < MAX_ATTEMPTS) {
        this.db.prepare("UPDATE analyses SET status = 'queued', phase = 'queued', message = 'Retomada após reinício do servidor' WHERE id = ?").run(row.id);
        this.db.prepare("UPDATE analysis_steps SET status = 'pending', started_at = NULL WHERE analysis_id = ? AND status = 'running'").run(row.id);
        this.event(row.id, 'warn', 'O servidor foi reiniciado durante a execução; a análise foi recolocada na fila.');
      } else {
        this.finishWithError(row.id, 'interrupted', 'Execução interrompida repetidamente por reinício do servidor.');
      }
    }
  }

  start(): void {
    this.stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const controller of this.running.values()) controller.abort();
  }

  activeCount(): number {
    return this.running.size;
  }

  cancel(analysisId: string): boolean {
    const controller = this.running.get(analysisId);
    if (controller) {
      controller.abort();
      return true;
    }
    const result = this.db
      .prepare("UPDATE analyses SET status = 'cancelled', phase = 'cancelled', message = 'Cancelada antes de iniciar', finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso(), analysisId);
    if (Number(result.changes) > 0) {
      this.db.prepare("UPDATE analysis_steps SET status = 'cancelled' WHERE analysis_id = ? AND status = 'pending'").run(analysisId);
      this.event(analysisId, 'warn', 'Análise cancelada pelo usuário antes de iniciar.');
      return true;
    }
    return false;
  }

  wake(): void {
    if (this.stopped) return;
    while (this.running.size < this.config.workerConcurrency) {
      const next = this.db
        .prepare("SELECT id FROM analyses WHERE status = 'queued' ORDER BY created_at LIMIT 1 OFFSET ?")
        .get(0) as { id: string } | undefined;
      if (!next) break;
      const claimed = this.db
        .prepare("UPDATE analyses SET status = 'running', started_at = ?, attempts = attempts + 1, phase = 'starting', message = 'Iniciando' WHERE id = ? AND status = 'queued'")
        .run(nowIso(), next.id);
      if (Number(claimed.changes) === 0) continue;
      const controller = new AbortController();
      this.running.set(next.id, controller);
      void this.execute(next.id, controller.signal)
        .catch((error) => {
          this.log.error({ err: error, analysisId: next.id }, 'analysis crashed');
          this.finishWithError(next.id, 'internal_error', `Falha interna do backend: ${(error as Error).message}`);
        })
        .finally(() => {
          this.running.delete(next.id);
          this.wake();
        });
    }
  }

  private event(analysisId: string, level: 'info' | 'warn' | 'error', message: string): void {
    this.db.prepare('INSERT INTO analysis_events (analysis_id, ts, level, message) VALUES (?, ?, ?, ?)').run(analysisId, nowIso(), level, message.slice(0, 4000));
  }

  private setProgress(analysisId: string, progress: number, phase: string, message: string): void {
    this.db
      .prepare('UPDATE analyses SET progress = ?, phase = ?, message = ? WHERE id = ?')
      .run(Math.max(0, Math.min(1, progress)), phase, message.slice(0, 500), analysisId);
  }

  private finishWithError(analysisId: string, code: string, message: string): void {
    this.db
      .prepare("UPDATE analyses SET status = 'failed', phase = 'failed', error_code = ?, error_message = ?, message = ?, finished_at = ? WHERE id = ?")
      .run(code, message, message.slice(0, 500), nowIso(), analysisId);
    this.db.prepare("UPDATE analysis_steps SET status = 'cancelled' WHERE analysis_id = ? AND status IN ('pending','running')").run(analysisId);
    this.event(analysisId, 'error', message);
  }

  private updateStep(stepId: string, fields: Partial<StepRow>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sql = `UPDATE analysis_steps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...(keys.map((k) => (fields as Record<string, unknown>)[k]) as (string | number | null)[]), stepId);
  }

  private async execute(analysisId: string, signal: AbortSignal): Promise<void> {
    const analysis = this.db.prepare('SELECT * FROM analyses WHERE id = ?').get(analysisId) as unknown as AnalysisRow;
    const artifact = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(analysis.artifact_id) as unknown as ArtifactRow | undefined;
    const project = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(analysis.project_id) as { name: string } | undefined;
    const profile = profileById(analysis.profile);
    if (!artifact || !profile || !project) {
      this.finishWithError(analysisId, 'invalid_state', 'Artefato, projeto ou perfil não encontrado para esta análise.');
      return;
    }
    if (!fs.existsSync(artifact.storage_path)) {
      this.finishWithError(analysisId, 'artifact_missing', 'O arquivo do artefato não está mais disponível no servidor.');
      return;
    }

    const caps = await this.capabilities.get();
    const reqStatus = new Map(caps.requirements.map((r) => [r.id, r]));
    const workDir = this.storage.workDir(analysisId);
    const stepsDir = this.storage.stepsDir(analysisId);
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stepsDir, { recursive: true, mode: 0o700 });
    this.db.prepare('UPDATE analyses SET rea_version = ? WHERE id = ?').run(this.runner.version, analysisId);
    this.event(analysisId, 'info', `Execução iniciada (REA ${this.runner.version}, isolamento: ${this.runner.sandbox.mode}).`);

    const stepRows = this.db.prepare('SELECT * FROM analysis_steps WHERE analysis_id = ? ORDER BY ordinal').all(analysisId) as unknown as StepRow[];
    const specByKey = new Map(profile.steps.map((s) => [s.key, s]));
    const contributions: { stepKey: string; contribution: Contribution }[] = [];
    const extraLimitations: { source: string; text: string }[] = [];
    let extractedRoot: string | null = null;
    let cancelled = false;
    let lastProgressWrite = 0;

    for (let index = 0; index < stepRows.length; index += 1) {
      const row = stepRows[index];
      if (row.status !== 'pending') continue;
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const base = index / stepRows.length;
      const span = 1 / stepRows.length;
      const isExtract = row.step_key === EXTRACT_STEP.key;
      const spec = specByKey.get(row.step_key);

      // Requirement / applicability checks produce explicit skips, never silent omissions.
      if (spec) {
        const missing = (spec.requires ?? []).map((r) => reqStatus.get(r)).filter((r) => r && !r.available);
        if (missing.length > 0) {
          const reason = missing.map((m) => m!.detail).join(' ');
          this.updateStep(row.id, { status: 'skipped', skip_reason: reason, finished_at: nowIso() });
          this.event(analysisId, 'warn', `Etapa "${row.title}" não executada: ${reason}`);
          continue;
        }
        if (spec.appliesTo && !spec.appliesTo(artifact.kind_detail)) {
          this.updateStep(row.id, { status: 'skipped', skip_reason: 'Não se aplica a este formato.', finished_at: nowIso() });
          continue;
        }
        if (spec.input === 'extracted-root' && !extractedRoot) {
          this.updateStep(row.id, { status: 'skipped', skip_reason: 'Depende da extração do pacote, que não foi concluída.', finished_at: nowIso() });
          this.event(analysisId, 'warn', `Etapa "${row.title}" não executada: extração indisponível.`);
          continue;
        }
      }

      const target = spec?.input === 'extracted-root' ? extractedRoot! : artifact.storage_path;
      const args = isExtract ? [artifact.storage_path] : spec!.args(target);
      const outputPath = path.join(stepsDir, `${String(row.ordinal).padStart(2, '0')}-${row.step_key}.json`);
      this.updateStep(row.id, { status: 'running', started_at: nowIso() });
      this.setProgress(analysisId, base, row.step_key, row.title);
      this.event(analysisId, 'info', `Etapa iniciada: ${row.title} (rea ${row.command}).`);

      let result: RunResult;
      try {
        result = await this.runner.run({
          command: row.command,
          args,
          workDir,
          outputPath,
          timeoutMs: this.config.stepTimeoutMs,
          signal,
          onProgress: (p) => {
            const now = Date.now();
            if (now - lastProgressWrite < 500) return;
            lastProgressWrite = now;
            const fraction = p.total > 0 ? Math.min(1, p.completed / p.total) : 0;
            this.setProgress(analysisId, base + span * Math.min(0.95, fraction), row.step_key, `${row.title}: ${p.message}`);
          },
        });
      } catch (error) {
        this.updateStep(row.id, { status: 'failed', error_code: 'spawn_failed', error_message: (error as Error).message, finished_at: nowIso() });
        this.event(analysisId, 'error', `Não foi possível iniciar o REA: ${(error as Error).message}`);
        continue;
      }

      const common = {
        finished_at: nowIso(),
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        evidence_path: outputPath,
        evidence_bytes: result.outputBytes,
        evidence_sha256: result.outputSha256,
      };
      if (result.cancelled) {
        this.updateStep(row.id, { ...common, status: 'cancelled' });
        cancelled = true;
        break;
      }
      if (result.timedOut || result.outputLimitExceeded) {
        const message = result.timedOut
          ? `Tempo limite de ${Math.round(this.config.stepTimeoutMs / 1000)} s excedido.`
          : 'A Evidence excedeu o tamanho máximo configurado (RI_MAX_EVIDENCE_MB).';
        this.updateStep(row.id, { ...common, status: 'failed', error_code: result.timedOut ? 'timeout' : 'output_limit', error_message: message });
        this.event(analysisId, 'error', `${row.title}: ${message}`);
        continue;
      }

      let parsed: unknown = null;
      let parseError: string | null = null;
      try {
        parsed = readJsonFile(outputPath, this.config.maxParseBytes);
      } catch (error) {
        parseError = (error as Error).message;
      }

      if (result.exitCode !== 0) {
        const reaError = asReaError(parsed);
        const message = reaError
          ? `${reaError.message}${reaError.remediation?.action && reaError.remediation.action !== reaError.message ? ` ${reaError.remediation.action}` : ''}${reaError.details?.reason ? ` (${String(reaError.details.reason)})` : ''}`
          : `REA terminou com status ${result.exitCode ?? result.signal}. ${result.stderrTail.slice(-600)}`;
        this.updateStep(row.id, { ...common, status: 'failed', error_code: reaError?.code ?? 'rea_failed', error_message: message.slice(0, 4000) });
        this.event(analysisId, 'error', `${row.title}: ${message}`);
        continue;
      }

      if (isExtract) {
        const nr = (parsed as { normalized_result?: { output_root?: string; containment_verified?: boolean } } | null)?.normalized_result;
        if (!nr?.output_root || nr.containment_verified !== true || !path.resolve(nr.output_root).startsWith(path.resolve(workDir))) {
          this.updateStep(row.id, { ...common, status: 'failed', error_code: 'extraction_unverified', error_message: 'A extração não confirmou contenção dentro do diretório de trabalho.' });
          this.event(analysisId, 'error', 'Extração rejeitada: contenção não verificada.');
          continue;
        }
        extractedRoot = findApplicationRoot(nr.output_root);
        this.updateStep(row.id, { ...common, status: 'succeeded' });
        this.event(analysisId, 'info', `Pacote extraído; raiz da aplicação: ${path.relative(nr.output_root, extractedRoot) || '.'}`);
        continue;
      }

      if (parseError) {
        extraLimitations.push({
          source: row.step_key,
          text: `A Evidence desta etapa (${result.outputBytes} bytes) não foi normalizada em memória: ${parseError} O arquivo bruto está disponível para download.`,
        });
      } else {
        try {
          contributions.push({ stepKey: row.step_key, contribution: normalizeEvidence(row.command, row.step_key, parsed, { kind: artifact.kind }) });
        } catch (error) {
          extraLimitations.push({ source: row.step_key, text: `Falha ao normalizar a Evidence: ${(error as Error).message}. A Evidence bruta permanece disponível.` });
        }
      }
      this.updateStep(row.id, { ...common, status: 'succeeded' });
      this.event(analysisId, 'info', `Etapa concluída: ${row.title} (${(result.durationMs / 1000).toFixed(1)} s).`);
    }

    // Scratch space can hold full extracted copies of the target; remove it.
    this.storage.removeTree(workDir);

    const finalSteps = this.db.prepare('SELECT * FROM analysis_steps WHERE analysis_id = ? ORDER BY ordinal').all(analysisId) as unknown as StepRow[];
    if (cancelled) {
      this.db.prepare("UPDATE analysis_steps SET status = 'cancelled' WHERE analysis_id = ? AND status IN ('pending','running')").run(analysisId);
    }
    const succeeded = finalSteps.filter((s) => s.status === 'succeeded').length;
    const failed = finalSteps.filter((s) => s.status === 'failed');
    const requiredSkipped = finalSteps.filter(
      (s) => s.status === 'skipped' && specByKey.get(s.step_key) && !specByKey.get(s.step_key)!.optional && s.skip_reason !== 'Não se aplica a este formato.',
    );
    const requiredFailed = failed.filter((s) => !specByKey.get(s.step_key)?.optional);

    let status: string;
    let message: string;
    if (cancelled) {
      status = 'cancelled';
      message = 'Cancelada pelo usuário.';
    } else if (succeeded === 0) {
      status = 'failed';
      message = failed[0]?.error_message ?? 'Nenhuma etapa pôde ser concluída.';
    } else if (requiredFailed.length > 0 || requiredSkipped.length > 0 || failed.length > 0) {
      status = 'partial';
      message = `Concluída parcialmente: ${succeeded} etapa(s) concluída(s), ${failed.length} com falha, ${requiredSkipped.length} essencial(is) não executada(s).`;
    } else {
      status = 'succeeded';
      message = `Concluída: ${succeeded} etapa(s).`;
    }

    const outcomes: StepOutcome[] = (this.db.prepare('SELECT * FROM analysis_steps WHERE analysis_id = ? ORDER BY ordinal').all(analysisId) as unknown as StepRow[]).map(toOutcome);
    let resultPath: string | null = null;
    let counts = '{}';
    if (succeeded > 0) {
      const assembled = assembleResult({
        analysisId,
        projectId: analysis.project_id,
        projectName: project.name,
        status,
        profile: { id: profile.id, title: profile.title },
        target: { fileName: artifact.file_name, size: artifact.size, sha256: artifact.sha256, kind: artifact.kind, kindDetail: artifact.kind_detail },
        rea: { version: this.runner.version, sandbox: this.runner.sandbox.mode },
        steps: outcomes,
        contributions,
        extraLimitations,
      });
      resultPath = this.storage.resultPath(analysisId);
      fs.writeFileSync(resultPath, JSON.stringify(assembled), { mode: 0o600 });
      counts = JSON.stringify(assembled.counts);
    }
    const firstError = failed[0];
    this.db
      .prepare(
        `UPDATE analyses SET status = ?, phase = ?, progress = ?, message = ?, finished_at = ?, result_path = ?, counts = ?,
         error_code = ?, error_message = ? WHERE id = ?`,
      )
      .run(
        status,
        status,
        status === 'cancelled' ? analysis.progress : 1,
        message,
        nowIso(),
        resultPath,
        counts,
        status === 'succeeded' ? null : (firstError?.error_code ?? (cancelled ? 'cancelled' : null)),
        status === 'succeeded' ? null : (firstError?.error_message ?? null),
        analysisId,
      );
    this.event(analysisId, status === 'failed' ? 'error' : status === 'succeeded' ? 'info' : 'warn', message);
  }
}

export function toOutcome(s: StepRow): StepOutcome {
  return {
    key: s.step_key,
    title: s.title,
    command: s.command,
    status: s.status,
    durationMs: s.duration_ms,
    errorCode: s.error_code,
    errorMessage: s.error_message,
    skipReason: s.skip_reason,
    evidenceBytes: s.evidence_bytes,
    evidenceSha256: s.evidence_sha256,
  };
}

/** Picks the shallowest directory with a package.json (outside node_modules), else the root. */
export function findApplicationRoot(root: string): string {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (depth >= 3) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  // Without package.json, a single top-level directory is the application root.
  const top = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  if (top.length === 1 && top[0].isDirectory()) return path.join(root, top[0].name);
  return root;
}
