# Catalogue Taxonomy

The catalogue (CAT-001) is the platform-owned taxonomy of what can be sold on BananaGig: **categories** (Auto Services) and **service types** (Car Detailing), where each service type belongs to exactly one category, plus their availability and order per market and a flat list of prohibited services. A **Gig** (Full Detail) is a provider-owned object that arrives with a later checkpoint and will reference a service type; nothing provider-specific (price, duration, radius, capacity, availability, variants, add-ons) exists in this schema. Decision: ADR-0040. Related: `GEOGRAPHY.md` (markets), `CONTENT.md` (names and descriptions), `CONFIGURATION.md` (the CATEGORY scope).

Requirements served: PRD 5.1 (Category and Service Type are Platform-owned, Gig is Provider-owned), PR-03.03 (the catalogue: collapsible categories each with its service types, a one-line description), CU-01.09 (categories are data with display order, active flag and markets), AD-01.03 and AD-01.04 (platform admins manage categories and service types with activation flags and display order; nothing appears unless an admin activated it), SV-02 (reference data, not hardcoded), SV-04 (a stable identity for the later search), SV-09 (verification policy is keyed by category and market: it will reference these ids).

## Ownership

| Object | Owner | Where |
|---|---|---|
| Category, service type, prohibited service | Platform (administrators) | `catalog.categories`, `catalog.service_types`, `catalog.prohibited_services` |
| Market availability and order | Platform (administrators), per market | `catalog.market_categories`, `catalog.market_service_types` |
| Names and descriptions | Content registry (CFG-002) | `content.entries`, found through keys generated from the code |
| Whether a market is public | Geography registry (GEO-001) | `geography.markets`; the catalogue asks through the `MarketGate` port |
| Gig, variant, add-on, bundle, price, pitch, media, radius, capacity | Provider, later checkpoints | not here |
| Verification, skill, equipment, licence and insurance requirements | SV-09 / TRUST-001 | not here; they reference the stable ids |

## Identity, history and retirement

- **The code is the identity**: immutable lower-case snake_case (`home_cleaning`), 2 to 48 characters, unique (service type codes are unique across ALL service types), never reused. It is the API path, the stem of the content keys and the CATEGORY configuration scope reference. Display text is never an identifier.
- **Names are content, derived not copied.** `name_content_key` is a stored generated column (`catalog.category.<code>.name`, `catalog.service_type.<code>.name`, `catalog.prohibited_service.<code>.name`) with a foreign key to `content.entries`, so a row cannot exist without its name entry and the key cannot disagree with the code. The description key is NULL or exactly `...<code>.description` (a link, requested with `withDescription`). **Create and publish the content entries first**, then create the row (the API answers `NAME_CONTENT_MISSING` otherwise).
- **No version tables.** A stable id, an immutable code, the status machine and the audit trail are enough: a future Gig references the id, a rename is a content change, and retirement keeps the row. See ADR-0040.
- **Status machine** (one function for all three tables): `DRAFT` (initial only) -> `ACTIVE` or `RETIRED`; `ACTIVE` <-> `INACTIVE`; `ACTIVE` or `INACTIVE` -> `RETIRED`; `RETIRED` is terminal (blocks every new use, keeps the row, the code and the history). Rows are never deleted or truncated.
- **Hierarchy rules** (database guards, `catalog_rule:<KEY>`): a service type is created under a non-RETIRED category and is ACTIVE only while its category is ACTIVE; a category cannot leave ACTIVE while one of its service types is ACTIVE (`CATEGORY_HAS_ACTIVE_SERVICE_TYPES`) and cannot be retired while one is not RETIRED (`CATEGORY_HAS_OPEN_SERVICE_TYPES`); a service type's category never changes.

## Market availability and public visibility

`market_categories` and `market_service_types` hold `enabled` and `display_order` per (market, item). Availability can be **prepared** for a market of any status (a PLANNED market before launch) and for items that are not ACTIVE yet. An item is **public** only when ALL of these hold:

1. the market is public: ACTIVE and in effect (decided by the geography registry through the port, the same rule as `GET /geography/markets/:code`); a market that is not public answers 404 `CATALOG_MARKET_NOT_FOUND` exactly like an unknown one;
2. the category is ACTIVE and its row is enabled in the market;
3. for a service type: it is ACTIVE, its row is enabled in the market, and its category is enabled there (the database refuses enabling a service type without its category in the same market).

`la-oc` stays PLANNED, so it exposes nothing. **Display order is market data**, unique per market over all rows (gaps of 10 by convention; swapping two orders takes three statements because the key is not deferrable); there is no global order column, and the administrative list without a market is ordered by code (the documented fallback, never offered to the public). Switching a category off in a market first switches off its enabled service types there (audited and announced one by one, listed in `alsoDisabled`). A RETIRED item is never enabled again, but its existing market rows stay as history.

## API

