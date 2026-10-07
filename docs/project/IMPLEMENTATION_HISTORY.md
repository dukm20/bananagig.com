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


## CI-001 — 2026-10-05

Status: COMPLETE
Commit: find it with `git log --grep "(CI-001)"`.
Summary: Corrective checkpoint. The first GitHub Actions run (2026-10-06 UTC, commit 17b6b8d) failed at `pnpm audit --prod` because of a low `@babel/core` advisory (GHSA-4x5r-pxfx-6jf8). It was resolved with a scoped pnpm override, without relaxing the audit gate. No application behavior, business logic, schema or migration changed.

### Delivered
- `pnpm-workspace.yaml`: override `"@asyncapi/generator-react-sdk>@babel/core": "^7.29.6"`; `pnpm-lock.yaml` now holds a single `@babel/core` 7.29.7 (was 7.12.9, exact-pinned by the AsyncAPI generator)
- `docs/security/SCAN_RESULTS.md`: CI-001 section with advisory, ranges, resolution and rationale; historical findings kept
- `scripts/governance.test.mjs`: the malformed-debt test no longer depends on DEBT-0001's exact wording (test-only change; it broke when that entry was rewritten)
- DEBT-0001 (CI now executed, still IN_PROGRESS) and DEBT-0007 (babel finding resolved) updated; LRN-0018; `skills/infrastructure` lesson

### Finding recorded
The advisory was not new: it was already listed as accepted dev tooling at INF-002. CI had never run, so the audit gate's nonzero exit was never enforced until the first push. The "production" classification came from next's optional `styled-jsx` peer resolving to the dev tooling's pinned copy.

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None. OpenAPI and AsyncAPI are unchanged (`pnpm specs:check` passes without regeneration).

### Tests
Unit 116, root script tests 59, integration 133, smoke 28 checks (all unchanged). `pnpm audit --prod`: no vulnerabilities. Rebuilt images: 0 HIGH/CRITICAL (Trivy).

### Skills updated
`skills/infrastructure` (one lesson bullet).

### ADRs
None required.

### Known follow-up
DEBT-0001 stays open until the governance and compose-smoke jobs have run green remotely and branch protection exists.


## CFG-001A — 2026-10-06

Status: COMPLETE
Commit: find it with `git log --grep "(CFG-001A)"`.
Summary: Corrective follow-up to CFG-001 that was already present as uncommitted changes in the working tree when CFG-002 began (not written in this session). It tightens error mapping and outbox actor attribution and fixes a documentation error about context keys. No schema, contract or API surface change.

### Delivered
- `ConfigurationService`: Postgres CHECK violations (`23514`) map to `VALIDATION_FAILED` and keep the constraint name; `value()` throws a typed `NO_VALUE` error instead of dereferencing a missing result; the scheduled-activation outbox event records `actor_type = 'system'` (was `user`)
- `validateDefinitionRules` reuses the cached schema validator, so a JSON schema with an `$id` can be validated more than once
- Documentation: `CONFIGURATION.md` and `skills/configuration` now show the real context keys (`{ market: id }`, lower-case) and the actual three resolver queries
- Tests: CHECK-violation mapping, `NO_VALUE` from `value()`, `actor_type = 'system'` on activation events, `$id` validator reuse; an API snapshot test now requests a real snapshot id

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None. OpenAPI and AsyncAPI are unchanged.

### Tests
Unit 117 (configuration 26), root script tests 59, integration 134 (configuration 47), all passing.

### Skills updated
`skills/configuration`: context-key example corrected.

### ADRs
None required.

### Known follow-up
None.


## CFG-002 — 2026-10-06

Status: COMPLETE
Commit: find it with `git log --grep "(CFG-002)"`.
Summary: Content and localization registry. Managed product copy lives in the database as stable keys with localized, effective-dated, immutable versions, a deterministic locale fallback, a restricted non-executable template language, a sanitized Markdown-subset renderer, legal documents with a hash for future consent records, immutable snapshots, audit, transactional-outbox events, a cached batch resolver with last-known-good for non-critical entries, a protected management API, a worker activation job and a web utility. Only 8 shell strings were seeded and moved (en-US); no business defaults, prices, policies, legal text or invented translations.

