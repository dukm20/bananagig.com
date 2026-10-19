# Provider public profile (PRO-002)

The provider public profile is a **presentation aggregate**: it stores only what the provider writes for customers and derives everything else on every read from the domain that owns it (ADR-0048). It is not Go-Live (PRO-003), not search or discoverability (SEARCH), not ratings (RATE) and not BananaDrop (DROP). A public profile is an unlisted page reachable only by its opaque id; nothing lists or searches profiles yet.

## What is stored and what is derived

| Public field | Owner | Stored in the profile? | How it is produced |
|---|---|---|---|
| `publicProfileId` | PRO-002 | yes (`provider.public_profiles.public_profile_id`, random uuid, immutable) | the only public identifier |
| `displayName` | PRO-002 (provider-authored) or identity (fallback) | the provider's own name only | the provider's name when set, else `publicDisplayName(first, last)` = first name and last initial (`Jane D.`); the legal name is never shown |
| `bio` | PRO-002 (provider-authored plain text) | yes | as stored |
| `photo` (type, width, height) | CAT-004 asset pipeline, purpose `PROFILE_PHOTO` | a pointer to the asset only | facts of the READY asset; the bytes come from the sanitised photo route |
| `badges[].type` | TRUST-001 | no | requirement type codes in `provider.profile.public_badge_types` with an APPROVED, unexpired, non-superseded requirement in the current case, evaluated at read time |
| `market.code` | PRO-001 / geography | no | the COMPLETED registration's market, only when ACTIVE and in effect |
| `gigs[]` (id, title, short pitch, service type code and name key, base price, duration, option and photo counts) | CAT-003 / CAT-004 | no | ACTIVE Gigs with a PUBLISHED version only |
| `ratings.available` | RATE-* | no | always `false` |
| `drops.available` | DROP-* | no | always `false` |

Never in a public payload: the account id, email, phone, address, legal name, any object key, bucket, hash, signed URL, asset id, trust case, requirement, document or reviewer detail, session or device data. Every public DTO is `.strict()`, built field by field.

## Visibility

`PRIVATE` (default) and `PUBLIC`, owner-only, with `published_at` set while PUBLIC. A public read also requires, at read time: an ACTIVE account, an ACTIVE PROVIDER role, a COMPLETED registration, a public name, and, when `provider.profile.public_requires_marketplace_eligibility` is true, a positive answer from `MarketplaceEligibilityPort` (no port wired = the read fails closed). Anything else (unknown, malformed, PRIVATE, ineligible) answers the identical `404 PROFILE_NOT_FOUND` with `no-store`. Making a profile PRIVATE is always allowed and depends on no other service. A change that would break the publishing prerequisites of a PUBLIC profile (clearing the name when no fallback exists, clearing a required bio, removing a required photo) is refused with `PROFILE_INCOMPLETE`.

## Photo delivery

Profile photos reuse the CAT-004 private asset pipeline (header, signature, size, hash, scan, version-conditional promotion) and are additionally sanitised at finalize. Anonymous and owner photo responses are the **sanitised bytes**, never the stored object: a pure container-level sanitiser keeps only validated structural parts, the image data and (for JPEG) a minimal Orientation-only EXIF, and drops EXIF/GPS, XMP, IPTC, comments, text chunks, thumbnails, unknown parts and trailing data. Headers: forced content type, `nosniff`, `Content-Disposition: inline`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-cache` and an opaque weak ETag (a digest of the asset id and the content hash). A matching `If-None-Match` answers 304 before any object read.

## API

Owner (`/api/v1/provider`, token required, `no-store`, strict bodies, the account is always the token's): `GET|POST|PATCH /profile`, `POST /profile/visibility`, `POST /profile/photo/uploads`, `POST /profile/photo/finalize`, `DELETE /profile/photo`, `GET /profile/preview`, `GET /profile/photo`. Public (no authentication, a supplied token is ignored): `GET /api/v1/providers/{publicProfileId}` and `.../photo`.

## Rules for the next checkpoints

- PRO-003 consumes `getProfileReadinessFacts` (`profileComplete` is not Go-Live) and may wire `MarketplaceEligibilityPort` and flip the flag; it must not copy any profile fact.
- SEARCH consumes `bananagig.provider.profile-updated.v1` and `profile-visibility-changed.v1` (field names only; the payload pairs the account id and the public id, so a consumer must not expose that mapping).
- DROP-* fills `drops`, RATE-* fills `ratings`; neither changes the public id or stores data in the profile.
- Moderation adds a state by forward migration; until then the display name, bio and photo are unreviewed (DEBT-0106).
- Open limits: DEBT-0106 to DEBT-0109.