Prefix `/api/v1/catalog`. Spec: `docs/api/openapi.yaml` (generated; never hand-edit). Standard envelope and error model; error codes `CATALOG_<CATEGORY_NOT_FOUND | SERVICE_TYPE_NOT_FOUND | PROHIBITED_SERVICE_NOT_FOUND | MARKET_NOT_FOUND | VALIDATION_FAILED | CONFLICT | INVALID_STATE | UNAVAILABLE>`.

**Reads** (public routes with visibility rules, `optionalAuthenticated`, `Vary: Authorization`):

| Operation | Path | Public view | Management view (catalog-read or catalog-write) |
|---|---|---|---|
| `listCatalogCategories` | GET `/categories?market=&locale=` | `market` REQUIRED (400 `CATALOG_VALIDATION_FAILED`, `details.reason` `MARKET_REQUIRED`), the public categories in the market's order, resolved name and description, stable id and code, icon name | every status; with `market` the availability and order in it (any market status), without it the global list by code |
| `getCatalogCategory` | GET `/categories/:code` | only while public in the named market, else 404 | any status |
| `listCatalogServiceTypes` | GET `/service-types?market=&category=&locale=` | the public service types in the market's order | the same, every status, `enabled` flags |
| `getCatalogServiceType` | GET `/service-types/:code` | as above | any status |
| `listCatalogProhibitedServices`, `getCatalogProhibitedService` | GET `/prohibited-services(/:code)` | never public (401/403) | the flat list with status |

The public DTO has exactly: `categoryId`, `code`, `name`, `description`, `iconKey`, `displayOrder` (category); `serviceTypeId`, `code`, `categoryCode`, `name`, `description`, `displayOrder` (service type). The management DTO adds `status`, `enabled`, the content keys and timestamps. Names and descriptions are resolved in ONE `content.resolveRendered` batch with the market in the context (a market override beats the platform copy) in the requested locale, else the market's default locale, with the content registry's own fallback chain. An item whose NAME has no published text is **omitted** from the public view (an unnamed item cannot be shown) and appears with its content key as name in the management view.

**Mutations** (`catalog-write`, the admin identity context, a `reason` of at most 1000 characters, an immutable audit row; activation and availability also write an outbox event in the same transaction; idempotent when nothing changes): `POST /categories` (201, DRAFT), `PATCH /categories/:code` (icon name, description link), `PUT /categories/:code/status` (`ACTIVE`, `INACTIVE`, `RETIRED`), `POST /service-types`, `PATCH /service-types/:code`, `PUT /service-types/:code/status`, `POST /prohibited-services`, `PUT /prohibited-services/:code/status`, `PUT /markets/:market/categories/:code` and `PUT /markets/:market/service-types/:code` (`enabled`, `displayOrder` required for a new row; a taken order is 409 `DISPLAY_ORDER_TAKEN`). DEV/TEST codes (`devtest_*`) are refused unless `allowTestKeys`.

**Permissions** are the temporary admin client roles of the other registries (DEBT-0021): `catalog-read` and `catalog-write` on `bananagig-admin` (write implies read), given to `admin.dev` and `admin2.dev` in the dev realm. Apply a realm change locally with `pnpm identity:sync`.

## Audit and events

Audit (`catalog.audit_events`, one row per real mutation, never for reads): `CATEGORY_CREATED`, `CATEGORY_UPDATED`, `CATEGORY_STATUS_CHANGED`, `SERVICE_TYPE_CREATED`, `SERVICE_TYPE_UPDATED`, `SERVICE_TYPE_STATUS_CHANGED`, `PROHIBITED_SERVICE_CREATED`, `PROHIBITED_SERVICE_STATUS_CHANGED`, `MARKET_CATALOG_AVAILABILITY_CHANGED`, each with the actor, the field diff and the reason.

Events (transactional outbox, identifiers only; spec `docs/events/asyncapi.yaml`): `bananagig.catalog.category-activated.v1`, `category-deactivated.v1` (an ACTIVE category left ACTIVE), `service-type-activated.v1`, `service-type-deactivated.v1`, `availability-changed.v1` (one per availability row changed, cascades included). Consumers arrive with SEARCH-001 and the provider checkpoints; no event exists for creation, metadata or the prohibited list because nothing consumes them.

## Cache

PostgreSQL is the truth. The public snapshot of a market (its enabled ACTIVE categories and service types, as codes and content keys, never text) is cached under `bg:{env}:cat:v1:market:<code>:<generation>`; the generation `bg:{env}:cat:gen` is bumped AFTER any committed change, so invalidation is immediate while Valkey answers. A bump lost to a Valkey failure or an open breaker is bounded by the snapshot TTL (`CONFIG_CACHE_TTL_SECONDS`, 30 s by default): the old snapshot may be served until it expires. The snapshot does not depend on the locale (the content registry caches text by locale and content generation) and does not embed the market's own visibility (the geography registry's cached `getMarket` is asked on every call), so neither a locale change nor a market activation touches this cache. Management reads and mutations never use it; every cache failure degrades to a database read.

