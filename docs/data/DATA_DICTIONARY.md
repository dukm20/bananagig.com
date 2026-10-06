# Data Dictionary

Every application-owned table has a `### schema.table` section with a row per column. `pnpm data-model:check` fails when a table in the schema snapshot has no section here. Infrastructure-owned schemas (`pgboss`, PostGIS) are documented by their upstream projects.

Format per column: name, type, nullability, default, meaning, and whether the value is immutable after insert.

### public.schema_migrations

Migration bookkeeping written by the migration runner (`scripts/lib/migrator.mjs`). One row per applied migration file. Rows are never updated or deleted.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `version` | integer | no | none | Numeric prefix of the filename; primary key `pk_schema_migrations`. Derived from `filename` and kept consistent by `ck_schema_migrations__filename_matches_version` | yes |
| `filename` | text | no | none | Migration file name `NNNN_snake_case.sql`; unique | yes |
| `checksum` | text | no | none | SHA-256 of the file when applied; a mismatch means an applied migration was edited and aborts the runner | yes |
| `applied_at` | timestamptz | no | `now()` | When the migration was recorded | yes |
| `duration_ms` | integer | yes | none | Execution time of the migration transaction in milliseconds; NULL for migrations recorded before tracking (0001) | yes |

### integration.outbox_events

Transactional outbox. A row is a committed domain event waiting to be (or already) published to NATS JetStream.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `outbox_event_id` | uuid | no | `gen_random_uuid()` | Primary key; also the event id (`eventId`) and the JetStream `Nats-Msg-Id` used for duplicate detection | yes |
| `aggregate_type` | text | no | none | Kind of entity the event is about (for example `booking`) | yes |
| `aggregate_id` | text | no | none | Identifier of that entity as text; no foreign key by design | yes |
| `event_type` | text | no | none | `bananagig.<domain>.<event>.v<n>`; also the NATS subject. Format enforced by check | yes |
| `event_version` | integer | no | none | Version number; derived from the `event_type` suffix, consistency enforced by check | yes |
| `actor_type` | text | no | none | `user`, `system` or `service` | yes |
| `actor_id` | text | yes | none | Actor identifier; NULL for anonymous/system | yes |
| `payload_json` | jsonb | no | none | Event payload; must be a JSON object | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request/job | yes |
| `causation_id` | text | yes | none | Event or job id that caused this event | yes |
| `created_at` | timestamptz | no | `now()` | When the event was committed; becomes the envelope `occurredAt` | yes |
| `next_attempt_at` | timestamptz | no | `now()` | Relay lease/backoff: not retried before this time | no |
| `published_at` | timestamptz | yes | none | When JetStream acknowledged the event; NULL while pending | no (set once) |
| `publish_attempts` | integer | no | `0` | Number of publish attempts; `>= 1` when published | no |
| `last_error` | text | yes | none | Message of the most recent failed attempt; cleared on success | no |
