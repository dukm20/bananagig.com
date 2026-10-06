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

- Producers must write events to a transactional outbox in the same database transaction as the state change (see `DATA_MODEL_GUARDRAILS.md`); the relay publishes them to NATS. The relay is not built yet (the `OutboxRelay` port exists).
- NATS JetStream provides durable streams; no streams are defined until the first product event.
- Consumers are idempotent (dedupe by `eventId`).

## pg-boss jobs

Queue names are `<domain>.<action>`, lowercase kebab-case (for example `booking.send-reminder`). Job data includes `_meta.correlationId`. Register handlers only through `jobHandler()`. The only queue today is `infra.ping`.
