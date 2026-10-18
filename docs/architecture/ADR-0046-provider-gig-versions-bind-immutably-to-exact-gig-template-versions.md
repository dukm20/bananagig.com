# ADR-0046 — Provider Gig versions bind immutably to the exact Gig Template version they were built from: published versions never change, a change is a new version, and a newer template version is never adopted automatically

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: CAT-003

## Context

CAT-002 (ADR-0041) built the platform-owned Gig Template with frozen versions and said that the provider Gig would store the exact `gig_template_version_id` it was built from. CAT-003 builds that Gig and the GigMenu. The PRD gives a provider several Gigs (PR-03.05), builds them from a template (PR-03.02, PR-03 step 3: the builder validates against "the template and limits"), limits the pitch (PR-03.06), and says a change creates a new Gig version while confirmed bookings keep an immutable snapshot (PR-03.12, R-06). A template is platform data that changes over time (a new required field, other duration bounds, a retirement), while a provider offer that is already published must keep meaning what it meant. Six questions needed an answer before any Gig table existed: what is identity and what is version data, which template version a Gig version binds, what happens when the template moves on, what a published version may do, where the provider's text and the price live, and how the provider's market and the service type are known without copying them.

## Decision

- **A Gig is an identity plus immutable versions.** `provider.gigs` holds the identity (`account_id`, `gig_template_id`, status, optional idempotency token). `provider.gig_versions` holds the content: provider copy (`title`, `short_pitch`, `description`), `price_amount_minor` + `price_currency`, `duration_minutes`, the lifecycle timestamps and the exact template version. Typed field values are normalised rows in `provider.gig_version_field_values`; no JSON document. An immutable `provider.gig_audit_events` trail records the changes. All four tables live in the existing `provider` schema.
- **Every version binds the EXACT `gig_template_version_id`.** v1 binds the template's ACTIVE version at creation (template ACTIVE, service type ACTIVE, version ACTIVE, enabled in the provider's market, service type among the registration's selected service types). **v(n+1) binds the SAME template version as v(n).** The database refuses a later version bound to a different template version than its predecessor, and any version bound to a version of another template than the Gig's (`TEMPLATE_VERSION_MISMATCH`).
- **No automatic migration (owner decision).** When the template gets a newer version, the bound version becomes SUPERSEDED and the Gig keeps it; when the template or the bound version is retired, the Gig remains readable and its history intact. A SUPERSEDED bound version can still be published; a RETIRED bound version (which also blocks creating the next draft), a RETIRED template or a RETIRED service type blocks publishing (a database guard under `FOR SHARE` locks, so it is race-safe against a concurrent retirement). Adopting a newer template version is a later, explicit provider act that will create a NEW Gig version (recorded as debt). A provider who wants the newest structure today creates a new Gig.
- **A published version is frozen by the database.** Gig status: `DRAFT` -> `ACTIVE` (first publish) -> `RETIRED` (terminal). Version status: `DRAFT` -> `PUBLISHED` -> `SUPERSEDED`; `DRAFT | PUBLISHED` -> `RETIRED` only through the retirement of the Gig. Guards refuse any content change of a version that is not a DRAFT and any change of its field value rows. At most one DRAFT and one PUBLISHED version exist per Gig (partial unique indexes), numbers are contiguous, and publishing v(n+1) supersedes v(n) in the same transaction. Nothing is hard-deleted; the audit trail is immutable. There is no reactivation (a provider creates a new Gig) and no INACTIVE state (the PRD has no pause).
- **No "current version" column.** The current version is the one PUBLISHED row and the editable one is the one DRAFT row, both guaranteed unique by partial indexes; a pointer would be a second source of truth that can disagree with the rows it points at.
- **The service type and the market are reached, not copied.** The Gig stores no `service_type_id` (it is the template's) and no market (it is the market of the account's COMPLETED registration, `provider.registrations.market_id`). Eligibility is derived from those owners at the time of the act. Currency is the one derived value that must be stored with the price, because a price is meaningless without it and the market's currency could change: `price_currency` is set by the server from the market's currency at save time, never accepted from the client, and checked by a guard.
- **Platform-fixed values are never copied.** A field whose behaviour is PLATFORM_FIXED belongs to the template version; the Gig stores no row for it and the view resolves it from the bound version. A PROVIDER_CONFIGURABLE field with no value is unset (the template default is only a hint). Because the version is immutable, resolving a field always reads the structure the provider saw.
- **Validation is against the bound version, eagerly, with typed values.** A draft save validates each value present against the bound template version (bounds, enum options of that exact version, type); only publishing requires completeness (copy, required fields, a price when the version allows one, a duration when it has duration facts). Field types the Gig cannot store yet (MONEY, MEDIA, EQUIPMENT_REFERENCE, SKILL_REFERENCE) are refused when a value is sent, and block publishing when the field is PROVIDER_REQUIRED (recorded as debt).
- **Provider text is plain text, owned by the provider, and never leaves the content columns.** It is not CFG-002 content. It is normalised (NFC, trimmed, control and bidirectional characters and HTML-looking markup refused) and limited by configuration (CFG-001). It never appears in an audit row, an event, a log, an error detail or a metric; `changes` holds ids, field names and counts. Moderation is recorded as a requirement, not built.
- **Caps and concurrency are enforced under the account lock.** `provider.gig.max_active` (Gigs in ACTIVE, checked at the first publish) and `provider.gig.max_drafts` (versions in DRAFT, checked at Gig creation and at next-draft creation) are configuration. Lock order is account -> gig -> version, catalogue rows `FOR SHARE`; external reads (policy, account facts, template structures) happen before the transaction. A draft carries a `revision`; a save or a publish names the revision it read and a different one is `STALE_DRAFT`.
- **Owner scoping and visibility.** Every query filters by the authenticated account; another account's Gig or version is `404`, never 403. The GigMenu is one owner-only read with a constant number of queries. A published Gig is **not live and not bookable**: Go-Live (PRO-003) is a separate decision, the readiness facts say `goLive: { evaluated: false, eligible: false }`, and the registration's `GIGS` onboarding step is derived from those facts through the existing prerequisite port.
- **Events.** `bananagig.provider.gig-created.v1`, `gig-version-published.v1` and `gig-retired.v1`, identifiers only, in the same transaction as the change. Draft edits emit nothing.

