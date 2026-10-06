# Content and localization registry

## Purpose

Read, define and change managed product copy (UI text, messages, email and push templates, help and legal documents) through the registry instead of hardcoding user-facing strings.

## When to use

- A screen, email, push message, error sentence shown to a person, help article or legal document needs text that people can read, localize or change.
- Defining a content entry or variable, adding a locale, or changing fallback, approval or scope policy.
- Rendering copy with variables (names, counts, money, dates) or recording which exact text a person saw or accepted.
- Touching the `content` schema, its API, events, cache, activation job or the web content helpers.
- Deciding whether a string is managed, protocol or developer text.

## Canonical files

- `db/migrations/0005_content_registry.sql`, `db/migrations/0006_content_seed_shell_copy.sql`, `docs/data/DATA_DICTIONARY.md`
- `packages/content/src/service.ts`, `resolver.ts`, `cache.ts`, `locale.ts`, `template.ts`, `format.ts`, `markup.ts`, `errors.ts`
- `packages/contracts/src/content.ts`
- `apps/api/src/modules/content/routes.ts`, `apps/api/src/modules/content/dto.ts`, `apps/api/src/plugins/auth.ts`
- `apps/worker/src/jobs/content.ts`
- `apps/web/src/lib/content.ts`, `apps/web/src/lib/locale.ts`
- `docs/engineering/CONTENT.md`, `docs/content/CONTENT_OWNERSHIP.md` (inventory of existing strings and migration rules)

## Architecture rules

- Managed copy lives in the registry, never in code, env vars or flagd (ADR-0018). Business values belong in the configuration registry, not here.
- Three kinds of string. Managed: anything a customer, provider or admin reads as part of the product (labels, messages, templates, help, legal). Protocol: error codes, enum values, event types, JSON keys, header names, paths; they stay in code and are never localized. Developer: logs, exceptions, diagnostics, test fixtures; English, in code. Gig, provider and category text is domain data owned by the domain's tables, not content.
- Key naming: `domain.area.name`, lower-case letters, digits and underscores in dot-separated segments, at most 160 characters (`session.error.login_failed`). The key never encodes a locale or the wording. Entry identity and policy are immutable; a different policy is a different entry.
- Localization: locales are a canonical BCP 47 subset (`en-US`, `es`, `zh-Hant-TW`), strict (no underscores, no padding). Authoring needs a registered locale, serving needs an active one. Only `en-US` exists; never invent translations. The platform default locale is at most one by unique index and can never be unset (guard trigger); a migration moves it by disabling the guard inside its own transaction. With no default the resolver raises `UNAVAILABLE` (`NO_PLATFORM_DEFAULT`).
- Fallback is per entry (ADR-0020): CHAIN = requested, its language, the caller's market default, the platform default; LANGUAGE_ONLY = requested and its language; EXACT = requested only. Chain position beats scope specificity. LEGAL is always EXACT, CRITICAL, second approver.
- Registry-owned copy never falls back to a hardcoded literal. When the registry cannot serve a key the caller omits the copy. The only static copy is the bootstrap set (wordmark, `Sign in`, `Sign out`, the error and loading shells, accessibility labels).
- Template safety (ADR-0019): the language is restricted and internal: literal text, `{name}`, `{{`/`}}`, and one `{name, plural, ...}` construct on COUNT variables. No expressions, helpers, includes or inline format arguments. Control characters U+007F to U+009F (C1) are rejected like the C0 ones. Single-line types are limited to 500 characters in the source and again on the rendered output (`LIMIT`, `rendered: true`). Authoring dry-renders in at most 6 rounds (every plural branch at least once), not once per category. Markup types render a restricted Markdown subset to allow-listed HTML; variable values are inserted only as escaped text after parsing; links are limited to https, http, mailto, tel or a root-relative path. Add no template or sanitizer dependency.
- Effective dating: half-open `[effective_from, effective_to)` derived from timestamps, never a stored current flag. Versions and their text are immutable; correct with a new version going forward. A higher-numbered published version makes a lower one stale (`CONFLICT`). The activation job only advances the workflow label; an immediate publish first activates any due SCHEDULED predecessors (audit by `system:content-activation`, events) before superseding them.
- Legal content: LEGAL entries need `content-legal` on top of the normal role (including entry activation; locale activation is content-write only, DEBT-0028), a second approver, are never cached, never served from last-known-good and never fall back. Records that must prove what a person accepted store `versions.version_id` and `body_sha256`.
- Snapshots only where reproduction matters (accepted legal text, disclosed booking or financial copy, transactional messages). Never snapshot routine UI labels. A snapshot stores version pointers, not copies and not variable values. Items carry no `effectiveTo` (it changes when a successor is published); only text, version, versionId, bodySha256, effectiveFrom, scope and locale are fixed and a read-back is byte-stable. `createSnapshot` rejects `at` later than the database clock plus 5 s (`AT_IN_FUTURE`).
- Cache: the resolved, un-rendered entry is cached per key, locale and context; generations (per entry, per locale set) are bumped after commit. CRITICAL and LEGAL entries are never cached or served from LKG; `at` lookups bypass both; LKG applies only when the database is unreachable, only to STANDARD entries, all-or-nothing, within the max age. Valkey failure never changes a result. Only active-locale, matched-context requests are cached (inactive locale or `marketDefaultLocale`, or a context reference matching no published version of the requested entries, is served from the database every time and never written to the cache or LKG). Cache I/O is bounded: `ValkeyConfigCache(client, { commandTimeoutMs, breakerCooldownMs, now })` gives 100 ms per command and a 5 s circuit breaker per instance (configuration and content each have their own instance), content adds a 250 ms deadline per call and parallel writes. Generation counters can be evicted under `allkeys-lru` and reset to 0; staleness is then bounded by the 30 s TTL.
- Visibility: callers without `content-read` resolve PUBLIC entries only, never the template, never `at`; INTERNAL entries behave as not found for them (`ENTRY_NOT_FOUND`, also when they have no effective content) and `effectiveTo` is null. `resolve-many` has a 500000-character total template budget for all callers (400 `CONTENT_RESPONSE_TOO_LARGE`).
- Permissions are the temporary client-role model (`content-read`, `content-write`, `content-approve`, `content-legal`; DEBT-0028). Do not build on it as the long-term design.

