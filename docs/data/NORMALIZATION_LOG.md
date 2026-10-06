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
