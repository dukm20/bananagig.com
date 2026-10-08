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

Seeded by ID-002 (migration 0010, through the real change workflow: parameter created, change drafted, submitted, approved by `system:migration-review`, published and activated; 6 `configuration.audit_events` rows per parameter, actor `system:migration`, correlation `seed-0010`): eight `INTEGER` parameters of the email verification policy, all with owner `security`, sensitivity `INTERNAL`, approval `SECOND_APPROVER`, criticality `CRITICAL` (never cached, never served from last-known-good), `is_required` true, `PLATFORM` scope only (no override level) and one `PLATFORM` value each. None holds personal data. The service reads them fresh on every call, never defaults them in code and fails closed when they cannot be read.

| Key | Unit | `validation_rules` | Seeded value | Basis |
|---|---|---|---|---|
| `verification.email.code.length` | digits | min 4, max 10 | 6 | PRD SV-03.01 default |
| `verification.email.validity_minutes` | minutes | min 1, max 120 | 10 | PRD SV-03.01 default |
| `verification.email.resend_seconds` | seconds | min 0, max 3600 | 30 | PRD SV-03.01 default |
| `verification.email.max_per_hour` | sends | min 1, max 100 | 5 | PRD SV-03.01 default |
| `verification.email.max_per_day` | sends | min 1, max 1000 | 10 | PRD CU-03.06 reference table default |
| `verification.email.max_attempts` | attempts | min 1, max 20 | 5 | PRD SV-03.01 default |
| `verification.email.requests.max_per_hour` | requests | min 1, max 1000 | 30 | ID-002 engineering assumption, not in the PRD; flagged for the security owner |
| `verification.email.address.max_per_hour` | sends | min 1, max 100 | 5 | ID-002 engineering assumption, not in the PRD; flagged for the security owner |

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

Seeded by ID-002 (migration 0010, through the real content lifecycle: entry created, version drafted, approved, published, activated; 5 `content.audit_events` rows per entry, 170 in total, actor `system:migration`, correlation `seed-0010`): 34 entries under `account.email.*`, each with owner `CONTENT`, sensitivity `PUBLIC`, criticality `STANDARD`, approval `NONE`, fallback `CHAIN`, maximum scope `PLATFORM` and one `PUBLISHED` `en-US` `PLATFORM` version 1. Notable keys: `account.email.verification.subject` (`EMAIL_SUBJECT`, no code in the subject) and `account.email.verification.body` (`EMAIL_BODY`, carrying the code, the magic link and the expiry); the verification screen `account.email.verify.*` (`title`, `intro`, `code_label`, `submit`, `resend`, `resend_wait`, `change`, `sent`, `success`); the magic-link page `account.email.link.*` (`title`, `body`, `confirm`, `sign_in_required`); the status labels `account.email.status.none`, `.pending`, `.verified`; and the messages `account.email.error.*`: the five address validation issues (`required`, `too_long`, `invalid_format`, `invalid_characters`, `unsupported`) and the API errors (`not_pending`, `code_invalid`, `code_expired`, `code_used`, `verification_locked`, `resend_too_soon`, `send_limit`, `unavailable`, `delivery_failed`, `rate_limited`, `link_invalid`). Types: 1 `EMAIL_SUBJECT`, 1 `EMAIL_BODY`, 10 `UI_LABEL`, 22 `PLAIN_TEXT`. Five typed variables (`content.entry_variables`, all required): on the email body `verification_code` (`STRING`) and `verification_url` (`URL`), both `SENSITIVE_PERSONAL` because they are credentials that must never be logged, and `expiry_minutes` (`COUNT`, `NONE`); on `account.email.verify.intro` `masked_email` (`STRING`, `PERSONAL`: the masked address only); on `account.email.verify.resend_wait` `seconds` (`COUNT`, `NONE`).

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

### geography.administrative_areas

Administrative areas of a country (GEO-002): states, provinces, regions and similar, hierarchical through `parent_area_id`. `code` is the canonical code within the country WITHOUT the country prefix (`CA` for California, the ISO 3166-2 subdivision part where one exists); `name` is the official proper name, not translated UI copy. Used by address formats whose `ADMINISTRATIVE_AREA` field has input type `LOOKUP`. Only the areas a country format needs are loaded (no counties or cities). Statuses are `ACTIVE` and `INACTIVE` only (no `PLANNED`: a row has no activation prerequisites). Rows are never deleted. Seeded: the 50 US states (`STATE`) and the District of Columbia (`DISTRICT`), all `ACTIVE`, none with a parent.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `administrative_area_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_administrative_areas`; also the first column of the keys `uq_administrative_areas__area_country` and `__area_country_code`, which are the targets of the composite foreign keys below and of `geography.addresses` | yes |
| `country_id` | uuid | no | none | Foreign key `fk_administrative_areas__country_id` to `geography.countries` (restrict); the country the area belongs to; first column of `uq_administrative_areas__country_code (country_id, code)` | yes |
| `code` | text | no | none | Canonical code inside the country, upper-case letters, digits and hyphen, 1 to 10 characters (`ck_administrative_areas__code_format`), unique per country; the value an address stores (`administrative_area_code`) and a template shows | yes |
| `name` | text | no | none | Official proper name, not blank, at most 120 characters (`ck_administrative_areas__name_not_blank`); may be corrected later (addresses keep the name they were accepted with) | no |
| `area_type` | text | no | none | `STATE, PROVINCE, TERRITORY, DISTRICT, REGION, COUNTY, OTHER` (`ck_administrative_areas__area_type`); the kind of area, not its depth | no |
| `status` | text | no | `ACTIVE` | `ACTIVE, INACTIVE` (`ck_administrative_areas__status`); only `ACTIVE` areas resolve in a `LOOKUP` field and can be used by a new address (trigger). The service refuses retiring the last `ACTIVE` area while a published format has a `LOOKUP` field (`AREAS_IN_USE`; a service rule, not a trigger) | no |
| `parent_area_id` | uuid | yes | none | Composite foreign key `fk_administrative_areas__parent (parent_area_id, country_id)` to `administrative_areas (administrative_area_id, country_id)` (restrict): the parent belongs to the SAME country; NULL for top-level areas. Immutable and the parent must exist first, so a cycle is impossible; `ck_administrative_areas__not_own_parent` | yes |
| `display_order` | integer | yes | none | Explicit picker order (`>= 0`, `ck_administrative_areas__display_order`); NULL means alphabetical by name | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Indexes: `pk_administrative_areas`; `uq_administrative_areas__country_code (country_id, code)` serves the lookup of an area by country and code, the areas of a country (leading `country_id`) and covers the `country_id` foreign key; `uq_administrative_areas__area_country (administrative_area_id, country_id)` is the target of the parent key; `uq_administrative_areas__area_country_code (administrative_area_id, country_id, code)` is the target of `fk_addresses__area_country_code`. No index on `parent_area_id` (areas are never deleted or re-keyed, so no foreign key check scans children, and the whole country list is read at once; the table holds tens to a few hundred rows per country).

