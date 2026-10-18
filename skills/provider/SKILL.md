# Provider registration and Gigs (the provider domain)

## Purpose

Let an existing account become a provider and track where it is in onboarding: the `provider` schema (registration attempts, selected service types, audit), the `@bananagig/provider` service with its pure requirement evaluator, the owner-only API under `/api/v1/provider` and the temporary web flow. Since PRO-001 the registration covers start/resume, market, service types, the derived requirement list, server-controlled submit and cancel. Since CAT-003 the same schema holds the provider's Gigs: an identity, immutable versions bound to the exact Gig Template version they were built from, typed field values, audit, and the owner-only GigMenu (`docs/engineering/PROVIDER_GIGS.md`). Later checkpoints add steps (subscription, profile, Go-Live) by implementing ports, not by changing the registration table.

## When to use

- A feature needs to know whether an account is registering or registered as a provider, in which market and for which service types.
- Adding or changing an onboarding step (TRUST-001 verification, subscription, PRO-002 profile, CAT-003 Gigs) or the Go-Live gate (PRO-003): you plug into the evaluator through `PrerequisitePort` and content keys.
- Changing provider registration policy (verified contacts, allowed market statuses, number of service types) or its wording.
- Touching the `provider` schema, its guards, API, events or the `/provider/registration` and `/provider/gigs` web pages.
- Building on provider Gigs: variants, add-ons, media (CAT-004), template adoption, service areas, availability, search or Go-Live (PRO-003) read published Gig versions and the readiness facts; the Gig rules are below.

## Canonical files

- `db/migrations/0018_provider_registration.sql`, `docs/data/DATA_DICTIONARY.md` (`provider.*`), `docs/data/NORMALIZATION_LOG.md` (PRO-001)
- `packages/contracts/src/provider.ts` (vocabularies, requests, DTOs, events, error codes, content-key helpers, policy schema)
- `packages/provider/src/{service,evaluator,policy,types,errors,index}.ts`
- `packages/catalog/src/service.ts` (`offeredServiceTypeCodes`, the catalogue read the registration uses)
- `apps/api/src/modules/provider/{routes,dto,wiring}.ts`, `apps/api/src/index.ts` (adapters), `apps/api/src/plugins/errors.ts` (`NO_STORE_PREFIXES`)
- `apps/web/src/app/provider/registration/page.tsx`, `apps/web/src/app/auth/provider/[action]/route.ts`, `apps/web/src/lib/auth/provider-handlers.ts`
- `packages/testing/src/provider-model.itest.ts`, `packages/provider/src/provider.test.ts`, `packages/provider/src/provider.itest.ts`, `packages/contracts/src/provider.test.ts`, `apps/api/src/provider.test.ts`, `apps/api/src/provider.itest.ts`, `apps/web/src/provider-handlers.test.ts`, `apps/web/src/provider-registration.test.tsx`, `apps/web/src/provider-client.test.ts`, `apps/smoke/src/index.ts` (scenario `Provider registration`)
- `docs/engineering/PROVIDER_REGISTRATION.md`, `docs/architecture/ADR-0042-provider-registration-is-provider-domain-state-of-the-existing-account-with-derived-onboarding-steps.md`
- Gigs (CAT-003): `db/migrations/0020_provider_gigs.sql`, `packages/contracts/src/gig.ts`, `packages/provider/src/{gig-service,gig-types,gig-policy,gig-errors}.ts`, `apps/api/src/modules/provider/{gig-routes,gig-dto,gig-wiring}.ts`, `packages/testing/src/gig-model.itest.ts`, `packages/provider/src/gig.test.ts`, `packages/provider/src/gig.itest.ts`, `apps/api/src/gig.test.ts`, `apps/api/src/gig.itest.ts`, `docs/engineering/PROVIDER_GIGS.md`, `docs/architecture/ADR-0046-provider-gig-versions-bind-immutably-to-exact-gig-template-versions.md`

## Architecture rules

