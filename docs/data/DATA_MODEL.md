# Data Model (as of GEO-001)

Describes what exists in the database today, verified against a database migrated from zero. No business-domain tables (identity, catalog, booking, finance and so on) exist yet; the application schemas are platform registries (`configuration`, `content`, `geography`) plus the outbox. Conventions: `DATABASE_CONVENTIONS.md`; migration rules: `MIGRATION_POLICY.md`; review rules: `DATA_MODEL_GUARDRAILS.md`; exact structure: `SCHEMA_SNAPSHOT.sql`.

## Schemas and ownership

| Schema | Class | Contents | Notes |
|---|---|---|---|
| `public` | application (bookkeeping) + extension | `schema_migrations` (application); `spatial_ref_sys` and PostGIS objects (extension) | Infrastructure only; product tables never go here (ADR-0008) |
| `integration` | **application** | `outbox_events` | Created in INF-003; cross-domain integration infrastructure |
| `configuration` | **application** | 10 tables: `scope_levels`, `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` | Created in CFG-001; the product configuration registry |
| `content` | **application** | 8 tables: `locales`, `entries`, `entry_variables`, `versions`, `version_approvals`, `snapshots`, `snapshot_items`, `audit_events` | Created in CFG-002; the managed content and localization registry. Reuses `configuration.scope_levels` (no second scope hierarchy) |
| `geography` | **application** | 8 tables: `currencies`, `time_zones`, `countries`, `country_locales`, `country_time_zones`, `markets`, `market_locales`, `audit_events` | Created in GEO-001; country, currency, time zone and market reference data with data-driven defaults and activation. References `content.locales` (the single locale authority) and `content.entries` (country display name); it has no locale table of its own. No address, tax or payment data |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queue `infra.ping` | Created by the worker on start; never altered by our migrations |
| database `keycloak` | infrastructure (Keycloak) | Identity provider tables | Separate database and role |

Extensions: `plpgsql`, `postgis 3.6`, `btree_gist` (extension-owned; supports the no-overlap exclusion constraints on `configuration.value_versions` and `content.versions`). **Deferred schemas** (created by the first feature that needs them): identity, catalog, provider, capacity, search, booking, finance, banana_credit, subscription, tax, messaging, trust, admin, audit.

## Application-owned tables

### `public.schema_migrations`
Migration bookkeeping. Columns: `version integer` (PK), `filename text` (unique), `checksum text`, `applied_at timestamptz`, `duration_ms integer` (nullable; NULL for 0001). Checks: `version > 0`, filename must match the zero-padded version, `duration_ms >= 0`. Rows are never updated or deleted.

### `integration.outbox_events`
Generic transactional outbox. One row per domain event, inserted in the same transaction as the state change; relayed to NATS JetStream by the worker; `published_at` marks completion. Key `outbox_event_id uuid` (also the event id and the JetStream message id). No foreign keys by design (domain-agnostic; `aggregate_id` is text). Partial indexes serve the relay (`idx_outbox_events__pending`) and retention purge (`idx_outbox_events__published_at`). Checks guard event-type format, version/type consistency, actor type, object payload, attempt counts. Business events do not exist yet; only the infrastructure `bananagig.infra.ping.v1` is produced (by the worker self-test).

### `configuration.*` (CFG-001): the product configuration registry

Normalized model; full column documentation in `DATA_DICTIONARY.md`, relationships in `ERD.md`, behavior in `docs/engineering/CONFIGURATION.md`.

| Table | Role |
|---|---|
| `configuration.scope_levels` | Canonical scope hierarchy as reference data (`PLATFORM` rank 0 ... `DROP` rank 7). Higher rank is more specific and wins |
| `configuration.parameters` | One typed definition per key: data type, validation rules, sensitivity, approval policy, criticality, owner. No default column (the PLATFORM value is the default) |
| `configuration.parameter_scopes` | Scope levels at which a parameter may be overridden (allowed overrides) |
| `configuration.parameter_values` | One holder per (parameter, scope level, scope reference). `scope_ref` has no foreign key by design; the composite FK to `parameter_scopes` enforces the allowed level |
| `configuration.value_versions` | Immutable published values with half-open validity `[effective_from, effective_to)`; exclusion constraint prevents overlap per holder |
| `configuration.change_requests` | Workflow: `DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED/ACTIVE -> SUPERSEDED`, plus `REJECTED`, `CANCELLED`. Content frozen after DRAFT; transitions guarded by trigger |
| `configuration.change_approvals` | Immutable decisions, one per approver per request; self-approval blocked by trigger under SECOND_APPROVER |
| `configuration.snapshots`, `configuration.snapshot_items` | Immutable record of a resolution: context and time, plus the exact version used per parameter |
| `configuration.audit_events` | Append-only audit of every mutation (actor, action, versions, reason, correlation id) |

