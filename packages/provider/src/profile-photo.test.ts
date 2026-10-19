// Unit tests of the profile photo service (PRO-002) that need no database: the opaque validator, the If-None-Match match, and the refusals that must happen BEFORE any store, scanner or
// statement is touched (input validation, stale revision, policy, size cap). Everything that needs real constraints, locks, the sweep and the object flow is in profile-photo.itest.ts.
import { MemoryObjectStore } from '@bananagig/platform';
import { describe, expect, it } from 'vitest';
import type { Database } from '@bananagig/database';
import { GigError } from './gig-errors';
import { DEFAULT_GIG_MEDIA_POLICY } from './gig-policy';
import { ProfileError } from './profile-errors';
import { ifNoneMatchMatches, ProfilePhotoService, profilePhotoEtag, type ProfilePhotoServiceDeps } from './profile-photo';
import { DEFAULT_PROFILE_POLICY, StaticProfilePolicyProvider, type ProfileMutator } from './profile-types';

const SHA = 'a'.repeat(64);
const ASSET = '3f9a1c7b-2d4e-4a6b-8c1d-5e7f90a1b2c3';

describe('profilePhotoEtag', () => {
  it('is a weak, opaque validator that is not the content hash', () => {
    const etag = profilePhotoEtag(ASSET, SHA);
    expect(etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
    expect(etag).not.toContain(SHA);
    expect(etag).not.toContain(ASSET);
    expect(profilePhotoEtag(ASSET, SHA)).toBe(etag);
  });
  it('changes with the asset and with the content hash', () => {
    const base = profilePhotoEtag(ASSET, SHA);
    expect(profilePhotoEtag('4f9a1c7b-2d4e-4a6b-8c1d-5e7f90a1b2c3', SHA)).not.toBe(base);
    expect(profilePhotoEtag(ASSET, 'b'.repeat(64))).not.toBe(base);
  });
});

describe('ifNoneMatchMatches', () => {
  const etag = profilePhotoEtag(ASSET, SHA);
  const other = profilePhotoEtag(ASSET, 'c'.repeat(64));
  it('matches the same tag, weak or strong, alone or in a list', () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(etag.slice(2), etag)).toBe(true); // the strong spelling of the same opaque tag
    expect(ifNoneMatchMatches(`${other}, ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches(`  ${etag}  ,${other}`, etag)).toBe(true);
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
  });
  it('does not match another tag, an empty header, garbage or an over-long header', () => {
    expect(ifNoneMatchMatches(other, etag)).toBe(false);
    expect(ifNoneMatchMatches(undefined, etag)).toBe(false);
    expect(ifNoneMatchMatches('', etag)).toBe(false);
    expect(ifNoneMatchMatches(',,,', etag)).toBe(false);
    expect(ifNoneMatchMatches('W/', etag)).toBe(false);
    expect(ifNoneMatchMatches(`${'x'.repeat(2000)},${etag}`, etag)).toBe(false);
  });
});

// ---------------------------------------------------------------- the service with fakes that fail the test when touched
const untouched = (name: string) => () => {
  throw new Error(`${name} must not be touched`);
};
class CountingStore extends MemoryObjectStore {
  reads = 0;
  override async read(key: string, max: number) {
    this.reads++;
    return super.read(key, max);
  }
  override async readVersioned(key: string, max: number) {
    this.reads++;
    return super.readVersioned(key, max);
  }
}
const noDatabase = new Proxy({} as Database, { get: untouched('the database') });
const noMutation: ProfileMutator['mutateProfile'] = async () => {
  throw new Error('no mutation expected');
};
function make(over: { revision?: number; photoCap?: number; mediaPolicy?: () => Promise<typeof DEFAULT_GIG_MEDIA_POLICY>; onRead?: () => void } = {}) {
  const store = new CountingStore();
  const calls = { reads: 0, publicTargets: 0, ownerTargets: 0, scans: 0 };
  const policy = new StaticProfilePolicyProvider({
    ...DEFAULT_PROFILE_POLICY,
    photoMaxFileSizeBytes: over.photoCap ?? DEFAULT_PROFILE_POLICY.photoMaxFileSizeBytes,
  });
  const profiles: ProfileMutator = {
    async readProfile() {
      calls.reads++;
      over.onRead?.();
      return { publicProfileId: ASSET, revision: over.revision ?? 3, photoAssetId: null, pendingPhotoAssetId: null };
    },
    mutateProfile: noMutation,
  };
  const deps: ProfilePhotoServiceDeps = {
    database: noDatabase,
    store,
    scanner: {
      async scan() {
        calls.scans++;
        return { status: 'CLEAN' };
      },
    },
    media: { media: over.mediaPolicy ?? (async () => ({ ...DEFAULT_GIG_MEDIA_POLICY })) },
    policy,
    profiles,
    async getPublicPhotoTarget() {
      calls.publicTargets++;
      return null;
    },
    async getOwnerPhotoTarget() {
      calls.ownerTargets++;
      return null;
    },
  };
  return { svc: new ProfilePhotoService(deps), store, calls, policy };
}
const err = async (p: Promise<unknown>): Promise<ProfileError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProfileError) return e;
    throw e;
  }
  throw new Error('expected a ProfileError');
};
const upload = (over: Record<string, unknown> = {}) => ({ expectedRevision: 3, mimeType: 'image/jpeg', sizeBytes: 100_000, ...over });

describe('ProfilePhotoService: refusals before any side effect', () => {
  it('rejects invalid and unknown request fields as VALIDATION_FAILED without reading the profile, signing or touching the database', async () => {
    const { svc, store, calls } = make();
    for (const body of [
      null,
      'x',
      {},
      upload({ sizeBytes: 0 }),
      upload({ sizeBytes: 1.5 }),
      upload({ expectedRevision: 0 }),
      upload({ mimeType: '' }),
      upload({ extra: 1 }),
      upload({ accountId: 'x' }),
      upload({ purpose: 'GIG_PHOTO' }),
      upload({ sha256: 'ZZ' }),
    ]) {
      const e = await err(svc.requestUpload('acct', body));
      expect(e.code).toBe('VALIDATION_FAILED');
    }
    expect((await err(svc.finalize('acct', { expectedRevision: 3, sha256: 'nope' }))).code).toBe('VALIDATION_FAILED');
    expect((await err(svc.finalize('acct', { expectedRevision: 3, photoAssetId: ASSET }))).code).toBe('VALIDATION_FAILED');
    expect((await err(svc.remove('acct', {}))).code).toBe('VALIDATION_FAILED');
    expect(calls.reads).toBe(0);
    expect(store.issued).toHaveLength(0);
  });

  it('answers a stale revision before signing anything', async () => {
    const { svc, store } = make({ revision: 5 });
    const e = await err(svc.requestUpload('acct', upload({ expectedRevision: 4 })));
    expect(e.code).toBe('STALE_PROFILE');
    expect(store.issued).toHaveLength(0);
  });

  it('propagates PROFILE_NOT_FOUND from the profile read before signing', async () => {
    const { svc, store } = make({
      onRead: () => {
        throw new ProfileError('PROFILE_NOT_FOUND', 'no profile', {});
      },
    });
    expect((await err(svc.requestUpload('acct', upload()))).code).toBe('PROFILE_NOT_FOUND');
    expect(store.issued).toHaveLength(0);
  });

  it('refuses a type outside the media policy allow-list and a size above the PROFILE cap (which may be lower than the media cap)', async () => {
    const { svc, store } = make({ photoCap: 50_000 });
    const type = await err(svc.requestUpload('acct', upload({ mimeType: 'image/gif' })));
    expect(type.code).toBe('MEDIA_REFUSED');
    expect(type.details).toEqual({ reason: 'MIME_NOT_ALLOWED' });
    const big = await err(svc.requestUpload('acct', upload({ sizeBytes: 50_001 })));
    expect(big.code).toBe('MEDIA_REFUSED');
    expect(big.details).toEqual({ reason: 'FILE_TOO_LARGE' });
    expect(DEFAULT_GIG_MEDIA_POLICY.maxFileSizeBytes).toBeGreaterThan(50_001); // the media cap alone would have allowed it
    expect(store.issued).toHaveLength(0);
  });

  it('the media cap still applies when it is lower than the profile cap', async () => {
    const { svc } = make({ photoCap: 20_000_000, mediaPolicy: async () => ({ ...DEFAULT_GIG_MEDIA_POLICY, maxFileSizeBytes: 1_000_000 }) });
    const e = await err(svc.requestUpload('acct', upload({ sizeBytes: 1_000_001 })));
    expect(e.details).toEqual({ reason: 'FILE_TOO_LARGE' });
  });

  it('fails closed with UNAVAILABLE when a policy is unreadable (no code default)', async () => {
    const media = make({
      mediaPolicy: async () => {
        throw new GigError('UNAVAILABLE', 'policy', { reason: 'POLICY_INVALID' });
      },
    });
    const a = await err(media.svc.requestUpload('acct', upload()));
    expect(a.code).toBe('UNAVAILABLE');
    expect(a.details).toEqual({ reason: 'POLICY_INVALID' });
    const profile = make();
    profile.policy.failure = new ProfileError('UNAVAILABLE', 'policy', { reason: 'POLICY_INVALID' });
    expect((await err(profile.svc.requestUpload('acct', upload()))).code).toBe('UNAVAILABLE');
    expect(profile.store.issued).toHaveLength(0);
  });
});

describe('ProfilePhotoService: serving', () => {
  it('a public request for anything but a uuid is null without asking the profile service or the database', async () => {
    const { svc, calls } = make();
    for (const id of ['', 'x', '../etc/passwd', ASSET + 'x', '3f9a1c7b-2d4e-4a6b-8c1d-5e7f90a1b2c3 ', 'null', '1'.repeat(500)])
      expect(await svc.publicPhoto(id)).toBeNull();
    expect(await svc.publicPhoto(undefined as unknown as string)).toBeNull();
    expect(calls.publicTargets).toBe(0);
  });

  it('answers null when the profile service gives no target (private, unknown, ineligible, no photo) without touching the database or the store', async () => {
    const { svc, calls, store } = make();
    expect(await svc.publicPhoto(ASSET, { ifNoneMatch: '*' })).toBeNull();
    expect(await svc.ownerPhoto('acct', { ifNoneMatch: '*' })).toBeNull();
    expect(calls.publicTargets).toBe(1);
    expect(calls.ownerTargets).toBe(1);
    expect(store.reads).toBe(0);
  });
});
