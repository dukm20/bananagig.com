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
