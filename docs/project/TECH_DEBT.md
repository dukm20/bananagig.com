# Technical Debt

Every knowingly postponed item is recorded here, not buried in completion reports. IDs are permanent. Statuses: OPEN, IN_PROGRESS, ACCEPTED (a conscious, documented risk), RESOLVED (keep the entry).

## DEBT-0001 — CI workflow never executed

Status: IN_PROGRESS
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: `.github/workflows/ci.yml` (verify, integration, compose-smoke, Trivy, governance) was written in INF-001 and first executed on 2026-10-06 (UTC) when the owner pushed `main` to github.com/dukm20/bananagig.com. Run #1 (commit 17b6b8d) failed at `pnpm audit --prod`, which skipped the governance checks and the compose-smoke job. CI-001 fixed the cause and run #2 (commit 14db38d) passed every job: verify (including governance) and compose-smoke. The remaining gap is that nothing enforces CI before merging.
Why deferred: pushing is a separate explicit human decision; checkpoint tooling never pushes.
Exit criteria: branch protection on `main` requiring the `verify` and `compose-smoke` jobs (a repository setting the owner must apply; the checkpoint tooling cannot).
Target checkpoint: first checkpoint after a remote is configured

## DEBT-0002 — Transactional outbox not implemented

Status: RESOLVED
Severity: MEDIUM
Introduced by: INF-002
Owner/domain: worker / database
Description: The guardrails require a transactional outbox, but there is no outbox table and no relay loop. Only the `OutboxRelay` and `EventPublisher` ports and `NatsEventPublisher` exist.
Why deferred: no product event exists to publish; a table without a producer would be speculative schema.
Exit criteria: outbox table (migration + data-model gate), a relay using `FOR UPDATE SKIP LOCKED`, idempotent publishing, and an ADR.
Target checkpoint: INF-003 (done)
Resolved by: INF-003. `integration.outbox_events` (migration 0003), `insertOutboxEvent`, the `PollingOutboxRelay` publishing through JetStream with message-id de-duplication, retention purge, and ADR-0012. Verified by `apps/worker/src/outbox.itest.ts` and the smoke check "Worker runtime". Consumer-side idempotency tables remain future work (DEBT-0013).

## DEBT-0003 — PWA is manifest-only

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web
Description: The web app has a manifest but no icons and no service worker, so it is not installable and has no offline behavior.
Why deferred: no product screens to cache; icons need brand assets.
Exit criteria: brand icons, service worker strategy decided (ADR), installability verified.
Target checkpoint: first customer-facing web checkpoint

## DEBT-0004 — Development-only security posture of local stack

Status: ACCEPTED
Severity: MEDIUM
Introduced by: INF-001
Owner/domain: infrastructure
Description: Keycloak runs `start-dev` (and INF-004 added a dev-only admin console host `keycloak-admin.localhost` in Caddy), OpenSearch has its security plugin disabled, Caddy serves plain HTTP, and development credentials are in `.env.example`. `/internal/diagnostics` has no authentication (it relies on not being routed by Caddy).
Why deferred: local development convenience; production deployment is out of scope so far.
Exit criteria: a production deployment design with TLS, real secrets management, Keycloak `start`, OpenSearch security, and authenticated or removed diagnostics.
Target checkpoint: production deployment checkpoint

## DEBT-0005 — Images pinned by tag, not digest

Status: OPEN
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Compose and the Dockerfile pin explicit tags (for example `valkey/valkey:8.1-alpine`, `node:24-alpine`) but not content digests, so a tag could change underneath a build.
Why deferred: digests need a refresh process (Renovate/Dependabot) that is not set up.
Exit criteria: digests pinned with automated update PRs.
Target checkpoint: first checkpoint after CI runs (DEBT-0001)

## DEBT-0006 — Web container does not drain on SIGTERM

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web
Description: The Next.js standalone server exits with code 143 on SIGTERM instead of draining in-flight requests. api and worker shut down gracefully.
Why deferred: the web tier is stateless and Compose restarts are fast; Next has no supported drain hook.
Exit criteria: a small wrapper/custom server that stops accepting and drains, or an upstream hook.
Target checkpoint: production deployment checkpoint

## DEBT-0007 — Accepted advisories in dev-only tooling

Status: ACCEPTED
Severity: LOW
Introduced by: INF-002
Owner/domain: infrastructure
Description: `pnpm audit` still reports braces (high, no patch), ajv, sprintf-js and @babel/core through the AsyncAPI CLI toolchain. Dev/CI only; never in an image. See `docs/security/SCAN_RESULTS.md`.
Why deferred: no fixed versions are available upstream.
Exit criteria: re-audit at each dependency refresh; replace the AsyncAPI CLI with `@asyncapi/parser` if findings persist.
Target checkpoint: INF-004
Re-audited in CI-001 (2026-10-05): the @babel/core finding is RESOLVED by a scoped override (`docs/security/SCAN_RESULTS.md`). `pnpm audit --prod` now reports no vulnerabilities; the full audit reports braces (high), ajv x2 and sprintf-js (moderate), all unchanged and dev/CI only. Entry stays ACCEPTED for those four.
Re-audited in INF-003 (2026-10-05): unchanged. `pnpm audit --prod` reports 1 low; full audit reports braces (high, no patch), sprintf-js (moderate, no patch), ajv (moderate x2) and @babel/core (low), all in the AsyncAPI CLI toolchain, dev/CI only.

