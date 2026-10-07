# ADR-0016 — Configuration registry: typed parameters, scoped immutable effective-dated versions

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: CFG-001

## Context

Business values (cancellation windows, review windows, retry policies, unit rules, fees) must never be hardcoded and must be changeable with approval, history and an audit trail. Bookings and later domains need to know exactly which values applied at a moment in time. Domain tables (markets, categories, providers, plans) do not exist yet, so the registry cannot depend on them.

## Decision

Product configuration lives in the PostgreSQL schema `configuration`, separate from runtime/infrastructure config (environment variables) and feature flags (flagd).

- **Typed parameters** (`parameters`) define key, data type, validation rules, sensitivity, approval policy and criticality. There is no default column: the PLATFORM-scope value is the default.
- **Scope hierarchy** as reference data (`scope_levels`): PLATFORM < COUNTRY < MARKET < CATEGORY < PLAN < PROVIDER < GIG < DROP. The most specific applicable scope wins. A parameter lists the levels at which it may be overridden (`parameter_scopes`); values and requests reference it through a composite foreign key.
- **Opaque scope references** (`scope_ref` text, no foreign key) so the registry does not depend on domain tables. The owning domain validates existence once it exists (DEBT-0024).
- **Immutable versions** (`value_versions`) with half-open validity `[effective_from, effective_to)`. A database exclusion constraint (`btree_gist`) forbids overlap per holder. The only permitted mutation is closing an open-ended version once when its successor is published; triggers enforce this. A published version is never withdrawn; corrections are new versions. A new version must start after the latest existing one for the same holder.
- **Resolution derives "current" from timestamps**, never from a stored current flag. The scheduled activation job (`configuration.activate-due`, every minute) only moves the workflow marker `SCHEDULED -> ACTIVE`; correctness does not depend on it.
- **Change workflow** (`change_requests`, `change_approvals`): `DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED/ACTIVE -> SUPERSEDED`, with `REJECTED` and `CANCELLED`. Policies NONE, OWNER_APPROVAL, SECOND_APPROVER; under SECOND_APPROVER the requester cannot approve (checked in the service and by a database trigger).
- **Snapshots** record the context and time plus a pointer to the exact immutable version used per parameter. Because versions can never change or be deleted, the pointer is equivalent to a copy.
- **Audit** (`audit_events`) is append-only and carries identifiers, never values.
- Events (change requested/approved/rejected, scheduled, activated) go through the transactional outbox (ADR-0012) with identifiers only.
- Canonical value encodings: DECIMAL as string; DURATION as `{amount, unit}`; MONEY as `{amount_minor, currency}`.

## Alternatives considered

- Single table of key/value rows with overwrite: no history, no approval, no point-in-time answers.
- A `default_value` column on the definition: duplicates the PLATFORM value and drifts.
- Mutable "current" value with a history table: two sources of truth; race-prone activation.
- Foreign keys from `scope_ref` to future domain tables: impossible now and couples the registry to every domain.
- Application-only overlap checks: not safe under concurrency; the exclusion constraint is the arbiter.
- Reusing feature flags (flagd): flags are not typed, versioned, approved or auditable per scope.

## Consequences

Any consumer asks the registry for a value in a context and may keep the snapshot id for audit. Writes are intentionally heavy (workflow, immutability); reads are cheap (3 queries per batch, cached). Existence of a scoped entity is not enforced by the registry (DEBT-0024). History is retained indefinitely.

## Migration / compatibility

New schema and one extension (`btree_gist`); no existing data affected. Migration `0004_configuration_registry.sql`, forward-only.

## Related files

- `db/migrations/0004_configuration_registry.sql`
- `packages/configuration/`
- `apps/api/src/modules/configuration/`
- `docs/engineering/CONFIGURATION.md`
- `docs/data/NORMALIZATION_LOG.md`

## Updated by GEO-001

The statements above that `scope_ref` is opaque and that existence of a scoped entity is not enforced (DEBT-0024) are no longer true for COUNTRY and MARKET. Since GEO-001 the service validates those references against the geography registry through the optional `ScopeReferenceValidator` port at `createChangeRequest` and again at `publish` (canonical form, existing, PLANNED or ACTIVE; fail-closed; ADR-0022). The column is still text without a foreign key, resolution still never validates, the other scope levels are still unvalidated (DEBT-0024 is IN_PROGRESS), and a registry built without the port behaves as originally decided.
