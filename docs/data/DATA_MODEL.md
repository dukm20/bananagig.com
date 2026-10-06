# Data Model (as of CFG-002)

Describes what exists in the database today, verified against a database migrated from zero. No business tables exist. Conventions: `DATABASE_CONVENTIONS.md`; migration rules: `MIGRATION_POLICY.md`; review rules: `DATA_MODEL_GUARDRAILS.md`; exact structure: `SCHEMA_SNAPSHOT.sql`.

## Schemas and ownership

| Schema | Class | Contents | Notes |
|---|---|---|---|
| `public` | application (bookkeeping) + extension | `schema_migrations` (application); `spatial_ref_sys` and PostGIS objects (extension) | Infrastructure only; product tables never go here (ADR-0008) |
| `integration` | **application** | `outbox_events` | Created in INF-003; cross-domain integration infrastructure |
| `configuration` | **application** | 10 tables: `scope_levels`, `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` | Created in CFG-001; the product configuration registry |
| `content` | **application** | 8 tables: `locales`, `entries`, `entry_variables`, `versions`, `version_approvals`, `snapshots`, `snapshot_items`, `audit_events` | Created in CFG-002; the managed content and localization registry. Reuses `configuration.scope_levels` (no second scope hierarchy) |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queue `infra.ping` | Created by the worker on start; never altered by our migrations |
| database `keycloak` | infrastructure (Keycloak) | Identity provider tables | Separate database and role |

Extensions: `plpgsql`, `postgis 3.6`, `btree_gist` (extension-owned; supports the no-overlap exclusion constraints on `configuration.value_versions` and `content.versions`). **Deferred schemas** (created by the first feature that needs them): identity, geography, catalog, provider, capacity, search, booking, finance, banana_credit, subscription, tax, messaging, trust, admin, audit.

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

### `content.*` (CFG-002): the content and localization registry

Managed product copy (UI text, message templates, help articles, legal documents) as stable keys with localized, effective-dated, immutable versions. Normalized model; full column documentation in `DATA_DICTIONARY.md`, relationships in `ERD.md`, behavior in `docs/engineering/CONTENT.md`. Content is not configuration: values that tune behavior stay in `configuration.*`.

| Table | Role |
|---|---|
| `content.locales` | Registry of locales (canonical BCP 47 subset). `is_active` controls what may be served; the `is_platform_default` row (always active) is the last resort of every fallback chain: the unique index allows at most one, the guard trigger refuses to unset it (a migration moves it by disabling the guard inside its own transaction), and the resolver fails with `UNAVAILABLE` (`NO_PLATFORM_DEFAULT`) if none exists. Seeded with `en-US` only (structural reference data, not copy). Rows are never deleted |
| `content.entries` | Stable identity of one piece of content: unique dotted `key`, `content_type`, `owner_role`, `sensitivity`, `criticality`, `approval_policy`, `fallback_policy`, `max_scope_type`. Immutable except `is_active`. Legal documents are entries with `content_type = 'LEGAL'` (forced owner, policy, criticality and fallback by check constraint) |
| `content.entry_variables` | Typed placeholders of an entry, shared by every locale and version. Immutable; no required variable once the entry has versions |
| `content.versions` | One row per (entry, locale, scope, version number) holding the template body and its own lifecycle `DRAFT -> IN_REVIEW -> APPROVED -> SCHEDULED/PUBLISHED -> SUPERSEDED`, plus `REJECTED`, `CANCELLED`. Body immutable from creation; half-open validity `[effective_from, effective_to)`; exclusion constraint `ex_versions__no_overlap` forbids overlapping published rows per holder |
| `content.version_approvals` | Immutable review decisions, one per approver per version; trigger blocks self-approval under SECOND_APPROVER and requires the version to be `IN_REVIEW` |
| `content.snapshots`, `content.snapshot_items` | Immutable record of a resolution (requested locale, context, evaluation time) plus the exact version used per entry (snapshot reads expose no `effective_to`, so a read-back is byte-stable). Created only for copy that must be reproducible; routine UI labels are never snapshotted |
| `content.audit_events` | Append-only audit of every content mutation (actor, action, entry, locale for locale actions only, versions tied to the entry by composite foreign keys, reason, correlation id); bodies are never copied |

Scope reuse: `content.entries.max_scope_type` and `content.versions.scope_type` are foreign keys to `configuration.scope_levels`, so the platform has ONE scope hierarchy. Content uses only `PLATFORM < COUNTRY < MARKET` (a check restricts the values; specificity comes from `scope_levels.rank`). `versions.scope_ref` is an opaque text reference with no foreign key, the same polymorphism choice as ADR-0016 / DEBT-0024.

Legal documents are `LEGAL` entries, not a separate table family. Future acceptance records (ID-005) will reference `content.versions.version_id` (immutable) and `body_sha256`; no legal-specific table exists.

## Migrations

