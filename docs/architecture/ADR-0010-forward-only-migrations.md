# ADR-0010 — Forward-only, checksum-guarded migrations with expand/migrate/contract

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-003

## Context

The first migrations are in place and the project will deploy to shared environments. Rollback-by-reverse-DDL is unreliable once data exists, and a migration edited after it ran silently diverges environments.

## Decision

Migrations are forward-only SQL files `NNNN_snake_case.sql`, applied in version order by `scripts/lib/migrator.mjs`, one transaction per file, with SHA-256 checksums verified on every run, an advisory lock with timeout so only one runner works at a time, and fail-fast behavior. Headers (`checkpoint`, `purpose`, `rollback strategy`, `backfill`, `risk`) are mandatory from 0002; destructive statements require a `-- destructive:` justification. Breaking changes follow expand / migrate / contract across separate checkpoints. Local rollback is rebuild-from-zero; production rollback is forward-fix.

## Alternatives considered

- Down migrations: doubles the surface, untested in practice, cannot restore dropped data.
- A third-party migration tool: adds a dependency for behavior that is about 150 lines here and needs project-specific rules (headers, destructive marker, documentation gate).

## Consequences

Every schema change is a reviewed, immutable file; mistakes are corrected by new migrations. Transaction-incompatible statements (`CREATE INDEX CONCURRENTLY`) are not supported until a reviewed mode exists (DEBT-0014). Bookkeeping lives in `public.schema_migrations`.

## Migration / compatibility

0001 is grandfathered (no headers) and must never be edited. 0002 upgraded the bookkeeping table in place.

## Related files

- `scripts/lib/migrator.mjs`
- `scripts/migrate.mjs`
- `db/migrations/0002_database_foundation.sql`
- `docs/data/MIGRATION_POLICY.md`
- `packages/testing/src/migrations.itest.ts`