## DEBT-0008 — AGPL licensing review for Grafana, Loki, Tempo

Status: OPEN
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Grafana, Loki and Tempo are AGPL-3.0. Fine as unmodified internal tools, but a hosted offering needs a licensing review.
Why deferred: no hosted offering yet.
Exit criteria: documented legal sign-off or replacement of the Grafana stack components.
Target checkpoint: production deployment checkpoint

## DEBT-0009 — otel-collector and flagd have no Compose healthcheck

Status: ACCEPTED
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Both images are distroless (no shell), so no container healthcheck exists; the smoke test verifies them by connectivity instead.
Why deferred: no supported shell-free healthcheck.
Exit criteria: upstream health binaries, or a sidecar/healthcheck wrapper image.
Target checkpoint: production deployment checkpoint

## DEBT-0010 — INF-001 bootstrap verified from a copied tree, not a fresh git clone

Status: RESOLVED
Severity: LOW
Introduced by: INF-002
Owner/domain: infrastructure
Description: The clean bootstrap was proven by copying `git ls-files -co --exclude-standard` into an empty directory and running install, checks, build, stack start, migrate and smoke. A real `git clone` could not be tested because no commit exists.
Why deferred: the baseline commit awaits the user's approval.
Exit criteria: after the baseline commit, repeat the sequence from `git clone`.
Target checkpoint: INF-003 (done)
Resolved by: INF-003. A real `git clone` of baseline commit 97936a3 into an empty directory: `cp .env.example .env`, `pnpm install --frozen-lockfile`, lint, typecheck, 34 tests, build, boundaries, specs check, `pnpm stack:all`, `pnpm migrate`, `pnpm smoke` (22 checks) all passed with no `.env` or `node_modules` in the clone.

## DEBT-0011 — Web telemetry not verified end to end

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web / observability
Description: `instrumentation.ts` registers the OpenTelemetry SDK and the web logger exists, but page-request traces (Tempo) and web logs (Loki) were not asserted by the smoke test.
Why deferred: only API and worker telemetry were required for the checkpoint.
Exit criteria: smoke test finds a web trace in Tempo and a web log line in Loki.
Target checkpoint: first customer-facing web checkpoint

## DEBT-0012 — Runtime database access uses the superuser in local development

Status: OPEN
Severity: MEDIUM
Introduced by: INF-001 (documented in INF-003)
Owner/domain: database / security
Description: API, worker and the migration runner connect as the Postgres bootstrap superuser (`bananagig`). The target model (migrator role owning schemas, non-superuser `bananagig_app` runtime role with DML-only grants, pg-boss schema pre-created by the migrator) is designed in `docs/data/DATABASE_CONVENTIONS.md` section 11 but not built.
Why deferred: pg-boss needs DDL rights unless its schema is pre-created from its construction plan, and the role/grant bootstrap needs a production-shaped provisioning story; both are larger than this checkpoint and local-only risk is low.
Exit criteria: separate migrator and runtime roles in the local stack, api and worker connect as the runtime role, pg-boss schema created by the migrator, an integration test proving the runtime role cannot run DDL or create extensions.
Target checkpoint: production deployment checkpoint
Reviewed in INF-004: the identity baseline needed no per-service database roles (the API validates tokens and has no identity persistence); unchanged.

## DEBT-0013 — Idempotency records table not built

Status: OPEN
Severity: LOW
Introduced by: INF-003
Owner/domain: database / integration
Description: A generic `integration.idempotency_records` table is designed (`DATABASE_CONVENTIONS.md` section 10) but not created, because no externally triggered write exists yet.
Why deferred: schema without a first user would be speculative; the design and entry point are documented.
Evaluated again in ID-001 and NOT built: the new write paths are idempotent by natural uniqueness plus a transactional retry (account bootstrap by the external identity unique key, role grant by the membership primary key, profile and status changes by comparing before writing), and none is triggered by an external system that retries with its own key. A generic table now would have no first user.
Exit criteria: first checkpoint with webhooks or an `Idempotency-Key` operation adds the table through the data-model gate, written in the same transaction as the effect.
Target checkpoint: first checkpoint with externally triggered writes (payments or public API writes)

## DEBT-0014 — Migrations cannot contain non-transactional statements

Status: OPEN
Severity: LOW
Introduced by: INF-003
Owner/domain: database
Description: Each migration runs in one transaction, so `CREATE INDEX CONCURRENTLY` and similar statements are unsupported. Large-table index builds in production will need them.
Why deferred: no large tables exist; the safe design (explicit `no-transaction` marker, one statement per file, reviewed) should be built against a real need.
Exit criteria: a reviewed no-transaction mode with partial-failure handling documented and tested.
Target checkpoint: first migration that indexes a table large enough to matter

## DEBT-0015 — Backup/restore is a development check only

