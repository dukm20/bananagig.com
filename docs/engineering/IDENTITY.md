# Identity (Keycloak baseline)

Authentication infrastructure plus, since ID-001, the application account that a verified identity is mapped to, since ID-002 and ID-003 the email and phone contacts, and since ID-004 the session registry, the second factor, the step-up and the password reset. No sign-up or onboarding business flows exist yet. Decisions: ADR-0013 (provider and data ownership), ADR-0014 (web session and PKCE), ADR-0015 (admin separation and role split), ADR-0025 (application account versus Keycloak identity), ADR-0026 (role membership and the active role context), ADR-0034 (application session registry, revocation and the security timeline), ADR-0035 (the Keycloak security admin client), ADR-0036 (step-up, MFA ownership and the trusted browser). The account side is described in `docs/engineering/ACCOUNTS.md`; sessions, the second factor and recovery in `docs/engineering/SESSIONS_AND_MFA.md`.

## Ownership boundary

| Keycloak owns | The BananaGig database owns |
|---|---|
| Authentication and credentials (passwords) | The application account, its id, status and status history (`identity.accounts`) |
| Protocol sessions and token issuance | The mapping of a login to its account (`identity.external_identities`: issuer + subject) |
| MFA factors (TOTP and recovery codes now, WebAuthn later) and their secrets and codes | Application roles (`CUSTOMER`, `PROVIDER`) and role memberships, the preferred role, the core profile (names, locale, time zone) |
| Brute-force protection, login flows, the floor that makes the second factor mandatory for users who have one | The application session registry, the browsers (devices) and the trusted-browser record, the "sign out everywhere" watermark, the security timeline (ID-004, ADR-0034) |
| The password reset link (creation, signature, email, single use) | The email and phone contacts and their verification, who may ask for a reset and the record of the request. Later: consents, role-specific data, business relationships and application permissions |

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
| `bananagig-web` | public, code flow, PKCE S256, own browser flow `bananagig-browser`, `minimum.acr.value=bananagig:mfa` | Customers and providers through the web app. No secret exists or is needed. Users who have a second factor are always asked for it (ID-004) |
| `bananagig-api` | resource server, no flows | The `aud` of API access tokens. Never used to obtain tokens |
| `bananagig-security` | confidential, client credentials only, service account with `realm-management` `manage-users` (ID-004) | The ONLY service account: the API asks Keycloak about a user's credentials and sessions, ends sessions and sends the reset email. No redirect URIs, no browser or password flow. See "Service accounts" |
| `bananagig-admin` | public, code flow, PKCE S256, own browser flow | Future admin console. Separate redirect host, shorter tokens, MFA-ready flow |
| `bananagig-dev-test` | **DEV/TEST ONLY**, password grant | Automated token acquisition for tests and smoke. Flagged `bananagig.devOnly`, removed from production realm builds |
| `admin-cli` | disabled | Keycloak's built-in client enables the password grant in every realm; it is disabled here |

Built-in `account` and `account-console` are DECLARED and DISABLED (ID-004: the account console would let a user manage credentials and sessions outside BananaGig; Caddy refuses its path as a second line). `broker`, `realm-management` and `security-admin-console` remain as Keycloak defaults. The BananaGig login theme is still open (DEBT-0019).

Realm policy: no public registration, brute-force protection (5 failures in 15 minutes lock the user for 15 minutes), `sslRequired=external` (all outside localhost/private networks), passwords of at least 12 characters, TOTP policy, "Keep me signed in" 30 days, refresh-token rotation with one tolerated reuse, no Keycloak email verification, `resetPasswordAllowed=false` (a reset is started by the BananaGig endpoint, which rate limits and records it; Keycloak only sends the link, through the SMTP server of the realm: Mailpit in development), an explicit `requiredActions` list (`delete_credential`, WebAuthn registration and `idp_link` disabled). Details and the reasons: `docs/engineering/SESSIONS_AND_MFA.md`.

`pnpm identity:check` lints the realm file against these rules (no implicit flow, no password grant except on the dev-only client, PKCE S256 on browser clients, exact redirect URIs, admin separated, no personal-data scopes, the single allowed service account with exactly `manage-users`, the web flow, MFA floor and `acr.loa.map` consistent, the built-in account clients disabled, the required actions declared, the brute-force, remember-me and rotation values, no development SMTP server in a production realm). It runs in CI and in unit tests.

### Versioning realm changes