### Delivered
- Migration `0005_content_registry.sql`: schema `content`, 8 tables (`locales`, `entries`, `entry_variables`, `versions`, `version_approvals`, `snapshots`, `snapshot_items`, `audit_events`), a lifecycle state machine and immutability enforced by guard triggers, an exclusion constraint against overlapping published versions per (entry, locale, scope), legal policy CHECK (LEGAL entries are owner LEGAL, SECOND_APPROVER, CRITICAL, EXACT), reuse of `configuration.scope_levels`
- Migration `0006_content_seed_shell_copy.sql`: seeds 8 shell entries (brand name and tagline, sign-in and sign-out labels, session status and sign-in error, home confirmation) through the real lifecycle with five audit rows each; emits no outbox events
- `packages/content` (new): locale canonicalization and fallback, formatter for 9 variable types (BigInt money, Intl), restricted template language with plural, zero-dependency markup renderer with link allow-list and an allow-list HTML verifier, resolver (3 queries per batch), cache and last-known-good, service with the full lifecycle, snapshots and activation
- `packages/configuration`: `ValkeyConfigCache` gained a per-command timeout and a circuit breaker (also protects the configuration registry)
- `packages/contracts`: content contracts, `canonicalizeLocale`, four events
- API module `/api/v1/content` (15 endpoints), `requireContentPermission`, `content-legal` gating, public resolve with visibility rules, router-level errors in the standard envelope, `maxParamLength` 192
- Worker job `content.activate-due` (cron, every minute, idempotent, `SKIP LOCKED`)
- Keycloak: client roles `content-read`, `content-write`, `content-approve`, `content-legal` on `bananagig-admin`, mapped to both dev admins
- Web: content utility with locale negotiation against the active locales, home and session pages registry-backed, bootstrap policy `BOOTSTRAP_COPY`
- Smoke: "Content Registry" scenario (29 checks)
- Docs: `docs/engineering/CONTENT.md`, `docs/content/CONTENT_OWNERSHIP.md`, data-model documents, ADR-0018 to ADR-0020, skill `skills/content`
- Quality process: four independent adversarial reviews (security, database and concurrency, compliance, API/cache/web); every verified finding was fixed with a regression test, including a Valkey-outage slowness, an INTERNAL-entry existence leak, unbounded anonymous cache keys, a missing activation event for due scheduled predecessors, quadratic authoring validation and several lows (see LRN-0019 to LRN-0022)
- Also: a corrective `CFG-001A` commit (separate) tightened configuration error mapping before this checkpoint

### Schema
New schema `content` (8 tables); see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (CFG-002), including the recorded BCNF exceptions (policy copy, trigger-computed hash, repeated entry id enforced by composite keys) and the index review. No existing table changed. `docs/design/` (brand kit) is excluded from tooling through `.git/info/exclude` and is not part of this checkpoint.

### Contracts
OpenAPI: 15 content operations (15 warnings remain on system and configuration paths, none on content). AsyncAPI: `bananagig.content.version-approved|version-scheduled|version-published|legal-document-published.v1`.

### Tests
Unit 1035 (content 725, contracts 88, api 82, web 67, configuration 35, identity 20, worker 10, config 6, observability 2), root script tests 61, integration 236 in 14 files, smoke 29 checks. The real-Valkey integration tests ran (Valkey was reachable).

### Skills updated
New `skills/content`; updated `configuration`, `web`, `api`, `database`, `worker`, `testing`; CLAUDE.md reading list.

### ADRs
ADR-0018 (content registry model and the `content` schema), ADR-0019 (restricted template formatter and markup renderer), ADR-0020 (locale fallback, cache, last-known-good and bootstrap).

### Known follow-up
DEBT-0026 to DEBT-0030 and extensions to DEBT-0022 and DEBT-0024. LRN-0019 to LRN-0022. GEO-001 supplies the market default locale that callers currently pass in the resolution context.


## CI-002 — 2026-10-06