Status: ACCEPTED
Severity: LOW
Introduced by: INF-003
Owner/domain: database / operations
Description: `pnpm db:backup-test` proves pg_dump/pg_restore and migration compatibility on a scratch database. It is not run in CI and is not a production disaster-recovery capability (no scheduled backups, point-in-time recovery, or restore drills).
Why deferred: production hosting is undecided.
Exit criteria: production backup strategy, PITR, and a scheduled restore drill.
Target checkpoint: production deployment checkpoint

## DEBT-0016 — Production secret manager and realm provisioning not wired

Status: OPEN
Severity: MEDIUM
Introduced by: INF-004
Owner/domain: identity / security
Description: Keycloak admin credentials, database credentials and any future confidential-client secret come from environment variables with dev placeholders. `pnpm identity:build-prod` produces a production realm, but there is no process that provisions it into a production Keycloak.
Why deferred: Production hosting and secret storage are undecided.
Exit criteria: A secrets manager supplies all credentials, the production realm is applied by an automated, reviewed pipeline, and the dev admin credentials cannot exist in production.
Target checkpoint: production deployment checkpoint


## DEBT-0017 — Identity notifications (email, SMS) and recovery flows not built

Status: OPEN
Severity: MEDIUM
Introduced by: INF-004
Owner/domain: identity
Description: Email verification, phone verification and account recovery are disabled in the realm (`verifyEmail` and `resetPasswordAllowed` false; no SMTP is configured in Keycloak; recovery/backup MFA hooks are not provisioned).
Why deferred: They are business flows with their own contracts and need a delivery provider; INF-004 is infrastructure only.
Exit criteria: Verified-email and recovery flows implemented with configured SMTP (Mailpit locally), recovery codes and tests. ID-001 persists no email or phone: contact channels and their verification state belong to ID-002 and ID-003.
Target checkpoint: ID-001 and following identity checkpoints


## DEBT-0018 — WebAuthn and web step-up authentication deferred

Status: OPEN
Severity: LOW
Introduced by: INF-004
Owner/domain: identity
Description: WebAuthn has default policy values only, and the web client's browser flow does not request level-2 authentication. The `acr` mapping (`bananagig:mfa`=2) exists but only the admin flow has an MFA step.
Why deferred: No feature needs step-up yet and WebAuthn needs a UX decision.
Exit criteria: A level-of-authentication browser flow bound to the web client, an `acr_values` request from the features that need it, and WebAuthn enrolment, with tests.
Target checkpoint: first feature requiring step-up (for example payment method change)


## DEBT-0019 — Keycloak built-in account console and login theme not decided

Status: OPEN
Severity: LOW
Introduced by: INF-004
Owner/domain: identity / web
Description: Keycloak's built-in account console (`/realms/bananagig/account`) is reachable through the public identity host (the proxy allows `/realms/bananagig/*`), and login pages use the default Keycloak theme rather than BananaGig branding. Built-in clients such as `account-console` keep Keycloak's wildcard redirect defaults.
Why deferred: BananaGig's own account and security screens do not exist yet, and the account console is currently the only way for a user to enrol TOTP.
Exit criteria: Either disable the built-in clients and reverse-proxy rules once BananaGig account screens exist, or theme and keep them; add a BananaGig login theme.
Target checkpoint: account security screens checkpoint


## DEBT-0020 — Interactive login only works in the container stack

Status: OPEN
Severity: LOW
Introduced by: INF-004
Owner/domain: identity / developer experience
Description: The issuer is pinned to `http://auth.localhost:8080` (Caddy). `pnpm dev` (host apps) therefore supports bearer-token calls but not browser login, because the dev stack does not run Caddy by default and the realm redirect URIs are the container-stack URLs.
Why deferred: Supporting a second origin means extra redirect URIs and hostname handling for little benefit while no UI needs login.
Exit criteria: A documented host-mode login path (Caddy in the dev profile or an additional registered dev origin) with a test.
Target checkpoint: first UI checkpoint that requires a signed-in user


## DEBT-0021 — Temporary configuration permissions and unenforced owner role

Status: OPEN
Severity: MEDIUM
Introduced by: CFG-001
Owner/domain: configuration / identity
Description: Access to the configuration API uses admin-context tokens plus client roles `configuration-read/write/approve` on `bananagig-admin`. `parameters.owner_role` is metadata; `OWNER_APPROVAL` is satisfied by any holder of `configuration-approve`.
Why deferred: Application roles and permissions do not exist yet.
Exit criteria: Application RBAC (identity-linked, in the BananaGig database) governs configuration access and owner-role approval; Keycloak client roles removed or reduced to authentication context.
Target checkpoint: admin/RBAC checkpoint (after ID-001)

## DEBT-0022 — Activation marker lag and cache invalidation limits

