import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso } from '../db.js';
import { asObject, badRequest, newId, notFound, requireString } from '../util/common.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12 || !value.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 32)) {
    throw badRequest('tags deve ser uma lista de até 12 textos com até 32 caracteres.');
  }
  return [...new Set(value.map((t: string) => t.trim()))];
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const toDto = (row: ProjectRow) => {
    const stats = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM artifacts WHERE project_id = ?) artifacts,
                (SELECT COUNT(*) FROM analyses WHERE project_id = ?) analyses,
                (SELECT MAX(created_at) FROM analyses WHERE project_id = ?) last_analysis_at`,
      )
      .get(row.id, row.id, row.id) as { artifacts: number; analyses: number; last_analysis_at: string | null };
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      artifactCount: stats.artifacts,
      analysisCount: stats.analyses,
      lastAnalysisAt: stats.last_analysis_at,
    };
  };

  const load = (id: string) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw notFound('Projeto');
    return row;
  };

  app.get('/api/v1/projects', async (request) => {
    const q = (request.query as { q?: string }).q?.trim();
    const rows = (
      q
        ? db.prepare("SELECT * FROM projects WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY updated_at DESC").all(`%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`)
        : db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
    ) as unknown as ProjectRow[];
    return { items: rows.map(toDto) };
  });

  app.post('/api/v1/projects', async (request, reply) => {
    const body = asObject(request.body);
    const name = requireString(body, 'name', { min: 1, max: 120 })!;
    const description = requireString(body, 'description', { max: 4000, optional: true }) ?? '';
    const tags = parseTags(body.tags) ?? [];
    const id = newId('prj');
    const now = nowIso();
    db.prepare('INSERT INTO projects (id, name, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, description, JSON.stringify(tags), now, now);
    reply.code(201);
    return toDto(load(id));
  });

  app.get('/api/v1/projects/:id', async (request) => {
    const project = toDto(load((request.params as { id: string }).id));
    const artifacts = db
      .prepare('SELECT id, file_name, size, sha256, kind, kind_detail, created_at FROM artifacts WHERE project_id = ? ORDER BY created_at DESC')
      .all(project.id)
      .map((a: any) => ({ id: a.id, fileName: a.file_name, size: a.size, sha256: a.sha256, kind: a.kind, kindDetail: a.kind_detail, createdAt: a.created_at }));
    return { ...project, artifacts };
  });

  app.patch('/api/v1/projects/:id', async (request) => {
    const row = load((request.params as { id: string }).id);
    const body = asObject(request.body);
    const name = requireString(body, 'name', { min: 1, max: 120, optional: true }) ?? row.name;
    const description = requireString(body, 'description', { max: 4000, optional: true }) ?? row.description;
    const tags = parseTags(body.tags) ?? (JSON.parse(row.tags) as string[]);
    db.prepare('UPDATE projects SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?').run(name, description, JSON.stringify(tags), nowIso(), row.id);
    return toDto(load(row.id));
  });

  app.delete('/api/v1/projects/:id', async (request) => {
    const row = load((request.params as { id: string }).id);
    const running = db.prepare("SELECT id FROM analyses WHERE project_id = ? AND status IN ('queued','running')").all(row.id) as { id: string }[];
    for (const r of running) ctx.worker.cancel(r.id);
    const artifacts = db.prepare('SELECT id FROM artifacts WHERE project_id = ?').all(row.id) as { id: string }[];
    const analyses = db.prepare('SELECT id FROM analyses WHERE project_id = ?').all(row.id) as { id: string }[];
    const uploads = db.prepare('SELECT id FROM uploads WHERE project_id = ?').all(row.id) as { id: string }[];
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    for (const a of artifacts) ctx.storage.removeTree(ctx.storage.artifactDir(a.id));
    for (const a of analyses) ctx.storage.removeTree(ctx.storage.analysisDir(a.id));
    for (const u of uploads) ctx.storage.removeTree(ctx.storage.uploadPath(u.id));
    return { deleted: true, artifacts: artifacts.length, analyses: analyses.length };
  });

  app.delete('/api/v1/artifacts/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const artifact = db.prepare('SELECT id FROM artifacts WHERE id = ?').get(id);
    if (!artifact) throw notFound('Artefato');
    const active = db.prepare("SELECT COUNT(*) n FROM analyses WHERE artifact_id = ? AND status IN ('queued','running')").get(id) as { n: number };
    if (active.n > 0) throw badRequest('Há análises em andamento para este artefato. Cancele-as antes de excluí-lo.');
    const analyses = db.prepare('SELECT id FROM analyses WHERE artifact_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    ctx.storage.removeTree(ctx.storage.artifactDir(id));
    for (const a of analyses) ctx.storage.removeTree(ctx.storage.analysisDir(a.id));
    return { deleted: true, analyses: analyses.length };
  });
}
