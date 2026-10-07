# ADR-0023 — One canonical immutable address, and a data-driven, versioned address format

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: GEO-002

## Context

Every later domain stores a place: customers and providers have addresses, a provider has a business address and service areas, a booking happens at a service address, tax and messaging depend on the country. Without one model each domain would invent its own columns, validate with its own rules and hardcode what a "state" or a "postal code" is, and a launch in a second country would mean code changes in each of them. The PRD asks for the opposite: forms, validation and display driven by the country, labels and messages as managed copy (SV-10.11), the administrative area stored as code and name (SV-10.05), coordinates as one geographic value, an address that is reviewable when it was typed by hand (SV-10.06), and a booking that keeps the address the customer accepted.

GEO-001 created the geography registry (ADR-0021) and the content registry owns managed copy (ADR-0018); the platform stores history as immutable, effective-dated rows closed once (ADR-0016, ADR-0018); and PostGIS conventions already exist (`DATABASE_CONVENTIONS.md` section 9). Addresses are personal data (ADR-0024 covers privacy).

## Decision

The address model lives in the `geography` schema (migration `0008_address_model.sql`) and has four tables.

- **ONE canonical address, no variants.** `geography.addresses` is the only structured address in the database: typed columns for the parts of a generic vocabulary (`organization`, `address_line_1`, `address_line_2`, `dependent_locality`, `locality`, `postal_code`, `sorting_code`, plus the administrative area), no customer, provider, booking or business variant, no country-specific column, and no owner column. Ownership belongs to identity, provider and booking, which reference `address_id`. Geography owns the structure only.
- **The address row IS the snapshot.** An address is immutable: a trigger refuses every UPDATE, and a changed or enriched address (for example a later geocode) is a NEW row. A booking that stores `address_id` therefore keeps exactly the address accepted at booking time; no `address_snapshots` table exists and no address columns are copied into booking tables. DELETE is not refused by the trigger; referencing tables will use `ON DELETE RESTRICT`, and retention and erasure are a recorded debt (DEBT-0036).
- **The format is data, versioned and effective-dated.** `geography.address_formats` holds one row per country VERSION (`DRAFT`, then `PUBLISHED` once) with a display template and a half-open period `[effective_from, effective_to)`. A partial exclusion constraint (`btree_gist`, `country_id` plus `tstzrange`, `WHERE status = 'PUBLISHED'`) allows at most one published format in force per country at any instant. A draft is immutable from creation; a published format is immutable except that its open end is closed exactly once by its successor; nothing is deleted. Publication locks the country row, raises the start to the actual start (never lowered) and closes the predecessor in the same transaction. A stored address references the exact version it was validated with, so a newer format never re-interprets it and `formatStoredAddress` renders it with its own template.
- **Fields are rows; labels and messages are content keys.** `geography.address_format_fields` holds one row per (format version, field type) with display order, requirement, maximum length, input type (`TEXT` or `LOOKUP`, the latter for the administrative area only), validation pattern, example, autocomplete hint and normalization rule. The label is a foreign key to `content.entries (key)`, never text; validation messages are content entries keyed by the issue code (`address.error.<code>`), so the form and the server show the same managed copy. Server validation, the central formatter and every client form read this one definition: no regular expression and no field order is duplicated in code, and a new country is data only (draft, publish) plus its label copy.
- **The postal rule lives on the field; there is no `postal_code_rules` table.** The pattern, example, normalization and maximum length of a postal code are attributes of the `POSTAL_CODE` field row of the version. A separate table would duplicate (version, field) data, give two answers when they disagree and could re-interpret old addresses. One validator serves forms, the service and any list of postal codes.
- **The area is a row, stored as id, code and name.** `geography.administrative_areas` is a same-country tree (adjacency list through a composite foreign key), identity immutable, never deleted, status `ACTIVE` or `INACTIVE`. An address stores `administrative_area_id`, the code and the name (PRD SV-10.05): the composite foreign key `(administrative_area_id, country_id, administrative_area_code)` keeps the area in the address country and the stored code equal to the area code (declared, enforced denormalization); the name is a snapshot as of insert; a free-text area stores only a name. Lookup values resolve to ACTIVE areas only.
- **A single PostGIS point.** `location geography(Point,4326)` is the only geospatial value; latitude and longitude are derived with `ST_Y` and `ST_X` of the geometry cast, so there are no columns that can drift. Coordinates are validated (-90..90, -180..180) BEFORE the point is built because PostGIS silently coerces. No GiST index until a spatial query exists.
- **Composite foreign keys carry consistency.** `(address_format_id, country_id)` to the format keeps the version in the address country; the area key above keeps the area in the country; `(parent_area_id, country_id)` keeps a parent in the same country. Guard triggers add what a key cannot: format lifecycle, immutability, `PUBLISHED` format, `ACTIVE` area and time zone at address insert, with `FOR SHARE` locks so a concurrent deactivation serializes with the insert. Every guard failure carries `geography_rule:<KEY>` (nine new keys) and the service classifies on it.
- **Derived but immutable: `formatted_address`.** The display text is generated by the central formatter at insert from the parts and the template of the version used, so historical addresses stay byte-stable regardless of later templates or formatter code. It is recomputable and cannot drift because the row is immutable. `raw_input` (what was submitted) is a JSON object because its shape depends on the source and it is only read back whole.
- **Statuses and sources are explicit and constrained.** `validation_status` (`UNVERIFIED`, `FORMAT_VALID`, `GEOCODED`, `VERIFIED`, `INVALID`) and `validation_source` (`MANUAL`, `AUTOCOMPLETE`, `GEOCODER`, `ADMIN`, `IMPORTED`) are bound by CHECKs (located statuses need a point, manual never has one, autocomplete is never verified, a provider code exactly for autocomplete and geocoder).
- **Audit and events.** `geography.audit_events` gains a third nullable subject (`address_format_id`, wider action and subject CHECKs, partial index); format drafts and publications and area changes are audited, and two outbox events carry identifiers and counts only (`address-format-published`, `administrative-areas-updated`).

