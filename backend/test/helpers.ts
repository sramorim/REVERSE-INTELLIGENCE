import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPairingCode } from '../src/auth.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');

/** Minimal STORE-only ZIP writer for building test archives. */
export function buildZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const ELECTRON_APP: Record<string, string> = {
  'notes-app/package.json': JSON.stringify({ name: 'fixture-notes', version: '2.1.0', main: 'main.js' }),
  'notes-app/main.js': [
    "const { app, BrowserWindow, ipcMain } = require('electron');",
    "const path = require('path');",
    'function createWindow() {',
    "  const win = new BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: true, contextIsolation: false } });",
    "  win.loadFile('index.html');",
    '}',
    "ipcMain.handle('notes:list', async () => []);",
    'app.whenReady().then(createWindow);',
  ].join('\n'),
  'notes-app/preload.js': [
    "const { contextBridge, ipcRenderer } = require('electron');",
    "contextBridge.exposeInMainWorld('notes', { list: () => ipcRenderer.invoke('notes:list') });",
  ].join('\n'),
  'notes-app/index.html': '<html><body><script src="renderer.js"></script></body></html>',
  'notes-app/renderer.js': 'window.notes.list().then(console.log);',
};

export async function makeApp(overrides: Record<string, unknown> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-test-'));
  const config = loadConfig({ dataDir, logLevel: 'silent', workerConcurrency: 1, maxChunkBytes: 4096, ...overrides });
  const { app, ctx } = await buildApp(config);
  await app.ready();
  ctx.worker.start();
  const { code } = createPairingCode(ctx.db, 'test');
  const pair = await app.inject({ method: 'POST', url: '/api/v1/auth/pair', payload: { code, deviceName: 'test-device' } });
  const token = pair.json().token as string;
  const auth = { authorization: `Bearer ${token}` };
  const cleanup = async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { app, ctx, token, auth, dataDir, cleanup };
}

export async function uploadBuffer(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  auth: Record<string, string>,
  projectId: string,
  fileName: string,
  data: Buffer,
  chunk = 4096,
  extra: Record<string, unknown> = {},
) {
  const created = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: auth, payload: { projectId, fileName, size: data.length } });
  if (created.statusCode !== 201) throw new Error(created.body);
  const id = created.json().id;
  let offset = 0;
  while (offset < data.length) {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${id}/chunk?offset=${offset}`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: data.subarray(offset, offset + chunk),
    });
    if (res.statusCode !== 200) throw new Error(res.body);
    offset = res.json().receivedBytes;
  }
  const done = await app.inject({ method: 'POST', url: `/api/v1/uploads/${id}/complete`, headers: auth, payload: { startAnalysis: true, ...extra } });
  return done;
}

export async function waitForAnalysis(app: Awaited<ReturnType<typeof makeApp>>['app'], auth: Record<string, string>, id: string, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/analyses/${id}`, headers: auth });
    const body = res.json();
    if (!['queued', 'running'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('analysis timeout');
}
