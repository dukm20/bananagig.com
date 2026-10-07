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

### content.locales

Registry of locales (CFG-002). Structural reference data: authoring a version requires the locale to exist (foreign key); serving requires `is_active`. Rows are never deleted. Seeded by migration 0005 with `en-US` only (active, platform default); no translations are invented. GEO-001 (migration 0007) added `display_name` and the generated `language`, `script`, `region`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `locale` | text | no | none | Primary key `pk_locales`; canonical BCP 47 subset `language[-Script][-REGION]` (for example `en-US`, `es-MX`, `zh-Hant-TW`); no variants or extensions; format enforced by `ck_locales__bcp47_format` | yes |
| `is_active` | boolean | no | `false` | Whether the locale may be served. Inactive locales can be authored for but are skipped by the resolver | no |
| `is_platform_default` | boolean | no | `false` | Marks the single last-resort locale of every fallback chain; `ck_locales__default_is_active` requires it to be active; `uq_locales__platform_default` (partial unique index) allows at most one and `trg_locales__guard` refuses any UPDATE that unsets it, so exactly one default always exists (a migration that moves the default disables the guard for its own transaction) | no (never unset) |
| `created_at` | timestamptz | no | `now()` | Registration time | yes |
| `updated_at` | timestamptz | no | `now()` | Last activation change | no |
| `display_name` | text | no | none (the insert trigger stores the tag itself when the value is NULL or blank) | Human-readable name of the locale (GEO-001), for example `English (United States)`; not blank (`ck_locales__display_name_not_blank`). Back-filled for `en-US` by migration 0007; the service derives a proper name with `Intl.DisplayNames` for newly registered locales | no |
| `language` | text | yes | generated | Derived from `locale` (GEO-001): `split_part(locale, '-', 1)`; `GENERATED ALWAYS AS ... STORED`, cannot be written or drift. Not NULL in practice (every tag has a language subtag) but declared nullable by the generation expression | derived |
| `script` | text | yes | generated | Derived from `locale` (GEO-001): the ISO 15924 script subtag (`^[a-z]{2,3}-([A-Z][a-z]{3})`), for example `Hant`; NULL when the tag has none (`en-US`) | derived |
| `region` | text | yes | generated | Derived from `locale` (GEO-001): the trailing ISO 3166-1 alpha-2 or UN M.49 numeric subtag (`-([A-Z]{2}|[0-9]{3})$`), for example `US`, `419`; NULL when the tag has none (`fil`) | derived |

Since GEO-001 this table is the single locale authority for the whole platform: `geography.country_locales.locale` references it and no `geography.locales` table exists.

Triggers: `trg_locales__guard` (`content.guard_locales`) forbids delete, any change to `locale` or `created_at`, and unsetting `is_platform_default`. `trg_locales__default_display_name` (`content.default_locale_display_name`, BEFORE INSERT, GEO-001) sets `display_name` to the tag when it is NULL or blank. `trg_locales__geography_guard` (`geography.guard_locale_deactivation`, BEFORE UPDATE, GEO-001, owned by geography) refuses `is_active` true -> false while the locale is the default locale of an ACTIVE country or market.

### content.entries

Stable semantic identity of one piece of managed content and its governance policy. Immutable except `is_active` (and `updated_at`): a different policy is a different entry.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `entry_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_entries` | yes |
| `key` | text | no | none | Unique (`uq_entries__key`) dotted lower-case key, for example `home.tagline`; at least two segments, `<= 160` chars (`ck_entries__key_format`). Never encodes a locale or the displayed text | yes |
| `content_type` | text | no | none | `PLAIN_TEXT, RICH_TEXT, MARKDOWN, EMAIL_SUBJECT, EMAIL_BODY, PUSH_TITLE, PUSH_BODY, LEGAL, HELP_ARTICLE, UI_LABEL`; drives validation and rendering (markup types render to sanitized HTML) | yes |
| `owner_role` | text | no | none | `CONTENT, LEGAL, SUPPORT, MARKETING`; the accountable function. `LEGAL` entries additionally require the `content-legal` client role for authoring and approval | yes |
| `description` | text | no | none | What the copy is for and where it appears; not blank | yes |
| `sensitivity` | text | no | `PUBLIC` | `PUBLIC, INTERNAL`; PUBLIC entries resolve anonymously, INTERNAL only for authorized callers (anonymous callers see ENTRY_NOT_FOUND) | yes |
| `criticality` | text | no | `STANDARD` | `STANDARD, CRITICAL`; CRITICAL is never cached and never served from last-known-good | yes |
| `approval_policy` | text | no | none | `NONE, OWNER_APPROVAL, SECOND_APPROVER`; copied onto each version at creation | yes |
| `fallback_policy` | text | no | `CHAIN` | `CHAIN` (requested locale, its language, market default, platform default), `LANGUAGE_ONLY`, `EXACT` (requested locale only) | yes |
| `max_scope_type` | text | no | `PLATFORM` | Most specific scope at which the entry may be overridden: `PLATFORM, COUNTRY, MARKET`. Foreign key to `configuration.scope_levels` (`fk_entries__max_scope_type`) plus `ck_entries__max_scope_type` | yes |
| `is_active` | boolean | no | `true` | Deactivated entries do not resolve and accept no new versions; rows are never deleted | no |
| `created_by` | text | no | none | Identity subject of the creator | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last `is_active` change | no |