Triggers: `trg_administrative_areas__guard` (`geography.guard_administrative_areas`, BEFORE UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`) and any change to `administrative_area_id`, `country_id`, `code`, `parent_area_id` or `created_at` (`IMMUTABLE_IDENTITY`); name, type, status and display order may change.

### geography.address_formats

One address format VERSION of a country (GEO-002). Created as `DRAFT` with all its fields, published once, immutable afterwards except that its open end is closed exactly once by its successor. The exclusion constraint guarantees that at most one `PUBLISHED` format of a country is in force at any instant; "in force" is derived from the half-open window `[effective_from, effective_to)` at read time (there is no current flag). A stored address references the exact version it was validated with, so a newer format never re-interprets it. Never deleted. Seeded: US version 1 (`PUBLISHED`).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `address_format_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_address_formats`; also first column of `uq_address_formats__format_country (address_format_id, country_id)`, the target of `fk_addresses__format_country` | yes |
| `country_id` | uuid | no | none | Foreign key `fk_address_formats__country_id` to `geography.countries` (restrict) | yes |
| `version` | integer | no | none | Version number within the country, `>= 1` (`ck_address_formats__version`); allocated as max plus one while the country row is locked; unique with the country (`uq_address_formats__country_version`) | yes |
| `status` | text | no | `DRAFT` | `DRAFT, PUBLISHED` (`ck_address_formats__status`). A row is inserted as `DRAFT` (`FORMAT_MUST_START_AS_DRAFT`), moves to `PUBLISHED` once and never back (`FORMAT_STATUS_TRANSITION`) | no |
| `display_template` | text | no | none | Ordered lines of the formatted address, 1 to 500 characters, no control character except the newline (`ck_address_formats__template`); lines are separated by a newline and each `{FIELD_TYPE}` token is replaced by the field value. At publication every field of the format must appear in the template and every token must be a field of the format (`FORMAT_TEMPLATE_MISMATCH`). The literal-attachment rule is in `docs/engineering/ADDRESSES.md` | yes |
| `effective_from` | timestamptz | no | none | Proposed start while `DRAFT`; raised once (never lowered) to the actual start at publication (the maximum of the proposed start, the requested start and the database clock); immutable afterwards | no (raised once) |
| `effective_to` | timestamptz | yes | none | End of the period (exclusive); NULL while open-ended; `effective_to > effective_from` (`ck_address_formats__effective_range`); a `DRAFT` is always open (`ck_address_formats__draft_is_open`); closed exactly once, to the successor's start, in the successor's publication transaction | no (closed once) |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the application | no |

Constraint `ex_address_formats__no_overlap`: `EXCLUDE USING gist (country_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&) WHERE (status = 'PUBLISHED')`, so two published formats of one country can never overlap (the service reports `CONFLICT`, reason `FORMAT_PERIOD_OVERLAP`).

Indexes: `pk_address_formats`; `uq_address_formats__country_version (country_id, version)` serves the versions of a country, the next version number (max plus one) and covers the `country_id` foreign key; `uq_address_formats__format_country (address_format_id, country_id)` is the target of the address key; the exclusion constraint creates a partial gist index used for the overlap check and for "the published format of a country at an instant" (equality on `country_id`; a country has a handful of versions, so no further index). `address_formats` is read by country, never by status alone.

Triggers: `trg_address_formats__guard` (`geography.guard_address_formats`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); refuses an INSERT that is not `DRAFT` (`FORMAT_MUST_START_AS_DRAFT`); refuses any change to the id, country, version, template or `created_at` (`FORMAT_IMMUTABLE`); for a `PUBLISHED` row refuses a return to `DRAFT` (`FORMAT_STATUS_TRANSITION`), a change of `effective_from` and a change of a non-NULL `effective_to` (`FORMAT_IMMUTABLE`), allowing only the one-time closure of an open end; for a `DRAFT` row refuses a change of the period (`FORMAT_IMMUTABLE`); on `DRAFT -> PUBLISHED` requires `effective_from` not lowered and `effective_to` still NULL (`FORMAT_IMMUTABLE`), at least one field including a required `ADDRESS_LINE_1` (`FORMAT_INCOMPLETE`), every template token to be a field and every field to appear in the template (`FORMAT_TEMPLATE_MISMATCH`), and, when a field is `LOOKUP`, at least one `ACTIVE` administrative area in the country (`LOOKUP_WITHOUT_AREAS`).

### geography.address_format_fields

The ordered field definitions of one address format version (GEO-002). Order, requirement, length, input type, pattern, example and normalization are data: the server validator and every client form read them from here through the address-format read model, so no regular expression or field order is duplicated in code. Labels are content keys, never text. The postal-code rule is the pattern of the `POSTAL_CODE` row (there is no separate postal rules table). Rows are inserted with their format while it is `DRAFT` and are immutable afterwards. Seeded: the five fields of US version 1.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `address_format_id` | uuid | no | none | Part of primary key `pk_address_format_fields`; foreign key `fk_address_format_fields__format` to `geography.address_formats` (restrict) | yes |
| `field_type` | text | no | none | Part of the primary key: `ORGANIZATION, ADDRESS_LINE_1, ADDRESS_LINE_2, DEPENDENT_LOCALITY, LOCALITY, ADMINISTRATIVE_AREA, POSTAL_CODE, SORTING_CODE` (`ck_address_format_fields__field_type`); each type once per format; a type that is absent means the country does not use that part. The vocabulary is closed (a ninth type is a migration) | yes |
| `display_order` | smallint | no | none | Position of the field in forms, 1..20 (`ck_address_format_fields__display_order`); unique per format (`uq_address_format_fields__format_order`) | yes |
| `content_label_key` | text | no | none | Foreign key `fk_address_format_fields__label_key` to `content.entries (key)` (restrict): the managed label copy, resolved by clients with the country as context (a country may word it its own way, for example "State" or "ZIP code" for the US); dotted lower-case format (`ck_address_format_fields__label_key_format`) | yes |
| `required` | boolean | no | none | Whether the field must be present | yes |
| `max_length` | smallint | no | none | Maximum length of the normalized value in characters (Unicode code points), 1..200 (`ck_address_format_fields__max_length`); the input is capped by it before a pattern runs | yes |
| `input_type` | text | no | `TEXT` | `TEXT` (free text, validated by the optional pattern) or `LOOKUP` (`ck_address_format_fields__input_type`); `LOOKUP` is only allowed for `ADMINISTRATIVE_AREA` (`ck_address_format_fields__lookup_only_for_area`) and then the value must be the code or name of an `ACTIVE` administrative area of the country | yes |
| `validation_pattern` | text | yes | none | Optional JavaScript regular expression the NORMALIZED value must fully match (the engine wraps it as `^(?:pattern)$` with the `u` flag), 1..200 characters (`ck_address_format_fields__pattern_length`); NULL for a `LOOKUP` field (`ck_address_format_fields__lookup_has_no_pattern`). Vetted by the service when the draft is created (no backreferences, no lookbehind, no group repeated that already repeats) | yes |
| `example_value` | text | yes | none | Example shown in forms (for example `12345`), not blank, at most 100 characters, no control character (`ck_address_format_fields__example`); the service checks that it matches the pattern and the maximum length | yes |
| `autocomplete_hint` | text | yes | none | HTML autocomplete token for the input (`address-line1`, `address-level2`, `postal-code`), lower-case (`ck_address_format_fields__autocomplete_hint`); advisory for clients (the API property is `autocomplete`) | yes |
| `normalization_rule` | text | yes | none | Optional rule applied after the universal normalization (NFC, trim, whitespace collapse): `UPPERCASE, REMOVE_SPACES, UPPERCASE_REMOVE_SPACES` (`ck_address_format_fields__normalization_rule`); NULL for a `LOOKUP` field | yes |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |

Indexes: `pk_address_format_fields (address_format_id, field_type)` serves the fields of a format and covers the `address_format_id` foreign key; `uq_address_format_fields__format_order (address_format_id, display_order)` serves ordered reads and guarantees a unique order. `content_label_key` has no index of its own (the target `content.entries` is never deleted and keys are immutable, so no foreign key check scans this table; no query starts from a label key).

Triggers: `trg_address_format_fields__guard` (`geography.guard_address_format_fields`, BEFORE INSERT OR UPDATE OR DELETE): refuses UPDATE and DELETE (`ROW_IMMUTABLE`); on INSERT share-locks the format row and requires it to be `DRAFT` (`FORMAT_NOT_DRAFT`), so a concurrent publication (which updates that row) serializes with a field insert.

### geography.addresses

The ONE canonical structured address (GEO-002): no customer, provider, booking or business variants and no country-specific column. Geography owns the structure; identity, provider and booking own who uses an address and will reference `address_id`. A row is IMMUTABLE once inserted (an UPDATE is refused; enrichment such as a later geocode inserts a NEW row), so a confirmed booking that references `address_id` keeps the exact address accepted at booking time and no snapshot table exists. PERSONAL DATA: never logged, never returned by a public API (no route reads a persisted address), retention and erasure policy is DEBT-0036. No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `address_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_addresses`; the reference every owning domain stores | yes |
| `country_id` | uuid | no | none | Foreign key `fk_addresses__country_id` to `geography.countries` (restrict); first column of `fk_addresses__format_country` and `fk_addresses__area_country_code`, which keep the format and the area in this country | yes |
| `address_format_id` | uuid | no | none | Composite foreign key `fk_addresses__format_country (address_format_id, country_id)` to `geography.address_formats (address_format_id, country_id)` (restrict): the exact format VERSION the address was validated with, in the same country; a newer version never re-interprets the row. The insert trigger requires it to be `PUBLISHED` (`FORMAT_NOT_PUBLISHED`) | yes |
| `administrative_area_id` | uuid | yes | none | Part of the composite foreign key `fk_addresses__area_country_code (administrative_area_id, country_id, administrative_area_code)` to `geography.administrative_areas (administrative_area_id, country_id, code)` (restrict, MATCH SIMPLE); set when the format field is a `LOOKUP`; NULL for a free-text or absent area. The insert trigger requires the area to be `ACTIVE` (`AREA_NOT_ACTIVE`) | yes |
| `administrative_area_code` | text | yes | none | Canonical area code, NULL exactly when `administrative_area_id` is NULL (`ck_addresses__area_consistent`); intentional denormalization of `administrative_areas.code`, enforced by the composite foreign key | yes |
| `administrative_area_name` | text | yes | none | For a lookup area the canonical name AS OF insert (a snapshot); for a format whose area field is `TEXT` the normalized free text, with no id and no code; required whenever a code exists (`ck_addresses__area_consistent`); at most 200 characters | yes |
| `organization` | text | yes | none | Organization or business name line; not blank and at most 200 characters (`ck_addresses__text_values`) | yes |
| `address_line_1` | text | no | none | First street address line; the only part that is always required; not blank, at most 200 characters (the country format applies the real, usually smaller, limit) | yes |
| `address_line_2` | text | yes | none | Second line (unit, suite, floor); not blank when present, at most 200 characters | yes |
| `dependent_locality` | text | yes | none | Sub-locality (district, neighborhood) for formats that use it; not blank when present, at most 200 characters | yes |
| `locality` | text | yes | none | City or town; NULL for formats without a locality; not blank when present, at most 200 characters | yes |
| `postal_code` | text | yes | none | Postal code, normalized by the format rule; NULL for countries or formats without one; not blank when present, at most 200 characters. Validated against the pattern of the format `POSTAL_CODE` field | yes |
| `sorting_code` | text | yes | none | Sorting code (CEDEX and similar) for formats that use it; not blank when present, at most 200 characters | yes |
| `location` | geography(Point,4326) | yes | none | The single authoritative geospatial value, built as `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography` after the service validated latitude -90..90 and longitude -180..180 (PostGIS silently coerces out-of-range input). Latitude and longitude are derived on read with `ST_Y` and `ST_X` of the geometry cast; there are no separate columns. NULL for manual entries. No spatial index until a spatial query exists | yes |
| `time_zone_id` | uuid | yes | none | Foreign key `fk_addresses__time_zone_id` to `geography.time_zones` (restrict): the zone a geocoder supplied, stored only when it is a registered `ACTIVE` zone (an unknown zone is dropped, never free text); the insert trigger requires `ACTIVE` (`TIME_ZONE_NOT_ACTIVE`). Later scheduling uses the zone of the service address with the market default as fallback (DEBT-0034) | yes |
| `formatted_address` | text | no | none | Intentional, immutable denormalization: the display text (newline-separated lines, country line excluded) generated by the central formatter from the structured fields and the template of the format version used; never produced by a client; not blank, at most 1500 characters (`ck_addresses__formatted_address`) | yes |
| `validation_status` | text | no | none | `UNVERIFIED, FORMAT_VALID, GEOCODED, VERIFIED, INVALID` (`ck_addresses__validation_status`). `UNVERIFIED`: passed the country format but no provider verified it (the manual-entry fallback, marked for review, and imported rows); `FORMAT_VALID`: an autocomplete selection that passed the format, without coordinates; `GEOCODED`: a geocoder resolved coordinates; `VERIFIED`: confirmed by a verification provider or an administrator; `INVALID`: rejected by a verification provider. Autocomplete success is never verification. `GEOCODED` and `VERIFIED` require a location (`ck_addresses__located_status_has_location`) | yes |
| `validation_source` | text | no | none | `MANUAL, AUTOCOMPLETE, GEOCODER, ADMIN, IMPORTED` (`ck_addresses__validation_source`): who supplied the structured data. `MANUAL` never carries a location and is only `UNVERIFIED`, `FORMAT_VALID` or `INVALID` (`ck_addresses__manual_is_not_located`); `AUTOCOMPLETE` is never `VERIFIED` (`ck_addresses__autocomplete_is_not_verified`); `VERIFIED` only from `GEOCODER` or `ADMIN` (`ck_addresses__verified_source`) | yes |
| `provider_code` | text | yes | none | Provider-neutral adapter code, lower-case (`ck_addresses__provider_code_format`, for example `mock`); present exactly for `AUTOCOMPLETE` and `GEOCODER`, absent for `MANUAL` and `ADMIN`, free for `IMPORTED` (`ck_addresses__provider`) | yes |
| `provider_reference` | text | yes | none | The provider's own identifier of the place; only with a `provider_code`; not blank, at most 200 characters, no control character (`ck_addresses__provider_reference`) | yes |
| `raw_input` | jsonb | no | none | What the person or provider submitted before normalization, as a JSON object (shape depends on the source), at most 4000 characters of JSON text (`ck_addresses__raw_input`); read back whole, never queried relationally; PERSONAL DATA, never returned by ordinary responses or logs | yes |
| `created_at` | timestamptz | no | `now()` | Insert time | yes |

Indexes: `pk_addresses` only. Every other foreign key (`country_id`, `(address_format_id, country_id)`, `(administrative_area_id, country_id, administrative_area_code)`, `time_zone_id`) is deliberately without a supporting index: the referenced rows (countries, formats, areas, time zones) are never deleted or re-keyed, so no foreign key check scans `addresses`, and no query filters addresses by country, format, area, time zone, postal code or location yet (reads are by `address_id`). `postal_code` is not indexed (no lookup by postal code exists; service-area postal lists hold their own rows). `location` has no GiST index until a spatial query exists (service areas and search), which adds it through its own data model review.

Triggers: `trg_addresses__guard` (`geography.guard_addresses`, BEFORE INSERT OR UPDATE): refuses every UPDATE (`ROW_IMMUTABLE`); on INSERT share-locks and requires the format to be `PUBLISHED` (`FORMAT_NOT_PUBLISHED`), the area, when set, to be `ACTIVE` (`AREA_NOT_ACTIVE`) and the time zone, when set, to be `ACTIVE` (`TIME_ZONE_NOT_ACTIVE`). DELETE is not refused by the trigger (tables referencing an address will use ON DELETE RESTRICT; erasure is DEBT-0036).

### geography.audit_events

Append-only audit trail of every geography management mutation (GEO-001; extended in GEO-002 with address formats and administrative areas). Exactly one subject: a country, a market or an address format. Reference values are public, so unlike `configuration.audit_events` the changed values are recorded. Seeded: five rows, actor `system:migration` (three in migration 0007: `COUNTRY_CREATED`, `COUNTRY_ACTIVATED`, `MARKET_CREATED`; two in migration 0008: `ADDRESS_FORMAT_DRAFTED`, `ADDRESS_FORMAT_PUBLISHED`).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `audit_event_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_audit_events` | yes |
| `occurred_at` | timestamptz | no | `clock_timestamp()` | When the action was recorded (statement-time clock, so rows of one transaction stay causally ordered) | yes |
| `actor` | text | no | none | Subject of the actor; `system:migration` for the seed. Never exposed through the public API | yes |
| `action` | text | no | none | `COUNTRY_CREATED, COUNTRY_UPDATED, COUNTRY_ACTIVATED, COUNTRY_DEACTIVATED, MARKET_CREATED, MARKET_UPDATED, MARKET_ACTIVATED, MARKET_DEACTIVATED` and, since GEO-002, `COUNTRY_ADMINISTRATIVE_AREAS_UPDATED, ADDRESS_FORMAT_DRAFTED, ADDRESS_FORMAT_PUBLISHED` (`ck_audit_events__action`, widened in migration 0008) | yes |
| `country_id` | uuid | yes | none | Foreign key `fk_audit_events__country_id` to `geography.countries` (restrict); set exactly for COUNTRY_* actions (including `COUNTRY_ADMINISTRATIVE_AREAS_UPDATED`, whose `changes` are `{added: [area codes], updated: [area codes]}`) | yes |
| `market_id` | uuid | yes | none | Foreign key `fk_audit_events__market_id` to `geography.markets` (restrict); set exactly for MARKET_* actions | yes |
| `address_format_id` | uuid | yes | none | Added in GEO-002. Foreign key `fk_audit_events__address_format_id` to `geography.address_formats` (restrict); the subject of ADDRESS_FORMAT_* actions (the format row identifies its country and version); NULL for country and market actions | yes |
| `changes` | jsonb | yes | none | Field-level difference `{field: [old, new]}`; NULL when no field difference is recorded (the seeded `COUNTRY_CREATED` and `MARKET_CREATED` rows); must be a JSON object (`ck_audit_events__changes_object`) | yes |
| `reason` | text | yes | none | Reason supplied by the actor | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request or migration (`seed-0007`, `seed-0008`) | yes |

Subject shape (`ck_audit_events__subject`, three branches since GEO-002): a COUNTRY_* action requires `country_id` and neither `market_id` nor `address_format_id`; a MARKET_* action requires `market_id` and neither `country_id` nor `address_format_id`; an ADDRESS_FORMAT_* action requires `address_format_id` and neither of the other two. Three nullable keys are used instead of a polymorphic id so that every one stays a real foreign key. Migration 0008 seeds two more rows for the US format (`ADDRESS_FORMAT_DRAFTED` with `{"version": [null, 1]}` and `ADDRESS_FORMAT_PUBLISHED` with `{"status": ["DRAFT", "PUBLISHED"]}`, actor `system:migration`, correlation `seed-0008`); the service writes `changes` `{status: [DRAFT, PUBLISHED], effectiveFrom: [proposed, actual]}` when it publishes a format.

Indexes: `pk_audit_events`; `idx_audit_events__country (country_id, occurred_at DESC) WHERE country_id IS NOT NULL`, `idx_audit_events__market (market_id, occurred_at DESC) WHERE market_id IS NOT NULL` and, since GEO-002, `idx_audit_events__address_format (address_format_id, occurred_at DESC) WHERE address_format_id IS NOT NULL` serve the audit trail of one country, market or address format (and the foreign key checks); partial because each row sets exactly one subject.

Triggers: `trg_audit_events__immutable` (`geography.forbid_mutation`, BEFORE UPDATE OR DELETE) blocks update and delete.

### identity.roles

Application roles as reference data (ID-001): the marketplace roles an account can hold, `CUSTOMER` and `PROVIDER`. They are NOT Keycloak roles (the realm roles `customer` and `provider` are only a one-time bootstrap hint when an account is created) and NOT fine-grained permissions (those arrive with the features that need them). The display name is managed content, never a column. A role is referenced by its immutable `code` in contracts and by `role_id` in the database. Rows are never deleted. Seeded: `CUSTOMER` and `PROVIDER`, both `ACTIVE`.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `role_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_roles`; referenced by `account_roles.role_id` and `account_audit_events.role_id` | yes |
| `code` | text | no | none | Unique (`uq_roles__code`) role code, upper-case letter first then upper-case letters, digits and underscore, 2 to 30 characters (`ck_roles__code_format`), for example `CUSTOMER`; the value contracts, the API and events use; the service looks a role up by it | yes |
| `name_content_key` | text | no | none | Foreign key `fk_roles__name_content_key` to `content.entries (key)` (restrict): the managed display name of the role (`identity.role.customer.name`, `identity.role.provider.name`), resolved through the content API; dotted lower-case format (`ck_roles__name_content_key_format`). The name is never stored as text here | no |
| `status` | text | no | `ACTIVE` | `ACTIVE, INACTIVE` (`ck_roles__status`). A role cannot become `INACTIVE` while a PENDING or ACTIVE membership holds it (`ROLE_IN_USE`); a grant or activation needs an `ACTIVE` role (`ROLE_NOT_ACTIVE`) | no |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the writer (no trigger) | no |

Indexes: `pk_roles`; `uq_roles__code` (lookup by code at every grant, and the uniqueness rule). `name_content_key` has no index of its own (the target `content.entries` is never deleted and keys are immutable; no query starts from a name key; the table holds two rows).

Triggers: `trg_roles__guard` (`identity.guard_roles`, BEFORE UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`) and a change to `role_id`, `code` or `created_at` (`IMMUTABLE_IDENTITY`); refuses `ACTIVE -> INACTIVE` while any membership with status `PENDING` or `ACTIVE` holds the role (`ROLE_IN_USE`).

