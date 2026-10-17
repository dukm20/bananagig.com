# ADR-0040 — The catalogue taxonomy is platform-owned reference data with stable identities, content-derived names, per-market availability and status-based retirement (no versions, no configuration values)

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: CAT-001

## Context

The PRD splits the catalogue in three owners: Category (Platform, Auto Services), Service Type (Platform, Car Detailing) and Gig (Provider, Full Detail) (5.1). Administrators maintain categories and service types with activation flags and display order, and nothing appears in the product unless an administrator activated it (AD-01.03, AD-01.04); categories are data with display order, an active flag and markets (CU-01.09); providers later build Gigs from service types (PR-03). Six questions had to be answered before any Gig table exists: where the taxonomy lives (configuration or tables), how many categories a service type has, where display text and order live, whether taxonomy rows are versioned, what retirement means, and how the market decides what is public.

## Decision

- **Reference data in a new `catalog` schema, not configuration values.** CFG-001 holds typed values scoped by platform, country, market, category, plan, provider, gig and drop. A category is the thing a CATEGORY scope names, not a value: forcing categories into `configuration.parameter_values` would give them no foreign keys to content or markets and would make the scope hierarchy circular. The `CATEGORY` scope reference is instead VALIDATED against `catalog.categories` through the existing scope port (DEBT-0024), composed with geography's validator in the API composition root.
- **A tree: every service type belongs to exactly ONE category**, fixed for life (`category_id` immutable). The PRD reads as a tree (collapsible categories each with its service types; a Gig identity names its category and its service type, the first being that of the second). A many-to-many would let a Gig choose between two categories for one service type and would need a primary-category rule. Moving a service type between categories is a new service type (a future Gig must keep its meaning).
- **The code is the identity; names are content, derived not copied.** Immutable lower-case snake_case, unique (service type codes across all service types), never reused. `name_content_key` is a stored generated column from the code with a foreign key to `content.entries`, so no display text and no second copy of the key exist in the schema, a row cannot exist without its name entry, and a rename in the content registry touches no identity. The description key is NULL or exactly the conventional key.
- **No version tables.** Stable ids + immutable codes + a status machine + an immutable audit trail meet every requirement: a Gig references the id, a rename is a content change (content has its own versions), and retirement keeps the row and the code. A published-version table would duplicate facts that never change (the code, the category) and force every reader through an "in force" resolution.
- **A status machine with a terminal `RETIRED`**, shared by categories, service types and prohibited services: `DRAFT` (initial only) -> `ACTIVE` or `RETIRED`; `ACTIVE` <-> `INACTIVE` (a pause); `RETIRED` blocks every new use, keeps the row, the code and the history, and is never reversed. Rows are never deleted or truncated. The hierarchy is enforced by the database (a service type is ACTIVE only under an ACTIVE category; a category cannot leave ACTIVE with an ACTIVE service type or be retired with an unretired one; no service type is created under a RETIRED category).
- **Display order and availability are MARKET data.** `market_categories` and `market_service_types` hold `enabled` and `display_order` per market, unique per market over all rows (the unique key is also the access path). There is no global order column (the administrative list without a market is ordered by code, never offered publicly) and no effective dates (the market's own window already gates exposure; a date column nothing reads would be speculative). A service type can be enabled in a market only while its category is enabled there; switching a category off first switches its service types off, audited one by one.
- **Public exposure is decided at read time, never stored.** An item is public only when the market is ACTIVE and in effect (asked of the geography registry through the `MarketGate` port: the catalogue never copies that rule, and a PLANNED market such as `la-oc` exposes nothing even with prepared rows), the category is ACTIVE and enabled in the market and, for a service type, it is ACTIVE and enabled in it. A non-public market is 404 exactly like an unknown one. Availability may be prepared for any market status and for items that are not ACTIVE yet.
- **Requirements and prohibitions.** Verification, skill, equipment, licence and insurance requirements per category and market are NOT modelled: SV-09 and TRUST-001 own their shape and will key them by these stable ids (a foreign key can be added without touching this schema). Prohibited services are a flat platform-level table (code, generated name key, optional category, status) with no workflow and no consumer; it answers "support prohibition structurally" without inventing moderation.
- **Management is audited and minimal.** Temporary admin client roles `catalog-read` and `catalog-write` (the DEBT-0021 model), a mandatory reason, one immutable audit row per real mutation, outbox events only where a projection or search consumer is foreseeable (activation, deactivation, availability). No admin UI.
- **Seed: a deliberately minimal DRAFT taxonomy** (2 categories, 4 service types, the PRD 5.1 example plus the first candidate category) with its copy through the real content lifecycle, because the launch list is an open question (Q5) and "nothing appears unless an administrator activated it".

## Alternatives considered

- **Taxonomy as configuration parameters**: rejected (above).
- **A category-service type join table (many-to-many)**: rejected (above); it can be added later by a reviewed migration if the product ever needs it.
- **Display names in the tables, or a plain `name_content_key` column**: a display name copies content and drifts; a plain key column can disagree with the code and be pointed at any entry. The generated column removes both.
- **Version tables with published windows (like content or address formats)**: those registries have values that change under an identity; the taxonomy's identity fields never change and its only history is status and availability, both audited.
- **A global `display_order` on categories and service types**: breaks when two markets want different menus (the PRD says categories are data per market).
- **Hard delete for unreferenced rows**: a future Gig, a configuration scope or an audit row may reference a code the moment it exists; one rule ("never deleted") is simpler and safer than "deletable until referenced".
- **Cascading status changes (deactivating a category deactivates its service types)**: hides the blast radius; the database refuses the unsafe move and the administrator deactivates children explicitly. (Market availability is the exception: switching a category off in a market is a single intent and cascades, audited per row.)
- **Requirement tables and a moderation workflow now**: premature without their consumers.

## Consequences

- A future Gig references `catalog.service_types.service_type_id` and takes its category from it; retirement of a service type blocks new Gigs only.
- Adding a category or service type is data plus content (create and publish the name entry, create the row, activate, enable in markets), never a deployment.
- The public read is two statements per market on a cache miss and none on a hit; the market's visibility is asked of geography on every call (its own cache).
- The CATEGORY configuration scope is now validated; `DEBT-0024` remains open for the plan, provider, gig and drop scopes.
- The launch taxonomy, the admin UI, synonyms, requirements policy, the icon pipeline and moderation are recorded debt (DEBT-0083), not framework gaps.

## Migration / compatibility

`0015_catalog.sql` adds the schema, six tables, seven functions with their triggers and the seeds; no existing table changes. The realm file gains the `catalog-read` and `catalog-write` client roles (`pnpm identity:sync` locally).

## Related files

- `db/migrations/0015_catalog.sql`
- `packages/contracts/src/catalog.ts`
- `packages/catalog/src/service.ts`
- `packages/catalog/src/scope-validator.ts`
- `apps/api/src/modules/catalog/routes.ts`
- `apps/api/src/modules/catalog/wiring.ts`
- `docs/engineering/CATALOG.md`
- `docs/architecture/ADR-0016-configuration-registry-design.md`
- `docs/architecture/ADR-0021-geography-reference-data-model-and-locale-authority.md`
- `docs/architecture/ADR-0022-cross-domain-reference-integrity-through-ports.md`
