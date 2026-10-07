# Data Model Changelog

Append-only. One entry per schema-changing checkpoint, newest last. Entries must use the template below; `pnpm data-model:check <ID>` verifies it whenever the schema snapshot changes.

```
## <CHECKPOINT>

Migration:
Added:
Changed:
Removed:
Renamed:

Relationships:

Constraints:

Indexes:

Backfill:

Compatibility:

Rollback:

Reason:
```

## INF-001

Migration: db/migrations/0001_infra_baseline.sql
Added: PostGIS extension; `public.schema_migrations` (created by the migration runner)
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: `schema_migrations` primary key on `filename`; `checksum` and `applied_at` NOT NULL

Indexes: primary key index only

Backfill: none

Compatibility: first migration; nothing depends on it yet

Rollback: drop the local database volume (`pnpm stack:reset`); no data exists to preserve

Reason: establish the migration baseline and spatial capability

## INF-002

Migration: none
Added: none
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: none

Indexes: none

Backfill: none

Compatibility: no schema change. The worker now creates the infrastructure queue `infra.ping` inside the pg-boss-owned `pgboss` schema (data, not DDL)

Rollback: not applicable

Reason: application skeleton checkpoint; the schema was reviewed and confirmed unchanged

## INF-003

Migration: db/migrations/0002_database_foundation.sql, db/migrations/0003_integration_outbox.sql
Added: `public.schema_migrations.version`, `public.schema_migrations.duration_ms`; schema `integration`; table `integration.outbox_events`; constraints and indexes listed below
Changed: `public.schema_migrations` primary key moved from `filename` to `version` (constraint renamed `pk_schema_migrations`); `filename` became unique
Removed: constraint `schema_migrations_pkey` (replaced by `pk_schema_migrations`)
Renamed: none

Relationships: none (the outbox is deliberately domain-agnostic with no foreign keys)

Constraints: `schema_migrations`: `pk_schema_migrations`, `uq_schema_migrations__filename`, `ck_schema_migrations__version_positive`, `ck_schema_migrations__filename_matches_version`, `ck_schema_migrations__duration_ms_nonnegative`. `outbox_events`: `pk_outbox_events` plus seven checks (event type format, version positive, version matches type, actor type, payload is object, attempts non-negative, published implies an attempt)

Indexes: `idx_outbox_events__pending` (partial, unpublished rows by due time), `idx_outbox_events__published_at` (partial, retention purge)

Backfill: `schema_migrations.version` parsed from the filename for already-recorded rows; `duration_ms` left NULL for 0001. The outbox starts empty

Compatibility: the migration runner bootstraps `schema_migrations` in its original shape and relies on 0002 to upgrade it, then records version and duration for 0002 onward; databases that only had 0001 upgrade in place

Rollback: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero

Reason: strengthen migration discipline (versioned, timed, uniquely keyed bookkeeping) and provide the transactional outbox required before the first event-producing feature (resolves DEBT-0002)

## INF-004

Migration: none
Added: none
Changed: none
Removed: none
Renamed: none

Relationships: none

Constraints: none

Indexes: none

Backfill: none

Compatibility: no schema change

Rollback: not applicable

Reason: identity infrastructure only (Keycloak realm, token validation, web session in Valkey); the user/profile model and the external identity mapping are deferred to ID-001

## CFG-001

Migration: db/migrations/0004_configuration_registry.sql
Added: extension `btree_gist`; schema `configuration`; tables `scope_levels` (seeded with the 8 canonical scope levels), `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events`; guard functions and triggers (immutability, workflow transitions, no self-approval, parameter identity)
Changed: none
Removed: none
Renamed: none

Relationships: `parameter_scopes -> parameters, scope_levels`; `parameter_values -> parameter_scopes (parameter_id, scope_type)`; `value_versions -> parameter_values`; `change_requests -> parameter_scopes, value_versions`; `change_approvals -> change_requests`; `snapshot_items -> snapshots, parameters, value_versions`; `audit_events -> parameters, change_requests, value_versions`. `scope_ref` deliberately has no foreign key

Constraints: unique key per parameter; typed/enumerated check constraints on data type, sensitivity, approval policy, criticality, state, decision, action; `PLATFORM` takes no scope reference; half-open validity `effective_to > effective_from`; exclusion constraint `ex_value_versions__no_overlap` (gist, per holder); unique `(parameter_value_id, version)`; one decision per approver per request; published states require a version (`ck_change_requests__published_has_version`)