1. Edit `infra/keycloak/bananagig-realm.json`.
2. `pnpm identity:check` and `pnpm test` (realm policy tests).
3. Apply locally: `pnpm identity:sync` (deletes and re-imports the realm in the running dev Keycloak; DEV ONLY, refuses non-local targets) or `pnpm stack:reset`. `--import-realm` alone skips a realm that already exists. A realm change reaches a running dev stack ONLY this way, and the recreated realm gives the development users NEW subjects: their next login creates new, empty BananaGig accounts (the old ones stay, unlinked) and every session is lost. Until it is run, the `bananagig-security` client does not exist and the security layer sees Keycloak as unavailable.
4. Run `pnpm test:integration` (live configuration and protocol tests) and `pnpm smoke`.
5. Commit the JSON with the change that needs it. The realm file is reviewed like code.

Production: `pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com --out realm.json` produces the production realm: dev-only client and users removed (the service-account user is KEPT: it carries the `manage-users` mapping), the development secret of `bananagig-security` stripped (Keycloak generates one), the development SMTP server removed (the command prints a notice: provision the production SMTP server), real https origins, `sslRequired=all`, admin OTP made unconditional. It is linted with the production rules. Provisioning that realm, the service-account secret and the SMTP server into a production Keycloak is not designed yet (DEBT-0016, DEBT-0004, DEBT-0071).

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
- Logout is POST only and requires `Origin` equal to the web origin (plus SameSite): it first tells the API to end the application session (best effort, 2 seconds, a failure never keeps the person signed in), then deletes the server session, clears the cookie, and redirects to Keycloak's end-session endpoint with `id_token_hint`. There is no GET logout link (CSRF).
- Expired sessions: the access token is refreshed server-side shortly before expiry (single-flight per session id in a process: the realm rotates refresh tokens and tolerates one reuse); a failed refresh deletes the session and the user is signed out.
- A session the API revoked (`401 SESSION_REVOKED`) is ended at once by the web server: it deletes its Valkey session, clears the cookie and sends the browser through Keycloak's end-session endpoint to `/session?error=session_revoked`, so the SSO cookie cannot sign the browser in again silently.
- The login accepts closed-list query parameters `stepUp=recent|mfa` and `kcAction=totp|recovery` (ID-004, `SESSIONS_AND_MFA.md`): a step-up asks Keycloak for a fresh authentication (`prompt=login`, plus `acr_values=bananagig:mfa`) in one round trip and the callback verifies from the token that it was reached; a `kc_action` (enrol a factor) is honoured only with the one-shot enrollment marker of the browser session. The browser's `acr_values` is never a source of truth: the flow's floor enforces the second factor and the API reads `acr` and `auth_time` from the verified token.
- After a successful login the callback registers the browser with the API (the device cookie `bg_device`, `__Host-bg_device` on https; the secret goes in a request body only).
- Sessions live in Valkey under `bg:<env>:web:session:<id>` with a TTL equal to the refresh lifetime. Valkey is non-authoritative: losing it signs users out, nothing more.

## Hostnames and issuer

Browsers use `http://auth.localhost:8080` (Caddy). Containers call `http://keycloak-auth:8080` directly. Keycloak is started with `KC_HOSTNAME=http://auth.localhost:8080` and `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, so tokens always carry `iss=http://auth.localhost:8080/realms/bananagig` whichever URL requested them, while back-channel endpoints (token, JWKS) follow the caller's host. The API verifies the pinned issuer and fetches keys from the internal JWKS URL.

