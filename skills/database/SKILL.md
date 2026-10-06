# Database (PostgreSQL, PostGIS, migrations)

## Purpose

Change the schema safely and access PostgreSQL correctly through `@bananagig/database`.

## When to use

- Any migration, table, column, index, constraint, or query change.
- Any code that needs a transaction, row lock, advisory lock, timeout, or isolation level.
- Reviewing persistence-affecting work (the Data Model Review Gate).

## Canonical files

- `db/migrations/NNNN_description.sql`, `scripts/lib/migrator.mjs`, `scripts/migrate.mjs`
- `packages/database/src/index.ts`, `packages/database/src/policy.ts`, `packages/database/src/locks.ts`
- `packages/platform/src/outbox.ts`
- `packages/testing/src/index.ts` (isolated test databases), `packages/testing/src/database.itest.ts`, `packages/testing/src/locks.itest.ts`, `packages/testing/src/migrations.itest.ts`
- `docs/data/DATABASE_CONVENTIONS.md` (naming, UUID, time, money, locking, pools, PostGIS), `docs/data/MIGRATION_POLICY.md`
- `docs/data/DATA_MODEL_GUARDRAILS.md`, `docs/data/DATA_MODEL.md`, `docs/data/DATA_MODEL_CHANGELOG.md`, `docs/data/DATA_DICTIONARY.md`, `docs/data/ERD.md`, `docs/data/NORMALIZATION_LOG.md`, `docs/data/SCHEMA_SNAPSHOT.sql`
- `scripts/schema-snapshot.mjs`, `scripts/data-model-check.mjs`, `scripts/db-backup-test.mjs`

## Architecture rules

- PostgreSQL is authoritative; Valkey/OpenSearch/NATS are derived (ADR-0001, ADR-0003). Domain events are committed to the outbox, then relayed (ADR-0012).
- Forward-only, checksum-guarded SQL migrations; never edit an applied one; headers mandatory; destructive statements need a `-- destructive:` marker and expand/migrate/contract (ADR-0010).
- Product tables live in per-domain schemas created by the first feature that needs them (ADR-0008). Infrastructure- and extension-owned objects (`pgboss`, PostGIS, `keycloak`) are never altered by our migrations.
- Types: UUIDv4 `gen_random_uuid()` keys, `timestamptz`, money as `amount_minor bigint` + `currency char(3)`, Banana units as separate plain integers (ADR-0011). Names: `pk_`/`fk_`/`uq_`/`ck_`/`idx_`, keys `<entity>_id`.
- SQL-first access with Kysely (ADR-0004). The caller owns transaction boundaries; repositories never open one.
- Row locks for invariant-bearing rows (`FOR UPDATE`, consistent order, bounded waits, never across network calls); `SKIP LOCKED` only for queue claiming; advisory locks only for singletons, never for financial state.
- Every application connection has a statement timeout and an idle-in-transaction timeout (pool policy per role).

## Implementation pattern

1. Write `db/migrations/NNNN_description.sql` (next contiguous number) with the five header comments.
2. Add table types to `DatabaseSchema` in `packages/database/src/index.ts` as features need them (typed queries) or use `sql` templates.
3. Wrap multi-statement writes in `database.transaction(fn, { isolationLevel, readOnly, timeoutMs, lockTimeoutMs })`; nested calls join the outer one and may not change isolation. Use `applyRowLock(qb, strength, wait)` for locks; retry on `isRetryableConcurrencyError`.
4. Domain events: call `insertOutboxEvent(trx, ...)` inside the same transaction as the state change. Never publish to NATS directly.
5. Run the Data Model Review Gate: update `DATA_MODEL.md`, `DATA_MODEL_CHANGELOG.md`, `DATA_DICTIONARY.md` (every table and column), `ERD.md`, and add a full `NORMALIZATION_LOG.md` entry.
6. `pnpm schema:snapshot --write`, then `pnpm data-model:check <ID>`.

## Commands

