# Technical Debt

Every knowingly postponed item is recorded here, not buried in completion reports. IDs are permanent. Statuses: OPEN, IN_PROGRESS, ACCEPTED (a conscious, documented risk), RESOLVED (keep the entry).

## DEBT-0001 — CI workflow never executed

Status: OPEN
Severity: MEDIUM
Introduced by: INF-001
Owner/domain: infrastructure
Description: `.github/workflows/ci.yml` (verify, integration, compose-smoke, Trivy, governance) is written but has never run. A remote `origin` (github.com/dukm20/bananagig.com) was configured in `.git/config` outside the checkpoints (not by the checkpoint tooling), but nothing has been pushed, so no run exists. Everything the workflow runs was verified locally.
Why deferred: pushing is a separate explicit human decision; checkpoint tooling never pushes.
Exit criteria: a remote exists, the first push is made by the owner, the workflow runs green on a PR, and branch protection requires it.
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
Exit criteria: Verified-email and recovery flows implemented with configured SMTP (Mailpit locally), recovery codes and tests.
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
Why deferred: No consumer needs sub-minute notification.
Exit criteria: A consumer with a documented latency need, then a tighter schedule or database-driven wake-up.
Target checkpoint: first consumer of `configuration.activated.v1`

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

Status: OPEN
Severity: MEDIUM
Introduced by: CFG-001
Owner/domain: configuration / each owning domain
Description: `scope_ref` is an opaque string with no foreign key, so a value can be set for a market, category or provider that does not exist or is later removed. The scope level is enforced; the entity is not.
Why deferred: The domain tables do not exist yet and the registry must not depend on them.
Exit criteria: A scope-reference validator port implemented by each owning domain and called on change-request creation and publish, with a test per scope level.
Target checkpoint: first checkpoint that creates a domain table used as a scope (geography/market, catalog/category, provider)

## DEBT-0025 — Snapshot and audit retention undefined

Status: OPEN
Severity: LOW
Introduced by: CFG-001
Owner/domain: configuration / data governance
Description: Snapshots, snapshot items, audit events and value versions are retained indefinitely. Snapshot volume will grow once bookings take one per quote.
Why deferred: No volume data; retention rules depend on legal and finance requirements.
Exit criteria: Documented retention per table, archival or partitioning where justified, and a restore test.
Target checkpoint: before the first booking checkpoint goes live
