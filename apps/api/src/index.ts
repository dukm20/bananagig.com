import { loadConfig, redactConfig } from '@bananagig/config';
import { createDatabase } from '@bananagig/database';
import { createDbTelemetry, getCorrelationId, registerPoolMetrics, initObservability, log, shutdownObservability } from '@bananagig/observability';
import { NatsClient, closeValkey, createS3, createValkey, runDiagnostics } from '@bananagig/platform';
import { ConfigurationService, ValkeyConfigCache } from '@bananagig/configuration';
import { ContentService } from '@bananagig/content';
import { AccountService } from '@bananagig/accounts';
import {
  AddressService,
  GeographyService,
  createAddressFormatReadinessCheck,
  createGeographyScopeReferenceValidator,
  createMarketDefaultsProvider,
  registerReadinessCheck,
} from '@bananagig/geography';
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

// Geography is the reference-data authority for COUNTRY/MARKET scopes: configuration and content validate scope references against it and
// content derives a market's default locale from it (ports, so no package imports another).
const geography = new GeographyService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  allowTestKeys: cfg.env !== 'production', // devtest-* markets and the test country ZZ are DEV/TEST only
});
const scopeReferences = createGeographyScopeReferenceValidator(geography);

const configuration = new ConfigurationService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  lkgMaxAgeSeconds: cfg.configuration.lkgMaxAgeSeconds,
  allowTestKeys: cfg.env !== 'production', // devtest.* keys are DEV/TEST only
  scopeReferences,
});

const content = new ContentService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  lkgMaxAgeSeconds: cfg.configuration.lkgMaxAgeSeconds,
  allowTestKeys: cfg.env !== 'production', // devtest.* keys are DEV/TEST only
  scopeReferences,
  markets: createMarketDefaultsProvider(geography),
});

// Addresses: country-driven formats and validation. The country name for formatted addresses comes from the content registry (a port: geography
// never imports content). No autocomplete, geocoder or verification provider is configured yet, so manual entry is the only path (DEBT-0037).
const address = new AddressService({
  database,
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  countryNames: async (countryCode, locale) => {
    // management read: a staff preview of a PLANNED country also gets its country line (the caller already decided visibility)
    const country = await geography.getCountry(countryCode, { management: true });
    const rendered = await content.render(country.displayNameContentKey, { locale, context: { country: countryCode } });
    return rendered.value;
  },
});
// A market can only be activated when its country has an address format in force (the readiness checklist of the market).
registerReadinessCheck(createAddressFormatReadinessCheck(address));

// The application account (ID-001): maps the verified Keycloak identity (issuer + subject) to the BananaGig account and its application roles.
const accounts = new AccountService({ database, lastSeenTouchSeconds: cfg.identity.lastSeenTouchSeconds });

const app = await buildApp({
  cfg,
  verifier,
  configuration,
  content,
  geography,
  address,
  accounts,
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
