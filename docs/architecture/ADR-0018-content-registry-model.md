# ADR-0018 — Content registry: localized, scoped, effective-dated immutable versions in a dedicated schema

Status: ACCEPTED
Date: 2026-10-06
Checkpoint: CFG-002

## Context

Product copy (labels, messages, email and push templates, help articles, legal documents) must be changeable without a deploy, localizable, approved, auditable and reproducible: the text a person saw or accepted must be provable later. Hardcoded strings cannot do that, and the configuration registry (ADR-0016) models typed values, not localized text with a template language, a locale fallback and a document lifecycle. Domain tables (catalog, provider, gig) do not exist yet, and their user-written text is not centrally managed copy anyway.

## Decision

Managed copy lives in a new PostgreSQL schema `content` (migration `0005_content_registry.sql`), separate from `configuration` and from runtime config and flags.

- **New schema.** Content is a separate aggregate with its own lifecycle (locales, drafts, review, immutable text, templates). Per ADR-0008 a schema is created by the first feature that needs it; `content` was not in the list of anticipated schema names, so this ADR records the addition. Tables: `locales`, `entries`, `entry_variables`, `versions`, `version_approvals`, `snapshots`, `snapshot_items`, `audit_events`.
- **Entry plus versions.** An entry is a stable semantic key with type, owner role, sensitivity, criticality, approval policy, fallback policy and the most specific scope allowed; it is immutable except `is_active`. The key never encodes a locale or the wording. Entry variables (typed placeholders with examples and a PII class) belong to the entry, so every translation shares one contract.
- **One `versions` table carrying its own lifecycle** (DRAFT, IN_REVIEW, APPROVED, SCHEDULED, PUBLISHED, SUPERSEDED, REJECTED, CANCELLED), one row per (entry, locale, scope, version number). The body is immutable from creation; `body_sha256` is computed by a trigger. Published rows (SCHEDULED, PUBLISHED, SUPERSEDED) are the only ones that resolve, and a gist exclusion constraint forbids overlapping periods per (entry, locale, scope). Triggers enforce the state machine, the second-approver rule, and the single permitted period changes (start raised once at publication, end closed once). The deliberate copy of `approval_policy` onto the version records the policy that governed it.
- **Legal documents are entries of type LEGAL**, not a separate set of tables. A CHECK forces owner LEGAL, SECOND_APPROVER, CRITICAL and EXACT fallback. Future acceptance records (ID-005) reference `versions.version_id` and `body_sha256`.
- **Locales table.** `locales` holds registered locales with `is_active` and `is_platform_default`. There is at most one default by the partial unique index `uq_locales__platform_default`, and the guard trigger `content.guard_locales` forbids unsetting it, so exactly one exists from the seed onward; a migration that moves the default disables the guard inside its own transaction and sets the new default there (it cannot create the new default first, the index would refuse it). If no default exists the resolver raises `UNAVAILABLE` (`NO_PLATFORM_DEFAULT`). Authoring requires registration (foreign key), serving requires activation. Activation is data, not code. Seed: `en-US` only.
- **Scope reuse.** `versions` and `entries` reference `configuration.scope_levels`, so there is one scope hierarchy and one rank order. Content is restricted to PLATFORM, COUNTRY and MARKET by CHECK; gig, provider and category text is domain data owned by the domain's tables. `scope_ref` stays opaque (DEBT-0024).
- **Snapshots** store a pointer per entry to the exact immutable version, with the locale, context and time. The pointer is equivalent to a copy of the text, hash, locale, scope, version number and start (versions never change and are never deleted), but not of `effective_to`, which is closed when a successor is published; snapshot items therefore carry no `effectiveTo` and a snapshot read-back is byte-stable. They are created only where reproduction matters, and never for an instant later than the database clock plus 5 seconds.
- **Per-domain audit table.** `content.audit_events` records every management mutation (actor, action, entry, version, previous version, reason, correlation id; the locale only for `LOCALE_*` actions, since a version action reaches its locale through the immutable version, enforced by `ck_audit_events__subject` and composite foreign keys tying versions to the entry of the same row) and never copies bodies. It is append-only. It is a log of what was done, written in the same transaction as the change; it is not a second authority: the rows in `versions`, `entries` and `locales` are the truth, and nothing reads the audit table to decide anything. A shared platform-wide audit table is deferred (the `audit` schema is still reserved); each domain keeps its own for now, as `configuration` does.
- Events go through the transactional outbox (ADR-0012) with identifiers only.

## Alternatives considered

- Put content in the `configuration` schema as a STRING parameter type: no locale dimension, no template variables, no per-locale fallback, and every translation would be a separate parameter key, breaking the stable key; the parameter lifecycle and cache keying are tied to values, not documents.
- Separate tables per lifecycle stage (drafts, published, history): two sources of truth and a copy step at publish; the single table with a guarded state machine keeps the immutable row that records point to.
- Separate legal-document tables: duplicate versioning, approval and immutability machinery; one more place for the policy to drift. A CHECK on the entry gives the same guarantees.
- A mutable "current version" pointer or flag: race-prone and not point-in-time; the current version is derived from timestamps.
- Locale columns on the entry (one text per language in one row): translations would share a lifecycle, so one language could not be corrected or scheduled independently.
- A second scope table for content: two hierarchies that would drift. Reusing `scope_levels` costs one read-only foreign key.
- Content in files or an external CMS: no approval, audit or point-in-time guarantees inside the transactional boundary, and a runtime dependency outside PostgreSQL (ADR-0001, ADR-0005).
- Storing rendered text in snapshots or notifications: copies of personal data; version pointers plus the caller's own variable store are enough.

## Consequences

Any consumer asks the registry for keys in a locale and context; reads are cheap (3 queries per batch, cached) and writes are intentionally heavy. Authors must follow the lifecycle for every wording change, including the seeded shell copy. A translation can be authored against an inactive locale and released by activating it. Entries and their variables are immutable after creation, so adding a variable or changing a policy means a new entry (DEBT-0029). The registry requires btree_gist (already present) and a foreign key to `configuration.scope_levels`, so `content` migrates after `configuration`. History is retained indefinitely (DEBT-0025).

## Migration / compatibility

New schema; no existing data affected. Migration `0005_content_registry.sql` (structure, `en-US` seed) and `0006_content_seed_shell_copy.sql` (eight product-shell entries published through the real lifecycle: five audit rows each, no outbox events because no consumer exists yet and consumers read current state), forward-only (ADR-0010).

## Related files

- `db/migrations/0005_content_registry.sql`
- `db/migrations/0006_content_seed_shell_copy.sql`
- `packages/content/`
- `packages/contracts/src/content.ts`
- `apps/api/src/modules/content/`
- `docs/engineering/CONTENT.md`
- `docs/data/NORMALIZATION_LOG.md`
