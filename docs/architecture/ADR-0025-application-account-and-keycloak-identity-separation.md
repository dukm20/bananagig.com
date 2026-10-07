# ADR-0025 — The application account is separate from the Keycloak identity, created lazily at the first authenticated request

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: ID-001

## Context

ADR-0013 made Keycloak the owner of authentication and promised an external identity reference later; until ID-001 no account existed and the API only validated tokens. Every later domain (addresses, bookings, balances, consents, provider data) needs a BananaGig account to hang on, and the PRD needs one login to hold a customer and a provider role (CU-03.03, PR-01.04), a first and last name with a public display rule (SV-11.02), an account status and closing (SV-11.09), and admin accounts that are separate logins (SV-11.08, ADR-0015).

Open questions: where the Keycloak subject is stored and whether it identifies the account; when and how the account appears for a person who signed in through Keycloak; which application roles a new account starts with when no sign-up flow exists yet; what happens to admin identities; and how much of the person (email, phone, address) belongs in this checkpoint. Keycloak tokens carry only identity claims (`sub`, `iss`, realm roles, no name or email), by claim minimization.

## Decision

- **The account is not the identity.** Schema `identity` (migration `0009_identity_accounts.sql`) has `identity.accounts` (opaque `account_id`, status, primary role, `closed_at`) and, separately, `identity.external_identities`, which maps `(provider_type, issuer, provider_subject)` to one account. The Keycloak subject is NOT a column of `accounts` and is never used as the account id: every other table references `account_id`, so the personal identifier lives in one table. The unique key makes one login link at most one account and decides every race; the link is immutable (only `last_seen_at` changes) and never deleted; there is no unique key on `account_id`, so an account can have several links later. A person is never matched by email or username. Nothing of credentials, MFA, protocol sessions or tokens is stored; issuer and subject are stored only because they ARE the link.
- **Lazy bootstrap at the first authenticated request.** `requireAccount()` authenticates, requires the normal web identity context (`azp` `bananagig-web`), looks the link up and, if there is none, creates in ONE transaction: the account (status `ACTIVE`, no primary role), its creation row in `account_status_history`, the external identity, the audit rows, the outbox events and the bootstrap roles. A concurrent first request loses on the unique key, rolls back its half-created account and returns the winner's. There is no Keycloak event listener, webhook, SPI or synchronization job. The status is `ACTIVE`, not `PENDING`: email and phone verification (CU-03.04 to CU-03.06) is a separate state that gates actions, not the existence of the account; `PENDING` exists in the status machine for a later flow and no path creates it.
- **Initial roles: a one-time bootstrap hint from Keycloak.** There is no sign-up flow yet, so the realm roles of the FIRST verified token seed the first application roles once (`BOOTSTRAP_ROLE_BY_IDENTITY_ROLE`: `customer` gives `CUSTOMER`, `provider` gives `PROVIDER`; both give both; neither gives an account with no role), recorded with `grant_source` `BOOTSTRAP`. After the account exists the token roles are never read again and PostgreSQL is the only authority for application roles; the provider role is added to an existing customer account server-side (PR-01.04). The coupling to how Keycloak users are provisioned is a recorded debt that ends when explicit sign-up flows grant the role (DEBT-0044). Keycloak roles are identity facts, not application roles, and are never copied or synchronized (ADR-0015).
- **Admin separation.** Admin identities (client `bananagig-admin`) are separate logins with NO account row and cannot hold customer or provider roles (SV-11.08): `requireAccount` answers 403 `ACCOUNT_CONTEXT_NOT_SUPPORTED` for the admin context and any other client. An application identity for administrators (profile, permissions, invitation, audit by administrator) is AD-07 (DEBT-0046), modelled separately from `identity.accounts`.
- **A status machine with an immutable history.** `accounts.status` (`PENDING`, `ACTIVE`, `SUSPENDED`, `CLOSURE_REQUESTED`, `CLOSED`) is the current state, enforced by trigger (`CLOSED` terminal, a closed account is frozen), and every change is an immutable `account_status_history` row; two deferred constraint triggers keep the two consistent in both directions at commit, each reading the CURRENT status (the newest history row equals it, and every history row continues the previous one, so a stray row is refused and a transaction may pass through a transient status). Suspended and closed accounts are refused by the API with 403. The machine exists; the closure rules (open bookings, money, payouts), deletion, export and erasure do not (DEBT-0045).
- **A one-to-one core profile.** `identity.account_profiles` holds first and last name (required, 1 to 50 characters, trimmed, no control or bidirectional characters: structural CHECKs and contract constants), the preferred locale (`content.locales`) and an optional time zone override (`geography.time_zones`). The row exists once the person has given a name (the token has none). There is no stored display name: the public display (first name and last initial, SV-11.02) is derived on read. The full name appears only in the caller's own profile; there is no public profile API.
- **Contact data and address ownership are deferred.** No email, phone, consent or verification state is stored (ID-002, ID-003; Keycloak keeps the login email); `geography.addresses` stays ownerless (ADR-0023) until a checkpoint has an address use case. Retention and erasure are open (DEBT-0045, DEBT-0036).
- **Privacy by construction.** No route accepts an account id, subject or role from the client; no token, name or subject of the account's login is logged, audited by value, put in an event or returned (errors carry fixed text and identifiers only; an actor string `account:<id>`, `system:<name>` or `admin:<subject>` names who acted, never the account being changed); bodies are validated strictly before Ajv can coerce them. Events (`bananagig.identity.*`, aggregate `identity_account`) carry identifiers only.

