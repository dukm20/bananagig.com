# Entity Relationship Diagram

Application-owned tables only. Update this file in any checkpoint that adds, removes or changes a table or foreign key (`pnpm data-model:check` additionally requires it when a foreign key in the schema snapshot changes).

```mermaid
erDiagram
  SCHEMA_MIGRATIONS {
    integer version PK
    text filename UK
    text checksum
    timestamptz applied_at
    integer duration_ms
  }
  OUTBOX_EVENTS {
    uuid outbox_event_id PK
    text aggregate_type
    text aggregate_id
    text event_type
    integer event_version
    text actor_type
    text actor_id
    jsonb payload_json
    text correlation_id
    text causation_id
    timestamptz created_at
    timestamptz next_attempt_at
    timestamptz published_at
    integer publish_attempts
    text last_error
  }
  SCOPE_LEVELS {
    text scope_type PK
    smallint rank UK
  }
  PARAMETERS {
    uuid parameter_id PK
    text key UK
    text data_type
    jsonb validation_rules
    text sensitivity
    text approval_policy
    text criticality
  }
  PARAMETER_SCOPES {
    uuid parameter_id PK
    text scope_type PK
  }
  PARAMETER_VALUES {
    uuid parameter_value_id PK
    uuid parameter_id FK
    text scope_type FK
    text scope_ref
  }
  VALUE_VERSIONS {
    uuid version_id PK
    uuid parameter_value_id FK
    integer version
    jsonb value
    timestamptz effective_from
    timestamptz effective_to
  }
  CHANGE_REQUESTS {
    uuid change_request_id PK
    uuid parameter_id FK
    text scope_type FK
    text scope_ref
    jsonb proposed_value
    text approval_policy
    text state
    uuid value_version_id FK
  }
  CHANGE_APPROVALS {
    uuid approval_id PK
    uuid change_request_id FK
    text approver
    text decision
  }
  SNAPSHOTS {
    uuid snapshot_id PK
    timestamptz evaluated_at
    jsonb context
  }
  SNAPSHOT_ITEMS {
    uuid snapshot_id PK
    uuid parameter_id PK
    uuid version_id FK
  }
  AUDIT_EVENTS {
    uuid audit_event_id PK
    text action
    uuid parameter_id FK
    uuid change_request_id FK
    uuid old_version_id FK
    uuid new_version_id FK
  }
  PARAMETERS ||--o{ PARAMETER_SCOPES : "allows"
  SCOPE_LEVELS ||--o{ PARAMETER_SCOPES : "level"
  PARAMETER_SCOPES ||--o{ PARAMETER_VALUES : "holds"
  PARAMETER_VALUES ||--o{ VALUE_VERSIONS : "versions"
  PARAMETER_SCOPES ||--o{ CHANGE_REQUESTS : "targets"
  VALUE_VERSIONS |o--o| CHANGE_REQUESTS : "published as"
  CHANGE_REQUESTS ||--o{ CHANGE_APPROVALS : "decided by"
  SNAPSHOTS ||--|{ SNAPSHOT_ITEMS : "contains"
  PARAMETERS ||--o{ SNAPSHOT_ITEMS : "resolved"
  VALUE_VERSIONS ||--o{ SNAPSHOT_ITEMS : "used"
  PARAMETERS ||--o{ AUDIT_EVENTS : "audited"
  CHANGE_REQUESTS |o--o{ AUDIT_EVENTS : "about"
```

`public.schema_migrations` and `integration.outbox_events` have no relationships. `schema_migrations` is migration infrastructure. `outbox_events` is intentionally domain-agnostic: `aggregate_type` and `aggregate_id` point at domain tables by value, never by foreign key.

The `configuration` schema (CFG-001) is a self-contained cluster (its `scope_levels` is also referenced read-only by the `content` schema, see below). `parameter_values.scope_ref` and `change_requests.scope_ref` reference future domain entities (market, category, provider, ...) by opaque value with no foreign key, so the registry does not depend on tables that do not exist yet; the level itself is enforced through `parameter_scopes -> scope_levels`. `audit_events.change_request_id` is nullable (parameter creation has no request). Third-party schemas (`pgboss`, PostGIS) are omitted. Planned domain schemas appear here as their tables are created.

