import { loadConfig, redactConfig } from '@bananagig/config';
import { createDatabase } from '@bananagig/database';
import { createDbTelemetry, getCorrelationId, registerPoolMetrics, initObservability, log, shutdownObservability } from '@bananagig/observability';
import {
  DisabledSmsTransport,
  FakePhoneIntelligence,
  NatsClient,
  RenderingSmsSender,
  S3PrivateObjectStore,
  SmtpEmailSender,
  UnknownPhoneIntelligence,
  ValkeyFakeSmsTransport,
  ValkeyRateLimiter,
  closeValkey,
  createS3,
  createS3Presigner,
  createValkey,
  runDiagnostics,
} from '@bananagig/platform';
import { ConfigurationService, ValkeyConfigCache } from '@bananagig/configuration';
import { ContentService } from '@bananagig/content';
import { CatalogService, GigTemplateService, createCatalogScopeReferenceValidator } from '@bananagig/catalog';
import { ProviderGigService, ProviderRegistrationService } from '@bananagig/provider';
import { DisabledEvidenceScanner, DisabledVerificationProvider, FakeEvidenceScanner, FakeVerificationProvider, TrustService } from '@bananagig/trust';
import { AccountAreaService, AccountService, ConsentService, EmailVerificationService, PhoneVerificationService, SecurityService } from '@bananagig/accounts';
import {
  AddressService,
  GeographyService,
  createAddressFormatReadinessCheck,
  createGeographyScopeReferenceValidator,
  createMarketDefaultsProvider,
  registerReadinessCheck,
} from '@bananagig/geography';
import { KeycloakAdminClient, createTokenVerifier } from '@bananagig/identity';
import { buildApp } from './app';
import { createContentSmsRenderer, createPhoneCountryDirectory, createPhonePolicyProvider } from './modules/account/phone-wiring';
import { composeScopeReferenceValidators, createMarketGate } from './modules/catalog/wiring';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';
import { createGigPolicyProvider, createGigPrerequisites, createGigTemplatePort } from './modules/provider/gig-wiring';
import { createProviderContextPort, createTrustPolicyProvider, createTrustPrerequisites } from './modules/trust/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createKeycloakSecurityIdentityProvider, createSecurityPolicyProvider, createUnavailableSecurityIdentityProvider } from './modules/security/wiring';
import { createContentEmailRenderer, createVerificationLinkBuilder, createVerificationPolicyProvider } from './modules/account/email-wiring';

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
// The catalogue taxonomy (CAT-001): platform-owned categories and service types. The public visibility of a market is geography's decision (a port, no package imports another).
const catalog = new CatalogService({
  database,
  markets: createMarketGate(geography),
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  allowTestKeys: cfg.env !== 'production', // devtest_* codes are DEV/TEST only
});
// The Gig Templates (CAT-002): the versioned structure a provider later builds a Gig from; same market gate, cache generation and test-key rule as the taxonomy.
const gigTemplates = new GigTemplateService({
  database,
  markets: createMarketGate(geography),
  cache: new ValkeyConfigCache(valkey),
  env: cfg.env,
  cacheTtlSeconds: cfg.configuration.cacheTtlSeconds,
  allowTestKeys: cfg.env !== 'production',
});
// One scope reference validator out of its owners (DEBT-0024): geography owns COUNTRY and MARKET, the catalogue owns CATEGORY.
const scopeReferences = composeScopeReferenceValidators([createGeographyScopeReferenceValidator(geography), createCatalogScopeReferenceValidator(catalog)]);

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

// Email verification (ID-002): BananaGig-owned email contact state. Limits come from the configuration registry (CFG-001), the message from the content registry
// (CFG-002) and the delivery from the EmailSender port (SMTP to Mailpit locally and in CI; a production provider implements the same port, DEBT in TECH_DEBT).
// The abuse limiter is the reusable Valkey rate-limit foundation; it fails closed for operations that send mail.
const emailVerification = new EmailVerificationService({
  database,
  policy: createVerificationPolicyProvider(configuration),
  sender: new SmtpEmailSender(
    { host: cfg.smtp.host, port: cfg.smtp.port, from: cfg.mailFrom, insecureLocal: cfg.env !== 'production' },
    createContentEmailRenderer(content),
  ),
  linkFor: createVerificationLinkBuilder(cfg.identity.webPublicUrl),
  hashSecret: cfg.verification.hashSecret,
  rateLimiter: new ValkeyRateLimiter(valkey),
});

// Phone verification (ID-003): BananaGig-owned phone contact state. The limits and the country/market policy come from the configuration registry (CFG-001), the SMS text
// from the content registry (CFG-002), the countries from geography, the delivery from the SmsSender port (the Valkey sink in dev/CI, nothing in production until a
// provider is chosen: DEBT-0059) and the line type from the PhoneIntelligence port (a deterministic fake in dev/CI, UNKNOWN in production until a vendor is chosen:
// DEBT-0060). Configuration refuses the fake adapters in production.
const phoneVerification = new PhoneVerificationService({
  database,
  policy: createPhonePolicyProvider(configuration),
  sender: new RenderingSmsSender(
    createContentSmsRenderer(content),
    cfg.sms.transport === 'fake' ? new ValkeyFakeSmsTransport(valkey, cfg.env) : new DisabledSmsTransport(),
  ),
  intelligence: cfg.phoneIntelligence === 'fake' ? new FakePhoneIntelligence() : new UnknownPhoneIntelligence(),
  countries: createPhoneCountryDirectory(geography),
  hashSecret: cfg.verification.hashSecret,
  rateLimiter: new ValkeyRateLimiter(valkey),
});