### identity.accounts

The BananaGig application account of one person (ID-001). It holds NO Keycloak subject (the link is `identity.external_identities`), NO credentials, NO contact data (the email contact is `identity.email_contacts` since ID-002; phone persistence belongs to ID-003), NO name (the core profile is `identity.account_profiles`) and NO address. `status` is the CURRENT state; every change is recorded in `identity.account_status_history` (current state plus immutable history is intentional: the current state is read on every authenticated request). The account row is the lock target of every account mutation (`FOR UPDATE`, lock order in `DATA_MODEL.md`). Rows are never deleted; `CLOSED` is terminal. No row is seeded: an account is created on the first authenticated request of a person.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `account_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_accounts`; the account identifier clients receive (an opaque id, never derived from the Keycloak subject) and the reference every other table and later domain stores. First column of the composite foreign key to `account_roles` | yes |
| `status` | text | no | none | `PENDING, ACTIVE, SUSPENDED, CLOSURE_REQUESTED, CLOSED` (`ck_accounts__status`). `PENDING`: created, not yet activated (no path creates it today). `ACTIVE`: usable. `SUSPENDED`: blocked by the platform (the API answers 403). `CLOSURE_REQUESTED`: still usable, closure pending. `CLOSED`: terminal (the API answers 403). Transitions by trigger: `PENDING -> ACTIVE or CLOSED`, `ACTIVE -> SUSPENDED or CLOSURE_REQUESTED`, `SUSPENDED -> ACTIVE or CLOSURE_REQUESTED or CLOSED`, `CLOSURE_REQUESTED -> ACTIVE or CLOSED`; an insert must be `PENDING` or `ACTIVE`. No financial closure semantics exist yet (DEBT-0045) | no |
| `primary_role_id` | uuid | yes | none | The persisted PREFERRED application role, used as the active role when a request names none. Composite foreign key `fk_accounts__primary_role (account_id, primary_role_id)` to `identity.account_roles (account_id, role_id)` (restrict, MATCH SIMPLE: not checked when NULL): it can only name a role this account holds; triggers require that membership to be `ACTIVE` (`PRIMARY_ROLE_NOT_ACTIVE`) and refuse deactivating it while it is the primary role (`PRIMARY_ROLE_IN_USE`). NULL when the account holds no active role or has no preference; cleared when the account closes (a CLOSED account must have none). An insert must have NULL (`ACCOUNT_INITIAL_STATE`). The first active role granted becomes the primary role | no |
| `created_at` | timestamptz | no | `now()` | Creation time (the account exists from the first authenticated request) | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the service | no |
| `closed_at` | timestamptz | yes | none | The instant the account was closed; non-NULL exactly when `status = 'CLOSED'` (`ck_accounts__closed_at`). Intentional denormalization of the `CLOSED` history row; set once, because a closed account can never change again | no (set once) |

