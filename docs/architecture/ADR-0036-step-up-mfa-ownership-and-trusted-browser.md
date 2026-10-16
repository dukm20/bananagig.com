# ADR-0036 — Keycloak owns the second factor and recovery codes, step-up is enforced by the flow and read from the token, and a trusted browser is a record with no login-time effect

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ID-004

## Context

The PRD asks for a second factor (an authenticator app now; email and SMS codes later), recovery codes, a step-up before sensitive actions (CU-09.14) and a trusted browser for a configured number of days (CU-09.13). The web client's browser flow had no second-factor step and `acr_values` was never requested (DEBT-0018). The Keycloak lab (26.3.5) established what the server actually does: an authorization request without `acr_values` skips a level-of-authentication condition entirely; `acr_values` is ignored for a user without a factor and an essential `claims` acr is not enforced for such a user; the browser can drop or change any authorization parameter; recovery codes ask for a numbered code and cannot be created through the admin REST API; and there is no way to skip the OTP step for a given browser without a custom extension.

## Decision

- **Keycloak owns the factors and the recovery codes.** BananaGig stores no secret and no code. The authenticator app and the recovery codes are enrolled through Keycloak's application-initiated actions (`kc_action=CONFIGURE_TOTP`, `CONFIGURE_RECOVERY_AUTHN_CODES`); BananaGig records the request (audit), sends the browser there and observes the result (ADR-0034). A support reset is a credential delete through the service account.
- **The second factor is enforced by the flow itself.** The web client has its own flow `bananagig-browser` (cookie, else password, then a conditional OTP or recovery-code step for users who have a factor) and the client attribute `minimum.acr.value=bananagig:mfa`, which makes level 2 the floor for every authorization request whatever the URL says. Users without a factor get password only (`acr=bananagig:password`). The consequence is that password-only users re-enter their password on each authorization request (their SSO cookie is below the floor); that cost is accepted.
- **The API reads the `acr` and `auth_time` claims of the verified token and nothing else.** `requireRecentAuthentication()` and `requireMfa()` follow RFC 9470: `401 STEP_UP_REQUIRED` with `WWW-Authenticate: Bearer error="insufficient_user_authentication", max_age=..., acr_values=...` and the same data in `details`; a user with no TOTP gets `403 MFA_ENROLLMENT_REQUIRED` instead of a loop; an unreadable provider is a fail-closed `503`. The window is `security.step_up_valid_minutes`. The web asks Keycloak for the stronger authentication (`prompt=login`, `acr_values`) in ONE round trip and verifies from the returned token that it was reached; a marker in the login transaction prevents a second trip. The browser's `acr_values` is never a source of truth.
- **A trusted browser is a record without a login-time effect.** It is registered by an HttpOnly device cookie, stored as a keyed hash, trusted for `session.trusted_browser_days`, shown to the owner, expiring by the clock and revoked by untrust, removal or the end of its sessions. It does NOT change when Keycloak asks for a code and it never satisfies a step-up guard. The product copy and the API summaries say so plainly. What remains true is that Keycloak's own remembered session (Keep me signed in, 30 days, MFA level remembered for the same period) spares an OTP user a repeat prompt on that browser while the SSO session lives.
- **The built-in Keycloak self-service surface is closed.** The `account` and `account-console` clients are disabled, `requiredActions` is declared explicitly with `delete_credential`, WebAuthn registration and `idp_link` disabled (any client could start `kc_action=delete_credential` for a signed-in user and remove the second factor unseen), `resetPasswordAllowed` is false, and Caddy refuses the account console and the reset-credentials flow.

## Alternatives considered

- Request `acr_values` from the browser and trust the result: Keycloak ignores it for users without a factor and the browser can drop it. Enforcement must be intrinsic to the flow. Rejected.
- Enforce the second factor only in the API (reject tokens with `acr` password): users who have a factor could sign in without ever being asked for it, and the API cannot make Keycloak ask. The floor makes Keycloak ask; the guards remain as the check. Both are kept.
- Gate the password form by level: password-only users then fail with "Invalid username or password" on SSO re-entry. Rejected after the lab.
- Nest the factors under the User Configured condition: breaks every login (lab). They are flat siblings.
- A trusted browser that skips OTP: needs a Keycloak extension. Two designs are preferred for later (DEBT-0066): (a) an offline-session-backed trusted browser, where trusting makes Keycloak keep a long-lived session for that browser and the trusted window is the session lifetime; (b) a signed request object (RFC 9101) in which BananaGig tells Keycloak, tamper-proof, that the device is trusted, consumed by a custom authenticator in the flow. Passing the trust through `acr_values` or an essential claim is not an option, because both are carried by the browser. None of them may let a trusted browser satisfy a step-up guard.
- Store the factor state (a "has MFA" flag) in BananaGig: a copy that drifts from Keycloak. Rejected for asking (and observing).
- Keep the Keycloak account console for factor management: no step-up, no audit, no session registry. Rejected; the security page replaces it.

## Consequences

The step-up primitive exists and is unit and integration tested but is wired only into the trusted-browser and enrolment routes; `requireMfa()` has no caller and changing an email or phone is not yet protected (DEBT-0050, DEBT-0062). Only TOTP and recovery codes exist: no email or SMS one-time code, no step-up for an account without TOTP, no phone confirmation after a reset and no support route for a person who lost both channels (DEBT-0067). WebAuthn is closed with its required actions until it is built (DEBT-0018). The trusted browser has no login-time effect (DEBT-0066). Realm changes reach a running dev stack only through `pnpm identity:sync`, which recreates the development users with NEW subjects.

## Migration / compatibility

No schema change beyond ADR-0034. The realm file gains the flow, the floor, the service-account client, the explicit required actions and the disabled built-in clients; `scripts/lib/realm.mjs` gains the lint rules and the production build keeps the service-account user. Existing users with a TOTP credential are asked for it at their next authorization request.

## Related files

- `infra/keycloak/bananagig-realm.json`
- `scripts/lib/realm.mjs`
- `infra/caddy/Caddyfile`
- `apps/api/src/plugins/step-up.ts`
- `apps/web/src/lib/auth/handlers.ts`
- `apps/web/src/lib/auth/security-handlers.ts`
- `packages/identity/src/oidc.ts`
- `docs/engineering/SESSIONS_AND_MFA.md`
- `docs/architecture/ADR-0015-admin-identity-separation.md`
