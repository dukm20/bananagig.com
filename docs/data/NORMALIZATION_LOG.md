# Normalization Log

Append one entry per schema-changing checkpoint (and per review checkpoint that confirms no change). `pnpm data-model:check <ID>` verifies the entry when the schema snapshot changes. Findings are recorded even when the answer is PASS.

Template:

```
## <CHECKPOINT>

Tables reviewed:

### 1NF
### 2NF
### 3NF
### BCNF
### Duplicate concepts examined
### Derived fields examined
### Intentional denormalization
### Index review
### Final decision
```

Every review also covers: ownership of each table, FK cardinality, uniqueness, check constraints, nullability, immutable historical state, configuration vs schema, concurrency, and retention (see `DATA_MODEL_GUARDRAILS.md`).

## INF-002

Tables reviewed: `public.schema_migrations` (the only application-owned table). `pgboss.*` and PostGIS objects are third-party designs and out of scope.

### 1NF
PASS. All columns are atomic scalars; no repeating groups or arrays.

### 2NF
PASS. The key is a single column (`filename`), so partial dependencies are impossible.

### 3NF
PASS. `checksum` and `applied_at` depend only on `filename`; no non-key attribute determines another.

### BCNF
PASS. The only determinant is the primary key.

### Duplicate concepts examined
None. Migration bookkeeping exists only here; pg-boss keeps its own job state in its own schema.

### Derived fields examined
None. `applied_at` is an event timestamp, not derived.

### Intentional denormalization
None.

### Index review
Primary key index only; the table is tiny and read by full scan.

### Final decision
No schema change. Product tables will use per-domain PostgreSQL schemas (see `DATA_MODEL.md`, ADR-0008). No schemas created yet because no feature needs one.

## INF-003

Tables reviewed: `public.schema_migrations` (changed), `integration.outbox_events` (new). `pgboss.*` and PostGIS objects are third-party and out of scope.

### 1NF
PASS. All columns are atomic scalars. `payload_json` is a single opaque document by design (the event body), not a repeating group standing in for a relation; nothing in it is queried relationally by the outbox.

### 2NF
PASS. Both tables have single-column keys (`version`, `outbox_event_id`), so partial dependencies are impossible.

### 3NF
PASS with two documented, constraint-enforced derivations. Every non-key attribute depends on the key and nothing else, except: `schema_migrations.version` is derivable from `filename`, and `outbox_events.event_version` is derivable from `event_type`. Both are kept deliberately (see Intentional denormalization).

### BCNF
PASS. `schema_migrations` has two candidate keys (`version`, `filename`) that determine each other and every other attribute; each determinant is a candidate key. `outbox_events` has one candidate key.

### Duplicate concepts examined
Event version appears in both `event_type` and `event_version` (see below). The outbox does not duplicate pg-boss job state: jobs live in `pgboss`, committed domain events in the outbox. Migration bookkeeping exists only in `schema_migrations`. Actor data is stored as two columns because the event envelope carries it; there is no users table yet to reference.

### Derived fields examined
`event_version` and `schema_migrations.version`: derived, immutable once written, consistency guaranteed by CHECK constraints (`ck_outbox_events__version_matches_type`, `ck_schema_migrations__filename_matches_version`). Mutable relay state (`next_attempt_at`, `published_at`, `publish_attempts`, `last_error`) is not derived from other columns: it is the relay's own state and lives on the row it describes. No stored totals or aggregates.

### Intentional denormalization
1. `schema_migrations.version` (from `filename`): numeric primary key and ordering; drift prevented by check.
2. `outbox_events.event_version` (from `event_type`): the envelope exposes the version explicitly and relay queries need no string parsing; drift prevented by check.

### Index review
`pk_schema_migrations`, `uq_schema_migrations__filename` (tiny table). `pk_outbox_events` plus two partial indexes: `idx_outbox_events__pending (next_attempt_at, created_at) WHERE published_at IS NULL` serves the relay claim query and stays small because published rows leave it; `idx_outbox_events__published_at WHERE published_at IS NOT NULL` serves retention purge. No foreign keys, so no foreign-key indexes are needed. No speculative indexes.

