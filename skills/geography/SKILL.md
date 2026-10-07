# Geography registry (countries, markets, locale, currency and addresses)

## Purpose

Read, define and change where BananaGig operates (countries, currencies, time zones, markets) and the data-driven defaults of a place, and store, validate and format addresses through the one canonical address model (country-driven formats, administrative areas), through the registry instead of hardcoding lists or per-country rules.

## When to use

- A feature needs a country, market, currency, time zone, default locale, distance unit, first day of the week or date and time format.
- Adding or activating a country or market, changing a market default, or registering a readiness check for a new domain (tax, payments, address).
- Referencing a COUNTRY or MARKET scope from configuration or content, or deriving a market's default locale.
- Touching the `geography` schema, its API, events, cache or the two ports.
- Any feature that collects, validates, formats, stores or references a postal address, a postal code, an administrative area (state, province) or coordinates; adding a country's address format; wiring an autocomplete, geocoding or verification adapter.

## Canonical files

- `db/migrations/0007_geography_registry.sql`, `db/migrations/0008_address_model.sql`, `docs/data/DATA_DICTIONARY.md`, `docs/data/NORMALIZATION_LOG.md`
- `packages/geography/src/service.ts`, `readiness.ts`, `validation.ts`, `cache.ts`, `errors.ts`, `scope-validator.ts`, `market-defaults-provider.ts`
- `packages/geography/src/address-engine.ts` (pure validator and formatter), `address-service.ts`, `address-providers.ts` (ports and mocks)
- `packages/contracts/src/geography.ts`, `packages/contracts/src/address.ts`
- `packages/configuration/src/scope-reference.ts`, `packages/content/src/market-defaults.ts` (the port declarations)
- `apps/api/src/modules/geography/routes.ts`, `apps/api/src/modules/geography/address-routes.ts`, `apps/api/src/modules/geography/dto.ts`, `apps/api/src/plugins/auth.ts`, `apps/api/src/index.ts`
- `packages/testing/src/geography-seed.itest.ts`, `packages/geography/src/geography.itest.ts`
- `packages/testing/src/address-model.itest.ts`
- `docs/engineering/GEOGRAPHY.md`, `docs/engineering/ADDRESSES.md`

## Architecture rules

