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

## CFG-002

Migration: db/migrations/0005_content_registry.sql (schema), db/migrations/0006_content_seed_shell_copy.sql (data only, no DDL: seeds 8 shell entries through the lifecycle)
Added: schema `content`; tables `content.locales` (seeded with the `en-US` active platform default), `content.entries`, `content.entry_variables`, `content.versions`, `content.version_approvals`, `content.snapshots`, `content.snapshot_items`, `content.audit_events`; functions and triggers `content.forbid_mutation` (immutable tables), `content.guard_locales`, `content.guard_entries`, `content.guard_entry_variables`, `content.guard_versions` (immutability, lifecycle state machine, scope bound, policy copy, `body_sha256` computation, one-time period changes), `content.guard_version_approvals` (IN_REVIEW only, no self-approval under SECOND_APPROVER)
Changed: none (`configuration.scope_levels` is referenced read-only)
Removed: none
Renamed: none

Relationships: `content.entries -> configuration.scope_levels (max_scope_type)`; `content.entry_variables -> content.entries`; `content.versions -> content.entries, content.locales, configuration.scope_levels (scope_type)`; `content.version_approvals -> content.versions`; `content.snapshot_items -> content.snapshots, content.versions (version_id, entry_id)`; `content.audit_events -> content.entries, content.versions via the composite keys (version_id, entry_id) and (previous_version_id, entry_id)` (a version named by an audit row must belong to the entry of the same row). `content.versions.scope_ref` deliberately has no foreign key
Constraints: unique entry key; key, content type, owner role, sensitivity, criticality, approval policy, fallback policy and max scope checks; `ck_entries__legal_policy` (LEGAL entries are owned by LEGAL, SECOND_APPROVER, CRITICAL, EXACT); BCP 47 subset check on locales and `ck_locales__default_is_active`; `ck_versions__platform_has_no_ref`, `ck_versions__scope_type`, status, body length 1..200000, `effective_to > effective_from`; `uq_versions__holder_version` (NULLS NOT DISTINCT) and `uq_versions__version_entry` (target of the snapshot composite FK); exclusion constraint `ex_versions__no_overlap` (gist, only SCHEDULED/PUBLISHED/SUPERSEDED rows, per entry, locale, scope); one decision per approver per version; audit action and subject-shape checks (`ck_audit_events__action`; `ck_audit_events__subject`: `locale` is set only for `LOCALE_*` actions, `ENTRY_*` actions name an entry only, `VERSION_*` actions name an entry and one of its versions, `previous_version_id` only on version actions); guard rules in the triggers: `content.guard_locales` refuses any UPDATE that unsets the platform default locale (a migration that moves it disables the guard inside its own transaction), `content.guard_versions` refuses closing `effective_to` in the past (the end may not be earlier than the start of the closing transaction, truncated to milliseconds)
Indexes: `uq_locales__platform_default` (partial unique: at most one default; together with the guard trigger that forbids unsetting it, exactly one exists from the seed onward), `idx_versions__resolution` (partial, published rows), `idx_versions__in_review` (partial), `idx_versions__scheduled` (partial), `idx_versions__entry` (history), `idx_audit_events__entry` (partial), `idx_audit_events__version` (partial); unique and exclusion constraint indexes

Backfill: none. `content.locales` receives one structural reference row (`en-US`, active, platform default); no translations are invented. Migration 0006 inserts 8 shell entries (each with one PUBLISHED `en-US` PLATFORM version and five audit rows: `ENTRY_CREATED`, `VERSION_DRAFTED`, `VERSION_APPROVED`, `VERSION_PUBLISHED`, `VERSION_ACTIVATED`) through the normal lifecycle, so guard triggers and the exclusion constraint apply (data only, no schema change, no outbox events)
Compatibility: new schema only. `integration.outbox_events` is reused for the content events (no change); `configuration.scope_levels` is reused read-only (foreign keys, restrict on delete)
Rollback: forward-fix only; locally rebuild from zero (`pnpm stack:reset`). The schema holds only the seeded launch locale until entries are created, so there is no data to preserve in a fresh environment
Reason: central, versioned, localized, auditable content registry so that user-facing copy (UI text, notifications, help, legal documents) is data with an approval trail and effective dates and never hardcoded strings; legal documents get stricter, immutable, hash-bound versions that future acceptance records (ID-005) can reference exactly