### Final decision
Schema accepted. Ownership: both tables are application-owned (`public` bookkeeping, `integration`). Nullability reviewed (only genuinely optional columns are nullable). Immutable historical state: all columns except the relay's four state columns are write-once; published rows are retained for `OUTBOX_RETENTION_DAYS` (default 7) then purged by the worker under an advisory lock. Concurrency: relay claims with `FOR UPDATE SKIP LOCKED` plus a lease so no lock is held during publishing; duplicate publishes are absorbed by JetStream (`Nats-Msg-Id`) and consumers dedupe by `eventId`. Configuration vs schema: no business values in the schema. Idempotency records deferred (DEBT-0013).

## INF-004

Tables reviewed: none changed. Application-owned tables remain `public.schema_migrations` and `integration.outbox_events` (reviewed in INF-003).

### 1NF
PASS (unchanged). No new columns or tables.

### 2NF
PASS (unchanged).

### 3NF
PASS (unchanged).

### BCNF
PASS (unchanged).

### Duplicate concepts examined
Identity data: credentials, sessions and MFA factors stay in Keycloak (its own database); profile data will live in the BananaGig schema keyed by the Keycloak `sub`. Nothing was duplicated between them, and no user table was created.

### Derived fields examined
None added. Web session records are cached in Valkey (non-authoritative, TTL), not stored in PostgreSQL.

### Intentional denormalization
None.

### Index review
No change.

### Final decision
No schema change; `pnpm data-model:check INF-004` confirms an unchanged snapshot. The future `identity.external_identities` design (unique provider + subject) is documented in `docs/engineering/IDENTITY.md` and will go through the full gate with ID-001.


## CFG-001

Tables reviewed: all new, in schema `configuration`: `scope_levels`, `parameters`, `parameter_scopes`, `parameter_values`, `value_versions`, `change_requests`, `change_approvals`, `snapshots`, `snapshot_items`, `audit_events`. Reused: `integration.outbox_events` (five new event types; no change).

### 1NF
PASS. Every column is an atomic scalar except three deliberate JSON documents (see intentional denormalization): `parameters.validation_rules`, `value_versions.value` / `change_requests.proposed_value`, `snapshots.context`. None is a repeating group; each is a single typed document read back whole. The allowed scope levels of a parameter are NOT an array on `parameters`; they are rows in `parameter_scopes`.

### 2NF
PASS. Composite keys: `parameter_scopes (parameter_id, scope_type)` has no non-key columns; `snapshot_items (snapshot_id, parameter_id)` has only `version_id`, which depends on the whole key. Every other table has a single-column surrogate key.

### 3NF
PASS. No transitive dependencies. Value history is separate from the holder (`parameter_values` -> `value_versions`) so scope identity is not repeated per version. Parameter definition attributes (type, sensitivity, criticality) live only on `parameters`; they are not repeated on values or versions. The scope rank lives only on `scope_levels`; the resolver joins it instead of copying it onto values.

### BCNF
PASS. Every determinant is a candidate key. Candidate keys checked: `parameters.key`; `scope_levels.rank`; `parameter_values (parameter_id, scope_type, scope_ref)` (NULLS NOT DISTINCT); `value_versions (parameter_value_id, version)` and the no-overlap period per holder; `change_requests.value_version_id`; `change_approvals (change_request_id, approver)`.

### Duplicate concepts examined
- Default value vs PLATFORM value: a `default_value` column on `parameters` would duplicate the PLATFORM-scope value and drift. Omitted; the PLATFORM version is the default.
- Allowed scope levels vs existing values: `parameter_scopes` is the single source for what is allowed; values and change requests reference it through a composite foreign key rather than re-validating in code only.
- Current value vs history: no "current value" column exists anywhere. Current is derived from effective dates at resolution time, so it cannot go stale.
- Snapshot copy vs pointer: items point at immutable versions instead of copying values.
- Audit vs change request history: `audit_events` records actions (who/when/which version), while `change_requests` and `change_approvals` hold request content and decisions; values are not copied into audit.

