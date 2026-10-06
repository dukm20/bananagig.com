# Implementation History

Append-only: one entry per completed checkpoint, oldest first. Correct mistakes in place; do not delete entries. The commit of a checkpoint cannot contain its own hash, so find it with `git log --grep "(<ID>)"`.

## INF-001 — 2026-10-05

Status: COMPLETE
Commit: baseline commit not yet created (no commits existed at completion). When made, find it with `git log --grep "(INF-002)"`.
Summary: Greenfield repository and local Docker Compose platform: PostgreSQL+PostGIS, Valkey, Keycloak, NATS JetStream, SeaweedFS S3, OpenSearch, flagd, OpenTelemetry Collector, Prometheus, Grafana, Loki, Tempo, Mailpit and Caddy, with placeholder web/api/worker.

### Delivered
- Compose stack with profiles, healthchecks, named volumes, loopback-only published ports
- Multi-stage Dockerfile (esbuild single-file bundles), non-root read-only containers
- `scripts/migrate.mjs` forward-only migration runner with checksum guard
- 20-check smoke test running inside the Compose network
- Docs: local development, container architecture, open-source stack, data-model guardrails

### Schema
`db/migrations/0001_infra_baseline.sql` (PostGIS extension). `public.schema_migrations` created by the runner. No business tables.

### Contracts
None.

### Tests
Unit 3, smoke 20 checks.

