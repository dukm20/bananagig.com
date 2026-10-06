import { PgBoss } from 'pg-boss';
import { loadConfig, redactConfig } from '@bananagig/config';
import { createDatabase } from '@bananagig/database';
import { dbQueryObserver, getCorrelationId, initObservability, log, shutdownObservability } from '@bananagig/observability';
import { NatsClient, closeValkey, createS3, createValkey, runDiagnostics, startHealthServer } from '@bananagig/platform';
import { Worker } from './worker';

const cfg = loadConfig({ service: 'bananagig-worker', role: 'worker' });
initObservability(cfg);
log('info', 'starting', { config: redactConfig(cfg) });

const database = createDatabase(cfg.databaseUrl, { onQuery: dbQueryObserver(), correlationIdProvider: getCorrelationId });
const nats = new NatsClient(cfg);
const valkey = createValkey(cfg);
const s3 = createS3(cfg);
const worker = new Worker({ cfg, database, nats, boss: new PgBoss(cfg.databaseUrl) });

await worker.start();

const server = startHealthServer({
  service: cfg.serviceName,
  port: cfg.port,
  ready: () => worker.readiness(),
  routes: {
    '/internal/diagnostics': async () => runDiagnostics({ cfg, database, valkey, nats, s3 }, { runtime: () => worker.selfTest() }),
  },
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal, workerId: worker.identity });
  server.close();
  await worker.stop();
  await Promise.allSettled([database.close(), closeValkey(valkey), Promise.resolve(s3.destroy())]);
  await shutdownObservability();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
