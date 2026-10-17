import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildZip, ELECTRON_APP, FIXTURES, makeApp, uploadBuffer, waitForAnalysis } from './helpers.js';

test('API rejects unauthenticated access and exposes only health publicly', async () => {
  const t = await makeApp();
  try {
    assert.equal((await t.app.inject({ url: '/api/v1/health' })).statusCode, 200);
    for (const url of ['/api/v1/projects', '/api/v1/dashboard', '/api/v1/system/status']) {
      const res = await t.app.inject({ url });
      assert.equal(res.statusCode, 401, url);
      assert.equal(res.json().error.code, 'unauthenticated');
    }
    const bad = await t.app.inject({ url: '/api/v1/projects', headers: { authorization: 'Bearer ri_forged' } });
    assert.equal(bad.statusCode, 401);
    const pair = await t.app.inject({ method: 'POST', url: '/api/v1/auth/pair', payload: { code: 'AAAAA-BBBBB', deviceName: 'x' } });
    assert.equal(pair.statusCode, 401);
  } finally {
    await t.cleanup();
  }
});

test('project CRUD with validation', async () => {
  const t = await makeApp();
  try {
    const invalid = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: '' } });
    assert.equal(invalid.statusCode, 400);
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'Projeto A', description: 'd', tags: ['x', 'x', 'y'] } });
    assert.equal(created.statusCode, 201);
    const p = created.json();
    assert.deepEqual(p.tags, ['x', 'y']);
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/v1/projects/${p.id}`, headers: t.auth, payload: { name: 'Projeto B' } });
    assert.equal(patched.json().name, 'Projeto B');
    const list = await t.app.inject({ url: '/api/v1/projects?q=B', headers: t.auth });
    assert.equal(list.json().items.length, 1);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/projects/${p.id}`, headers: t.auth });
    assert.equal(del.statusCode, 200);
    assert.equal((await t.app.inject({ url: `/api/v1/projects/${p.id}`, headers: t.auth })).statusCode, 404);
  } finally {
    await t.cleanup();
  }
});

test('resumable upload enforces offsets, size and checksum', async () => {
  const t = await makeApp();
  try {
    const p = (await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'U' } })).json();
    const data = Buffer.alloc(10_000, 7);
    const up = (await t.app.inject({ method: 'POST', url: '/api/v1/uploads', headers: t.auth, payload: { projectId: p.id, fileName: 'blob.bin', size: data.length } })).json();
    const put = (offset: number, buf: Buffer) =>
      t.app.inject({ method: 'PUT', url: `/api/v1/uploads/${up.id}/chunk?offset=${offset}`, headers: { ...t.auth, 'content-type': 'application/octet-stream' }, payload: buf });
    assert.equal((await put(0, data.subarray(0, 4000))).json().receivedBytes, 4000);
    const wrong = await put(0, data.subarray(0, 100));
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().error.details.receivedBytes, 4000, 'server tells the client where to resume');
    assert.equal((await put(4000, Buffer.alloc(5000))).statusCode, 413, 'chunk larger than limit');
    const status = (await t.app.inject({ url: `/api/v1/uploads/${up.id}`, headers: t.auth })).json();
    assert.equal(status.receivedBytes, 4000, 'rejected chunk did not advance the offset');
    const early = await t.app.inject({ method: 'POST', url: `/api/v1/uploads/${up.id}/complete`, headers: t.auth, payload: {} });
    assert.equal(early.statusCode, 409);
    await put(4000, data.subarray(4000, 8000));
    await put(8000, data.subarray(8000));
    const mismatch = await t.app.inject({ method: 'POST', url: `/api/v1/uploads/${up.id}/complete`, headers: t.auth, payload: { sha256: '0'.repeat(64) } });
    assert.equal(mismatch.statusCode, 422);
    const tooBig = await t.app.inject({ method: 'POST', url: '/api/v1/uploads', headers: t.auth, payload: { projectId: p.id, fileName: 'x', size: 10 ** 13 } });
    assert.equal(tooBig.statusCode, 413);
  } finally {
    await t.cleanup();
  }
});

