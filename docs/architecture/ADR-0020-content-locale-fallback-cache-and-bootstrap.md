# ADR-0020 — Content locale fallback, precedence, cache, last-known-good and bootstrap policy

Status: ACCEPTED
Date: 2026-10-06
Checkpoint: CFG-002

## Context

Content is read on every page and message, in many locales, and only one locale (`en-US`) has copy at launch. Resolution must be deterministic, fast, never show stale or substituted text where that is unacceptable (legal and disclosed copy), and the system must stay usable, and recoverable by operators, when the database or Valkey is unavailable. PostgreSQL is authoritative (ADR-0001) and Valkey is non-authoritative (ADR-0003); ADR-0017 set the equivalent policy for configuration.

## Decision

**Fallback chain** (per entry `fallback_policy`), with `trunc(tag)` being progressive truncation (`zh-Hant-TW` gives `zh-Hant-TW, zh-Hant, zh`):

- CHAIN: `dedupe(trunc(requested) ++ trunc(marketDefaultLocale?) ++ trunc(platformDefault))`.
- LANGUAGE_ONLY: `trunc(requested)`.
- EXACT: `[requested]`.

Only ACTIVE locales are considered, and the reported chain is the filtered one. The market default is supplied by the caller in the context until geography exists; the platform default is the default row of `content.locales` (at most one by the unique index, never unset by the guard trigger; if none exists the resolver raises `UNAVAILABLE` with reason `NO_PLATFORM_DEFAULT`). Locale tags are canonical BCP 47 (`language[-Script][-REGION]`); invalid or padded tags are rejected, not repaired. LEGAL entries are forced to EXACT: a document is never shown, or recorded as accepted, in a language the person did not request.

**Precedence**: chain position first, then scope specificity (MARKET over COUNTRY over PLATFORM) within the same locale, with scopes applicable only when the context carries them. A version in an earlier chain locale at PLATFORM beats a fallback-locale version at MARKET. Tie-breakers (higher version, then id) exist only for determinism; ties are prevented by the exclusion constraint. No candidate gives `NO_CONTENT`, which is authoritative.

**Resolution** takes three queries per batch independent of key count (entries with variables and locale data, published candidates for the union of chain locales and applicable scopes, the next effective boundary).

**Cache**: the resolved, un-rendered entry is cached in Valkey per entry key, entry generation, locale generation, requested locale and context hash, valid until the next effective boundary and capped by the configuration TTL setting (30 seconds; no new environment variables). Publication, activation and entry (de)activation bump the entry generation after commit; any locale change bumps the locale generation. Rendering happens per call, so personal data never enters the cache. CRITICAL and LEGAL entries are never cached and never served from last-known-good. Requests with `at` and snapshots bypass cache and last-known-good. Only requests whose key space is bounded by operator-controlled data are cached: the requested locale and the market default locale must be active and every context scope reference must match a published version of the requested entries; any other request is served from the database every time and writes neither a resolution entry nor a last-known-good entry, so anonymous callers cannot grow the key space. Cache I/O is bounded: the Valkey adapter applies a 100 ms timeout per command and a 5 second circuit breaker per `ValkeyConfigCache` instance (the API and worker create one instance per registry, so configuration and content have separate breakers), and the content cache adds a 250 ms deadline per call and parallel writes. Generation counters are plain Valkey keys: under `allkeys-lru` pressure one can be evicted and read as 0 again, and a bump lost during an outage is not retried, so staleness in both cases is bounded by the 30 second TTL.

**Last-known-good** is used only when the database cannot be reached (connection, pool, timeout, shutdown; SQL and programming errors are not outages), only for STANDARD entries, only within the configuration maximum age (86400 seconds), only before the copy's own end, and all-or-nothing per batch. A definitive "no content" or "unknown entry" is never replaced. Otherwise the call fails with `UNAVAILABLE`. A Valkey outage degrades to database reads and never changes a result.

**Bootstrap**: registry-owned copy never falls back to developer-hardcoded text. When the registry cannot serve a key the caller omits the copy. The only static copy is the bootstrap set: the wordmark, the authentication-control labels `Sign in` and `Sign out`, the generic error, not-found and loading shells, and accessibility-required labels. Anything else needs a documented change to the bootstrap set.

**Visibility**: callers without `content-read` resolve only PUBLIC entries and never the template or `at`; INTERNAL entries are indistinguishable from unknown ones to them (`ENTRY_NOT_FOUND`, also when the INTERNAL entry has no effective content), and `effectiveTo` is returned as null to them.

## Alternatives considered

- Always fall back to the platform default locale (including legal): can present, and record acceptance of, a document in the wrong language.
- Scope first, then locale: a generic MARKET override in a fallback language would hide an exact-locale PLATFORM translation; chain position first respects the reader's language.
- BCP 47 lookup with arbitrary extensions, variants or `u-` keys: unneeded surface; the subset is enforced by contract, CHECK and tests, and can be widened later.
- Hardcoded default strings in code as the fallback: unapproved, never localized, invisible to the registry and a second source of truth; the omit rule is simpler and honest.
- Serve last-known-good on any error or for CRITICAL copy: would hide missing content and could serve withdrawn or unapproved legal or disclosed text.
- Cache the rendered output: bakes personal data into the cache and multiplies keys by variable values.
- Pub/sub invalidation: more moving parts; generation counters give the same effect with one key per entry and one for locales.
- Cache everything with a fixed TTL: would serve copy past its effective boundary.

## Consequences

Correctness never depends on the cache, the activation job or Valkey. During a database outage, standard UI copy continues from last-known-good for up to a day while legal and critical copy fail visibly. A page may omit a label during a registry outage instead of showing a stand-in; this is deliberate and operators recover through the bootstrap login controls. A locale without content for an EXACT or LANGUAGE_ONLY entry yields `NO_CONTENT`, so legal flows block until the translation is published. Cross-instance invalidation relies on the shared generation counters (same limits as DEBT-0022, and bounded by the TTL if a counter is evicted). The web app negotiates the requested locale against the public active-locale list (memoized 30 seconds per process), so a locale activation reaches negotiation within 30 seconds; `<html lang>` stays static (DEBT-0026). Market default locales come from callers until geography exists (DEBT-0029). The fallback policy of an entry cannot be changed after creation.

## Migration / compatibility

None beyond migration `0005_content_registry.sql` (policy columns and CHECKs). Reuses the cache primitives and settings from the configuration package; no new environment variables.

## Related files

- `packages/content/src/locale.ts`
- `packages/content/src/resolver.ts`
- `packages/content/src/cache.ts`
- `apps/web/src/lib/content.ts`
- `apps/web/src/lib/locale.ts`
- `docs/engineering/CONTENT.md`
