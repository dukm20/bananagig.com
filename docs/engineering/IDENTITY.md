# Identity (Keycloak baseline)

Authentication infrastructure plus, since ID-001, the application account that a verified identity is mapped to. No sign-up, onboarding, verification or recovery business flows exist yet. Decisions: ADR-0013 (provider and data ownership), ADR-0014 (web session and PKCE), ADR-0015 (admin separation and role split), ADR-0025 (application account versus Keycloak identity), ADR-0026 (role membership and the active role context). The account side is described in `docs/engineering/ACCOUNTS.md`.

## Ownership boundary

| Keycloak owns | The BananaGig database owns |
|---|---|
| Authentication and credentials (passwords) | The application account, its id, status and status history (`identity.accounts`) |
| Protocol sessions and token issuance | The mapping of a login to its account (`identity.external_identities`: issuer + subject) |
| MFA factors (TOTP now, WebAuthn later) | Application roles (`CUSTOMER`, `PROVIDER`) and role memberships, the preferred role, the core profile (names, locale, time zone) |
| Brute-force protection, login flows | Later: contact data and verification, consents, role-specific data, business relationships and application permissions |

Keycloak stores only what authentication needs (a username, an email for login and, in dev, a name). Profile data is not duplicated into Keycloak, and nothing of Keycloak (credentials, tokens, sessions) is duplicated into the BananaGig database; the only provider data stored is the issuer and subject that form the link. See `docs/engineering/ACCOUNTS.md` for the full ownership table.

## Subject mapping (implemented in ID-001)

Every BananaGig account references its Keycloak identity by the immutable `sub` claim and the issuer, stored in `identity.external_identities` (migration `0009_identity_accounts.sql`):

```
identity.external_identities (
  external_identity_id uuid PK, account_id uuid -> identity.accounts, provider_type text ('KEYCLOAK'),
  issuer text, provider_subject text, created_at, last_seen_at,
  UNIQUE (provider_type, issuer, provider_subject)
)
```

There is no `users` table: `identity.accounts` carries no subject, no credentials and no contact data. The unique key makes one login link at most one account (a race between two first requests has exactly one winner), the link is immutable (only `last_seen_at` changes) and never deleted, and the key is the lookup of every authenticated request. Both the issuer and the subject are used verbatim; a person is never matched to an account by email or username (both can change). Keycloak's realm roles are not copied: they seed the first application roles of a new account once and are never read again (ADR-0025). Details, the account bootstrap policy and the active role are in `docs/engineering/ACCOUNTS.md`.

## Application account

A verified identity of the normal web context (`azp` `bananagig-web`) gets a BananaGig account on its first authenticated request, in one transaction, with status `ACTIVE`, an immutable status history row (the database checks at commit, in both directions, that the history and the current status agree), the external identity link and initial roles from the one-time bootstrap hint (`customer` gives `CUSTOMER`, `provider` gives `PROVIDER`). The application roles of an account come from PostgreSQL, never from the token; the role a request acts as (the active role) is request context validated against the account's ACTIVE roles on every request, sent by the web server as `x-active-role`, and never persisted. Switching role does not create a Keycloak login or session. Admin identities (`bananagig-admin`) have no account and get 403 on the account routes (SV-11.08). `requireAccount()` in `apps/api/src/plugins/account.ts` is the guard; routes read `request.account`, never the realm roles of the token, for application decisions.

## Realm and clients

Realm `bananagig`, declared in `infra/keycloak/bananagig-realm.json` (the only source of truth; never configure by clicking in the admin console).

