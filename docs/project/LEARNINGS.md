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


## LRN-0015 — Immutable history and a no-overlap constraint need one explicit, trigger-allowed closure

Date: 2026-10-05
Checkpoint: CFG-001
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0016
Related skill: skills/configuration/SKILL.md

### Context
Effective-dated values must be immutable, yet a database exclusion constraint on `tstzrange(effective_from, effective_to)` only works when the predecessor's end is stored. Deriving the end from the successor leaves overlap prevention to application code.

### Learning
Store `effective_to`, allow exactly one mutation (NULL to a value, every other column unchanged) in a `BEFORE UPDATE` guard trigger, and let the gist exclusion constraint (`btree_gist` for the uuid equality part) be the final arbiter of concurrent publishes. Test both the permitted closure and every forbidden update.

### Why it matters
Application-level overlap checks race under concurrency; a blanket "no updates" trigger would make the constraint unusable.

### Reuse rule
Any effective-dated history table: explicit end column, half-open range, exclusion constraint, one-time closure trigger, concurrency test.

### Evidence
`db/migrations/0004_configuration_registry.sql` (`ex_value_versions__no_overlap`, `guard_value_versions`), `packages/configuration/src/configuration.itest.ts`.

## LRN-0016 — Fastify's default Ajv strips unknown body fields silently

Date: 2026-10-05
Checkpoint: CFG-001
Domain: api
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
Fastify's default Ajv options set `removeAdditional: true`, so with the zod-derived schemas (`additionalProperties: false`) an unknown body property is removed silently instead of rejected. Found while designing the configuration write endpoints.

### Learning
Set `ajv: { customOptions: { removeAdditional: false } }` so `additionalProperties: false` rejects unknown fields with a 400 instead of ignoring them.

### Why it matters
Silent field dropping on a configuration write can publish a different change than the caller intended.

### Reuse rule
Keep `removeAdditional: false` on the app; when adding write endpoints, include an unknown-field case in the validation test (the CFG-001 test covers bad bodies generally, not an explicit unknown-field case).

### Evidence
`apps/api/src/app.ts` (comment at the Fastify constructor), `apps/api/src/configuration.test.ts` ("validates request bodies").

## LRN-0017 — Fastify `preHandler` guards run after validation; use `preValidation` so 401 beats 400

Date: 2026-10-05
Checkpoint: CFG-001
Domain: api
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
With the guard in `preHandler`, validation runs first, so an anonymous caller sending an invalid body would receive 400 (and learn about the schema) instead of 401.

### Learning
Authorization guards for routes with a body schema belong in `preValidation`. Read-only routes without bodies are indifferent.

### Why it matters
Unauthenticated callers must learn nothing about the contract beyond 401.

### Reuse rule
Assert 401 with an empty or invalid body in route tests (the CFG-001 test posts `{}` anonymously to every POST route).

### Evidence
`apps/api/src/modules/configuration/routes.ts`, `apps/api/src/configuration.test.ts` ("requires authentication on every route (401)").

## LRN-0018 — A dev-tool pin can surface in `pnpm audit --prod` through an optional peer, and `>=` overrides can jump a major

Date: 2026-10-05
Checkpoint: CI-001
Domain: infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
CI's `pnpm audit --prod` failed on `@babel/core` reached as `apps/web > next > styled-jsx > @babel/core`. The only copy in the lockfile was 7.12.9, pinned exactly by `@asyncapi/generator-react-sdk` (dev tooling); pnpm used it to satisfy next's optional peer. A first override with `>=7.29.6` resolved to `@babel/core` 8.0.6 and broke the `^7` peer ranges of the Babel plugins.

### Learning
A production-audit finding may come from a dev-only dependency that satisfies a prod package's optional peer, so check `pnpm why` before judging reachability. Scope the override to the pinning parent (`"parent>child"`) and cap the major (`^7.29.6`); verify with `pnpm peers check`.

### Why it matters
An unbounded `>=` override can silently adopt a new major that satisfies the audit and breaks peers. Separately, a gate that CI enforces cannot be treated as "accepted" in a debt entry: this advisory was recorded as accepted at INF-002 while `pnpm audit --prod` already exited 1 locally, and nobody saw it fail until CI ran.

### Reuse rule
Run each CI gate locally and check its exit code, not just its summary. Use scoped, major-capped overrides and record them in `docs/security/SCAN_RESULTS.md`.

### Evidence
`pnpm-workspace.yaml` (overrides), `docs/security/SCAN_RESULTS.md` (CI-001 section).

## LRN-0019 — A cache outage test with an instantly failing fake hides the real failure mode: slow, serial Valkey failures

Date: 2026-10-06
Checkpoint: CFG-002
Domain: configuration / content
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0020
Related skill: skills/content/SKILL.md

### Context
The first content cache passed its "Valkey outage degrades to database reads" tests, which used `MemoryConfigCache` with a `fail` flag that errors instantly. Against a real `iovalkey` client pointed at a closed port, with the production options (`maxRetriesPerRequest: 2`, `lazyConnect`), each failed command took 0.2 to 1.9 s and the costs grew across successive awaited commands: resolving 1 key took 3 s, 3 keys 28 s, 8 keys 88 s, although PostgreSQL was healthy. The same flaw existed in the CFG-001 adapter.

### Learning
Every cache command must be bounded (a per-command timeout) and protected by a circuit breaker, writes must not be awaited one after another, and outage tests must use clients that hang or fail slowly and a real client on a dead port, not only an instant-failure fake.

### Why it matters
"A cache failure never changes the result" is only true if it also never makes the request take a minute; a slow outage turns an optional dependency into a page-load outage.

### Reuse rule
Wrap any new cache or optional-dependency adapter with the same timeout and breaker (`ValkeyConfigCache` options `commandTimeoutMs`, `breakerCooldownMs`), and add one outage test with a hanging client and one with a real client on a closed port, asserting a latency bound.

### Evidence
`packages/configuration/src/cache.ts`, `packages/configuration/src/cache.test.ts`, `packages/content/src/cache.ts`, `packages/content/src/content.itest.ts` (outage tests).

## LRN-0020 — An authorization filter applied only to the success path leaves an existence oracle on the error path

Date: 2026-10-06
Checkpoint: CFG-002
Domain: api / content
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0020
Related skill: skills/content/SKILL.md

### Context
Anonymous callers must not learn that an INTERNAL content entry exists. The first version hid INTERNAL entries only when they resolved to content. An INTERNAL entry with no live version (unpublished, or only future-scheduled) fell into the "no content" bucket and returned `CONTENT_NO_CONTENT`, while a nonexistent key returned `CONTENT_ENTRY_NOT_FOUND`, so keys could be enumerated.

### Learning
Every outcome category for a protected resource (found, not found, no value yet, expired) must carry the resource's sensitivity so the same filter applies to all of them. For callers below the required privilege, protected-and-missing must be indistinguishable from nonexistent in code, message and details.

### Why it matters
Existence leaks expose unannounced keys and drafts even when the content itself never leaks.

### Reuse rule
When adding an access filter, write one test that compares the responses for a nonexistent key and a protected key in each state (unpublished, scheduled, live) and requires identical output.

### Evidence
`packages/content/src/service.ts` (`resolveMany` with `includeInternal`), `packages/content/src/resolver.ts` (`MissingEntry.sensitivity`), `packages/content/src/content.itest.ts`.

## LRN-0021 — Caller-controlled values in cache keys give an anonymous caller an unbounded key space

Date: 2026-10-06
Checkpoint: CFG-002
Domain: content / cache
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0020
Related skill: skills/content/SKILL.md

### Context
Resolution and last-known-good keys included the requested locale and the scope context. Both are free-form for anonymous callers (any well-formed locale tag, any scope reference), so 1000 requests produced 2000 new keys, 1000 of them with a 24-hour TTL, and the web app forwards the visitor's `Accept-Language`. With a 128 MB `allkeys-lru` Valkey this evicts hot entries and can evict the generation counters.

### Learning
Only cache requests whose key components normalize to values that exist: an ACTIVE requested locale and context references that matched a published version. Everything else is served from PostgreSQL every time and never written to the cache or to last-known-good.

### Why it matters
Cache pollution by an unauthenticated caller is a denial-of-service and a correctness risk (evicted generation counters).

### Reuse rule
For every component that goes into a cache key, state where its values come from and bound the set; add a test that sends 1000 distinct unknown values and asserts that the cache gained no keys.

### Evidence
`packages/content/src/resolver.ts` (`BatchResult.cacheable`), `packages/content/src/cache.ts`, `packages/content/src/service.test.ts`, `packages/content/src/content.itest.ts`.

## LRN-0022 — Concurrent integration runs collide through the shared global setup that drops idle test databases

Date: 2026-10-06
Checkpoint: CFG-002
Domain: testing
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
`vitest.integration.setup.ts` drops every stale `bananagig_t_*` database at the start of a run. When several people, agents or runs execute integration tests at the same time, one run's global setup drops the other's idle databases and the other run fails with "database does not exist" (36 tests failed in one review run).

