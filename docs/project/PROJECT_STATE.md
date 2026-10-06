# Project State

Current truth only. History lives in `IMPLEMENTATION_HISTORY.md`; decisions in `docs/architecture/`.

Current checkpoint: META-001
Last completed checkpoint: META-001
Next approved checkpoint: INF-003 — PostgreSQL/PostGIS and Migration Discipline
Latest migration: 0001_infra_baseline.sql
Latest ADR: ADR-0009
Last updated: 2026-10-05

## Architecture

Modular monolith in a pnpm/Turborepo workspace. PostgreSQL (with PostGIS) is authoritative; NATS JetStream carries events; Valkey, OpenSearch and S3 (SeaweedFS) hold derived data and blobs. Everything runs locally under Docker Compose behind Caddy. See `docs/engineering/APPLICATION_ARCHITECTURE.md` and `docs/engineering/CONTAINER_ARCHITECTURE.md`.

## Applications

| App | State |
|---|---|
| `apps/web` | Next.js 16 App Router shell. Infrastructure pages only: `/`, `/health`, `/system`; `/healthz`, `/readyz`, `/metrics`. Typed API client with `getSystemInfo()` |
| `apps/api` | Fastify 5. `GET /healthz`, `/readyz`, `/version`, `/api/v1/system/info`. System module only. Standard error model and correlation ids |
| `apps/worker` | pg-boss + NATS host with health server. Only the infrastructure `infra.ping` job and `bananagig.infra.ping.v1` event |
| `apps/smoke` | 22-check connectivity test (`pnpm smoke`) |

Packages: `contracts`, `config`, `observability`, `database` (Kysely + pg), `platform` (adapters), `testing`.

## Infrastructure

Compose profiles: `core` (postgres, valkey, nats, seaweedfs, keycloak, flagd, api, worker, web, caddy), `observability` (otel-collector, prometheus, grafana, loki, tempo), `search` (opensearch), `devtools` (mailpit), `tools` (smoke). Local entry point: Caddy on 127.0.0.1:8080 (`*.localhost`). Dev mode: `pnpm dev` runs apps on the host (web 3210, api 3211, worker 3212) with dependency containers via `compose.dev.yaml`.

## Database schemas

| Schema | Contents |
|---|---|
| `public` | `schema_migrations` (application), `spatial_ref_sys` (PostGIS) |
| `pgboss` | pg-boss internals (13 tables), queue `infra.ping` |
| (database `keycloak`) | Keycloak, separate database |

No business tables. Product tables will live in per-domain schemas (ADR-0008). Details: `docs/data/DATA_MODEL.md`.

## External integrations

None to external services. Local-only stand-ins: Mailpit (SMTP sink), Keycloak realm `bananagig-dev` (empty), flagd (one flag).

## Active feature flags

`dev-test-flag` (flagd, `infra/flagd/flags.json`), a connectivity test flag, not a product flag.

## Completed capabilities

- Local container platform with health, readiness and a passing connectivity smoke test
- Typed validated configuration, structured logging, tracing, request correlation (HTTP, DB transaction setting, jobs, events)
- API skeleton with generated OpenAPI 3.1, AsyncAPI 3.0 event envelope, standard error model
- Database package with transaction helper (rollback, nesting, isolation level)
- Worker runtime with graceful shutdown
- Workspace dependency rules enforced by script and lint
- Governance system: project state, history, learnings, debt, skills, ADRs, data-model gate, checkpoint scripts

## Partially implemented capabilities

- PWA: manifest only (DEBT-0003)
- Transactional outbox: relay port only, no table or loop (DEBT-0002)
- CI: workflow written, never executed (DEBT-0001)
- Web telemetry: SDK registered; page-level traces and logs not verified in Tempo/Loki (DEBT-0011)

## Known blockers

None.

## Test counts

Unit: 29 (config 5, contracts 4, observability 2, api 8, worker 4, web 5, migration files 1). Governance script tests: 33 in `scripts/governance.test.mjs` (counted in `pnpm test`; root total with migration-file test 34). Integration: 10 (database 7, worker 3). Smoke: 22 checks.