## Alternatives considered

- **Always bind the newest ACTIVE template version (read the template at each publish).** A published offer would change meaning when the platform publishes a new template version, and R-06 ("provider edits never retroactively change confirmed scope") would depend on timing. It also makes a Gig unvalidatable against the structure its provider actually saw.
- **Automatic migration of Gigs to the new template version.** New required fields, other duration bounds or removed options could invalidate a live offer overnight, with no provider act and no way to review the result. Adoption needs its own design (diff, review, explicit provider confirmation) and is a later checkpoint.
- **Copy the template structure or the fixed values into the Gig.** Duplicates platform data and drifts; the template version is already immutable, so a reference is enough.
- **Edit published versions in place with an audit trail.** Gives no stable thing for a later booking or search document to reference, and makes "what was sold" depend on the audit.
- **A `current_version_id` column on the Gig.** A second source of truth that can disagree with the version rows; the two partial unique indexes state the invariant directly.
- **Store the service type and the market on the Gig.** Duplicates facts of the template and the registration that can then disagree with their owners; both are reachable by key.
- **Store the Gig content as one JSON document per version.** No foreign keys to template fields, no per-column constraints and no type checks in the database; the typed value table keeps the constraints checkable.
- **Reactivation of a retired Gig, or an INACTIVE (paused) Gig.** The PRD defines no pause; a status nothing can reach is dead state. A new Gig is the explicit way back, and its history is separate.
- **Provider text as CFG-002 content.** The content registry is for platform-authored, effective-dated text with localisation; provider copy is per-provider data, large in number, and would need a moderation and ownership model the content registry does not have.
- **Accept the currency from the client.** Lets a client price in a currency the market does not use; the market already knows its currency.

## Consequences

- A published Gig can sit on an older template version indefinitely, until template adoption exists. This is the accepted cost of the owner decision and is recorded as debt together with the adoption work.
- A template that was retired after a Gig was published leaves the published version and the history readable but allows no new draft or publication on that Gig; the provider creates a new Gig from a current template.
- A template with a PROVIDER_REQUIRED field of a type not yet supported cannot be published as a Gig until CAT-004 and later checkpoints add those types.
- Wording of template labels is still shared by all template versions (DEBT-0084), so a label change reaches a Gig built on an older version.
- Variants, add-ons, media, service areas, availability, search, public pages, moderation, Go-Live and template adoption are later checkpoints; the new tables are keyed so they extend the version (CAT-004 keys children by `gig_version_id`).
- The readiness facts give PRO-003 and the onboarding a signal without making a Gig a promise of work.

## Migration / compatibility

`0020_provider_gigs.sql` adds four tables (`gigs`, `gig_versions`, `gig_version_field_values`, `gig_audit_events`) to the `provider` schema, their guards and TRUNCATE refusals, the partial unique indexes, five configuration parameters through the change-request lifecycle and the platform labels through the content lifecycle. It is additive: no existing table changes and no Gig row is seeded. Adding states, a pointer or adoption later is a forward migration (never an edit of 0020). Rollback is forward-fix only (`MIGRATION_POLICY.md`); locally `pnpm stack:reset` rebuilds from zero.

## Related files

- `db/migrations/0020_provider_gigs.sql`
- `packages/contracts/src/gig.ts`
- `packages/provider/src/gig-service.ts`
- `packages/provider/src/gig-types.ts`
- `packages/provider/src/gig-policy.ts`
- `apps/api/src/modules/provider/gig-routes.ts`
- `docs/engineering/PROVIDER_GIGS.md`
- `docs/architecture/ADR-0040-platform-owned-taxonomy-with-stable-identities-and-status-based-retirement.md`
- `docs/architecture/ADR-0041-versioned-platform-gig-templates-referenced-immutably-by-provider-gigs.md`
- `docs/architecture/ADR-0042-provider-registration-is-provider-domain-state-of-the-existing-account-with-derived-onboarding-steps.md`
- `docs/architecture/ADR-0043-provider-verification-is-a-case-of-policy-derived-requirements-not-a-verified-flag.md`
- `docs/architecture/ADR-0044-verification-evidence-lives-in-private-object-storage-with-server-verified-immutable-metadata.md`
- `docs/architecture/ADR-0045-scanning-and-external-verification-are-provider-neutral-ports-that-fail-closed.md`