### Derived fields examined
- Active/scheduled status of a version: derived from `effective_from/effective_to` and `now()`, not stored.
- `change_requests.state` ACTIVE/SUPERSEDED is a workflow marker moved by the activation job and by supersession; resolution never depends on it (the resolver uses timestamps only), so a delayed job cannot produce a wrong value.
- `value_versions.effective_to` of a predecessor equals the `effective_from` of its successor. This is stored (see below).

### Intentional denormalization
1. `change_requests.approval_policy`: copy of `parameters.approval_policy` at request time. The policy that governed a request must not change retroactively when the parameter is edited. Frozen after DRAFT by trigger.
2. `value_versions.effective_to`: derivable from the successor's `effective_from`. Stored so a database exclusion constraint (`ex_value_versions__no_overlap`, gist) can make overlapping validity impossible. Closed exactly once, by the publisher in the same transaction as the successor insert; trigger-guarded; verified by tests.
3. JSON columns `validation_rules`, `value`/`proposed_value`, `context`: the shape depends on `data_type` or is an input copy; never queried relationally; validated by the service against the definition before insert, object-type checked in the database.
4. `parameter_values.scope_ref` / `change_requests.scope_ref` have no foreign key: the referenced entities (markets, categories, providers) do not exist yet and the registry must not depend on domain tables. The scope LEVEL is enforced by foreign key; the existence of the referenced entity is validated by the owning domain when it exists (DEBT-0024).
5. `change_requests.scope_type/scope_ref` repeat the holder identity: the holder does not exist until publish, so the request must carry the target itself.

### Index review
Primary and unique keys cover identity lookups and the foreign key from `parameter_scopes`. Added: `idx_value_versions__holder_effective (parameter_value_id, effective_from DESC)` for resolution (candidate versions by time; the resolver runs 3 queries per batch); partial `idx_change_requests__pending` and `idx_change_requests__scheduled` (small, serve the approver queue and the activation job); `idx_change_requests__parameter (parameter_id, created_at DESC)` for history; `idx_audit_events__parameter (parameter_id, occurred_at DESC)` and partial `idx_audit_events__change_request`. The exclusion constraint adds a gist index used for overlap checks. Foreign-key indexes: `parameter_values`/`change_requests` are covered by the composite keys and `uq_parameter_values__parameter_scope_ref`; `change_approvals` by `uq_change_approvals__request_approver`; `snapshot_items` by its primary key (snapshot) and the immutable version pointer (low volume, no reverse lookups yet); `audit_events.old/new_version_id` are not indexed (no lookup path). No speculative indexes.

### Final decision
Schema accepted. Ownership: all ten tables application-owned in schema `configuration`. Nullability reviewed (only genuinely optional columns nullable). Immutable historical state: `value_versions` (only a one-time closure), `change_approvals`, `snapshots`, `snapshot_items`, `audit_events` are immutable by trigger; `change_requests` content frozen after DRAFT and transitions guarded; parameters and change requests are never deleted. Concurrency: publish takes row locks on the holder and relies on the exclusion constraint as the final arbiter; approvals are unique per approver; activation is idempotent. Configuration vs schema: no business parameters or values are seeded; `scope_levels` is structural reference data. Retention: all history retained (no purge).

## CFG-002

Tables reviewed: all new, in schema `content`: `content.locales`, `content.entries`, `content.entry_variables`, `content.versions`, `content.version_approvals`, `content.snapshots`, `content.snapshot_items`, `content.audit_events`. Reused read-only: `configuration.scope_levels` (foreign keys from `content.entries` and `content.versions`; no change), `integration.outbox_events` (content event types; no change). Migration 0006 is data only (8 shell entries seeded through the lifecycle, five audit rows each, no outbox events) and changes no table definition.

