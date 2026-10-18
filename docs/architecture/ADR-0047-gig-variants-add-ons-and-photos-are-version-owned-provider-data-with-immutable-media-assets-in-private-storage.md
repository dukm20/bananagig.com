# ADR-0047 — Gig variants, add-ons and photos are version-owned provider data: a published version's children never change, photo bytes are immutable private assets shared by attachment, and nothing about BananaDrop pricing is stored on them

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: CAT-004

## Context

CAT-003 (ADR-0046) built the provider Gig as an identity plus immutable versions bound to an exact Gig Template version. It deliberately left variants, add-ons and photos out (DEBT-0089). The PRD asks for them (PR-03.07 photo gallery of up to 50 photos of at most 10 MB; PR-03.08 variants and add-ons that each carry a price delta and a duration delta; CU-04.03 the options card). Two constraints shape the design:

1. A published Gig version must stay immutable (R-06: provider edits never change confirmed scope), so whatever a customer sees on a version, its variants, add-ons and photos included, must be frozen with it.
2. PRD-TRP-001 makes BananaDrop (neighborhood group pricing, DROP-001 onward) a first-class core domain. Later it will reference an exact Gig version and, for service-specific price ladders, one variant of it; compatible services keep their own base prices and ladders. CAT-004 must be consumable by that domain without containing any of it.

Photos are not trust evidence (TRUST-001 stores evidence in `trust.documents`), but they need the same hardened handling: a private bucket, server verification of the bytes, scanning that fails closed, and no object key or signed URL in any default payload.

## Decision

- **Children belong to a Gig VERSION, never to the Gig.** `provider.gig_version_variants`, `provider.gig_version_add_ons` and `provider.gig_version_media` carry `gig_version_id`. Database guards allow writes only while the parent version is DRAFT; once it is PUBLISHED, SUPERSEDED or RETIRED every child row is frozen (also against DELETE and TRUNCATE). Publishing v2 cannot touch v1's rows.
- **Next draft copies configuration, not history.** The next draft receives the variants and add-ons of the published version (same keys, same order) and re-attaches the same READY photos; v1 stays untouched. If the base price could not be carried over (the market currency changed), the options are not copied, because their deltas are minor units of the old currency.
- **One pricing rule, no absolute prices.** The Gig price (CAT-003) is the base. A variant or add-on adds a non-negative integer delta in minor units and a non-negative number of minutes. Children have no currency column: the currency is the parent version's, derived from the provider's market by the server. No floats, no negative deltas, no tiers.
- **Stable keys, regenerated row ids.** Each variant and add-on has a server-minted `item_key` unique within the version and copied into the next draft; the row id is regenerated on every replace and copy. Consumers (a booking snapshot, a BananaDrop ladder) reference `(gig_version_id, item_key)`, never the row id. Names are not identity; duplicate names (after NFKC and case folding) are refused.
- **Whole-set replacement under the draft revision.** Variants and add-ons are replaced as a list (array order is the display order) at `expectedRevision`; every effective child mutation raises the draft revision by exactly 1, so a stale editor cannot overwrite silently. The database refuses UPDATE of option rows (delete + insert only).
- **The template constrains, the Gig does not duplicate.** Variants need the bound template version to allow `FIXED_WITH_VARIANTS`; add-ons need a new explicit template-version permission (the fifth pricing model `ADD_ONS`, column `catalog.gig_template_versions.pricing_add_ons`, default false, frozen with the version; forward migration 0021). A photo attaches to a MEDIA field of the exact bound template version, and that field's own bounds apply (`max_items = 0` prohibits, PROVIDER_REQUIRED needs `min_items`); a template without a MEDIA field takes no photos. The rule is read from the template version and never copied onto the Gig.
- **Photo bytes are immutable ASSETS shared by ATTACHMENTS.** `provider.media_assets` (owned by the account; UPLOAD_PENDING → READY | ABANDONED, READY → DELETED; bytes facts frozen once READY) and `provider.gig_version_media` (version, asset, template field, order, alt text). The same READY asset can be attached to several versions, so the next draft copies no binary. An asset is deleted only when no attachment references it; deleting a draft's attachment never deletes bytes still used by a published version.
- **Private storage, controlled promotion (the TRUST-001 lessons).** The browser's file goes through the web server to a one-object presigned PUT on a separate `.upload` key; finalize reads that object, checks size, content type, magic bytes, header dimensions inside configured bounds (never decoding the image), SHA-256, and scans it; only then the exact verified bytes are promoted to the final key with a version-conditional copy (unsigned metadata is not carried over) and re-hashed. The upload key is never read again, so a replayed PUT cannot change the final asset. Production has no scanner: with `provider.gig.media.require_clean_scan` true (seeded) nothing can be attached.
- **Reference-aware, reconcilable clean-up.** A scheduled worker job abandons expired and stuck uploads, deletes unreferenced READY assets after a grace period and re-issues object deletions until `objects_removed_at` is set (a failed best-effort delete is retried, not forgotten). Retiring a Gig closes its pending uploads.
- **Photos are never public here.** No permanent URL, no search projection, no CDN. The owner can request a short-lived one-object link that the web app turns into a redirect; object keys, hashes, asset ids and signed URLs never appear in default payloads, audit rows, events or logs.
- **JPEG, PNG and WebP only.** HEIC (the PRD default) is deferred until a verified reader exists; SVG is never accepted. Every limit (size, count, types, TTLs, edges, pixels, alt text length, variant and add-on counts and text lengths) is CFG-001 configuration (`provider.gig.media.*`, `provider.gig.variant.*`, `provider.gig.add_on.*`, `provider.gig.option.*`).
- **BananaDrop readiness (PRD-TRP-001).** The version exposes the base price, stable keys, deltas and order; nothing tier-, ladder-, floor-, threshold-, participation- or Drop-related is stored on a Gig, variant, add-on or photo, and options never reference another Gig. A BananaDrop will hold its own ladders per (Gig version, item key), so compatible services with different base prices and ladders need nothing from CAT-004 but the stable references above. The PRD's "Drop-eligible" flag on variants and add-ons belongs to DROP-002.
- **Events and audit.** The published event gains counts only (`variantCount`, `addOnCount`, `mediaCount`); child mutations emit no event. Audit rows (`GIG_VARIANTS_UPDATED`, `GIG_ADD_ONS_UPDATED`, `GIG_MEDIA_*`) hold ids, counts and reason codes, never names, descriptions, alt text, keys, URLs or hashes.