Indexes: `pk_accounts` only. The composite foreign key `fk_accounts__primary_role` needs no separate index: its check on the referenced side is a lookup by `(account_id, role_id)` on `pk_account_roles`, and on the referencing side a lookup by `account_id`, which `pk_accounts` serves (a unique key). No index on `status` (nothing filters accounts by status yet; an administrative account search adds its own through a review).

Triggers: `trg_accounts__guard` (`identity.guard_accounts`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); on INSERT requires `PENDING` or `ACTIVE` and a NULL primary role (`ACCOUNT_INITIAL_STATE`); on UPDATE refuses a change to `account_id` or `created_at` (`IMMUTABLE_IDENTITY`), refuses any change to a `CLOSED` account (`ACCOUNT_CLOSED`), enforces the status transition table (`ACCOUNT_STATUS_TRANSITION`), refuses closing while the account still holds a PENDING or ACTIVE membership or a primary role (`ACCOUNT_HAS_ACTIVE_ROLES`), and requires the new primary role to be an ACTIVE membership of the same account, read with `FOR SHARE` (`PRIMARY_ROLE_NOT_ACTIVE`). `trg_accounts__status_history` (`identity.check_status_history`, a CONSTRAINT trigger AFTER INSERT OR UPDATE OF status, DEFERRABLE INITIALLY DEFERRED): at COMMIT the newest `account_status_history` row of the account (highest `history_seq`) must equal the CURRENT `accounts.status`, read at commit and not taken from the row version that queued the event (`STATUS_HISTORY_MISMATCH`); because it is deferred, the status and its history row can be written in either order inside one transaction, and a transaction that passes through a transient status (suspend, then reactivate) is accepted when the end state and the history agree. The other direction (a history row without a matching status change) is checked by `trg_account_status_history__consistent` on the history table.

### identity.account_roles