### 1NF
PASS. Every column is an atomic scalar except two deliberate JSON documents: `content.entry_variables.example_value` and `content.snapshots.context` (see "Unnecessary JSON" below). Items that could have been arrays are rows: the variables of an entry are rows in `content.entry_variables`, not an array on `content.entries`; the versions of an entry are rows in `content.versions`; the items of a snapshot are rows in `content.snapshot_items`; approvals are rows, not a list on a version. `content.versions.body` is a single text document (template source), not a JSON structure and not a repeating group. A locale tag such as `zh-Hant-TW` is treated as one atomic identifier (it is the unit that is registered, activated and authored for); its language and script prefixes are not stored as separate columns because they are derivable by progressive truncation (see Derived fields). `scope_ref` is one opaque string.

### 2NF
PASS. Composite keys: `content.entry_variables (entry_id, name)`: every other column (`var_type`, `is_required`, `description`, `example_value`, `pii_class`) describes that variable of that entry, so it depends on the whole key. `content.snapshot_items (snapshot_id, entry_id)`: the only other column is `version_id` (plus the repeated `entry_id`, covered by the BCNF discussion below). Every other table has a single-column surrogate primary key (`locale` for `content.locales`), so partial dependencies are impossible. The natural candidate key of `content.versions` is `(entry_id, locale, scope_type, scope_ref, version)`; every attribute (body, status, period, reason, author) describes that exact version, none describes only part of the key.

### 3NF
PASS with three documented, trigger-enforced derivations. Entry governance attributes (content type, owner, sensitivity, criticality, fallback policy, max scope) live only on `content.entries`; versions do not repeat them. Locale attributes (`is_active`, `is_platform_default`) live only on `content.locales`; versions carry just the locale key. Scope rank lives only on `configuration.scope_levels`; the guard trigger and the resolver join it rather than copying it. Deliberate exceptions (see Intentional denormalization): `content.versions.approval_policy` (determined by `entry_id`), `content.versions.body_sha256` (determined by `body`), and `content.snapshot_items.entry_id` (determined by `version_id`).

### BCNF
PASS except four recorded, deliberate violations, each prevented from drifting by the database. Candidate keys checked: `content.locales.locale` (and the single-default rule: the partial unique index `uq_locales__platform_default` allows at most one default and `guard_locales` refuses any UPDATE that unsets it, so exactly one exists from the seed onward; a migration that moves the default disables the guard inside its own transaction and sets the new default there); `content.entries.entry_id` and `content.entries.key`; `content.entry_variables (entry_id, name)`; `content.versions.version_id`, `(entry_id, locale, scope_type, scope_ref, version)` (NULLS NOT DISTINCT) and the superkey `(version_id, entry_id)`; `content.version_approvals (version_id, approver)`; `content.snapshot_items (snapshot_id, entry_id)`; `content.snapshots.snapshot_id`; `content.audit_events.audit_event_id`. Determinants that are NOT candidate keys: (1) `content.versions`: `entry_id -> approval_policy` (version copies the entry policy so the governing policy never changes retroactively; the guard trigger forces equality at insert and freezes the column, and the entry policy is itself immutable, so the dependency cannot be violated); (2) `content.versions`: `body -> body_sha256` (derived; computed by the insert trigger, never trusted from the caller, immutable); (3) `content.snapshot_items`: `version_id -> entry_id` (repeated so that the primary key can express "one version per entry per snapshot"; the composite foreign key `(version_id, entry_id) -> content.versions (version_id, entry_id)` makes drift impossible); (4) `content.audit_events`: `version_id -> entry_id` and `previous_version_id -> entry_id` (an audit row names the entry once, and the versions it mentions must belong to that entry; the composite foreign keys `fk_audit_events__version_entry (version_id, entry_id)` and `fk_audit_events__previous_version_entry (previous_version_id, entry_id)` to `uq_versions__version_entry` make drift impossible, with MATCH SIMPLE so locale and entry actions, which carry no version, are unaffected). A second dependency, `version_id -> locale`, is NOT stored: `ck_audit_events__subject` requires `locale` to be NULL for every entry and version action, so a locale is stored only for locale actions, where it is the subject itself (an audit row has no key on it, and `action` determines which subject columns are NULL, which is a CHECK shape and not a stored fact). Everything else is determined by a candidate key.