## content schema (CFG-002)

The `content` schema is a second cluster. It shares exactly one table with `configuration`: `configuration.scope_levels` (the single scope hierarchy). Entity names are prefixed `CONTENT_` where they would collide with `configuration` entities in the diagram above.

```mermaid
erDiagram
  SCOPE_LEVELS {
    text scope_type PK
    smallint rank UK
  }
  CONTENT_LOCALES {
    text locale PK
    boolean is_active
    boolean is_platform_default
  }
  CONTENT_ENTRIES {
    uuid entry_id PK
    text key UK
    text content_type
    text owner_role
    text sensitivity
    text criticality
    text approval_policy
    text fallback_policy
    text max_scope_type FK
    boolean is_active
  }
  CONTENT_ENTRY_VARIABLES {
    uuid entry_id PK
    text name PK
    text var_type
    boolean is_required
    jsonb example_value
    text pii_class
  }
  CONTENT_VERSIONS {
    uuid version_id PK
    uuid entry_id FK
    text locale FK
    text scope_type FK
    text scope_ref
    integer version
    text body
    text body_sha256
    text status
    text approval_policy
    timestamptz effective_from
    timestamptz effective_to
  }
  CONTENT_VERSION_APPROVALS {
    uuid approval_id PK
    uuid version_id FK
    text approver
    text decision
  }
  CONTENT_SNAPSHOTS {
    uuid snapshot_id PK
    timestamptz evaluated_at
    text requested_locale
    jsonb context
  }
  CONTENT_SNAPSHOT_ITEMS {
    uuid snapshot_id PK
    uuid entry_id PK
    uuid version_id FK
  }
  CONTENT_AUDIT_EVENTS {
    uuid audit_event_id PK
    text action
    uuid entry_id FK
    text locale
    uuid version_id FK
    uuid previous_version_id FK
  }
  SCOPE_LEVELS ||--o{ CONTENT_ENTRIES : "max scope"
  SCOPE_LEVELS ||--o{ CONTENT_VERSIONS : "scope level"
  CONTENT_ENTRIES ||--o{ CONTENT_ENTRY_VARIABLES : "defines"
  CONTENT_ENTRIES ||--o{ CONTENT_VERSIONS : "has"
  CONTENT_LOCALES ||--o{ CONTENT_VERSIONS : "language of"
  CONTENT_VERSIONS ||--o{ CONTENT_VERSION_APPROVALS : "decided by"
  CONTENT_SNAPSHOTS ||--|{ CONTENT_SNAPSHOT_ITEMS : "contains"
  CONTENT_VERSIONS ||--o{ CONTENT_SNAPSHOT_ITEMS : "used (version_id, entry_id)"
  CONTENT_ENTRIES |o--o{ CONTENT_AUDIT_EVENTS : "audited"
  CONTENT_VERSIONS |o--o{ CONTENT_AUDIT_EVENTS : "about (version_id, entry_id)"
  CONTENT_VERSIONS |o--o{ CONTENT_AUDIT_EVENTS : "previous (previous_version_id, entry_id)"
```

`content.versions.scope_ref` references future domain entities (country, market) by opaque value with no foreign key, as in `configuration`; the level is enforced through `versions.scope_type -> configuration.scope_levels` and bounded by `entries.max_scope_type`. `content.snapshot_items` references versions through the composite key `(version_id, entry_id)`, which is why `entry_id` is repeated there. `content.audit_events.entry_id` is NULL for locale actions and `version_id` is NULL for entry and locale actions; `audit_events` references versions through the composite keys `(version_id, entry_id)` and `(previous_version_id, entry_id)` (so a version can only be named together with its own entry); `audit_events.locale` is a plain value (no foreign key) stored only for locale actions. Legal documents are `LEGAL` entries in this same cluster; future acceptance records (ID-005) will reference `content.versions.version_id`.

