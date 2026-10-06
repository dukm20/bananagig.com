# ADR-0009 — pg-boss for durable background jobs

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

The worker needs durable, transactional background jobs without another broker.

## Decision

Use pg-boss, which stores jobs in the `pgboss` schema of the authoritative database. Queue names are `<domain>.<action>`. Handlers register through `jobHandler()`, which restores the correlation id and opens a span. Job data carries `_meta.correlationId`.

## Alternatives considered

- BullMQ on Valkey: jobs would live in a non-authoritative store.
- Roll our own table: needless reinvention.

## Consequences

Jobs share the database's availability and backups, and can be enqueued in the same transaction as the state change. Throughput is bounded by Postgres.

## Migration / compatibility

pg-boss owns and migrates its own schema.

## Related files

- `apps/worker/src/worker.ts`
- `apps/worker/src/runtime/job.ts`
- `docs/engineering/EVENT_CONVENTIONS.md`
