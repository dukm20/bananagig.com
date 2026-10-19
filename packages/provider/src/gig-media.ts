// The media operations of a Gig draft (CAT-004): authorize an upload, finalize it (verify the bytes, scan, promote), attach, update the alt text, reorder, detach, preview, and the
// clean-up of abandoned uploads. This mirrors the hardened TRUST-001 evidence flow (packages/trust/src/service.ts requestUpload / finalizeDocument, LRN-0056):
//
//  - the browser's bytes land on an UPLOAD key (`<final key>.upload`) that is separate from the final key. The presigned PUT stays valid until it expires, so the server reads the
//    upload key ONCE (bounded by the authorized size), checks it, hashes it, scans it and PROMOTES exactly those bytes to the final key with a version-conditional copy; nothing ever
//    reads the upload key again, so a replayed PUT can only write an object no one reads;
//  - object-store and scanner I/O happens BEFORE the transaction; the transaction (on the DraftMutator primitive of the Gig service: account, Gig, draft locks, revision check) only
//    records the verdict;
//  - the asset id, the object key, the hash and every URL stay inside this file: they never reach an audit row, an event, a log line, an error detail or a default payload. The
//    only place a URL is ever returned is the DTO of the upload authorization and of the preview.
//
// A photo is an ATTACHMENT (provider.gig_version_media: the API's `mediaId`) of an ASSET (provider.media_assets: account-owned bytes). A published version's attachments are frozen
// by the database; the clean-up never deletes bytes that any attachment (of any version, in any state) references.
//
// Time: every authorization window is written and compared with the DATABASE clock (now() in SQL), never with the clock of the application server or the object store.
// Objects: every path that abandons or deletes an asset deletes its objects AFTER the commit, then records `objects_removed_at`; a failed deletion leaves it NULL and the clean-up
// repeats it (so a store outage never leaves bytes behind for good).
import { createHash, randomUUID } from 'node:crypto';
import {
  DetachGigMediaRequest,
  FinalizeGigMediaRequest,
  ReorderGigMediaRequest,
  RequestGigMediaUploadRequest,
  UpdateGigMediaRequest,
  gigIssueKey,
  normalizeProviderText,
  textLength,
  type GigDetailDto,
  type GigIssueDto,
  type GigIssueReason,
  type GigMediaPreviewDto,
  type GigMediaUploadDto,
  type ProviderGigMediaPolicy,
} from '@bananagig/contracts';
import { sql, type Database, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { ObjectStoreError, type PrivateObjectStore } from '@bananagig/platform';
import type { z } from 'zod';
import { isDatabaseOutage } from './errors';
import { GigError } from './gig-errors';
import { deleteMediaObjects, loadGigMedia, uploadKeyOf, writeMediaAudit } from './gig-media-model';
import type { Executor } from './gig-sql';
import type { DraftMutationContext, DraftMutator, GigMediaScanner, GigPolicyProvider } from './gig-types';

export interface GigMediaServiceDeps {
  database: Database;
  store: PrivateObjectStore;
  scanner: GigMediaScanner;
  policy: GigPolicyProvider;
  drafts: DraftMutator;
}

// ---------------------------------------------------------------- pure: image signatures and header dimensions
const ascii = (b: Uint8Array, at: number, text: string): boolean =>
  b.byteLength >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const le24 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const le32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The types this build can verify (their signature and header layout are known). Own keys only: an inherited name such as `constructor` is not a type. */
const VERIFIABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Pure: whether the first bytes are the signature of the declared image type (JPEG, PNG, WebP: `RIFF....WEBP`). false for any other type. */
export function matchesImageSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (typeof mimeType !== 'string' || !VERIFIABLE.has(mimeType)) return false;
  switch (mimeType) {
    case 'image/jpeg':
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.byteLength >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v);
    default:
      return bytes.byteLength >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');
  }
}

/** PNG: signature, then the IHDR chunk must come first (length 13) and hold the width and height (big endian). */
function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (!matchesImageSignature('image/png', b) || b.byteLength < 24) return null;
  if (be32(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return null;
  const width = be32(b, 16);
  const height = be32(b, 20);
  // the PNG specification caps both at 2^31 - 1 and forbids zero
  if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

/** JPEG: walk the marker segments until a start-of-frame (SOF0..SOF15 except DHT, JPG, DAC) carries the size. Stops at the start of the scan or the end of the image. */
function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (!matchesImageSignature('image/jpeg', b)) return null;
  let i = 2;
  while (i < b.byteLength) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // fill bytes
    const marker = b[i++];
    if (marker === undefined) return null;
    // markers without a length: TEM, RSTn, SOI, EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null; // EOI or SOS before any frame header (or a stuffed byte outside entropy data)
    if (i + 2 > b.byteLength) return null;
    const length = be16(b, i);
    if (length < 2 || i + length > b.byteLength) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length, precision (1), height (2), width (2), components (1) ...
      if (length < 8) return null;
      const precision = b[i + 2]!;
      const height = be16(b, i + 3);
      const width = be16(b, i + 5);
      const components = b[i + 7]!;
      // height 0 means "defined by a later DNL marker": not accepted (the size would be unknown to the header check)
      if (width < 1 || height < 1 || components < 1 || ![8, 12, 16].includes(precision)) return null;
      return { width, height };
    }
    i += length;
  }
  return null;
}

/** WebP: a RIFF container whose first chunk is VP8 (lossy), VP8L (lossless) or VP8X (extended); each stores the size differently, always in the first bytes of the chunk. */
function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (!matchesImageSignature('image/webp', b) || b.byteLength < 20) return null;
  // the declared container size must fit in what we have (a truncated file is not a well-formed image)
  if (le32(b, 4) + 8 > b.byteLength) return null;
  const chunkSize = le32(b, 16);
  const data = 20;
  if (chunkSize > b.byteLength - data) return null;
  if (ascii(b, 12, 'VP8X')) {
    if (chunkSize < 10) return null;
    return { width: le24(b, data + 4) + 1, height: le24(b, data + 7) + 1 };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (chunkSize < 5 || b[data] !== 0x2f) return null;
    const bits = le32(b, data + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8 ')) {
    if (chunkSize < 10) return null;
    const keyFrame = (b[data]! & 1) === 0;
    if (!keyFrame || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
    const width = (b[data + 6]! | (b[data + 7]! << 8)) & 0x3fff;
    const height = (b[data + 8]! | (b[data + 9]! << 8)) & 0x3fff;
    if (width < 1 || height < 1) return null;
    return { width, height };
  }
  return null;
}

/** Pure: the dimensions (width, height) read from the HEADER of a JPEG, PNG or WebP (never decoded), or null when the bytes are not a well-formed image of that type. */
export function readImageDimensions(mimeType: string, bytes: Uint8Array): { width: number; height: number } | null {
  if (typeof mimeType !== 'string' || !VERIFIABLE.has(mimeType)) return null;
  switch (mimeType) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    default:
      return webpDimensions(bytes);
  }
}

// ---------------------------------------------------------------- helpers
type Raw = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Where the verified bytes live. The asset id is the only variable part; it is minted by the server and never appears outside this file. */
const FINAL_PREFIX = 'provider/gig-media/';
const mimeOf = (contentType: string | undefined): string | undefined => contentType?.split(';')[0]?.trim().toLowerCase();
const SYSTEM_ACTOR = 'system:gig-media-cleanup';
/** How often a refusal retries its own bookkeeping when the draft revision moves under it. */
const ABANDON_ATTEMPTS = 3;

