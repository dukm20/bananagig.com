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

### configuration.scope_levels

Canonical scope hierarchy. Structural reference data seeded by migration 0004 and changed only by migration. A higher rank is more specific and wins at resolution.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `scope_type` | text | no | none | Primary key `pk_scope_levels`; `PLATFORM, COUNTRY, MARKET, CATEGORY, PLAN, PROVIDER, GIG, DROP`; upper snake case enforced by check | yes |
| `rank` | smallint | no | none | Specificity order, `>= 0`, unique (`uq_scope_levels__rank`). PLATFORM 0 ... DROP 7 | yes |

### configuration.parameters

Typed definition of one configuration parameter (identity, type, validation, governance). Holds no values and no default: the PLATFORM-scope value is the default.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `parameter_id` | uuid | no | `gen_random_uuid()` | Primary key | yes |
| `key` | text | no | none | Unique dotted lower-case key, for example `booking.cancellation_window`; format and length checked | yes |
| `data_type` | text | no | none | `STRING, INTEGER, DECIMAL, BOOLEAN, ENUM, DURATION, MONEY, JSON` | yes |
| `unit` | text | yes | none | Human unit label for display (informational) | no |
| `description` | text | no | none | What the parameter controls; not blank | no |
| `owner_role` | text | no | none | Role accountable for the parameter. Metadata only in CFG-001: approval is gated by the `configuration-approve` client role, not by matching this value (DEBT-0021) | no |
| `validation_rules` | jsonb | no | `{}` | Type-specific rules (min/max, enum values, pattern, currencies, JSON schema); must be an object | no |
| `sensitivity` | text | no | `INTERNAL` | `PUBLIC, INTERNAL, SENSITIVE`; SENSITIVE values are redacted in API responses and never placed in events or logs | no |
| `approval_policy` | text | no | none | `NONE, OWNER_APPROVAL, SECOND_APPROVER`; copied onto each change request | no |
| `criticality` | text | no | `STANDARD` | `STANDARD, CRITICAL`; CRITICAL is never cached or served from last-known-good | no |
| `is_required` | boolean | no | `true` | Whether a consumer treats a missing value as an error | no |
| `is_active` | boolean | no | `true` | Deactivated parameters are not resolvable; rows are never deleted | no |
| `created_by` | text | no | none | Identity subject of the creator | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last definition update | no |

### configuration.parameter_scopes

Allowed overrides: the scope levels at which a parameter may hold a value. PLATFORM is inserted with the parameter.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `parameter_id` | uuid | no | none | Part of primary key `pk_parameter_scopes`; foreign key to `parameters` | yes |
| `scope_type` | text | no | none | Part of primary key; foreign key to `scope_levels` | yes |

### configuration.parameter_values

Value holder: one row per (parameter, scope level, scope reference). The timeline of values lives in `value_versions`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `parameter_value_id` | uuid | no | `gen_random_uuid()` | Primary key | yes |
| `parameter_id` | uuid | no | none | With `scope_type`, composite foreign key to `parameter_scopes` (enforces an allowed level) | yes |
| `scope_type` | text | no | none | Scope level | yes |
| `scope_ref` | text | yes | none | Opaque domain reference (uuid or code) with NO foreign key by design; NULL exactly when `scope_type = PLATFORM` (`ck_parameter_values__platform_has_no_ref`); unique per holder with `NULLS NOT DISTINCT` | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

### configuration.value_versions

Immutable published values with half-open validity `[effective_from, effective_to)`. The only permitted update is closing an open-ended version once.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `version_id` | uuid | no | `gen_random_uuid()` | Primary key; referenced by snapshots, audit and change requests | yes |
| `parameter_value_id` | uuid | no | none | Foreign key to the holder; part of `ex_value_versions__no_overlap` | yes |
| `version` | integer | no | none | Per-holder sequence number, `> 0`; unique with the holder | yes |
| `value` | jsonb | no | none | Canonical encoding of the typed value (DECIMAL string, DURATION `{amount, unit}`, MONEY `{amount_minor, currency}`) | yes |
| `effective_from` | timestamptz | no | none | Start of validity (inclusive) | yes |
| `effective_to` | timestamptz | yes | none | End of validity (exclusive); NULL while open-ended; `> effective_from` | no (closed once) |
| `reason` | text | no | none | Business reason for the version; not blank | yes |
| `created_by` | text | no | none | Publisher subject | yes |
| `created_at` | timestamptz | no | `now()` | Publication time | yes |

