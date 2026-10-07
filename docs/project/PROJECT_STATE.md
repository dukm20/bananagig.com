# Project State

Current truth only. History lives in `IMPLEMENTATION_HISTORY.md`; decisions in `docs/architecture/`.

Current checkpoint: GEO-002
Last completed checkpoint: GEO-002
Next approved checkpoint: ID-001 — User / Account / Role Model
Latest migration: 0008_address_model.sql
Latest ADR: ADR-0024
Last updated: 2026-10-07

## Architecture

Modular monolith in a pnpm/Turborepo workspace. PostgreSQL (with PostGIS) is authoritative; NATS JetStream carries events; Valkey, OpenSearch and S3 (SeaweedFS) hold derived data and blobs. Everything runs locally under Docker Compose behind Caddy. See `docs/engineering/APPLICATION_ARCHITECTURE.md` and `docs/engineering/CONTAINER_ARCHITECTURE.md`.

## Applications

| App | State |
|---|---|
| `apps/web` (container `web-app`) | Next.js 16 App Router shell. Infrastructure pages only: `/`, `/health`, `/system`, `/session`; `/healthz`, `/readyz`, `/metrics`; auth routes `/auth/login`, `/auth/callback`, `/auth/session`, POST `/auth/logout` (PKCE, server-side session in Valkey). Typed API client with `getSystemInfo()`, `getWhoAmI()`, `resolveContent()`, `resolveManyContent()` and `listContentLocales()`. The home and session pages read their shell copy from the content registry through the API (server-side utility `src/lib/content.ts`, locale negotiation from `Accept-Language` against the active locales); the only static copy is the bootstrap set `BOOTSTRAP_COPY` (wordmark, `Sign in`, `Sign out`) and the error, not-found and loading shells |
| `apps/api` (container `api-service`) | Fastify 5. `GET /healthz`, `/readyz`, `/version`, `/api/v1/system/info`, `/api/v1/system/whoami` (requires a Keycloak access token), the configuration module under `/api/v1/configuration` (admin context plus `configuration-read/write/approve` client roles), and the content module under `/api/v1/content` (15 endpoints: entries, versions with submit/approve/reject/cancel/publish, locales, snapshots, public `resolve` and `resolve-many`; admin context plus `content-read/write/approve` and `content-legal` client roles; public routes serve PUBLIC entries only). Standard error model, correlation ids, auth guards (401/403). The geography module under `/api/v1/geography` (public reads of ACTIVE countries, markets, market defaults, currencies and time zones with an optional bearer; management views and writes for admin context plus `geography-read` and `geography-write`, where write implies read) with `Vary: Authorization` on public routes. Address operations under the same prefix (GEO-002): public reads of a country's address format and administrative areas, stateless public `validate` and `format` (no persistence, no logging, `Cache-Control: no-store`), and management of format drafts, publication and areas (`geography-read/write`); no route creates or reads a persisted address |
| `apps/worker` (container `worker-service`) | pg-boss + NATS host with health server and the transactional-outbox relay (publishes to JetStream stream `BANANAGIG_EVENTS`). Jobs: infrastructure `infra.ping`, `configuration.activate-due` and `content.activate-due` (cron, every minute). Events: `bananagig.infra.ping.v1`, the five `bananagig.configuration.*.v1` events and the four `bananagig.content.*.v1` events (`version-approved`, `version-scheduled`, `version-published`, `legal-document-published`) via the outbox |
| `apps/smoke` | 31-check connectivity test (`pnpm smoke`), including identity, the configuration registry, the content registry, geography and addresses |

Packages: `geography` (countries, currencies, time zones, markets: service, readiness registry, cache, and the scope-reference validator and market-default provider ports; since GEO-002 also the pure address engine, `AddressService` and the provider-neutral autocomplete, geocoder and verification ports with in-memory mocks), `configuration` (registry service, resolver, cache with bounded Valkey I/O, last-known-good), `content` (content registry: locales, restricted template formatter, zero-dependency markup renderer, resolver, cache, service), `identity` (JWT verification, OIDC/PKCE helpers, DEV/TEST-only `/testing`), `contracts`, `config`, `observability` (incl. DB telemetry), `database` (Kysely + pg, pool policies, transaction options, lock helpers), `platform` (adapters, outbox store), `testing` (isolated migrated test databases).

## Infrastructure

Compose service keys are descriptive role names and containers are `bananagig-<service key>` (convention in `docs/engineering/CONTAINER_ARCHITECTURE.md`). Profiles: `core` (postgres-db, valkey-cache, nats-events, seaweedfs-storage, seaweedfs-storage-init, keycloak-auth, flagd-flags, api-service, worker-service, web-app, caddy-proxy), `observability` (otel-collector, prometheus-metrics, grafana-dashboard, loki-logs, tempo-traces), `search` (opensearch-search), `devtools` (mailpit-email), `tools` (smoke). Identity: Keycloak realm `bananagig` from `infra/keycloak/bananagig-realm.json` (admin client roles `configuration-read/write/approve` added in CFG-001 and `content-read/write/approve/legal` added in CFG-002 and `geography-read/write` added in GEO-001; clients `bananagig-web`, `bananagig-api`, `bananagig-admin`, dev-only `bananagig-dev-test`); the issuer is pinned to the public URL; Caddy exposes only realm endpoints on `auth.localhost`. Local entry point: caddy-proxy on 127.0.0.1:8080 (`*.localhost`). Dev mode: `pnpm dev` runs apps on the host (web 3210, api 3211, worker 3212) with dependency containers via `compose.dev.yaml`.

