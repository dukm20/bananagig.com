# Data Model Changelog

Append-only. One entry per schema-changing checkpoint, newest last. Entries must use the template below; `pnpm data-model:check <ID>` verifies it whenever the schema snapshot changes.

```
## <CHECKPOINT>

Migration:
Added:
Changed:
Removed:
Renamed:

Relationships:

Constraints:

Indexes:

Backfill:

Compatibility:

Rollback:

Reason:
```

## INF-001

Migration: db/migrations/0001_infra_baseline.sql
Added: PostGIS extension; `public.schema_migrations` (created by the migration runner)
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: `schema_migrations` primary key on `filename`; `checksum` and `applied_at` NOT NULL

Indexes: primary key index only

Backfill: none

Compatibility: first migration; nothing depends on it yet

Rollback: drop the local database volume (`pnpm stack:reset`); no data exists to preserve

Reason: establish the migration baseline and spatial capability

## INF-002

Migration: none
Added: none
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: none

Indexes: none

Backfill: none

Compatibility: no schema change. The worker now creates the infrastructure queue `infra.ping` inside the pg-boss-owned `pgboss` schema (data, not DDL)

Rollback: not applicable

Reason: application skeleton checkpoint; the schema was reviewed and confirmed unchanged

## INF-003

Migration: db/migrations/0002_database_foundation.sql, db/migrations/0003_integration_outbox.sql
Added: `public.schema_migrations.version`, `public.schema_migrations.duration_ms`; schema `integration`; table `integration.outbox_events`; constraints and indexes listed below
Changed: `public.schema_migrations` primary key moved from `filename` to `version` (constraint renamed `pk_schema_migrations`); `filename` became unique
Removed: constraint `schema_migrations_pkey` (replaced by `pk_schema_migrations`)
Renamed: none

Relationships: none (the outbox is deliberately domain-agnostic with no foreign keys)

Constraints: `schema_migrations`: `pk_schema_migrations`, `uq_schema_migrations__filename`, `ck_schema_migrations__version_positive`, `ck_schema_migrations__filename_matches_version`, `ck_schema_migrations__duration_ms_nonnegative`. `outbox_events`: `pk_outbox_events` plus seven checks (event type format, version positive, version matches type, actor type, payload is object, attempts non-negative, published implies an attempt)

Indexes: `idx_outbox_events__pending` (partial, unpublished rows by due time), `idx_outbox_events__published_at` (partial, retention purge)

Backfill: `schema_migrations.version` parsed from the filename for already-recorded rows; `duration_ms` left NULL for 0001. The outbox starts empty

Compatibility: the migration runner bootstraps `schema_migrations` in its original shape and relies on 0002 to upgrade it, then records version and duration for 0002 onward; databases that only had 0001 upgrade in place

Rollback: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero

Reason: strengthen migration discipline (versioned, timed, uniquely keyed bookkeeping) and provide the transactional outbox required before the first event-producing feature (resolves DEBT-0002)

## INF-004

Migration: none
Added: none
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: none

Indexes: none

Backfill: none

Compatibility: no schema change

Rollback: not applicable

Reason: identity infrastructure only (Keycloak realm, token validation, web session in Valkey); the user/profile model and the external identity mapping are deferred to ID-001

## CFG-001

Migration: db/migrations/0004_configuration_registry.sql
Added: extension `btree_gist`; schema `configuration`; tables `scope_levels` (seeded with the 8 canonical scope levels), `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events`; guard functions and triggers (immutability, workflow transitions, no self-approval, parameter identity)
Changed: none
Removed: none
Renamed: none

Relationships: `parameter_scopes -> parameters, scope_levels`; `parameter_values -> parameter_scopes (parameter_id, scope_type)`; `value_versions -> parameter_values`; `change_requests -> parameter_scopes, value_versions`; `change_approvals -> change_requests`; `snapshot_items -> snapshots, parameters, value_versions`; `audit_events -> parameters, change_requests, value_versions`. `scope_ref` deliberately has no foreign key

Constraints: unique key per parameter; typed/enumerated check constraints on data type, sensitivity, approval policy, criticality, state, decision, action; `PLATFORM` takes no scope reference; half-open validity `effective_to > effective_from`; exclusion constraint `ex_value_versions__no_overlap` (gist, per holder); unique `(parameter_value_id, version)`; one decision per approver per request; published states require a version (`ck_change_requests__published_has_version`)

Indexes: `idx_value_versions__holder_effective` (resolution), `idx_change_requests__pending` (partial), `idx_change_requests__scheduled` (partial), `idx_change_requests__parameter` (history), `idx_audit_events__parameter`, `idx_audit_events__change_request` (partial); unique/exclusion constraint indexes

Backfill: none. `scope_levels` is structural reference data seeded by the migration

Compatibility: new schema only; `integration.outbox_events` is reused for the five configuration events

Rollback: forward-fix only; locally rebuild from zero

Reason: central versioned configuration registry required by every later domain (cancellation windows, review windows, Banana unit rules, retry policies) with no hardcoded business values