## Alternatives considered

- Per-domain address tables (customer, provider, booking, business): duplicate columns and rules, and every country change touches every domain. Rejected.
- Per-country columns or tables (`state`, `zip_code`, `province`, `prefecture`): the vocabulary would grow with every country and the code would branch on country. Rejected; one generic vocabulary of eight parts with the format deciding which apply.
- An entity-attribute-value table of address parts: loses typed length and not-blank checks, the area foreign key and the point, and turns every read into a pivot. Rejected; the nullable parts are inherent to one canonical model and are tied together by CHECKs.
- Country format as code, constants or JSON in configuration: not versioned per address, not reviewable in the database, regular expressions duplicated in clients. Rejected.
- A JSON `fields` list on `address_formats`: no typed checks, no label foreign key, not queryable. Rejected; fields are rows.
- A shared `field_types` table or inheritance between versions: the attributes vary per country, and a version that depends on another row is not immutable in meaning. Rejected; each version is complete.
- A `postal_code_rules` table: duplicates field data and can drift from the version. Rejected.
- Mutable addresses plus a snapshot table (or copied columns in bookings): personal data in two places, a second retention problem, and a table with the same columns. Rejected; immutability makes the row the snapshot.
- Separate `latitude` and `longitude` columns (or alongside the point): two truths and no way to catch out-of-range input in a CHECK. Rejected.
- Storing only the area name or only the area code: loses either the PRD's code and name pair or the link to the canonical row. Rejected; id, code and name with the composite key.
- Foreign key on `(country_id, version)` instead of a surrogate format id: equivalent integrity, but audit rows, events and the field table are simpler with one id; the composite `(address_format_id, country_id)` key keeps the country consistent.
- Draft and published rows in separate tables: 1:1 with the same identity and fields, and a copy at publication. Rejected; the draft is the future published row (as in content).
- Enforcing publication order only in the service (or only with triggers): the exclusion constraint is the final arbiter that cannot be bypassed; the service adds clear errors and the country row lock.

## Consequences

Adding a country is a data change: label content entries, areas, a format draft and its publication, through audited API calls, with a readiness check that gates markets on a format in force. Old addresses never change meaning. The price is that corrections are new versions and new rows: an unused or wrong draft stays `DRAFT` (DEBT-0039), an edited saved address creates a new address, and erasure cannot simply delete referenced rows (DEBT-0036). A published version repeats the fields it did not change. Validation patterns come from the database and run in the API process; they are vetted but not isolated (DEBT-0042). Only the US dataset exists (DEBT-0040) and markets do not yet reference an administrative area (DEBT-0041). The insert guard requires a published format, not one in force, so an address can be stored against a superseded version (the row records which). The country address data is cached under the geography generation, so a publication can reach validation a cache bound late. Any later table that needs an address stores `address_id` with `ON DELETE RESTRICT`.

## Migration / compatibility

Migration `0008_address_model.sql`, forward-only (ADR-0010), one transaction: four new tables, guard triggers, an additive nullable column and two widened CHECKs on `geography.audit_events` (a pure widening; the append-only trigger is not involved), and deterministic seeds (51 US areas, US format version 1 published through the guard, twelve address content entries through the real content lifecycle). No existing row is rewritten, no code path of GEO-001 changes behavior, and no outbox event is emitted by the seed.

## Related files

- `db/migrations/0008_address_model.sql`
- `packages/contracts/src/address.ts`
- `packages/geography/src/address-engine.ts`
- `packages/geography/src/address-service.ts`
- `apps/api/src/modules/geography/address-routes.ts`
- `docs/engineering/ADDRESSES.md`
- `docs/data/DATA_MODEL.md`
- `docs/data/NORMALIZATION_LOG.md`