Other constraints: `ck_entries__content_type`, `__owner_role`, `__sensitivity`, `__criticality`, `__approval_policy`, `__fallback_policy`, `__description_not_blank`; `ck_entries__legal_policy` (a LEGAL entry must have owner LEGAL, SECOND_APPROVER, CRITICAL and EXACT).

Triggers: `trg_entries__guard` (`content.guard_entries`) forbids delete and any change to a column other than `is_active` and `updated_at`.

### content.entry_variables

Typed placeholders of an entry: the variable contract shared by every locale and version. Immutable.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `entry_id` | uuid | no | none | Part of primary key `pk_entry_variables`; foreign key to `content.entries` (restrict) | yes |
| `name` | text | no | none | Part of primary key; `^[a-z][a-z0-9_]*$`, `<= 60` chars (`ck_entry_variables__name_format`) | yes |
| `var_type` | text | no | none | `STRING, NUMBER, MONEY, DATE, TIME, DATETIME, URL, PERSON_DISPLAY_NAME, COUNT`; selects the formatter | yes |
| `is_required` | boolean | no | `true` | Whether a render must supply a value when the template references it | yes |
| `description` | text | no | none | What the variable carries; not blank | yes |
| `example_value` | jsonb | no | none | Example in the canonical encoding of `var_type` (JSON scalar, or `{amount_minor, currency}` for MONEY); used to dry-render drafts | yes |
| `pii_class` | text | no | `NONE` | `NONE, PERSONAL, SENSITIVE_PERSONAL`; `ck_entry_variables__person_name_is_pii` forbids `NONE` for `PERSON_DISPLAY_NAME` | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Triggers: `trg_entry_variables__immutable` (`content.forbid_mutation`) blocks update and delete; `trg_entry_variables__no_late_required` (`content.guard_entry_variables`) rejects inserting a required variable once the entry has versions.

### content.versions

One row per (entry, locale, scope type, scope reference, version number): the template body and its own lifecycle. The body is immutable from creation.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `version_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_versions`; referenced by approvals, snapshots, audit and (future) acceptance records. Unique with `entry_id` (`uq_versions__version_entry`, target of the snapshot composite foreign key) | yes |
| `entry_id` | uuid | no | none | Foreign key to `content.entries` (restrict) | yes |
| `locale` | text | no | none | Foreign key to `content.locales` (restrict) | yes |
| `scope_type` | text | no | `PLATFORM` | `PLATFORM, COUNTRY, MARKET`; foreign key to `configuration.scope_levels` plus `ck_versions__scope_type`; the guard trigger rejects a scope more specific (higher rank) than the entry's `max_scope_type` | yes |
| `scope_ref` | text | yes | none | Opaque domain reference (country or market code/id) with NO foreign key by design; NULL exactly when `scope_type = PLATFORM` (`ck_versions__platform_has_no_ref`); format `^[A-Za-z0-9._:-]{1,200}$` | yes |
| `version` | integer | no | none | Per-holder sequence number `> 0`, assigned at draft creation as max+1 per (entry, locale, scope_type, scope_ref); `uq_versions__holder_version` (NULLS NOT DISTINCT) is the arbiter | yes |
| `body` | text | no | none | Template source in the restricted template syntax; 1 to 200000 characters; plain text, not JSON | yes |
| `body_sha256` | text | no | `''` | SHA-256 (hex) of the UTF-8 body; computed by the insert trigger, a caller value is overwritten. Lets consent and audit records bind to the exact text | yes |
| `status` | text | no | `DRAFT` | `DRAFT, IN_REVIEW, APPROVED, SCHEDULED, PUBLISHED, SUPERSEDED, REJECTED, CANCELLED`; transitions guarded by trigger. SCHEDULED, PUBLISHED and SUPERSEDED are the published markers (only these resolve). A version must be inserted as `DRAFT` | no |
| `approval_policy` | text | no | none | `NONE, OWNER_APPROVAL, SECOND_APPROVER`; deliberate copy of the entry policy at creation (trigger requires equality) | yes |
| `effective_from` | timestamptz | no | none | Start of validity (inclusive). Proposed start while unpublished; raised exactly once at publication to `max(proposed, now)` | no (raised once at publication) |
| `effective_to` | timestamptz | yes | none | End of validity (exclusive); NULL while open-ended; `> effective_from`; may be closed once on a SCHEDULED or PUBLISHED version | no (closed once) |
| `reason` | text | no | none | Business reason for this version; not blank | yes |
| `created_by` | text | no | none | Author subject (the author cannot approve under SECOND_APPROVER) | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last transition time | no |

