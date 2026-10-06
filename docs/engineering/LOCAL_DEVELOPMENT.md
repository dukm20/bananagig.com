# Local Development

Prerequisites: Docker with Compose v2, Node 24, pnpm 12.9.1 (`corepack enable` or `npm i -g pnpm@12.9.1`). Run all commands from the repo root.

## Two ways to run

| Mode | Command | Use for |
|---|---|---|
| **Host apps + container dependencies (default for coding)** | `pnpm dev` | Fast edit loop. web/api/worker run on your machine with hot reload (`next dev`, `tsx watch`); Postgres, Valkey, NATS, SeaweedFS, flagd, Mailpit run in Docker. No image rebuilds. |
| **Everything in containers** | `pnpm stack:all` | Production-like check, smoke test, Caddy routing. |

We chose host apps plus container dependencies over bind-mounted dev containers: it is simpler, faster, and avoids file-watcher and permission problems on macOS.

`pnpm dev` ports: web http://localhost:3210, api http://localhost:3211, worker health http://localhost:3212. Dependency ports are published on 127.0.0.1 by `compose.dev.yaml` with offsets (Postgres 5433, Valkey 16379, NATS 14222, S3 18333, flagd 18013, SMTP 11025). Settings live in `.env.host` (created from `.env.host.example`).

```bash
pnpm install
pnpm dev                # starts dependency containers, migrates, then web+api+worker with hot reload
pnpm dev:deps           # only the dependency containers (needed by test:integration)
pnpm test:integration   # real Postgres + NATS; every test file gets its own freshly migrated database
```

## Install

```bash
cp .env.example .env          # development-only defaults; never commit .env
pnpm install
```

## Start

```bash
pnpm stack:up                 # core profile: postgres, valkey, nats, seaweedfs, keycloak, flagd, api, worker, web, caddy
pnpm stack:all                # core + observability + search + devtools (needed for the smoke test)
```

Equivalent raw commands: `docker compose up -d --build`, or add `--profile observability --profile search --profile devtools`. First start builds images and pulls roughly 3 GB. Keycloak takes about 30-60 seconds to become healthy.

## URLs

| URL | Service |
|---|---|
| http://app.localhost:8080 | web (`/`, `/system`, `/health`; `/api/v1/*` is proxied to the API) |
| http://api.localhost:8080/healthz | api (`/readyz`, `/metrics` too; `/internal/*` is blocked at the proxy) |
| http://auth.localhost:8080 | Keycloak (admin / `KEYCLOAK_ADMIN_PASSWORD`, realm `bananagig-dev`) |
| http://grafana.localhost:8080 | Grafana (`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`) |
| http://mail.localhost:8080 | Mailpit inbox |
| http://prometheus.localhost:8080 | Prometheus |
| 127.0.0.1:5433 | Postgres (`psql postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig`) |

`*.localhost` resolves to loopback in modern browsers and curl. If yours does not, send a `Host:` header.

## Stop / restart / logs

```bash
pnpm stack:down                                   # stop and remove containers, keep volumes
docker compose restart api worker                 # restart specific services
pnpm stack:logs                                   # follow all logs
docker compose logs -f --tail=100 api             # one service
pnpm stack:ps                                     # status and health
```

## Health check

```bash
pnpm stack:ps                                     # every service with a healthcheck shows (healthy)
curl -s http://api.localhost:8080/readyz
curl -s http://app.localhost:8080/healthz
```

## DB migration

Run `pnpm migrate` right after the stack first starts. Until the migrations exist the worker's outbox relay logs query errors (the `integration` schema is missing). Policy and conventions: `docs/data/MIGRATION_POLICY.md`, `docs/data/DATABASE_CONVENTIONS.md`.

```bash
set -a; . ./.env; set +a      # exports DATABASE_URL_HOST for the host-side runner
pnpm migrate                  # applies db/migrations/*.sql in order; refuses if an applied file was edited
```

## Test, lint, typecheck, contracts

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit tests (no infrastructure needed)
pnpm test:integration     # needs `pnpm dev:deps`
pnpm build
pnpm deps:check           # workspace boundaries + cycles   (pnpm deps:graph prints Mermaid)
pnpm specs:generate       # regenerate docs/api/openapi.yaml and docs/events/asyncapi.yaml
pnpm specs:check          # fail if committed specs drifted from the code
pnpm openapi:lint && pnpm asyncapi:validate
```

## Smoke test

Runs inside the Compose network and verifies real connectivity: Postgres and PostGIS queries, Valkey set/get, NATS and JetStream, an S3 put/get/delete, OpenSearch health, a flag evaluation through OpenFeature, a test email received by Mailpit, a pg-boss job and NATS event round-trip in the worker, the API contract with a correlation id that is then found in Loki, the web `/system` page rendering API data, a trace from api and from the worker found in Tempo, app logs found in Loki, Prometheus targets up, Grafana datasources provisioned, Keycloak realm, and web/api/worker `/healthz` + `/readyz`.

```bash
pnpm stack:all && pnpm migrate     # if not already running
pnpm smoke                         # exit code 0 = all checks passed
```

## Backup / restore check (development only)

```bash
pnpm db:backup-test    # scratch DB from migrations -> pg_dump -> pg_restore into a clean DB -> verify data, PostGIS, snapshot equality, checksum-clean rerun, and that a new migration still applies
```

This is a development validation, not production disaster recovery (DEBT-0015). Manual commands: `docker exec bananagig-postgres pg_dump -U bananagig -Fc -d bananagig -f /tmp/x.dump` and `pg_restore -U bananagig -d <empty db> --no-owner /tmp/x.dump`.

## Full reset / clean volumes

```bash
pnpm stack:reset                   # removes containers AND all bananagig_* volumes (destroys local data)
pnpm stack:all
set -a; . ./.env; set +a; pnpm migrate
pnpm smoke
```

Volumes from other checkouts (for example older `bananagig_pgdata`) have different names and are not touched.

## Container and image security scan

See the Trivy commands in `CONTAINER_ARCHITECTURE.md`.

## Troubleshooting

- Port 5433 or 8080 busy: set `POSTGRES_HOST_PORT` or `PROXY_HTTP_PORT` in `.env`.
- Postgres init scripts (Keycloak database, PostGIS) run only on a fresh volume; use `pnpm stack:reset` after changing them.
- OpenSearch needs about 1 GB of Docker memory. Drop it by omitting the `search` profile; the smoke test will then fail its OpenSearch check by design.

## Port conflicts seen on developer machines

A host Postgres on 5432 and unrelated servers on 3000/3101 exist on the author's machine, so this repo uses 5433 and 32xx for dev apps. Check with `lsof -iTCP:<port> -sTCP:LISTEN` before assuming a service is yours.

## Checkpoint workflow (governance)

Every checkpoint follows `docs/engineering/COMMIT_POLICY.md`:

```bash
pnpm checkpoint:start <ID>
# ... implement; update docs/project/*, skills/*, ADRs and docs/data/* as the checkpoint requires ...
pnpm checkpoint:finalize <ID> --skill-update=UPDATED|NOT_REQUIRED
pnpm checkpoint:commit <ID> "<type>(<ID>): <description>"      # only when commits are enabled; never pushes
```

Individual gates: `pnpm format:check`, `pnpm skills:check`, `pnpm project-state:check [<ID>]`, `pnpm data-model:check [<ID>]`, `pnpm schema:snapshot [--write|--check]`.