| File | Content |
|---|---|
| `0001_infra_baseline.sql` | PostGIS extension (immutable; predates the header rule) |
| `0002_database_foundation.sql` | `schema_migrations`: `version` as primary key, `duration_ms`, naming/consistency constraints |
| `0003_integration_outbox.sql` | `integration` schema and `outbox_events` |
| `0004_configuration_registry.sql` | `btree_gist` extension; `configuration` schema with 10 tables, reference data for the scope hierarchy, immutability/workflow guard triggers |
| `0005_content_registry.sql` | `content` schema with 8 tables, the `en-US` launch locale, guard triggers (immutability, lifecycle state machine, self-approval, `body_sha256` computation), no-overlap exclusion constraint on published versions |
| `0006_content_seed_shell_copy.sql` | seeds 8 shell entries through the lifecycle (data only) |

Latest migration: `0006_content_seed_shell_copy.sql`. Ownership: application migrations are applied by `pnpm migrate`; `pgboss.*` by pg-boss; Keycloak by Keycloak.

## Intentional denormalization

| Where | What | Why | How drift is prevented |
|---|---|---|---|
| `schema_migrations.version` | derived from `filename` prefix | numeric ordering and a compact primary key | `ck_schema_migrations__filename_matches_version` |
| `outbox_events.event_version` | derived from the `event_type` suffix | the event envelope carries the version explicitly | `ck_outbox_events__version_matches_type` |
| `change_requests.approval_policy` | copy of `parameters.approval_policy` at request time | the policy that governed a request must not change retroactively | immutable after DRAFT (`guard_change_requests`) |
| `value_versions.effective_to` | `effective_to` of a version equals the `effective_from` of its successor | explicit validity makes overlap prevention a database constraint | closed exactly once by the publisher in the same transaction; guarded by trigger and exclusion constraint |
| `parameters.validation_rules`, `value_versions.value`, `snapshots.context` | JSON documents | shape depends on the data type; read back whole, never queried relationally | validated by the service against the definition before insert; object/type checks in the database |
| `content.versions.approval_policy` | copy of `content.entries.approval_policy` at version creation | the policy that governed a version must not change retroactively | trigger `content.guard_versions` requires equality with the entry at insert and forbids change afterwards (entry policy itself is immutable) |
| `content.versions.body_sha256` | derived hash of `body` (SHA-256 hex of the UTF-8 text) | later consent/audit records bind to the exact text without copying it; cheap integrity comparison | computed by the insert trigger (the caller value is ignored); body and hash immutable afterwards |
| `content.snapshot_items.entry_id` | repeats `content.versions.entry_id` | primary key `(snapshot_id, entry_id)` guarantees one version per entry per snapshot | composite foreign key `(version_id, entry_id) -> content.versions (version_id, entry_id)` makes drift impossible |
| `content.versions.effective_from` | proposed start while unpublished, raised once to the publication instant | one column serves "requested start" and "actual start"; avoids a second timestamp and a separate publication table | trigger allows a change only on the `APPROVED -> SCHEDULED/PUBLISHED` transition and only upward; immutable afterwards |
| `content.entry_variables.example_value`, `content.snapshots.context` | JSON documents | shape depends on `var_type` (scalar or `{amount_minor, currency}`), or is an input copy; read back whole, never queried relationally | validated by the service; `ck_snapshots__context_object` in the database. `versions.body` is plain text, not JSON |
| `content.versions.status` SCHEDULED/PUBLISHED/SUPERSEDED | workflow markers, not "is current" flags | the exclusion constraint and the lifecycle need to distinguish published from unpublished rows | which version applies is always derived from the timestamps; resolution never depends on the activation job |

## Stores and authority

| Store | Role | Authoritative? |
|---|---|---|
| PostgreSQL | Transactional state, jobs (pg-boss), **committed events (outbox)** | **Yes** |
| Valkey (configuration cache) | Cache and last-known-good copies of resolved configuration | No: PostgreSQL is authoritative; CRITICAL parameters are never cached |
| NATS JetStream | Event transport (stream `BANANAGIG_EVENTS`, 7-day retention, 2-minute duplicate window) | No: events originate from the outbox |
| Valkey (content cache) | Cache and last-known-good copies of resolved (un-rendered) content entries, plus generation counters for invalidation | No: PostgreSQL is authoritative; CRITICAL and LEGAL entries are never cached nor served from last-known-good |
| Valkey | Cache, derived state, rate limits | No (rebuildable, TTL on every key) |
| OpenSearch | Search projection | No (rebuilt from PostgreSQL) |
| SeaweedFS (S3) | Media/blobs | Authoritative for blob bytes; PostgreSQL holds metadata |

## Identity boundary (INF-004: no schema change)

Keycloak (database `keycloak`, infrastructure-owned) owns credentials, protocol sessions and MFA factors. BananaGig will reference identities by the immutable Keycloak `sub` in a future `identity.external_identities` table (unique on provider + subject), created by the first persisted account feature (ID-001) through the Data Model Review Gate. No user or profile table exists and none was needed for INF-004. Web sessions live in Valkey (non-authoritative, TTL on every key). See `docs/engineering/IDENTITY.md`.

## ERD

See `ERD.md`.