Status: OPEN
Severity: LOW
Introduced by: CFG-001
Owner/domain: configuration / worker
Description: The activation job runs every minute, so the `SCHEDULED -> ACTIVE` marker, its event and the predecessor supersession can lag by up to about 60 seconds. Resolution is unaffected (it uses timestamps). Cache invalidation relies on the shared generation counter in Valkey and a 30 s TTL; there is no push to other instances and no event consumers yet.
CFG-002 content registry (same pattern): the `content.activate-due` marker lags by up to about 60 seconds; cache generation bumps happen after commit and are not retried, so if Valkey is down while a version is published, entries cached before the outage stay stale until their validity boundary or the TTL (at most 30 s) after Valkey returns; and content records no resolution or error metrics (CFG-001 records `recordConfigResolution` and `recordConfigError`). Valkey runs with `allkeys-lru` under a 128 MB cap, so under memory pressure the per-entry generation counters can be evicted and reset to 0, letting a stale generation-0 entry be served after a publish; staleness is bounded by the TTL (30 s). The Valkey circuit breaker is per `ValkeyConfigCache` instance (the API and worker create one for configuration and one for content over a shared client), so each learns about an outage separately.
Why deferred: No consumer needs sub-minute notification.
Exit criteria: A consumer with a documented latency need, then a tighter schedule or database-driven wake-up; content metrics added to the observability package alongside the first content consumer dashboard.
Target checkpoint: first consumer of `configuration.activated.v1` or `content.version-published.v1`

## DEBT-0023 — No configuration admin UI, bulk import or export

Status: OPEN
Severity: LOW
Introduced by: CFG-001
Owner/domain: configuration / admin
Description: Parameters and changes are managed through the API only. There is no UI, bulk import/export, diff view or environment promotion tooling.
Why deferred: Out of scope for the engine checkpoint.
Exit criteria: Admin UI and a controlled promotion path.
Target checkpoint: admin console checkpoint

## DEBT-0024 — Scope references are not validated against domain entities

Status: IN_PROGRESS
Severity: MEDIUM
Introduced by: CFG-001
Owner/domain: configuration / each owning domain
Description: `scope_ref` is an opaque string with no foreign key (a polymorphic reference cannot have one). GEO-001 resolved COUNTRY and MARKET: both registries (configuration change requests and content versions) validate those references at creation and at publish through the `ScopeReferenceValidator` port implemented by geography (the entity must exist, be PLANNED or ACTIVE and use the canonical form: ISO alpha-2 upper case, market code lower-case kebab). The scope references of CATEGORY, PLAN, PROVIDER, GIG and DROP are still unvalidated, and existing rows are not re-validated if an entity is later deactivated.
Why deferred: The domain tables do not exist yet and the registry must not depend on them.
Exit criteria: The same port implemented by the catalog, provider, plan, gig and drop domains (called by both registries), with a test per scope level.
Target checkpoint: first checkpoint that creates each remaining scope domain table (catalog/category, provider, plan, gig, drop)

## DEBT-0025 — Snapshot and audit retention undefined

Status: OPEN
Severity: LOW
Introduced by: CFG-001
Owner/domain: configuration / data governance
Description: Snapshots, snapshot items, audit events and value versions are retained indefinitely. Snapshot volume will grow once bookings take one per quote.
Why deferred: No volume data; retention rules depend on legal and finance requirements.
Exit criteria: Documented retention per table, archival or partitioning where justified, and a restore test.
Target checkpoint: before the first booking checkpoint goes live

## DEBT-0026 — No translation workflow, provider or machine translation

Status: OPEN
Severity: MEDIUM
Introduced by: CFG-002
Owner/domain: content / localization
Description: The content registry stores and serves localized versions, but there is no process to request, review or import translations, no translation provider and no machine translation. Only en-US copy exists, and no translation was invented. Entries have no stored "required locales" list; completeness is not reported.
Why deferred: The launch locale is en-US only and the provider, review and budget decisions are product decisions, not platform plumbing.
Exit criteria: A documented translation workflow (request, translate, review, publish) with a coverage report per active locale, and a decision on providers and machine translation.
Target checkpoint: first checkpoint that activates a second locale (with GEO-001 locale configuration)

## DEBT-0027 — No content admin UI, rich editor, media library or help-center authoring

Status: OPEN
Severity: MEDIUM
Introduced by: CFG-002
Owner/domain: content / admin
Description: Content is managed through the protected API only. There is no Global Admin screen, no WYSIWYG or live preview editor, no media or image library (the markup subset has no images) and no help-center authoring flow (HELP_ARTICLE exists as a content type only).
Why deferred: The admin console and media storage are separate checkpoints; this one builds the platform.
Exit criteria: Admin screens for entries, drafts, review and scheduling built on the content API, an image policy with the storage service, and help-center authoring.
Target checkpoint: first admin console checkpoint

## DEBT-0028 — Temporary content permissions and unenforced owner roles

Status: OPEN
Severity: MEDIUM
Introduced by: CFG-002
Owner/domain: content / identity
Description: Content management uses the same temporary model as configuration (DEBT-0021): the admin identity context plus client roles `content-read`, `content-write`, `content-approve` and `content-legal`. Only LEGAL-owned entries are gated by an owner-specific role. `owner_role` CONTENT, SUPPORT and MARKETING is metadata and does not restrict who may edit. The geography roles `geography-read` and `geography-write` follow the same temporary model (no approval workflow: changes are audited, not approved). Locale registration and activation require only `content-write`, so deactivating a locale makes EXACT-policy LEGAL text for that locale unavailable without `content-legal`; resolve by requiring `content-legal` for locale deactivation, or by a per-locale legal flag, when the temporary permission model is replaced.
Why deferred: Application roles and permissions do not exist yet.
Exit criteria: Role-based permissions per owner role in the application RBAC, replacing `requireContentPermission`.
Target checkpoint: application RBAC checkpoint (with DEBT-0021)