### Learning
Concurrent integration runs must not share that cleanup. Use a copy of the integration config without the global setup (same include globs, `fileParallelism: false`) for the second and later runs; the normal `pnpm test:integration` stays the single authoritative run.

### Why it matters
The failure looks like a product bug and wastes time diagnosing.

### Reuse rule
Run `pnpm test:integration` alone, or point parallel runs at a private config without `globalSetup`; never run two default-config runs simultaneously.

### Evidence
`vitest.integration.config.ts`, `vitest.integration.setup.ts`, `packages/testing/src/index.ts` (`dropStaleTestDatabases`).

## LRN-0023 — The CI governance step runs the git-diff rules with no checkpoint id; run it locally exactly as CI does

Date: 2026-10-06
Checkpoint: CI-002
Domain: governance / ci
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
The first CFG-002 push failed CI in the governance step. `data-model:check` runs there with `--base=<previous remote head>` and no checkpoint id, and a schema-changing range requires an id, which CI never had. The rule had never run in CI before: the first CI run had an empty base (baseline mode skips every git-diff rule). It also never ran in my local verification, because I typed a base that did not exist (`14db38d9`), and a base that does not resolve silently selected baseline mode. Moreover `git rev-parse --verify <40 hex>` succeeds even when the object does not exist.

### Learning
`data-model:check` now infers the checkpoint id or ids from the `<type>(<ID>)` subjects of the commits in `base..HEAD` that added a migration and verifies each id's review entries; a commit that adds a migration without an id in its subject fails. An explicit `--base` that does not resolve to a commit is now an error once the repository has commits (use `<ref>^{commit}` to test existence). Inference only counts migrations present in the final base diff (a migration added and later removed in the range is ignored), compares merge commits against each parent, and matches review headings on the whole id or an id followed by whitespace so that `## CFG-001A` does not satisfy `CFG-001`.

### Why it matters
A governance check that is skipped looks identical to one that passed, and the first push that changes the schema is exactly when the skipped rule matters.

### Reuse rule
Before pushing a schema change, run `pnpm data-model:check --base=<full previous remote SHA>` with no id and `pnpm project-state:check --base=...`, and read the output for the "baseline" note, which means the diff rules did not run. Keep the checkpoint id in the subject of every commit that adds a migration.

### Evidence
`scripts/data-model-check.mjs` (`inferCheckpoints`), `scripts/lib/governance.mjs` (`explicitBaseProblem`), `scripts/governance.test.mjs` ("CI mode" tests and the explicit-base tests), `.github/workflows/ci.yml` (Governance checks step).

## LRN-0024 — A shared contract change must be typechecked on every consumer, and parallel work must be re-verified after merging

Date: 2026-10-07
Checkpoint: GEO-001
Domain: testing / contracts
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
Extending `LocaleDto` (new required fields) updated the API tests but not the web fixtures, so `apps/web` stopped typechecking and five tests failed; this would have failed `next build` and the Docker web image. Separately, two fix agents working in parallel tightened validation (a real ISO region check) and rewrote tests independently, and their combined result broke ten integration tests that each had passed alone.

### Learning
Contract and DTO changes are checked by the workspace-wide `pnpm typecheck` and the complete test suites, never only by the packages that were edited; work done in parallel is only verified after it has been merged and the whole suite has run.

### Why it matters
Package-scoped green runs hide consumers (web fixtures) and interactions between independent changes.

### Reuse rule
After changing anything exported from `packages/contracts`, run `pnpm typecheck` and `pnpm test` for the whole workspace before reporting; after merging parallel changes, run `pnpm test:integration` alone once. Build test fixtures through one helper so they cannot drift from the contract.

### Evidence
`apps/web/src/web.test.tsx` (the `locale()` fixture helper), `packages/contracts/src/content.ts` (`LocaleDto`).

## LRN-0025 — `SELECT ... FOR UPDATE` over a join or an aggregate is stale after a lock wait in READ COMMITTED

Date: 2026-10-07
Checkpoint: GEO-001
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/database/SKILL.md

### Context
`loadCountry` and `loadMarket` read a row together with joined data and `ARRAY(subselect)` columns in one statement ending in `FOR UPDATE`. When another transaction held the row, PostgreSQL re-evaluated only the locked row after the wait: joined and array columns came from the old snapshot. Symptoms reproduced by review: a spurious `MARKET_NOT_FOUND` for an existing market, a wrong audit diff, and identical concurrent updates returning 409.

### Learning
Lock first with a bare single-table `SELECT 1 FROM t WHERE ... FOR UPDATE|SHARE`, and only then run the full read as a second statement, which gets a fresh snapshot.

### Why it matters
The bug only appears under contention, so ordinary tests and single-connection runs pass.

### Reuse rule
Never combine `FOR UPDATE` with joins, aggregates or subselects whose values the transaction then relies on; keep one documented lock order per aggregate and test overlaps with two connections.

### Evidence
`packages/geography/src/service.ts` (load-then-lock), `packages/geography/src/geography.itest.ts` (concurrent update tests).

## LRN-0026 — A trigger that enforces an invariant over a set must lock the parent row, not only read the siblings

Date: 2026-10-07
Checkpoint: GEO-001
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/database/SKILL.md

### Context
"An ACTIVE country has at least one ACTIVE time zone" was enforced by guards that read the sibling zones without locks. Review proved two violations with two connections: two concurrent deactivations of two different zones each saw the other zone ACTIVE and both committed; and a country activation raced a delete of its only zone link.

### Learning
A guard that protects an invariant spanning several rows must serialize the writers by locking the parent row (`FOR UPDATE`, in a fixed order) or the rows it relies on (`FOR SHARE`) before it reads the siblings. Prove each guard with a deterministic two-connection test (wait for the second session to block in `pg_stat_activity`, release the first) and mutate the lock away to see the test fail.

### Why it matters
Each session's guard is correct against the data it sees, so the invariant breaks only through the interleaving.

### Reuse rule
For every invariant over a set write a barrier race test before trusting the trigger; document the lock order next to the trigger.

### Evidence
`db/migrations/0007_geography_registry.sql` (`guard_time_zones`, `guard_country_links`, `guard_countries`), `packages/testing/src/geography-seed.itest.ts` (race tests).

## LRN-0027 — A seed migration's tests must scope to their own rows

Date: 2026-10-07
Checkpoint: GEO-001
Domain: testing
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
Migration 0007 added one more content entry (the US display name), and the CFG-002 seed test that asserted "exactly the eight entries and 40 audit rows" failed, though migration 0006 was untouched.

### Learning
Tests of a seed migration assert about the rows that migration created (by key or correlation id), not about table totals, because later migrations legitimately add rows to the same tables.

### Why it matters
Total-based assertions turn every later seed into a failure of an unrelated, older test.

### Reuse rule
Filter seed assertions by `key = ANY(<the migration's keys>)` or by the migration's correlation id.

### Evidence
`packages/testing/src/content-seed.itest.ts`, `packages/testing/src/geography-seed.itest.ts`.

## LRN-0028 — Do not assert wall-clock time in unit tests; assert counts, and read CI failures from the public check-run annotations

Date: 2026-10-07
Checkpoint: CI-003
Domain: testing / ci
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
A unit test required validating a large template in under 3 seconds. It took 0.3 s locally and passed in an emulated clean Linux container (same Node and ICU, a 2-CPU limit, `CI=true`, a POSIX locale), yet failed on the GitHub runner at 3.6 s and turned the whole run red, skipping the build, the integration tests and `compose-smoke`. The CI log itself needs authentication, but the check-run annotations of the failed job are public (`GET /repos/<owner>/<repo>/check-runs/<id>/annotations`) and named the exact assertion.

### Learning
A latency threshold on shared hardware is flaky by construction. Assert the work done (a render count, a query count) instead, which is exact and fails for the same regressions. When a time bound is the only guard against catastrophic backtracking, make the ceiling an order of magnitude above the normal time: the regressions it guards against take minutes. When CI fails and the log is unavailable, read the annotations first.

### Why it matters
A flaky guard costs a full CI cycle each time, and local or containerized runs cannot prove its absence.

### Reuse rule
No `toBeLessThan(<small ms>)` on real time unless it compares against a deliberately tiny deadline the test controls; prefer counts or an injected clock.

### Evidence
`packages/content/src/template.test.ts` (render-count test), `packages/content/src/markup.test.ts` (generous ceiling), DEBT-0035.

## LRN-0029 — The PRD is a .docx in the design kit; read its numbered requirements before designing a product checkpoint

Date: 2026-10-07
Checkpoint: GEO-002
Domain: process
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0023
Related skill: skills/geography/SKILL.md

### Context
GEO-002 was first designed from the checkpoint prompt alone because a shallow search for a PRD found nothing. The PRD exists at `docs/design/BananaGig_Brand_Kit/BananaGig_PRD.docx`. Reading SV-10 changed four decisions before any test was written: manual address entry is marked unverified for review, an address stores the administrative area code and name, the form and the server show the same message, and a second country must need no deployment (so administrative areas needed a management write path).

### Learning
Requirements that live in a Word file are invisible to grep and to `*.md` searches. Extract the text once (a .docx is a zip; the text is in `word/document.xml` as `<w:t>` runs) and search it by requirement id.