## geography schema (GEO-001, GEO-002)

The `geography` schema is a third cluster (GEO-001 reference data; GEO-002 added the address model: `GEO_ADMINISTRATIVE_AREAS`, `GEO_ADDRESS_FORMATS`, `GEO_ADDRESS_FORMAT_FIELDS`, `GEO_ADDRESSES`). It depends on `content` only (foreign keys go geography -> content, never the other way): `content.locales` is the single locale authority, and `content.entries` holds the country display name. Entity names are prefixed `GEO_` throughout (including the referenced content tables, which are the same tables as `CONTENT_LOCALES` and `CONTENT_ENTRIES` above) so that they stay unique across the diagrams in this file.

```mermaid
erDiagram
  GEO_CONTENT_LOCALES {
    text locale PK
    text display_name
    text language "generated"
    text script "generated"
    text region "generated"
    boolean is_active
    boolean is_platform_default
  }
  GEO_CONTENT_ENTRIES {
    uuid entry_id PK
    text key UK
  }
  GEO_CURRENCIES {
    char3 currency_code PK
    char3 numeric_code UK
    smallint minor_unit_digits
    text display_name
    text status
  }
  GEO_TIME_ZONES {
    uuid time_zone_id PK
    text iana_name UK
    text status
  }
  GEO_COUNTRIES {
    uuid country_id PK
    char2 iso_alpha2 UK
    char3 iso_alpha3 UK
    char3 iso_numeric UK
    text display_name_content_key FK
    text status
    text dialing_code
    char3 default_currency_code FK
    text default_locale FK
    text distance_unit
    text first_day_of_week
    text date_format_code
    text time_format_code
  }
  GEO_COUNTRY_LOCALES {
    uuid country_id PK
    text locale PK
  }
  GEO_COUNTRY_TIME_ZONES {
    uuid country_id PK
    uuid time_zone_id PK
  }
  GEO_MARKETS {
    uuid market_id PK
    text code UK
    text name
    uuid country_id FK
    text status
    text default_locale FK
    char3 currency_code FK
    uuid default_time_zone_id FK
    timestamptz effective_from
    timestamptz effective_to
  }
  GEO_MARKET_LOCALES {
    uuid market_id PK
    uuid country_id FK
    text locale PK
  }
  GEO_AUDIT_EVENTS {
    uuid audit_event_id PK
    text action
    uuid country_id FK
    uuid market_id FK
    uuid address_format_id FK
    jsonb changes
  }
  GEO_ADMINISTRATIVE_AREAS {
    uuid administrative_area_id PK
    uuid country_id FK
    text code UK
    text name
    text area_type
    text status
    uuid parent_area_id FK
    integer display_order
  }
  GEO_ADDRESS_FORMATS {
    uuid address_format_id PK
    uuid country_id FK
    integer version UK
    text status
    text display_template
    timestamptz effective_from
    timestamptz effective_to
  }
  GEO_ADDRESS_FORMAT_FIELDS {
    uuid address_format_id PK
    text field_type PK
    smallint display_order UK
    text content_label_key FK
    boolean required
    smallint max_length
    text input_type
    text validation_pattern
    text example_value
    text autocomplete_hint
    text normalization_rule
  }
  GEO_ADDRESSES {
    uuid address_id PK
    uuid country_id FK
    uuid address_format_id FK
    uuid administrative_area_id FK
    text administrative_area_code FK
    text administrative_area_name
    text organization
    text address_line_1
    text address_line_2
    text dependent_locality
    text locality
    text postal_code
    text sorting_code
    geography_point location "geography(Point,4326), single point"
    uuid time_zone_id FK
    text formatted_address "derived, immutable"
    text validation_status
    text validation_source
    text provider_code
    text provider_reference
    jsonb raw_input
  }
  GEO_CONTENT_ENTRIES ||--o{ GEO_COUNTRIES : "display name (display_name_content_key -> key)"
  GEO_CURRENCIES ||--o{ GEO_COUNTRIES : "default currency"
  GEO_CURRENCIES ||--o{ GEO_MARKETS : "market currency"
  GEO_COUNTRIES ||--o{ GEO_COUNTRY_LOCALES : "supports"
  GEO_CONTENT_LOCALES ||--o{ GEO_COUNTRY_LOCALES : "locale"
  GEO_COUNTRY_LOCALES ||--o{ GEO_COUNTRIES : "default locale (country_id, default_locale), deferred"
  GEO_COUNTRIES ||--o{ GEO_COUNTRY_TIME_ZONES : "uses"
  GEO_TIME_ZONES ||--o{ GEO_COUNTRY_TIME_ZONES : "zone"
  GEO_COUNTRIES ||--o{ GEO_MARKETS : "contains"
  GEO_COUNTRY_TIME_ZONES ||--o{ GEO_MARKETS : "default time zone (country_id, default_time_zone_id)"
  GEO_MARKETS ||--o{ GEO_MARKET_LOCALES : "supports (market_id, country_id)"
  GEO_COUNTRY_LOCALES ||--o{ GEO_MARKET_LOCALES : "country supports (country_id, locale)"
  GEO_MARKET_LOCALES ||--o{ GEO_MARKETS : "default locale (market_id, default_locale), deferred"
  GEO_COUNTRIES |o--o{ GEO_AUDIT_EVENTS : "audited"
  GEO_MARKETS |o--o{ GEO_AUDIT_EVENTS : "audited"
  GEO_COUNTRIES ||--o{ GEO_ADMINISTRATIVE_AREAS : "has areas"
  GEO_ADMINISTRATIVE_AREAS |o--o{ GEO_ADMINISTRATIVE_AREAS : "parent (parent_area_id, country_id)"
  GEO_COUNTRIES ||--o{ GEO_ADDRESS_FORMATS : "has format versions"
  GEO_ADDRESS_FORMATS ||--|{ GEO_ADDRESS_FORMAT_FIELDS : "defines fields"
  GEO_CONTENT_ENTRIES ||--o{ GEO_ADDRESS_FORMAT_FIELDS : "label (content_label_key -> key)"
  GEO_COUNTRIES ||--o{ GEO_ADDRESSES : "country"
  GEO_ADDRESS_FORMATS ||--o{ GEO_ADDRESSES : "validated with (address_format_id, country_id)"
  GEO_ADMINISTRATIVE_AREAS |o--o{ GEO_ADDRESSES : "area (administrative_area_id, country_id, administrative_area_code)"
  GEO_TIME_ZONES |o--o{ GEO_ADDRESSES : "geocoded zone"
  GEO_ADDRESS_FORMATS |o--o{ GEO_AUDIT_EVENTS : "drafted and published"
```