- **A provider is not a second account.** One `identity.accounts` row holds CUSTOMER and PROVIDER. No provider login, password or contact; the schema references the account by id only and copies no email, phone, name or address.
- **Three concepts, never merged:** the application role (`identity.account_roles`: PENDING, ACTIVE, INACTIVE; ID-001), the registration (`provider.registrations`: IN_PROGRESS, COMPLETED, CANCELLED) and Go-Live (PRO-003). The evaluator reports `goLive {evaluated:false, eligible:false}`; never set it from here.
- **Role lifecycle:** requested `PENDING` at start (an existing membership is kept, `INACTIVE` is refused), `ACTIVE` at completion in the same transaction, untouched by cancel.
- **Attempts:** `attempt_number` is contiguous per account; at most one non-cancelled attempt (partial unique index); restart is the next attempt with an empty selection. Completed and cancelled registrations are frozen by the database.
- **Steps are derived, never stored.** `evaluateRequirements` is pure; the service gathers one read per owner. The `VERIFICATION` step is answered by the trust domain (TRUST-001, `skills/trust`) through the same port; the steps of later checkpoints come from `PrerequisitePort` (default `UnavailablePrerequisites` = `NOT_AVAILABLE`); do not create placeholder rows.
- **Domain packages do not import each other.** The provider package depends on ports (`AccountPort`, `ConsentPort`, `MarketPort`, `CatalogPort`, `PolicyProvider`, `PrerequisitePort`); the API module wires them to identity, consent, geography, catalogue and configuration.
- **Contacts first:** market and services are refused (`PREREQUISITE_NOT_MET`) until the configured contacts are verified. Submit takes only `expectedRevision`; the server re-evaluates every PRO-001 step (`REGISTRATION_INCOMPLETE` names the open steps).
- **Policy is configuration, wording is content.** Five typed parameters `provider.registration.*` read fresh and failing closed (`UNAVAILABLE`, `POLICY_INVALID`); copy under `provider.registration.*` content keys; the API returns keys, never words. Never hardcode a count, a status list or a text.
- **Market rules:** the market status must be in `market_statuses_allowed` (default `ACTIVE`) and an ACTIVE market must be inside its window. Seeded `la-oc` stays `PLANNED`; this domain never changes a market's status.
- **Service types** are chosen by `service_type_id` from the catalogue (not Gigs, not template snapshots); each must be ACTIVE and offered in the chosen market; the database guard refuses retired/inactive types under a `FOR SHARE` read. A stored selection that stops being offered becomes `BLOCKED` in the evaluator; it is never silently removed.
- **Owner-only API:** every route acts on the verified token's account (`requireAccount({honorActiveRoleHeader:false})`); no route accepts an account id, registration id, role, status or completion flag; strict bodies; every response `no-store`; error details are an allow-list.
- **Audit and outbox:** one audit row and one outbox event per real change, in the same transaction; none for no-ops or reads; identifiers, codes and counts only.
- **Lock order:** account row `FOR UPDATE` → registration `FOR UPDATE` → service types `FOR SHARE`.
- **Consent is evaluated before the registration transaction** (the consent service uses a repeatable-read snapshot that cannot nest); `AccountService.grantRole` and `getAccountContext` join the caller's transaction when they use the same `Database` instance.

### Provider Gigs (CAT-003)

