import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { app, ctx } = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
ctx.worker.start();
app.log.info(
  {
    rea: ctx.runner.version,
    sandbox: ctx.runner.sandbox.mode,
    tls: Boolean(config.tlsCertPath),
    dataDir: config.dataDir,
    jadx: Boolean(config.jadxJarPath),
  },
  'REVERSE INTELLIGENCE backend ready',
);
if (!config.tlsCertPath && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  app.log.warn('Listening without TLS on a non-loopback interface. Use RI_TLS_CERT/RI_TLS_KEY or a TLS reverse proxy.');
}
// Warm the capability cache so the first dashboard request is fast.
void ctx.capabilities.get();