## Database schemas

| Schema | Class | Contents |
|---|---|---|
| `public` | application bookkeeping + extension | `schema_migrations` (version PK, filename, checksum, applied_at, duration_ms); `spatial_ref_sys` (PostGIS) |
| `integration` | application | `outbox_events` (transactional outbox) |
| `configuration` | application | 10 tables: `scope_levels` (seeded hierarchy), `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` |
| `geography` | application | 12 tables (8 from GEO-001 plus `administrative_areas`, `address_formats`, `address_format_fields`, `addresses` from GEO-002): `currencies` (ISO 4217, `minor_unit_digits` is data), `time_zones` (IANA names validated against the database tz data), `countries` (ISO codes, display-name content key, default currency and locale, format settings as enum codes), `country_locales`, `country_time_zones`, `markets` (own default locale, currency and time zone, half-open effective window), `market_locales`, `audit_events`. Seeded: USD, four US time zones, US (ACTIVE) and the market `la-oc` (PLANNED). References `content.locales` (the single locale authority), `content.entries` and `integration`. GEO-002: ordered, versioned, effective-dated address formats whose labels are content keys, 51 seeded US areas (50 states and DC), the immutable canonical structured address with one PostGIS point and the exact format version it used; `audit_events` also records format drafts, publications and area changes. Seeded: US address format v1 and 12 content entries (field labels with US-scoped wording, validation messages) |
| `content` | application | 8 tables: `locales` (seeded en-US, the platform default; extended by GEO-001 with `display_name` and generated `language`, `script`, `region`), `entries`, `entry_variables`, `versions` (lifecycle and effective-dated immutable localized bodies), `version_approvals`, `snapshots`, `snapshot_items`, `audit_events` |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queues `infra.ping`, `configuration.activate-due`, `content.activate-due` |
| (database `keycloak`) | infrastructure (Keycloak) | separate database |

No business tables and no business parameters (the configuration registry is empty of product configuration; `scope_levels` is structural reference data). The content registry holds only 8 seeded product-shell strings (brand name and tagline, sign-in/out labels, session status and error, home confirmation), en-US only; no prices, policies, legal text or marketplace copy. Product schemas are created by the first feature that needs each (ADR-0008); the reserved names are listed in `docs/data/DATA_MODEL.md`. Conventions: `docs/data/DATABASE_CONVENTIONS.md`. Migration rules: `docs/data/MIGRATION_POLICY.md` (forward-only, ADR-0010). Local DB access uses the Postgres superuser (DEV ONLY, DEBT-0012).

## External integrations

None to external services. Local-only stand-ins: Mailpit (SMTP sink), Keycloak realm `bananagig` with dev-only users (`customer.dev`, `provider.dev`, `admin.dev`, `admin2.dev`), flagd (one flag).

## Active feature flags

`dev-test-flag` (flagd, `infra/flagd/flags.json`), a connectivity test flag, not a product flag.

## Completed capabilities