Indexes: `idx_value_versions__holder_effective` (resolution), `idx_change_requests__pending` (partial), `idx_change_requests__scheduled` (partial), `idx_change_requests__parameter` (history), `idx_audit_events__parameter`, `idx_audit_events__change_request` (partial); unique/exclusion constraint indexes

Backfill: none. `scope_levels` is structural reference data seeded by the migration

Compatibility: new schema only; `integration.outbox_events` is reused for the five configuration events

Rollback: forward-fix only; locally rebuild from zero

Reason: central versioned configuration registry required by every later domain (cancellation windows, review windows, Banana unit rules, retry policies) with no hardcoded business values

## CFG-002

Migration: db/migrations/0005_content_registry.sql (schema), db/migrations/0006_content_seed_shell_copy.sql (data only, no DDL: seeds 8 shell entries through the lifecycle)
Added: schema `content`; tables `content.locales` (seeded with the `en-US` active platform default), `content.entries`, `content.entry_variables`, `content.versions`, `content.version_approvals`, `content.snapshots`, `content.snapshot_items`, `content.audit_events`; functions and triggers `content.forbid_mutation` (immutable tables), `content.guard_locales`, `content.guard_entries`, `content.guard_entry_variables`, `content.guard_versions` (immutability, lifecycle state machine, scope bound, policy copy, `body_sha256` computation, one-time period changes), `content.guard_version_approvals` (IN_REVIEW only, no self-approval under SECOND_APPROVER)
Changed: none (`configuration.scope_levels` is referenced read-only)
Removed: none
Renamed: none

Relationships: `content.entries -> configuration.scope_levels (max_scope_type)`; `content.entry_variables -> content.entries`; `content.versions -> content.entries, content.locales, configuration.scope_levels (scope_type)`; `content.version_approvals -> content.versions`; `content.snapshot_items -> content.snapshots, content.versions (version_id, entry_id)`; `content.audit_events -> content.entries, content.versions via the composite keys (version_id, entry_id) and (previous_version_id, entry_id)` (a version named by an audit row must belong to the entry of the same row). `content.versions.scope_ref` deliberately has no foreign key
Constraints: unique entry key; key, content type, owner role, sensitivity, criticality, approval policy, fallback policy and max scope checks; `ck_entries__legal_policy` (LEGAL entries are owned by LEGAL, SECOND_APPROVER, CRITICAL, EXACT); BCP 47 subset check on locales and `ck_locales__default_is_active`; `ck_versions__platform_has_no_ref`, `ck_versions__scope_type`, status, body length 1..200000, `effective_to > effective_from`; `uq_versions__holder_version` (NULLS NOT DISTINCT) and `uq_versions__version_entry` (target of the snapshot composite FK); exclusion constraint `ex_versions__no_overlap` (gist, only SCHEDULED/PUBLISHED/SUPERSEDED rows, per entry, locale, scope); one decision per approver per version; audit action and subject-shape checks (`ck_audit_events__action`; `ck_audit_events__subject`: `locale` is set only for `LOCALE_*` actions, `ENTRY_*` actions name an entry only, `VERSION_*` actions name an entry and one of its versions, `previous_version_id` only on version actions); guard rules in the triggers: `content.guard_locales` refuses any UPDATE that unsets the platform default locale (a migration that moves it disables the guard inside its own transaction), `content.guard_versions` refuses closing `effective_to` in the past (the end may not be earlier than the start of the closing transaction, truncated to milliseconds)
Indexes: `uq_locales__platform_default` (partial unique: at most one default; together with the guard trigger that forbids unsetting it, exactly one exists from the seed onward), `idx_versions__resolution` (partial, published rows), `idx_versions__in_review` (partial), `idx_versions__scheduled` (partial), `idx_versions__entry` (history), `idx_audit_events__entry` (partial), `idx_audit_events__version` (partial); unique and exclusion constraint indexes