Role membership (ID-001): ONE row per (account, role). The primary key is the rule "an account holds a role at most once", so a duplicate active membership cannot exist; an account can hold `CUSTOMER` and `PROVIDER` at the same time (PRD CU-03.03). Re-granting a deactivated role reactivates the same row. The row describes the CURRENT episode and the LATEST grant; the history of grants, activations and deactivations is in `identity.account_audit_events` (`ROLE_GRANTED`, `ROLE_ACTIVATED`, `ROLE_DEACTIVATED`). Rows are never deleted. No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `account_id` | uuid | no | none | Part of primary key `pk_account_roles`; foreign key `fk_account_roles__account_id` to `identity.accounts` (restrict); also the first column of the key `fk_accounts__primary_role` points at | yes |
| `role_id` | uuid | no | none | Part of the primary key; foreign key `fk_account_roles__role_id` to `identity.roles` (restrict); the second column of the primary role target | yes |
| `status` | text | no | none | `PENDING, ACTIVE, INACTIVE` (`ck_account_roles__status`): `PENDING` granted but not yet active, `ACTIVE` held, `INACTIVE` deactivated. A row is inserted `PENDING` or `ACTIVE`; transitions `PENDING -> ACTIVE or INACTIVE`, `ACTIVE -> INACTIVE`, `INACTIVE -> ACTIVE` (`ROLE_STATUS_TRANSITION`; `INACTIVE -> PENDING` is refused). Equivalent to the two timestamps below (`ck_account_roles__lifecycle`) | no |
| `granted_at` | timestamptz | no | `now()` | When the LATEST grant of this membership happened (overwritten when a deactivated role is granted again) | no |
| `activated_at` | timestamptz | yes | none | When the membership last became `ACTIVE`; NULL while `PENDING` (never activated); kept when it becomes `INACTIVE`; overwritten on reactivation | no |
| `deactivated_at` | timestamptz | yes | none | When the membership became `INACTIVE`; NULL while `PENDING` or `ACTIVE` (cleared on reactivation). `ck_account_roles__lifecycle`: `PENDING` has neither timestamp, `ACTIVE` has `activated_at` and no `deactivated_at`, `INACTIVE` has `deactivated_at` | no |
| `granted_by` | text | no | none | Actor of the latest grant: `account:<account_id>` for the person, `system:<name>` for the platform (the bootstrap uses `system:account-bootstrap`) or `admin:<subject>` for an administrator (admin actions arrive with AD-07, DEBT-0046); not blank, at most 200 characters (`ck_account_roles__granted_by`). The actor names WHO acted; it is never a token and never the subject of the account being changed | no |
| `grant_source` | text | no | none | Where the latest grant came from: `BOOTSTRAP` (the one-time seeding at account creation), `SIGNUP` (an explicit sign-up flow, later), `ADMIN`, `SYSTEM` (`ck_account_roles__grant_source`) | no |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the service | no |

Indexes: `pk_account_roles (account_id, role_id)` serves the membership list of one account (prefix `account_id`: an account holds a handful of roles, so no separate partial index on `status = 'ACTIVE'`), covers the `account_id` foreign key and is the target of `fk_accounts__primary_role`. `role_id` has no index of its own: "who holds role X" is an administrative query that does not exist yet and a role is never deleted, so no foreign key check scans this table by role.

Triggers: `trg_account_roles__guard` (`identity.guard_account_roles`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); on INSERT requires `PENDING` or `ACTIVE` (`ROLE_STATUS_TRANSITION`); on UPDATE refuses a change of `account_id` or `role_id` (`IMMUTABLE_IDENTITY`) and any transition outside the table above (`ROLE_STATUS_TRANSITION`); when a membership is inserted or becomes ACTIVE it share-locks and requires an `ACTIVE` role (`ROLE_NOT_ACTIVE`) and a non-`CLOSED` account (`ACCOUNT_CLOSED`), so a concurrent role deactivation or account closure serializes with it; when an ACTIVE membership leaves ACTIVE it locks the account row (`FOR UPDATE`) and refuses the change while the membership is the account primary role (`PRIMARY_ROLE_IN_USE`).

### identity.external_identities

Maps an identity-provider login to ONE account (ID-001). For Keycloak, `provider_subject` is the immutable JWT `sub` and `issuer` the realm issuer (the public realm URL). The unique key `(provider_type, issuer, provider_subject)` is the lookup of every authenticated request and the rule that one subject links at most one account (a race between two first requests is decided by this key). Future social federation still arrives through the Keycloak subject. Nothing about credentials, tokens or sessions is stored; issuer and subject are the only provider data, because they ARE the link. PERSONAL IDENTIFIER: the subject of the login linked here is never logged and never put in audit changes, events, errors or API responses (an actor string such as `admin:<subject>` names who acted, not the account being changed). Rows are never deleted or re-pointed; only `last_seen_at` changes. No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `external_identity_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_external_identities`; the identifier of the link itself (short and stable for future references; the natural key is long) | yes |
| `account_id` | uuid | no | none | Foreign key `fk_external_identities__account_id` to `identity.accounts` (restrict): the account this login belongs to. NOT unique: an account may have several links later | yes |
| `provider_type` | text | no | none | `KEYCLOAK` (`ck_external_identities__provider_type`); a closed vocabulary, widened by a migration when another provider type needs different handling. First column of the unique key | yes |
| `issuer` | text | no | none | The issuer of the identity: the Keycloak realm URL for `KEYCLOAK`; not blank, at most 512 characters, no control characters (`ck_external_identities__issuer`). Used verbatim (an issuer that differs by one character is another identity). Second column of the unique key | yes |
| `provider_subject` | text | no | none | The provider subject (the immutable Keycloak `sub`); not blank, at most 255 characters, no control characters (`ck_external_identities__subject`). Used verbatim. Third column of the unique key | yes |
| `created_at` | timestamptz | no | `now()` | When the account was linked to this login (the first authenticated request) | yes |
| `last_seen_at` | timestamptz | no | `now()` | Last authenticated request seen for this identity, touched at most once per configured interval (`IDENTITY_LAST_SEEN_TOUCH_SECONDS`, default 300) so authenticated reads do not write on every request; a failed touch never fails a request | no |

Indexes: `pk_external_identities`; `uq_external_identities__provider_issuer_subject (provider_type, issuer, provider_subject)` is THE lookup (identity to account) and the uniqueness rule. `account_id` has no index of its own: lookups go from the identity to the account, never from an account to its identities on a hot path (an account has one Keycloak identity), and accounts are never deleted, so no foreign key check scans this table.

Triggers: `trg_external_identities__guard` (`identity.guard_external_identities`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); refuses an UPDATE that changes anything except `last_seen_at` (`IMMUTABLE_IDENTITY`); on INSERT share-locks the account row and refuses a `CLOSED` account (`ACCOUNT_CLOSED`).

### identity.account_status_history

Append-only history of the account status (ID-001): one row per status change, `from_status` NULL for the creation row. `history_seq` gives a total order, also inside one transaction (a status change and its row are written together, and per account the order equals commit order because every status change locks the account row until commit). Two deferred constraint triggers keep the current state and its history consistent in both directions: one on `identity.accounts` requires the newest row to equal the CURRENT status at commit, one on this table refuses at commit a stray row, a row whose `from_status` does not continue the previous row's `to_status` (NULL for the first row) and a newest row that differs from the account status. This table is the audit of status changes (actor, reason, correlation id); `identity.account_audit_events` covers the other mutations. Rows are immutable. No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `status_history_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_account_status_history` | yes |
| `history_seq` | bigint | no | `GENERATED ALWAYS AS IDENTITY` | Total order of the history rows (unique, `uq_account_status_history__seq`); the newest row of an account is its highest `history_seq`. Gaps are possible (rolled back inserts) and mean nothing | yes |
| `account_id` | uuid | no | none | Foreign key `fk_account_status_history__account_id` to `identity.accounts` (restrict) | yes |
| `from_status` | text | yes | none | The status before the change; NULL for the creation row (`ck_account_status_history__from_status`: NULL or one of the five statuses); it must equal the `to_status` of the account's previous row, NULL for the first row (`trg_account_status_history__consistent`, at commit) | yes |
| `to_status` | text | no | none | The status after the change (`ck_account_status_history__to_status`); the newest row's `to_status` equals the current `accounts.status` at commit. `ck_account_status_history__changed` requires it to differ from `from_status` | yes |
| `reason` | text | yes | none | Optional reason supplied by the actor; not blank and at most 1000 characters when present (`ck_account_status_history__reason`) | yes |
| `actor` | text | no | none | Who changed the status: `system:<name>` (the bootstrap writes `system:account-bootstrap`), `account:<account_id>` or `admin:<subject>` (admin actions arrive with AD-07, DEBT-0046); not blank, at most 200 characters (`ck_account_status_history__actor`). The actor names WHO acted; never a token and never the subject of the account being changed | yes |
| `occurred_at` | timestamptz | no | `clock_timestamp()` | When the change was recorded (statement-time clock, so rows of one transaction stay causally ordered) | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request (or a generated id outside a request) | yes |

Indexes: `pk_account_status_history`; `uq_account_status_history__seq (history_seq)` states the uniqueness of the identity column as a constraint (identity values are unique only while the sequence is not reset or overridden); `idx_account_status_history__account (account_id, history_seq DESC)` serves the timeline of one account newest first, the newest-row and previous-row lookups of the two deferred consistency triggers and the `account_id` foreign key.

