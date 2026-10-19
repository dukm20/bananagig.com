// The provider PROFILE PHOTO (PRO-002): one photo per public profile, built on the CAT-004 asset pipeline (provider.media_assets, account-owned bytes) instead of a second upload
// subsystem. The flow is the Gig photo flow with a different owner of the reference:
//
//  - requestUpload authorizes ONE upload (purpose PROFILE_PHOTO, the profile's own size cap on top of the media policy), writes the asset and the profile's `pending_photo_asset_id`
//    in one profile mutation (a previous unfinished upload is abandoned in the same transaction) and returns the one-time presigned PUT to the SEPARATE `.upload` key;
//  - finalize runs the SHARED integrity pipeline of gig-media.ts (inspectUpload / promoteUpload: one bounded versioned read, signature, header dimensions, SHA-256, fail-closed scan,
//    version-conditional promotion) BEFORE the transaction, then records READY and moves the asset from the pending pointer to `photo_asset_id`. The replaced photo is only
//    DETACHED: the reference-aware clean-up deletes its bytes once it is no longer referenced AND has been READY for longer than the grace period (the grace period runs from
//    `ready_at`, not from the moment of detaching, so a long-lived photo that is replaced can be swept at the next run);
//  - EVENT RULE: a mutation that only moves the PENDING pointer (authorizing an upload, abandoning an upload, the expired-upload sweep, removing an unfinished upload) reports
//    `publicChange: false`: the revision still rises and the audit row is still written, but no `profile-updated` event is emitted because no customer-visible fact changed;
//  - the stored bytes are NEVER served. Photos are verified by header only and keep EXIF/GPS and any polyglot tail (DEBT-0099), so every read passes the pure container-level sanitiser
//    (image-sanitize.ts) and carries an opaque weak ETag: a matching If-None-Match answers 304 BEFORE any object is read;
//  - the object key, the bucket, the hash and the asset id never appear in a payload, an audit row, an event, a log line or an error detail. The only URL ever returned is the one-time
//    presigned PUT target of requestUpload.
//
// Lock order is account -> profile -> asset everywhere (the profile mutator takes the first two; this file takes the asset only inside `run`). Every `run` that reports a change raises the
// revision by exactly one IN THE SAME UPDATE as the change (`revision = ctx.revision + 1`), as the mutator and the database guard require.
import { createHash, randomUUID } from 'node:crypto';
import {
  FinalizeProfilePhotoRequest,
  RemoveProfilePhotoRequest,
  RequestProfilePhotoUploadRequest,
  type OwnerProfileStateDto,
  type ProfilePhotoUploadDto,
  type ProviderGigMediaPolicy,
  type ProviderProfilePolicy,
} from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { log } from '@bananagig/observability';
import type { PrivateObjectStore } from '@bananagig/platform';
import type { z } from 'zod';
import { isDatabaseOutage } from './errors';
import { GigError } from './gig-errors';
import { inspectUpload, markUploadKeysRemoved, mediaFinalKey, promoteUpload, removeAssetObjects, verifyFinalObject, type MediaVerifyPolicy } from './gig-media';
import { deleteMediaObjects, uploadKeyOf } from './gig-media-model';
import type { GigMediaScanner } from './gig-types';
import { ProfileError } from './profile-errors';
import { publishingIssues } from './profile-validate';
import type { ProfileMutator, ProfilePhotoApi, ProfilePhotoResult, ProfilePhotoTarget, ProfilePolicyProvider } from './profile-types';
import { sanitizeImage } from './image-sanitize';