## Implementation pattern

1. Decide ownership (managed, protocol or developer). If managed, find an existing key before adding one.
2. Define the entry in the owning checkpoint (`createEntry` or `POST /api/v1/content/entries`): key, content type, owner role, sensitivity, criticality, approval and fallback policy, `max_scope_type`, and every variable with type, description, PII class and a conforming example. Seed through the lifecycle (draft, approve, publish), never by inserting PUBLISHED rows or editing an applied migration.
3. Read in the web: `getContent` or `getContentMany` from `apps/web/src/lib/content.ts`; render with `renderContent`; omit on `undefined`. Read in a service: `content.resolveRendered(keys, { locale, context, variables })`.
4. Notifications (NOTIF-001): resolve with `resolveRendered`, persist `versionId` and `bodySha256` with the message, treat `missing` as not sendable.
5. Record: `createSnapshot({ keys, locale, context, purpose }, actor)` only for the cases above, and store the snapshot id.
6. Change copy: create a draft version per locale, submit, approve, publish (a future start becomes SCHEDULED and is served from its instant).
7. After changing the API or events, run `pnpm specs:generate` and the spec checks.

## Commands

```bash
pnpm --filter @bananagig/content test
pnpm test:integration                 # real PostgreSQL (and Valkey when reachable)
pnpm specs:generate && pnpm specs:check
pnpm data-model:check <CHECKPOINT>    # after any change to the content schema
pnpm smoke                            # includes the Content Registry scenario
```

## Testing requirements

- Unit: key and locale validation, fallback chains, resolver precedence, template parsing, missing and unknown variables, money formatting from minor units, markup sanitization with the XSS vector corpus, cache and LKG policy.
- Integration (real database): lifecycle and approval policies, self-approval refused, timeline and stale-version rules, overlap and concurrent publish, immutability triggers (published and legal), 3 queries per batch, snapshot stability after later edits, audit and outbox rows, cache invalidation, outage and LKG rules. The real-Valkey test self-skips when Valkey is unreachable; say so in reports.
- API: visibility (PUBLIC against INTERNAL), 401 before 400, 403 for missing roles and for `at` or `includeTemplate` without `content-read`, error mapping without copy in details.
- Web: the page reads copy through the API, locale negotiation, copy omitted (not replaced) when the registry is down, no database or content-package import in `apps/web`.
- Use `devtest.*` keys only in tests; they exist only when `allowTestKeys` is on.