### Duplicate concepts examined
Each of the following was challenged and the decision recorded.

- **Entry / version / locale duplication.** `content.entries` is the stable identity and policy (what the copy is and how it is governed), `content.versions` is the text of one (locale, scope) at one point in time, `content.locales` is the registry of languages. The key is not repeated in versions (they reference `entry_id`), the entry policy attributes are not repeated in versions (except the one deliberate policy copy), and the locale is stored once per version as a foreign key to the registry. No text or policy is stored in two tables. Decision: three tables, no duplicated attributes beyond the documented exceptions.
- **Is locale a property of the version, or should translations be a child table?** Considered `version_translations (version_id, locale, body)` under one language-neutral version. Rejected: the lifecycle (draft, review, approval, schedule, publish, supersede, effective dates) is per locale: a Spanish legal document is approved and effective on a different date than the English one, and a translation correction must not re-version or re-approve the other languages. Lifecycle attributes would then depend on `(version, locale)`, so the child table would just be `content.versions` under another name, and the parent would be an empty shell. Locale therefore belongs to the version holder `(entry, locale, scope_type, scope_ref)` and the per-holder `version` number. The locale registry is separate because its attributes (`is_active`, `is_platform_default`) depend on the locale alone, not on any entry or version; embedding them in versions would repeat them on every row (update anomaly: activating a locale would touch every version) and could not enforce "exactly one platform default" with a constraint. Activation is also an operational decision independent of authoring, so a locale can be authored for before it is served.
- **Publication lifecycle duplication: why no publications / change-request table.** CFG-001 needs `configuration.change_requests` because the value version does not exist until publication (published values are immutable and carry the only timeline), so a proposal must live somewhere else first. Content versions are different: the body is immutable from the moment of creation, so the draft IS the future published row. A separate `publications` or `change_requests` table would be 1:1 with `content.versions` (same identity, same lifetime) and would either duplicate the body/locale/scope or hold only status columns that depend on the version key alone, i.e. the same entity split in two with a join on every read and a cross-table consistency problem. Instead the lifecycle is `content.versions.status` (guard trigger state machine), decisions are `content.version_approvals`, and the history is `content.audit_events`. Cost accepted: unpublished and never-published rows (DRAFT, REJECTED, CANCELLED) share the table; partial indexes and the partial exclusion constraint keep them out of resolution and overlap checks.
- **Scope polymorphism.** `content.versions.scope_type` is a foreign key to the existing `configuration.scope_levels` (one scope hierarchy for the platform; no `content.scope_levels` copy to drift), restricted to `PLATFORM, COUNTRY, MARKET` by a check and bounded per entry by `content.entries.max_scope_type` (guard trigger compares ranks from `scope_levels`). `scope_ref` is an opaque text reference with NO foreign key and is NULL exactly for PLATFORM (`ck_versions__platform_has_no_ref`): the referenced entities (country, market) do not exist as tables yet and a polymorphic reference cannot be a single foreign key. Alternatives rejected: one nullable FK column per scope kind (sparse, grows with every new level) and a separate scope table (a second hierarchy). The level is enforced by the database; existence of the referenced entity is validated by the owning domain when it exists (same limitation as DEBT-0024). A new content scope level is a migration that widens `ck_versions__scope_type` and `ck_entries__max_scope_type`.
- **Template variable normalization.** Variables belong to the entry (`content.entry_variables (entry_id, name)`), not to a version or a locale. Placing them per version would repeat the contract on every translation and allow translations to disagree about what placeholders exist, which breaks the guarantee that every locale of an entry renders from the same inputs. A translation may legitimately omit a variable, so "variables used by this body" is not stored: it is derived by parsing the body (a stored `used_variables` array would be a derived, driftable duplicate). `is_required` is a property of the variable, and `trg_entry_variables__no_late_required` blocks adding a required variable after versions exist (existing copy would stop rendering).
- **Snapshot duplication.** A snapshot could copy locale, body and metadata of the resolved text. Rejected: `content.snapshot_items.version_id` points at an immutable version (body, hash, locale, scope, version number and `effective_from` can never change after publication, and the row can never be deleted), so for the text and what identifies it the pointer is equivalent to a stored copy without duplicating up to 200000 characters per item. It is NOT equivalent for `effective_to`: that column is the live end of the version's period and is closed once when a successor is published, so a read through the pointer after that would differ from what was true at creation. Snapshot items therefore deliberately expose no `effective_to` (the service, the API and the contract omit it); only the text, version, version id, hash, `effective_from`, scope and locale are fixed, which makes a snapshot read-back byte-stable. The period that applied at `evaluated_at` is derivable from `evaluated_at` and the version history if ever needed. `entry_id` is repeated in the items only so the primary key `(snapshot_id, entry_id)` can state "one version per entry per snapshot" (a constraint cannot span tables); the composite foreign key `(version_id, entry_id)` to `uq_versions__version_entry` prevents drift. Dropping the column and keying on `(snapshot_id, version_id)` would allow two versions of the same entry (for example two locales) in one snapshot and make reproduction ambiguous. `content.snapshots.requested_locale` is an input (what the caller asked for), distinct from the resolved locale that the version carries, so it is not a duplicate.
- **Legal-document overlap with generic content.** Legal documents are `content.entries` with `content_type = 'LEGAL'`; `ck_entries__legal_policy` forces owner LEGAL, SECOND_APPROVER, CRITICAL and EXACT fallback. Versions, locales (jurisdictional language), COUNTRY/MARKET scopes, approvals, audit and snapshots are exactly what a legal document needs, so separate `legal_documents` / `legal_document_versions` / `legal_approvals` tables would duplicate all of them and give two places to enforce immutability. No legal tables were created. The future acceptance record (ID-005) will reference `content.versions.version_id` (immutable primary key) and may store `body_sha256` as evidence; `body_sha256` is computed by the database at insert, so such a copy can be verified. That future copy is an ID-005 decision and will go through its own review.
- **Audit vs lifecycle.** `content.audit_events` records who did what and when (action, entry, locale for locale actions, versions, reason, correlation id); content, decisions and timeline stay in `content.versions` and `content.version_approvals`. Bodies are never copied into audit.