- **A Gig is an identity plus immutable versions.** `provider.gigs` (account, template, status), `provider.gig_versions` (content, price, duration, exact template version), `provider.gig_version_field_values` (typed rows, never a JSON blob), `provider.gig_audit_events` (immutable). The Gig stores no service type (via its template) and no market (the market of the account's COMPLETED registration).
- **Exact template version, no auto-migration (ADR-0046).** v1 binds the template's ACTIVE version; every later version binds the SAME one, even after the template gets a newer version. A SUPERSEDED bound version still publishes; a RETIRED bound version, template or service type blocks publishing and the next draft (DB guard, `FOR SHARE`). Never read the mutable template to learn what a Gig was built from: ask `GigTemplatePort.exactVersion`.
- **Published versions are frozen; a change is the next draft.** Gig `DRAFT -> ACTIVE -> RETIRED` (terminal, no reactivation), version `DRAFT -> PUBLISHED -> SUPERSEDED | RETIRED`; at most one DRAFT and one PUBLISHED per Gig (partial unique indexes, no current-version pointer); publishing supersedes the previous version in the same transaction; nothing is deleted.
- **Eligibility** to create or publish is an ACTIVE account, an ACTIVE PROVIDER role, a COMPLETED registration, the template's service type among the selected ones and the template enabled in the market. Verification, subscription, profile and Go-Live are NOT required: a published Gig is not live and not bookable (`goLive.evaluated=false` always).
- **Draft saves replace the whole editable content with `expectedRevision`** (`STALE_DRAFT`) and validate eagerly against the bound version; completeness is checked only at publish (`PUBLISH_BLOCKED` with identifier-only `issues`). PLATFORM_FIXED values are never copied; supported field types are TEXT, LONG_TEXT, INTEGER, DECIMAL (string), BOOLEAN, ENUM, DURATION; a PROVIDER_REQUIRED field of any other type blocks publishing (`FIELD_TYPE_NOT_SUPPORTED`).
- **Price and currency:** integer minor units plus a currency the SERVER derives from the market (never from the client), permitted only when the bound version allows FIXED or FIXED_WITH_VARIANTS; the DB guard checks the currency. Duration only when the bound version has duration facts.
- **Provider text is plain text and never leaves the content columns:** not in audit `changes` (ids, field names and counts only), events, logs, error details or metrics. It is normalised with `normalizeProviderText`; limits are configuration (`provider.gig.*`).
- **Caps** (`max_active` at first publish, `max_drafts` at Gig and next-draft creation) are counted under the account row lock. Lock order account -> gig -> version; policy, account facts and template structures are read BEFORE the transaction (catalogue reads cannot nest).
- **Owner scoping:** every query filters by the authenticated account; another account's Gig is 404, never 403. The GigMenu is a constant-query owner-only read, not a public listing.
- **The `GIGS` onboarding step** comes from `gigsPrerequisite` over the readiness facts (`NOT_STARTED`, `IN_PROGRESS`, `COMPLETE`; never `BLOCKED`; it does not block registration submit).

## Implementation pattern

1. To add a step: add the id to `ONBOARDING_STEPS` in contracts (and `REGISTRATION_STEPS` only if it must block submit), add its content keys in a forward migration through the content lifecycle, implement the fact in a port, and extend `evaluateRequirements`. Never persist its status in the provider schema.
2. To change policy: add the typed parameter through the configuration lifecycle in a forward migration, extend `ProviderRegistrationPolicy` and `parseProviderPolicy` (fail closed), and read it in the service, not in the web.
3. New persistence: forward migration `NNNN_*.sql`, guards with `provider_rule:<KEY>`, the Data Model Review Gate, then map the key in `mapDbError` and `MESSAGES` in `dto.ts` with a content key.
4. After changing the API or events run `pnpm specs:generate`; after changing the schema run the Data Model Review Gate and `pnpm schema:snapshot --write`.
5. To add something to a Gig (a CAT-004 child, a new field type): key the new table by `gig_version_id` so it is versioned with the Gig, freeze it with the version in a guard, extend the publish completeness and the `GigIssueReason` list with content keys, and keep provider text out of audit and events. To support a new template field type, add its typed value column and extend the field-type guard in a forward migration.

## Commands

`pnpm --filter @bananagig/provider test` · (Gigs) `packages/provider/src/gig.itest.ts` and `packages/testing/src/gig-model.itest.ts` run the same way, after `pnpm migrate` · `pnpm --filter @bananagig/contracts test` · `node --env-file-if-exists=.env.host node_modules/vitest/vitest.mjs run -c vitest.integration.config.ts packages/provider/src/provider.itest.ts` · `pnpm smoke` (scenario `Provider registration`; needs `pnpm stack:all`, `pnpm migrate`, rebuilt api-service/web-app images) · `pnpm data-model:check PRO-001` · `pnpm smoke` scenario `Provider GigMenu`

## Testing requirements

- Model tests on isolated databases: shape, seeds (5 parameters, 56 content entries), every guard with its exact `provider_rule` key, the status matrix, contiguous attempts, one live attempt, frozen history, retired/inactive service types under concurrent retirement, immutable audit, no truncate.
- Service tests with fakes and real transactions: idempotent start and resume, role transitions (PENDING, ACTIVE, INACTIVE refused), contacts-first, policy-driven market rules, offered-only service types, revision and stale handling, submit gates, cancel/restart, audit and outbox exactness and atomicity, the query budget of the evaluator, fail-closed policy.
- Pure evaluator tests: the status truth table of every step including `NOT_AVAILABLE` and `BLOCKED`.
- API tests: owner-only (no id accepted), strict bodies, `no-store` on errors, error mapping and allow-listed details, no contact or document in any response.
- Web tests: handlers (same-origin, strict forms, closed notice/error words, no leakage), page (copy only from content keys, forms only when allowed, no consent control), client methods.
- Break the production line a test claims to cover (mutation check, on a private copy) before trusting it.

## Data-model considerations

Any change to the registration tables or their guards needs the Data Model Review Gate and a forward migration (never edit 0018); the same holds for the four Gig tables (never edit 0020). The Gig tables hold no contact, name, address or document either. A second market per registration, a review state or a Go-Live table are new columns/tables with their own migration and ADR update; Go-Live belongs to PRO-003, not here. Never add contact, name, address or document columns.

## Common failure modes

- Treating a COMPLETED registration as "can receive work": that is Go-Live (PRO-003).
- Reading the role status as the registration status, or the reverse.
- Choosing a market or services before the contacts are verified (409 `PREREQUISITE_NOT_MET`); services before a market (409 `MARKET_REQUIRED`).
- Submitting while consent is outstanding (409 `REGISTRATION_INCOMPLETE`, `details.steps` names LEGAL): the person accepts on `/consents`; the web never pre-ticks consent.
- Re-using a stale `expectedRevision` (409 `STALE_REGISTRATION`): read the registration again.
- Calling the consent service inside the registration transaction (`TransactionOptionError`).
- Expecting a PLANNED market (the seeded `la-oc`) to accept registration; it needs a policy change and a product decision (DEBT-0085).
- Hardcoding a message, a status word or a limit in code or the web page.
- Expecting a Gig to follow a newer template version, or to become live when published: it keeps its exact template version and Go-Live is PRO-003.
- Saving a draft with a stale `expectedRevision` (409 `STALE_DRAFT`), a second draft (409 `DRAFT_EXISTS`), or publishing with no draft (409 `NO_DRAFT`): read the Gig again.
- Treating another account's Gig as 403: it is 404 `GIG_NOT_FOUND` by design.
- Sending a currency, a value for a PLATFORM_FIXED field, or an option code of a newer template version: refused (the server derives the currency; options belong to the bound version).
- Reading `PUBLISH_BLOCKED` as a validation error of the request: it lists what a complete publishable draft still needs, by identifier.

## Known BananaGig-specific lessons

- The smoke needs a customer-only identity: `customer.dev` already holds PROVIDER ACTIVE (bootstrap, DEBT-0044), so the scenario creates a throwaway Keycloak user with the `customer` realm role, verifies its contacts through the real flows and deletes it at the end.
- A PL/pgSQL `IF ... THEN` stops at the first `THEN`; do not put a `CASE` with its own `THEN` inside a condition (LRN-0055).
- Order lists with `COLLATE "C"` so the selection and the audit `changes` are the same on every machine.
- Guard triggers report `provider_rule:<KEY>` in the error DETAIL; the service maps the key, never the driver message.
- Many parallel integration files exhaust Postgres connections (`max_connections` 100): run at most two integration files at once.
- Catalogue reads (the template port) open repeatable-read snapshots and cannot run inside a provider transaction: read template structures first, then open the transaction and let the DB guards re-check the races (retirement of the template, version or service type).
- A provider Gig is a published offer, not a provider being live: the readiness facts are signals for PRO-003, never a flag to set.

## Do not

- Do not create a provider user, login, password, contact or a second account row.
- Do not store step statuses, Go-Live flags, service areas, availability, documents or verification results in the `provider` schema. The only prices are the Gig version's `price_amount_minor` and `price_currency`.
- Do not edit, delete or re-bind a PUBLISHED Gig version, add a current-version pointer, or reactivate a retired Gig; the change is the next draft or a new Gig.
- Do not migrate a Gig to a newer template version, copy PLATFORM_FIXED values or template structure into Gig rows, or store the service type or market on the Gig.
- Do not put provider text (title, pitch, description, text values) or amounts in audit rows, events, logs, error details, redirects or cookies.
- Do not accept an account id, currency, status or template version id from a client; the server derives them.
- Do not accept an account id, registration id, role or status from a client, and do not accept free text on cancel (the audit trail is immutable).
- Do not treat "PROVIDER role ACTIVE" as proof of vetting or Go-Live: until PRO-003 an account activates the role itself by completing the registration.
- Do not call a port that may become a remote call (verification, subscription, profile, Gigs) inside the registration transaction; read it before the locks.
- Do not hardcode policy values or user-visible text.
- Do not make a market public or change a market's status from the provider domain.
- Do not import another domain package from `@bananagig/provider`; add a port.
- Do not edit an applied migration.

## Related ADRs

ADR-0025, ADR-0038, ADR-0040, ADR-0041, ADR-0042, ADR-0046

## Last reviewed

2026-10-18 (CAT-003)