| Client | Type | Purpose |
|---|---|---|
| `bananagig-web` | public, code flow, PKCE S256 | Customers and providers through the web app. No secret exists or is needed |
| `bananagig-api` | resource server, no flows | The `aud` of API access tokens. Never used to obtain tokens |
| `bananagig-admin` | public, code flow, PKCE S256, own browser flow | Future admin console. Separate redirect host, shorter tokens, MFA-ready flow |
| `bananagig-dev-test` | **DEV/TEST ONLY**, password grant | Automated token acquisition for tests and smoke. Flagged `bananagig.devOnly`, removed from production realm builds |
| `admin-cli` | disabled | Keycloak's built-in client enables the password grant in every realm; it is disabled here |

Built-in `account`, `account-console`, `broker`, `realm-management` and `security-admin-console` remain as Keycloak defaults (DEBT-0019).

Realm policy: no public registration, brute-force protection, `sslRequired=external` (all outside localhost/private networks), passwords of at least 12 characters, TOTP policy, no password reset or email verification yet (they need SMTP and business flows).

`pnpm identity:check` lints the realm file against these rules (no implicit flow, no password grant except on the dev-only client, PKCE S256 on browser clients, exact redirect URIs, admin separated, no personal-data scopes). It runs in CI and in unit tests.

### Versioning realm changes

1. Edit `infra/keycloak/bananagig-realm.json`.
2. `pnpm identity:check` and `pnpm test` (realm policy tests).
3. Apply locally: `pnpm identity:sync` (deletes and re-imports the realm in the running dev Keycloak; DEV ONLY, refuses non-local targets) or `pnpm stack:reset`. `--import-realm` alone skips a realm that already exists.
4. Run `pnpm test:integration` (live configuration and protocol tests) and `pnpm smoke`.
5. Commit the JSON with the change that needs it. The realm file is reviewed like code.

Production: `pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json` produces the production realm: dev-only client and users removed, real https origins, `sslRequired=all`, admin OTP made unconditional. It is linted with the production rules. Provisioning that realm into a production Keycloak is not designed yet (DEBT-0016, DEBT-0004).

## Authorization Code + PKCE flow (web)

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as web-app (Next.js)
  participant V as valkey-cache
  participant K as Keycloak (public: auth.localhost)
  participant A as api-service
  B->>W: GET /auth/login?returnTo=/session
  W->>V: store {state, nonce, code_verifier, returnTo} (10 min, single use)
  W-->>B: 302 to Keycloak (response_type=code, code_challenge S256, state, nonce) + HttpOnly tx cookie
  B->>K: authorize + sign in (password; MFA when configured)
  K-->>B: 302 to /auth/callback?code&state
  B->>W: GET /auth/callback (tx cookie)
  W->>V: take transaction (consumed once)
  W->>W: constant-time state check
  W->>K: back channel (keycloak-auth:8080) code + code_verifier, NO client secret
  K-->>W: access, refresh and ID tokens
  W->>W: verify ID token (signature, iss, aud, exp, nonce) and access token
  W->>V: store session record (tokens stay here)
  W-->>B: 302 returnTo + opaque HttpOnly SameSite=Lax session cookie
  B->>W: GET /session (cookie)
  W->>A: GET /api/v1/system/whoami (Authorization: Bearer, server side)
