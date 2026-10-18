import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import type { AppConfig } from '@bananagig/config';
import { API_PREFIX } from '@bananagig/contracts';
import type { CatalogService, GigTemplateService } from '@bananagig/catalog';
import type { ProviderGigService, ProviderRegistrationService } from '@bananagig/provider';
import type { TrustService } from '@bananagig/trust';
import type { ConfigurationService } from '@bananagig/configuration';
import type { ContentService } from '@bananagig/content';
import type {
  AccountAreaOperations,
  AccountService,
  ConsentOperations,
  EmailVerificationService,
  PhoneVerificationService,
  SecurityOperations,
} from '@bananagig/accounts';
import type { AddressService, GeographyService } from '@bananagig/geography';
import type { TokenVerifier } from '@bananagig/identity';
import { metrics } from '@bananagig/observability';
import { accountPlugin } from './plugins/account';
import { authPlugin } from './plugins/auth';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin, frameworkErrors } from './plugins/errors';
import { enforceStrictIntegerParams } from './plugins/strict-params';
import { configurationRoutes } from './modules/configuration/routes';
import { contentRoutes } from './modules/content/routes';
import { accountRoutes } from './modules/account/routes';
import { catalogRoutes } from './modules/catalog/routes';
import { providerRoutes } from './modules/provider/routes';
import { providerGigRoutes } from './modules/provider/gig-routes';
import { trustAdminRoutes } from './modules/trust/admin-routes';
import { trustProviderRoutes } from './modules/trust/routes';
import { consentRoutes } from './modules/consent/routes';
import { passwordResetRoutes, securityRoutes } from './modules/security/routes';
import { drainWithTimeout } from './modules/security/wiring';
import { addressRoutes } from './modules/geography/address-routes';
import { geographyRoutes } from './modules/geography/routes';
import { systemAuthRoutes, systemRootRoutes, systemV1Routes } from './modules/system/routes';

/** Longest path parameter the router accepts: above the 160-character content key limit; longer values are rejected with the standard 400. */
export const MAX_PATH_PARAM_LENGTH = 192;

/** Longest the shutdown waits for the security layer's detached work. */
export const SECURITY_DRAIN_TIMEOUT_MS = 5000;

export interface AppDeps {
  cfg: AppConfig;
  /** Critical dependencies only. See docs/engineering/API_CONVENTIONS.md (dependency criticality). */
  readiness: () => Promise<Record<string, 'up' | 'down'>>;
  /** Internal-only connectivity diagnostics (not routed by Caddy, hidden from OpenAPI). */
  diagnostics?: () => Promise<unknown>;
  /** Access-token verifier (real JWKS in production, local keys in tests). */
  verifier: TokenVerifier;
  /** Product configuration registry (internal/admin API). */
  configuration: ConfigurationService;
  /**
   * Content and localization registry (management routes are internal/admin; resolve and active locales are public). Optional only so the
   * pre-existing test harnesses that build the app without it keep compiling; index.ts and the spec generator always pass it.
   */
  content?: ContentService;
  /**
   * Geography registry (countries, markets, currencies, time zones: reads are public with visibility rules, management is internal/admin).
   * Optional for the same reason as content; routes are registered only when provided.
   */
  geography?: GeographyService;
  /** Address formats, administrative areas and the stateless validate/format operations (public reads, internal management). Routes are registered only when provided. */
  address?: AddressService;
  /** The application account (ID-001): the account routes and the requireAccount guard; routes are registered only when provided. */
  accounts?: AccountService;
  /** The email contact and its verification (ID-002); the email routes are registered only when provided together with `accounts`. */
  emailVerification?: EmailVerificationService;
  /** The phone contact and its verification (ID-003); the phone routes are registered only when provided together with `accounts`. */
  phoneVerification?: PhoneVerificationService;
  /**
   * Sessions, devices, MFA status, step-up and password reset (ID-004). Optional like the verification services: when provided together with `accounts`, the security
   * routes are registered AND requireAccount enforces the session registry (a revoked session is refused with 401 SESSION_REVOKED, a token without `sid` is refused);
   * without it requireAccount behaves exactly as before.
   */
  security?: SecurityOperations;
  /**
   * Consent and legal-version history (ID-005): the caller's relationship to the versions of the legal documents owned by the content registry. Optional like the other
   * account services; the consent routes are registered only when provided together with `accounts`.
   */
  consent?: ConsentOperations;
  /**
   * The shared account area registry (ACC-001): which sections each role sees. Optional like the other account services; the account area routes (and the section
   * guard of PUT /account/profile) are active only when provided together with `accounts`. index.ts always provides it.
   */
  accountArea?: AccountAreaOperations;
  /** The catalogue taxonomy (CAT-001): the routes are registered when provided together with `content` (names and descriptions are resolved through it). */
  catalog?: CatalogService;
  /** The Gig Templates (CAT-002), registered together with the catalogue under the same prefix. */
  gigTemplates?: GigTemplateService;
  /** The provider registration (PRO-001): registered with the account routes (it acts on the account of the verified token), so it needs `accounts`. */
  providerRegistrations?: ProviderRegistrationService;
  /** The provider Gigs (CAT-003): the GigMenu and the Gig versions of the caller; the routes act on the account of the verified token, so they need `accounts`. */
  providerGigs?: ProviderGigService;
  /** Provider verification (TRUST-001): the provider routes act on the account of the verified token, so they need `accounts`; the reviewer routes need the `trust-*` admin roles. */
  trust?: TrustService;
}