Scope polymorphism choice: `scope_type` (FK to `scope_levels`) plus an opaque text `scope_ref`, with no foreign keys into domain tables that do not exist yet. Integrity of the *level* is enforced by the database; existence of the *referenced entity* is validated by the owning domain when it exists (DEBT-0024). ADR-0016.

### `content.*` (CFG-002): the content and localization registry

Managed product copy (UI text, message templates, help articles, legal documents) as stable keys with localized, effective-dated, immutable versions. Normalized model; full column documentation in `DATA_DICTIONARY.md`, relationships in `ERD.md`, behavior in `docs/engineering/CONTENT.md`. Content is not configuration: values that tune behavior stay in `configuration.*`.

| Table | Role |
|---|---|
| `content.locales` | Registry of locales (canonical BCP 47 subset) and the single locale authority for the platform (geography references it; GEO-001 added `display_name` and the generated `language`, `script`, `region`). `is_active` controls what may be served; the `is_platform_default` row (always active) is the last resort of every fallback chain: the unique index allows at most one, the guard trigger refuses to unset it (a migration moves it by disabling the guard inside its own transaction), and the resolver fails with `UNAVAILABLE` (`NO_PLATFORM_DEFAULT`) if none exists. Seeded with `en-US` only (structural reference data, not copy). Rows are never deleted |
| `content.entries` | Stable identity of one piece of content: unique dotted `key`, `content_type`, `owner_role`, `sensitivity`, `criticality`, `approval_policy`, `fallback_policy`, `max_scope_type`. Immutable except `is_active`. Legal documents are entries with `content_type = 'LEGAL'` (forced owner, policy, criticality and fallback by check constraint) |
| `content.entry_variables` | Typed placeholders of an entry, shared by every locale and version. Immutable; no required variable once the entry has versions |
| `content.versions` | One row per (entry, locale, scope, version number) holding the template body and its own lifecycle `DRAFT -> IN_REVIEW -> APPROVED -> SCHEDULED/PUBLISHED -> SUPERSEDED`, plus `REJECTED`, `CANCELLED`. Body immutable from creation; half-open validity `[effective_from, effective_to)`; exclusion constraint `ex_versions__no_overlap` forbids overlapping published rows per holder |
| `content.version_approvals` | Immutable review decisions, one per approver per version; trigger blocks self-approval under SECOND_APPROVER and requires the version to be `IN_REVIEW` |
| `content.snapshots`, `content.snapshot_items` | Immutable record of a resolution (requested locale, context, evaluation time) plus the exact version used per entry (snapshot reads expose no `effective_to`, so a read-back is byte-stable). Created only for copy that must be reproducible; routine UI labels are never snapshotted |
| `content.audit_events` | Append-only audit of every content mutation (actor, action, entry, locale for locale actions only, versions tied to the entry by composite foreign keys, reason, correlation id); bodies are never copied |

Scope reuse: `content.entries.max_scope_type` and `content.versions.scope_type` are foreign keys to `configuration.scope_levels`, so the platform has ONE scope hierarchy. Content uses only `PLATFORM < COUNTRY < MARKET` (a check restricts the values; specificity comes from `scope_levels.rank`). `versions.scope_ref` is an opaque text reference with no foreign key, the same polymorphism choice as ADR-0016 / DEBT-0024.

Legal documents are `LEGAL` entries, not a separate table family. Future acceptance records (ID-005) will reference `content.versions.version_id` (immutable) and `body_sha256`; no legal-specific table exists.

### `geography.*` (GEO-001): the geography registry

Country, currency, time zone and market reference data. Every default (currency, locale, time zone, distance unit, first day of week, date and time format) is a row value, never code. Normalized model; full column documentation in `DATA_DICTIONARY.md`, relationships in `ERD.md`. Rows are never deleted: statuses are `PLANNED`, `ACTIVE`, `INACTIVE` (check constraints on the four status-bearing tables), and "active" never means anything else than `status = 'ACTIVE'`.

