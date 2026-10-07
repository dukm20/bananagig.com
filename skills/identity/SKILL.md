# Identity (Keycloak, tokens, sessions)

## Purpose

Work with BananaGig authentication and authorization: the Keycloak realm, token validation in the API, the web session, test identities, and the application account (account, external identity link, application roles, active role, core profile) that a verified identity maps to.

## When to use

- Changing the realm file, a client, a role, a scope or MFA policy.
- Protecting an API route, adding a guard, or reading the caller's identity.
- Changing web login, session or logout behavior.
- Writing tests that need a signed-in user.
- Anything that reads or changes the application account: bootstrap, roles and memberships, the active role, the status machine, the core profile.

## Canonical files

- `infra/keycloak/bananagig-realm.json`, `scripts/lib/realm.mjs`, `scripts/identity-realm.mjs`, `scripts/identity-sync.mjs`
- `packages/identity/src/verifier.ts`, `packages/identity/src/oidc.ts`, `packages/identity/src/testing.ts`
- `apps/api/src/plugins/auth.ts`, `apps/api/src/modules/system/routes.ts`
- `apps/web/src/lib/auth/handlers.ts`, `apps/web/src/lib/auth/store.ts`, `apps/web/src/lib/auth/runtime.ts`
- `infra/caddy/Caddyfile`, `docs/engineering/IDENTITY.md`
- Application account (ID-001): `db/migrations/0009_identity_accounts.sql`, `packages/contracts/src/account.ts`, `packages/accounts/src/service.ts`, `packages/accounts/src/identity.ts`, `packages/accounts/src/errors.ts`, `apps/api/src/plugins/account.ts`, `apps/api/src/plugins/strict-body.ts`, `apps/api/src/modules/account/routes.ts`, `docs/engineering/ACCOUNTS.md`

## Architecture rules

- Keycloak owns authentication only; accounts, profiles, application roles and permissions belong to the BananaGig database, linked by the immutable issuer and `sub` in `identity.external_identities` (ADR-0013, ADR-0025). Never key data by username or email. The subject is NOT a column of `accounts` and is never the account id.
- The account is created lazily at the FIRST authenticated request of the normal web context (`requireAccount()`), in one transaction, status `ACTIVE`; the unique key `(provider_type, issuer, provider_subject)` decides a race (the loser rolls back and re-reads). Initial roles come ONCE from the token realm roles (`BOOTSTRAP_ROLE_BY_IDENTITY_ROLE`: `customer` to `CUSTOMER`, `provider` to `PROVIDER`) and are never read again; PostgreSQL is the only authority for application roles (DEBT-0044).
- Roles are reference data; membership is one row per (account, role); the preferred (primary) role is a composite foreign key to the account's own membership plus triggers. The ACTIVE role of a request is context, NOT persisted: the web server session keeps it and sends `x-active-role`, and the API validates it against the ACTIVE memberships on every request (403 `ACCOUNT_ROLE_NOT_HELD` or `ACCOUNT_ROLE_NOT_ACTIVE`). Switching role never creates a Keycloak login or session (ADR-0026).
- Concurrency: one lock order (the ACCOUNT row first with `FOR UPDATE`, then the ROLE row `FOR SHARE`, then the membership, identity and profile rows of that account), natural uniqueness for idempotency. Privacy: no client-supplied account id, subject or role; no token, name or subject of the account's login in logs, audit `changes`, events, errors or responses (an actor `account:<id>`, `system:<name>` or `admin:<subject>` names WHO acted and is not the subject of the account being changed); `mapDbError` logs only the SQLSTATE or error class of an outage; admin logins have no account (403 on account routes). Account routes send `Cache-Control: no-store`.
- Status and events: `accounts.status` plus the immutable `account_status_history` are kept consistent in both directions by two deferred constraint triggers that read the CURRENT status at commit (a transient status passes, a stray row or a broken `from_status` chain fails); closing an account audits `ROLE_DEACTIVATED` per membership and `PRIMARY_ROLE_CHANGED` when it clears a primary role, and `account-role-deactivated` is emitted only for a membership that was ACTIVE.
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
5. Protect a route that needs the account: `preValidation: [requireAccount({ includeProfile? }), strictBody(Schema)]`, read `request.account` (`activeRole`, `roles`, `status`), never `request.principal.realmRoles`, and never accept an account id or role from the client. A role is granted only by `AccountService.grantRole` from server code; there is no grant endpoint.

## Commands

