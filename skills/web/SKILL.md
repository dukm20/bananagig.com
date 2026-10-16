# Web (Next.js App Router)

## Purpose

Build web UI and the server-side API client without breaking the workspace boundaries.

## When to use

- Adding a page, layout, route handler, or client component.
- Changing how the web app calls the API.
- Changing the web container or dev workflow.

## Canonical files

- `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/system/page.tsx`
- `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/server.ts`, `apps/web/src/instrumentation.ts`, `apps/web/src/lib/auth/handlers.ts`, `apps/web/src/lib/auth/runtime.ts`, `apps/web/src/app/session/page.tsx`, `apps/web/src/app/auth/active-role/route.ts`, `apps/web/src/testing/account-stub.ts`
- `apps/web/next.config.ts`, `apps/web/src/web.test.tsx`
- `Dockerfile` (target `runtime-web`)
- ID-004: `apps/web/src/lib/auth/{device,security-handlers}.ts`, `apps/web/src/app/{security,forgot-password}/page.tsx`, `apps/web/src/app/auth/{security/[action],password-reset,revoked}/route.ts`, `apps/web/src/security-handlers.test.ts`, `apps/web/src/security.test.tsx`

## Architecture rules

- App Router with server rendering by default; client components only when needed.
- The web app imports only `@bananagig/contracts`, `@bananagig/config`, `@bananagig/identity` and `@bananagig/observability`. It never imports `database`, `platform`, pg, kysely or pg-boss (lint and `pnpm deps:check` fail). It may use Valkey for session records only.
- All data comes from the API through `createApiClient` (`/api/v1`, correlation id propagated, errors parsed to `ApiError`). Server code reads config lazily via `serverConfig()` (never at import time, or `next build` breaks).
- Persona shells (customer/provider/admin) will be route-group layouts wrapping `children`; none exist yet.
- Authentication is a server-side session (ADR-0014): `/auth/login`, `/auth/callback`, `/auth/session`, POST `/auth/logout` implemented as plain Request->Response functions in `apps/web/src/lib/auth/handlers.ts`. The browser holds only opaque HttpOnly cookies; tokens never reach it. Never use localStorage, sessionStorage or JS-readable cookies for auth (a test scans the source). Redirects use `WEB_PUBLIC_URL`, not the request host. Read the session with `getSession(cookieHeader, authDeps())` and call the API with the session's bearer token via `serverApi(accessToken)`.
- The application role a signed-in person acts as (ID-001, ADR-0026) is session state on the SERVER: `SessionRecord.activeRole` in the Valkey session record, never a cookie, a URL or browser storage. The switch is the BFF route `POST /auth/active-role` (`handleActiveRole`): POST only, `Origin` must equal the web origin (like logout), the role is a form field, the server calls the API's `POST /api/v1/account/active-role` with the session token and stores the role only when the API confirms it, then answers 303 to `/session` (a refusal redirects to `/session?error=role` and changes nothing). Every server-side account read sends the remembered role as `x-active-role`; the API validates it on every request, so the stored role is a hint, not authority. A remembered role the API refuses (`ACCOUNT_ROLE_NOT_HELD`, `ACCOUNT_ROLE_NOT_ACTIVE`) is forgotten. Switching role never touches the Keycloak session or any token.
- The `/session` page (infrastructure, no account screens yet) shows the account id, status, application roles and active role and a switch for each other held role; labels, status names and role names are managed content keys (`session.account.*`, `account.status.*`, `identity.role.*.name`), omitted when the registry cannot serve them, and `session.account.unavailable` shows when the account could not be loaded. The web app reaches the account only through `getAccount`, `setActiveRole` and `updateProfile` of the API client; it never imports `@bananagig/accounts`.
- Keep the accessibility baseline: skip link, landmarks, `role=status/alert`, focus styles.
- Security actions (ID-004, `docs/engineering/SESSIONS_AND_MFA.md`): the `/security` page (server component, `force-dynamic`, copy only from the registry) posts no-JS forms to `POST /auth/security/<revoke-session|revoke-all|trust-device|untrust-device|remove-device|mfa-enroll>` (`handleSecurityAction`): POST only, `Origin` = web origin, session required, EXACTLY the action's fields (an unknown or repeated field or a value outside its closed set is a 400), every result a 303 back to `/security?notice=<word>` or `?error=<API code>`, never a submitted value in a redirect, cookie or log. The page maps only known words to registry keys; an unknown error word shows the generic "unavailable" copy, and a "factor set up" notice is shown only when the overview proves a factor exists.
- A `401 STEP_UP_REQUIRED` becomes ONE login round trip (`/auth/login?returnTo=/security&stepUp=recent|mfa`); coming back does not repeat the action. `handleLogin` accepts only closed-list `stepUp` / `kcAction`, records the step-up in the login transaction and the callback verifies the VERIFIED token reached it (no second trip; the page gets `error=step_up_required`). `kcAction` is honoured only when `takeEnrollment(sessionId)` returns the one-shot marker `mfa-enroll` stored after the API accepted the request; it forces `prompt=login`. The callback appends the whitelisted `kc_action_status` to the return URL.
- A `401 SESSION_REVOKED` ends the session: `endRevokedSession` deletes the Valkey session, clears the cookie and goes through Keycloak's end-session endpoint to `/session?error=session_revoked` (the URI is registered in the realm); a PAGE cannot clear a cookie while rendering, so it redirects to `GET /auth/revoked`, which asks the API again with the session's own token and ends the session only if the API confirms. Logout first tells the API (best effort, 2 s). Token refresh is single-flight per session id (`getSession`), because the realm rotates refresh tokens and tolerates one reuse; it is per process (DEBT-0069).
- The device cookie (`bg_device` / `__Host-bg_device`, HttpOnly, SameSite=Lax, 400 days, 43 base64url chars from `randomToken(32)`) is minted and renewed at login (`ensureDeviceSecret`), sent to the API ONCE in a request body (`registerSession`, best effort 2 s) and never stored in Valkey, a URL, a redirect or a log; when the API answers `deviceId: null` for a secret that was not minted in this request (a removed browser), mint a new one and register once more; removing the current browser clears the cookie. The public password-reset handler forwards the last `x-forwarded-for` entry and always shows the same registry text for an accepted request.
- Acceptance forms (ID-005, `apps/web/src/app/consents/page.tsx`, PRD R-13): a page that asks a person to accept a legal document gets the version in force from the API (`document`: entry key, version id, locale, hash), fetches the text from the PUBLIC content resolver and offers the Accept form ONLY if the resolver's `contentType` is LEGAL, `resolvedLocale` equals the document's locale and BOTH `versionId` and `bodySha256` equal the API's (and the value is non-empty). Otherwise it shows the registry's "unavailable" note and NO form. The hidden fields (`purpose`, `versionId`, `locale`, `bodySha256`) are taken from that verified document and re-verified by the API; no checkbox, nothing pre-ticked or auto-submitted, no script, and no GET that changes state. `format: 'html'` values render as the content layer does; a `text` value is never injected unescaped.
- Consent BFF handlers (`apps/web/src/lib/auth/consent-handlers.ts`, template `security-handlers.ts`): POST only, `Origin` must equal the web origin, signed-out is `303 /session`, `strictForm` with EXACTLY the action's fields (a missing, extra, repeated or malformed field is 400 and changes nothing), results are `303 /consents?notice=<closed word>` or `?error=ACCOUNT_CONSENT_<CODE>` from a closed list (anything else `API_ERROR`), `SESSION_REVOKED` ends the session, no step-up. A notice word in the URL is shown only when the data proves it, and an unknown error word shows the generic message.