```

Rules enforced by code and tests:

- `response_type=code` with `code_challenge_method=S256` only. The helper cannot build a plain or implicit request, and Keycloak refuses them for these clients (tested live).
- `state` and `nonce` are random, single-use and validated; the transaction cookie binds the browser to the attempt (login CSRF).
- Redirect URIs are exact-match in Keycloak; post-login `returnTo` accepts same-site relative paths only.
- The browser never receives a token: only two opaque cookies. The web app source contains no `localStorage`, `sessionStorage`, `document.cookie` or `indexedDB` (unit test scans it).
- Session cookie: HttpOnly, SameSite=Lax, Path=/, `Secure` and the `__Host-` prefix when `WEB_PUBLIC_URL` is https. Lax (not Strict) is required so the cookie travels with Keycloak's top-level redirect back.
- Redirects are built from `WEB_PUBLIC_URL`, never from the request host (which is internal behind the proxy).
- Logout is POST only and requires `Origin` equal to the web origin (plus SameSite): it deletes the server session, clears the cookie, and redirects to Keycloak's end-session endpoint with `id_token_hint`. There is no GET logout link (CSRF).
- Expired sessions: the access token is refreshed server-side shortly before expiry; a failed refresh deletes the session and the user is signed out.
- Sessions live in Valkey under `bg:<env>:web:session:<id>` with a TTL equal to the refresh lifetime. Valkey is non-authoritative: losing it signs users out, nothing more.

## Hostnames and issuer

Browsers use `http://auth.localhost:8080` (Caddy). Containers call `http://keycloak-auth:8080` directly. Keycloak is started with `KC_HOSTNAME=http://auth.localhost:8080` and `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, so tokens always carry `iss=http://auth.localhost:8080/realms/bananagig` whichever URL requested them, while back-channel endpoints (token, JWKS) follow the caller's host. The API verifies the pinned issuer and fetches keys from the internal JWKS URL.

Config (`@bananagig/config`): `KEYCLOAK_URL` (internal), `KEYCLOAK_PUBLIC_URL` (issuer base), `KEYCLOAK_REALM`, `KEYCLOAK_API_AUDIENCE`, `KEYCLOAK_WEB_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_ID`, `WEB_PUBLIC_URL`.

## Roles: identity vs application permission

| | IDENTITY ROLE | APPLICATION PERMISSION |
|---|---|---|
| Where | Keycloak (token claim) | BananaGig database / configuration |
| Meaning | "This account is a customer / provider" | "May approve refunds", "may edit this provider's calendar" |
| Granularity | Coarse, rarely changes | Fine, business-driven, auditable, changes often |
| Now | Realm roles `customer`, `provider` (identity facts; a one-time hint when an account is created). Client role `admin-console-access` on `bananagig-admin` | Application roles `CUSTOMER` and `PROVIDER` as memberships of an account (`identity.account_roles`, ID-001: marketplace roles, not permissions). No fine-grained permission yet; those are built with the features that need them |

Admin access is a **client role** on the admin client, never a realm role mixed into normal accounts, and admin tokens carry no `customer`/`provider` roles; an admin login has no application account and cannot hold the customer or provider role. Detailed admin permissions (finance, trust, support) are application data, not Keycloak roles. Authorization is always enforced server-side; hiding UI is not security.

## Admin separation

