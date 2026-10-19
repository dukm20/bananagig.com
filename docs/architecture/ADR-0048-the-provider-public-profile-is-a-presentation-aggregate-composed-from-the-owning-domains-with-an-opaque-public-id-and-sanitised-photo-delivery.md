# ADR-0048 — The provider public profile is a presentation aggregate composed from the owning domains: it stores only what the provider authors, exposes only an opaque public id, derives everything else on every read and serves only sanitised photo bytes

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: PRO-002

## Context

BananaGig needs a provider page a customer can see (PRD PR-09, CU-05). The facts such a page shows already have an owner: the person's legal name (identity), the verification state (TRUST-001), the offers (CAT-003, CAT-004 Gigs and their versions) and the market (PRO-001). Three constraints shape it:

1. A copy of any of those facts in the profile would become a second source of truth: a stored `verified` flag outlives an expired document, a stored Gig summary outlives a retirement, a stored name outlives a name change.
2. The page is the first thing in the product readable by anyone without signing in. The account id, the contacts, the legal name, the evidence and the storage keys must never be reachable from it, and an unknown profile must be indistinguishable from a private one.
3. Photos are verified by header only (DEBT-0099) and keep EXIF and GPS data. Serving the stored object anonymously would publish the location of the provider's home.

PRD-TRP-001 also fixes the boundaries: a public profile is not Go-Live (PRO-003), not discoverability (SEARCH) and not BananaDrop membership (DROP-*), and a price is never presented as bookable when it is not.

## Decision

- **The profile stores presentation only.** `provider.public_profiles` holds the provider's display name, bio, two photo pointers (ready and pending) and a two-state visibility (`PRIVATE` default, `PUBLIC`), with a revision for optimistic concurrency. Nothing derived is stored: no verified flag, no badge, no Gig field, no price, no rating, no market, no legal name.
- **The projection is derived on every read, by ONE function.** The public read and the owner's preview call the same `buildPublicProfile`; the preview only adds `visibility` and `preview: true`. The profile, eligibility, market code, photo and published Gig facts come from one statement; trust badges (type codes only, from the live case with the TRUST-001 evaluator), the fallback name and the service names come from ports in the same request (staleness is bounded by one request; recorded as debt). Gig cards come from ACTIVE Gigs with a PUBLISHED version only. `ratings` and `drops` are `available: false` placeholders so later checkpoints fill them without breaking readers.
- **An opaque public id.** `public_profile_id` (random uuid, the primary key) is the only public identifier; `account_id` is a separate unique internal key. The account id appears in no public payload or URL. Unknown, `PRIVATE`, ineligible, malformed or flag-gated ids all answer the same `404`.
- **Visibility is a preference, not an entitlement.** `PUBLIC` means the owner chose to show the page. A public read additionally requires, at read time, an ACTIVE account, an ACTIVE provider role and a COMPLETED registration, and, when the configuration flag `provider.profile.public_requires_marketplace_eligibility` is true, a positive answer from `MarketplaceEligibilityPort` (fail closed when no port is wired). PRO-003 and SEARCH can therefore gate exposure without changing this code. The public page states that booking is not open; the page lists nothing and is reachable only by its id.
- **The fallback public name is the account's own rule** (`publicDisplayName`: first name and last initial); the legal name is never shown. A provider-entered display name is allowed (PRD lists it separately from the legal name); whether it may differ from first name plus last initial is an open owner question.
- **Customer-appropriate badges only.** A badge exists for a requirement TYPE listed in `provider.profile.public_badge_types` (configuration) when the provider's current case holds a non-superseded, approved, unexpired requirement of that type. The result is the type code; no document, date, reason or id leaves the trust package.
- **Photos reuse the CAT-004 asset pipeline, with a purpose.** `media_assets.purpose` (`GIG_PHOTO` default, `PROFILE_PHOTO`) is immutable and database-guarded in both directions; a profile photo cannot be attached to a Gig version and the reverse. The profile points at the asset; the reference-aware clean-up and the asset guard treat the pointers as references. Trust evidence storage is not reused.
- **Public photo delivery is sanitised bytes through the API, never the stored object.** A pure container-level sanitiser (no decoding, no re-encoding) drops EXIF, GPS, XMP, IPTC, comments, text chunks and trailing data and re-emits a minimal Orientation-only EXIF; unrecognised or malformed containers are refused. The response carries a forced content type, `nosniff`, a restrictive content security policy and an opaque weak ETag (a digest of the asset id and the hash, never the content hash) so a conditional request is answered before any object read. No object key, bucket or signed URL is exposed.
- **Mutations are owner-scoped, revision-checked and atomic.** One transaction takes the account lock, then the profile lock at `expectedRevision`, then asset locks; the revision rises by exactly 1 in the same UPDATE as the change (database guard); one immutable audit row and the outbox event are written in the same transaction; provider text never reaches audit, events, logs or error details (field names only).
- **Publishing prerequisites are configuration.** Bio and photo requirements are typed parameters (seeded false, flagged as assumptions); a change that would break them on a `PUBLIC` profile is refused, not applied silently.

