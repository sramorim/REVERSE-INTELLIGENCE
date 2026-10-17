import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createDeviceToken, createPairingCode, listDevices, revokeDevice } from './auth.js';

/**
 * Operator CLI. Runs on the backend host with direct database access; there is
 * intentionally no remote admin API.
 *
 *   npm run admin -- pair [label]              short-lived pairing code for the app
 *   npm run admin -- token <device name>       long-lived token (scripts/CI)
 *   npm run admin -- devices                   list paired devices
 *   npm run admin -- revoke <deviceId>         revoke a device token
 *   npm run admin -- gen-cert <host-or-ip>...  self-signed TLS certificate + SHA-256 pin
 */

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();

function usage(): never {
  console.error('Uso: npm run admin -- <pair [rótulo] | token <nome> | devices | revoke <id> | gen-cert <host...>>');
  process.exit(2);
}

switch (command) {
  case 'pair': {
    const db = openDb(config.dataDir);
    const { code, expiresAt } = createPairingCode(db, args.join(' ') || 'app');
    console.log(`Código de pareamento: ${code}`);
    console.log(`Válido até: ${expiresAt} (uso único)`);
    break;
  }
  case 'token': {
    if (args.length === 0) usage();
    const db = openDb(config.dataDir);
    const { device, token } = createDeviceToken(db, args.join(' '));
    console.log(`Dispositivo: ${device.id} (${device.name})`);
    console.log(`Token (exibido apenas agora): ${token}`);
    break;
  }
  case 'devices': {
    const db = openDb(config.dataDir);
    for (const d of listDevices(db)) {
      console.log(`${d.id}\t${d.name}\tcriado ${d.created_at}\túltimo uso ${d.last_used_at ?? '-'}${d.revoked_at ? `\tREVOGADO ${d.revoked_at}` : ''}`);
    }
    break;
  }
  case 'revoke': {
    if (!args[0]) usage();
    const db = openDb(config.dataDir);
    console.log(revokeDevice(db, args[0]) ? 'Revogado.' : 'Dispositivo não encontrado ou já revogado.');
    break;
  }
  case 'gen-cert': {
    if (args.length === 0) usage();
    const dir = path.join(config.dataDir, 'tls');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = path.join(dir, 'server.key');
    const cert = path.join(dir, 'server.crt');
    const san = args.map((h) => (/^[\d.]+$|:/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '825', '-subj', `/CN=${args[0]}`, '-addext', `subjectAltName=${san}`,
    ], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
    const der = new crypto.X509Certificate(fs.readFileSync(cert)).raw;
    const pin = crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)!.join(':');
    console.log(`Chave:       ${key}`);
    console.log(`Certificado: ${cert}`);
    console.log(`SHA-256 do certificado (informe no app em Configurações > Fixação de certificado):`);
    console.log(pin);
    console.log(`Inicie com: RI_TLS_KEY=${key} RI_TLS_CERT=${cert} npm start`);
    break;
  }
  default:
    usage();
}
