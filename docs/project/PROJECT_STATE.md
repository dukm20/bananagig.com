# Project State

Current truth only. History lives in `IMPLEMENTATION_HISTORY.md`; decisions in `docs/architecture/`.

Current checkpoint: CI-001
Last completed checkpoint: CI-001
Next approved checkpoint: CFG-002 — Content and Localization Registry
Latest migration: 0004_configuration_registry.sql
Latest ADR: ADR-0017
Last updated: 2026-10-05

## Architecture

Modular monolith in a pnpm/Turborepo workspace. PostgreSQL (with PostGIS) is authoritative; NATS JetStream carries events; Valkey, OpenSearch and S3 (SeaweedFS) hold derived data and blobs. Everything runs locally under Docker Compose behind Caddy. See `docs/engineering/APPLICATION_ARCHITECTURE.md` and `docs/engineering/CONTAINER_ARCHITECTURE.md`.

## Applications

| App | State |
|---|---|
| `apps/web` (container `web-app`) | Next.js 16 App Router shell. Infrastructure pages only: `/`, `/health`, `/system`, `/session`; `/healthz`, `/readyz`, `/metrics`; auth routes `/auth/login`, `/auth/callback`, `/auth/session`, POST `/auth/logout` (PKCE, server-side session in Valkey). Typed API client with `getSystemInfo()` and `getWhoAmI()` |
| `apps/api` (container `api-service`) | Fastify 5. `GET /healthz`, `/readyz`, `/version`, `/api/v1/system/info`, `/api/v1/system/whoami` (requires a Keycloak access token), and the configuration module under `/api/v1/configuration` (admin context plus `configuration-read/write/approve` client roles). Standard error model, correlation ids, auth guards (401/403) |
| `apps/worker` (container `worker-service`) | pg-boss + NATS host with health server and the transactional-outbox relay (publishes to JetStream stream `BANANAGIG_EVENTS`). Jobs: infrastructure `infra.ping` and `configuration.activate-due` (cron, every minute). Events: `bananagig.infra.ping.v1` and the five `bananagig.configuration.*.v1` events via the outbox |
| `apps/smoke` | 28-check connectivity test (`pnpm smoke`), including identity and the configuration registry |

Packages: `configuration` (registry service, resolver, cache, last-known-good), `identity` (JWT verification, OIDC/PKCE helpers, DEV/TEST-only `/testing`), `contracts`, `config`, `observability` (incl. DB telemetry), `database` (Kysely + pg, pool policies, transaction options, lock helpers), `platform` (adapters, outbox store), `testing` (isolated migrated test databases).

## Infrastructure

Compose service keys are descriptive role names and containers are `bananagig-<service key>` (convention in `docs/engineering/CONTAINER_ARCHITECTURE.md`). Profiles: `core` (postgres-db, valkey-cache, nats-events, seaweedfs-storage, seaweedfs-storage-init, keycloak-auth, flagd-flags, api-service, worker-service, web-app, caddy-proxy), `observability` (otel-collector, prometheus-metrics, grafana-dashboard, loki-logs, tempo-traces), `search` (opensearch-search), `devtools` (mailpit-email), `tools` (smoke). Identity: Keycloak realm `bananagig` from `infra/keycloak/bananagig-realm.json` (admin client roles `configuration-read/write/approve` added in CFG-001; clients `bananagig-web`, `bananagig-api`, `bananagig-admin`, dev-only `bananagig-dev-test`); the issuer is pinned to the public URL; Caddy exposes only realm endpoints on `auth.localhost`. Local entry point: caddy-proxy on 127.0.0.1:8080 (`*.localhost`). Dev mode: `pnpm dev` runs apps on the host (web 3210, api 3211, worker 3212) with dependency containers via `compose.dev.yaml`.

## Database schemas

| Schema | Class | Contents |
|---|---|---|
| `public` | application bookkeeping + extension | `schema_migrations` (version PK, filename, checksum, applied_at, duration_ms); `spatial_ref_sys` (PostGIS) |
| `integration` | application | `outbox_events` (transactional outbox) |
| `configuration` | application | 10 tables: `scope_levels` (seeded hierarchy), `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queues `infra.ping`, `configuration.activate-due` |
| (database `keycloak`) | infrastructure (Keycloak) | separate database |

No business tables and no business parameters (the registry is empty of product configuration; `scope_levels` is structural reference data). Product schemas are created by the first feature that needs each (ADR-0008); the reserved names are listed in `docs/data/DATA_MODEL.md`. Conventions: `docs/data/DATABASE_CONVENTIONS.md`. Migration rules: `docs/data/MIGRATION_POLICY.md` (forward-only, ADR-0010). Local DB access uses the Postgres superuser (DEV ONLY, DEBT-0012).

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
- Governance system: project state, history, learnings, debt, skills, ADRs, data-model gate, checkpoint scripts

## Partially implemented capabilities

- PWA: manifest only (DEBT-0003)
- Identity: notifications/recovery flows (DEBT-0017), WebAuthn and step-up (DEBT-0018), account console/theme (DEBT-0019), host-mode login (DEBT-0020), secret manager and production realm provisioning (DEBT-0016)
- Configuration: temporary client-role permissions (DEBT-0021), activation marker lag (DEBT-0022), no admin UI (DEBT-0023), unvalidated scope references (DEBT-0024), retention undefined (DEBT-0025)
- Idempotency records table designed, not built (DEBT-0013)
- Least-privilege runtime database roles designed, not built (DEBT-0012)
- CI: first run (2026-10-06 UTC, commit 17b6b8d) failed at `pnpm audit --prod`; CI-001 resolved the cause, but the governance and compose-smoke jobs have not yet run remotely (DEBT-0001)
- Web telemetry: SDK registered; page-level traces and logs not verified in Tempo/Loki (DEBT-0011)

## Known blockers

None.

## Test counts

Unit: 116 (config 6, contracts 4, observability 2, identity 20, configuration 25, api 32, worker 5, web 22) plus 59 root script tests (governance 37, identity realm 21, migration files 1). Integration: 133 (database 18, locks 9, migrations 11, postgis 6, outbox 8, worker 4, Keycloak 21, API auth 5, configuration 46, API configuration 5). Smoke: 28 checks.
