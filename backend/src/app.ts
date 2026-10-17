import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { Storage } from './storage.js';
import { ReaRunner, detectSandbox } from './rea/runner.js';
import { CapabilityProbe } from './rea/capabilities.js';
import { AnalysisWorker } from './jobs/worker.js';
import { authenticate, type Device } from './auth.js';
import { ApiError } from './util/common.js';
import type { AppContext } from './context.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerAnalysisRoutes } from './routes/analyses.js';

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
  }
}

export const SERVER_VERSION = '1.0.0';
const PUBLIC_ROUTES = new Set(['/api/v1/health', '/api/v1/auth/pair']);

export async function buildApp(config: Config): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const https =
    config.tlsKeyPath && config.tlsCertPath
      ? { key: fs.readFileSync(config.tlsKeyPath), cert: fs.readFileSync(config.tlsCertPath) }
      : null;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'body.token', 'body.code'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    requestTimeout: 0, // large chunk uploads on slow links; per-route limits apply instead
    ...(https ? { https } : {}),
  } as never) as unknown as FastifyInstance;

  const db = openDb(config.dataDir);
  const storage = new Storage(config.dataDir);
  const sandbox = detectSandbox(config);
  const runner = new ReaRunner(config, sandbox);
  const capabilities = new CapabilityProbe(runner, path.join(storage.probeDir(), 'capabilities'));
  const worker = new AnalysisWorker(db, storage, runner, capabilities, config, app.log);
  const ctx: AppContext = { config, db, storage, runner, capabilities, worker, startedAt: new Date().toISOString(), version: SERVER_VERSION };

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/v1/')) throw new ApiError(404, 'not_found', 'Rota não encontrada.');
    if (PUBLIC_ROUTES.has(url)) return;
    request.device = authenticate(db, request.headers.authorization);
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
      return;
    }
    if (error.validation || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || error.statusCode === 400) {
      reply.code(400).send({ error: { code: 'invalid_request', message: 'Requisição inválida.', details: { reason: error.message } } });
      return;
    }
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send({ error: { code: 'payload_too_large', message: 'Conteúdo excede o tamanho permitido.', details: null } });
      return;
    }
    if (error.statusCode === 415) {
      reply.code(415).send({ error: { code: 'unsupported_media_type', message: 'Tipo de conteúdo não suportado.', details: null } });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({ error: { code: 'internal_error', message: 'Erro interno do servidor. Consulte os registros do backend.', details: null } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Rota não encontrada.', details: null } });
  });

  registerSystemRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerAnalysisRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await worker.stop();
    db.close();
  });

  worker.recover();
  return { app, ctx };
}
