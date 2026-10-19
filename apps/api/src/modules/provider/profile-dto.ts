// Provider public profile API shaping and error mapping (PRO-002). Every mapper builds the response field by field: the service already shapes its view, but the API never relies on that
// alone. The public mappers are the LAST line of defence of the public surface: they copy the allow-listed properties and nothing else, so a service that one day returns an account id, an
// object key, a hash or a legal name by mistake still cannot put it on the wire. Provider-written text (display name, bio) appears only in the owner's own responses and in the public
// projection; it never appears in an error.
import {
  PROFILE_ISSUE_REASONS,
  PROFILE_PHOTO_MIME_TYPES,
  profileErrorKey,
  profileWireCode,
  type OwnerProfileStateDto,
  type PreviewProviderProfileDto,
  type ProfileErrorCode,
  type ProfileIssueDto,
  type ProfilePhotoDto,
  type ProfilePhotoUploadDto,
  type PublicProviderProfileDto,
} from '@bananagig/contracts';
import { ProfileError, ProviderError } from '@bananagig/provider';
import { AppError } from '../../errors';
import { MEDIA_REFUSAL_REASONS } from './gig-dto';

const photoDto = (p: ProfilePhotoDto | null): ProfilePhotoDto | null => (p === null ? null : { mimeType: p.mimeType, width: p.width, height: p.height });

/** The owner's view: the form state, the readiness facts and the configured limits. No asset id, key, hash or URL. */
export const ownerStateDto = (s: OwnerProfileStateDto): OwnerProfileStateDto => ({
  exists: s.exists,
  profile:
    s.profile === null
      ? null
      : {
          publicProfileId: s.profile.publicProfileId,
          displayName: s.profile.displayName,
          publicName: s.profile.publicName,
          bio: s.profile.bio,
          photo: photoDto(s.profile.photo),
          photoPending: s.profile.photoPending,
          visibility: s.profile.visibility,
          publishedAt: s.profile.publishedAt,
          revision: s.profile.revision,
          createdAt: s.profile.createdAt,
          updatedAt: s.profile.updatedAt,
        },
  readiness: {
    displayNamePresent: s.readiness.displayNamePresent,
    publicNameAvailable: s.readiness.publicNameAvailable,
    bioPresent: s.readiness.bioPresent,
    profilePhotoPresent: s.readiness.profilePhotoPresent,
    hasPublishedGig: s.readiness.hasPublishedGig,
    trustSummaryAvailable: s.readiness.trustSummaryAvailable,
    profileComplete: s.readiness.profileComplete,
    visibility: s.readiness.visibility,
  },
  limits: {
    displayNameMaxLength: s.limits.displayNameMaxLength,
    bioMaxLength: s.limits.bioMaxLength,
    bioRequired: s.limits.bioRequired,
    photoRequired: s.limits.photoRequired,
    photoMaxSizeBytes: s.limits.photoMaxSizeBytes,
    photoMimeTypes: [...s.limits.photoMimeTypes],
  },
});

/** What any customer may see: allow-listed properties only (see the contract PublicProviderProfileDto). */
export const publicProfileDto = (p: PublicProviderProfileDto): PublicProviderProfileDto => ({
  publicProfileId: p.publicProfileId,
  displayName: p.displayName,
  bio: p.bio,
  photo: photoDto(p.photo),
  badges: p.badges.map((b) => ({ type: b.type })),
  market: p.market === null ? null : { code: p.market.code },
  gigs: p.gigs.map((g) => ({
    gigId: g.gigId,
    title: g.title,
    shortPitch: g.shortPitch,
    serviceTypeCode: g.serviceTypeCode,
    serviceTypeNameContentKey: g.serviceTypeNameContentKey,
    price: g.price === null ? null : { amountMinor: g.price.amountMinor, currency: g.price.currency },
    durationMinutes: g.durationMinutes,
    variantCount: g.variantCount,
    addOnCount: g.addOnCount,
    photoCount: g.photoCount,
  })),
  ratings: { available: false },
  drops: { available: false },
});

export const previewProfileDto = (p: PreviewProviderProfileDto): PreviewProviderProfileDto => ({
  ...publicProfileDto(p),
  visibility: p.visibility,
  preview: true,
});

export const photoUploadDto = (u: ProfilePhotoUploadDto): ProfilePhotoUploadDto => ({
  upload: { url: u.upload.url, headers: { ...u.upload.headers }, expiresAt: u.upload.expiresAt },
  maxSizeBytes: u.maxSizeBytes,
  revision: u.revision,
});

