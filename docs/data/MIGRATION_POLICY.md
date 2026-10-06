# Migration Policy

## Policy: forward-only

Migrations are **forward-only SQL**. There are no down migrations. (ADR-0010)

| Situation | What we do |
|---|---|
| **Local development** | Throw the database away and rebuild from zero: `pnpm stack:reset` (or drop and recreate a scratch database). Rebuilding from zero is the supported "rollback" |
| **Before production deployment** (a migration not yet applied anywhere shared) | Fix it in the working tree and re-run on a fresh database. A migration that has been applied to any shared or long-lived database counts as applied |
| **Production / shared environments** | **Forward-fix**: write a new migration that corrects the problem. Never edit, delete or rename an applied migration. Data restores come from backups (see `docs/engineering/LOCAL_DEVELOPMENT.md` for the dev procedure), not from reverse DDL |
| **Destructive changes** | Only through expand / migrate / contract (below), across separate checkpoints |

## Runner rules (`scripts/lib/migrator.mjs`, `pnpm migrate`)

1. File names: `NNNN_snake_case.sql`, versions contiguous from 0001, applied in version order. Duplicate versions, gaps and bad names fail validation.
2. Applied migrations are immutable: the SHA-256 checksum of every applied file is verified on every run; an edited, deleted or renamed applied file aborts the run.
3. One transaction per file, with the bookkeeping row inserted in the same transaction. A failing migration rolls back completely and is never recorded; the run stops at the first failure (fail fast).
4. One runner at a time: a session advisory lock (key `7265001`) with a timeout (`MIGRATION_LOCK_TIMEOUT_MS`, default 60 s). A second runner waits, then finds everything applied (no-op) or fails with a clear error when the lock is not released in time.
5. Safety timeouts: `statement_timeout` 10 min and `lock_timeout` 30 s for migration sessions, so DDL never queues indefinitely behind other locks.
6. Bookkeeping (`public.schema_migrations`): `version` (PK), `filename` (unique), `checksum`, `applied_at`, `duration_ms`. `version` is derived from the filename and kept consistent by a CHECK constraint (documented intentional denormalization). 0001 predates `duration_ms`, so its duration is NULL.
7. Transaction-incompatible statements (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` in some cases) are not supported yet; they need a reviewed `no-transaction` mode (DEBT-0014).
8. `pnpm migrate --check` verifies checksums and lists pending migrations without applying.

## File convention

Every migration from 0002 on starts with these header comments (enforced by the runner and `pnpm data-model:check`):

```sql
-- checkpoint: INF-003
-- purpose: <what and why>
-- rollback strategy: <forward-fix plan; local: rebuild from zero>
-- backfill: <what data is rewritten/derived, or "none">
-- risk: <locking, duration, data-loss, compatibility>
```

A migration containing a destructive statement (`DROP TABLE/COLUMN/SCHEMA/INDEX/CONSTRAINT/TYPE`, `TRUNCATE`, `DELETE FROM`, column type change) must also carry:

```sql
-- destructive: <justification and the expand/migrate/contract step it belongs to>
```

0001 is grandfathered (it predates the header rule) and must never be edited.

## Expand / migrate / contract

Breaking changes (rename a column, change a type, split a table, drop structure) never happen in one step.

1. **EXPAND**: add the new structure alongside the old (nullable column, new table, new index). Old code keeps working. Migration is additive.
2. **MIGRATE**: backfill and, if needed, dual-write from application code. Backfills run as batched, resumable jobs or a bounded migration, never as one unbounded transaction on a large table.
3. **VERIFY**: prove old and new agree (count and checksum queries, a verification query recorded in the checkpoint, tests). Switch reads to the new structure. Keep the old structure in place for at least one full checkpoint.
4. **CONTRACT**: in a **later checkpoint**, remove the old structure, with `-- destructive:` referencing the verification evidence.

**No checkpoint may combine CONTRACT with an unverified MIGRATE of live data** unless the user explicitly approves it in the checkpoint prompt. The expand/migrate/contract flow is exercised by `0002_database_foundation.sql` on a tiny table (add `version`, backfill, enforce NOT NULL, swap the primary key), with its destructive step marked, and by `packages/testing/src/migrations.itest.ts` for the validation rules.

## Checklist for every migration

1. Next contiguous number; headers filled in honestly.
2. Applies from zero (`createIsolatedDatabase`) and on top of the previous state.
3. Naming and type conventions followed (`DATABASE_CONVENTIONS.md`).
4. Constraints and indexes included in the same migration.
5. Data-model gate: `pnpm schema:snapshot --write`, `pnpm data-model:check <ID>`; docs, dictionary, ERD, changelog and normalization log updated.
6. Integration test for new constraints and any new locking behaviour.
