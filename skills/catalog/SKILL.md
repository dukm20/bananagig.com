# Catalogue taxonomy (categories, service types) and Gig Templates

## Purpose

Read and change the PLATFORM-OWNED taxonomy of what can be sold: categories (Auto Services), service types (Car Detailing; each belongs to exactly one category), their availability and display order per market and the flat prohibited-service list. Since CAT-002 also the versioned Gig Templates: the platform-approved structure a provider builds a Gig from. Since CAT-003 providers create Gigs (Full Detail) from a template version in the `provider` schema (`skills/provider`); nothing provider-specific lives here.

## When to use

- A feature needs the list of categories or service types of a market (onboarding, the GigMenu, discovery, search, admin), or must reference a service type from another table (a Gig).
- Adding or retiring a category, a service type or a prohibited service, changing its availability or order in a market, or touching the `catalog` schema, its API, events or cache.
- Referencing a CATEGORY scope from configuration, or keying a policy (verification, fees) by category.
- A feature builds on a Gig Template: the provider Gig builder (CAT-003, built), template adoption, CAT-004 (variants, add-ons, media), the requirements checkpoints (TRUST-001, SV-09), template administration, or anything that must reference "the structure a Gig was built from".
- Anything that is tempted to store a category or service name, a category list or a menu order in code, configuration or a Gig table.

## Canonical files

- `db/migrations/0015_catalog.sql`, `db/migrations/0016_gig_templates.sql`, `docs/data/DATA_DICTIONARY.md`, `docs/data/NORMALIZATION_LOG.md`
- `packages/contracts/src/catalog.ts`, `packages/contracts/src/gig-template.ts`
- `packages/catalog/src/service.ts`, `gig-template-service.ts`, `gig-template-types.ts`, `cache.ts`, `scope-validator.ts`, `types.ts`, `errors.ts`
- `apps/api/src/modules/catalog/{routes,gig-template-routes,dto,gig-template-dto,common,wiring}.ts`, `apps/api/src/plugins/auth.ts` (`CATALOG_PERMISSIONS`), `apps/api/src/index.ts`
- `packages/testing/src/catalog-model.itest.ts`, `packages/catalog/src/catalog.itest.ts`, `apps/api/src/catalog.itest.ts`, `packages/testing/src/gig-template-model.itest.ts`, `packages/catalog/src/gig-template.itest.ts`, `apps/api/src/gig-template.itest.ts`
- `docs/engineering/CATALOG.md`, `docs/engineering/GIG_TEMPLATES.md`, `docs/engineering/PROVIDER_GIGS.md`, `docs/architecture/ADR-0040-platform-owned-taxonomy-with-stable-identities-and-status-based-retirement.md`, `docs/architecture/ADR-0041-versioned-platform-gig-templates-referenced-immutably-by-provider-gigs.md`, `docs/architecture/ADR-0046-provider-gig-versions-bind-immutably-to-exact-gig-template-versions.md`

## Architecture rules