| Table | Role |
|---|---|
| `geography.currencies` | ISO 4217 currencies. Primary key is the alpha code `char(3)`; unique numeric code; `minor_unit_digits` 0..4 is data (not every currency has two decimals). Code, numeric code and minor unit digits are immutable (stored money depends on them) |
| `geography.time_zones` | IANA time zone identities (`iana_name` unique, surrogate `time_zone_id`). A NEW name must be listed in the database server's tz database (`pg_timezone_names`; the `posix/` and `right/` alias trees are refused; checked by trigger on insert only, so it reflects the server's tzdata at that moment and is not re-validated when tzdata is updated; an already registered name skips the scan). UTC offsets are never an identity |
| `geography.countries` | One row per country: ISO alpha-2/alpha-3/numeric (unique, immutable), `display_name_content_key` (foreign key to `content.entries (key)`: the display name is managed content, not a column), dialing code, default currency (FK to `geography.currencies`), default locale, and the format settings as enum codes `distance_unit`, `first_day_of_week`, `date_format_code`, `time_format_code`. Single source of the format settings: markets inherit them |
| `geography.country_locales` | Locales supported in a country (many-to-many to `content.locales`; immutable link rows). Its primary key `(country_id, locale)` is the target of the deferred composite foreign key `fk_countries__default_locale`, so a country default locale must be one of its supported locales |
| `geography.country_time_zones` | Time zones used in a country (many-to-many; immutable link rows). Its primary key is the target of `fk_markets__country_time_zone`, so a market time zone must belong to the market's country |
| `geography.markets` | A first-class operating area inside one country: unique kebab-case `code`, `name` (at most 120 characters), country, default locale, currency, default time zone, and the half-open effective window `[effective_from, effective_to)` on the row (no version table). Distance unit and date/time formats are NOT stored here (inherited from the country). "In effect" is derived from `status = 'ACTIVE'` plus the window at read time |
| `geography.market_locales` | Locales a market supports (many-to-many; immutable link rows). `country_id` repeats `markets.country_id` on purpose (intentional denormalization, see below) so that `(country_id, locale)` can reference `country_locales`; `(market_id, locale)` is the target of the deferred composite foreign key `fk_markets__default_locale` |
| `geography.audit_events` | Append-only audit of every geography management mutation: actor, action, exactly one subject (`country_id` or `market_id`, two nullable foreign keys under `ck_audit_events__subject`), field-level `changes` as a JSON object `{field: [old, new]}`, reason, correlation id. Reference values are public, so values are recorded (unlike `configuration.audit_events`) |

**Single locale authority.** `content.locales` stays the one registry of locales; geography references it by foreign key (`geography.country_locales.locale`) and by trigger (see below). Dependency direction in the database is geography -> content only (the content schema has no foreign key, column or trigger function that reads geography tables except the one deactivation guard below, which is owned by geography). GEO-001 changed `content.locales` additively (expand step): `display_name text NOT NULL` (inserted rows without one get the tag itself, by `content.default_locale_display_name`), plus generated stored columns `language`, `script`, `region` derived from the tag, so they cannot drift. The CHECK `ck_locales__display_name_not_blank` guards the name.

