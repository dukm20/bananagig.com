# Data Model Guardrails

Applies to every feature checkpoint. Existing migrations and tables at INF-001: see `DATA_MODEL.md`. There are no business tables yet, so no existing table needed remediation.

1. **PostgreSQL is the authoritative transactional state.** Bookings, balances, Banana Credits, subscriptions, slot reservations and tax state live only in Postgres. Valkey, OpenSearch and NATS hold derived or in-flight data that can be rebuilt.
2. **Every schema change requires a migration** in `db/migrations/NNNN_description.sql`, applied with `pnpm migrate`. No manual DDL.
3. **Never edit an applied migration.** The runner stores a SHA-256 checksum and fails if a file changes. Fix forward with a new migration.
4. **UUIDs.** Primary keys are `uuid`, generated with `gen_random_uuid()` (or UUIDv7 if adopted project-wide). No serial IDs for entities exposed outside the database.
5. **Timestamps.** Always `timestamptz`, stored as UTC. Every table has `created_at timestamptz NOT NULL DEFAULT now()`. Mutable tables also have `updated_at`. Never use `timestamp without time zone`.
6. **Money.** Store integer minor units (`bigint amount_minor`) next to an ISO-4217 `currency char(3)` with a check constraint. Never `float`. Never store amount without currency. Banana Credits are a separate ledger unit, never mixed with currency columns.
7. **Naming.** `snake_case`, plural table names, singular column names. Booleans read as predicates (`is_active`). Timestamps end in `_at`, dates in `_on`. Foreign keys are `<referenced_singular>_id`. Constraint names: `pk_<table>`, `fk_<table>__<ref>`, `uq_<table>__<cols>`, `ck_<table>__<rule>`. Index names: `ix_<table>__<cols>`.
8. **Keys.** Every table has a primary key. Every relationship has a real foreign key with an explicit `ON DELETE` (default `RESTRICT`). Junction tables use a composite or surrogate key plus a uniqueness constraint on the pair.
9. **Uniqueness.** Business-unique fields get unique constraints or partial unique indexes (for example, one active row per natural key `WHERE deleted_at IS NULL`). Application checks are not a substitute.
10. **Check constraints.** Encode invariants in the schema: non-negative amounts, valid state enums, `starts_at < ends_at`. Prefer `CHECK` on text or a lookup table over free-form status strings.
11. **Indexing.** Index every foreign key and every column used in frequent filters or sorts. Justify each index in the migration comment. Use GiST for geography. Review with `EXPLAIN` before adding speculative indexes. Remove unused indexes.
12. **Deletion vs retention.** Financial, booking, tax and audit records are immutable and retained; correct them with compensating rows. Other user-facing entities may use soft deletion (`deleted_at timestamptz`), and uniqueness must account for it. Hard deletion is allowed only for data with no retention duty and must be documented.
13. **Audit.** State changes to sensitive entities write an append-only audit row: actor, action, entity, before and after (or diff), `occurred_at`, request/trace id. Audit tables are never updated or deleted.
14. **Snapshots and versions.** Anything that must stay reproducible after the source changes (price at booking, terms accepted, tax rate applied) is copied into the transaction record, or referenced through an immutable versioned row. Do not join to mutable source rows for historical truth.
15. **Row locking.** Use `SELECT ... FOR UPDATE` (or `SKIP LOCKED` for queues) inside short transactions. Lock in a consistent order (by table, then by id ascending) to avoid deadlocks. Slot and balance changes lock the owning row. Never hold a lock across a network call.
16. **Idempotency.** Externally triggered writes (payments, webhooks, job handlers, API retries) carry an idempotency key with a unique constraint, recorded in the same transaction as the effect. Handlers must be safe to run twice.
17. **Transactional outbox.** Domain events are inserted into an `outbox` table in the same transaction as the state change, then published to NATS by the worker. Never publish to NATS from inside the business transaction, and never write to the database and publish as two independent steps.
18. **Normalization review for every feature.** Before merging a schema change, record in the checkpoint report that the design was checked against:
    - **1NF:** atomic values, no repeating groups or arrays standing in for relations.
    - **2NF:** no attribute depends on part of a composite key.
    - **3NF:** no non-key attribute depends on another non-key attribute.
    - **BCNF where useful:** every determinant is a candidate key, especially in tables with several overlapping unique keys.
19. **Every feature checkpoint revisits the data model:** update `DATA_MODEL.md` (tables, constraints, indexes, ERD), and report tables added, changed and reused, normalization findings, migration risk, backfill and rollback.
20. **Intentional denormalization must be documented** in `DATA_MODEL.md` with the reason (measured performance, immutability snapshot), the source of truth, and how drift is prevented or detected. Undocumented denormalization is a defect.