`GEO_CONTENT_LOCALES` is `content.locales` (changed in GEO-001: `display_name` plus the generated `language`, `script`, `region`); there is no `geography.locales`. `GEO_CONTENT_ENTRIES` is `content.entries`; only its `key` is referenced (`fk_countries__display_name_content_key`). The two default-locale relationships point from the child to a membership row: a country's default locale must be one of its supported locales and a market's default locale one of the market's supported locales, both checked at commit (deferred composite foreign keys), which is why `GEO_COUNTRIES` and `GEO_MARKETS` appear on the many side of a relationship to their own link tables. `GEO_MARKET_LOCALES.country_id` repeats the market's country so that the composite key `(country_id, locale)` forces every market locale to be supported by the market's country; the key `(market_id, country_id)` to `geography.markets` prevents drift. `GEO_AUDIT_EVENTS` has two nullable subject keys (exactly one is set, `ck_audit_events__subject`) instead of a polymorphic id.

**Address model (GEO-002).** `GEO_ADDRESSES` is the one canonical, immutable structured address; it has NO owner column (customer, provider, booking and business tables will reference `address_id` from their own schemas). Three composite foreign keys carry a repeated value on purpose: `(address_format_id, country_id)` to `GEO_ADDRESS_FORMATS` keeps the format version in the address country (`uq_address_formats__format_country`), `(administrative_area_id, country_id, administrative_area_code)` to `GEO_ADMINISTRATIVE_AREAS` keeps the area in the country and the stored code equal to the area code (`uq_administrative_areas__area_country_code`; all three NULL for a free-text or absent area, MATCH SIMPLE), and `(parent_area_id, country_id)` keeps a parent area in the same country (`uq_administrative_areas__area_country`). `GEO_ADDRESS_FORMATS` is one row per country VERSION; a partial exclusion constraint (`ex_address_formats__no_overlap`, gist) allows at most one `PUBLISHED` format of a country in force at any instant, so the relationship country to formats is 1-N with a no-overlap rule that a diagram cannot show. `GEO_ADDRESS_FORMAT_FIELDS` has a composite key `(address_format_id, field_type)` and a second unique key `(address_format_id, display_order)`; its label points at `content.entries (key)`. `GEO_AUDIT_EVENTS` now has three nullable subject keys (exactly one is set, `ck_audit_events__subject`). `location` is the only PostGIS column in the database; the diagram type name `geography_point` stands for `geography(Point,4326)`. There is no `postal_code_rules` table: the postal rule is the pattern on the `POSTAL_CODE` field row.