Other constraints: `ck_versions__version_positive`, `__body_length`, `__status`, `__approval_policy`, `__effective_range`, `__reason_not_blank`, `__scope_ref_format`; `ex_versions__no_overlap` (gist exclusion on `entry_id`, `locale`, `scope_type`, `coalesce(scope_ref, '')`, `tstzrange(effective_from, effective_to, '[)')`, only where `status IN ('SCHEDULED','PUBLISHED','SUPERSEDED')`).

Indexes: `idx_versions__resolution (entry_id, locale, scope_type, effective_from DESC)` partial on published statuses, used by the effective_from branch of the resolver's next-boundary query (the candidate rows are read through `idx_versions__entry` or the exclusion index, then filtered by time); `idx_versions__in_review (created_at)` partial on `IN_REVIEW`; `idx_versions__scheduled (effective_from)` partial on `SCHEDULED`; `idx_versions__entry (entry_id, created_at DESC)`.

Triggers: `trg_versions__guard` (`content.guard_versions`): no delete; on insert, entry must be active, status `DRAFT`, policy equal to the entry, scope not above `max_scope_type`, and `body_sha256` is computed; on update identity and text are frozen, status follows the state machine (DRAFT -> IN_REVIEW/APPROVED/CANCELLED; IN_REVIEW -> APPROVED/REJECTED/CANCELLED; APPROVED -> SCHEDULED/PUBLISHED/CANCELLED; SCHEDULED -> PUBLISHED/SUPERSEDED; PUBLISHED -> SUPERSEDED), DRAFT -> APPROVED only when policy is NONE, approval needs a recorded APPROVE decision and rejection a REJECT decision, `effective_from` may only be raised during `APPROVED -> SCHEDULED/PUBLISHED`, `effective_to` may only be closed once and only at or after the start of the closing transaction (history is never rewritten).

### content.version_approvals

Immutable review decisions; one per approver per version.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `approval_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_version_approvals` | yes |
| `version_id` | uuid | no | none | Foreign key to `content.versions` (restrict); unique with `approver` (`uq_version_approvals__version_approver`) | yes |
| `approver` | text | no | none | Approver subject | yes |
| `decision` | text | no | none | `APPROVE` or `REJECT` (`ck_version_approvals__decision`) | yes |
| `comment` | text | yes | none | Optional comment | yes |
| `decided_at` | timestamptz | no | `now()` | Decision time | yes |

Triggers: `trg_version_approvals__immutable` (`content.forbid_mutation`) blocks update and delete; `trg_version_approvals__guard` (`content.guard_version_approvals`) requires the version to be `IN_REVIEW` and forbids the author approving their own version under SECOND_APPROVER.

### content.snapshots

Immutable record of a resolution: the requested locale, context and evaluation time that were used. Created only for copy that must be reproducible later; routine UI labels are never snapshotted.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `snapshot_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_snapshots`; the handle callers store | yes |
| `evaluated_at` | timestamptz | no | none | The instant content was resolved at | yes |
| `requested_locale` | text | no | none | Locale the caller asked for (BCP 47 subset, `ck_snapshots__locale_format`); not a foreign key (the request may name a locale that was later deactivated or never registered) | yes |
| `context` | jsonb | no | none | Resolution context (scope references); must be an object (`ck_snapshots__context_object`); read back whole | yes |
| `purpose` | text | no | none | Why the snapshot was taken; not blank | yes |
| `created_by` | text | no | none | Subject that requested the snapshot | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Triggers: `trg_snapshots__immutable` (`content.forbid_mutation`).