### Why it matters
Designing from a summary produces plausible but wrong defaults (here: calling a manual address FORMAT_VALID) that are cheap to fix before coding and expensive after.

### Reuse rule
At the start of a product checkpoint, extract the PRD into the scratchpad and cite the governing requirement ids in the review.

### Evidence
`docs/design/BananaGig_Brand_Kit/BananaGig_PRD.docx` (SV-10.01 to SV-10.12 and its acceptance criteria), `docs/engineering/ADDRESSES.md`.

## LRN-0030 — Take the start time of a serialized publication from the clock after the lock, not from now()

Date: 2026-10-07
Checkpoint: GEO-002
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0023
Related skill: skills/database/SKILL.md

### Context
Publishing an address format closes the open-ended predecessor at the new start, and publications of one country serialize on the country row. PostgreSQL `now()` is the transaction START time, so a publication that waited for the lock has a `now()` earlier than the start the winner just committed, which would make its start precede its predecessor's.

### Learning
Read `clock_timestamp()` after the locks are held and require the new start to be strictly later than the predecessor's start (a typed retryable conflict otherwise). Time-ordered history that is serialized by a lock needs a clock that is read inside the critical section.

### Why it matters
With `now()` two concurrent publications can produce an empty or inverted period, or a spurious overlap error.

### Reuse rule
Any "close the open end and start the next one" operation computes the boundary after taking the lock, with `clock_timestamp()`, and checks it is after the previous start.

### Evidence
`packages/geography/src/address-service.ts` (`publishFormat`), `packages/geography/src/address.itest.ts` (concurrent publication test).

## LRN-0031 — When the unauthenticated GitHub API is rate limited, read the run result from the public run page

Date: 2026-10-07
Checkpoint: GEO-002
Domain: ci
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
The CI watcher polls the public Actions API and stops with "API rate limit exceeded" after enough calls (60 per hour per address, shared with other tools), while `gh` is not installed.

### Learning
`https://github.com/<owner>/<repo>/actions/runs/<id>` is a public HTML page whose text contains `Status Success|Failure` and each job's duration; fetching it with `curl` and stripping tags answers "is the run green" without the API. Check-run annotations and logs still need the API or authentication.

### Why it matters
A pending "is CI green" precondition would otherwise block a checkpoint on an hour-long rate limit.

### Reuse rule
Use the API when it answers; fall back to the run page text for the final status only.

### Evidence
Run 37578136291 (CI-003) read as `Status Success`, verify 4m 18s, compose-smoke 3m 49s.


## LRN-0032 — Ajv type coercion accepts non-canonical numbers; check integer text lexically before it is converted

Date: 2026-10-07
Checkpoint: GEO-002A
Domain: api
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
The address format `:version` path parameter was declared `{ type: 'integer', minimum: 1, maximum: 100000 }`. Fastify's Ajv runs with type coercion on (query strings need it), so `1e3` became 1000, `1.0`, `+1` and `01` became 1, `0x10` became 16, ` 1` became 1 and `Infinity` reached the handler as `null`. The schema looked strict and the earlier tests only tried `0`, `-1`, `1.5` and `abc`.

### Learning
A schema type is not a syntax check when coercion is enabled. Integers that arrive as text are validated with an anchored base-10 pattern (`^(0|[1-9][0-9]*)$`, at most 15 digits) BEFORE any conversion, by one shared parser, in a `preValidation` hook that runs ahead of Ajv. A start-up guard that refuses to register a route with an unguarded numeric `params` or `querystring` property turns "remember the hook" into a failure nobody can skip.

### Why it matters
`Number()`, `parseInt` and Ajv coercion all read exponents, hex, signs and whitespace; an identifier written two ways (`1` and `1e3`) breaks caching, audit trails and any comparison of the raw text.

### Reuse rule
Never convert user text to a number with `Number`, `parseInt`, `parseFloat`, unary plus or coercion without a prior lexical check. Use `parseDecimalInteger` and `strictIntegerParams`; test the non-canonical forms at the HTTP boundary.

### Evidence
`packages/contracts/src/integer.ts`, `apps/api/src/plugins/strict-params.ts`, `apps/api/src/strict-params.test.ts`, `apps/api/src/address.test.ts` (strict version path parameter), `docs/engineering/API_CONVENTIONS.md`.

## LRN-0033 — Conditional punctuation needs an owner per character; test every subset of present fields

Date: 2026-10-07
Checkpoint: GEO-002A
Domain: geography
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/geography/SKILL.md

### Context
The address template rule gave the text in front of a token to that token and the text after the last token to the last token. For `{LOCALITY} ({ADMINISTRATIVE_AREA})` the opening bracket therefore followed the area but the closing bracket followed the last token, and with no locality the line rendered `CA)`. Every test used a complete address or dropped one separator-only field, so none of them could fail. A first fix that matched bracket pairs across several fields and nested pairs produced `Acme( [CA])` and glued separators, which only the all-subsets tests exposed.

### Learning
Punctuation that comes in pairs must have ONE owner: the field it wraps. The smallest grammar that gives this is a bracket written directly around a single field; brackets around several fields, around text or nested need ownership rules that cannot be explained in one sentence, so they are refused when a template is drafted instead of being guessed at render time. Prove a renderer by enumerating every subset of present fields (invariants: balanced, nothing dangling, each value once and in order) and by a differential test against the old renderer on inputs the change must not affect.

### Why it matters
A formatted address is shown to customers and providers and stored in snapshots; a dangling bracket is visible, and it appears only for the incomplete addresses nobody tried.

### Reuse rule
Before adding syntax to a template language, write down which element owns every character and what happens when each owner is absent; test all subsets.

### Evidence
`packages/geography/src/address-engine.ts` (`renderLine`), `packages/geography/src/address-engine.test.ts` (punctuation of omitted fields), `docs/engineering/ADDRESSES.md`.

## LRN-0034 — A get-or-create keyed by a unique constraint: insert, let the loser fail and roll back, then read

Date: 2026-10-07
Checkpoint: ID-001
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0025
Related skill: skills/identity/SKILL.md

### Context
The first authenticated request of a person creates their account and links the Keycloak identity. Several requests of the same person can arrive at once (a page load fires parallel API calls). A "look up, then insert if absent" without protection creates one account per request.

