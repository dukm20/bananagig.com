# Identity (Keycloak, tokens, sessions)

## Purpose

Work with BananaGig authentication and authorization: the Keycloak realm, token validation in the API, the web session, test identities, and the application account (account, external identity link, application roles, active role, core profile, email contact and its verification) that a verified identity maps to.

## When to use

- Changing the realm file, a client, a role, a scope or MFA policy.
- Protecting an API route, adding a guard, or reading the caller's identity.
- Changing web login, session or logout behavior.
- Writing tests that need a signed-in user.
- Anything that reads or changes the application account: bootstrap, roles and memberships, the active role, the status machine, the core profile.
- Anything that reads or changes the email contact or its verification: adding or changing the address, the code and magic link, resend and attempt limits, the trusted-identity-provider rule, the email events and audit, the verification screen.

## Canonical files

- `infra/keycloak/bananagig-realm.json`, `scripts/lib/realm.mjs`, `scripts/identity-realm.mjs`, `scripts/identity-sync.mjs`
- `packages/identity/src/verifier.ts`, `packages/identity/src/oidc.ts`, `packages/identity/src/testing.ts`
- `apps/api/src/plugins/auth.ts`, `apps/api/src/modules/system/routes.ts`
- `apps/web/src/lib/auth/handlers.ts`, `apps/web/src/lib/auth/store.ts`, `apps/web/src/lib/auth/runtime.ts`
- `infra/caddy/Caddyfile`, `docs/engineering/IDENTITY.md`
- Application account (ID-001): `db/migrations/0009_identity_accounts.sql`, `packages/contracts/src/account.ts`, `packages/accounts/src/service.ts`, `packages/accounts/src/identity.ts`, `packages/accounts/src/errors.ts`, `apps/api/src/plugins/account.ts`, `apps/api/src/plugins/strict-body.ts`, `apps/api/src/modules/account/routes.ts`, `docs/engineering/ACCOUNTS.md`
- Email contact and verification (ID-002): `db/migrations/0010_email_verification.sql`, `packages/contracts/src/email.ts`, `packages/accounts/src/{email-crypto,email-policy,email-state,email-verification}.ts`, `packages/platform/src/{email,rate-limit}.ts`, `apps/api/src/modules/account/{email-routes,email-wiring}.ts`, `apps/web/src/lib/auth/email-handlers.ts`, `apps/web/src/app/verify-email/`, `packages/testing/src/mailpit.ts`, `docs/engineering/EMAIL_VERIFICATION.md`, `docs/engineering/RATE_LIMITING.md`

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
- Email ownership (ADR-0027): BananaGig owns the marketplace contact (`identity.email_contacts`); the Keycloak email claim is never trusted or copied. An address is VERIFIED only by proof (code or magic link) or because a TRUSTED identity provider reported it verified: `decideIdpEmail` requires a canonical address, `email_verified === true` (boolean) AND a brokered provider in the caller's `trustedProviders` (empty by default; a Keycloak realm user never counts). Anything else is a suggestion and is never persisted.
- ONE canonical form (`canonicalizeEmail`): trimmed, domain IDNA lower-case ASCII, local part a lower-cased ASCII dot-atom, dots and `+tags` kept (no Gmail folding), at most 254 characters. It is the comparison key, the uniqueness key and the delivery address; never store a second form. Return the address only MASKED (`maskEmail`), only to its owner, and never in a log, audit `changes`, event or error.
- Uniqueness is the database's: a VERIFIED address belongs to one account (partial unique index); PENDING duplicates across accounts are allowed (a pending claim proves nothing and must not reveal who holds the address); one primary, one open candidate and one live row per address per account. A proven mailbox that another account verified is `ACCOUNT_EMAIL_UNAVAILABLE`, never a takeover; add and send answer identically whatever another account holds.
- Challenge lifecycle (ADR-0028): one challenge per SEND (a resend supersedes the open one); the code (CSPRNG digits) and the 256-bit token are shown once and stored only as HMAC-SHA-256 keyed with `VERIFICATION_HASH_SECRET` (code hash bound to the challenge id, constant-time compare); single use under the row lock (account row, then contacts, then challenge `FOR UPDATE`); wrong attempts counted under that lock and committed although the call fails; the attempt that reaches the maximum locks the challenge; a repeated successful confirmation is an idempotent success with no second side effect.
- The magic link carries the token in the URL FRAGMENT (`/verify-email#token=`): never sent to a server, so in no log, trace or Referer. Opening it verifies nothing; the page shows a button and the web server POSTs the token in a body. Never put a code or token in a query string, a redirect URL, a cookie or a log.
- Sending is two-phase: commit the challenge, deliver through the `EmailSender` port OUTSIDE any transaction, then record the outcome; a failed delivery invalidates its challenge (`DELIVERY_FAILED`) and does not start the cooldown. The identity service never touches SMTP or a template engine: the composition root supplies the sender and the content-registry renderer.
- Limits are CFG-001 parameters (`verification.email.*`, CRITICAL, read fresh, fail closed when unavailable). The cooldown, hourly and daily caps and the attempt maximum are counted in PostgreSQL per ACCOUNT; the reusable Valkey limiter (ADR-0029) adds source address, target address and device. It fails CLOSED for operations that send mail and open only for confirmation. A refusal never names the dimension.
- Change email: the new address is `REPLACEMENT_PENDING`; the verified primary stays VERIFIED and primary until the candidate verifies, then the old one is `DISABLED/REPLACED` in the same transaction. Setting the primary again withdraws a pending change; a different address supersedes the pending one. Step-up authentication, the notice to the old address and the screens are later (DEBT-0050).