```bash
pnpm dev:deps                                   # Postgres on 127.0.0.1:5433
set -a; . ./.env.host; set +a; pnpm migrate     # apply; `pnpm migrate --check` verifies checksums and lists pending
pnpm schema:snapshot --write                    # regenerate docs/data/SCHEMA_SNAPSHOT.sql from a scratch DB migrated from zero
pnpm data-model:check <ID>
pnpm test:integration                           # each file gets its own migrated database
pnpm db:backup-test                             # pg_dump -> restore -> verify (dev validation only)
```

## Testing requirements

- Integration tests use `createIsolatedDatabase()` (fresh `bananagig_t_*` database migrated from zero, dropped afterwards); never the dev database, never shared state.
- New tables: constraint-violation tests (each CHECK/UNIQUE/FK rejects bad data) and rollback tests.
- Locking code: prove blocking, NOWAIT/SKIP LOCKED behavior, and the retryable error codes (`locks.itest.ts` shows the patterns: two transactions and deferred barriers).
- Timeouts: assert SQLSTATE 57014 (statement) and 55P03 (lock).
- Spatial columns: GiST index usable (`enable_seqscan = off` plus EXPLAIN) and ST_DWithin in meters (`postgis.itest.ts`).

## Data-model considerations

This skill is the data-model process: see the review gate above, `DATABASE_CONVENTIONS.md` and `DATA_MODEL_GUARDRAILS.md`. Record intentional denormalization in `DATA_MODEL.md` and enforce it with a CHECK. `pgboss.*` and PostGIS objects are excluded from the snapshot. Idempotency records are deferred (DEBT-0013): add `integration.idempotency_records` with the first externally triggered write.

## Common failure modes

- Editing an applied migration (`Applied migration ... was modified`), or deleting/renaming one; add a new one.
- Missing header comments or an unmarked `DROP`/`DELETE`/type change (validation fails).
- Stale `SCHEMA_SNAPSHOT.sql` after a migration, or a table without a dictionary section.
- A long transaction holding locks across an HTTP/NATS call; nested `transaction()` with different isolation (throws `TransactionOptionError`).
- A query that hangs: check `statement_timeout`/`lock_timeout`; a pool that is exhausted: `db_pool_connections` metric and `connectionBudget()`.
- Building a PostGIS point from unvalidated lat/lng (silently coerced, LRN-0011).

## Known BananaGig-specific lessons

- The official `postgis/postgis` image has no arm64 build; Postgres is a custom image (LRN-0002).
- Host port 5433 (5432 is commonly taken, LRN-0009); integration tests need `pnpm dev:deps`.
- Core NATS publish cannot de-duplicate; the outbox relay uses JetStream message ids (LRN-0012).
- PostgreSQL 17 has no `uuidv7()`; revisit the key default on PostgreSQL 18 (ADR-0011).
- Local dev runs the app as the Postgres superuser (DEV ONLY, DEBT-0012); the target least-privilege role model is in `DATABASE_CONVENTIONS.md`.
- For history that must be immutable and non-overlapping, store a half-open range, add a gist exclusion constraint (`btree_gist`), and allow exactly one closure of the open end through a guard trigger (LRN-0015, ADR-0016). Reference tables for structural enums (for example `configuration.scope_levels`) are seeded by migration; business values are never seeded.

## Do not

- Do not edit applied migrations, hand-edit the snapshot, or write to `pgboss.*` / PostGIS objects.
- Do not store money as float or amounts without currency, and never mix Banana units into money columns.
- Do not use `SKIP LOCKED` or advisory locks for balances, credit lots, reservations or payments.
- Do not publish domain events outside the outbox, or set SERIALIZABLE globally.
- Do not log SQL text unless `DB_LOG_SQL=true` is deliberately set in local development.
- Do not add tables or schemas "for later".

## Related ADRs

ADR-0001, ADR-0004, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012

## Last reviewed

2026-10-05 (CFG-001)