```bash
pnpm identity:check                          # realm policy lint
pnpm identity:sync                           # DEV ONLY: re-import the realm into the running dev Keycloak
pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json
pnpm test:integration                        # live Keycloak protocol tests (starts keycloak-auth) and the account tests (isolated databases)
pnpm --filter @bananagig/accounts test       # account pure helpers and service units
pnpm smoke                                   # includes PKCE login, API auth, web session, Caddy auth routes
```

## Testing requirements

- Unit: forged tokens for every rejection category (none, HS256, wrong key, issuer, audience, expired, not-before, wrong type, missing claims); guards (401 before 403); logs never contain token segments.
- Integration (live Keycloak): real PKCE login per user, wrong verifier and code reuse rejected, redirect URI exact match, implicit/plain/missing-PKCE refused, password grant refused for production clients, claim allow-list, admin context separation, logout invalidates refresh.
- Web: PKCE verifier matches the challenge, state/nonce/replay checks, cookie attributes, CSRF-safe logout, no browser storage in source.
- Account: first-request bootstrap with real tokens, N parallel first requests give exactly one account (repeat the run), idempotent grants, active role not held or not active, suspended and closed accounts, admin context refused, strict bodies (coerced-body regression table), status history at commit (transient status, stray row, `from_status` gap), closure audit rows and events, and privacy by log capture (no token, subject or name in the output).

## Data-model considerations

Schema `identity` (migration 0009, seven tables) holds the application account; see `docs/engineering/ACCOUNTS.md` and ADR-0025 and ADR-0026. Any change goes through the Data Model Review Gate (database skill). There is no users table and nothing of Keycloak (credentials, tokens, sessions) is stored; contact data is ID-002 and ID-003, address ownership is not modelled.

## Common failure modes

- Realm edits not applying: `--import-realm` skips an existing realm; use `pnpm identity:sync` or `pnpm stack:reset` (LRN-0013).
- Issuer mismatch (401 on every token): the pinned issuer is the PUBLIC URL; check `KEYCLOAK_PUBLIC_URL` and that Keycloak runs with `KC_HOSTNAME`.
- Built-in `admin-cli` re-enabling the password grant: it is disabled in the realm file (LRN-0014).
- Session cookie missing after login: SameSite must be Lax (not Strict) and redirects must use `WEB_PUBLIC_URL`.
- Login works in the stack but not in `pnpm dev`: expected (DEBT-0020).
- 403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` on an account route: an admin or non-web token (account routes serve `azp` `bananagig-web` only). A person who suddenly has a new empty account: the issuer or the Keycloak user changed (the issuer is part of the link key).

## Known BananaGig-specific lessons

- Tokens are issued with `iss` = public URL even when fetched through `keycloak-auth:8080` (`KC_HOSTNAME` + backchannel-dynamic, LRN-0013).
- Keycloak's client-secret endpoint returns `{"type":"secret"}` without a value for public clients; assert on `value`.
- The public auth host exposes only `/realms/bananagig/*` and `/resources/*`; the dev admin console is on `keycloak-admin.localhost` (DEV ONLY).
- Production realm: `pnpm identity:build-prod` (dev client/users removed, https origins, admin OTP required).
- Keycloak realm roles are an identity fact and a one-time bootstrap hint; the application roles in `identity.account_roles` can differ afterwards (a provider role added server-side does not change the token). A closed account is blocked permanently for its login (403 `ACCOUNT_CLOSED`) because the link is permanent.
- The admin client carries `configuration-read`, `configuration-write` and `configuration-approve` plus the original admin role; dev users `admin.dev` and `admin2.dev` hold all of them so second-approver flows can be exercised. These client roles are temporary access control until application RBAC exists (DEBT-0021).

## Do not

- Do not put tokens in localStorage, cookies readable by JS, URLs or logs.
- Do not add the implicit flow, the password grant, or a client secret to a browser client.
- Do not import `@bananagig/identity/testing` from production code.
- Do not add profile, email or phone claims to API tokens.
- Do not model business permissions as Keycloak roles or mix admin capability into realm roles.
- Do not create a users table, store the Keycloak subject on `accounts`, or duplicate profile data in Keycloak.
- Do not use a Keycloak realm role as an application permission or read it after the account exists; authorize with `request.account`.
- Do not accept an account id, subject or role from the client, and do not add an endpoint that grants a role.
- Do not persist the active role, create an admin account, or log a token, a name or the subject of an account's login.

## Related ADRs

ADR-0013, ADR-0014, ADR-0015, ADR-0025, ADR-0026

## Last reviewed

2026-10-07 (ID-001)
