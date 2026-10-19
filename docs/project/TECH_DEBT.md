# Technical Debt

Every knowingly postponed item is recorded here, not buried in completion reports. IDs are permanent. Statuses: OPEN, IN_PROGRESS, ACCEPTED (a conscious, documented risk), RESOLVED (keep the entry).

## DEBT-0001 — CI is not enforced before merge: `main` has no protection, required review or CODEOWNERS enforcement

Status: IN_PROGRESS
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: `.github/workflows/ci.yml` (verify, integration, compose-smoke, Trivy, governance) was written in INF-001 and first executed on 2026-10-06 (UTC) when the owner pushed `main` to github.com/dukm20/bananagig.com. Run #1 (commit 17b6b8d) failed at `pnpm audit --prod`, which skipped the governance checks and the compose-smoke job. CI-001 fixed the cause and run #2 (commit 14db38d) passed every job: verify (including governance) and compose-smoke. The remaining gap is that nothing enforces CI before merging. The ENG-GOV-001 audit (2026-10-18, unauthenticated reads) confirmed `main` is unprotected (`protected: false`, no rulesets), no pull request has ever been opened, commits are unsigned and the repository is public; `.github/CODEOWNERS` was added but is inert until a ruleset requires code-owner review. The exact settings to apply are in `docs/engineering/GITHUB_SETTINGS.md` (remediation items C-1 and C-2).
Why deferred: pushing is a separate explicit human decision; checkpoint tooling never pushes.
Exit criteria: a ruleset on `main` requiring a pull request, one approval with code-owner review, the `verify` and `compose-smoke` checks (and, after one clean cycle, the governance and CodeQL jobs), no force push, read back with the verification commands of `GITHUB_SETTINGS.md` (a repository setting the owner must apply; the checkpoint tooling cannot).
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
ID-005 note (2026-10-16): the consent guard trigger takes `FOR SHARE` on `content.versions`, `identity.accounts` and `identity.consent_purposes`, which needs UPDATE (or a stronger) privilege on those tables; a DML-only runtime role must therefore be granted it, or the trigger made `SECURITY DEFINER` (DEBT-0081).

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
ID-004 note (2026-10-16): the first service account exists, `bananagig-security` (ADR-0035). Its secret (`KEYCLOAK_SECURITY_CLIENT_SECRET`) is required by the API in production and the development placeholder is refused there, but nothing generates, stores or rotates the production value: `pnpm identity:build-prod` strips the secret so Keycloak generates one, and reading it from Keycloak (`GET clients/{id}/client-secret`), injecting it from a secret store and rotating it (`POST` there) is manual. `${ENV}` placeholders in realm import files were not verified. The production realm build also removes the development SMTP server (Mailpit), so the password reset sends nothing in production until a production SMTP server is provisioned. See DEBT-0071.

## DEBT-0017 — Identity notifications (email, SMS) and recovery flows not built

Status: OPEN
Severity: MEDIUM
Introduced by: INF-004
Owner/domain: identity
Description: Email verification, phone verification and account recovery are disabled in the realm (`verifyEmail` and `resetPasswordAllowed` false; no SMTP is configured in Keycloak; recovery/backup MFA hooks are not provisioned).
Why deferred: They are business flows with their own contracts and need a delivery provider; INF-004 is infrastructure only.
Exit criteria: Verified-email and recovery flows implemented with configured SMTP (Mailpit locally), recovery codes and tests. ID-001 persists no email or phone: contact channels and their verification state belong to ID-002 and ID-003.
Target checkpoint: ID-001 and following identity checkpoints
ID-002 note: email verification (the BananaGig email contact, code and magic link, Mailpit) is implemented without Keycloak SMTP; the realm still has `verifyEmail` and `resetPasswordAllowed` off. Recovery through email (password reset link, recovery codes), SMS and phone verification remain open (ID-003 for phone).
ID-003 note (2026-10-08): phone verification is built (the BananaGig phone contact and the SMS code, `docs/engineering/PHONE_VERIFICATION.md`) with the Valkey fake sink for development and tests and no production SMS provider (DEBT-0059). SMS-based account recovery and SMS second factors are NOT built and stay open.
ID-004 note (2026-10-16): the password reset by email link (BananaGig endpoint, Keycloak sends the link), the authenticator app (TOTP) and recovery codes are built (`docs/engineering/SESSIONS_AND_MFA.md`). Still open: email and SMS one-time-code factors, the phone confirmation after a reset, the support route for a person who lost both channels, and notifications such as the password-changed email (DEBT-0067, DEBT-0068). The realm still has `verifyEmail` off; Keycloak now has an SMTP server in the development realm only.

## DEBT-0018 — WebAuthn and web step-up authentication deferred

Status: OPEN
Severity: LOW
Introduced by: INF-004
Owner/domain: identity
Description: WebAuthn has default policy values only, and the web client's browser flow does not request level-2 authentication. The `acr` mapping (`bananagig:mfa`=2) exists but only the admin flow has an MFA step.
Why deferred: No feature needs step-up yet and WebAuthn needs a UX decision.
Exit criteria: A level-of-authentication browser flow bound to the web client, an `acr_values` request from the features that need it, and WebAuthn enrolment, with tests.
Target checkpoint: first feature requiring step-up (for example payment method change)
ID-004 note (2026-10-16): the level-of-authentication browser flow is built (`bananagig-browser` bound to `bananagig-web` with the floor `minimum.acr.value=bananagig:mfa`) and the API has the step-up primitives (`requireRecentAuthentication()`, `requireMfa()`, RFC 9470 responses, `acr`/`max_age` from the web login). Still open: WebAuthn (its required actions are disabled in the realm until it is built) and the CALLERS of the primitive: only the trusted-browser and MFA-enrolment routes use it, `requireMfa()` has no route (DEBT-0050, DEBT-0062).

## DEBT-0019 — Keycloak built-in account console and login theme not decided

