import { PgBoss } from 'pg-boss';
import { loadConfig, redactConfig } from '@bananagig/config';
import { createDatabase, PG_BOSS_POOL_MAX } from '@bananagig/database';
import { createDbTelemetry, getCorrelationId, registerPoolMetrics, initObservability, log, shutdownObservability } from '@bananagig/observability';
import { NatsClient, closeValkey, createS3, createValkey, runDiagnostics, startHealthServer } from '@bananagig/platform';
import { ConfigurationService, ValkeyConfigCache } from '@bananagig/configuration';
import { ContentService } from '@bananagig/content';
import { Worker } from './worker';

const cfg = loadConfig({ service: 'bananagig-worker', role: 'worker' });
initObservability(cfg);
log('info', 'starting', { config: redactConfig(cfg) });

const telemetry = createDbTelemetry({ slowQueryMs: cfg.db.slowQueryMs, logSql: cfg.db.logSql });
const database = createDatabase(cfg.databaseUrl, { role: 'worker', overrides: cfg.db, ...telemetry, correlationIdProvider: getCorrelationId });
registerPoolMetrics('worker', () => database.poolStats());
const nats = new NatsClient(cfg);
const valkey = createValkey(cfg);
const s3 = createS3(cfg);
const configuration = new ConfigurationService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  lkgMaxAgeSeconds: cfg.configuration.lkgMaxAgeSeconds,
  allowTestKeys: cfg.env !== 'production',
});
const content = new ContentService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  lkgMaxAgeSeconds: cfg.configuration.lkgMaxAgeSeconds,
  allowTestKeys: cfg.env !== 'production',
});
const worker = new Worker({
  configuration,
  content,
  cfg,
  database,
  nats,
  boss: new PgBoss({ connectionString: cfg.databaseUrl, max: PG_BOSS_POOL_MAX, application_name: 'bananagig-worker-pgboss' }),
});

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