/**
 * Trust exactly `hops` reverse proxies (DEBT-0055). proxy-addr calls this for each hop counted from the socket (hop 0 is the connection peer, the first proxy); a hop
 * is trusted while its index is below the count, so `request.ip` is the first address that is NOT a trusted proxy: with 1 hop the last X-Forwarded-For entry (the one
 * the proxy wrote), with 0 hops always the socket address. A client-chosen leftmost entry is never used.
 */
export const trustHops =
  (hops: number) =>
  (_address: string, hop: number): boolean =>
    hop < hops;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // removeAdditional=false: unknown request properties are REJECTED (400) instead of silently stripped.
  // maxParamLength: Fastify's default (100) is shorter than a content key (160) and than the longest :id/:locale, which would orphan a created
  // entry. frameworkErrors routes router-level failures (over-long params, malformed URLs) through the standard error envelope.
  const app = Fastify({
    logger: false,
    // the EXACT number of trusted reverse proxies (DEBT-0055): request.ip is the address that many hops from the socket, never a client-chosen leftmost entry
    trustProxy: trustHops(deps.cfg.trustedProxyHops),
    ajv: { customOptions: { removeAdditional: false } },
    routerOptions: { maxParamLength: MAX_PATH_PARAM_LENGTH },
    frameworkErrors,
  });
  // before any route: numeric params/querystring properties must use the strict integer hook (plugins/strict-params.ts)
  enforceStrictIntegerParams(app);
  const sys = { cfg: deps.cfg, startedAt: Date.now() };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'BananaGig API',
        version: '1.0.0',
        license: { name: 'UNLICENSED', identifier: 'UNLICENSED' },
        description: 'HTTP contract for the BananaGig API. Generated from route schemas; do not edit docs/api/openapi.yaml by hand.',
      },
      servers: [{ url: 'http://api.localhost:8080', description: 'Local development via Caddy' }],
      tags: [
        { name: 'system', description: 'Operational and system information' },
        { name: 'configuration', description: 'Product configuration registry: internal/admin only (admin identity context plus a configuration permission)' },
        {
          name: 'content',
          description:
            'Content and localization registry: management is internal/admin only (admin identity context plus a content permission); resolve and the active locale list are public with visibility rules',
        },
        {
          name: 'geography',
          description:
            'Geography registry (countries, markets, currencies, time zones, market defaults): reads are public with visibility rules (ACTIVE data and public fields only), management is internal/admin only (admin identity context plus a geography permission)',
        },
        {
          name: 'account',
          description:
            "The caller's own application account (ID-001): account, application roles, active role and core profile. Authenticated with the normal web identity context; the admin context has no application account. Application roles live in PostgreSQL, not in Keycloak",
        },
        {
          name: 'security',
          description:
            "The caller's own sessions, browsers (devices) and second-factor state, the step-up protocol (RFC 9470) and the security timeline (ID-004), plus the public password-reset request. Passwords, authenticator secrets and recovery codes live in the identity provider; BananaGig stores none of them",
        },
        {
          name: 'account-area',
          description:
            'The shared account area (ACC-001): one framework for every persona. The navigation is data (a registry of sections per application role) selected by the ACTIVE role of the request; the section read models compose the profile, contact, security and consent domains and store nothing of their own. A section the active role does not have is a 404 on its endpoints, whatever the front end shows',
        },
        {
          name: 'catalog',
          description:
            'The PLATFORM-OWNED catalogue taxonomy (CAT-001): categories and service types (a Gig belongs to a provider and is not here), their availability and display order per market and the prohibited-service list. Reads are public with visibility rules (ACTIVE items enabled in an ACTIVE market, resolved names and descriptions); management needs the admin context plus catalog-read or catalog-write, a reason and writes an immutable audit row',
        },
        {
          name: 'trust',
          description:
            "Provider verification (TRUST-001): a case of requirements that policy derives from the provider's market and service types, each evidenced by documents in private storage (or an external verification) and decided by reviewers with structured reasons. No `verified` flag exists and an approved case is NOT Go-Live (PRO-003). Provider routes act on the caller's own case; reviewer routes need the trust-read, trust-review or trust-admin admin roles.",
        },
        {
          name: 'provider',
          description:
            'The provider registration of the caller (PRO-001): the same account, not a second one. The application role (identity), the registration (market, service types, status) and Go-Live eligibility (PRO-003) are separate. Contact and agreement state are composed from their owners, never stored here; verification (TRUST-001) and Gigs (CAT-003) report their own state; subscription and profile are future prerequisites reported as not available. Owner only: every route acts on the account of the verified token.',
        },
        {
          name: 'gigs',
          description:
            "The provider GigMenu (CAT-003): the offers of the caller, each built from a platform-owned Gig Template and kept as an identity with immutable versions (a draft is edited in place, publishing freezes it and supersedes the previous version, retiring is terminal and nothing is deleted). Every version is bound to the EXACT template version it was built from. A Gig is not live and not bookable: Go-Live (PRO-003), service areas, availability and search are later checkpoints. CAT-004 adds, to the DRAFT of a version, whole-set variants (mutually exclusive alternatives) and add-ons (independent extras), each adding a non-negative delta to the base price and duration, and photos for the MEDIA fields of the template version (an authorized, presigned upload that the server verifies, scans and promotes; the file never passes through the API; a short-lived owner-only preview URL); a published version's variants, add-ons and photos never change, and the next draft copies them. The price currency is the market currency, set by the server. Owner only: every route acts on the account of the verified token and another account's Gig is not found.",
        },
        {
          name: 'gig-templates',
          description:
            'The PLATFORM-OWNED Gig Templates (CAT-002): the versioned structure a provider later builds a Gig from, attached to one service type (typed fields that are fixed, configurable or required for the provider, duration guidance, allowed pricing models and service-area modes, requirement hooks). A published version is frozen; a Gig will reference the exact version it was built from. Nothing provider-specific is stored (no price, radius, area, pitch, photo or capacity). Same visibility model as the catalogue: public reads of ACTIVE templates in an ACTIVE market, management with the admin context plus catalog-read or catalog-write',
        },
        {
          name: 'consent',
          description:
            "The caller's own consent to the legal documents (ID-005): what each purpose needs, the version in force, and an append-only history of acceptances and withdrawals bound to the exact version, locale and text hash. The legal text itself is owned and served by the content registry; no account id is ever accepted",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Keycloak access token for the bananagig-api audience (Authorization Code + PKCE). Obtain it through the web app or an approved client.',
          },
        },
      },
    },
  });
  await app.register(correlationPlugin);
  await app.register(errorPlugin);
  await app.register(authPlugin, { verifier: deps.verifier, realm: deps.cfg.identity.realm });

  await app.register(systemRootRoutes, { ...sys, readiness: deps.readiness });
  await app.register(systemV1Routes, { ...sys, prefix: API_PREFIX });
  await app.register(systemAuthRoutes, { prefix: API_PREFIX });
  await app.register(configurationRoutes, { prefix: `${API_PREFIX}/configuration`, configuration: deps.configuration });
  if (deps.content) await app.register(contentRoutes, { prefix: `${API_PREFIX}/content`, content: deps.content });
  if (deps.geography) await app.register(geographyRoutes, { prefix: `${API_PREFIX}/geography`, geography: deps.geography });
  if (deps.address) await app.register(addressRoutes, { prefix: `${API_PREFIX}/geography`, address: deps.address });
  if (deps.catalog && deps.content)
    await app.register(catalogRoutes, { prefix: `${API_PREFIX}/catalog`, catalog: deps.catalog, gigTemplates: deps.gigTemplates, content: deps.content });
  if (deps.trust) await app.register(trustAdminRoutes, { prefix: `${API_PREFIX}/admin/trust`, trust: deps.trust });
  if (deps.accounts) {
    await app.register(accountPlugin, {
      accounts: deps.accounts,
      emailVerification: deps.emailVerification,
      phoneVerification: deps.phoneVerification,
      security: deps.security,
      consent: deps.consent,
      accountArea: deps.accountArea,
    });
    await app.register(accountRoutes, {
      prefix: API_PREFIX,
      emailRoutes: deps.emailVerification !== undefined,
      phoneRoutes: deps.phoneVerification !== undefined,
      areaRoutes: deps.accountArea ? { securitySummary: deps.security !== undefined, privacySummary: deps.consent !== undefined } : undefined,
    });
    if (deps.providerRegistrations) await app.register(providerRoutes, { prefix: `${API_PREFIX}/provider`, registrations: deps.providerRegistrations });
    if (deps.providerGigs) await app.register(providerGigRoutes, { prefix: `${API_PREFIX}/provider`, gigs: deps.providerGigs });
    if (deps.trust) await app.register(trustProviderRoutes, { prefix: `${API_PREFIX}/provider/verification`, trust: deps.trust });
    if (deps.security) {
      const security = deps.security;
      // graceful stop (index.ts closes the database only after app.close()): wait, bounded, for the detached password-reset work
      app.addHook('onClose', async () => drainWithTimeout(security.drain?.bind(security), SECURITY_DRAIN_TIMEOUT_MS));
      await app.register(securityRoutes, { prefix: API_PREFIX });
      await app.register(passwordResetRoutes, { prefix: API_PREFIX });
    }
    if (deps.consent) await app.register(consentRoutes, { prefix: API_PREFIX });
  }

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => reply.type(metrics.contentType).send(await metrics.metrics()));
  if (deps.diagnostics) {
    const d = deps.diagnostics;
    app.get('/internal/diagnostics', { schema: { hide: true } }, async () => d());
  }
  return app;
}
