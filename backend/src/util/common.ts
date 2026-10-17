import crypto from 'node:crypto';
import fs from 'node:fs';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Error with a stable machine code and a message meant for the app user.
 * Messages are Portuguese because the client is localized in pt-BR.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} não encontrado.`);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'invalid_request', message, details);

export function requireString(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max: number; optional?: boolean },
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw badRequest(`Campo obrigatório ausente: ${key}.`);
  }
  if (typeof value !== 'string') throw badRequest(`O campo ${key} deve ser texto.`);
  const trimmed = value.trim();
  if (trimmed.length < (opts.min ?? 0)) throw badRequest(`O campo ${key} é muito curto.`);
  if (trimmed.length > opts.max) throw badRequest(`O campo ${key} excede ${opts.max} caracteres.`);
  return trimmed;
}

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Corpo da requisição deve ser um objeto JSON.');
  }
  return body as Record<string, unknown>;
}

/** Keeps only the last `limit` bytes of a growing text buffer. */
export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  toString(): string {
    const joined = this.chunks.join('');
    return joined.length > this.limit ? joined.slice(joined.length - this.limit) : joined;
  }
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'artifact';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (cleaned.length > 0 ? cleaned : 'artifact').slice(0, 200);
}