- Countries, currencies, time zones and markets are rows, never constants or env vars (ADR-0021). No tax, payment or fee data lives here; business values belong in configuration. Addresses are structure only (below).
- Country reference data: ISO 3166-1 alpha-2 (upper case, the canonical COUNTRY scope reference, must be a region known to `Intl`; `ZZ` is the DEV/TEST code behind `allowTestKeys`), alpha-3 and numeric are unique and immutable and checked for format and uniqueness only (DEBT-0031). The display name is a content entry (`display_name_content_key`), never a column. Format settings are enum codes on the country only (`MILES|KILOMETERS`, `MONDAY..SUNDAY`, `MDY|DMY|YMD`, `12_HOUR|24_HOUR`); markets inherit them; consumers render with `Intl`. No per-market overrides.
- Locale ownership: `content.locales` is the single locale authority. Geography references it by foreign key and never adds a locale table or locale columns; the content package never imports geography, geography never imports content (ports). Database dependency runs geography -> content only.
- Currency conventions: ISO 4217 alpha code (`char(3)`) is the key; `minor_unit_digits` (0 to 4) is data; code, numeric code and digits are immutable. Money elsewhere is `amount_minor bigint` plus the code; build decimals from minor units with BigInt, never Number division.
- Time zone conventions: IANA names only (`America/Los_Angeles`), never UTC offsets. The service accepts names in `Intl.supportedValuesOf('timeZone')` plus 19 listed IANA names that Node's CLDR list spells differently (`Asia/Kolkata`), so `Etc/GMT+5`, `EST`, `us/pacific`, `UTC+5`, `posix/...`, `right/...` and `UTC` are rejected; the database trigger (new names only, `pg_timezone_names`, not `posix/` or `right/`) stays the final authority. A market has one default zone from its country's zones; a later address checkpoint overrides it per location (DEBT-0034).
- Market model: first-class row with a unique lower-case kebab code (the canonical MARKET scope reference), its own default locale, currency and time zone, supported locales that are a subset of the country's, and a half-open window `[effective_from, effective_to)`. "In effect" is derived from `status = 'ACTIVE'` plus the window; never store a current or ready flag.
- Status machine on currencies, time zones, countries and markets: PLANNED is the initial status only (never written back); PLANNED to ACTIVE or INACTIVE, ACTIVE and INACTIVE move both ways. Rows are never deleted. Link rows are immutable (add or remove, never update) and the links of an ACTIVE country cannot be removed.
- Activation and readiness: the database triggers enforce the built-in prerequisites (country: ACTIVE currency, default locale and one ACTIVE time zone; market: ACTIVE country, currency, time zone, locale) and refuse deactivating a dependency in use; the service checks first for typed errors and runs the readiness registry. Readiness is derived in code, never stored. A later domain adds a check with `registerReadinessCheck({ code, description, required, evaluate })` at start-up; a failing required check is `NOT_READY` (409).
- Visibility: public callers see ACTIVE rows and public fields only (markets also only while in effect; `supportedLocales` only for ACTIVE locales and a country's `timeZones` only ACTIVE zones; `effectiveTo` is null); `geography-read` sees everything; audit rows and actors are never exposed. Every public GET sets `Vary: Authorization`. Permissions are the temporary client-role model (`geography-read`, `geography-write`, and write implies read; DEBT-0028).
- Configuration and content integration (ADR-0022): the `ScopeReferenceValidator` port checks COUNTRY and MARKET references at write time (canonical form, exists, PLANNED or ACTIVE; ONE generic reason for unknown, INACTIVE and non-canonical, while PLANNED and ACTIVE validate, which is inherent) and fails closed (`SCOPE_REFERENCE_INVALID`, `SCOPE_REFERENCE_UNAVAILABLE`); the `MarketDefaultsProvider` port derives a market's default locale for content (degrades to the platform default) and, through its optional `isVisible`, lets PUBLIC content resolution drop a country or market the public geography API does not show (not ACTIVE, outside its window, unknown, or the check throws: fail closed), so PLANNED, INACTIVE and unknown markets behave like no market; management callers are unfiltered. Configuration resolution never touches geography. The provider memoizes for 60 s, so visibility changes reach public content in about a minute. Wire both only in `apps/api/src/index.ts`.
- Addresses (ADR-0023, ADR-0024; `docs/engineering/ADDRESSES.md`): there is ONE canonical structured address, `geography.addresses`, for every domain. Never add a customer, provider, booking or business address variant, a country-specific column (`state`, `zip_code`) or an owner column; owning domains store `address_id` with `ON DELETE RESTRICT`. No country-specific code path anywhere: field order, requirement, label key, length, pattern and normalization, the postal-code rule and the display template are rows of the country format (`address_formats`, `address_format_fields`), read by the validator, the formatter and every client form. A postal rule is the pattern on the `POSTAL_CODE` field (no `postal_code_rules` table). Labels and validation messages are content keys (`address.field.*`, `address.error.<code>`), never strings in code.
- Address rows are immutable and the row IS the booking snapshot: change or enrich an address by inserting a new row, never an UPDATE (trigger), and never copy address columns into another table. Each address stores the exact format VERSION it was validated with, so old addresses are never re-interpreted; `formatted_address` is derived, stored once by the central formatter and never produced by a client.
- Entry points: validate and normalize with `validateAddressAgainstFormat` (engine) or `AddressService.validateAddress`; render only with `formatAddressWithFormat` or `AddressService.formatAddress` / `formatStoredAddress`; a single postal code or other field with `validateFieldValue` / `validatePostalCode`; persist with `createManualAddress`, `createAddressFromAutocomplete` or `geocodeAndCreateAddress`. A provider failure falls back to manual entry stored `UNVERIFIED`; autocomplete is `FORMAT_VALID`, never verified; `VERIFIED` needs a verification provider or an administrator.
- PostGIS: one `geography(Point,4326)` `location`; build with `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography` only after `isValidCoordinate` (-90..90, -180..180); derive latitude and longitude with `ST_Y` and `ST_X` of the geometry cast; no separate lat/lng columns; no GiST index until a spatial query exists (the first spatial checkpoint adds it).
- Adapter boundary: vendors implement `AddressAutocompleteProvider`, `GeocoderProvider` or `AddressValidationProvider` and are resolved per country through the `providers` resolvers; never import a vendor into the service, never log what an adapter receives, throw or return null instead of guessing, test against the mocks (DEBT-0037).
- Privacy: addresses and coordinates are personal data. Never log an address value (use `redactAddress` for any structure that might hold one; the logger also redacts keys containing `address`, `postal`, `zip`, `latitude`, `longitude`, `raw_input`); issues carry the property and a code, never the value; `validate` and `format` are stateless with `Cache-Control: no-store`; there is NO public route that creates or reads a persisted address; `raw_input` is returned only with `includeRawInput` in process. Retention and exact-location access policy are open (DEBT-0036).
- Formats and areas: a format is created as DRAFT (immutable), published once (`POST .../publication`: start is the latest of the proposed, requested and database time, the predecessor's open end is closed once, the country row is locked, `ADDRESS_FORMAT_PUBLISHED` audit plus event, cache bump) and never edited or deleted: a correction is a new version. At most one published format is in force per country (exclusion constraint). Areas are upserted (batch of 500, parent set at creation only), never deleted, and the last ACTIVE area cannot be retired while a published format has a lookup field. A public address route shows ACTIVE countries only; management (`geography-read`/`geography-write`) previews anything.
- Add a country with data only: country ACTIVE (GEO-001 prerequisites), label content entries for every field key the format uses (reuse `address.field.*` where the wording fits), areas when a field is a lookup, draft the format, publish it, verify with the public reads and `validate`/`format`, then the markets (the `ADDRESS_FORMAT` readiness check gates them). No code, migration or deployment.
- Concurrency: one lock order everywhere (markets of the country in `market_id` order, then the country, then currency, time zone, locale); lock with a bare `SELECT 1 ... FOR UPDATE|SHARE`, then read in a second statement (joined and `ARRAY(...)` columns go stale after a lock wait in READ COMMITTED); sibling rules lock the owner first. One inherent limit: a raw SQL zone deactivation can deadlock with a market activation (PostgreSQL aborts one side; the service reports a retryable `CONFLICT`, `CONCURRENT_UPDATE`).
- Errors: every guard `RAISE` carries `DETAIL 'geography_rule:<KEY>'` and callers classify on that key only; an unknown currency, locale or time zone named in a body is a 404 with its own code; control, bidi and surrogate characters or blank text in `name` and `reason` are rejected (`adminText`); bodies are validated strictly before ajv coercion.
- Events: country and market deactivated events only for ACTIVE to INACTIVE; retiring a PLANNED row audits and emits nothing; activation is idempotent.
- Cache: PostgreSQL is the truth; generation key `bg:{env}:geo:gen` bumped after commit plus content's `locgen` in every key; every cache failure degrades to a database read; management reads bypass it.

## Implementation pattern

1. Read market facts with `resolveMarketDefaults(code)` (data only, no code fallback) or `getMarket`/`getCountry`; resolve the country name through the content API with `displayNameContentKey`. Web code calls the API, never the package.
2. New country: create it PLANNED (`createCountry`), make sure its currency, locales and time zones are ACTIVE (SQL or migration today, DEBT-0031), then `setCountryActive`. New market: `createMarket` (PLANNED), check `getMarketReadiness`, then `setMarketActive`.
3. Referencing a market or country from another registry: use the canonical form (`US`, `la-oc`), never a free-text spelling.
4. New domain that must gate market launch: register a readiness check with a test that a failing check blocks activation (`NOT_READY`).
5. Address features: create addresses only through `AddressService` and store the returned `addressId` in the owning domain; render with the stored format version (`formatStoredAddress`), never with today's format; validate postal codes of lists with `validatePostalCode`.
6. After changing the API or events, run `pnpm specs:generate` and the spec checks; after changing the schema run the Data Model Review Gate.

## Commands

```bash
pnpm --filter @bananagig/geography test
pnpm test:integration                 # real PostgreSQL (isolated databases)
pnpm specs:generate && pnpm specs:check
pnpm data-model:check <CHECKPOINT>    # after any change to the geography schema
pnpm smoke                            # includes the Geography scenario
```

## Testing requirements

- Unit: ISO code, currency digits, locale canonicalization, IANA and scope reference validation, format enums, readiness registry, cache generations and deadlines, error mapping (guard keys, `CONCURRENT_UPDATE`, `FORBIDDEN_CHARACTER`), both ports including `isVisible`.
- Integration (real database, isolated): seeds, constraints, immutability, status machine, link rows, activation and deactivation rules, deterministic race tests with two real transactions that wait until the second one is blocked on a lock (`pg_stat_activity`), not sleeps: market activation versus country deactivation, country activation versus the deactivation of its only ACTIVE zone, audit and outbox rows, cache behaviour.
- API: 401 before 400, 403 for missing roles, write implies read, public visibility (PLANNED and INACTIVE hidden, no status or timestamps, `effectiveTo` null), `Vary: Authorization`, strict bodies (`{"active":1}` is 400), non-canonical path parameters are 400, error mapping without constraint names.
- Cross-registry: configuration and content scope validation, the market-default locale chain and the public content visibility filter with the real services (`apps/api/src/geography-integration.itest.ts`).
- Addresses: engine unit tests for every issue code, normalization, pattern vetting and the template literal-attachment rule; database tests for every address constraint, guard key, the exclusion constraint and immutability; service flows with the mocks (provider failure falls back to manual); API tests for visibility, `no-store`, strict bodies and that errors and logs never contain an address value; a second country added with data only.
- Use `devtest-*` markets and the country `ZZ` only in tests, with `allowTestKeys` on; they cannot be deleted, so use unique codes per run.

## Data-model considerations

Any change to `geography.*` (including the GEO-002 address tables) or to the columns GEO-001 added to `content.locales` goes through the Data Model Review Gate (dictionary, ERD, normalization log, snapshot). Do not add a stored readiness or current flag, offset columns, locale columns, per-market format copies, a second locale table, or foreign keys from `scope_ref` into geography without an ADR. `market_locales.country_id` is a deliberate, foreign-key-enforced denormalization. Reference rows are never deleted. For addresses also do not add a postal rules table, an address snapshot table, separate latitude and longitude columns, an `is_current` flag on formats or an owner column on `addresses` without an ADR; `administrative_area_code` and `country_id` on `addresses` are declared, composite-foreign-key-enforced denormalizations, and `formatted_address` and `raw_input` are immutable by design.

## Common failure modes

- Public 404 for a market that exists: it is PLANNED or INACTIVE, outside its window, or the caller has no `geography-read`.
- 400 on `/countries/us` or `/markets/LA-OC`: path parameters must be canonical.
- `INVALID_STATE` on activation (`COUNTRY_NOT_ACTIVE`, `CURRENCY_NOT_ACTIVE`, `LOCALE_NOT_ACTIVE`, `TIME_ZONE_NOT_ACTIVE`, `NO_ACTIVE_TIME_ZONE`): a dependency is not ACTIVE; time zones registered through the API start PLANNED and nothing activates them yet.
- `NOT_READY`: a required custom readiness check failed; see `details.checks`.
- `SCOPE_REFERENCE_INVALID` on a configuration or content write: wrong casing, unknown or INACTIVE market or country (the reason is deliberately the same for all three).
- Deactivating a locale refused (`CONTENT_INVALID_STATE`, `details.reason` `LOCALE_IN_USE_BY_GEOGRAPHY`): it is the default of an ACTIVE country or market.
- Public content ignores a request's `market`: it is PLANNED, INACTIVE, out of its window or unknown (dropped by the visibility filter), or the provider failed; a `content-read` caller sees it.
- Address 404 `GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND` or `COUNTRY_NOT_FOUND`: the country has no PUBLISHED format in force, or (public view) is not ACTIVE. A draft is rejected with `UNSAFE_PATTERN`, `INVALID_TEMPLATE`, `EXAMPLE_DOES_NOT_MATCH` or `UNKNOWN_CONTENT_KEY` (create the label content entry first); a publication is refused with `FORMAT_PERIOD_OVERLAP` or `START_NOT_AFTER_CURRENT`; retiring areas with `AREAS_IN_USE`.
- A 409 `CONCURRENT_UPDATE` conflict: a deadlock or serialization failure; nothing was written, repeat the request.
- Stale reads after a lost cache bump: bounded by the TTL; use a `geography-read` token for an authoritative read.
- Common mistakes: using a UTC offset or a lower-case country code as an identity, copying a country format onto a market, resolving the market default locale in the caller instead of using the provider, forgetting to pass the ports where a service is built, and registering readiness checks that do slow I/O while the market row is locked, and, for addresses, building the formatted string in a client, logging an address or coordinates, hardcoding a postal regex or field order, updating an address row instead of inserting a new one, and treating an autocomplete result as verified.

## Known BananaGig-specific lessons

- The default-locale foreign keys are DEFERRABLE INITIALLY DEFERRED so a row and its first link are inserted in one transaction; the new links go in first, the row update second, removed links last.
- Activation locks dependency rows `FOR SHARE` and a deactivation needs the row lock, so the two serialize; prove such rules with deterministic interleavings, not sleeps. The country time zone check locks the ACTIVE zone rows it relies on.
- Link rows are immutable and the service replaces sets by adding and removing rows; an ACTIVE country can add but not remove links (the API reason keeps the legacy name `LINKS_FROZEN`).
- Public market reads evaluate the effective window in memory on every call and never cache it; management reads and readiness are never cached.
- The API passes `CONFIG_CACHE_TTL_SECONDS` (default 30 s) as the geography TTL; the service default is 300 s. Content's provider memo adds up to 60 s.
- The seeded market `la-oc` is PLANNED on purpose: a business assumption the owner confirms before activating it. Configuration and content accept PLANNED references so values can be prepared.
- Geography reads `content.locales` and `content.entries` by SQL (read-only, same transaction as the activation): a deliberate exception to "other domains use the content service" (ADR-0021); do not widen it.
- Address immutability is what makes snapshots free: a trigger refuses UPDATE, enrichment inserts a new row, and the format publication closes the predecessor's open end once under the country row lock with the exclusion constraint as the final arbiter. The address insert guard requires a PUBLISHED (not an in-force) format, an ACTIVE area and an ACTIVE time zone, share-locked, so an address can use a version that has since been superseded and the row records which one.
- Public validation and address creation read the cached public view, so a just-published format or area can lag by the cache bound; management reads and the readiness check read the database. The US dataset (51 areas, format version 1, 12 content entries) comes from migration 0008; PostGIS coordinates are validated before the point is built because PostGIS coerces silently.
- Retiring a PLANNED country or market (PLANNED to INACTIVE) is audited but emits no event; the US is seeded with four time zones only (DEBT-0031); `la-oc` is a business assumption awaiting owner confirmation; the smoke Geography scenario adapts to the status of `la-oc` and reuses country `ZZ` and locale `qaa`.

- Display templates are punctuation-safe by construction (`renderLine`): text in front of a token belongs to that token and is written only when the token and an earlier token of the line have values; a bracket pair is allowed only as a direct wrapper of ONE field, `({FIELD})` or `[{FIELD}]`, and is written only with that field (and only when the field starts the line or an earlier field is present), so `{LOCALITY} ({ADMINISTRATIVE_AREA})` renders `Irvine (CA)`, `Irvine` or `CA`, never `CA)`. There are no conditionals, expressions, nesting or escapes; `templateProblem` refuses every other bracket. Test a new template shape with all subsets of present fields, not only the full address (GEO-002A, LRN-0032).
- Pattern vetting is deliberately conservative: any backslash followed by 1 to 9 is refused, including the pattern text `\\1` (write `[\\]1`); relax it only for a demonstrated product requirement (`docs/engineering/ADDRESSES.md`).
- The public address `validate` and `format` endpoints are not production-exposure-ready until the platform rate-limit checkpoint resolves DEBT-0030.

## Do not

- Do not hardcode countries, currencies, time zones, markets or format rules in code.
- Do not add locale, offset, readiness or "is current" columns, or a `geography.locales` table.
- Do not import `@bananagig/geography` from content, configuration or web (use the ports and the API; lint and `pnpm deps:check` enforce it).
- Do not delete reference rows or edit the applied migration; deactivate or fix forward.
- Do not accept non-canonical COUNTRY or MARKET references, or fail a content read because geography is unavailable (the visibility check drops the member instead; never serve a market that could not be verified as public).
- Do not return a specific reason for an invalid scope reference, or let `effectiveTo` reach a public DTO.
- Do not allow `ZZ` or `devtest-*` outside DEV/TEST, or put business values (fees, taxes, prices) in geography.
- Do not use the temporary client-role permissions as the long-term model (DEBT-0028).
- Do not add country-specific address code paths, columns or tables, or hardcode a postal-code pattern, a field order, a label or a validation message in code or a client.
- Do not log or return an address, postal code, coordinates or `raw_input`; do not add a public route that creates or reads a persisted address; do not echo a rejected value in an error.
- Do not update or snapshot-copy an address (insert a new row), edit a published format (publish a new version), or delete an address, area or format.
- Do not call a vendor from the service, let a provider failure fail a flow, or mark an autocomplete or manual address `VERIFIED`.

## Related ADRs

ADR-0021, ADR-0022, ADR-0023, ADR-0024 (builds on ADR-0001, ADR-0008, ADR-0011, ADR-0012, ADR-0016, ADR-0018)

## Last reviewed

2026-10-07 (GEO-002A)