Status: OPEN
Severity: LOW
Introduced by: INF-004
Owner/domain: identity / web
Description: Keycloak's built-in account console (`/realms/bananagig/account`) is reachable through the public identity host (the proxy allows `/realms/bananagig/*`), and login pages use the default Keycloak theme rather than BananaGig branding. Built-in clients such as `account-console` keep Keycloak's wildcard redirect defaults.
Why deferred: BananaGig's own account and security screens do not exist yet, and the account console is currently the only way for a user to enrol TOTP.
Exit criteria: Either disable the built-in clients and reverse-proxy rules once BananaGig account screens exist, or theme and keep them; add a BananaGig login theme.
Target checkpoint: account security screens checkpoint
ID-004 note (2026-10-16): the built-in account console is closed: `account` and `account-console` are declared disabled in the realm file, the linter requires it, and Caddy returns 404 for `/realms/bananagig/account*` and for the self-service `login-actions/reset-credentials*` (a second line). Account security is the BananaGig `/security` page. Still open: the BananaGig login theme (Keycloak's login, OTP, recovery-code and reset-password pages and the reset email use the built-in English theme text).

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
ID-005 note (2026-10-16): the four `consent.*` parameters are owned by `legal` (CRITICAL, second approver), but `owner_role` is still metadata: any holder of `configuration-approve` other than the requester can approve a change to who must accept a legal document or what a new version does to existing acceptances. The application RBAC must restrict these to the legal owner (DEBT-0077).

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
Description: `scope_ref` is an opaque string with no foreign key (a polymorphic reference cannot have one). GEO-001 resolved COUNTRY and MARKET: both registries (configuration change requests and content versions) validate those references at creation and at publish through the `ScopeReferenceValidator` port implemented by geography (the entity must exist, be PLANNED or ACTIVE and use the canonical form: ISO alpha-2 upper case, market code lower-case kebab). CAT-001 resolved CATEGORY: `createCatalogScopeReferenceValidator` (composed with geography's validator in the API composition root) checks that the category exists, has the canonical code and is not RETIRED (DRAFT, ACTIVE and INACTIVE are valid, so configuration can be prepared before a category launches; content has no CATEGORY scope). The scope references of PLAN, PROVIDER, GIG and DROP are still unvalidated, and existing rows are not re-validated if an entity is later deactivated or retired.
Why deferred: The domain tables do not exist yet and the registry must not depend on them.
Exit criteria: The same port implemented by the provider, plan, gig and drop domains (called by both registries), with a test per scope level (COUNTRY, MARKET and CATEGORY are done).
Target checkpoint: first checkpoint that creates each remaining scope domain table (provider, plan, gig, drop)

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
ID-005 note (2026-10-16): the gap now reaches consent. A content-write holder can deactivate a locale and make the consent documents in that language `DOCUMENT_UNAVAILABLE`, so required consents in it cannot be accepted or satisfied (`docs/engineering/CONSENT.md`); an accept racing the deactivation is not serialized by a lock and is a valid historical fact if it won (DEBT-0081). The two seeded LEGAL entries are restricted to PLATFORM scope.

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
ID-002 note: the reusable facility now exists (`RateLimiter`, `ValkeyRateLimiter`, ADR-0029, `docs/engineering/RATE_LIMITING.md`) and protects the email verification endpoints, but it is NOT applied to the public address or content endpoints, so this item stays OPEN. `docs/engineering/RATE_LIMITING.md` lists the steps to close it; the client address must be trustworthy first (DEBT-0055).
ID-003 note (2026-10-08): the limiter now also protects the phone verification operations (set number, send, confirm; buckets `phone-verification:account|ip|device|number`) and the source address it counts comes from the exact trusted-proxy model (ADR-0033). It is still NOT applied to the public content or address endpoints, so this item stays OPEN.

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
CI run 37718747872 (ID-001) then failed `packages/content/src/template.test.ts:391` for a different reason: the maximum-size template test is CPU heavy (0.6 s locally) and hit Vitest's 5 s default test timeout on the runner; CI-004 gave the content package a 30 s `testTimeout` (`packages/content/vitest.config.ts`). The other packages still use the 5 s default; none has failed on it, but any CPU-heavy test added there needs the same care.
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
ID-003 note (2026-10-08): E.164 storage and library-based validation now exist (`canonicalizePhone` over libphonenumber-js, ADR-0031; the number's country comes from the library and is cross-checked against the ACTIVE country and its configured dialing code in geography). The numbering rules are the library's, not data-driven country rules an admin can edit, and no client-side validator exists, so the exit criteria are not met. The item stays OPEN, severity LOW.

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
ID-002 decision (option B again): the five email routes validate the RAW body with `strictBody` before Ajv (no coercion of the code, the token or the address), with regression tests; the older configuration and content routes are unchanged, so this item stays OPEN.

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
ID-004 note (2026-10-16): unchanged. The new `identity.application_sessions`, `identity.account_devices` and security audit rows also hold personal data (browser families, times, the Keycloak `sid`) and are never deleted (DEBT-0057); closing or suspending an account does not revoke its sessions (DEBT-0074).
ID-005 note (2026-10-16): consent events (`identity.consent_events`) and their audit rows are legal records of what an account accepted and are never updated, deleted or truncated (append-only triggers). The erasure and retention procedure must decide what survives an erasure request: a legal record may have to be retained, and it holds only the account reference, the purpose, the version id, locale, text hash and times, never the text (DEBT-0081). The events block deleting an account row (`ON DELETE RESTRICT`).

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

## DEBT-0049 — No production email provider; the delivery adapter is SMTP only

Status: OPEN
Severity: MEDIUM
Introduced by: ID-002
Owner/domain: platform / identity
Description: `EmailSender` is a provider-neutral port with one adapter, `SmtpEmailSender`, used with Mailpit locally and in CI (or any SMTP relay with STARTTLS). No production provider (SES, Postmark, SendGrid, ...) is selected; there is no SPF, DKIM or DMARC setup, no bounce or complaint handling, no delivery webhooks and no per-provider rate budget (SV-03.03 asks to re-verify after a bounce).
Why deferred: the vendor is a commercial decision; the port keeps the identity domain free of it.
Exit criteria: a selected provider behind `EmailSender` (or SMTP credentials for a relay) with SPF, DKIM and DMARC, bounce and complaint events that mark a contact for re-verification, and an environment-specific sender address.
Target checkpoint: before the first production sign-up

## DEBT-0050 — Email change has no step-up, no old-address notice and no account screens

Status: OPEN
Severity: MEDIUM
Introduced by: ID-002
Owner/domain: identity / web
Description: The data model and lifecycle of a change are complete (the verified primary stays active until the replacement verifies), but CU-09.14 and CU-09.15 also require fresh two-factor authentication before the change and a notice to the old address, and there is no account or profile screen to start a change (the `/verify-email` page only verifies; it offers the change form while an address is pending). The magic link needs JavaScript in the browser and a signed-out visitor must sign in and open the link again (the token is deliberately never stored).
Why deferred: step-up needs the 2FA checkpoints; the notice needs a notification template and trigger; the account area is CU-09.
Exit criteria: a step-up check before `POST /account/email` for a verified account, an old-address notice email on `EmailVerified` with a replacement, and the account email screens.
Target checkpoint: the account security checkpoints (CU-09.13 to CU-09.15)
ID-004 note (2026-10-16): the step-up primitive exists (`requireRecentAuthentication()`, `requireMfa()`; DEBT-0018) but is NOT wired into `POST /account/email`: changing an email still needs only a signed-in session. The old-address notice is still open.

## DEBT-0051 — No recovery for an address that is verified on another account

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: identity / support
Description: A verified address belongs to exactly one account and there is no takeover or transfer (ADR-0027). A person who lost access to the account that holds their address, or whose address was verified by someone else after the mailbox changed hands, gets `ACCOUNT_EMAIL_UNAVAILABLE` with no self-service way out. There is no release flow and no admin tool.
Why deferred: it needs an identity-proofing process and admin tooling (support identity checks, SV-03 recovery).
Exit criteria: a documented support procedure and an admin action that releases a verified address with a reason, audit and notice.
Target checkpoint: the admin account tooling (AD-07) and the recovery checkpoint

## DEBT-0052 — The verification email is plain managed copy without a branded layout

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: content / platform
Description: The email body is managed Markdown-subset content rendered to sanitized HTML, with a plain-text alternative derived from it. There is no branded layout (logo, header, footer, legal address), no per-locale templates beyond `en-US`, and no email preview or test-send tooling for content editors.
Why deferred: branding and the layout system are design work; the registry already supports editing the wording.
Exit criteria: a shared email layout, a locale set, and a preview in the content tooling.
Target checkpoint: the notification checkpoints

## DEBT-0053 — Brokered social login is not configured; the trusted-provider email rule is not wired

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: identity
Description: `decideIdpEmail` and `EmailVerificationService.bootstrapIdpEmail` implement and test the rule that an address a TRUSTED provider reports verified becomes a VERIFIED contact (PRD: Apple and Google emails, including Apple private relay addresses). Nothing calls it: no social identity provider is brokered in Keycloak, access tokens carry no email claim, and the set of trusted provider aliases is not configured anywhere.
Why deferred: social sign-in is a sign-up checkpoint (CU-03); claim minimization keeps the email out of tokens.
Exit criteria: Keycloak brokering for Google and Apple, a way to obtain the provider's `email` and `email_verified` for the first login without adding them to API tokens, the trusted alias list as deployment configuration, and the call in the sign-up flow with tests.
Target checkpoint: the customer sign-up checkpoint (CU-03)

## DEBT-0054 — Bot protection, device dimension and re-verification are not implemented

Status: OPEN
Severity: MEDIUM
Introduced by: ID-002
Owner/domain: identity / security
Description: SV-03.04 asks for bot protection on code requests, rate limits by device, and SV-03.03 for re-verification after a period, a risk signal or a bounce. ID-002 limits by account, source address and target address; the limiter accepts a device dimension but no device identifier exists; there is no CAPTCHA or proof-of-work; there is no `verification.reverify_after_days` behaviour.
Why deferred: the device identifier, the risk signals (SV-09.03) and the bot-protection vendor do not exist yet.
Exit criteria: a device or session identifier passed to the service, bot protection on the send operation, and re-verification with the configured period.
Target checkpoint: the sign-up hardening and risk checkpoints
ID-003 note (2026-10-08): the same gaps apply to the SMS send, where they cost money (SMS pumping, DEBT-0059); there is no bot protection on `POST /account/phone/verification/send`. The phone service accepts a device dimension like the email service, but no device identifier exists and none is passed, so that dimension is still unused.
ID-004 note (2026-10-16): the device identifier now exists and feeds the device dimension of the email and phone limiters (the routes pass `request.securitySession.accountDeviceId`; it is absent until the browser has registered, and a person who clears the device cookie gets a new device and so a new bucket, so the dimension bounds honest clients, not an attacker). Still open: bot protection on the send operations and re-verification after a period, a risk signal or a bounce.

## DEBT-0055 — The API trusts a client-supplied X-Forwarded-For

Status: RESOLVED
Severity: MEDIUM
Introduced by: INF-002 (surfaced by ID-002)
Owner/domain: api / infrastructure
Description: Fastify runs with `trustProxy: true`, so `request.ip` is the first address of `X-Forwarded-For`, which a client can set. The email verification limits count `request.ip` (hashed) as one dimension; an attacker who sets the header gets a new bucket per request. The account and address dimensions and the PostgreSQL limits are not affected.
Why deferred: the number of proxy hops depends on the deployment topology (Caddy only locally).
Exit criteria: `trustProxy` set to the exact hop count (or a CIDR list) per environment, the web server forwarding the real client address, and a test that a spoofed header does not create a new bucket. Required before DEBT-0030 relies on the IP dimension.
Target checkpoint: ID-003 (done)
Resolved by: ID-003 (ADR-0033). `trustProxy: true` is gone: `TRUSTED_PROXY_HOPS` (0 to 4, required explicitly in production) is the exact number of proxies, `trustHops(hops)` trusts a hop while `hop < hops`, so `request.ip` is the entry the nearest trusted proxy wrote and a client-chosen leftmost entry is never used. Caddy REPLACES `X-Forwarded-For` (`header_up X-Forwarded-For {remote_host}`) and the web server forwards the last entry (`clientIpOf`). Verified by `apps/api/src/trust-proxy.test.ts` (0, 1 and 2 hops, spoofed chains, IPv6, config defaults, static Caddyfile and compose checks) and the `Phone verification` smoke scenario (a spoofed header through the real Caddy creates no rate-limit bucket). Residual, not code: the API must be reachable only through the proxy (Compose publishes no API port; production must keep it on a private network) and the hop count must match the real topology (a CDN in front means 2); both are deployment invariants recorded in `RATE_LIMITING.md`. DEBT-0030 stays OPEN: the limiter is still not applied to the public content and address endpoints.


## DEBT-0056 — No admin view of the verification timeline and attempts

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: admin / identity
Description: CU-09.04 expects admins to see verification status, timestamps and attempts in the console, with addresses masked except for roles with explicit permission (SV-03.05). The data exists (contacts, challenges, audit rows) but no admin API or screen reads it.
Why deferred: the admin console and application RBAC are later checkpoints (DEBT-0046, DEBT-0021).
Exit criteria: an admin read model of the contact timeline with masked addresses and a permission to reveal.
Target checkpoint: AD-07

## DEBT-0057 — Verification challenges and disabled contacts are never purged

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: identity / privacy
Description: Challenge rows (one per send) and DISABLED contact rows are never deleted or anonymized; expired challenges stay. They hold personal data (the canonical address on contacts) and hashes. There is no retention period or purge job.
Why deferred: retention and erasure are decided with DEBT-0036 and DEBT-0045.
Exit criteria: a retention period per table, a purge or anonymization job that keeps what the audit needs, and the erasure procedure for the contact data.
Target checkpoint: the account closure and privacy checkpoints
ID-003 note (2026-10-08): the same gap covers `identity.phone_verification_challenges` (one row per SMS, code hash and delivery outcome) and DISABLED `identity.phone_contacts` rows (the E.164 number and country), which are never purged. The DEV/TEST fake SMS sink is the only store of a plaintext code; its Valkey entries expire by a 15-minute TTL, which is their only retention control (the sink is never enabled in production).
ID-004 note (2026-10-16): the same gap covers `identity.application_sessions` (one row per login, the Keycloak `sid`), `identity.account_devices` (a keyed device hash and three coarse families) and the security audit rows: none is ever deleted or anonymized, and there is no retention period.
ID-005 note (2026-10-16): the same gap covers `identity.consent_events` and the `CONSENT_` audit rows (account id, purpose, version reference, locale, hash, database time and the optional application session id): none is ever deleted or anonymized and there is no retention period; unlike the other tables they may have to be RETAINED against erasure (DEBT-0081).

## DEBT-0058 — Two verification abuse limits are engineering assumptions awaiting owner confirmation

Status: OPEN
Severity: LOW
Introduced by: ID-002
Owner/domain: identity / security
Description: The six PRD values (6 digits, 10 minutes, 30 seconds, 5 per hour, 10 per day, 5 attempts) are seeded as written. `verification.email.requests.max_per_hour` (30 requests per account and per source address per hour) and `verification.email.address.max_per_hour` (5 verification emails to one address per hour across all accounts) are NOT in the PRD; they are ID-002's engineering assumption for the abuse limits. The PRD keys are shared by channel (`verification.code.*`); ID-002 uses channel-specific keys (`verification.email.*`) so phone can differ. A shared office address can reach the source-address limit.
Why deferred: the security owner has not reviewed the values.
Exit criteria: the owner confirms or changes the values through a configuration change request (second approver), and decides whether the PRD keys should be shared across channels.
Target checkpoint: before launch

## DEBT-0059 — No production SMS provider, no spend caps or dashboard, no SMS-pumping alerts

Status: OPEN
Severity: MEDIUM
Introduced by: ID-003
Owner/domain: platform / identity / security
Description: `SmsSender` and `SmsTransport` are provider-neutral ports (ADR-0032) with two adapters: the Valkey fake sink (DEV and TEST only) and `DisabledSmsTransport`, the production default, which fails every send as `ACCOUNT_PHONE_DELIVERY_FAILED`. No SMS provider is selected, so no verification SMS can be delivered in production. There is no spend cap or budget per day or per country, no delivery-status or cost dashboard, no delivery receipts and no alert on SMS pumping or on an unusual share of failures (SV-03.04). The per-account, per-source-address and per-number limits (`verification.phone.*`) bound abuse but do not replace spend controls. MEDIUM rather than LOW because an SMS costs money and a provider adapter without these controls can be abused for fraud; it blocks launch of phone verification, not development.
Why deferred: the vendor is a commercial decision; the port keeps the identity domain free of it.
Exit criteria: a provider adapter implementing `SmsTransport`, delivery receipts, a spend cap and an alert on pumping patterns (many numbers per source, high failure share, premium or unusual destinations), and an operations dashboard.
Target checkpoint: before launch, with the sign-up hardening and risk checkpoints

## DEBT-0060 — No telecom line-type or risk vendor

Status: OPEN
Severity: MEDIUM
Introduced by: ID-003
Owner/domain: platform / identity / security
Description: `PhoneIntelligence` is a port (ADR-0032) with a fake classifier (DEV and TEST, the line type from the last three digits) and `UnknownPhoneIntelligence`, which classifies every number UNKNOWN. The market policy blocks VIRTUAL and HIGH_RISK by default (`verification.phone.blocked_line_types`), so in production nothing is classified VIRTUAL or HIGH_RISK and the line-type policy has no effect until a vendor exists (SV-03.02). A market that adds UNKNOWN to the blocked list would refuse every number.
Why deferred: the vendor is a commercial decision and carries a per-lookup cost and privacy review.
Exit criteria: a vendor adapter implementing `PhoneIntelligence` with the five-second timeout and fail-closed behaviour, a data-processing review of sending numbers to the vendor, and tests against recorded vendor responses.
Target checkpoint: before launch, with DEBT-0059

## DEBT-0061 — No recovery for a number that is verified on another account or whose phone was lost

Status: OPEN
Severity: LOW
Introduced by: ID-003
Owner/domain: identity / support
Description: A verified number belongs to at most `verification.phone.max_accounts_per_number` accounts (default 1) and there is no takeover or displacement (ADR-0031). A person who proves a number held by another account gets `ACCOUNT_PHONE_UNAVAILABLE` with no self-service way out, and a person who lost the phone that is their verified number has no recovery. Recovery is intended as a support process; neither the process nor an admin tool exists.
Why deferred: takeover of a number is an account-takeover vector, so the release flow needs identity proofing, support roles and the admin console (DEBT-0046, DEBT-0021).
Exit criteria: a documented support process with identity proofing and an admin action that releases a verified number with an audit trail.
Target checkpoint: AD-07 and the account recovery checkpoints

## DEBT-0062 — Phone change has no step-up, no notice to the old number, no screens and no phone verification page

Status: OPEN
Severity: MEDIUM
Introduced by: ID-003
Owner/domain: identity / web
Description: The data model and lifecycle of a phone change are complete (the verified primary stays active until the replacement verifies, CU-09.15), but CU-09.14 and CU-09.15 also require fresh two-factor authentication before the change and a notice to the old number, and nothing implements either. No web page exists to enter a number, show the masked number and countdown, send, confirm or change it (the API operations exist under `/api/v1/account/phone`); the managed copy for the screens is seeded but unused. A signed-in session alone can start a number change.
Why deferred: step-up needs the 2FA checkpoints; the notice needs an SMS notification template and a provider (DEBT-0059); the account area is CU-09.
Exit criteria: a step-up check before `POST /account/phone` for a verified account, an old-number notice on `PhoneVerified` with a replacement, a phone verification page and the account phone screens.
Target checkpoint: the account security checkpoints (CU-09.13 to CU-09.15)
ID-004 note (2026-10-16): the step-up primitive exists (DEBT-0018) but is NOT wired into `POST /account/phone`; a signed-in session alone can still start a number change. The notice to the old number and the phone screens are still open.

## DEBT-0063 — Accounts have no market, so market-scoped phone policy resolves by country only

Status: OPEN
Severity: LOW
Introduced by: ID-003
Owner/domain: identity / geography / configuration
Description: `verification.phone.max_accounts_per_number` and `verification.phone.blocked_line_types` may be overridden per COUNTRY and per MARKET (PRD SV-03.02), but an account has no market yet, so the policy resolves with the number's country only; a market override is stored and ignored. The default country of a national-format number is the only ACTIVE country in geography (launch: the United States), so the form cannot offer a market-specific default until the account or the sign-up context carries a market (SV-10.07).
Why deferred: the account market (sign-up location, provider service area) belongs to onboarding and the market model, not to phone verification.
Exit criteria: the account or the request carries a market, the phone policy resolves with it, and a test shows a market override changing the accounts-per-number and blocked types.
Target checkpoint: the onboarding and market checkpoints
ID-005 note (2026-10-16): the consent policy parameters (`consent.<purpose>.required_for` and `.reacceptance`) also allow COUNTRY and MARKET overrides for the consent law of a region and are read at PLATFORM scope only, for the same reason; the two consent documents are restricted to PLATFORM scope (DEBT-0079).

## DEBT-0064 — Two phone abuse limits are engineering assumptions awaiting owner confirmation

Status: OPEN
Severity: LOW
Introduced by: ID-003
Owner/domain: identity / security
Description: The six PRD code-policy values (6 digits, 10 minutes, 30 seconds, 5 per hour, 10 per day, 5 attempts) are seeded as written. `verification.phone.requests.max_per_hour` (30 requests per account, source address and device per hour) and `verification.phone.number.max_per_hour` (5 verification SMS to one number per hour across all accounts) are NOT in the PRD; they are ID-003's engineering assumptions. The PRD keys are shared across channels (`verification.code.*`); ID-003, like ID-002 (DEBT-0058), uses channel-specific keys (`verification.phone.*`) so the channels can differ. A shared number (a household or office line) can reach the per-number limit.
Why deferred: the security owner has not reviewed the values.
Exit criteria: the owner confirms or changes the values through a configuration change request (second approver), and decides whether the PRD keys should be shared across channels (together with DEBT-0058).
Target checkpoint: before launch

## DEBT-0065 — Phone abuse residuals found in the ID-003 review

Status: OPEN
Severity: MEDIUM
Introduced by: ID-003
Owner/domain: identity / security
Description: Accepted residuals, none exploitable to take over an account but each a cost or availability risk: (1) wrong-code attempts are capped per challenge (5) and a resend resets them, with no cap per NUMBER across challenges and accounts: an attacker account gets about 25 guesses per hour against a victim's number (about 0.06% a day of a 6-digit code), and success squats the number (recovery is DEBT-0061); (2) the per-number SMS budget (5 per hour, all accounts) equals one account's own hourly cap, so one account can exhaust a victim's budget and show them `PHONE_RATE_LIMITED` for up to an hour; (3) no global or per-country daily SMS ceiling or kill switch, and the source-address bucket keys the exact address, so an IPv6 /64 rotates freely; (4) a number added while the blocked-line-type list was empty has no snapshot and is never blocked by a later tightening; (5) repeating a confirmation after the pending change was withdrawn answers an idempotent 200 `changed:false` for any code while a primary exists (documented, but a client could misread it); (6) a failed resend supersedes the previous working code (one open challenge per contact), so the user holds an SMS whose code no longer works; (7) the SMS provider call has no timeout of its own, and a process death after the challenge commit and before the SENT update leaves a usable challenge with delivery PENDING (counts toward the caps, replaced by a resend); (8) the audit and outbox writes of a wrong attempt now run in a savepoint (the counted attempt survives their failure), but the email flow of ID-002 still writes its counter, audit and event in one transaction.
Why deferred: each needs a product or security decision (limits, support process, vendor) or touches the unchanged email flow; the production SMS provider does not exist yet (DEBT-0059) so sends are disabled in production.
Exit criteria: a per-number attempt cap across challenges, a number budget above the per-account cap with a per-(account, number) sub-limit, a global and per-country send ceiling with a kill switch and IPv6 /64 keys, a re-lookup for numbers without a snapshot when the policy tightens, a code-bound idempotent confirm, a provider timeout and a stale-PENDING sweeper, and the same savepoint treatment for the email attempt counter.
Target checkpoint: before the production SMS provider is enabled (DEBT-0059)

## DEBT-0066 — A trusted browser is recorded but has no effect on when Keycloak asks for a code

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: identity / security
Description: A browser the person trusts is stored (`identity.account_devices.trusted_until`, `session.trusted_browser_days`), shown and expired, and never satisfies a step-up guard, but it does NOT change Keycloak's login-time prompt for a code (PRD CU-09.13 says "a browser can be trusted for the configured number of days"). Keycloak cannot skip the OTP step for one browser without a custom extension, and the tempting shortcuts (`acr_values`, an essential `claims` parameter) travel through the browser and are tamperable. The product copy and the API summaries say so plainly (`account.security.devices.trust_note`). What exists is Keycloak's own remembered session: with "Keep me signed in" an OTP user keeps their SSO session and MFA level for 30 days on that browser.
Why deferred: the effect needs a Keycloak extension or session design and a security decision; the record, the device registry and the honest copy were built so it can be added without a data change.
Exit criteria: either an offline-session-backed trusted browser (trusting a browser makes Keycloak keep a long-lived session for it, trusted window = session lifetime) or a signed request object (RFC 9101) carrying the device assertion to a custom authenticator that may skip the OTP step; in both a trusted browser never satisfies a step-up guard, and the copy is updated.
Target checkpoint: the account security checkpoints (CU-09.13)

## DEBT-0067 — No email or SMS one-time-code factor, no step-up for accounts without TOTP, no phone confirmation after a reset, no support route

Status: OPEN
Severity: MEDIUM
Introduced by: ID-004
Owner/domain: identity / security / support
Description: Only the authenticator app (TOTP) and Keycloak's recovery codes exist as second factors. Not built: the one-time code sent to the verified email or phone as a second factor (PRD CU-09.13), the step-up for an account WITHOUT a TOTP credential (CU-09.14: the "Authentication Required" dialog that sends a code to a verified channel; today `requireMfa()` answers `403 MFA_ENROLLMENT_REQUIRED`), the phone confirmation after a password reset ("then confirms a code to the verified phone", CU-03.12), the recovery through the other channel plus a backup code, and the support identity-check route for a person who lost both channels (CU-03.12, PRD question Q7). A person with neither a TOTP device nor recovery codes who loses their password can only use the email link.
Why deferred: the email and SMS factors need Keycloak extensions or a BananaGig-side second-factor design and, for SMS, a provider (DEBT-0059); the support route needs the admin console and support roles (DEBT-0046, DEBT-0021).
Exit criteria: an email/SMS code factor integrated with the flow, a step-up path for accounts without TOTP, the phone confirmation step of the reset, the backup-code recovery and a documented support process with an admin action and audit trail.
Target checkpoint: the account security and recovery checkpoints (CU-09.13, CU-09.14, CU-03.12)

## DEBT-0068 — Keycloak events are not consumed: factor and password changes are observed lazily and no notice is sent

Status: OPEN
Severity: MEDIUM
Introduced by: ID-004
Owner/domain: identity / security
Description: BananaGig does not consume Keycloak's event stream (no failed-sign-in feed, no recovery-code-used event, no credential-change events). It OBSERVES: the factor and password transitions are read from the admin API at the security overview and at login registration and audited with the OBSERVATION time (`MFA_ENABLED`, `RECOVERY_CODES_ENABLED`, `PASSWORD_CHANGED`, `PASSWORD_RESET_COMPLETED`). Consequences: a recovery code being used, failed sign-ins and a lock-out never appear on the timeline; the other sessions of a user whose password changed elsewhere are revoked only when the owner next logs in or opens `/security` (until then another session, an attacker's for instance, keeps working: the reset form's "sign out of other sessions" box is unchecked by default and Keycloak 26.3.5 has no native default for it); no "password changed" email notice (CU-09.12) is sent; the audit time of a transition is not the time it happened. A factor present the first time it is seen is anchored as a baseline.
Why deferred: consuming the events needs a listener SPI or event stream and a delivery guarantee; the notification needs the notification engine (NOTIF-001).
Exit criteria: Keycloak events (or a listener) feed the audit log in real time, a password change or reset ends the other sessions at once, a password-changed notice is sent, and failed sign-ins and recovery-code use are on the timeline.
Target checkpoint: the account security checkpoints and NOTIF-001

## DEBT-0069 — Refresh-token single-flight is per web process

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: web / identity
Description: The realm rotates refresh tokens and tolerates one reuse (`refreshTokenMaxReuse` 1, measured in the lab: with 0 a racing refresh loses a request in most trials, with 1 two concurrent refreshes both succeeded and three kill the chain). The web server makes the refresh single-flight per session id, but only within one process (`getSession`, a map keyed by the store): with several web instances, or a refresh in a second process, three or more concurrent refreshes of one session can still kill its chain and sign the person out. Valkey is not used as a lock.
Why deferred: one web instance runs today; a distributed single-flight (a Valkey lock or a refresh-ahead job) is not needed until the web tier scales out.
Exit criteria: a cross-process single-flight (for example a Valkey lock with a short TTL keyed by the session id) or a refresh strategy that cannot race, with a test using two processes.
Target checkpoint: before the web tier runs more than one instance

## DEBT-0070 — Three security parameters are assumptions and one value is configured in two places

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: identity / security
Description: `session.trusted_browser_days` (30, CU-09.13), `session.keep_signed_in_days` (30, SV-01.12) and `reset_link.validity_minutes` (60, CU-03.11) are PRD values. `security.step_up_valid_minutes` (15), `security.activity_log_days` (90; CU-09.20 says "the configured period" without a value) and `reset_link.max_requests_per_hour` (5 per address and per source address) are ID-004's engineering assumptions, not reviewed by the security owner. In addition `session.keep_signed_in_days` duplicates the realm's "Keep me signed in" lifetimes (`ssoSessionIdleTimeoutRememberMe`, `ssoSessionMaxLifespanRememberMe`, 2592000 s): a configuration change request does not move the realm, so the two can drift; a unit test only compares the realm file with the seeded default.
Why deferred: the security owner has not reviewed the values; the realm is configured by file, not by the registry.
Exit criteria: the owner confirms or changes the three assumptions through a configuration change request (second approver); the remember-me lifetimes are derived from the parameter (a deployment step that renders the realm from configuration) or a runtime check compares them and alerts.
Target checkpoint: before launch

## DEBT-0071 — The security service account holds manage-users (realm-wide user administration)

Status: OPEN
Severity: MEDIUM
Introduced by: ID-004
Owner/domain: identity / security
Description: `bananagig-security` (ADR-0035) needs `realm-management` `manage-users`, the lab-measured minimum for ending sessions and sending the reset email. Whoever holds its secret can create, change and delete any user of the realm, set credentials, end any session and send required-action emails (it cannot change realm settings or clients). The API uses only five operations. Keycloak's fine-grained admin permissions (restricting the role to specific users or operations) are not used: the feature is disabled in this stack (`ADMIN_FINE_GRAINED_AUTHZ` needs a `--features` change) and was not tried. The production secret is generated by Keycloak after the realm import and must be read, injected and rotated by hand (DEBT-0016); `${ENV}` placeholders in the import file were not verified.
Why deferred: production hosting and the secret store are undecided; fine-grained permissions are a Keycloak feature flag and a tested configuration.
Exit criteria: the secret is generated or injected by the secret manager and rotated on a schedule, fine-grained admin permissions (or a narrower gateway) limit the client to the five operations, and an alert fires on use outside them.
Target checkpoint: production deployment checkpoint (with DEBT-0016)

## DEBT-0072 — Keycloak propagation is best effort without a retry queue, and the admin calls are not throttled or cached

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: identity / platform
Description: Ending Keycloak sessions after a revocation, the detached password-reset work (lookup, audit, Keycloak calls) and the reconciliation are best effort. A Keycloak failure never undoes the application revocation (the registry refuses the session at once), but the Keycloak session (and its refresh token and SSO cookie) then lives until it is retried: the retry happens only when the next revoke or session listing sees the session still listed (bounded to 20 per call), and a revocation made while Keycloak is down for good is never retried. The detached password-reset task is lost if the process dies after the 202 (the person asks again). `GET /account/security` makes two admin calls (the user and its credentials) and `GET /account/security/sessions` one plus up to 20 session-ending retries per request; they are not throttled or cached, so a hostile or busy client multiplies load on Keycloak (bounded only by the API's own request limits, which do not cover these routes).
Why deferred: a queue or a worker job (pg-boss) and a cache need a design; the application-side enforcement does not depend on them.
Exit criteria: a durable retry for the propagation (an outbox consumer or a pg-boss job keyed by the revoked session), a short cache or coalescing of the overview's admin calls, a rate limit on the two read routes, and the password-reset work queued instead of detached.
Target checkpoint: the account security checkpoints and the worker checkpoint

## DEBT-0073 — Password-reset abuse residuals

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: identity / security
Description: Accepted residuals of the public reset endpoint: (1) the per-address bucket (`reset_link.max_requests_per_hour`) can be burned by a third party who knows the address, so the owner's own request gets `429` for up to an hour; it is uniform on purpose (the answer must not depend on whether an account exists); (2) the per-source bucket is only as good as `TRUSTED_PROXY_HOPS` (ADR-0033): with a wrong count every visitor shares one bucket or a client picks its own; (3) the link goes only to the address Keycloak holds when it equals the verified one, so a person whose Keycloak address differs gets no email and no error; (4) Keycloak's brute-force lock-out (5 failures in 15 minutes lock the user for 15 minutes, PRD CU-03.11) is mandated and abusable: anyone who knows an address can lock that user out of password sign-in by failing five times; (5) there is no bot protection on the endpoint (DEBT-0054); (6) the audit row `PASSWORD_RESET_REQUESTED` means "requested", it is written before Keycloak's address is compared and before the email is sent, so it does not prove delivery.
Why deferred: each needs a product or security decision (limits, a proof-of-work or CAPTCHA, a per-account lock-out policy) or a deployment fact (the proxy topology).
Exit criteria: bot protection and a lock-out policy that does not let a third party deny sign-in (for example lock the source, not only the user), a delivery outcome recorded with the request, and a production proxy topology check.
Target checkpoint: before launch, with the sign-up hardening checkpoint

## DEBT-0074 — Session and security residuals found in the ID-004 review

Status: OPEN
Severity: MEDIUM
Introduced by: ID-004
Owner/domain: identity / security / web
Description: Accepted residuals: (1) no approximate location for sessions (CU-09.20 asks for one; no GeoIP) and no admin security console; (2) sessions, devices and the security audit rows are never purged (DEBT-0057); (3) routes that use only `requireAuthenticated()` (for example `GET /system/whoami`) do not consult the session registry and accept a revoked session's token until it expires; (4) suspending or closing an account does not revoke its sessions (the account routes refuse it with 403 anyway, but a Keycloak session survives); (5) removing the current browser needs the cookie rotation, which only the web server performs (a client that ignores `deviceId: null` keeps presenting a removed secret); (6) the number of remaining recovery codes is readable from Keycloak (`remainingCodes`) but not surfaced, and `hasMfaEnrolled` looks at TOTP only, so a person with recovery codes but no TOTP gets `403 MFA_ENROLLMENT_REQUIRED`; (7) MFA transitions are audited at OBSERVATION time (DEBT-0068); (8) password-only users re-enter their password on every authorization request (their SSO cookie is below the MFA floor); (9) the timeline cursor is a microsecond timestamp, so rows sharing a microsecond across a page boundary could be skipped, and the session and device lists are capped at 200 rows; (10) a session's `last_seen_at` is touched at most once a minute, so "last active" can be a minute stale.
Why deferred: each needs a dependency (GeoIP, the admin console, account closure rules), a product decision or a Keycloak change; none lets a revoked session act on a `requireAccount` route.
Exit criteria: GeoIP and the admin console, a retention job, the registry consulted by every authenticated route (or `requireAuthenticated` retired in favour of `requireAccount`), session revocation on suspension and closure, the recovery-code count on the security page, and a cursor with a tie-breaker.
Target checkpoint: the account security, closure and admin console checkpoints

## DEBT-0075 — No metrics or alerts for the security layer's Keycloak failures

Status: OPEN
Severity: LOW
Introduced by: ID-004
Owner/domain: identity / platform
Description: Every failure of the Keycloak admin client, the detached password-reset task and the transition observation is reduced to a warn-level log line with a CODE (`TOKEN_REJECTED`, `FORBIDDEN`, `TIMEOUT`, ...). No counter, gauge or alert exists. A wrong or rotated `KEYCLOAK_SECURITY_CLIENT_SECRET` or a realm that was not re-imported makes the security page show the second factor as unknown, revocations report `keycloak: UNAVAILABLE` and the password reset accept requests (202) but send nothing, with nothing but a log line to say so.
Why deferred: the metrics and alerting conventions for domain services are not designed yet.
Exit criteria: counters by code for the admin client and the detached work, a gauge for the last successful call, and an alert on a sustained failure ratio, plus an operations note.
Target checkpoint: the observability hardening checkpoint

## DEBT-0076 — No flow requires consent yet: the sign-up and provider-onboarding screens do not exist

Status: OPEN
Severity: MEDIUM
Introduced by: ID-005
Owner/domain: identity / web / onboarding
Description: The consent layer is complete as infrastructure (the append-only log, the evaluator, four API operations, the minimal `/consents` page, and `listOutstandingConsents`, `hasRequiredConsents` and `requireConsents`), but NOTHING calls the readiness services and no journey is gated by consent. The sign-up screen with its required Terms and Privacy checkbox (PRD CU-03; "consent version and time stored") and the provider sign-up with its required acknowledgements (PR-01) do not exist, so an account is created and can use every account route without accepting anything, and `requireConsents` (`ACCOUNT_CONSENT_REQUIRED`) has no caller. Until Legal publishes a version of each document (a fresh environment has none) every required purpose is `DOCUMENT_UNAVAILABLE` and nothing can be accepted at all.
Why deferred: the sign-up and onboarding screens belong to the web checkpoints (CU-03, PR-01); this checkpoint delivers the data model, the rules and the API they will call.
Exit criteria: the customer sign-up and provider onboarding screens present the verified legal text, post an explicit acceptance (never pre-ticked) and are gated by `requireConsents` / `hasRequiredConsents`; a test shows an account with an outstanding required purpose cannot complete onboarding; Legal has published the first versions.
Target checkpoint: the onboarding checkpoints (CU-03 and PR-01)

## DEBT-0077 — The consent policy defaults are assumptions awaiting the legal owner

Status: OPEN
Severity: MEDIUM
Introduced by: ID-005
Owner/domain: identity / legal / configuration
Description: `consent.terms_of_service.reacceptance` and `consent.privacy_policy.reacceptance` are seeded as `REACCEPT_REQUIRED` (everyone accepts the version in force). That is an ID-005 engineering ASSUMPTION: the PRD says documents are versioned and each acceptance records the exact version (SV-02.04) but not what a new version does to existing acceptances, nor whether it differs by document, role, region or kind of change (editorial versus material). `consent.terms_of_service.required_for` and `consent.privacy_policy.required_for` are `["CUSTOMER","PROVIDER"]`, taken from the PRD (CU-03 sign-up consent and PR-01 provider sign-up) but not confirmed with Legal: whether providers accept the customer Terms or a separate provider agreement, and whether the Privacy Policy applies to both, is open. The seeds are flagged in the migration header, the seed reason and the basis, and are changed by a configuration change request (second approver), not a deploy.
Why deferred: the legal owner has not reviewed the values; the conservative defaults keep the product safe in the meantime.
Exit criteria: Legal confirms or changes the four values through a configuration change request, decides whether the mode should differ by document, region or kind of change, and the provider agreement question is settled (see DEBT-0080).
Target checkpoint: before launch

## DEBT-0078 — No re-acceptance notification, no compliance console, no consent export, and no way to read the text of a historical accepted version

Status: OPEN
Severity: MEDIUM
Introduced by: ID-005
Owner/domain: identity / legal / admin / notifications
Description: (1) When Legal publishes a new version under `REACCEPT_REQUIRED` a person is told only when they next open `/consents` (the requirement turns `REACCEPTANCE_REQUIRED`); no email, push or in-app notice is sent and nobody consumes `legal-document-published` or the consent events. (2) No admin legal-compliance console exists: nobody can see how many accounts have not accepted the version in force, or who accepted what (the data is complete in `identity.consent_events`, and no index serves a "who accepted this version" query, deliberately). (3) No consent export: PRD CU-09.22 and "Download my data" want the consent history in the export, and none exists. (4) The history shows the version number, locale, time and a shortened hash, but there is no customer-facing way to read the full text of a historical accepted version; the text is reachable in-process through `ContentService.getVersion(versionId)` and, for administrators with `content-read`, in the entry detail of the management API, but no route reads one version by id for its owner, and the consent routes deliberately never return legal text. (5) The hash covers the SOURCE (template body) of the version while the person is shown its rendered, sanitized output; the evidence is the immutable source version and a pinned rendering test guards the renderer and sanitizer, but the rendered output is not hashed or stored at accept time. A stronger design compares and stores a hash of the rendered output when the person accepts.
Why deferred: notifications (NOTIF-001), the admin console and the export are separate checkpoints; the data needed by all four is already recorded.
Exit criteria: a notification when a new version needs acceptance, an admin console report of outstanding acceptances and per-account consent history, the consent history in the data export, and a read of a historical version by its id for its owner (or the console), and (if Legal wants it) a hash of the rendered output compared at accept time, each with tests and its own data-model review.
Target checkpoint: NOTIF-001, the admin console and the privacy checkpoints (CU-09.22)

## DEBT-0079 — No regional consent-law engine; policy resolves at platform scope; no cross-language equivalence

Status: OPEN
Severity: LOW
Introduced by: ID-005
Owner/domain: identity / legal / configuration / geography
Description: (1) Consent law differs by region, and the four `consent.*` parameters allow COUNTRY and MARKET overrides, but accounts have no market (DEBT-0063) and the policy provider passes no context, so only the PLATFORM value is ever read; overrides would be stored and ignored. There is no engine that maps a person's jurisdiction to documents, ages or opt-in rules. (2) The two consent documents are restricted to PLATFORM scope (`max_scope_type` PLATFORM on the LEGAL entry shells) and only a PLATFORM-scope version can be accepted, so a country- or market-specific version of the Terms cannot exist yet. (3) An acceptance in one language is not equated with another: under `REACCEPT_REQUIRED` a person who accepted in `en-US` and is evaluated in `es-MX` must accept the `es-MX` version, and under `REACCEPT_FOR_NEW_USERS_ONLY` must accept once in that language; a person who accepts in a second language makes it their latest event, so switching back may require another acceptance. (4) A person whose preferred locale has no LEGAL version stays `DOCUMENT_UNAVAILABLE` under `REACCEPT_REQUIRED` (no silent fallback, by design); the caller passes the locale it shows, and the future gating flows must pass it.
Why deferred: it needs accounts with a market, a legal decision on regional documents and on whether translations are equivalent (and which locale is authoritative), none of which exist.
Exit criteria: the policy resolves with the account's country and market, Legal decides regional documents (the entry's max scope widened in a new migration with a model change for scoped versions) and translation equivalence, and the evaluator and the trigger apply the decision with tests.
Target checkpoint: the onboarding and market checkpoints (with DEBT-0063)

## DEBT-0080 — Other consent purposes are not seeded, and a withdrawable consent that is not required cannot be re-granted from the page

Status: OPEN
Severity: LOW
Introduced by: ID-005
Owner/domain: identity / legal / web
Description: Only `TERMS_OF_SERVICE` and `PRIVACY_POLICY` exist. The model supports more (a purpose is a migration: a LEGAL entry shell, a purpose row, two parameters and a label), but none is seeded: the independent-business acknowledgement and other provider agreements (PR-01), marketing email and web push (R-13), the saved-checkout consent, cookie consent and the admin confidentiality policy (AD-07 "accept the current confidentiality policy before any console access"). There is no marketing preference centre. On the `/consents` page the Accept form is offered only for `OUTSTANDING` and `REACCEPTANCE_REQUIRED`, so a withdrawable purpose that is NOT required (the typical optional consent) shows no Accept control: after a voluntary withdrawal it cannot be re-granted from the page (the API allows it), and a first opt-in has no place on the page either. The page is infrastructure, not the final account screen. HARD PRECONDITION: the first `WITHDRAWABLE` purpose must not be seeded before the rate limit on accept and withdraw exists (DEBT-0081); until then no purpose can append events without bound.
Why deferred: each purpose needs Legal's document, the product decision about who must accept it and its flow; the final account privacy screen (CU-09.22) is a later checkpoint.
Exit criteria: the accept and withdraw rate limit exists (DEBT-0081), the purposes are added with their documents and policy, the final privacy screens offer optional consents unticked (R-13) and let a person grant, withdraw and re-grant them, and the admin console gates on the confidentiality policy.
Target checkpoint: the onboarding, marketing, cookie and admin checkpoints (CU-09.22, AD-07)

## DEBT-0081 — Consent infrastructure residuals found in the ID-005 review

Status: OPEN
Severity: LOW
Introduced by: ID-005
Owner/domain: identity / privacy / platform
Description: Accepted residuals: (1) TRUNCATE of `identity.account_audit_events` is unguarded (pre-existing since ID-001: only UPDATE and DELETE are refused there; the new `consent_events` table does refuse TRUNCATE, so the audit rows of consents are protected only by the table owner's discipline); (2) deactivating a locale or a LEGAL entry racing an accept is not serialized by a lock: the guard trigger share-locks the version row, not the locale or entry rows, so an accept that wins the race is a valid historical fact for a version that was in force when the check ran (benign); (3) the check relies on the default READ COMMITTED isolation of the write transaction; (4) no retention or erasure model for legal consent records: consent events and their audit rows are never purged, and a legal record may have to be retained against an erasure request (DEBT-0045, DEBT-0057); (5) the consent routes are not rate limited (`RATE_LIMITING.md`). This is DORMANT today (both seeded purposes are `NOT_WITHDRAWABLE` and a repeated accept is an idempotent no-op, so an account appends at most one event per published version) and MUST be fixed BEFORE the first `WITHDRAWABLE` purpose is seeded (a hard precondition, also in DEBT-0080): once accept and withdraw can cycle, one token can append about 50 events per second per account, about 1.5 KB each across the event, audit and outbox rows, about 6 GB per day, and starve the connection pool. The fix is a `ValkeyRateLimiter` keyed per account with the limit from configuration (CFG-001), failing closed; (6) `GET /account/me` carries no consent summary (on purpose: it would add configuration reads to a hot read), so a client learns `satisfied` only from `GET /account/consents/requirements`; (7) `getRequirements` reads the configuration registry once per evaluated purpose with no caching (CRITICAL parameters are never cached), and no metric or alert exists for consent policy failures; (8) a future least-privilege database role needs UPDATE on `content.versions`, `identity.accounts` and `identity.consent_purposes` because the guard trigger takes `FOR SHARE` on them, or the trigger must become `SECURITY DEFINER` (see DEBT-0012); (9) `FOR SHARE` on a version row can in theory starve a publisher (a stream of share-lockers; PostgreSQL gives no queue priority to a waiting `FOR UPDATE`): the mitigation is a `lock_timeout` with retry on the content publish path, a content-package change that is not done; (10) publishing truncates `effective_to` to milliseconds, so an accept within the same millisecond could be recorded fractionally after the window it was proven in (cosmetic); (11) entry and locale activation are deliberately NOT locked by the trigger and must not be added after the version lock: publication locks the entry and then the version, so the reverse order would deadlock.
Why deferred: each needs a decision (retention, rate limits), a dependency (the observability conventions) or touches pre-existing tables outside this checkpoint.
Exit criteria: a TRUNCATE guard on the audit tables, a retention and erasure policy that keeps legally required consent records, the rate limit on accept and withdraw (before the first withdrawable purpose), a `lock_timeout` with retry on publish or a documented decision, grants or `SECURITY DEFINER` for the guard trigger, and metrics for the policy and registry failures, and, if wanted, a consent summary on the account read.
Target checkpoint: the privacy checkpoints (with DEBT-0045 and DEBT-0057) and the observability hardening checkpoint

## DEBT-0082 — Account area: capabilities and polish deliberately left to later checkpoints

Status: OPEN
Severity: LOW
Introduced by: ACC-001
Owner/domain: identity / web / content
Description: ACC-001 built the shared framework (section registry, role-driven navigation, guarded section read models, responsive accessible shell) and enabled only the sections whose capability exists: Profile, Contact details, Security, Language and region, Privacy and data, Roles. Not built, by design: (1) the Notifications section (NOTIF-001) and Close account (the closure rules, DEBT-0045) are registered as PLANNED and switched off; (2) the role-specific sections (addresses, payment methods, credits and transactions, verification documents, payout and tax, plan and billing, public profile, business and staff profile) have no registry rows, because each is added by the checkpoint that builds its capability; as a result CUSTOMER and PROVIDER see the same six sections today and the role-driven difference is proven only by tests that add rows to an isolated database; (3) the registry has no runtime admin API (a change is a reviewed migration; the admin console arrives with AD-07); (4) the Contact details section has no phone action because no phone page exists (the phone verification screens are still missing, DEBT-0062, DEBT-0067); (5) the pages are functional, accessible and responsive but not the final visual design; (6) the data-download block of the Privacy section only states that the export is not available (the export is DEBT-0045); (7) the Security section shows a registered-session count that is not reconciled with the identity provider (the security centre does reconcile); (8) no profile or locale change event exists, because no consumer needs one (the `PROFILE_UPDATED` audit row is the record); (9) the registry is read on every request without a cache (one indexed read of an 8-row table) — a cache needs an invalidation design and is not justified by the cost.
Why deferred: each depends on a capability, a decision or a checkpoint that does not exist yet; building any of them now would invent business data (the PRD's later sections) or ship an unused mechanism.
Exit criteria: each section is added with its capability as rows of `account_sections` and `account_section_roles` (a forward migration, a guarded endpoint behind `requireAccountSection`, a web page and tests); the admin console edits the registry through an audited workflow; the final account screens replace the placeholder visuals; the export, closure and notification checkpoints replace items 1, 4 and 6.
Target checkpoint: the checkpoints that own each capability (NOTIF-001, the closure and privacy checkpoints, PR-01 and the provider profile checkpoints, AD-07) and the account screen polish checkpoint

## DEBT-0083 — Catalogue: the launch taxonomy and the capabilities around it are deliberately left to later checkpoints

Status: OPEN
Severity: LOW
Introduced by: CAT-001
Owner/domain: catalog / trust / search / admin
Description: CAT-001 built the platform-owned taxonomy (categories, service types, market availability and order, prohibited services, audit, events, cache, the CATEGORY scope reference) and left out, by design: (1) the complete launch taxonomy: the seed is a deliberately minimal DRAFT set (2 categories, 4 service types) and the PRD's 13 candidate categories are not seeded; the final list depends on PRD question Q5 and an administrator activates and enables what launches; (2) the admin console UI (only the management API exists); (3) natural-language synonyms and aliases ("leaking tap" -> a service type) and the search projection (SEARCH-001); (4) verification, skill, equipment, licence and insurance requirement policies per category and market (SV-09, TRUST-001 key them by the stable ids; no table was guessed); (5) a skills and equipment vocabulary; (6) the category icon media pipeline (only a design-system icon NAME is stored); (7) the prohibited-service list has no moderation workflow and no consumer; (8) availability has no effective dates (the market window gates exposure) and no bulk reorder (swapping two display orders takes three statements); (9) a public item whose name has no published text is omitted rather than reported (the management view shows the content key); (10) the catalogue is not yet used by any Gig, onboarding or search flow; (11) the audit trail has no read API or index.
Small known gaps recorded with it (see CATALOG.md "Known limits"): retirement leaves enabled market rows in place; the audit `reason`/`actor` CHECKs trim spaces only; prohibited services can be created under a RETIRED category; a lost cache bump is bounded by the snapshot TTL; the header comments of migration 0015 say "seven tables" and that every status change writes an event (six tables; only activation, deactivation and availability do), left as written because the migration was already applied to the development database when the review found it.
Why deferred: each needs a decision, a vocabulary or a consumer that does not exist yet (the launch list is an open product question; trust, search, Gig templates and the admin console are later checkpoints); building any of them now would guess.
Exit criteria: the launch categories and service types are chosen (Q5) and seeded or created by administrators; the admin console manages the catalogue; synonyms and the search projection read the stable ids and the events; TRUST-001 adds the requirement tables with a foreign key to categories or service types; a bulk reorder and an audit read exist when an admin screen needs them.
Target checkpoint: the search and trust checkpoints, and the admin console checkpoints (AD-01). (The Gig templates left by this entry were built in CAT-002; their own deferrals are DEBT-0084.)


## DEBT-0084 — Gig Templates: the template catalogue, authoring tools, requirement catalogues and the Gig builder are left to later checkpoints, and a few behaviours are accepted limits

Status: OPEN
Severity: LOW
Introduced by: CAT-002
Owner/domain: catalog / trust / admin / provider
Description: CAT-002 built the versioned, platform-owned Gig Template model (identity and frozen versions, typed fields, enum options, requirement hooks, pricing and area model metadata, availability per market, audit, events, cache, the public and management APIs) and left out, by design: (1) the complete template catalogue: the seed is two DRAFT templates without versions (Full Detail, Standard Clean); every launch template, its fields and its copy are created by administrators through the API; (2) the template authoring UI in the admin console (only the management API exists; building a version means creating the content entries first and then sending the whole definition); (3) the skill, equipment, licence and insurance catalogues and the verification policy engine: `gig_template_requirements.reference_code` is an opaque code that nothing validates, and SKILL_REFERENCE / EQUIPMENT_REFERENCE fields have no catalogue to select from (SV-09, TRUST-001); (4) a media-rule editor and the platform photo limits (the PRD's 10 MB, 50 photos and file types are configuration to be wired by the Gig builder; a MEDIA field only carries the item count of the template); (5) pricing suggestions and any price, floor or fee logic (the template only says which pricing models a Gig may use); (6) the provider Gig builder, the Gig table and the validation of a Gig against its template version (CAT-003); (7) a review or approval step for versions (no IN_REVIEW status: no reviewer role exists; the temporary admin roles of DEBT-0021 apply, one administrator can author and publish); (8) no read API for the audit trail.
Accepted limits recorded with it (see GIG_TEMPLATES.md "Known limits"): wording is shared by all versions, so a text change in the content registry reaches a published version (a change of meaning needs a new field key); a service type that is paused or retired leaves its templates ACTIVE but unreachable (the public read re-checks the chain, there is no cascade); the stale-draft token is maintained by the service, so a raw SQL edit of draft rows does not bump it; the mutations open their own transaction and must not be called inside a caller's; a lost cache generation bump is bounded by the snapshot TTL.
Why deferred: each needs a consumer, a vocabulary or an owner that does not exist yet (the Gig builder, the trust catalogues, the admin console, the content authors); building any of them now would guess.
Exit criteria: administrators author the launch templates (Q5) in the admin console; TRUST-001 owns the requirement catalogues and the policy and validates `reference_code`; CAT-003 creates Gigs from a template version and validates against it; the platform photo limits are configuration read by the builder; a version review step exists if the product wants one.
Target checkpoint: CAT-003 (provider Gigs), TRUST-001, SV-09 and the admin console checkpoints (AD-01)

## DEBT-0085 — Provider registration: product decisions taken as engineering assumptions (PLANNED-market pre-registration, the service type ceiling, one market per registration)

Status: OPEN
Severity: MEDIUM
Introduced by: PRO-001
Owner/domain: provider / product
Description: PRO-001 had to pick defaults for three questions the PRD leaves open and recorded each as configuration or a single replaceable column, not as hidden code: (1) **Pre-registration in a PLANNED market.** The PRD launches Los Angeles / Orange County first and a provider will want to register before it opens, but nothing says whether registration may open before a market is ACTIVE. The default `provider.registration.market_statuses_allowed = ["ACTIVE"]` refuses it, so with the seeded `la-oc` (`PLANNED`) nobody can choose a market yet; the platform owners must decide and, if wanted, change the parameter (no code change). (2) **`provider.registration.max_service_types = 10`** is an engineering assumption (the PRD gives no bound; the contract ceiling is 50). (3) **One market per registration** (`registrations.market_id`); the PRD's provider service areas and further markets (PR-03, PRO-003) may need several, which becomes a join table in a forward migration. Also open: whether a provider who cancelled may leave a `PENDING` role behind (today the role stays `PENDING` until a later checkpoint decides), and the data-protection retention for cancelled attempts.
Why deferred: each is a product or legal decision; guessing differently in code would be harder to undo than a parameter.
Exit criteria: the product owner confirms or changes each default; the configuration values are set in the operational environments; the join table (if several markets are wanted) ships with its migration and ADR update; a retention rule for cancelled attempts exists.
Target checkpoint: before the first real provider onboarding (PRO-003 Go-Live at the latest)

## DEBT-0086 — Provider registration: later steps, flows and polish are deliberately left to later checkpoints, and a few behaviours are accepted limits

Status: OPEN
Severity: LOW
Introduced by: PRO-001
Owner/domain: provider / trust / billing / web
Description: PRO-001 built the registration lifecycle (attempts, market, service types, derived requirements, server-controlled submit and cancel, audit, events, the owner-only API and a minimal temporary web flow) and left out, by design: (1) verification and documents (built by TRUST-001, which now answers the `VERIFICATION` step; its own deferrals are DEBT-0087 and DEBT-0088: ID.me, a real scanner, retention); (2) subscription and payment (`SUBSCRIPTION` is `NOT_AVAILABLE`); (3) the public profile (PRO-002; `PROFILE`), Gigs and the GigMenu (CAT-003; `GIGS`), pricing, service areas, availability and capacity; (4) payout and tax setup; (5) Go-Live certification (PRO-003; the evaluator says `goLive.evaluated=false`); (6) business or company providers and team members (the registration is an individual's); (7) leaving the provider role after completion, and the self-service reactivation of an `INACTIVE` role (refused with `PROVIDER_ROLE_INACTIVE`); (8) regional provider policies (the policy is PLATFORM scope only); (9) the polished, accessible-at-scale onboarding UI (the page is a minimal temporary flow with no progress persistence beyond the server state); (10) a non-public-market option endpoint (the page lists only the public ACTIVE markets, so a policy that allows PLANNED markets will also need an options read for them); (11) an independent-business acknowledgement purpose in the consent registry (only the two legal purposes seeded by ID-005 exist, so the PRD's independent-contractor acknowledgement is not asked); (12) PROVIDER roles granted by the bootstrap hint (DEBT-0044) exist without a registration, so a registration row is not proof that the role was requested and a role is not proof of a registration.
Accepted limits (found in the independent review): a registration lists the selected service types but a later retirement of one only turns the `SERVICES` step into `BLOCKED` on read (the completed registration keeps its history); the revision token is optional on the PUTs (last write wins when omitted) and is NOT bound to the attempt, so a stale tab holding revision N of a cancelled attempt can match revision N of the next attempt (the server still re-evaluates every step before completing); a cancelled attempt's `PENDING` role is left in place, so the provider consent purposes stay required for that account until a later checkpoint decides; submit activates the PROVIDER role itself at completion (no review exists yet), so no authorization may treat "PROVIDER role ACTIVE" as proof that a provider was vetted or is live (Go-Live, PRO-003, is that gate; product decision to move role activation to Go-Live); consent is evaluated before the submit transaction (its repeatable-read snapshot cannot nest), so a withdrawal in that window can still let a submit complete, and market eligibility in `selectMarket` is checked before the transaction only (submit re-checks everything); the requirements response carries an `owner` field with internal checkpoint ids (harmless today, drop or neutralise it when the console exists); `LEGAL` is `NOT_REQUIRED` when the consent policy requires nothing for the account's roles (fail-open by the consent owner's configuration, and an outstanding customer-only purpose also blocks provider submit because `satisfied` spans all held roles); the write routes have no rate limit (each real change adds an audit row; add the platform limiter when abuse matters); an account in CLOSURE_REQUESTED or SUSPENDED cannot change or cancel its registration (the registration requires an ACTIVE account).
Why deferred: each needs a consumer, a vocabulary or an owner that does not exist yet; building any of them now would guess.
Exit criteria: TRUST-001 supplies the verification fact through `PrerequisitePort`; the subscription, profile and Gig checkpoints do the same for their steps; PRO-003 decides Go-Live; the onboarding UI checkpoint replaces the temporary page; the role-exit and business-provider flows are designed when the PRD flows are scheduled.
Target checkpoint: TRUST-001 first; then the subscription, PRO-002, CAT-003 and PRO-003 checkpoints

## DEBT-0087 — Provider verification: production adapters, assumed limits and product decisions are deliberately left open

Status: OPEN
Severity: MEDIUM
Introduced by: TRUST-001
Owner/domain: trust / security / legal / product
Description: TRUST-001 built the verification model (cases, requirement instances with cycles and rounds, document metadata, structured reviews, external references, audit, events, the owner-only provider API and the staff API) and left out, by design and with the safe default: (1) **No real malware scanner.** The production scanner is `disabled` and reports an error, so with `trust.verification.require_clean_scan` true (the default) no document can be attached in production until a scanner adapter exists; the development scanner only flags the harmless EICAR test string. (2) **No external verification vendor.** ID.me or any other provider needs a contract, credentials and a response shape that do not exist; only the port, a development fake and a disabled adapter exist, and an inbound callback (when a vendor needs one) must verify the vendor's signature behind the port. (3) **Engineering assumptions in configuration, not the PRD:** the maximum file size (10 MiB), the allowed content types (PDF, JPEG, PNG), the documents per requirement (5), the lifetimes of upload (5 min) and download (1 min) links. (4) **Retention.** Evidence is sensitive and should not be kept merely because it can be; no retention period, redaction or deletion job exists because the legal schedule is not confirmed. (5) **Document types are not accepted per market** (a document type evidences one requirement type everywhere); a market-specific list needs a table. (6) **No reviewer notes** (structured reasons only) until a note policy (length, visibility, retention, redaction) exists. (7) **Providers cannot download their own evidence** and there is no OCR or extraction (nothing structured is derived from a document). (8) **No automated licence or insurance verification**, no appeals or disputes, no regional requirement catalogue (only identity verification is required, from PR-02.06; the others are off until a trust-admin enables them where policy says). (9) **Reviewers are admin identities recorded as text** (DEBT-0046) with the temporary client-role model (DEBT-0021); there is no trust console. (10) **Audit of reads:** a reviewer's reading of a case (including the integrity hashes) is not audited, only the download of evidence is. (11) **Policy can fail open:** when a trust-admin turns identity verification off, every provider reads `NOT_REQUIRED` and verification complete (audited, but with no reason field); Go-Live (PRO-003) must treat `NOT_REQUIRED` explicitly and check `prerequisiteMet`. (12) **No rate limit** on upload authorization, finalize and external refresh (an authenticated provider can request an authorization every few minutes; the lazy cleanup bounds the storage it can leave behind but not the traffic): apply the platform limiter with DEBT-0030.
Why deferred: each needs a vendor, a legal decision or a consumer that does not exist; building any of them now would guess, and the stand-ins fail closed.
Exit criteria: a scanner adapter and a vendor adapter exist behind the ports with their configuration; Legal confirms the retention schedule and a note policy; product confirms the limits and the per-market document acceptance; a trust console replaces the API-only reviewer flow.
Target checkpoint: before the first real provider onboarding (PRO-003 Go-Live at the latest); the console in the admin checkpoints (AD-02)

## DEBT-0088 — Provider verification: expiry sweep and cleanup are not scheduled, the web flow is minimal, and a few behaviours are accepted limits

Status: OPEN
Severity: LOW
Introduced by: TRUST-001
Owner/domain: trust / worker / web
Description: (1) **The expiry sweep (`recordExpiries`) exists but no worker job runs it.** The overview already reads an approval past its end as EXPIRED (derived from the timestamp) and re-verification records the expiry inline, so behaviour is correct, but the EXPIRED status, the audit row and the `verification-expired` event are written only when a provider re-verifies until a pg-boss cron calls the sweep; expiry reminders before the end date (SV-09.01) do not exist. (2) **Orphans:** an authorized upload that is never finalized leaves an `UPLOAD_PENDING` row (and possibly an object) until a cleanup job exists. (3) **The web flow is minimal and temporary:** the browser posts the file to the web handler, which holds it in memory for one request (bounded by the 50 MiB structural ceiling and the 10 MiB policy maximum); no streaming, no progress, no polished UI, no direct-to-store upload (`S3_PUBLIC_ENDPOINT` exists for it but no CORS is configured). (4) **Accepted limits:** an infected or mismatching upload abandons the document and the provider must request a new authorization; a withdrawn draft's object is deleted best-effort (a failed delete leaves an orphan); the reviewers' queue lists the oldest submissions first with a limit and no cursor; the case revision is bumped by every change of the case or of a document (a stale tab must reload before submitting); the rate limiter is not applied to the verification routes (DEBT-0030).
Why deferred: each needs a consumer or an owner that does not exist yet (the worker schedule, the console, the notification checkpoints).
Exit criteria: a worker cron for the sweep and the cleanup; expiry reminders through the notification checkpoint; the console and the polished provider flow replace the temporary page.
Target checkpoint: PRO-003 (Go-Live needs timely expiry), the notification checkpoint and the admin console checkpoints

## DEBT-0089 — Provider Gigs: bundles and the equipment, skill and money field types are still unsupported, and a required one blocks publishing

Status: OPEN
Severity: LOW
Introduced by: CAT-003 (partly resolved by CAT-004)
Owner/domain: provider / catalog
Description: CAT-004 built variants, add-ons and photo media as version-owned children (ADR-0047, `docs/engineering/PROVIDER_GIGS.md`), so MEDIA template fields are now satisfied by photo attachments. Still unsupported: the EQUIPMENT_REFERENCE and SKILL_REFERENCE field types (no catalogues to select from; owned by TRUST-001 and SV-09), the MONEY field type (the price is a column of the version) and bundles (BUNDLE_ELIGIBLE, CU-10). An OPTIONAL field of an unsupported type is not editable and is ignored; a PROVIDER_REQUIRED field of an unsupported type (or MONEY) blocks publishing with issue `FIELD_TYPE_NOT_SUPPORTED`, so a template that requires equipment or skills cannot be published as a Gig yet. A raw `FIELD_TYPE_UNSUPPORTED` guard in the database repeats the rule.
Why deferred: each needs its own catalogue or flow (the equipment and skill catalogues, bundle pricing) and the PRD flows that use them; building any of them now would guess.
Exit criteria: the equipment and skill field types have catalogues to select from and are supported in a forward migration, bundles are specified, and the publish completeness covers them.
Target checkpoint: the checkpoint that adds the equipment and skill catalogues (TRUST-001 follow-up / SV-09); bundles with the Growth block

## DEBT-0090 — Provider Gigs: provider-written copy is not moderated

Status: OPEN
Severity: MEDIUM
Introduced by: CAT-003
Owner/domain: trust / provider / legal
Description: The title, short pitch, description and TEXT / LONG_TEXT field values of a Gig are free provider text. CAT-003 normalises it (Unicode NFC, whitespace, control and bidirectional-override characters, unpaired surrogates, HTML-looking markup are refused) and limits its length through configuration, but nothing reviews its content: a provider can publish offensive, misleading, off-platform-contact or prohibited-service wording (the CAT-001 prohibited-service list is not applied to the text), and nothing detects contact details written into the copy. Publishing is immediate; there is no review state, queue, report flow or takedown beyond the provider retiring the Gig. Provider text never enters audit, events, logs or error details by design, so a future moderator reads the version rows.
Why deferred: moderation needs a policy (what is refused, automatic versus human review, appeal), a reviewer role and console (DEBT-0021, AD-02) and legal input; it is a recorded requirement, not a guess.
Exit criteria: a moderation policy exists; published or pending versions can be reviewed, rejected or taken down with structured reasons and an audit trail; the prohibited-service list is applied; publishing becomes a request for review where the policy says so (a new version status or a separate review table, in a forward migration).
Target checkpoint: before public Gig pages and search expose Gig text; the trust and admin console checkpoints (AD-02)

## DEBT-0091 — Provider Gigs: a newer template version is never adopted (no migration of existing Gigs)

Status: OPEN
Severity: MEDIUM
Introduced by: CAT-003
Owner/domain: provider / catalog / product
Description: By owner decision (ADR-0046) every version of a Gig binds the EXACT Gig Template version of its first version; nothing migrates a Gig automatically when the template gets a newer version or is retired. The consequences until adoption exists: a Gig can stay on an older (SUPERSEDED) template structure indefinitely and still publish new versions of its content; a Gig whose bound version, template or service type was RETIRED stays readable but cannot publish or start a new draft, and the provider's only way to a current structure is to create a new Gig and retire the old one (history is not carried over); there is no way for a provider to see that a newer template version exists, no diff, and no way for the platform to find or notify the Gigs on an old version (the index on `gig_template_version_id` supports the query, nothing runs it); wording of template labels is shared by all template versions (DEBT-0084), so a label change still reaches Gigs on older versions.
Why deferred: adoption needs a design the owner has not made (opt-in or required by a deadline, how new required fields and removed options are resolved, whether adoption creates a new Gig version and re-publishes, how customers and bookings are told); doing it automatically would break the guarantee that a published offer does not change meaning.
Exit criteria: an explicit adoption flow creates a NEW Gig version bound to the newer template version, validates it against that version, shows the provider what changed, and publishes only on the provider's act; the platform can list the Gigs still on a superseded or retired template version; the retirement path tells affected providers.
Target checkpoint: a catalogue lifecycle checkpoint after CAT-004 (to be scheduled by the owner)

## DEBT-0092 — Provider Gigs: service area, availability, capacity and the instant-book and price rules are not part of a Gig yet

Status: OPEN
Severity: MEDIUM
Introduced by: CAT-003
Owner/domain: provider / product
Description: A Gig version holds copy, one price, one duration and the template field values only. Left out by design: (1) service area and radius (the template's RADIUS / POSTAL_CODES / POLYGON modes are not attached to a Gig; PR-03.04); (2) availability, schedules and capacity (PR-03.04); (3) price rules beyond a single fixed price: a floor price, a base-price rule, instant-book and booking-mode settings (PR-03.09, PR-03.10) and discounts (group pricing through BananaDrops is NOT a price rule of the Gig: it is the core BananaDrop domain, DROP-001 to DROP-016, which references the exact Gig version and never changes it; Banana Credits are a separate provider monetization mechanism); (4) the policies a Gig carries in the PRD (PR-03.04). Publishing a Gig therefore says nothing about where or when the provider works, and the price is a plain amount in the provider's market currency (the currency is derived from the market, a provider who works in several markets or currencies is not supported because the registration has one market, DEBT-0085).
Why deferred: each needs a consumer or a product decision that does not exist (geography of service areas, the scheduling model, the pricing and fee rules from configuration); a Gig is not bookable until these and Go-Live exist.
Exit criteria: the service-area, availability/capacity and pricing-rule checkpoints add their data as children of the Gig version (frozen with it, in forward migrations), validate against the bound template version's allowed modes, and Go-Live (PRO-003) states which of them a bookable provider needs.
Target checkpoint: the service-area (AREA-001), availability (CAP-001 to CAP-003) and pricing checkpoints; PRO-003; the BananaDrop checkpoints (DROP-001 onward) consume the Gig and its versions

## DEBT-0093 — Provider Gigs: no search projection, public Gig page or booking consumer

Status: OPEN
Severity: LOW
Introduced by: CAT-003
Owner/domain: search / provider / web
Description: Published Gig versions are visible to their owner only (the GigMenu and the Gig detail). There is no OpenSearch projection, ranking, public Gig page, customer-facing read, or booking snapshot. The `bananagig.provider.gig-created.v1`, `gig-version-published.v1` and `gig-retired.v1` events exist (identifiers only, no copy), but nothing consumes them, so a consumer must read the published version from the database or an API that does not exist yet. Go-Live (PRO-003) is not evaluated: the readiness facts report `goLive {evaluated:false, eligible:false}`, and a published Gig is not live and not bookable. The registration `GIGS` step reads the facts but is not consulted by anything that blocks work.
Why deferred: the consumers (search, public pages, booking, Go-Live) are separate checkpoints; building a projection or public read now would guess their shape and expose provider text before moderation (DEBT-0090).
Exit criteria: a search projection and a public read are built from PUBLISHED versions (and the events) only, after Go-Live and moderation decide what may be shown; a booking keeps an immutable snapshot of the published version it was made against (R-06).
Target checkpoint: the BananaDrop-aware search (SEARCH-001 to SEARCH-003), public-pages and booking checkpoints; PRO-003

## DEBT-0094 — Provider Gigs: the editor is a minimal temporary web flow with plain text only

Status: OPEN
Severity: LOW
Introduced by: CAT-003
Owner/domain: web / provider
Description: The `/provider/gigs` pages are server-rendered, minimal and temporary, in the same style as the registration and verification pages: forms post to same-origin handlers and redirect with closed lists of notice and error words. Left out: a rich text editor (provider text is plain text on purpose), autosave and unsaved-change protection (a stale tab gets `STALE_DRAFT` and must reload; there is no merge), a side-by-side comparison of versions, previews of how a customer will see the Gig, drag-and-drop ordering, client-side validation, and any progress persistence beyond the server state. The editor shows the template's fields from the bound version and labels them through content keys; a field of an unsupported type is listed as not available yet (DEBT-0089).
Why deferred: the polished experience belongs to the onboarding and provider-console UI checkpoint and depends on the decisions of CAT-004 (media, variants) and moderation (DEBT-0090).
Exit criteria: the polished provider Gig builder replaces the temporary pages with accessible editing of all CAT-004 content, version comparison, preview and conflict handling.
Target checkpoint: the provider console / Gig builder UI checkpoint after CAT-004

## DEBT-0095 — Provider Gigs: the web price entry and its display of money are an engineering simplification

Status: OPEN
Severity: LOW
Introduced by: CAT-003
Owner/domain: web / provider / product
Description: The API stores and exchanges prices as integer minor units plus a three-letter currency code that the server derives from the provider's market. The API does not expose how many minor-unit digits a currency has, so the temporary web editor cannot present a major-unit amount for every currency; it takes the price as a whole number of minor units (cents for USD) labelled with the currency, and the handler accepts digits only (`apps/web/src/lib/auth/gig-handlers.ts`); a provider must type 1250 for 12.50. Money is shown without locale formatting, and the GigMenu shows the stored amount and currency as is. There is no price validation against ranges or suggestions (the PRD price floor, base price and suggestions are DEBT-0092 and the template carries no suggested price), and `price_currency` follows the market's currency at the time of each save, so a currency change of a market reaches a draft the next time it is saved but not a published version.
Why deferred: currency exponents and locale formatting belong to a money-formatting component shared with billing, subscriptions and bookings, which does not exist yet.
Exit criteria: a shared money component (minor-unit digits from `geography.currencies`, locale formatting, safe parsing of a major-unit input) is used by the editor and the GigMenu; the API exposes the exponent or a formatted display value; a policy exists for a market that changes its currency while Gigs are published.
Target checkpoint: the checkpoint that introduces money display for subscriptions or booking, and the provider Gig builder UI checkpoint

## DEBT-0096 — Provider Gigs: accepted limits and port reuse

Status: OPEN
Severity: LOW
Introduced by: CAT-003
Owner/domain: provider / platform
Description: Accepted limits of CAT-003: (1) **Account facts reuse the registration's `AccountPort`.** The Gig service reads the account and role facts through the port the provider registration already uses and does not own a second account reader; those facts are read before the transaction, so a change committed in between is caught only by the database guards (`provider_rule` keys such as `ACCOUNT_NOT_ACTIVE`). The provider's market and selected service types come from the COMPLETED registration, so a service type retired after registration blocks creation and publishing only, never reading. (2) **Policy is read fresh before the transaction** (catalogue and configuration reads cannot nest): a policy change between the read and the commit applies to the next call. (3) **The write routes have no rate limit** (DEBT-0030): every real change adds an audit row, and a saved draft can be rewritten without limit, subject to the draft cap only on creating drafts. (4) **Field bounds are checked by the service, not the database**: the database checks type, template membership, behaviour, option validity and the currency, not minimum and maximum lengths or numbers of the bound template version. (5) **Audit `changes` hold field names and counts, not before and after values**, so the content of an earlier DRAFT cannot be reconstructed from the audit (the PUBLISHED and SUPERSEDED versions remain readable as rows). (6) **A DRAFT version is overwritten in place** by every save (the revision counter prevents lost updates); only publishing creates history. (7) **The GigMenu lists every Gig of the account** (the caps keep it small) with no pagination or filtering. (8) `PUBLISH_BLOCKED` carries identifiers only (`details.issues`), so every client must map them to labels through the content keys.
Why deferred: each is a deliberate simplification with a safe default or needs infrastructure that other checkpoints own (the limiter, a money component, a console).
Exit criteria: the platform limiter is applied to the Gig routes with DEBT-0030; pagination is added when the cap is raised or a console needs it; an audit read exists if reviewers need before and after values; the account facts port is shared by identity once a second consumer exists.
Target checkpoint: DEBT-0030 for the limiter; the provider console checkpoints for the rest

## DEBT-0097 — Provider Gigs: limits found in the independent review and accepted for CAT-003

Status: OPEN
Severity: LOW
Introduced by: CAT-003
Owner/domain: provider / web / product
Description: The independent security and data reviews of CAT-003 found these items; the defects they found (a quadratic-time markup check, invisible text, an unbounded web form body, an unmapped account-port error, a lock-order inversion with template retirement, market currency drift, an unindexed foreign key and a Gig without a version) were fixed, and these remain as deliberate limits. (1) **Growth is bounded per state, not in total.** `provider.gig.max_active` counts ACTIVE Gigs and `provider.gig.max_drafts` counts open drafts; RETIRED Gigs, SUPERSEDED versions and audit rows are permanent by design and have no cap, so a script that creates, publishes and retires Gigs grows the GigMenu response and the history without bound (no pagination, DEBT-0030 for the limiter). (2) **Plain-text rules are strict on purpose.** Every Unicode format character except the joiners is refused (this includes the left-to-right and right-to-left marks that some right-to-left texts use), and any text that looks like an HTML tag opener (`<` followed by a letter, `!`, `?` or `/`) is refused, so prose such as "<up to 2 hours" needs rewording. (3) **Eligibility is re-checked in full only on create and publish.** Saving a draft, starting the next draft and retiring require an ACTIVE account but do not re-check the PROVIDER role, the market offering or the template status (the database guards the hard cases: a retired template or service type blocks publishing), and a suspended account cannot retire its own Gigs. (4) **The price ceiling is structural.** `GIG_PRICE_MINOR_CEILING` (10^12 minor units) keeps amounts far below the precision of a JavaScript number; the configurable price floor and ceiling are DEBT-0092. (5) **The temporary web editor drops unsaved edits when a numeric field is malformed**: the handler redirects with a closed error word and the page re-reads the server state, because typed values must not travel in a redirect or cookie. (6) A new Gig draft created in the same instant a template version is activated can see `GIG_TEMPLATE_NOT_AVAILABLE` (reason `NO_ACTIVE_VERSION`); a retry resolves it.
Why deferred: each needs a policy decision, a shared component or infrastructure that later checkpoints own; none is exploitable for data exposure or for writing outside the owner's own Gigs.
Exit criteria: total and per-Gig version caps and pagination exist with the provider console; the limiter protects the write routes (DEBT-0030); the product owner confirms the text rules for right-to-left languages; the draft save re-checks the full eligibility if the product wants paused providers to stop editing; the console keeps typed values on a validation error.
Target checkpoint: DEBT-0030 for the limiter; the provider console / Gig builder UI checkpoint for the rest

## DEBT-0098 — Provider Gigs: variants and add-ons are deliberately simple (no quantity, no negative delta, no default, no combined bounds, no Drop flag)

Status: OPEN
Severity: LOW
Introduced by: CAT-004
Owner/domain: provider / product / BananaDrop
Description: A variant or add-on is a name, an optional description, a non-negative price delta in minor units of the Gig's currency, a non-negative duration delta in minutes, a stable key within the Gig and a display order (version-owned, replaced as a whole set under the draft revision). Left out by design: (1) add-on quantity and quantity pricing (the PRD gives only "pet hair +$25"); (2) negative deltas (the base is the price with no variant selected); (3) a default variant, a minimum number of variants and the rule that a booking must select exactly one variant when any exist (a BOOK rule, recorded as an assumption); (4) combined bounds: base plus a delta plus up to the configured number of add-ons can exceed the structural price ceiling (10^12 minor units) and the duration plus deltas can exceed the template maximum, so BOOK and DROP must not reuse the base ceiling for totals; (5) the PRD flag "Drop-eligible" on a variant or add-on (PR-03.08) and every tier, ladder, floor and threshold: these belong to the BananaDrop domain (DROP-002 eligibility, DROP-005 tiers), which references the exact Gig version and the item key, never the row ids (`variant_id` and `add_on_id` are regenerated on every replace and every next-draft copy; the key is stable); (6) duplicate names are refused after NFKC and case folding only (Unicode confusables are not detected); (7) a market currency change drops the base price at the next draft, and then the options are not copied (their deltas were minor units of the old currency).
Why deferred: each needs a booking, BananaDrop or product decision that does not exist yet.
Exit criteria: BOOK defines selection and totals and checks combined bounds; DROP-002 and DROP-005 add eligibility and tiers keyed by (gig version, item key); the owner decides on negative deltas, defaults and quantities.
Target checkpoint: BOOK-001 and the DROP-002 / DROP-005 checkpoints

## DEBT-0099 — Provider Gig photos: HEIC, header-only verification, assumed limits and no derivatives, delivery or moderation

Status: OPEN
Severity: MEDIUM
Introduced by: CAT-004
Owner/domain: provider / platform / trust
Description: Photos are private assets (JPEG, PNG, WebP) verified by the server (existence, size, content type, magic bytes, SHA-256, header dimensions within configured bounds, scan) and attached to the DRAFT; a published version's attachments are frozen. Accepted limits: (1) **HEIC is not accepted** although the PRD lists JPG, PNG or HEIC (PR-03.07): there is no verified HEIC reader; SVG is never accepted; (2) **verification is header-only**: a file with a valid image header and a hostile or truncated tail passes (no IEND, EOI or RIFF-size check, because phone JPEGs legitimately carry trailing data), nothing is re-encoded and EXIF/GPS is not stripped, so the bytes must never be delivered publicly as they are; (3) **no thumbnails, derivatives, CDN, public delivery URL or search projection**; the preview is a short-lived owner-only link; (4) **no moderation** of photos or alt text (DEBT-0090) and no AI alt text; no video; (5) **assumed policy values** the owner has not confirmed: minimum edge 200 px, maximum edge 12000 px, maximum 50 megapixels, upload authorization 900 s, preview link 60 s, orphan grace 86400 s, alt text 200 characters (the PRD gives 10 MB, 50 photos and the file types only); (6) **production has no malware scanner** (DEBT-0087): with `provider.gig.media.require_clean_scan` true (the seeded value) nothing can be attached in production, and with it false unscanned photos are attachable and publishable (development and test only); a photo accepted while the flag was false becomes unusable when it is turned on and reports "not ready"; (7) there is no per-account storage quota and the orphan sweep scans all READY assets (linear in their number; no index is used); (8) the photo count of the menu is READY photos only while the editor also lists unfinished uploads.
Why deferred: each needs a decoder or vendor (HEIC, re-encoding, scanner), a delivery architecture or a product decision.
Exit criteria: a media derivatives checkpoint re-encodes (strips metadata, validates structure), adds thumbnails and a delivery path; HEIC is added with a verified reader and its signature test; the owner confirms or changes the assumed values; a scanner adapter exists for production; a quota and an indexed sweep exist before volume.
Narrowed by PRO-002: the PROFILE photo (not Gig photos) is now delivered publicly, only as sanitised bytes through the API (a pure container-level sanitiser strips EXIF, GPS, XMP, IPTC, comments and trailing data; no re-encoding, no thumbnails, no HEIC; DEBT-0107). Gig photos remain private owner-only previews.
Target checkpoint: the media delivery and public profile checkpoints (PRO-002 and the SEARCH/CU checkpoints), and the production scanner (DEBT-0087)

## DEBT-0100 — Provider Gig photos: upload handling and concurrency accepted limits

Status: OPEN
Severity: LOW
Introduced by: CAT-004
Owner/domain: provider / web / platform
Description: Accepted limits found by the independent reviews of CAT-004: (1) the temporary web handler buffers the file about three to five times (up to the configured maximum, 10 MB seeded, 25 MiB ceiling) and the API reads it again to verify it, and the Gig routes have no rate limit (DEBT-0030), so a signed-in provider can fan out concurrent uploads and finalizes; (2) two concurrent finalizes of the same photo plus a replayed presigned PUT between the winner's promotion and its commit can leave final bytes whose hash differs from the stored one (both byte sets passed the same checks; it is an integrity, not a safety, problem, matters before public delivery; finalize is not serialized per asset); (3) object deletion is best effort after the commit and is reconciled by the clean-up job (a failed delete is retried on the next run), so bytes can linger until then; (4) the clean-up job runs every 15 minutes with a batch of 200 per pass (structural constants, not configuration) and its policy adapter in `apps/worker` duplicates the API's (`createWorkerGigPolicy` and `createGigPolicyProvider`); (5) the presigned PUT can be used by the owner to attach unsigned metadata headers, which the promotion no longer copies (REPLACE directive) but which the temporary `.upload` key keeps until it is swept; (6) a lifecycle rule on the bucket as a backstop does not exist.
Why deferred: each needs infrastructure (streaming multipart parsing, per-asset serialization or conditional-create on the store, the limiter, a bucket lifecycle rule) that other checkpoints own.
Exit criteria: the upload is streamed into the PUT, the limiter protects authorize and finalize, finalize is serialized per asset or the store supports a conditional create, the two policy adapters are one function in the provider package, and the bucket has a lifecycle rule for `.upload` keys.
Target checkpoint: DEBT-0030 for the limiter; the media delivery checkpoint for the rest

## DEBT-0101 — Provider Gigs: API shape and temporary editor limits of the options and photo flows

Status: OPEN
Severity: LOW
Introduced by: CAT-004
Owner/domain: api / web
Description: (1) Detaching a photo is `DELETE` with a JSON body (`expectedRevision`), which OpenAPI 3.1 permits but some proxies and generated clients drop; (2) the generated OpenAPI inlines the Gig detail in every route (`components.schemas` is empty project-wide), growing the file by about 16,700 lines and giving generated SDKs seventeen identical anonymous types; (3) the temporary editor takes price and duration deltas in whole minor units like the base price (DEBT-0095), shows "500 USD" for 500 minor units, and reports a validation failure with a closed issue word and no preserved input (typed values are never put in a redirect); (4) `PUT .../variants` without a key mints a new key, so a client that omits keys breaks cross-version identity (the web form always sends them); (5) success and error redirects end in a section fragment, so a sighted user lands on the section (the message is echoed there for the sections it can place, and announced from the top for everyone); (6) the visual design, previews, drag-and-drop and polish are UI-BASE-001.
Why deferred: the shared component schema registry and the design system are separate checkpoints.
Exit criteria: schemas are registered once in `components.schemas`; the detach route moves to a body-less shape; UI-BASE-001 retrofits the editor with a shared money component and field-level errors.
Target checkpoint: UI-BASE-001 and the API conventions follow-up

## DEBT-0102 — Production configuration validation is incomplete and the production code path is never exercised

Status: OPEN
Severity: MEDIUM
Introduced by: INF-002 (found by the ENG-GOV-001 audit, items A-04, A-05, A-16, A-19)
Owner/domain: platform / config
Description: In production the configuration (1) does not require Valkey, S3, SMTP or NATS for the API and Valkey or S3 for the worker (an empty Valkey URL connects to localhost; `S3_BUCKET` defaults to the development bucket and `MAIL_FROM` to a `.localhost` sender); (2) accepts `http://` public URLs, which makes the session cookies non-Secure and drops the `__Host-` prefix; (3) does not refuse the development database password and S3 keys; (4) accepts `DB_STATEMENT_TIMEOUT_MS=0`; (5) leaves the fake-adapter refusals to a single `NODE_ENV` default of `development`, so compose, the smoke and CI never boot the production path (only unit tests cover it) and only the fake SMS transport guards itself at construction; (6) lets `require_clean_scan` be turned off in production configuration with no code-level floor; (7) duplicates the seeded Gig policy defaults in code for tests.
Why deferred: found by an audit that changes no production code; the fixes change startup behaviour and need approval and tests.
Exit criteria: remediation items R-04 and R-05 of `docs/engineering/GOVERNANCE_REMEDIATION_PLAN.md`: production validation requires and refuses the values above, every fake adapter guards itself, a CI job boots the images with `NODE_ENV=production` and the disabled adapters, and the clean-scan floor is enforced.
Target checkpoint: ENG-GOV-002

## DEBT-0103 — Runtime resilience gaps: missing timeouts, lifecycle control, a side-effecting diagnostics endpoint, no migration deployment path and unbounded outbox retries

Status: OPEN
Severity: MEDIUM
Introduced by: INF-002 and later (found by the ENG-GOV-001 audit, items A-06, A-07, A-08, A-14)
Owner/domain: platform / api / worker
Description: (1) The web server's calls to the API, the S3 clients and an OpenSearch fetch have no timeout, and Fastify has no request or connection timeout; (2) there is no `unhandledRejection` or `uncaughtException` handler, no overall shutdown deadline, and the advisory-lock release path can return a still-locked connection to the pool; (3) `/internal/diagnostics` is registered unconditionally and unauthenticated, writes and deletes an S3 object, sends a real SMTP message with TLS verification disabled and returns the database version, protected only by a proxy 404 rule (MIT-0001), and `/metrics` is reachable through the proxy; (4) migrations run from the host only, and readiness is `SELECT 1`, so an image can report ready against an unmigrated or newer database; (5) poison outbox events retry forever, the JetStream duplicate window (120 s) is shorter than the backoff cap (300 s), and the purge error is swallowed.
Why deferred: found by an audit that changes no production code.
Exit criteria: remediation items R-06, R-07, R-08 and R-15 of the plan.
Target checkpoint: ENG-GOV-002 and ENG-GOV-003; the outbox items before payments or webhooks

## DEBT-0104 — No operational alerting, partial abuse protection and minimal security headers

Status: OPEN
Severity: MEDIUM
Introduced by: INF-002 and later (found by the ENG-GOV-001 audit, items A-09, A-10, A-11, A-17)
Owner/domain: platform / web / observability
Description: (1) The only metrics are database, auth and configuration counters: no HTTP rate, latency or error metrics, no outbox backlog or age, no job-failure counts, no Prometheus rules, and the worker stays ready when the relay stalls; (2) rate limiting covers only email and phone verification and password reset (DEBT-0030 lists the absence; the 142 authenticated routes and the web login are unlimited), and one Valkey with LRU eviction holds sessions, rate-limit counters and caches together; (3) only `frame-ancestors` and `X-Frame-Options` are set: no HSTS, nosniff, Permissions-Policy or full CSP behind the sanitised-HTML renderer; (4) log redaction works by key name only (no `email`, `phone`, `ip` or `subject`), although no leak was found.
Why deferred: found by an audit that changes no production code.
Exit criteria: remediation items R-09, R-11, R-12 and R-17 of the plan.
Target checkpoint: ENG-GOV-004 and the rate-limiting checkpoint (DEBT-0030)

## DEBT-0105 — Supply chain and test governance controls are partial

Status: OPEN
Severity: LOW
Introduced by: INF-001 and later (found by the ENG-GOV-001 audit, items A-12, A-15, A-18)
Owner/domain: infrastructure / testing
Description: Beyond the advisory gates added by ENG-GOV-001 (secret scan, policy scan, CodeQL, dependency review, workflow lint, Dependabot): container images are pinned by tag not digest (DEBT-0005); Trivy scans 3 of about 19 images; there is no SBOM or licence check; third-party containers lack the hardening the app images have; `env_file: .env` gives the API and worker every secret; ESLint is not type-aware (`no-floating-promises` is off), there are no coverage thresholds, every workspace test script uses `--passWithNoTests`, and one integration test skips silently when Valkey is unreachable.
Why deferred: each needs measurement and tuning before it can be required.
Exit criteria: remediation items R-13 and R-14 of the plan; the advisory jobs are made required (C-2).
Target checkpoint: ENG-GOV-004 and ENG-GOV-002


## DEBT-0106 — Provider public profile: assumed policy values, open product questions and deliberately missing capabilities

Status: OPEN
Severity: MEDIUM
Introduced by: PRO-002
Owner/domain: provider / product
Description: PRO-002 built the profile (display name, bio, one photo, PRIVATE/PUBLIC, derived badges, Gig cards, market code, readiness facts, preview, public read) and left out, by design: (1) **Assumed configuration values the PRD does not give:** `provider.profile.display_name.max_length` 60, `bio.max_length` 1000, `bio.required` false, `photo.required` false, `photo.max_file_size_bytes` 2 MiB, `public_badge_types` IDENTITY, BACKGROUND_CHECK, INSURANCE, and `public_requires_marketplace_eligibility` false (the two that decide exposure are marked CRITICAL). (2) **Open owner question:** whether a provider-entered display name may differ from first name plus last initial (PRD CU-02.11 shows only the latter; PR-09.02 lists display name and legal name separately); the default permits it. (3) **No moderation** of display name, bio or photo (impersonation, off-platform contact details, offensive content): a COMPLETED registration can publish a page with no review. (4) **No slug**, only the opaque id; no business provider profiles; no ratings or reviews (`ratings.available` false); no BananaDrop offers (`drops.available` false); no service-area summary (market code only); no CDN or stored sanitised derivative; no HEIC. (5) **Badge wording** ("Background check completed", "Insurance on file") is engineering copy awaiting product and legal review, and the badge set is a configuration list. (6) **The 404 for a profile is final:** there is no `SUSPENDED` state until moderation exists.
Why deferred: each needs a product or legal decision, a vendor or a later domain (RATE, DROP, AREA, SEARCH, admin moderation).
Exit criteria: the owner confirms or changes the assumed values; a moderation checkpoint adds a state and a review path by forward migration; the SEARCH and PRO-003 checkpoints decide marketplace exposure through `MarketplaceEligibilityPort`; DROP and RATE fill their placeholders.
Target checkpoint: PRO-003 (Go-Live), the admin moderation checkpoints, RATE-* and DROP-*

## DEBT-0107 — Provider public profile: the public routes are unthrottled and the photo is sanitised on every request

Status: OPEN
Severity: MEDIUM
Introduced by: PRO-002
Owner/domain: api / platform
Description: (1) `GET /api/v1/providers/{id}` and `/photo` are unauthenticated and not rate limited (DEBT-0030 now covers them): a request without `If-None-Match` costs about six statements plus ports, and the photo path reads the object (up to the configured cap, 25 MiB structural ceiling), hashes it and runs the sanitiser; (2) the sanitised bytes are not stored, so every uncached request repeats the work (a stored derivative also removes the question whether the container walk can ever be wrong for a given file); (3) the names port costs several identity statements per public read because `AccountService` has no narrow name read; (4) an authenticated provider can authorize photo uploads in a loop (each creates an asset row, an audit row and a revision bump) until the limiter exists, the same open pattern as DEBT-0087 for trust evidence; (5) a finalize that overlaps an abandon of the same pending upload can leave a promoted original (with its metadata) in the bucket that no sweep deletes (the CAT-004 pattern; it is never served); (6) the public page returns HTTP 200 with an alert when a dependency is down.
Why deferred: the limiter policy per route class and the derivatives pipeline are separate checkpoints.
Exit criteria: DEBT-0030 applies a per-IP budget to `/api/v1/providers/*` (a higher one for conditional requests); a sanitised derivative is stored at finalize; a narrow name read exists; authorization is throttled per profile; the object sweep covers the overlap; the outage page answers 503.
Target checkpoint: the rate-limit policy checkpoint (R-11) and the media delivery checkpoint

## DEBT-0108 — Provider public profile: the projection is not a single snapshot and several states are decided at read time

Status: OPEN
Severity: LOW
Introduced by: PRO-002
Owner/domain: provider
Description: (1) The profile, eligibility, market code, photo and published Gig facts come from ONE statement; trust badges, the fallback name, service names and the market status are separate reads in the same request, so a response can mix states up to one request apart (the spec asked for one repeatable-read snapshot; ports cannot join a caller's snapshot). (2) A PUBLIC profile stays PUBLIC in storage while read-time eligibility hides it (account, role or registration not active, flag without port); it reappears without owner action when eligibility returns. (3) Authorization of an upload, its abandonment and the expired-upload sweep raise the profile revision (an open owner form then gets 409 `STALE_PROFILE`) but emit no `profile-updated` event. (4) The orphan-sweep grace for a replaced photo runs from the asset's `ready_at`, not from the detach time, so a long-ready photo replaced just now can be deleted at the next sweep. (5) Owner mutations require only an ACTIVE account (public exposure is gated at read time), so a provider with an inactive role can still edit and upload. (6) After a committed hide or photo removal the answer degrades field by field when a dependency is down; the degraded echo is indistinguishable from a real zero, so a client must reread. (7) The `serve` path hides an outage as 503 only when an id is publicly readable (ids are unguessable). (8) Events carry the account id and the public id together, so any consumer learns the mapping.
Why deferred: each is cheap for the temporary audience and costly to remove before SEARCH and Go-Live define their needs.
Exit criteria: decide per item with PRO-003 and SEARCH (a snapshot-capable read model or accepted staleness; a stored or computed visibility reason; a detach timestamp; role-gated mutations; a degraded marker in the DTO; event consumer rules recorded in the AsyncAPI description).
Target checkpoint: PRO-003 and SEARCH-001

## DEBT-0109 — Provider public profile: the temporary web pages lose typed text on a refused save and share forms and formats with the Gig pages

Status: OPEN
Severity: LOW
Introduced by: PRO-002
Owner/domain: web
Description: (1) A refused save redirects with closed words only, so the typed name and bio are lost (the page re-renders from the stored profile); (2) details, photo, remove and visibility are separate forms, so unsaved text is dropped when another form is submitted (a hint says to save first); (3) the upload notes show raw MIME types and truncate the size to whole MB, and the counters show the stored length with no unit; (4) the public price uses `Intl` digits (CLDR) rather than the platform's ISO 4217 `minor_unit_digits` (the Gig owner pages still print raw minor units); (5) tab titles are fixed English literals and the Gig card sums variants and add-ons into one "Options" number (separate labels need keys); (6) the owner page is one large component with inline helpers and borrowed `gig-*` class names; (7) the public page is `noindex` and states that booking is not open, but a final design for it does not exist.
Why deferred: UI-BASE-001 retrofits every screen with a shared form model, money component and design system.
Exit criteria: field-level server errors keep the typed values (client state), one money component reads the currency digits from the platform, shared FormField/StatusNote/FactList components exist, titles come from the registry.
Target checkpoint: UI-BASE-001
