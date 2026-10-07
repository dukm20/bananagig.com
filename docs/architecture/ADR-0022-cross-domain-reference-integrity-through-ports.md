# ADR-0022 — Cross-domain reference integrity through ports: ScopeReferenceValidator and MarketDefaultsProvider

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: GEO-001

## Context

Configuration (ADR-0016) and content (ADR-0018) scope their values to a COUNTRY or MARKET through `scope_ref`, an opaque text reference without a foreign key. That was right while no domain table existed (DEBT-0024), but it let a value be written for a market that does not exist, and resolution matches references by exact string, so `us` or `LA-OC` would silently never match. Content also took the market's default locale from the caller (`context.marketDefaultLocale`), which only works if every caller knows it and gets it right.

GEO-001 creates the markets and countries these references name. The registries sit below geography (geography already depends on configuration for the cache primitives and on content tables for locales), so they must not import it, and a package cycle would break the boundary rules (`pnpm deps:check`).

## Decision

Integrity across domains is provided by two small, optional ports declared by the consumer and implemented by geography: the `ScopeReferenceValidator` (writes) and the `MarketDefaultsProvider` (reads, with two methods: the default locale and a visibility check). No registry imports geography; geography declares the same shapes structurally.

- **`ScopeReferenceValidator`** (declared in `packages/configuration/src/scope-reference.ts`, re-exported by content): `validate(scopeType, scopeRef)` returns `{ valid: true }` or `{ valid: false, reason }`. Geography implements it (`createGeographyScopeReferenceValidator`) for `COUNTRY` and `MARKET`: the reference must be in canonical form, must exist, and must be PLANNED or ACTIVE (INACTIVE is retired; accepting PLANNED is inherent, so a caller can tell an accepted reference is PLANNED or ACTIVE). An invalid reference of any kind (unknown, INACTIVE, non-canonical) gets ONE generic reason, because the authors of configuration and content hold no `geography-read` and a specific reason would disclose registry state. Every other scope type is valid and untouched (not geography's domain). Configuration calls it at `createChangeRequest` and again at `publish`; content at `createVersion` and `publish`. The publish check runs before the transaction so no row lock is held during validator I/O; the small window in which an entity is deactivated between check and commit is accepted, and existing rows are not re-validated.
- **Canonical reference forms.** A COUNTRY reference is the ISO 3166-1 alpha-2 code in upper case (`US`); a MARKET reference is the market code in lower-case kebab form (`la-oc`). Because resolution compares by exact string, non-canonical spellings are rejected at write time instead of never matching at read time.
- **Fail-closed validation.** An invalid reference is `VALIDATION_FAILED` (`details.reason` `SCOPE_REFERENCE_INVALID`, `scopeType`, `check`); a validator that throws (database outage) is `UNAVAILABLE` (`SCOPE_REFERENCE_UNAVAILABLE`). A write is never accepted on a reference that could not be verified. With no validator wired, both services behave exactly as before.
- **`MarketDefaultsProvider`** (declared in `packages/content/src/market-defaults.ts`): `defaultLocale(marketCode)` returns the default locale of an ACTIVE market in effect, or `null`; the optional `isVisible('COUNTRY' | 'MARKET', ref)` says whether the public geography API would show the reference (exists, ACTIVE and, for markets, in effect). Geography implements both (`createMarketDefaultsProvider`) over the public reads with a 60 s in-process memo (including negative answers) and serves the last value if the database errors. Content calls it when `context.market` is set and `marketDefaultLocale` is not, and merges the answer into the effective context BEFORE hashing, cache and last-known-good keys, the resolver query and the snapshot context, so keys and snapshots record what was used. An explicit `marketDefaultLocale` wins and skips the provider.
- **Degrade to the platform default, never fail a read.** A null, malformed or throwing `defaultLocale` means no market default (a warning with the market code only); the fallback chain continues to the platform default. A derived default that is not an ACTIVE locale is skipped by the chain, the request is not cached, and a snapshot drops it. Reads are public and hot, so unlike writes they favour availability.
- **Public content resolution consults geography for visibility, and fails closed.** `ContentService.resolveMany` for PUBLIC calls (`includeInternal === false`) calls `isVisible` for `context.country` and `context.market` and DROPS a member that is not visible (not ACTIVE, outside its effective window, unknown, or the check throws), before the context is hashed, cached or resolved. A PLANNED, INACTIVE or unknown market is then indistinguishable from no market, so anonymous callers cannot read copy of a market that is not live yet or probe which markets exist. Management callers (`content-read`) and snapshots are unfiltered. A provider without `isVisible` keeps the previous behaviour. The two degradations point in opposite directions on purpose: a failed default-locale lookup costs only a nicer fallback, while a failed visibility check must not expose unverified data, so the member is dropped and the read still succeeds with platform copy.
- **Existence is still not validated on resolve.** Resolution does not reject an unknown reference (it is dropped for public content or matches nothing); configuration resolution does not consult geography at all.
- **Wiring** is in `apps/api/src/index.ts`: one geography service, one validator shared by configuration and content, and the provider for content.

## Alternatives considered

- Foreign keys from `scope_ref` to `geography.countries` or `geography.markets`: `scope_ref` is polymorphic (eight scope levels, some without tables yet), the format is text for several domains, and the foreign key would make the lower registries depend on geography in the database. Rejected; a port gives the same existence check at write time.
- Importing the geography package from configuration and content: creates a package cycle (geography already depends on configuration) and couples the registries to a domain. Rejected.
- Validating existence at resolve time (rejecting an unknown or non-live reference): turns a geography outage into a content and configuration outage. Rejected; resolve stays authoritative on its own data and never fails because of geography. Visibility filtering is the part that was accepted instead, with a different failure mode (the member is dropped, the read succeeds), because without it an anonymous caller could read MARKET-scoped copy of a PLANNED market and tell it from an unknown one. It costs a memoized geography lookup when a public request names a country or market, and it makes a geography outage hide market-specific copy from public callers until geography answers or the memo is warm.
- Leaving public resolve unfiltered (the original design, in which resolve did not consult geography): simplest and fastest, but publishes prepared copy of markets that are not live. Rejected after review.
- Failing open for validation (accept the reference when geography is down): would admit unverifiable data into immutable, effective-dated versions. Rejected.
- Failing closed for the market default (error when geography is down): a reference-data hiccup would break page rendering for every market request. Rejected; the chain has a safe platform default.
- A generic event-driven copy of market data inside content: a second authority to keep in sync. Rejected.

## Consequences

COUNTRY and MARKET references are validated everywhere a registry accepts a write; the seeded PLANNED `la-oc` is accepted before it goes live so values can be prepared. DEBT-0024 is IN_PROGRESS: CATEGORY, PLAN, PROVIDER, GIG and DROP references are still unvalidated, and each future domain implements the same port. A market default change, and a market or country becoming visible or hidden, reaches public content within about a minute (the memo) plus the geography cache bound (DEBT-0033); the memo also holds negative answers, so a market that was just activated can keep resolving as platform copy for that long. A public request that names a country or market now touches the provider (memoized, so the cost is one lookup per reference per minute per process). The two services need the same wiring to behave the same way: forgetting to pass the validator disables validation silently, which is why `apps/api/src/index.ts` is the single place that builds it. Content's `ContentContext` still accepts an explicit `marketDefaultLocale` for callers that know better.

## Migration / compatibility

No schema change. Existing `scope_ref` values are not re-validated. Both ports are optional and additive: services created without them (tests, tools) are unchanged. Public content resolution drops a context member the provider reports as not visible; a provider without `isVisible` leaves it unchanged. Content's resolver query now orders its batch (`WITH ORDINALITY`) so batch order is deterministic. Content locale DTOs gained `displayName`, `language`, `script` and `region` (ADR-0021).

## Related files

- `packages/configuration/src/scope-reference.ts`
- `packages/configuration/src/service.ts`
- `packages/content/src/market-defaults.ts`
- `packages/content/src/service.ts`
- `packages/geography/src/scope-validator.ts`
- `packages/geography/src/market-defaults-provider.ts`
- `apps/api/src/index.ts`
- `docs/engineering/GEOGRAPHY.md`