- Separate client (`bananagig-admin`), separate redirect host (`admin.localhost`, currently reserved by Caddy and answering 503: no admin app exists), separate callback URI.
- Shorter access tokens (180 s vs 300 s), shorter client session (idle 15 min, max 8 h).
- Its own browser authentication flow `bananagig-admin-browser` with an OTP step.
- The API tells the contexts apart: `Principal.authContext` is `admin` when `azp` is `bananagig-admin` (guard: `requireAuthContext('admin')`, plus `requireClientRole('bananagig-admin','admin-console-access')`).
- No public admin sign-up: public registration is off; admins arrive by invitation in a later checkpoint (AD-07). Admin identities have no `identity.accounts` row: the account routes answer 403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` for the admin context (DEBT-0046).

## MFA

| | Development (now) | Production (policy) |
|---|---|---|
| TOTP | Supported by the realm (6 digits, 30 s, SHA-1 for authenticator-app compatibility) | Same |
| Customers/providers | Not forced | Not forced yet; step-up capable |
| Admin client | OTP required only once the user has a TOTP credential (conditional) | OTP **required and enrolment forced**: `pnpm identity:build-prod` makes the OTP sub-flow unconditional |
| Step-up | `acr.loa.map` maps `bananagig:password`=1, `bananagig:mfa`=2; the `acr` claim is issued. The web client's flow does not request level 2 yet | A feature that needs step-up requests `acr_values=bananagig:mfa` and binds a level-of-authentication flow (DEBT-0018) |
| WebAuthn | Policy defaults declared only | Deferred (DEBT-0018) |
| Recovery | Backup/recovery hooks arrive with the recovery business flow (DEBT-0017) | Same |

## Token claims (minimization)

API access tokens carry only: `sub`, `iss`, `aud` (`bananagig-api`), `exp`, `iat`, `azp`, `typ` (Bearer), `sid`, `acr`, `scope`, `realm_access.roles`, `resource_access.<client>.roles`, `jti` and `auth_time` where applicable. Not carried: email, phone, name, username, internal database ids, secrets. Default scopes are `basic`, `roles`, `acr` and `bananagig-api-audience` only; `profile`, `email` and `phone` are not assigned (the realm policy test fails if they are). `fullScopeAllowed=false`, so roles are limited to those mapped to each client. An integration test checks live tokens against the allowed-claim list.

## API validation

`@bananagig/identity` (`TokenVerifier`): RS256/ES256 only (`none` and HMAC never accepted), signature, exact issuer, audience, expiry, not-before (5 s tolerance), required `sub`/`exp`/`iat`, token type (`typ` must be `Bearer`; ID and refresh tokens are rejected), `azp` present. JWKS is fetched from the internal URL, cached for 10 minutes with a 30-second cooldown on unknown keys (key rotation safe), with a 5-second timeout.

Fastify guards in `apps/api/src/plugins/auth.ts`: `requireAuthenticated()`, `requireRealmRole(...all)`, `requireAnyRole(...any)`, `requireClientRole(client, role)`, `requireAuthContext(ctx)`. Failures use the standard error model with the correlation id preserved; no provider payload is ever returned:

| Situation | Response |
|---|---|
| No token | 401 `AUTHENTICATION_REQUIRED` + `WWW-Authenticate: Bearer realm="bananagig"` |
| Malformed, forged, wrong issuer/audience/type, expired | 401 `INVALID_TOKEN` + `error="invalid_token"` |
| Authenticated but lacking the role | 403 `INSUFFICIENT_PERMISSIONS` |
| Key set unreachable | 503 `AUTH_PROVIDER_UNAVAILABLE` (category DEPENDENCY) |

`GET /api/v1/system/whoami` returns `{subject, clientId, audience, realmRoles, authContext}` plus the correlation id, never the token.

The account routes (ID-001) build on these guards: `requireAccount({ includeProfile?, honorActiveRoleHeader? })` (`apps/api/src/plugins/account.ts`) authenticates (401), requires the normal web context (403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` for the admin context and any other client), maps the verified issuer and subject to the account (creating it on the first request), refuses `SUSPENDED` and `CLOSED` accounts (403) and sets `request.account`. It never reads an account id, subject or role from the client (the subject comes from the verified token only).

| Route | Purpose | Notes |
|---|---|---|
| GET `/api/v1/account/me` | the caller's own account: id, status, ACTIVE application roles, preferred role, active role, profile | optional `x-active-role` header validated against the ACTIVE roles on every request (403 `ACCOUNT_ROLE_NOT_HELD` or `ACCOUNT_ROLE_NOT_ACTIVE`; an empty header is refused as `ACCOUNT_ROLE_NOT_HELD`, the web server omits the header instead of sending it empty); no query parameters |
| POST `/api/v1/account/active-role` | validate a role switch `{ role }` and return the account with that active role | persists nothing and does not touch Keycloak |
| PUT `/api/v1/account/profile` | replace the caller's own profile (first and last name, optional locale and time zone) | strict body, idempotent |