## Implementation pattern

1. New page: `apps/web/src/app/<route>/page.tsx` (server component); export `metadata`; fetch via `serverApi()` and render a graceful state when the API is down.
2. New API call: add a typed method to `createApiClient` that validates with the contracts schema.
3. Add a render test and a client test (stub HTTP server) in `apps/web/src`.
4. Verify in a container: `pnpm stack:all`, open `http://app.localhost:8080`, `pnpm smoke`.

## Commands

```bash
pnpm dev                     # web http://localhost:3210 with hot reload
pnpm --filter @bananagig/web test
pnpm --filter @bananagig/web build
```

## Testing requirements

- Render tests use `react-dom/server` (`apps/web/vitest.config.ts` enables the automatic JSX runtime).
- API client tests run against an in-process HTTP server that returns contract-valid bodies; true end-to-end coverage is the smoke check "Web -> API (SSR /system)".
- Acceptance pages and handlers (ID-005, `apps/web/src/consent-handlers.test.ts`, `consents.test.tsx`): the account and content stubs; the hidden fields equal the verified document; a resolver result with another version id, hash, locale or content type refuses Accept (the note shows, no form); nothing pre-ticked; closed notice and error lists; strict forms (extra, repeated, malformed fields); no token, secret or full hash in the output (history shows a shortened hash).