- Boundary: Category and Service Type are PLATFORM-owned; Gig, variant, add-on, bundle, price, pitch, media, radius, capacity and availability are PROVIDER-owned (the Gig, its versions, price, duration and copy since CAT-003 in `provider.*`; the rest arrives later). Never add a provider-specific column (price, duration, radius, cap, media) to the catalogue, and never collapse a service type into a Gig. A Gig reaches its service type and category THROUGH its template (`gig_templates.service_type_id`); the Gig table stores neither.
- The CODE is the identity: immutable lower-case snake_case (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, 2 to 48), unique (service type codes across ALL service types), never reused, never an English display name. Ids and codes are what other tables, configuration scopes, URLs and search reference.
- Names and descriptions are CONTENT (CFG-002): `name_content_key` is a stored generated column (`catalog.<kind>.<code>.name`) with a foreign key to `content.entries`; the description key is NULL or exactly `...<code>.description`. Create and publish the content entry FIRST, then the row. A rename is a content change and moves no id, code or order. Never store display text in the catalogue.
- Taxonomy is reference data, NOT configuration: a category is what a CATEGORY scope names, not a parameter value. Do not put categories in `configuration.parameter_values`. The CATEGORY scope reference is validated against the catalogue through the scope port (DRAFT, ACTIVE and INACTIVE valid; RETIRED, unknown and non-canonical get the one generic reason).
- A tree: a service type has exactly ONE category and it never changes (a move is a new service type). No category-service-type join table.
- No version tables: stable id + immutable code + status machine + audit trail. Status: `DRAFT` (initial only) -> `ACTIVE` | `RETIRED`; `ACTIVE` <-> `INACTIVE`; `ACTIVE` | `INACTIVE` -> `RETIRED`; `RETIRED` terminal. Rows are never deleted or truncated; retirement blocks new use and keeps the row, the code and the history.
- Hierarchy (database guards, `catalog_rule:<KEY>`): a service type is ACTIVE only under an ACTIVE category; a category cannot leave ACTIVE while a service type is ACTIVE nor be retired while one is not RETIRED; none is created under a RETIRED category; in a market a service type is enabled only while its category is enabled there, and a RETIRED item is never enabled. The service switches a category's service types off first when the category is switched off in a market (audited one by one).
- Market data: `market_categories` / `market_service_types` hold `enabled` and `display_order` per market, unique per market over all rows (gaps of 10; the unique key is the access path and is not deferrable). There is no global order; the administrative list without a market is ordered by code and never public. No effective dates.
- Public exposure is derived at read time: market ACTIVE and in effect (asked of geography through `MarketGate`; never copy that rule), category ACTIVE and enabled, service type ACTIVE and enabled under an enabled category. A non-public market is 404 exactly like an unknown one; `la-oc` stays PLANNED and exposes nothing. Availability may be prepared for any market status.
- Public DTOs carry only the public fields (`categoryId`, `code`, `name`, `description`, `iconKey`, `displayOrder`; service type adds `categoryCode`): no status, no `enabled`, no content keys, no timestamps, no audit. The management view (`catalog-read` or `catalog-write`, the admin context) adds them. Names are resolved in ONE `resolveRendered` batch with the market in the content context; an item whose name has no published text is omitted publicly and shown with its content key to administrators.
- Management mutations need `catalog-write` (the temporary admin client role model, DEBT-0021), a reason, and write an immutable audit row; activation, deactivation and availability changes also write an outbox event in the same transaction; a repeat that changes nothing writes nothing. DEV/TEST codes (`devtest_*`) exist only with `allowTestKeys`.
- Requirements (verification, skills, equipment, licence, insurance) are NOT here: SV-09 / TRUST-001 own them and key them by these ids. Prohibited services are a flat list with no workflow.
- Cache: generation counter `bg:{env}:cat:gen` bumped AFTER commit; the per-market snapshot holds codes and content keys only (no text, no market visibility); management reads bypass it; every cache failure degrades to a database read.

### Gig Templates (CAT-002)

