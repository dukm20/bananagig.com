// Public contracts of the PROVIDER PUBLIC PROFILE (PRO-002). The profile is a PRESENTATION AGGREGATE: `provider.public_profiles` stores only what the provider authors for customers (display name,
// bio, one photo, visibility). Everything else a customer sees is DERIVED at read time from the domain that owns it:
//   - the fallback public name from the account's first name and last initial (identity),
//   - trust badges from the live verification case (TRUST-001; type codes only, nothing is copied),
//   - Gig summaries from ACTIVE Gigs with a PUBLISHED version (CAT-003, CAT-004),
//   - the market code from the COMPLETED registration (PRO-001).
// Four rules shape every type here:
//   1. The ONLY public identifier is the opaque `publicProfileId`. The account id, object keys, hashes, evidence ids and legal names never appear in a public payload.
//   2. PUBLIC visibility is a preference. It does NOT mean live or bookable: Go-Live is PRO-003 and discoverability is SEARCH. `drops` and `ratings` are placeholders (`available: false`).
//   3. One projection function serves the public read and the owner preview (the preview only adds `visibility` and `preview: true`).
//   4. Provider-written text (display name, bio) is PLAIN TEXT: it never reaches an audit row, an event, a log or an error detail.
import { z } from 'zod';
import { normalizeProfileName, publicDisplayName } from './account';
import { envelope } from './envelope';
import { GIG_MEDIA_FILE_CEILING, GIG_MEDIA_MIME_TYPES, GigMediaMimeType, GigPriceDto } from './gig';
import { TRUST_REQUIREMENT_TYPES, TrustRequirementType } from './trust';

// ---------------------------------------------------------------- vocabularies
/** PRIVATE (default; owner and preview only) -> PUBLIC (the owner chose to show it) and back. No SUSPENDED state exists: nothing can reach it until moderation adds it by a forward migration. */
export const PROFILE_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const;
export const ProfileVisibility = z.enum(PROFILE_VISIBILITIES);
export type ProfileVisibility = z.infer<typeof ProfileVisibility>;

/** The asset purpose that keeps a profile photo from ever being attached to a Gig version (and the reverse); the database guards repeat it. */
export const PROFILE_PHOTO_PURPOSE = 'PROFILE_PHOTO';
export const GIG_PHOTO_PURPOSE = 'GIG_PHOTO';

export const PROFILE_AUDIT_ACTIONS = [
  'PROVIDER_PUBLIC_PROFILE_CREATED',
  'PROVIDER_PUBLIC_PROFILE_UPDATED',
  'PROVIDER_PROFILE_PHOTO_CHANGED',
  'PROVIDER_PROFILE_VISIBILITY_CHANGED',
] as const;
export type ProfileAuditAction = (typeof PROFILE_AUDIT_ACTIONS)[number];

/** The names of the fields a change can touch (what `changedFields` of an event and `changes` of an audit row may hold: names only, never values). */
export const PROFILE_FIELD_NAMES = ['displayName', 'bio', 'photo', 'visibility'] as const;
export type ProfileFieldName = (typeof PROFILE_FIELD_NAMES)[number];

// ---------------------------------------------------------------- managed content keys (CFG-002; platform UI labels and errors only, never provider text)
export const profileVisibilityKey = (v: ProfileVisibility): string => `provider.profile.visibility.${v.toLowerCase()}`;
export const profileErrorKey = (c: ProfileErrorCode): string => `provider.profile.error.${c.toLowerCase()}`;
export const profileIssueKey = (reason: ProfileIssueReason): string => `provider.profile.issue.${reason.toLowerCase()}`;
/** The label of a public trust badge, by requirement type (all seven types have copy so a configuration change never lacks it). */
export const profileBadgeKey = (t: TrustRequirementType): string => `provider.profile.badge.${t.toLowerCase()}`;