// ---------------------------------------------------------------- errors
/**
 * The ONLY service details that reach a client: an ALLOW-list of short machine tokens (`reason`, `field`, `code`), `retryable`, small integer bounds (`limit`, `max`, `count`) and the
 * issues of a refused value or an incomplete profile (reason code and field NAME: identifiers only). Anything else a future service change might put in `details` (a cause, SQL, a value,
 * the provider's text, an object key) is dropped here.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ISSUES = 16;
const ISSUE_REASON = new Set<string>(PROFILE_ISSUE_REASONS);
const FIELDS = new Set<string>(['displayName', 'bio', 'photo', 'visibility']);
export function safeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['reason', 'field', 'code'] as const) {
    const v = details[key];
    if (typeof v === 'string' && SAFE_TOKEN.test(v)) out[key] = v;
  }
  if (details.retryable === true) out.retryable = true;
  for (const key of ['limit', 'max', 'count'] as const) {
    const v = details[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000) out[key] = v;
  }
  if (Array.isArray(details.issues)) {
    const issues: ProfileIssueDto[] = [];
    for (const raw of details.issues) {
      if (issues.length >= MAX_ISSUES) break;
      if (raw === null || typeof raw !== 'object') continue;
      const i = raw as Record<string, unknown>;
      if (typeof i.reason !== 'string' || !ISSUE_REASON.has(i.reason)) continue;
      issues.push({
        reason: i.reason as ProfileIssueDto['reason'],
        ...(typeof i.field === 'string' && FIELDS.has(i.field) ? { field: i.field as NonNullable<ProfileIssueDto['field']> } : {}),
      });
    }
    if (issues.length > 0) out.issues = issues;
  }
  return out;
}

type Category = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'AUTHORIZATION' | 'DEPENDENCY';
const MESSAGES: Record<ProfileErrorCode, { category: Category; message: string }> = {
  PROFILE_NOT_FOUND: { category: 'NOT_FOUND', message: 'The profile was not found' },
  PROVIDER_NOT_ELIGIBLE: { category: 'AUTHORIZATION', message: 'The account cannot have a provider profile yet' },
  ACCOUNT_NOT_ACTIVE: { category: 'AUTHORIZATION', message: 'The account is not active' },
  STALE_PROFILE: { category: 'CONFLICT', message: 'The profile changed since it was read' },
  PROFILE_INCOMPLETE: { category: 'CONFLICT', message: 'The profile is not complete enough to be public' },
  VALIDATION_FAILED: { category: 'VALIDATION', message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', message: 'The profile is temporarily unavailable' },
  MEDIA_NOT_FOUND: { category: 'NOT_FOUND', message: 'The photo was not found' },
  MEDIA_REFUSED: { category: 'VALIDATION', message: 'The photo cannot be used' },
  MEDIA_EXPIRED: { category: 'CONFLICT', message: 'The upload expired; start a new upload' },
  MEDIA_SCAN_UNAVAILABLE: { category: 'DEPENDENCY', message: 'The photo could not be checked yet; try again later' },
};

/** The one answer for an unknown, private, ineligible or malformed public id: byte-for-byte the same body apart from the correlation id. */
export const publicNotFound = (): AppError =>
  new AppError('NOT_FOUND', profileWireCode('PROFILE_NOT_FOUND'), MESSAGES.PROFILE_NOT_FOUND.message, { messageKey: profileErrorKey('PROFILE_NOT_FOUND') });

/** Maps typed profile failures onto the standard API error model: fixed messages, a message KEY for the web, and allow-listed details. */
export function toAppError(err: unknown): never {
  // the account port reports its own outages and refusals as ProviderError: translate them to the profile vocabulary (never a 500)
  if (err instanceof ProviderError) {
    if (err.code === 'ACCOUNT_NOT_ACTIVE') err = new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
    else if (err.code === 'CONFLICT')
      err = new ProfileError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
        reason: 'CONCURRENT_UPDATE',
        retryable: true,
      });
    else err = new ProfileError('UNAVAILABLE', 'the profile is unavailable');
  }
  if (!(err instanceof ProfileError)) throw err;
  const m = MESSAGES[err.code];
  if (!m) throw err;
  const code = profileWireCode(err.code);
  const messageKey = profileErrorKey(err.code);
  if (err.code === 'UNAVAILABLE') throw new AppError('DEPENDENCY', code, m.message, { messageKey });
  // a scan outage is retryable by definition and carries nothing else; a missing photo carries nothing at all (it must not tell "unknown" from "not yours")
  if (err.code === 'MEDIA_SCAN_UNAVAILABLE') throw new AppError('DEPENDENCY', code, m.message, { retryable: true, messageKey });
  if (err.code === 'MEDIA_NOT_FOUND' || err.code === 'PROFILE_NOT_FOUND') throw new AppError('NOT_FOUND', code, m.message, { messageKey });
  const details = safeDetails(err.details);
  // a refused photo names WHY from a closed list of reason codes (never a size, a hash, a key or the stored content type)
  if (err.code === 'MEDIA_REFUSED' && typeof details.reason === 'string' && !MEDIA_REFUSAL_REASONS.has(details.reason)) delete details.reason;
  throw new AppError(m.category, code, m.message, { ...details, messageKey });
}

/** The content types a photo response may carry (the same allow-list as the upload policy); anything else is never sent. */
export const PHOTO_CONTENT_TYPES: ReadonlySet<string> = new Set<string>(PROFILE_PHOTO_MIME_TYPES);
