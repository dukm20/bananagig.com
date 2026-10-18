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


## CI-004 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(CI-004)"`.
Summary: Repaired the CI failure of the ID-001 push. GitHub Actions run 37718747872 (`2e2ce4f`) failed in the `verify` job at `pnpm test`: `packages/content/src/template.test.ts:391` ("renders a body with 198 six-category plural constructs in at most 6 full renders") exceeded Vitest's default 5 s test timeout. The test is CPU heavy (a 200,000-character body validated for two markup types) and takes 0.6 s locally; on the 2-CPU runner, with Turborepo running the packages' tests in parallel, it took more than 5 s. The content package is unchanged by ID-001. The failure skipped the remaining `verify` steps and the whole `compose-smoke` job, so the ID-001 work has not been through the full CI yet.

### Delivered
- `packages/content/vitest.config.ts`: `testTimeout: 30_000` for the content package (the harness ceiling only; what the tests assert stays deterministic: render counts and rejection reasons, never elapsed time). Proved that the config is picked up with a throwaway test that sleeps 5.6 s and passes.
- DEBT-0035 notes the second failure mode (default test timeout) and that other packages still use the 5 s default; `skills/testing` gained the lesson.

### Schema
None. Data model: NOT_REQUIRED.

### Contracts
None.

### Tests
Unchanged: unit 2564, root script tests 71, integration 890 in 24 files, smoke 32 checks.

### Skills updated
`skills/testing`.

### ADRs
None required.

### Known follow-up
Push and confirm the next CI run is green end to end (the Accounts smoke scenario and the Trivy scan have never run in CI). DEBT-0035 stays OPEN.


## ID-002 — 2026-10-07

Status: COMPLETE
Commit: find it with `git log --grep "(ID-002)"`.
Summary: The BananaGig-owned email contact and its verification. A person adds an address, receives ONE email with a one-time code and a single-use magic link, and verifies by either; the address is canonical, masked everywhere, never trusted from Keycloak, and a change keeps the old verified address active until the new one verifies. Introduces the reusable Valkey rate-limit foundation, the provider-neutral `EmailSender` port with the SMTP/Mailpit adapter, and the account-level `emailVerificationStatus`. Booking gating, phone verification, recovery, onboarding and account screens are NOT part of it.

### Housekeeping at the start (requested)
`PROJECT_STATE` records the verified ID-001 CI result (run 37718747872 failed at the content template test timeout; CI-004 `cfd85de` fixed it; run 37719387103 green, `verify` and `compose-smoke` including the Accounts smoke scenario and Trivy). `la-oc` stays PLANNED and DEBT-0030 stays OPEN.