Backfill: none. `content.locales` receives one structural reference row (`en-US`, active, platform default); no translations are invented. Migration 0006 inserts 8 shell entries (each with one PUBLISHED `en-US` PLATFORM version and five audit rows: `ENTRY_CREATED`, `VERSION_DRAFTED`, `VERSION_APPROVED`, `VERSION_PUBLISHED`, `VERSION_ACTIVATED`) through the normal lifecycle, so guard triggers and the exclusion constraint apply (data only, no schema change, no outbox events)
Compatibility: new schema only. `integration.outbox_events` is reused for the content events (no change); `configuration.scope_levels` is reused read-only (foreign keys, restrict on delete)
Rollback: forward-fix only; locally rebuild from zero (`pnpm stack:reset`). The schema holds only the seeded launch locale until entries are created, so there is no data to preserve in a fresh environment
Reason: central, versioned, localized, auditable content registry so that user-facing copy (UI text, notifications, help, legal documents) is data with an approval trail and effective dates and never hardcoded strings; legal documents get stricter, immutable, hash-bound versions that future acceptance records (ID-005) can reference exactly

## GEO-001

Migration: db/migrations/0007_geography_registry.sql (one migration: DDL, guard triggers and deterministic launch seed in one transaction)
Added: schema `geography`; tables `geography.currencies`, `geography.time_zones`, `geography.countries`, `geography.country_locales`, `geography.country_time_zones`, `geography.markets`, `geography.market_locales`, `geography.audit_events`; on `content.locales` the columns `display_name` and the generated stored columns `language`, `script`, `region`, the constraint `ck_locales__display_name_not_blank`, the function `content.default_locale_display_name` and trigger `trg_locales__default_display_name`; functions and triggers `geography.forbid_mutation` (`trg_audit_events__immutable`, and the link-row triggers `trg_country_locales__immutable`, `trg_country_time_zones__immutable`, `trg_market_locales__immutable`), `geography.guard_currencies` (`trg_currencies__guard`), `geography.guard_time_zones` (`trg_time_zones__guard`), `geography.guard_countries` (`trg_countries__guard`), `geography.guard_markets` (`trg_markets__guard`), `geography.guard_country_links` (`trg_country_locales__guard`, `trg_country_time_zones__guard`), `geography.guard_locale_deactivation` (`trg_locales__geography_guard` on `content.locales`); seed rows: currency USD, four US time zones, country US (ACTIVE) with its locale and time zone links, content entry `geography.country.us.name`, market `la-oc` (PLANNED) with its locale link, three `geography.audit_events` rows
Changed: `content.locales` (expand step only): `display_name` is NOT NULL (existing row `en-US` back-filled to `English (United States)`; later inserts without a name get the tag itself by trigger) and three generated columns were added, so a small table rewrite of one row. `content.locales` remains the single locale authority; no `geography.locales` table exists. Nothing is renamed, dropped or loosened
Removed: none
Renamed: none

Relationships: `geography.countries -> content.entries (display_name_content_key -> key)`, `geography.countries -> geography.currencies (default_currency_code)`, `geography.countries -> geography.country_locales (country_id, default_locale)` (DEFERRABLE INITIALLY DEFERRED); `geography.country_locales -> geography.countries, content.locales`; `geography.country_time_zones -> geography.countries, geography.time_zones`; `geography.markets -> geography.countries, geography.currencies, geography.country_time_zones (country_id, default_time_zone_id)`, `geography.markets -> geography.market_locales (market_id, default_locale)` (DEFERRABLE INITIALLY DEFERRED); `geography.market_locales -> geography.markets (market_id, country_id)`, `geography.market_locales -> geography.country_locales (country_id, locale)`; `geography.audit_events -> geography.countries (country_id), geography.markets (market_id)`. All foreign keys are ON DELETE RESTRICT (the two deferred default-locale keys use the default NO ACTION); rows are never deleted. Dependency direction between schemas is geography -> content only; `integration.outbox_events` is reused for geography events by value (aggregate types `geography_country` and `geography_market`), no foreign key

