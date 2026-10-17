import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { RateLimiter, redeemPairingCode } from '../auth.js';
import { asObject, requireString } from '../util/common.js';

let usageCache: { at: number; value: { bytes: number; files: number } } | null = null;

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pairLimiter = new RateLimiter(10, 15 * 60 * 1000);

  /** Unauthenticated liveness probe: reveals no configuration. */
  app.get('/api/v1/health', async () => ({ ok: true, service: 'reverse-intelligence', apiVersion: 1 }));

  app.post('/api/v1/auth/pair', async (request) => {
    pairLimiter.check(request.ip);
    const body = asObject(request.body);
    const code = requireString(body, 'code', { min: 6, max: 32 })!;
    const deviceName = requireString(body, 'deviceName', { min: 1, max: 80 })!;
    const { device, token } = redeemPairingCode(ctx.db, code, deviceName);
    request.log.info({ deviceId: device.id }, 'device paired');
    return { token, device: { id: device.id, name: device.name, createdAt: device.created_at } };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const device = request.device!;
    return { device: { id: device.id, name: device.name, createdAt: device.created_at } };
  });

  app.get('/api/v1/system/status', async (request) => {
    const force = (request.query as { refresh?: string }).refresh === '1';
    const caps = await ctx.capabilities.get(force);
    if (!usageCache || Date.now() - usageCache.at > 60_000) usageCache = { at: Date.now(), value: ctx.storage.usage() };
    const queued = (ctx.db.prepare("SELECT COUNT(*) n FROM analyses WHERE status = 'queued'").get() as { n: number }).n;
    return {
      server: {
        version: ctx.version,
        startedAt: ctx.startedAt,
        node: process.version,
        tls: Boolean(ctx.config.tlsCertPath && ctx.config.tlsKeyPath),
      },
      rea: {
        version: caps.reaVersion,
        reachable: caps.reaReachable,
        error: caps.reaError,
        checkedAt: caps.checkedAt,
      },
      sandbox: ctx.runner.sandbox,
      requirements: caps.requirements,
      profiles: caps.profiles,
      queue: { running: ctx.worker.activeCount(), queued, concurrency: ctx.config.workerConcurrency },
      limits: {
        maxUploadBytes: ctx.config.maxUploadBytes,
        maxChunkBytes: ctx.config.maxChunkBytes,
        stepTimeoutSeconds: Math.round(ctx.config.stepTimeoutMs / 1000),
      },
      storage: usageCache.value,
    };
  });

  app.get('/api/v1/dashboard', async () => {
    const one = <T>(sql: string) => ctx.db.prepare(sql).get() as T;
    const byStatus = ctx.db.prepare('SELECT status, COUNT(*) n FROM analyses GROUP BY status').all() as { status: string; n: number }[];
    const active = ctx.db
      .prepare(
        `SELECT a.id, a.status, a.progress, a.phase, a.message, a.created_at, a.started_at, a.profile, p.name project_name, ar.file_name
         FROM analyses a JOIN projects p ON p.id = a.project_id JOIN artifacts ar ON ar.id = a.artifact_id
         WHERE a.status IN ('queued','running') ORDER BY a.created_at`,
      )
      .all();
    const recent = ctx.db
      .prepare(
        `SELECT a.id, a.status, a.progress, a.message, a.created_at, a.finished_at, a.profile, a.counts, p.name project_name, ar.file_name, ar.kind
         FROM analyses a JOIN projects p ON p.id = a.project_id JOIN artifacts ar ON ar.id = a.artifact_id
         WHERE a.status NOT IN ('queued','running') ORDER BY COALESCE(a.finished_at, a.created_at) DESC LIMIT 8`,
      )
      .all();
    const caps = await ctx.capabilities.get();
    return {
      totals: {
        projects: one<{ n: number }>('SELECT COUNT(*) n FROM projects').n,
        artifacts: one<{ n: number }>('SELECT COUNT(*) n FROM artifacts').n,
        analyses: byStatus.reduce((a, r) => a + r.n, 0),
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      },
      active: active.map(mapListRow),
      recent: recent.map(mapListRow),
      services: {
        rea: { ok: caps.reaReachable, version: caps.reaVersion },
        jadx: caps.requirements.find((r) => r.id === 'jadx') ?? null,
        sandbox: ctx.runner.sandbox.mode,
        workers: { running: ctx.worker.activeCount(), concurrency: ctx.config.workerConcurrency },
      },
    };
  });
}

export function mapListRow(row: any) {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    phase: row.phase ?? null,
    message: row.message,
    profile: row.profile,
    projectName: row.project_name,
    fileName: row.file_name,
    kind: row.kind ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    counts: row.counts ? JSON.parse(row.counts) : null,
  };
}
