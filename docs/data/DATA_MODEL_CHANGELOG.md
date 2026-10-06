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