Constraints: unique ISO alpha-2, alpha-3 and numeric codes (`uq_countries__iso_alpha2`, `uq_countries__iso_alpha3`, `uq_countries__iso_numeric`), unique currency numeric code (`uq_currencies__numeric_code`, primary key is the alpha code), unique `uq_time_zones__iana_name`, unique market code (`uq_markets__code`) and `uq_markets__market_country (market_id, country_id)` (target of the market_locales composite foreign key); format checks for every code (`ck_currencies__currency_code_format`, `__numeric_code_format`, `ck_countries__iso_alpha2_format`, `__iso_alpha3_format`, `__iso_numeric_format`, `__content_key_format`, `__dialing_code_format`, `ck_time_zones__iana_name_format`, `ck_markets__code_format`); `ck_currencies__minor_unit_digits` (0..4), `ck_currencies__symbol_length`; status checks on currencies, time zones, countries and markets (`PLANNED, ACTIVE, INACTIVE`); format settings as enum checks (`ck_countries__distance_unit`, `__first_day_of_week`, `__date_format_code`, `__time_format_code`); not-blank checks (`ck_currencies__display_name_not_blank`, `ck_markets__name_not_blank` (the market name is also limited to 120 characters), `ck_locales__display_name_not_blank`); half-open window `ck_markets__effective_range (effective_to IS NULL OR effective_to > effective_from)`; audit `ck_audit_events__action`, `ck_audit_events__subject` (COUNTRY_* actions name exactly a country, MARKET_* actions exactly a market) and `ck_audit_events__changes_object`; deferred composite foreign keys `fk_countries__default_locale` and `fk_markets__default_locale`; trigger-enforced rules: activation prerequisites (country: ACTIVE default currency, ACTIVE default locale in `content.locales`, at least one ACTIVE time zone, so it is created PLANNED, linked, then activated; market: ACTIVE country, currency, default time zone and default locale), a status machine (PLANNED is the initial status only: an UPDATE back to PLANNED is refused on currencies, time zones, countries and markets; every other transition between PLANNED, ACTIVE and INACTIVE is allowed subject to the activation and deactivation rules), deactivation refused while an ACTIVE country or market depends on a currency, time zone, locale (only when it is their default) or country, deletion refused on currencies, time zones, countries and markets, identity immutability (currency code, numeric code and minor unit digits; ISO codes; time zone id and name; market code and country), a NEW IANA name must exist in `pg_timezone_names` and must not be a `posix/` or `right/` alias (checked on insert only; a registered name skips the scan), immutable link rows (`country_locales`, `country_time_zones` and `market_locales` are never updated, only inserted or deleted), removal of locale or time zone links of an ACTIVE country refused (the country row is share-locked first), audit rows immutable. Activation checks lock the dependency rows they read with `FOR SHARE` (country: default currency, default locale and, on activation only, the ACTIVE time zone rows it relies on; market: country, currency, default time zone and default locale), so a concurrent deactivation, which needs the row lock, serializes with them and exactly one wins; deactivating a time zone locks the ACTIVE countries that use it (`FOR UPDATE`, `country_id` order) before the sibling-zone check, so two deactivations of two zones of one country cannot both pass. Every guard error carries `geography_rule:<KEY>` in its DETAIL (15 keys; see `DATA_MODEL.md`) so classification never depends on message text (see `NORMALIZATION_LOG.md` GEO-001, concurrency)
Indexes: `idx_countries__active (iso_alpha2) WHERE status = 'ACTIVE'` (public active-country list), `idx_markets__active (country_id, code) WHERE status = 'ACTIVE'` (active markets by country and the country deactivation guard), `idx_audit_events__country (country_id, occurred_at DESC) WHERE country_id IS NOT NULL`, `idx_audit_events__market (market_id, occurred_at DESC) WHERE market_id IS NOT NULL`; plus the primary key and unique constraint indexes. No other foreign key is separately indexed (tiny, rarely changing reference tables; see `NORMALIZATION_LOG.md`)

Backfill: `content.locales.display_name` is set to `English (United States)` for `en-US` and to the tag itself for any other existing row (none exist) before the NOT NULL is applied; `language`, `script`, `region` are generated, so they are computed for existing rows. Seeds (data, deterministic, no business values): USD; four time zones; US created PLANNED, linked, then activated through the guard; the content entry `geography.country.us.name` taken through the real lifecycle (DRAFT, APPROVED, PUBLISHED, five `content.audit_events` rows, no trigger disabled); market `la-oc` PLANNED; three `geography.audit_events` rows. No outbox events are produced
Compatibility: additive. Existing content code keeps working: `display_name` is filled for inserts that omit it, the new columns are read-only, and the generated columns are derived from `locale`. `content.entries` and `content.versions` are untouched apart from one new entry row and its version. The new `trg_locales__geography_guard` on `content.locales` only refuses a deactivation that would break an ACTIVE country or market, so deactivating an unused locale behaves as before (the content package does not import geography; a market default locale reaches it through a port). `configuration` and `content` `scope_ref` values for COUNTRY and MARKET scopes are still opaque text without a foreign key (DEBT-0024 stays open); the service validates them against `geography` instead. `integration.outbox_events` is reused unchanged
Rollback: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero with `pnpm stack:reset`. Reference rows are never deleted (deactivate instead), so there is nothing to restore; the expand step on `content.locales` is not reversed by dropping columns once any code reads them
Reason: country, currency, time zone and market are platform reference data that every later checkpoint (address, tax, payment, catalog, booking) depends on; they are data-driven rows with activation guarded by the database instead of hardcoded lists, with `content.locales` kept as the one locale authority and market default locale feeding the content fallback chain