Status: COMPLETE
Commit: find it with `git log --grep "(CI-002)"`.
Summary: Corrective checkpoint. The first CI run for CFG-001A and CFG-002 (run #3) failed in the `Governance checks` step: CI runs `data-model:check` with the real previous head as base and no checkpoint id, and the check demanded an id because migration 0005 changed the schema. The git-diff rules had never run in CI before (the first run had an empty base) nor locally against a real base. No application behavior, schema or migration changed.

### Delivered
- `scripts/data-model-check.mjs`: without an id, infers the checkpoint id(s) from the `<type>(<ID>)` subject of every commit in `base..HEAD` that added a migration, verifies each id's normalization and changelog entries (and that the changelog names that commit's migrations), and fails a migration-adding commit whose subject has no id
- `scripts/lib/governance.mjs`, `data-model-check.mjs`, `project-state-check.mjs`: an explicit `--base` that is not a commit is an error once the repository has commits (it previously selected baseline mode silently); the first-commit flow is unchanged
- `scripts/governance.test.mjs`: five regression tests (id inference with a complete review, missing review entries, missing id in the subject, unresolvable base for both checks); all five fail against the previous scripts
- Documentation: `docs/engineering/COMMIT_POLICY.md` (the checkpoint id in commit subjects is load-bearing), `skills/testing` lesson, LRN-0023

### Finding recorded
The failure was in the CI workflow's use of the check, not in application code: everything before the governance step passed in CI (format, lint, typecheck, unit tests, specs, build, integration tests, audit). `compose-smoke` was skipped because it depends on `verify`.

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None.

### Tests
Unit 1035, root script tests 66 (governance 42, identity realm 23, migration files 1), integration 236, smoke 29 checks (unchanged except the governance suite).

### Skills updated
`skills/testing` (one lesson bullet).

### ADRs
None required.

### Known follow-up
`compose-smoke` (including Trivy) has not yet run for the content registry; it runs after `verify` passes on the next push.


## CI-002A — 2026-10-06

Status: COMPLETE
Commit: find it with `git log --grep "(CI-002A)"`.
Summary: Corrective hardening of the CI-002 checkpoint-id inference, found by review after CI-002 was pushed and CI went green. No application behavior, schema or migration changed.

### Delivered
- `scripts/data-model-check.mjs`: inference counts only migrations that are in the final `base..working tree` diff (a migration added and removed inside the range no longer attributes to its original checkpoint), compares merge commits against each parent (`diff-tree -m`), and matches review headings on the whole checkpoint id or an id followed by whitespace, so `## CFG-001A` no longer satisfies a check for `CFG-001` (the old prefix match was also used for explicit ids)
- `scripts/governance.test.mjs`: three regression tests (heading boundary, migration removed within the range, merge-commit migration); governance suite 45 tests

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None.

### Tests
Unit 1035, root script tests 69 (governance 45, identity realm 23, migration files 1), integration 236, smoke 29 checks. The CI-equivalent `data-model:check` against the range that failed in CI (`14db38d..HEAD`) still passes.

### Skills updated
None (the testing-skill lesson from CI-002 already covers running the governance step as CI does).

### ADRs
None required.

### Known follow-up
None.


## GEO-001 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(GEO-001)"`.
Summary: Geography foundation as data: countries, currencies, time zones and markets with deterministic market defaults, database-enforced activation rules, an extensible readiness registry, protected management and public read APIs, six outbox events, and integration with the configuration and content registries. `content.locales` stays the single locale authority. Only US reference data and one PLANNED market (`la-oc`) were seeded; no address, geocoding, service-area, search, booking or tax behavior.

