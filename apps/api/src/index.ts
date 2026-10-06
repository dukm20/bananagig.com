import { loadConfig, redactConfig } from '@bananagig/config';
import { createDatabase } from '@bananagig/database';
import { createDbTelemetry, getCorrelationId, registerPoolMetrics, initObservability, log, shutdownObservability } from '@bananagig/observability';
import { NatsClient, closeValkey, createS3, createValkey, runDiagnostics } from '@bananagig/platform';
import { createTokenVerifier } from '@bananagig/identity';
import { buildApp } from './app';

const cfg = loadConfig({ service: 'bananagig-api', role: 'api' });
initObservability(cfg);
log('info', 'starting', { config: redactConfig(cfg) });

const telemetry = createDbTelemetry({ slowQueryMs: cfg.db.slowQueryMs, logSql: cfg.db.logSql });
const database = createDatabase(cfg.databaseUrl, { role: 'api', overrides: cfg.db, ...telemetry, correlationIdProvider: getCorrelationId });
registerPoolMetrics('api', () => database.poolStats());
const valkey = createValkey(cfg);
const nats = new NatsClient(cfg);
const s3 = createS3(cfg);
const adapters = { cfg, database, valkey, nats, s3 };

const verifier = createTokenVerifier({
  issuer: cfg.identity.issuer,
  apiAudience: cfg.identity.apiAudience,
  jwks: { url: cfg.identity.jwksUrl },
  webClientId: cfg.identity.webClientId,
  adminClientId: cfg.identity.adminClientId,
});

const app = await buildApp({
  cfg,
  verifier,
  // Critical for serving requests: Postgres only. Valkey/NATS/OpenSearch/flagd outages must not take the API down.
  readiness: async () => ({ postgres: (await database.health()).ok ? 'up' : 'down' }),
  diagnostics: () => runDiagnostics(adapters),
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  await app.close(); // stops accepting, drains in-flight requests
  await Promise.allSettled([database.close(), closeValkey(valkey), nats.close(), Promise.resolve(s3.destroy())]);
  await shutdownObservability();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.port, host: '0.0.0.0' });
log('info', 'listening', { port: cfg.port });