## GEO-002

Migration: db/migrations/0008_address_model.sql (one migration: DDL, guard triggers, the additive change to `geography.audit_events` and deterministic seeds in one transaction)
Added: tables `geography.administrative_areas`, `geography.address_formats`, `geography.address_format_fields`, `geography.addresses` (the first `geography(Point,4326)` column in the database: `addresses.location`); on `geography.audit_events` the column `address_format_id`, the foreign key `fk_audit_events__address_format_id` and the partial index `idx_audit_events__address_format`; functions and triggers `geography.guard_administrative_areas` (`trg_administrative_areas__guard`), `geography.guard_address_formats` (`trg_address_formats__guard`), `geography.guard_address_format_fields` (`trg_address_format_fields__guard`), `geography.guard_addresses` (`trg_addresses__guard`); nine new `geography_rule:<KEY>` values (`FORMAT_NOT_DRAFT`, `FORMAT_MUST_START_AS_DRAFT`, `FORMAT_STATUS_TRANSITION`, `FORMAT_IMMUTABLE`, `FORMAT_INCOMPLETE`, `FORMAT_TEMPLATE_MISMATCH`, `LOOKUP_WITHOUT_AREAS`, `FORMAT_NOT_PUBLISHED`, `AREA_NOT_ACTIVE`); seed rows: 51 US administrative areas, US address format version 1 (created `DRAFT`, five fields, published through the guard), 12 content entries (five address field labels, seven validation messages) with 14 published versions, two `geography.audit_events` rows (`ADDRESS_FORMAT_DRAFTED`, `ADDRESS_FORMAT_PUBLISHED`) and 68 `content.audit_events` rows
Changed: `geography.audit_events` (expand step only): `ck_audit_events__action` is dropped and re-created WIDER (adds `COUNTRY_ADMINISTRATIVE_AREAS_UPDATED`, `ADDRESS_FORMAT_DRAFTED`, `ADDRESS_FORMAT_PUBLISHED`) and `ck_audit_events__subject` is dropped and re-created with a third branch (`ADDRESS_FORMAT_%` names exactly an address format) while the two existing branches additionally require `address_format_id IS NULL`; every existing row still satisfies both, no row is rewritten, the append-only trigger is not involved. Nothing is renamed, dropped or loosened
Removed: none
Renamed: none

Relationships: `geography.administrative_areas -> geography.countries (country_id)`, `geography.administrative_areas -> geography.administrative_areas (parent_area_id, country_id)` (self-reference, same country); `geography.address_formats -> geography.countries (country_id)`; `geography.address_format_fields -> geography.address_formats (address_format_id)`, `geography.address_format_fields -> content.entries (content_label_key -> key)`; `geography.addresses -> geography.countries (country_id)`, `geography.addresses -> geography.address_formats (address_format_id, country_id)` (the exact format VERSION, in the address country), `geography.addresses -> geography.administrative_areas (administrative_area_id, country_id, administrative_area_code)` (MATCH SIMPLE: all NULL for a free-text or absent area), `geography.addresses -> geography.time_zones (time_zone_id)`; `geography.audit_events -> geography.address_formats (address_format_id)`. All foreign keys are ON DELETE RESTRICT; rows are never deleted by the application. Dependency direction between schemas stays geography -> content only; `integration.outbox_events` is reused for the two new events by value (aggregate types `geography_address_format` and `geography_country`), no foreign key. No owner column exists on `geography.addresses`: customers, providers, bookings and businesses will reference `address_id` from their own schemas

