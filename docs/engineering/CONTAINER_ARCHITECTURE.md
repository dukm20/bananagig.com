# Container Architecture

Docker Compose project `bananagig`, one bridge network `bananagig-net`, one primary concern per container.

## Naming convention

- **Compose service keys are descriptive role names** (`postgres-db`, `api-service`, `caddy-proxy`). The key is also the DNS name other containers use (`postgres-db:5432`, `nats-events:4222`, `keycloak-auth:8080`).
- **Container names are `bananagig-<service key>`** (`bananagig-postgres-db`). Internal addressing always uses the service key, never `container_name`.
- **Technology identity is documented separately** in the table below and in `OPEN_SOURCE_STACK.md`, so a technology can be swapped without renaming the role.
- Unchanged by design: named volumes (`bananagig_postgres_data`, ... they identify data), telemetry `service.name` values (`bananagig-api`, `bananagig-worker`, `bananagig-web`: application identity used in logs and traces), workspace and image names (`apps/api`, `bananagig/api:dev`).

| Service key (DNS name) | Container | Technology | Role |
|---|---|---|---|
| `postgres-db` | `bananagig-postgres-db` | PostgreSQL 17 + PostGIS | authoritative database |
| `valkey-cache` | `bananagig-valkey-cache` | Valkey | cache |
| `nats-events` | `bananagig-nats-events` | NATS + JetStream | events |
| `seaweedfs-storage` | `bananagig-seaweedfs-storage` | SeaweedFS (S3) | object storage |
| `seaweedfs-storage-init` | `bananagig-seaweedfs-storage-init` | SeaweedFS shell | one-shot bucket creation |
| `keycloak-auth` | `bananagig-keycloak-auth` | Keycloak | identity |
| `flagd-flags` | `bananagig-flagd-flags` | flagd | feature flags |
| `api-service` | `bananagig-api-service` | Fastify app | HTTP API |
| `worker-service` | `bananagig-worker-service` | Node worker (pg-boss, NATS) | background work |
| `web-app` | `bananagig-web-app` | Next.js app | web UI |
| `caddy-proxy` | `bananagig-caddy-proxy` | Caddy | reverse proxy |
| `opensearch-search` | `bananagig-opensearch-search` | OpenSearch | search projection |
| `otel-collector` | `bananagig-otel-collector` | OpenTelemetry Collector | telemetry ingest |
| `prometheus-metrics` | `bananagig-prometheus-metrics` | Prometheus | metrics |
| `loki-logs` | `bananagig-loki-logs` | Loki | logs |
| `tempo-traces` | `bananagig-tempo-traces` | Tempo | traces |
| `grafana-dashboard` | `bananagig-grafana-dashboard` | Grafana | dashboards |
| `mailpit-email` | `bananagig-mailpit-email` | Mailpit | email sink |
| `smoke` | `bananagig-smoke` | Node app | one-shot connectivity test |

## Profiles

| Profile | Services | Started by |
|---|---|---|
| `core` | postgres-db, valkey-cache, nats-events, seaweedfs-storage, seaweedfs-storage-init, keycloak-auth, flagd-flags, api-service, worker-service, web-app, caddy-proxy | `docker compose up -d` (`COMPOSE_PROFILES=core` in `.env`) |
| `observability` | otel-collector, prometheus-metrics, grafana-dashboard, loki-logs, tempo-traces | `--profile observability` |
| `search` | opensearch-search | `--profile search` |
| `devtools` | mailpit-email | `--profile devtools` |
| `tools` | smoke (one-shot) | `pnpm smoke` |

`pnpm stack:all` enables all four long-running profiles. The smoke test needs all of them.

## Topology

```
host:8080 -> caddy-proxy -> web-app | api-service | keycloak-auth | grafana-dashboard | mailpit-email | prometheus-metrics     (Host header routing)
host:5433 -> postgres-db (127.0.0.1 only, for migrations and psql)

api-service, worker-service -> postgres-db, valkey-cache, nats-events (JetStream), seaweedfs-storage (S3), opensearch-search, flagd-flags, mailpit-email (SMTP)
web-app -> api-service (server-side API calls)
web-app, api-service, worker-service -> otel-collector (OTLP/HTTP :4318) -> tempo-traces (traces), loki-logs (logs)
prometheus-metrics -> web-app, api-service, worker-service  /metrics
grafana-dashboard -> prometheus-metrics, loki-logs, tempo-traces
keycloak-auth -> postgres-db (own `keycloak` database and role)
web-app -> valkey-cache (server-side session records only), keycloak-auth (back-channel token calls)
api-service -> keycloak-auth (JWKS fetch, cached)
```

## Application containers

Built from the one root `Dockerfile` (`--build-arg APP=<app>`), multi-stage: `fetch` (pnpm store cached until the lockfile changes) -> `build` -> runtime.

