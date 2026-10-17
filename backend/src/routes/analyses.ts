import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso } from '../db.js';
import { ApiError, asObject, badRequest, newId, notFound, sha256Hex } from '../util/common.js';
import { createAnalysis, toOutcome, type AnalysisRow, type StepRow } from '../jobs/worker.js';
import { PROFILES, profileById, profileForKind } from '../rea/profiles.js';
import { asReaError, readJsonFile } from '../rea/runner.js';
import type { AnalysisResult } from '../rea/model.js';
import { renderHtmlReport } from '../reports/html.js';
import { renderPdfReport } from '../reports/pdf.js';
import { mapListRow } from './system.js';

const CLASS_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const METHOD_NAME = /^(<init>|<clinit>|[A-Za-z_$][\w$]*)$/;

export function registerAnalysisRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage } = ctx;

  const load = (id: string) => {
    const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as AnalysisRow | undefined;
    if (!row) throw notFound('Análise');
    return row;
  };
  const steps = (id: string) => db.prepare('SELECT * FROM analysis_steps WHERE analysis_id = ? ORDER BY ordinal').all(id) as unknown as StepRow[];
  const loadResult = (row: AnalysisRow): AnalysisResult => {
    if (!row.result_path || !fs.existsSync(row.result_path)) {
      throw new ApiError(409, 'result_unavailable', row.status === 'queued' || row.status === 'running' ? 'A análise ainda não terminou.' : 'Esta análise não produziu resultados.');
    }
    return JSON.parse(fs.readFileSync(row.result_path, 'utf8')) as AnalysisResult;
  };

  const detail = (row: AnalysisRow) => {
    const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(row.artifact_id) as any;
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(row.project_id) as any;
    const profile = profileById(row.profile);
    return {
      id: row.id,
      status: row.status,
      progress: row.progress,
      phase: row.phase,
      message: row.message,
      attempts: row.attempts,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      reaVersion: row.rea_version,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      hasResult: Boolean(row.result_path),
      counts: JSON.parse(row.counts || '{}'),
      profile: { id: row.profile, title: profile?.title ?? row.profile },
      project: { id: project.id, name: project.name },
      artifact: { id: artifact.id, fileName: artifact.file_name, size: artifact.size, sha256: artifact.sha256, kind: artifact.kind, kindDetail: artifact.kind_detail },
      steps: steps(row.id).map(toOutcome),
    };
  };

  app.get('/api/v1/profiles', async () => ({
    items: PROFILES.map((p) => ({ id: p.id, title: p.title, description: p.description, kinds: p.kinds, steps: p.steps.map((s) => ({ key: s.key, title: s.title, command: s.command })) })),
  }));

  app.post('/api/v1/analyses', async (request, reply) => {
    const body = asObject(request.body);
    const artifactId = typeof body.artifactId === 'string' ? body.artifactId : '';
    const artifact = db.prepare('SELECT id, project_id, kind FROM artifacts WHERE id = ?').get(artifactId) as { id: string; project_id: string; kind: string } | undefined;
    if (!artifact) throw notFound('Artefato');
    const profile = typeof body.profile === 'string' ? profileById(body.profile) : profileForKind(artifact.kind as never);
    if (!profile) throw badRequest('Perfil de análise desconhecido.');
    if (!profile.kinds.includes(artifact.kind as never) && profile.id !== 'generic-artifact') {
      throw badRequest(`O perfil "${profile.title}" não se aplica a este tipo de artefato (${artifact.kind}).`);
    }
    const id = createAnalysis(db, { projectId: artifact.project_id, artifactId: artifact.id, profile });
    ctx.worker.wake();
    reply.code(201);
    return detail(load(id));
  });

  app.get('/api/v1/analyses', async (request) => {
    const q = request.query as { projectId?: string; status?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const where: string[] = [];
    const params: string[] = [];
    if (q.projectId) {
      where.push('a.project_id = ?');
      params.push(q.projectId);
    }
    if (q.status) {
      const statuses = q.status.split(',').filter((s) => /^[a-z]+$/.test(s));
      if (statuses.length > 0) {
        where.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT a.*, p.name project_name, ar.file_name, ar.kind FROM analyses a JOIN projects p ON p.id = a.project_id
         JOIN artifacts ar ON ar.id = a.artifact_id ${clause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) n FROM analyses a ${clause}`).get(...params) as { n: number }).n;
    return { items: rows.map(mapListRow), total, limit, offset };
  });

  app.get('/api/v1/analyses/:id', async (request) => detail(load((request.params as { id: string }).id)));

  app.get('/api/v1/analyses/:id/events', async (request) => {
    const row = load((request.params as { id: string }).id);
    const after = Number((request.query as { after?: string }).after) || 0;
    const items = db.prepare('SELECT seq, ts, level, message FROM analysis_events WHERE analysis_id = ? AND seq > ? ORDER BY seq LIMIT 500').all(row.id, after);
    return { items };
  });

  app.get('/api/v1/analyses/:id/result', async (request) => loadResult(load((request.params as { id: string }).id)));

  app.post('/api/v1/analyses/:id/cancel', async (request) => {
    const row = load((request.params as { id: string }).id);
    if (row.status !== 'queued' && row.status !== 'running') throw new ApiError(409, 'not_active', 'A análise não está em andamento.');
    const ok = ctx.worker.cancel(row.id);
    return { cancelling: ok };
  });

  app.post('/api/v1/analyses/:id/rerun', async (request, reply) => {
    const row = load((request.params as { id: string }).id);
    const profile = profileById(row.profile)!;
    const id = createAnalysis(db, { projectId: row.project_id, artifactId: row.artifact_id, profile });
    ctx.worker.wake();
    reply.code(201);
    return detail(load(id));
  });

  app.delete('/api/v1/analyses/:id', async (request) => {
    const row = load((request.params as { id: string }).id);
    if (row.status === 'queued' || row.status === 'running') throw new ApiError(409, 'active', 'Cancele a análise antes de excluí-la.');
    db.prepare('DELETE FROM analyses WHERE id = ?').run(row.id);
    storage.removeTree(storage.analysisDir(row.id));
    return { deleted: true };
  });

  app.get('/api/v1/analyses/:id/steps/:key/evidence', async (request, reply) => {
    const { id, key } = request.params as { id: string; key: string };
    const step = steps(load(id).id).find((s) => s.step_key === key);
    if (!step?.evidence_path || !fs.existsSync(step.evidence_path)) throw notFound('Evidence');
    return sendFile(reply, step.evidence_path, `${id}-${key}-evidence.json`, 'application/json');
  });

  // ------------------------------------------------ Android exploration (on demand)

  let probeBusy = false;
  const runProbe = async (row: AnalysisRow, command: string, args: string[]) => {
    const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(row.artifact_id) as any;
    if (artifact.kind !== 'android-apk') throw badRequest('Exploração de classes está disponível apenas para APKs.');
    const caps = await ctx.capabilities.get();
    if (!caps.requirements.find((r) => r.id === 'jadx')?.available) {
      throw new ApiError(503, 'engine_unavailable', 'JADX não está configurado no servidor (REA_JADX_MCP_JAR).');
    }
    const cacheDir = path.join(storage.analysisDir(row.id), 'probes');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const cachePath = path.join(cacheDir, `${sha256Hex(JSON.stringify([command, ...args]))}.json`);
    if (fs.existsSync(cachePath)) return readJsonFile(cachePath, 64 * 1024 * 1024);
    if (probeBusy) throw new ApiError(429, 'probe_busy', 'Outra consulta ao decompilador está em andamento. Tente novamente em instantes.');
    probeBusy = true;
    const workDir = path.join(storage.probeDir(), newId('wrk'));
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const tmpOut = path.join(workDir, 'out.json');
    try {
      const result = await ctx.runner.run({ command, args: [artifact.storage_path, ...args], workDir, outputPath: tmpOut, timeoutMs: 180_000 });
      const parsed = readJsonFile(tmpOut, 64 * 1024 * 1024);
      if (result.exitCode !== 0) {
        const err = asReaError(parsed);
        throw new ApiError(422, err?.code ?? 'rea_failed', err?.message ?? (result.timedOut ? 'Tempo limite excedido.' : 'Falha do REA.'), err?.details as Record<string, unknown>);
      }
      fs.renameSync(tmpOut, cachePath);
      return parsed;
    } finally {
      probeBusy = false;
      storage.removeTree(workDir);
    }
  };

  app.get('/api/v1/analyses/:id/android/classes', async (request) => {
    const row = load((request.params as { id: string }).id);
    const q = request.query as { q?: string; offset?: string; limit?: string };
    const step = steps(row.id).find((s) => s.step_key === 'android-classes' && s.status === 'succeeded');
    if (!step?.evidence_path) throw new ApiError(409, 'inventory_unavailable', 'O inventário de classes não foi produzido nesta análise.');
    const evidence = readJsonFile(step.evidence_path, ctx.config.maxParseBytes) as { normalized_result?: { matches?: string[] } };
    const all = evidence.normalized_result?.matches ?? [];
    const needle = (q.q ?? '').toLowerCase();
    const filtered = needle ? all.filter((c) => c.toLowerCase().includes(needle)) : all;
    const offset = Math.max(Number(q.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
  });

  app.post('/api/v1/analyses/:id/android/class', async (request) => {
    const row = load((request.params as { id: string }).id);
    const body = asObject(request.body);
    const className = String(body.className ?? '');
    if (!CLASS_NAME.test(className) || className.length > 512) throw badRequest('Nome de classe inválido.');
    const evidence = (await runProbe(row, 'inspect-android-class', [className])) as { normalized_result?: unknown; limitations?: string[] };
    return { className, result: evidence.normalized_result, limitations: evidence.limitations ?? [], certainty: 'confirmed', basis: 'Inventário de membros do JADX (metadados DEX).' };
  });

  app.post('/api/v1/analyses/:id/android/method', async (request) => {
    const row = load((request.params as { id: string }).id);
    const body = asObject(request.body);
    const className = String(body.className ?? '');
    const methodName = String(body.methodName ?? '');
    const overload = body.overloadIndex;
    if (!CLASS_NAME.test(className) || !METHOD_NAME.test(methodName)) throw badRequest('Classe ou método inválido.');
    const args = [className, methodName];
    if (overload !== undefined && overload !== null) {
      if (typeof overload !== 'number' || !Number.isSafeInteger(overload) || overload < 0) throw badRequest('overloadIndex inválido.');
      args.push('--overload-index', String(overload));
    }
    const evidence = (await runProbe(row, 'inspect-android-method', args)) as { normalized_result?: unknown; limitations?: string[] };
    return {
      className,
      methodName,
      result: evidence.normalized_result,
      limitations: evidence.limitations ?? [],
      certainty: 'inferred',
      basis: 'Código decompilado pelo JADX: representação derivada, não o código-fonte original.',
    };
  });

  // ------------------------------------------------ reports

  const reportDto = (r: any) => ({ id: r.id, analysisId: r.analysis_id, format: r.format, size: r.size, sha256: r.sha256, createdAt: r.created_at });

  app.get('/api/v1/analyses/:id/reports', async (request) => {
    const row = load((request.params as { id: string }).id);
    return { items: db.prepare('SELECT * FROM reports WHERE analysis_id = ? ORDER BY created_at DESC').all(row.id).map(reportDto) };
  });

  app.post('/api/v1/analyses/:id/reports', async (request, reply) => {
    const row = load((request.params as { id: string }).id);
    const body = asObject(request.body);
    const format = String(body.format ?? '');
    if (!['html', 'json', 'pdf'].includes(format)) throw badRequest('Formato deve ser html, json ou pdf.');
    const result = loadResult(row);
    let content: Buffer;
    if (format === 'html') content = Buffer.from(renderHtmlReport(result), 'utf8');
    else if (format === 'pdf') content = await renderPdfReport(result);
    else {
      const provenance = steps(row.id).map((s) => ({ key: s.step_key, command: `rea ${s.command}`, status: s.status, evidenceSha256: s.evidence_sha256, evidenceBytes: s.evidence_bytes }));
      content = Buffer.from(JSON.stringify({ report: 'reverse-intelligence/analysis', ...result, provenance }, null, 2), 'utf8');
    }
    const dir = storage.reportsDir(row.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = newId('rep');
    const file = path.join(dir, `${id}.${format}`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    db.prepare('INSERT INTO reports (id, analysis_id, format, path, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, row.id, format, file, content.length, sha256Hex(content), nowIso());
    reply.code(201);
    return reportDto(db.prepare('SELECT * FROM reports WHERE id = ?').get(id));
  });

  app.get('/api/v1/reports/:id/download', async (request, reply) => {
    const r = db.prepare('SELECT r.*, a.file_name FROM reports r JOIN analyses an ON an.id = r.analysis_id JOIN artifacts a ON a.id = an.artifact_id WHERE r.id = ?').get((request.params as { id: string }).id) as any;
    if (!r || !fs.existsSync(r.path)) throw notFound('Relatório');
    const type = r.format === 'pdf' ? 'application/pdf' : r.format === 'html' ? 'text/html; charset=utf-8' : 'application/json';
    const base = String(r.file_name).replace(/[^\w.-]+/g, '_');
    return sendFile(reply, r.path, `relatorio-${base}.${r.format}`, type);
  });

  app.delete('/api/v1/reports/:id', async (request) => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get((request.params as { id: string }).id) as any;
    if (!r) throw notFound('Relatório');
    db.prepare('DELETE FROM reports WHERE id = ?').run(r.id);
    fs.rmSync(r.path, { force: true });
    return { deleted: true };
  });
}

function sendFile(reply: FastifyReply, file: string, downloadName: string, type: string) {
  const { size } = fs.statSync(file);
  reply.header('Content-Type', type);
  reply.header('Content-Length', size);
  reply.header('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
  // Reports are viewed outside a browser origin; forbid script execution if opened in one.
  reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  return reply.send(fs.createReadStream(file));
}
