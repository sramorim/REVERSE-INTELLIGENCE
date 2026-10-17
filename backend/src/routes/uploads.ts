import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso } from '../db.js';
import { detectArtifact } from '../detect.js';
import { ApiError, asObject, badRequest, newId, notFound, requireString, safeFileName, sha256File } from '../util/common.js';
import { profileById, profileForKind } from '../rea/profiles.js';
import { createAnalysis } from '../jobs/worker.js';

/**
 * Resumable chunked uploads.
 *
 *   POST /uploads                      -> declare file name + size
 *   PUT  /uploads/:id/chunk?offset=N   -> append raw bytes at N (must equal received bytes)
 *   GET  /uploads/:id                  -> current received byte count (to resume)
 *   POST /uploads/:id/complete         -> verify size/SHA-256, detect kind, store artifact
 *
 * A dropped connection loses at most one chunk; the client re-reads the
 * server offset and continues.
 */

interface UploadRow {
  id: string;
  project_id: string;
  file_name: string;
  declared_size: number;
  received_bytes: number;
  status: string;
  artifact_id: string | null;
}

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage, config } = ctx;
  const locks = new Set<string>();

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const load = (id: string) => {
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as UploadRow | undefined;
    if (!row) throw notFound('Upload');
    return row;
  };
  const dto = (row: UploadRow) => ({
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    size: row.declared_size,
    receivedBytes: row.received_bytes,
    status: row.status,
    artifactId: row.artifact_id,
    chunkSize: config.maxChunkBytes,
  });

  app.post('/api/v1/uploads', async (request, reply) => {
    const body = asObject(request.body);
    const projectId = requireString(body, 'projectId', { min: 1, max: 64 })!;
    const fileName = safeFileName(requireString(body, 'fileName', { min: 1, max: 255 })!);
    const size = body.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw badRequest('size deve ser um inteiro positivo (bytes).');
    if (size > config.maxUploadBytes) {
      throw new ApiError(413, 'file_too_large', `Arquivo excede o limite do servidor (${Math.round(config.maxUploadBytes / 1048576)} MiB).`);
    }
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw notFound('Projeto');
    const id = newId('upl');
    const now = nowIso();
    db.prepare("INSERT INTO uploads (id, project_id, file_name, declared_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'uploading', ?, ?)").run(id, projectId, fileName, size, now, now);
    fs.writeFileSync(storage.uploadPath(id), Buffer.alloc(0), { mode: 0o600 });
    reply.code(201);
    return dto(load(id));
  });

  app.get('/api/v1/uploads/:id', async (request) => dto(load((request.params as { id: string }).id)));

  app.put('/api/v1/uploads/:id/chunk', { bodyLimit: config.maxChunkBytes + 1024 }, async (request) => {
    const row = load((request.params as { id: string }).id);
    if (row.status !== 'uploading') throw new ApiError(409, 'upload_closed', 'Este upload já foi finalizado.');
    const offset = Number((request.query as { offset?: string }).offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('offset inválido.');
    if (offset !== row.received_bytes) {
      throw new ApiError(409, 'offset_mismatch', 'Offset divergente; retome a partir do valor informado pelo servidor.', { receivedBytes: row.received_bytes });
    }
    if (locks.has(row.id)) throw new ApiError(409, 'chunk_in_progress', 'Outro bloco deste upload está sendo recebido.');
    locks.add(row.id);
    const partPath = storage.uploadPath(row.id);
    let written = 0;
    try {
      // Discard bytes of a previously interrupted chunk beyond the committed offset.
      fs.truncateSync(partPath, offset);
      const limit = Math.min(config.maxChunkBytes, row.declared_size - offset);
      let seen = 0;
      const handle = await fs.promises.open(partPath, 'r+');
      try {
        for await (const chunk of request.body as Readable) {
          const buf = chunk as Buffer;
          seen += buf.length;
          if (seen > limit) {
            // Keep draining (bounded) so the client receives a clean 413 instead of a reset.
            if (seen > limit + config.maxChunkBytes) (request.body as Readable).destroy();
            continue;
          }
          await handle.write(buf, 0, buf.length, offset + written);
          written += buf.length;
        }
      } finally {
        await handle.close();
      }
      if (seen > limit) throw new ApiError(413, 'chunk_too_large', 'Bloco excede o tamanho permitido ou o tamanho declarado do arquivo.');
      const received = offset + written;
      db.prepare('UPDATE uploads SET received_bytes = ?, updated_at = ? WHERE id = ?').run(received, nowIso(), row.id);
      return { receivedBytes: received, size: row.declared_size };
    } catch (error) {
      fs.truncateSync(partPath, offset);
      throw error;
    } finally {
      locks.delete(row.id);
    }
  });

  app.post('/api/v1/uploads/:id/complete', async (request, reply) => {
    const row = load((request.params as { id: string }).id);
    const body = request.body ? asObject(request.body) : {};
    if (row.status === 'complete' && row.artifact_id) return { upload: dto(row), artifact: artifactDto(ctx, row.artifact_id), analysisId: null };
    if (row.received_bytes !== row.declared_size) {
      throw new ApiError(409, 'upload_incomplete', `Upload incompleto: ${row.received_bytes} de ${row.declared_size} bytes.`, { receivedBytes: row.received_bytes });
    }
    const partPath = storage.uploadPath(row.id);
    const actual = fs.statSync(partPath).size;
    if (actual !== row.declared_size) throw new ApiError(500, 'upload_corrupt', 'Tamanho em disco diverge do registrado.');
    const sha256 = await sha256File(partPath);
    const expected = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : null;
    if (expected && expected !== sha256) {
      db.prepare("UPDATE uploads SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
      fs.rmSync(partPath, { force: true });
      throw new ApiError(422, 'checksum_mismatch', 'O SHA-256 recebido não confere com o enviado pelo aplicativo. Envie o arquivo novamente.', { expected, actual: sha256 });
    }
    const artifactId = newId('art');
    const target = storage.artifactPath(artifactId, row.file_name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(partPath, target);
    fs.chmodSync(target, 0o400);
    const detection = await detectArtifact(target, row.file_name);
    const now = nowIso();
    db.prepare('INSERT INTO artifacts (id, project_id, file_name, size, sha256, kind, kind_detail, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      artifactId,
      row.project_id,
      row.file_name,
      row.declared_size,
      sha256,
      detection.kind,
      detection.detail,
      target,
      now,
    );
    db.prepare("UPDATE uploads SET status = 'complete', artifact_id = ?, updated_at = ? WHERE id = ?").run(artifactId, now, row.id);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, row.project_id);

    let analysisId: string | null = null;
    if (body.startAnalysis === true) {
      const profile = typeof body.profile === 'string' ? profileById(body.profile) : profileForKind(detection.kind);
      if (!profile) throw badRequest('Perfil de análise desconhecido.');
      analysisId = createAnalysis(db, { projectId: row.project_id, artifactId, profile });
      ctx.worker.wake();
    }
    reply.code(201);
    return { upload: dto(load(row.id)), artifact: artifactDto(ctx, artifactId), analysisId };
  });

  app.delete('/api/v1/uploads/:id', async (request) => {
    const row = load((request.params as { id: string }).id);
    if (row.status === 'uploading') {
      db.prepare("UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
      fs.rmSync(storage.uploadPath(row.id), { force: true });
    }
    return { aborted: row.status === 'uploading' };
  });

  // Abandoned uploads older than 24 h are removed hourly.
  const sweep = setInterval(() => {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const stale = db.prepare("SELECT id FROM uploads WHERE status = 'uploading' AND updated_at < ?").all(cutoff) as { id: string }[];
    for (const s of stale) {
      db.prepare("UPDATE uploads SET status = 'expired' WHERE id = ?").run(s.id);
      fs.rmSync(storage.uploadPath(s.id), { force: true });
    }
  }, 3600 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));
}

export function artifactDto(ctx: AppContext, id: string) {
  const a = ctx.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as any;
  if (!a) throw notFound('Artefato');
  const profile = profileForKind(a.kind);
  return {
    id: a.id,
    projectId: a.project_id,
    fileName: a.file_name,
    size: a.size,
    sha256: a.sha256,
    kind: a.kind,
    kindDetail: a.kind_detail,
    createdAt: a.created_at,
    suggestedProfile: { id: profile.id, title: profile.title, description: profile.description },
  };
}