## Alternatives considered

- A `keycloak_subject` column on `accounts`: the subject is a fact about a login, not about the account; a second login, a replaced provider or a re-created Keycloak user would be an account-level data migration, and the personal identifier would sit in the table every domain joins to. Rejected for the link table.
- Using the Keycloak `sub` as the account primary key: couples every foreign key to the identity provider (ADR-0013 keeps it swappable), makes the key a string, and spreads the identifier into every referencing table. Rejected; the `account_id` is a generated uuid.
- Matching an account to a login by email or username: both change, and an email match would let a new login take over an existing account. Rejected.
- Creating the account from Keycloak (event listener, admin events, a webhook, a realm SPI): a second moving part that can fail or lag behind a login, needs Keycloak customization and a reconciliation job. Rejected for creation at the first request, which works for every entry path and cannot create an account for someone who never reaches BananaGig.
- An explicit "register" call that the web app makes after the first login: every client must remember it, and "authenticated but without an account" becomes a state every route handles. Rejected; the guard is the single place.
- Granting `CUSTOMER` to every new account: a provider-first sign-up must not also become a customer (the PRD creates the account and the role at sign-up). Rejected.
- No automatic role (an account with no role until a flow grants one): the target end state, but no sign-up flow exists, so nobody could ever hold a role and the dev users and tests could not exercise anything. Deferred to the sign-up checkpoints (DEBT-0044).
- Synchronizing Keycloak realm roles into PostgreSQL on every login: a second copy that drifts and ties authorization to token content. Rejected.
- Creating the account `PENDING` until verification: the PRD lets a person browse before verifying (CU-03.06) and verification is its own state; coupling the two would block account-bound features that do not need verification. Rejected for `ACTIVE`.
- Storing email and name from the token: the tokens carry neither (claim minimization), and storing the Keycloak email would duplicate it without a verification model. Rejected; contact data waits for ID-002 and ID-003.
- Admin accounts as a row with an `ADMIN` role in `identity.accounts`: contradicts SV-11.08 and ADR-0015 (separate logins, separate client, no mixing). Rejected.
- A separate account per role of one login: the PRD says one login holds both roles (CU-03.03, PR-01.04). Rejected.

## Consequences

Every authenticated account request reads PostgreSQL (the identity by its unique key, the account, its memberships), with no cache (DEBT-0047). The issuer is part of the key, so changing the public realm URL, or re-creating a Keycloak user, produces a new account until a reviewed migration or an explicit link flow exists; a person whose account is `CLOSED` cannot sign up again with the same login. An account can exist with no role (a token with neither realm role), and the first request bootstraps the account even when its body or query is then rejected with 400 (the guard runs first) or when it names a role the new account lacks (the account is committed, then the answer is 403). Until the sign-up flows exist the initial roles depend on how Keycloak users are provisioned (DEBT-0044). Personal identifiers and names are retained with no erasure or export procedure (DEBT-0045, DEBT-0036), and administrators have no application identity (DEBT-0046). In return: Keycloak stays swappable, no business table stores a Keycloak subject, there is exactly one guard (`requireAccount`) and one creation path, accounts are created atomically and race-safely, and contact data, consents, addresses and business data can be added to the account without touching authentication.

## Migration / compatibility

Migration `0009_identity_accounts.sql`, forward-only (ADR-0010), one transaction: seven new tables, guard triggers, the two deferred status-history triggers, and deterministic seeds (the roles `CUSTOMER` and `PROVIDER` and 17 content entries through the real lifecycle). No existing row is rewritten, no account is seeded (accounts appear on the first authenticated request of a person; existing dev logins get theirs on first use), and the seed emits no outbox event. The Keycloak realm needs no change: the account is created from claims the tokens already carry (`iss`, `sub`, realm roles). `GET /api/v1/system/whoami` and every existing route are unchanged.

## Related files

- `db/migrations/0009_identity_accounts.sql`
- `packages/contracts/src/account.ts`
- `packages/accounts/src/service.ts`
- `packages/accounts/src/identity.ts`
- `apps/api/src/plugins/account.ts`
- `apps/api/src/modules/account/routes.ts`
- `docs/engineering/ACCOUNTS.md`
- `docs/engineering/IDENTITY.md`
- `docs/data/DATA_MODEL.md`
- `docs/data/NORMALIZATION_LOG.md`
- `docs/architecture/ADR-0013-keycloak-identity-provider.md`
- `docs/architecture/ADR-0015-admin-identity-separation.md`
