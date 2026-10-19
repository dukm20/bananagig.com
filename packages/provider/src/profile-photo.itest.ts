// Integration tests of the provider profile photo (PRO-002) over a real, freshly migrated PostgreSQL database (migration 0024 with its guards) and the in-memory private object store.
//
// ProfilePhotoService needs the profile-mutation primitive (ProfileMutator) of ProviderProfileService, written in parallel by another agent. Until that service is used (the last block of
// this file runs the journey through the REAL service), the tests run on `FakeProfiles`: a minimal mutator over the REAL tables with the same contract (owner-scoped, account then profile
// lock, revision check, audit row in the same transaction), so every constraint, trigger, lock and clean-up path below is the real one. Everything is asserted against the rows the
// database holds and the objects the store holds, never against a return value alone.
//
// What must never appear in an audit row, a log line, an error detail or a served payload: object keys, upload URLs (other than the one-time PUT target), hashes and asset ids.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerProfileStateDto, ProviderGigMediaPolicy, ProviderProfilePolicy } from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { MemoryObjectStore, ObjectStoreError } from '@bananagig/platform';
import { createIsolatedDatabase, createTestPool, rejection, type IsolatedDatabase } from '@bananagig/testing';
import {
  DEFAULT_GIG_MEDIA_POLICY,
  ProviderProfileService,
  type AccountFacts,
  type AccountNamePort,
  type AccountPort,
  type GigServiceNamePort,
  type MarketFacts,
  type MarketPort,
  type TrustSummaryPort,
  DEFAULT_PROFILE_POLICY,
  GigMediaService,
  ProfileError,
  StaticGigPolicyProvider,
  StaticProfilePolicyProvider,
  type DraftMutator,
  type GigMediaScanner,
  type ProfileMutationContext,
  type ProfileMutationOutcome,
  type ProfileMutator,
  type ProfilePhotoTarget,
} from './index';
import { ascii, cat, exifSegment, exifTiff, jpeg, png, PNG_SIG, SECRETS, u32be, u32le, vp8Data, webp } from './image-sanitize-fixtures';
import { ProfilePhotoService, profilePhotoEtag } from './profile-photo';
import { readImageDimensions } from './gig-media';

// every log call of the code under test is captured here (and nothing is printed)
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

type Pool = ReturnType<typeof createTestPool>;
type Row = Record<string, unknown>;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- environment
let iso: IsolatedDatabase;
let pool: Pool;
const mediaPolicy = new StaticGigPolicyProvider({ maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 });
const profilePolicy = new StaticProfilePolicyProvider();
const setMedia = (over: Partial<ProviderGigMediaPolicy>): void => {
  mediaPolicy.mediaValue = { ...DEFAULT_GIG_MEDIA_POLICY, ...over };
};
const setProfile = (over: Partial<ProviderProfilePolicy>): void => {
  profilePolicy.value = { ...DEFAULT_PROFILE_POLICY, ...over };
};

/** A store whose behaviour a test can bend and whose reads are counted. */
class TestStore extends MemoryObjectStore {
  reads = 0;
  failRead = false;
  failDelete = false;
  failSign: Error | undefined;
  readonly deleted: string[] = [];
  override async read(key: string, max: number) {
    this.reads++;
    if (this.failRead) throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    return super.read(key, max);
  }
  override async readVersioned(key: string, max: number) {
    this.reads++;
    return super.readVersioned(key, max);
  }
  override async createUploadUrl(r: Parameters<MemoryObjectStore['createUploadUrl']>[0]) {
    if (this.failSign) throw this.failSign;
    return super.createUploadUrl(r);
  }
  override async delete(key: string) {
    if (this.failDelete) throw new ObjectStoreError('UNAVAILABLE', 'the object store is unavailable');
    this.deleted.push(key);
    return super.delete(key);
  }
}
const store = new TestStore();
const scanner: GigMediaScanner & { next: 'CLEAN' | 'INFECTED' | 'ERROR'; scans: number } = {
  next: 'CLEAN',
  scans: 0,
  async scan() {
    scanner.scans++;
    return { status: scanner.next };
  },
};

const noDrafts: DraftMutator = {
  async readDraft() {
    throw new Error('drafts are not available');
  },
  async mutateDraft() {
    throw new Error('drafts are not available');
  },
};

const stateOf = (accountId: string, row: Row, asset: Row | undefined): OwnerProfileStateDto =>
  ({
    exists: true,
    profile: {
      publicProfileId: row.public_profile_id as string,
      displayName: (row.display_name as string | null) ?? null,
      publicName: null,
      bio: (row.bio as string | null) ?? null,
      photo: asset ? { mimeType: asset.mime_type as string, width: Number(asset.width), height: Number(asset.height) } : null,
      photoPending: row.pending_photo_asset_id !== null,
      visibility: row.visibility_status as 'PRIVATE' | 'PUBLIC',
      publishedAt: null,
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
    readiness: {} as never,
    limits: {} as never,
  }) as unknown as OwnerProfileStateDto;

/** A minimal ProfileMutator over the real tables (see the header): account lock, profile lock, revision check, `run`, the revision rule, one audit row. */
class FakeProfiles implements ProfileMutator {
  constructor(private readonly database: Database) {}
  async readProfile(accountId: string) {
    const r = (
      await sql<Row>`SELECT public_profile_id, revision, photo_asset_id, pending_photo_asset_id FROM provider.public_profiles WHERE account_id = ${accountId}::uuid`.execute(
        this.database.db,
      )
    ).rows[0];
    if (!r) throw new ProfileError('PROFILE_NOT_FOUND', 'the profile was not found', {});
    return {
      publicProfileId: r.public_profile_id as string,
      revision: Number(r.revision),
      photoAssetId: (r.photo_asset_id as string | null) ?? null,
      pendingPhotoAssetId: (r.pending_photo_asset_id as string | null) ?? null,
    };
  }
  async mutateProfile<T>(accountId: string, expectedRevision: number, run: (ctx: ProfileMutationContext) => Promise<ProfileMutationOutcome<T>>) {
    const known = await this.readProfile(accountId);
    if (known.revision !== expectedRevision) throw new ProfileError('STALE_PROFILE', 'stale', {});
    const value = await this.database.transaction(async (trx) => {
      await sql`SELECT account_id FROM identity.accounts WHERE account_id = ${accountId}::uuid FOR UPDATE`.execute(trx);
      const row = (
        await sql<Row>`SELECT public_profile_id, revision, photo_asset_id, pending_photo_asset_id FROM provider.public_profiles WHERE account_id = ${accountId}::uuid FOR UPDATE`.execute(
          trx,
        )
      ).rows[0]!;
      if (Number(row.revision) !== expectedRevision) throw new ProfileError('STALE_PROFILE', 'stale', {});
      const cid = randomUUID();
      const out = await run({
        trx,
        accountId,
        cid,
        publicProfileId: row.public_profile_id as string,
        revision: Number(row.revision),
        photoAssetId: (row.photo_asset_id as string | null) ?? null,
        pendingPhotoAssetId: (row.pending_photo_asset_id as string | null) ?? null,
      });
      if (out.changed) {
        const now = (
          await sql<Row>`SELECT revision FROM provider.public_profiles WHERE public_profile_id = ${row.public_profile_id as string}::uuid`.execute(trx)
        ).rows[0]!;
        if (Number(now.revision) !== expectedRevision + 1) throw new Error('a mutation must raise the revision by exactly one');
        await sql`INSERT INTO provider.profile_audit_events (actor, account_id, public_profile_id, action, changes, correlation_id)
          VALUES (${`account:${accountId}`}, ${accountId}::uuid, ${row.public_profile_id as string}::uuid, ${out.action},
                  ${JSON.stringify({ changedFields: out.changedFields, revision: [expectedRevision, expectedRevision + 1] })}::jsonb, ${cid})`.execute(trx);
      }
      return out.value;
    });
    const row = (await sql<Row>`SELECT * FROM provider.public_profiles WHERE account_id = ${accountId}::uuid`.execute(this.database.db)).rows[0]!;
    const asset = row.photo_asset_id
      ? (
          await sql<Row>`SELECT mime_type, width, height FROM provider.media_assets WHERE media_asset_id = ${row.photo_asset_id as string}::uuid`.execute(
            this.database.db,
          )
        ).rows[0]
      : undefined;
    return { value, state: stateOf(accountId, row, asset) };
  }
  /** The photo targets the real service derives after its visibility rules (here: PUBLIC = shown, otherwise null). */
  async getPublicPhotoTarget(publicProfileId: string): Promise<ProfilePhotoTarget | null> {
    const r = (
      await sql<Row>`SELECT photo_asset_id FROM provider.public_profiles WHERE public_profile_id = ${publicProfileId}::uuid AND visibility_status = 'PUBLIC'`.execute(
        this.database.db,
      )
    ).rows[0];
    return r?.photo_asset_id ? { assetId: r.photo_asset_id as string } : null;
  }
  async getOwnerPhotoTarget(accountId: string): Promise<ProfilePhotoTarget | null> {
    const r = (await sql<Row>`SELECT photo_asset_id FROM provider.public_profiles WHERE account_id = ${accountId}::uuid`.execute(this.database.db)).rows[0];
    return r?.photo_asset_id ? { assetId: r.photo_asset_id as string } : null;
  }
}

let fake: FakeProfiles;
let photos: ProfilePhotoService;
/** The Gig media service over the SAME database, used only for its clean-up pass (the worker job runs exactly this). */
let sweeper: GigMediaService;
const sweep = () => sweeper.cleanup({ limit: 200 });

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { overrides: { poolMax: 40, connectionTimeoutMs: 30_000 } } });
  pool = createTestPool(iso.url, 10);
  fake = new FakeProfiles(iso.database);
  photos = new ProfilePhotoService({
    database: iso.database,
    store,
    scanner,
    media: mediaPolicy,
    policy: profilePolicy,
    profiles: fake,
    getPublicPhotoTarget: (id) => fake.getPublicPhotoTarget(id),
    getOwnerPhotoTarget: (id) => fake.getOwnerPhotoTarget(id),
  });
  sweeper = new GigMediaService({ database: iso.database, store, scanner, policy: mediaPolicy, drafts: noDrafts });
});
beforeEach(() => {
  mediaPolicy.failure = undefined;
  mediaPolicy.mediaValue = { ...DEFAULT_GIG_MEDIA_POLICY };
  profilePolicy.failure = undefined;
  profilePolicy.value = { ...DEFAULT_PROFILE_POLICY };
  store.reads = 0;
  store.failRead = false;
  store.failDelete = false;
  store.failSign = undefined;
  store.deleted.length = 0;
  store.issued.length = 0;
  scanner.next = 'CLEAN';
  scanner.scans = 0;
  logSink.lines.length = 0;
});
afterEach(() => undefined);
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Row>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const one = async <T = Row>(text: string, params: unknown[] = []): Promise<T> => (await q<T>(text, params))[0]!;