## Data-model considerations

The web app has no database access and no data-model impact. Needing data means adding an API endpoint (api skill), not a query.

## Common failure modes

- `next build` failing because config was validated at import time; keep `serverConfig()` lazy.
- Workspace packages not transpiled: add them to `transpilePackages` in `next.config.ts`.
- Standalone image missing files: `outputFileTracingRoot` must be the repo root.
- Read-only root filesystem needs the `tmpfs` on `.next/cache` (see `compose.yaml`).

## Known BananaGig-specific lessons

- Next.js standalone exits with 143 on SIGTERM and does not drain (DEBT-0006).
- The web container deliberately receives no database credentials.
- Dev ports: web 3210 (3000 and 3101 are often taken by other projects, LRN-0009).
- PWA is manifest-only so far (DEBT-0003).
- Account tests use the contract-validating `apps/web/src/testing/account-stub.ts` (the `x-active-role` header must be an ACTIVE role of the account, the switch persists nothing), next to the content stub.
- User-visible copy comes from the content registry through the API only, via `getContent`, `getContentMany` and `renderContent` in `apps/web/src/lib/content.ts` (ADR-0020). When the registry cannot serve a key the helper returns `undefined` and the page omits the element; never write `?? 'literal'` for managed copy. The only static copy is `BOOTSTRAP_COPY` (wordmark, `Sign in`, `Sign out`) plus the error, not-found and loading shells. Tests use the contract-validating stub `apps/web/src/testing/content-stub.ts`, and `apps/web/src/boundaries.test.ts` scans for forbidden imports.
- One-time tokens in links travel in the URL FRAGMENT (`/verify-email#token=...`): a fragment is never sent to a server, so it is in no access log, trace or Referer. A client component reads it, removes it with `history.replaceState`, and the page offers a button that POSTs it in a form body to a same-origin BFF handler; opening the link must never change state (mail scanners prefetch). The token is never stored (not in the login transaction, storage or a cookie): a signed-out visitor signs in and opens the link again.
- BFF handlers that act for the signed-in user (`/auth/email/<action>`): POST only, `Origin` must equal the web origin, session required, forward the browser's address as `x-forwarded-for` (the API's IP rate limit must count real clients, not the web server), answer a 303 back to the page with `?ok=` or `?error=<API code>` and never put a submitted value in the redirect, a cookie or a log line.
- The address a BFF handler forwards (`clientIpOf` in `apps/web/src/lib/auth/email-handlers.ts`) is the LAST `x-forwarded-for` entry, the one Caddy wrote (it REPLACES the header with `{remote_host}`), never the leftmost, which a client can set. The web server forwards exactly one value to the API, which trusts one hop (ADR-0033). No phone verification page exists yet (DEBT-0062); a future one reuses this handler pattern.

## Do not

- Do not call the database or infrastructure adapters from web code, and do not import `@bananagig/geography`, `@bananagig/content` or `@bananagig/configuration` (lint and `pnpm deps:check` fail); country, market, currency and time zone data comes from the public `GET /api/v1/geography/*` reads (ACTIVE data only) and a country name is a content key resolved through the content API.
- Do not hardcode marketplace content or business values in pages.
- Do not read `process.env` directly in components; go through `@bananagig/config`.
- Do not render tokens, put them in URLs, or build GET endpoints that change state (logout and the role switch are POST with an Origin check).
- Do not store the active role in a cookie, URL or browser storage, trust it without the API validating it, import `@bananagig/accounts`, or treat the Keycloak realm roles of the session as application roles.
- Do not put a one-time code or token in a query string, a redirect URL, a cookie or a log line, and do not let a GET request change state.
- Do not put the device secret, a session id of Keycloak, an access token or a submitted value in a URL, redirect, cookie value (other than the device cookie itself), Valkey record or log; do not claim in copy that a trusted browser skips a verification code.
- Do not honour a `kc_action` without the enrollment marker, trust an `acr_values` the browser sent, or start a second step-up round trip from the callback.
- Do not offer an Accept control for text you did not verify to be the version in force, build the form from anything but that verified document, or let a page or a GET record a consent.

## Related ADRs
ADR-0006, ADR-0007, ADR-0014, ADR-0026, ADR-0033, ADR-0034, ADR-0036, ADR-0037

## Last reviewed
2026-10-16 (ID-005)