### Skills updated
None (the skills system did not exist yet; created by META-001 from this checkpoint's lessons).

### ADRs
None at the time; ADR-0001 to ADR-0005 were recorded retroactively by META-001.

### Known follow-up
Application skeletons (INF-002); CI unexecuted; digest pinning.

## INF-002 — 2026-10-05

Status: COMPLETE
Commit: baseline commit not yet created. Find it with `git log --grep "(INF-002)"`.
Summary: Real application skeletons: Next.js web, Fastify API, worker host; shared config, contracts, observability, database and platform packages; generated OpenAPI/AsyncAPI; correlation and error model; dependency boundaries; host-based dev workflow with hot reload; image and dependency scans.

### Delivered
- web (Next.js 16), api (Fastify, system module), worker (pg-boss + NATS + health server)
- `packages/{config,contracts,observability,database,platform,testing}`
- OpenAPI 3.1 and AsyncAPI 3.0 generated from code, drift-checked and validated
- `pnpm dev` (host apps, container deps), `pnpm test:integration`, `pnpm deps:check`
- Smoke test grew to 22 checks (correlation found in Loki, worker job+event round-trip, web to API)
- Trivy image scans (0 HIGH/CRITICAL), dependency audit with documented dev-tool findings
- Docs: application architecture, API and event conventions, scan results

### Schema
No schema change. Reviewed live schemas; decision recorded that product tables use per-domain schemas (ADR-0008).

### Contracts
`docs/api/openapi.yaml` (system endpoints), `docs/events/asyncapi.yaml` (envelope, `infra.ping`).

### Tests
Unit 29, integration 10, smoke 22 checks.

### Skills updated
None (skills created in META-001).

### ADRs
ADR-0006, ADR-0007, ADR-0008 and ADR-0009 were recorded by META-001 for decisions made here.

### Known follow-up
DEBT-0001 to DEBT-0011.

## META-001 — 2026-10-05

Status: COMPLETE
Commit: not created (the user has not asked for commits). Find it later with `git log --grep "(META-001)"`.
Summary: Self-documenting repository: constitution (`CLAUDE.md`), project state, history, learnings, tech debt, six skills, nine ADRs, data-model automation (schema snapshot, review gate), and checkpoint start/finalize/commit scripts with CI governance.

### Delivered
- `CLAUDE.md`, `docs/project/*`, `skills/*`, `docs/architecture/ADR-0001` to `ADR-0009`
- `docs/data/{DATA_MODEL_CHANGELOG,DATA_DICTIONARY,ERD,NORMALIZATION_LOG,SCHEMA_SNAPSHOT.sql}`
- Scripts: `schema-snapshot`, `data-model-check`, `skills-check`, `project-state-check`, `checkpoint-start`, `checkpoint-finalize`, `commit-checkpoint` (+ shared `lib/governance.mjs`)
- Prettier formatting gate; `COMMIT_POLICY.md`; CI governance steps

### Schema
No schema change.

### Contracts
None.

### Tests
Governance tests in `scripts/governance.test.mjs` exercise each checker and the commit tool against scratch git repositories.

### Skills updated
Created six initial skills from INF-001/INF-002 knowledge.

### ADRs
ADR-0001 to ADR-0009 seeded for decisions already made.

### Known follow-up
First real use of `checkpoint:start/finalize/commit` happens in INF-003 (requires the baseline commit).

## INF-003 — 2026-10-05

Status: COMPLETE
Commit: find it with `git log --grep "(INF-003)"`.
Summary: Production-grade PostgreSQL/PostGIS foundation: hardened forward-only migration runner, upgraded migration bookkeeping, the `integration` schema with a transactional outbox and JetStream relay, pool/timeout policy, transaction options and locking helpers, DB telemetry, isolated per-file test databases, and a backup/restore development check. Database conventions and migration policy documented.

### Delivered
- `scripts/lib/migrator.mjs`: checksum guard, duplicate/gap detection, headers and destructive-marker rules, advisory lock with timeout, per-file transactions, check mode
- `packages/database`: pool policies per role, statement/lock/idle-in-transaction timeouts, transaction options (isolation, read-only, timeouts, nesting rules), `applyRowLock`, advisory-lock helpers, telemetry hooks
- Outbox store (`packages/platform/src/outbox.ts`), `PollingOutboxRelay`, JetStream stream `BANANAGIG_EVENTS` with message-id de-duplication; resolves DEBT-0002
- DB telemetry: query/transaction/pool metrics, slow-query warning, SQL text off by default
- Test isolation (`createIsolatedDatabase`), 55 integration tests, `pnpm db:backup-test`
- Docs: `DATABASE_CONVENTIONS.md`, `MIGRATION_POLICY.md`; ADR-0010, ADR-0011, ADR-0012
- Clean `git clone` bootstrap verified (closes DEBT-0010)

### Schema
Migrations `0002_database_foundation.sql` (schema_migrations: version PK, duration_ms, constraints) and `0003_integration_outbox.sql` (`integration` schema, `integration.outbox_events`). No business tables.

### Contracts
No API change. Event envelope unchanged; the worker now publishes through JetStream.

### Tests
Unit 29, governance 34, integration 55, smoke 23 checks, backup/restore test passing.

### Skills updated
`skills/database` (rewritten with INF-003 rules), `skills/worker` (outbox), `skills/testing` (isolated databases).

### ADRs
ADR-0010 forward-only migrations, ADR-0011 core data conventions, ADR-0012 transactional outbox; ADR-0002 updated.

### Known follow-up
DEBT-0012 (runtime roles), DEBT-0013 (idempotency records), DEBT-0014 (non-transactional migrations), DEBT-0015 (backup is a dev check). DEBT-0002 and DEBT-0010 resolved.

## INF-002A — 2026-10-05

Status: COMPLETE
Commit: find it with `git log --grep "(INF-002A)"`.
Summary: Naming-only cleanup: Compose service keys now describe roles (`postgres-db`, `api-service`, `caddy-proxy`, ...), containers are `bananagig-<service key>`, and every internal DNS reference, config, script, smoke label and document uses the new names. No technology, port or behavior changed.

### Delivered
- All 18 long-running services renamed (plus `seaweedfs-storage-init`); `otel-collector` and `smoke` keep their names
- Internal DNS updated: `postgres-db:5432`, `valkey-cache:6379`, `nats-events:4222`, `seaweedfs-storage:8333`, `opensearch-search:9200`, `keycloak-auth:8080`, `api-service:3000`, `mailpit-email`, `flagd-flags`, `prometheus-metrics`, `loki-logs`, `tempo-traces`, `grafana-dashboard`
- Caddy upstreams, Prometheus targets and job names, Grafana datasource URLs, OTel exporters, CI service containers, `scripts/dev.mjs`, `scripts/db-backup-test.mjs`
- Smoke output uses friendly names (Postgres DB, Valkey Cache, ..., Worker Service); "available" for PostGIS and JetStream
- Docs: container architecture (naming convention and service table), local development, open-source stack (service column), application architecture diagram
- Checkpoint scripts accept letter-suffixed ids (`INF-002A`)

### Schema
No schema change (data model review gate: NOT_REQUIRED, naming-only).

### Contracts
None.

### Tests
Unit 29, governance 35, integration 55, smoke 23 checks (all passing after the rename).

### Skills updated
`skills/infrastructure`: naming convention rule.

### ADRs
None (convention, not an architecture decision).

### Known follow-up
Telemetry `service.name` values (`bananagig-api`, `bananagig-worker`, `bananagig-web`) and named volumes keep their original names by design; rename them only with a deliberate log/dashboard migration.

## INF-004 — 2026-10-05

Status: COMPLETE
Commit: find it with `git log --grep "(INF-004)"`.
Summary: Production-capable identity baseline on Keycloak: realm as code, web client with Authorization Code + PKCE and a server-side session, API JWT validation with guards and `whoami`, a separate admin client with an MFA-ready flow, minimal claims, auth telemetry, locked-down Caddy auth routes, and tests from forged tokens to live protocol checks. No users table or business flow.

### Delivered
- `infra/keycloak/bananagig-realm.json` (realm `bananagig`; clients web, api, admin, dev-only test client; roles customer/provider and the admin client role; TOTP policy; ACR map), pinned issuer via `KC_HOSTNAME`
- `packages/identity`: `TokenVerifier`, OIDC/PKCE helpers, DEV/TEST-only `/testing` helpers (ESLint-restricted)
- API: `plugins/auth.ts` guards (`requireAuthenticated`, `requireRealmRole`, `requireAnyRole`, `requireClientRole`, `requireAuthContext`), `GET /api/v1/system/whoami`, 401/403/503 standard errors, `security-defined` lint enforced
- Web: `/auth/login`, `/auth/callback`, `/auth/session`, POST `/auth/logout`, `/session` page, server-side Valkey session, bearer calls to the API
- Auth telemetry (counts by failure category, mismatch counters, duration); no token material in logs
- `pnpm identity:check`, `identity:sync` (dev), `identity:build-prod` (strips dev-only, enforces admin OTP, https origins)
- Caddy: public identity host exposes only realm endpoints; dev-only admin console host; admin host reserved
- Smoke grew to 27 checks (realm/clients, PKCE logins, API auth, web session E2E, Caddy auth routes)
- Docs: `IDENTITY.md`; ADR-0013, ADR-0014, ADR-0015; skill `skills/identity`

### Schema
No schema change (data model: NOT_REQUIRED). Future `identity.external_identities` keyed by Keycloak `sub` documented for ID-001.

### Contracts
OpenAPI: `GET /api/v1/system/whoami` and the `bearerAuth` security scheme; public routes now declare `security: []`.

### Tests
Unit 83, root script tests 59, integration 81, smoke 27 checks.

### Skills updated
New `skills/identity`; updated `api`, `web`, `infrastructure`, `testing`.

### ADRs
ADR-0013 (Keycloak and data ownership), ADR-0014 (PKCE and server-side session), ADR-0015 (admin separation and role split).

### Known follow-up
DEBT-0016 to DEBT-0020. Built-in `admin-cli` password grant found and disabled (LRN-0014).


## CFG-001 — 2026-10-05

Status: COMPLETE
Commit: find it with `git log --grep "(CFG-001)"`.
Summary: Generic configuration registry with no business parameters: typed parameters, a scope hierarchy (PLATFORM to DROP), immutable effective-dated versions with database overlap prevention, change requests with approval policies (including second approver), scheduled activation, immutable snapshots, append-only audit, outbox events, and a cached resolver with last-known-good for non-critical parameters.

### Delivered
- Migration `0004_configuration_registry.sql`: schema `configuration`, 10 tables, `btree_gist`, exclusion constraint `ex_value_versions__no_overlap`, immutability and workflow guard triggers, seeded `scope_levels`
- `packages/configuration`: `ConfigurationService`, 3-query batch resolver, Valkey and in-memory cache, value validation for 8 data types
- `packages/contracts`: configuration contracts and event payloads; `envelope.ts` split out to avoid a cycle
- API module `/api/v1/configuration` (parameters, resolve, snapshots, change requests with submit/approve/reject/cancel/publish), guards `requireConfigurationPermission(read|write|approve)`, redaction of SENSITIVE values
- Worker job `configuration.activate-due` (cron every minute)
- Keycloak: admin client roles `configuration-read/write/approve`; second dev admin `admin2.dev`
- OpenAPI and AsyncAPI regenerated (five configuration events); smoke grew to 28 checks (two real admin PKCE logins, self-approval refused)
- Migration integration tests no longer hardcode the latest migration number
- Docs: `docs/engineering/CONFIGURATION.md`; ADR-0016, ADR-0017; skill `skills/configuration`; data-model documents

### Schema
New schema `configuration` (10 tables); see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (CFG-001). `docs/design/` (brand kit) is excluded from tooling through `.git/info/exclude` and is not part of this checkpoint.

### Contracts
OpenAPI: 12 configuration operations. AsyncAPI: `bananagig.configuration.change-requested|change-approved|change-rejected|scheduled|activated.v1`.

### Tests
Unit 116, root script tests 59, integration 133, smoke 28 checks.

### Skills updated
New `skills/configuration`; updated `database`, `api`, `worker`, `testing`, `identity`.

### ADRs
ADR-0016 (registry design), ADR-0017 (cache, last-known-good, temporary permissions).

### Known follow-up
DEBT-0021 to DEBT-0025. LRN-0015 to LRN-0017.