// ---------------------------------------------------------------- policy (configuration, never code)
export const PROVIDER_PROFILE_POLICY_KEYS = {
  displayNameMaxLength: 'provider.profile.display_name.max_length',
  bioMaxLength: 'provider.profile.bio.max_length',
  bioRequired: 'provider.profile.bio.required',
  photoRequired: 'provider.profile.photo.required',
  photoMaxFileSizeBytes: 'provider.profile.photo.max_file_size_bytes',
  publicBadgeTypes: 'provider.profile.public_badge_types',
  publicRequiresMarketplaceEligibility: 'provider.profile.public_requires_marketplace_eligibility',
} as const;
/** Structural ceilings of the stored text (the database CHECKs repeat them); the configured limits must not exceed them. */
export const PROFILE_DISPLAY_NAME_CEILING = 100;
export const PROFILE_BIO_CEILING = 5000;
export const ProviderProfilePolicy = z
  .object({
    displayNameMaxLength: z.number().int().min(1).max(PROFILE_DISPLAY_NAME_CEILING),
    bioMaxLength: z.number().int().min(1).max(PROFILE_BIO_CEILING),
    bioRequired: z.boolean(),
    photoRequired: z.boolean(),
    photoMaxFileSizeBytes: z.number().int().min(1).max(GIG_MEDIA_FILE_CEILING),
    /** The requirement types a customer may see as a badge (a type listed here still needs an APPROVED, current requirement of that type). */
    publicBadgeTypes: z
      .array(TrustRequirementType)
      .max(TRUST_REQUIREMENT_TYPES.length)
      .refine((a) => new Set(a).size === a.length, { message: 'badge types must be unique' }),
    /** When true a public read also needs a positive answer from the marketplace eligibility port (PRO-003 later); with no port wired the read fails closed. */
    publicRequiresMarketplaceEligibility: z.boolean(),
  })
  .strict();
export type ProviderProfilePolicy = z.infer<typeof ProviderProfilePolicy>;

// ---------------------------------------------------------------- the fallback public name (PRD CU-02.11: first name and last initial; the legal name is never shown)
/** `Jane D.` (PRD CU-02.11): the account's own public-name rule (`publicDisplayName`, one source of truth). Null when either name is missing, so a legal name is never a fallback. */
export function derivePublicName(firstName: string | null | undefined, lastName: string | null | undefined): string | null {
  const first = normalizeProfileName(firstName ?? '');
  const last = normalizeProfileName(lastName ?? '');
  if (!first || !last) return null;
  return publicDisplayName(first, last);
}

// ---------------------------------------------------------------- requests (strict; the account is the caller's, never in a body or a path)
const revision = z.number().int().min(1).max(2_147_483_647);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** Creates the caller's profile (idempotent). The body is empty on purpose. */
export const CreateProviderProfileRequest = z.object({}).strict();
export type CreateProviderProfileRequest = z.infer<typeof CreateProviderProfileRequest>;
/**
 * Changes the display name and/or the bio. A field that is ABSENT stays unchanged; `null` clears it. The raw text is bounded generously here (four times the ceiling in UTF-16 units) so the
 * service can normalise it and answer with a precise reason; the configured limits are enforced by the service.
 */