- Local container platform with health, readiness and a passing connectivity smoke test
- Typed validated configuration, structured logging, tracing, request correlation (HTTP, DB transaction setting, jobs, events)
- API skeleton with generated OpenAPI 3.1, AsyncAPI 3.0 event envelope, standard error model
- Database foundation: forward-only checksum-guarded migrations with advisory-lock serialization, per-role pool and timeout policy, transaction helper (isolation, read-only, timeouts, nesting rules), row-lock and advisory-lock helpers, DB telemetry (query/transaction/pool metrics, slow-query warning)
- Transactional outbox with JetStream relay (ADR-0012)
- Isolated per-file test databases migrated from zero; backup/restore development check (`pnpm db:backup-test`)
- Worker runtime with graceful shutdown
- Workspace dependency rules enforced by script and lint
- Identity baseline: Keycloak realm as code, Authorization Code + PKCE web login with server-side session, API JWT validation (signature, issuer, audience, expiry, type) with guards and `whoami`, admin client separated with MFA-ready flow, auth telemetry, production realm builder, live protocol and end-to-end tests (ADR-0013 to 0015)
- Configuration registry (CFG-001): typed parameters; scope hierarchy PLATFORM to DROP; immutable effective-dated versions with database overlap prevention; change requests with NONE/OWNER/SECOND_APPROVER policies; scheduled activation; immutable snapshots; append-only audit; transactional-outbox events; Valkey cache with last-known-good for STANDARD parameters only (ADR-0016, ADR-0017)
- Content registry (CFG-002): stable keys; locales with a data-driven deterministic fallback (CHAIN, LANGUAGE_ONLY, EXACT; legal never falls back); immutable effective-dated versions with a database lifecycle state machine and overlap prevention; two-person approval for legal documents (legal documents are `LEGAL` entries with `body_sha256` for future consent records); typed template variables with a restricted, non-executable formatter and a sanitized Markdown-subset renderer; batched 3-query resolver; Valkey cache with bounded I/O and last-known-good for STANDARD entries only (never legal or critical); immutable snapshots; append-only audit; transactional-outbox events; scheduled activation job; web utility with bootstrap policy (ADR-0018 to ADR-0020)
- Geography registry (GEO-001): data-driven countries, currencies, time zones and markets with deterministic market defaults (`resolveMarketDefaults`: country formats plus market locale, currency and time zone, no code fallback); activation rules enforced by database triggers and an extensible in-code readiness registry (derived, never stored); one locale authority (`content.locales`); COUNTRY and MARKET scope references of configuration and content validated through a port; content derives the market default locale and hides non-visible markets from public callers; protected management API and public reads; six outbox events; audited writes (ADR-0021, ADR-0022)
- Address model (GEO-002): country-driven address formats (ordered fields, requirement, length, input type, pattern, example, normalization, display template) read by every form and by the server validator from the same records, with no country-specific code or column; labels and validation messages are content keys; administrative areas as a lookup or free text per format; one canonical, immutable structured address (raw input preserved, validation status and source, one `geography(Point,4326)`, time zone reference, the format version used) that doubles as the booking snapshot; central validator and formatter; versioned effective-dated formats with a database exclusion constraint and a country-row lock for publication; management API for formats and areas so a country is added with data only; ADDRESS_FORMAT market readiness check; manual-entry fallback marked UNVERIFIED; provider-neutral adapter ports with mocks; privacy rules (no logging, redaction, stateless public endpoints, no persisted-address route); two outbox events; shared cache with invalidation (ADR-0023, ADR-0024)
- Content ownership rules and string inventory: `docs/content/CONTENT_OWNERSHIP.md`
- Governance system: project state, history, learnings, debt, skills, ADRs, data-model gate, checkpoint scripts

## Partially implemented capabilities

- PWA: manifest only (DEBT-0003)
- Identity: notifications/recovery flows (DEBT-0017), WebAuthn and step-up (DEBT-0018), account console/theme (DEBT-0019), host-mode login (DEBT-0020), secret manager and production realm provisioning (DEBT-0016)
- Configuration: temporary client-role permissions (DEBT-0021), activation marker lag and cache invalidation limits, also for content (DEBT-0022), no admin UI (DEBT-0023), unvalidated scope references, also for content (DEBT-0024), retention undefined (DEBT-0025)
- Content: no translation workflow or second locale (DEBT-0026), no admin UI, rich editor or media library (DEBT-0027), temporary permissions and unenforced owner roles (DEBT-0028), shell copy only; other text channels unmanaged (DEBT-0029)
- No rate limiting on public API endpoints (DEBT-0030), including the public geography reads
- Addresses: no autocomplete, geocoder or verification vendor and no per-country provider selection (DEBT-0037), retention, erasure and exact-location access undefined (DEBT-0036), phone rules (DEBT-0038), no admin UI or draft management (DEBT-0039), US-only address data (DEBT-0040), markets do not reference an administrative area (DEBT-0041), data-driven patterns run without RE2 isolation (DEBT-0042); DEBT-0032 and DEBT-0034 are in progress
- Geography: US-only dataset and no management API or bulk import for currencies, time zones or locale activation (DEBT-0031), only the four built-in readiness checks (DEBT-0032), cache generation coupled to content's locale generation key (DEBT-0033), no automatic time zone lookup (DEBT-0034); scope references of CATEGORY, PLAN, PROVIDER, GIG and DROP still unvalidated (DEBT-0024 in progress)
- Idempotency records table designed, not built (DEBT-0013)
- Least-privilege runtime database roles designed, not built (DEBT-0012)
- CI: every run through `f3f326f` (`CI-003`, run 37578136291: verify 4m 18s and compose-smoke 3m 49s, status Success) is green, including the geography work; the GEO-002 commit has not been pushed, so its CI result is not recorded here. Branch protection requiring CI is not configured (DEBT-0001)
- Web telemetry: SDK registered; page-level traces and logs not verified in Tempo/Loki (DEBT-0011)

## Known blockers

None.

## Test counts

Unit: 1524 (config 6, contracts 143, observability 16, identity 20, configuration 42, content 754, geography 275, api 178, worker 10, web 80) plus 71 root script tests (governance 46, identity realm 24, migration files 1). Integration: 507 in 21 files (includes address model rules 49, address service 59, API addresses 14, geography database rules 42, geography service 55, API geography 11, cross-domain geography 19, content 96, content API 12, configuration 52, Keycloak 21). Smoke: 31 checks.