Errors use the standard model with `ACCOUNT_<code>` codes (`ACCOUNT_SUSPENDED`, `ACCOUNT_CLOSED`, `ACCOUNT_ROLE_NOT_HELD`, `ACCOUNT_ROLE_NOT_ACTIVE`, `ACCOUNT_VALIDATION_FAILED`, `ACCOUNT_CONFLICT`, `ACCOUNT_INVALID_STATE`, `ACCOUNT_UNAVAILABLE`); every response of a matched account route, errors included, carries `Cache-Control: no-store` (the caller's own personal data); the full reference is in `docs/engineering/ACCOUNTS.md`. Readiness of the API still depends on PostgreSQL only: a Keycloak outage fails authenticated routes, not public ones.

## Telemetry and logging

Metrics: `auth_token_validations_total{result}`, `auth_token_validation_failures_total{category}` (missing, malformed, signature, expired, not_yet_valid, issuer_mismatch, audience_mismatch, wrong_token_type, claims_invalid, jwks_unavailable, unsupported_algorithm), `auth_issuer_audience_mismatch_total{kind}`, `auth_token_validation_duration_seconds`. Failures log the category only. Tokens, authorization codes, refresh tokens, passwords and OTP secrets are never logged (a test asserts no token or token segment appears in log output; the logger also redacts keys such as `token` and `authorization`).

## Service accounts

None created: no machine-to-machine need exists. When one does: a dedicated confidential client per integration (never a shared one), client-credentials grant only, the secret held in the secret manager (never committed or logged), an audience restricted to the one API it needs, least-privilege client roles, and never used to impersonate or act on behalf of a user. Add it through the realm file, the policy linter and an ADR/PR note.

## Secrets

Keycloak admin credentials, database credentials and any future confidential-client secret come from environment/secret storage only. `.env.example` holds fake `*_dev_only` placeholders; the realm file contains only dev-only user passwords (`dev_only_*`, enforced by test) and no client secrets. The production secret manager is not wired yet (DEBT-0016). `bananagig-api` has a Keycloak-generated secret that nothing uses.

## Caddy routes

| Host | Exposes |
|---|---|
| `auth.localhost` | **Only** `/realms/bananagig/*` and `/resources/*` (login, token, logout, JWKS, discovery, static). Admin console, master realm, health, metrics and everything else return 404 |
| `keycloak-admin.localhost` | **DEV ONLY** Keycloak admin console (`/admin/master/console/`). Remove in production; reach the console privately |
| `admin.localhost` | Reserved for the admin app; 503 until it exists |
| `app.localhost` | web-app (`/auth/*`, `/session`, ...) and `/api/v1/*` to api-service |
| `api.localhost` | api-service; `/internal/*` blocked |

Smoke test "Caddy Proxy auth routes" asserts all of this from inside the network.

## Local development

- Interactive login needs the container stack (`pnpm stack:all`; open `http://app.localhost:8080/session`). Host mode (`pnpm dev`) supports bearer-token calls to the API but not browser login, because the issuer is pinned to `auth.localhost:8080` (DEBT-0020).
- Admin console (DEV ONLY): `http://keycloak-admin.localhost:8080/admin/master/console/`, login `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from `.env`.
- Dev-only identities (they do not exist in production realm builds): `customer.dev` (role customer), `provider.dev` (provider), `admin.dev` (client role `admin-console-access`), passwords `dev_only_customer_password`, `dev_only_provider_password`, `dev_only_admin_password`.
- Test helpers: `@bananagig/identity/testing` (forged tokens for unit tests, `devAccessToken`, a scripted real PKCE login). **DEV/TEST ONLY**: ESLint forbids importing it from production code. The password grant exists solely on `bananagig-dev-test`; the PKCE helper keeps the production protocol shape and is preferred.

## Production hardening checklist (not done; tracked)

Keycloak `start` with TLS and a real hostname, secrets manager (DEBT-0016), production realm provisioning from `identity:build-prod` (DEBT-0004), SMTP/SMS for verification and recovery (DEBT-0017), WebAuthn and step-up (DEBT-0018), decide the built-in account console and a BananaGig login theme (DEBT-0019), remove the dev admin host from the proxy, and a Keycloak backup/restore drill (it shares PostgreSQL, DEBT-0015).