Triggers: `trg_account_status_history__immutable` (`identity.forbid_mutation`, BEFORE UPDATE OR DELETE): every UPDATE or DELETE is refused (`ROW_IMMUTABLE`). `trg_account_status_history__consistent` (`identity.check_status_history_row`, a CONSTRAINT trigger AFTER INSERT, DEFERRABLE INITIALLY DEFERRED): at COMMIT each inserted row must continue the previous row of the account (`from_status` equals the previous `to_status` by `history_seq`, NULL for the first row) and the newest row of the account must equal the CURRENT `accounts.status` (`STATUS_HISTORY_MISMATCH` in both cases), so a stray history row is refused instead of going unnoticed. Together with `trg_accounts__status_history` on `identity.accounts` the two sides cannot drift in either direction.

### identity.account_profiles

Core profile of an account, one row at most (ID-001): first and last name, the preferred locale and an optional time zone override. `account_id` is the key (one-to-one). The row exists once the person has given a name, so the name columns are NOT NULL; a name is not in the Keycloak token (claims are minimized), so an account exists before its profile. There is NO stored display name: the public display (first name and last initial, PRD SV-11.02) is derived on read, and the legal or full name appears only in the caller's own `GET /account/me`. Contact data (email, phone), photo, bio and provider or business details are NOT here. PERSONAL DATA: never logged, never in audit changes or events, never in a public API. Rows are never deleted (erasure is DEBT-0045). No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `account_id` | uuid | no | none | Primary key `pk_account_profiles` and foreign key `fk_account_profiles__account_id` to `identity.accounts` (restrict): the one-to-one link | yes |
| `first_name` | text | no | none | First name as normalized by the service (Unicode NFC, tabs and line breaks as spaces, invisible characters removed, whitespace collapsed, trimmed); 1 to 50 characters (`ck_account_profiles__first_name`), no leading or trailing whitespace, no control characters (U+0001 to U+001F, U+007F to U+009F) and no bidirectional embedding, override or isolate characters (U+202A to U+202E, U+2066 to U+2069). Required: PRD CU-03 sign-up field table (1-50 characters, trimmed). A structural constraint, not configuration | no |
| `last_name` | text | no | none | Last name, same rules as `first_name` (`ck_account_profiles__last_name`) | no |
| `preferred_locale` | text | yes | none | Foreign key `fk_account_profiles__preferred_locale` to `content.locales (locale)` (restrict): the single locale authority; the service accepts only an ACTIVE locale at write time and reads it `FOR SHARE` inside the write transaction, so a concurrent deactivation of that locale serializes with the profile write; there is no trigger on this table, so a deactivation committed AFTER the write is allowed and the profile keeps referencing the now-inactive locale by design (a historical reference; readers fall back to the content chain). NULL means follow the market default | no |
| `time_zone_id` | uuid | yes | none | Foreign key `fk_account_profiles__time_zone_id` to `geography.time_zones` (restrict): the time zone override (PRD CU-09 language and region); never free text or an offset; the service accepts only a registered ACTIVE zone at write time and reads it `FOR SHARE` inside the write transaction (a concurrent deactivation serializes with the write); a deactivation committed AFTER the write is allowed and the profile keeps the zone by design, as addresses keep their time zone. NULL means follow the market default time zone, which is never copied here | no |
| `created_at` | timestamptz | no | `now()` | When the profile row was created (the first time the person gave a name) | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the service | no |

Indexes: `pk_account_profiles (account_id)` serves the profile lookup by account and covers the `account_id` foreign key. `preferred_locale` and `time_zone_id` have no index of their own (locales and time zones are never deleted or re-keyed, no query filters profiles by them, and the table is read by account).

Triggers: `trg_account_profiles__guard` (`identity.guard_account_profiles`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); refuses a change of `account_id` or `created_at` (`IMMUTABLE_IDENTITY`); share-locks the account row and refuses an insert or update for a `CLOSED` account (`ACCOUNT_CLOSED`).

### identity.account_audit_events

Append-only audit of account mutations other than status (ID-001; status changes are the structured `identity.account_status_history`): account created, external identity linked, role granted, activated and deactivated, primary role changed, profile updated. `changes` is a JSON object because its shape depends on the action; it never holds a token, a subject, a name or any personal value (profile updates record the NAMES of the changed fields only). Rows are immutable. No row is seeded (the migration seed writes `content.audit_events`, not identity audit rows).

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `audit_event_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_account_audit_events` | yes |
| `occurred_at` | timestamptz | no | `clock_timestamp()` | When the action was recorded (statement-time clock, so rows of one transaction stay causally ordered) | yes |
| `actor` | text | no | none | Who acted: `system:<name>` (the bootstrap writes `system:account-bootstrap`), `account:<account_id>` or `admin:<subject>` (admin actions arrive with AD-07, DEBT-0046); not blank, at most 200 characters (`ck_account_audit_events__actor`). The actor names WHO acted; never a token and never the subject of the account being changed. Never exposed through a public API | yes |
| `action` | text | no | none | `ACCOUNT_CREATED, EXTERNAL_IDENTITY_LINKED, ROLE_GRANTED, ROLE_ACTIVATED, ROLE_DEACTIVATED, PRIMARY_ROLE_CHANGED, PROFILE_UPDATED` and, since ID-002, `EMAIL_ADDED, EMAIL_CHANGE_REQUESTED, EMAIL_VERIFICATION_REQUESTED, EMAIL_VERIFICATION_FAILED, EMAIL_VERIFICATION_LOCKED, EMAIL_VERIFIED, EMAIL_PRIMARY_CHANGED` (`ck_account_audit_events__action`, widened in migration 0010) | yes |
| `account_id` | uuid | no | none | Foreign key `fk_account_audit_events__account_id` to `identity.accounts` (restrict): the account the action concerns | yes |
| `role_id` | uuid | yes | none | Foreign key `fk_account_audit_events__role_id` to `identity.roles` (restrict); set exactly for the `ROLE_*` actions (`ck_account_audit_events__role`: `(action LIKE 'ROLE\_%') = (role_id IS NOT NULL)`); `PRIMARY_ROLE_CHANGED` records role codes in `changes` instead | yes |
| `changes` | jsonb | yes | none | Optional JSON object (`ck_account_audit_events__changes_object`): `{status: [from, to], source}` for role rows, `{status: [null, 'ACTIVE']}` and `{providerType}` for the creation rows, `{primaryRole: [old code, new code]}` (new code null when the primary role is cleared, also by closing the account, which writes this row in addition to the `ROLE_DEACTIVATED` rows), `{fields: [names of the changed profile fields]}`. Read back whole, never filtered relationally. No token, subject or personal value | yes |
| `reason` | text | yes | none | Reason supplied by the actor (a role change), when given | yes |
| `correlation_id` | text | no | none | Correlation id of the originating request (or a generated id outside a request) | yes |
| `email_contact_id` | uuid | yes | none | Added in ID-002 (the last column of the table). Together with `account_id` the COMPOSITE foreign key `fk_account_audit_events__account_email_contact (account_id, email_contact_id)` to `identity.email_contacts (account_id, email_contact_id)` (restrict, MATCH SIMPLE, target `uq_email_contacts__account_contact`: an audit row can only name a contact of the audited account): the email contact an `EMAIL_*` action concerns; set exactly for the `EMAIL_*` actions (`ck_account_audit_events__email_contact`: `(action LIKE 'EMAIL\_%') = (email_contact_id IS NOT NULL)`), NULL for every other action. The audit trail names the contact by id and, in `changes`, by a MASKED address; it never holds a full address, a code, a token or a hash | yes |

Indexes: `pk_account_audit_events`; `idx_account_audit_events__account (account_id, occurred_at DESC)` serves the audit timeline of one account and the `account_id` foreign key. `role_id` has no index of its own (a role is never deleted and nothing starts an audit query from a role).

Triggers: `trg_account_audit_events__immutable` (`identity.forbid_mutation`, BEFORE UPDATE OR DELETE): every UPDATE or DELETE is refused (`ROW_IMMUTABLE`).

Extension in ID-002 (migration 0010, expand step): seven `EMAIL_*` actions and the nullable `email_contact_id`. `EMAIL_ADDED` (a first address was set, or an IDP-verified address was recorded), `EMAIL_CHANGE_REQUESTED` (a replacement address was set while a verified primary exists), `EMAIL_VERIFICATION_REQUESTED` (a verification email was issued), `EMAIL_VERIFICATION_FAILED` (a wrong code, with the attempt number), `EMAIL_VERIFICATION_LOCKED` (the attempt that reached the maximum locked the challenge), `EMAIL_VERIFIED` (the address was verified, with the method `CODE`, `LINK` or `IDP`) and `EMAIL_PRIMARY_CHANGED` (a verified replacement became the primary and the old primary was disabled). For these actions `changes` holds the MASKED address (`c***@b***.localhost`), status pairs, purpose (`INITIAL_EMAIL`, `CHANGE_EMAIL`), method, attempt numbers, the challenge id or the replaced contact id; never a full address, a code, a token or a hash. The per-contact timeline is read through `idx_account_audit_events__account` with the contact as a filter (an account has a handful of contacts), so no index was added for `email_contact_id`. The migration seeds no identity audit row.