**Activation rules enforced by the database** (guard triggers, safety net under the service). The rows an activation reads are locked `FOR SHARE` (country: default currency, default locale and the ACTIVE time zone rows it relies on; market: country, currency, time zone and locale), so a concurrent deactivation, which needs the row lock, serializes with it and exactly one of the two wins (race-tested for market activation versus country deactivation, and country activation versus deactivation of its only ACTIVE zone, in both orders). Two rules read SIBLING rows and therefore lock the row that owns the invariant first: deactivating a time zone locks every ACTIVE country that uses it (`FOR UPDATE`, in `country_id` order) before it checks that the country keeps another ACTIVE zone, so two concurrent deactivations of two different zones of one country serialize and the second is refused; removing a country time zone or locale link share-locks the country row before it reads the country status, so an activation of that country and the removal of its only zone link serialize (race-tested in both orders). Every guard failure carries a machine-readable key in the error DETAIL, exactly `geography_rule:<KEY>` (keys: `CURRENCY_NOT_ACTIVE`, `COUNTRY_NOT_ACTIVE`, `TIME_ZONE_NOT_ACTIVE`, `LOCALE_NOT_ACTIVE`, `NO_ACTIVE_TIME_ZONE`, `COUNTRY_HAS_ACTIVE_MARKETS`, `CURRENCY_IN_USE`, `TIME_ZONE_IN_USE`, `LOCALE_IS_ACTIVE_DEFAULT`, `LINKS_PROTECTED`, `PLANNED_IS_INITIAL`, `IMMUTABLE_IDENTITY`, `NOT_DELETABLE`, `NOT_IANA`, `ROW_IMMUTABLE`); the service classifies by that key and never by message text (messages contain user-chosen codes). Lock order (service and triggers): the markets of a country (`market_id` order), then the country, then currency, time zone and locale rows. One inversion is inherent: a time zone row is locked by the UPDATE itself before its trigger can lock the country, so a raw SQL zone deactivation racing a market activation can deadlock; PostgreSQL aborts one side (`40P01`) and the service reports a retryable `CONFLICT` (`CONCURRENT_UPDATE`). A country can become `ACTIVE` only with an `ACTIVE` default currency, an `ACTIVE` default locale and at least one `ACTIVE` linked time zone (so it is created `PLANNED`, linked, then activated; creating a country directly `ACTIVE` fails); a market can become `ACTIVE` only with an `ACTIVE` country, currency, default time zone and default locale; a currency, time zone or locale cannot be deactivated while an `ACTIVE` country or market depends on it (a time zone also not while it is the last `ACTIVE` zone of an `ACTIVE` country; a locale only when it is the default of an `ACTIVE` country or market, so a non-default supported locale can be deactivated on purpose and public reads then hide it); a country cannot be deactivated while it has `ACTIVE` markets. Identity (ISO codes, market code and country, time zone id and name, currency code, numeric code and minor unit digits) is immutable; DELETE on currencies, time zones, countries and markets is refused; `geography.audit_events` is append-only.

**Status machine** (currencies, time zones, countries, markets). `PLANNED` is the initial status only: the guard triggers refuse any UPDATE that sets a row back to `PLANNED`. The permitted transitions are `PLANNED -> ACTIVE`, `PLANNED -> INACTIVE`, `ACTIVE -> INACTIVE` and `INACTIVE -> ACTIVE`, each subject to the activation and deactivation rules above; the service never writes `PLANNED` and treats activation and deactivation as idempotent.

**Immutable link rows.** `geography.country_locales`, `geography.country_time_zones` and `geography.market_locales` are never updated (BEFORE UPDATE trigger `geography.forbid_mutation`): a link is inserted or deleted. Deleting a link of an `ACTIVE` country (locale or time zone) is refused by trigger (after share-locking the country row); adding one is allowed. A market's default time zone and default locale are protected by their composite foreign keys, so a link a market still uses cannot be removed; the service checks this with plain reads before it deletes anything (typed `IN_USE`), because the foreign key check would lock the market row in the opposite lock order. `markets.name` is limited to 120 characters (`ck_markets__name_not_blank`).

**Cross-schema triggers.** `trg_locales__geography_guard` (function `geography.guard_locale_deactivation`) is a BEFORE UPDATE trigger on `content.locales`: it refuses `is_active` true -> false for a locale that is the default of an `ACTIVE` country or market. It sits next to the existing `trg_locales__guard` (owned by content). Country and market guards read `content.locales.is_active` (`FOR SHARE`) at activation. `geography.countries.display_name_content_key` has a foreign key into `content.entries`.

**Derived, never stored.** Market readiness (what a market still lacks to go live) is evaluated in code by a readiness registry and is not a column; "market in effect" is `status` plus the window; the distance unit and formats of a market come from its country at read time; locale language, script and region are generated columns.