### content.snapshot_items

The exact immutable version of each resolved entry in a snapshot. The pointer fixes the body, hash, locale, scope, version number and start of the version (none can change, and the version can never be deleted); it does NOT fix `versions.effective_to`, which is closed once when a successor is published, so snapshot reads (service, API and contract) expose no end of period and a read-back is byte-stable. The table comment in migration 0005 says the same thing in its own words (the only later change to the version is closing an open `effective_to` once, so the applied text is fixed); it is an applied migration and is not edited.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `snapshot_id` | uuid | no | none | Part of primary key `pk_snapshot_items`; foreign key to `content.snapshots` (restrict) | yes |
| `entry_id` | uuid | no | none | Part of primary key (one version per entry per snapshot); repeats `versions.entry_id`, kept consistent by the composite foreign key | yes |
| `version_id` | uuid | no | none | Composite foreign key `(version_id, entry_id)` to `content.versions (version_id, entry_id)` (`fk_snapshot_items__entry_version`); points at the immutable version that won resolution | yes |

Triggers: `trg_snapshot_items__immutable` (`content.forbid_mutation`).

### content.audit_events

Append-only audit trail of every content mutation. Bodies are never copied; they are reached through version ids.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `audit_event_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_audit_events` | yes |
| `occurred_at` | timestamptz | no | `now()` | When the action committed | yes |
| `actor` | text | no | none | Subject of the actor; system actors for job-driven changes | yes |
| `action` | text | no | none | `ENTRY_CREATED, ENTRY_ACTIVATED, ENTRY_DEACTIVATED, LOCALE_REGISTERED, LOCALE_ACTIVATED, LOCALE_DEACTIVATED, VERSION_DRAFTED, VERSION_SUBMITTED, VERSION_APPROVED, VERSION_REJECTED, VERSION_CANCELLED, VERSION_PUBLISHED, VERSION_ACTIVATED, VERSION_SUPERSEDED` (`ck_audit_events__action`) | yes |
| `entry_id` | uuid | yes | none | Foreign key to `content.entries`; NULL for locale actions; also the entry of every version named in the row (composite foreign keys below) | yes |
| `locale` | text | yes | none | Set ONLY for locale actions; `ck_audit_events__subject` requires NULL for entry and version actions (the locale of a version event is reached through the immutable version, never repeated here). No foreign key is declared (the locale registry never deletes rows) | yes |
| `version_id` | uuid | yes | none | Set for version actions. Composite foreign key `fk_audit_events__version_entry (version_id, entry_id)` to `content.versions (version_id, entry_id)`: the version must belong to the entry of the same row | yes |
| `previous_version_id` | uuid | yes | none | The version replaced or closed; only on version actions. Composite foreign key `fk_audit_events__previous_version_entry (previous_version_id, entry_id)` to `content.versions (version_id, entry_id)` (same entry) | yes |
| `reason` | text | yes | none | Reason or comment | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request or job | yes |

Subject shape (`ck_audit_events__subject`): `LOCALE_*` actions carry a locale and no entry, version or previous version; `ENTRY_*` actions carry an entry only (no locale, version or previous version); `VERSION_*` actions carry an entry and a version of that entry (no locale; optionally the previous version). Foreign keys are composite and MATCH SIMPLE, so rows without a version are not checked.

Indexes: `idx_audit_events__entry (entry_id, occurred_at DESC)` partial where `entry_id IS NOT NULL`; `idx_audit_events__version (version_id)` partial where `version_id IS NOT NULL`.

Triggers: `trg_audit_events__immutable` (`content.forbid_mutation`).

### geography.currencies

