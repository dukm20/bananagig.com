# ADR-0038 — Consent policy is configuration (role-scoped requirements, re-acceptance modes) and the current state is derived

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ID-005

## Context

ADR-0037 records what an account accepted. The product also needs to answer, at any moment, "what must this account accept now, and is it compliant?". That depends on facts that are NOT stable and are not the engineers' to decide: which roles must accept which document (the PRD asks customers and providers to accept the Terms and the Privacy Policy at sign-up; a provider adds agreements; an admin accepts a confidentiality policy), and what a newly published version does to an acceptance that already exists (an editorial fix should not interrupt everybody, a change of terms should). The PRD says neither how the second works nor whether it differs by document, and the rules differ by region and will change with legal advice. Business values must not be hardcoded, and the answer has to be consistent in the page, the API and any future gate.

## Decision

- **Policy is configuration (CFG-001), per purpose.** `consent.<purpose lower case>.required_for` is a JSON array of application role codes and `consent.<purpose lower case>.reacceptance` is one of three modes. They are CRITICAL, `SECOND_APPROVER`, owner `legal`, never cached and never last-known-good, with PLATFORM scope read today and COUNTRY and MARKET allowed by the definition for the regional law that will come. The consumer parses them strictly and has NO code default: a missing, unreadable or invalid value (including a role code that does not exist) fails the operation closed (`UNAVAILABLE`), never "nobody is required".
- **Structure stays in columns, policy in configuration.** What is a property of the purpose itself and follows from its legal nature stays in `identity.consent_purposes`: the document entry it binds to (one purpose per document) and the `withdrawal_policy` (`NOT_WITHDRAWABLE` for a condition of the service, `WITHDRAWABLE` for an optional consent). Both are immutable.
- **Requirements are role-scoped.** The roles considered are the account's roles with status PENDING or ACTIVE: a provider role that was requested but is not active yet already needs the provider's agreements. A purpose is required when any considered role is in `required_for`. A required purpose cannot be withdrawn while a considered role requires it.
- **Three re-acceptance modes, applied to the version in force in the evaluated locale.** The locale is the request's, else the profile's preferred locale, else the platform default; legal documents never fall back. `REACCEPT_REQUIRED` is satisfied only by the accepted version that IS the version in force; `REACCEPT_FOR_NEW_USERS_ONLY` is satisfied by an acceptance of any version in the SAME locale as the evaluated one (existing acceptors are not asked again, a person who never accepted in that language is); `NO_REACCEPT` is satisfied by an acceptance of any version in any locale. The evaluator is a pure function with a fixed order: not required (`NOT_REQUIRED`); then, when the latest event is an acceptance, the lenient modes are decided first (`NO_REACCEPT` is `SATISFIED`, `REACCEPT_FOR_NEW_USERS_ONLY` is `SATISFIED` when the accepted locale equals the evaluated one), EVEN WHEN NO DOCUMENT IS IN FORCE, so a gap in Legal's timeline or the deactivation of a locale or entry does not un-satisfy people who already accepted; then no document in force (`DOCUMENT_UNAVAILABLE`, which still applies under `REACCEPT_REQUIRED` even if the account accepted earlier); then no acceptance (`OUTSTANDING`); then `REACCEPT_REQUIRED` (`SATISFIED` or `REACCEPTANCE_REQUIRED`) or `OUTSTANDING` for an acceptance in another locale.
- **The current state is derived, never stored.** `NONE`, `ACCEPTED` or `WITHDRAWN` comes from the latest event; compliance (`SATISFIED`, `OUTSTANDING`, ...) is computed at read time from the event, the version in force, the policy and the roles. No `current` or `compliant` flag exists, so a new publication, a role change or a policy change takes effect immediately and nothing needs a backfill or a sweeper.
- **Defaults are assumptions, flagged.** `REACCEPT_REQUIRED` for both seeded purposes is the conservative choice (everyone accepts the version in force) and is NOT in the PRD; `required_for` is `["CUSTOMER","PROVIDER"]` for both purposes from the PRD but not yet confirmed with Legal. Both are recorded as technical debt for the legal owner (DEBT-0077) and are changed by a configuration change request, not a deploy.
- **Signup-readiness is a service, not a flow.** `listOutstandingConsents`, `hasRequiredConsents` and `requireConsents` (`CONSENT_REQUIRED` with the outstanding purpose codes) give a future sign-up or onboarding flow one consistent answer. No flow calls them yet.

## Alternatives considered

- **Columns on the purpose** (`required_for_roles`, `reacceptance_mode`): changing a legal policy would be a migration and a deploy, could not be approved by a second person, audited or scheduled, could not be overridden per country or market, and would put business values in schema. Rejected; configuration already has the workflow, history and scopes. Only the facts that are structural stay columns.
- **Hardcoded per-document behaviour** (`if (purpose === 'TERMS_OF_SERVICE') ...` in the service or the page): hides policy in code, makes every new document a code change and breaks the rule against hardcoded configurable values. Rejected.
- **A stored current flag or status on the account/purpose** (set by accept, cleared when a new version is published): needs a hook on every publication, a backfill, and drifts the moment a publish, a role grant or a policy change is missed. The derivation is one query. Rejected.
- **One global re-acceptance rule instead of a mode per purpose**: Legal will want a major-change document to force re-acceptance and an editorial one not to; a per-purpose parameter costs nothing extra. Rejected.
- **Only `ACTIVE` roles are considered**: a provider who requested the role would reach the provider flow without the provider's agreements. Rejected for PENDING and ACTIVE.
- **A fallback locale for legal documents when the person's language has no version**: a person would accept text in a language they did not ask for, which ADR-0020 forbids. Rejected; the result is `DOCUMENT_UNAVAILABLE`.
- **Read policy once and cache it in the service**: legal parameters are CRITICAL and must be read fresh; a stale cache would apply an old requirement after Legal changed it. Rejected.

## Consequences

The seeded policy is an assumption until Legal confirms it (DEBT-0077). Policy resolves at PLATFORM scope because accounts have no market yet, so COUNTRY and MARKET values are stored and ignored (DEBT-0079, DEBT-0063). Language switches can require a new acceptance under `REACCEPT_REQUIRED` and `REACCEPT_FOR_NEW_USERS_ONLY` because acceptances are not equated across languages. `getRequirements` reads the registry once per evaluated purpose (no cache by design). Nothing notifies a person that a new version needs their acceptance (DEBT-0078). No flow requires consent yet, so a required purpose does not stop any journey today (DEBT-0076). A purpose that is withdrawable but not required has no Accept control on the page (DEBT-0080). A new purpose is a migration (a LEGAL entry shell, a purpose row, two parameters and the label copy), not a code change.

## Migration / compatibility

Migration `0013_consent.sql` seeds the four parameters through the real change workflow (reason and basis flag the assumptions) and nothing else for policy. No schema change is needed to add a mode or a role to `required_for`; a new mode would be a new member of `REACCEPTANCE_MODES`, a matching change of the parameters' validation rules and a new branch in `evaluateRequirement`, with a table test.

## Related files

- `db/migrations/0013_consent.sql`
- `packages/contracts/src/consent.ts`
- `packages/accounts/src/consent-evaluate.ts`
- `packages/accounts/src/consent-policy.ts`
- `packages/accounts/src/consent-service.ts`
- `apps/api/src/modules/consent/wiring.ts`
- `docs/engineering/CONSENT.md`
- `docs/engineering/CONFIGURATION.md`
- `docs/architecture/ADR-0016-configuration-registry-design.md`
- `docs/architecture/ADR-0020-content-locale-fallback-cache-and-bootstrap.md`
