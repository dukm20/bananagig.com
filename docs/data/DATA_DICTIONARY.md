# Data Dictionary

Every application-owned table has a `### schema.table` section with a row per column. `pnpm data-model:check` fails when a table in the schema snapshot has no section here. Infrastructure-owned schemas (`pgboss`, PostGIS) are documented by their upstream projects.

Format per column: name, type, nullability, default, meaning, and whether the value is immutable after insert.

### public.schema_migrations

Migration bookkeeping written by `scripts/migrate.mjs`. One row per applied migration file. Rows are never updated or deleted.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `filename` | text | no | none | Migration file name (`NNNN_description.sql`); primary key | yes |
| `checksum` | text | no | none | SHA-256 of the file when applied; a mismatch means an applied migration was edited and aborts the runner | yes |
| `applied_at` | timestamptz | no | `now()` | When the migration was applied | yes |