### identity.email_contacts

The email addresses of an account, owned by BananaGig (ID-002). NOT a copy of the Keycloak email: the login email stays in Keycloak and a plain email claim is never persisted; an address is `VERIFIED` only when the person proved the mailbox with a code or a magic link, or a TRUSTED identity provider reported it verified. An account has at most one primary (`VERIFIED`) address, at most one open candidate (`PENDING` first address or `REPLACEMENT_PENDING` replacement) and the `DISABLED` history. The canonical address is the only stored form. PERSONAL DATA: `email_normalized` is never logged, never in audit `changes`, events, errors or an API response; the owner receives it only MASKED. Privacy classes in this table: `email_normalized` PERSONAL DATA; every other column is non-personal state; nothing here is a secret. Rows are never deleted (erasure is DEBT-0045). No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `email_contact_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_email_contacts`; the identifier audit rows, challenges and events reference (opaque, not derived from the address) | yes |
| `account_id` | uuid | no | none | Foreign key `fk_email_contacts__account_id` to `identity.accounts` (restrict): the account that holds the address. NOT unique (a primary, an open candidate and the history); first column of three of the partial unique indexes and of the unique constraint `uq_email_contacts__account_contact (account_id, email_contact_id)` (the target of the composite foreign key of `account_audit_events`, which also serves every read by account). The account row is locked before any sibling is read | yes |
| `email_normalized` | text | no | none | The canonical address: lower-case ASCII, trimmed, domain IDNA-mapped, local part a lower-cased ASCII dot-atom, dots and `+tags` kept (produced by the one function `canonicalizeEmail`). The comparison key, the uniqueness key (verified rows) and the delivery address; the original typing is not kept. `ck_email_contacts__email_normalized` bounds it (at most 254 characters, local part 1 to 64 and domain 3 to 253 characters of the allowed alphabets). Privacy class: PERSONAL DATA | yes |
| `status` | text | no | none | `PENDING, VERIFIED, REPLACEMENT_PENDING, DISABLED` (`ck_email_contacts__status`). `PENDING`: the first address, unverified. `VERIFIED`: ownership proven. `REPLACEMENT_PENDING`: a new address that replaces the verified primary once it verifies (the old address stays `VERIFIED` and primary until then). `DISABLED`: replaced or superseded, kept as history. Transitions by trigger: `PENDING` and `REPLACEMENT_PENDING` to `VERIFIED` or `DISABLED`, `VERIFIED` to `DISABLED` (only as `REPLACED`, only while a `REPLACEMENT_PENDING` row exists), `DISABLED` terminal; an insert is `PENDING` without a primary, `REPLACEMENT_PENDING` with a primary, or `VERIFIED` only from a trusted identity provider without a primary (`EMAIL_STATUS_TRANSITION`, `EMAIL_INITIAL_WITH_PRIMARY`, `EMAIL_REPLACEMENT_WITHOUT_PRIMARY`, `EMAIL_PRIMARY_NOT_REPLACEABLE`) | no |
| `is_primary` | boolean | no | `false` | The account's primary active address. Only a `VERIFIED` row can be primary (`ck_email_contacts__primary_is_verified`) and an account has at most one (`uq_email_contacts__primary_per_account`). Flips to true only together with the transition into `VERIFIED` (which must set it) and to false only together with `DISABLED` (`EMAIL_PRIMARY_CHANGE`), so the primary is replaced atomically. A row created `VERIFIED` (only `IDP_VERIFIED`) must be created primary (`EMAIL_PRIMARY_CHANGE`), so `is_primary` and `status = 'VERIFIED'` coincide on every row and an account has at most one `VERIFIED` row (intentional denormalization: a stored function of the status, kept as the explicit name of the primary) | no |
| `source` | text | no | none | `USER_ENTERED` (must be verified by code or link) or `IDP_VERIFIED` (a trusted identity provider reported the address verified; born `VERIFIED`, `ck_email_contacts__idp_born_verified`) (`ck_email_contacts__source`). A claim without the verified flag from a trusted provider is neither: it is not persisted | yes |
| `verified_at` | timestamptz | yes | none | When ownership was proven. Non-NULL for `VERIFIED`, NULL for `PENDING` and `REPLACEMENT_PENDING` (`ck_email_contacts__verified_at`); a `DISABLED` row keeps the value of its verified period (a replaced primary) or has none (superseded before it verified). Set exactly once and kept when the address is later replaced (`IMMUTABLE_IDENTITY`) | no (set once) |
| `disabled_at` | timestamptz | yes | none | When the address was replaced or superseded; non-NULL exactly when `status = 'DISABLED'` (`ck_email_contacts__disabled`). Written once with the transition; the row is frozen afterwards (`IMMUTABLE_IDENTITY`) | no (set once) |
| `disabled_reason` | text | yes | none | `REPLACED` (a verified primary replaced by a newly verified address) or `SUPERSEDED` (a pending address replaced by a newer one, or the change withdrawn, before it verified) (`ck_email_contacts__disabled_reason`); non-NULL exactly when `status = 'DISABLED'`. The guard fixes it by the previous status: `VERIFIED` to `DISABLED` only as `REPLACED`, `PENDING` or `REPLACEMENT_PENDING` to `DISABLED` only as `SUPERSEDED`; the row is frozen afterwards | no (set once) |
| `created_at` | timestamptz | no | `now()` | Creation time | yes |
| `updated_at` | timestamptz | no | `now()` | Last update, maintained by the service (no trigger); a `DISABLED` row can no longer be updated, so its value is the instant of the transition to `DISABLED` | no |

Uniqueness: a `VERIFIED` address belongs to at most ONE account (`uq_email_contacts__verified_address`); `PENDING` claims are deliberately NOT unique across accounts (a pending claim proves nothing, so it neither blocks the real owner nor reveals that anyone else holds the address); per account at most one primary, at most one open candidate and one live row per address.

Indexes: `pk_email_contacts`; `uq_email_contacts__verified_address (email_normalized) WHERE status = 'VERIFIED'` (the rule, and the lookup "is this address verified on any account" at verification); `uq_email_contacts__primary_per_account (account_id) WHERE is_primary` (the rule, and the lookup of the primary address read by `GET /account/me`); `uq_email_contacts__open_per_account (account_id) WHERE status IN ('PENDING', 'REPLACEMENT_PENDING')` (the rule, and the lookup of the pending candidate); `uq_email_contacts__live_address_per_account (account_id, email_normalized) WHERE status <> 'DISABLED'` (the rule only: an account cannot hold the same live address twice); the unique constraint `uq_email_contacts__account_contact (account_id, email_contact_id)` (a superset of the primary key: the target of the audit composite foreign key; its leading column also serves every read by account, the whole-account read of the deferred invariant trigger and the `account_id` foreign key). No index on `email_normalized` for pending duplicates (nothing filters pending rows by address) and no separate index on `account_id` (the constraint index covers it); an index follows a real query path through its own review.

Triggers: `trg_email_contacts__guard` (`identity.guard_email_contacts`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); refuses a change of `email_contact_id`, `account_id`, `email_normalized`, `source` or `created_at`, of an already set `verified_at` and ANY update of a `DISABLED` row (`IMMUTABLE_IDENTITY`); enforces the status transition table, the primary flag rules (a transition into `VERIFIED` must set `is_primary`) and the disable reasons (`EMAIL_STATUS_TRANSITION`, `EMAIL_PRIMARY_CHANGE`); refuses verifying a contact of a `CLOSED` account, after share-locking the account row (`ACCOUNT_CLOSED`); refuses disabling a verified primary unless a `REPLACEMENT_PENDING` row exists, after locking the account row (`EMAIL_PRIMARY_NOT_REPLACEABLE`); on INSERT locks the account row, refuses a `CLOSED` account (`ACCOUNT_CLOSED`) and applies the insert rules (`EMAIL_STATUS_TRANSITION`, `EMAIL_INITIAL_WITH_PRIMARY`, `EMAIL_REPLACEMENT_WITHOUT_PRIMARY`, and `EMAIL_PRIMARY_CHANGE` for a row created `VERIFIED` without `is_primary`). `trg_email_contacts__invariants` (`identity.check_email_account_invariants`, a CONSTRAINT trigger AFTER INSERT OR UPDATE, DEFERRABLE INITIALLY DEFERRED): at COMMIT a pending initial address and a primary never coexist, a `REPLACEMENT_PENDING` address needs a primary, an account that ever replaced a primary still has one, and a contact that is no longer open has no open challenge (`EMAIL_INVARIANT`); being deferred, the multi-step replacement may pass through intermediate states inside its transaction.