### Delivered
- Migration `0007_geography_registry.sql`: schema `geography` with 8 tables (`currencies`, `time_zones`, `countries`, `country_locales`, `country_time_zones`, `markets`, `market_locales`, `audit_events`); `content.locales` gained `display_name` and generated `language`, `script`, `region`; guard triggers for immutability, a status machine (PLANNED is initial only), activation dependencies (country: ACTIVE currency, default locale and at least one time zone; market: ACTIVE country, currency, time zone and locale), protected removal of an ACTIVE country's links, a cross-schema guard on locale deactivation; every guard RAISE carries a machine-readable `geography_rule:<KEY>`; seeds: USD, four US time zones, the US display name as managed content (through the real content lifecycle), country US (ACTIVE), market `la-oc` named "LA & OC" (PLANNED, inert until the owner activates it; a business assumption awaiting owner confirmation)
- `packages/geography` (new): `GeographyService` (reads with management/public views, `resolveMarketDefaults`, audited management writes, idempotent activation, replace-set semantics), the readiness registry (`registerReadinessCheck`), generation-based cache with bounded I/O, `createGeographyScopeReferenceValidator` and `createMarketDefaultsProvider` (structural ports, no imports of the content package)
- `packages/configuration` and `packages/content`: the `ScopeReferenceValidator` port (COUNTRY and MARKET references validated at creation and publish, fail closed, canonical forms: ISO alpha-2 upper case, market code lower-case kebab) and the `MarketDefaultsProvider` port (the market default locale is derived and merged into the context before hashing, caching and snapshots; public callers never see copy for a market that is not visible); locale DTOs gained display name and derived parts; the resolver's batch order is deterministic
- API `/api/v1/geography`: public reads (ACTIVE data, public fields, `Vary: Authorization`, `effectiveTo` hidden) and management routes (admin context, `geography-read` and `geography-write`, write implies read), strict raw-body validation before ajv coercion, input hardening for names and reasons
- Keycloak client roles `geography-read` and `geography-write`; smoke scenario "Geography" (30 checks) and the Configuration scenario now uses the seeded market
- Docs: `docs/engineering/GEOGRAPHY.md`, skill `skills/geography`, ADR-0021 (geography reference-data model and locale authority) and ADR-0022 (cross-domain reference integrity through ports), data-model documents
- Quality process: four independent adversarial reviews (security, database and concurrency, API and delivery, compliance) plus the data-model documentation review; every verified finding was fixed with a regression test (including a stale-read bug of `FOR UPDATE` on joined selects, two time-zone invariant races, a lock-order deadlock, a content-visibility leak for non-visible markets, and CI-breaking web fixtures); see LRN-0024 to LRN-0027
- Housekeeping inside this checkpoint (requested at its start): the PROJECT_STATE CI line now records that CFG-002 was fully verified in GitHub CI (run #4)

### Schema
New schema `geography` (8 tables) and an extension of `content.locales`; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (GEO-001), including the recorded denormalizations (`market_locales.country_id` enforced by composite foreign keys, which is a 2NF and BCNF exception) and the index review. `docs/design/` is excluded from tooling and not part of this checkpoint.

### Contracts
OpenAPI: 14 geography operations. AsyncAPI: `bananagig.geography.country-activated|country-deactivated|market-created|market-activated|market-deactivated|market-defaults-changed.v1` (deactivation events only for ACTIVE to INACTIVE).

### Tests
Unit 1221, root script tests 71, integration 385 in 18 files, smoke 30 checks (run twice for idempotency). Real Valkey integration tests ran (Valkey reachable).

### Skills updated
New `skills/geography`; updated `api`, `configuration`, `content`, `database`, `testing`, `web`; CLAUDE.md reading list.

### ADRs
ADR-0021, ADR-0022.

### Known follow-up
DEBT-0031 to DEBT-0034, DEBT-0024 (in progress), DEBT-0030 applies to public geography reads. LRN-0024 to LRN-0027. GEO-002 will bring address formats and structured addresses; the market default time zone can then be overridden per service address (DEBT-0034).


## CI-002B — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(CI-002B)"`.
Summary: Corrective hardening of the checkpoint-id inference in `data-model:check` (second round, after CI-002A), found while GEO-001 was being committed. The edits were made outside the checkpoint tooling by the repository owner and were kept out of the GEO-001 commit; they are committed here at the owner's request. No application behavior, schema or migration changed.

### Delivered
- `scripts/data-model-check.mjs`: each migration file in the final base diff is attributed to exactly one checkpoint, the newest commit that added the surviving file, so a migration that was added, deleted and re-added inside the pushed range is not counted twice or credited to an earlier checkpoint
- `scripts/governance.test.mjs`: regression test "attributes a deleted and re-added migration only to the checkpoint that added the surviving file"

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None.

### Tests
Unit 1221, root script tests 71 (governance 46, identity realm 24, migration files 1), integration 385, smoke 30 checks (unchanged). The CI-equivalent `data-model:check` against the GEO-001 range (`40ec528..HEAD`, no checkpoint id) passes.

### Skills updated
None (the testing-skill lesson from CI-002 already covers running the governance step as CI does).

### ADRs
None required.

### Known follow-up
None.


## CI-003 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(CI-003)"`.
Summary: Corrective checkpoint. CI run #5 (`b55713d`: CI-002A, GEO-001, CI-002B) failed in `pnpm test` on a wall-clock assertion. The fix and several small refinements that were in progress in the working tree are committed together at the owner's request. No schema, migration or public API change.

### Delivered
- `packages/content/src/template.test.ts`: the "198 plural constructs validate in under 3 s" assertion (3.6 s on the runner, 0.3 s locally) is replaced by the deterministic render count (exactly 6 renders versus 198 x 6 + 1 for the old per-construct loop); `packages/content/src/markup.test.ts` and the parse test in `template.test.ts`: the catastrophic-backtracking ceilings are widened to 15 s and 10 s (a real regression takes minutes)
- `packages/contracts/src/text.ts` (new): the shared `adminText` helper extracted from the geography contracts (control, bidi-override and unpaired-surrogate characters, blank values); `geography.ts` re-exports it and `content.ts` applies it to the locale display name (`RegisterLocaleRequest.displayName`), with contract tests
- `packages/geography/src/service.ts`: a lock timeout (SQLSTATE `55P03`) is mapped, like a deadlock, to the retryable CONFLICT `CONCURRENT_UPDATE`, with a test that also checks the message never leaks the driver text
- `apps/smoke/src/index.ts`: a shared `ensureDevtestGeography` helper (private-use locale `qaa` and DEV/TEST country `ZZ`); the Configuration Registry scenario now creates its own devtest market instead of using the seeded `la-oc`, so activating or retiring the seeded market can no longer break smoke
- `apps/api/src/geography-integration.itest.ts`: a test regex updated for the real country codes used there
- Docs: LRN-0028, DEBT-0035, testing skill lesson

### Finding recorded
Four attempts to reproduce the failure locally (a clean Linux container with the same Node and ICU, twice with a 2-CPU limit, and once with CI=true and a POSIX locale) all passed; the failing assertion was identified from the public check-run annotations of the failed job. The final tree also passed twice in a 1-CPU container.

### Schema
None. No migration. Data model: NOT_REQUIRED.

### Contracts
None changed in the generated specs (`pnpm specs:check` passes without regeneration).

### Tests
Unit 1221, root script tests 71, integration 385 in 18 files, smoke 30 checks (run twice on the rebuilt stack).

### Skills updated
`skills/testing` (one lesson bullet).

### ADRs
None required.

### Known follow-up
DEBT-0035 (the cache tests still assert real elapsed time against their own small deadlines). CI-003 has to run green on GitHub before this checkpoint is considered verified in CI.


## GEO-002 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(GEO-002)"`.
Summary: The address model and address format engine: country-driven, versioned address formats whose fields, labels, requirement, lengths, input types, patterns and display template are data, administrative areas, one canonical immutable structured address (also the future booking snapshot), a pure validator and formatter shared by server and clients through one read model, a manual-entry fallback marked for review, provider-neutral autocomplete, geocoder and verification ports with mocks, and privacy rules from the start. No provider service areas, profile screens, geospatial search, booking, tax, map UI, vendor selection or admin UI.

### Delivered
- Migration `0008_address_model.sql`: `geography.administrative_areas`, `address_formats` (DRAFT to PUBLISHED, half-open effective window, gist exclusion constraint against overlapping published periods, open end closable once), `address_format_fields` (ordered rows, labels are content keys), `addresses` (immutable rows; composite foreign keys keep the area and the format version in the address country; status and source CHECKs; one `geography(Point,4326)`; `raw_input` JSON), guard triggers with `geography_rule:<KEY>` details, `audit_events` widened for format and area actions; seeds: 51 US areas, US format v1, 12 content entries (field labels with US-scoped overrides "State" and "ZIP code", validation messages), all through the real lifecycles
- `packages/geography`: the pure address engine (`address-engine.ts`: normalization, pattern vetting, validation with all issues, `validateFieldValue` for postal codes in lists, the one formatter, template checks, `redactAddress`), `AddressService` (cached public reads, validate, format, manual / autocomplete / geocoder persistence flows with fallback, `getAddress` for owning domains, format drafts, publication serialized on the country row with `clock_timestamp()`, area upsert, audit and outbox, cache invalidation), the provider ports and mocks, and the `ADDRESS_FORMAT` market readiness check
- Contracts `address.ts`; two events `bananagig.geography.address-format-published.v1` and `administrative-areas-updated.v1`; error code `ADDRESS_FORMAT_NOT_FOUND`; log redaction of address, postal, zip, coordinate and raw-input keys (fails closed beyond its depth)
- API (8 operations): public `GET /countries/:code/address-format`, `GET /countries/:code/administrative-areas`, stateless `POST /addresses/validate` and `/addresses/format` (no-store, 16 KiB limit); management `GET` and `POST /countries/:code/address-formats`, `POST .../:version/publication`, `POST /countries/:code/administrative-areas`. No route creates or reads a persisted address
- Web API client methods for the format, areas, validate and format; smoke scenario "Addresses" (31 checks) and a ZZ address format published by the smoke so the readiness check lets its devtest market activate
- Docs: `docs/engineering/ADDRESSES.md`, ADR-0023 (canonical immutable address and data-driven format), ADR-0024 (provider-neutral boundary and privacy), data-model documents, skills `geography`, `database`, `api`
- Found by reading the PRD (a .docx, SV-10) after the first design: manual entry is UNVERIFIED for review, area code and name are stored, form and server share message keys, and a second country needs no deployment (hence the area management API); LRN-0029
- Review fixes before closing: a provider's "unknown suggestion" answer was mistaken for an outage, the raw-input size check disagreed with the table CHECK, the country-name resolver ignored management previews, redaction passed deep structures through, pasted tabs and line breaks were rejected instead of collapsed

### Schema
Four new tables in `geography` and a widened `geography.audit_events`; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (GEO-002), including why there is no `postal_code_rules` table, no snapshot table and no separate latitude and longitude columns.

### Contracts
OpenAPI: 8 address operations (valid, 15 pre-existing warnings). AsyncAPI: `address-format-published` and `administrative-areas-updated`.

### Tests
Unit 1524, root script tests 71, integration 507 in 21 files, smoke 31 checks (run twice). Real Valkey integration tests ran.

### Skills updated
`skills/geography`, `skills/database`, `skills/api`.

### ADRs
ADR-0023, ADR-0024.

### Known follow-up
DEBT-0036 to DEBT-0042 (retention and exact-location access, provider vendor and per-country selection, phone rules, admin UI, US-only data, market to area link, pattern isolation); DEBT-0032 and DEBT-0034 in progress; LRN-0029 to LRN-0031. Owner decision still open: confirm or remove the seeded PLANNED market `la-oc`.


## GEO-002A — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(GEO-002A)"`.
Summary: Corrective checkpoint for two verified GEO-002 gaps before GEO-002 is pushed: a display template with a bracketed field rendered malformed punctuation when a field was missing, and the `:version` path parameter accepted non-canonical numbers. No new address feature, no schema change.

### Defects reproduced
- Formatter: `{LOCALITY} ({ADMINISTRATIVE_AREA})` with only the area rendered `CA)` (the closing bracket belonged to the last token, the opening one to the following token).
- Path parameter: Ajv coercion read `1e3` and `1e2` as 1000 and 100, `1.0`, `+1`, `01` and ` 1` as 1, `0x10` as 16 and `Infinity` as `null` for `POST /countries/:code/address-formats/:version/publication`.

### Delivered
- Formatter (`packages/geography/src/address-engine.ts`): a token may be wrapped in brackets written directly around it, `({FIELD})` or `[{FIELD}]`; the brackets belong to that field and are written only with it, and only when it starts the line or an earlier field is present. Text still belongs to the following token. Templates without brackets render identically (a 6,000-case differential test against a frozen copy of the old renderer, plus 200,000 cases in the review); `templateProblem` refuses any bracket that does not wrap exactly one field (an earlier design that matched bracket pairs across fields was dropped after all-subsets tests produced `Acme( [CA])`); `addressLine1` null or undefined is treated as absent
- Strict integers: one parser `parseDecimalInteger` (`packages/contracts/src/integer.ts`: canonical base-10 only, at most 15 digits, checked lexically before conversion), the `strictIntegerParams` preValidation hook and the fail-closed start-up guard `enforceStrictIntegerParams` (`apps/api/src/plugins/strict-params.ts`; refuses an unguarded numeric `params` or `querystring` property, a numeric type outside `properties`, and any `$ref`), `integerParamSchema` documents the bounds and syntax in OpenAPI; the address publication route uses them; rejections are the standard `VALIDATION_FAILED` envelope with `params.version` and a fixed message
- Smoke: the Geography scenario now proves on the running stack that `1e3`, `1.0`, `01`, `+1` and `0x10` are rejected with the standard envelope (`params.version`) and that re-publishing format 1 is an idempotent no-op
- The intentional refusal of backreference-like pattern text (including `\\1`) is documented and pinned by a test; `la-oc` untouched and PLANNED; DEBT-0030 kept OPEN with a note that the public address endpoints are not production-exposure-ready
- Independent verification workflow (11 agents): an oracle fuzz of the formatter (340,000 cases, no mismatch), an HTTP bypass attack of the parser (about 140 encodings, none reached the service), a regression review (identical output for bracket-free templates), then a verifier per finding; confirmed and fixed: the guard did not see `$ref` or composition keywords, `addressLine1` null, an unproven documentation claim (now a real test); confirmed and recorded as DEBT-0043: body coercion on the configuration and content routes

### Schema
None. No migration, no change to `docs/data/SCHEMA_SNAPSHOT.sql`. Data model: NOT_REQUIRED (formatter and API input-validation corrective checkpoint).

### Contracts
OpenAPI: the `version` path parameter gained a description (valid, 15 pre-existing warnings). AsyncAPI unchanged.

### Tests
Unit 1716, root script tests 71, integration 507 in 21 files, smoke 31 checks (run twice).

### Skills updated
`skills/geography`, `skills/api`, `skills/testing`.

### ADRs
None required (no architecture change).

### Known follow-up
DEBT-0043 (body coercion on configuration and content routes); DEBT-0030 stays OPEN; LRN-0032 and LRN-0033. Push GEO-002 and GEO-002A together and verify GitHub CI.


## ID-001 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(ID-001)"`.
Summary: The canonical BananaGig application identity model: the account of a person linked to a verified Keycloak identity, application roles with membership and a role-switch context, an account status machine with an immutable history, a core profile, audit and domain events, and the account API with the web session page. Keycloak stays the only owner of authentication, credentials, MFA, protocol sessions and tokens; nothing of those is stored. No onboarding UI, email or phone verification, password recovery, consent, billing, photos, provider business or admin invitation.

### Housekeeping at the start (requested)
`PROJECT_STATE` records that GitHub Actions run 37587370637 (`566b28c`, pushed with `e4234e9`, so GEO-002 and GEO-002A) passed: `verify` and `compose-smoke`, every step, including `pnpm smoke` and the Trivy image scan. `la-oc` stays PLANNED and DEBT-0030 stays OPEN (the public address endpoints are not production-exposure-ready).

### Delivered
- Migration `0009_identity_accounts.sql`: schema `identity` with 7 tables (`roles`, `accounts`, `account_roles`, `external_identities`, `account_status_history`, `account_profiles`, `account_audit_events`), guard triggers with `identity_rule:<KEY>` details, a primary role pointer as a composite foreign key to the account's own membership, deferred constraint triggers that keep the current status equal to the newest history row in both directions, seeds: roles CUSTOMER and PROVIDER and 17 content entries (role names, status labels, session account labels, name and account-state messages). No account is seeded.
- `packages/accounts` (new, `@bananagig/accounts`): `AccountService` (provisioning from a verified identity with the unique key deciding races, idempotent `grantRole`, `deactivateRole`, `setPrimaryRole`, `selectActiveRole`, `changeStatus`, `upsertProfile`), the pure helpers (identity key, one-time bootstrap roles, active-role resolution), typed errors with guard classification by key only.
- Contracts `account.ts` (statuses and the transition table, role code, name rules and `validateProfileName`, `publicDisplayName`, account read model, requests, five identity events); config `IDENTITY_LAST_SEEN_TOUCH_SECONDS`.
- API (3 operations under `/api/v1/account`): `GET /me`, `POST /active-role`, `PUT /profile`; the `requireAccount` guard (verified token to account, 403 for the admin and other contexts, SUSPENDED and CLOSED refused, the active role from `x-active-role` validated against ACTIVE memberships on every request, no client-supplied account id or role anywhere, no endpoint that grants a role); `Cache-Control: no-store`; a shared `strictBody` replacing three copies. OpenAPI valid; AsyncAPI gained five identity events.
- Web: server session `activeRole`, BFF `POST /auth/active-role` (same-origin, session cookie, validated by the API, no token in the browser, no new Keycloak login), `/session` shows the account id, status, roles and active role from managed content keys; web client methods.
- Smoke scenario "Accounts" (32 checks): real PKCE login as customer.dev, stable account id, CUSTOMER role, PROVIDER granted through the service, role switch, header validation, admin 403, no token or subject in any response.
- Docs: `docs/engineering/ACCOUNTS.md`, ADR-0025 (application account and Keycloak identity separation) and ADR-0026 (account-role membership and active role context), data-model documents, skills `identity`, `database`, `api`, `web`, `testing`, `docs/content/CONTENT_OWNERSHIP.md`.
- Quality process: unit, database and service integration, API integration, web and smoke tests written by independent workers with mutation checks on the service; review fixes applied before closing: literal bidirectional characters in a CHECK regex (the file-writing quirk, LRN-0036), the deferred history trigger read the queued row instead of the current account (found by an `it.fails` test, LRN-0035) and left a stray history row unchecked, `grantRole` validated its reason inside the transaction, `mapDbError(null)` threw, the outage log carried the driver message, a one-character display initial, closure now audits the primary role change, a PENDING role deactivation is audited but not announced, profile locale and zone reads take share locks, account routes send `no-store`.

### Decisions
- Bootstrap policy (ADR-0025): the account is created lazily at the first authenticated request of the normal web context with status ACTIVE; its initial roles are seeded ONCE from the Keycloak realm roles of that token (customer to CUSTOMER, provider to PROVIDER, none to no role), never read again; PostgreSQL is the only authority afterwards (DEBT-0044 until sign-up flows grant roles explicitly).
- Active role (ADR-0026): request-scoped context kept in the web server session, never persisted and never trusted; the preferred (primary) role is the persisted default.
- DEBT-0043: option B: the new account bodies use `strictBody` and tests prove they cannot be coerced; the debt stays OPEN for the configuration and content routes.
- DEBT-0013: evaluated again; the idempotency records table is not needed (natural uniqueness and transactional retry cover every write path); stays OPEN with that note.

### Schema
New schema `identity` (7 tables); see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (ID-001): current status with an immutable history is the one intentional denormalization (kept equal by deferred triggers); no contact data, no address ownership, no credential or token column.

### Contracts
OpenAPI: 3 account operations (valid, 15 pre-existing warnings). AsyncAPI: `bananagig.identity.account-created`, `external-identity-linked`, `account-role-granted`, `account-role-deactivated` and `account-status-changed` (v1).

### Tests
Unit 2564, root script tests 71, integration 890 in 24 files, smoke 32 checks (run twice).

### Skills updated
`skills/identity`, `skills/database`, `skills/api`, `skills/web`, `skills/testing`.

### ADRs
ADR-0025, ADR-0026.

### Known follow-up
DEBT-0044 to DEBT-0048 (bootstrap hint, closure and erasure, admin identity, account lookup cache, preferred-role endpoint and account screens); DEBT-0013, DEBT-0017, DEBT-0021, DEBT-0043 updated; LRN-0034 to LRN-0036. Owner decision still open: confirm or remove the seeded PLANNED market `la-oc`.