## DEBT-0029 — Content registry covers product shell copy only; other text channels are unmanaged

Status: OPEN
Severity: LOW
Introduced by: CFG-002
Owner/domain: content / api / identity / notifications
Description: Only a small shell set of strings was migrated (home and session pages; 8 keys). API error `message` texts, Keycloak login and account screens (built-in English), the PWA manifest, the error, not-found and loading shells, and email and push delivery are not registry-backed. Entries and their variables are also immutable after creation (no edit-metadata or add-variable endpoint), and locale management is limited to registering and activating locales; market default locales come from the caller until geography exists.
Why deferred: Those screens, the notification delivery engine (NOTIF-001), the Keycloak theme (DEBT-0019) and geography (GEO-001) do not exist yet.
Exit criteria: Each channel migrated by its owning checkpoint following the migration strategy in `docs/content/CONTENT_OWNERSHIP.md`; a decision on localizing API error messages.
Target checkpoint: owning checkpoints (NOTIF-001, GEO-001, the first customer screens)

## DEBT-0030 — No rate limiting on any public API endpoint

Status: OPEN
Severity: MEDIUM
Introduced by: INF-002 (surfaced by the CFG-002 security review)
Owner/domain: api / infrastructure
Description: The API has no rate limiting, request-cost budgets or abuse controls on any route. The public content resolve endpoints (`/api/v1/content/resolve`, `/resolve-many`, public `/locales`) are unauthenticated, perform database reads and server-side rendering, and can be called repeatedly. CFG-002 added bounds that limit the cost of one call (at most 100 keys, a 500,000-character total template budget per call, no caching or last-known-good for unknown locales and contexts) but cannot limit the call rate. Since GEO-002 the public address `validate` and `format` endpoints (`POST /api/v1/geography/addresses/validate` and `/format`) are unauthenticated and accept address data; they are stateless, size-limited (16 KiB) and do not persist or log it, but they must NOT be considered production-exposure-ready until this debt is resolved (GEO-002A confirmed this and left the debt OPEN).
Why deferred: Rate limiting belongs at the edge or in a shared plugin and needs a policy (limits per client, per route class, behind which proxy headers); that is a platform decision, not content logic.
Exit criteria: A documented rate-limit policy enforced at Caddy or by an API plugin (with trusted client IP handling), tests, and per-route classes (public read, authenticated read, admin write).
Target checkpoint: before the first public customer screen goes live

## DEBT-0031 — Only the US reference dataset exists; no management API or bulk import for currencies, time zones and locale activation

Status: OPEN
Severity: MEDIUM
Introduced by: GEO-001
Owner/domain: geography
Description: Geography is seeded with the United States only (USD, four US time zones, `en-US`). The management API covers countries and markets, but there is no API to create or activate currencies, time zones or locales for geography, no bulk import of the ISO 3166, ISO 4217 and IANA datasets, no admin UI and no readiness dashboard. A new real country therefore needs its currency, locale and time zones activated by migration or SQL first. `createCountry` registers unknown valid IANA zones as PLANNED, but nothing activates them. The United States is seeded with only four zones (New York, Chicago, Denver, Los Angeles): Phoenix, Anchorage, Honolulu and the rest are absent, so `GET /countries/US` reports a partial zone list. ISO validation checks the alpha-2 code against the platform's region list but alpha-3 and numeric codes are only checked for format and uniqueness, so their consistency with the alpha-2 code is not verified.
Why deferred: The launch geography is one country; the dataset, import format and review process are product and data-governance decisions.
Exit criteria: A reviewed bulk import of the reference datasets, management endpoints (audited) for currencies, time zones and country/market locale activation, and an admin view of readiness.
Target checkpoint: first checkpoint that opens a second country or currency

## DEBT-0032 — Market readiness covers only the built-in dependency checks and ADDRESS_FORMAT

Status: IN_PROGRESS
Severity: LOW
Introduced by: GEO-001
Owner/domain: geography / each owning domain
Description: Market activation runs the extensible readiness registry. It holds COUNTRY_ACTIVE, CURRENCY_ACTIVE, LOCALE_ACTIVE and TIME_ZONE_ACTIVE (the database enforces the same four with triggers) and, since GEO-002, ADDRESS_FORMAT (the market country has a published address format in force; registered at API start-up, application level only). Tax, payment provider, address autocomplete and content translation readiness are not checked because those domains do not exist yet. A market can therefore be ACTIVE without any of them. The PRD (AD-01, SV-10) also wants a readiness checklist before a COUNTRY can be activated, with a preview of the rendered form; the registry is market-level only today.
Why deferred: The checks need their domains; the registry (`registerReadinessCheck`) is the designed extension point.
Exit criteria: Each remaining domain registers its readiness check when it ships (TAX, PAYMENT_PROVIDER, AUTOCOMPLETE, CONTENT_TRANSLATION) with tests that a failing check blocks activation (`NOT_READY`); ADDRESS_FORMAT is done (GEO-002). A country-level readiness checklist exists with the admin UI (DEBT-0039).
Target checkpoint: the checkpoint that introduces each domain (tax, payments, autocomplete, translation)

