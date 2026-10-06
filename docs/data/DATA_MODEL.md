# Data Model (as of CFG-001)

Describes what exists in the database today, verified against a database migrated from zero. No business tables exist. Conventions: `DATABASE_CONVENTIONS.md`; migration rules: `MIGRATION_POLICY.md`; review rules: `DATA_MODEL_GUARDRAILS.md`; exact structure: `SCHEMA_SNAPSHOT.sql`.

## Schemas and ownership

| Schema | Class | Contents | Notes |
|---|---|---|---|
| `public` | application (bookkeeping) + extension | `schema_migrations` (application); `spatial_ref_sys` and PostGIS objects (extension) | Infrastructure only; product tables never go here (ADR-0008) |
| `integration` | **application** | `outbox_events` | Created in INF-003; cross-domain integration infrastructure |
| `configuration` | **application** | 10 tables: `scope_levels`, `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` | Created in CFG-001; the product configuration registry |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queue `infra.ping` | Created by the worker on start; never altered by our migrations |
| database `keycloak` | infrastructure (Keycloak) | Identity provider tables | Separate database and role |

Extensions: `plpgsql`, `postgis 3.6`, `btree_gist` (extension-owned; supports the no-overlap exclusion constraint on `configuration.value_versions`). **Deferred schemas** (created by the first feature that needs them): identity, geography, catalog, provider, capacity, search, booking, finance, banana_credit, subscription, tax, messaging, trust, admin, audit.

## Application-owned tables

### `public.schema_migrations`
Migration bookkeeping. Columns: `version integer` (PK), `filename text` (unique), `checksum text`, `applied_at timestamptz`, `duration_ms integer` (nullable; NULL for 0001). Checks: `version > 0`, filename must match the zero-padded version, `duration_ms >= 0`. Rows are never updated or deleted.

### `integration.outbox_events`
Generic transactional outbox. One row per domain event, inserted in the same transaction as the state change; relayed to NATS JetStream by the worker; `published_at` marks completion. Key `outbox_event_id uuid` (also the event id and the JetStream message id). No foreign keys by design (domain-agnostic; `aggregate_id` is text). Partial indexes serve the relay (`idx_outbox_events__pending`) and retention purge (`idx_outbox_events__published_at`). Checks guard event-type format, version/type consistency, actor type, object payload, attempt counts. Business events do not exist yet; only the infrastructure `bananagig.infra.ping.v1` is produced (by the worker self-test).

### `configuration.*` (CFG-001): the product configuration registry

Normalized model; full column documentation in `DATA_DICTIONARY.md`, relationships in `ERD.md`, behavior in `docs/engineering/CONFIGURATION.md`.

| Table | Role |
|---|---|
| `configuration.scope_levels` | Canonical scope hierarchy as reference data (`PLATFORM` rank 0 ... `DROP` rank 7). Higher rank is more specific and wins |
| `configuration.parameters` | One typed definition per key: data type, validation rules, sensitivity, approval policy, criticality, owner. No default column (the PLATFORM value is the default) |
| `configuration.parameter_scopes` | Scope levels at which a parameter may be overridden (allowed overrides) |
| `configuration.parameter_values` | One holder per (parameter, scope level, scope reference). `scope_ref` has no foreign key by design; the composite FK to `parameter_scopes` enforces the allowed level |
| `configuration.value_versions` | Immutable published values with half-open validity `[effective_from, effective_to)`; exclusion constraint prevents overlap per holder |
| `configuration.change_requests` | Workflow: `DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED/ACTIVE -> SUPERSEDED`, plus `REJECTED`, `CANCELLED`. Content frozen after DRAFT; transitions guarded by trigger |
| `configuration.change_approvals` | Immutable decisions, one per approver per request; self-approval blocked by trigger under SECOND_APPROVER |
| `configuration.snapshots`, `configuration.snapshot_items` | Immutable record of a resolution: context and time, plus the exact version used per parameter |
| `configuration.audit_events` | Append-only audit of every mutation (actor, action, versions, reason, correlation id) |

Scope polymorphism choice: `scope_type` (FK to `scope_levels`) plus an opaque text `scope_ref`, with no foreign keys into domain tables that do not exist yet. Integrity of the *level* is enforced by the database; existence of the *referenced entity* is validated by the owning domain when it exists (DEBT-0024). ADR-0016.

## Migrations

| File | Content |
|---|---|
| `0001_infra_baseline.sql` | PostGIS extension (immutable; predates the header rule) |
| `0002_database_foundation.sql` | `schema_migrations`: `version` as primary key, `duration_ms`, naming/consistency constraints |
| `0003_integration_outbox.sql` | `integration` schema and `outbox_events` |
| `0004_configuration_registry.sql` | `btree_gist` extension; `configuration` schema with 10 tables, reference data for the scope hierarchy, immutability/workflow guard triggers |

Latest migration: `0004_configuration_registry.sql`. Ownership: application migrations are applied by `pnpm migrate`; `pgboss.*` by pg-boss; Keycloak by Keycloak.

## Intentional denormalization

| Where | What | Why | How drift is prevented |
|---|---|---|---|
| `schema_migrations.version` | derived from `filename` prefix | numeric ordering and a compact primary key | `ck_schema_migrations__filename_matches_version` |
| `outbox_events.event_version` | derived from the `event_type` suffix | the event envelope carries the version explicitly | `ck_outbox_events__version_matches_type` |
| `change_requests.approval_policy` | copy of `parameters.approval_policy` at request time | the policy that governed a request must not change retroactively | immutable after DRAFT (`guard_change_requests`) |
| `value_versions.effective_to` | `effective_to` of a version equals the `effective_from` of its successor | explicit validity makes overlap prevention a database constraint | closed exactly once by the publisher in the same transaction; guarded by trigger and exclusion constraint |
| `parameters.validation_rules`, `value_versions.value`, `snapshots.context` | JSON documents | shape depends on the data type; read back whole, never queried relationally | validated by the service against the definition before insert; object/type checks in the database |

## Stores and authority

| Store | Role | Authoritative? |
|---|---|---|
| PostgreSQL | Transactional state, jobs (pg-boss), **committed events (outbox)** | **Yes** |
| Valkey (configuration cache) | Cache and last-known-good copies of resolved configuration | No: PostgreSQL is authoritative; CRITICAL parameters are never cached |
| NATS JetStream | Event transport (stream `BANANAGIG_EVENTS`, 7-day retention, 2-minute duplicate window) | No: events originate from the outbox |
| Valkey | Cache, derived state, rate limits | No (rebuildable, TTL on every key) |
| OpenSearch | Search projection | No (rebuilt from PostgreSQL) |
| SeaweedFS (S3) | Media/blobs | Authoritative for blob bytes; PostgreSQL holds metadata |

## Identity boundary (INF-004: no schema change)

Keycloak (database `keycloak`, infrastructure-owned) owns credentials, protocol sessions and MFA factors. BananaGig will reference identities by the immutable Keycloak `sub` in a future `identity.external_identities` table (unique on provider + subject), created by the first persisted account feature (ID-001) through the Data Model Review Gate. No user or profile table exists and none was needed for INF-004. Web sessions live in Valkey (non-authoritative, TTL on every key). See `docs/engineering/IDENTITY.md`.

## ERD

See `ERD.md`.
