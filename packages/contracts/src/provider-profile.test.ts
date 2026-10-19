import { describe, expect, it } from 'vitest';
import {
  CreateProviderProfileRequest,
  OwnerProfileStateDto,
  PROFILE_ERROR_CODES,
  PROFILE_ISSUE_REASONS,
  PreviewProviderProfileDto,
  ProviderProfilePolicy,
  PublicProfileParams,
  PublicProviderProfileDto,
  SetProfileVisibilityRequest,
  UpdateProviderProfileRequest,
  derivePublicName,
  publicDisplayName,
  profileBadgeKey,
  profileErrorKey,
  profileIssueKey,
  profileWireCode,
  TRUST_REQUIREMENT_TYPES,
} from './index';

const publicProfile = {
  publicProfileId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  displayName: 'Jane D.',
  bio: null,
  photo: null,
  badges: [],
  market: null,
  gigs: [],
  ratings: { available: false },
  drops: { available: false },
};

describe('derivePublicName (first name and last initial)', () => {
  it('uses the first code point of the last name, uppercased, with a period', () => {
    expect(derivePublicName('Jane', 'doe')).toBe('Jane D.');
    expect(derivePublicName(' Jane ', ' Ōkami')).toBe('Jane Ō.');
    expect(derivePublicName('Ann', '\u{1F600}x')).toBe('Ann \u{1F600}.');
    // parity with the account area rule: the German sharp s is kept as one character (it does not become SS)
    expect(derivePublicName('Jane', '\u00DFmith')).toBe(publicDisplayName('Jane', '\u00DFmith'));
    expect(derivePublicName('Jane', '\u00DFmith')).toBe('Jane \u00DF.');
  });
  it('is null when a name is missing, so the legal name is never a fallback', () => {
    expect(derivePublicName('Jane', '')).toBeNull();
    expect(derivePublicName(null, 'Doe')).toBeNull();
    expect(derivePublicName(undefined, undefined)).toBeNull();
  });
});

describe('profile requests are strict', () => {
  it('create takes an empty body only', () => {
    expect(CreateProviderProfileRequest.safeParse({}).success).toBe(true);
    expect(CreateProviderProfileRequest.safeParse({ accountId: 'x' }).success).toBe(false);
  });
  it('update needs a revision, a field to change and no unknown field', () => {
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 1, bio: null }).success).toBe(true);
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 1, displayName: 'Jane' }).success).toBe(true);
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(UpdateProviderProfileRequest.safeParse({ displayName: 'x' }).success).toBe(false);
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 1, bio: 'x', accountId: 'a' }).success).toBe(false);
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 0, bio: 'x' }).success).toBe(false);
    expect(UpdateProviderProfileRequest.safeParse({ expectedRevision: 1, bio: 'x'.repeat(20_001) }).success).toBe(false);
  });
  it('visibility accepts only the two states', () => {
    expect(SetProfileVisibilityRequest.safeParse({ expectedRevision: 2, visibility: 'PUBLIC' }).success).toBe(true);
    expect(SetProfileVisibilityRequest.safeParse({ expectedRevision: 2, visibility: 'SUSPENDED' }).success).toBe(false);
  });
  it('the public id is a uuid and nothing else', () => {
    expect(PublicProfileParams.safeParse({ publicProfileId: publicProfile.publicProfileId }).success).toBe(true);
    expect(PublicProfileParams.safeParse({ publicProfileId: 'jane-d' }).success).toBe(false);
    expect(PublicProfileParams.safeParse({ publicProfileId: publicProfile.publicProfileId, accountId: 'a' }).success).toBe(false);
  });
});