// ---------------------------------------------------------------- shared with the profile photo flow (PRO-002): the integrity pipeline and the object bookkeeping
/** The final object key of an asset (the database derives the same key and refuses any other). */
export const mediaFinalKey = (assetId: string): string => `${FINAL_PREFIX}${assetId}`;

/** The limits an upload is verified against. The profile photo flow passes the media policy with `maxFileSizeBytes` lowered to its own cap. */
export type MediaVerifyPolicy = Pick<
  ProviderGigMediaPolicy,
  'allowedMimeTypes' | 'maxFileSizeBytes' | 'minEdgePixels' | 'maxEdgePixels' | 'maxPixels' | 'requireCleanScan'
>;
/** What the pipeline needs to know of the asset row (never leaves the process). */
export interface MediaAssetFacts {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}
export interface MediaRefused {
  kind: 'refused';
  /** A reason code (MIME_NOT_ALLOWED, FILE_TOO_LARGE, OBJECT_MISSING, SIZE_MISMATCH, ...). */
  reason: string;
  scan?: 'INFECTED';
  /** false = the asset stays open (the browser may still be uploading); true = the caller abandons it. */
  closes: boolean;
}
export type MediaInspection =
  | MediaRefused
  | { kind: 'store-unavailable' }
  | { kind: 'scan-unavailable' }
  | { kind: 'verified'; bytes: Buffer; version: string; sha256: string; width: number; height: number; scanned: 'CLEAN' | 'ERROR' };

/**
 * The integrity checks of an upload, in the order CAT-004 defined them: policy (type, size), then ONE bounded versioned read of the UPLOAD key (existence, size, content type), signature,
 * header dimensions within the limits, the caller's SHA-256, then the scan. Pure of the database: the caller decides what a refusal does to its own rows. The object store is read ONCE.
 */
export async function inspectUpload(
  deps: { store: PrivateObjectStore; scanner: GigMediaScanner },
  asset: MediaAssetFacts,
  policy: MediaVerifyPolicy,
  expectedSha256?: string,
): Promise<MediaInspection> {
  const refusal = (reason: string, scan?: 'INFECTED', closes = true): MediaRefused => ({ kind: 'refused', reason, ...(scan ? { scan } : {}), closes });
  // the policy may have changed since the authorization: a type or size no longer allowed is refused
  if (!(policy.allowedMimeTypes as readonly string[]).includes(asset.mimeType)) return refusal('MIME_NOT_ALLOWED');
  if (asset.sizeBytes > policy.maxFileSizeBytes) return refusal('FILE_TOO_LARGE');

  const uploadKey = uploadKeyOf(asset.objectKey);
  let read: { bytes: Buffer; version: string } | null;
  try {
    const info = await deps.store.head(uploadKey);
    if (info === null) return refusal('OBJECT_MISSING', undefined, false); // not abandoned: the browser may still be uploading or may upload again
    if (info.size !== asset.sizeBytes) return refusal('SIZE_MISMATCH');
    if (mimeOf(info.contentType) !== asset.mimeType) return refusal('CONTENT_TYPE_MISMATCH');
    read = await deps.store.readVersioned(uploadKey, asset.sizeBytes);
  } catch (err) {
    if (err instanceof ObjectStoreError && err.code === 'TOO_LARGE') return refusal('SIZE_MISMATCH');
    if (err instanceof ObjectStoreError && err.code === 'CHANGED') return refusal('OBJECT_CHANGED');
    log('error', 'gig media object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    return { kind: 'store-unavailable' };
  }
  if (read === null) return refusal('OBJECT_MISSING', undefined, false);
  const { bytes } = read;
  if (bytes.byteLength !== asset.sizeBytes) return refusal('SIZE_MISMATCH');
  if (!matchesImageSignature(asset.mimeType, bytes)) return refusal('SIGNATURE_MISMATCH');
  // dimensions from the HEADER only (the image is never decoded): a decompression bomb is a small file with a huge claimed size
  const dims = readImageDimensions(asset.mimeType, bytes);
  if (dims === null) return refusal('IMAGE_INVALID');
  if (dims.width < policy.minEdgePixels || dims.height < policy.minEdgePixels) return refusal('IMAGE_TOO_SMALL');
  if (dims.width > policy.maxEdgePixels || dims.height > policy.maxEdgePixels || dims.width * dims.height > policy.maxPixels) return refusal('IMAGE_TOO_LARGE');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) return refusal('HASH_MISMATCH');

  let scanned: 'CLEAN' | 'INFECTED' | 'ERROR';
  try {
    scanned = (await deps.scanner.scan({ key: asset.objectKey, size: bytes.byteLength, bytes })).status;
  } catch {
    scanned = 'ERROR';
  }
  if (scanned === 'INFECTED') return refusal('SCAN_INFECTED', 'INFECTED');
  if (scanned === 'ERROR' && policy.requireCleanScan) return { kind: 'scan-unavailable' };
  return { kind: 'verified', bytes, version: read.version, sha256, width: dims.width, height: dims.height, scanned };
}

/**
 * PROMOTE: copies exactly the bytes that were hashed and scanned from the upload key to the final key (only while the upload object still has the version that was read), then checks what
 * landed there. After this nothing reads the upload key again: a replayed PUT can only write an object nobody reads.
 */
