# Local Development

Prerequisites: Docker with Compose v2, Node 24, pnpm 12.9.1 (`corepack enable` or `npm i -g pnpm@12.9.1`). Run all commands from the repo root.

## Two ways to run

| Mode | Command | Use for |
|---|---|---|
| **Host apps + container dependencies (default for coding)** | `pnpm dev` | Fast edit loop. web/api/worker run on your machine with hot reload (`next dev`, `tsx watch`); Postgres, Valkey, NATS, SeaweedFS, flagd, Mailpit run in Docker. No image rebuilds. |
| **Everything in containers** | `pnpm stack:all` | Production-like check, smoke test, Caddy routing. |

We chose host apps plus container dependencies over bind-mounted dev containers: it is simpler, faster, and avoids file-watcher and permission problems on macOS.

Email verification (ID-002) sends real SMTP to Mailpit (`SMTP_HOST`, `SMTP_PORT`; on the host stack `127.0.0.1:11025`, inbox at http://mail.localhost:8080 or the host API on `127.0.0.1:18025`) and hashes codes with `VERIFICATION_HASH_SECRET` (a development placeholder is in `.env.example`; production sets its own). The integration tests read the delivered message through `packages/testing/src/mailpit.ts` (`MAILPIT_API_URL`, default `http://127.0.0.1:18025`).

Phone verification (ID-003) sends no real SMS locally. `SMS_TRANSPORT=fake` (the development default, set in `.env.example`) appends each text to a Valkey list (`bananagig:fake-sms:<sha256 of the E.164>`, 15-minute TTL) that tests and the smoke test read with `FakeSmsInbox` (`@bananagig/testing`, `packages/testing/src/sms.ts`; Valkey on `127.0.0.1:16379` on the host stack). `PHONE_INTELLIGENCE=fake` classifies a number by its last three digits, so a test chooses the line type by choosing the number: 901 VOIP, 902 VIRTUAL, 903 LANDLINE, 904 HIGH_RISK, 905 the lookup fails, anything else MOBILE (the default policy blocks VIRTUAL and HIGH_RISK). `TRUSTED_PROXY_HOPS=1` matches the local topology (Caddy, or the web server, in front of the API; Caddy replaces `X-Forwarded-For`). Production refuses `SMS_TRANSPORT=fake` and `PHONE_INTELLIGENCE=fake` and requires `TRUSTED_PROXY_HOPS` to be set for the API; see `docs/engineering/PHONE_VERIFICATION.md` and `docs/engineering/RATE_LIMITING.md`.

Sessions, the second factor and the password reset (ID-004, `docs/engineering/SESSIONS_AND_MFA.md`) need the Keycloak service account `bananagig-security`: `KEYCLOAK_SECURITY_CLIENT_ID` (default `bananagig-security`) and `KEYCLOAK_SECURITY_CLIENT_SECRET` (the development placeholder `bananagig_security_dev_only_secret_0001` is in `.env.example` and in the realm file and must match it; at least 32 characters; production sets its own and refuses the placeholder). The API container gets both from `compose.yaml`. Keycloak's own mail (the password-reset link) goes to Mailpit: the development realm declares `smtpServer` `mailpit-email:1025`, so the message appears in the inbox at http://mail.localhost:8080 (on the host stack the inbox API is `127.0.0.1:18025`). A security-layer call that cannot reach Keycloak (wrong secret, the client missing because the realm was not re-imported) degrades quietly: the security page shows the second-factor state as unknown, revocations report `keycloak: UNAVAILABLE` and no reset email is sent.

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
| http://app.localhost:8080 | web-app (`/`, `/system`, `/health`; `/api/v1/*` is proxied to the API) |
| http://api.localhost:8080/healthz | api-service (`/readyz`, `/metrics` too; `/internal/*` is blocked at the proxy) |
| http://auth.localhost:8080/realms/bananagig | keycloak-auth public identity host (realm endpoints only; the admin console is NOT served here) |
| http://keycloak-admin.localhost:8080/admin/master/console/ | Keycloak admin console, **DEV ONLY** (login `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`) |
| http://app.localhost:8080/session | Sign in / out and session status (infrastructure page) |
| http://grafana.localhost:8080 | Grafana (`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`) |
| http://mail.localhost:8080 | Mailpit inbox |
| http://prometheus.localhost:8080 | Prometheus |
| 127.0.0.1:5433 | Postgres (`psql postgres://bananagig:bananagig_dev_only@127.0.0.1:5433/bananagig`) |

`*.localhost` resolves to loopback in modern browsers and curl. If yours does not, send a `Host:` header.

## Identity (Keycloak)

Realm `bananagig` is imported from `infra/keycloak/bananagig-realm.json` on first start. Full guide: `docs/engineering/IDENTITY.md`.

- Dev-only users: `customer.dev`, `provider.dev`, `admin.dev` with passwords `dev_only_customer_password`, `dev_only_provider_password`, `dev_only_admin_password` (they do not exist in production realm builds).
- Browser login needs the container stack: `pnpm stack:all`, then open `http://app.localhost:8080/session` and use Sign in. `pnpm dev` (host apps) supports bearer-token calls to the API only (DEBT-0020).
- Edited the realm file? `pnpm identity:check`, then `pnpm identity:sync` (DEV ONLY re-import into the running dev Keycloak) or `pnpm stack:reset`. A running dev stack picks up realm changes (including the ID-004 flow, service account and closed account console) ONLY this way, and `identity:sync` recreates the realm: the dev users get NEW subjects, so their next login creates new, empty BananaGig accounts (the old accounts stay, unlinked) and every session and enrolled second factor is gone.
- Two-step verification and recovery codes can be tried in the stack at http://app.localhost:8080/security after signing in; `provider.dev` is password-only in the realm file and the smoke scenario `Sessions and security` enrols and always removes a second factor for it.
- The built-in "Forgot password" link does not exist on the Keycloak login page (`resetPasswordAllowed=false`); use http://app.localhost:8080/forgot-password (the page `/session` links to it) and read the mail in Mailpit.
- Consents (ID-005): a fresh database has NO published legal document. The two LEGAL entries `legal.terms_of_service` and `legal.privacy_policy` exist as shells, so http://app.localhost:8080/consents shows every required agreement as unavailable and nothing can be accepted until a version is published. To try it, publish one through the content workflow (`docs/engineering/CONTENT.md`, the `/api/v1/content` management routes): create a version of the entry in `en-US` (admin context token of `admin.dev`, who holds `content-write` and `content-legal`), submit it, approve it with a DIFFERENT administrator (`admin2.dev`, who holds `content-approve` and `content-legal`: legal entries need a second approver and the author cannot approve), then publish it; the integration tests do the same through `ContentService`. Use throw-away test wording in a development database only; real legal text is published by Legal. `pnpm stack:reset` returns to the empty state. Consent rows themselves are append-only, so accepting in development cannot be undone except by resetting the database.
- Production realm build: `pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json`.
- Get a token for manual API calls (dev only): `curl -s -d grant_type=password -d client_id=bananagig-dev-test -d username=customer.dev -d password=dev_only_customer_password http://127.0.0.1:18081/realms/bananagig/protocol/openid-connect/token` (port 18081 is published by `compose.dev.yaml`), then call `GET /api/v1/system/whoami` with `Authorization: Bearer <access_token>`.

## Stop / restart / logs

```bash
pnpm stack:down                                   # stop and remove containers, keep volumes
docker compose restart api-service worker-service   # restart specific services (use the Compose service keys)
pnpm stack:logs                                   # follow all logs
docker compose logs -f --tail=100 api-service     # one service
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

Runs inside the Compose network (services addressed by their service keys, e.g. `postgres-db`) and verifies real connectivity. Output rows use friendly names: Postgres DB, PostGIS, Valkey Cache, Keycloak Auth, NATS Events, JetStream, SeaweedFS Storage, OpenSearch Search, Feature Flags, OTel Collector, Prometheus Metrics, Grafana Dashboard, Loki Logs, Tempo Traces, Mailpit Email, Web App, API Service, Worker Service. It checks: Postgres and PostGIS queries, Valkey set/get, NATS and JetStream, an S3 put/get/delete, OpenSearch health, a flag evaluation through OpenFeature, a test email received by Mailpit, a pg-boss job and NATS event round-trip in the worker, the API contract with a correlation id that is then found in Loki, the web `/system` page rendering API data, a trace from api and from the worker found in Tempo, Keycloak discovery/JWKS/client policy, real PKCE logins for web and admin contexts, API acceptance of valid tokens and rejection of missing/invalid/tampered ones, a full web session (login, opaque HttpOnly cookie, API call with the session token, CSRF-safe logout), Caddy auth-route restrictions, app logs found in Loki, Prometheus targets up, Grafana datasources provisioned, Keycloak realm, and `/healthz` + `/readyz` of Web App, API Service and Worker Service.

```bash
pnpm stack:all && pnpm migrate     # if not already running
pnpm smoke                         # exit code 0 = all checks passed
```

## Backup / restore check (development only)

```bash
pnpm db:backup-test    # scratch DB from migrations -> pg_dump -> pg_restore into a clean DB -> verify data, PostGIS, snapshot equality, checksum-clean rerun, and that a new migration still applies
```

This is a development validation, not production disaster recovery (DEBT-0015). Manual commands: `docker exec bananagig-postgres-db pg_dump -U bananagig -Fc -d bananagig -f /tmp/x.dump` and `pg_restore -U bananagig -d <empty db> --no-owner /tmp/x.dump`.

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
