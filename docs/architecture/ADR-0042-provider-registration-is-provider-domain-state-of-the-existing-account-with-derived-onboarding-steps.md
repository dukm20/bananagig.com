# ADR-0042 — Provider registration is provider-domain state of the existing account: role, registration and Go-Live stay separate, and onboarding steps are derived from their owners

Status: ACCEPTED
Date: 2026-10-17
Checkpoint: PRO-001

## Context

The PRD lets one person be a customer and a provider on one account (ID-001, ADR-0025) and starts the provider journey at sign-up (PR-01): contacts first (PR-01.03, PR-01.05), then legal acceptance, market, services, verification, subscription, profile and Gigs, after which an admin-controlled Go-Live decides whether the provider receives work (AD-01). Several checkpoints will contribute steps (TRUST-001 verification, subscription, PRO-002 profile, CAT-003 Gigs, PRO-003 Go-Live). Three questions needed an answer before any provider table existed: is a provider a second account, what does "registered" mean next to the application role and Go-Live, and where does the onboarding progress live.

## Decision

- **A provider is not a second account.** There is no provider user, login, password or contact. The `provider` schema references `identity.accounts` by id only and copies no email, phone, name or address (guarded by a test over the information schema).
- **Three concepts, three owners.** The application role (`identity.account_roles`, `PENDING | ACTIVE | INACTIVE`, ID-001) answers "may this account act as a provider"; the provider registration (`provider.registrations`, `IN_PROGRESS | COMPLETED | CANCELLED`) answers "where is the account in onboarding"; Go-Live (PRO-003) answers "can it receive work" and is not stored or decided here (`goLive.evaluated=false` always). Registration never invents a role status and never flips a Go-Live flag.
- **The role is requested PENDING at start and activated at completion**, by the identity service's `grantRole` joining the registration transaction. An existing PENDING or ACTIVE membership is kept; INACTIVE is refused for self-service. Cancelling leaves the PENDING role untouched (the account, the customer role and every history stay).
- **Attempts, not versions.** A registration is an attempt (`attempt_number` contiguous per account, at most one non-cancelled attempt by a partial unique index). A cancelled attempt is history; restart creates the next attempt with an empty selection. A revision counter guards the draft selections; a completed or cancelled registration is frozen by the database.
- **Onboarding steps are derived, never persisted.** A pure evaluator composes the facts of the owners (contacts from ID-002/003, consent from ID-005, the market and catalogue offer, the configured policy) into step statuses. Steps of later checkpoints are `NOT_AVAILABLE` through a `PrerequisitePort` (default `UnavailablePrerequisites`) — no fake record is created for them, and each later checkpoint replaces its port. Storing step rows would duplicate truths owned elsewhere and go stale.
- **Domain packages do not import each other.** `@bananagig/provider` takes ports (`AccountPort`, `ConsentPort`, `MarketPort`, `CatalogPort`, `PolicyProvider`, `PrerequisitePort`) wired in the API module; `contracts` carries the vocabulary. Consent is evaluated before the registration transaction (its repeatable-read snapshot cannot nest).
- **Policy is configuration, wording is content, the market and the catalogue stay owned by their domains.** Five typed parameters (`provider.registration.*`: verified email, verified phone, market statuses allowed, min and max service types), seeded through the real change-request lifecycle and failing closed; 56 content entries (labels, statuses, errors, page copy) through the real content lifecycle. Only a market whose status the policy allows (default `ACTIVE`) and that is inside its window accepts registration, so the seeded `la-oc` (`PLANNED`) is neither made public nor opened for registration by this checkpoint. Service types are selected by `service_type_id` from the catalogue (never a Gig, never a template snapshot), must be ACTIVE and offered in the chosen market, and a retired or deactivated type is refused by the database guard under a `FOR SHARE` read.
- **Contacts first, server-controlled submit.** Market and services are refused until the configured contacts are verified. Submit takes only the revision; the server re-evaluates every PRO-001-owned step and no client flag can complete a registration.
- **Audit and events like every owned domain.** An immutable audit table in the schema (five actions, identifiers only) and three outbox events written in the same transaction; no event on reads or no-ops.
- **Lock order** account row → registration → service types, the same account-first order as ID-001.

## Alternatives considered

- **A `provider_users`/`provider_accounts` table with its own credentials.** Rejected: duplicates identity, breaks "one email, one phone, one person" and the customer-provider role switch.
- **Use the role status as the registration status** (PENDING = in progress, ACTIVE = registered). Rejected: the role is an authorisation fact owned by identity and also reflects admin decisions; registration needs attempts, a market, selections and a history of cancellation; Go-Live would then have no place.
- **Persist a step table.** Rejected: contacts and consent change in other domains without telling the provider schema; a stored `COMPLETE` would be a stale copy. A derived evaluator costs one read per owner.
- **A SUBMITTED state awaiting review.** Rejected for this checkpoint: no review exists until TRUST-001/PRO-003; the Go-Live decision is where an admin gate belongs. Adding a state later is a CHECK and guard change in a forward migration.
- **Several markets per registration (a join table).** Rejected: the PRD registers a provider into one launch market first; service areas and further markets belong to PRO-003 and PR-03. The column can become a table in a forward migration.
- **Let a client name the account or role** (`/accounts/:id/provider`). Rejected: owner-only routes with no identifier keep "not yours" and "does not exist" indistinguishable and remove an authorisation class of bugs.

## Consequences

- Later checkpoints plug into the evaluator by implementing a port and adding content keys; they do not change the registration table.
- PLANNED-market pre-registration, the maximum number of service types (10) and the single-market assumption are product decisions to confirm (DEBT-0085).
- Leaving the provider role after completion, business providers and regional policies are future work.
- The temporary web flow is minimal; the polished onboarding replaces it without touching the API.

## Migration / compatibility

`0018_provider_registration.sql` adds the `provider` schema: three tables (`registrations`, `registration_service_types`, `audit_events`), the guards and TRUNCATE refusals, five configuration parameters through the change-request lifecycle and 56 content entries through the content lifecycle. It is additive: no existing table changes, nothing else reads the new tables, and no registration row is seeded. Adding a review state, several markets or step persistence later is a forward migration (never an edit of 0018). Rollback is forward-fix only (`MIGRATION_POLICY.md`); locally `pnpm stack:reset` rebuilds from zero.

## Related files

- `db/migrations/0018_provider_registration.sql`
- `packages/contracts/src/provider.ts`
- `packages/provider/src/service.ts`
- `packages/provider/src/evaluator.ts`
- `apps/api/src/modules/provider/routes.ts`
- `docs/engineering/PROVIDER_REGISTRATION.md`
- `docs/architecture/ADR-0025-application-account-and-keycloak-identity-separation.md`
- `docs/architecture/ADR-0038-consent-policy-as-configuration-and-derived-current-state.md`
- `docs/architecture/ADR-0040-platform-owned-taxonomy-with-stable-identities-and-status-based-retirement.md`