// Account security (ID-004): the application session registry, devices, MFA status and password reset. Passwords, TOTP, recovery codes and protocol sessions stay in
// Keycloak (ADR-0034): the admin client only ASKS it and ends sessions, with a dedicated service account (bananagig-security). The limits come from the configuration
// registry (CFG-001). Without an admin client secret the provider reports itself unavailable (MFA state unknown, revocation application-side only). The abuse limiter
// is the Valkey rate-limit foundation and fails closed (every password-reset request can send an email).
const securityIdentity = cfg.keycloakAdmin.clientSecret
  ? createKeycloakSecurityIdentityProvider(
      new KeycloakAdminClient({
        baseUrl: cfg.keycloakAdmin.baseUrl,
        realm: cfg.keycloakAdmin.realm,
        clientId: cfg.keycloakAdmin.clientId,
        clientSecret: cfg.keycloakAdmin.clientSecret,
        resetEmail: { clientId: cfg.identity.webClientId, redirectUri: `${cfg.identity.webPublicUrl}/session` },
      }),
    )
  : createUnavailableSecurityIdentityProvider();
const security = new SecurityService({
  database,
  policy: createSecurityPolicyProvider(configuration),
  identityProvider: securityIdentity,
  rateLimiter: new ValkeyRateLimiter(valkey),
  hashSecret: cfg.verification.hashSecret,
});

// Consent and legal-version history (ID-005): the account's relationship to the versions of the legal documents (CFG-002 owns the documents and their immutable
// versions; this layer owns only the append-only acceptance record and derives the state). Who needs which purpose and what a newer version does to an existing
// acceptance come from the configuration registry (CFG-001, `consent.<purpose>.required_for` / `.reacceptance`, no code default); the default locale is the platform
// default row of the content registry.
const consent = new ConsentService({
  database,
  policy: createConsentPolicyProvider(configuration),
  defaultLocale: createDefaultLocaleResolver(content),
});

// The shared account area (ACC-001): the registry of sections per application role (data in identity.account_sections / account_section_roles). It owns no state of its own
// (the section read models compose the profile, contact, security and consent domains) and reads one indexed query per request; nothing is cached.
const accountArea = new AccountAreaService({ database });

// The provider registration (PRO-001): the registration of an account that wants to become a provider. A provider is the SAME account; the contact, consent, market and catalogue
// state it composes are read through ports over their owning services (no package imports another), the policy from the configuration registry, and its `verification` step is
// answered by the verification domain (TRUST-001); subscription and profile report NOT_AVAILABLE until their checkpoints exist, and its `gigs` step is answered by the Gig domain (CAT-003). It shares the `database` of the account
// service, so the role request joins its transaction.
const providerAccountPort = createAccountPort(accounts);
const providerPolicy = createProviderPolicyProvider(configuration);
const registrations: { current?: ProviderRegistrationService } = {};

// Provider verification (TRUST-001): a case of requirements derived from the registration's market and service types. Evidence lives in the PRIVATE bucket (presigned, one object,
// short-lived); scanning and external verification are ports whose production default fails closed (no scanner and no vendor exist yet). It reads the registration through the
// registration's own ports (a lazy getter: the registration is constructed with the verification prerequisite below).
const trust = new TrustService({
  database,
  context: createProviderContextPort({ accounts: providerAccountPort, policy: providerPolicy, registrations: () => registrations.current! }),
  policy: createTrustPolicyProvider(configuration),
  store: new S3PrivateObjectStore({ client: s3, presignClient: createS3Presigner(cfg), bucket: cfg.s3.bucket }),
  scanner: cfg.trust.scanner === 'fake' ? new FakeEvidenceScanner() : new DisabledEvidenceScanner(),
  external: cfg.trust.externalProvider === 'fake' ? new FakeVerificationProvider() : new DisabledVerificationProvider(),
});

// The provider Gigs (CAT-003): the offers of a provider, built from the platform-owned Gig Templates. The template facts are read through a port over the Gig Template service (an
// EXACT version: a Gig keeps the one it was built from), the policy from the configuration registry, the account facts through the same account port as the registration. The Gig
// service reads the registration state in its own tables (nothing is injected from the registration), so the registration's `gigs` step can be answered by it without a cycle.
const providerGigs = new ProviderGigService({
  database,
  accounts: providerAccountPort,
  templates: createGigTemplatePort(gigTemplates),
  policy: createGigPolicyProvider(configuration),
});
const providerRegistrations = (registrations.current = new ProviderRegistrationService({
  database,
  accounts: providerAccountPort,
  consent: createConsentPort(consent),
  markets: createMarketPort(geography),
  catalog: createCatalogPort(catalog),
  policy: providerPolicy,
  prerequisites: createTrustPrerequisites(trust, createGigPrerequisites(providerGigs)),
}));

const app = await buildApp({
  cfg,
  verifier,
  configuration,
  content,
  geography,
  address,
  accounts,
  emailVerification,
  phoneVerification,
  security,
  consent,
  accountArea,
  catalog,
  gigTemplates,
  providerRegistrations,
  providerGigs,
  trust,
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
