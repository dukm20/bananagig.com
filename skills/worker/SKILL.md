# Worker (pg-boss jobs, NATS events)

## Purpose

Add background jobs, event consumers and publishers on the worker host.

## When to use

- Adding a pg-boss queue or handler, a NATS subscription, or event publishing.
- Changing worker readiness, concurrency, or shutdown.

## Canonical files

- `apps/worker/src/worker.ts`, `apps/worker/src/index.ts`
- `apps/worker/src/runtime/job.ts`, `apps/worker/src/runtime/events.ts`, `apps/worker/src/runtime/outbox.ts`, `packages/platform/src/outbox.ts`, `apps/worker/src/outbox.itest.ts`
- `packages/platform/src/health-server.ts`, `packages/platform/src/clients.ts`
- `apps/worker/src/worker.test.ts`, `apps/worker/src/worker.itest.ts`
- `docs/engineering/EVENT_CONVENTIONS.md`, `docs/events/asyncapi.yaml`

## Architecture rules

- Jobs: pg-boss (ADR-0009). Queue names `<domain>.<action>` in kebab-case. Register handlers only through `jobHandler()`; enqueue with `withJobMeta()` so the correlation id travels with the job.
- Events: subject equals the event type `bananagig.<domain>.<event>.v<n>`; publish validated `EventEnvelope`s with `NatsEventPublisher`; subscribe with `subscribe()` (restores correlation). Consumers are idempotent (dedupe by `eventId`).
- Domain events originate from the transactional outbox in PostgreSQL (`integration.outbox_events`, ADR-0012): producers call `insertOutboxEvent(trx, ...)` in the same transaction as the state change; the `PollingOutboxRelay` claims with a lease (`SKIP LOCKED`), publishes through JetStream with `Nats-Msg-Id = eventId`, then marks published. Never publish to NATS inside the business transaction or outside the outbox for domain facts.
- Readiness: PostgreSQL + job runtime started + NATS connected. Identity `WORKER_ID`, concurrency `WORKER_CONCURRENCY`.
- Shutdown: stop the health server, `boss.stop({ graceful: true })`, close NATS, DB, Valkey, flush telemetry with a bound.

## Implementation pattern

1. Define the job/event contract in `packages/contracts` and document events in the AsyncAPI generator (`scripts/generate-specs.mjs`), then `pnpm specs:generate`.
2. Register in `Worker.start()`: `boss.createQueue(name)` then `boss.work(name, { localConcurrency }, jobHandler(name, handler))`.
3. Handlers must be idempotent and safe to run twice; record an idempotency key in the same transaction as the effect.
4. Add a unit test with fakes (`worker.test.ts`) and an integration test against real Postgres + NATS (`worker.itest.ts`).

## Commands

```bash
pnpm dev                      # worker health on http://localhost:3212/readyz
pnpm test:integration         # starts deps, real pg-boss + NATS round trip
curl -s localhost:3212/internal/diagnostics   # infra.ping job + event self-test (host dev mode)
```

## Testing requirements

- Handler tests prove idempotency (run twice) and correlation restoration.
- Lifecycle tests: start reports ready, stop is graceful and idempotent, readiness reflects Postgres down.
- Anything touching real queues goes in a `*.itest.ts` using `createIsolatedDatabase()` (its own migrated database).
- Outbox behavior (commit/rollback, lease, backoff, duplicate publish, purge) is covered in `outbox.itest.ts`; extend it rather than re-testing the relay elsewhere.

## Data-model considerations

pg-boss owns the `pgboss` schema; never query or alter it directly. Handlers that write product tables follow the database skill (transaction helper, row locks, idempotency, outbox).

## Common failure modes

- Shutdown that hangs because a network client is not bounded (LRN-0007).
- Calling `quit()` on a never-connected lazy Valkey client (use `closeValkey`).
- Handlers that assume exactly-once delivery.
- Forgetting `_meta.correlationId` on enqueued data (the job logs a new id instead of the request's).

## Known BananaGig-specific lessons

- Only the infrastructure queue `infra.ping` and event `bananagig.infra.ping.v1` exist; do not add product queues here as examples.
- Core NATS publish cannot de-duplicate or acknowledge; relays must use JetStream and mark rows published only after the ack (LRN-0012).
- Stream `BANANAGIG_EVENTS` (subjects `bananagig.>`) is ensured by the worker at startup.
- Unreachable OTLP endpoint must not delay exit (`shutdownObservability` is bounded to 3 s).

## Do not

- Do not publish events outside the outbox for domain facts.
- Do not create product jobs or subjects before their checkpoint.
- Do not block shutdown on unbounded network calls.

## Related ADRs

ADR-0002, ADR-0009, ADR-0012

## Last reviewed

2026-10-05 (INF-003)