## Data-model considerations

Any change to `content.*` goes through the Data Model Review Gate (normalization log, dictionary, ERD, snapshot). Do not add a stored current flag, a default-text column, locale-specific keys, a second scope hierarchy, a table of legal documents separate from entries, or foreign keys from `scope_ref` into domain tables without an ADR. The deliberate copy of `approval_policy` on `versions` records the policy that governed that version. History is retained; there is no purge (DEBT-0025).

## Common failure modes

- `NO_CONTENT` (404): nothing effective now in any chain locale: a future-dated first version, an EXACT or LANGUAGE_ONLY entry without that locale, the locale inactive.
- `ENTRY_NOT_FOUND` (404): unknown or inactive key, or an INTERNAL entry requested by a caller without `content-read`.
- `CONFLICT` (409) on publish: stale version (a higher-numbered one is published), a start at or before the head, or an overlap with an explicit end.
- `TEMPLATE_ERROR` (400): syntax, `UNKNOWN_VARIABLE`, `MISSING_REQUIRED_VARIABLE`, `INVALID_VARIABLE_VALUE`, `UNSAFE_LINK`, `PLURAL_REQUIRES_COUNT`, `CONTENT_TYPE_RULE`, `LIMIT` (also at render time for single-line output over 500); the reason and position are in `details`, never the text or value.
- `FORBIDDEN_APPROVER` (403): the author approving under SECOND_APPROVER, or a non-author submitting or cancelling.
- `UNAVAILABLE` (503): database unreachable with no safe LKG (CRITICAL, LEGAL, never resolved before, or a mixed batch), or no platform default locale (`NO_PLATFORM_DEFAULT`).
- 400 `PATH_PARAMETER_TOO_LONG` or `BAD_URL`: router-level rejection (path parameter over 192 characters) in the standard envelope.
- A page missing a label: by design the registry was down or the key has no content; do not add a literal fallback.
- Cached copy outliving a change after a Valkey outage or an evicted generation counter: bounded by the TTL (30 s) and generations; use `at` for an authoritative read.

## Known BananaGig-specific lessons

- Resolution derives the current version from timestamps, so a late activation job never shows wrong copy; the job only advances the label and notifies.
- `resolve-many` returns only the keys it could serve; compare with the requested keys instead of expecting an error.
- The sentinels U+E000 and U+E001 delimit placeholders internally and are rejected in sources and values; never reuse them.
- Contracts' `canonicalizeLocale` is strict and does not trim; callers pass clean tags.
- Never format money with Number division; build the decimal string from minor units with BigInt and let `Intl.NumberFormat` format it.
- Guards run in `preValidation` so unauthenticated callers get 401 before body validation; Fastify must keep `removeAdditional: false`.
- Variable values and copy never go into events, logs, audit rows or error details.
- Audit rows carry `locale` only for `LOCALE_*` actions (`ck_audit_events__subject`); version actions reach the locale through the version. Seeded versions (migration 0006) emit no outbox events and have five audit rows each.
- Web locale negotiation uses the public active-locale list (`GET /api/v1/content/locales`, memoized 30 s per process); `<html lang>` is still static (DEBT-0026).

## Do not

- Do not hardcode user-facing strings, or write `getContent(...) ?? 'literal'` for managed copy.
- Do not put business values (prices, fees, windows) in content, or marketplace text (gig, provider, category) in the registry.
- Do not add a template engine, markdown or sanitizer library, or any helper, include or expression to the template language.
- Do not cache or fall back for CRITICAL or LEGAL entries, or serve them from last-known-good.
- Do not read or write `content.*` tables from other domains; use the service or the API.
- Do not edit a published version or an applied migration; publish a new version.
- Do not inject a registry value as HTML unless its format is `html`.
- Do not use the temporary client-role permissions as the long-term model (DEBT-0028).

## Related ADRs

ADR-0018, ADR-0019, ADR-0020 (builds on ADR-0001, ADR-0003, ADR-0012, ADR-0016, ADR-0017)

## Last reviewed

2026-10-06 (CFG-002)