## Alternatives considered

- **Children on the Gig identity.** A published version would change when the provider edits; R-06 and every later booking snapshot would break.
- **Absolute prices per variant.** Two places to change a price and no single base to compare; a BananaDrop ladder would have to be reconciled against both. A delta keeps one base.
- **One JSON document for options and media.** No foreign keys to template fields, no per-column constraints, no database-enforced freeze or counts.
- **A `media` table that stores the bytes' facts per version (no asset).** Each version would repeat the object key, hash and size and the next draft would copy or share bytes without an owner; the asset is the thing with a lifecycle, the attachment is the thing with an order and a field.
- **Reuse the trust document tables.** Different owner, different lifecycle and sensitivity; it would couple Gig publishing to verification cases.
- **Public bucket or CDN delivery now.** Moderation, EXIF handling, derivatives and a delivery architecture do not exist yet (DEBT-0099).
- **Allow add-ons in every template.** The template author must opt in; "no explicit permission" cannot mean "allowed".
- **Variant/add-on flags for BananaDrop eligibility now.** Guesses the DROP-002 vocabulary.

## Consequences

- A published Gig version is a complete, immutable offer: copy, price, duration, field values, variants, add-ons and photos. Booking, search and BananaDrop can snapshot or reference it forever.
- The Gig service gains a draft-mutation primitive (account → Gig → draft locks, revision check, +1 bump) used by every child mutation; the media service is a collaborator over it.
- Photos need an object store, a scanner port and a clean-up job at runtime; without a store or scanner every media operation is UNAVAILABLE and nothing is attached.
- Known limits are recorded: DEBT-0098 (options), DEBT-0099 (photos), DEBT-0100 (upload handling and concurrency), DEBT-0101 (API shape and temporary editor).
- A later checkpoint that changes any of this is a forward migration (never an edit of 0021 to 0023). Rollback is forward-fix only; locally `pnpm stack:reset` rebuilds from zero.

## Migration / compatibility

Migration 0021 adds the template permission, the four tables, the guards, the widened audit action CHECK and the seeds; 0022 hardens the media lifecycle (reconciliation markers, derived object key, option rows without UPDATE); 0023 corrects seeded copy and adds the refusal messages. Existing template versions get `pricing_add_ons = false`; existing Gig versions have no children.

## Related files

- `db/migrations/0021_gig_variants_addons_media.sql`, `0022_gig_media_hardening.sql`, `0023_gig_options_copy_fix.sql`
- `packages/contracts/src/gig.ts`
- `packages/provider/src/gig-service.ts`, `gig-options.ts`, `gig-media.ts`, `gig-media-model.ts`
- `apps/worker/src/jobs/gig-media.ts`
- `docs/engineering/PROVIDER_GIGS.md`
- `docs/product/BananaGig_PRD_TRP_Alignment.md`, `docs/product/ROADMAP.md`
- `docs/architecture/ADR-0041-versioned-platform-gig-templates-referenced-immutably-by-provider-gigs.md`
- `docs/architecture/ADR-0044-verification-evidence-lives-in-private-object-storage-with-server-verified-immutable-metadata.md`
- `docs/architecture/ADR-0045-scanning-and-external-verification-are-provider-neutral-ports-that-fail-closed.md`
- `docs/architecture/ADR-0046-provider-gig-versions-bind-immutably-to-exact-gig-template-versions.md`