## DEBT-0033 — Geography cache invalidation is generation-based and coupled to content's locale generation key

Status: OPEN
Severity: LOW
Introduced by: GEO-001
Owner/domain: geography / content
Description: Geography caches reference reads in Valkey keyed by a geography generation counter and, because public reads hide inactive locales, also by content's `bg:{env}:content:locgen` counter (read by key name). There is no push invalidation, and a lost generation bump (Valkey down at write time, or an evicted counter under memory pressure) leaves stale entries until the TTL (the service default is 300 s, but the API wires the shared registry cache TTL `CONFIG_CACHE_TTL_SECONDS`, 30 s by default, so the effective bound is 30 s). The market-default provider used by content keeps a 60 s in-process memo, so a changed market default reaches content within about a minute.
Why deferred: Reference data changes rarely and the TTL bounds the staleness; a shared cache-generation helper is a refactor across three packages.
Exit criteria: A shared cache-generation helper (instead of a key-name coupling) and a documented staleness budget per consumer.
Target checkpoint: when a second consumer of geography reads needs tighter freshness

## DEBT-0034 — No automatic time zone lookup; the market default time zone is the only operational zone

Status: IN_PROGRESS
Severity: LOW
Introduced by: GEO-001
Owner/domain: geography
Description: Each market has one default operational time zone chosen from its country's zones. GEO-002 added the per-address reference (`geography.addresses.time_zone_id`, stored when a geocoder supplies a registered ACTIVE zone), but no geocoder exists yet, so no address carries a zone, and nothing consumes it: scheduling still uses the market default. There is no lookup of a zone from coordinates inside BananaGig.
Why deferred: The geocoding vendor (DEBT-0037) and scheduling are later checkpoints.
Exit criteria: A geocoder adapter that supplies the zone (or an offline lookup from coordinates), and scheduling that uses the zone of the service address with the market default as the fallback.
Target checkpoint: the geocoding provider checkpoint and the first scheduling checkpoint


## DEBT-0035 — A few unit tests assert latency against small deadlines and can flake on a loaded runner

Status: OPEN
Severity: LOW
Introduced by: CFG-002 and GEO-001 (found by CI-003)
Owner/domain: testing
Description: CI run #5 failed because a unit test asserted that a large template validated in under 3 s (0.3 s locally, 3.6 s on the runner); CI-003 replaced it with a deterministic render count and widened two catastrophic-backtracking ceilings. The cache tests (`packages/configuration/src/cache.test.ts`, `packages/content/src/cache.test.ts`, `packages/geography/src/cache.test.ts`) still assert real elapsed time against the small per-call deadlines they exercise (for example under 500 ms with 40 ms deadlines). Their margins are the point of the tests and they passed on CI and under a 1-CPU container twice, but they remain load-sensitive.
Why deferred: Replacing real timers with an injected clock changes the cache adapters' API for tests only and is not needed while they pass.
Exit criteria: Inject a clock and a controllable fake cache client into the bounded-I/O adapters so the tests count calls and simulated time instead of waiting, or quarantine them behind a generous ceiling.
Target checkpoint: next change to the cache adapters

## DEBT-0036 — Address retention, erasure and exact-location access are undefined

Status: OPEN
Severity: MEDIUM
Introduced by: GEO-002
Owner/domain: geography / identity / booking
Description: `geography.addresses` rows are personal data and immutable (a changed address is a new row; an address referenced by a booking is its snapshot). There is no retention period, no erasure or anonymization procedure (DELETE is allowed by the guard, but nothing yet decides which rows are orphaned or which referenced rows must be anonymized in place), and no policy for who may see an exact address at which booking stage (the PRD shows the exact address to a provider only from confirmation). No route reads a persisted address; owning domains read them in process through `AddressService.getAddress`.
Why deferred: Ownership (identity, provider, booking) does not exist; the policy needs those domains and a legal retention decision.
Exit criteria: A documented retention period and erasure/anonymization procedure for stored addresses (including raw_input and coordinates), and role- and stage-based exact-location access enforced where addresses are served, with tests.
Target checkpoint: ID-001 and the first booking checkpoint (access policy), with the data-export and deletion work of the account checkpoints

## DEBT-0037 — No production autocomplete, geocoder or address verification provider

Status: OPEN
Severity: MEDIUM
Introduced by: GEO-002
Owner/domain: geography
Description: Only the provider-neutral ports (`AddressAutocompleteProvider`, `GeocoderProvider`, `AddressValidationProvider`) and in-memory mocks exist. No vendor is selected (PRD open question Q about the autocomplete and geocoding partner), nothing chooses a provider per country (the PRD configures `address.autocomplete_provider` and `address.geocoder` at COUNTRY scope), and the verification provider has a fixed contract and mock but no service flow. Every address is therefore entered manually and stored UNVERIFIED (marked for review), never GEOCODED or VERIFIED, and carries no coordinates or time zone.
Why deferred: The vendor and its terms of service (storing results, billing, country coverage) are a business decision; the boundary was the scope of GEO-002.
Exit criteria: A selected vendor adapter implementing the ports with contract tests against the mocks, per-country provider selection read from configuration (COUNTRY scope), a verification flow that produces VERIFIED rows, and provider terms reviewed for what may be stored.
Target checkpoint: the geocoding and discovery checkpoints

