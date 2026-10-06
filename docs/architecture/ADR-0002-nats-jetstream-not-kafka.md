# ADR-0002 — NATS JetStream for events; no Kafka

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

The platform needs durable events and consumers between the API and worker, with a small local footprint and open-source licensing.

## Decision

Use NATS with JetStream. Subjects follow `bananagig.<domain>.<event>.v<version>` and carry the shared event envelope. Kafka is explicitly excluded.

## Alternatives considered

- Kafka: heavier to run and operate, more than the expected event volume needs.
- Postgres-only (LISTEN/NOTIFY or polling): no durable consumer groups or replay.

## Consequences

One light binary with persistence. Events are published from a transactional outbox in Postgres (not yet built, DEBT-0002) so the database stays the source of truth. Revisit if throughput outgrows NATS.

## Migration / compatibility

No streams exist yet; adding the first product event creates one and an AsyncAPI entry.

## Related files

- `docs/engineering/EVENT_CONVENTIONS.md`
- `docs/events/asyncapi.yaml`
- `apps/worker/src/runtime/events.ts`
- `packages/contracts/src/index.ts`
