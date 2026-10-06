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

