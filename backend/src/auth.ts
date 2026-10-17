import crypto from 'node:crypto';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import { ApiError, newId, sha256Hex } from './util/common.js';

/**
 * Device authentication.
 *
 * An operator with shell access to the backend creates a short-lived,
 * single-use pairing code (admin CLI). The app exchanges it for a long-lived
 * bearer token. Only SHA-256 hashes of codes and tokens are stored; tokens are
 * 256-bit random values, so a fast hash is adequate (no password stretching
 * needed for high-entropy secrets).
 */

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createPairingCode(db: Db, label: string): { code: string; expiresAt: string } {
  const bytes = crypto.randomBytes(10);
  let raw = '';
  for (const b of bytes) raw += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO pairing_codes (code_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256Hex(normalizeCode(code)), label, nowIso(), expiresAt);
  return { code, expiresAt };
}

function newToken(): string {
  return `ri_${crypto.randomBytes(32).toString('base64url')}`;
}

export function createDeviceToken(db: Db, name: string): { device: Device; token: string } {
  const token = newToken();
  const id = newId('dev');
  const created = nowIso();
  db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    sha256Hex(token),
    created,
  );
  return { device: { id, name, created_at: created, last_used_at: null, revoked_at: null }, token };
}

export function redeemPairingCode(db: Db, code: string, deviceName: string): { device: Device; token: string } {
  const hash = sha256Hex(normalizeCode(code));
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(hash) as
      | { expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
      throw new ApiError(401, 'pairing_invalid', 'Código de pareamento inválido, expirado ou já utilizado.');
    }
    const result = createDeviceToken(db, deviceName);
    db.prepare('UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ?').run(
      nowIso(),
      result.device.id,
      hash,
    );
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function authenticate(db: Db, authorization: string | undefined): Device {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) throw new ApiError(401, 'unauthenticated', 'Autenticação necessária.');
  const row = db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM devices WHERE token_hash = ?').get(
    sha256Hex(match[1]),
  ) as Device | undefined;
  if (!row || row.revoked_at) {
    throw new ApiError(401, 'unauthenticated', 'Token inválido ou revogado. Pareie o dispositivo novamente.');
  }
  // Throttle last_used_at writes to one per minute per device.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
    db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  }
  return row;
}

export function listDevices(db: Db): Device[] {
  return db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM devices ORDER BY created_at').all() as unknown as Device[];
}

export function revokeDevice(db: Db, id: string): boolean {
  const result = db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
  return Number(result.changes) > 0;
}

/** Fixed-window limiter for unauthenticated endpoints (pairing). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  check(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > this.max) {
      throw new ApiError(429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    }
  }
}