### Derived fields examined
- **No "is current", "is published", "is latest" or "current_version" column exists anywhere.** `SCHEDULED`, `PUBLISHED` and `SUPERSEDED` in `content.versions.status` are workflow markers moved by the publisher and the activation job. Which version applies at an instant is derived from `effective_from <= at AND (effective_to IS NULL OR effective_to > at)` over published rows, so a delayed activation job can never serve a wrong version, and a stored flag cannot go stale. Status is still stored because the exclusion constraint, the immutability guard and the partial indexes need to distinguish unpublished rows from published ones.
- `content.versions.body_sha256`: derived from `body`; stored and computed by the insert trigger (see Intentional denormalization).
- Language of a locale (`zh-Hant-TW` -> `zh-Hant` -> `zh`): derived by progressive truncation in code, not stored.
- Fallback chain: derived at resolution from `entries.fallback_policy`, the requested locale, the caller-supplied market default and the platform default; not stored.
- Next version number: derived as max+1 per holder inside a transaction holding the entry row lock; `uq_versions__holder_version` is the arbiter.
- `content.versions.effective_from` while unpublished is a proposal, not a derived value (see below).

### Intentional denormalization
1. `content.versions.approval_policy`: copy of `content.entries.approval_policy` at creation, so the policy that governed a version never changes retroactively. Trigger `content.guard_versions` requires equality at insert and freezes the column; the entry policy is immutable (`content.guard_entries`).
2. `content.versions.body_sha256`: derived hash of `body`, computed by the insert trigger (the caller value is overwritten), immutable. Lets later consent and audit records bind to exact text without copying it.
3. `content.snapshot_items.entry_id`: repeats `content.versions.entry_id`; composite foreign key `(version_id, entry_id)` prevents drift; supports the one-version-per-entry primary key.
4. `content.versions.effective_from`: holds the proposed start while the version is unpublished and is raised exactly once at publication to `max(proposed, now)` (trigger allows a change only during `APPROVED -> SCHEDULED/PUBLISHED` and only upward). One column replaces a request-time/actual-time pair and a separate publication table; immutable afterwards. `effective_to` is stored (a successor's start could be derived) so that `ex_versions__no_overlap` can forbid overlap in the database; it can be closed once on a published version.
5. JSON columns `content.entry_variables.example_value` and `content.snapshots.context`: shape depends on `var_type` (scalar, or `{amount_minor, currency}` for MONEY) or is an input copy; never queried relationally; validated by the service, object type checked in the database for `context`.
6. `content.versions.scope_ref` has no foreign key (see Scope polymorphism); `content.audit_events.locale` is a plain value stored only for locale actions (`ck_audit_events__subject` requires NULL for entry and version actions; the locale of a version event is reached through the immutable version). `content.audit_events.entry_id` next to `version_id` is the repeated determinant of BCNF item (4), pinned by the composite foreign keys.
7. Status markers SCHEDULED/PUBLISHED/SUPERSEDED versus derived currency: markers are workflow, currency is derived from timestamps (see Derived fields).

Unnecessary JSON, challenged: only `example_value` and `snapshots.context` are JSON. `versions.body` is text (the template syntax is parsed by the service; storing a parsed tree would duplicate it). No `metadata`, `settings` or `variables` JSON column exists on entries or versions: governance attributes are typed, checked columns and variables are rows. `audit_events` carries no JSON payload (bodies are reached through version ids). `example_value` stays JSON because splitting it into typed columns per `var_type` would be sparse (nine variable types, MONEY needs two fields) and it is only read back whole to dry-render; `context` is an input copy of the resolution request, read back whole and never filtered by its fields.

### Index review
Each index and the query path it serves (constraint-backed indexes included):
- `content.locales`: `pk_locales` (locale lookup, FK target); `uq_locales__platform_default` (partial unique: enforces at most one default and finds it; the trigger `guard_locales` makes it exactly one by refusing to unset it).
- `content.entries`: `pk_entries` (FK target); `uq_entries__key` serves the lookup by key (resolution by key; key + locale resolves the key to `entry_id` here and then uses the holder index below).
- `content.entry_variables`: `pk_entry_variables (entry_id, name)` serves loading the variables of an entry and covers the `entry_id` foreign key.
- `content.versions`: `pk_versions`; `uq_versions__version_entry (version_id, entry_id)` is the target of the snapshot composite foreign key; `uq_versions__holder_version (entry_id, locale, scope_type, scope_ref, version)` serves key + locale lookup of a holder's versions, the max+1 version number and covers the `entry_id` foreign key; `ex_versions__no_overlap` (gist) is created by the exclusion constraint and is used for the overlap check at publication; `idx_versions__resolution (entry_id, locale, scope_type, effective_from DESC) WHERE status IN ('SCHEDULED','PUBLISHED','SUPERSEDED')` serves the effective_from branch of the next-boundary query only (index-only scan over entry, locale, scope and a future `effective_from`); it does NOT serve the candidate query (verified with EXPLAIN ANALYZE on a scratch database with 3000 entries x 2 locales x 5 versions and 20 keys: the candidate rows are read through `idx_versions__entry` or the gist exclusion index `ex_versions__no_overlap` (equality on entry, locale and scope), 200 rows read and 40 returned in under 1 ms, then filtered by time; the effective_to branch of the boundary query reads the same history). Candidate read cost therefore grows with the history length of a holder (every published row of the holder is read), which is short and bounded by editorial practice; the query was deliberately not changed, and the index is kept for the boundary query; `idx_versions__scheduled (effective_from) WHERE status = 'SCHEDULED'` serves the activation job (due rows only); `idx_versions__in_review (created_at) WHERE status = 'IN_REVIEW'` serves the reviewer queue; `idx_versions__entry (entry_id, created_at DESC)` serves the management history of one entry.
- `content.version_approvals`: `pk_version_approvals`; `uq_version_approvals__version_approver` serves the decisions of a version and covers the `version_id` foreign key.
- `content.snapshots`: `pk_snapshots` serves snapshot lookup by id. `content.snapshot_items`: `pk_snapshot_items (snapshot_id, entry_id)` serves loading a snapshot's items (snapshot lookup is by primary key) and covers the `snapshot_id` foreign key.
- `content.audit_events`: `pk_audit_events`; `idx_audit_events__entry (entry_id, occurred_at DESC) WHERE entry_id IS NOT NULL` serves the audit trail of an entry (locale actions have no entry and stay out of it); `idx_audit_events__version (version_id) WHERE version_id IS NOT NULL` serves the audit trail of one version, including a legal document version.
- Legal version lookup: by `version_id` (primary key) for acceptance evidence, and by key + locale through `uq_entries__key` and `uq_versions__holder_version`; no extra index.

Foreign keys without a supporting index, and why: `content.entries.max_scope_type` and `content.versions.scope_type` (target `configuration.scope_levels` is an eight-row reference table that is never deleted, so no referential check scans these tables, and no query filters by scope level alone); `content.versions.locale` (locales are never deleted, guarded by `trg_locales__guard`; versions are always read per entry, through the holder index); `content.snapshot_items (version_id, entry_id)` (versions can never be deleted; no reverse "which snapshots used this version" path is needed yet, and a future need would add a partial or plain index through its own review); `content.audit_events.entry_id`/`version_id` are indexed (partial), `content.audit_events.previous_version_id` is not (no lookup path; versions never deleted). The composite foreign keys `fk_audit_events__version_entry` and `fk_audit_events__previous_version_entry` reference the existing unique index `uq_versions__version_entry`; they replace the former single-column foreign keys on `version_id` and `previous_version_id` (same cost, stronger guarantee). No speculative indexes.

### Final decision
Schema accepted. Ownership: all eight tables are application-owned in schema `content`. Cardinality: entry 1-N variables, entry 1-N versions, locale 1-N versions, version 1-N approvals, snapshot 1-N items, version 1-N snapshot items (one per snapshot). Nullability reviewed: only genuinely optional columns are nullable (`scope_ref` exactly for PLATFORM, `effective_to` while open-ended, audit subject columns constrained by `ck_audit_events__subject`). Immutable historical state: variables, approvals, snapshots, snapshot items and audit events by `content.forbid_mutation`; versions by `content.guard_versions` (body frozen, one-time period changes, an end can only be closed at or after the start of the closing transaction so history is never rewritten); entries immutable except `is_active`; locales and entries are never deleted and the platform default locale is never unset. Concurrency: version numbers are allocated while holding the entry row lock with the holder unique key as arbiter; publication locks the version row and the exclusion constraint is the final arbiter against overlap; the activation job is idempotent (`FOR UPDATE SKIP LOCKED`). Configuration vs schema: no business values or product copy are seeded by the migration (only the structural `en-US` locale row); the 8 shell entries are data (migration 0006: one PUBLISHED `en-US` PLATFORM version each plus five causally ordered audit rows each (`clock_timestamp()`), no outbox events, no trigger disabled) created through the lifecycle, and fees, windows and durations stay in `configuration`. Retention: all history retained (no purge). Migration risk: low; new schema and tables only, brief lock on the eight-row `configuration.scope_levels` while its two foreign keys are added, no existing data touched, single transaction. Backfill: none (the seeded locale is reference data). Rollback strategy: forward-fix only (`MIGRATION_POLICY.md`); locally rebuild from zero with `pnpm stack:reset`; the schema holds only the seeded locale until entries are created, so there is nothing to preserve in a fresh environment. Known limitation: `scope_ref` existence is not database-enforced (as DEBT-0024).