## Alternatives considered

- **Store a verified flag and a Gig summary on the profile.** Faster reads, wrong answers after an expiry, a retirement or a rename; every owning domain would have to notify the profile.
- **Use the account id as the public id.** Enumerable by anyone who has seen it elsewhere (events, logs, other APIs) and impossible to rotate.
- **A `SUSPENDED` or `HIDDEN` state now.** Nothing could reach it; moderation adds it by a forward migration when it exists.
- **Serve the stored photo with a signed URL.** Leaks EXIF and GPS data and any polyglot tail; it also exposes the storage topology.
- **Re-encode the image to sanitise it.** Needs an image decoder and its attack surface (DEBT-0099); a container walk with an allow-list is smaller and provable.
- **A second upload subsystem for profile photos.** Duplicates the hardest-won code of CAT-004 (promotion, scanning, reconciliation).
- **Make `PUBLIC` mean live.** Would let a profile bypass Go-Live and the marketplace eligibility the PRD reserves for PRO-003.

## Consequences

- Reads cost several statements and a sanitiser pass per photo request; a stored sanitised derivative and a cache are future work (DEBT-0107).
- The unauthenticated routes are not rate limited (DEBT-0030).
- Moderation of the display name, bio and photo is a recorded future boundary.
- PRO-003 consumes the readiness facts (`getProfileReadinessFacts`), SEARCH consumes the two events, DROP-* adds active offers to the `drops` placeholder.

## Migration / compatibility

Forward-only migrations `0024_provider_public_profiles.sql` (the `purpose` column of `provider.media_assets`, `provider.public_profiles`, `provider.profile_audit_events`, the guards, seven configuration parameters and the UI copy) and `0025_provider_profile_copy_fix.sql` (seven more copy entries); `0001` to `0023` are untouched. Existing assets default to `GIG_PHOTO`, so every Gig flow keeps its behaviour. The two replaced guard functions (`guard_media_assets`, `guard_gig_version_media`) are the earlier bodies plus the profile references and the purpose check. No backfill: a provider has no profile until they create one. Rollback is a forward migration (drop nothing that was published; set the two exposure parameters to their safe values) because applied migrations are never edited.

## Related files

- `db/migrations/0024_provider_public_profiles.sql`, `db/migrations/0025_provider_profile_copy_fix.sql`
- `packages/contracts/src/provider-profile.ts`
- `packages/provider/src/{profile-service,profile-projection,profile-validate,profile-policy,profile-photo,profile-types,image-sanitize}.ts`
- `packages/trust/src/public-badges.ts`
- `apps/api/src/modules/provider/{profile-routes,profile-dto,profile-wiring}.ts`
- `apps/web/src/app/provider/profile/**`, `apps/web/src/app/providers/**`
- `docs/data/NORMALIZATION_LOG.md` (PRO-002), `docs/architecture/ADR-0047-*.md` (the media pipeline it reuses), `docs/architecture/ADR-0046-*.md`
