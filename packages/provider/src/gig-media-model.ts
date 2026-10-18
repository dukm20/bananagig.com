// Media of a Gig version (CAT-004): the row shapes, the pure rules and the SQL reads/copy that the Gig service uses to build a version, validate a publish and start the next draft.
// A photo is an ATTACHMENT (provider.gig_version_media: version, template MEDIA field, order, alt text) of an ASSET (provider.media_assets: account-owned bytes, immutable once READY).
// Nothing here ever reads or returns an object key, a hash or an asset id to a caller: the rows keep the asset id only so the service can lock it.
import { gigIssueKey, type GigIssueDto, type GigIssueReason, type GigMediaDto, type ProviderGigMediaPolicy } from '@bananagig/contracts';
import { sql, type Trx } from '@bananagig/database';
import { log } from '@bananagig/observability';
import { ObjectStoreError, type PrivateObjectStore } from '@bananagig/platform';
import type { Executor } from './gig-sql';
import type { GigTemplateFieldFacts, GigTemplateStructure } from './gig-types';

/** One attachment with the facts of its asset (never the object key or the hash outside the service). */
export interface GigMediaRow {
  /** The attachment id (the API's `mediaId`). */
  mediaId: string;
  gigVersionId: string;
  assetId: string;
  gigTemplateFieldId: string;
  fieldKey: string;
  displayOrder: number;
  altText: string | null;
  /** The asset state: UPLOAD_PENDING (not verified yet) or READY (verified, promoted). Any other asset state reads as not ready. */
  assetStatus: 'UPLOAD_PENDING' | 'READY';
  /** The scan verdict of a READY asset: CLEAN, or ERROR when the file was accepted without a clean verdict (only while clean scans are not required). */
  scanStatus: 'PENDING' | 'CLEAN' | 'ERROR';
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRow(r: Raw): GigMediaRow {
  const scan = r.scan_status as string;
  return {
    mediaId: r.gig_version_media_id as string,
    gigVersionId: r.gig_version_id as string,
    assetId: r.media_asset_id as string,
    gigTemplateFieldId: r.gig_template_field_id as string,
    fieldKey: r.field_key as string,
    displayOrder: Number(r.display_order),
    altText: (r.alt_text as string | null) ?? null,
    assetStatus: r.status === 'READY' ? 'READY' : 'UPLOAD_PENDING',
    scanStatus: scan === 'CLEAN' ? 'CLEAN' : scan === 'ERROR' ? 'ERROR' : 'PENDING',
    mimeType: (r.mime_type as string | null) ?? null,
    sizeBytes: num(r.size_bytes),
    width: num(r.width),
    height: num(r.height),
  };
}

/** One query: the attachments of the given versions (all statuses), ordered by (version, display order). */
export async function loadGigMedia(ex: Executor, versionIds: readonly string[]): Promise<Map<string, GigMediaRow[]>> {
  const out = new Map<string, GigMediaRow[]>(versionIds.map((id) => [id, []]));
  if (versionIds.length === 0) return out;
  const rows = (
    await sql<Raw>`SELECT m.gig_version_media_id, m.gig_version_id, m.media_asset_id, m.gig_template_field_id, f.field_key, m.display_order, m.alt_text,
           a.status, a.scan_status, a.mime_type, a.size_bytes, a.width, a.height
      FROM provider.gig_version_media m
      JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
      JOIN catalog.gig_template_fields f ON f.gig_template_field_id = m.gig_template_field_id
     WHERE m.gig_version_id = ANY(${[...versionIds]}::uuid[])
     ORDER BY m.gig_version_id, m.display_order`.execute(ex)
  ).rows;
  for (const r of rows) {
    const row = toRow(r);
    (out.get(row.gigVersionId) ?? out.set(row.gigVersionId, []).get(row.gigVersionId)!).push(row);
  }
  return out;
}

/** The API view of the attachments (UPLOADING while the asset is not READY). No key, no hash, no asset id. */
export function toMediaDtos(rows: readonly GigMediaRow[]): GigMediaDto[] {
  return [...rows]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((r) => ({
      mediaId: r.mediaId,
      fieldKey: r.fieldKey,
      displayOrder: r.displayOrder,
      status: r.assetStatus === 'READY' ? ('READY' as const) : ('UPLOADING' as const),
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      width: r.assetStatus === 'READY' ? r.width : null,
      height: r.assetStatus === 'READY' ? r.height : null,
      altText: r.altText,
    }));
}

const mediaIssue = (reason: GigIssueReason, extra: { fieldKey?: string; itemKey?: string } = {}): GigIssueDto => ({
  target: 'media',
  ...(extra.fieldKey === undefined ? {} : { fieldKey: extra.fieldKey }),
  ...(extra.itemKey === undefined ? {} : { itemKey: extra.itemKey }),
  reason,
  messageKey: gigIssueKey(reason),
});

/** Whether a photo may count as a delivered one: its asset is READY and, when clean scans are required, the verdict is CLEAN. */
const usable = (r: GigMediaRow, policy: ProviderGigMediaPolicy): boolean => r.assetStatus === 'READY' && (!policy.requireCleanScan || r.scanStatus === 'CLEAN');
const mediaFields = (s: GigTemplateStructure): GigTemplateFieldFacts[] =>
  s.fields.filter((f) => f.fieldType === 'MEDIA').sort((a, b) => a.displayOrder - b.displayOrder);

/** The per-field rules (minimum for a required field, maximum, prohibition) shared by the publish check and the menu fact. */
function fieldRuleIssues(rows: readonly GigMediaRow[], structure: GigTemplateStructure, policy: ProviderGigMediaPolicy): GigIssueDto[] {
  const issues: GigIssueDto[] = [];
  for (const f of mediaFields(structure)) {
    const mine = rows.filter((r) => r.fieldKey === f.fieldKey);
    if (f.maxItems === 0) {
      if (mine.length > 0) issues.push(mediaIssue('MEDIA_NOT_PERMITTED', { fieldKey: f.fieldKey }));
      continue;
    }
    if (f.maxItems !== null && mine.length > f.maxItems) issues.push(mediaIssue('MEDIA_TOO_MANY', { fieldKey: f.fieldKey }));
    if (f.behavior === 'PROVIDER_REQUIRED' && mine.filter((r) => usable(r, policy)).length < (f.minItems ?? 1))
      issues.push(mediaIssue('MEDIA_REQUIRED', { fieldKey: f.fieldKey }));
  }
  return issues;
}

/**
 * The publish rules for the media of a version against the EXACT template version: for each MEDIA field the READY photos must reach `minItems` (PROVIDER_REQUIRED) and not exceed
 * `maxItems`; a field with `maxItems = 0` takes none; the total must not exceed the configured maximum; no attachment may be unfinished (UPLOADING). Identifiers only.
 */
export function mediaIssues(rows: readonly GigMediaRow[], structure: GigTemplateStructure, policy: ProviderGigMediaPolicy): GigIssueDto[] {
  const issues: GigIssueDto[] = [];
  const known = new Set(mediaFields(structure).map((f) => f.fieldKey));
  const ordered = [...rows].sort((a, b) => a.displayOrder - b.displayOrder);
  for (const r of ordered) {
    if (!known.has(r.fieldKey)) issues.push(mediaIssue('MEDIA_FIELD_UNKNOWN', { fieldKey: r.fieldKey, itemKey: r.mediaId }));
    else if (!usable(r, policy)) issues.push(mediaIssue('MEDIA_NOT_READY', { fieldKey: r.fieldKey, itemKey: r.mediaId }));
  }
  issues.push(...fieldRuleIssues(ordered, structure, policy));
  if (rows.length > policy.maxItems) issues.push(mediaIssue('MEDIA_TOTAL_EXCEEDED'));
  return issues;
}

/** Facts for the GigMenu and PRO-003: the READY count and whether the template version's media requirement is satisfied (true when it has no MEDIA field). */
export function mediaSummary(
  rows: readonly GigMediaRow[],
  structure: GigTemplateStructure,
  policy: ProviderGigMediaPolicy,
): { mediaCount: number; mediaRequirementSatisfied: boolean } {
  return {
    mediaCount: rows.filter((r) => r.assetStatus === 'READY').length,
    mediaRequirementSatisfied: fieldRuleIssues(rows, structure, policy).length === 0,
  };
}

/**
 * Starts the next draft: attaches the SAME READY assets (no binary copy) to the new draft version with the same field, order and alt text. Unfinished uploads are not copied.
 * Runs inside the caller's transaction; returns the number of attachments copied.
 */
export async function copyGigMedia(trx: Executor, fromVersionId: string, toVersionId: string): Promise<number> {
  const r = await sql<Raw>`WITH ins AS (
      INSERT INTO provider.gig_version_media (gig_version_id, media_asset_id, gig_template_field_id, display_order, alt_text)
      SELECT ${toVersionId}::uuid, m.media_asset_id, m.gig_template_field_id, (row_number() OVER (ORDER BY m.display_order))::integer, m.alt_text
        FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
       WHERE m.gig_version_id = ${fromVersionId}::uuid AND a.status = 'READY'
      RETURNING 1)
    SELECT count(*) AS n FROM ins`.execute(trx);
  return Number(r.rows[0]!.n);
}

// ---------------------------------------------------------------- object keys and their removal (shared by the media service and the Gig service's retire)
/** Where the provider's bytes arrive: a SEPARATE key from the final one (LRN-0056). The final key is `provider/gig-media/<asset id>`; the asset row stores it. */
export const uploadKeyOf = (finalKey: string): string => `${finalKey}.upload`;
const actorOf = (accountId: string): string => `account:${accountId}`;

/**
 * Deletes exactly the given object keys from the private store: idempotent (a missing object is not an error), best effort (a failure is logged by kind, counts only, never with a key and
 * never thrown) and it MARKS NOTHING in the database. Returns true when every key is gone or was never there. The media clean-up finds assets whose objects were not confirmed removed
 * (`objects_removed_at IS NULL`) and repeats the deletion, so a failed attempt here is repaired later.
 */
export async function deleteMediaObjects(store: PrivateObjectStore, keys: readonly string[]): Promise<boolean> {
  let failed = 0;
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (err) {
      failed++;
      log('warn', 'could not delete a gig photo object', { error: err instanceof ObjectStoreError ? err.code : 'unknown' });
    }
  }
  if (failed > 0) log('warn', 'gig photo objects left for the clean-up', { failed, total: keys.length });
  return failed === 0;
}