`geography` has no foreign key to `integration.outbox_events`: geography events (aggregate types `geography_country`, `geography_market` and `geography_address_format`) point at their aggregate by value, as for every outbox producer. `configuration` and `content` `scope_ref` values for COUNTRY (ISO alpha-2, upper case) and MARKET (market code, lower-case kebab) scopes stay opaque text with no foreign key (DEBT-0024 remains open); they are validated against `geography` by the service layer through a port, not by the database.

## identity schema (ID-001)

The `identity` schema is a fourth cluster and the first application (not registry) schema. It depends on `content` (role display names, the preferred locale) and `geography` (the time zone override) and nothing depends on it yet: foreign keys go identity -> content and identity -> geography, never the other way, and `integration.outbox_events` points at it by value. Entity names are prefixed `ID_` (the referenced tables are the same tables as `GEO_CONTENT_ENTRIES`, `GEO_CONTENT_LOCALES` and `GEO_TIME_ZONES` above).

```mermaid
erDiagram
  ID_CONTENT_ENTRIES {
    uuid entry_id PK
    text key UK
  }
  ID_CONTENT_LOCALES {
    text locale PK
    boolean is_active
  }
  ID_GEO_TIME_ZONES {
    uuid time_zone_id PK
    text iana_name UK
    text status
  }
  ID_ROLES {
    uuid role_id PK
    text code UK
    text name_content_key FK
    text status
    timestamptz created_at
    timestamptz updated_at
  }
  ID_ACCOUNTS {
    uuid account_id PK
    text status
    uuid primary_role_id FK "composite with account_id, nullable"
    timestamptz created_at
    timestamptz updated_at
    timestamptz closed_at
  }
  ID_ACCOUNT_ROLES {
    uuid account_id PK
    uuid role_id PK
    text status
    timestamptz granted_at
    timestamptz activated_at
    timestamptz deactivated_at
    text granted_by
    text grant_source
    timestamptz updated_at
  }
  ID_EXTERNAL_IDENTITIES {
    uuid external_identity_id PK
    uuid account_id FK
    text provider_type UK
    text issuer UK
    text provider_subject UK
    timestamptz created_at
    timestamptz last_seen_at
  }
  ID_ACCOUNT_STATUS_HISTORY {
    uuid status_history_id PK
    bigint history_seq UK "GENERATED ALWAYS AS IDENTITY"
    uuid account_id FK
    text from_status "NULL on the creation row"
    text to_status
    text reason
    text actor
    timestamptz occurred_at
    text correlation_id
  }
  ID_ACCOUNT_PROFILES {
    uuid account_id PK
    text first_name
    text last_name
    text preferred_locale FK
    uuid time_zone_id FK
    timestamptz created_at
    timestamptz updated_at
  }
  ID_ACCOUNT_AUDIT_EVENTS {
    uuid audit_event_id PK
    timestamptz occurred_at
    text actor
    text action
    uuid account_id FK
    uuid role_id FK
    jsonb changes
    text reason
    text correlation_id
  }
  ID_CONTENT_ENTRIES ||--o{ ID_ROLES : "display name (name_content_key -> key)"
  ID_ACCOUNTS ||--o{ ID_ACCOUNT_ROLES : "holds (account_id)"
  ID_ROLES ||--o{ ID_ACCOUNT_ROLES : "granted as (role_id)"
  ID_ACCOUNT_ROLES |o--o| ID_ACCOUNTS : "preferred role (account_id, primary_role_id), optional"
  ID_ACCOUNTS ||--o{ ID_EXTERNAL_IDENTITIES : "linked to (account_id)"
  ID_ACCOUNTS ||--o{ ID_ACCOUNT_STATUS_HISTORY : "status timeline"
  ID_ACCOUNTS ||--o| ID_ACCOUNT_PROFILES : "core profile, one-to-one"
  ID_CONTENT_LOCALES |o--o{ ID_ACCOUNT_PROFILES : "preferred locale"
  ID_GEO_TIME_ZONES |o--o{ ID_ACCOUNT_PROFILES : "time zone override"
  ID_ACCOUNTS ||--o{ ID_ACCOUNT_AUDIT_EVENTS : "audited"
  ID_ROLES |o--o{ ID_ACCOUNT_AUDIT_EVENTS : "ROLE_* actions only"
```

