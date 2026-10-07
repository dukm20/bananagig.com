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

## Architecture rules

- App Router with server rendering by default; client components only when needed.
- The web app imports only `@bananagig/contracts`, `@bananagig/config`, `@bananagig/identity` and `@bananagig/observability`. It never imports `database`, `platform`, pg, kysely or pg-boss (lint and `pnpm deps:check` fail). It may use Valkey for session records only.
- All data comes from the API through `createApiClient` (`/api/v1`, correlation id propagated, errors parsed to `ApiError`). Server code reads config lazily via `serverConfig()` (never at import time, or `next build` breaks).
- Persona shells (customer/provider/admin) will be route-group layouts wrapping `children`; none exist yet.
- Authentication is a server-side session (ADR-0014): `/auth/login`, `/auth/callback`, `/auth/session`, POST `/auth/logout` implemented as plain Request->Response functions in `apps/web/src/lib/auth/handlers.ts`. The browser holds only opaque HttpOnly cookies; tokens never reach it. Never use localStorage, sessionStorage or JS-readable cookies for auth (a test scans the source). Redirects use `WEB_PUBLIC_URL`, not the request host. Read the session with `getSession(cookieHeader, authDeps())` and call the API with the session's bearer token via `serverApi(accessToken)`.
- The application role a signed-in person acts as (ID-001, ADR-0026) is session state on the SERVER: `SessionRecord.activeRole` in the Valkey session record, never a cookie, a URL or browser storage. The switch is the BFF route `POST /auth/active-role` (`handleActiveRole`): POST only, `Origin` must equal the web origin (like logout), the role is a form field, the server calls the API's `POST /api/v1/account/active-role` with the session token and stores the role only when the API confirms it, then answers 303 to `/session` (a refusal redirects to `/session?error=role` and changes nothing). Every server-side account read sends the remembered role as `x-active-role`; the API validates it on every request, so the stored role is a hint, not authority. A remembered role the API refuses (`ACCOUNT_ROLE_NOT_HELD`, `ACCOUNT_ROLE_NOT_ACTIVE`) is forgotten. Switching role never touches the Keycloak session or any token.
- The `/session` page (infrastructure, no account screens yet) shows the account id, status, application roles and active role and a switch for each other held role; labels, status names and role names are managed content keys (`session.account.*`, `account.status.*`, `identity.role.*.name`), omitted when the registry cannot serve them, and `session.account.unavailable` shows when the account could not be loaded. The web app reaches the account only through `getAccount`, `setActiveRole` and `updateProfile` of the API client; it never imports `@bananagig/accounts`.
- Keep the accessibility baseline: skip link, landmarks, `role=status/alert`, focus styles.

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

## Do not

- Do not call the database or infrastructure adapters from web code, and do not import `@bananagig/geography`, `@bananagig/content` or `@bananagig/configuration` (lint and `pnpm deps:check` fail); country, market, currency and time zone data comes from the public `GET /api/v1/geography/*` reads (ACTIVE data only) and a country name is a content key resolved through the content API.
- Do not hardcode marketplace content or business values in pages.
- Do not read `process.env` directly in components; go through `@bananagig/config`.
- Do not render tokens, put them in URLs, or build GET endpoints that change state (logout and the role switch are POST with an Origin check).
- Do not store the active role in a cookie, URL or browser storage, trust it without the API validating it, import `@bananagig/accounts`, or treat the Keycloak realm roles of the session as application roles.

## Related ADRs

ADR-0006, ADR-0007, ADR-0014, ADR-0026

## Last reviewed

2026-10-07 (ID-001)