describe('public projection shape', () => {
  it('accepts the placeholders and rejects fabricated ratings or drops', () => {
    expect(PublicProviderProfileDto.safeParse(publicProfile).success).toBe(true);
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, ratings: { available: true } }).success).toBe(false);
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, drops: { available: false, active: [] } }).success).toBe(false);
  });
  it('rejects any extra field, so an internal id cannot ride along', () => {
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, accountId: 'a' }).success).toBe(false);
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, email: 'a@b.c' }).success).toBe(false);
  });
  it('the preview is the public projection plus the visibility and the marker', () => {
    expect(PreviewProviderProfileDto.safeParse({ ...publicProfile, preview: true, visibility: 'PRIVATE' }).success).toBe(true);
    expect(PreviewProviderProfileDto.safeParse({ ...publicProfile, preview: false, visibility: 'PRIVATE' }).success).toBe(false);
    expect(PreviewProviderProfileDto.safeParse(publicProfile).success).toBe(false);
  });
  it('a badge is a requirement type only', () => {
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, badges: [{ type: 'IDENTITY' }] }).success).toBe(true);
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, badges: [{ type: 'IDENTITY', expiresAt: '2030-01-01' }] }).success).toBe(false);
    expect(PublicProviderProfileDto.safeParse({ ...publicProfile, badges: [{ type: 'PASSPORT' }] }).success).toBe(false);
  });
  it('the owner state carries readiness and limits even without a profile', () => {
    const ok = OwnerProfileStateDto.safeParse({
      exists: false,
      profile: null,
      readiness: {
        displayNamePresent: false,
        publicNameAvailable: true,
        bioPresent: false,
        profilePhotoPresent: false,
        hasPublishedGig: false,
        trustSummaryAvailable: false,
        profileComplete: true,
        visibility: null,
      },
      limits: {
        displayNameMaxLength: 60,
        bioMaxLength: 1000,
        bioRequired: false,
        photoRequired: false,
        photoMaxSizeBytes: 2097152,
        photoMimeTypes: ['image/jpeg'],
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('policy', () => {
  const ok = {
    displayNameMaxLength: 60,
    bioMaxLength: 1000,
    bioRequired: false,
    photoRequired: false,
    photoMaxFileSizeBytes: 2_097_152,
    publicBadgeTypes: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'],
    publicRequiresMarketplaceEligibility: false,
  };
  it('accepts the seeded values', () => expect(ProviderProfilePolicy.safeParse(ok).success).toBe(true));
  it('refuses values over the structural ceilings, duplicate or unknown badge types and extra keys', () => {
    expect(ProviderProfilePolicy.safeParse({ ...ok, displayNameMaxLength: 101 }).success).toBe(false);
    expect(ProviderProfilePolicy.safeParse({ ...ok, bioMaxLength: 5001 }).success).toBe(false);
    expect(ProviderProfilePolicy.safeParse({ ...ok, photoMaxFileSizeBytes: 26_214_401 }).success).toBe(false);
    expect(ProviderProfilePolicy.safeParse({ ...ok, publicBadgeTypes: ['IDENTITY', 'IDENTITY'] }).success).toBe(false);
    expect(ProviderProfilePolicy.safeParse({ ...ok, publicBadgeTypes: ['PASSPORT'] }).success).toBe(false);
    expect(ProviderProfilePolicy.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('keys and codes', () => {
  it('has copy keys for every error, issue and trust type', () => {
    for (const c of PROFILE_ERROR_CODES) expect(profileErrorKey(c)).toBe(`provider.profile.error.${c.toLowerCase()}`);
    for (const r of PROFILE_ISSUE_REASONS) expect(profileIssueKey(r)).toMatch(/^provider\.profile\.issue\.[a-z_]+$/);
    for (const t of TRUST_REQUIREMENT_TYPES) expect(profileBadgeKey(t)).toBe(`provider.profile.badge.${t.toLowerCase()}`);
  });
  it('wire codes are unique and never double-prefixed', () => {
    const wire = PROFILE_ERROR_CODES.map(profileWireCode);
    expect(new Set(wire).size).toBe(wire.length);
    expect(wire.filter((w) => w.startsWith('PROFILE_PROFILE_'))).toEqual([]);
    expect(profileWireCode('STALE_PROFILE')).toBe('STALE_PROFILE');
    expect(profileWireCode('PROFILE_NOT_FOUND')).toBe('PROFILE_NOT_FOUND');
    expect(profileWireCode('VALIDATION_FAILED')).toBe('PROFILE_VALIDATION_FAILED');
  });
});