export const UpdateProviderProfileRequest = z
  .object({
    expectedRevision: revision,
    displayName: z
      .string()
      .max(PROFILE_DISPLAY_NAME_CEILING * 4)
      .nullable()
      .optional(),
    bio: z
      .string()
      .max(PROFILE_BIO_CEILING * 4)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((r) => r.displayName !== undefined || r.bio !== undefined, { message: 'name a field to change', path: ['displayName'] });
export type UpdateProviderProfileRequest = z.infer<typeof UpdateProviderProfileRequest>;
export const SetProfileVisibilityRequest = z.object({ expectedRevision: revision, visibility: ProfileVisibility }).strict();
export type SetProfileVisibilityRequest = z.infer<typeof SetProfileVisibilityRequest>;
/** Authorizes ONE profile photo upload. The client never names an account, an asset purpose or an object. A previous unfinished upload is abandoned. */
export const RequestProfilePhotoUploadRequest = z
  .object({
    expectedRevision: revision,
    mimeType: z.string().min(1).max(100),
    sizeBytes: z.number().int().min(1).max(GIG_MEDIA_FILE_CEILING),
    sha256: sha256Hex.optional(),
  })
  .strict();
export type RequestProfilePhotoUploadRequest = z.infer<typeof RequestProfilePhotoUploadRequest>;
export const FinalizeProfilePhotoRequest = z.object({ expectedRevision: revision, sha256: sha256Hex.optional() }).strict();
export type FinalizeProfilePhotoRequest = z.infer<typeof FinalizeProfilePhotoRequest>;
export const RemoveProfilePhotoRequest = z.object({ expectedRevision: revision }).strict();
export type RemoveProfilePhotoRequest = z.infer<typeof RemoveProfilePhotoRequest>;
/** The only public identifier: an opaque, random uuid (never the account id, never derived from the name). */
export const PublicProfileParams = z.object({ publicProfileId: z.string().uuid() }).strict();
export type PublicProfileParams = z.infer<typeof PublicProfileParams>;

// ---------------------------------------------------------------- issues (identifiers only; the words are registry copy under `profileIssueKey`)
export const PROFILE_ISSUE_REASONS = [
  'DISPLAY_NAME_TOO_LONG',
  'DISPLAY_NAME_BLANK',
  'DISPLAY_NAME_FORBIDDEN_CHARACTER',
  'DISPLAY_NAME_HTML_NOT_ALLOWED',
  'BIO_TOO_LONG',
  'BIO_BLANK',
  'BIO_FORBIDDEN_CHARACTER',
  'BIO_HTML_NOT_ALLOWED',
  /** Publishing facts (PROFILE_INCOMPLETE): what a PUBLIC profile still needs. */
  'BIO_REQUIRED',
  'PHOTO_REQUIRED',
  'PUBLIC_NAME_UNAVAILABLE',
] as const;
export type ProfileIssueReason = (typeof PROFILE_ISSUE_REASONS)[number];
export const ProfileIssueDto = z.object({ reason: z.enum(PROFILE_ISSUE_REASONS), field: z.enum(PROFILE_FIELD_NAMES).optional() });
export type ProfileIssueDto = z.infer<typeof ProfileIssueDto>;

// ---------------------------------------------------------------- DTOs
/** Readiness FACTS for PRO-003 and the owner (a fact is not a decision: `profileComplete` is NOT Go-Live and does not make the profile public). */
export const ProfileReadinessDto = z.object({
  /** The provider entered a display name of their own. */
  displayNamePresent: z.boolean(),
  /** Some public name can be shown (the display name or the account's first name and last initial). */
  publicNameAvailable: z.boolean(),
  bioPresent: z.boolean(),
  profilePhotoPresent: z.boolean(),
  hasPublishedGig: z.boolean(),
  /** At least one public trust badge is currently derivable. */
  trustSummaryAvailable: z.boolean(),
  /** Everything the configuration requires for a public profile is present (name; bio and photo only when required). */
  profileComplete: z.boolean(),
  /** Null when the profile does not exist yet. */
  visibility: ProfileVisibility.nullable(),
});
export type ProfileReadinessDto = z.infer<typeof ProfileReadinessDto>;

/** The limits the owner's form needs (from configuration; the server enforces them). */
export const ProfileLimitsDto = z.object({
  displayNameMaxLength: z.number().int(),
  bioMaxLength: z.number().int(),
  bioRequired: z.boolean(),
  photoRequired: z.boolean(),
  photoMaxSizeBytes: z.number().int(),
  photoMimeTypes: z.array(GigMediaMimeType),
});
export type ProfileLimitsDto = z.infer<typeof ProfileLimitsDto>;

/** What a photo looks like to a client: no asset id, no object key, no hash, no URL (the bytes come from the controlled photo routes). */
export const ProfilePhotoDto = z.object({ mimeType: GigMediaMimeType, width: z.number().int(), height: z.number().int() }).strict();
export type ProfilePhotoDto = z.infer<typeof ProfilePhotoDto>;

export const OwnerProviderProfileDto = z.object({
  publicProfileId: z.string(),
  /** The provider's own display name, or null when none was entered. */
  displayName: z.string().nullable(),
  /** The name customers see now (the display name, else first name and last initial); null when neither exists. */
  publicName: z.string().nullable(),
  bio: z.string().nullable(),
  photo: ProfilePhotoDto.nullable(),
  /** An upload was authorized and not finished. */
  photoPending: z.boolean(),
  visibility: ProfileVisibility,
  publishedAt: z.string().nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OwnerProviderProfileDto = z.infer<typeof OwnerProviderProfileDto>;
/** The owner's view: `exists: false` (no row yet) still carries the readiness facts and the limits so the form can render. */
export const OwnerProfileStateDto = z.object({
  exists: z.boolean(),
  profile: OwnerProviderProfileDto.nullable(),
  readiness: ProfileReadinessDto,
  limits: ProfileLimitsDto,
});
export type OwnerProfileStateDto = z.infer<typeof OwnerProfileStateDto>;
export const OwnerProfileStateResponse = envelope(OwnerProfileStateDto);

/** A customer-appropriate trust indicator: the requirement TYPE only (never a document type, number, date, reason, count, case or requirement id). */
export const PublicBadgeDto = z.object({ type: TrustRequirementType }).strict();
export type PublicBadgeDto = z.infer<typeof PublicBadgeDto>;
/** A published Gig as a card. Derived on every read; nothing is stored. No BananaDrop, tier, rating or availability data. */
export const PublicGigSummaryDto = z
  .object({
    gigId: z.string(),
    title: z.string(),
    shortPitch: z.string().nullable(),
    serviceTypeCode: z.string(),
    serviceTypeNameContentKey: z.string(),
    price: GigPriceDto.nullable(),
    durationMinutes: z.number().int().nullable(),
    variantCount: z.number().int(),
    addOnCount: z.number().int(),
    photoCount: z.number().int(),
  })
  .strict();
export type PublicGigSummaryDto = z.infer<typeof PublicGigSummaryDto>;
/** The provider's ACTIVE public market, never an address, an area or a coordinate. */
export const PublicMarketDto = z.object({ code: z.string() }).strict();
export type PublicMarketDto = z.infer<typeof PublicMarketDto>;

/** What any customer may see. `ratings` and `drops` are placeholders so RATE-* and DROP-* can fill them without breaking readers; nothing is fabricated. */
export const PublicProviderProfileDto = z
  .object({
    publicProfileId: z.string(),
    displayName: z.string(),
    bio: z.string().nullable(),
    photo: ProfilePhotoDto.nullable(),
    badges: z.array(PublicBadgeDto),
    market: PublicMarketDto.nullable(),
    gigs: z.array(PublicGigSummaryDto),
    ratings: z.object({ available: z.literal(false) }).strict(),
    drops: z.object({ available: z.literal(false) }).strict(),
  })
  .strict();
export type PublicProviderProfileDto = z.infer<typeof PublicProviderProfileDto>;
export const PublicProviderProfileResponse = envelope(PublicProviderProfileDto);
/** The owner's preview: exactly the public projection plus the visibility and a marker that it is a preview (a PRIVATE profile is previewable; it is not public). */
export const PreviewProviderProfileDto = PublicProviderProfileDto.extend({ preview: z.literal(true), visibility: ProfileVisibility }).strict();
export type PreviewProviderProfileDto = z.infer<typeof PreviewProviderProfileDto>;
export const PreviewProviderProfileResponse = envelope(PreviewProviderProfileDto);

/** The answer to a photo upload authorization: the one-object short-lived PUT target (shown once, never stored, never logged). */
export const ProfilePhotoUploadDto = z.object({
  upload: z.object({ url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
  maxSizeBytes: z.number().int(),
  /** The profile revision AFTER the reservation (the next call must send it). */
  revision: z.number().int(),
});
export type ProfilePhotoUploadDto = z.infer<typeof ProfilePhotoUploadDto>;
export const ProfilePhotoUploadResponse = envelope(ProfilePhotoUploadDto);

// ---------------------------------------------------------------- events (transactional outbox; identifiers and field NAMES only, never provider text)
export const PROFILE_EVENTS = {
  profileUpdated: 'bananagig.provider.profile-updated.v1',
  profileVisibilityChanged: 'bananagig.provider.profile-visibility-changed.v1',
} as const;
export const ProfileUpdatedPayload = z.object({
  accountId: z.string(),
  publicProfileId: z.string(),
  revision: z.number().int(),
  changedFields: z.array(z.enum(PROFILE_FIELD_NAMES)),
});
export type ProfileUpdatedPayload = z.infer<typeof ProfileUpdatedPayload>;
export const ProfileVisibilityChangedPayload = z.object({ accountId: z.string(), publicProfileId: z.string(), visibility: ProfileVisibility });
export type ProfileVisibilityChangedPayload = z.infer<typeof ProfileVisibilityChangedPayload>;

// ---------------------------------------------------------------- errors
export const PROFILE_ERROR_CODES = [
  'PROFILE_NOT_FOUND',
  'PROVIDER_NOT_ELIGIBLE',
  'ACCOUNT_NOT_ACTIVE',
  'STALE_PROFILE',
  'PROFILE_INCOMPLETE',
  'VALIDATION_FAILED',
  'CONFLICT',
  'UNAVAILABLE',
  'MEDIA_NOT_FOUND',
  'MEDIA_REFUSED',
  'MEDIA_EXPIRED',
  'MEDIA_SCAN_UNAVAILABLE',
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];
/** The code on the wire (`error.code`): `PROFILE_NOT_FOUND`, `PROFILE_INCOMPLETE` and `STALE_PROFILE` as they are, every other code prefixed with `PROFILE_`. */
export const profileWireCode = (c: ProfileErrorCode): string => (c.startsWith('PROFILE_') || c === 'STALE_PROFILE' ? c : `PROFILE_${c}`);

export const PROFILE_PHOTO_MIME_TYPES = GIG_MEDIA_MIME_TYPES;