### Learning
Let the unique key decide, not application locking: look the key up; when absent, run ONE transaction that inserts the account and the link; the concurrent loser blocks on the unique index until the winner commits, gets a unique violation (SQLSTATE 23505 on the key's constraint) and its whole transaction, including the half-created account, rolls back; it then re-reads the winner's row. Bound the retries (3) and report a retryable conflict after that. 25 parallel first requests produce exactly one account, one link, one history row and one creation event, checked over repeated runs because a race test that passes once proves little.

### Why it matters
Advisory locks serialize more than needed and hide the invariant in code; a plain unique constraint makes the duplicate impossible even for a second application instance or a raw SQL client.

### Reuse rule
Get-or-create = unique constraint + one creating transaction + catch 23505 on THAT constraint + re-read. Test with N parallel callers and global invariants, several rounds.

### Evidence
`packages/accounts/src/service.ts` (`ensureAccountForIdentity`), `packages/accounts/src/accounts.itest.ts` (parallel first requests), `apps/api/src/account.itest.ts` (20 concurrent HTTP calls).

## LRN-0035 — A deferred consistency trigger reads the current row at commit and guards both sides of the invariant

Date: 2026-10-07
Checkpoint: ID-001
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0025
Related skill: skills/database/SKILL.md

### Context
The account status must always equal the newest row of its immutable history. The first version of the deferred constraint trigger compared the newest history row with `NEW.status` of the row version that queued the event. For a deferred AFTER ROW trigger `NEW` is that old version, so a transaction that suspends and reactivates an account (a transient status) was refused at COMMIT although the end state was consistent; and a stray history row, which fires nothing on the accounts table, went unnoticed. An integration test written with `it.fails` for the suspected defect proved the first, and the review of the second.

### Learning
A deferred check must read the CURRENT row at commit, not the queued row version, and an invariant between two tables needs a deferred trigger on each table (the status change without a history row, and the history row without or against a status change), plus continuity of the chain (`from_status` equals the previous `to_status`). When a suspected defect cannot be reached through the service, pin it with `it.fails` and fix the code, not the test.

### Why it matters
A latent false refusal appears the first time someone legitimately changes state twice in one transaction (a support script, a later checkpoint), and an unguarded side of the invariant lets raw SQL corrupt the history silently.

### Reuse rule
Deferred constraint triggers: read the live rows inside the function; install one per side of the invariant; test with a transient state, a stray row and a gap.

### Evidence
`db/migrations/0009_identity_accounts.sql` (`identity.check_status_history`, `identity.check_status_history_row`), `packages/testing/src/identity-model.itest.ts` (transient status, stray row, gap).

## LRN-0036 — Literal bidirectional and invisible characters in source slip past eslint; scan for them

Date: 2026-10-07
Checkpoint: ID-001
Domain: process / security
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
The file-writing tool decodes the TEXT of a Unicode escape (backslash, `u`, four hex digits) in the content it writes and puts the literal character on disk. It happened three times: zero-width characters in two regexes (eslint's `no-irregular-whitespace` caught them) and, in the identity migration, the bidirectional override characters U+202A to U+202E and U+2066 to U+2069 inside a CHECK regex. eslint does NOT flag bidi characters, so that one was found only by a reviewer reading the file. Bidirectional characters in source can make code read differently from how it executes (the "trojan source" class).

### Learning
Write any file that needs a Unicode escape through a shell heredoc or python, and scan the changed files before committing. Older committed test fixtures (`packages/content/src/format.test.ts`, `template.test.ts`, `packages/geography/src/address-engine.test.ts`) still hold such literals as test data.

### Why it matters
A literal bidi character in a regex or a migration is invisible in review and silently changes what a reader believes the constraint is.

### Reuse rule
Before a commit: `python3 -I -c` over `git ls-files` plus untracked files, flag U+202A to U+202E, U+2066 to U+2069, U+200B, U+2060, U+FEFF, U+180E, U+00AD and control characters outside tab and newline. New code builds such characters with escapes or `String.fromCodePoint`.

### Evidence
Migration `0009_identity_accounts.sql` (CHECKs `ck_account_profiles__first_name` and `__last_name` use escapes), `packages/geography/src/address-engine.ts` (`INVISIBLE`), the three older test files above (candidates to convert).

## LRN-0037 — A failed attempt that must be remembered cannot throw inside its transaction

Date: 2026-10-07
Checkpoint: ID-002
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0028
Related skill: skills/identity/SKILL.md

### Context
Wrong verification codes must be counted and the challenge locked at the maximum, atomically and under concurrency. The natural code throws "wrong code" from inside the service transaction, which rolls back the very `attempt_count` increment it just made, so an attacker would get unlimited guesses.

### Learning
When a failure has to leave a durable trace (an attempt counter, a lock, an audit row), the transaction must RETURN an outcome (`WRONG`, `LOCKED`, `FAIL`) and commit, and the caller throws after the commit. Take the row lock first (`FOR UPDATE` on the account, then the challenge) so concurrent attempts are counted one after the other, and make the lock part of the same update (`CASE WHEN attempt_count + 1 >= max`).

### Why it matters
The unit test with a mocked database passes while the real behaviour is "no limit". Only a concurrent integration test (N parallel wrong codes ending at exactly the maximum) and a check that the count survived the failed call show it.

### Reuse rule
Any "count and reject" flow (attempts, lockouts, quota use): outcome-returning transaction, throw after commit, concurrent test that asserts the persisted count.

### Evidence
`packages/accounts/src/email-verification.ts` (`confirmCode`, `AttemptOutcome`, `settle`), `packages/accounts/src/email-verification.itest.ts` (attempt race, count persisted after the failed call).

## LRN-0038 — A one-time secret in a URL query is a logged secret; use the fragment and never let a GET change state

Date: 2026-10-07
Checkpoint: ID-002
Domain: web / security / observability
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0028
Related skill: skills/web/SKILL.md

### Context
The first design put the magic-link token in `?token=`. The Node HTTP instrumentation records the query on spans, proxies and servers log request URLs, the Referer header carries the page address, and a login redirect stores the return URL server-side. Mail scanners and link previewers also open links with GET, so a GET that verifies would verify addresses nobody confirmed.

### Learning
Put one-time tokens in the URL fragment (`/verify-email#token=...`, never sent to any server), read and remove them in a client component, show a confirm button, and POST the token in a body to the API. Do not carry the token through the login redirect (the fragment is dropped, deliberately): a signed-out visitor signs in and opens the link again. Hash the secret at rest with a KEYED hash (HMAC); a plain SHA-256 of a 6-digit code can be reversed from a leaked table in a millisecond.

### Why it matters
A logged or traced token is a credential in the observability stack, which has a different audience and retention than the database.

### Reuse rule
Any emailed or shared one-time link: fragment for the secret, POST to act, keyed hash at rest, a smoke check that searches Loki for the secret after the flow.

### Evidence
`apps/web/src/app/verify-email/link-confirm.tsx`, `apps/api/src/modules/account/email-wiring.ts` (`createVerificationLinkBuilder`), `apps/smoke/src/index.ts` (check `Email verification`, Loki absence queries), `packages/accounts/src/email-crypto.ts`.

## LRN-0039 — A uniqueness policy that is configuration cannot be a unique index: lock, count, and let the trigger enforce the same value

Date: 2026-10-08
Checkpoint: ID-003
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0031
Related skill: skills/database/SKILL.md

### Context
The PRD lets a market decide how many accounts may verify the same phone number (`verification.phone.max_accounts_per_number`, default 1, overridable per country and market). For email the rule is fixed ("one account"), so a partial unique index on the verified address is exact. For the phone, an index is correct only for a maximum of one and wrong the moment a market raises it.

### Learning
Serialize the competing verifications of ONE key with `pg_advisory_xact_lock(hashtextextended('phone:' || number, 0))`, count the OTHER holders inside the same transaction, refuse at the limit, and pass the limit to the guard trigger through a transaction-local setting (`set_config('app.phone_max_accounts', n, true)`). The trigger takes the same lock and enforces that setting, or a structural ceiling when the setting is absent, so a writer that bypasses the service still cannot exceed it. Do the typed refusal only after the caller proved control (a correct code), so the answer before that reveals nothing about other accounts. Prove it with a race test: N parallel verifications (more than the cap) end at exactly the cap, and raw SQL against the trigger fails with its rule key.

### Why it matters
A read-then-write count without the lock lets two concurrent verifications both see "one holder fewer than the limit" and both succeed; a check only in the service is skipped by any other writer. Both failures pass every single-threaded test.

### Reuse rule
Any limit that is policy data (accounts per number, devices per account, seats): lock on the key, count, compare, setting for the trigger, structural ceiling as defence in depth, a concurrency test that ends at exactly the limit, and a mutation check that removing the lock fails the test.

### Evidence
`db/migrations/0011_phone_verification.sql` (the guard trigger, rule key `PHONE_NUMBER_CAP`), `packages/accounts/src/phone-verification.ts` (`completeVerification`).

## LRN-0040 — Trust a proxy hop count with an explicit function, and prove the proxy replaces X-Forwarded-For

Date: 2026-10-08
Checkpoint: ID-003
Domain: api / infrastructure / security
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0033
Related skill: skills/api/SKILL.md

### Context
DEBT-0055: `trustProxy: true` made `request.ip` the leftmost `X-Forwarded-For` entry, which a client chooses, so every request could get a new source-address rate-limit bucket. The exact hop count is the fix, but Fastify 5.12.5 types the option as `boolean | string | string[] | TrustProxyFunction`: there is no numeric form to rely on.

### Learning
Pass a function, `(address, hop) => hop < hops` (`trustHops`). proxy-addr counts hops from the socket (hop 0 is the connection peer), so with 1 hop `request.ip` is the LAST entry, the one the proxy wrote, and with 0 hops it is the socket address. Unit-test the function and the real Fastify behaviour for 0, 1 and 2 hops with chains of different length. The count is only half the control: the proxy must REPLACE the header (`header_up X-Forwarded-For {remote_host}` in Caddy), the web server must forward one value (the last entry it received, not the leftmost), and the API must be unreachable except through the proxy. Prove the replacement twice: statically (a test that reads the Caddyfile and the compose file) and end to end (a smoke test that sends a spoofed header through Caddy and then inspects Valkey for the rate-limit bucket the spoofed address would have created, which must not exist).

### Why it matters
A wrong count fails silently in both directions: too low puts every user in one bucket (a global lockout at the limit), too high lets a client choose its bucket and defeats the limit that protects SMS spend. Unit tests with a fake request cannot see the proxy.

### Reuse rule
Any decision that depends on the client address: a hop-count function, a documented topology invariant, a static test of the proxy config, and a smoke test that looks for the bucket a spoofed address would create.

### Evidence
`apps/api/src/app.ts` (`trustHops`), `apps/api/src/trust-proxy.test.ts`, `infra/caddy/Caddyfile`, `apps/web/src/lib/auth/email-handlers.ts` (`clientIpOf`), `apps/smoke/src/index.ts` (the spoofed `X-Forwarded-For` check in the phone scenario).

## LRN-0041 — Docker Desktop clock drift fails integration tests that compare a database timestamp with the host clock

Date: 2026-10-16
Checkpoint: ID-003
Domain: testing / infrastructure
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
The ID-003 finalize run failed twice in files this checkpoint did not touch (`address-model.itest.ts` timed out, then `outbox.itest.ts` failed a backoff comparison) although the same suite had passed minutes earlier.

### Learning
The Postgres container reads the Docker Desktop VM clock, which can run tens of seconds behind the host after the laptop sleeps. Integration tests that compare a database-computed timestamp (`now()`, a backoff `next_attempt_at`) with the host's `Date.now()` then fail intermittently in files nobody changed (seen as `outbox.itest.ts` "records failures ... and backoff": expected 1792173131583 to be greater than 1792173159306), and a stalled file can also hit the 30 s test timeout. Compare `date +%s` on the host with `docker exec bananagig-postgres-db date +%s` before debugging; the drift corrects itself, and the same test passes alone once the clocks agree.

### Why it matters
It looks like a flaky or broken test in an unrelated area and costs a full 5 minute integration run per retry, and `checkpoint:finalize` fails on it.

### Reuse rule
When an unchanged integration file fails on a time comparison, check the host and container clocks first, rerun that file alone, and only then look at the code. New tests should take both sides of a time comparison from the database clock (`clock_timestamp()`), as the phone tests do.

### Evidence
`apps/worker/src/outbox.itest.ts` (host `Date.now()` against `next_attempt_at`); host 1792173169 against container 1792173140 on 2026-10-16, equal again seconds later.

## LRN-0042 — Keycloak ignores acr_values for a user without a factor and the browser can drop any authorization parameter, so the second factor must be enforced by the flow and the app must read the acr claim

Date: 2026-10-16
Checkpoint: ID-004
Domain: identity / security
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0036
Related skill: skills/identity/SKILL.md

### Context
The web client's browser flow had no second-factor step, and DEBT-0018 assumed a feature that needs step-up would request `acr_values=bananagig:mfa`. The ID-004 lab (Keycloak 26.3.5) tried the obvious designs against a real realm.

### Learning
A level-of-authentication condition in the flow is false when the request asks for no level, so a login without `acr_values` never meets the OTP step; `acr_values` is ignored (no error, no forced enrolment) for a user who has no factor, and an essential `claims` acr is not enforced for such a user either (a token with `acr=bananagig:password` is issued); and the browser carries every authorization parameter, so it can drop or change them. The requirement therefore cannot live in the request. Make it intrinsic to the flow: a dedicated flow bound to the client, with the OTP step conditional on "user has a factor", and the client attribute `minimum.acr.value=bananagig:mfa`, which makes level 2 the floor for every request whatever the URL says. Then read the `acr` and `auth_time` of the VERIFIED token in the API (`requireMfa()`, `requireRecentAuthentication()`) and have the web callback check the token, not the URL, before it believes a step-up happened. Costs found on the way: a password-only user's SSO cookie is below the floor, so every new authorization request asks the password again (do not gate the password form by level: it fails with "Invalid username or password" on SSO re-entry), and the factors must be flat siblings (nesting them under the user-configured condition breaks every login).

### Why it matters
A design that "requests MFA" from the browser looks correct in a happy-path test with a user who has a factor and silently lets the same user skip it by dropping one query parameter; and a guard that trusts what the URL asked for is bypassed the same way.

### Reuse rule
Never enforce an authentication requirement from `acr_values`, `max_age` or `claims` sent through the browser. Put the floor in the flow (client attribute plus a bound flow), read the claims of the verified token on the server, and keep the web callback from looping by recording the step-up in the login transaction. Change the flow only with the lab scripts or the live tests at hand.

### Evidence
`infra/keycloak/bananagig-realm.json` (flow `bananagig-browser`, `minimum.acr.value`), `scripts/lib/realm.mjs` (`lintWebSecurity`), `apps/api/src/plugins/step-up.ts`, `apps/web/src/lib/auth/handlers.ts` (`handleCallback`, `stepUpReached`), `packages/identity/src/keycloak-security.itest.ts` ("second factor floor and recovery codes (live)").

## LRN-0043 — A partial requiredActions list in a realm import replaces Keycloak's defaults, an undeclared built-in client is created enabled, and any client can start kc_action=delete_credential

Date: 2026-10-16
Checkpoint: ID-004
Domain: identity / security
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0036
Related skill: skills/identity/SKILL.md

### Context
ID-004 moved account security into BananaGig (step-up, audit, session registry). Keycloak, however, ships a self-service surface of its own, and the realm file only declared the parts BananaGig used.

### Learning
Declaring `requiredActions` in a realm file REPLACES Keycloak's default list, and omitting it leaves `delete_credential` enabled: any client, including `bananagig-web`, can then send a signed-in user to `kc_action=delete_credential` and remove their second factor with no step-up, no audit and no registry entry. The built-in `account` and `account-console` clients are created ENABLED by the import unless the file declares them with `enabled: false`, which opens an account console where a user manages credentials and sessions outside BananaGig. So the file must declare the product actions explicitly and enabled (`CONFIGURE_TOTP`, `CONFIGURE_RECOVERY_AUTHN_CODES`, `UPDATE_PASSWORD`, the usual ones), declare `delete_credential`, WebAuthn registration and `idp_link` disabled, declare both built-in clients disabled, and the proxy should refuse the console and the self-service reset path as a second line while leaving the action-token path of the reset email open.

### Why it matters
Nothing fails when the surface is open: the realm imports, the app works and the tests of the happy path pass. The hole is only visible to someone who looks for it, and a later partial `requiredActions` edit can silently drop the product actions.

### Reuse rule
Lint the realm file for every Keycloak surface BananaGig replaces (the linter rules and their negative tests), declare things explicitly rather than rely on defaults, and re-enable a disabled action only together with the feature that uses it (WebAuthn: DEBT-0018).

### Evidence
`scripts/lib/realm.mjs` (`lintBuiltInSurface`, `REQUIRED_ACTIONS_ENABLED`, `REQUIRED_ACTIONS_DISABLED`), `scripts/identity-realm.test.mjs` ("built-in account surface"), `infra/caddy/Caddyfile` (`@blocked`), `packages/identity/src/keycloak-security.itest.ts` ("built-in account surface is closed (live)").

## LRN-0044 — The generated OpenAPI silently lacked routes whose service the generator never received, and spec:check could not notice

Date: 2026-10-16
Checkpoint: ID-004
Domain: api / governance
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
While regenerating the specs for ID-004 it turned out that `docs/api/openapi.yaml` did not document the ID-003 phone routes. Each optional service of `AppDeps` enables a route module, and `scripts/generate-specs.mjs` builds the app without a database, so it must pass a stand-in for every service; it never passed the phone service.

### Learning
`pnpm specs:check` compares the committed file with what the generator produces. If the generator omits a module, both files are equally incomplete and the check passes, so a missing module is invisible to every gate. Guard the generator itself: `apps/api/src/spec-completeness.test.ts` parses the `AppDeps` interface and the keys the generator passes to `buildApp` and fails when a property is not passed, and asserts that the committed spec contains a path of each route module.

### Why it matters
The spec is the contract clients and reviewers read; an undocumented route is not linted, not diffed and not discoverable, and it happened to a whole feature for a checkpoint.

### Reuse rule
When a check compares generated output with a committed copy, also check that the generator is complete. When you add an optional service to `AppDeps`, pass it in `scripts/generate-specs.mjs` and add its module to the spec-completeness test.

### Evidence
`apps/api/src/spec-completeness.test.ts`, `scripts/generate-specs.mjs`, `apps/api/src/app.ts` (`AppDeps`).

## LRN-0045 — A per-sid upsert next to a bulk revoke needs the account row locked FOR SHARE by the creator and FOR UPDATE by the bulk operation

Date: 2026-10-16
Checkpoint: ID-004
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0034
Related skill: skills/database/SKILL.md

### Context
"Sign out everywhere" must also stop a Keycloak session the API has never seen (the person signed in elsewhere and has not made a request yet). Such a session has no row to revoke. The registry creates a row on first sight (`INSERT ... ON CONFLICT (keycloak_session_id) DO NOTHING`), so a first sight racing a revoke-all could create a live row just after the revoke-all looked.

### Learning
Give the bulk operation a watermark on the owner row (`identity.accounts.sessions_not_before`) and serialize the two through that row: the creator reads the watermark under `SELECT ... FROM identity.accounts WHERE account_id = $1 FOR SHARE` and refuses a session whose `auth_time` predates it; revoke-all takes the same row `FOR UPDATE`, revokes the existing rows and raises the watermark. Either the new row exists when revoke-all runs (and is revoked) or the creator reads the raised watermark; no interleaving escapes. Two concurrent first sights of one `sid` create ONE row (the conflict loser reads the winner), a `sid` that belongs to another account is treated as revoked, and the watermark applies only to first sight (a session with a row is governed by its own `revoked_at`, so a later login works). `auth_time` has whole-second resolution and comes from another clock, hence a 2-second tolerance. Prove it with two real transactions in both orders, not with sequential calls.

### Why it matters
Sequential tests pass either way. Without the lock the bug is a sub-second window that lets a session survive a "sign out everywhere", which is exactly the case the feature exists for.

### Reuse rule
When rows can be created by requests while a bulk operation must cover rows that do not exist yet, use a watermark on the owner row plus FOR SHARE for the creator and FOR UPDATE for the bulk operation, a conflict-safe insert, and a race test in both orders.

### Evidence
`packages/accounts/src/security-service.ts` (`firstSight`, `revokeAllSessions`), `db/migrations/0012_application_sessions.sql` (the watermark guard), `packages/testing/src/security-model.itest.ts` (section H, "the account row serializes first sight (FOR SHARE) with revoke-all (FOR UPDATE)").

## LRN-0046 — Bind an immutable record to an immutable version with a composite foreign key that includes the derived columns, so the database proves them

Date: 2026-10-16
Checkpoint: ID-005
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0037
Related skill: skills/database/SKILL.md

### Context
A consent event must prove WHICH text a person accepted, without copying the text. The content version is immutable (body, locale and `body_sha256` never change) and never deleted, but a foreign key on `version_id` alone says nothing about the locale and the hash a service stored next to it: a bug, a second writer or a crafted request could store a hash that disagrees with the version.

### Learning
Give the referenced table an additive unique constraint over the key plus the derived columns (`UNIQUE (version_id, locale, body_sha256)` on `content.versions`; `version_id` is already unique, so it adds no rule) and reference THAT with a composite foreign key from the event. The database then proves that the locale and the hash stored with the record are those of the immutable version, and a wrong claim is a plain foreign key violation (SQLSTATE 23503), not a check that code can skip. It costs a second unique index on the referenced table; if the indexed columns never change the updates stay HOT. Do not add an index on the referencing side when the referenced rows are never deleted or re-keyed (no foreign key check ever scans it) and no query needs it; say so in the migration.

### Why it matters
Evidence that can disagree with the thing it is evidence of is not evidence. Copying the text instead would duplicate large documents per account and create a second source of truth for the wording.

### Reuse rule
When a record must pin an immutable version, store the version id AND the immutable attributes the record asserts (locale, hash), and reference a unique key that includes them. Use this for acceptances, notification receipts and any "what exactly was shown" record. Verify the claim in the service too, to answer with a precise error.

### Evidence
`db/migrations/0013_consent.sql` (`uq_versions__version_locale_hash`, `fk_consent_events__version`), `packages/accounts/src/consent-service.ts` (`acceptOnce`).

## LRN-0047 — Evaluate "in force" with ONE SQL definition used by the trigger and the service, and test it for parity with the resolver

Date: 2026-10-16
Checkpoint: ID-005
Domain: database / content / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0037
Related skill: skills/identity/SKILL.md

### Context
Whether a legal version can be accepted depends on the same rule the content resolver uses to decide what is served now: a published status, an active entry and locale, platform scope, `effective_from <= now < effective_to`, where SCHEDULED, PUBLISHED and SUPERSEDED are workflow labels and the timestamps decide (a SCHEDULED version whose start has passed counts even if the activation job has not advanced it). Re-implementing that in the guard trigger, in the service and in the page gives three definitions that drift.

### Learning
Put the rule in one SQL function (`identity.consent_version_state(version_id, entry_id, at)` returning `NOT_FOUND`, `IN_FORCE` or `NOT_CURRENT`) and call it from the guard trigger, from the service's pre-check and from the query that picks the version in force. The function mirrors the resolver, so the resolver and the function must agree: test the PARITY (publish versions in every state and window, ask `ContentService.resolve` and the function, compare) and change the function in a new migration whenever the resolver's definition of "effective" changes. Return `NOT_FOUND` for everything not published, so an unknown id and an unpublished one are indistinguishable to the caller.

### Why it matters
A drift is silent: the page offers a version the trigger refuses, or worse the trigger accepts a version the resolver would not serve, and nothing fails until a lawyer asks which text a person saw.

### Reuse rule
Any rule that both the database (as an arbiter) and the service (as an early, precise error) need belongs in a SQL function with a parity test against the other implementation of the same rule, not in two copies.

### Evidence
`db/migrations/0013_consent.sql` (`identity.consent_version_state`, `identity.guard_consent_events`), `packages/accounts/src/consent-service.ts` (`acceptOnce`, `getRequirements`), `packages/content/src/resolver.ts`, `docs/engineering/CONTENT.md` (Legal documents).

## LRN-0048 — Take FOR SHARE on the referenced version inside the insert trigger, before reading the clock, so an accept and a publish serialize

Date: 2026-10-16
Checkpoint: ID-005
Domain: database / concurrency
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0037
Related skill: skills/database/SKILL.md

### Context
An acceptance is valid only if the version is in force at the moment of the insert. Publishing a successor closes the head version's window by updating the head row. Checking the window without a lock leaves a gap: the check passes, the publication commits, and an event is stored for a version that is no longer in force; the later arrival looks as if it was never valid.

### Learning
In the BEFORE INSERT trigger, `SELECT ... FOR SHARE` the referenced version row FIRST, then read `clock_timestamp()` and evaluate the window. If the publication committed first, the lock waits for it and the next statement (a fresh snapshot in READ COMMITTED) sees the closed window and refuses; if the insert holds the lock first, the publication's update waits for the insert's transaction and the event lands as a valid historical fact. There is no interleaving that stores an event for a version that was not in force at the event's own time. The lock order is account row, purpose row, version row, and it relies on the default READ COMMITTED isolation. Prove it with two real transactions holding the locks in both orders, not with sequential calls.

### Why it matters
The window of this race is milliseconds, so sequential tests and manual checks never hit it, and the failure is a legal record that contradicts the content history.

### Reuse rule
When a write is valid only against the current state of a row another workflow updates, lock that row FOR SHARE in the guard before you read the clock or the state, and test both orders with held locks.

### Evidence
`db/migrations/0013_consent.sql` (`identity.guard_consent_events`: the `PERFORM 1 FROM content.versions ... FOR SHARE` before `clock_timestamp()`).

## LRN-0049 — Let the guard trigger overwrite the default timestamp with the instant the check was made

Date: 2026-10-16
Checkpoint: ID-005
Domain: database / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0037
Related skill: skills/database/SKILL.md

### Context
A record that says "accepted at T" is only meaningful if T is the instant at which the acceptance was proven valid. A column default (`DEFAULT clock_timestamp()`) is evaluated after the BEFORE trigger, and a caller can supply any value, including a past or future one, so the stored time and the instant of the eligibility check could differ.

### Learning
In the guard trigger, take `v_now := clock_timestamp()` once, evaluate eligibility at `v_now` and assign `NEW.occurred_at := v_now` before returning. A supplied value is overwritten, the default stays only as documentation, and the row's time is exactly the instant of the check, never a client's clock. Tests that need an event in the past must disable the guard trigger as the table owner (and say so), because the trigger deliberately makes backdating impossible through normal SQL.

### Why it matters
It removes a whole class of "client timestamp" mistakes and makes the record usable as evidence that the version was in force at that instant, with no extra column.

### Reuse rule
For an append-only evidence table whose validity depends on the time of the insert, set the time in the guard trigger from the same clock reading used for the check; never accept a time from the caller.

### Evidence
`db/migrations/0013_consent.sql` (`identity.guard_consent_events`: `NEW.occurred_at := v_now`), `packages/accounts/src/consent-service.ts` (the insert supplies no time and returns the stored `occurred_at`).

## LRN-0050 — Do not add locks on entries or locales after the version lock in an insert trigger: publication locks the entry, then the version

Date: 2026-10-16
Checkpoint: ID-005
Domain: database / concurrency
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0037
Related skill: skills/database/SKILL.md

### Context
The consent guard trigger share-locks the content version row so an accept serializes with a publication (LRN-0048). It is tempting to also lock the entry row or the locale row, so that deactivating an entry or locale serializes with an accept as well.

### Learning
The content publish path locks the ENTRY row first and then the VERSION row. A trigger that takes the version lock and then an entry or locale lock acquires them in the opposite order, so an accept and a publication can deadlock (each holds what the other waits for). The trigger therefore locks only what comes after the version in the global order (nothing), and entry and locale activation are deliberately not serialized with an accept: an accept that wins that race is a valid historical fact for a version that was in force when it was checked. If such a lock is ever needed, take it BEFORE the version lock, in the order publication uses, and prove both orders with held locks.

### Why it matters
A deadlock between a user action and an administrator's publication is rare, non-deterministic and only visible in production traffic; the lock order is invisible in the trigger's code unless it is written down.

### Reuse rule
Before adding a lock to a guard trigger, list the lock order of every other writer of the same rows (here entry, then version) and extend only in that order; document the order next to the trigger.

### Evidence
`db/migrations/0013_consent.sql` (`identity.guard_consent_events`: account, purpose, then version; the comment on the lock order), `docs/engineering/CONSENT.md` (Database-enforced eligibility), DEBT-0081.

## LRN-0051 — A test pool needs an `error` listener: `pool.end()` returns before the server has seen the clients leave, and a following `DROP DATABASE ... WITH (FORCE)` can deliver 57P01 to an idle client

Date: 2026-10-16
Checkpoint: ID-005
Domain: testing / PostgreSQL
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
CI run 38977469935 for ID-005 failed in the integration step with "Vitest caught 2 unhandled errors" (`error: terminating connection due to administrator command`, SQLSTATE 57P01) attributed to `consent-model.itest.ts`, while every assertion passed. The file had passed locally many times, also under CPU load.

### Learning
pg-pool's `end()` resolves as soon as its client list is empty; it does not wait for the connections to close. The idle-client error listener stays attached to a client that is being ended, and it re-emits the error on the POOL. A pool without an `error` listener turns that into an uncaught exception. Test teardown ends the pools and then force-drops the database, so on a slow runner the FATAL 57P01 of the drop reaches a client that is still closing. Reproduced deterministically with a 30-connection pool, `end()` and an immediate `DROP DATABASE ... WITH (FORCE)`: 520 uncaught 57P01 over 60 repetitions without a listener, none with one. The larger and busier the pool, the likelier the hit, which is why a fast local machine never showed it.

### Why it matters
It is a failure with no failing test and no stack inside the test file, only "this error originated in" a file that was merely running when it fired. Local green runs prove nothing about it.

### Reuse rule
Create every `pg.Pool` in a test with `createTestPool(url, max)` from `@bananagig/testing` (it swallows pool errors) and let `createIsolatedDatabase().drop()` wait for the sessions to drain before it forces the drop. Never build a bare `new pg.Pool` in an `*.itest.ts`.

### Evidence
`packages/testing/src/index.ts` (`createTestPool`, the drain loop in `drop`), `node_modules/pg-pool/index.js` (`makeIdleListener`, `end`), CI run 38977469935.

## LRN-0052 — An automated login within 2 s of a sign-out-everywhere is refused: the smoke must wait, and a local pass proves nothing about CI timing

Date: 2026-10-16
Checkpoint: ID-005
Domain: testing / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0034
Related skill: skills/testing/SKILL.md

### Context
CI run 38982170853 (compose-smoke) failed in `Sessions and security` (7a: "a new login after the revocation" got 401 SESSION_REVOKED) and then in `Consent`, which logs in as the same user right after the aborted scenario. The scenario had passed locally.

### Learning
`SecurityService.firstSight` refuses a never-seen session whose `auth_time` is within 2 s of the account's `sessions_not_before` unless the identity provider confirms that it started later (whole-second start times, one second reserved). A person needs far longer than that to log in again; the smoke signs in again within about a second of the revocation, which a slow local stack hid and a fast runner did not. The failed scenario also leaves the account with a fresh watermark, so the next scenario failed for the same reason (a cascade, not a second defect). Reproduced locally only after the API container was really rebuilt: `docker compose up -d --build` takes the SERVICE names (`api-service`, `worker-service`, `web-app`), and `api` fails with "no such service".

### Why it matters
A green local smoke against stale containers, or on a slower machine, says nothing about a window that is measured in seconds.

### Reuse rule
In a smoke or integration scenario, wait about 2.6 s after any sign-out-everywhere before signing in again (and before it for the logins that must count as older). When reproducing a CI failure, check the container creation time (`docker inspect <name> --format '{{.Created}}'`) before trusting a local result.

### Evidence
`apps/smoke/src/index.ts` (the two waits in (7a) and (7b)), `packages/accounts/src/security-service.ts` (`firstSight`), CI run 38982170853.

## LRN-0053 — With `loading.tsx` present, Next answers a `notFound()` in a dynamic page with HTTP 200 (and the not-found content); the server-side 404 is the API's, and the end-to-end check must say so

Date: 2026-10-16
Checkpoint: ACC-001
Domain: web
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0039
Related skill: skills/web/SKILL.md

### Context
The account area ends a section the API answers 404 for (or a registry section without a page) in `notFound()`. Probing the running web app through Caddy: `/nope-page` (static not-found, outside any streaming boundary) is 404, but `/account/notifications` and `/account/zzz` are 200 with the not-found content and a noindex meta tag. The root `app/loading.tsx` makes every dynamic page stream, so the status line is sent before the page body runs.

### Learning
A `notFound()` (or `redirect()`) raised while the page body renders cannot change a status that has already been sent. Raising it from `generateMetadata` does not help either (Next 16 streams metadata too; tried and reverted). The content is blocked, which is what authorization needs; the HTTP 404 that exists is the API's (`ACCOUNT_SECTION_NOT_FOUND`), and a redirect becomes a meta refresh with status 200 for signed-out visitors on a dynamic page.

### Why it matters
A test or a smoke check that asserts HTTP 404 on a streamed web page fails for a reason that is not a defect, and a monitor that counts 404s will not see these.

### Reuse rule
Assert the not-found CONTENT (and that no section content is present) for streamed web pages, accept 404 or 200-with-not-found, and put the authoritative status assertions on the API. Do not spend time trying to turn it into a 404 with metadata tricks; if a real 404 is ever required, remove the boundary for that route.

### Evidence
`apps/smoke/src/index.ts` (the `notServed` helper of the Account area scenario), probes of `/account/zzz` and `/nope-page` through Caddy, `apps/web/src/app/account/[section]/page.tsx`.

## LRN-0054 — When the seed gives every role the same set, prove role-driven behaviour against the data itself: an SQL oracle plus one reversible, self-healing flip

Date: 2026-10-16
Checkpoint: ACC-001
Domain: testing / identity
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0039
Related skill: skills/testing/SKILL.md

### Context
The account area selects sections by the ACTIVE role, but today CUSTOMER and PROVIDER have the same six sections, so a smoke that only compares the two menus proves nothing about role-driven selection, and the registry tables forbid DELETE, so a smoke cannot create and remove a role-specific row.

### Learning
Compare the API answer with a direct SQL read of the matrix for the role in use (the oracle: it fails if the service ignores the role), then prove the effect by flipping ONE seeded row off for ONE role for the length of one step and restoring it in `finally`; make the scenario self-healing (a precondition step restores the seeded value if an interrupted run left it flipped) and never swallow a failed restore. Role-specific sets with extra rows belong in tests on an ISOLATED database, where rows can be added freely.

### Why it matters
A role-driven framework tested only with identical data passes even when the role is ignored, and a flip without a self-healing precondition leaves the shared dev registry changed after one killed run.

### Reuse rule
For a data-driven selection: oracle query for the expected set, one reversible flip on seeded reference data, a precondition that restores the seed, a loud failure message when the restore fails; extra rows only in isolated databases.

### Evidence
`apps/smoke/src/index.ts` (Account area, steps (8) to (10) and the precondition), `apps/api/src/account-area.itest.ts`, `packages/accounts/src/account-area.itest.ts`.


## LRN-0055 — In PL/pgSQL, `IF <condition> THEN` ends the condition at the FIRST `THEN`, even inside a `CASE`: compute the value into a variable first

Date: 2026-10-17
Checkpoint: CAT-002
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0041
Related skill: skills/database/SKILL.md

### Context
A guard trigger compared a content key with `CASE WHEN x IS NULL THEN NULL ELSE ... END` inside an `IF ... THEN`. The migration failed with `syntax error at end of input` and a caret under the `CASE`, on a line number relative to the function body, with nothing pointing at the real cause.

### Learning
PL/pgSQL does not parse the `IF` condition as an SQL expression of its own: it scans for the first `THEN` keyword and sends the text before it to the SQL parser as `SELECT <text>`. A `CASE ... THEN` inside the condition therefore cuts the expression short. Do not put `CASE` (or any construct that uses the word `THEN`) in an `IF`/`ELSIF` condition: assign the value to a variable (or use `COALESCE`/`NULLIF`) and test the variable. The same applies to `WHEN ... THEN` inside a `CASE` statement's condition.

### Why it matters
The error text names a symptom (end of input) far from the cause, the migration is applied in one transaction so nothing is half done, and the same mistake costs the next author the same hour.

### Reuse rule
Write guard triggers with intermediate variables (`stem := ...; IF a <> stem || '.label' OR COALESCE(b, stem || '.help') <> stem || '.help' THEN`). When a PL/pgSQL function fails with "syntax error at end of input", look for `THEN` inside a condition first. Run every new migration from zero on a scratch database before anything depends on it.

### Evidence
`db/migrations/0016_gig_templates.sql` (`catalog.guard_gig_template_fields`, the `stem` variable).

## LRN-0056 — A presigned PUT stays valid after you verified the object: upload to a key nothing reads, and promote the bytes you hashed

Date: 2026-10-18
Checkpoint: TRUST-001
Domain: security / storage
Status: ACTIVE
Supersedes: none
Related ADR: ADR-0044
Related skill: skills/trust/SKILL.md

### Context
Verification evidence is uploaded with a presigned PUT, then the server checks it (size, content type, file signature, SHA-256, malware scan) and records it. The independent security review showed that the same URL still accepts a PUT until it expires, so a provider could overwrite an object after it was hashed, scanned and even submitted: the stored hash and scan verdict then describe other bytes, and the reviewer's download returns the swapped file. Nothing in the test suite replayed a PUT.

### Learning
A presigned URL is a capability, not a one-time token: nothing makes it single use or binds it to the bytes you inspected. Verification of an object you do not exclusively control proves nothing about the object a later reader gets. The fix is structural: the uploader writes to an UPLOAD key that no reader ever uses; finalize reads that object once (remembering its version/ETag), hashes and scans exactly those bytes, copies them to the FINAL key with a conditional copy (only while the version is unchanged), re-reads and re-hashes what landed (some stores ignore the condition), and stops reading the upload key. A replay can then only write an object nothing reads.

### Why it matters
It is invisible in functional tests and smoke runs (the happy path works), it silently voids the integrity guarantee (and a real scanner's verdict), and it comes back whenever someone "simplifies" the two keys into one.

### Reuse rule
For any user-supplied file that is verified server-side: never serve, hash-trust or scan-trust the key the client can still write to. Promote to a server-owned key, verify the promoted copy, delete the source, and add a test that replays the PUT after finalize and after submit. Never sign a PUT for the final key.

### Evidence
`packages/trust/src/service.ts` (`uploadKeyOf`, `finalizeDocument`: versioned read, conditional copy, re-hash of the promoted copy), `packages/platform/src/object-store.ts` (`readVersioned`, `copyIfVersion`), the `Provider verification` smoke scenario (replays the PUT after finalize and compares the reviewers' download with the hashed bytes), `packages/trust/src/trust.itest.ts` (replayed PUT tests).

## LRN-0057 — A `pnpm dev` worker on the host shares the pg-boss queue with the container worker and makes the "Worker runtime" smoke check flaky

Date: 2026-10-18
Checkpoint: TRUST-001
Domain: infrastructure / testing
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/infrastructure/SKILL.md

### Context
After the user's `pnpm dev` shells were started, the smoke started failing intermittently: `Worker runtime` reported a failed pg-boss job, and when it did, the worker diagnostics call took the full 8 s self-test timeout, aborted the smoke's own 8 s request, and 13 of 42 checks failed with "worker: no result" (a cascade from one cause). The host process (`tsx watch` of `apps/worker`, `.env.host`) uses the SAME Postgres, and pg-boss delivers each job to one of the workers that poll the queue, so about half of the `infra.ping` jobs were handled by the host worker, whose in-memory "seen" map is not the container's.

### Learning
Two workers on one database are a competing-consumers setup: any check that sends a job and waits for THAT process to handle it is a lottery while both run. The failure looks like a platform regression (many unrelated checks fail at once) but is environmental.

### Why it matters
It costs a re-run per occurrence and tempts people to "fix" the worker or to weaken the check. CI runs one worker and is unaffected.

### Reuse rule
When `Worker runtime` fails and nothing about the worker changed, look for a host-run worker (`ps`, `lsof -i :3102`, the pnpm dev shells) before touching code; re-run (it passes about half of the time) or stop the host worker, but never terminate a shell you do not own without asking. Any new job-based check must be written so that it does not depend on WHICH worker handles the job.

### Evidence
The `Worker runtime` check in `apps/smoke/src/index.ts` and `apps/worker/src/worker.ts` (`selfTest`); a host `tsx watch` worker (`pnpm dev`) next to the container `worker-service` on the same database; the TRUST-001 smoke runs that failed 13 of 42 checks and then passed on re-run without a code change.

## LRN-0058 — Ajv coerces JSON bodies that are declared in the route schema: a strict zod pre-check does not protect a handler that reads `req.body`

Date: 2026-10-18
Checkpoint: CAT-003
Domain: api
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
The Gig draft body carries field values that are a union (`string | integer | boolean | null`). The routes validate the RAW body with a strict zod schema in `preValidation` (`strictBody`) and then read `req.body` in the handler. Fastify's Ajv runs with coercion for bodies declared in the OpenAPI schema, so by the time the handler ran, `3` had become `"3"`, `true` had become `"true"` and `null` had become `""`. The strict check had passed on the original values, so nothing flagged it.

### Learning
`strictBody` proves the request was valid; it does not make `req.body` the value that was proved. For any body whose schema has a union, a nullable scalar or a number, the handler must read the contract's PARSED copy that the pre-check produced, never `req.body`. The other modules (configuration, content, provider registration) are safe only because their bodies hold no unions (DEBT-0043 still lists the coerced integers and booleans of the management routes).

### Why it matters
A coerced value can change the meaning of a stored value silently (a boolean field becoming the text "true", a cleared value becoming an empty string) and the strict check gives false assurance.

### Reuse rule
In a new route with a typed body, store the pre-check's parse result (see `strictParsed` / `bodyOf` in `apps/api/src/modules/provider/gig-routes.ts`) and have the handler use it. Add a unit test that sends `3`, `true` and `null` as values and asserts the service receives exactly those.

### Evidence
`apps/api/src/modules/provider/gig-routes.ts` (`strictParsed`, `bodyOf`); the CAT-003 unit and integration tests that send mixed-type field values; the coercion observed by the API agent before the fix.

## LRN-0059 — A guard trigger that locks another domain's rows must take them in that domain's own lock order

Date: 2026-10-18
Checkpoint: CAT-003
Domain: database
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/database/SKILL.md

### Context
The Gig version guard read the exact template version `FOR SHARE` and then the template `FOR SHARE`. The catalogue service retires a template by locking the template `FOR UPDATE` and then its ACTIVE version `FOR UPDATE`. A publish and a template retirement running together deadlocked (SQLSTATE 40P01); the independent review reproduced it with two sessions. The Gig side maps 40P01 to a retryable conflict, so nothing was corrupted, but the victim was not controlled.

### Learning
Lock order is a contract of the OWNING domain. A guard that locks rows of another schema must follow the owner's order (parent before child: template, service type, then version), and it should lock only when the operation can depend on those rows (a version insert and a publication, not a draft save).

### Why it matters
A deadlock between a provider action and a staff action is rare enough to miss in review and in tests that run one side at a time, and it is expensive to find in production.

### Reuse rule
Before writing a guard that locks catalogue (or any foreign) rows, read the owner's service for the order in which it locks them and copy it. Add a model test where the owner's transaction holds the parent `FOR UPDATE`, the guarded statement waits, and the owner then requests the child: it must finish without 40P01 (see the lock-order test in `packages/testing/src/gig-model.itest.ts`).

### Evidence
`provider.guard_gig_versions` in `db/migrations/0020_provider_gigs.sql`; `GigTemplateService.setGigTemplateStatus` in `packages/catalog/src/gig-template-service.ts`; the lock-order cases in `packages/testing/src/gig-model.itest.ts`.

## LRN-0060 — A validation regex on provider text must be linear: adjacent `\s*` quantifiers turn 80 KB of spaces into 13 seconds of blocked event loop

Date: 2026-10-18
Checkpoint: CAT-003
Domain: api / security
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/api/SKILL.md

### Context
The markup check for provider text was `/<\s*\/?\s*[A-Za-z!?][^>]*>?/`. A description of `"a<"` followed by 79,990 spaces and a digit stays valid under the request schema (the body is about 80 KB) and takes the regex quadratic time: 13 s measured, on the main thread, blocking every other request. Single-line fields were safe only because their whitespace is collapsed first.

### Learning
Any regex that runs on text a user controls must have no adjacent quantifiers that can match the same characters (`\s*\/?\s*`) and no nested quantifiers. A test with a hostile 80,000 character input and a time budget is the only reliable check; a lint rule does not catch it.

### Why it matters
It is a one-request denial of service for the whole API process, available to any signed-in user.

### Reuse rule
Write user-text regexes so that each position is matched by one alternative (`/<[\s/]*[A-Za-z!?]/`), pre-cap the length before matching where possible, and add a regression test that feeds the validator spaces, slashes and repeated opener sequences and asserts it finishes in a fraction of a second.

### Evidence
`packages/contracts/src/gig.ts` (`HTML_TAG`) and the hostile-input tests in `packages/contracts/src/gig.test.ts` and `packages/provider/src/gig.test.ts`; the measured 13 s in the CAT-003 security review.

## LRN-0061 — The database container's clock drifts from the host's: an integration test must not compare a database timestamp with the host's `Date.now()` at millisecond precision

Date: 2026-10-18
Checkpoint: CAT-003
Domain: testing
Status: ACTIVE
Supersedes: none
Related ADR: none
Related skill: skills/testing/SKILL.md

### Context
`pnpm checkpoint:finalize CAT-003` failed twice in the integration step on `packages/content/src/content.itest.ts` (`expected 1792289931795 to be less than or equal to 1792289931794` and a "closed in the past" case), while the same suite passed 7713 of 7713 when run alone, twice. Measured afterwards: the PostgreSQL container's `clock_timestamp()` was about 20 ms AHEAD of the host clock (Docker's VM drifts and resynchronises), so a version published "now" by the database could carry a start time later than the host's `Date.now()` taken a few milliseconds afterwards. Nothing in CAT-003 touched the content package.

### Learning
Two clocks are in play in every integration test: the host (Node) and the database container. Their offset changes with the machine's load and sleep state, so a test that passes alone can fail inside a long run. CI runs both on one clock and is unaffected.

### Why it matters
A flaky check at the end of a 15 minute finalize costs a full rerun and tempts people to retry until green instead of finding the cause.

### Reuse rule
Compare database timestamps with each other (or build the instant in SQL with `clock_timestamp()`), or give a host comparison a generous tolerance (`CLOCK_SKEW_MS` in the content tests); never assert `dbTimestamp <= Date.now()` or build "a moment ago" from `Date.now()` and feed it back to a database guard that uses its own clock.

### Evidence
`packages/content/src/content.itest.ts` (`CLOCK_SKEW_MS` and the SQL `clock_timestamp()` form); the measured offset of about 20 ms between `docker exec ... clock_timestamp()` and the host; the two failed finalize runs and the two clean standalone runs.