Constraints: unique `uq_administrative_areas__country_code (country_id, code)`, `uq_administrative_areas__area_country (administrative_area_id, country_id)` (target of the parent key) and `uq_administrative_areas__area_country_code (administrative_area_id, country_id, code)` (target of the address area key); unique `uq_address_formats__country_version (country_id, version)` and `uq_address_formats__format_country (address_format_id, country_id)` (target of the address format key); `uq_address_format_fields__format_order (address_format_id, display_order)`; exclusion constraint `ex_address_formats__no_overlap` (gist, `country_id` equality plus `tstzrange(effective_from, effective_to, '[)')` overlap, only `PUBLISHED` rows); format checks on area code (`ck_administrative_areas__code_format`), name (`__name_not_blank`, at most 120 characters), type, status, display order and `__not_own_parent`; address format `ck_address_formats__version`, `__status` (`DRAFT`, `PUBLISHED`), `__template` (1 to 500 characters, no control characters except the newline), `__effective_range`, `__draft_is_open`; field checks for field type, display order 1..20, label key format, maximum length 1..200, input type, `ck_address_format_fields__lookup_only_for_area`, `__lookup_has_no_pattern`, pattern length, example, autocomplete hint and normalization rule; address checks `ck_addresses__area_consistent`, `__text_values` (every part not blank and at most 200 characters), `__formatted_address` (at most 1500), `__validation_status`, `__validation_source`, `__located_status_has_location`, `__manual_is_not_located`, `__autocomplete_is_not_verified`, `__verified_source`, `__provider`, `__provider_code_format`, `__provider_reference`, `__raw_input` (JSON object, at most 4000 characters); trigger-enforced rules: area identity immutable and areas never deleted; address format identity, version and template immutable, a one-way `DRAFT -> PUBLISHED` lifecycle, a published format immutable except the one-time closure of its open end, completeness and template/field agreement and the LOOKUP prerequisite checked at publication, formats never deleted; field rows insert-only and only while their format is `DRAFT` (the format row is share-locked); address rows never updated, requiring a `PUBLISHED` format, an `ACTIVE` area and an `ACTIVE` time zone at insert (each share-locked); audit `ck_audit_events__action` and `ck_audit_events__subject` widened as described. Every guard error carries `geography_rule:<KEY>` in its DETAIL (24 keys in total; see `DATA_MODEL.md`)
Indexes: `idx_audit_events__address_format (address_format_id, occurred_at DESC) WHERE address_format_id IS NOT NULL` (audit trail of one format, newest first; also serves the foreign key); plus the primary key, unique constraint and exclusion constraint (gist) indexes listed above. No other index: no foreign key of `geography.addresses` is separately indexed and there is no GiST index on `location` (nothing filters by those columns yet; the first spatial query adds the index through its own review, see `NORMALIZATION_LOG.md` GEO-002)

Backfill: none; every table is new. Seeds (data, deterministic, no business values, no personal data): the 12 address content entries taken through the real content lifecycle (DRAFT, APPROVED, PUBLISHED, no trigger disabled); 51 US administrative areas; US address format version 1 created `DRAFT`, given its fields, then published through the guard so the completeness, template and LOOKUP rules ran; two `geography.audit_events` rows. No outbox events are produced and no address row is created
Compatibility: additive. `geography.audit_events` keeps every existing row and code path (the two CHECKs only accept more values and the new column is nullable and defaults to NULL for existing inserts). No existing table, column or constraint is removed or loosened beyond the audit CHECK widening. `content.entries` and `content.versions` receive 12 new entries and 14 versions only. The cache gains the key `address:<CC>` under the existing generation key, bumped by format publication, area changes and every `GeographyService` write. `integration.outbox_events` is reused unchanged
Rollback: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero with `pnpm stack:reset`. Formats, fields and addresses are never updated after publication or insert (a change is a new version or a new address row) and reference rows are never deleted, so there is nothing to restore; the audit widening is not narrowed back once rows with the new actions exist
Reason: every later checkpoint that stores a place (customer and provider profiles, service areas, search, booking, tax, messaging) needs ONE structured, country-aware address instead of per-domain variants and hardcoded country rules; the format is data (versioned and effective-dated, labels and messages as managed content), the stored address is immutable so it doubles as the booking snapshot, and the location is a single PostGIS point

## ID-001