### configuration.change_requests

A proposed change to one (parameter, scope). State machine enforced by trigger; content frozen after DRAFT.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `change_request_id` | uuid | no | `gen_random_uuid()` | Primary key | yes |
| `parameter_id` | uuid | no | none | With `scope_type`, composite foreign key to `parameter_scopes` | yes |
| `scope_type` | text | no | none | Target scope level | yes (after DRAFT) |
| `scope_ref` | text | yes | none | Target scope reference; NULL exactly for PLATFORM | yes (after DRAFT) |
| `proposed_value` | jsonb | no | none | Proposed canonical value, validated against the definition before insert | yes (after DRAFT) |
| `effective_from` | timestamptz | no | none | Requested start; clamped to publish time if already passed | yes (after DRAFT) |
| `effective_to` | timestamptz | yes | none | Optional requested end | yes (after DRAFT) |
| `reason` | text | no | none | Why the change is needed; not blank | yes (after DRAFT) |
| `requested_by` | text | no | none | Requester subject | yes |
| `approval_policy` | text | no | none | Policy that governs THIS request (copy of the parameter policy at request time) | yes (after DRAFT) |
| `state` | text | no | `DRAFT` | `DRAFT, PENDING_APPROVAL, APPROVED, SCHEDULED, ACTIVE, REJECTED, SUPERSEDED, CANCELLED`; transitions guarded by trigger | no |
| `value_version_id` | uuid | yes | none | Published version; NOT NULL exactly in SCHEDULED, ACTIVE, SUPERSEDED; unique | no (set once) |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last transition time | no |

### configuration.change_approvals

Immutable approval decisions; one per approver per request. Self-approval is refused by trigger under SECOND_APPROVER.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `approval_id` | uuid | no | `gen_random_uuid()` | Primary key | yes |
| `change_request_id` | uuid | no | none | Foreign key to the request; unique with `approver` | yes |
| `approver` | text | no | none | Approver subject | yes |
| `decision` | text | no | none | `APPROVE` or `REJECT` | yes |
| `comment` | text | yes | none | Optional comment | yes |
| `decided_at` | timestamptz | no | `now()` | Decision time | yes |

### configuration.snapshots

Immutable record of a resolution: the context and evaluation time that were used.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `snapshot_id` | uuid | no | `gen_random_uuid()` | Primary key; the handle callers store (for example on a future booking) | yes |
| `evaluated_at` | timestamptz | no | none | The time the configuration was evaluated at | yes |
| `context` | jsonb | no | none | Resolution context (scope references); must be an object | yes |
| `purpose` | text | no | none | Why the snapshot was taken; not blank | yes |
| `created_by` | text | no | none | Subject that requested the snapshot | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

### configuration.snapshot_items

The exact immutable version used for each parameter in a snapshot.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `snapshot_id` | uuid | no | none | Part of primary key; foreign key to `snapshots` | yes |
| `parameter_id` | uuid | no | none | Part of primary key; foreign key to `parameters` | yes |
| `version_id` | uuid | no | none | Foreign key to the immutable `value_versions` row that won resolution | yes |

### configuration.audit_events

Append-only audit trail of every configuration mutation. Values are reached through version ids, never copied.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `audit_event_id` | uuid | no | `gen_random_uuid()` | Primary key | yes |
| `occurred_at` | timestamptz | no | `now()` | When the action committed | yes |
| `actor` | text | no | none | Subject of the actor; `system:configuration-activation` for the supersession done by the activation job | yes |
| `action` | text | no | none | `PARAMETER_CREATED, CHANGE_DRAFTED, CHANGE_SUBMITTED, CHANGE_APPROVED, CHANGE_REJECTED, CHANGE_CANCELLED, CHANGE_PUBLISHED, CHANGE_ACTIVATED, CHANGE_SUPERSEDED` | yes |
| `parameter_id` | uuid | no | none | Foreign key to the parameter | yes |
| `change_request_id` | uuid | yes | none | Foreign key to the request, when the action belongs to one | yes |
| `old_version_id` | uuid | yes | none | Version replaced or closed | yes |
| `new_version_id` | uuid | yes | none | Version published or activated | yes |
| `reason` | text | yes | none | Reason or comment | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request/job | yes |