/**
 * Inside the caller's transaction (the Gig and the DRAFT version are locked, the version is still a DRAFT): removes every UPLOAD_PENDING attachment of the version, ABANDONS its asset
 * and audits `GIG_MEDIA_UPLOAD_REFUSED` with the reason code `GIG_RETIRED` (ids and the code only). Returns the object keys (the final key and the upload key of each asset) the caller
 * deletes AFTER the commit with `deleteMediaObjects`; the clean-up repairs a failed deletion. Used by the Gig service when it retires a Gig.
 */
export async function closePendingMediaOfDraft(trx: Trx, c: { accountId: string; gigId: string; versionId: string; cid: string }): Promise<string[]> {
  const rows = (
    await sql<Raw>`SELECT m.gig_version_media_id, a.media_asset_id, a.object_key, v.version_number
      FROM provider.gig_version_media m
      JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id
      JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
     WHERE m.gig_version_id = ${c.versionId}::uuid AND a.status = 'UPLOAD_PENDING'
     ORDER BY m.display_order FOR UPDATE OF m, a`.execute(trx)
  ).rows;
  const keys: string[] = [];
  for (const r of rows) {
    // the attachment first: the database refuses to abandon an asset an attachment still references
    await sql`DELETE FROM provider.gig_version_media WHERE gig_version_media_id = ${r.gig_version_media_id as string}::uuid`.execute(trx);
    await sql`UPDATE provider.media_assets SET status = 'ABANDONED', updated_at = now() WHERE media_asset_id = ${r.media_asset_id as string}::uuid`.execute(
      trx,
    );
    await writeMediaAudit(trx, c.cid, {
      accountId: c.accountId,
      action: 'GIG_MEDIA_UPLOAD_REFUSED',
      gigId: c.gigId,
      gigVersionId: c.versionId,
      changes: { mediaId: r.gig_version_media_id, versionNumber: Number(r.version_number), reason: 'GIG_RETIRED' },
    });
    keys.push(r.object_key as string, uploadKeyOf(r.object_key as string));
  }
  return keys;
}

/** One audit row of a media change: identifiers, counts and reason codes only (never a name, an alt text, a key, a URL or a hash). */
export function writeMediaAudit(
  trx: Executor,
  cid: string,
  a: { accountId: string; action: string; gigId: string; gigVersionId: string; changes: Record<string, unknown>; actor?: string },
) {
  return sql`INSERT INTO provider.gig_audit_events (actor, action, account_id, gig_id, gig_version_id, changes, correlation_id)
    VALUES (${a.actor ?? actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.gigId}, ${a.gigVersionId}, ${JSON.stringify(a.changes)}::jsonb, ${cid})`.execute(
    trx,
  );
}
