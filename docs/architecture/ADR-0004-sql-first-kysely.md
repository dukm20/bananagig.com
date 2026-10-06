# ADR-0004 — SQL-first database access with Kysely and pg

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-002

## Context

Later features need explicit transaction scope, isolation levels and row locks (`FOR UPDATE`, `SKIP LOCKED`).

## Decision

Use Kysely over the `pg` driver in `@bananagig/database`: a typed query builder that stays close to SQL, with a transaction helper (`db.transaction`, nesting joins, isolation level, correlation id in `app.correlation_id`). No ORM.

## Alternatives considered

- Prisma: hides transaction and locking control and generates models.
- Raw `pg` only: no type safety.

## Consequences

Table types are added to `DatabaseSchema` as features add tables. Developers write SQL-shaped code. Migrations stay plain SQL.

## Migration / compatibility

`DatabaseSchema` is empty; no models exist.

## Related files

- `packages/database/src/index.ts`
- `packages/testing/src/database.itest.ts`
- `scripts/migrate.mjs`
