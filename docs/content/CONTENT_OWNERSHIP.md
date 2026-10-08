# Content Ownership

Who owns each human-readable string in BananaGig, and how a string moves into the content registry. The registry itself (model, lifecycle, resolver, cache, template language) is described in `docs/engineering/CONTENT.md`. This document is the inventory and the migration rules; update it in the same change that moves, adds or removes a string (step 7 below).

Last verified against the code: CFG-002 (scan of `apps/web/src`, `apps/api/src`, `apps/worker/src`, `packages/*/src`, `infra/keycloak`, `apps/smoke`).

## 1. Ownership categories

Not every literal gets a content key. A string is classified by who needs to change it and why, not by whether it contains words.

| Class | Meaning | Owner | Lives in |
|---|---|---|---|
| MANAGED_CONTENT | Text a user reads that the business may reword, translate, schedule or approve without a deploy: labels, messages, emails, push text, help, legal documents, marketing copy | Content, Support, Marketing or Legal (the entry's `owner_role`) | Content registry (`content.entries` and `content.versions`), resolved by key and locale |
| PROTOCOL | Machine contract text: error codes and categories, JSON field names, HTTP reason phrases, event and job names, query-string codes such as `error=login_failed`, header values | Engineering | Code and contracts; changing it is a versioned API/event change, never a content edit |
| DEVELOPER | Text for engineers and operators: log lines, exception messages, OpenAPI summaries, diagnostic pages (`/system`, `/health`, the `/session` identity table), smoke check names, role descriptions, test strings | Engineering | Code, English only, not localized |
| BOOTSTRAP | The tiny static set of user-visible strings that must render when the registry cannot be reached, so the product can still start a login, log out and show a generic failure | Engineering | Code (`BOOTSTRAP_COPY` in `apps/web/src/lib/content.ts` and the static web shells) |

Rules:

1. A string is MANAGED_CONTENT if a non-engineer could reasonably want to change its wording, or it must be localized. When in doubt about user-facing text, it is managed.
2. PROTOCOL and DEVELOPER strings never get keys. Putting an error code or a log line in the registry would make a contract editable by content staff and make logs untranslatable noise.
3. Registry-owned copy never falls back to a developer literal. When the registry is down a page omits the managed element; it does not substitute English from code.
4. BOOTSTRAP is deliberately tiny and only for: the wordmark `BananaGig` (a proper noun, brand), the two authentication controls `Sign in` and `Sign out` (so a signed-out user can still start a login and a signed-in one can log out when the registry is down; operators recover through them), the generic fatal-error shells (`error.tsx`, `not-found.tsx`, `loading.tsx`, which are client or error shells that cannot call the API) and accessibility-required labels. Bootstrap strings are static because the registry being unavailable must not make the product unusable, not because they are unimportant. Adding to this set requires updating this document and `docs/engineering/CONTENT.md`.
5. Legal documents are MANAGED_CONTENT entries of type LEGAL (Legal-owned, second approver, exact locale, never cached). They are never code literals.

## 2. Key naming rules

Format enforced by `ck_entries__key_format`: `^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$`, at most 160 characters. At least two dot-separated segments, lowercase, digits and underscores only.

Convention: `domain.area.name[.role]`

- `domain`: the product area that owns the copy (`brand`, `common`, `session`, `system`, later `booking`, `provider`, `legal`, `notification`).
- `area`: the screen, feature or kind within the domain (`action`, `status`, `error`, `home`).
- `name`: what the string is, in snake_case (`sign_in`, `login_failed`).
- `role` (optional): the part of a multi-part message when one concept needs several strings (`.title`, `.body`, `.cta`, `.subject`).

Keys are stable identifiers: never reused for a different meaning, never renamed (a rename is a new key plus deactivating the old entry). Wording changes are new versions of the same key.

| Good | Why |
|---|---|
| `common.action.sign_in` | domain, area, name |
| `session.error.login_failed` | names the situation, not the sentence |
| `booking.confirmation.email.subject` | optional role suffix for a multi-part message |
| `legal.terms.customer` | document identity, not its version or locale |

| Bad | Why |
|---|---|
| `common.action.sign_in.en_us` | encodes the locale; locale is a version attribute, never part of the key |
| `sign_in_to_your_account` | no domain segment, and it is the English text |
| `local_help_done_fast` | derived from the English wording; breaks the first time the wording changes |
| `home.title.v2` | encodes a version; versions live in `content.versions` |
| `Session.Status` | upper case and not matching the key format |
| `button1` | no meaning, no domain, fails the format |

## 3. Inventory of existing strings

Status values: MIGRATED (moved to the registry in CFG-002, key shown), STATIC BOOTSTRAP, PROTOCOL, DEVELOPER, DEFERRED (managed content not yet migrated; debt reference shown).

### apps/web

| File | String(s) | Class | Status |
|---|---|---|---|
| `app/page.tsx` | wordmark heading | MANAGED_CONTENT | MIGRATED `brand.name`; static `BOOTSTRAP_COPY.wordmark` is the only fallback (BOOTSTRAP) |
| `app/page.tsx` | tagline | MANAGED_CONTENT | MIGRATED `brand.tagline` (omitted if the registry is down) |
| `app/page.tsx` | platform initialization confirmation | MANAGED_CONTENT | MIGRATED `system.home.initialized` |
| `app/page.tsx` | links `System`, `Health` | DEVELOPER | DEVELOPER (infrastructure navigation, replaced by real navigation later) |
| `app/session/page.tsx` | signed-in and signed-out status | MANAGED_CONTENT | MIGRATED `session.status.signed_in`, `session.status.signed_out` |
| `app/session/page.tsx` | sign-in and sign-out controls | MANAGED_CONTENT | MIGRATED `common.action.sign_in`, `common.action.sign_out`; static `BOOTSTRAP_COPY.signIn` and `signOut` are the only fallback (BOOTSTRAP) |
| `app/session/page.tsx` | sign-in failure message (shown for `?error=login_failed`) | MANAGED_CONTENT | MIGRATED `session.error.login_failed` |
| `app/session/page.tsx` | page heading `Session`, metadata title `Session` | MANAGED_CONTENT | DEFERRED, DEBT-0029 (first customer screens) |
| `app/session/page.tsx` | identity table labels (`subject`, `roles`, `api sees`, `none`, `unavailable (...)`) | DEVELOPER | DEVELOPER (diagnostic) |
| `app/session/page.tsx` | query code `login_failed` | PROTOCOL | PROTOCOL (set by `lib/auth/handlers.ts`, maps to the key above) |
| `app/system/page.tsx` | heading, `api reachable`, `api unavailable`, field labels, metadata title | DEVELOPER | DEVELOPER (diagnostic page) |
| `app/health/page.tsx` | heading, `web: ok`, endpoint note, metadata title | DEVELOPER | DEVELOPER (diagnostic page) |
| `app/layout.tsx` | header wordmark, metadata title default and template, `applicationName` (`BananaGig`) | MANAGED_CONTENT | STATIC BOOTSTRAP (brand proper noun; the layout cannot await the registry on every shell render) |
| `app/layout.tsx` | `Skip to content`, `Primary` nav label | MANAGED_CONTENT | STATIC BOOTSTRAP (accessibility-required labels) |
| `app/layout.tsx` | nav link `Session` | MANAGED_CONTENT | DEFERRED, DEBT-0029 (first customer screens) |
| `app/layout.tsx` | metadata `description` (`Local help. Done fast.`) | MANAGED_CONTENT | DEFERRED, DEBT-0029 (duplicates `brand.tagline`; move with metadata generation) |
| `app/layout.tsx` | `<html lang="en">` | PROTOCOL | DEFERRED, DEBT-0026 (must follow the resolved locale once a second locale is active) |
| `app/error.tsx` | `Something went wrong`, `An unexpected error occurred.`, `Try again` | MANAGED_CONTENT | STATIC BOOTSTRAP (generic fatal-error shell, client component) |
| `app/not-found.tsx` | `Page not found`, `Back to start` | MANAGED_CONTENT | STATIC BOOTSTRAP (generic shell) |
| `app/loading.tsx` | `Loading…` | MANAGED_CONTENT | STATIC BOOTSTRAP (generic shell, accessibility status) |
| `app/manifest.ts` | `name`, `short_name` (`BananaGig`) | MANAGED_CONTENT | STATIC BOOTSTRAP (brand proper noun) |
| `app/manifest.ts` | `description` (`Local help. Done fast.`) | MANAGED_CONTENT | DEFERRED, DEBT-0029 (also DEBT-0003, manifest-only PWA) |
| `lib/auth/handlers.ts` | `Method not allowed`, `Forbidden` response bodies | PROTOCOL | PROTOCOL (HTTP reason text on non-browser-rendered auth endpoints) |
| `app/healthz`, `app/readyz`, `app/metrics` | JSON status fields | PROTOCOL | PROTOCOL |

### apps/api, apps/worker, apps/smoke, packages

| Where | String(s) | Class | Status |
|---|---|---|---|
| `apps/api/src/errors.ts`, `plugins/errors.ts`, `plugins/auth.ts`, `modules/*/dto.ts`, `modules/*/routes.ts` | error `code` and `category` | PROTOCOL | PROTOCOL (the client contract) |
| same | error `message` (for example `Authentication is required`, `Request validation failed`, `The content registry is temporarily unavailable`) | DEVELOPER | DEVELOPER; localization is DEFERRED, DEBT-0029 (API-error-localization checkpoint, see section 5) |
| `apps/api/src/app.ts`, `modules/*/routes.ts` | OpenAPI title, tags, `summary`, `description` | DEVELOPER | DEVELOPER |
| content and configuration entries as data | copy served by `/api/v1/content/resolve*` | MANAGED_CONTENT | registry data, not a code literal |
| `apps/worker/src/**` | log messages, job names (`content.activate-due`, `configuration.activate-due`, `infra.ping`), event names | DEVELOPER / PROTOCOL | DEVELOPER for logs, PROTOCOL for job and event names |
| `apps/smoke/src/index.ts` | check names, thrown messages | DEVELOPER | DEVELOPER |
| `apps/smoke/src/index.ts` | assertions that the session page contains `Signed in` and that `brand.name` and `brand.tagline` resolve to the seeded English | DEVELOPER | DEVELOPER (test coupling to seed `0006`; if seeded wording is versioned, update the smoke expectation) |
| `packages/content`, `packages/configuration`, `packages/identity`, `packages/platform`, `packages/database`, `packages/observability` | exception messages, log text, error categories | DEVELOPER / PROTOCOL | DEVELOPER for messages, PROTOCOL for codes and categories |
| `packages/contracts` | `ERROR_STATUS`, `CONTENT_ERROR_CODES`, `CONTENT_EVENTS`, field names | PROTOCOL | PROTOCOL |

### infra, email and notifications

| Where | String(s) | Class | Status |
|---|---|---|---|
| `infra/keycloak/bananagig-realm.json` | realm `displayName` (`BananaGig`) | MANAGED_CONTENT | STATIC BOOTSTRAP (brand proper noun, shown by the default login theme) |
| `infra/keycloak/bananagig-realm.json` | role and scope `description` text | DEVELOPER | DEVELOPER |
| Keycloak login, error and account screens | built-in English theme text | MANAGED_CONTENT | DEFERRED, DEBT-0019 and DEBT-0029 (see section 6) |
| Email and push | no templates, senders or delivery code exist (Mailpit is a dev-only mail sink; Keycloak `verifyEmail` is false) | MANAGED_CONTENT | DEFERRED, DEBT-0029 (NOTIF-001) |

## 4. What moved in CFG-002

Eight entries, seeded by `db/migrations/0006_content_seed_shell_copy.sql`, each with one PUBLISHED en-US PLATFORM version, owner CONTENT, PUBLIC, STANDARD, approval policy NONE, CHAIN fallback:

| Key | Type | en-US body | Read by |
|---|---|---|---|
| `brand.name` | UI_LABEL | BananaGig | `app/page.tsx` |
| `brand.tagline` | UI_LABEL | Local help. Done fast. | `app/page.tsx` |
| `common.action.sign_in` | UI_LABEL | Sign in | `app/session/page.tsx` |
| `common.action.sign_out` | UI_LABEL | Sign out | `app/session/page.tsx` |
| `system.home.initialized` | PLAIN_TEXT | Platform initialization successful. | `app/page.tsx` |
| `session.status.signed_in` | UI_LABEL | Signed in | `app/session/page.tsx` |
| `session.status.signed_out` | UI_LABEL | Not signed in | `app/session/page.tsx` |
| `session.error.login_failed` | PLAIN_TEXT | Sign-in could not be completed. Please try again. | `app/session/page.tsx` |

No translations were invented: only en-US exists, other locales resolve through the fallback chain to en-US (DEBT-0026). The seeded versions emit no outbox events and have five audit rows each (`ENTRY_CREATED`, `VERSION_DRAFTED`, `VERSION_APPROVED`, `VERSION_PUBLISHED`, `VERSION_ACTIVATED`). Seeded wording is changed by publishing a new version, never by editing the migration. Everything else in section 3 marked DEFERRED stays a code literal until its owning checkpoint (DEBT-0029).

### ID-001 additions

`db/migrations/0009_identity_accounts.sql` seeds 17 more entries through the real lifecycle (owner CONTENT, PUBLIC, STANDARD, approval policy NONE, CHAIN, PLATFORM scope): the role names `identity.role.customer.name` (Customer) and `identity.role.provider.name` (Provider), referenced by `identity.roles.name_content_key` and returned to clients as `roles[].nameContentKey`; the account status labels `account.status.pending`, `.active`, `.suspended`, `.closure_requested` and `.closed` (key = `account.status.` plus the status in lower case, `accountStatusLabelKey`); the session page labels `session.account.id`, `.status`, `.roles`, `.active_role` and the message `session.account.unavailable` (all used by `app/session/page.tsx`, which omits an element whose copy is missing and never substitutes hardcoded text); and the messages `account.error.name_required`, `.name_too_long`, `.name_invalid_characters` (the content keys of the profile name issue codes, `profileIssueMessageKey`), `account.error.suspended` and `account.error.closed`. The session page rows that predate ID-001 (subject, roles, api sees) remain infrastructure diagnostics. There is no key for a refused role switch (`/session?error=role` shows no message yet): per-message keys are not added speculatively.

### ID-002 additions

`db/migrations/0010_email_verification.sql` seeds 34 more entries through the real lifecycle (owner CONTENT, PUBLIC, STANDARD, approval policy NONE, CHAIN, PLATFORM scope): the verification email `account.email.verification.subject` (EMAIL_SUBJECT) and `.body` (EMAIL_BODY, typed variables `verification_code` STRING, `verification_url` URL, `expiry_minutes` COUNT; the first two marked SENSITIVE_PERSONAL), rendered by the API composition root (`createContentEmailRenderer`) and never written in code; the verification screen copy `account.email.verify.title`, `.intro` (variable `masked_email`), `.code_label`, `.submit`, `.resend`, `.resend_wait` (variable `seconds`), `.change`, `.sent`, `.success`; the magic-link page `account.email.link.title`, `.body`, `.confirm`, `.sign_in_required`; the status labels `account.email.status.none`, `.pending`, `.verified` (key = `account.email.status.` plus the status in lower case, `emailStatusLabelKey`); and the messages `account.email.error.*` (`required`, `too_long`, `invalid_format`, `invalid_characters`, `unsupported` are the issue codes, `emailIssueMessageKey`; `not_pending`, `code_invalid`, `link_invalid`, `code_expired`, `code_used`, `verification_locked`, `resend_too_soon`, `send_limit`, `unavailable`, `delivery_failed`, `rate_limited` are the error codes, `emailErrorMessageKey`). The web page `/verify-email` omits an element whose copy is missing and never substitutes hardcoded text (the sign-in label is the bootstrap exception).

### GEO-001 additions

- Country display name. `db/migrations/0007_geography_registry.sql` seeds one more entry through the real lifecycle (UI_LABEL, owner CONTENT, PUBLIC, STANDARD, approval policy NONE, CHAIN, PLATFORM scope; five audit rows, no outbox events): `geography.country.us.name`, en-US body `United States`. A country's display name is managed content, not a column: `geography.countries.display_name_content_key` is a foreign key to `content.entries (key)`, and consumers resolve it with the content API. Convention for later countries: `geography.country.<alpha-2 lower case>.name`, authored through the lifecycle (create the entry, then the country). Currency display names stay a column on `geography.currencies` (a stable English reference label, not localized copy). Locale display names (`content.locales.display_name`) are reference data, not copy.
- `marketDefaultLocale` is derived, not supplied. A caller that names a market in the context no longer needs to pass `marketDefaultLocale`: the content service derives it from the geography registry (an ACTIVE market in effect) and an explicit value, when given, wins (`docs/engineering/CONTENT.md`, ADR-0022). Do not build a market-to-locale table in a caller. Public callers also cannot see copy of a market that is not live: for anonymous resolution a `market` or `country` in the context that geography does not show publicly (PLANNED, INACTIVE, out of window or unknown) is dropped, so it behaves like no market; preparing MARKET-scoped copy for a PLANNED market is allowed (the reference validates) and becomes visible when the market is activated, within about a minute.

## 5. Migration strategy for later checkpoints

Apply these seven steps to every string a checkpoint touches:

1. Identify managed content. Classify each user-facing literal with section 1. Skip PROTOCOL and DEVELOPER text.
2. Create a stable key. Follow section 2, choose type, owner role, sensitivity, criticality and fallback policy, and define variables with example values (never interpolate with string concatenation).
3. Seed an initial version. Add it through a migration that uses the real lifecycle (as `0006` does), or through the management API for non-seed content. Never insert a PUBLISHED row directly.
4. Replace the literal with the resolver. Web uses `getContent` and `getContentMany`; services use `ContentService.resolveRendered`. Pass variables by name; pass the locale explicitly or let `getContent` negotiate it from `Accept-Language` against the public active-locale list (`GET /api/v1/content/locales`, memoized 30 s per web process, so a locale activation reaches negotiation within 30 s). Omit the element when the registry cannot serve it; do not add a literal fallback.
5. Test fallback and locale. Cover the served copy, a locale that falls back (for example `es-MX` to `en-US`), and the registry-unavailable path (copy omitted, bootstrap controls still present).
6. Remove the literal. Delete the hardcoded string and any test that asserts it in code; tests assert behavior or use the content stub.
7. Update this document. Move the row from DEFERRED to MIGRATED with its key, adjust the debt entry in `docs/project/TECH_DEBT.md`, and update the data-model documents if the schema changed.

### API error messages

The error `code` and `category` are the contract; clients branch on them, never on `message`. `message` stays English developer text (DEVELOPER) and is not shown to end users as-is. Customer-facing screens map `code` to a managed key (for example `session.error.login_failed` for the login failure code) and render that. Do not add per-message registry keys speculatively. Localizing API `message` itself, if it is wanted at all, is the job of a dedicated API-error-localization checkpoint (DEBT-0029), which must decide whether the API resolves messages by `Accept-Language` or whether clients keep mapping codes to keys. New error codes must be stable and documented in the OpenAPI spec before any UI depends on them.

## 6. Keycloak, email and notification copy

- Keycloak login, error and account screens: the default Keycloak theme and its built-in English strings are not registry-backed. Keycloak renders these from its own message bundles, so they are not resolved from the registry at render time. The owning checkpoint (the Keycloak theme decision, DEBT-0019) must decide how theme bundles are kept in step with registry wording; until then they are DEFERRED. The realm `displayName` stays the static brand name.
- Email: subject and body are MANAGED_CONTENT (types EMAIL_SUBJECT and EMAIL_BODY, owner by purpose: SUPPORT for transactional, MARKETING for promotional, LEGAL for legal notices). A notification service must resolve the template at send time with `resolveRendered` and persist the returned `versionId`, `resolvedLocale` and `bodySha256` with the message, so the exact wording sent is provable. Subjects are single-line; the renderer rejects newlines. No email or notification code exists yet (NOTIF-001).
- Push and in-app notifications: PUSH_TITLE and PUSH_BODY types, same rules. Recipient locale comes from the user's stored preference, not from the sending worker's environment.
- Legal notices and acceptance texts: LEGAL entries only. Acceptance records reference `content.versions.version_id` and `body_sha256`, never the text.
- Transactional emails sent by Keycloak itself (password reset, verification) follow the Keycloak rule above until the theme checkpoint.