Migration: db/migrations/0009_identity_accounts.sql (one migration: DDL, guard triggers, the two deferred constraint triggers and deterministic seeds in one transaction)
Added: schema `identity`; tables `identity.roles`, `identity.accounts`, `identity.account_roles`, `identity.external_identities`, `identity.account_status_history`, `identity.account_profiles`, `identity.account_audit_events`; functions and triggers `identity.forbid_mutation` (`trg_account_status_history__immutable`, `trg_account_audit_events__immutable`), `identity.guard_roles` (`trg_roles__guard`), `identity.guard_accounts` (`trg_accounts__guard`), `identity.check_status_history` (the DEFERRABLE INITIALLY DEFERRED constraint trigger `trg_accounts__status_history`, `AFTER INSERT OR UPDATE OF status` on `accounts`) and `identity.check_status_history_row` (the DEFERRABLE INITIALLY DEFERRED constraint trigger `trg_account_status_history__consistent`, `AFTER INSERT` on `account_status_history`), `identity.guard_account_roles` (`trg_account_roles__guard`), `identity.guard_external_identities` (`trg_external_identities__guard`), `identity.guard_account_profiles` (`trg_account_profiles__guard`); thirteen `identity_rule:<KEY>` values (`NOT_DELETABLE`, `ROW_IMMUTABLE`, `IMMUTABLE_IDENTITY`, `ACCOUNT_INITIAL_STATE`, `ACCOUNT_STATUS_TRANSITION`, `ACCOUNT_CLOSED`, `ACCOUNT_HAS_ACTIVE_ROLES`, `ROLE_NOT_ACTIVE`, `ROLE_IN_USE`, `ROLE_STATUS_TRANSITION`, `PRIMARY_ROLE_NOT_ACTIVE`, `PRIMARY_ROLE_IN_USE`, `STATUS_HISTORY_MISMATCH`); seed rows: roles `CUSTOMER` and `PROVIDER` and 17 content entries (two role names, five account status labels, five session account labels and messages, five account name and state messages) with 17 published `en-US` versions and 85 `content.audit_events` rows. No account, membership, external identity, profile, history or audit row is seeded
Changed: none (`content.entries`, `content.locales` and `geography.time_zones` are referenced read-only; `content.entries` receives 17 new entries and `content.versions` 17 new versions through the real lifecycle)
Removed: none
Renamed: none

Relationships: `identity.roles -> content.entries (name_content_key -> key)`; `identity.account_roles -> identity.accounts (account_id), identity.roles (role_id)`; `identity.accounts -> identity.account_roles (account_id, primary_role_id)` (composite, MATCH SIMPLE: NULL means no primary role; the preferred role can only name a membership of the SAME account; the two tables reference each other without a deferred key because an account starts without a primary role); `identity.external_identities -> identity.accounts (account_id)`; `identity.account_status_history -> identity.accounts (account_id)`; `identity.account_profiles -> identity.accounts (account_id), content.locales (preferred_locale -> locale), geography.time_zones (time_zone_id)`; `identity.account_audit_events -> identity.accounts (account_id), identity.roles (role_id)`. All foreign keys are ON DELETE RESTRICT and no row is ever deleted. Dependency direction between schemas: identity -> content and identity -> geography only (neither references identity). `integration.outbox_events` is reused for the five identity events by value (aggregate type `identity_account`), no foreign key. The Keycloak subject is not a column of `identity.accounts` and nothing references a Keycloak table

