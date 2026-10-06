# Project Learnings

Durable engineering knowledge that a future session would otherwise rediscover painfully. Add an entry only when it is reusable and not obvious from the code.

**Do not add:** trivial command output, one-time typo fixes, temporary debugging noise, or anything the code already makes obvious.

**Rules:** entries are append-only; correct in place. When a learning becomes wrong, set `Status: SUPERSEDED` and add a new ACTIVE entry whose `Supersedes:` names it (`pnpm project-state:check` enforces this). Source code and config beat stale learnings. Prefer linking to a canonical skill or ADR over repeating a rule. IDs are sequential and permanent.

## LRN-0001 — flagd server and OpenFeature provider protocol must be paired

Date: 2026-10-05
Checkpoint: INF-001
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
The Node flagd provider (`@openfeature/flagd-provider` 0.16) evaluates over a newer gRPC protocol than flagd v0.12.9 serves.

### Learning
Evaluations against flagd v0.12.9 failed with `12 UNIMPLEMENTED: Received HTTP status code 404`. flagd v0.17.0 works with provider 0.16 when `resolverType: 'rpc'` is set explicitly.

### Why it matters
The flag service is a safe-default dependency, so this failure looks like "flag unavailable" and can hide behind default values forever.

### Reuse rule
When bumping either the flagd image or the provider SDK, bump the pair together and keep the smoke check that evaluates `dev-test-flag` through the SDK (not just flagd's health endpoint).

### Evidence
`packages/platform/src/checks.ts` (`ensureFlagProvider`), `compose.yaml` flagd image tag, smoke check "flagd / OpenFeature".

## LRN-0002 — The official postgis/postgis image has no linux/arm64 build

Date: 2026-10-05
Checkpoint: INF-001
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0001
Related skill: skills/database/SKILL.md

### Context
Developing on Apple Silicon, `postgis/postgis:*` fails with `no matching manifest for linux/arm64/v8`.

### Learning
PostGIS is installed on top of the official multi-arch `postgres` image from the PGDG apt repo (`postgresql-17-postgis-3`) in `infra/postgres/Dockerfile`.

### Why it matters
Switching to an upstream PostGIS tag would silently break arm64 developers; running amd64 emulation is slow and flaky.

### Reuse rule
Keep the custom Postgres image. When bumping Postgres major, bump the `postgresql-NN-postgis-3` package name with it and rebuild.

### Evidence
`infra/postgres/Dockerfile`, `compose.yaml` postgres service.

## LRN-0003 — SeaweedFS master healthy does not mean the S3 gateway is usable

Date: 2026-10-05
Checkpoint: INF-001
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
A clean start intermittently failed because the bucket-creation init container ran when the master answered but the filer was not up.

### Learning
The healthcheck must require both master (9333) and filer (8888); `weed shell` needs `-filer=seaweedfs-storage:8888`; the init container retries until the bucket is listed.

### Why it matters
The failure only appears on a cold start (empty volumes), exactly the case a new developer or CI hits first.

### Reuse rule
Test infrastructure changes with `pnpm stack:reset` followed by a full start, not only by restarting a warm stack.

### Evidence
`compose.yaml` `seaweedfs-storage` and `seaweedfs-storage-init` services (named `seaweedfs` and `seaweedfs-init` when the lesson was learned); reproduced and fixed during the INF-001 full-reset test.

## LRN-0004 — `docker compose up --wait` fails on one-shot init containers

Date: 2026-10-05
Checkpoint: INF-002
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
`--wait` treats a service that exits (even with code 0), such as `seaweedfs-storage-init`, as a failure.

### Learning
Start with `up -d` and poll container health yourself (`scripts/dev.mjs`); CI uses `up -d` and lets the smoke test retry.

### Why it matters
Using `--wait` in scripts or CI produces confusing failures that look like unhealthy dependencies.

### Reuse rule
Never combine `--wait` with services that are meant to exit. Poll `docker inspect -f '{{.State.Health.Status}}'` for long-running ones.

### Evidence
`scripts/dev.mjs`, `.github/workflows/ci.yml`.

## LRN-0005 — Editing a single-file bind-mounted config in place can strand the container on the old inode

Date: 2026-10-05
Checkpoint: INF-002
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
After editing `infra/caddy/Caddyfile` with BSD `sed -i`, the running Caddy container kept serving the old file and its healthcheck returned 404 until the container was recreated.

### Learning
BSD `sed -i` replaces the file (new inode), and a single-file bind mount keeps pointing at the old one. Editors that write in place do not have this problem.

### Why it matters
Config changes appear to "not apply" or half-apply, wasting debugging time.

### Reuse rule
After changing a bind-mounted single file, recreate the service (`docker compose up -d --force-recreate <svc>`) instead of assuming a reload.

### Evidence
Observed with the Caddy healthcheck (`unhealthy`, `HTTP 404` on `/caddy-health`) until `--force-recreate`.

## LRN-0006 — Fastify hooks and error handlers are encapsulated unless the plugin is wrapped with fastify-plugin

Date: 2026-10-05
Checkpoint: INF-002
Domain: api
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0006
Related skill: skills/api/SKILL.md

### Context
Hooks, decorators and `setErrorHandler` registered inside a plain `app.register(plugin)` only apply within that plugin's scope.

### Learning
Cross-cutting plugins (correlation, error model) must be wrapped with `fastify-plugin` (`fp`) so they apply to sibling routes. Without it correlation headers were missing and errors used Fastify's default shape.

### Why it matters
The unit tests that checked headers failed in a confusing way (hooks silently not running).

### Reuse rule
Wrap every cross-cutting plugin in `fp`; keep route modules as plain encapsulated plugins.

### Evidence
`apps/api/src/plugins/correlation.ts`, `apps/api/src/plugins/errors.ts`, `apps/api/src/api.test.ts`.

## LRN-0007 — An unreachable OTLP collector must not block process shutdown

Date: 2026-10-05
Checkpoint: INF-002
Domain: observability
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/worker/SKILL.md

### Context
`NodeSDK.shutdown()` waits on exporters; with no collector (host dev mode) the API took longer than tsx's 5-second force-kill window to exit.

### Learning
`shutdownObservability()` races the SDK shutdown against a 3-second timeout.

### Why it matters
Slow or hung shutdown breaks hot reload and masks real graceful-shutdown problems.

### Reuse rule
Any new shutdown step that talks to the network must be bounded. Also close lazy clients safely (`closeValkey`: `quit()` on a never-connected lazy client hangs).

### Evidence
`packages/observability/src/index.ts` (`shutdownObservability`), `packages/platform/src/clients.ts` (`closeValkey`).

## LRN-0008 — Image scans cannot see dependencies inside esbuild bundles

Date: 2026-10-05
Checkpoint: INF-002
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0007
Related skill: skills/infrastructure/SKILL.md

### Context
api, worker and smoke ship one bundled `index.js`, so Trivy's image scan sees only the OS and Node. Conversely the stock `node:alpine` image carries npm with its own vulnerable dependencies that the apps never use.

### Learning
Scan three things: images (OS/Node), the lockfile (`pnpm audit --prod`, `trivy fs`), and Dockerfiles. Runtime images delete npm, corepack and yarn.

### Why it matters
Relying on only one scan either misses bundled packages or reports noise from unused tooling.

### Reuse rule
Keep the runtime-base `rm -rf` of npm/corepack/yarn, and run the lockfile audit whenever dependencies change. Prefer removal over ignore entries.

### Evidence
`Dockerfile` (`runtime-base`), `docs/security/SCAN_RESULTS.md`.

## LRN-0009 — Developer machines already use common ports (5432, 6379, 3000, 3101)

Date: 2026-10-05
Checkpoint: INF-001
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
A host Postgres owns 5432 and unrelated dev servers answered on 3000 and 3101, producing misleading responses (a 500 from another project's server) when probing the apps.

### Learning
BananaGig publishes Postgres on 5433, uses 3210-3212 for host dev apps and offset ports (16379, 14222, 18333, ...) for dependencies. Always probe with `lsof -iTCP:<port> -sTCP:LISTEN` before trusting a response.

### Why it matters
A port collision looks exactly like an application bug.

### Reuse rule
New services get a port from the documented offset scheme in `compose.dev.yaml` / `.env.host.example`; check for collisions before choosing one.

### Evidence
`compose.dev.yaml`, `.env.host.example`.

## LRN-0010 — pnpm 12 blocks dependency build scripts until each is allowed or denied

Date: 2026-10-05
Checkpoint: INF-001
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` for packages that ship install scripts.

### Learning
Declare every one under `allowBuilds` in `pnpm-workspace.yaml` (`true` for esbuild and protobufjs, `false` for the AsyncAPI CLI's analytics/postinstall packages).

### Why it matters
A new dependency can break fresh installs and CI even though it works on a warm machine.

### Reuse rule
When adding a dependency, run a clean `pnpm install --frozen-lockfile` and decide each reported build script explicitly; never blanket-allow.

### Evidence
`pnpm-workspace.yaml`.

## LRN-0011 — PostGIS silently coerces out-of-range coordinates

Date: 2026-10-05
Checkpoint: INF-003
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/database/SKILL.md

### Context
Building a point from latitude 91 with `ST_MakePoint(10, 91)::geography` does not fail; PostGIS emits a notice and stores a coerced, valid value.

### Learning
A CHECK constraint on the stored coordinates cannot detect bad input because the stored value is already in range. Validate latitude (-90..90) and longitude (-180..180) before building the point, at the API boundary, and build points longitude-first.

### Why it matters
Wrong coordinates would be stored as plausible-looking locations, corrupting distance search with no error anywhere.

### Reuse rule
Every code path that creates a point validates input first (zod at the boundary); do not rely on the database to reject it.

### Evidence
`packages/testing/src/postgis.itest.ts` (the coercion test), `docs/data/DATABASE_CONVENTIONS.md` section 9.


## LRN-0012 — JetStream de-duplication needs a stream and a message id; core NATS publish has neither

Date: 2026-10-05
Checkpoint: INF-003
Domain: worker
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0012
Related skill: skills/worker/SKILL.md

### Context
Core NATS `publish` is fire-and-forget: no acknowledgement and no duplicate detection. An outbox relay that retries after a crash would deliver duplicates silently.

### Learning
Publish through JetStream (`jetstream().publish`) with `msgID` set to the outbox event id, into a stream whose subjects capture the event subjects (`bananagig.>`). The stream's duplicate window drops repeats and the publish ack reports `duplicate: true`. Core subscribers still receive messages on captured subjects.

### Why it matters
Without an acknowledged publish a row would be marked published even when NATS never stored it, which loses events.

### Reuse rule
Only mark an outbox row published after a JetStream ack. Keep consumers idempotent by `eventId` because the duplicate window is finite.

### Evidence
`apps/worker/src/runtime/events.ts`, `packages/platform/src/clients.ts` (`ensureEventStream`), `apps/worker/src/outbox.itest.ts` (duplicate test).

## LRN-0013 — Pin the Keycloak issuer to the public URL; realm files are imported only once

Date: 2026-10-05
Checkpoint: INF-004
Domain: identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0013
Related skill: skills/identity/SKILL.md

### Context
Containers reach Keycloak at `keycloak-auth:8080`, browsers at `auth.localhost:8080`. Without pinning, Keycloak derives `iss` from the request host, so a token fetched in-network never matches the issuer the browser saw. Separately, `--import-realm` silently skips a realm that already exists, so edited realm files appear not to apply.

### Learning
Start Keycloak with `KC_HOSTNAME=<public url>` and `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: `iss` is always the public URL, while token and JWKS endpoints follow the caller's host. Validate the exact public issuer and fetch keys from the internal JWKS URL. To apply realm edits locally use `pnpm identity:sync` (delete and re-import) or `pnpm stack:reset`.

### Why it matters
An issuer mismatch makes every token fail validation, and un-applied realm edits make security settings look configured when they are not.

### Reuse rule
Never derive the expected issuer from the request or from discovery at runtime; configure it. After any realm file change, re-import and run the live integration tests.

### Evidence
`compose.yaml` keycloak-auth environment, `packages/config/src/index.ts` (`identity.issuer`), `packages/identity/src/keycloak.itest.ts` (discovery issuer test), `scripts/identity-sync.mjs`.


## LRN-0014 — Every Keycloak realm ships a built-in admin-cli client with the password grant enabled

Date: 2026-10-05
Checkpoint: INF-004
Domain: identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0014
Related skill: skills/identity/SKILL.md

### Context
A freshly imported product realm contains Keycloak's built-in clients. `admin-cli` is a public client with direct access (password) grants enabled, so it silently violates a "no password grant" policy even when every BananaGig client is correct.

### Learning
Declare `admin-cli` in the realm file with `enabled: false` and no direct grants (realm administration uses the master realm's own admin-cli). Test the live realm for ANY enabled password grant, not just BananaGig clients, and require it to be flagged dev-only.

### Why it matters
A policy test limited to our own clients would pass while an extra password-grant client stayed reachable.

### Reuse rule
When asserting protocol restrictions, enumerate all clients in the live realm (`GET /admin/realms/<realm>/clients`), including Keycloak's built-ins.

### Evidence
`infra/keycloak/bananagig-realm.json` (admin-cli entry), `packages/identity/src/keycloak.itest.ts` ("bananagig-api issues nothing; password grant exists only on the dev-only client").