### identity.email_verification_challenges

One verification intent per SEND (ID-002). A resend creates a NEW challenge (new code, new magic token) and supersedes the open one in the same transaction, so the number of sends in a window is the number of rows (no counter to drift) and the history of sends is kept. The code and the magic token are shown once, in the email; only their HMAC-SHA-256, keyed with a server secret held outside the database (`VERIFICATION_HASH_SECRET`), is stored, so a database leak cannot be used to verify an address and a 6-digit code cannot be brute-forced offline. SECURITY: single use (`used_at`, set under the row lock together with the verification of the contact), expiry, wrong attempts counted atomically, locked when the configured maximum is reached. Privacy classes in this table: `code_hash` and `magic_token_hash` DERIVED SECRETS (keyed hashes; they must not leave the server and never appear in a response, log, audit row or event); NO column holds a plaintext code, a plaintext token or the address (the address is only on the parent contact row); `correlation_id` is a technical identifier. Rows are never deleted. No row is seeded.

| Column | Type | Null | Default | Meaning | Immutable |
|---|---|---|---|---|---|
| `challenge_id` | uuid | no | `gen_random_uuid()` | Primary key `pk_email_verification_challenges`; the code hash is bound to it | yes |
| `email_contact_id` | uuid | no | none | Foreign key `fk_email_verification_challenges__email_contact_id` to `identity.email_contacts` (restrict): the contact being verified. A challenge can only be issued for a `PENDING` or `REPLACEMENT_PENDING` contact, whose row is locked at insert (`CHALLENGE_NOT_OPEN`) | yes |
| `purpose` | text | no | none | `INITIAL_EMAIL` or `CHANGE_EMAIL` (`ck_email_verification_challenges__purpose`), frozen at issuance from the contact status (`PENDING` gives initial, `REPLACEMENT_PENDING` gives change; `CHALLENGE_PURPOSE`). A deliberate snapshot (intentional denormalization): the contact status changes when the address verifies, the purpose of this send must not | yes |
| `code_hash` | text | no | none | HMAC-SHA-256 hex (64 lower-case hex characters, `ck_email_verification_challenges__code_hash`) of the numeric code, bound to the challenge id and domain-separated, keyed with `VERIFICATION_HASH_SECRET`. The plaintext code (`verification.email.code.length` digits) is never stored or logged. Privacy class: DERIVED SECRET. Not unique (the code space is small; the lookup is by contact, never by code) | yes |
| `magic_token_hash` | text | no | none | HMAC-SHA-256 hex (`ck_email_verification_challenges__magic_token_hash`) of the 256-bit random magic-link token. Unique (`uq_email_verification_challenges__magic_token_hash`): it is the lookup key of a link confirmation. The plaintext token is never stored or logged. Privacy class: DERIVED SECRET | yes |
| `expires_at` | timestamptz | no | none | When the challenge stops being usable, set at issuance from `verification.email.validity_minutes`; `expires_at > created_at` (`ck_email_verification_challenges__expiry`). Expiry is evaluated on the row loaded by key; there is no status `EXPIRED` and no sweeper | yes |
| `used_at` | timestamptz | yes | none | When the challenge was consumed; set under the row lock together with the transition of the contact to `VERIFIED`, and checked at commit (`CHALLENGE_CONSUMPTION`). NULL and `consumed_via` NULL while unused (`ck_email_verification_challenges__consumed`); never set together with `invalidated_at` (`ck_email_verification_challenges__closed_once`) | no (set once) |
| `consumed_via` | text | yes | none | `CODE` or `LINK`: how the challenge was consumed; non-NULL exactly when `used_at` is | no (set once) |
| `attempt_count` | integer | no | `0` | Wrong code attempts, incremented atomically under the challenge row lock, one attempt at a time (`CHALLENGE_ATTEMPTS`), `>= 0` (`ck_email_verification_challenges__attempts`). When `verification.email.max_attempts` is reached the same statement locks the challenge. A wrong magic token is not an attempt on any challenge (it matches none). A single counter column, not an events table: each failed attempt is also an audit row (`EMAIL_VERIFICATION_FAILED`) | no |
| `invalidated_at` | timestamptz | yes | none | When the challenge was closed without being used; NULL while it is open or used. Non-NULL exactly when `invalidation_reason` is (`ck_email_verification_challenges__invalidated`) | no (set once) |
| `invalidation_reason` | text | yes | none | `SUPERSEDED` (a newer challenge was issued), `LOCKED` (maximum wrong attempts reached), `CONTACT_DISABLED` (the address was replaced or superseded) or `DELIVERY_FAILED` (the message could not be sent, so the code was never delivered). An invalidated challenge can never verify | no (set once) |
| `delivery_status` | text | no | `PENDING` | `PENDING, SENT, FAILED` (`ck_email_verification_challenges__delivery`). `PENDING` until the delivery outcome is recorded (a crash between delivery and recording leaves `PENDING` with a still valid code); recorded once (`CHALLENGE_DELIVERY`). `SENT` exactly when `last_sent_at` is set. A failed delivery closes the challenge with `DELIVERY_FAILED` | no (recorded once) |
| `last_sent_at` | timestamptz | yes | none | When the delivery provider accepted the message (NULL while pending or after a failed delivery). The resend cooldown counts from the creation of the newest challenge that is neither `FAILED` nor used, so a delivery in flight holds a second send back, a failed delivery does not make the person wait and a verified address does not delay the next change; the per-hour and per-day caps count every challenge, so failing deliveries are bounded too | no (recorded once) |
| `created_at` | timestamptz | no | `now()` | When the challenge was issued, also the instant the hourly and daily caps count from | yes |
| `correlation_id` | text | no | none | Correlation id of the issuing request, carried by its audit rows and events too; not blank, at most 200 characters (`ck_email_verification_challenges__correlation`) | yes |

State is derived, not flagged: a challenge is OPEN while `used_at` and `invalidated_at` are both NULL, EXPIRED when `expires_at` has passed, CONSUMED when `used_at` is set and CLOSED otherwise (by `invalidation_reason`). There is no `status`, `is_open` or `is_expired` column, no `sent_count` and no `resend_count`: the number of sends in a window is a count of rows.

Indexes: `pk_email_verification_challenges`; `uq_email_verification_challenges__magic_token_hash (magic_token_hash)` (a constraint: the lookup of a link confirmation and the guarantee that two challenges never share a token); `uq_email_verification_challenges__open_per_contact (email_contact_id) WHERE used_at IS NULL AND invalidated_at IS NULL` (the lookup of the contact's open challenge for a code confirmation and the rule that a contact has at most one open challenge); `idx_email_verification_challenges__contact_created (email_contact_id, created_at DESC)` (the send history of ONE contact, newest first: the resend cooldown, the per-hour and per-day caps and the verification timeline; it also covers the foreign key; counting per account joins the account's few contacts to this index). No index on `expires_at`: expiry is evaluated on the row loaded by key and there is no sweeper; a retention job would add a partial index through its own review.

Triggers: `trg_email_verification_challenges__guard` (`identity.guard_email_verification_challenges`, BEFORE INSERT OR UPDATE OR DELETE): refuses DELETE (`NOT_DELETABLE`); on INSERT share-locks the account row and refuses a `CLOSED` account (`ACCOUNT_CLOSED`), then locks the contact row (`FOR UPDATE`), requires it to be `PENDING` or `REPLACEMENT_PENDING` (`CHALLENGE_NOT_OPEN`), requires the purpose to match its status (`CHALLENGE_PURPOSE`) and requires a fresh start (`attempt_count` 0, not used, not invalidated, delivery `PENDING`: `CHALLENGE_STATE`); on UPDATE refuses a change of `challenge_id`, `email_contact_id`, `purpose`, both hashes, `expires_at`, `created_at` or `correlation_id` (`IMMUTABLE_IDENTITY`), refuses any change to a used or invalidated challenge (`CHALLENGE_CLOSED`), allows `attempt_count` to stay or grow by exactly one (`CHALLENGE_ATTEMPTS`) and refuses changing `delivery_status` or `last_sent_at` once the outcome is recorded (`CHALLENGE_DELIVERY`). `trg_email_verification_challenges__consumption` (`identity.check_challenge_consumption`, a CONSTRAINT trigger AFTER UPDATE, DEFERRABLE INITIALLY DEFERRED): at COMMIT a challenge with `used_at` set must belong to a `VERIFIED` contact (`CHALLENGE_CONSUMPTION`), so a challenge is consumed only together with the verification of its address.