export async function promoteUpload(
  store: PrivateObjectStore,
  asset: MediaAssetFacts,
  read: { version: string },
  sha256: string,
): Promise<{ kind: 'promoted' } | MediaRefused | { kind: 'store-unavailable' }> {
  try {
    await store.copyIfVersion(uploadKeyOf(asset.objectKey), asset.objectKey, read.version);
    const landed = await store.read(asset.objectKey, asset.sizeBytes);
    if (landed === null || !createHash('sha256').update(landed).digest().equals(Buffer.from(sha256, 'hex')))
      return { kind: 'refused', reason: 'OBJECT_CHANGED', closes: true };
    return { kind: 'promoted' };
  } catch (err) {
    if (err instanceof ObjectStoreError && err.code === 'CHANGED') return { kind: 'refused', reason: 'OBJECT_CHANGED', closes: true };
    log('error', 'gig media object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    return { kind: 'store-unavailable' };
  }
}

/**
 * After two finalizations raced: compares the final object with the hash the winner recorded. A difference cannot be repaired here (the integrity window of a concurrent finalize plus a
 * replayed PUT is accepted debt); it is reported as a counts-only warning. Best effort, no lock.
 */
export async function verifyFinalObject(db: Executor, store: PrivateObjectStore, assetId: string, finalKey: string, size: number): Promise<void> {
  try {
    const recorded = (await sql<Raw>`SELECT sha256 FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid`.execute(db)).rows[0]?.sha256 as
      string | null | undefined;
    const landed = await store.read(finalKey, size);
    if (!recorded || landed === null || createHash('sha256').update(landed).digest('hex') !== recorded)
      log('warn', 'a gig photo final object differs from its recorded hash', { mismatches: 1 });
  } catch (e) {
    log('warn', 'could not verify a gig photo final object', { error: e instanceof Error ? e.name : 'unknown' });
  }
}

/** Records that the objects of terminal assets are gone; returns how many rows were marked (the ones whose authorization has ended). Best effort. */
export async function markObjectsRemoved(db: Executor, finalKeys: readonly string[]): Promise<number> {
  try {
    return Number(
      (
        await sql<Raw>`WITH m AS (
            UPDATE provider.media_assets SET objects_removed_at = now()
             WHERE object_key = ANY(${[...finalKeys]}::text[]) AND status IN ('ABANDONED', 'DELETED') AND objects_removed_at IS NULL AND upload_expires_at <= now()
            RETURNING 1)
          SELECT count(*) AS n FROM m`.execute(db)
      ).rows[0]!.n,
    );
  } catch (e) {
    log('warn', 'could not record the removal of gig photo objects', { error: e instanceof Error ? e.name : 'unknown' });
    return 0;
  }
}
/** Records that the upload object of READY assets is gone (once their authorization has ended). */
export async function markUploadKeysRemoved(db: Executor, finalKeys: readonly string[]): Promise<number> {
  try {
    return Number(
      (
        await sql<Raw>`WITH m AS (
            UPDATE provider.media_assets SET upload_key_removed_at = now()
             WHERE object_key = ANY(${[...finalKeys]}::text[]) AND status = 'READY' AND upload_key_removed_at IS NULL AND upload_expires_at <= now()
            RETURNING 1)
          SELECT count(*) AS n FROM m`.execute(db)
      ).rows[0]!.n,
    );
  } catch (e) {
    log('warn', 'could not record the removal of gig photo upload objects', { error: e instanceof Error ? e.name : 'unknown' });
    return 0;
  }
}
/** After the commit that abandoned or deleted these assets: deletes the final and the upload object of each final key, then records `objects_removed_at`. A failed deletion leaves it NULL (the clean-up repeats it). */
export async function removeAssetObjects(db: Executor, store: PrivateObjectStore, finalKeys: readonly string[]): Promise<boolean> {
  if (finalKeys.length === 0) return true;
  const ok = await deleteMediaObjects(
    store,
    finalKeys.flatMap((k) => [k, uploadKeyOf(k)]),
  );
  if (ok) await markObjectsRemoved(db, finalKeys);
  return ok;
}

const notFoundMedia = () => new GigError('MEDIA_NOT_FOUND', 'the photo was not found', {});
const refused = (reason: string) => new GigError('MEDIA_REFUSED', 'the file did not match what was described', { reason });
const stale = () => new GigError('STALE_DRAFT', 'the draft changed since it was read: read it again', { reason: 'STALE_DRAFT' });
const storeDown = (): GigError => new GigError('UNAVAILABLE', 'photos are unavailable', { reason: 'MEDIA_STORE_UNAVAILABLE' });
/** An object-store failure as the typed error the callers speak: the cause is logged by name only (never a key, a URL or the driver's text). */
const storeUnavailable = (err: unknown): GigError => {
  log('error', 'gig media object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
  return new GigError('UNAVAILABLE', 'photos are unavailable', { reason: 'MEDIA_STORE_UNAVAILABLE' });
};

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new GigError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof first?.path[0] === 'string' ? first.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}
const mediaIssue = (reason: GigIssueReason, itemKey?: string, fieldKey?: string): GigIssueDto => ({
  target: 'media',
  ...(fieldKey === undefined ? {} : { fieldKey }),
  ...(itemKey === undefined ? {} : { itemKey }),
  reason,
  messageKey: gigIssueKey(reason),
});
const invalid = (...issues: GigIssueDto[]) => new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: 'MEDIA_INVALID', issues });

/** The alt text as stored: plain single-line text, NFC, no markup; blank is no alt text. Returns the issue instead of the text when it is refused. */
function altTextOf(raw: string | null, max: number, itemKey?: string): { ok: true; value: string | null } | { ok: false; issue: GigIssueDto } {
  if (raw === null) return { ok: true, value: null };
  const n = normalizeProviderText(raw, { multiline: false });
  if (!n.ok) return { ok: false, issue: mediaIssue(n.reason, itemKey) };
  if (n.value === '') return { ok: true, value: null };
  if (textLength(n.value) > max) return { ok: false, issue: mediaIssue('MEDIA_ALT_TOO_LONG', itemKey) };
  return { ok: true, value: n.value };
}

interface OwnedAttachment {
  mediaId: string;
  gigVersionId: string;
  versionStatus: string;
  versionNumber: number;
  assetId: string;
  assetStatus: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  /** Whether the authorization window has ended, by the DATABASE clock. */
  expired: boolean;
}

/** What `cleanup` did, as counts. */
export interface GigMediaCleanupResult {
  /** Unfinished uploads closed (expired, or stuck on a retired Gig). */
  abandoned: number;
  /** Unreferenced READY photos removed after the grace period. */
  deleted: number;
  /** Assets whose stored objects were confirmed removed by the reconciliation passes (terminal assets, and the upload keys of READY ones). */
  reconciled: number;
}

export class GigMediaService {
  constructor(protected readonly deps: GigMediaServiceDeps) {}

  private get db() {
    return this.deps.database.db;
  }
  /** Reads outside a transaction: only an outage of the database is translated; the callers speak GigError and nothing else. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GigError) && isDatabaseOutage(e)) {
        log('error', 'gig media database unavailable', { error: e instanceof Error ? e.name : 'unknown' });
        throw new GigError('UNAVAILABLE', 'photos are unavailable', { reason: 'MEDIA_DATABASE_UNAVAILABLE' });
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ objects
  /**
   * After the commit that abandoned or deleted these assets: deletes the final and the upload object of each final key, then records `objects_removed_at` (only once the upload
   * authorization has ended, because a presigned PUT could still recreate the upload object before that). A failed deletion leaves the column NULL: the clean-up repeats it.
   */
  private async removeObjects(finalKeys: readonly string[]): Promise<boolean> {
    return removeAssetObjects(this.db, this.deps.store, finalKeys);
  }
  private async markObjectsRemoved(finalKeys: readonly string[]): Promise<number> {
    return markObjectsRemoved(this.db, finalKeys);
  }
  private async markUploadKeysRemoved(finalKeys: readonly string[]): Promise<number> {
    return markUploadKeysRemoved(this.db, finalKeys);
  }

  /** The attachment of the account's Gig (never by id alone): MEDIA_NOT_FOUND for an unknown one, one of another account's Gig, or one of another Gig. */
  private async ownedAttachment(accountId: string, gigId: string, mediaId: string): Promise<OwnedAttachment> {
    if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw notFoundMedia();
    const r = (
      await this.read(() =>
        sql<Raw>`SELECT m.gig_version_media_id, m.gig_version_id, v.status AS version_status, v.version_number, a.media_asset_id, a.status AS asset_status,
               a.object_key, a.mime_type, a.size_bytes, (a.upload_expires_at <= now()) AS expired
          FROM provider.gig_version_media m
          JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
          JOIN provider.gigs g ON g.gig_id = v.gig_id
          JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
         WHERE m.gig_version_media_id = ${mediaId}::uuid AND g.gig_id = ${gigId}::uuid AND g.account_id = ${accountId}::uuid`.execute(this.db),
      )
    ).rows[0];
    if (!r) throw notFoundMedia();
    return {
      mediaId: r.gig_version_media_id as string,
      gigVersionId: r.gig_version_id as string,
      versionStatus: r.version_status as string,
      versionNumber: Number(r.version_number),
      assetId: r.media_asset_id as string,
      assetStatus: r.asset_status as string,
      objectKey: r.object_key as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
      expired: r.expired === true,
    };
  }
  private async assetStatus(assetId: string): Promise<string | undefined> {
    return this.read(
      async () =>
        (await sql<Raw>`SELECT status FROM provider.media_assets WHERE media_asset_id = ${assetId}::uuid`.execute(this.db)).rows[0]?.status as
          string | undefined,
    );
  }

