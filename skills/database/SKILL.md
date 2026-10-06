# Database (PostgreSQL, PostGIS, migrations)

## Purpose

Change the schema safely and access PostgreSQL correctly through `@bananagig/database`.

## When to use

- Any migration, table, column, index, constraint, or query change.
- Any code that needs a transaction, row lock, or isolation level.
- Reviewing persistence-affecting work (the Data Model Review Gate).

## Canonical files

- `db/migrations/NNNN_description.sql`, `scripts/migrate.mjs`
- `packages/database/src/index.ts`, `packages/testing/src/index.ts`, `packages/testing/src/database.itest.ts`
- `docs/data/DATA_MODEL_GUARDRAILS.md`, `docs/data/DATA_MODEL.md`, `docs/data/DATA_MODEL_CHANGELOG.md`, `docs/data/DATA_DICTIONARY.md`, `docs/data/ERD.md`, `docs/data/NORMALIZATION_LOG.md`, `docs/data/SCHEMA_SNAPSHOT.sql`
- `scripts/schema-snapshot.mjs`, `scripts/data-model-check.mjs`

## Architecture rules

- PostgreSQL is authoritative; Valkey/OpenSearch/NATS are derived (ADR-0001, ADR-0003).
- Forward-only SQL migrations; never edit an applied one (checksum-guarded, `pnpm migrate`).
- Product tables live in per-domain schemas (ADR-0008); `public` is infrastructure only. Create a schema in the first feature migration that needs it.
- Follow the 20 rules in `DATA_MODEL_GUARDRAILS.md` (uuid keys, `timestamptz`, money as integer minor units plus currency, constraints in the schema, FK indexes, audit, snapshots, idempotency, outbox).
- SQL-first access with Kysely (ADR-0004). No ORM. Business values never in schema defaults if they are configurable.

## Implementation pattern

1. Write `db/migrations/NNNN_description.sql` (next contiguous number, snake_case).
2. Add table types to `DatabaseSchema` in `packages/database/src/index.ts` as the feature needs them.
3. Wrap multi-statement writes in `database.transaction(async (trx) => ..., { isolationLevel, correlationId })`. Nested calls join the outer transaction. Take row locks with `FOR UPDATE` in a consistent order, never across a network call.
4. Run the Data Model Review Gate: update `DATA_MODEL.md`, `DATA_MODEL_CHANGELOG.md`, `DATA_DICTIONARY.md` (every table has a `### schema.table` section), `ERD.md` if foreign keys changed, and add a full `NORMALIZATION_LOG.md` entry (1NF, 2NF, 3NF, BCNF, duplicates, derived fields, denormalization, indexes, final decision).
5. `pnpm schema:snapshot --write`, then `pnpm data-model:check <ID>`.

## Commands

```bash
pnpm dev:deps                     # Postgres on 127.0.0.1:5433
set -a; . ./.env.host; set +a; pnpm migrate     # apply; `node scripts/migrate.mjs --check` verifies checksums only
pnpm schema:snapshot --write      # regenerate docs/data/SCHEMA_SNAPSHOT.sql from a scratch DB
pnpm data-model:check <ID>
pnpm test:integration
```

## Testing requirements

- Every schema change needs an integration test against the isolated `bananagig_test` database (never the dev database).
- Transaction code needs commit, rollback, and (where relevant) isolation/lock tests; copy the patterns in `packages/testing/src/database.itest.ts`.
- Constraints (unique, check, FK) get a test that a violating write is rejected and rolled back.

## Data-model considerations

This skill is the data-model process: see the review gate above and `DATA_MODEL_GUARDRAILS.md`. Record intentional denormalization in `DATA_MODEL.md`. `pgboss.*` and PostGIS objects are infrastructure-owned and excluded from the snapshot.

## Common failure modes

- Editing an applied migration (fails with `Applied migration ... was modified`); add a new one.
- Stale `SCHEMA_SNAPSHOT.sql` after a migration (`data-model:check` fails).
- Tables created in `public` instead of a domain schema.
- Forgetting the dictionary section or normalization entry for a new table.
- Long transactions holding locks across HTTP/NATS calls.

## Known BananaGig-specific lessons

- The official `postgis/postgis` image has no arm64 build; Postgres is a custom image (LRN-0002).
- Host port 5433 (5432 is commonly taken); the test database is `bananagig_test`.
- The migration runner holds an advisory lock and bookkeeping lives in `public.schema_migrations`.

## Do not

- Do not edit applied migrations, hand-edit the snapshot, or write to `pgboss.*` directly.
- Do not store money as float or amounts without currency.
- Do not put bookings, balances, credits, subscriptions, reservations or tax state in Valkey.
- Do not add tables "for later".

## Related ADRs

ADR-0001, ADR-0004, ADR-0008, ADR-0009

## Last reviewed

2026-10-05 (META-001)