**Seeded launch reference data** (migration 0007, deterministic, no business values, no tax, payment or address data): currency `USD` (840, 2 minor digits, `ACTIVE`); four IANA zones `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles` (all `ACTIVE`); country `US` (USA, 840, `ACTIVE`, +1, default currency `USD`, default locale `en-US`, `MILES`, `SUNDAY`, `MDY`, `12_HOUR`) with `en-US` in `geography.country_locales` and all four zones in `geography.country_time_zones`; the content entry `geography.country.us.name` (`UI_LABEL`, `en-US` body `United States`, taken through the real lifecycle to `PUBLISHED` with five `content.audit_events` rows, exactly like migration 0006); market `la-oc` ("LA & OC", `PLANNED`, `en-US`, `USD`, `America/Los_Angeles`, `effective_from` = migration time) with `en-US` in `geography.market_locales`; three `geography.audit_events` rows (`COUNTRY_CREATED`, `COUNTRY_ACTIVATED`, `MARKET_CREATED`, actor `system:migration`, correlation `seed-0007`). `content.locales.display_name` for `en-US` is back-filled to `English (United States)`. No other market, country or currency is seeded, and no outbox event is emitted. `la-oc` stays `PLANNED` until the owner activates it through the management API.

Events and cache are not stored in this schema: geography events reuse `integration.outbox_events` (aggregate types `geography_country` and `geography_market`, identifiers only); see the store table below for the cache.

## Migrations

| File | Content |
|---|---|
| `0001_infra_baseline.sql` | PostGIS extension (immutable; predates the header rule) |
| `0002_database_foundation.sql` | `schema_migrations`: `version` as primary key, `duration_ms`, naming/consistency constraints |
| `0003_integration_outbox.sql` | `integration` schema and `outbox_events` |
| `0004_configuration_registry.sql` | `btree_gist` extension; `configuration` schema with 10 tables, reference data for the scope hierarchy, immutability/workflow guard triggers |
| `0005_content_registry.sql` | `content` schema with 8 tables, the `en-US` launch locale, guard triggers (immutability, lifecycle state machine, self-approval, `body_sha256` computation), no-overlap exclusion constraint on published versions |
| `0006_content_seed_shell_copy.sql` | seeds 8 shell entries through the lifecycle (data only) |
| `0007_geography_registry.sql` | `content.locales` gains `display_name` (NOT NULL, insert default by trigger) and generated `language`, `script`, `region`; `geography` schema with 8 tables, guard triggers (immutability, one-way PLANNED status, activation rules with share locks, zone deactivation locking the ACTIVE countries that use the zone, immutable link rows, locale deactivation guard on `content.locales`, machine-readable `geography_rule:<KEY>` in every guard error DETAIL), launch seed (USD, four US time zones, US, the country display-name content entry, planned market `la-oc`) |

Latest migration: `0007_geography_registry.sql`. Ownership: application migrations are applied by `pnpm migrate`; `pgboss.*` by pg-boss; Keycloak by Keycloak.

## Intentional denormalization