export interface ProfilePhotoServiceDeps {
  database: Database;
  store: PrivateObjectStore;
  scanner: GigMediaScanner;
  /** The existing media policy (types, bounds, TTLs, scan requirement). Only `media()` is used. */
  media: { media(): Promise<ProviderGigMediaPolicy> };
  /** The profile policy (the photo size cap). */
  policy: ProfilePolicyProvider;
  /** The profile-mutation primitive (ProviderProfileService): owner-scoped, locked, revisioned, audited, with the outbox event. */
  profiles: ProfileMutator;
  /** ProviderProfileService.getPublicPhotoTarget: only after every visibility and eligibility rule passed. */
  getPublicPhotoTarget(publicProfileId: string): Promise<ProfilePhotoTarget | null>;
  /** ProviderProfileService.getOwnerPhotoTarget. */
  getOwnerPhotoTarget(accountId: string): Promise<ProfilePhotoTarget | null>;
}

type Raw = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How often a bookkeeping step retries when the profile revision moves under it. */
const ATTEMPTS = 3;
const PROFILE_PHOTO_PURPOSE = 'PROFILE_PHOTO';
/**
 * Part of the ETag seed: raise it whenever the sanitiser changes what it outputs, so a cached copy made by an older sanitiser is never revalidated as current.
 */
const SANITIZER_VERSION = 1;
/** An If-None-Match header longer than this is ignored (the answer is then the full image): the match is a linear scan and must stay cheap. */
const IF_NONE_MATCH_MAX = 1024;

const notFoundMedia = () => new ProfileError('MEDIA_NOT_FOUND', 'the photo was not found', {});
const refused = (reason: string) => new ProfileError('MEDIA_REFUSED', 'the file did not match what was described', { reason });
const stale = () => new ProfileError('STALE_PROFILE', 'the profile changed since it was read: read it again', { reason: 'STALE_PROFILE' });
const storeDown = () => new ProfileError('UNAVAILABLE', 'photos are unavailable', { reason: 'MEDIA_STORE_UNAVAILABLE' });

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new ProfileError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof first?.path[0] === 'string' ? first.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}

/** The opaque weak validator: a hash of the asset id, the content hash and the sanitiser version. It is NOT the content hash and cannot be reversed to it. */
export function profilePhotoEtag(assetId: string, sha256: string): string {
  return `W/"${createHash('sha256').update(`profile-photo:v${SANITIZER_VERSION}:${assetId}:${sha256}`).digest('hex')}"`;
}

/** Weak comparison of an If-None-Match header with an ETag (RFC 9110 8.8.3.2): `*` matches any current representation; a list matches when any entry has the same opaque tag. */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.length === 0 || header.length > IF_NONE_MATCH_MAX) return false;
  const opaque = (t: string): string => (t.startsWith('W/') ? t.slice(2) : t);
  const wanted = opaque(etag);
  for (const raw of header.split(',')) {
    const entry = raw.trim();
    if (entry === '*') return true;
    if (entry !== '' && opaque(entry) === wanted) return true;
  }
  return false;
}

export class ProfilePhotoService implements ProfilePhotoApi {
  constructor(protected readonly deps: ProfilePhotoServiceDeps) {}

  private get db() {
    return this.deps.database.db;
  }
  /** Reads outside a transaction: only an outage of the database is translated; the callers speak ProfileError and nothing else. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ProfileError) && isDatabaseOutage(e)) {
        log('error', 'profile photo database unavailable', { error: e instanceof Error ? e.name : 'unknown' });
        throw new ProfileError('UNAVAILABLE', 'photos are unavailable', { reason: 'MEDIA_DATABASE_UNAVAILABLE' });
      }
      throw e;
    }
  }
  /** The media policy, fail closed: an unreadable configuration is UNAVAILABLE (the Gig policy provider speaks GigError). */
  private async mediaPolicy(): Promise<ProviderGigMediaPolicy> {
    try {
      return await this.deps.media.media();
    } catch (e) {
      if (e instanceof ProfileError) throw e;
      if (e instanceof GigError && e.code === 'UNAVAILABLE') throw new ProfileError('UNAVAILABLE', 'photos are unavailable', { reason: 'POLICY_INVALID' });
      throw e;
    }
  }
  /** The effective verification policy: the media policy with the profile's own (usually smaller) size cap. */
  private verifyPolicy(media: ProviderGigMediaPolicy, profile: ProviderProfilePolicy): MediaVerifyPolicy & { cap: number } {
    const cap = Math.min(profile.photoMaxFileSizeBytes, media.maxFileSizeBytes);
    return { ...media, maxFileSizeBytes: cap, cap };
  }