- **api-service, worker-service, smoke** (`--target runtime`): esbuild bundles each app into one `index.js`; the image is `node:24-alpine` plus that file.
- **web-app** (`--target runtime-web`): Next.js `standalone` output (server, traced `node_modules`, static assets).
- npm, corepack and yarn are removed from runtime images (not needed; they carried the base image's only HIGH findings).
- Non-root `node` user, `read_only` root filesystem (web gets `tmpfs` for `.next/cache` and `/tmp`), `cap_drop: ALL`, `no-new-privileges`.
- Build args `APP_VERSION`, `GIT_SHA`, `BUILD_TIME` populate `/version`.
- Healthchecks hit `/readyz` on port 3000. Compose publishes none of these ports; Caddy is the only entry.
- `web-app` gets an explicit minimal environment (no `env_file`), so it never holds database or infrastructure credentials.
- Graceful shutdown: api-service and worker-service handle SIGTERM (stop accepting, drain, close DB/NATS/Valkey, flush telemetry bounded to 3 s) and exit 0 in well under a second. The web-app container exits via SIGTERM default (143): the Next standalone server has no drain hook (DEBT, stateless).
- `/internal/diagnostics` (api-service, worker-service) runs connectivity checks, is not routed by Caddy and is excluded from OpenAPI.

## Keycloak (`keycloak-auth`)

Started with `start-dev --import-realm` (development only). `KC_HOSTNAME=http://auth.localhost:8080` pins the issuer to the public URL, `KC_HOSTNAME_ADMIN=http://keycloak-admin.localhost:8080` serves the admin console on its own host, and `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` lets containers call `keycloak-auth:8080` and still receive tokens with the public issuer. The realm is the repository file `infra/keycloak/bananagig-realm.json`. Caddy exposes only `/realms/bananagig/*` and `/resources/*` on `auth.localhost`; the admin console host is dev-only. `web-app` receives `KEYCLOAK_URL`, `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_WEB_CLIENT_ID`, `WEB_PUBLIC_URL` and `VALKEY_URL` (still no database credentials). See `IDENTITY.md`.

## Ports published to the host (all bound to 127.0.0.1)

| Host | Container | Purpose |
|---|---|---|
| 8080 (`PROXY_HTTP_PORT`) | caddy-proxy:80 | All HTTP entry points |
| 5433 (`POSTGRES_HOST_PORT`) | postgres-db:5432 | Migrations and psql. 5433 avoids clashing with a host Postgres on 5432 |

## Volumes

`bananagig_postgres_data`, `bananagig_nats_data`, `bananagig_seaweedfs_data`, `bananagig_opensearch_data`, `bananagig_prometheus_data`, `bananagig_grafana_data`, `bananagig_loki_data`, `bananagig_tempo_data`, `bananagig_caddy_data`. Valkey is intentionally ephemeral: it holds only derived data.

## Conventions

**Valkey namespacing:** `bg:<env>:<domain>:<key>`, for example `bg:development:diag:ping:bananagig-api`.

**Valkey TTL:** every key gets an explicit TTL. Use `EX` on write; no persistent keys. The server runs `allkeys-lru` with `maxmemory 128mb`. Never store bookings, balances, Banana Credits, subscriptions, slot reservations or tax state here.

**NATS subjects:** `bananagig.<domain>.<event>.v<version>`, for example `bananagig.booking.confirmed.v1`. No product subjects exist yet.

**pg-boss jobs:** queue names `<domain>.<action>`, for example `booking.send-reminder`, in lowercase kebab-case. pg-boss owns the `pgboss` schema. No product jobs exist yet.

**OpenSearch:** a projection only. PostgreSQL is the source of truth, and indexes must be rebuildable from it. No indexes exist yet.

**Feature flags:** OpenFeature SDK with the flagd provider. Application code must supply a safe default (`flagBoolean(key, fallback)` never throws). The only flag is `dev-test-flag`.

**Telemetry:** traces go OTLP/HTTP to the Collector, then Tempo. Logs are structured JSON on stdout and mirrored as OTLP logs to the Collector, then Loki. Metrics are scraped by Prometheus from `/metrics`.

## Healthchecks

Every container has a Compose healthcheck except `otel-collector` and `flagd`, whose images are distroless (no shell). They are verified by connectivity in the smoke test (Collector health endpoint plus traces arriving in Tempo; flagd health endpoint plus a flag evaluation).

## Security posture

- Development credentials live in `.env.example` and are obviously fake (`*_dev_only`). `.env` is git-ignored. Production secrets are out of scope here.
- Explicit image tags everywhere. Digest pinning is a future hardening step.
- No privileged containers. SeaweedFS, Postgres and the Keycloak image run as the images define.
- Keycloak runs `start-dev` and OpenSearch has its security plugin disabled. Both are development-only and documented as such.
- The postgres container's entrypoint starts as root and drops to `postgres`; this is the upstream pattern (Trivy rule AVD-DS-0002 is suppressed in that Dockerfile with a reason).

### Trivy

```bash
# Repo: Dockerfiles, dependency lockfile, secrets
docker run --rm -v "$PWD":/src:ro -v trivy-cache:/root/.cache aquasec/trivy:0.65.0 \
  fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --skip-dirs node_modules --skip-dirs dist /src

# Built images (mounts the Docker socket read-only; local use only)
for i in api worker web; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro -v trivy-cache:/root/.cache \
    aquasec/trivy:0.65.0 image --severity HIGH,CRITICAL bananagig/$i:dev
done
```