**Account versus external identity.** `ID_ACCOUNTS` carries no Keycloak subject. `ID_EXTERNAL_IDENTITIES` maps `(provider_type, issuer, provider_subject)`, one unique key marked `UK` on the three columns in the diagram, to an account: one login links at most one account, an account may have several links (no unique key on `account_id`). No Keycloak table is referenced, and nothing of credentials, MFA or sessions is mirrored.

**Role membership and the preferred role.** `ID_ACCOUNT_ROLES` has the composite primary key `(account_id, role_id)`: one membership row per account and role, so a login can be a customer and a provider (two rows) but never holds a role twice. The relationship from `ID_ACCOUNT_ROLES` to `ID_ACCOUNTS` runs the other way round on purpose: `accounts.primary_role_id` is the composite foreign key `fk_accounts__primary_role (account_id, primary_role_id)` to `account_roles (account_id, role_id)` (MATCH SIMPLE, so NULL means no preference). The key includes `account_id`, which is why the preference can only name a membership of the SAME account (the account's own id is part of the key, so a membership of another account cannot match), and a trigger adds that the membership is ACTIVE. The two tables reference each other without a deferred key because an account is inserted without a primary role.

**Status current state and history.** `accounts.status` is the current state and `ID_ACCOUNT_STATUS_HISTORY` holds every change (intentional denormalization); the relationship has no database key that carries the equality, so two deferred constraint triggers check it at commit in both directions, each against the CURRENT account status: `trg_accounts__status_history` (on `accounts`) requires the newest history row (highest `history_seq`) to equal `accounts.status`, and `trg_account_status_history__consistent` (on the history table) refuses a stray row, a row whose `from_status` does not continue the previous row's `to_status` (NULL for the first row) and a newest row that differs from the account status.

**Profile, audit, and what is deliberately absent.** `ID_ACCOUNT_PROFILES` is one-to-one with the account (`account_id` is primary key and foreign key) and optional (the row exists once a name was given); there is no `display_name`. `ID_ACCOUNT_AUDIT_EVENTS.role_id` is set only for `ROLE_*` actions (`ck_account_audit_events__role`). There are no contact tables (email and phone: ID-002, ID-003), no address column or table (`geography.addresses` stays ownerless; a saved address will reference `address_id` from its own table with `ON DELETE RESTRICT`), no admin identity table (admin logins have no account, DEBT-0046) and no foreign key to `integration.outbox_events` (identity events, aggregate type `identity_account`, point at their aggregate by value).
