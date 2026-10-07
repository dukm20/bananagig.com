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