Constraints: unique `uq_roles__code`; unique `uq_external_identities__provider_issuer_subject (provider_type, issuer, provider_subject)` (one login links at most one account; the lookup of every authenticated request); primary key `pk_account_roles (account_id, role_id)` (an account holds a role at most once: the rule "no duplicate active membership"); unique `uq_account_status_history__seq (history_seq)` over the identity column; format and vocabulary checks `ck_roles__code_format` (upper-case code), `ck_roles__name_content_key_format`, `ck_roles__status` (`ACTIVE`, `INACTIVE`), `ck_accounts__status` (`PENDING`, `ACTIVE`, `SUSPENDED`, `CLOSURE_REQUESTED`, `CLOSED`), `ck_account_roles__status` (`PENDING`, `ACTIVE`, `INACTIVE`), `ck_account_roles__grant_source` (`BOOTSTRAP`, `SIGNUP`, `ADMIN`, `SYSTEM`), `ck_external_identities__provider_type` (`KEYCLOAK`), `ck_account_audit_events__action` (seven actions); cross-column checks `ck_accounts__closed_at` (`closed_at` is set exactly when the status is `CLOSED`), `ck_account_roles__lifecycle` (`PENDING` has neither timestamp, `ACTIVE` has `activated_at` and no `deactivated_at`, `INACTIVE` has `deactivated_at`), `ck_account_status_history__changed` (`from_status` differs from `to_status`), `ck_account_audit_events__role` (`role_id` is set exactly for `ROLE_*` actions), `ck_account_audit_events__changes_object` (JSON object); value checks `ck_account_roles__granted_by`, `ck_account_status_history__actor` and `ck_account_audit_events__actor` (not blank, at most 200 characters), `ck_account_status_history__reason` (not blank, at most 1000), `ck_external_identities__issuer` (not blank, at most 512, no control characters), `ck_external_identities__subject` (not blank, at most 255, no control characters), `ck_account_profiles__first_name` and `__last_name` (1 to 50 characters, no leading or trailing whitespace, no control characters and no bidirectional-override characters). Trigger-enforced rules: immutable history and audit rows; role identity immutable and a role cannot be deactivated while an account holds it; the account status machine with `CLOSED` terminal, accounts inserted `PENDING` or `ACTIVE` without a primary role, closing only without PENDING or ACTIVE memberships and without a primary role; the membership status machine (a row starts `PENDING` or `ACTIVE`; `INACTIVE` never goes back to `PENDING`), an ACTIVE role required to grant or activate, and no role for a closed account; the primary role must be an ACTIVE membership of the same account and an ACTIVE membership cannot leave ACTIVE while it is the primary role; external identities and profiles immutable except `last_seen_at` and the profile values, and neither accepts a write for a closed account; every row of every table undeletable; and the two deferred checks that keep the status history and the account consistent in both directions at commit (both read the CURRENT account status at commit: the newest history row equals `accounts.status`, and every history row continues the previous one, `from_status` equal to the previous `to_status`, NULL for the first row, so a stray row is refused and a transaction may pass through a transient status). Every guard error carries `identity_rule:<KEY>` in its DETAIL (SQLSTATE `23000`; see `DATA_MODEL.md`)
Indexes: `idx_account_status_history__account (account_id, history_seq DESC)` (the status timeline of one account, newest first, and the newest-row and previous-row lookups of the two deferred consistency checks) and `idx_account_audit_events__account (account_id, occurred_at DESC)` (the audit timeline of one account); plus the primary key and unique constraint indexes (`uq_external_identities__provider_issuer_subject` is the hot lookup, `pk_account_roles` serves the membership list of one account and is the composite foreign key target). Foreign keys deliberately without an index: `external_identities.account_id`, `account_roles.role_id`, `accounts.primary_role_id` (covered by `pk_accounts`, whose key `account_id` is unique), `roles.name_content_key`, `account_profiles.preferred_locale`, `account_profiles.time_zone_id`, `account_audit_events.role_id` (never-deleted reference targets, no filtered query; see `NORMALIZATION_LOG.md`)

Backfill: none; every table is new and no account is seeded (an account appears on the first authenticated request of a person, created from the verified Keycloak identity). Seeds (data, deterministic, no business values, no personal data): the two roles and the 17 content entries through the real content lifecycle (DRAFT, APPROVED, PUBLISHED, no trigger disabled). No outbox events are produced by the migration
Compatibility: additive. New schema only; existing tables, columns and constraints are untouched. `integration.outbox_events` is reused unchanged; `content` receives 17 entries and versions only. The web session record in Valkey is unchanged by the schema (the chosen active role is session state, never a column). No cache is added
Rollback: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero with `pnpm stack:reset`. Accounts, memberships, external identities, history and audit rows are never deleted (a status change or a new row replaces deletion) and reference rows are never deleted, so there is nothing to restore
Reason: the first persisted account feature. Keycloak authenticates; the platform needs its own account to hang roles, status, a core profile and, later, contact data, consents, addresses and business data on, linked to the login by the immutable issuer and subject. The model separates the account from the external identity, keeps roles as reference data with one membership row per account and role (one login may be customer and provider at once), persists only a preferred role (the active role is request context), and records every status change in an immutable history that the database itself keeps equal to the current state