ISO 4217 currencies (GEO-001). Money elsewhere is `amount_minor bigint` plus a currency code; the number of minor-unit digits is data here, not a constant (JPY has 0, KWD has 3). Rows are never deleted. Seeded: `USD`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `currency_code` | char(3) | no | none | Primary key `pk_currencies`; ISO 4217 alpha code, upper case (`ck_currencies__currency_code_format`); the foreign key target of `geography.countries.default_currency_code` and `geography.markets.currency_code` | yes |
| `numeric_code` | char(3) | no | none | ISO 4217 numeric code, three digits (`ck_currencies__numeric_code_format`); unique (`uq_currencies__numeric_code`) | yes |
| `minor_unit_digits` | smallint | no | none | Decimal digits of the minor unit, 0 to 4 (`ck_currencies__minor_unit_digits`); stored amounts depend on it | yes |
| `display_name` | text | no | none | English display name, for example `US Dollar`; not blank (`ck_currencies__display_name_not_blank`) | no |
| `symbol` | text | yes | none | Optional symbol, 1 to 8 characters (`ck_currencies__symbol_length`); display hint only (formatting uses `Intl`) | no |
| `status` | text | no | `PLANNED` | `PLANNED, ACTIVE, INACTIVE` (`ck_currencies__status`). PLANNED is the initial status only (the guard refuses an update back to it). Only ACTIVE currencies can be the currency of an ACTIVE country or market | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Indexes: `pk_currencies`, `uq_currencies__numeric_code`; no other index (tiny reference table).

Triggers: `trg_currencies__guard` (`geography.guard_currencies`, BEFORE UPDATE OR DELETE): refuses delete; refuses a change to `currency_code`, `numeric_code`, `minor_unit_digits` or `created_at`; refuses any update that sets the status back to PLANNED; refuses ACTIVE -> not ACTIVE while an ACTIVE country uses it as default currency or an ACTIVE market uses it.

### geography.time_zones

