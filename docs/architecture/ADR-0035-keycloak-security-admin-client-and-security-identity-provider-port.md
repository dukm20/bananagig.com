# ADR-0035 — BananaGig asks Keycloak through a dedicated service account behind a SecurityIdentityProvider port, and propagation is best effort

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ID-004

## Context

Keycloak owns passwords, TOTP, recovery codes and protocol sessions (ADR-0013). The security layer (ADR-0034) needs four things only Keycloak can do or know: whether a user has a TOTP credential or recovery codes and when the password was created, the list of the user's protocol sessions, ending one or all of them, and sending the single-use password-reset link. That is the Keycloak admin REST API. Until now no service account existed (IDENTITY.md said none was justified), so this checkpoint is the first machine-to-machine credential of the platform and must be as narrow as the lab allows.

## Decision

- **One dedicated confidential client, `bananagig-security`, client credentials only.** Standard, implicit and direct-access flows are off (a password grant and a browser flow fail), there are no redirect URIs or origins, `fullScopeAllowed` is false, the default scope is `roles` (without it the token carries no `resource_access`), the access token lives 120 seconds and no refresh token is issued. Its service-account user holds the `realm-management` role `manage-users` and nothing else, and the same role is scope-mapped to the client. `scripts/lib/realm.mjs` lints all of it and forbids any other client from enabling a service account.
- **`manage-users`, because the lab measured it as the minimum.** Reading the user, credentials and sessions works with `view-users`; ending one session (`DELETE sessions/{sid}`), ending all of a user's sessions (`POST users/{id}/logout`) and `execute-actions-email` return 403 below `manage-users`. `query-users` only adds user search. The role is realm-wide user administration; the accepted blast radius and why fine-grained admin permissions are not used yet are in the consequences.
- **A port in `accounts`, a client in `identity`.** `SecurityIdentityProvider` (`packages/accounts/src/security-types.ts`) has five methods (`getUserSecurity`, `listSessions`, `endSession`, `endAllSessions`, `sendPasswordResetEmail`) and an `available` flag. `KeycloakAdminClient` (`packages/identity/src/keycloak-admin.ts`) is fetch based, has no dependency, caches the token until 30 seconds before expiry with one in-flight refresh, uses a 5-second timeout, never retries and reduces every failure to a `KeycloakAdminError` carrying a CODE (never a body, token, secret, URL or id). `identity` imports nothing from the workspace, so it declares the same shape locally and the composition root (`apps/api/src/modules/security/wiring.ts`) adapts it, turning every client error into the port's `SecurityProviderUnavailableError`. A null provider (`available = false`) exists for processes without the secret; the in-memory `FakeSecurityIdentityProvider` serves tests.
- **Best-effort propagation with reported outcomes.** The database commit is authoritative; Keycloak is called AFTER it, with no lock held. A revocation reports `keycloak`: `ENDED`, `UNAVAILABLE` or `NOT_NEEDED`; a failure is retried only when the next revoke or session listing sees the session still listed (bounded). The security overview treats a Keycloak failure as "unknown" (`mfa.available: false`), the step-up guard that needs to know fails closed (`503 ACCOUNT_SECURITY_UNAVAILABLE`), and the password reset sends nothing.
- **The secret is a deployment secret.** `KEYCLOAK_SECURITY_CLIENT_SECRET` (32 to 256 characters) is required by the API role in production and the published development placeholder is refused there; the production realm build strips the secret and keeps the service-account user.

## Alternatives considered

- Use the master realm admin credentials or `admin-cli`: a human, realm-superuser credential in an application process. Rejected.
- `view-users` only: cannot end sessions or send the reset email, which would leave "sign out everywhere" application-side only. Rejected as insufficient, and kept in mind for a read-only second client.
- Fine-grained admin permissions (restrict the role to specific users and operations): the feature is disabled in this stack (`ADMIN_FINE_GRAINED_AUTHZ` needs a `--features` change) and was not tried. Deferred (DEBT-0071).
- Let the web server call Keycloak with the user's own token (account API): the built-in account REST API is closed on purpose (ADR-0036) and a user token cannot end other users' sessions or send the link.
- Call the admin API inside the transaction, or retry through a queue: holds a lock across a network call, or builds a retry subsystem for a best-effort step. A queue is possible later (DEBT-0072).
- Import the identity package into `accounts`: breaks the workspace boundary (`pnpm deps:check`). Rejected for the structural port.

## Consequences

The platform now holds a credential that can administer every user of the realm: whoever obtains the secret can create, change and delete users, set credentials, end sessions and send required-action emails (it cannot change realm settings or clients). Containment is the narrow client, a secret only the API process holds and a lint rule on the realm file. Production needs the secret generated and injected (DEBT-0016, DEBT-0071). A wrong secret or a realm that was not re-imported makes Keycloak "unavailable" to the security layer without breaking the application's own revocation. The admin calls on the security overview and the session list are not throttled or cached (DEBT-0072).

## Migration / compatibility

No schema change beyond ADR-0034. `.env.example`, `compose.yaml` and `packages/config` gain `KEYCLOAK_SECURITY_CLIENT_ID` and `KEYCLOAK_SECURITY_CLIENT_SECRET`. A running dev Keycloak needs `pnpm identity:sync` to create the client.

## Related files

- `packages/identity/src/keycloak-admin.ts`
- `packages/accounts/src/security-types.ts`
- `packages/accounts/src/security-fakes.ts`
- `apps/api/src/modules/security/wiring.ts`
- `infra/keycloak/bananagig-realm.json`
- `scripts/lib/realm.mjs`
- `packages/config/src/index.ts`
- `docs/engineering/SESSIONS_AND_MFA.md`
- `docs/architecture/ADR-0013-keycloak-identity-provider.md`