Config (`@bananagig/config`): `KEYCLOAK_URL` (internal), `KEYCLOAK_PUBLIC_URL` (issuer base), `KEYCLOAK_REALM`, `KEYCLOAK_API_AUDIENCE`, `KEYCLOAK_WEB_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_SECURITY_CLIENT_ID` and `KEYCLOAK_SECURITY_CLIENT_SECRET` (the service account of ID-004; the secret is required by the API in production and the development placeholder is refused there), `WEB_PUBLIC_URL`.

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
| Customers/providers | Enrolment is voluntary (`/security`, through Keycloak `kc_action`). A user WHO HAS a TOTP credential or recovery codes is always asked for one: the web flow `bananagig-browser` plus the client floor `minimum.acr.value=bananagig:mfa` make level 2 mandatory for them; a user without a factor signs in with a password only (`acr=bananagig:password`) | Same. Not forced; no email or SMS one-time-code factor yet (DEBT-0067) |
| Admin client | OTP required only once the user has a TOTP credential (conditional) | OTP **required and enrolment forced**: `pnpm identity:build-prod` makes the OTP sub-flow unconditional |
| Step-up | `acr.loa.map` maps `bananagig:password`=1, `bananagig:mfa`=2. The API guards `requireRecentAuthentication()` and `requireMfa()` read `auth_time` and `acr` from the verified token and answer `401 STEP_UP_REQUIRED` (RFC 9470) or `403 MFA_ENROLLMENT_REQUIRED`; only the trusted-browser and enrolment routes use them so far (DEBT-0050, DEBT-0062) | Same |
| Recovery codes | Keycloak's own `recovery-authn-codes` credential, enrolled through `kc_action=CONFIGURE_RECOVERY_AUTHN_CODES`; numbered, single use; BananaGig stores none | Same |
| Trusted browser | Recorded and shown by BananaGig; it does NOT change when Keycloak asks for a code (DEBT-0066) | Same |
| WebAuthn | Policy defaults declared only; its required actions are disabled | Deferred (DEBT-0018) |
| Password reset | Started by `POST /api/v1/auth/password-reset`; Keycloak emails the single-use link to its own address of the user (Mailpit in development); the recovery by phone and the support route are not built (DEBT-0067) | Same, once a production SMTP server is provisioned |

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