  /** The detail of the draft at its CURRENT revision, without changing anything (the idempotent answer of a repeated call). */
  private async currentDetail(accountId: string, gigId: string): Promise<GigDetailDto> {
    for (let attempt = 0; ; attempt++) {
      const ctx = await this.deps.drafts.readDraft(accountId, gigId);
      try {
        return (await this.deps.drafts.mutateDraft(accountId, gigId, ctx.draft.revision, async () => ({ changed: false, value: null }))).detail;
      } catch (e) {
        if (!(e instanceof GigError && e.code === 'STALE_DRAFT') || attempt >= ABANDON_ATTEMPTS) throw e;
      }
    }
  }

  // ------------------------------------------------------------------ authorize
  /** Authorizes ONE upload for a MEDIA field of the draft's exact template version; reserves the last place in the draft (an UPLOADING attachment) and raises the draft revision. */
  async requestUpload(accountId: string, gigId: string, input: unknown): Promise<{ upload: GigMediaUploadDto; detail: GigDetailDto }> {
    const body = parseInput(RequestGigMediaUploadRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.media();
    // the owner's draft first: a foreign or unknown Gig answers 404 whatever the body says
    const pre = await this.deps.drafts.readDraft(accountId, gigId);
    if (pre.draft.revision !== body.expectedRevision) throw stale();
    if (!(policy.allowedMimeTypes as readonly string[]).includes(body.mimeType)) throw refused('MIME_NOT_ALLOWED');
    if (body.sizeBytes > policy.maxFileSizeBytes) throw refused('FILE_TOO_LARGE');
    const field = pre.structure.fields.find((f) => f.fieldKey === body.fieldKey && f.fieldType === 'MEDIA');
    if (!field) throw invalid(mediaIssue('MEDIA_FIELD_UNKNOWN', undefined, body.fieldKey));
    if (field.maxItems === 0 || field.behavior === 'PLATFORM_FIXED') throw invalid(mediaIssue('MEDIA_NOT_PERMITTED', undefined, field.fieldKey));
    const alt = altTextOf(body.altText, policy.altTextMaxLength);
    if (!alt.ok) throw invalid(alt.issue);

    // the asset id is minted and the upload URL signed BEFORE the transaction: signing is the store's work, and a store failure must not happen while locks are held
    const assetId = randomUUID();
    const finalKey = `${FINAL_PREFIX}${assetId}`;
    let upload;
    try {
      upload = await this.deps.store.createUploadUrl({
        key: uploadKeyOf(finalKey),
        contentType: body.mimeType,
        contentLength: body.sizeBytes,
        ttlSeconds: policy.uploadTtlSeconds,
      });
    } catch (err) {
      throw storeUnavailable(err);
    }

    const staleKeys: string[] = [];
    const { value, detail } = await this.deps.drafts.mutateDraft(accountId, gigId, body.expectedRevision, async (ctx) => {
      const trx = ctx.trx;
      staleKeys.length = 0;
      // expired, never-finalized authorizations of THIS draft are closed first (they count toward the caps; their objects go after the commit)
      const expired = (
        await sql<Raw>`SELECT m.gig_version_media_id, a.media_asset_id, a.object_key
          FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
         WHERE m.gig_version_id = ${ctx.draft.gigVersionId}::uuid AND a.status = 'UPLOAD_PENDING' AND a.upload_expires_at <= now()
         ORDER BY m.display_order FOR UPDATE OF m, a`.execute(trx)
      ).rows;
      for (const x of expired) {
        await sql`DELETE FROM provider.gig_version_media WHERE gig_version_media_id = ${x.gig_version_media_id as string}::uuid`.execute(trx);
        await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${x.media_asset_id as string}::uuid`.execute(
          trx,
        );
        staleKeys.push(x.object_key as string);
        await writeMediaAudit(trx, cid, {
          accountId,
          action: 'GIG_MEDIA_UPLOAD_REFUSED',
          gigId,
          gigVersionId: ctx.draft.gigVersionId,
          changes: { mediaId: x.gig_version_media_id, versionNumber: ctx.draft.versionNumber, reason: 'UPLOAD_EXPIRED' },
        });
      }
      const rows = (await loadGigMedia(trx, [ctx.draft.gigVersionId])).get(ctx.draft.gigVersionId) ?? [];
      const inField = rows.filter((r) => r.fieldKey === field.fieldKey).length;
      if (field.maxItems !== null && inField >= field.maxItems) throw invalid(mediaIssue('MEDIA_TOO_MANY', undefined, field.fieldKey));
      if (rows.length >= policy.maxItems) throw invalid(mediaIssue('MEDIA_TOTAL_EXCEEDED'));

      // the authorization window is written with the DATABASE clock
      await sql`INSERT INTO provider.media_assets (media_asset_id, account_id, object_key, mime_type, size_bytes, upload_expires_at)
        VALUES (${assetId}::uuid, ${accountId}::uuid, ${finalKey}, ${body.mimeType}, ${body.sizeBytes}::bigint, now() + make_interval(secs => ${policy.uploadTtlSeconds}::double precision))`.execute(
        trx,
      );
      const inserted = (
        await sql<Raw>`INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order, alt_text)
          VALUES (${ctx.draft.gigVersionId}::uuid, ${assetId}::uuid, ${field.gigTemplateFieldId}::uuid,
                  (SELECT COALESCE(max(display_order), 0) + 1 FROM provider.gig_version_media WHERE gig_version_id = ${ctx.draft.gigVersionId}::uuid), ${alt.value})
          RETURNING gig_version_media_id, display_order`.execute(trx)
      ).rows[0]!;
      const mediaId = inserted.gig_version_media_id as string;
      await writeMediaAudit(trx, cid, {
        accountId,
        action: 'GIG_MEDIA_UPLOAD_AUTHORIZED',
        gigId,
        gigVersionId: ctx.draft.gigVersionId,
        changes: { mediaId, versionNumber: ctx.draft.versionNumber, mediaCount: rows.length + 1, revision: [ctx.draft.revision, ctx.draft.revision + 1] },
      });
      return { changed: true, value: { mediaId, displayOrder: Number(inserted.display_order), revision: ctx.draft.revision + 1 } };
    });
    // the transaction committed: only now the objects of the closed authorizations go
    await this.removeObjects(staleKeys);
    const dto: GigMediaUploadDto = {
      media: {
        mediaId: value.mediaId,
        fieldKey: field.fieldKey,
        displayOrder: value.displayOrder,
        status: 'UPLOADING',
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        width: null,
        height: null,
        altText: alt.value,
      },
      upload: { url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() },
      maxSizeBytes: policy.maxFileSizeBytes,
      revision: detail.draftVersion?.revision ?? value.revision,
    };
    return { upload: dto, detail };
  }

  // ------------------------------------------------------------------ refuse
  /**
   * Refuses an upload for good: the attachment leaves the draft, the asset becomes ABANDONED (with the scan verdict when that was the reason), the objects are deleted and the refusal is
   * audited by reason code. Only the transaction that actually moved the asset deletes objects. A failure here never replaces the refusal the caller is about to report.
   */
  private async abandon(accountId: string, gigId: string, mediaId: string, reason: string, scan?: 'INFECTED'): Promise<void> {
    const cid = getCorrelationId() ?? randomUUID();
    try {
      for (let attempt = 0; attempt < ABANDON_ATTEMPTS; attempt++) {
        const ctx = await this.deps.drafts.readDraft(accountId, gigId);
        let key: string | null = null;
        try {
          await this.deps.drafts.mutateDraft(accountId, gigId, ctx.draft.revision, async (c) => {
            const gone = await this.removePending(c, cid, mediaId, 'GIG_MEDIA_UPLOAD_REFUSED', { reason }, scan);
            key = gone;
            return { changed: gone !== null, value: null };
          });
        } catch (e) {
          if (e instanceof GigError && e.code === 'STALE_DRAFT') continue;
          throw e;
        }
        if (key) await this.removeObjects([key]);
        return;
      }
    } catch (e) {
      log('warn', 'could not close a refused gig photo upload', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  /**
   * Inside a draft mutation: removes an UPLOADING attachment of the draft and abandons its asset. Returns the object key to delete after the commit, or null when the attachment is not
   * (or no longer) an unfinished upload of this draft.
   */
  private async removePending(
    ctx: DraftMutationContext,
    cid: string,
    mediaId: string,
    action: 'GIG_MEDIA_UPLOAD_REFUSED' | 'GIG_MEDIA_DETACHED',
    extra: Record<string, unknown>,
    scan?: 'INFECTED',
  ): Promise<string | null> {
    const r = (
      await sql<Raw>`SELECT m.gig_version_media_id, a.media_asset_id, a.object_key, a.status
        FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
       WHERE m.gig_version_media_id = ${mediaId}::uuid AND m.gig_version_id = ${ctx.draft.gigVersionId}::uuid FOR UPDATE OF m, a`.execute(ctx.trx)
    ).rows[0];
    if (!r || r.status !== 'UPLOAD_PENDING') return null;
    await sql`DELETE FROM provider.gig_version_media WHERE gig_version_media_id = ${mediaId}::uuid`.execute(ctx.trx);
    await sql`UPDATE provider.media_assets SET status = 'ABANDONED', scan_status = COALESCE(${scan ?? null}, scan_status), updated_at = now()
      WHERE media_asset_id = ${r.media_asset_id as string}::uuid`.execute(ctx.trx);
    await writeMediaAudit(ctx.trx, cid, {
      accountId: ctx.accountId,
      action,
      gigId: ctx.gigId,
      gigVersionId: ctx.draft.gigVersionId,
      changes: { mediaId, versionNumber: ctx.draft.versionNumber, ...extra },
    });
    return r.object_key as string;
  }

  // ------------------------------------------------------------------ finalize
  /** Verifies the stored object (exists, size, content type, signature, dimensions within the limits, SHA-256), scans it, promotes exactly those bytes and marks the asset READY. Idempotent. */
  async finalize(accountId: string, gigId: string, mediaId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(FinalizeGigMediaRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.media();
    const pre = await this.deps.drafts.readDraft(accountId, gigId);
    const owned = await this.ownedAttachment(accountId, gigId, mediaId);
    // an attachment that is not in the editable draft is, for this caller, not there
    if (owned.gigVersionId !== pre.draft.gigVersionId) throw notFoundMedia();
    if (owned.assetStatus === 'READY') return this.currentDetail(accountId, gigId);
    if (owned.assetStatus !== 'UPLOAD_PENDING') throw notFoundMedia();
    if (pre.draft.revision !== body.expectedRevision) throw stale();
    if (owned.expired) {
      await this.abandon(accountId, gigId, mediaId, 'UPLOAD_EXPIRED');
      throw new GigError('MEDIA_EXPIRED', 'the upload took too long', { reason: 'UPLOAD_EXPIRED' });
    }
    // A refusal. If a concurrent finalization already made the photo READY (this call lost the race: the winner also deleted the upload object, so this one sees it missing, changed or
    // different), the photo succeeded and that is the answer; the asset is never abandoned from under a finished photo.
    const gone = async (reason: string, scan?: 'INFECTED', closes = true): Promise<GigDetailDto> => {
      if ((await this.assetStatus(owned.assetId)) === 'READY') return this.currentDetail(accountId, gigId);
      if (closes) await this.abandon(accountId, gigId, mediaId, reason, scan);
      throw refused(reason);
    };
    // the shared integrity pipeline (type and size policy, one bounded versioned read, signature, header dimensions, hash, scan): see inspectUpload
    const inspected = await inspectUpload(this.deps, owned, policy, body.sha256);
    if (inspected.kind === 'refused') return gone(inspected.reason, inspected.scan, inspected.closes);
    if (inspected.kind === 'store-unavailable') throw storeDown();
    if (inspected.kind === 'scan-unavailable')
      throw new GigError('MEDIA_SCAN_UNAVAILABLE', 'we could not check the file right now', { reason: 'SCAN_UNAVAILABLE', retryable: true });
    const { sha256, version } = inspected;
    const dims = { width: inspected.width, height: inspected.height };
    const scanned = inspected.scanned;
    const uploadKey = uploadKeyOf(owned.objectKey);

    // someone else may have finished (or closed) this upload while the bytes were being checked: do not write over a finished asset
    const state = await this.assetStatus(owned.assetId);
    if (state === 'READY') return this.currentDetail(accountId, gigId);
    if (state !== 'UPLOAD_PENDING') throw notFoundMedia();

    // PROMOTE: copy exactly the bytes that were hashed and scanned to the final key and stop reading the upload key (see promoteUpload)
    const promoted = await promoteUpload(this.deps.store, owned, { version }, sha256);
    if (promoted.kind === 'refused') return gone(promoted.reason, promoted.scan, promoted.closes);
    if (promoted.kind === 'store-unavailable') throw storeDown();

    let detail: GigDetailDto;
    let outcome: 'attached' | 'already';
    try {
      const r = await this.deps.drafts.mutateDraft(accountId, gigId, body.expectedRevision, async (ctx) => {
        const a = (
          await sql<Raw>`SELECT a.status FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
           WHERE m.gig_version_media_id = ${mediaId}::uuid AND m.gig_version_id = ${ctx.draft.gigVersionId}::uuid FOR UPDATE OF a`.execute(ctx.trx)
        ).rows[0];
        if (!a) throw notFoundMedia();
        if (a.status === 'READY') return { changed: false, value: 'already' as const };
        if (a.status !== 'UPLOAD_PENDING') throw notFoundMedia();
        await sql`UPDATE provider.media_assets SET status = 'READY', sha256 = ${sha256}, width = ${dims.width}::integer, height = ${dims.height}::integer,
            scan_status = ${scanned}, ready_at = now(), updated_at = now() WHERE media_asset_id = ${owned.assetId}::uuid`.execute(ctx.trx);
        await writeMediaAudit(ctx.trx, cid, {
          accountId,
          action: 'GIG_MEDIA_ATTACHED',
          gigId,
          gigVersionId: ctx.draft.gigVersionId,
          changes: { mediaId, versionNumber: ctx.draft.versionNumber, scanStatus: scanned, revision: [ctx.draft.revision, ctx.draft.revision + 1] },
        });
        return { changed: true, value: 'attached' as const };
      });
      detail = r.detail;
      outcome = r.value;
    } catch (e) {
      // two finalizations of the same upload race: the revision the loser sent is stale, but the photo is READY, which is what it asked for.
      // The promoted copy is NOT deleted on a failed transaction: it may be the very object the winner just made READY; an unfinished asset's objects go with the asset (abandon, clean-up).
      if (e instanceof GigError && e.code === 'STALE_DRAFT' && (await this.assetStatus(owned.assetId)) === 'READY') {
        await this.verifyFinal(owned.assetId, owned.objectKey, owned.sizeBytes);
        return this.currentDetail(accountId, gigId);
      }
      throw e;
    }
    // this call promoted bytes but another one made the photo READY: check, without a lock, that the final object is still what the winner recorded
    if (outcome === 'already') await this.verifyFinal(owned.assetId, owned.objectKey, owned.sizeBytes);
    else if (await deleteMediaObjects(this.deps.store, [uploadKey])) await this.markUploadKeysRemoved([owned.objectKey]);
    return detail;
  }

  private async verifyFinal(assetId: string, finalKey: string, size: number): Promise<void> {
    await verifyFinalObject(this.db, this.deps.store, assetId, finalKey, size);
  }

  // ------------------------------------------------------------------ edit the draft's photos
  async updateAltText(accountId: string, gigId: string, mediaId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(UpdateGigMediaRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.media();
    await this.deps.drafts.readDraft(accountId, gigId);
    if (!UUID.test(mediaId)) throw notFoundMedia();
    const alt = altTextOf(body.altText, policy.altTextMaxLength, mediaId);
    if (!alt.ok) throw invalid(alt.issue);
    return (
      await this.deps.drafts.mutateDraft(accountId, gigId, body.expectedRevision, async (ctx) => {
        const r = (
          await sql<Raw>`SELECT alt_text FROM provider.gig_version_media WHERE gig_version_media_id = ${mediaId}::uuid AND gig_version_id = ${ctx.draft.gigVersionId}::uuid FOR UPDATE`.execute(
            ctx.trx,
          )
        ).rows[0];
        if (!r) throw notFoundMedia();
        if (((r.alt_text as string | null) ?? null) === alt.value) return { changed: false, value: null };
        await sql`UPDATE provider.gig_version_media SET alt_text = ${alt.value}, updated_at = now() WHERE gig_version_media_id = ${mediaId}::uuid`.execute(
          ctx.trx,
        );
        await writeMediaAudit(ctx.trx, cid, {
          accountId,
          action: 'GIG_MEDIA_UPDATED',
          gigId,
          gigVersionId: ctx.draft.gigVersionId,
          changes: { mediaId, versionNumber: ctx.draft.versionNumber, altTextSet: alt.value !== null, revision: [ctx.draft.revision, ctx.draft.revision + 1] },
        });
        return { changed: true, value: null };
      })
    ).detail;
  }

  async reorder(accountId: string, gigId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(ReorderGigMediaRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    await this.deps.drafts.readDraft(accountId, gigId);
    return (
      await this.deps.drafts.mutateDraft(accountId, gigId, body.expectedRevision, async (ctx) => {
        const current = (
          await sql<Raw>`SELECT gig_version_media_id, display_order FROM provider.gig_version_media WHERE gig_version_id = ${ctx.draft.gigVersionId}::uuid
            ORDER BY display_order FOR UPDATE`.execute(ctx.trx)
        ).rows.map((r) => ({ id: r.gig_version_media_id as string, order: Number(r.display_order) }));
        const wanted = new Set(body.mediaIds.map((m) => m.toLowerCase()));
        if (current.length !== body.mediaIds.length || current.some((c) => !wanted.has(c.id))) throw invalid(mediaIssue('MEDIA_ORDER_INVALID'));
        const ids = body.mediaIds.map((m) => m.toLowerCase());
        if (current.every((c, i) => c.id === ids[i] && c.order === i + 1)) return { changed: false, value: null };
        // ONE statement numbers the whole list 1..n. The unique (version, order) key is DEFERRABLE INITIALLY IMMEDIATE, which PostgreSQL checks at the end of the statement, so
        // the intermediate states of a swap are never seen.
        await sql`UPDATE provider.gig_version_media m SET display_order = o.ord::integer, updated_at = now()
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id, ord) WHERE m.gig_version_media_id = o.id AND m.gig_version_id = ${ctx.draft.gigVersionId}::uuid`.execute(
          ctx.trx,
        );
        await writeMediaAudit(ctx.trx, cid, {
          accountId,
          action: 'GIG_MEDIA_REORDERED',
          gigId,
          gigVersionId: ctx.draft.gigVersionId,
          changes: { versionNumber: ctx.draft.versionNumber, mediaCount: current.length, revision: [ctx.draft.revision, ctx.draft.revision + 1] },
        });
        return { changed: true, value: null };
      })
    ).detail;
  }

  /** Detaches a photo of the DRAFT (the attachment is removed; the asset stays until the reference-aware clean-up). An unfinished upload is abandoned and its objects deleted. */
  async detach(accountId: string, gigId: string, mediaId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(DetachGigMediaRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    await this.deps.drafts.readDraft(accountId, gigId);
    if (!UUID.test(mediaId)) throw notFoundMedia();
    let key: string | null = null;
    const { detail } = await this.deps.drafts.mutateDraft(accountId, gigId, body.expectedRevision, async (ctx) => {
      key = null;
      const r = (
        await sql<Raw>`SELECT a.status FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
         WHERE m.gig_version_media_id = ${mediaId}::uuid AND m.gig_version_id = ${ctx.draft.gigVersionId}::uuid`.execute(ctx.trx)
      ).rows[0];
      if (!r) throw notFoundMedia();
      if (r.status === 'UPLOAD_PENDING') {
        key = await this.removePending(ctx, cid, mediaId, 'GIG_MEDIA_DETACHED', { abandoned: true, revision: [ctx.draft.revision, ctx.draft.revision + 1] });
        if (key === null) throw notFoundMedia();
        return { changed: true, value: null };
      }
      await sql`DELETE FROM provider.gig_version_media WHERE gig_version_media_id = ${mediaId}::uuid`.execute(ctx.trx);
      await writeMediaAudit(ctx.trx, cid, {
        accountId,
        action: 'GIG_MEDIA_DETACHED',
        gigId,
        gigVersionId: ctx.draft.gigVersionId,
        changes: { mediaId, versionNumber: ctx.draft.versionNumber, abandoned: false, revision: [ctx.draft.revision, ctx.draft.revision + 1] },
      });
      return { changed: true, value: null };
    });
    if (key) await this.removeObjects([key]);
    return detail;
  }

  // ------------------------------------------------------------------ preview
  /** A short-lived one-object GET target for a READY photo of ANY version of the owner's Gig. */
  async preview(accountId: string, gigId: string, versionNumber: number | null, mediaId: string): Promise<GigMediaPreviewDto> {
    if (typeof gigId !== 'string' || !UUID.test(gigId)) throw new GigError('GIG_NOT_FOUND', 'the Gig was not found', {});
    if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw notFoundMedia();
    const policy = await this.deps.policy.media();
    const version = (
      await this.read(() =>
        sql<Raw>`SELECT v.gig_version_id FROM provider.gigs g
          LEFT JOIN provider.gig_versions v ON v.gig_id = g.gig_id AND ${versionNumber === null ? sql`v.status = 'DRAFT'` : sql`v.version_number = ${versionNumber}::integer`}
         WHERE g.gig_id = ${gigId}::uuid AND g.account_id = ${accountId}::uuid`.execute(this.db),
      )
    ).rows[0];
    if (!version) throw new GigError('GIG_NOT_FOUND', 'the Gig was not found', {});
    if (version.gig_version_id === null)
      throw versionNumber === null
        ? new GigError('NO_DRAFT', 'the Gig has no draft', { reason: 'NO_DRAFT' })
        : new GigError('GIG_VERSION_NOT_FOUND', 'the Gig version was not found', {});
    const r = (
      await this.read(() =>
        sql<Raw>`SELECT a.status, a.scan_status, a.object_key, a.mime_type FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
         WHERE m.gig_version_media_id = ${mediaId}::uuid AND m.gig_version_id = ${version.gig_version_id as string}::uuid`.execute(this.db),
      )
    ).rows[0];
    // an unfinished upload has no bytes worth showing; a file accepted without a clean verdict is not shown once clean scans are required
    if (!r || r.status !== 'READY' || (policy.requireCleanScan && r.scan_status !== 'CLEAN')) throw notFoundMedia();
    try {
      const d = await this.deps.store.createDownloadUrl({
        key: r.object_key as string,
        ttlSeconds: policy.downloadTtlSeconds,
        contentType: r.mime_type as string,
        disposition: 'inline',
      });
      return { url: d.url, expiresAt: d.expiresAt.toISOString() };
    } catch (err) {
      throw storeUnavailable(err);
    }
  }

  // ------------------------------------------------------------------ clean-up
  /**
   * Clean-up (a scheduled job). Reference-aware and reconciling; the bytes of an asset any attachment references (of any version) are never touched. The passes:
   *  (a) UPLOAD_PENDING assets past their authorization are abandoned (their draft attachment leaves the draft, the objects go);
   *  (e) UPLOAD_PENDING assets whose attachments are ALL on RETIRED versions (a Gig retired with a photo in flight) are abandoned;
   *  (b) READY assets that NO attachment references, READY for longer than the grace period, are marked DELETED and their objects deleted;
   *  (c) terminal assets (ABANDONED, DELETED) whose objects were not confirmed removed get their objects deleted again (a store outage, or a PUT that recreated the upload object);
   *  (d) READY assets whose upload authorization has ended and whose upload object was not removed yet lose that object (this also removes bytes a replayed PUT recreated);
   *  (f) PRO-002: UPLOAD_PENDING profile photos past their authorization lose the profile's pending pointer and are abandoned. A profile reference (photo_asset_id or
   *      pending_photo_asset_id) counts as a reference everywhere above: (b) never deletes a photo a profile shows or is finishing.
   * Every transaction follows the lock order of the service (account, Gig, version, asset); a row someone else holds is left for the next run. `limit` applies to each pass.
   * Returns counts only; logs carry counts only.
   */
  async cleanup(opts: { limit: number }): Promise<GigMediaCleanupResult> {
    const limit = Math.max(1, Math.min(Math.trunc(opts.limit), 1000));
    const policy = await this.deps.policy.media();
    const cid = getCorrelationId() ?? randomUUID();
    let abandoned = 0;
    let deleted = 0;
    let reconciled = 0;
    let failed = 0;
    /** Runs one step; a transaction returns the final key to clean up after its commit (or null when it did nothing). */
    const attempt = async (fn: () => Promise<string | null>): Promise<boolean> => {
      try {
        const key = await fn();
        if (key === null) return false;
        await this.removeObjects([key]);
        return true;
      } catch (e) {
        if (isDatabaseOutage(e)) throw e;
        failed++;
        log('warn', 'a gig photo clean-up step failed', { error: e instanceof Error ? e.name : 'unknown' });
        return false;
      }
    };
    const candidates = (query: () => Promise<{ rows: Raw[] }>) => this.read(async () => (await query()).rows);

    // (a) expired uploads (a pending photo on a frozen version is left to pass (e))
    for (const c of await candidates(() =>
      sql<Raw>`SELECT a.media_asset_id, a.account_id FROM provider.media_assets a
        WHERE a.status = 'UPLOAD_PENDING' AND a.upload_expires_at <= now()
          AND NOT EXISTS (SELECT 1 FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
                           WHERE m.media_asset_id = a.media_asset_id AND v.status <> 'DRAFT')
          AND NOT EXISTS (SELECT 1 FROM provider.public_profiles p WHERE p.pending_photo_asset_id = a.media_asset_id)
        ORDER BY a.upload_expires_at LIMIT ${limit}::integer`.execute(this.db),
    ))
      if (await attempt(() => this.abandonPending(c.media_asset_id as string, c.account_id as string, cid, 'EXPIRED'))) abandoned++;

    // (f) expired profile photo uploads (PRO-002): the profile's pending pointer is cleared first, then the asset is closed
    for (const c of await candidates(() =>
      sql<Raw>`SELECT a.media_asset_id, a.account_id FROM provider.media_assets a
        WHERE a.status = 'UPLOAD_PENDING' AND a.upload_expires_at <= now()
          AND EXISTS (SELECT 1 FROM provider.public_profiles p WHERE p.pending_photo_asset_id = a.media_asset_id)
        ORDER BY a.upload_expires_at LIMIT ${limit}::integer`.execute(this.db),
    ))
      if (await attempt(() => this.abandonProfilePending(c.media_asset_id as string, c.account_id as string, cid))) abandoned++;

    // (e) pending uploads stuck on RETIRED versions
    for (const c of await candidates(() =>
      sql<Raw>`SELECT a.media_asset_id, a.account_id FROM provider.media_assets a
        WHERE a.status = 'UPLOAD_PENDING'
          AND EXISTS (SELECT 1 FROM provider.gig_version_media m WHERE m.media_asset_id = a.media_asset_id)
          AND NOT EXISTS (SELECT 1 FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
                           WHERE m.media_asset_id = a.media_asset_id AND v.status <> 'RETIRED')
        ORDER BY a.updated_at LIMIT ${limit}::integer`.execute(this.db),
    ))
      if (await attempt(() => this.abandonPending(c.media_asset_id as string, c.account_id as string, cid, 'RETIRED'))) abandoned++;

    // (b) unreferenced READY assets after the grace period
    for (const c of await candidates(() =>
      sql<Raw>`SELECT a.media_asset_id, a.account_id FROM provider.media_assets a
        WHERE a.status = 'READY' AND a.ready_at <= now() - make_interval(secs => ${policy.orphanGraceSeconds}::double precision)
          AND NOT EXISTS (SELECT 1 FROM provider.gig_version_media m WHERE m.media_asset_id = a.media_asset_id)
          AND NOT EXISTS (SELECT 1 FROM provider.public_profiles p WHERE p.photo_asset_id = a.media_asset_id OR p.pending_photo_asset_id = a.media_asset_id)
        ORDER BY a.ready_at LIMIT ${limit}::integer`.execute(this.db),
    ))
      if (await attempt(() => this.deleteOrphan(c.media_asset_id as string, c.account_id as string, policy))) deleted++;

    // (c) terminal assets whose objects are not confirmed removed
    for (const c of await candidates(() =>
      sql<Raw>`SELECT object_key FROM provider.media_assets
        WHERE status IN ('ABANDONED', 'DELETED') AND objects_removed_at IS NULL ORDER BY updated_at LIMIT ${limit}::integer`.execute(this.db),
    )) {
      const key = c.object_key as string;
      if (await deleteMediaObjects(this.deps.store, [key, uploadKeyOf(key)])) reconciled += await this.markObjectsRemoved([key]);
    }

    // (d) the upload objects of READY assets once their authorization has ended
    for (const c of await candidates(() =>
      sql<Raw>`SELECT object_key FROM provider.media_assets
        WHERE status = 'READY' AND upload_key_removed_at IS NULL AND upload_expires_at <= now() ORDER BY upload_expires_at LIMIT ${limit}::integer`.execute(
        this.db,
      ),
    )) {
      const key = c.object_key as string;
      if (await deleteMediaObjects(this.deps.store, [uploadKeyOf(key)])) reconciled += await this.markUploadKeysRemoved([key]);
    }

    if (failed > 0) log('warn', 'gig photo clean-up finished with failures', { failed, abandoned, deleted, reconciled });
    return { abandoned, deleted, reconciled };
  }

  /** Locks the account row without waiting (a provider mid-request is simply left for the next run). */
  private async lockAccountIfFree(trx: Trx, accountId: string): Promise<boolean> {
    return (
      (await sql<Raw>`SELECT account_id FROM identity.accounts WHERE account_id = ${accountId}::uuid FOR UPDATE SKIP LOCKED`.execute(trx)).rows.length === 1
    );
  }

  /**
   * One unfinished upload, in one transaction (account, Gigs, versions, then the asset, all without waiting). EXPIRED: the authorization has ended and every attachment is on a DRAFT, which
   * loses it (the draft revision rises). RETIRED: every attachment is on a RETIRED version; those attachments are frozen history and stay, the asset is closed. Returns the final key to
   * clean up after the commit, or null when the asset is no longer in that state (or is busy).
   */
  private async abandonPending(assetId: string, accountId: string, cid: string, why: 'EXPIRED' | 'RETIRED'): Promise<string | null> {
    return this.deps.database.transaction(async (trx) => {
      if (!(await this.lockAccountIfFree(trx, accountId))) return null;
      const attached = (
        await sql<Raw>`SELECT m.gig_version_media_id, v.gig_version_id, v.gig_id, v.status, v.version_number
          FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
         WHERE m.media_asset_id = ${assetId}::uuid`.execute(trx)
      ).rows;
      const gigIds = [...new Set(attached.map((x) => x.gig_id as string))].sort();
      const versionIds = [...new Set(attached.map((x) => x.gig_version_id as string))].sort();
      if (gigIds.length > 0) await sql`SELECT gig_id FROM provider.gigs WHERE gig_id = ANY(${gigIds}::uuid[]) ORDER BY gig_id FOR UPDATE`.execute(trx);
      if (versionIds.length > 0)
        await sql`SELECT gig_version_id FROM provider.gig_versions WHERE gig_version_id = ANY(${versionIds}::uuid[]) ORDER BY gig_version_id FOR UPDATE`.execute(
          trx,
        );
      const a = (
        await sql<Raw>`SELECT object_key FROM provider.media_assets
          WHERE media_asset_id = ${assetId}::uuid AND status = 'UPLOAD_PENDING' AND (${why === 'RETIRED'} OR upload_expires_at <= now()) FOR UPDATE SKIP LOCKED`.execute(
          trx,
        )
      ).rows[0];
      // the versions were locked above: their state is current
      const fresh = (
        versionIds.length === 0
          ? []
          : (await sql<Raw>`SELECT gig_version_id, status FROM provider.gig_versions WHERE gig_version_id = ANY(${versionIds}::uuid[])`.execute(trx)).rows
      ).map((v) => v.status as string);
      const required = why === 'EXPIRED' ? 'DRAFT' : 'RETIRED';
      if (!a || (why === 'RETIRED' && attached.length === 0) || fresh.some((s) => s !== required)) return null;
      for (const x of attached) {
        if (why === 'EXPIRED') {
          await sql`DELETE FROM provider.gig_version_media WHERE gig_version_media_id = ${x.gig_version_media_id as string}::uuid`.execute(trx);
          await sql`UPDATE provider.gig_versions SET revision = revision + 1, updated_at = now() WHERE gig_version_id = ${x.gig_version_id as string}::uuid AND status = 'DRAFT'`.execute(
            trx,
          );
        }
        await writeMediaAudit(trx, cid, {
          accountId,
          actor: SYSTEM_ACTOR,
          action: 'GIG_MEDIA_UPLOAD_REFUSED',
          gigId: x.gig_id as string,
          gigVersionId: x.gig_version_id as string,
          changes: { mediaId: x.gig_version_media_id, versionNumber: Number(x.version_number), reason: why === 'EXPIRED' ? 'UPLOAD_EXPIRED' : 'GIG_RETIRED' },
        });
      }
      await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${assetId}::uuid`.execute(trx);
      return a.object_key as string;
    });
  }

