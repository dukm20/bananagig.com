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
- Spatial columns: GiST index usable (`enable_seqscan = off` plus EXPLAIN) and ST_DWithin in meters (`postgis.itest.ts`). A spatial column nobody filters by yet (`geography.addresses.location`) gets no index until the first spatial query adds it through its own review.

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
- When the unit of history is a document, keep one versions table that carries its own lifecycle and a guard trigger for the state machine (content, ADR-0018). Compute integrity hashes in an insert trigger (`content.versions.body_sha256`), use `UNIQUE NULLS NOT DISTINCT` for holder keys with a nullable scope reference, and seed product text through the real lifecycle inside a `DO` block so guards, audit and the exclusion constraint all apply (migration `0006`); never insert PUBLISHED rows directly or disable triggers.
- For reference data with an activation status (geography, ADR-0021): a guard trigger makes the initial status one-way (PLANNED is never written back) and refuses ACTIVE without its ACTIVE dependencies; the activation reads dependency rows with `FOR SHARE` while a deactivation needs the row lock, so exactly one of two racing changes wins; link rows are immutable (a BEFORE UPDATE `forbid_mutation` trigger, add or delete only). Use one lock order in triggers and service (children first by id order, then the owner, then the dependency rows), lock a row with a bare `SELECT 1 ... FOR UPDATE|SHARE` and read it in a second statement (joined and `ARRAY(subselect)` columns are stale after a lock wait in READ COMMITTED), and let a rule that reads sibling rows lock the owning row first. Give every guard `RAISE` a machine-readable `DETAIL = 'geography_rule:<KEY>'` so the service classifies on the key, never on message text; accept that a raw SQL update locks its row before its trigger can run, so some inversions remain and surface as retryable `40P01`. Express "a child may only use what its parent supports" with composite foreign keys (`uq_markets__market_country`, `market_locales (country_id, locale)`) and "default is one of the members" with a DEFERRABLE INITIALLY DEFERRED composite key to the membership table. Validate names against the engine's own data (`pg_timezone_names` for IANA zones) and derive parts of a code with generated columns (`content.locales.language`, `script`, `region`) instead of parsing in code. Seed reference rows in the same order the service would (created PLANNED, linked, then activated) so the guards run.
- An immutable row can double as a snapshot (geography, ADR-0023): refuse UPDATE with a trigger, make enrichment an insert of a new row, let owning tables reference the row with `ON DELETE RESTRICT`, and do not copy its columns into a snapshot table (personal data in two places). A value that is denormalized on purpose but must stay consistent travels through a composite foreign key that includes it (`geography.addresses (administrative_area_id, country_id, administrative_area_code)` to a unique key on the parent), so the copy cannot drift; give the parent the supporting `UNIQUE` key the composite reference needs.
- For versioned, effective-dated definitions (address formats, ADR-0023) a draft is the future published row: create it complete and immutable, publish once through a guard trigger that raises the start only upward, keep the periods half-open with a partial gist exclusion constraint on the published rows, close the open end of the predecessor exactly once in the successor's transaction, and serialize publications by locking the owning country row (`FOR UPDATE`) first; the exclusion constraint stays the final arbiter. Seed such a row the way the service would (draft, fields, publish) so the guard runs.
- A current-state column kept next to its immutable history (identity, ADR-0025: `accounts.status` plus `account_status_history`) is guarded in BOTH directions by two DEFERRABLE INITIALLY DEFERRED constraint triggers (`identity.check_status_history` on the owner table, `identity.check_status_history_row` on the history table) that read the CURRENT owner row at COMMIT, never the row version that queued the event (a transaction that passes through a transient status is then fine): the newest history row equals the current state, and every history row continues the previous one (`from_status` is the previous `to_status`, NULL for the first), so a stray history row is refused. The service writes both in one transaction under the owner row lock.
- A "preferred" pointer to a child row is a composite foreign key to the OWN membership, `(account_id, primary_role_id)` to `account_roles (account_id, role_id)`, MATCH SIMPLE so NULL means none, plus a trigger for what a key cannot say (the membership is ACTIVE) and one that refuses leaving ACTIVE while it is the pointer (it locks the owner row first; lock order: owner row, then the reference row `FOR SHARE`, then the child rows). Create the owner without the pointer so the two tables reference each other with no deferred key; clear or move the pointer before deactivating the child. Prefer it to an `is_primary` flag plus a partial unique index (two rows to move, no foreign-key guarantee).
- Race-free get-or-create (identity, ADR-0025): never SELECT-then-INSERT alone. Insert the parent, the history row and the unique-keyed link in ONE transaction; the unique key admits one winner, the loser's 23505 rolls back its half-created parent, and it re-reads the winner's row (bounded attempts). Idempotent operations compare first and write nothing when nothing changes.
- PL/pgSQL does not short-circuit boolean operators: `OLD` does not exist for an INSERT, so never put `OLD.x` and `TG_OP` in one `OR` or `AND`; branch on `TG_OP` in separate statements (`identity.guard_accounts`). Guard errors use `DETAIL = 'identity_rule:<KEY>'`, the same machine-readable pattern as geography.
- Uniqueness policy as partial unique indexes (ID-002): "a verified address belongs to one account" is `UNIQUE (email_normalized) WHERE status = 'VERIFIED'`, while pending duplicates stay legal; "one open challenge per contact" is `UNIQUE (email_contact_id) WHERE used_at IS NULL AND invalidated_at IS NULL`. A multi-step replacement (disable the old primary, promote the new one) passes through states the immediate guards must allow and the whole-account invariant must forbid at COMMIT: use a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that re-reads the account's rows. Count sends as rows (one challenge per send) instead of a counter column that can drift; a hash column is `CHECK (col ~ '^[0-9a-f]{64}$')` and a keyed HMAC, never a plain hash of a low-entropy secret.

## Do not

- Do not edit applied migrations, hand-edit the snapshot, or write to `pgboss.*` / PostGIS objects.
- Do not store money as float or amounts without currency, and never mix Banana units into money columns.
- Do not use `SKIP LOCKED` or advisory locks for balances, credit lots, reservations or payments.
- Do not publish domain events outside the outbox, or set SERIALIZABLE globally.
- Do not log SQL text unless `DB_LOG_SQL=true` is deliberately set in local development.
- Do not add tables or schemas "for later".

## Related ADRs

ADR-0001, ADR-0004, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0021, ADR-0023, ADR-0025, ADR-0026

## Last reviewed

2026-10-07 (ID-002)
