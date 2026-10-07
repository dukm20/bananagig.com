# ADR-0024 — Provider-neutral address boundary, manual fallback, and address privacy rules

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: GEO-002

## Context

Entering an address is easier and more accurate with autocomplete and geocoding, and a verification service can confirm deliverability. The PRD names such a partner as an open decision and configures the provider per country (`address.autocomplete_provider`, `address.geocoder`), requires that entry still works when a provider is down and that a hand-typed address is marked for review (SV-10.06), and treats the exact address as sensitive until a booking is confirmed. No vendor is selected, vendor terms (what may be stored, billing, country coverage) are a business decision, and tests must never depend on the network.

Addresses are personal data. The platform logs structured, redacted events and forwards logs to a collector, so one careless log line would copy an address or coordinates out of the database. The address model itself is decided in ADR-0023.

## Decision

**Provider-neutral ports, mocks, no vendor.** `packages/geography/src/address-providers.ts` declares three ports: `AddressAutocompleteProvider` (`suggest`, `resolve` a selection to structured fields), `GeocoderProvider` (`geocode` to a point, an optional IANA time zone and a reference) and `AddressValidationProvider` (a verification verdict). Each has a lower-case adapter `code` (stored as `provider_code`). Deterministic in-memory mocks (no network, a `failing` flag, a call log) are what tests and CI use. Providers are resolved by `providers.autocomplete|geocoder|validation(countryCode)` handed to `AddressService`; selecting the provider per country from configuration (COUNTRY scope) is deferred, as is the verification service flow, which has a fixed contract and a mock only (DEBT-0037). The ports are the only place a vendor adapter will plug in; geography never imports a vendor SDK.

**Manual fallback always works; a provider never fails a flow.** Every provider call has a deadline (default 3000 ms); an error, a timeout or an unusable answer is treated as unavailable. A resolved suggestion is validated against the country format like any typed input, never trusted as is. Geocoding that does not locate the address (no provider, provider down, not found, coordinates outside the valid range) stores the address exactly like a manual one: source `MANUAL`, status `UNVERIFIED`, no coordinates. Manual entry is stored `UNVERIFIED`, which marks it for review and never pretends to be geocoded; an autocomplete selection is stored `FORMAT_VALID` (a selection is not verification); only a geocoder is `GEOCODED`; `VERIFIED` is reserved for a verification provider or an administrator. The autocomplete flows answer `UNAVAILABLE` (reasons `NO_AUTOCOMPLETE_PROVIDER`, `PROVIDER_UNAVAILABLE`) so the caller falls back to manual entry. A time zone from a geocoder is stored only as a reference to a registered ACTIVE `geography.time_zones` row; an unknown zone is dropped with a warning that names the provider only.

**Privacy rules.**

- No address value is ever logged: not a part, a postal code, coordinates, `raw_input`, the formatted text, a rejected value, a provider payload or provider error text. Logs about addresses carry codes only (provider code, operation, country code). Two guards back the discipline: `redactAddress` in the engine (replaces every address key at any depth) and the observability log redaction, which redacts any attribute whose key contains `address`, `postal`, `zip`, `latitude`, `longitude` or `raw_input` in addition to secrets. Adapters must never log what they receive.
- Validation issues carry the input property and a code, never the value; errors never echo input (the strict body check lists paths only).
- `POST /addresses/validate` and `POST /addresses/format` are stateless: they persist nothing, log nothing, accept at most 16 KiB and answer `Cache-Control: no-store`.
- There is NO public route that creates or reads a persisted address. Persisted addresses are used in process by the owning domains through `AddressService`; `getAddress` returns `raw_input` only on request. Exposing a persisted address, and deciding who may see an exact address at which booking stage, belongs to the identity and booking checkpoints (DEBT-0036).
- Patterns that come from the database are vetted at draft time and run against input capped by the field maximum length (DEBT-0042 for the residual risk).

## Alternatives considered

- Choosing a vendor now: a business and legal decision (storage terms, billing, coverage) that does not belong in this checkpoint; the ports let the choice be made later without touching the model. Rejected for now.
- Calling a vendor SDK directly from the service: couples the domain to one vendor and makes tests depend on the network. Rejected.
- Failing the request when the provider is down: would block account creation and booking. Rejected; manual entry is the guaranteed path and is marked for review.
- Treating an autocomplete selection as verified: autocomplete confirms the text exists, not that the place is deliverable or that the customer owns it. Rejected; `FORMAT_VALID`, never `VERIFIED`.
- Trusting provider fields without re-validation: a provider can return a shape the country format does not allow. Rejected; every resolved suggestion passes the country validator.
- Per-country provider selection read from configuration now: the configuration keys and a vendor do not exist yet; a resolver function keeps the seam. Deferred (DEBT-0037).
- A public `GET /addresses/:id` (or a create route): the exact address is sensitive and no owning domain or access policy exists. Rejected for now.
- Logging addresses at debug level for support: an address in the log pipeline is a copy that cannot be erased or access-controlled like the table. Rejected; the redaction is unconditional.
- Redaction only in the logger: depends on key names. Kept as the second guard; the first is not putting address values in log attributes at all.

## Consequences

Entry works without any provider, and every address records how far it was validated. Manual and fallback addresses carry no coordinates, so anything that needs a location (service areas, distance) must handle `UNVERIFIED` rows until the provider checkpoint exists; the review workflow for them is a later concern. Residual risks, recorded rather than hidden: no retention, erasure or stage-based exact-location access policy (DEBT-0036); the public validate and format routes are unauthenticated and have no rate limiting (DEBT-0030); a vendor adapter must be reviewed for storage terms and for logging before it ships (DEBT-0037); redaction by key name can miss an address placed under an unrelated key, which is why code must not log address values at all; database-supplied patterns run in the API process (DEBT-0042). The mocks are deterministic, so contract tests written against the ports will validate a real adapter later.

## Migration / compatibility

No schema change beyond ADR-0023's migration. The log redaction regex in `packages/observability/src/index.ts` was widened (keys containing `address`, `postal`, `zip`, `latitude`, `longitude`, `raw_input`); existing log attributes with such keys are now redacted. `AddressService` takes optional providers: with none configured the behavior is the manual path.

## Related files

- `packages/geography/src/address-providers.ts`
- `packages/geography/src/address-service.ts`
- `packages/geography/src/address-engine.ts`
- `apps/api/src/modules/geography/address-routes.ts`
- `packages/observability/src/index.ts`
- `docs/engineering/ADDRESSES.md`
- `docs/architecture/ADR-0023-canonical-immutable-address-and-data-driven-format.md`