## Scope reference (DEBT-0024)

`CATEGORY` configuration scope references are validated against `catalog.categories` when a change request is created and when it is published, through the existing scope port (`createCatalogScopeReferenceValidator`, composed with geography's validator in the API composition root): the canonical code, existing, not RETIRED (DRAFT, ACTIVE and INACTIVE are valid so configuration can be prepared before a category launches); unknown, retired and non-canonical references get the ONE generic reason `SCOPE_REFERENCE_INVALID`.

## Known limits

- **Retirement keeps availability rows.** Retiring an item leaves its enabled market rows as they are: the public view hides it (status filter) and no availability event is sent; the guard `ITEM_RETIRED` only stops a retired item from being enabled. Switch the rows off first if consumers of `availability-changed` need to see it.
- **Transactions.** The mutations open their own transaction and bump the cache generation after it commits; do not call them inside a caller's transaction (the generation would move before the outer commit).
- **Audit text checks.** `reason` and `actor` are checked with `btrim`, which trims spaces only; the API validates the text (`adminText`) before it reaches the database.
- **Prohibited services** can still be created under a RETIRED category (the list is data only; no workflow reads it yet).

## Gig Templates

The versioned, platform-owned structure a provider builds a Gig from (CAT-002) lives in the same schema and is documented in `docs/engineering/GIG_TEMPLATES.md` (ADR-0041). It shares this document's visibility model, roles, audit table, generation cache and market gate.

## Not here (see `TECH_DEBT.md`, DEBT-0083)

The admin UI, the complete launch taxonomy (the seed is a deliberately minimal DRAFT set; the launch list depends on PRD question Q5), natural-language synonyms and the search projection, verification/skill/equipment requirement policies, the prohibited-service moderation, the category icon media pipeline, effective-dated availability, Gig templates (built in CAT-002, see GIG_TEMPLATES.md; their own deferrals are DEBT-0084).

## How to add a category or a service type

1. In the content registry create and publish the **name** entry (`catalog.category.<code>.name`, content type `UI_LABEL`; add the `.description` entry too if the item has a description) — through the content API (second approver where the entry policy needs one) or a seed migration through the lifecycle.
2. `POST /api/v1/catalog/categories` (or `/service-types` with `categoryCode`) with the code and a reason. It is created DRAFT.
3. Activate the category, then its service types (`PUT .../status`), then enable them per market (`PUT /markets/:market/categories/:code` first, then the service types), each with a display order that fits between two others.
4. Retire what must stop being used (`RETIRED`, terminal); the row, the code and the history stay.

## Testing

Run the files rather than quoting counts: the contracts (`packages/contracts/src/catalog.test.ts`), the database model (`packages/testing/src/catalog-model.itest.ts`: shape, seed, every guard, the status matrix, the races), the service (`packages/catalog/src/catalog.test.ts`, `catalog.itest.ts`: visibility truth table, cache, audit, outbox, concurrency, scope validator), the API (`apps/api/src/catalog.test.ts`, `catalog.itest.ts`) and the smoke scenario `Catalog` (seeded taxonomy, a DEV/TEST market, hidden/visible transitions, rename, cascade, scope reference, retirement, audit and outbox). Commands: `pnpm --filter <package> test`, one integration file with `node --env-file-if-exists=.env.host node_modules/vitest/vitest.mjs run -c vitest.integration.config.ts <file>`, `pnpm smoke`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| the public list is empty | the market is not ACTIVE/in effect (that is a 404, not an empty list), the category or service type is not ACTIVE, or its availability row is missing, disabled or not under an enabled category |
| 404 `CATALOG_MARKET_NOT_FOUND` for a market that exists | it is PLANNED or INACTIVE (the public view needs an ACTIVE market in effect) |
| an ACTIVE item is missing from the public list | its name has no published text in the resolved locale chain (it is omitted); the management view shows the content key |
| 400 `CATALOG_VALIDATION_FAILED`, `details.reason` `NAME_CONTENT_MISSING`, on create | the content entry `catalog.<kind>.<code>.name` does not exist yet |
| 409 `CATALOG_INVALID_STATE`, `details.reason` `CATEGORY_HAS_ACTIVE_SERVICE_TYPES` | deactivate the service types first |
| 409 `CATALOG_INVALID_STATE`, `details.reason` `CATEGORY_NOT_ENABLED_IN_MARKET` | enable the category in that market before its service types |
| 409 `CATALOG_CONFLICT`, `details.reason` `DISPLAY_ORDER_TAKEN` | another item of the market has that position; use a free one (gaps of 10) |
| a role gets 403 on a catalogue mutation | the token needs the admin context and `catalog-write`; after a realm change run `pnpm identity:sync` |