IANA time zone identities (GEO-001). The identity is the IANA name, never a UTC offset (offsets change with daylight saving time). Rows are never deleted. Seeded: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles` (all ACTIVE).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `time_zone_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_time_zones` | yes |
| `iana_name` | text | no | none | IANA name such as `America/Los_Angeles`; unique (`uq_time_zones__iana_name`); format and length <= 64 checked (`ck_time_zones__iana_name_format`); a NEW name must also exist in the server's tz database (`pg_timezone_names`, checked by the insert trigger, whose message wins over the format check for malformed names; `posix/` and `right/` aliases are refused; an already registered name skips the scan; not re-validated when tzdata is updated) | yes |
| `status` | text | no | `PLANNED` | `PLANNED, ACTIVE, INACTIVE` (`ck_time_zones__status`); PLANNED is the initial status only (the guard refuses an update back to it) | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Indexes: `pk_time_zones`, `uq_time_zones__iana_name`; no other index (tiny reference table).

Triggers: `trg_time_zones__guard` (`geography.guard_time_zones`, BEFORE INSERT OR UPDATE OR DELETE): refuses delete (`NOT_DELETABLE`); on insert refuses `posix/` and `right/` names and, for a name that is not registered yet, requires it to exist in `pg_timezone_names` (`NOT_IANA`); refuses a change to `time_zone_id`, `iana_name` or `created_at` (`IMMUTABLE_IDENTITY`); refuses any update that sets the status back to PLANNED (`PLANNED_IS_INITIAL`); refuses ACTIVE -> not ACTIVE while an ACTIVE market uses it as default time zone or while it is the last ACTIVE zone of an ACTIVE country (`TIME_ZONE_IN_USE`). Before it looks at the sibling zones it locks every ACTIVE country that uses the zone (`FOR UPDATE`, `country_id` order), so two concurrent deactivations of two different zones of one country serialize and the second is refused. A country activation locks the ACTIVE zone rows it relies on `FOR SHARE`, so a concurrent deactivation of the country's only ACTIVE zone serializes with it.

### geography.countries

One row per country (GEO-001) with its data-driven display defaults. The display name is managed content (a content entry key), not a column. Created `PLANNED`, linked to its locales and time zones, then activated. Rows are never deleted. Seeded: `US` (ACTIVE).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `country_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_countries` | yes |
| `iso_alpha2` | char(2) | no | none | ISO 3166-1 alpha-2, upper case (`ck_countries__iso_alpha2_format`); unique (`uq_countries__iso_alpha2`). This is the canonical COUNTRY scope reference used by configuration and content | yes |
| `iso_alpha3` | char(3) | no | none | ISO 3166-1 alpha-3, upper case (`ck_countries__iso_alpha3_format`); unique (`uq_countries__iso_alpha3`) | yes |
| `iso_numeric` | char(3) | no | none | ISO 3166-1 numeric, three digits (`ck_countries__iso_numeric_format`); unique (`uq_countries__iso_numeric`) | yes |
| `display_name_content_key` | text | no | none | Key of the content entry holding the country's display name (for example `geography.country.us.name`); foreign key `fk_countries__display_name_content_key` to `content.entries (key)` (restrict); dotted lower-case format (`ck_countries__content_key_format`). The text is resolved through the content service, never stored here | no |
| `status` | text | no | `PLANNED` | `PLANNED, ACTIVE, INACTIVE` (`ck_countries__status`). ACTIVE requires an ACTIVE default currency, an ACTIVE default locale and at least one ACTIVE linked time zone (trigger); not deactivatable while it has ACTIVE markets. PLANNED is the initial status only (the guard refuses an update back to it). Readiness beyond these rules is derived in code, not stored | no |
| `dialing_code` | text | no | none | International dialing prefix, `+` and 1 to 4 digits (`ck_countries__dialing_code_format`) | no |
| `default_currency_code` | char(3) | no | none | Foreign key `fk_countries__default_currency_code` to `geography.currencies (currency_code)` (restrict) | no |
| `default_locale` | text | no | none | The country's default locale. Composite foreign key `fk_countries__default_locale (country_id, default_locale)` to `geography.country_locales (country_id, locale)`, DEFERRABLE INITIALLY DEFERRED (checked at commit, so the country and its first locale link can be inserted in one transaction): the default must be one of the supported locales. Locale validity and activity come from `content.locales` | no |
| `distance_unit` | text | no | none | `MILES` or `KILOMETERS` (`ck_countries__distance_unit`). Single source: markets inherit it | no |
| `first_day_of_week` | text | no | none | `MONDAY ... SUNDAY` (`ck_countries__first_day_of_week`). Single source: markets inherit it | no |
| `date_format_code` | text | no | none | `MDY`, `DMY` or `YMD` (`ck_countries__date_format_code`): a code, not a format string; rendering uses `Intl`. Single source | no |
| `time_format_code` | text | no | none | `12_HOUR` or `24_HOUR` (`ck_countries__time_format_code`). Single source | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Indexes: `pk_countries`, `uq_countries__iso_alpha2`, `uq_countries__iso_alpha3`, `uq_countries__iso_numeric`; `idx_countries__active (iso_alpha2) WHERE status = 'ACTIVE'` serves the public active-country list. Foreign keys `display_name_content_key`, `default_currency_code` have no index of their own (tiny table, never deleted targets).

Triggers: `trg_countries__guard` (`geography.guard_countries`, BEFORE INSERT OR UPDATE OR DELETE): refuses delete; refuses a change to `country_id`, the ISO codes or `created_at`; when the row becomes or stays ACTIVE and its status, default currency or default locale changed (or on insert as ACTIVE) it requires an ACTIVE default currency (locked `FOR SHARE`) and an ACTIVE default locale in `content.locales` (locked `FOR SHARE`); when the row BECOMES ACTIVE (not for a currency or locale change of an already ACTIVE country: the zone guard keeps that rule) it also requires at least one ACTIVE linked time zone (the ACTIVE zone rows it relies on are locked `FOR SHARE OF` the time zone, so a concurrent deactivation of the country's only ACTIVE zone serializes with the activation; inserting a country directly as ACTIVE always fails); refuses any update that sets the status back to PLANNED (status machine: PLANNED -> ACTIVE or INACTIVE, ACTIVE <-> INACTIVE); refuses ACTIVE -> not ACTIVE while an ACTIVE market belongs to the country.

### geography.country_locales

Locales supported in a country (many-to-many between `geography.countries` and `content.locales`, GEO-001). Its primary key is also the target of the default-locale foreign keys of countries and the country-locale foreign key of `geography.market_locales`. Seeded: `(US, en-US)`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `country_id` | uuid | no | none | Part of primary key `pk_country_locales`; foreign key `fk_country_locales__country_id` to `geography.countries` (restrict) | yes |
| `locale` | text | no | none | Part of primary key; foreign key `fk_country_locales__locale` to `content.locales (locale)` (restrict): locale validity comes from the single locale authority | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Indexes: `pk_country_locales (country_id, locale)` serves the locales of a country and covers the `country_id` foreign key. The `locale` foreign key has no index of its own (locales are never deleted; no query starts from a locale).

Triggers: `trg_country_locales__immutable` (`geography.forbid_mutation`, BEFORE UPDATE): link rows are never rewritten, only inserted or deleted; `trg_country_locales__guard` (`geography.guard_country_links`, BEFORE DELETE): refuses removing a link of an ACTIVE country (deactivate the country first; `LINKS_PROTECTED`). It share-locks the country row before it reads the status, so a concurrent activation serializes with the removal. Inserting a link into an ACTIVE country is allowed.

### geography.country_time_zones

Time zones used in a country (many-to-many between `geography.countries` and `geography.time_zones`, GEO-001). Its primary key is the target of the market default-time-zone foreign key. Seeded: US with the four seeded zones.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `country_id` | uuid | no | none | Part of primary key `pk_country_time_zones`; foreign key `fk_country_time_zones__country_id` to `geography.countries` (restrict) | yes |
| `time_zone_id` | uuid | no | none | Part of primary key; foreign key `fk_country_time_zones__time_zone_id` to `geography.time_zones` (restrict) | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Indexes: `pk_country_time_zones (country_id, time_zone_id)` serves the zones of a country and covers the `country_id` foreign key. The `time_zone_id` foreign key has no index of its own (tiny table; the guards that look up by time zone scan it).

Triggers: `trg_country_time_zones__immutable` (`geography.forbid_mutation`, BEFORE UPDATE): link rows are never rewritten, only inserted or deleted; `trg_country_time_zones__guard` (`geography.guard_country_links`, BEFORE DELETE): refuses removing a link of an ACTIVE country (`LINKS_PROTECTED`), after share-locking the country row, so an activation racing the removal of the country's only zone link cannot leave an ACTIVE country without a zone. Inserting a link into an ACTIVE country is allowed.

### geography.markets

A market (GEO-001): a first-class operating area inside one country with its own default locale, currency and operational time zone. The distance unit and date/time defaults are NOT stored here: they come from the country (single source). Effective dating is a half-open window `[effective_from, effective_to)` on the row; "in effect" is derived at read time from `status = 'ACTIVE'` and the window, and readiness is derived in code; neither is a column. Rows are never deleted. Seeded: `la-oc` (PLANNED).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `market_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_markets` | yes |
| `code` | text | no | none | Unique (`uq_markets__code`) lower-case kebab-case code, at most 60 characters (`ck_markets__code_format`), for example `la-oc`. This is the canonical MARKET scope reference used by configuration and content | yes |
| `name` | text | no | none | Display name of the market, for example `LA & OC`; not blank and at most 120 characters (`ck_markets__name_not_blank`) | no |
| `country_id` | uuid | no | none | Foreign key `fk_markets__country_id` to `geography.countries` (restrict); also the second column of `uq_markets__market_country (market_id, country_id)` and of the composite keys below | yes |
| `status` | text | no | `PLANNED` | `PLANNED, ACTIVE, INACTIVE` (`ck_markets__status`). ACTIVE requires an ACTIVE country, currency, default time zone and default locale (trigger). PLANNED is the initial status only (the guard refuses an update back to it) | no |
| `default_locale` | text | no | none | Composite foreign key `fk_markets__default_locale (market_id, default_locale)` to `geography.market_locales (market_id, locale)`, DEFERRABLE INITIALLY DEFERRED: the default must be one of the market's supported locales, which in turn must be supported by the country | no |
| `currency_code` | char(3) | no | none | Foreign key `fk_markets__currency_code` to `geography.currencies (currency_code)` (restrict); the market's own currency (its own fact, not derived from or copied from the country's default currency) | no |
| `default_time_zone_id` | uuid | no | none | Composite foreign key `fk_markets__country_time_zone (country_id, default_time_zone_id)` to `geography.country_time_zones (country_id, time_zone_id)` (restrict): the zone must belong to the market's country | no |
| `effective_from` | timestamptz | no | none | Start of the market window (inclusive) | no |
| `effective_to` | timestamptz | yes | none | End of the window (exclusive); NULL while open-ended; `effective_to > effective_from` (`ck_markets__effective_range`) | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Indexes: `pk_markets`, `uq_markets__code`, `uq_markets__market_country (market_id, country_id)` (target of `fk_market_locales__market_country`); `idx_markets__active (country_id, code) WHERE status = 'ACTIVE'` serves the active markets of a country and the country deactivation guard. No full index on `country_id` (tiny table; management listing scans it). `currency_code`, `default_time_zone_id` and `default_locale` foreign keys have no index of their own.

Triggers: `trg_markets__guard` (`geography.guard_markets`, BEFORE INSERT OR UPDATE OR DELETE): refuses delete; refuses a change to `market_id`, `code`, `country_id` or `created_at`; when the row becomes or stays ACTIVE and its status, currency, default locale or default time zone changed (or on insert as ACTIVE) it requires an ACTIVE country, an ACTIVE currency, an ACTIVE default time zone (each locked `FOR SHARE`) and an ACTIVE default locale in `content.locales` (locked `FOR SHARE`), so a concurrent deactivation of any of them serializes with the activation; refuses any update that sets the status back to PLANNED (status machine: PLANNED -> ACTIVE or INACTIVE, ACTIVE <-> INACTIVE).

### geography.market_locales

Locales a market supports (many-to-many, GEO-001). `country_id` repeats `geography.markets.country_id` on purpose (intentional denormalization): it lets the composite foreign key `(country_id, locale)` force every market locale to be supported by the market's country; the other composite foreign key makes drift of `country_id` impossible. Seeded: `(la-oc, en-US)`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `market_id` | uuid | no | none | Part of primary key `pk_market_locales`; first column of composite foreign key `fk_market_locales__market_country (market_id, country_id)` to `geography.markets (market_id, country_id)` (restrict) | yes |
| `country_id` | uuid | no | none | Repeats `markets.country_id` (see above); second column of `fk_market_locales__market_country` and first column of `fk_market_locales__country_locale (country_id, locale)` to `geography.country_locales (country_id, locale)` (restrict) | yes |
| `locale` | text | no | none | Part of primary key; the locale; valid only if the country supports it (the composite foreign key), which in turn references `content.locales` | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Indexes: `pk_market_locales (market_id, locale)` serves the locales of a market, covers the `market_id` foreign key and is the target of `fk_markets__default_locale`. `fk_market_locales__country_locale` has no index of its own (referenced rows are never deleted while a market uses them; tiny table).

Triggers: `trg_market_locales__immutable` (`geography.forbid_mutation`, BEFORE UPDATE): link rows are never rewritten, only inserted or deleted. There is no delete trigger: a market locale link that the market still uses as its default is protected by the deferred default-locale foreign key (checked at commit), and links of ACTIVE markets are not otherwise frozen.

### geography.audit_events

Append-only audit trail of every geography management mutation (GEO-001). Exactly one subject: a country or a market. Reference values are public, so unlike `configuration.audit_events` the changed values are recorded. Seeded: three rows (`COUNTRY_CREATED`, `COUNTRY_ACTIVATED`, `MARKET_CREATED`), actor `system:migration`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `audit_event_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_audit_events` | yes |
| `occurred_at` | timestamptz | no | `clock_timestamp()` | When the action was recorded (statement-time clock, so rows of one transaction stay causally ordered) | yes |
| `actor` | text | no | none | Subject of the actor; `system:migration` for the seed. Never exposed through the public API | yes |
| `action` | text | no | none | `COUNTRY_CREATED, COUNTRY_UPDATED, COUNTRY_ACTIVATED, COUNTRY_DEACTIVATED, MARKET_CREATED, MARKET_UPDATED, MARKET_ACTIVATED, MARKET_DEACTIVATED` (`ck_audit_events__action`) | yes |
| `country_id` | uuid | yes | none | Foreign key `fk_audit_events__country_id` to `geography.countries` (restrict); set exactly for COUNTRY_* actions | yes |
| `market_id` | uuid | yes | none | Foreign key `fk_audit_events__market_id` to `geography.markets` (restrict); set exactly for MARKET_* actions | yes |
| `changes` | jsonb | yes | none | Field-level difference `{field: [old, new]}`; NULL when no field difference is recorded (the seeded `COUNTRY_CREATED` and `MARKET_CREATED` rows); must be a JSON object (`ck_audit_events__changes_object`) | yes |
| `reason` | text | yes | none | Reason supplied by the actor | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request or migration (`seed-0007`) | yes |

Subject shape (`ck_audit_events__subject`): a COUNTRY_* action requires `country_id` and no `market_id`; a MARKET_* action requires `market_id` and no `country_id`. Two nullable keys are used instead of a polymorphic id so that both stay real foreign keys.

Indexes: `pk_audit_events`; `idx_audit_events__country (country_id, occurred_at DESC) WHERE country_id IS NOT NULL` and `idx_audit_events__market (market_id, occurred_at DESC) WHERE market_id IS NOT NULL` serve the audit trail of one country or market (and the foreign key checks).

Triggers: `trg_audit_events__immutable` (`geography.forbid_mutation`, BEFORE UPDATE OR DELETE) blocks update and delete.