  /** The owner state at the CURRENT revision, without changing anything (the idempotent answer of a repeated call). */
  private async currentState(accountId: string): Promise<OwnerProfileStateDto> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.deps.profiles.readProfile(accountId);
      try {
        return (
          await this.deps.profiles.mutateProfile(accountId, ctx.revision, async () => ({
            changed: false,
            action: 'PROVIDER_PROFILE_PHOTO_CHANGED',
            changedFields: [],
            value: null,
          }))
        ).state;
      } catch (e) {
        if (!(e instanceof ProfileError && e.code === 'STALE_PROFILE') || attempt >= ATTEMPTS) throw e;
      }
    }
  }

  // ------------------------------------------------------------------ authorize
  async requestUpload(accountId: string, input: unknown): Promise<ProfilePhotoUploadDto> {
    const body = parseInput(RequestProfilePhotoUploadRequest, input);
    const media = await this.mediaPolicy();
    const policy = this.verifyPolicy(media, await this.deps.policy.policy());
    // the owner's profile first: no profile is PROFILE_NOT_FOUND whatever the body says
    const pre = await this.deps.profiles.readProfile(accountId);
    if (pre.revision !== body.expectedRevision) throw stale();
    if (!(policy.allowedMimeTypes as readonly string[]).includes(body.mimeType)) throw refused('MIME_NOT_ALLOWED');
    if (body.sizeBytes > policy.cap) throw refused('FILE_TOO_LARGE');

    // the asset id is minted and the upload URL signed BEFORE the transaction: signing is the store's work, and a store failure must not happen while locks are held
    const assetId = randomUUID();
    const finalKey = mediaFinalKey(assetId);
    let upload;
    try {
      upload = await this.deps.store.createUploadUrl({
        key: uploadKeyOf(finalKey),
        contentType: body.mimeType,
        contentLength: body.sizeBytes,
        ttlSeconds: media.uploadTtlSeconds,
      });
    } catch (err) {
      log('error', 'profile photo object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      throw storeDown();
    }

    const staleKeys: string[] = [];
    const { value } = await this.deps.profiles.mutateProfile(accountId, body.expectedRevision, async (ctx) => {
      staleKeys.length = 0;
      const row = (
        await sql<Raw>`SELECT pending_photo_asset_id FROM provider.public_profiles WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(ctx.trx)
      ).rows[0];
      const previous = (row?.pending_photo_asset_id as string | null | undefined) ?? null;
      // the authorization window is written with the DATABASE clock
      await sql`INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at, purpose)
        VALUES (${assetId}::uuid, ${accountId}::uuid, ${finalKey}, ${body.mimeType}, ${body.sizeBytes}::bigint,
                now() + make_interval(secs => ${media.uploadTtlSeconds}::double precision), ${PROFILE_PHOTO_PURPOSE})`.execute(ctx.trx);
      // the pointer moves to the new asset first: the database refuses to abandon an asset a profile still references
      await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = ${assetId}::uuid, revision = ${ctx.revision}::integer + 1, updated_at = now() WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(
        ctx.trx,
      );
      if (previous !== null) {
        const old = (await sql<Raw>`SELECT object_key, status FROM provider.media_assets WHERE media_asset_id = ${previous}::uuid FOR UPDATE`.execute(ctx.trx))
          .rows[0];
        if (old?.status === 'UPLOAD_PENDING') {
          await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${previous}::uuid`.execute(ctx.trx);
          staleKeys.push(old.object_key as string);
        }
      }
      // PENDING POINTER ONLY: nothing a customer sees changed, so no `profile-updated` event (the revision and the audit row are still written)
      return {
        changed: true,
        publicChange: false,
        action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const,
        changedFields: ['photo' as const],
        value: { revision: ctx.revision + 1 },
      };
    });
    // the transaction committed: only now the objects of the abandoned authorization go
    await removeAssetObjects(this.db, this.deps.store, staleKeys);
    return {
      upload: { url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() },
      maxSizeBytes: policy.cap,
      revision: value.revision,
    };
  }

  // ------------------------------------------------------------------ refuse
  /**
   * Closes the profile's unfinished upload `assetId`: the pending pointer is cleared, the asset becomes ABANDONED (with the scan verdict when that was the reason) and its objects are
   * deleted after the commit. Only the transaction that actually moved the asset deletes objects. A failure here never replaces the refusal the caller is about to report.
   */
  private async abandon(accountId: string, assetId: string, scan?: 'INFECTED'): Promise<void> {
    try {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const ctx = await this.deps.profiles.readProfile(accountId);
        let key: string | null = null;
        try {
          await this.deps.profiles.mutateProfile(accountId, ctx.revision, async (c) => {
            key = null;
            const row = (
              await sql<Raw>`SELECT pending_photo_asset_id FROM provider.public_profiles WHERE public_profile_id = ${c.publicProfileId}::uuid`.execute(c.trx)
            ).rows[0];
            if (row?.pending_photo_asset_id !== assetId)
              return { changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: [], value: null };
            await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = NULL, revision = ${c.revision}::integer + 1, updated_at = now() WHERE public_profile_id = ${c.publicProfileId}::uuid`.execute(
              c.trx,
            );
            const a = (await sql<Raw>`SELECT object_key, status FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid FOR UPDATE`.execute(c.trx))
              .rows[0];
            if (a?.status === 'UPLOAD_PENDING') {
              await sql`UPDATE provider.media_assets SET status = 'ABANDONED', scan_status = COALESCE(${scan ?? null}, scan_status), updated_at = now()
                WHERE media_asset_id = ${assetId}::uuid`.execute(c.trx);
              key = a.object_key as string;
            }
            // PENDING POINTER ONLY (see requestUpload): no public event
            return { changed: true, publicChange: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], value: null };
          });
        } catch (e) {
          if (e instanceof ProfileError && e.code === 'STALE_PROFILE') continue;
          throw e;
        }
        if (key) await removeAssetObjects(this.db, this.deps.store, [key]);
        return;
      }
    } catch (e) {
      log('warn', 'could not close a refused profile photo upload', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  // ------------------------------------------------------------------ finalize
  /** Verifies the uploaded object (the shared CAT-004 pipeline), promotes exactly those bytes and records the asset as the profile photo. Idempotent. */
  async finalize(accountId: string, input: unknown): Promise<OwnerProfileStateDto> {
    const body = parseInput(FinalizeProfilePhotoRequest, input);
    const policy = this.verifyPolicy(await this.mediaPolicy(), await this.deps.policy.policy());
    const pre = await this.deps.profiles.readProfile(accountId);
    const assetId = pre.pendingPhotoAssetId;
    // nothing is pending: a repeated finalize of a finished upload answers with the current state; with no photo at all there is nothing to finish
    if (assetId === null) {
      if (pre.photoAssetId !== null) return this.currentState(accountId);
      throw notFoundMedia();
    }
    const owned = (
      await this.read(() =>
        sql<Raw>`SELECT object_key, mime_type, size_bytes, status, (upload_expires_at <= now()) AS expired
            FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid AND account_id = ${accountId}::uuid AND purpose = ${PROFILE_PHOTO_PURPOSE}`.execute(
          this.db,
        ),
      )
    ).rows[0];
    if (!owned) throw notFoundMedia();
    if (owned.status === 'READY') return this.currentState(accountId);
    if (owned.status !== 'UPLOAD_PENDING') throw notFoundMedia();
    if (pre.revision !== body.expectedRevision) throw stale();
    if (owned.expired === true) {
      await this.abandon(accountId, assetId);
      throw new ProfileError('MEDIA_EXPIRED', 'the upload took too long', { reason: 'UPLOAD_EXPIRED' });
    }
    const asset = { objectKey: owned.object_key as string, mimeType: owned.mime_type as string, sizeBytes: Number(owned.size_bytes) };
    // A refusal. If a concurrent finalization already made the photo READY (this call lost the race: the winner also deleted the upload object, so this one sees it missing, changed or
    // different), the photo succeeded and that is the answer; the asset is never abandoned from under a finished photo.
    const gone = async (reason: string, scan?: 'INFECTED', closes = true): Promise<OwnerProfileStateDto> => {
      if (await this.isReady(assetId)) return this.currentState(accountId);
      if (closes) await this.abandon(accountId, assetId, scan);
      throw refused(reason);
    };
    const inspected = await inspectUpload(this.deps, asset, policy, body.sha256);
    if (inspected.kind === 'refused') return gone(inspected.reason, inspected.scan, inspected.closes);
    if (inspected.kind === 'store-unavailable') throw storeDown();
    if (inspected.kind === 'scan-unavailable')
      throw new ProfileError('MEDIA_SCAN_UNAVAILABLE', 'we could not check the file right now', { reason: 'SCAN_UNAVAILABLE', retryable: true });
    const { sha256, version, width, height, scanned } = inspected;
    // The stored object is never served as stored (it keeps its metadata), and a file the sanitiser would refuse could never be shown: refuse it NOW, like any other bad image, instead of
    // accepting a photo that can never be served. The sanitiser runs on the verified bytes (the same ones that are hashed, scanned and promoted).
    if (!sanitizeImage(asset.mimeType, inspected.bytes, { maxBytes: asset.sizeBytes }).ok) return gone('IMAGE_INVALID');

    // someone else may have finished (or closed) this upload while the bytes were being checked: do not write over a finished asset
    const state = await this.assetStatus(assetId);
    if (state === 'READY') return this.currentState(accountId);
    if (state !== 'UPLOAD_PENDING') throw notFoundMedia();

    const promoted = await promoteUpload(this.deps.store, asset, { version }, sha256);
    if (promoted.kind === 'refused') return gone(promoted.reason, promoted.scan, promoted.closes);
    if (promoted.kind === 'store-unavailable') throw storeDown();

    let result: { value: 'attached' | 'already'; state: OwnerProfileStateDto };
    try {
      result = await this.deps.profiles.mutateProfile(accountId, body.expectedRevision, async (ctx) => {
        const row = (
          await sql<Raw>`SELECT photo_asset_id, pending_photo_asset_id FROM provider.public_profiles WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(
            ctx.trx,
          )
        ).rows[0];
        const unchanged = { changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: [], value: 'already' as const };
        if (row?.pending_photo_asset_id !== assetId) {
          // the upload was superseded (a newer authorization) or already finished by a concurrent call
          if (row?.photo_asset_id === assetId) return unchanged;
          throw notFoundMedia();
        }
        const a = (await sql<Raw>`SELECT status FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid FOR UPDATE`.execute(ctx.trx)).rows[0];
        if (a?.status === 'READY') return unchanged;
        if (a?.status !== 'UPLOAD_PENDING') throw notFoundMedia();
        await sql`UPDATE provider.media_assets SET status = 'READY', sha256 = ${sha256}, width = ${width}::integer, height = ${height}::integer,
            scan_status = ${scanned}, ready_at = now(), updated_at = now() WHERE media_asset_id = ${assetId}::uuid`.execute(ctx.trx);
        // the replaced READY photo is only DETACHED here; the reference-aware clean-up deletes its bytes after the grace period
        await sql`UPDATE provider.public_profiles SET photo_asset_id = ${assetId}::uuid, pending_photo_asset_id = NULL, revision = ${ctx.revision}::integer + 1, updated_at = now()
          WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(ctx.trx);
        return { changed: true, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], value: 'attached' as const };
      });
    } catch (e) {
      // two finalizations of the same upload race: the revision the loser sent is stale, but the photo is READY, which is what it asked for.
      // The promoted copy is NOT deleted on a failed transaction: it may be the very object the winner just made READY.
      if (e instanceof ProfileError && e.code === 'STALE_PROFILE' && (await this.isReady(assetId))) {
        await verifyFinalObject(this.db, this.deps.store, assetId, asset.objectKey, asset.sizeBytes);
        return this.currentState(accountId);
      }
      throw e;
    }
    // this call promoted bytes but another one made the photo READY: check, without a lock, that the final object is still what the winner recorded
    if (result.value === 'already') await verifyFinalObject(this.db, this.deps.store, assetId, asset.objectKey, asset.sizeBytes);
    else if (await deleteMediaObjects(this.deps.store, [uploadKeyOf(asset.objectKey)])) await markUploadKeysRemoved(this.db, [asset.objectKey]);
    return result.state;
  }

  private async assetStatus(assetId: string): Promise<string | undefined> {
    return this.read(
      async () =>
        (await sql<Raw>`SELECT status FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid`.execute(this.db)).rows[0]?.status as
          string | undefined,
    );
  }
  private async isReady(assetId: string): Promise<boolean> {
    return (await this.assetStatus(assetId)) === 'READY';
  }

  // ------------------------------------------------------------------ remove
  /** Removes the photo and any unfinished upload. A READY photo is only detached (the clean-up deletes the bytes after the grace period); an unfinished upload is abandoned. */
  async remove(accountId: string, input: unknown): Promise<OwnerProfileStateDto> {
    const body = parseInput(RemoveProfilePhotoRequest, input);
    const profilePolicy = await this.deps.policy.policy();
    await this.deps.profiles.readProfile(accountId);
    let key: string | null = null;
    const { state } = await this.deps.profiles.mutateProfile(accountId, body.expectedRevision, async (ctx) => {
      key = null;
      const row = (
        await sql<Raw>`SELECT photo_asset_id, pending_photo_asset_id, visibility_status FROM provider.public_profiles WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(
          ctx.trx,
        )
      ).rows[0];
      const photo = (row?.photo_asset_id as string | null | undefined) ?? null;
      const pending = (row?.pending_photo_asset_id as string | null | undefined) ?? null;
      if (photo === null && pending === null) return { changed: false, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: [], value: null };
      // A PUBLIC profile never drops below the configured prerequisites: when a photo is required, the photo of a PUBLIC profile cannot be removed (the owner makes it PRIVATE first).
      if (photo !== null && row?.visibility_status === 'PUBLIC') {
        const issues = publishingIssues({ publicNameAvailable: true, bioPresent: true, photoPresent: false }, profilePolicy);
        if (issues.length > 0) throw new ProfileError('PROFILE_INCOMPLETE', 'a public profile needs a photo: make it private first', { issues });
      }
      await sql`UPDATE provider.public_profiles SET photo_asset_id = NULL, pending_photo_asset_id = NULL, revision = ${ctx.revision}::integer + 1, updated_at = now() WHERE public_profile_id = ${ctx.publicProfileId}::uuid`.execute(
        ctx.trx,
      );
      if (pending !== null) {
        const a = (await sql<Raw>`SELECT object_key, status FROM provider.media_assets WHERE media_asset_id = ${pending}::uuid FOR UPDATE`.execute(ctx.trx))
          .rows[0];
        if (a?.status === 'UPLOAD_PENDING') {
          await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${pending}::uuid`.execute(ctx.trx);
          key = a.object_key as string;
        }
      }
      // removing only an unfinished upload (no photo shown) is a pending-pointer change: no public event
      return { changed: true, publicChange: photo !== null, action: 'PROVIDER_PROFILE_PHOTO_CHANGED' as const, changedFields: ['photo' as const], value: null };
    });
    if (key) await removeAssetObjects(this.db, this.deps.store, [key]);
    return state;
  }

  // ------------------------------------------------------------------ serve (sanitised bytes, never the stored object)
  async ownerPhoto(accountId: string, opts: { ifNoneMatch?: string } = {}): Promise<ProfilePhotoResult | null> {
    const target = await this.deps.getOwnerPhotoTarget(accountId);
    if (target === null) return null;
    return this.serve(target, opts.ifNoneMatch, 'owner');
  }

  async publicPhoto(publicProfileId: string, opts: { ifNoneMatch?: string } = {}): Promise<ProfilePhotoResult | null> {
    if (typeof publicProfileId !== 'string' || !UUID.test(publicProfileId)) return null;
    const target = await this.deps.getPublicPhotoTarget(publicProfileId);
    if (target === null) return null;
    return this.serve(target, opts.ifNoneMatch, 'public');
  }

  /**
   * One READY profile photo, sanitised. The public side answers null for everything that is not servable (a missing object, a malformed container, a scan verdict that is no longer
   * enough) so that nothing distinguishes it from an unknown profile; the owner side answers a typed ProfileError. An outage of the database or the store is UNAVAILABLE on both.
   */
  private async serve(target: ProfilePhotoTarget, ifNoneMatch: string | undefined, side: 'owner' | 'public'): Promise<ProfilePhotoResult | null> {
    const missing = (reason: string): null => {
      if (side === 'owner') throw new ProfileError('MEDIA_NOT_FOUND', 'the photo was not found', { reason });
      return null;
    };
    if (!UUID.test(target.assetId)) return missing('NOT_FOUND');
    const media = await this.mediaPolicy();
    const a = (
      await this.read(() =>
        sql<Raw>`SELECT object_key, mime_type, size_bytes, sha256, scan_status FROM provider.media_assets
            WHERE media_asset_id = ${target.assetId}::uuid AND status = 'READY' AND purpose = ${PROFILE_PHOTO_PURPOSE}`.execute(this.db),
      )
    ).rows[0];
    // a file accepted without a clean verdict is not shown once clean scans are required
    if (!a || typeof a.sha256 !== 'string' || (media.requireCleanScan && a.scan_status !== 'CLEAN')) return missing('NOT_FOUND');
    const etag = profilePhotoEtag(target.assetId, a.sha256);
    // a matching validator answers BEFORE any object is read
    if (ifNoneMatchMatches(ifNoneMatch, etag)) return { kind: 'not-modified', etag };

    const size = Number(a.size_bytes);
    let stored: Buffer | null;
    try {
      // the stored size was verified exactly at finalize (and is within the profile cap of that time): the read is bounded by it
      stored = await this.deps.store.read(a.object_key as string, size);
    } catch (err) {
      log('error', 'profile photo object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      throw storeDown();
    }
    if (stored === null) return missing('OBJECT_MISSING');
    // the bytes served must be the bytes that were verified
    if (stored.byteLength !== size || createHash('sha256').update(stored).digest('hex') !== a.sha256) {
      log('warn', 'a profile photo object differs from its recorded hash', { mismatches: 1 });
      return missing('OBJECT_CHANGED');
    }
    const clean = sanitizeImage(a.mime_type as string, stored, { maxBytes: size });
    if (!clean.ok) {
      log('warn', 'a profile photo could not be sanitised', { reason: clean.reason });
      if (side === 'owner') throw new ProfileError('MEDIA_REFUSED', 'the photo could not be prepared', { reason: 'IMAGE_MALFORMED' });
      return null;
    }
    return { kind: 'bytes', bytes: clean.bytes, contentType: a.mime_type as string, etag };
  }
}
