# ADR-0012 — Transactional outbox relayed to NATS JetStream

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-003

## Context

Domain events must never be lost or published for a state change that rolled back, and publishing must not hold database locks across network calls. ADR-0002 chose NATS JetStream as the transport.

## Decision

Events are inserted into `integration.outbox_events` in the same transaction as the state change (`insertOutboxEvent(trx, ...)`). A polling relay in the worker claims due rows with `FOR UPDATE SKIP LOCKED` plus a short lease, publishes to the JetStream stream `BANANAGIG_EVENTS` with `Nats-Msg-Id = outbox_event_id`, then marks the row published; failures back off exponentially. Delivery is at-least-once; consumers dedupe by `eventId`. Published rows are purged after a retention period under an advisory lock.

## Alternatives considered

- Publish inside the business transaction: lost events or phantom events on failure.
- Debezium/CDC from the WAL: heavier infrastructure than the event volume warrants.
- LISTEN/NOTIFY only: not durable.

## Consequences

PostgreSQL is the committed-event source; NATS is transport. Slight publish latency (poll interval, default 1 s). The relay is polling, not push; swap for LISTEN/NOTIFY wake-ups later if latency matters.

## Migration / compatibility

New schema `integration`, new table; no existing data affected. Resolves DEBT-0002.

## Related files

- `db/migrations/0003_integration_outbox.sql`
- `packages/platform/src/outbox.ts`
- `apps/worker/src/runtime/outbox.ts`
- `apps/worker/src/outbox.itest.ts`
- `docs/engineering/EVENT_CONVENTIONS.md`
