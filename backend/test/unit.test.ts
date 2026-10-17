import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectArtifact, listZipEntries } from '../src/detect.js';
import { certaintyFromEvidence, normalizeEvidence, parseManifestComponents } from '../src/rea/normalize.js';
import { openDb } from '../src/db.js';
import { authenticate, createPairingCode, redeemPairingCode, revokeDevice } from '../src/auth.js';
import { ApiError, safeFileName } from '../src/util/common.js';
import { profileForKind } from '../src/rea/profiles.js';
import { ALLOWED_COMMANDS } from '../src/rea/runner.js';
import { buildZip, ELECTRON_APP, FIXTURES } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ri-unit-'));

test('detects APK, JavaScript archive, ELF and unknown content by magic bytes', async () => {
  const dir = tmp();
  const apk = await detectArtifact(path.join(FIXTURES, 'mini.apk'), 'renamed.bin');
  assert.equal(apk.kind, 'android-apk');
  const zipPath = path.join(dir, 'app.zip');
  fs.writeFileSync(zipPath, buildZip(ELECTRON_APP));
  assert.equal((await detectArtifact(zipPath, 'app.zip')).kind, 'javascript-archive');
  assert.deepEqual((await listZipEntries(zipPath))?.sort(), Object.keys(ELECTRON_APP).sort());
  const elf = path.join(dir, 'x');
  fs.writeFileSync(elf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), Buffer.alloc(64)]));
  assert.equal((await detectArtifact(elf, 'x')).kind, 'native-elf');
  const txt = path.join(dir, 'notes.apk');
  fs.writeFileSync(txt, 'not really an apk');
  assert.equal((await detectArtifact(txt, 'notes.apk')).kind, 'unknown', 'extension alone must not decide the kind');
});

test('every profile uses only allow-listed static REA commands', () => {
  for (const kind of ['android-apk', 'javascript-archive', 'electron-asar', 'dotnet-assembly', 'native-elf', 'sqlite', 'unknown'] as const) {
    for (const step of profileForKind(kind).steps) assert.ok(ALLOWED_COMMANDS.has(step.command), step.command);
  }
  for (const forbidden of ['capture-process', 'debug-with-gdb', 'instrument-with-frida', 'install-adb-package', 'cutter-command']) {
    assert.equal(ALLOWED_COMMANDS.has(forbidden), false, forbidden);
  }
});

test('maps REA evidence states to certainty levels', () => {
  assert.equal(certaintyFromEvidence({ state: 'observed', confidence: 'exact' }), 'confirmed');
  assert.equal(certaintyFromEvidence({ state: 'inferred', confidence: 'high' }), 'inferred');
  assert.equal(certaintyFromEvidence({ state: 'inferred', confidence: 'low' }), 'hypothesis');
  assert.equal(certaintyFromEvidence({ state: 'unknown' }), 'hypothesis');
});

test('parses manifest components and flags exported components without permission', () => {
  const xml = `<manifest><application android:allowBackup="true">
    <activity android:name="a.Main" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>
    <service android:name="a.Sync" android:exported="true"/>
    <receiver android:name="a.Boot"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/></intent-filter></receiver>
    <provider android:name="a.Files" android:exported="false"/>
  </application></manifest>`;
  const components = parseManifestComponents(xml);
  assert.equal(components.length, 4);
  assert.deepEqual(components[2].actions, ['android.intent.action.BOOT_COMPLETED']);
  const contribution = normalizeEvidence('inspect-android-package', 'android-package', { normalized_result: { package_name: 'a', manifest: { status: 'complete', text: xml }, permissions: [] } }, { kind: 'android-apk' });
  const security = contribution.sections.security!;
  const titles = security.findings!.map((f) => f.title);
  assert.ok(titles.some((t) => t.includes('a.Sync')), 'explicitly exported service is flagged');
  const boot = security.findings!.find((f) => f.title.includes('a.Boot'))!;
  assert.equal(boot.certainty, 'inferred', 'implicit export is an inference');
  assert.ok(!titles.some((t) => t.includes('a.Main')), 'launcher activity is expected to be exported');
  assert.ok(!titles.some((t) => t.includes('a.Files')));
});

test('normalizer never invents facts for absent metadata', () => {
  const go = normalizeEvidence('inspect-go-binary', 'go', { normalized_result: { format: 'elf', build_info: null } }, { kind: 'native-elf' });
  const facts = go.sections.build!.facts!;
  assert.equal(facts.length, 1);
  assert.match(facts[0].value, /não encontrados/);
  assert.equal(go.sections.dependencies, undefined);
});

test('pairing codes are single use and tokens can be revoked', () => {
  const db = openDb(tmp());
  const { code } = createPairingCode(db, 't');
  const { token, device } = redeemPairingCode(db, code.toLowerCase(), 'phone');
  assert.throws(() => redeemPairingCode(db, code, 'again'), (e: unknown) => e instanceof ApiError && e.code === 'pairing_invalid');
  assert.equal(authenticate(db, `Bearer ${token}`).id, device.id);
  assert.throws(() => authenticate(db, 'Bearer ri_wrong'), ApiError);
  assert.throws(() => authenticate(db, undefined), ApiError);
  revokeDevice(db, device.id);
  assert.throws(() => authenticate(db, `Bearer ${token}`), ApiError);
  const row = db.prepare('SELECT token_hash FROM devices').get() as { token_hash: string };
  assert.notEqual(row.token_hash, token, 'only the hash is stored');
});

test('sanitizes user supplied file names', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\x\\evil<>.apk'), 'evil__.apk');
  assert.equal(safeFileName(''), 'artifact');
});
