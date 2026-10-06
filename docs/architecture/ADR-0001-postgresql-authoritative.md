# ADR-0001 — PostgreSQL is the authoritative transactional store

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

BananaGig will hold bookings, balances, credits, subscriptions, slot reservations and tax state where integrity and concurrency control matter. It also needs geospatial queries for local services.

## Decision

PostgreSQL 17 with PostGIS is the single authoritative store for transactional state. Every other store (Valkey, OpenSearch, NATS, S3 metadata caches) is derived, rebuildable, or a transport. Schema changes go through forward-only SQL migrations.

## Alternatives considered

- Document or key-value store as primary: weaker constraints and multi-row transactions.
- Managed multi-model database: lock-in and no clear benefit at this scale.

## Consequences

Strong constraints, transactions and row locks are available for money-like state. Search, cache and events must tolerate rebuilds. PostGIS ties the project to Postgres extensions (see LRN-0002 for the arm64 image).

## Migration / compatibility

First migration `db/migrations/0001_infra_baseline.sql` enables PostGIS. No data existed before.

## Related files

- `docs/data/DATA_MODEL_GUARDRAILS.md`
- `db/migrations/0001_infra_baseline.sql`
- `infra/postgres/Dockerfile`
- `packages/database/src/index.ts`
