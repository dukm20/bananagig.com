# Project State

Current truth only. History lives in `IMPLEMENTATION_HISTORY.md`; decisions in `docs/architecture/`.

Current checkpoint: INF-002A
Last completed checkpoint: INF-002A
Next approved checkpoint: INF-004 — Keycloak Identity Baseline
Latest migration: 0003_integration_outbox.sql
Latest ADR: ADR-0012
Last updated: 2026-10-05

## Architecture

Modular monolith in a pnpm/Turborepo workspace. PostgreSQL (with PostGIS) is authoritative; NATS JetStream carries events; Valkey, OpenSearch and S3 (SeaweedFS) hold derived data and blobs. Everything runs locally under Docker Compose behind Caddy. See `docs/engineering/APPLICATION_ARCHITECTURE.md` and `docs/engineering/CONTAINER_ARCHITECTURE.md`.

## Applications

| App | State |
|---|---|
| `apps/web` (container `web-app`) | Next.js 16 App Router shell. Infrastructure pages only: `/`, `/health`, `/system`; `/healthz`, `/readyz`, `/metrics`. Typed API client with `getSystemInfo()` |
| `apps/api` (container `api-service`) | Fastify 5. `GET /healthz`, `/readyz`, `/version`, `/api/v1/system/info`. System module only. Standard error model and correlation ids |
| `apps/worker` (container `worker-service`) | pg-boss + NATS host with health server and the transactional-outbox relay (publishes to JetStream stream `BANANAGIG_EVENTS`). Only the infrastructure `infra.ping` job and `bananagig.infra.ping.v1` event |
| `apps/smoke` | 23-check connectivity test (`pnpm smoke`) |

Packages: `contracts`, `config`, `observability` (incl. DB telemetry), `database` (Kysely + pg, pool policies, transaction options, lock helpers), `platform` (adapters, outbox store), `testing` (isolated migrated test databases).

## Infrastructure

Compose service keys are descriptive role names and containers are `bananagig-<service key>` (convention in `docs/engineering/CONTAINER_ARCHITECTURE.md`). Profiles: `core` (postgres-db, valkey-cache, nats-events, seaweedfs-storage, seaweedfs-storage-init, keycloak-auth, flagd-flags, api-service, worker-service, web-app, caddy-proxy), `observability` (otel-collector, prometheus-metrics, grafana-dashboard, loki-logs, tempo-traces), `search` (opensearch-search), `devtools` (mailpit-email), `tools` (smoke). Local entry point: caddy-proxy on 127.0.0.1:8080 (`*.localhost`). Dev mode: `pnpm dev` runs apps on the host (web 3210, api 3211, worker 3212) with dependency containers via `compose.dev.yaml`.

## Database schemas

| Schema | Class | Contents |
|---|---|---|
| `public` | application bookkeeping + extension | `schema_migrations` (version PK, filename, checksum, applied_at, duration_ms); `spatial_ref_sys` (PostGIS) |
| `integration` | application | `outbox_events` (transactional outbox) |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queue `infra.ping` |
| (database `keycloak`) | infrastructure (Keycloak) | separate database |

No business tables. Product schemas are created by the first feature that needs each (ADR-0008); the reserved names are listed in `docs/data/DATA_MODEL.md`. Conventions: `docs/data/DATABASE_CONVENTIONS.md`. Migration rules: `docs/data/MIGRATION_POLICY.md` (forward-only, ADR-0010). Local DB access uses the Postgres superuser (DEV ONLY, DEBT-0012).

## External integrations

None to external services. Local-only stand-ins: Mailpit (SMTP sink), Keycloak realm `bananagig-dev` (empty), flagd (one flag).

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
- Governance system: project state, history, learnings, debt, skills, ADRs, data-model gate, checkpoint scripts

## Partially implemented capabilities

- PWA: manifest only (DEBT-0003)
- Idempotency records table designed, not built (DEBT-0013)
- Least-privilege runtime database roles designed, not built (DEBT-0012)
- CI: workflow written, never executed (DEBT-0001)
- Web telemetry: SDK registered; page-level traces and logs not verified in Tempo/Loki (DEBT-0011)

## Known blockers

None.

## Test counts

Unit: 29 (config 5, contracts 4, observability 2, api 8, worker 4, web 5, migration files 1) plus 34 governance script tests. Integration: 55 (database 18, locks 9, migrations 11, postgis 6, outbox 8, worker 3). Smoke: 23 checks.
