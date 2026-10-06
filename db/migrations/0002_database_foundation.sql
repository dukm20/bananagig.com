-- checkpoint: INF-003
-- purpose: upgrade migration bookkeeping: numeric version as primary key, execution duration, naming-convention constraints
-- rollback strategy: forward-fix only (see docs/data/MIGRATION_POLICY.md); locally, recreate the database with `pnpm stack:reset`
-- backfill: version is parsed from the filename for already-recorded rows; duration_ms stays NULL for rows recorded before duration tracking existed (0001)
-- risk: low; the table only holds migration bookkeeping, is tiny, and the ALTERs run inside the runner's transaction under its advisory lock
-- destructive: replaces the filename primary key with version (expand: add version + backfill; contract: swap key). Safe because no other table references schema_migrations and the backfill is verified by the NOT NULL step in the same transaction

ALTER TABLE public.schema_migrations
  ADD COLUMN version integer,
  ADD COLUMN duration_ms integer;

UPDATE public.schema_migrations
   SET version = substring(filename FROM '^[0-9]{4}')::integer
 WHERE version IS NULL;

ALTER TABLE public.schema_migrations ALTER COLUMN version SET NOT NULL;

ALTER TABLE public.schema_migrations DROP CONSTRAINT schema_migrations_pkey;

ALTER TABLE public.schema_migrations
  ADD CONSTRAINT pk_schema_migrations PRIMARY KEY (version),
  ADD CONSTRAINT uq_schema_migrations__filename UNIQUE (filename),
  ADD CONSTRAINT ck_schema_migrations__version_positive CHECK (version > 0),
  ADD CONSTRAINT ck_schema_migrations__filename_matches_version CHECK (filename ~ ('^' || lpad(version::text, 4, '0') || '_[a-z0-9_]+[.]sql$')),
  ADD CONSTRAINT ck_schema_migrations__duration_ms_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0);

COMMENT ON TABLE public.schema_migrations IS 'Applied-migration bookkeeping written by the migration runner. Rows are never updated or deleted.';
COMMENT ON COLUMN public.schema_migrations.version IS 'Numeric prefix of the filename (derived, kept consistent by ck_schema_migrations__filename_matches_version).';
COMMENT ON COLUMN public.schema_migrations.duration_ms IS 'Execution time of the migration transaction; NULL for migrations recorded before tracking began.';
