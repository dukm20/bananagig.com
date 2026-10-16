# ADR-0034 — BananaGig keeps a registry of application sessions that it enforces on every request, and the security timeline is a read model over the audit log

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ID-004

## Context

The PRD asks that a person can see where they are signed in, sign out of one session or everywhere, and that "Sign out everywhere ends all other sessions within one minute" (CU-09.20, SV-01.12). Keycloak owns the protocol sessions, but it issues access tokens that live 300 seconds and an API that validates only signature and expiry accepts a revoked session's token until it expires. Ending the Keycloak session does stop the refresh token, but it cannot recall a token already issued, and it tells the application nothing per request. The person also needs a security activity log (sign-ins, sign-outs, browser, second-factor and password changes, contact changes) for a configured period. The question is where the session state lives, how the API enforces it and what the timeline is built on.

## Decision

- **A registry of application sessions in PostgreSQL that references the Keycloak `sid`.** `identity.application_sessions` has one row per Keycloak session the API has seen, created on first sight. It holds the `sid` (unique, never logged, returned or audited; the API hands out an opaque application session id), the account, the browser (device) it came from, the seen time and a terminal revocation with a reason. It stores no token and no credential. Browsers live in `identity.account_devices` (ADR-0036 covers what a trusted browser means).
- **Enforcement on every request, in the API.** `requireAccount()` resolves the verified token's `sid` to its row in ONE statement (read the state, touch `last_seen_at` at most once a minute). A revoked row, or a row that belongs to another account, is `401 SESSION_REVOKED` at once. The guarantee therefore does not depend on the access token's lifetime, and "within one minute" holds for every route behind `requireAccount()`. Keycloak is told afterwards, best effort, so the refresh token and the SSO cookie stop working too; the database row is authoritative and an unreachable Keycloak never undoes a revocation.
- **A revocation watermark for sessions the API has not seen.** A Keycloak session may exist that the API never saw (the person signed in on another device and has not made a request yet). Revoke-all raises `identity.accounts.sessions_not_before`; a session FIRST SEEN after that with an `auth_time` older than the watermark (with a 2-second tolerance) is refused. First sight takes the account row `FOR SHARE` and revoke-all takes it `FOR UPDATE`, so the two serialize. A session that already has a row is governed only by its own `revoked_at`, so a later login works.
- **Derived state, not stored state.** A session is active when it is not revoked, within the `session.keep_signed_in_days` window and, when Keycloak can be asked, still known to Keycloak; the listing closes rows that are not (`KEYCLOAK_ENDED`). There is no `status` or `expires_at` column that could drift from Keycloak.
- **The timeline is a read model over `identity.account_audit_events`.** The security actions (sixteen, added to the audit action list) and the contact changes of ID-002 and ID-003 are filtered to the configured period and shown newest first with a coarse device taken from the session. There is no activity table: the audit log is already append-only, written in the transaction of the change and the single source of what happened.
- **Observed transitions.** Keycloak does not tell BananaGig when a factor or the password changes, so the service observes them (at the overview and at login registration) by comparing Keycloak's credential kinds and the password creation time with the LAST such audit action, under the account lock, writing `MFA_ENABLED`, `PASSWORD_CHANGED` and so on idempotently. A password change also revokes the account's older sessions (`PASSWORD_CHANGED`), because Keycloak 26.3.5 has no native default for that. A factor already present the first time it is seen is anchored as a baseline, not a transition.

## Alternatives considered

- Store the tokens or token ids and revoke them: BananaGig would hold bearer credentials, and a token id is not what the application needs; the `sid` is stable across refreshes. Rejected.
- Rely on the access token's expiry (300 s) and on Keycloak ending the session: "sign out everywhere" would take up to five minutes and a Keycloak outage would make it fail silently. Rejected: that would not meet the PRD.
- Introspect the token with Keycloak on every request: a network call per request makes Keycloak a hard dependency of every authenticated route and still says nothing about the application's own revocations (a removed browser). Rejected.
- Back-channel logout only: a notification that can be lost or delayed, needs a public endpoint and a delivery guarantee, and does not cover sessions the API has not seen. It could complement the registry later; it cannot replace it.
- A separate activity table: a second copy of facts the audit log already holds, with its own writes to keep consistent. Rejected for a filtered read of the audit log.
- Make the watermark apply to every session: a login made after "sign out everywhere" would be refused too, or every row would have to be revoked individually. Rejected for the first-sight-only rule.

## Consequences

Every authenticated request reads one indexed row; a revoked session costs the same read and is refused. Routes that use only `requireAuthenticated()` (for example `GET /system/whoami`) do not consult the registry and accept a revoked session's token until it expires (DEBT-0074); new account routes must use `requireAccount()`. Sessions, devices and the security audit rows are never deleted and hold personal data (DEBT-0057). The audit time of an observed transition is the observation time, and a password change made elsewhere ends the other sessions only when the owner next logs in or opens the security page (DEBT-0068). Keycloak's events are not consumed.

## Migration / compatibility

Migration `0012_application_sessions.sql` (forward-only): two tables with guard triggers, the nullable `sessions_not_before` column, the wider audit action list with a session and a device reference, six configuration parameters and the managed copy. Existing accounts have no sessions; rows appear at the next authenticated request. Without the security service wired, `requireAccount()` behaves as before.

## Related files

- `db/migrations/0012_application_sessions.sql`
- `packages/accounts/src/security-service.ts`
- `packages/contracts/src/security.ts`
- `apps/api/src/plugins/account.ts`
- `apps/api/src/modules/security/routes.ts`
- `docs/engineering/SESSIONS_AND_MFA.md`
- `docs/architecture/ADR-0025-application-account-and-keycloak-identity-separation.md`
- `docs/architecture/ADR-0014-bff-session-pkce.md`
