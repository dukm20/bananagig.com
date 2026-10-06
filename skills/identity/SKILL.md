# Identity (Keycloak, tokens, sessions)

## Purpose

Work with BananaGig authentication and authorization: the Keycloak realm, token validation in the API, the web session, and test identities.

## When to use

- Changing the realm file, a client, a role, a scope or MFA policy.
- Protecting an API route, adding a guard, or reading the caller's identity.
- Changing web login, session or logout behavior.
- Writing tests that need a signed-in user.

## Canonical files

- `infra/keycloak/bananagig-realm.json`, `scripts/lib/realm.mjs`, `scripts/identity-realm.mjs`, `scripts/identity-sync.mjs`
- `packages/identity/src/verifier.ts`, `packages/identity/src/oidc.ts`, `packages/identity/src/testing.ts`
- `apps/api/src/plugins/auth.ts`, `apps/api/src/modules/system/routes.ts`
- `apps/web/src/lib/auth/handlers.ts`, `apps/web/src/lib/auth/store.ts`, `apps/web/src/lib/auth/runtime.ts`
- `infra/caddy/Caddyfile`, `docs/engineering/IDENTITY.md`

## Architecture rules

- Keycloak owns authentication only; profiles, preferences and application permissions belong to the BananaGig database, linked later by the immutable `sub` (ADR-0013). Never key data by username or email.
- Browsers use Authorization Code + PKCE S256 with a server-side session; tokens never reach the browser; no implicit flow, no password grant, no client secret on browser clients (ADR-0014).
- Identity roles (`customer`, `provider`) are not application permissions. Admin is a separate client with a client role and its own flow (ADR-0015). Admin tokens carry no customer/provider roles.
- Authorization is enforced in the API on the server. UI hiding is not security.
- Tokens carry minimal claims: sub, iss, aud, exp, iat, azp, typ, sid, acr, scope, roles. Never add email, phone, names or internal ids.
- The realm file is the single source of truth. The password grant exists only on the dev-only client (`bananagig.devOnly`).

## Implementation pattern

1. Protect a route: `preHandler: requireAuthenticated()` or `requireRealmRole(...)` / `requireAnyRole(...)` / `requireClientRole(client, role)` / `requireAuthContext('admin')` from `apps/api/src/plugins/auth.ts`; declare `security: [{ bearerAuth: [] }]` in the route schema (public routes declare `security: []`), then `pnpm specs:generate`.
2. Read identity: `request.principal` (subject, clientId, realmRoles, clientRoles, authContext). Never log or return the token.
3. Change the realm: edit the JSON, `pnpm identity:check`, `pnpm identity:sync`, then integration tests and smoke. Add a policy rule in `scripts/lib/realm.mjs` plus a test when a new rule matters.
4. Need a signed-in user in a test: forged tokens (`createTestKeys`, `signToken`) for unit tests; `authorizationCodeLogin` (real PKCE) or `devAccessToken` for integration tests.

## Commands

```bash
pnpm identity:check                          # realm policy lint
pnpm identity:sync                           # DEV ONLY: re-import the realm into the running dev Keycloak
pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json
pnpm test:integration                        # live Keycloak protocol tests (starts keycloak-auth)
pnpm smoke                                   # includes PKCE login, API auth, web session, Caddy auth routes
```

## Testing requirements

- Unit: forged tokens for every rejection category (none, HS256, wrong key, issuer, audience, expired, not-before, wrong type, missing claims); guards (401 before 403); logs never contain token segments.
- Integration (live Keycloak): real PKCE login per user, wrong verifier and code reuse rejected, redirect URI exact match, implicit/plain/missing-PKCE refused, password grant refused for production clients, claim allow-list, admin context separation, logout invalidates refresh.
- Web: PKCE verifier matches the challenge, state/nonce/replay checks, cookie attributes, CSRF-safe logout, no browser storage in source.

## Data-model considerations

No tables exist or are needed. When accounts are persisted (ID-001) add `identity.external_identities` keyed to the Keycloak `sub` through the Data Model Review Gate; do not create a users table before then.

## Common failure modes

- Realm edits not applying: `--import-realm` skips an existing realm; use `pnpm identity:sync` or `pnpm stack:reset` (LRN-0013).
- Issuer mismatch (401 on every token): the pinned issuer is the PUBLIC URL; check `KEYCLOAK_PUBLIC_URL` and that Keycloak runs with `KC_HOSTNAME`.
- Built-in `admin-cli` re-enabling the password grant: it is disabled in the realm file (LRN-0014).
- Session cookie missing after login: SameSite must be Lax (not Strict) and redirects must use `WEB_PUBLIC_URL`.
- Login works in the stack but not in `pnpm dev`: expected (DEBT-0020).

## Known BananaGig-specific lessons

- Tokens are issued with `iss` = public URL even when fetched through `keycloak-auth:8080` (`KC_HOSTNAME` + backchannel-dynamic, LRN-0013).
- Keycloak's client-secret endpoint returns `{"type":"secret"}` without a value for public clients; assert on `value`.
- The public auth host exposes only `/realms/bananagig/*` and `/resources/*`; the dev admin console is on `keycloak-admin.localhost` (DEV ONLY).
- Production realm: `pnpm identity:build-prod` (dev client/users removed, https origins, admin OTP required).
- The admin client carries `configuration-read`, `configuration-write` and `configuration-approve` plus the original admin role; dev users `admin.dev` and `admin2.dev` hold all of them so second-approver flows can be exercised. These client roles are temporary access control until application RBAC exists (DEBT-0021).

## Do not

- Do not put tokens in localStorage, cookies readable by JS, URLs or logs.
- Do not add the implicit flow, the password grant, or a client secret to a browser client.
- Do not import `@bananagig/identity/testing` from production code.
- Do not add profile, email or phone claims to API tokens.
- Do not model business permissions as Keycloak roles or mix admin capability into realm roles.
- Do not create a users table or duplicate profile data in Keycloak.

## Related ADRs

ADR-0013, ADR-0014, ADR-0015

## Last reviewed

2026-10-05 (CFG-001)
