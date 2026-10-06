# Event Conventions

## Envelope

Every domain event uses the `EventEnvelope` from `@bananagig/contracts`:

| Field | Meaning |
|---|---|
| eventId | UUID, unique per event; consumers dedupe on it |
| eventType | `bananagig.<domain>.<event>.v<version>`; also the NATS subject |
| eventVersion | Integer, equals the `v<n>` in eventType |
| occurredAt | ISO-8601 UTC time the fact happened |
| correlationId | Correlation id of the originating request/job |
| causationId | `eventId` (or job id) that directly caused this event, or null |
| actor | `{ type: user|system|service, id }` |
| aggregateType / aggregateId | The entity the event is about |
| payload | Event-specific JSON object |

NATS message header `x-correlation-id` mirrors `correlationId`.

## Versioning rules

1. A published `v<n>` is immutable in meaning. Adding optional payload fields is allowed within a version.
2. Removing/renaming fields or changing semantics requires a new `v<n+1>` event type. Producers may emit both during migration; consumers upgrade, then the old version is retired.
3. Consumers must ignore unknown fields.
4. Every event type is documented in `docs/events/asyncapi.yaml` (3.0) in the same change that introduces it.

## Contract

`docs/events/asyncapi.yaml` is generated from the contracts package (`pnpm specs:generate`), checked for drift (`pnpm specs:check`) and validated (`pnpm asyncapi:validate`) in CI. Only the envelope and the infrastructure self-test event `bananagig.infra.ping.v1` exist; no product events.

## Delivery

- Producers write events to the transactional outbox (`integration.outbox_events`) in the same database transaction as the state change, using `insertOutboxEvent(trx, ...)` (ADR-0012). Never publish to NATS inside a business transaction.
- The worker's `PollingOutboxRelay` claims due rows with a lease (`FOR UPDATE SKIP LOCKED`), publishes through **JetStream** with `Nats-Msg-Id = outbox_event_id`, and marks a row published only after the acknowledgement. Failures back off exponentially. Published rows are purged after `OUTBOX_RETENTION_DAYS`.
- Stream `BANANAGIG_EVENTS` captures `bananagig.>` (file storage, 7-day retention, 2-minute duplicate window) and is ensured by the worker at startup.
- Delivery is **at-least-once**. Consumers must be idempotent and dedupe by `eventId` (the duplicate window is finite).
- Relay settings (`OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS`, `OUTBOX_RETENTION_DAYS`) come from `@bananagig/config`.

## pg-boss jobs

Queue names are `<domain>.<action>`, lowercase kebab-case (for example `booking.send-reminder`). Job data includes `_meta.correlationId`. Register handlers only through `jobHandler()`. The only queue today is `infra.ping`.