## Implementation pattern

1. Protect a route: `preHandler: requireAuthenticated()` or `requireRealmRole(...)` / `requireAnyRole(...)` / `requireClientRole(client, role)` / `requireAuthContext('admin')` from `apps/api/src/plugins/auth.ts`; declare `security: [{ bearerAuth: [] }]` in the route schema (public routes declare `security: []`), then `pnpm specs:generate`.
2. Read identity: `request.principal` (subject, clientId, realmRoles, clientRoles, authContext). Never log or return the token.
3. Change the realm: edit the JSON, `pnpm identity:check`, `pnpm identity:sync`, then integration tests and smoke. Add a policy rule in `scripts/lib/realm.mjs` plus a test when a new rule matters.
4. Need a signed-in user in a test: forged tokens (`createTestKeys`, `signToken`) for unit tests; `authorizationCodeLogin` (real PKCE) or `devAccessToken` for integration tests.
5. Protect a route that needs the account: `preValidation: [requireAccount({ includeProfile? }), strictBody(Schema)]`, read `request.account` (`activeRole`, `roles`, `status`), never `request.principal.realmRoles`, and never accept an account id or role from the client. A role is granted only by `AccountService.grantRole` from server code; there is no grant endpoint.
6. Email operation: take the account from `requireAccount()`, validate the body with `strictBody(Schema)` (a code or token is never coerced), call `EmailVerificationService` with `{ clientIp: request.ip }`, map `AccountError` through `toAppError` (429s carry `Retry-After`), answer `no-store`. A new email error code goes into `EMAIL_ERROR_CODES`, `toAppError`, the content seed (`account.email.error.<code>`) and the error-mapping table test.

## Commands

```bash
pnpm identity:check                          # realm policy lint
pnpm identity:sync                           # DEV ONLY: re-import the realm into the running dev Keycloak
pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json
pnpm test:integration                        # live Keycloak protocol tests (starts keycloak-auth) and the account tests (isolated databases)
pnpm --filter @bananagig/accounts test       # account pure helpers and service units
pnpm smoke                                   # includes PKCE login, API auth, web session, Caddy auth routes
```
pnpm --filter @bananagig/platform test           # email adapter and rate limiter units; rate-limit.itest.ts needs Valkey (pnpm dev:deps)
# email integration tests read the delivered message from Mailpit (devtools profile): packages/testing/src/mailpit.ts

## Testing requirements

- Unit: forged tokens for every rejection category (none, HS256, wrong key, issuer, audience, expired, not-before, wrong type, missing claims); guards (401 before 403); logs never contain token segments.
- Integration (live Keycloak): real PKCE login per user, wrong verifier and code reuse rejected, redirect URI exact match, implicit/plain/missing-PKCE refused, password grant refused for production clients, claim allow-list, admin context separation, logout invalidates refresh.
- Web: PKCE verifier matches the challenge, state/nonce/replay checks, cookie attributes, CSRF-safe logout, no browser storage in source.
- Account: first-request bootstrap with real tokens, N parallel first requests give exactly one account (repeat the run), idempotent grants, active role not held or not active, suspended and closed accounts, admin context refused, strict bodies (coerced-body regression table), status history at commit (transient status, stray row, `from_status` gap), closure audit rows and events, and privacy by log capture (no token, subject or name in the output).
- Email: canonicalization tables, masking, strict request validation (no coercion), crypto (CSPRNG, keyed hashes, constant-time compare), the trusted-provider table, expiry through crafted rows (never sleeps), single use, the attempt race (concurrent wrong codes never exceed the maximum), code versus link racing, resend racing verify, replacement races, duplicate verified across accounts (including the race), cooldown and hour/day caps with a fake policy, limiter fail-closed versus fail-open, delivery failure, audit/outbox/log scans for the plaintext code, token, hashes and the full address, Mailpit receiving the real message, and the smoke scenario.