| Where | What | Why | How drift is prevented |
|---|---|---|---|
| `schema_migrations.version` | derived from `filename` prefix | numeric ordering and a compact primary key | `ck_schema_migrations__filename_matches_version` |
| `outbox_events.event_version` | derived from the `event_type` suffix | the event envelope carries the version explicitly | `ck_outbox_events__version_matches_type` |
| `change_requests.approval_policy` | copy of `parameters.approval_policy` at request time | the policy that governed a request must not change retroactively | immutable after DRAFT (`guard_change_requests`) |
| `value_versions.effective_to` | `effective_to` of a version equals the `effective_from` of its successor | explicit validity makes overlap prevention a database constraint | closed exactly once by the publisher in the same transaction; guarded by trigger and exclusion constraint |
| `parameters.validation_rules`, `value_versions.value`, `snapshots.context` | JSON documents | shape depends on the data type; read back whole, never queried relationally | validated by the service against the definition before insert; object/type checks in the database |
| `content.versions.approval_policy` | copy of `content.entries.approval_policy` at version creation | the policy that governed a version must not change retroactively | trigger `content.guard_versions` requires equality with the entry at insert and forbids change afterwards (entry policy itself is immutable) |
| `content.versions.body_sha256` | derived hash of `body` (SHA-256 hex of the UTF-8 text) | later consent/audit records bind to the exact text without copying it; cheap integrity comparison | computed by the insert trigger (the caller value is ignored); body and hash immutable afterwards |
| `content.snapshot_items.entry_id` | repeats `content.versions.entry_id` | primary key `(snapshot_id, entry_id)` guarantees one version per entry per snapshot | composite foreign key `(version_id, entry_id) -> content.versions (version_id, entry_id)` makes drift impossible |
| `content.versions.effective_from` | proposed start while unpublished, raised once to the publication instant | one column serves "requested start" and "actual start"; avoids a second timestamp and a separate publication table | trigger allows a change only on the `APPROVED -> SCHEDULED/PUBLISHED` transition and only upward; immutable afterwards |
| `content.entry_variables.example_value`, `content.snapshots.context` | JSON documents | shape depends on `var_type` (scalar or `{amount_minor, currency}`), or is an input copy; read back whole, never queried relationally | validated by the service; `ck_snapshots__context_object` in the database. `versions.body` is plain text, not JSON |
| `content.versions.status` SCHEDULED/PUBLISHED/SUPERSEDED | workflow markers, not "is current" flags | the exclusion constraint and the lifecycle need to distinguish published from unpublished rows | which version applies is always derived from the timestamps; resolution never depends on the activation job |
| `geography.market_locales.country_id` | repeats `geography.markets.country_id` | the composite foreign key `(country_id, locale) -> geography.country_locales` is the only way to force every market locale to be supported by the market's country | composite foreign key `fk_market_locales__market_country (market_id, country_id) -> geography.markets (market_id, country_id)` (target `uq_markets__market_country`) makes drift impossible |
| `geography.countries.default_locale` and `geography.markets.default_locale` | a default that is also a member of `country_locales` / `market_locales` | one default per country/market with a database guarantee that it is one of the supported locales | deferred composite foreign keys `fk_countries__default_locale` and `fk_markets__default_locale` (checked at commit); not a copy: the membership row is the fact, the default only selects one |
| `geography.countries.default_currency_code`, `geography.markets.currency_code` | currency code text instead of a surrogate id | the ISO alpha code is the natural, immutable key of `geography.currencies` (`char(3)`); the same convention as money columns elsewhere | foreign keys to `geography.currencies (currency_code)`; the code is immutable by trigger |
| `geography.audit_events.changes` | JSON document `{field: [old, new]}` | its shape depends on the subject (country or market) and the changed fields; read back whole, never queried relationally | object check `ck_audit_events__changes_object`; rows immutable by trigger |
| `geography.audit_events.country_id`, `geography.audit_events.market_id` | two nullable subject foreign keys instead of one polymorphic id | a real foreign key per subject keeps referential integrity | `ck_audit_events__subject` requires exactly the key that matches the action prefix |
| `content.locales.language`, `script`, `region` | derived from `locale` | the service and queries filter by language/region without parsing | generated stored columns (`GENERATED ALWAYS AS ... STORED`); they cannot be written or drift |

## Stores and authority

| Store | Role | Authoritative? |
|---|---|---|
| PostgreSQL | Transactional state, jobs (pg-boss), **committed events (outbox)** | **Yes** |
| Valkey (configuration cache) | Cache and last-known-good copies of resolved configuration | No: PostgreSQL is authoritative; CRITICAL parameters are never cached |
| NATS JetStream | Event transport (stream `BANANAGIG_EVENTS`, 7-day retention, 2-minute duplicate window) | No: events originate from the outbox |
| Valkey (content cache) | Cache and last-known-good copies of resolved (un-rendered) content entries, plus generation counters for invalidation | No: PostgreSQL is authoritative; CRITICAL and LEGAL entries are never cached nor served from last-known-good |
| Valkey (geography cache) | Short-lived cache of public geography reads (keys `bg:{env}:geo:v1:<what>:<gen>`, generation counter `bg:{env}:geo:gen` bumped after commit, default TTL 300 s); management reads bypass it | No: PostgreSQL is authoritative; every cache failure degrades to a database read, and a lost generation bump is bounded by the TTL |
| Valkey | Cache, derived state, rate limits | No (rebuildable, TTL on every key) |
| OpenSearch | Search projection | No (rebuilt from PostgreSQL) |
| SeaweedFS (S3) | Media/blobs | Authoritative for blob bytes; PostgreSQL holds metadata |

## Identity boundary (INF-004: no schema change)

Keycloak (database `keycloak`, infrastructure-owned) owns credentials, protocol sessions and MFA factors. BananaGig will reference identities by the immutable Keycloak `sub` in a future `identity.external_identities` table (unique on provider + subject), created by the first persisted account feature (ID-001) through the Data Model Review Gate. No user or profile table exists and none was needed for INF-004. Web sessions live in Valkey (non-authoritative, TTL on every key). See `docs/engineering/IDENTITY.md`.

## ERD

See `ERD.md`.