The account routes (ID-001) build on these guards: `requireAccount({ includeProfile?, honorActiveRoleHeader? })` (`apps/api/src/plugins/account.ts`) authenticates (401), requires the normal web context (403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` for the admin context and any other client), maps the verified issuer and subject to the account (creating it on the first request), refuses `SUSPENDED` and `CLOSED` accounts (403) and sets `request.account`. It never reads an account id, subject or role from the client (the subject comes from the verified token only). Since ID-004, when the security service is wired it also resolves the token's `sid` to an application session (created on first sight): a token without `sid` is `401 INVALID_TOKEN` and a revoked session is `401 SESSION_REVOKED` at once although the access token is still valid (`SESSIONS_AND_MFA.md`). `Principal` gained `authTime` (the `auth_time` claim). Routes that use only `requireAuthenticated()` (for example `GET /system/whoami`) do not consult the registry (DEBT-0074).

| Route | Purpose | Notes |
|---|---|---|
| GET `/api/v1/account/me` | the caller's own account: id, status, ACTIVE application roles, preferred role, active role, profile | optional `x-active-role` header validated against the ACTIVE roles on every request (403 `ACCOUNT_ROLE_NOT_HELD` or `ACCOUNT_ROLE_NOT_ACTIVE`; an empty header is refused as `ACCOUNT_ROLE_NOT_HELD`, the web server omits the header instead of sending it empty); no query parameters |
| POST `/api/v1/account/active-role` | validate a role switch `{ role }` and return the account with that active role | persists nothing and does not touch Keycloak |
| PUT `/api/v1/account/profile` | replace the caller's own profile (first and last name, optional locale and time zone) | strict body, idempotent |
| GET `/api/v1/account/email` | the caller's own email verification state (ID-002): status, masked primary and pending address, resend countdown, attempts left, code length | masked only; `no-store` |
| POST `/api/v1/account/email` | set the address to verify `{ email }` (first address or a pending replacement) | strict body; sends nothing |
| POST `/api/v1/account/email/verification/send` | send or resend the verification email (code and magic link) | cooldown and hour/day caps from configuration; 429 with `Retry-After` |
| POST `/api/v1/account/email/verification/confirm-code` | confirm with `{ code }` | wrong codes are counted and lock the verification |
| POST `/api/v1/account/email/verification/confirm-link` | confirm with `{ token }` | the token is in the body, never in a URL |
| GET `/api/v1/account/phone` | the caller's own phone verification state (ID-003): status, masked primary and pending number, resend countdown, attempts left, code length, validity | masked only; `no-store` |
| POST `/api/v1/account/phone` | set the number to verify `{ phone, country? }` (first number or a pending replacement) | strict body; sends nothing |
| POST `/api/v1/account/phone/verification/send` | send or resend the verification SMS (code only, no link) | cooldown and hour/day caps from configuration; 429 with `Retry-After` |
| POST `/api/v1/account/phone/verification/confirm-code` | confirm with `{ code }` | wrong codes are counted and lock the verification |
| `/api/v1/account/security/*` (12 operations) and POST `/api/v1/auth/password-reset` (public) | application sessions, browsers, second-factor state, step-up-protected actions, the security timeline and the password reset (ID-004) | listed with their guards and errors in `docs/engineering/SESSIONS_AND_MFA.md`; `no-store` |

The email in Keycloak is a login identifier only: access tokens carry no email claim and BananaGig never trusts or copies it (ADR-0027). Keycloak holds no phone number and access tokens carry no phone claim; BananaGig owns the phone contact (ADR-0031, `docs/engineering/PHONE_VERIFICATION.md`). Errors use the standard model with `ACCOUNT_<code>` codes (`ACCOUNT_SUSPENDED`, `ACCOUNT_CLOSED`, `ACCOUNT_ROLE_NOT_HELD`, `ACCOUNT_ROLE_NOT_ACTIVE`, `ACCOUNT_VALIDATION_FAILED`, `ACCOUNT_CONFLICT`, `ACCOUNT_INVALID_STATE`, `ACCOUNT_UNAVAILABLE`); every response of a matched account route, errors included, carries `Cache-Control: no-store` (the caller's own personal data); the full reference is in `docs/engineering/ACCOUNTS.md`. Readiness of the API still depends on PostgreSQL only: a Keycloak outage fails authenticated routes, not public ones.

## Telemetry and logging

Metrics: `auth_token_validations_total{result}`, `auth_token_validation_failures_total{category}` (missing, malformed, signature, expired, not_yet_valid, issuer_mismatch, audience_mismatch, wrong_token_type, claims_invalid, jwks_unavailable, unsupported_algorithm), `auth_issuer_audience_mismatch_total{kind}`, `auth_token_validation_duration_seconds`. Failures log the category only. Tokens, authorization codes, refresh tokens, passwords and OTP secrets are never logged (a test asserts no token or token segment appears in log output; the logger also redacts keys such as `token` and `authorization`).

## Service accounts

One exists since ID-004: `bananagig-security` (ADR-0035), the identity of the API when it asks Keycloak about a user's credentials and sessions, ends sessions and sends the reset email. Confidential, client credentials only (standard, implicit and password flows off), no redirect URIs, `fullScopeAllowed` false, a 120-second token, no refresh token, and one role: `realm-management` `manage-users` (the lab showed it is the minimum: ending sessions and `execute-actions-email` are 403 below it). `manage-users` is realm-wide user administration, so the secret is as sensitive as an administrator credential (fine-grained admin permissions are not used yet, DEBT-0071). The policy linter allows service accounts on this client only, with exactly that role.

Any further machine-to-machine need follows the same rules: a dedicated confidential client per integration (never a shared one), client-credentials grant only, the secret held in the secret manager (never committed or logged), an audience restricted to the one API it needs, least-privilege client roles, and never used to impersonate or act on behalf of a user. Add it through the realm file, the policy linter and an ADR/PR note.

## Secrets

Keycloak admin credentials, database credentials and any future confidential-client secret come from environment/secret storage only. `.env.example` holds fake `*_dev_only` placeholders; the realm file contains dev-only user passwords (`dev_only_*`, enforced by test) and ONE client secret, the development placeholder of `bananagig-security` (`bananagig_security_dev_only_secret_0001`, which a test requires to equal the `KEYCLOAK_SECURITY_CLIENT_SECRET` development default; the linter requires a `dev_only` value in the development realm and no secret at all in a production realm). `KEYCLOAK_SECURITY_CLIENT_SECRET` is required by the API in production and the placeholder is refused there; the production realm build strips the secret and Keycloak generates one. The production secret manager is not wired yet (DEBT-0016). `bananagig-api` has a Keycloak-generated secret that nothing uses.

## Caddy routes

| Host | Exposes |
|---|---|
| `auth.localhost` | **Only** `/realms/bananagig/*` and `/resources/*` (login, token, logout, JWKS, discovery, static). Admin console, master realm, health, metrics and everything else return 404. Since ID-004 also 404: `/realms/bananagig/account*` (the account console) and `/realms/bananagig/login-actions/reset-credentials*` (the self-service reset), matched BEFORE the wholesale realm proxy; `/login-actions/action-token` (the link in the reset email) stays open |
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

Keycloak `start` with TLS and a real hostname, secrets manager including the `bananagig-security` client secret (DEBT-0016, DEBT-0071), production realm provisioning from `identity:build-prod` and the production SMTP server (DEBT-0004), SMS and the email/SMS recovery factors (DEBT-0017, DEBT-0067), WebAuthn (DEBT-0018), a BananaGig login theme (DEBT-0019; the built-in account console is already disabled), remove the dev admin host from the proxy, and a Keycloak backup/restore drill (it shares PostgreSQL, DEBT-0015).