test('real REA analysis of a JavaScript/Electron archive, results and reports', async () => {
  const t = await makeApp();
  try {
    const p = (await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'Electron' } })).json();
    const done = await uploadBuffer(t.app, t.auth, p.id, 'notes.zip', buildZip(ELECTRON_APP));
    assert.equal(done.statusCode, 201, done.body);
    assert.equal(done.json().artifact.kind, 'javascript-archive');
    const analysis = await waitForAnalysis(t.app, t.auth, done.json().analysisId);
    assert.equal(analysis.status, 'succeeded', JSON.stringify(analysis.steps));
    assert.deepEqual(analysis.steps.map((s: { key: string }) => s.key), ['extract', 'inventory', 'javascript-app']);

    const result = (await t.app.inject({ url: `/api/v1/analyses/${analysis.id}/result`, headers: t.auth })).json();
    const identity = result.sections.find((s: { id: string }) => s.id === 'identity');
    assert.ok(identity.facts.some((f: { label: string; value: string }) => f.label === 'Pacote (package.json)' && f.value === 'fixture-notes'));
    const electron = result.sections.find((s: { id: string }) => s.id === 'electron');
    const channels = electron.tables.find((tb: { title: string }) => tb.title === 'Canais IPC');
    assert.ok(channels.rows.some((r: string[]) => r[0] === 'notes:list'));
    const security = result.sections.find((s: { id: string }) => s.id === 'security');
    assert.ok(security.findings.some((f: { title: string }) => f.title.includes('nodeIntegration')), 'literal nodeIntegration=true is reported');
    assert.ok(result.counts.confirmed > 0 && result.counts.hypothesis >= 0);

    for (const format of ['html', 'json', 'pdf']) {
      const rep = await t.app.inject({ method: 'POST', url: `/api/v1/analyses/${analysis.id}/reports`, headers: t.auth, payload: { format } });
      assert.equal(rep.statusCode, 201, rep.body);
      const dl = await t.app.inject({ url: `/api/v1/reports/${rep.json().id}/download`, headers: t.auth });
      assert.equal(dl.statusCode, 200);
      if (format === 'pdf') assert.equal(dl.rawPayload.subarray(0, 5).toString(), '%PDF-');
      if (format === 'html') assert.match(dl.body, /fixture-notes/);
      if (format === 'json') assert.equal(JSON.parse(dl.body).provenance.length, 3);
    }
    const events = (await t.app.inject({ url: `/api/v1/analyses/${analysis.id}/events`, headers: t.auth })).json().items;
    assert.ok(events.length >= 4);
    const evidence = await t.app.inject({ url: `/api/v1/analyses/${analysis.id}/steps/javascript-app/evidence`, headers: t.auth });
    assert.equal(JSON.parse(evidence.body).operation, 'analyze_javascript_application');
    const dash = (await t.app.inject({ url: '/api/v1/dashboard', headers: t.auth })).json();
    assert.equal(dash.totals.analyses, 1);
    assert.equal(dash.recent[0].id, analysis.id);
    // Scratch extraction is removed after the run.
    assert.equal(fs.existsSync(path.join(t.dataDir, 'analyses', analysis.id, 'work')), false);
  } finally {
    await t.cleanup();
  }
});

test('unsupported content yields an honest generic inventory, and failures are reported', async () => {
  const t = await makeApp();
  try {
    const p = (await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'Generic' } })).json();
    const done = await uploadBuffer(t.app, t.auth, p.id, 'data.bin', Buffer.from('plain bytes without a known format\n'));
    assert.equal(done.json().artifact.kind, 'unknown');
    const analysis = await waitForAnalysis(t.app, t.auth, done.json().analysisId);
    assert.ok(['succeeded', 'failed', 'partial'].includes(analysis.status));
    for (const step of analysis.steps) {
      if (step.status === 'failed') assert.ok(step.errorMessage && step.errorMessage.length > 0, 'failed steps carry a reason');
    }
    // A profile that does not apply to the artifact is rejected.
    const wrong = await t.app.inject({ method: 'POST', url: '/api/v1/analyses', headers: t.auth, payload: { artifactId: done.json().artifact.id, profile: 'android-apk' } });
    assert.equal(wrong.statusCode, 400);
  } finally {
    await t.cleanup();
  }
});

test('queued analysis can be cancelled', async () => {
  const t = await makeApp({ workerConcurrency: 1 });
  try {
    const p = (await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'C' } })).json();
    await t.ctx.worker.stop(); // keep the next analysis queued
    const done = await uploadBuffer(t.app, t.auth, p.id, 'notes.zip', buildZip(ELECTRON_APP));
    const id = done.json().analysisId;
    const cancel = await t.app.inject({ method: 'POST', url: `/api/v1/analyses/${id}/cancel`, headers: t.auth });
    assert.equal(cancel.statusCode, 200);
    const a = (await t.app.inject({ url: `/api/v1/analyses/${id}`, headers: t.auth })).json();
    assert.equal(a.status, 'cancelled');
    assert.ok(a.steps.every((s: { status: string }) => s.status === 'cancelled'));
  } finally {
    await t.cleanup();
  }
});

const jadx = process.env.REA_JADX_MCP_JAR;
test('real REA + JADX analysis of an APK and on-demand decompilation', { skip: !jadx && 'REA_JADX_MCP_JAR not set' }, async () => {
  const t = await makeApp({ jadxJarPath: jadx });
  try {
    const p = (await t.app.inject({ method: 'POST', url: '/api/v1/projects', headers: t.auth, payload: { name: 'APK' } })).json();
    const done = await uploadBuffer(t.app, t.auth, p.id, 'mini.apk', fs.readFileSync(path.join(FIXTURES, 'mini.apk')));
    const analysis = await waitForAnalysis(t.app, t.auth, done.json().analysisId);
    assert.equal(analysis.status, 'succeeded', JSON.stringify(analysis.steps));
    const result = (await t.app.inject({ url: `/api/v1/analyses/${analysis.id}/result`, headers: t.auth })).json();
    const identity = result.sections.find((s: { id: string }) => s.id === 'identity');
    assert.ok(identity.facts.some((f: { value: string }) => f.value === 'com.example.mini'));
    const perms = result.sections.find((s: { id: string }) => s.id === 'permissions').tables[0];
    assert.deepEqual(perms.rows.map((r: string[]) => r[0]).sort(), ['android.permission.CAMERA', 'android.permission.INTERNET']);
    const method = await t.app.inject({ method: 'POST', url: `/api/v1/analyses/${analysis.id}/android/method`, headers: t.auth, payload: { className: 'com.example.mini.Greeter', methodName: 'greet' } });
    assert.equal(method.statusCode, 200, method.body);
    assert.match(method.json().result.source.text, /Hello, /);
    assert.equal(method.json().certainty, 'inferred');
  } finally {
    await t.cleanup();
  }
});
