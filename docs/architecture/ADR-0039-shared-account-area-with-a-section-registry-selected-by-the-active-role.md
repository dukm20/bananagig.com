# ADR-0039 — The account area is one shared framework: its sections are reference data selected by the ACTIVE role, section endpoints compose the owning domains, and a hidden section is a 404

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ACC-001

## Context

The PRD gives every persona an account area (CU-09 customer, PR-09 provider, PB-03 business, AD-07 administrator, SV-11 the shared requirements) with a common core (profile, contact details and verification, security, notifications, language and region, privacy and data, roles, closing the account) and sections that only one persona has (addresses, payment methods, verification documents, payout and tax, plan and billing, public profile, business and staff profile). Those sections arrive one at a time over many checkpoints, and a person who holds the customer and the provider role switches between them without signing in again (CU-03.03, ADR-0026). Four questions had to be decided before any account page exists: where the list of sections lives, what the sections store, how a section is protected, and whether personas get separate account systems.

## Decision

- **One framework, not one account system per persona.** There is one account area, one shell, one navigation endpoint and one section guard. A persona differs by the rows it has in the section matrix, not by code paths. Administrators stay structurally separate (ADR-0015): the admin identity context has no application account, `requireAccount` refuses it with 403, and nothing here merges administrator handling into the customer and provider records. The concepts (a registry, a guard, a shell) can be reused by an administrator application later without forcing the same identity model.
- **The sections are reference data, in the identity schema.** `identity.account_sections` (code, own URL, label and description content keys, status) and `identity.account_section_roles` (section, role, enabled, display order). Two tables because the section attributes depend on the section alone and the flag and order on the pair (2NF). The role is a foreign key to `identity.roles`, so a future persona is a row of `roles` plus rows of the matrix. Rejected places: the configuration registry (no role scope; a JSON blob would have no foreign keys to roles or content keys), code constants (the menu would live in the front end), a column on the role (a list in a cell). Changing a section is a reviewed migration today, exactly like roles and consent purposes; an audited admin workflow arrives with the admin console (DEBT-0082).
- **Availability has one definition:** an enabled matrix row of an ACTIVE role for an ACTIVE section. Guard triggers refuse enabling a row for a non-ACTIVE section or role and retiring a section or a role that a row still shows (`SECTION_IN_USE`, `ROLE_HAS_SECTIONS`; `identity.roles` gains that one trigger and nothing else), and both tables refuse DELETE and TRUNCATE; the one read query repeats the three conditions. A section is `ACTIVE` only when its capability and its page exist: Notifications and Close account are registered as `PLANNED` and switched off, and the later sections are added by the checkpoint that builds them.
- **The ACTIVE role selects the section set, and the client never names it.** The role is the one the account guard already validated against PostgreSQL on every request (`x-active-role`, ADR-0026). Switching role changes the next response without a new login. The role is not stored: no section preference table exists because no section is a persisted personal choice (a preference table is added by the checkpoint that has one).
- **Section endpoints compose, they do not copy.** The profile, contact, security, privacy and roles read models return what the owning domains already know (the profile row, the masked contact states the guard read, the security overview plus a session count, the consent requirement counts, the held roles). Nothing is stored in the area and nothing is aggregated into `GET /account/me`. The navigation costs the guard's reads plus ONE registry read whatever the number of sections; there is no per-section query and no cache (the registry is an 8-row table read through a unique key).
- **A section the role does not have is a 404 `ACCOUNT_SECTION_NOT_FOUND`, the same answer for an unknown, planned, retired or not-enabled section.** 403 would confirm that the section exists and belongs to another persona. 401 and the account guard's 403 (admin context, suspended or closed account, role not held) still come first, and for a route whose sections are static (the reads and `PUT /account/profile`) the section is checked before the body. `PATCH /account/profile` derives the sections it needs from the fields present, so its strict body shape (400) is checked first and the sections second (404). The guard (`requireAccountSection`, `requireAnyAccountSection`, `assertAccountSections`) reads the role's sections once per request. A field-level rule decides which sections a profile change needs: the names need PROFILE, the locale and time zone need LANGUAGE_REGION, and the full replace (`PUT /account/profile`) needs both.
- **Domain endpoints are not gated by the menu.** The email, phone, security and consent operations keep their own authorization (the owner, the account guard). A section controls what the ACCOUNT AREA offers, not what a flow may do: a sign-up or onboarding flow must be able to record a consent or verify a contact whatever the role's menu contains.
- **Partial profile updates exist because the sections edit different fields.** `PATCH /account/profile` changes the present fields only and reads the stored row `FOR UPDATE` inside the transaction, so two concurrent edits of different fields both apply. `PUT /account/profile` keeps its replace contract. The audit row is the existing `PROFILE_UPDATED` with the changed field names; no event is emitted because nothing consumes one.

## Alternatives considered

- **A separate account application per persona**: duplicates the shell, the profile, contacts, security and privacy sections four times, and every later cross-cutting change (a new shared section, an accessibility fix) is made four times. Rejected.
- **Section visibility as a configuration parameter per section and role**: the configuration registry has no role scope and would need one for this single use; a JSON list is exactly the blob the data model rules out. Rejected.
- **The menu in the front end with the server only checking the endpoints**: the labels, order and visibility would ship with code and could drift from what the server allows. Rejected: the web renders what the API returns.
- **403 for a hidden section**: tells a probe which sections exist for other personas. Rejected for 404.
- **A per-account section table (pinned, hidden or reordered sections)**: nothing in the product asks for it; a table nothing writes is speculative. Rejected until a real preference exists.
- **Storing the active role to restore the menu on the next visit**: a second source of truth beside the web session (ADR-0026). Rejected.
- **Folding the summaries into `GET /account/me`**: turns the hottest read into an aggregate that calls the identity provider and the consent evaluator on every request. Rejected; each section has its own read.
- **Gating the domain endpoints by section**: would couple sign-up and onboarding flows to the account menu. Rejected.

## Consequences

- Adding a section is: a content entry for its label, a forward migration with its registry and matrix rows, a guarded endpoint, a web page, tests. No existing section changes.
- The framework is data-complete but, until a role-specific capability ships, CUSTOMER and PROVIDER see the same six sections; the role-driven difference is proven by tests that add rows to an isolated database (DEBT-0082).
- `PUT /account/profile` is guarded by the sections only when the account area is wired into the app (the composition root always does it); an application built without it keeps the previous behaviour, which keeps the older unit tests valid.
- Hidden sections are enforced on the server: the shell does not decide anything the API has not already decided.

## Migration / compatibility

`0014_account_area.sql` adds the two tables, three guard functions (one is a trigger on `identity.roles`) and the deterministic seeds; no existing table gains a column, constraint or index. `PATCH /account/profile` and six read operations are new; `PUT /account/profile` is unchanged for a person who has both profile sections (every seeded role).

## Related files

- `db/migrations/0014_account_area.sql`
- `packages/contracts/src/account-area.ts`
- `packages/accounts/src/account-area.ts`
- `packages/accounts/src/service.ts` (`patchProfile`)
- `apps/api/src/plugins/account-section.ts`
- `apps/api/src/modules/account/area-routes.ts`
- `docs/engineering/ACCOUNT_AREA.md`
- `docs/engineering/ACCOUNTS.md`
- `docs/architecture/ADR-0015-admin-identity-separation.md`
- `docs/architecture/ADR-0026-account-role-membership-and-active-role-context.md`