## Data-model considerations

Schema `identity` (migrations 0009 and 0010, nine tables) holds the application account and the email contact; see `docs/engineering/ACCOUNTS.md` and ADR-0025 and ADR-0026. Any change goes through the Data Model Review Gate (database skill). There is no users table and nothing of Keycloak (credentials, tokens, sessions) is stored; contact data is ID-002 and ID-003, address ownership is not modelled.

## Common failure modes

- Realm edits not applying: `--import-realm` skips an existing realm; use `pnpm identity:sync` or `pnpm stack:reset` (LRN-0013).
- Issuer mismatch (401 on every token): the pinned issuer is the PUBLIC URL; check `KEYCLOAK_PUBLIC_URL` and that Keycloak runs with `KC_HOSTNAME`.
- Built-in `admin-cli` re-enabling the password grant: it is disabled in the realm file (LRN-0014).
- Session cookie missing after login: SameSite must be Lax (not Strict) and redirects must use `WEB_PUBLIC_URL`.
- Login works in the stack but not in `pnpm dev`: expected (DEBT-0020).
- 403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` on an account route: an admin or non-web token (account routes serve `azp` `bananagig-web` only). A person who suddenly has a new empty account: the issuer or the Keycloak user changed (the issuer is part of the link key).
- `ACCOUNT_EMAIL_RATE_LIMITED` or `UNAVAILABLE` (reason `RATE_LIMITER_UNAVAILABLE`) on a send: Valkey is the limiter and sends fail closed; `pnpm dev:deps`. `UNAVAILABLE` with reason `POLICY_UNAVAILABLE`: a `verification.email.*` parameter is missing or invalid (CRITICAL parameters never fall back).
- A code or link that worked a moment ago now says used: a resend supersedes the previous challenge; a repeated successful confirmation is an idempotent success, a superseded one is `ACCOUNT_EMAIL_CODE_USED`.
- A magic link that does nothing when opened signed out: the fragment does not survive the login redirect; sign in, then open the link again.

## Known BananaGig-specific lessons

- Tokens are issued with `iss` = public URL even when fetched through `keycloak-auth:8080` (`KC_HOSTNAME` + backchannel-dynamic, LRN-0013).
- Keycloak's client-secret endpoint returns `{"type":"secret"}` without a value for public clients; assert on `value`.
- The public auth host exposes only `/realms/bananagig/*` and `/resources/*`; the dev admin console is on `keycloak-admin.localhost` (DEV ONLY).
- Production realm: `pnpm identity:build-prod` (dev client/users removed, https origins, admin OTP required).
- Keycloak realm roles are an identity fact and a one-time bootstrap hint; the application roles in `identity.account_roles` can differ afterwards (a provider role added server-side does not change the token). A closed account is blocked permanently for its login (403 `ACCOUNT_CLOSED`) because the link is permanent.
- The admin client carries `configuration-read`, `configuration-write` and `configuration-approve` plus the original admin role; dev users `admin.dev` and `admin2.dev` hold all of them so second-approver flows can be exercised. These client roles are temporary access control until application RBAC exists (DEBT-0021).
- Hashing a 6-digit code with plain SHA-256 is reversible from a leaked table in a millisecond: the HMAC key lives outside the database. Counting sends as challenge rows (one per send) removes every counter that could drift. A deferred constraint trigger is the right place for "the whole account is consistent at COMMIT" when a replacement passes through intermediate states (LRN-0035 pattern).
- The `email_verified` flag of Keycloak is not evidence for BananaGig: an administrator or a realm import sets it. Trust is a function of the brokered provider, not of the flag alone.

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
- Do not trust or copy the Keycloak email claim, persist a plain claim, or mark an address VERIFIED without a code, a link or a trusted provider's verified flag.
- Do not store, log, audit, put in an event or return a plaintext code, token, hash or full address; do not put a token in a query string; do not let a GET change state.
- Do not hardcode a code length, validity, cooldown, cap or attempt limit; do not make the limiter fail open on an operation that sends mail.
- Do not replace the verified primary before its replacement verifies, and do not transfer a verified address between accounts.

## Related ADRs

ADR-0013, ADR-0014, ADR-0015, ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0029

## Last reviewed

2026-10-07 (ID-002)