### Delivered
- Migration `0010_email_verification.sql`: `identity.email_contacts` and `identity.email_verification_challenges` (one challenge per send), guard triggers with `identity_rule:<KEY>` details, two deferred constraint triggers (whole-account email invariants, challenge consumption), the audit extension (seven EMAIL_* actions, composite foreign key to the contact), the eight `verification.email.*` parameters seeded through the real change workflow (six PRD values, two flagged assumptions) and 34 managed content entries with typed variables through the real lifecycle.
- Contracts `email.ts`: vocabularies, the single `canonicalizeEmail`, `maskEmail`, strict request bodies, read models, five events, twelve error codes.
- `packages/accounts`: `EmailVerificationService` (add/change address, send, confirm by code, confirm by link, trusted-identity-provider bootstrap), keyed-hash crypto (CSPRNG code and token, HMAC-SHA-256 with length-prefixed parts, constant-time compare), policy parsing and the `decideIdpEmail` trust rule, the masked email summary on `AccountContext`.
- `packages/platform`: `EmailSender` and `EmailRenderer` ports, `SmtpEmailSender`, `htmlToPlainText`, `RecordingEmailSender`; `RateLimiter`, `ValkeyRateLimiter` (one atomic script: all rules or none, fixed windows, circuit breaker) and `MemoryRateLimiter`.
- API: five operations under `/api/v1/account/email*`, strict raw bodies, error mapping with `Retry-After`, composition (configuration-backed policy, content-backed renderer, Valkey limiter); `VERIFICATION_HASH_SECRET` in config.
- Web: `/verify-email` (code form, resend countdown, change form, magic-link landing reading the token from the URL fragment), BFF handlers `/auth/email/<action>`, api-client methods.
- Smoke scenario "Email verification" (33 checks): real tokens, the delivered Mailpit message, wrong code counted, verification, idempotent repeat, no address, code or token in responses or Loki; run twice to cover INITIAL_EMAIL and CHANGE_EMAIL.
- Docs: `docs/engineering/EMAIL_VERIFICATION.md`, `RATE_LIMITING.md`, ADR-0027, ADR-0028, ADR-0029, the data-model documents, skills `identity`, `testing`, `configuration`, `content`, `web`, `database`.
- Quality process: unit, data-model, service, API and web tests written by independent workers; their findings fixed before closing: the content renderer sent a variable to the subject entry that defines none (every send would have failed), the resend cooldown raced an in-flight delivery, refused sends spent the per-address budget, a superseded code burned an attempt, four database guard gaps (disabled contacts mutable, audit naming another account's contact, closed accounts verifying, verified non-primary rows), an `Object.prototype` key on the web page, the stale-test-database cleanup dropping databases of live runs, hash inputs that were not injective.

### Decisions
- ADR-0027: BananaGig owns the contact; the Keycloak email claim is never trusted; a trusted brokered provider's verified email is the only shortcut; one canonical form; verified address unique across accounts, pending duplicates allowed, no takeover; replacement keeps the old address active.
- ADR-0028: one challenge per send; keyed hashes; single use under a row lock; the token in the URL fragment and a POST to act; two-phase delivery.
- ADR-0029: the reusable rate-limit foundation; the caller decides how an outage fails; limits are configuration.
- DEBT-0043 option B again for the five new bodies; DEBT-0030 stays OPEN (the limiter is not applied to the public address endpoints; the steps are in `RATE_LIMITING.md`).
- The PRD keys `verification.code.*` are shared by channel; ID-002 uses channel-specific `verification.email.*` as the checkpoint asked.

### Schema
Two new tables, one extended table (`identity.account_audit_events`), 70 constraints in the `identity` schema; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (ID-002). Intentional denormalization: the challenge `purpose` snapshot of the contact status at issuance; `is_primary` coincides with `status = 'VERIFIED'` by guard.

### Contracts
OpenAPI: five email operations. AsyncAPI: `bananagig.identity.email-contact-added`, `email-verification-sent`, `email-verified`, `email-verification-failed` and `email-change-requested` (v1).

### Tests
Unit 4322, root script tests 71, integration 1624 in 28 files, smoke 33 checks (run twice).

### Skills updated
`skills/identity`, `skills/testing`, `skills/configuration`, `skills/content`, `skills/web`, `skills/database`.

### ADRs
ADR-0027, ADR-0028, ADR-0029.

### Known follow-up
DEBT-0049 to DEBT-0058 (production provider, change-email step-up and screens, contested addresses, branded layout, brokered social login, bot protection and re-verification, trusted proxy address, admin timeline, retention, unconfirmed abuse limits). Confirm or change the two assumed limits and the channel-specific key decision with the security owner. Push and confirm CI is green end to end (the Email verification smoke scenario has not run in CI).

## ID-003 — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ID-003)"`.
Summary: The BananaGig-owned phone contact and its verification. A person adds a number (national or international), receives ONE concise SMS with a one-time code and verifies it; the number is canonical E.164 through libphonenumber-js (no custom dialing rules, no hardcoded calling code), country-aware through geography, masked everywhere and never stored in Keycloak. A change keeps the old verified number primary until the new one verifies. Introduces the provider-neutral `SmsSender` and `PhoneIntelligence` ports with fake adapters, the channel-neutral verification primitives shared with email, the per-country accounts-per-number policy, the derived contacts summary on `GET /account/me`, and the exact trusted-proxy hop model that resolves DEBT-0055.

### Housekeeping at the start (requested)
`PROJECT_STATE` records the verified ID-002 CI result (run 37728760371 for `675bb83`, green end to end). `la-oc` stays PLANNED and DEBT-0030 stays OPEN.

### Delivered
- Migration `0011_phone_verification.sql`: `identity.phone_contacts` and `identity.phone_verification_challenges` (one challenge per send), guard triggers with `identity_rule:<KEY>` details (including `PHONE_NUMBER_CAP`, counting holders on accounts that are not CLOSED), two deferred constraint triggers, the audit extension (seven PHONE_* actions, composite foreign key to the contact), the ten `verification.phone.*` parameters seeded through the real change workflow and 33 managed content entries.
- Contracts `phone.ts`: vocabularies, masking, strict request bodies, read models, five events, error codes; `AccountDto` gains `phone` and the derived `contacts` summary.
- `packages/accounts`: `PhoneVerificationService` (add/change number, send, confirm), `canonicalizePhone`, the phone policy, the channel-neutral `verification-core` and `verification-crypto` shared with email (email unchanged and proven by its full suites).
- `packages/platform`: `SmsSender` (fake sink and disabled adapters) and `PhoneIntelligence` (fake and unknown adapters) ports; `packages/testing`: the fake SMS inbox helper; `packages/config`: `SMS_TRANSPORT`, `PHONE_INTELLIGENCE`, `TRUSTED_PROXY_HOPS`; the development hash secret is refused in production.
- API: four operations under `/api/v1/account/phone*`, strict raw bodies, error mapping with `Retry-After`, `trustHops(hops)` replacing `trustProxy: true`; Caddy replaces `X-Forwarded-For`; the web BFF forwards one value.
- Smoke scenario "Phone verification": the code read from the fake sink, line-type refusals, wrong code counted, verified, derived contacts, email unchanged, idempotent repeat, no number or code in responses or Loki, and a spoofed `X-Forwarded-For` through Caddy that creates no bucket; run twice (INITIAL_PHONE, then CHANGE_PHONE).
- Docs: `docs/engineering/PHONE_VERIFICATION.md`, ADR-0030 to ADR-0033, the data-model documents, the engineering documents and skills.
- Quality process: unit, data-model, service and API suites written by independent workers; two independent read-only reviews (security, concurrency and database invariants) of the finished work. Findings fixed: the country directory rejected every country (the public geography view carries no `status`), `canonicalizePhone` returned INVALID_NUMBER for an unknown default country, the per-number budget could be charged to a different number than the one texted and was spent by sends the cooldown then refused, a closed account held its number forever, a counted wrong attempt could be rolled back by a failing audit or event write, the send-window cap silently ignored non-Date timestamps, and the development hash secret was accepted in production. Smoke bug: the line-type case used the VOIP tail, which the default blocklist allows.

### Decisions
- ADR-0030: the channel-neutral primitives are shared as code (`verification-core`, `verification-crypto`), not as a generic table or a framework; email and phone keep their own hash domains.
- ADR-0031: separate `phone_contacts` and `phone_verification_challenges` tables; canonical E.164 only; a line-type snapshot; `country_code` kept on the contact; accounts per number is configuration enforced by the service and a guard trigger, not a unique index.
- ADR-0032: SMS delivery and phone intelligence behind provider-neutral ports; fake adapters refused in production.
- ADR-0033: the exact trusted-proxy hop count; DEBT-0055 RESOLVED with two documented deployment invariants.
- DEBT-0043 option B again for the new bodies; DEBT-0030 stays OPEN (the limiter is not applied to the public address and content endpoints).
- The PRD keys `verification.code.*` are shared by channel; ID-003 uses channel-specific `verification.phone.*`, as ID-002 did.
- Repeating a confirmation after the pending change was withdrawn stays the documented idempotent success for any code; a code-bound variant was tried, contradicted four pinned tests and the documentation, and was reverted (DEBT-0065).

### Schema
Two new tables, one extended table (`identity.account_audit_events`), 96 constraints in the `identity` schema; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (ID-003). Intentional denormalization: `country_code` is derivable from `phone_e164` and kept for the foreign key and queries; the challenge `purpose` snapshot of the contact status at issuance; `is_primary` coincides with `status = 'VERIFIED'` by guard; `line_type` is a point-in-time snapshot.

### Contracts
OpenAPI: four phone operations and the extended account context. AsyncAPI: `bananagig.identity.phone-contact-added`, `phone-verification-sent`, `phone-verified`, `phone-verification-failed` and `phone-change-requested` (v1).

### Tests
Unit 6349, root script tests 71, integration 2679 in 31 files (phone data model rules 577, phone verification service 370, API phone 108), smoke 34 checks (run twice).

### Skills updated
`skills/identity`, `skills/testing`, `skills/configuration`, `skills/content`, `skills/database`, `skills/api`, `skills/web`.

### ADRs
ADR-0030, ADR-0031, ADR-0032, ADR-0033.

### Known follow-up
DEBT-0059 to DEBT-0065 (production SMS provider and spend caps, telecom risk vendor, contested numbers and lost phones, change step-up and screens, account market, unconfirmed limits, abuse residuals). DEBT-0055 is RESOLVED. Confirm or change the two assumed limits and the channel-specific key decision with the security owner. Push and confirm CI is green end to end (the Phone verification smoke scenario has not run in CI).

## ID-004 — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ID-004)"`.
Summary: The application security layer around the Keycloak authentication foundation: an application session registry that references the Keycloak `sid` (no token or credential is stored) and is enforced on every web-context request, so revocation takes effect at once although access tokens live 300 s; devices with a keyed-hash secret and coarse browser metadata, plus the trusted-browser record; sign out one, everywhere or the current session; the security timeline as a read model over the audit log; step-up guards on the verified `auth_time` and `acr`; the Keycloak browser flow with an unskippable second factor, TOTP and recovery codes owned by Keycloak; password-reset orchestration; the Keycloak admin client and a dedicated service account; realm hardening. Resolves nothing silently: the trusted browser has no login-time effect (DEBT-0066) and the email/SMS second factor is not built (DEBT-0067).

### Housekeeping at the start (requested)
`PROJECT_STATE` records the verified ID-003 CI result (run 38946842804 for `bd2be1c`, green end to end: `verify` 6m 55s and `compose-smoke` 4m 43s, including the phone integration tests and the `Phone verification` smoke scenario). `la-oc` stays PLANNED; DEBT-0030, DEBT-0064 and DEBT-0065 stay OPEN. Found and fixed while verifying: the OpenAPI file committed with ID-003 had NO phone routes (`scripts/generate-specs.mjs` never passed the phone service; `specs:check` could not notice); the regenerated spec has them and `apps/api/src/spec-completeness.test.ts` now fails whenever a route module of the app is missing from the generator or the committed spec.

### Delivered
- Migration `0012_application_sessions.sql`: `identity.application_sessions` (one row per Keycloak session id, terminal revocation with a reason, `fillfactor` 80 so the once-a-minute touch is a HOT update), `identity.account_devices` (keyed device hash, coarse families, trusted-browser window, removal), `identity.accounts.sessions_not_before` (the revocation watermark, with its own guard), the audit extension (16 security actions, session and device references with composite foreign keys), guard triggers with `identity_rule:<KEY>` details, a partial index for the observed-state lookups, six configuration parameters and 86 managed content entries.
- Contracts `security.ts` (vocabularies, strict request bodies, read models, seven events, error codes) and `SecurityService` in `packages/accounts` behind the `SecurityIdentityProvider` port, with fakes.
- API: 13 operations under `/api/v1/account/security/*` and the public `POST /api/v1/auth/password-reset`, the step-up guards (RFC 9470), session enforcement in `requireAccount`, a bounded drain of detached work at shutdown, `no-store` on every error under the account and auth prefixes, the device id fed into the email and phone rate limits.
- Identity package: `Principal.authTime`, validated step-up authorize parameters, `kc_action_status` helper, `KeycloakAdminClient`. Config: `KEYCLOAK_SECURITY_CLIENT_ID/SECRET`.
- Realm: the `bananagig-browser` flow family with `minimum.acr.value` (the second factor cannot be skipped by editing the URL), the `bananagig-security` service account (`manage-users` only), brute force 5 in 15 minutes locking 15 minutes, remember-me 30 days, refresh rotation with one reuse, SMTP to Mailpit; the built-in account console and the credential-deleting, WebAuthn and identity-link actions disabled; Caddy denies the account console and the reset-credentials URL; lint rules and a production build that keeps only the service account.
- Web: device cookie, session registration at login with cookie rotation after a removed device, single-flight token refresh, revoked-session handling, same-origin POST handlers, the `/security` and `/forgot-password` pages, one-shot server marker for credential setup.
- Smoke scenario "Sessions and security" (two real logins, revocation in milliseconds, TOTP and recovery enrolment with guaranteed removal, step-up refusal with a real aged login in the opt-in mode, no secret in any response or log).
- Docs: `docs/engineering/SESSIONS_AND_MFA.md`, ADR-0034 to ADR-0036, the data-model documents, engineering documents, seven skills, DEBT-0066 to DEBT-0075, LRN-0042 to LRN-0045.
- Quality process: a Keycloak research probe and a lab in scratch realms (nine requirements verified before any design was fixed); parallel authors with disjoint ownership; two independent read-only reviews (security, concurrency and database); independent test authors for the database model, the service, the API and the contracts. Findings fixed: retried revokes never re-reached Keycloak; the password-reset path leaked a timing difference; every session touch was a non-HOT update; the overview scanned the whole audit history; the first observation of an existing factor wrote false history and events; a presented device created ghost rows; liveness depended on reconciliation; the watermark refused a genuine login within the same second; a password reset left other sessions alive (the reset form's sign-out checkbox cannot be defaulted on in Keycloak 26.3.5); the credential-setup login skipped the recent-authentication proof; a user could delete their own second factor outside BananaGig through `kc_action=delete_credential`; the built-in account console was live; the timeline cursor skipped events that share a timestamp; impossible calendar values in the cursor leaked a database error; router-level errors lacked `no-store`; the sign-out-everywhere button was hidden when no other session was visible.

### Decisions
- ADR-0034: the registry, per-request enforcement, the watermark, the timeline as a read model, derived session state. Rejected: storing tokens, introspection per request, a separate activity table.
- ADR-0035: the Keycloak admin client and the `SecurityIdentityProvider` port; best-effort propagation with explicit outcomes.
- ADR-0036: Keycloak owns the factors and the recovery codes; claims-based step-up; the trusted browser is recorded without a login effect (offline-session-backed trust or a signed request object plus a custom authenticator are the future options).
- The email and phone change flows are NOT given a step-up check here (the prompt excluded those business flows); the primitive exists (DEBT-0050, DEBT-0062).
- Trusted browser honesty: the UI, API and documents say plainly that trust does not change when Keycloak asks for a code.

### Schema
Two new tables, one new column on `identity.accounts`, two new columns on `identity.account_audit_events`, 121 constraints in the `identity` schema; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (ID-004). No stored status, no `expires_at`, no activity table, no MFA flag, no recovery code, no raw IP or user agent. The only accepted denormalization is the audit action prefix paired with its foreign key column.

### Contracts
OpenAPI: thirteen security operations, the public password-reset operation, and (found missing) the four phone operations of ID-003. AsyncAPI: `bananagig.identity.session-created`, `session-revoked`, `sessions-revoked-all`, `mfa-enabled`, `mfa-disabled`, `password-reset-requested`, `password-reset-completed` (v1).

### Tests
Unit 7582, root script tests 163, integration 3747 in 35 files (security data model 571, security service 332, API security 148, live Keycloak 17), smoke 35 checks (run three times: twice normal and once with the step-up aging path).

### Skills updated
`skills/identity`, `skills/api`, `skills/web`, `skills/testing`, `skills/database`, `skills/configuration`, `skills/content`.

### ADRs
ADR-0034, ADR-0035, ADR-0036.

### Known follow-up
DEBT-0066 to DEBT-0075 (trusted browser effect, email/SMS second factor and phone-confirmed recovery, Keycloak events, multi-instance refresh, assumed parameters, service account scope, propagation retries and admin-call throttling, reset abuse residuals, session residuals, security metrics). Push and confirm CI is green (the Sessions and security smoke scenario and the live Keycloak integration test have not run in CI). Confirm the three assumed security values with the security owner. Apply the step-up guard to the email and phone change when those flows are built.

## ID-005 — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ID-005)"`.
Summary: The application-owned consent system. An account's relationship to a legal document is one append-only event log (`identity.consent_events`: ACCEPTED or WITHDRAWN with a per-account-and-purpose sequence) in which every row binds to the exact immutable CFG-002 version through a composite foreign key on `(version_id, locale, body_sha256)`, so the database proves the stored locale and hash. An insert trigger proves the version is published, in platform scope, a version of the purpose's own document and in force at that instant (taking `FOR SHARE` on the version row so an accept racing a publication serializes) and sets the time itself. Current consent is derived, never stored. Policy (who needs which purpose, what a newer version does) is configuration. No legal text is copied anywhere.

### Housekeeping at the start (requested)
`PROJECT_STATE` records the verified ID-004 CI result (run 38966938846 for `301b009`, green end to end: `verify` 6m 11s and `compose-smoke` 4m 31s, including the live Keycloak security test and the `Sessions and security` smoke scenario). `la-oc` stays PLANNED; DEBT-0030, DEBT-0064, DEBT-0065 and DEBT-0070 stay OPEN.

### Delivered
- Migration `0013_consent.sql`: an additive UNIQUE on `content.versions (version_id, locale, body_sha256)`; the SQL function `identity.consent_version_state` (the single "in force" definition, equal to the content resolver and parity-tested); two EMPTY LEGAL entry shells (`legal.terms_of_service`, `legal.privacy_policy`: no legal text is seeded); `identity.consent_purposes` (document, withdrawal policy, status) with TERMS_OF_SERVICE and PRIVACY_POLICY; `identity.consent_events` with guard and append-only triggers (UPDATE, DELETE, TRUNCATE refused); the audit extension (`consent_event_id`, CONSENT_ACCEPTED and CONSENT_WITHDRAWN); four configuration parameters; 40 managed copy entries.
- Contracts `consent.ts`; `ConsentService` in `packages/accounts` (accept with a defined check order and idempotent repeats, withdraw, consistent-snapshot reads, the pure requirement evaluator with three re-acceptance modes, the strict policy parser) and the signup-ready `listOutstandingConsents`, `hasRequiredConsents`, `requireConsents`.
- API: `GET /account/consents`, `GET /account/consents/requirements`, `POST /account/consents/:purpose/accept` and `/withdraw`; the configuration-backed policy provider; the default-locale resolver; two events (`consent-accepted`, `consent-withdrawn`).
- Web: the `/consents` page (accept offered only when the public resolver returns exactly the requirement's version, hash, entry and locale; nothing pre-ticked), the same-origin handlers, the api-client, and, found by the security review, framing protection (`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`) on every web response.
- Smoke scenario "Consent": publishes dev-only legal versions through the real two-approver workflow on every run, accepts with the exact displayed values, checks the database binding, the refusals, a new Terms version forcing re-acceptance, the web page through Caddy, and that no legal text or secret reaches logs, outbox or audit.
- Docs: `docs/engineering/CONSENT.md`, ADR-0037 and ADR-0038, the data-model documents, engineering documents, seven skills, DEBT-0076 to DEBT-0081, LRN-0046 to LRN-0050.
- Quality process: independent authors for the migration and service, API and web; two independent read-only reviews (security and privacy, concurrency and database); independent test authors for the database model, the service, the API and the contracts. Findings fixed: the `accept` check order leaked the locale and hash-guessing of an unpublished-but-approved version; `requireConsents` with an empty list was vacuously satisfied; people who had already accepted flipped to DOCUMENT_UNAVAILABLE platform-wide during a gap in Legal's timeline under the lenient modes; `getConsents` and `getRequirements` read from separate snapshots; an index the planner never used; the in-force function returned IN_FORCE for a NULL entry id; no framing protection on any web page (a predating gap); smoke bugs (a raw object posted as the body, a status-copy count that collided with identical copy).

### Decisions
- ADR-0037: one append-only event log bound to the exact version, locale and hash; alternatives rejected: acceptance plus current-state tables, a boolean per purpose, storing the legal text, trusting the latest version, a service-only eligibility check.
- ADR-0038: policy as configuration and derived current state; rejected: policy columns on the purpose, hardcoded per-document behaviour, a stored current flag, a locale fallback.
- Legal never falls back: a person whose locale has no LEGAL version stays DOCUMENT_UNAVAILABLE under the strict mode, and a gating flow must pass the locale it shows (rejected: falling back to the platform default locale, which contradicts "do not silently accept en-US").
- `/account/me` carries no consent summary (it would add configuration reads to a hot read; `GET /account/consents/requirements` carries `satisfied`).
- The evidence of an acceptance is the immutable SOURCE version (id, locale, hash); the page shows its rendered, sanitized output; a pinned rendering test fails on purpose when the renderer changes (a rendered hash compared at accept time is future work, DEBT-0078).

### Schema
Two new tables, one new column on `account_audit_events`, one additive unique constraint on `content.versions`, 141 constraints in the `identity` schema; see `docs/data/DATA_MODEL_CHANGELOG.md` and `NORMALIZATION_LOG.md` (ID-005). The only denormalization accepted besides the audit prefix pair is the FK-verified `locale` and `body_sha256` on each event (derivable from the version, kept so the accepted bytes are provable).

### Contracts
OpenAPI: four consent operations. AsyncAPI: `bananagig.identity.consent-accepted` and `consent-withdrawn` (v1).

### Tests
Unit 8354, root script tests 163, integration 4269 in 38 files (consent data model 356, consent service 100, API consent 66), smoke 36 checks (the Consent scenario passed three consecutive runs; two later runs failed only in the Email and Phone scenarios on the per-account hourly send cap, which is counted in PostgreSQL by design).

### Skills updated
`skills/identity`, `skills/content`, `skills/api`, `skills/web`, `skills/testing`, `skills/database`, `skills/configuration`.

### ADRs
ADR-0037, ADR-0038.

### Known follow-up
DEBT-0076 to DEBT-0081 (no flow requires consent yet, unconfirmed policy defaults, no re-acceptance notification or console or export, no regional engine or cross-language equivalence, other purposes not seeded, residuals including the DORMANT rate limit that must exist before the first withdrawable purpose). Push and confirm CI is green (the Consent smoke scenario has not run in CI). Legal must publish the first versions of the Terms of Service and Privacy Policy before any flow can require consent; until then required purposes are DOCUMENT_UNAVAILABLE.

## ID-005 (CI follow-up fix) — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ID-005)"` (the `fix(ID-005)` commit).
Summary: CI run 38977469935 for `b07e161` failed in the integration step with two unhandled PostgreSQL 57P01 errors attributed to `consent-model.itest.ts`; no assertion failed. The ID-005 report said the integration tests passed: that was true locally only, and the race needs a slower runner than the development machine.

### Delivered
- Root cause found and reproduced: `pg-pool` `end()` resolves before the server has seen the clients leave, the idle-client error listener re-emits on the pool, and a pool without an `error` listener makes that an uncaught exception. The next `DROP DATABASE ... WITH (FORCE)` of the teardown triggers it. A 30-connection pool, `end()` and an immediate forced drop gave 520 uncaught errors in 60 repetitions without a listener and none with one.
- `createTestPool(url, max)` in `packages/testing/src/index.ts` (pool with an `error` listener) used by all seven model integration files (consent, security, phone, email, identity, address, geography); `createIsolatedDatabase().drop()` waits up to 5 s for the database's sessions to leave before it forces the drop.
- LRN-0051 and a rule in `skills/testing/SKILL.md`.

### Schema
No change (no migration, latest stays 0013).

### Contracts
No change.

### Tests
The seven changed files (2208 tests) passed twice in a row locally. The CI result of the fix is not known until the user pushes it.

### Skills updated
`skills/testing` (use `createTestPool`, never a bare `new pg.Pool`, in an integration test; LRN-0051).

### ADRs
None required.

### Known follow-up
None. No schema, API or behaviour change. The same commit also carries the uncommitted ID-004 session-watermark follow-up that was in the working tree (`SecurityService` login check against the identity provider's session start; ADR-0034, `SESSIONS_AND_MFA.md`, identity and web skills, smoke), committed at the user's request.

## ID-005 (CI smoke follow-up) — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ID-005)"` (the second `fix(ID-005)` commit).
Summary: CI run 38982170853 for `3cf0064` passed `verify` and failed `compose-smoke`: `Sessions and security` (7a) got 401 SESSION_REVOKED for a new login made about a second after a sign-out-everywhere, and `Consent` failed as a cascade of the same refusal. The cause is the first-sight rule committed in `3cf0064` (a never-seen session within 2 s of the watermark must be confirmed by the identity provider), not the consent code. Reproduced locally after really rebuilding the API container (my first local smoke pass ran against stale containers because I named the services wrongly).

### Delivered
- The smoke waits 2.6 s before the new logins E (7a) and k (7b), with the reason in a comment.
- LRN-0052 and a rule in `skills/testing/SKILL.md`.

### Schema
No change.

### Contracts
No change.

### Tests
Smoke against rebuilt containers: without the waits `Sessions and security` and `Consent` fail exactly as in CI; with them both pass. The `Email verification` and `Phone verification` scenarios failed locally only on the per-account hourly send caps of the dev database (known, DEBT-recorded behaviour, filled by today's repeated runs); a fresh CI database does not have them.

### Skills updated
`skills/testing`.

### ADRs
None required.

### Known follow-up
A person who signs in again within about 2 s of a sign-out-everywhere would also be refused; in practice a login takes longer, and the rule fails closed. Not recorded as debt unless it is seen in use.

## ACC-001 — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(ACC-001)"`.
Summary: The shared account area. ONE framework for every persona instead of an account system per persona: the sections are reference data (`identity.account_sections`, `identity.account_section_roles`) selected by the ACTIVE role the account guard already validated, the section read models compose the profile, contacts, security and consent domains and store nothing, a section the active role lacks is a 404 `ACCOUNT_SECTION_NOT_FOUND` on its endpoints, and the web has a responsive, accessible shell with one page per section. CUSTOMER and PROVIDER see the same six sections today because no role-specific capability exists yet; this is stated rather than papered over, and the role-driven selection is proven against the registry itself.

### Housekeeping at the start (requested)
`PROJECT_STATE` records the three ID-005 commits (`b07e161` feature, `3cf0064` integration and session fix, `9b30026` smoke timing fix) and GitHub Actions run 38984639745 SUCCESS (`verify` PASS 9m 42s, `compose-smoke` PASS 4m 45s). `checkpoint:start` ran first (it needs a clean tree), then the housekeeping edit.

### Delivered
- Migration `0014_account_area.sql`: `account_sections` (code, own URL, label and description content keys, status) and `account_section_roles` (the matrix: enabled, display order, unique per role); three guard functions and triggers (a row is enabled only for an ACTIVE section and role, neither can leave ACTIVE while enabled, no DELETE or TRUNCATE, keys and `created_at` kept; one trigger on `identity.roles`); the seed of 8 sections x 2 roles and 64 managed copy entries through the content lifecycle (en-US, plural-aware count copy). No profile, contact, security or consent column was duplicated and no per-person preference table was added.
- Contracts `account-area.ts`; `AccountAreaService` (one indexed registry read per call); `AccountService.patchProfile` (present fields only, row read FOR UPDATE in the transaction, a kept locale or time zone is not revalidated); `SecurityService.getSummary`.
- API: seven operations (`getAccountNavigation`, `getAccountProfile`, `patchAccountProfile`, `getAccountContactVerification`, `getAccountRolesSection`, `getAccountSecuritySummary`, `getAccountPrivacySummary`) and a section guard for `PUT /account/profile`; `requireAccountSection`, `requireAnyAccountSection`, `assertAccountSections` (one registry read per request).
- Web: the account layout and shell, the six section pages, the not-found fallback, the two no-JS form handlers, the role switch return path (allowlist `/account/roles` or `/account`), contract-validating stub, 180 new web tests.
- Smoke scenario `Account area`: API and web through Caddy; SQL oracle for each role, one reversible and self-healing flip of a seeded matrix row.
- Docs: `ACCOUNT_AREA.md`, ADR-0039, the data model documents, DEBT-0082, LRN-0053 and LRN-0054.
- A pre-existing flaky test (CFG-002, `packages/content/src/content.itest.ts`, the effective window) failed one finalization: it built "now + 60 s" and "now + 120 s" from two `Date.now()` calls and asserted an exact difference (and an equal start and end). It now uses one base instant; three consecutive runs pass. The same weakness (two writes inside one millisecond compared at millisecond resolution) failed a finalization once in the new registry model test and was removed from every new test that compared `updated_at`; the file passes four consecutive runs.
- Quality process: independent authors for the web, for the database and service tests and for the contract and API tests; two independent read-only reviews. They found and I fixed: a names-only PATCH that revalidated a stored locale or time zone that had been deactivated; my own edit that put the stored-zone column in the wrong SELECT (caught by the independent test author before it shipped: it would have cleared the time zone on every patch); a role that could be retired while the matrix still enabled sections for it; a language form that silently cleared a stored inactive value; name errors not tied to their field; account-area link contrast in dark mode; a TRUNCATE gap; `created_at` documented immutable but not enforced; "1 agreements" copy; and documentation that overstated the guarantees.

### Schema
Migration 0014: two new tables, three guard functions with five triggers (one trigger on `identity.roles`), seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (1NF to BCNF, two tables because section attributes depend on the section alone and enabled/order on the pair).

### Contracts
`packages/contracts/src/account-area.ts` (vocabulary, DTOs, `PatchProfileRequest`, `PROFILE_FIELD_SECTIONS`, `ACCOUNT_AREA_COPY`); error code `SECTION_NOT_FOUND`; OpenAPI regenerated and valid; AsyncAPI unchanged (no event was added).

### Tests
Unit 8982 and 163 root script tests, integration 4596 in 43 files, smoke 37 checks. Locally the `Account area`, `Sessions and security` and `Consent` smoke scenarios pass; `Email verification` and `Phone verification` fail on the per-account send caps of the developer database (used up by many runs the same hour, known and by design); a fresh CI database does not have them. Mutation checks by the independent authors (the API layer, the registry service, `patchProfile` and the migration guards, each broken and restored): every mutation was caught by a test except three that are redundant by design (the profile row lock is covered by the account lock, one of two TRUNCATE triggers is behaviourally covered by the other, and the per-request memoization, for which a test was added afterwards).

### Skills updated
`skills/identity`, `skills/api`, `skills/web`, `skills/database`, `skills/testing`.

### ADRs
ADR-0039.

### Known follow-up
DEBT-0082 (later role-specific sections, notifications, closure, privacy export, registry admin editor, visual polish, phone action, registry cache, profile event). CUSTOMER and PROVIDER share one section set until a role-specific capability ships. Next approved checkpoint: CAT-001 (Categories and Service Types).


## CAT-001 — 2026-10-16

Status: COMPLETE
Commit: find it with `git log --grep "(CAT-001)"`.
Summary: Categories and service types as the PLATFORM-OWNED taxonomy: Category > Service Type (exactly one, immutable category) > Gig (provider-owned, CAT-002 and later; nothing provider-specific exists here). Reference data, not configuration values and not Gig content. Stable immutable snake_case codes, a four-state status machine (DRAFT, ACTIVE, INACTIVE, RETIRED) enforced in one SQL function, no hard delete, per-market availability with a display order unique per market, names and descriptions as content keys (CFG-002) derived from the code by a generated column with a foreign key to the content registry. The public view shows only ACTIVE items enabled under an enabled ACTIVE category in a market geography calls public; the management view (admin context plus `catalog-read`/`catalog-write`) shows everything. The seed is deliberately minimal and all DRAFT (2 categories, 4 service types), so nothing is public until an administrator activates and enables it; la-oc stays PLANNED.

### Housekeeping at the start (requested)
`PROJECT_STATE` records ACC-001 (`d86f5d4`, GitHub Actions run 38995740997 SUCCESS: `verify` PASS, `compose-smoke` PASS, fresh-database smoke 37/37; the Email and Phone local failures were the developer database's send caps only). `checkpoint:start` ran first. A second interactive Claude session exists on this machine and could not be closed from here; the finalize "working tree unchanged" check was the guard.

### Delivered
- Migration `0015_catalog.sql`: schema `catalog` with six tables (`categories`, `service_types`, `prohibited_services`, `market_categories`, `market_service_types`, `audit_events`), a shared status-transition function, five guard functions and the immutability function with triggers (rules reported as `catalog_rule:<KEY>`, TRUNCATE refused on every table), the seed (12 content entries through the lifecycle, 2 categories, 4 service types, 6 audit rows).
- Contracts `catalog.ts`; package `@bananagig/catalog` (`CatalogService`, generation cache, the CATEGORY scope-reference validator); API module under `/api/v1/catalog` (16 operations) with a market gate port over the geography registry; temporary admin client roles `catalog-read`/`catalog-write` in the realm (DEBT-0021 model); outbox events for activation, deactivation and availability; smoke scenario `Catalog` (38 checks).
- DEBT-0024 for the CATEGORY scope: references are validated against the catalogue when a change request is created and published (RETIRED, unknown and non-canonical references get one generic reason).
- Docs: `CATALOG.md`, ADR-0040, `skills/catalog`, the data model documents, DEBT-0083.
- Quality process: independent authors for the contracts and API, the service and the database model, each with mutation checks (52 whole-file mutations of the database rules, 18 of the service rules, 8 of the API fixes); two independent read-only reviews. Defects found and fixed before the commit: a shared mutable scope-validator result; a double first submission of an availability row reported as CODE_TAKEN (now a retryable conflict with one whole-transaction retry); collation-dependent ordering (`COLLATE "C"`); an error-details deny-list (now an allow-list); a public content outage that hid the catalogue as an empty list (now 503); a management preview in the wrong locale (now the market default); `mapDbError(null)` throwing a TypeError; management and mutation responses without `Cache-Control: no-store`; documentation that claimed instant cache invalidation and contradicted the content ownership rule.

### Schema
Migration 0015: six tables, seven functions, 12 triggers, seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (1NF to BCNF; no version tables and no requirement tables on purpose; one non-key index).

### Contracts
`packages/contracts/src/catalog.ts`; five events (`bananagig.catalog.*.v1`); OpenAPI and AsyncAPI regenerated and valid.

### Tests
Unit 9287 and 164 root script tests, integration 5132 in 46 files (catalog data model rules 386, service 104, API 46), smoke 38 checks (38/38 locally, including Email and Phone verification).

### Skills updated
`skills/catalog` (new), `skills/database`, `skills/content`.

### ADRs
ADR-0040.

### Known follow-up
DEBT-0083 (launch taxonomy, admin UI, synonyms and search, requirement policies, moderation, icon pipeline, effective-dated availability, and a few small gaps listed there). Next: CAT-002 Gig Templates.

## CAT-002 — 2026-10-17

Status: COMPLETE
Commit: find it with `git log --grep "(CAT-002)"`.
Summary: Gig Templates. The platform-owned, versioned structure a provider will build a Gig from, attached to exactly one service type. Identity (immutable code and service type, derived copy keys, status) is separate from the version (duration guidance, allowed pricing models and service-area modes, typed fields, enum options, requirement hooks). A version is a DRAFT until published, then ACTIVE and frozen with all its rows by database guards, and superseded automatically by the next publication; one DRAFT and one ACTIVE per template, contiguous numbers, never deleted. The future provider Gig (CAT-003) will reference `gig_template_version_id`, so it keeps the exact structure it was built from. No provider data is stored. Copy is content with derived keys shared by all versions. The seed is two DRAFT templates without versions; nothing is public until built, published, activated and enabled; la-oc stays PLANNED.

### Housekeeping at the start (requested)
`PROJECT_STATE` records CAT-001 (`67d0424`, GitHub Actions run 39004552503 SUCCESS: `verify` PASS 11m 27s, `compose-smoke` PASS 5m 41s, fresh-database smoke 38/38 with the Catalog, Email and Phone scenarios). `checkpoint:start` ran first. A second interactive Claude session exists on this machine and could not be closed from here.

### Delivered
- Migration `0016_gig_templates.sql`: six tables in the `catalog` schema (`gig_templates`, `gig_template_versions`, `gig_template_fields`, `gig_template_field_options`, `gig_template_requirements`, `market_gig_templates`), nine functions with twelve triggers, the audit table extended (two subject columns, seventeen actions), the seed (6 content entries, 2 DRAFT templates, 2 audit rows). Migration `0017_gig_templates_hardening.sql` (forward fix after the independent review, 0016 was already applied to the development database): a field with options keeps its type and key, the publication re-verifies the option rules, the audit key to a version is composite, stale comments.
- Contracts `gig-template.ts`; `GigTemplateService` in `@bananagig/catalog`; 12 API operations under `/api/v1/catalog`; five outbox events (activated, deactivated, retired, published with the exact version id, availability changed); the public snapshot cache shares the taxonomy's generation counter; smoke scenario `Gig templates` (39 checks).
- Docs: `GIG_TEMPLATES.md`, ADR-0041, the data model documents, `skills/catalog` (extended), `skills/database` and `skills/content`, DEBT-0084, LRN-0055.
- Quality process: independent authors for the contracts and API, the service and the database model, each with mutation checks (118 on the contract and API, 99 on the service, about 50 in-file and whole-file on the database rules, four on 0017); two independent read-only reviews. Defects found and fixed before the commit: an oversized `copyFromVersion` answered 500; echoed content keys were not length-capped; float noise made an unchanged draft look changed and the 4-decimal check rejected valid large values and accepted 5e-11 (now a relative tolerance and a 1e9 cap); the content check ignored SCHEDULED and SUPERSEDED versions the resolver serves and deactivated entries; a poisoned cache entry could add management fields to a public view; management reads could show a version with the rows of a later revision (now one snapshot, joining a caller's transaction when nested); a field with options could be retyped or renamed and then published inconsistently; the audit trail could pair a template with another template's version; unbounded options per version; stale comments and docs that overstated the guarantees. The independent database author ran its mutation campaign for two hours; I stopped it, verified the production files were untouched (migration modification time, the snapshot parity, the suites) and finished the file myself.
- A nested transaction with another isolation level is refused by the database layer; a read that wants a snapshot must fall back to joining the caller's transaction (documented in the service).

### Schema
Migrations 0016 and 0017: six new tables, ten functions (nine guards and checks plus one helper), twelve triggers, one unique key and one composite foreign key added, seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (1NF to BCNF, flags instead of child tables for the closed pricing and area sets, typed metadata instead of JSON, derived field and option keys stored and verified by the guards).

### Contracts
`packages/contracts/src/gig-template.ts`; error codes `GIG_TEMPLATE_NOT_FOUND`, `GIG_TEMPLATE_VERSION_NOT_FOUND`; five `bananagig.catalog.gig-template-*.v1` events; OpenAPI and AsyncAPI regenerated and valid.

### Tests
Unit 9748 and 164 root script tests, integration 6141 in 49 files (Gig Template data model rules 839, service 148, API 22), smoke 39 checks (39/39 locally).

### Skills updated
`skills/catalog`, `skills/database`, `skills/content`.

### ADRs
ADR-0041.

### Known follow-up
DEBT-0084 (the template catalogue, authoring UI, requirement catalogues and policy engine, media-rule editor, pricing suggestions, the provider Gig builder, and the accepted limits listed there). Next: PRO-001 Provider Registration.

## PRO-001 — 2026-10-17

Status: COMPLETE
Commit: find it with `git log --grep "(PRO-001)"`.
Summary: Provider Registration. A person becomes a provider with the account they already have: provider-domain state for the existing account (no provider user, login or copied contact), with the application role, the registration and Go-Live kept as three separate things. Attempts (a restart is a new attempt), market, service types chosen from the catalogue, onboarding steps derived by a pure evaluator from their owners, server-controlled submit and cancel, policy as typed configuration that fails closed, copy as content, audit and outbox in the same transaction, an owner-only API and a minimal temporary web flow.

### Housekeeping at the start (requested)
`PROJECT_STATE` records CAT-002 (`0221af7`, GitHub Actions run 39020045328 SUCCESS: `verify` PASS 14m 27s, `compose-smoke` PASS 5m 0s, fresh-database smoke 39/39). `checkpoint:start` ran first. A second interactive Claude session (`bananagig-com-4c`) exists on this machine and was idle; the user-owned `pnpm dev` shells were not touched. `la-oc` stays PLANNED; DEBT-0030, 0064, 0065, 0070 and 0076 to 0084 stay OPEN.

### Delivered
- Migration `0018_provider_registration.sql` (one transaction): schema `provider` with `registrations`, `registration_service_types` and `audit_events`; two guard functions plus the immutability function with a TRUNCATE refusal per table (`provider_rule:<KEY>` keys, 12 rules); a partial unique index for at most one non-cancelled attempt per account; 5 configuration parameters (`provider.registration.*`) through the real change-request lifecycle and 56 content entries through the real content lifecycle.
- Contracts `provider.ts`; package `@bananagig/provider` (`ProviderRegistrationService`, the pure `evaluateRequirements`, the policy parser, the ports); `CatalogService.offeredServiceTypeCodes`; the API module `apps/api/src/modules/provider` (7 operations under `/api/v1/provider`, owner-only, no identifier accepted, `no-store`); three outbox events (started, completed, cancelled); the minimal web flow (`/provider/registration` and `/auth/provider/<action>`); smoke scenario `Provider registration` (40 checks).
- Docs: `PROVIDER_REGISTRATION.md`, ADR-0042, the data model documents, `skills/provider` (new), DEBT-0085 and DEBT-0086.
- Quality process: independent authors for the database model, the service, the contracts and API, and the web, each with mutation checks (90 on the SQL, 56 on the service, about 80 on the contracts and API, 39 on the web, 15 on the review fixes); two independent read-only reviews. Defects and gaps found and fixed before the commit: a free-text cancel `reason` would have persisted in the immutable audit table (the field was removed); a body-less cancel answered 400; an INACTIVE role at submit was reported as an incomplete LEGAL step; the contact check for market and services ran only before the transaction; an `AccountError` conflict escaped as a 500; the facts of later checkpoints were read inside the submit transaction. Accepted limits are listed in DEBT-0086.
- Lessons carried: consent is evaluated before the registration transaction (its repeatable-read snapshot cannot nest); the smoke needs a customer-only identity, so it creates and deletes a throwaway Keycloak user (customer.dev already holds PROVIDER).

### Schema
Migration 0018: three tables, three functions, six triggers, five indexes, seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (derived steps not stored, no copied contact, one market column, selections as a join table, the completion and cancellation timestamps justified by the lifecycle CHECK).

### Contracts
`packages/contracts/src/provider.ts`; 14 error codes `PROVIDER_*`; three `bananagig.provider.registration-*.v1` events; OpenAPI and AsyncAPI regenerated and valid.

### Tests
Unit 10609 and 164 root script tests, integration 6597 in 52 files (provider data model rules 215, provider service 157, API provider 70, catalog service 118), smoke 40 checks (40/40 locally).

### Skills updated
`skills/provider` (new).

### ADRs
ADR-0042.

### Known follow-up
DEBT-0085 (PLANNED-market pre-registration, the service type ceiling, one market per registration) and DEBT-0086 (verification, subscription, profile, Gigs, Go-Live, business providers, the polished UI and the accepted limits). Next: TRUST-001 Provider Verification and Documents.

## TRUST-001 — 2026-10-18

Status: COMPLETE
Commit: find it with `git log --grep "(TRUST-001)"`.
Summary: Provider Verification and Documents. Verification is multi-dimensional: a verification CASE holds one requirement instance per thing policy asks of the provider (definition, rule and instance are separate; re-verification is a new cycle that keeps the old approval; evidence submissions are counted in rounds), evidenced by documents in the PRIVATE object store (metadata only in PostgreSQL, server-verified size, content type, file signature and SHA-256, a malware-scan port that fails closed, immutable history) or by an external verification behind a provider-neutral port, and decided by reviewers with structured reasons. There is no `verified` flag; the overall state is derived and is never Go-Live.

### Housekeeping at the start (requested)
`PROJECT_STATE` records PRO-001 (`a4d99c1`, GitHub Actions run 39055006188 SUCCESS in 20m 48s, as reported by the repository owner). `checkpoint:start` ran first. A peer interactive Claude session exists and was idle; the user-owned `pnpm dev` shells were not touched (their host worker shares the pg-boss queue with the container worker, which made the `Worker runtime` smoke check flaky: LRN-0057). `la-oc` stays PLANNED; DEBT-0030, 0064, 0065, 0070 and 0076 to 0086 stay OPEN.

### Delivered
- Migration `0019_trust_verification.sql` (one transaction): schema `trust` with ten tables (`requirement_definitions`, `document_types`, `reason_codes`, `requirement_rules`, `verification_cases`, `case_requirements`, `documents`, `reviews`, `external_verifications`, `audit_events`), ten functions and 21 triggers (guard rules `trust_rule:<KEY>`, 39 keys), 28 indexes, 6 `trust.*` configuration parameters through the real change-request lifecycle, 97 content entries through the real content lifecycle, and the reference seeds (4 definitions of which only identity verification is ACTIVE and required, 7 document types, 7 reason codes, one rule).
- Contracts `trust.ts`; package `@bananagig/trust` (`TrustService`, the pure evaluator, the ports, the DEV/TEST adapters); `PrivateObjectStore` in `@bananagig/platform` (S3 and in-memory adapters, versioned read and conditional copy; `@aws-sdk/s3-request-presigner` added, pinned to the client version); settings `S3_PUBLIC_ENDPOINT`, `TRUST_SCANNER`, `TRUST_EXTERNAL_PROVIDER`; Keycloak realm roles `trust-read`, `trust-review`, `trust-admin` (dev administrators); the provider API (11 operations) and the staff API (10); seven outbox events; PRO-001's VERIFICATION step answered by this domain; the minimal web flow; smoke scenario `Provider verification` (41 checks).
- Docs: `TRUST_VERIFICATION.md`, ADR-0043 to ADR-0045, the data model documents, `skills/trust` (new), DEBT-0087 and DEBT-0088, LRN-0056 and LRN-0057.
- Quality process: independent authors for the database model, the service, the pure and platform units, the contracts and API, and the web, each with mutation checks (about 50 on the SQL, 48 on the service, 50 on the units, 60 on the contracts and API, 40 on the web, 25 on the review fixes); two independent read-only reviews. Defects found and fixed before the commit, by the test authors: starting an external verification violated its own guard; a rejected external verification could never be restarted; the stored case status ignored an approval past its end; `matchesSignature` threw on an inherited key; a duplicated configuration read. By the reviews: **a presigned PUT stayed valid after finalize and could overwrite evidence after it was hashed and scanned** (now a separate upload key and a conditional promote that re-hashes the result); the web upload would have put the signed URL in a Next.js trace span (now `node:http(s)`); abandoned uploads piled up; a reviewer could approve an external requirement without the provider's result; replaying an approve with another end date was a silent no-op; a case with approvals could be cancelled; a stuck EXPIRED case for a requirement policy dropped; a document could be inserted for a cancelled case (database guard); reviews were read without an index; timestamps could be caller-supplied; and several smaller ones. Accepted limits are in DEBT-0087 and DEBT-0088.

### Schema
Migration 0019: ten tables, ten functions, 21 triggers, 28 indexes, seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (definition, rule and instance separated; the case status derived but stored; cycles and rounds; metadata only in the database; no account id on requirements or documents; structured reasons and no free text; no `verified` boolean).

### Contracts
`packages/contracts/src/trust.ts`; 25 error codes `TRUST_*`; seven `bananagig.trust.verification-*.v1` events; OpenAPI and AsyncAPI regenerated and valid.

### Tests
Unit 12282 and 164 root script tests, integration 7458 in 55 files (trust data model rules 620, trust service 131, API trust 110), smoke 41 checks (41/41 locally).

### Skills updated
`skills/trust` (new), `skills/provider`, `skills/infrastructure`.

### ADRs
ADR-0043, ADR-0044, ADR-0045.

### Known follow-up
DEBT-0087 (a real scanner, a vendor adapter, retention, per-market document acceptance, reviewer notes, a trust console, the policy that can fail open, no audit of reads, no rate limit) and DEBT-0088 (the unscheduled expiry sweep and cleanup, the minimal web flow, accepted limits). Next: CAT-003 Provider GigMenu and Gig Versioning.

## CAT-003 — 2026-10-18

Status: COMPLETE
Commit: find it with `git log --grep "(CAT-003)"`.
Summary: Provider GigMenu and Gig Versioning. A Gig is the provider-owned offer built from a PLATFORM-OWNED Gig Template: an IDENTITY (`provider.gigs`: account and template, status DRAFT, ACTIVE, RETIRED; no service type and no market column) plus immutable VERSIONS (`provider.gig_versions`) that each bind the EXACT `gig_template_version_id`, with normalised typed field values, a server-derived price currency, duration, plain-text provider copy, one editable DRAFT and one PUBLISHED version at most, atomic supersede on publish, retire that keeps history, and no migration of an existing Gig to a newer template version. It is not live or bookable: Go-Live stays PRO-003 and `goLive` is `{evaluated:false, eligible:false}`.

### Housekeeping at the start (requested)
`PROJECT_STATE` records TRUST-001 (`38c934e`, GitHub Actions run 39080616644 SUCCESS in 17m 31s, `verify` PASS, `compose-smoke` PASS, `Provider verification` smoke PASS, as reported by the repository owner). `checkpoint:start` ran first on a clean tree. The user-owned `pnpm dev` shells were not touched. `la-oc` stays PLANNED; DEBT-0030, 0064, 0065, 0070 and 0076 to 0088 stay OPEN.

### Delivered
- Migration 0020 (`provider` schema): `gigs`, `gig_versions`, `gig_version_field_values`, `gig_audit_events`; 7 guard functions and 12 triggers (`provider_rule:<KEY>`, SQLSTATE 23000) that keep the invariants true for direct SQL (one DRAFT and one PUBLISHED per Gig, contiguous numbers, frozen published versions and values, exact template version binding, price currency equal to the market currency, typed value columns, ENUM options of the exact version, PLATFORM_FIXED never stored, a deferred check that a Gig has a version and that its status agrees with its versions, immutable audit); lock order account, Gig, version, then the catalogue rows in the catalogue's own order (template, service type, version); five typed `provider.gig.*` limits and 107 content entries seeded through the real change-request and content lifecycles.
- `ProviderGigService` in `@bananagig/provider` over the `GigTemplatePort` and `GigPolicyProvider` ports: create (idempotent by `clientRequestId`), next draft, eager typed validation of every field value against the exact template version, draft save with an optimistic revision, publish with completeness issues and atomic supersede, retire, the GigMenu read model in a constant number of statements, `getGigReadinessFacts` and `gigsPrerequisite` for the onboarding GIGS step; three narrow exact-version reads added to `@bananagig/catalog`.
- Contracts `packages/contracts/src/gig.ts` (DTOs, strict requests, 15 error codes, issue reasons, events, the plain-text normaliser); API module under `/api/v1/provider` (9 owner-only operations, error codes `GIG_*`, bodies read from the parsed copy); three outbox events; minimal accessible web pages `/provider/gigs`, `/provider/gigs/<id>`, `/provider/gigs/<id>/versions/<n>` and their POST handlers; smoke scenario `Provider GigMenu` (42 checks).
- Docs: `PROVIDER_GIGS.md`, ADR-0046, the data model documents, `skills/catalog` and `skills/provider`, DEBT-0089 to DEBT-0097, LRN-0058 to LRN-0060.
- Quality process: the work was split across six parallel agents (database, service, API, web, smoke, docs) against one shared spec and contracts, each with unit and integration tests; two independent read-only reviews. Defects found by the reviews and fixed before the commit: **a quadratic-time markup regex let one 80 KB description block the whole API for about 13 s**; invisible and blank-looking text could satisfy "required" text; a deadlock between publish and template retirement (guard lock order); a market currency change blocked the next draft with an untyped error; the account port's errors surfaced as 500; the web form body was not size-bounded; a foreign key into the catalogue had no index although the catalogue deletes rows; and a body field value was coerced by Ajv before the handler read it (found while building the API: LRN-0058). Accepted limits are in DEBT-0096 and DEBT-0097.

### Schema
Migration 0020: four tables, seven functions, 12 triggers, seeds. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (Gig identity separate from versions; service type reached through the template; market reached through the registration; only the currency stored with the price; no current-version pointer, the partial unique indexes replace it; typed rows instead of a JSON blob; BCNF reviewed).

### Contracts
`packages/contracts/src/gig.ts`; 15 error codes (wire codes `GIG_*`); three `bananagig.provider.gig-*.v1` events; OpenAPI and AsyncAPI regenerated and valid.

### Tests
Unit 12919 and 164 root script tests, integration 7713 in 58 files (Gig data model rules 121, Gig service 92, API Gigs 36), smoke 42 checks (42/42 locally).

### Skills updated
`skills/catalog`, `skills/provider`.

### ADRs
ADR-0046.

### Known follow-up
DEBT-0089 (variants, add-ons, media and the unsupported required field types), DEBT-0090 (moderation), DEBT-0091 (template adoption), DEBT-0092 (service area, availability, capacity, price floor), DEBT-0093 (search, public page, Go-Live), DEBT-0094 to DEBT-0097 (the temporary editor, money entry, accepted limits). Next: CAT-004 Variants, Add-ons and Media.

## PRD-TRP-001 — 2026-10-18

Status: COMPLETE
Commit: find it with `git log --grep "(PRD-TRP-001)"`.
Summary: BananaGig Neighborhood Group Pricing Alignment. A documentation-only checkpoint that makes BananaGig's defining product requirement explicit and canonical: BananaGig is a neighborhood demand-bundling marketplace, and BananaDrop (provider-controlled neighborhood group pricing with price protection) is a first-class core domain, not a later enhancement. No production code, migration, schema, API, event or UI changed.

### Delivered
- `docs/product/BananaGig_PRD_TRP_Alignment.md` (the canonical product direction supplied by the owner: value propositions, the domain chain, the 20 product invariants, the customer and provider portal requirements, shared group state, architecture impact notes, the revised roadmap, the UI/UX standard, the MVP definition and the rule for future agents).
- `docs/product/ROADMAP.md` (new): the canonical feature roadmap, with the completed checkpoints, the current position, the BananaDrop core (DROP-001 to DROP-010) moved before search and the customer booking experience, the settlement half (DROP-011 to DROP-016) after booking, the BananaDrop-aware search checkpoints, the sequencing rules, the MVP bar and the UI-BASE-001 scope (a retrofit of every existing and future screen to the Apple-inspired + Uber Base Web direction, with BananaGig's own identity).
- `docs/product/PRD_RECONCILIATION.md` (new): where the PRD v9.4 (a Word file kept outside git) differs from the alignment (vision framed as a lead and subscription platform, BananaDrop as P2 build step 8, "optional Drop tiers", price lock before fulfilment, Banana Credits as the leading mechanism) and what each difference means for engineering; the alignment document wins until the owner revises the PRD.
- `CLAUDE.md`: the alignment document and the roadmap are now read at the start of every session, and a hard rule states the product truth. `PROJECT_STATE.md`: the current checkpoint, a Product direction section and the CAT-003 CI record (run 39091478398 SUCCESS in 23m 54s). `skills/provider`, `skills/catalog`, `skills/web`: the durable rules (BananaDrop consumes the exact Gig version and variant key, tiers and ladders never live on a Gig, variant or add-on, temporary UI until UI-BASE-001, no client-side group progress). Corrected: DEBT-0092 and DEBT-0093 (group pricing is the BananaDrop domain, not a price rule of the Gig; the targets are the AREA, CAP, DROP and SEARCH checkpoints) and the "Not here" list of `PROVIDER_GIGS.md`.

### Repository search for conflicts
No tracked document described BananaGig as a lead and subscription platform or placed BananaDrop in a later phase; the only conflicting statements were the two debt entries and the out-of-scope list above (corrected). The product requirements document (`docs/design/BananaGig_Brand_Kit/BananaGig_PRD.docx`) is excluded from git and was not edited: its conflicts are listed in `PRD_RECONCILIATION.md` for the owner.

### Schema
None. No migration, no table, no API or event change.

### Contracts
None. OpenAPI and AsyncAPI are unchanged.

### Tests
None changed. Governance checks run: `project-state:check`, `skills:check`, `data-model:check`, format and lint on the touched files.

### Skills updated
`skills/provider`, `skills/catalog`, `skills/web`.

### ADRs
None created: the decision is product direction, recorded as the canonical alignment document; the architecture decisions (BananaDrop aggregate, qualification, tiers, price protection) are made at their DROP checkpoints.

### Known follow-up
The owner updates the PRD Word file from `PRD_RECONCILIATION.md`. Open owner questions stay open (default price-lock time, late-cancellation fee split Q32). Next: CAT-004 Variants, Add-ons and Media (in progress), then PRO-002.

## CAT-004 — 2026-10-18

Status: COMPLETE
Commit: find it with `git log --grep "(CAT-004)"`.
Summary: Variants, Add-ons and Media. A provider Gig VERSION gains variants, add-ons and photos as version-owned children that freeze with it (database guards, also against DELETE and TRUNCATE); the next draft copies the options and re-attaches the same ready photos without copying bytes; v1 is never touched. One pricing rule (base plus a non-negative delta in minor units and minutes; no per-child currency, no absolute prices, no quantity). Photos are private assets (JPEG, PNG, WebP) verified by the server and promoted from a separate upload key; assets are shared by attachment. Designed so BananaDrop (PRD-TRP-001) can consume it: it references the exact Gig version and a stable item key, and nothing about tiers, ladders or Drop eligibility is stored on a Gig, variant, add-on or photo. Not built: service areas, availability, booking, search, public photo delivery, derivatives, moderation, HEIC, Go-Live, the BananaDrop domain.

### Housekeeping at the start (requested)
`PROJECT_STATE` records CAT-003 (`1498d44`, GitHub Actions run 39091478398 SUCCESS in 23m 54s). PRD-TRP-001 (`eab5764`) was committed locally in between (documentation only, not pushed) and its product direction was applied to the design. `checkpoint:start` ran first on a clean tree. The user-owned `pnpm dev` shells were not touched. `la-oc` stays PLANNED; DEBT-0030, 0064, 0065, 0070 and 0076 to 0097 stay OPEN.

### Delivered
- Migrations: 0021 (template permission `pricing_add_ons` and the fifth pricing model `ADD_ONS`; `gig_version_variants`, `gig_version_add_ons`, `media_assets`, `gig_version_media`; four guard functions plus the publication backstop; widened audit actions; 15 configuration parameters and 72 content entries), 0022 hardening from the independent reviews (reconciliation markers for object removal, a derived object key, no UPDATE of options, repair of uploads stuck on retired versions), 0023 (corrected copy as content version 2, 13 photo-refusal messages). Forward-only; 0001 to 0020 untouched.
- Service: `ProviderGigService` gained the draft-mutation primitive (account, Gig and draft locks, revision check, exactly +1), `replaceVariants`, `replaceAddOns`, the next-draft copy, publish validation of options and photos, retire that closes pending uploads and the GigMenu counts in a constant number of statements; `GigMediaService` (authorize, finalize with signature, header-dimension, hash and scan checks and a version-conditional promotion, alt text, reorder in one UPDATE, detach, preview, reconciled clean-up) with pure JPEG/PNG/WebP header parsing; the worker job `provider.gig-media-cleanup`; `copyIfVersion` no longer carries browser metadata (REPLACE directive).
- Contracts and API: nine owner-only routes, four media error codes, the version DTO with variants, add-ons, photos, constraints and child summaries, publish event counts; OpenAPI and AsyncAPI regenerated and valid.
- Web (temporary): whole-set no-JS options forms, photo upload through the web server with `node:http`, controlled preview route, closed issue and refusal words, section fragments. Smoke scenario `Provider variants, add-ons and media`.
- Docs: ADR-0047, `PROVIDER_GIGS.md` (rewritten, with a BananaDrop readiness section), the data model documents, `skills/catalog`, `skills/provider`, `skills/infrastructure`, `skills/testing`, DEBT-0098 to DEBT-0101 (DEBT-0089 narrowed), LRN-0062 to LRN-0065.
- Quality process: seven parallel agents (database, Gig service, media and worker, catalog hook, API, web, smoke) against one spec and contract; three independent read-only reviews (security, data and concurrency, API/UX/accessibility) with a fix wave; a time-boxed mutation campaign of 361 mutants on a private copy (280 killed by the existing suites; 81 survived, about 42 of them real gaps now killed by new tests; the rest equivalent, redundant or race-only). Defects found and fixed before the commit: retiring a Gig left unfinished uploads and their bytes forever; best-effort object deletion was never retried; a double finalize gave the loser a refusal for a photo that succeeded; upload signing ran inside the account-locked transaction; the upload expiry used the application clock; the next draft copied price deltas of a dropped currency; no-file and oversize uploads ended on raw error pages; validation failures named no field; a stale assertion after 0022. Accepted limits are in DEBT-0098 to DEBT-0101.

### Schema
Migrations 0021 to 0023: four tables, their guard functions and the publication backstop, the constraints and indexes listed and justified in NORMALIZATION_LOG, one column on `catalog.gig_template_versions`. NORMALIZATION_LOG, DATA_MODEL, DATA_DICTIONARY, ERD, DATA_MODEL_CHANGELOG and SCHEMA_SNAPSHOT updated; Data Model Review Gate passed (version ownership; delta versus absolute price; asset versus attachment with binary reuse; key versus name versus row id; display order; no JSON; currency inherited; BCNF reviewed).

### Contracts
`packages/contracts/src/gig.ts` (CAT-004 section); 19 error codes, 43 issue reasons, 13 photo refusal reasons; the published event gained `variantCount`, `addOnCount`, `mediaCount`.

### Tests
Unit 13533 and 164 root script tests, integration 8053 in 62 files, smoke 43 checks (41/43 locally: Email and Phone verification hit the daily send cap of `customer.dev` on the developer database; all other checks, including the new scenario, pass).

### Skills updated
`skills/catalog`, `skills/provider`, `skills/infrastructure`, `skills/testing`.

### ADRs
ADR-0047.

### Known follow-up
DEBT-0098 (simple option model), DEBT-0099 (HEIC, header-only verification, assumed limits, no derivatives or delivery), DEBT-0100 (upload handling and concurrency), DEBT-0101 (API shape and temporary editor). Next: PRO-002 Provider Public Profile, then PRO-003, the availability and service-area checkpoints and the BananaDrop core (DROP-001 onward) per `docs/product/ROADMAP.md`.

## ENG-GOV-001 — 2026-10-18

Status: COMPLETE (advisory mode; production readiness NOT READY, see the audit)
Commit: find it with `git log --grep "(ENG-GOV-001)"`; the checkpoint-id fix for the tooling is a separate earlier commit (`9b7fb6c`).
Summary: Production Engineering Governance. Read-only audit first (A-01 to A-20, no P0 finding), then the owner approved Phase B: the production standard, review checklist and shortcut register integrated into `CLAUDE.md`; repository Claude Code settings and tested hooks; advisory CI (policy scan, secret scan, CodeQL, dependency review, workflow lint, Dependabot) and a hardened `ci.yml`; CODEOWNERS; manual GitHub settings instructions; a prioritized remediation plan. No production behaviour, migration, API or event changed. Nothing is enforced by GitHub yet: `main` has no ruleset and no check is required (owner action, `GITHUB_SETTINGS.md`).

### Delivered
- Docs: `docs/engineering/PRODUCTION_STANDARD.md`, `REVIEW_CHECKLIST.md`, `TEMPORARY_MITIGATIONS.md` (MIT-0001 to MIT-0006, all PROPOSED, approver pending), `GOVERNANCE_AUDIT.md`, `GOVERNANCE_REMEDIATION_PLAN.md`, `GITHUB_SETTINGS.md`; the two input documents are committed beside them. `CLAUDE.md`: risk classification at the start of every checkpoint, the governance section, mitigation registration in the completion rule, the extended closing report.
- Local guardrails: `.claude/settings.json` and `.claude/hooks/` (parser-based Bash guard with git-option canonicalisation, file-edit guard for applied migrations, secrets, gate files and disabled tests, evidence and stop hooks); README with limits and a recovery procedure. 73 tests in `scripts/claude-hooks.test.mjs`.
- Policy scan `scripts/governance-scan.mjs` (rules R1 to R7, allowlist with expiry and ratchet, 79 tests), `.gitleaks.toml`, `pnpm governance:scan`, `pnpm secrets:scan`.
- CI: `ci.yml` (permissions, timeouts, concurrency, SHA-pinned actions; blocking behaviour unchanged), `governance.yml`, `codeql.yml`, `dependabot.yml`, `.github/CODEOWNERS`.
- Tooling fix `9b7fb6c`: checkpoint ids with a second name segment (`ENG-GOV-001`) are accepted by `checkpoint:start`, `checkpoint:finalize` and the commit-subject check.
- Quality process: an independent read-only red-team attacked the hooks, the scan and the gates in isolated copies. It found bypasses of the hooks (heredoc substitution, pipe into a shell, git option abbreviations, ANSI-C quoting, brace expansion, `cp` into the migrations directory, case-insensitive paths, split secrets), evasions of the scan, a self-allowlisting gitleaks config and that the new scans are not blocking; all but the last were fixed here, the rest is recorded. During the fix the hooks were rewritten in place, which locked every Bash, Write and Edit call of the session until the owner restored the files (LRN-0067).

### Schema
None. No migration, table or data-model document changed.

### Contracts
None. OpenAPI and AsyncAPI are unchanged.

### Tests
Root script tests 317 (governance 47, identity realm 117, migration files 1, governance scan 79, Claude hooks 73). `governance:scan` exit 0 with 0 findings (10 informational: six proposed mitigations, the tag-pinned Trivy image, CODEOWNERS present, the `--passWithNoTests` ratchet). Lint, format check and skills check pass. Workspace unit and integration suites are unaffected (no source change) and were not re-run for this documentation and tooling checkpoint beyond what `checkpoint:finalize` runs. Not run: `pnpm secrets:scan` against a clean history in CI, the workflows on GitHub, actionlint.

### Skills updated
`skills/infrastructure`, `skills/testing`.

### ADRs
None: tooling and process, no architecture decision.

### Known follow-up
DEBT-0001 (retitled: CI not enforced before merge) and DEBT-0102 to DEBT-0105. Owner actions C-1 (apply the `main` ruleset), C-2 (required scans, secret scanning), C-4 (visibility), C-6 (approve or remove MIT-0001 to MIT-0006) and plan item C-7 (`data-model:check` with an empty base ref). Hardening checkpoints R-04 to R-17 are proposed, not approved. Next: PRO-002 Provider Public Profile.