/** The authorization window is immutable (a guard): a test that needs an authorization in the past switches the guard off for that one statement. */
async function expireAsset(assetId: string): Promise<void> {
  await q('ALTER TABLE provider.media_assets DISABLE TRIGGER USER');
  try {
    await q(`UPDATE provider.media_assets SET upload_expires_at = created_at + interval '1 millisecond' WHERE media_asset_id = $1`, [assetId]);
  } finally {
    await q('ALTER TABLE provider.media_assets ENABLE TRIGGER USER');
  }
}
/** Moves the moment an asset became READY into the past (immutable: guards off for that one statement) so the orphan grace period can be tested without waiting. */
async function ageAsset(assetId: string, seconds: number): Promise<void> {
  await q('ALTER TABLE provider.media_assets DISABLE TRIGGER USER');
  try {
    await q(`UPDATE provider.media_assets SET ready_at = ready_at - make_interval(secs => $2) WHERE media_asset_id = $1`, [assetId, seconds]);
  } finally {
    await q('ALTER TABLE provider.media_assets ENABLE TRIGGER USER');
  }
}

// ---------------------------------------------------------------- builders
let seq = 0;
async function mkAccount(): Promise<string> {
  const n = ++seq;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query("INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id")).rows[0].account_id as string;
    await c.query(
      "INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'ACTIVE', 'test', 'test')",
      [id],
    );
    await c.query(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
       SELECT $1, role_id, 'ACTIVE', now(), 'system:test', 'BOOTSTRAP' FROM identity.roles WHERE code IN ('CUSTOMER', 'PROVIDER')`,
      [id],
    );
    await c.query(`UPDATE identity.accounts SET primary_role_id = (SELECT role_id FROM identity.roles WHERE code = 'CUSTOMER') WHERE account_id = $1`, [id]);
    await c.query("INSERT INTO identity.account_profiles (account_id, first_name, last_name) VALUES ($1, 'Ada', 'Tester')", [id]);
    await c.query(
      `INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at) VALUES ($1, $2, 'VERIFIED', true, 'IDP_VERIFIED', now())`,
      [id, `profile.photo.itest.${n}@example.test`],
    );
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
async function register(accountId: string): Promise<void> {
  const regId = (
    await one<{ provider_registration_id: string }>(
      'INSERT INTO provider.registrations (account_id, attempt_number) VALUES ($1, 1) RETURNING provider_registration_id',
      [accountId],
    )
  ).provider_registration_id;
  await q(`UPDATE provider.registrations SET market_id = (SELECT market_id FROM geography.markets ORDER BY code LIMIT 1) WHERE provider_registration_id = $1`, [
    regId,
  ]);
  await q(
    `INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id) SELECT $1, service_type_id FROM catalog.service_types WHERE status = 'ACTIVE' ORDER BY code LIMIT 1`,
    [regId],
  );
  await q("UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = $1", [regId]);
}
interface Prov {
  accountId: string;
  publicProfileId: string;
}
async function mkProvider(visibility: 'PRIVATE' | 'PUBLIC' = 'PRIVATE'): Promise<Prov> {
  const accountId = await mkAccount();
  await register(accountId);
  const publicProfileId = (
    await one<{ public_profile_id: string }>('INSERT INTO provider.public_profiles (account_id) VALUES ($1) RETURNING public_profile_id', [accountId])
  ).public_profile_id;
  if (visibility === 'PUBLIC')
    await q(`UPDATE provider.public_profiles SET visibility_status = 'PUBLIC', revision = revision + 1 WHERE account_id = $1`, [accountId]);
  return { accountId, publicProfileId };
}
const profileRow = (p: Prov) => one<Row>('SELECT * FROM provider.public_profiles WHERE account_id = $1', [p.accountId]);
const assetRow = (id: string) => one<Row>('SELECT * FROM provider.media_assets WHERE media_asset_id = $1', [id]);
const revisionOf = async (p: Prov): Promise<number> => Number((await profileRow(p)).revision);
const audits = (p: Prov) =>
  q<Row>('SELECT actor, action, changes, correlation_id FROM provider.profile_audit_events WHERE public_profile_id = $1 ORDER BY occurred_at, audit_event_id', [
    p.publicProfileId,
  ]);

const JPEG_ORIGINAL = (): Buffer => jpeg({ exif: exifSegment(exifTiff({ little: true, orientation: 6, gps: true })) }).file;
const goodJpeg = (): Buffer => jpeg({ exif: exifSegment(exifTiff({ little: false, orientation: 6, gps: true })), trailing: Buffer.alloc(0) }).file;

/** Authorizes an upload, plays the browser (PUT to the upload key) and returns the pending asset. */
async function authorize(p: Prov, bytes: Buffer, over: { mime?: string; size?: number; put?: boolean; contentType?: string } = {}) {
  const mime = over.mime ?? 'image/jpeg';
  const r = await photos.requestUpload(p.accountId, { expectedRevision: await revisionOf(p), mimeType: mime, sizeBytes: over.size ?? bytes.length });
  const row = await profileRow(p);
  const assetId = row.pending_photo_asset_id as string;
  const asset = await assetRow(assetId);
  const finalKey = asset.object_key as string;
  if (over.put !== false) store.put(`${finalKey}.upload`, bytes, over.contentType ?? mime);
  return { r, assetId, finalKey, uploadKey: `${finalKey}.upload`, revision: r.revision };
}
async function finalizeOk(p: Prov, bytes: Buffer = goodJpeg(), mime = 'image/jpeg') {
  const a = await authorize(p, bytes, { mime });
  const state = await photos.finalize(p.accountId, { expectedRevision: a.revision });
  return { ...a, state };
}
const code = async (p: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> => {
  const e = await rejection(p);
  if (!(e instanceof ProfileError)) throw e instanceof Error ? e : new Error(String(e));
  return { code: e.code, details: e.details };
};

// ====================================================================== 1. authorize
describe('requestUpload', () => {
  it('authorizes one upload: a PROFILE_PHOTO asset owned by the account on a final key, the profile pending pointer, a presigned PUT to a SEPARATE upload key, revision +1, an audit row of field names only', async () => {
    const p = await mkProvider();
    const before = await revisionOf(p);
    const r = await photos.requestUpload(p.accountId, { expectedRevision: before, mimeType: 'image/jpeg', sizeBytes: 123_456 });
    expect(r.revision).toBe(before + 1);
    expect(r.maxSizeBytes).toBe(Math.min(DEFAULT_PROFILE_POLICY.photoMaxFileSizeBytes, DEFAULT_GIG_MEDIA_POLICY.maxFileSizeBytes));
    const row = await profileRow(p);
    expect(Number(row.revision)).toBe(before + 1);
    const asset = await assetRow(row.pending_photo_asset_id as string);
    expect(asset).toMatchObject({
      account_id: p.accountId,
      purpose: 'PROFILE_PHOTO',
      status: 'UPLOAD_PENDING',
      mime_type: 'image/jpeg',
      sha256: null,
      ready_at: null,
    });
    expect(Number(asset.size_bytes)).toBe(123_456);
    expect(row.photo_asset_id).toBeNull();
    // the PUT goes to the separate upload key, never to the final key
    expect(store.issued).toHaveLength(1);
    expect(store.issued[0]).toMatchObject({
      kind: 'upload',
      key: `${asset.object_key as string}.upload`,
      ttlSeconds: DEFAULT_GIG_MEDIA_POLICY.uploadTtlSeconds,
    });
    expect(r.upload.url).toContain('upload');
    expect(r.upload.headers['content-type']).toBe('image/jpeg');
    // the authorization window is written with the DATABASE clock
    const w = await one<{ ttl: number; drift: number }>(
      `SELECT extract(epoch FROM upload_expires_at - created_at)::float AS ttl, abs(extract(epoch FROM upload_expires_at - now()))::float AS drift FROM provider.media_assets WHERE media_asset_id = $1`,
      [asset.media_asset_id],
    );
    expect(w.ttl).toBeCloseTo(DEFAULT_GIG_MEDIA_POLICY.uploadTtlSeconds, 0);
    expect(w.drift).toBeLessThan(DEFAULT_GIG_MEDIA_POLICY.uploadTtlSeconds + 5);
    // the audit row: field names and revisions, no ids, keys or hashes
    const rows = await audits(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: `account:${p.accountId}`, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' });
    expect(rows[0]!.changes).toEqual({ changedFields: ['photo'], revision: [before, before + 1] });
    expect(JSON.stringify(rows)).not.toContain(asset.object_key as string);
    expect(JSON.stringify(rows)).not.toContain(asset.media_asset_id as string);
  });

  it('refuses a stale revision, a missing profile, an invalid body, a type outside the allow-list and a size above the PROFILE cap, creating nothing', async () => {
    const p = await mkProvider();
    const rev = await revisionOf(p);
    expect((await code(photos.requestUpload(p.accountId, { expectedRevision: rev + 5, mimeType: 'image/jpeg', sizeBytes: 1000 }))).code).toBe('STALE_PROFILE');
    expect((await code(photos.requestUpload(await mkAccount(), { expectedRevision: 1, mimeType: 'image/jpeg', sizeBytes: 1000 }))).code).toBe(
      'PROFILE_NOT_FOUND',
    );
    expect((await code(photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 1000, purpose: 'GIG_PHOTO' }))).code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await code(photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/gif', sizeBytes: 1000 }))).details).toEqual({
      reason: 'MIME_NOT_ALLOWED',
    });
    setProfile({ photoMaxFileSizeBytes: 50_000 });
    expect((await code(photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 50_001 }))).details).toEqual({
      reason: 'FILE_TOO_LARGE',
    });
    const ok = await photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 50_000 });
    expect(ok.maxSizeBytes).toBe(50_000);
    expect(store.issued).toHaveLength(1); // only the valid request signed anything
    expect(Number((await one('SELECT count(*) AS n FROM provider.media_assets WHERE account_id = $1', [p.accountId])).n)).toBe(1);
  });

  it('fails closed when a policy is unreadable and when the store cannot sign, leaving no asset behind', async () => {
    const p = await mkProvider();
    const rev = await revisionOf(p);
    profilePolicy.failure = new ProfileError('UNAVAILABLE', 'policy', { reason: 'POLICY_INVALID' });
    expect((await code(photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 1000 }))).code).toBe('UNAVAILABLE');
    profilePolicy.failure = undefined;
    store.failSign = new Error('signer down');
    const e = await code(photos.requestUpload(p.accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 1000 }));
    expect(e).toEqual({ code: 'UNAVAILABLE', details: { reason: 'MEDIA_STORE_UNAVAILABLE' } });
    expect(Number((await one('SELECT count(*) AS n FROM provider.media_assets WHERE account_id = $1', [p.accountId])).n)).toBe(0);
    expect(await revisionOf(p)).toBe(rev);
  });

  it('a new authorization abandons the previous pending asset in the same transaction and deletes its objects after the commit', async () => {
    const p = await mkProvider();
    const first = await authorize(p, goodJpeg());
    expect(store.objects.has(first.uploadKey)).toBe(true);
    const second = await authorize(p, goodJpeg());
    expect((await assetRow(first.assetId)).status).toBe('ABANDONED');
    const row = await profileRow(p);
    expect(row.pending_photo_asset_id).toBe(second.assetId);
    expect(store.objects.has(first.uploadKey)).toBe(false);
    expect(store.deleted).toEqual(expect.arrayContaining([first.finalKey, first.uploadKey]));
    expect((await assetRow(second.assetId)).status).toBe('UPLOAD_PENDING');
    // the abandoned asset can no longer be finalized by anyone: the pointer names the new one
    expect(Number(row.revision)).toBe(second.revision);
  });

  it('serializes two concurrent authorizations at the same revision: exactly one wins, the other is STALE_PROFILE, and only one asset is pending', async () => {
    const p = await mkProvider();
    const rev = await revisionOf(p);
    const body = { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 1000 };
    const results = await Promise.allSettled([photos.requestUpload(p.accountId, body), photos.requestUpload(p.accountId, body)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ProfileError).code).toBe('STALE_PROFILE');
    expect(Number((await one(`SELECT count(*) AS n FROM provider.media_assets WHERE account_id = $1 AND status = 'UPLOAD_PENDING'`, [p.accountId])).n)).toBe(1);
  });
});

// ====================================================================== 2. finalize
describe('finalize', () => {
  it('verifies, scans and promotes the upload: the asset is READY with its facts, the profile shows it, the replaced pointer is cleared, the upload object is deleted and the final object keeps the ORIGINAL bytes', async () => {
    const p = await mkProvider();
    const bytes = JPEG_ORIGINAL();
    const a = await authorize(p, bytes);
    const state = await photos.finalize(p.accountId, { expectedRevision: a.revision });
    const asset = await assetRow(a.assetId);
    expect(asset).toMatchObject({ status: 'READY', scan_status: 'CLEAN', width: 640, height: 480, purpose: 'PROFILE_PHOTO' });
    expect(asset.sha256).toBe(sha(bytes));
    const row = await profileRow(p);
    expect(row.photo_asset_id).toBe(a.assetId);
    expect(row.pending_photo_asset_id).toBeNull();
    expect(Number(row.revision)).toBe(a.revision + 1);
    expect(state.profile).toMatchObject({ photo: { mimeType: 'image/jpeg', width: 640, height: 480 }, photoPending: false });
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect(store.objects.get(a.finalKey)!.bytes.equals(bytes)).toBe(true); // the stored original is untouched (and keeps its EXIF: that is why it is never served)
    expect(scanner.scans).toBe(1);
    const rows = await audits(p);
    expect(rows.map((r) => r.action)).toEqual(['PROVIDER_PROFILE_PHOTO_CHANGED', 'PROVIDER_PROFILE_PHOTO_CHANGED']);
    expect(rows[1]!.changes).toEqual({ changedFields: ['photo'], revision: [a.revision, a.revision + 1] });
  });

  it('is idempotent: a repeated finalize answers with the current state and changes nothing', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    await photos.finalize(p.accountId, { expectedRevision: a.revision });
    const rev = await revisionOf(p);
    const again = await photos.finalize(p.accountId, { expectedRevision: a.revision });
    expect(again.profile?.revision).toBe(rev);
    expect(await revisionOf(p)).toBe(rev);
    expect(scanner.scans).toBe(1);
    expect(await audits(p)).toHaveLength(2);
  });

  it('answers MEDIA_NOT_FOUND when nothing is pending and there is no photo; a stale revision when the profile moved', async () => {
    const p = await mkProvider();
    expect((await code(photos.finalize(p.accountId, { expectedRevision: 1 }))).code).toBe('MEDIA_NOT_FOUND');
    const a = await authorize(p, goodJpeg());
    expect((await code(photos.finalize(p.accountId, { expectedRevision: a.revision - 1 }))).code).toBe('STALE_PROFILE');
    expect((await assetRow(a.assetId)).status).toBe('UPLOAD_PENDING'); // a stale call closes nothing
    expect((await code(photos.finalize(await mkAccount(), { expectedRevision: 1 }))).code).toBe('PROFILE_NOT_FOUND');
  });

  it('does not abandon when the object is not there yet (the browser may still be uploading)', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg(), { put: false });
    const e = await code(photos.finalize(p.accountId, { expectedRevision: a.revision }));
    expect(e).toEqual({ code: 'MEDIA_REFUSED', details: { reason: 'OBJECT_MISSING' } });
    expect((await assetRow(a.assetId)).status).toBe('UPLOAD_PENDING');
    expect((await profileRow(p)).pending_photo_asset_id).toBe(a.assetId);
    store.put(a.uploadKey, goodJpeg(), 'image/jpeg'); // the upload arrives: finalizing now succeeds
    await photos.finalize(p.accountId, { expectedRevision: a.revision });
    expect((await assetRow(a.assetId)).status).toBe('READY');
  });

  describe.each([
    ['a size that differs from the authorization', 'SIZE_MISMATCH', (b: Buffer) => ({ bytes: Buffer.concat([b, Buffer.from([1, 2, 3])]), mime: 'image/jpeg' })],
    ['a content type that differs', 'CONTENT_TYPE_MISMATCH', (b: Buffer) => ({ bytes: b, mime: 'image/jpeg', contentType: 'image/png' })],
    ['bytes that are not the declared type', 'SIGNATURE_MISMATCH', (b: Buffer) => ({ bytes: Buffer.from(b).fill(0, 0, 3), mime: 'image/jpeg' })],
    ['an image below the minimum edge', 'IMAGE_TOO_SMALL', () => ({ bytes: jpeg({ w: 100, h: 100, trailing: Buffer.alloc(0) }).file, mime: 'image/jpeg' })],
    [
      'an image above the pixel limits (a decompression bomb header)',
      'IMAGE_TOO_LARGE',
      () => ({ bytes: jpeg({ w: 30000, h: 30000, trailing: Buffer.alloc(0) }).file, mime: 'image/jpeg' }),
    ],
    ['a header that is not an image', 'IMAGE_INVALID', () => ({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0]), mime: 'image/jpeg' })],
  ])('refuses %s', (_name, reason, make) => {
    it(`${reason}: the pending pointer is cleared, the asset is ABANDONED and its objects are deleted`, async () => {
      const p = await mkProvider();
      const base = goodJpeg();
      const m = make(base) as { bytes: Buffer; mime: string; contentType?: string };
      const authorizedSize = reason === 'SIZE_MISMATCH' ? base.length : m.bytes.length;
      const a = await authorize(p, m.bytes, { mime: m.mime, size: authorizedSize, ...(m.contentType ? { contentType: m.contentType } : {}) });
      const e = await code(photos.finalize(p.accountId, { expectedRevision: a.revision }));
      expect(e).toEqual({ code: 'MEDIA_REFUSED', details: { reason } });
      expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
      expect((await profileRow(p)).pending_photo_asset_id).toBeNull();
      expect((await profileRow(p)).photo_asset_id).toBeNull();
      expect(store.objects.has(a.uploadKey)).toBe(false);
      expect(store.objects.has(a.finalKey)).toBe(false);
    });
  });

  it('refuses a hash the client announced that does not match (HASH_MISMATCH) and accepts the right one', async () => {
    const p = await mkProvider();
    const bytes = goodJpeg();
    const a = await authorize(p, bytes);
    expect((await code(photos.finalize(p.accountId, { expectedRevision: a.revision, sha256: 'f'.repeat(64) }))).details).toEqual({ reason: 'HASH_MISMATCH' });
    const b = await authorize(p, bytes);
    await photos.finalize(p.accountId, { expectedRevision: b.revision, sha256: sha(bytes) });
    expect((await assetRow(b.assetId)).status).toBe('READY');
  });

  it('refuses an infected file for good (scan verdict recorded, ABANDONED, objects deleted) and fails closed when the scanner cannot decide', async () => {
    const p = await mkProvider();
    scanner.next = 'INFECTED';
    const a = await authorize(p, goodJpeg());
    expect((await code(photos.finalize(p.accountId, { expectedRevision: a.revision }))).details).toEqual({ reason: 'SCAN_INFECTED' });
    expect(await assetRow(a.assetId)).toMatchObject({ status: 'ABANDONED', scan_status: 'INFECTED' });
    expect(store.objects.has(a.uploadKey)).toBe(false);

    scanner.next = 'ERROR';
    const b = await authorize(p, goodJpeg());
    const e = await code(photos.finalize(p.accountId, { expectedRevision: b.revision }));
    expect(e).toEqual({ code: 'MEDIA_SCAN_UNAVAILABLE', details: { reason: 'SCAN_UNAVAILABLE', retryable: true } });
    expect((await assetRow(b.assetId)).status).toBe('UPLOAD_PENDING'); // nothing is closed: the scanner may come back

    setMedia({ requireCleanScan: false }); // the policy that allows an unscanned file is the only way an ERROR verdict is accepted
    await photos.finalize(p.accountId, { expectedRevision: b.revision });
    expect(await assetRow(b.assetId)).toMatchObject({ status: 'READY', scan_status: 'ERROR' });
  });

  it('refuses an upload that took too long (MEDIA_EXPIRED) and closes it', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    await expireAsset(a.assetId);
    expect((await code(photos.finalize(p.accountId, { expectedRevision: a.revision }))).code).toBe('MEDIA_EXPIRED');
    expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
    expect((await profileRow(p)).pending_photo_asset_id).toBeNull();
  });

  it('refuses an object that changes between the read and the promotion (a replayed PUT) and a final copy that is corrupted', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    const original = store.copyIfVersion.bind(store);
    store.copyIfVersion = async (from: string, to: string, version: string) => {
      store.put(from, jpeg({ w: 700, h: 700, trailing: Buffer.alloc(0) }).file, 'image/jpeg'); // the browser replays its PUT
      return original(from, to, version);
    };
    try {
      expect((await code(photos.finalize(p.accountId, { expectedRevision: a.revision }))).details).toEqual({ reason: 'OBJECT_CHANGED' });
    } finally {
      store.copyIfVersion = original;
    }
    expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
  });

  it('two concurrent finalizations of the same upload leave one READY photo and one revision step', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    const results = await Promise.allSettled([
      photos.finalize(p.accountId, { expectedRevision: a.revision }),
      photos.finalize(p.accountId, { expectedRevision: a.revision }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await assetRow(a.assetId)).toMatchObject({ status: 'READY' });
    expect((await profileRow(p)).photo_asset_id).toBe(a.assetId);
    expect(await revisionOf(p)).toBe(a.revision + 1);
    expect(store.objects.get(a.finalKey)).toBeDefined();
  });

  it('a store outage while reading is UNAVAILABLE and closes nothing', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    const head = store.head.bind(store);
    store.head = async () => {
      throw new Error('store down');
    };
    try {
      expect(await code(photos.finalize(p.accountId, { expectedRevision: a.revision }))).toEqual({
        code: 'UNAVAILABLE',
        details: { reason: 'MEDIA_STORE_UNAVAILABLE' },
      });
    } finally {
      store.head = head;
    }
    expect((await assetRow(a.assetId)).status).toBe('UPLOAD_PENDING');
  });
});

// ====================================================================== 2b. finalize sanitises (header-valid but unsanitisable files are refused)
describe('finalize refuses a photo the sanitiser cannot process', () => {
  // each case: [name, bytes that pass the header check but are not a well-formed container, the same file repaired]
  const validJpeg = (): Buffer => jpeg({ trailing: Buffer.alloc(0) }).file;
  const pngWith = (extra: Buffer): Buffer => {
    const p = png({ w: 400, h: 300, trailing: Buffer.alloc(0) });
    return cat(PNG_SIG, p.kept[0]!, extra, ...p.kept.slice(1));
  };
  // a lossy WebP whose only chunk has an odd size and no pad byte: the header check reads it, the container is invalid
  const webpBody = (pad: boolean): Buffer => {
    const data = vp8Data(640, 480);
    const body = cat(ascii('WEBP'), ascii('VP8 '), u32le(data.length), data, pad ? [0] : []);
    return cat(ascii('RIFF'), u32le(body.length), body);
  };
  const jpegPadded = (padding: Buffer): Buffer => {
    const v = validJpeg();
    const at = v.indexOf(Buffer.from([0xff, 0xc4])); // between the frame header (all the header check reads) and the Huffman table
    return cat(v.subarray(0, at), padding, v.subarray(at));
  };
  const cases: [string, string, Buffer, Buffer][] = [
    ['padding bytes between JPEG segments', 'image/jpeg', jpegPadded(ascii('SECRET-TAIL')), jpegPadded(Buffer.alloc(0))],
    ['a JPEG that is cut before its scan ends', 'image/jpeg', validJpeg().subarray(0, validJpeg().indexOf(Buffer.from([0xff, 0xda])) + 14), validJpeg()],
    ['a bad PNG chunk (a type that is not letters)', 'image/png', pngWith(cat(u32be(0), Buffer.from([1, 2, 3, 4]), u32be(0))), pngWith(Buffer.alloc(0))],
    ['a WebP odd chunk without its pad byte', 'image/webp', webpBody(false), webpBody(true)],
  ];
  it.each(cases)(
    '%s: the header check accepts it, the sanitiser refuses it (IMAGE_INVALID, asset abandoned, pointer cleared, objects deleted); the repaired file is accepted',
    async (_n, mime, bad, repaired) => {
      expect(readImageDimensions(mime, bad), 'the header check must pass for this case to mean anything').not.toBeNull();
      const p = await mkProvider('PUBLIC');
      const a = await authorize(p, bad, { mime });
      const e = await code(photos.finalize(p.accountId, { expectedRevision: a.revision }));
      expect(e).toEqual({ code: 'MEDIA_REFUSED', details: { reason: 'IMAGE_INVALID' } });
      expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
      const row = await profileRow(p);
      expect(row.pending_photo_asset_id).toBeNull();
      expect(row.photo_asset_id).toBeNull();
      expect(store.objects.has(a.uploadKey)).toBe(false);
      expect(store.objects.has(a.finalKey)).toBe(false);
      expect(await photos.publicPhoto(p.publicProfileId)).toBeNull();

      const b = await authorize(p, repaired, { mime });
      await photos.finalize(p.accountId, { expectedRevision: b.revision });
      expect((await assetRow(b.assetId)).status).toBe('READY');
      expect((await photos.publicPhoto(p.publicProfileId))?.kind).toBe('bytes'); // and it can really be served
    },
  );
  it('the sanitiser runs once, on the bytes that were read, before anything is promoted (a refused file never reaches the final key)', async () => {
    const p = await mkProvider();
    const bad = webpBody(false);
    const a = await authorize(p, bad, { mime: 'image/webp' });
    await code(photos.finalize(p.accountId, { expectedRevision: a.revision }));
    expect(store.objects.has(a.finalKey)).toBe(false);
  });
});

// ====================================================================== 3. ownership and purpose separation
describe('ownership and purpose', () => {
  it('another account cannot finalize, remove or read the photo of this profile, and the database refuses to point its profile at this asset', async () => {
    const a = await mkProvider();
    const b = await mkProvider();
    const done = await finalizeOk(a);
    expect((await code(photos.finalize(b.accountId, { expectedRevision: 1 }))).code).toBe('MEDIA_NOT_FOUND');
    expect(await photos.ownerPhoto(b.accountId)).toBeNull();
    // the database: a READY asset of account A can never be the photo of B's profile
    const e = await rejection(
      q('UPDATE provider.public_profiles SET photo_asset_id = $1, revision = revision + 1 WHERE account_id = $2', [done.assetId, b.accountId]),
    );
    expect(String((e as { detail?: string }).detail)).toContain('ASSET_OWNER');
    // B's pending pointer cannot name A's asset either
    const pend = await authorize(a, goodJpeg());
    const e2 = await rejection(q('UPDATE provider.public_profiles SET pending_photo_asset_id = $1 WHERE account_id = $2', [pend.assetId, b.accountId]));
    expect(String((e2 as { detail?: string }).detail)).toContain('ASSET_OWNER');
    expect((await profileRow(a)).photo_asset_id).toBe(done.assetId);
  });

  it('a Gig photo asset is not a profile photo: the database refuses the pointer and the service never serves it', async () => {
    const p = await mkProvider();
    const gigAsset = randomUUID();
    await q(
      `INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at) VALUES ($1, $2, $3, 'image/jpeg', 100, now() + interval '1 hour')`,
      [gigAsset, p.accountId, `provider/gig-media/${gigAsset}`],
    );
    expect((await assetRow(gigAsset)).purpose).toBe('GIG_PHOTO');
    const e = await rejection(q('UPDATE provider.public_profiles SET pending_photo_asset_id = $1 WHERE account_id = $2', [gigAsset, p.accountId]));
    expect(String((e as { detail?: string }).detail)).toContain('ASSET_PURPOSE');
    // a target that (wrongly) names a Gig asset is not servable: the service asks the asset for its purpose
    const forged = new ProfilePhotoService({
      database: iso.database,
      store,
      scanner,
      media: mediaPolicy,
      policy: profilePolicy,
      profiles: fake,
      getPublicPhotoTarget: async () => ({ assetId: gigAsset }),
      getOwnerPhotoTarget: async () => ({ assetId: gigAsset }),
    });
    expect(await forged.publicPhoto(p.publicProfileId)).toBeNull();
    expect((await code(forged.ownerPhoto(p.accountId))).code).toBe('MEDIA_NOT_FOUND');
  });
});

// ====================================================================== 4. replace and remove
describe('replace and remove', () => {
  it('replacing the photo detaches the old READY asset (still READY, bytes kept) and the reference-aware sweep deletes it once it is unreferenced AND READY for longer than the grace period (counted from ready_at, not from the detach)', async () => {
    const p = await mkProvider();
    const first = await finalizeOk(p);
    const second = await finalizeOk(p, jpeg({ w: 700, h: 500, trailing: Buffer.alloc(0) }).file);
    const row = await profileRow(p);
    expect(row.photo_asset_id).toBe(second.assetId);
    expect((await assetRow(first.assetId)).status).toBe('READY'); // detached, not deleted
    expect(store.objects.has(first.finalKey)).toBe(true);

    // inside the grace period nothing is deleted, whatever is referenced
    const early = await sweep();
    expect(early.deleted).toBe(0);
    expect((await assetRow(first.assetId)).status).toBe('READY');

    // after the grace period the detached asset goes; the referenced one never does
    setMedia({ orphanGraceSeconds: 60 });
    await ageAsset(first.assetId, 3600);
    await ageAsset(second.assetId, 3600);
    const late = await sweep();
    expect(late.deleted).toBe(1);
    expect((await assetRow(first.assetId)).status).toBe('DELETED');
    expect(store.objects.has(first.finalKey)).toBe(false);
    expect((await assetRow(second.assetId)).status).toBe('READY');
    expect(store.objects.has(second.finalKey)).toBe(true);
    expect((await profileRow(p)).photo_asset_id).toBe(second.assetId);
  });

  it('remove clears the photo pointer (revision +1, audited), keeps the asset until the sweep, and is idempotent when there is nothing to remove', async () => {
    const p = await mkProvider();
    const done = await finalizeOk(p);
    const rev = await revisionOf(p);
    const state = await photos.remove(p.accountId, { expectedRevision: rev });
    expect(state.profile).toMatchObject({ photo: null, photoPending: false });
    const row = await profileRow(p);
    expect(row.photo_asset_id).toBeNull();
    expect(Number(row.revision)).toBe(rev + 1);
    expect((await assetRow(done.assetId)).status).toBe('READY');
    expect(await photos.ownerPhoto(p.accountId)).toBeNull(); // nothing is served from the moment the pointer is gone
    const again = await photos.remove(p.accountId, { expectedRevision: rev + 1 });
    expect(again.profile?.revision).toBe(rev + 1);
    expect(await revisionOf(p)).toBe(rev + 1);
    expect((await code(photos.remove(p.accountId, { expectedRevision: rev }))).code).toBe('STALE_PROFILE');
    // after the grace period the sweep deletes the orphan
    setMedia({ orphanGraceSeconds: 60 });
    await ageAsset(done.assetId, 3600);
    expect((await sweep()).deleted).toBe(1);
    expect(store.objects.has(done.finalKey)).toBe(false);
  });

  it('remove abandons an unfinished upload and deletes its objects', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    const state = await photos.remove(p.accountId, { expectedRevision: a.revision });
    expect(state.profile?.photoPending).toBe(false);
    expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await profileRow(p)).pending_photo_asset_id).toBeNull();
  });

  it('a PUBLIC profile never drops below its prerequisites: with photo.required the photo cannot be removed (PROFILE_INCOMPLETE, nothing changes) until the profile is PRIVATE; an unfinished upload can still be removed', async () => {
    const p = await mkProvider('PUBLIC');
    const done = await finalizeOk(p);
    setProfile({ photoRequired: true });
    const rev = await revisionOf(p);
    const refusedRemoval = await code(photos.remove(p.accountId, { expectedRevision: rev }));
    expect(refusedRemoval).toEqual({ code: 'PROFILE_INCOMPLETE', details: { issues: [{ reason: 'PHOTO_REQUIRED', field: 'photo' }] } });
    expect((await profileRow(p)).photo_asset_id).toBe(done.assetId);
    expect(await revisionOf(p)).toBe(rev);
    expect((await photos.publicPhoto(p.publicProfileId))?.kind).toBe('bytes');
    expect((await audits(p)).length).toBe(2); // the refused call wrote nothing
    // with an unfinished replacement pending, removing is still removing the photo: refused too, and the pending upload is untouched
    const pending = await authorize(p, goodJpeg());
    expect((await code(photos.remove(p.accountId, { expectedRevision: pending.revision }))).code).toBe('PROFILE_INCOMPLETE');
    expect((await assetRow(pending.assetId)).status).toBe('UPLOAD_PENDING');
    expect((await profileRow(p)).photo_asset_id).toBe(done.assetId);
    // a PUBLIC profile with no photo (it got there before the requirement) may cancel its unfinished upload
    const bare = await mkProvider('PUBLIC');
    const pend2 = await authorize(bare, goodJpeg());
    const cancelled = await photos.remove(bare.accountId, { expectedRevision: pend2.revision });
    expect(cancelled.profile?.photoPending).toBe(false);
    // replacing is not removing
    const swap = await finalizeOk(p, jpeg({ w: 700, h: 500, trailing: Buffer.alloc(0) }).file);
    expect((await profileRow(p)).photo_asset_id).toBe(swap.assetId);
    // PRIVATE first, then the photo can go
    await q(`UPDATE provider.public_profiles SET visibility_status = 'PRIVATE', revision = revision + 1 WHERE account_id = $1`, [p.accountId]);
    await photos.remove(p.accountId, { expectedRevision: await revisionOf(p) });
    expect((await profileRow(p)).photo_asset_id).toBeNull();
    // and with the requirement off a PUBLIC profile may drop its photo
    setProfile({ photoRequired: false });
    const q2 = await mkProvider('PUBLIC');
    await finalizeOk(q2);
    await photos.remove(q2.accountId, { expectedRevision: await revisionOf(q2) });
    expect((await profileRow(q2)).photo_asset_id).toBeNull();
  });

  it('remove validates its body and the owner', async () => {
    const p = await mkProvider();
    expect((await code(photos.remove(p.accountId, {}))).code).toBe('VALIDATION_FAILED');
    expect((await code(photos.remove(await mkAccount(), { expectedRevision: 1 }))).code).toBe('PROFILE_NOT_FOUND');
  });
});

// ====================================================================== 5. clean-up interplay
describe('clean-up (reference-aware)', () => {
  it('never deletes or abandons an asset the profile references, even with no grace period and an expired pending upload on ANOTHER profile', async () => {
    setMedia({ orphanGraceSeconds: 0 });
    const p = await mkProvider();
    const done = await finalizeOk(p);
    const pending = await authorize(p, goodJpeg()); // the profile now references a READY photo AND a pending upload
    await sweep(); // other tests leave unreferenced photos behind: only THIS profile's assets are asserted
    expect((await assetRow(done.assetId)).status).toBe('READY');
    expect((await assetRow(pending.assetId)).status).toBe('UPLOAD_PENDING');
    expect(logSink.lines.join('\n')).not.toContain('clean-up step failed');
  });

  it('an expired pending profile upload loses the pointer (revision +1, system audit row) and is then abandoned with its objects deleted', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    await expireAsset(a.assetId);
    const result = await sweep();
    expect(result.abandoned).toBe(1);
    expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
    const row = await profileRow(p);
    expect(row.pending_photo_asset_id).toBeNull();
    expect(Number(row.revision)).toBe(a.revision + 1);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    const rows = await audits(p);
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({ actor: 'system:gig-media-cleanup', action: 'PROVIDER_PROFILE_PHOTO_CHANGED' });
    expect(last.changes).toEqual({ changedFields: ['photo'], revision: [a.revision, a.revision + 1], reason: 'UPLOAD_EXPIRED' });
    expect(logSink.lines.join('\n')).not.toContain('clean-up step failed');
    // a second run finds nothing to do
    expect((await sweep()).abandoned).toBe(0);
  });

  it('an unfinished upload that is NOT expired is left alone by the sweep', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    expect((await sweep()).abandoned).toBe(0);
    expect((await assetRow(a.assetId)).status).toBe('UPLOAD_PENDING');
    expect((await profileRow(p)).pending_photo_asset_id).toBe(a.assetId);
  });

  it('the database itself refuses to delete or abandon an asset a profile references (ASSET_REFERENCED), for the photo and for the pending pointer', async () => {
    const p = await mkProvider();
    const done = await finalizeOk(p);
    const pending = await authorize(p, goodJpeg());
    const del = await rejection(q(`UPDATE provider.media_assets SET status = 'DELETED' WHERE media_asset_id = $1`, [done.assetId]));
    expect(String((del as { detail?: string }).detail)).toContain('ASSET_REFERENCED');
    const aband = await rejection(q(`UPDATE provider.media_assets SET status = 'ABANDONED' WHERE media_asset_id = $1`, [pending.assetId]));
    expect(String((aband as { detail?: string }).detail)).toContain('ASSET_REFERENCED');
  });

  it('terminal profile assets whose objects were not removed (a store outage) are reconciled by the next sweep', async () => {
    const p = await mkProvider();
    const a = await authorize(p, goodJpeg());
    store.failDelete = true;
    await photos.remove(p.accountId, { expectedRevision: a.revision });
    expect((await assetRow(a.assetId)).status).toBe('ABANDONED');
    expect(store.objects.has(a.uploadKey)).toBe(true); // the deletion failed, the object is still there
    store.failDelete = false;
    await expireAsset(a.assetId);
    const r = await sweep();
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(a.uploadKey)).toBe(false);
    expect((await assetRow(a.assetId)).objects_removed_at).not.toBeNull();
  });
});

// ====================================================================== 6. serving (sanitised bytes only)
describe('serving', () => {
  it('the owner and the public get SANITISED bytes: no EXIF/GPS/tail, the same dimensions, the orientation kept; the stored original keeps its metadata', async () => {
    const p = await mkProvider('PUBLIC');
    const original = JPEG_ORIGINAL();
    const a = await authorize(p, original);
    await photos.finalize(p.accountId, { expectedRevision: a.revision });
    expect(store.objects.get(a.finalKey)!.bytes.includes('SECRET-GPS')).toBe(true);

    for (const result of [await photos.ownerPhoto(p.accountId), await photos.publicPhoto(p.publicProfileId)]) {
      expect(result?.kind).toBe('bytes');
      if (result?.kind !== 'bytes') throw new Error('unreachable');
      expect(result.contentType).toBe('image/jpeg');
      for (const s of SECRETS) expect(result.bytes.includes(s), s).toBe(false);
      expect(result.bytes.includes('http://ns.adobe.com')).toBe(false);
      expect(result.bytes.length).toBeLessThan(original.length);
      expect(readImageDimensions('image/jpeg', result.bytes)).toEqual({ width: 640, height: 480 });
      const at = result.bytes.indexOf('Exif\0\0');
      expect(at).toBeGreaterThan(0);
      expect(result.bytes[at + 6 + 19]).toBe(6); // the Orientation survived as the only EXIF tag
      expect(result.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(result.etag).not.toContain(sha(original));
      expect(result.etag).toBe(profilePhotoEtag(a.assetId, sha(original)));
    }
  });

  it('serves a PNG and a WebP sanitised as well', async () => {
    const p = await mkProvider('PUBLIC');
    await finalizeOk(p, png({ w: 400, h: 300 }).file, 'image/png');
    const r = await photos.publicPhoto(p.publicProfileId);
    if (r?.kind !== 'bytes') throw new Error('expected bytes');
    expect(r.contentType).toBe('image/png');
    for (const s of SECRETS) expect(r.bytes.includes(s), s).toBe(false);
    expect(readImageDimensions('image/png', r.bytes)).toEqual({ width: 400, height: 300 });

    const webpFile = webp().file;
    expect(webpFile.includes('SECRET-XMP')).toBe(true);
    await finalizeOk(p, webpFile, 'image/webp');
    const w = await photos.publicPhoto(p.publicProfileId);
    if (w?.kind !== 'bytes') throw new Error('expected bytes');
    expect(w.contentType).toBe('image/webp');
    for (const s of SECRETS) expect(w.bytes.includes(s), s).toBe(false);
    expect(w.bytes.readUInt32LE(4)).toBe(w.bytes.length - 8);
    expect(readImageDimensions('image/webp', w.bytes)).toEqual({ width: 800, height: 600 });
  });

  it('a matching If-None-Match answers not-modified with ZERO object reads; a different one gets the bytes; the validator changes when the photo is replaced', async () => {
    const p = await mkProvider('PUBLIC');
    const first = await finalizeOk(p);
    store.reads = 0;
    const r1 = await photos.publicPhoto(p.publicProfileId);
    expect(r1?.kind).toBe('bytes');
    expect(store.reads).toBe(1);
    const etag = r1!.etag;

    store.reads = 0;
    const nm = await photos.publicPhoto(p.publicProfileId, { ifNoneMatch: etag });
    expect(nm).toEqual({ kind: 'not-modified', etag });
    expect((await photos.publicPhoto(p.publicProfileId, { ifNoneMatch: `"zzz", ${etag}` }))?.kind).toBe('not-modified');
    expect((await photos.ownerPhoto(p.accountId, { ifNoneMatch: '*' }))?.kind).toBe('not-modified');
    expect(store.reads).toBe(0);

    expect((await photos.publicPhoto(p.publicProfileId, { ifNoneMatch: 'W/"other"' }))?.kind).toBe('bytes');

    await finalizeOk(p, jpeg({ w: 800, h: 600, trailing: Buffer.alloc(0) }).file);
    const r2 = await photos.publicPhoto(p.publicProfileId, { ifNoneMatch: etag });
    expect(r2?.kind).toBe('bytes'); // the old validator no longer matches
    expect(r2!.etag).not.toBe(etag);
    expect(first.assetId).toBeTruthy();
  });

  it('answers null for a PRIVATE profile, an unknown or malformed id and a profile without a photo, without any object read', async () => {
    const priv = await mkProvider('PRIVATE');
    await finalizeOk(priv);
    const empty = await mkProvider('PUBLIC');
    store.reads = 0;
    expect(await photos.publicPhoto(priv.publicProfileId)).toBeNull();
    expect(await photos.publicPhoto(randomUUID())).toBeNull();
    expect(await photos.publicPhoto('not-a-uuid')).toBeNull();
    expect(await photos.publicPhoto(empty.publicProfileId)).toBeNull();
    expect(await photos.ownerPhoto(empty.accountId)).toBeNull();
    expect(store.reads).toBe(0);
    expect((await photos.ownerPhoto(priv.accountId))?.kind).toBe('bytes'); // the owner still sees it
  });

  it('refuses to serve bytes that are no longer the verified bytes (a tampered final object): null for the public, MEDIA_NOT_FOUND for the owner', async () => {
    const p = await mkProvider('PUBLIC');
    const done = await finalizeOk(p);
    const obj = store.objects.get(done.finalKey)!;
    store.put(done.finalKey, Buffer.concat([obj.bytes.subarray(0, obj.bytes.length - 3), Buffer.from([1, 2, 3])]), obj.contentType);
    expect(await photos.publicPhoto(p.publicProfileId)).toBeNull();
    expect((await code(photos.ownerPhoto(p.accountId))).code).toBe('MEDIA_NOT_FOUND');
    store.objects.delete(done.finalKey);
    expect(await photos.publicPhoto(p.publicProfileId)).toBeNull();
  });

  it('a READY photo that the sanitiser cannot process (accepted before finalize sanitised, simulated by rewriting the recorded facts) is null for the public and a typed error for the owner', async () => {
    const p = await mkProvider('PUBLIC');
    const done = await finalizeOk(p);
    const bytes = Buffer.from(store.objects.get(done.finalKey)!.bytes);
    bytes[bytes.length - 1] = 0; // the EOI marker is damaged: the header is still fine
    bytes[bytes.length - 2] = 0;
    store.put(done.finalKey, bytes, 'image/jpeg');
    await q('ALTER TABLE provider.media_assets DISABLE TRIGGER USER');
    try {
      await q('UPDATE provider.media_assets SET sha256 = $2 WHERE media_asset_id = $1', [done.assetId, sha(bytes)]);
    } finally {
      await q('ALTER TABLE provider.media_assets ENABLE TRIGGER USER');
    }
    expect(await photos.publicPhoto(p.publicProfileId)).toBeNull();
    expect(await code(photos.ownerPhoto(p.accountId))).toEqual({ code: 'MEDIA_REFUSED', details: { reason: 'IMAGE_MALFORMED' } });
    expect(logSink.lines.join('\n')).toContain('could not be sanitised');
  });

  it('a file accepted without a clean scan verdict is not served once clean scans are required', async () => {
    const p = await mkProvider('PUBLIC');
    setMedia({ requireCleanScan: false });
    scanner.next = 'ERROR';
    await finalizeOk(p);
    expect((await photos.publicPhoto(p.publicProfileId))?.kind).toBe('bytes');
    setMedia({ requireCleanScan: true });
    expect(await photos.publicPhoto(p.publicProfileId)).toBeNull();
    expect((await code(photos.ownerPhoto(p.accountId))).code).toBe('MEDIA_NOT_FOUND');
  });

  it('an object-store outage while serving is UNAVAILABLE (never a 404-looking null)', async () => {
    const p = await mkProvider('PUBLIC');
    await finalizeOk(p);
    store.failRead = true;
    expect(await code(photos.publicPhoto(p.publicProfileId))).toEqual({ code: 'UNAVAILABLE', details: { reason: 'MEDIA_STORE_UNAVAILABLE' } });
    // a validator match needs no read, so it still answers during the outage
    store.failRead = false;
    const etag = (await photos.publicPhoto(p.publicProfileId))!.etag;
    store.failRead = true;
    expect((await photos.publicPhoto(p.publicProfileId, { ifNoneMatch: etag }))?.kind).toBe('not-modified');
  });
});

// ====================================================================== 7. nothing secret leaves
describe('no secret leaves the service', () => {
  it('audit rows, logs and error details never hold an object key, an upload URL, a hash or an asset id', async () => {
    const p = await mkProvider('PUBLIC');
    const done = await finalizeOk(p, JPEG_ORIGINAL());
    const sha256 = (await assetRow(done.assetId)).sha256 as string;
    // provoke refusals and clean-up so the logs have content
    scanner.next = 'INFECTED';
    const bad = await authorize(p, goodJpeg());
    const err = await code(photos.finalize(p.accountId, { expectedRevision: bad.revision }));
    scanner.next = 'CLEAN';
    const tampered = store.objects.get(done.finalKey)!;
    store.put(done.finalKey, Buffer.from(tampered.bytes.subarray(0, 10)), tampered.contentType);
    await photos.publicPhoto(p.publicProfileId);
    await sweep();
    const surfaces = JSON.stringify([await audits(p), err]) + logSink.lines.join('\n');
    for (const needle of ['provider/gig-media', 'memory://', '.upload', sha256, done.assetId, bad.assetId, done.finalKey])
      expect(surfaces, needle).not.toContain(needle);
  });
});

// ====================================================================== 8. through the REAL ProviderProfileService
describe('through the real ProviderProfileService', () => {
  /** The ports of the real service, read from the real rows (the domains never import each other, so they are fakes here). */
  const accountsPort: AccountPort = {
    async facts(accountId: string): Promise<AccountFacts> {
      const r = (
        await sql<Row>`SELECT a.status,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('code', ro.code, 'status', m.status) ORDER BY ro.code)
                        FROM identity.account_roles m JOIN identity.roles ro ON ro.role_id = m.role_id WHERE m.account_id = a.account_id), '[]'::jsonb) AS memberships
          FROM identity.accounts a WHERE a.account_id = ${accountId}`.execute(iso.database.db)
      ).rows[0]!;
      return { accountId, status: r.status as string, memberships: r.memberships as AccountFacts['memberships'], emailVerified: true, phoneVerified: true };
    },
    async grantRole() {
      throw new Error('the profile service never grants roles');
    },
  };
  const namesPort: AccountNamePort = {
    async names(accountId: string) {
      const r = (await sql<Row>`SELECT first_name, last_name FROM identity.account_profiles WHERE account_id = ${accountId}`.execute(iso.database.db)).rows[0];
      return r ? { firstName: r.first_name as string, lastName: r.last_name as string } : null;
    },
  };
  const marketsPort: MarketPort = {
    async lookup(code: string): Promise<MarketFacts | null> {
      const r = (
        await sql<Row>`SELECT code, status, (effective_from <= now() AND (effective_to IS NULL OR effective_to > now())) AS in_effect FROM geography.markets WHERE code = ${code}`.execute(
          iso.database.db,
        )
      ).rows[0];
      return r ? { code: r.code as string, status: r.status as string, inEffect: r.in_effect === true } : null;
    },
  };
  const trustPort: TrustSummaryPort = { publicBadgeTypes: async () => [] };
  const servicesPort: GigServiceNamePort = { forTemplateVersions: async () => new Map() };
  let real: ProviderProfileService;
  let realPhotos: ProfilePhotoService;
  beforeAll(() => {
    real = new ProviderProfileService({
      db: iso.database,
      accounts: accountsPort,
      names: namesPort,
      markets: marketsPort,
      trust: trustPort,
      services: servicesPort,
      policy: profilePolicy,
    });
    realPhotos = new ProfilePhotoService({
      database: iso.database,
      store,
      scanner,
      media: mediaPolicy,
      policy: profilePolicy,
      profiles: real,
      getPublicPhotoTarget: (id) => real.getPublicPhotoTarget(id),
      getOwnerPhotoTarget: (id) => real.getOwnerPhotoTarget(id),
    });
  });
  const events = (profileId: string) =>
    q<Row>(`SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, outbox_event_id`, [profileId]);

  it('the whole journey: create, upload, finalize, publish, serve sanitised bytes with a validator, replace, hide, remove, with audit rows and outbox events that hold field names only', async () => {
    const accountId = await mkAccount();
    await register(accountId);
    const created = await real.createProfile(accountId);
    const profileId = created.state.profile!.publicProfileId;
    let rev = created.state.profile!.revision;

    const original = JPEG_ORIGINAL();
    const up = await realPhotos.requestUpload(accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: original.length });
    expect(up.revision).toBe(rev + 1);
    const pending = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    const finalKey = (await assetRow(pending)).object_key as string;
    store.put(`${finalKey}.upload`, original, 'image/jpeg');
    const state = await realPhotos.finalize(accountId, { expectedRevision: up.revision });
    expect(state.profile).toMatchObject({ photo: { mimeType: 'image/jpeg', width: 640, height: 480 }, photoPending: false, revision: up.revision + 1 });
    rev = state.profile!.revision;

    // PRIVATE: the public sees nothing; the owner and the preview see the photo
    expect(await realPhotos.publicPhoto(profileId)).toBeNull();
    expect((await realPhotos.ownerPhoto(accountId))?.kind).toBe('bytes');
    expect((await real.getPreview(accountId)).photo).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 });

    // publish: the same bytes are now public, sanitised, with a validator
    const published = await real.setVisibility(accountId, { expectedRevision: rev, visibility: 'PUBLIC' });
    rev = published.profile!.revision;
    const pub = await realPhotos.publicPhoto(profileId);
    if (pub?.kind !== 'bytes') throw new Error('expected bytes');
    for (const sec of SECRETS) expect(pub.bytes.includes(sec), sec).toBe(false);
    expect(readImageDimensions('image/jpeg', pub.bytes)).toEqual({ width: 640, height: 480 });
    expect((await realPhotos.publicPhoto(profileId, { ifNoneMatch: pub.etag }))?.kind).toBe('not-modified');
    expect((await real.getPublicProfile(profileId))?.photo).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 });
    expect(JSON.stringify(await real.getPublicProfile(profileId))).not.toContain(finalKey);

    // replace: a new upload while PUBLIC keeps serving the old photo until the new one is finalized
    const replacement = jpeg({ w: 800, h: 600, trailing: Buffer.alloc(0) }).file;
    const up2 = await realPhotos.requestUpload(accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: replacement.length });
    expect((await realPhotos.publicPhoto(profileId))?.etag).toBe(pub.etag);
    const pending2 = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    store.put(`${(await assetRow(pending2)).object_key as string}.upload`, replacement, 'image/jpeg');
    const replaced = await realPhotos.finalize(accountId, { expectedRevision: up2.revision });
    rev = replaced.profile!.revision;
    const pub2 = await realPhotos.publicPhoto(profileId);
    expect(pub2?.etag).not.toBe(pub.etag);
    expect(readImageDimensions('image/jpeg', (pub2 as { bytes: Buffer }).bytes)).toEqual({ width: 800, height: 600 });
    expect((await realPhotos.publicPhoto(profileId, { ifNoneMatch: pub.etag }))?.kind).toBe('bytes'); // the old validator is dead

    // hide: PRIVATE again answers null (the same as an unknown profile)
    const hidden = await real.setVisibility(accountId, { expectedRevision: rev, visibility: 'PRIVATE' });
    rev = hidden.profile!.revision;
    expect(await realPhotos.publicPhoto(profileId)).toBeNull();
    expect(await realPhotos.publicPhoto(randomUUID())).toBeNull();

    // remove
    const removed = await realPhotos.remove(accountId, { expectedRevision: rev });
    expect(removed.profile).toMatchObject({ photo: null, photoPending: false });
    expect(await realPhotos.ownerPhoto(accountId)).toBeNull();

    // the trail holds field names, revisions and visibility only
    const rows = await q<Row>('SELECT action, changes FROM provider.profile_audit_events WHERE public_profile_id = $1 ORDER BY occurred_at, audit_event_id', [
      profileId,
    ]);
    expect(rows.map((r) => r.action)).toEqual([
      'PROVIDER_PUBLIC_PROFILE_CREATED',
      'PROVIDER_PROFILE_PHOTO_CHANGED',
      'PROVIDER_PROFILE_PHOTO_CHANGED',
      'PROVIDER_PROFILE_VISIBILITY_CHANGED',
      'PROVIDER_PROFILE_PHOTO_CHANGED',
      'PROVIDER_PROFILE_PHOTO_CHANGED',
      'PROVIDER_PROFILE_VISIBILITY_CHANGED',
      'PROVIDER_PROFILE_PHOTO_CHANGED',
    ]);
    const ev = await events(profileId);
    const surfaces = JSON.stringify([rows, ev]) + logSink.lines.join('\n');
    for (const needle of [finalKey, 'provider/gig-media', 'memory://', '.upload', sha(original), pending, pending2])
      expect(surfaces, needle).not.toContain(needle);
    const updated = ev.filter((e) => e.event_type === 'bananagig.provider.profile-updated.v1');
    expect(updated.some((e) => JSON.stringify((e.payload_json as { changedFields?: string[] }).changedFields) === '["photo"]')).toBe(true);
  });

  it('EVENT RULE: authorizing, abandoning and the expired-upload sweep write the audit row and raise the revision but emit NO profile-updated event; finalize and removing a shown photo do', async () => {
    const accountId = await mkAccount();
    await register(accountId);
    const created = await real.createProfile(accountId);
    const profileId = created.state.profile!.publicProfileId;
    const photoEvents = async () =>
      (await events(profileId)).filter(
        (e) =>
          e.event_type === 'bananagig.provider.profile-updated.v1' &&
          JSON.stringify((e.payload_json as { changedFields?: string[] }).changedFields) === '["photo"]',
      ).length;
    const auditCount = async () => (await q<Row>('SELECT 1 FROM provider.profile_audit_events WHERE public_profile_id = $1', [profileId])).length;
    const before = { events: await photoEvents(), audits: await auditCount() };

    const up1 = await realPhotos.requestUpload(accountId, { expectedRevision: created.state.profile!.revision, mimeType: 'image/jpeg', sizeBytes: 5000 });
    expect(await photoEvents()).toBe(before.events); // authorization: no event
    expect(await auditCount()).toBe(before.audits + 1); // but audited, and the revision rose
    const up2 = await realPhotos.requestUpload(accountId, { expectedRevision: up1.revision, mimeType: 'image/jpeg', sizeBytes: 5000 }); // abandons up1
    expect(await photoEvents()).toBe(before.events);
    expect(await auditCount()).toBe(before.audits + 2);

    const pending = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    await expireAsset(pending);
    await sweep();
    expect(await photoEvents()).toBe(before.events); // the sweep: audited (system), no event
    expect(await auditCount()).toBe(before.audits + 3);
    expect((await real.getOwnerProfile(accountId)).profile?.revision).toBe(up2.revision + 1);

    const bytes = goodJpeg();
    const state = (await real.getOwnerProfile(accountId)).profile!;
    const up3 = await realPhotos.requestUpload(accountId, { expectedRevision: state.revision, mimeType: 'image/jpeg', sizeBytes: bytes.length });
    const asset3 = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    store.put(`${(await assetRow(asset3)).object_key as string}.upload`, bytes, 'image/jpeg');
    const done = await realPhotos.finalize(accountId, { expectedRevision: up3.revision });
    expect(await photoEvents()).toBe(before.events + 1); // finalize: a public change, one event

    // removing the shown photo is a public change; removing only an unfinished upload (no photo shown) is a pending-pointer change
    await realPhotos.remove(accountId, { expectedRevision: done.profile!.revision });
    expect(await photoEvents()).toBe(before.events + 2);
    const afterRemoval = (await real.getOwnerProfile(accountId)).profile!;
    const up4 = await realPhotos.requestUpload(accountId, { expectedRevision: afterRemoval.revision, mimeType: 'image/jpeg', sizeBytes: 5000 });
    expect(await photoEvents()).toBe(before.events + 2);
    await realPhotos.remove(accountId, { expectedRevision: up4.revision });
    expect(await photoEvents()).toBe(before.events + 2);
  });

  it('a PUBLIC profile with photo.required cannot lose its photo through the real service (PROFILE_INCOMPLETE), and can once it is PRIVATE', async () => {
    const accountId = await mkAccount();
    await register(accountId);
    const created = await real.createProfile(accountId);
    const bytes = goodJpeg();
    const up = await realPhotos.requestUpload(accountId, {
      expectedRevision: created.state.profile!.revision,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.length,
    });
    const asset = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    store.put(`${(await assetRow(asset)).object_key as string}.upload`, bytes, 'image/jpeg');
    const done = await realPhotos.finalize(accountId, { expectedRevision: up.revision });
    const pub = await real.setVisibility(accountId, { expectedRevision: done.profile!.revision, visibility: 'PUBLIC' });
    setProfile({ photoRequired: true });
    const e = await code(realPhotos.remove(accountId, { expectedRevision: pub.profile!.revision }));
    expect(e).toEqual({ code: 'PROFILE_INCOMPLETE', details: { issues: [{ reason: 'PHOTO_REQUIRED', field: 'photo' }] } });
    expect((await real.getOwnerProfile(accountId)).profile).toMatchObject({ visibility: 'PUBLIC', revision: pub.profile!.revision });
    expect((await real.getOwnerProfile(accountId)).profile?.photo).not.toBeNull();
    const priv = await real.setVisibility(accountId, { expectedRevision: pub.profile!.revision, visibility: 'PRIVATE' });
    const removed = await realPhotos.remove(accountId, { expectedRevision: priv.profile!.revision });
    expect(removed.profile?.photo).toBeNull();
  });

  it('a stale revision is STALE_PROFILE through the real mutator, and an expired pending upload is cleared by the sweep (the owner state shows no pending photo)', async () => {
    const accountId = await mkAccount();
    await register(accountId);
    const { state } = await real.createProfile(accountId);
    const rev = state.profile!.revision;
    expect((await code(realPhotos.requestUpload(accountId, { expectedRevision: rev + 3, mimeType: 'image/jpeg', sizeBytes: 1000 }))).code).toBe(
      'STALE_PROFILE',
    );
    const up = await realPhotos.requestUpload(accountId, { expectedRevision: rev, mimeType: 'image/jpeg', sizeBytes: 1000 });
    expect((await real.getOwnerProfile(accountId)).profile?.photoPending).toBe(true);
    const pending = (await one<Row>('SELECT pending_photo_asset_id FROM provider.public_profiles WHERE account_id = $1', [accountId]))
      .pending_photo_asset_id as string;
    await expireAsset(pending);
    expect((await sweep()).abandoned).toBeGreaterThanOrEqual(1);
    const after = await real.getOwnerProfile(accountId);
    expect(after.profile).toMatchObject({ photoPending: false, revision: up.revision + 1 });
    expect((await assetRow(pending)).status).toBe('ABANDONED');
  });

  it("two providers: one cannot finalize or remove the other's photo through the service", async () => {
    const a = await mkAccount();
    const b = await mkAccount();
    await register(a);
    await register(b);
    const pa = await real.createProfile(a);
    const pb = await real.createProfile(b);
    const upA = await realPhotos.requestUpload(a, { expectedRevision: pa.state.profile!.revision, mimeType: 'image/jpeg', sizeBytes: 1000 });
    expect((await code(realPhotos.finalize(b, { expectedRevision: pb.state.profile!.revision }))).code).toBe('MEDIA_NOT_FOUND');
    expect((await real.getOwnerProfile(a)).profile?.photoPending).toBe(true);
    const removed = await realPhotos.remove(b, { expectedRevision: pb.state.profile!.revision });
    expect(removed.profile?.revision).toBe(pb.state.profile!.revision); // nothing to remove: no change
    expect((await real.getOwnerProfile(a)).profile).toMatchObject({ photoPending: true, revision: upA.revision });
  });
});