- **Three levels, three owners.** Service type (platform, what is sold: Car Detailing) > Gig Template (platform, the approved structure: Full Detail) > Gig (provider, what one provider sells: price, chosen duration, pitch, description and the values of the provider-editable fields in CAT-003; floor price, radius or area, photos, capacity, variants, add-ons, booking mode later). Never put a provider value in a template row and never read the mutable template to learn what a Gig was built from.
- **Identity and version are separate.** `gig_templates` = immutable code and service type, derived copy keys, status; `gig_template_versions` = the structure. A provider Gig version stores `gig_template_version_id` (CAT-003) and validates against THAT frozen version. A published version and its field, option and requirement rows are frozen by guards; the fix for a mistake is a new version copied from it (`copyFromVersion`).
- **Version lifecycle.** `DRAFT` -> `ACTIVE` (publish) | `RETIRED` (discard); `ACTIVE` -> `SUPERSEDED` (automatic, only by publishing a newer version) | `RETIRED` (done by the retirement of the template; the machine allows it, the service offers no direct withdraw). One DRAFT and one ACTIVE per template, contiguous numbers, never deleted. No `IN_REVIEW` (no reviewer exists yet).
- **Editing is whole-draft and token-guarded.** `PUT .../versions/:n` replaces the WHOLE definition with `expectedRevision`; a different revision is 409 `STALE_DRAFT`; an equal definition writes nothing. Publish takes the same token and is a no-op when repeated on an ACTIVE version with that revision.
- **Fields are typed rows, not JSON.** 11 types, behaviour `PLATFORM_FIXED` / `PROVIDER_CONFIGURABLE` / `PROVIDER_REQUIRED` ("editable" and "required" are derived), sections, per-type metadata under a CHECK matrix (a column that does not belong to the type is NULL), enum options as rows, MONEY without numeric metadata (limits are configuration). A photo rule is a MEDIA field (`max_items = 0` = no photos, required = `PROVIDER_REQUIRED` with a minimum).
- **Copy is content with DERIVED keys shared by all versions**: `catalog.gig_template.<code>.name|description|instructions`, `...field.<field_key>.label|help|default`, `...field.<field_key>.option.<option_code>.label`. The entries must EXIST before a draft names them (400 `CONTENT_ENTRY_MISSING` lists the keys) and be published (as the content resolver reads it) in the platform default locale before publication (409 `CONTENT_NOT_PUBLISHED` lists the keys). A field whose meaning changes gets a NEW field key; wording is not frozen per version (DEBT-0084).
- **Pricing and area models are metadata**, not prices: FIXED, FIXED_WITH_VARIANTS (at least one base model), BUNDLE_ELIGIBLE, DROP_ELIGIBLE; RADIUS, POSTAL_CODES, POLYGON (at least one). Requirement rows (SKILL, EQUIPMENT, LICENSE, INSURANCE, BACKGROUND_CHECK) are hooks with an opaque, unvalidated reference code until TRUST-001 owns the catalogues.
- **Publication needs** an ACTIVE template and service type (read FOR SHARE), at least one field, options for every enum, and the published copy. **Retiring a template** discards an open draft (audited), closes the ACTIVE version, keeps every version and the code. CAT-001 guards are NOT changed: a paused service type leaves its templates ACTIVE but unreachable (the public read re-checks the chain).
- **Locks**: the service takes the TEMPLATE row first, then the version, in every version operation; raw statements that lock a version first can deadlock (retryable conflict). Availability per market is a plain row per (market, template) with the same one-retry race policy as the taxonomy.
- **Consumers bind the exact version and are never migrated automatically (ADR-0046).** v1 of a Gig binds the ACTIVE version; later Gig versions keep the SAME template version, so superseding a template version changes nothing for existing Gigs and a RETIRED version/template/service type only blocks NEW drafts and publishing. A template change that adds a PROVIDER_REQUIRED field of a type the Gig cannot store yet (MONEY, MEDIA, EQUIPMENT_REFERENCE, SKILL_REFERENCE) makes the template unpublishable as a Gig until CAT-004. Adoption of a newer version is a later checkpoint.
- **Public vs management**: the same routes, `Vary: Authorization`; the public view carries the safe structure of the ACTIVE version with resolved copy and never the status, revision, content keys, timestamps or other versions; management responses and every mutation are `Cache-Control: private, no-store`. Events: activated, deactivated, retired, published (with the exact version id), availability changed. The snapshot cache shares the taxonomy's generation counter.

## Implementation pattern

1. Read for a market with `listCategoriesForMarket(code)`, `listServiceTypesForMarket(code, { categoryCode })`, `getCategoryForMarket`, `getServiceTypeForMarket` (they throw `MARKET_NOT_FOUND` for a market that is not public); resolve the text through the content registry in the API layer (names are keys in the service). Web code calls the API, never the package.
2. Reference a service type from another table by `service_type_id`; never copy its code, name or category into the other table's rows (read the category through the service type).
3. New category: create and publish `catalog.category.<code>.name` (and `.description`), `POST /catalog/categories`, activate, enable it in the markets with a display order, then its service types the same way (category first). Retire with `RETIRED`.
4. After changing the API or events run `pnpm specs:generate` and the spec checks; after changing the schema run the Data Model Review Gate.

## Commands

`pnpm --filter @bananagig/catalog test` · `node --env-file-if-exists=.env.host node_modules/vitest/vitest.mjs run -c vitest.integration.config.ts packages/catalog/src/catalog.itest.ts` · `pnpm identity:sync` (after a realm change, DEV ONLY) · `pnpm smoke` (scenarios `Catalog` and `Gig templates`)

## Testing requirements

- Model tests on isolated databases: shape, seed, every guard with its exact `catalog_rule` key, the 4x4 status matrix, the hierarchy races with real transactions in both orders, unique codes and orders, `la-oc`-style PLANNED markets expose nothing.
- Service tests: the visibility truth table, cache hit/miss/invalidate after every mutation kind and never after a no-op or a failure, audit and outbox exactness and atomicity, idempotence, the cascade, query counts, concurrency through the service.
- API tests: market required, non-public market 404, exact public key sets, `Vary: Authorization`, one content batch, permissions (catalog-read cannot write), strict bodies and params, error mapping.
- Break the production line a test claims to cover (mutation check) before trusting it.

