-- checkpoint: INF-003
-- purpose: create the integration schema and the generic transactional outbox (resolves DEBT-0002); no business events exist yet
-- rollback strategy: forward-fix only; the outbox is empty until the first event-producing feature, so locally `pnpm stack:reset` is sufficient
-- backfill: none (new objects)
-- risk: low; new schema and table only, nothing depends on them yet

CREATE SCHEMA integration;
COMMENT ON SCHEMA integration IS 'Application-owned: cross-domain integration infrastructure (transactional outbox now; idempotency records and webhook inbox later).';

CREATE TABLE integration.outbox_events (
  outbox_event_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type   text        NOT NULL,
  aggregate_id     text        NOT NULL,
  event_type       text        NOT NULL,
  event_version    integer     NOT NULL,
  actor_type       text        NOT NULL,
  actor_id         text,
  payload_json     jsonb       NOT NULL,
  correlation_id   text        NOT NULL,
  causation_id     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  publish_attempts integer     NOT NULL DEFAULT 0,
  last_error       text,
  CONSTRAINT pk_outbox_events PRIMARY KEY (outbox_event_id),
  CONSTRAINT ck_outbox_events__event_type_format CHECK (event_type ~ '^bananagig[.][a-z][a-z0-9-]*[.][a-z][a-z0-9-]*[.]v[1-9][0-9]*$'),
  CONSTRAINT ck_outbox_events__event_version_positive CHECK (event_version > 0),
  CONSTRAINT ck_outbox_events__version_matches_type CHECK (right(event_type, length(event_version::text) + 2) = '.v' || event_version::text),
  CONSTRAINT ck_outbox_events__actor_type CHECK (actor_type IN ('user', 'system', 'service')),
  CONSTRAINT ck_outbox_events__payload_is_object CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT ck_outbox_events__attempts_nonnegative CHECK (publish_attempts >= 0),
  CONSTRAINT ck_outbox_events__published_has_attempt CHECK (published_at IS NULL OR publish_attempts >= 1)
);

-- Relay query: unpublished rows that are due, oldest first.
CREATE INDEX idx_outbox_events__pending ON integration.outbox_events (next_attempt_at, created_at) WHERE published_at IS NULL;
-- Retention purge of published rows.
CREATE INDEX idx_outbox_events__published_at ON integration.outbox_events (published_at) WHERE published_at IS NOT NULL;

COMMENT ON TABLE integration.outbox_events IS 'Transactional outbox: rows are inserted in the same transaction as the state change and relayed to NATS by the worker. NATS is transport; this table is the committed-event source.';
COMMENT ON COLUMN integration.outbox_events.aggregate_id IS 'Identifier of the aggregate as text (uuid or other); no foreign key by design: the outbox is domain-agnostic.';
COMMENT ON COLUMN integration.outbox_events.event_version IS 'Derived from the event_type suffix (.v<n>); kept because the event envelope carries it; consistency enforced by ck_outbox_events__version_matches_type.';
COMMENT ON COLUMN integration.outbox_events.next_attempt_at IS 'Relay lease/backoff: a claimed or failed row is not retried before this time.';