  /**
   * One expired profile photo upload, in one transaction (account, profile, then the asset, all without waiting): the profile's pending pointer is cleared (the revision rises: the owner's
   * view changed) and the asset is abandoned. This is a PENDING-POINTER-ONLY change, like the authorization of an upload: the revision rises and one audit row is written (by field NAME only), but NO `profile-updated`
   * outbox event is emitted, because nothing a customer sees changed (the same `publicChange: false` rule as ProfilePhotoService). Returns the final key to clean up after the commit, or null when nothing was to do (or the rows are busy).
   */
  private async abandonProfilePending(assetId: string, accountId: string, cid: string): Promise<string | null> {
    return this.deps.database.transaction(async (trx) => {
      if (!(await this.lockAccountIfFree(trx, accountId))) return null;
      const p = (
        await sql<Raw>`SELECT public_profile_id, revision FROM provider.public_profiles
          WHERE pending_photo_asset_id = ${assetId}::uuid FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows[0];
      if (!p) return null;
      const a = (
        await sql<Raw>`SELECT object_key FROM provider.media_assets
          WHERE media_asset_id = ${assetId}::uuid AND status = 'UPLOAD_PENDING' AND upload_expires_at <= now() FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows[0];
      if (!a) return null;
      const revision = Number(p.revision);
      await sql`UPDATE provider.public_profiles SET pending_photo_asset_id = NULL, revision = revision + 1, updated_at = now()
        WHERE public_profile_id = ${p.public_profile_id as string}::uuid`.execute(trx);
      await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${assetId}::uuid`.execute(trx);
      await sql`INSERT INTO provider.profile_audit_events (actor, action, account_id, public_profile_id, changes, correlation_id)
        VALUES (${SYSTEM_ACTOR}, 'PROVIDER_PROFILE_PHOTO_CHANGED', ${accountId}::uuid, ${p.public_profile_id as string}::uuid,
                ${JSON.stringify({ changedFields: ['photo'], revision: [revision, revision + 1], reason: 'UPLOAD_EXPIRED' })}::jsonb, ${cid})`.execute(trx);
      return a.object_key as string;
    });
  }

  /** One unreferenced READY asset, in one transaction. The re-check under the asset lock is what makes an attach and the sweep unable to race. */
  private async deleteOrphan(assetId: string, accountId: string, policy: ProviderGigMediaPolicy): Promise<string | null> {
    return this.deps.database.transaction(async (trx) => {
      if (!(await this.lockAccountIfFree(trx, accountId))) return null;
      const a = (
        await sql<Raw>`SELECT a.object_key FROM provider.media_assets a
          WHERE a.media_asset_id = ${assetId}::uuid AND a.status = 'READY' AND a.ready_at <= now() - make_interval(secs => ${policy.orphanGraceSeconds}::double precision)
            AND NOT EXISTS (SELECT 1 FROM provider.gig_version_media m WHERE m.media_asset_id = a.media_asset_id)
            AND NOT EXISTS (SELECT 1 FROM provider.public_profiles p WHERE p.photo_asset_id = a.media_asset_id OR p.pending_photo_asset_id = a.media_asset_id)
          FOR UPDATE OF a SKIP LOCKED`.execute(trx)
      ).rows[0];
      if (!a) return null;
      await sql`UPDATE provider.media_assets SET status = 'DELETED', updated_at = now() WHERE media_asset_id = ${assetId}::uuid`.execute(trx);
      return a.object_key as string;
    });
  }
}
