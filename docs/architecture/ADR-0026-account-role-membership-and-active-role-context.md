# ADR-0026 — Application roles are reference data with one membership row per account and role; the active role is request-scoped context

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: ID-001

## Context

The PRD lets one login hold a customer role and a provider role and switch between them without signing out (CU-03.03, CU-09.23), lists the roles in the account area (SV-11.08), and lets an email already used by a customer login add the provider role to the same login (PR-01.04). Admin accounts are separate logins and cannot hold customer or provider roles (SV-11.08, ADR-0015). Keycloak realm roles (`customer`, `provider`) are coarse identity claims issued by another system (ADR-0015: identity roles are not application permissions), and tokens live for minutes.

The platform therefore needs a model for which roles exist, which roles an account holds, a durable preference between them, and the role a single request acts as, together with a rule for who may grant a role and how concurrent or repeated grants behave.

## Decision

- **Roles are reference data.** `identity.roles` holds `CUSTOMER` and `PROVIDER` (upper-case immutable `code`, display name as a content key `identity.role.<code>.name`, status `ACTIVE` or `INACTIVE`, never deleted). They are marketplace roles of an account, not Keycloak roles and not fine-grained permissions (those arrive with the features that need them). A role cannot be deactivated while any membership holds it (`ROLE_IN_USE`), and a membership cannot be granted for an inactive role.
- **One membership row per account and role.** `identity.account_roles` has the primary key `(account_id, role_id)`: an account can hold both roles but never the same role twice, so "no duplicate active membership" is a key, not an application check. Status `PENDING`, `ACTIVE`, `INACTIVE` is bound to `activated_at` and `deactivated_at` by a lifecycle CHECK and to its transitions by a guard trigger. Re-granting a deactivated role reactivates the same row; the row describes the latest grant (`granted_by`, `grant_source`) and the history of grants and deactivations is in the immutable `identity.account_audit_events`. Closing an account deactivates its memberships and clears the primary role, auditing each.
- **A persisted preferred (primary) role.** `accounts.primary_role_id` is a composite foreign key `(account_id, primary_role_id)` to the account's own membership, so it can only name a role the account holds; triggers add that the membership is ACTIVE (`PRIMARY_ROLE_NOT_ACTIVE`) and refuse deactivating it while it is the primary role (`PRIMARY_ROLE_IN_USE`). The first role that becomes ACTIVE becomes the account's primary role; the service moves or clears it before deactivating a role and when the account closes. It is a preference that only decides the default active role, never a permission.
- **The active role is request-scoped context and is not persisted.** The web server keeps the chosen role in its server session and sends it in the `x-active-role` header; the API validates it against the ACTIVE memberships PostgreSQL holds on EVERY request (403 `ACCOUNT_ROLE_NOT_HELD` or `ACCOUNT_ROLE_NOT_ACTIVE`; a malformed or empty header is `ACCOUNT_ROLE_NOT_HELD`, and the web server omits the header instead of sending it empty). Without a requested role the active role is the primary role if it is still active, else the only ACTIVE role, else null (the client must choose). `POST /api/v1/account/active-role` is pure validation that returns the account with that role resolved; it persists nothing and does not call Keycloak, so switching role never creates a Keycloak login or session (CU-03.03).
- **No endpoint grants a role.** Granting, deactivating and changing the preferred role are server-side `AccountService` operations (`grantRole`, `deactivateRole`, `setPrimaryRole`): provider sign-up (PR-01) will add `PROVIDER` to an existing account with source `SIGNUP`, support and admin flows use `ADMIN`, and the one-time bootstrap uses `BOOTSTRAP` (ADR-0025). A client can never choose its own role.
- **Application authorization reads the account, not the token.** Features that behave per role read `request.account.activeRole` and `request.account.roles` (from PostgreSQL), never the Keycloak realm roles in `request.principal`.
- **Idempotency and concurrency by natural uniqueness.** Granting an ACTIVE role, deactivating an INACTIVE one, repeating a profile write or a status change write nothing and emit nothing; the membership primary key makes a duplicate impossible, and every mutation locks the account row first (one lock order: the ACCOUNT row first (`FOR UPDATE`), then the ROLE row (`FOR SHARE`), then the membership, identity and profile rows of that account; the service's `grantInTx` takes the role share lock before the membership row lock and there is no lock cycle). No idempotency table is needed (DEBT-0013 evaluated, stays open). A role deactivation or an account closure racing a grant serializes on the row locks and exactly one wins.
- **Events and audit.** `account-role-granted` (when a membership becomes ACTIVE) and `account-role-deactivated` carry the account id and role code (the granted event also the source) only; `account-role-deactivated` is emitted only for a membership that was ACTIVE, because a PENDING membership was never announced by `account-role-granted` (its deactivation is audited but not announced). Every grant, activation, deactivation and primary role change writes an audit row with actor, source and reason, and closing an account writes a `PRIMARY_ROLE_CHANGED` row when it clears a primary role, in addition to the `ROLE_DEACTIVATED` rows. The actor (`account:<id>`, `system:<name>` or `admin:<subject>`, admin actions arriving with AD-07) names who acted; it is not the subject of the account being changed.

## Alternatives considered

- Persisting the active role (a column on `accounts` or a sessions table): a second source of truth beside the web session, two browsers of one account would overwrite each other, it needs its own consistency rule against deactivation, a navigation click would write the hottest row, and it goes stale across logout. Rejected; only the preference is persisted.
- Carrying the active role (or the application roles) in the Keycloak token through a mapper: tokens live for minutes, so a role change or a switch would need a new token, which is a new Keycloak login or session and contradicts "switch without signing out"; it would also make Keycloak the authority for application state. Rejected.
- Using the Keycloak realm roles as the application roles, or synchronizing them into the database: identity facts versus marketplace state (ADR-0015); a copy that can drift and an authorization decision that depends on token age. Rejected.
- Booleans (`is_customer`, `is_provider`) or a role array on `accounts`: a new role is a schema change for every row, no per-role lifecycle, grant source or audit, no foreign key for events, no managed display name. Rejected.
- One membership row per grant episode (history in the same table): a duplicate ACTIVE membership then needs a partial unique index and a sort to find the current row. Rejected; one row per (account, role) and the episodes in the audit table.
- `is_primary boolean` on the membership with a partial unique index: moving the preference changes two rows, and nothing says the flagged membership is the account's own. Rejected for the composite foreign key pointer.
- A foreign key without the ACTIVE trigger, or a trigger without the foreign key: the key proves the membership exists and is this account's, the trigger proves it is ACTIVE; neither alone gives both, and a CHECK cannot read another table. Both are kept.
- An endpoint `POST /account/roles` for self-service role addition: a client-chosen role is a privilege escalation surface, and the provider role needs the provider sign-up data (acknowledgements, verification, PR-01) that does not exist yet. Rejected for server-side grants.
- Trusting the role header without validation, or validating it once and caching the answer in the session: a deactivated or never-held role would keep working. Rejected; the header is checked against PostgreSQL on every request (cost: DEBT-0047).
- A separate account per role of one login: the PRD says one login holds both roles (CU-03.03, PR-01.04). Rejected.

## Consequences

Role changes take effect on the next request: a role deactivated during a session turns the next request that names it into a 403 until the web server switches. Every request validates the header against PostgreSQL (an index lookup of the account's few memberships, no cache yet, DEBT-0047). `activeRole` can be null for an account with several roles and no active preference; the client must choose and the screens for that are not built (DEBT-0048). The preferred role changes only through the service (no endpoint). Adding a role is a migration plus content copy, not a code change in the guard (the header check accepts any role in the table); role-specific business data will live in the provider and customer schemas keyed by account. Granting a role from the client is impossible by design, so provider sign-up must call the service from the server. Fine-grained permissions are not modelled and the admin client roles remain temporary (DEBT-0021).

## Migration / compatibility

Migration `0009_identity_accounts.sql` (see ADR-0025), forward-only, one transaction: `identity.roles` with its two seeded rows, `identity.account_roles`, the composite primary role key on `identity.accounts`, the guard triggers and the 13 `identity_rule:<KEY>` values. No account or membership is seeded. The web session record may carry the chosen role; a session without one sends no header and the API resolves the role from PostgreSQL. Existing routes and tokens are unchanged.

## Related files

- `db/migrations/0009_identity_accounts.sql`
- `packages/contracts/src/account.ts`
- `packages/accounts/src/service.ts`
- `packages/accounts/src/identity.ts`
- `apps/api/src/plugins/account.ts`
- `apps/api/src/modules/account/routes.ts`
- `docs/engineering/ACCOUNTS.md`
- `docs/data/DATA_MODEL.md`
- `docs/data/NORMALIZATION_LOG.md`
- `docs/architecture/ADR-0025-application-account-and-keycloak-identity-separation.md`
- `docs/architecture/ADR-0015-admin-identity-separation.md`