## DEBT-0038 — Phone numbering rules are not part of the country model

Status: OPEN
Severity: LOW
Introduced by: GEO-002
Owner/domain: geography
Description: PRD SV-10.07 requires phone entry, formatting and validation to use the country lookup (dialling code and numbering rules). Countries hold the dialling code (GEO-001) but there is no phone rule model; GEO-002 deliberately did not add one because the address model does not need it.
Why deferred: No phone entry exists until account verification; the rule model (and a libphonenumber-style adapter) belongs with it.
Exit criteria: Data-driven phone numbering rules per country used by one server and client validator, E.164 storage, tested like the postal rules.
Target checkpoint: ID-001 (phone verification)

## DEBT-0039 — No admin UI, preview or draft management for address formats and areas

Status: OPEN
Severity: LOW
Introduced by: GEO-002
Owner/domain: geography / admin
Description: Address formats and administrative areas are managed through the API only. There is no screen to edit, preview the rendered form or formatted address, or see a readiness checklist (PRD AD-01 step 6), a DRAFT format cannot be edited or discarded (it is immutable; a corrected version is a new draft, and an unused draft stays DRAFT), and areas have no bulk import from a reference-data partner.
Why deferred: The admin console is a later track; the API is complete enough for a country to be added with data only.
Exit criteria: Admin screens for formats and areas with form and formatted-address preview, draft discard, bulk area import with a reviewed dataset, and the country-level readiness checklist (DEBT-0032).
Target checkpoint: the admin console checkpoints

## DEBT-0040 — Address reference data covers the United States only

Status: OPEN
Severity: LOW
Introduced by: GEO-002
Owner/domain: geography
Description: Only the US address format and the 50 states plus DC are seeded. No territories, counties or cities; area names are single official names (no per-locale names); an area is displayed by its code. No other country has a format or areas.
Why deferred: The launch country is the United States (PRD); further countries are data, added through the management API (the integration tests prove a second country with provinces and an A1A 1A1 postal code needs no deployment).
Exit criteria: Reference data (and an import path, DEBT-0039) for each country as it is opened, and localized area names when a second locale ships (DEBT-0026).
Target checkpoint: first checkpoint that opens a second country

## DEBT-0041 — Markets do not reference an administrative area

Status: OPEN
Severity: LOW
Introduced by: GEO-002 (gap found against PRD SV-10.08)
Owner/domain: geography
Description: PRD SV-10.08 says a market belongs to a country AND an administrative area (LA & OC belongs to California). GEO-001 markets reference only a country, and GEO-002 added the areas without linking markets to them.
Why deferred: It changes the market API, DTOs, events and tests of GEO-001 and no consumer needs it yet.
Exit criteria: A nullable composite foreign key `markets (administrative_area_id, country_id)`, exposed in the market API and used by service-area and market reporting.
Target checkpoint: the first checkpoint that reads the area of a market (service areas or reporting)

## DEBT-0042 — Data-driven validation patterns run in the API process (no RE2 isolation)

Status: OPEN
Severity: LOW
Introduced by: GEO-002
Owner/domain: geography / security
Description: Field validation patterns come from the database and run as JavaScript regular expressions. They are authored only by privileged administrators and vetted when a draft is created (bounded length, no backreferences or lookbehind, no repeated group that already repeats), and the input is capped by the field's maximum length (200 characters at most) before a pattern runs. A vetted pattern can still be slow in a way the heuristic does not recognize.
Why deferred: A linear-time engine (RE2) or isolation in a worker is a dependency and runtime decision; the controls above bound the risk to administrators acting in error.
Exit criteria: Evaluate patterns with a linear-time engine or a time-boxed worker, keeping the vetting as a first filter.
Target checkpoint: before pattern authoring is opened to anyone beyond platform administrators

## DEBT-0043 — Ajv still coerces integer and boolean values in request bodies of many configuration and some content routes

Status: OPEN
Severity: LOW
Introduced by: INF-002 and CFG-001/CFG-002 (found by the GEO-002A adversarial review)
Owner/domain: api
Description: Fastify's Ajv runs with type coercion on. GEO-002A put integers in path and query parameters behind one strict parser, and the geography management and address routes validate the RAW body with zod (`strictBody`) before Ajv. Many configuration routes and the content routes that carry integers (for example versions) validate only after Ajv (the content routes use `strictBody` where a body has booleans), so a body value such as `"1e3"`, `"0x10"`, `" 5"` or `"+7"` for an integer field (for example `validationRules.minLength`, or a `version`), or `"true"` or `1` for a boolean, is coerced to a number or boolean before the route's own zod parse sees it. Reproduced against the real app with a fake service: `POST /api/v1/configuration/parameters` stored `minLength` 1000 for `"1e3"`. Every affected route is internal (admin context plus a write permission), and the coerced value is always a valid in-range number or boolean that zod and the service then validate, so nothing invalid is stored; the effect is that sloppy input is interpreted instead of rejected.
Why deferred: Outside the GEO-002A scope (path and query identifiers); adding `strictBody` to every configuration and content route touches their tests and error shapes.
Exit criteria: `strictBody(<schema>)` after the authorization hook on every configuration and content route with a body (or a body validator with coercion off), with tests that `"1e3"`, `"0x10"` and `"true"` are rejected with the standard envelope, and a start-up guard like `enforceStrictIntegerParams` for body schemas.
Target checkpoint: next change to the configuration or content API, or before a public (non-admin) write endpoint is added
ID-001 decision (option B): the new account bodies (`POST /account/active-role`, `PUT /account/profile`) validate the RAW body with `strictBody` before Ajv, `GET /account/me` rejects unknown query parameters, and regression tests prove `{"role":1}`, `{"role":true}`, extra properties and a body or query `accountId` are rejected. The configuration and content routes are unchanged, so this debt stays OPEN.

