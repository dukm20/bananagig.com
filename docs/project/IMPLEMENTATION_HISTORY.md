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