## Data-model considerations

Any change to the twelve tables or their guards needs the Data Model Review Gate and a forward migration (never edit 0015 or 0016). A new level (an alias, a requirement catalogue, a provider Gig) is a new table keyed by the stable ids, not a column here; a Gig references `gig_template_versions.gig_template_version_id` (done in CAT-003 by `provider.gig_versions`; mind its foreign keys when retiring or restructuring template rows).

## Common failure modes

- Creating the row before its name content entry (400 `NAME_CONTENT_MISSING`).
- Activating a service type before its category, or deactivating a category before its service types (409 with the rule as `details.reason`).
- Enabling a service type in a market before its category, or reusing a display order of the market (409).
- Treating "the public list is empty" as "no such market": a market that is not public is a 404, an empty list means nothing is launched in it.
- Hardcoding a category or service name, list or order in code, configuration or a test of another domain.
- Storing provider-specific data (a price, a radius) on a service type.
- Asserting HTTP 404 for a streamed web page instead of the API's 404 (LRN-0053).
- Editing a published template version (409 `VERSION_NOT_DRAFT`): create a new version from it instead.
- Replacing a draft with a stale revision (409 `STALE_DRAFT`): read the draft again first.
- A draft naming content entries that do not exist yet, or publishing with copy that is only a draft in the content registry: create and publish the entries first (the errors name the keys).
- Publishing under a template that is not ACTIVE or a service type that is not ACTIVE (409 `GIG_TEMPLATE_NOT_ACTIVE`, `SERVICE_TYPE_NOT_ACTIVE`).
- Giving a template a provider value (a price, a radius) or reading the mutable template to validate a Gig.
- Expecting a published Gig to follow a new template version, or to stop working because its template version was superseded: it keeps the version it was built from; only a RETIRED version, template or service type blocks new drafts and publishing.
- Retiring a template while expecting its Gigs to disappear: they stay readable to their owners; the template just leaves the creation choices.

## Known BananaGig-specific lessons

- A foreign key on a stored GENERATED column works in PostgreSQL 17: it gives referential integrity to a name key that is a function of the code, with nothing to keep in sync.
- Seeded taxonomy is DRAFT on purpose ("nothing appears unless an admin activated it"); the smoke and the tests activate DEV/TEST items of their own and leave the seed as found.
- Availability changes of a category cascade to its service types in that market inside one transaction (audit and event per row), because the database refuses an enabled service type without its enabled category.
- The seeded copy of the taxonomy has `max_scope_type` MARKET, so a market can override a name without touching the platform text.
- Two simultaneous FIRST submissions of the same availability row race on the primary key. The service maps a `pk_market_*` 23505 (like a deadlock or serialization failure) to a retryable `CONCURRENT_UPDATE` and `retryOnRace` re-runs the whole transaction once; the loser then sees the winner's row and returns the idempotent result. Never report that race as `CODE_TAKEN`/`DISPLAY_ORDER_TAKEN`.
- Order every list by code with `COLLATE "C"` (byte order): the database collation differs between machines.
- Management responses, the prohibited list and mutations are `Cache-Control: private, no-store` (an `onSend` hook in `routes.ts`); a lost generation bump is bounded by the snapshot TTL, not instant.
- Error `details` are an allow-list (`reason`, `field`, `code`, `retryable`); never forward a driver message, constraint name or SQL.

## Do not

- Do not add Gig, variant, add-on, price, duration, radius, capacity, availability or media to this schema (they live in `provider.*`, keyed by `gig_template_version_id`).
- Do not migrate a provider Gig to a newer template version silently; adoption is an explicit provider act of a later checkpoint.
- Do not delete, truncate, rename or re-code a category, service type or prohibited service, and never reuse a retired code.
- Do not move a service type to another category.
- Do not put display text, a menu order or a category list in code or configuration.
- Do not expose the prohibited-service list, a non-ACTIVE item, a disabled availability row or a content key on the public API.
- Do not decide market visibility in this package: ask the geography registry through the port.
- Do not edit an applied migration.

## Related ADRs

ADR-0016, ADR-0021, ADR-0022, ADR-0040, ADR-0041, ADR-0046

## Last reviewed

2026-10-18 (CAT-003)