## DEBT-0044 — Initial application roles are seeded from the Keycloak realm roles of the first token

Status: OPEN
Severity: MEDIUM
Introduced by: ID-001
Owner/domain: identity
Description: There is no sign-up flow yet, so an account created from the first verified web identity gets its initial application roles from the Keycloak realm roles of that token (`customer` gives CUSTOMER, `provider` gives PROVIDER; ADR-0025). It is a one-time hint, never consulted after the account exists, and PostgreSQL is the only authority afterwards, but it couples account creation to how Keycloak users are provisioned and it cannot express "this person signed up as a customer" independently of Keycloak.
Why deferred: Sign-up (CU-03, PR-01) and its consent and verification steps are later checkpoints; the PRD creates the account and the role at sign-up.
Exit criteria: The sign-up flows create the account and grant the role explicitly (`grantRole` with source SIGNUP); the bootstrap hint is removed and a token with no mapped role no longer creates an account silently.
Target checkpoint: the customer sign-up checkpoint (CU-03) and the provider sign-up checkpoint (PR-01)

## DEBT-0045 — Account closure, deletion, data export and erasure are not implemented

Status: OPEN
Severity: MEDIUM
Introduced by: ID-001
Owner/domain: identity / privacy
Description: The account status machine exists (PENDING, ACTIVE, SUSPENDED, CLOSURE_REQUESTED, CLOSED, with an immutable history, and closing deactivates every role), but no closure rule is implemented: no check for open bookings, money owed or payouts (SV-11.09, CU-09), no 30-day erasure or anonymization of personal data (the profile, `raw_input` of addresses, audit actors), no data export, and no retention schedule. Identity rows are never deleted by the guards, so erasure will need its own reviewed procedure.
Why deferred: Bookings, payments and payouts do not exist; closure rules depend on them. Financial closure semantics were explicitly out of scope.
Exit criteria: Closure rules per role with tests, an erasure and anonymization procedure that keeps legally retained records, a data export, and the retention policy (with DEBT-0036).
Target checkpoint: the account closure and privacy checkpoints (CU-09 and PR-09 account sections)

## DEBT-0046 — Admin identities have no application identity

Status: OPEN
Severity: LOW
Introduced by: ID-001
Owner/domain: identity / admin
Description: Admin logins (client `bananagig-admin`) are separate from customer and provider accounts by design (SV-11.08): they get no account, `requireAccount` answers 403 for the admin context, and admin permissions are still the temporary Keycloak client roles (DEBT-0021). Nothing in PostgreSQL identifies an administrator (no admin profile, no application permission, no invitation).
Why deferred: The admin console and its invitation and RBAC model (AD-07) are later checkpoints.
Exit criteria: An admin application identity model separate from `identity.accounts`, application permissions replacing the client roles, and admin audit that names the administrator.
Target checkpoint: AD-07 (admin users, account and profile) and the admin RBAC checkpoint

## DEBT-0047 — The account lookup is not cached on the authenticated path

Status: OPEN
Severity: LOW
Introduced by: ID-001
Owner/domain: identity / performance
Description: Every authenticated request of an account route reads PostgreSQL (the external identity by its unique key, the account, its memberships and, for `/account/me`, the profile) and may touch `last_seen_at` once per interval. The key lookup and the membership list are index lookups, but there is no Valkey cache and no measurement under load.
Why deferred: PostgreSQL is authoritative and the paths are cheap; caching adds invalidation rules (role grants, status changes) that need a design and numbers.
Exit criteria: A measured budget for the account lookup; if needed, a generation-invalidated cache like the geography and content registries, never serving a SUSPENDED or CLOSED account.
Target checkpoint: before the first customer screen goes live, or when the lookup shows in the slow-query log

## DEBT-0048 — No endpoint or screen for the preferred role; account screens are infrastructure only

Status: OPEN
Severity: LOW
Introduced by: ID-001
Owner/domain: identity / web
Description: The preferred (primary) role can be changed only by the service (`setPrimaryRole`); there is no API for it. The `/session` page shows the account id, status, roles and active role and a role switcher, but there are no account screens (profile, roles, security) and no endpoint to add a role: provider role creation belongs to the provider sign-up.
Why deferred: The account area (SV-11) and provider sign-up (PR-01) are later checkpoints.
Exit criteria: The account area with a roles section and switcher, an endpoint or screen for the preferred role if the product wants one, and provider sign-up adding PROVIDER to an existing account.
Target checkpoint: the account area checkpoints (CU-09, PR-09) and PR-01

