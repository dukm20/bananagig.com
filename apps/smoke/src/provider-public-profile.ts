// Smoke scenario 'Provider public profile' (PRO-002), end to end with REAL Keycloak tokens, THROWAWAY customer-only identities (created through the Keycloak admin API and deleted at the
// end) that become providers through the REAL flows (contacts, registration, consent, submit), an isolated DEV/TEST market (ZZ) with its own taxonomy and Gig Template, the real private
// object store (SeaweedFS, one-object presigned PUT), the DEV/TEST fake scanner, read-only SELECTs on the database and Loki.
//
// What it proves (the 19 steps of the checkpoint): the owner journey (create, display name, bio, photo, preview, visibility), the derived projection (fallback `First L.` name, trust badges from
// an APPROVED requirement and their disappearance when the approval expires, ACTIVE published Gigs only), the anonymous public read and the public photo, a deep scan of every public
// response for private data, GPS/EXIF stripped from the SERVED photo while the stored original keeps it, IDOR against a second provider, trust detail staying private, Go-Live never evaluated,
// no BananaDrop data and no ratings, la-oc untouched, and the audit trail, outbox and logs holding no private profile field.
//
// Assumptions (checked against the real implementation by the lead after the images are rebuilt; this scenario has NOT run against a live stack when it was written):
//  - routes under /api/v1/provider/profile[...] (owner, no-store) and /api/v1/providers/{publicProfileId}[/photo] (public, no auth) as listed in the PRO-002 spec; wire error codes from
//    `profileWireCode`; 404 NOT_FOUND, 409 STALE_PROFILE, 400 VALIDATION_FAILED and MEDIA_REFUSED;
//  - database objects of migration 0024: provider.public_profiles (public_profile_id, account_id, display_name, bio, photo_asset_id, pending_photo_asset_id, visibility_status, published_at,
//    revision), provider.media_assets.purpose, provider.profile_audit_events (account_id, action, changes);
//  - the seeded profile policy (display name 60, bio 1000, photo 2 MiB, bio and photo NOT required, badge types IDENTITY/BACKGROUND_CHECK/INSURANCE, marketplace eligibility not required);
//  - DATABASE_URL (read-only SELECTs), LOKI_URL, MAILPIT_URL, VALKEY_URL, KEYCLOAK_ADMIN*, S3_ENDPOINT reachable from this container, TRUST_SCANNER=fake and the realm roles of admin.dev.
// The audit trail and the outbox have no owner-visible surface, so they are read with SELECTs (not through an API); the stored object itself cannot be fetched from here (no store
// credentials), so "the stored original keeps its EXIF/GPS" is proved by the server-computed SHA-256 of the stored asset being the hash of the GPS-carrying file we uploaded.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ACTIVE_ROLE_HEADER,
  AccountResponse,
  ConsentRequirementsResponse,
  CORRELATION_HEADER,
  GigDetailResponse,
  OwnerProfileStateResponse,
  PreviewProviderProfileResponse,
  PROFILE_AUDIT_ACTIONS,
  PROFILE_FIELD_NAMES,
  ProfilePhotoUploadResponse,
  profileErrorKey,
  profileIssueKey,
  profileWireCode,
  PublicProviderProfileResponse,
  type ProfileErrorCode,
  type ProfileIssueReason,
} from '@bananagig/contracts';
import { createDatabase } from '@bananagig/database';
import { Redis } from 'iovalkey';

/** What the scenario borrows from the smoke entry point (index.ts runs top-level code, so it cannot be imported from here). */
export interface SmokeContext {
  api: string;
  kcUrl: string;
  /** A real authorization-code login against Keycloak (the DEV/TEST scripted PKCE helper of index.ts); returns the access token. */
  loginAs(client: 'web' | 'admin', creds: { username: string; password: string }): Promise<string>;
  /** The DEV/TEST administrator (admin.dev). */
  adminCreds: { username: string; password: string };
  /** The fake SMS sink (DEV/TEST only) and the code extractor: those helpers live in testing packages that only index.ts may import. */
  openSmsInbox(valkey: Redis): { clear(e164: string): Promise<unknown>; wait(e164: string, count: number, timeoutMs: number): Promise<{ body: string }[]> };
  extractSmsCode(body: string): string | null | undefined;
  env(key: string, fallback: string): string;
  get(url: string, init?: RequestInit): Promise<Response>;
  retry<T>(fn: () => Promise<T>, tries?: number, delay?: number): Promise<T>;
  sleep(ms: number): Promise<unknown>;
  expectOk(url: string, init?: RequestInit): Promise<Response>;
  clearLimiterBuckets(prefix: string): Promise<void>;
  ensureDevtestGeography(admin: string): Promise<void>;
  kcMasterToken(): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed response bodies are untyped JSON that each step checks field by field
type Json = any;
type Reply = { status: number; text: string; json: Json; headers: Headers };
type Raw = { status: number; headers: Headers; bytes: Buffer };

// ---------------------------------------------------------------- synthetic DEV/TEST image with GPS EXIF (never a real photo)
const be16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const jpegSeg = (marker: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
/** A little-endian TIFF block with IFD0 (description, make, ORIENTATION 6, GPS pointer) and a GPS IFD (latitude and longitude with references). */
const exifTiff = (tag: string): Buffer => {
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const entry = (t: number, type: number, count: number, value: Buffer): Buffer =>
    Buffer.concat([u16(t), u16(type), u32(count), value.length === 4 ? value : Buffer.concat([value, Buffer.alloc(4 - value.length)])]);
  const desc = Buffer.from(`GPSDESC-${tag}\0`, 'latin1');
  const make = Buffer.from(`SmokeCam-${tag}\0`, 'latin1');
  const ifdLen = 2 + 4 * 12 + 4;
  const descOff = 8 + ifdLen;
  const makeOff = descOff + desc.length;
  const gpsOff = makeOff + make.length;
  const latOff = gpsOff + ifdLen;
  const lonOff = latOff + 24;
  const rational3 = (vals: [number, number][]): Buffer => Buffer.concat(vals.flatMap(([n, d]) => [u32(n), u32(d)]));
  const ifd0 = Buffer.concat([
    u16(4),
    entry(0x010e, 2, desc.length, u32(descOff)),
    entry(0x010f, 2, make.length, u32(makeOff)),
    entry(0x0112, 3, 1, Buffer.concat([u16(6), Buffer.alloc(2)])),
    entry(0x8825, 4, 1, u32(gpsOff)),
    u32(0),
  ]);
  const gps = Buffer.concat([
    u16(4),
    entry(1, 2, 2, Buffer.from('N\0', 'latin1')),
    entry(2, 5, 3, u32(latOff)),
    entry(3, 2, 2, Buffer.from('W\0', 'latin1')),
    entry(4, 5, 3, u32(lonOff)),
    u32(0),
  ]);
  return Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    u32(8),
    ifd0,
    desc,
    make,
    gps,
    rational3([
      [33, 1],
      [40, 1],
      [1250, 100],
    ]),
    rational3([
      [117, 1],
      [52, 1],
      [3000, 100],
    ]),
  ]);
};
/**
 * A valid baseline grayscale JPEG (as the Gig media smoke builds, every 8x8 block is "DC difference 0, end of block") that ALSO carries: JFIF, an EXIF APP1 with GPS and an ORIENTATION of 6,
 * a COM comment and trailing bytes after the end-of-image marker. `edge` must be a multiple of 16.
 */
const synthJpegWithGps = (edge: number, tag: string): Buffer => {
  const counts = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSeg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    jpegSeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(tag)])),
    jpegSeg(0xfe, Buffer.from(`COMMENT-${tag}`, 'latin1')),
    jpegSeg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    jpegSeg(0xc0, Buffer.from([8, edge >> 8, edge & 255, edge >> 8, edge & 255, 1, 1, 0x11, 0])),
    jpegSeg(0xc4, Buffer.concat([Buffer.from([0x00]), counts, Buffer.from([0])])),
    jpegSeg(0xc4, Buffer.concat([Buffer.from([0x10]), counts, Buffer.from([0])])),
    jpegSeg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    Buffer.alloc(((edge / 8) * (edge / 8)) / 4, 0),
    Buffer.from([0xff, 0xd9]),
    Buffer.from(`TRAILER-${tag}`, 'latin1'),
  ]);
};
type JpegSegment = { marker: number; payload: Buffer };
/** A tolerant container walk (no decoding): the segments before the scan, the offset of the scan, and where the end-of-image marker ends (-1 when there is none). */
const parseJpeg = (b: Buffer): { segs: JpegSegment[]; scanStart: number; eoiEnd: number } => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG (no start-of-image marker)');
  const segs: JpegSegment[] = [];
  let scanStart = -1;
  let eoiEnd = -1;
  let i = 2;
  while (i < b.length - 1) {
    if (b[i] !== 0xff) throw new Error(`JPEG: expected a marker at ${i}`);
    while (b[i + 1] === 0xff) i++;
    const m = b[i + 1]!;
    if (m === 0xd9) {
      eoiEnd = i + 2;
      break;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    segs.push({ marker: m, payload: b.subarray(i + 4, i + 2 + len) });
    if (m === 0xda) {
      scanStart = i;
      let j = i + 2 + len;
      while (j < b.length - 1 && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1]! >= 0xd0 && b[j + 1]! <= 0xd7))) j++;
      i = j;
      continue;
    }
    i += 2 + len;
  }
  return { segs, scanStart, eoiEnd };
};
/** The tag numbers of IFD0 of an EXIF APP1 payload, its ORIENTATION and whether another IFD follows. */
const exifTags = (payload: Buffer): { tags: number[]; orientation: number | null; hasNextIfd: boolean } => {
  const t = payload.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number): number => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number): number => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const base = u32(4);
  const count = u16(base);
  const tags: number[] = [];
  let orientation: number | null = null;
  for (let k = 0; k < count; k++) {
    const at = base + 2 + k * 12;
    const tag = u16(at);
    tags.push(tag);
    if (tag === 0x0112) orientation = u16(at + 8);
  }
  return { tags, orientation, hasNextIfd: u32(base + 2 + count * 12) !== 0 };
};
const sof = (b: Buffer): { width: number; height: number } => {
  const s = parseJpeg(b).segs.find((x) => x.marker >= 0xc0 && x.marker <= 0xc3);
  if (!s) throw new Error('JPEG: no start-of-frame segment');
  return { height: s.payload.readUInt16BE(1), width: s.payload.readUInt16BE(3) };
};

// ---------------------------------------------------------------- the scenario
export async function providerPublicProfileScenario(ctx: SmokeContext): Promise<string> {
  const {
    api,
    kcUrl,
    loginAs,
    adminCreds,
    openSmsInbox,
    extractSmsCode,
    env,
    get,
    retry,
    sleep,
    expectOk,
    clearLimiterBuckets,
    ensureDevtestGeography,
    kcMasterToken,
  } = ctx;
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(what);
  };
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cid = `smoke-profile-${runId}`;
  const cidPublic = `smoke-profile-public-${runId}`;
  const flowStart = Date.now() * 1e6;
  const marketCode = `devtest-prof-${runId}`;
  const categoryCode = `devtest_profc_${runId}`;
  const serviceType = `devtest_profs_${runId}`;
  const tpl = `devtest_prof_${runId}`;
  const key = (suffix: string): string => `catalog.gig_template.${tpl}.${suffix}`;
  const mailpit = env('MAILPIT_URL', 'http://mailpit-email:8025');
  const loki = env('LOKI_URL', 'http://loki-logs:3100');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% BananaGig DEV/TEST synthetic evidence ${label} ${runId}\n%%EOF\n`, 'latin1');

  // the provider text of this run (plain text, unique per run: it is searched for in the audit trail, the outbox and the logs)
  const legalA = { first: 'Quinn', last: 'Vandersloot' };
  const legalB = { first: 'Robin', last: 'Wetherington' };
  const fallbackA = 'Quinn V.';
  const displayNfd = `Cafe${String.fromCodePoint(0x301)} Smoke ${runId}`; // typed in NFD ...
  const displayName = `Caf${String.fromCodePoint(0xe9)} Smoke ${runId}`; // ... stored and shown in NFC
  const bio = `We wash cars with care ${runId}.\nSecond line of the bio ${runId}.`;
  const gigText = {
    a: { title: `Smoke Wash ${runId}`, pitch: `Smoke pitch ${runId}`, desc: `Smoke description ${runId}.` },
    retired: { title: `Smoke Retired ${runId}`, pitch: `Retired pitch ${runId}`, desc: `Retired description ${runId}.` },
    draft: { title: `Smoke Draft ${runId}`, pitch: `Draft pitch ${runId}`, desc: `Draft description ${runId}.` },
    edit: { title: `Smoke Draft Edit ${runId}`, pitch: `Edit pitch ${runId}`, desc: `Edit description ${runId}.` },
  };
  const variantNames = [`Basic ${runId}`, `Deluxe ${runId}`];
  const addOnName = `Wax ${runId}`;

  // ---------------------------------------------------------------- HTTP helpers
  const request = async (
    path: string,
    method: string,
    token: string | null,
    body?: unknown,
    o: { cid?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> => {
    const r = await get(`${api}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [CORRELATION_HEADER]: o.cid ?? cid,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.headers ?? {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json, headers: r.headers };
  };
  const requestRaw = async (path: string, token: string | null, o: { cid?: string; headers?: Record<string, string> } = {}): Promise<Raw> => {
    const r = await get(`${api}/api/v1${path}`, {
      method: 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), [CORRELATION_HEADER]: o.cid ?? cid, ...(o.headers ?? {}) },
    });
    return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
  };
  type Parser = { safeParse(v: unknown): Json };
  /** An expected success whose body must match the published contract. Returns the `data` member. */
  const read = (schema: Parser, r: Reply, status: number | number[], what: string): Json => {
    const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
    assert(ok, `${what} -> ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`);
    const p = schema.safeParse(r.json);
    if (!p.success) throw new Error(`${what}: the response does not match its contract: ${String(p.error?.message).slice(0, 400)}`);
    return p.data.data;
  };
  const sameError = (r: Reply): string => {
    const e = r.json?.error ?? {};
    return JSON.stringify([r.status, e.code, e.category, e.message, e.details ?? null]); // everything but the per-request correlation id
  };
  const refusal = (r: Reply, status: number, code: ProfileErrorCode, what: string): Reply => {
    assert(
      r.status === status && r.json?.error?.code === profileWireCode(code),
      `${what}: expected ${status} ${profileWireCode(code)}, got ${r.status} ${r.json?.error?.code ?? r.text.slice(0, 160)} ${r.json?.error?.details?.reason ?? ''}`,
    );
    const mk = r.json.error.details?.messageKey;
    if (mk !== undefined) assert(mk === profileErrorKey(code), `${what}: the message key ${mk} does not belong to ${code}`);
    return r;
  };
  const hasIssue = (r: Reply, reason: ProfileIssueReason): boolean =>
    Array.isArray(r.json?.error?.details?.issues) &&
    r.json.error.details.issues.some((i: Json) => i.reason === reason && (i.messageKey === undefined || i.messageKey === profileIssueKey(reason)));
  const seenOwner: string[] = []; // every OWNER profile response (body and headers), except the one-time upload authorizations (they hold a signed URL by design)
  const owner = async (method: string, path: string, token: string | null, body?: unknown, keep = true): Promise<Reply> => {
    const r = await request(`/provider/profile${path}`, method, token, body);
    if (keep) seenOwner.push(r.text, JSON.stringify([...r.headers]));
    assert(
      r.headers.get('cache-control') === 'no-store',
      `${method} /provider/profile${path}: every owner response must be Cache-Control: no-store (${r.status})`,
    );
    return r;
  };
  const publicSeen: { label: string; text: string; headers: string; bytes?: Buffer }[] = []; // every PUBLIC response, scanned at the end of step 13
  const publicJson = async (id: string, token: string | null = null, extra: Record<string, string> = {}): Promise<Reply> => {
    const r = await request(`/providers/${id}`, 'GET', token, undefined, { cid: cidPublic, headers: extra });
    publicSeen.push({ label: `GET /providers/${id === 'x' ? 'x' : ':id'} -> ${r.status}`, text: r.text, headers: JSON.stringify([...r.headers]) });
    return r;
  };
  const publicPhoto = async (id: string, token: string | null = null, extra: Record<string, string> = {}): Promise<Raw> => {
    const r = await requestRaw(`/providers/${id}/photo`, token, { cid: cidPublic, headers: extra });
    publicSeen.push({ label: `GET /providers/:id/photo -> ${r.status}`, text: '', headers: JSON.stringify([...r.headers]), bytes: r.bytes });
    return r;
  };
  const putTo = async (upload: Json, bytes: Buffer, type: string): Promise<number> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((upload.headers ?? {}) as Record<string, unknown>))
      if (!['content-length', 'host'].includes(k.toLowerCase())) headers[k] = String(v);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
    const r = await fetch(upload.url, { method: 'PUT', headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(10_000) });
    return r.status;
  };
  const secretsOfUrls: string[] = [];
  const noteUrl = (u: string): void => {
    const url = new URL(u);
    const sig = url.searchParams.get('X-Amz-Signature') ?? url.search.slice(1);
    if (sig.length >= 16) secretsOfUrls.push(sig);
  };
  const mgmt = async (module: string, admin: string, method: string, path: string, body?: unknown, okStatuses = [200, 201]): Promise<Reply> => {
    const r = await request(`/${module}${path}`, method, admin, body);
    assert(okStatuses.includes(r.status), `${method} /${module}${path} -> ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.details?.reason ?? ''}`);
    return r;
  };

  // ---------------------------------------------------------------- resources to clean up
  const kcToken = await kcMasterToken();
  const kcAdmin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; location: string | null }> => {
    const res = await get(`${kcUrl}/admin/realms/bananagig${path}`, {
      method,
      headers: { authorization: `Bearer ${kcToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  const kcUserIds: string[] = [];
  const database = createDatabase(env('DATABASE_URL', ''), { role: 'tests' });
  const valkey = new Redis(env('VALKEY_URL', 'redis://valkey-cache:6379'), { maxRetriesPerRequest: 2 });
  valkey.on('error', () => undefined);
  const inbox = openSmsInbox(valkey);
  let admin = '';
  let marketCreated = false;
  let ruleOn = false;
  let definitionOn = false;
  try {
    // ---- the platform side: an administrator, a DEV/TEST market, category, service type and an ACTIVE Gig Template (variants and add-ons, no photo field) offered in the market
    admin = await loginAs('admin', adminCreds);
    const laocBefore = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    await ensureDevtestGeography(admin);
    await mgmt('geography', admin, 'POST', '/markets', {
      code: marketCode,
      name: `DEV/TEST profile smoke ${runId}`,
      countryCode: 'ZZ',
      defaultLocale: 'qaa',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Los_Angeles',
      reason: 'DEV/TEST ONLY smoke market',
    });
    marketCreated = true;
    const publishCopy = async (k: string, copy: string): Promise<void> => {
      await mgmt('content', admin, 'POST', '/entries', {
        key: k,
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'DEV/TEST ONLY profile smoke entry',
        approvalPolicy: 'NONE',
      });
      const v = (await mgmt('content', admin, 'POST', `/entries/${k}/versions`, { locale: 'en-US', body: copy, reason: 'smoke test' })).json.data;
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/submit`, {});
      await mgmt('content', admin, 'POST', `/versions/${v.versionId}/publish`, {});
    };
    await publishCopy(`catalog.category.${categoryCode}.name`, `Smoke Profile Category ${runId}`);
    await publishCopy(`catalog.service_type.${serviceType}.name`, `Smoke Profile Service ${runId}`);
    await publishCopy(key('name'), `Smoke Profile Template ${runId}`);
    await mgmt('catalog', admin, 'POST', '/categories', { code: categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/service-types', { code: serviceType, categoryCode, reason: 'DEV/TEST ONLY' });
    await mgmt('catalog', admin, 'POST', '/gig-templates', {
      code: tpl,
      serviceTypeCode: serviceType,
      withDescription: false,
      withInstructions: false,
      reason: 'DEV/TEST ONLY smoke template',
    });
    await mgmt('catalog', admin, 'PUT', `/categories/${categoryCode}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/service-types/${serviceType}/status`, { status: 'ACTIVE', reason: 'launch' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/status`, { status: 'ACTIVE', reason: 'launch' });
    await publishCopy(key('field.inclusions.label'), 'What is included');
    await publishCopy(key('field.inclusions.default'), 'Exterior wash, interior vacuum, windows.');
    await publishCopy(key('field.finish.label'), 'Finish');
    await publishCopy(key('field.finish.option.wax.label'), 'Wax');
    await publishCopy(key('field.finish.option.sealant.label'), 'Sealant');
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions`, { reason: 'DEV/TEST ONLY first draft' });
    await mgmt('catalog', admin, 'PUT', `/gig-templates/${tpl}/versions/1`, {
      expectedRevision: 1,
      duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
      pricingModels: ['FIXED_WITH_VARIANTS', 'ADD_ONS'],
      areaModes: ['RADIUS'],
      fields: [
        { fieldKey: 'inclusions', fieldType: 'LONG_TEXT', section: 'INCLUSIONS', behavior: 'PLATFORM_FIXED', withDefaultText: true },
        { fieldKey: 'finish', fieldType: 'ENUM', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'sealant' }] },
      ],
      requirements: [{ requirementType: 'INSURANCE' }],
      reason: 'DEV/TEST ONLY fields',
    });
    await mgmt('catalog', admin, 'POST', `/gig-templates/${tpl}/versions/1/publish`, { expectedRevision: 2, reason: 'DEV/TEST ONLY publish' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/categories/${categoryCode}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/service-types/${serviceType}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('catalog', admin, 'PUT', `/markets/${marketCode}/gig-templates/${tpl}`, { enabled: true, displayOrder: 10, reason: 'prepare' });
    await mgmt('geography', admin, 'POST', `/markets/${marketCode}/activation`, { active: true, reason: 'smoke test' });
    // the trust policy (as the 'Provider verification' scenario): identity verification is ACTIVE for everyone; liability insurance (an EXPIRING requirement) is switched on for THIS market only
    // and switched off again in `finally`
    const trustAdmin = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Reply> =>
      request(`/admin/trust${path}`, method, admin, body);
    assert(
      (await trustAdmin('PUT', '/requirement-definitions/liability_insurance/status', { status: 'ACTIVE' })).status === 200,
      'activating the insurance requirement',
    );
    definitionOn = true;
    assert(
      (await trustAdmin('PUT', '/requirement-rules', { requirementCode: 'liability_insurance', marketCode, serviceTypeCode: null, enabled: true })).status ===
        200,
      'requiring insurance in the test market',
    );
    ruleOn = true;

    // ---- a throwaway provider: Keycloak user, verified contacts, registration (market, services, consent, submit) through the REAL flows; optionally the trust case with evidence
    type Provider = { token: string; accountId: string; email: string; e164: string; tail: string; password: string; username: string };
    const onboard = async (tag: string, names: { first: string; last: string }, withTrust: boolean): Promise<Provider> => {
      await clearLimiterBuckets('email-verification');
      await clearLimiterBuckets('phone-verification');
      const username = `pro002${tag}.${runId}`;
      const password = `Pw-${randomBytes(9).toString('hex')}`; // secret-scan:allow throwaway DEV/TEST identity, deleted at the end
      const email = `pro002${tag}-${runId}@bananagig.localhost`;
      const created = await kcAdmin('POST', '/users', {
        username,
        enabled: true,
        email: `kc-${email}`,
        emailVerified: true,
        firstName: names.first,
        lastName: names.last,
        attributes: { 'bananagig.devOnly': ['true'] },
      });
      assert(
        created.status === 201 && !!created.location,
        `(1) creating the throwaway Keycloak user ${tag} -> ${created.status} ${JSON.stringify(created.json)}`,
      );
      const kcUserId = created.location!.split('/').pop()!;
      kcUserIds.push(kcUserId);
      const role = await kcAdmin('GET', '/roles/customer');
      assert(role.status === 200, `(1) the customer realm role -> ${role.status}`);
      assert((await kcAdmin('POST', `/users/${kcUserId}/role-mappings/realm`, [role.json])).status === 204, '(1) mapping the customer realm role');
      assert(
        (await kcAdmin('PUT', `/users/${kcUserId}/reset-password`, { type: 'password', value: password, temporary: false })).status === 204,
        '(1) setting the throwaway password',
      );
      const token = await loginAs('web', { username, password });
      const me = AccountResponse.parse((await request('/account/me', 'GET', token)).json).data;
      assert(uuidRe.test(me.accountId) && me.status === 'ACTIVE', `(1) the account of ${tag} is created on the first request and ACTIVE`);
      // the LEGAL name lives in identity.account_profiles: set it explicitly (the public fallback is derived from it, in full it must never be shown)
      const named = await request(
        '/account/profile',
        'PATCH',
        token,
        { firstName: names.first, lastName: names.last },
        { headers: { [ACTIVE_ROLE_HEADER]: 'CUSTOMER' } },
      );
      assert(named.status === 200, `(2) setting the legal name of ${tag} -> ${named.status} ${named.json?.error?.code ?? ''}`);
      assert((await request('/account/email', 'POST', token, { email })).status === 200, '(2) setting the email');
      assert((await request('/account/email/verification/send', 'POST', token, {})).status === 200, '(2) sending the email verification');
      const message = await retry(
        async () => {
          const found = (await (await expectOk(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
            messages: { ID: string }[] | null;
          };
          if (!found.messages?.length) throw new Error('the verification email has not arrived');
          return (await (await expectOk(`${mailpit}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
        },
        10,
        1000,
      );
      const emailCode = /code is\s+([0-9]{6})\b/i.exec(message.Text)?.[1];
      assert(!!emailCode, '(2) the email code is missing from the delivered message');
      assert((await request('/account/email/verification/confirm-code', 'POST', token, { code: emailCode })).status === 200, '(2) confirming the email code');
      let tail = '';
      do tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
      while (['901', '902', '903', '904', '905'].includes(tail.slice(-3)));
      const e164 = `+1202555${tail}`;
      await inbox.clear(e164);
      assert((await request('/account/phone', 'POST', token, { phone: `(202) 555-${tail}`, country: 'US' })).status === 200, '(2) setting the phone number');
      assert((await request('/account/phone/verification/send', 'POST', token, {})).status === 200, '(2) sending the SMS');
      const smsCode = extractSmsCode((await inbox.wait(e164, 1, 10_000))[0]!.body);
      assert(!!smsCode, '(2) the SMS code is missing');
      assert((await request('/account/phone/verification/confirm-code', 'POST', token, { code: smsCode })).status === 200, '(2) confirming the SMS code');
      assert((await request('/provider/registration', 'POST', token, {})).status === 201, '(2) starting the provider registration');
      assert((await request('/provider/registration/market', 'PUT', token, { marketCode })).status === 200, '(2) choosing the test market');
      if (withTrust) {
        // the verification case (policy: identity + insurance for the test market) with synthetic evidence for both requirements, submitted for review
        const v = (path: string, method: 'GET' | 'POST', body?: unknown): Promise<Reply> => request(`/provider/verification${path}`, method, token, body);
        assert((await v('', 'POST', {})).status === 201, '(2) opening the verification case');
        const evidence = async (requirementCode: string, documentTypeCode: string, label: string): Promise<void> => {
          const bytes = pdf(label);
          const auth = await v('/documents/upload', 'POST', { requirementCode, documentTypeCode, mimeType: 'application/pdf', sizeBytes: bytes.byteLength });
          assert(auth.status === 201, `(2) authorizing the ${label} evidence -> ${auth.status} ${auth.json?.error?.code ?? ''}`);
          noteUrl(auth.json.data.upload.url);
          assert((await putTo(auth.json.data.upload, bytes, 'application/pdf')) < 300, `(2) PUT of the ${label} evidence`);
          const fin = await v(`/documents/${auth.json.data.document.verificationDocumentId}/finalize`, 'POST', { sha256: sha256(bytes) });
          assert(fin.status === 200, `(2) finalizing the ${label} evidence -> ${fin.status} ${fin.json?.error?.code ?? ''}`);
        };
        await evidence('identity_verification', 'drivers_license', 'identity');
        await evidence('liability_insurance', 'insurance_certificate', 'insurance');
        const overview = await v('', 'GET');
        assert(overview.status === 200, '(2) the verification overview');
        const submitted = await v('/submit', 'POST', { expectedRevision: overview.json.data.case.revision });
        assert(
          submitted.status === 200 && submitted.json.data.case.status === 'IN_REVIEW',
          `(2) submitting the verification case -> ${submitted.status} ${submitted.json?.error?.code ?? ''}`,
        );
      }
      assert(
        (await request('/provider/registration/services', 'PUT', token, { serviceTypeCodes: [serviceType] })).status === 200,
        '(2) choosing the service type',
      );
      const consentReq = ConsentRequirementsResponse.parse((await request('/account/consents/requirements', 'GET', token)).json).data;
      const outstanding = consentReq.requirements.filter((r) => r.status === 'OUTSTANDING' || r.status === 'REACCEPTANCE_REQUIRED');
      assert(
        outstanding.every((r) => r.document),
        `(2) legal text must be in force (the Consent scenario publishes it): ${JSON.stringify(consentReq.requirements.map((r) => `${r.purposeCode}:${r.status}`))}`,
      );
      for (const r of outstanding) {
        const accepted = await request(`/account/consents/${r.purposeCode}/accept`, 'POST', token, {
          versionId: r.document!.versionId,
          locale: r.document!.locale,
          bodySha256: r.document!.bodySha256,
        });
        assert(accepted.status === 200, `(2) accepting ${r.purposeCode} -> ${accepted.status} ${accepted.json?.error?.code ?? ''}`);
      }
      const reg0 = (await request('/provider/registration', 'GET', token)).json.data.registration;
      const submitted = await request('/provider/registration/submit', 'POST', token, { expectedRevision: reg0.revision });
      assert(
        submitted.status === 200 && submitted.json.data.registration.status === 'COMPLETED' && submitted.json.data.providerRole === 'ACTIVE',
        `(2) registration submit -> ${submitted.status} ${submitted.json?.error?.code ?? ''}`,
      );
      return { token, accountId: me.accountId, email, e164, tail, password, username };
    };

    // ---------------------------------------------------------------- (1) authenticate the provider; every owner route needs the caller's own token
    const A = await onboard('a', legalA, true); // (1) + (2): authenticated provider with a COMPLETED registration, verification case in review
    const tokA = A.token;
    const accountId = A.accountId;
    const profileRoutes: [string, string, unknown][] = [
      ['GET', '', undefined],
      ['POST', '', {}],
      ['PATCH', '', { expectedRevision: 1, bio: 'x' }],
      ['POST', '/visibility', { expectedRevision: 1, visibility: 'PUBLIC' }],
      ['POST', '/photo/uploads', { expectedRevision: 1, mimeType: 'image/jpeg', sizeBytes: 100 }],
      ['POST', '/photo/finalize', { expectedRevision: 1 }],
      ['DELETE', '/photo', { expectedRevision: 1 }],
      ['GET', '/preview', undefined],
      ['GET', '/photo', undefined],
    ];
    for (const [method, path, body] of profileRoutes)
      assert((await owner(method, path, null, body, false)).status === 401, `(1) ${method} /provider/profile${path} without a token must be 401`);

    // ---------------------------------------------------------------- (2) Gig prerequisites: published Gig A (2 variants, 1 add-on), a Gig published then RETIRED, a DRAFT-only Gig, and a draft EDIT of Gig A
    const gig = (method: string, path: string, body?: unknown): Promise<Reply> => request(`/provider/gigs${path}`, method, tokA, body);
    const gigData = (r: Reply, status: number, what: string): Json => read(GigDetailResponse, r, status, what);
    const makeGig = async (
      text: { title: string; pitch: string; desc: string },
      price: number,
      options: boolean,
    ): Promise<{ gigId: string; revision: number }> => {
      const c = gigData(await gig('POST', '', { gigTemplateCode: tpl }), 201, `(2) creating the Gig ${text.title}`);
      const gigId: string = c.gig.gigId;
      let rev: number = c.draftVersion.revision;
      rev = gigData(
        await gig('PUT', `/${gigId}/draft`, {
          expectedRevision: rev,
          title: text.title,
          shortPitch: text.pitch,
          description: text.desc,
          priceAmountMinor: price,
          durationMinutes: 120,
          fieldValues: [{ fieldKey: 'finish', value: 'wax' }],
        }),
        200,
        `(2) saving the draft ${text.title}`,
      ).draftVersion.revision;
      if (options) {
        rev = gigData(
          await gig('PUT', `/${gigId}/draft/variants`, {
            expectedRevision: rev,
            variants: [
              { name: variantNames[0], description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 },
              { name: variantNames[1], description: null, priceDeltaMinor: 2500, durationDeltaMinutes: 30 },
            ],
          }),
          200,
          '(2) saving the variants',
        ).draftVersion.revision;
        rev = gigData(
          await gig('PUT', `/${gigId}/draft/add-ons`, {
            expectedRevision: rev,
            addOns: [{ name: addOnName, description: null, priceDeltaMinor: 1500, durationDeltaMinutes: 15 }],
          }),
          200,
          '(2) saving the add-on',
        ).draftVersion.revision;
      }
      return { gigId, revision: rev };
    };
    const gigA = await makeGig(gigText.a, 15000, true);
    gigData(await gig('POST', `/${gigA.gigId}/publish`, { expectedRevision: gigA.revision }), 200, '(2) publishing Gig A');
    const gigR = await makeGig(gigText.retired, 9900, false);
    gigData(await gig('POST', `/${gigR.gigId}/publish`, { expectedRevision: gigR.revision }), 200, '(2) publishing the Gig that is retired next');
    gigData(await gig('POST', `/${gigR.gigId}/retire`, {}), 200, '(2) retiring that Gig');
    const gigD = await makeGig(gigText.draft, 7700, false); // a DRAFT: never published
    // a next draft of the PUBLISHED Gig A with other words: the public summary must keep showing the published version
    const nextDraft = gigData(await gig('POST', `/${gigA.gigId}/versions`, {}), 201, '(2) starting the next draft of Gig A');
    gigData(
      await gig('PUT', `/${gigA.gigId}/draft`, {
        expectedRevision: nextDraft.draftVersion.revision,
        title: gigText.edit.title,
        shortPitch: gigText.edit.pitch,
        description: gigText.edit.desc,
        priceAmountMinor: 18000,
        durationMinutes: 90,
        fieldValues: [{ fieldKey: 'finish', value: 'wax' }],
      }),
      200,
      '(2) editing the next draft of Gig A',
    );
    const gigIdsAll = [gigA.gigId, gigR.gigId, gigD.gigId];

    // the profile does not exist yet: the owner state still carries the readiness facts and the limits; the onboarding step has not started; nothing is public
    const stateOf = async (token: string = tokA): Promise<Json> => read(OwnerProfileStateResponse, await owner('GET', '', token), 200, 'GET /provider/profile');
    const state0 = await stateOf();
    assert(
      state0.exists === false &&
        state0.profile === null &&
        state0.readiness.visibility === null &&
        state0.readiness.hasPublishedGig === true &&
        state0.readiness.publicNameAvailable === true &&
        state0.readiness.displayNamePresent === false &&
        state0.readiness.bioPresent === false &&
        state0.readiness.profilePhotoPresent === false,
      `(3) no profile yet: exists false, readiness facts present (${JSON.stringify(state0.readiness)})`,
    );
    const limits = state0.limits;
    assert(
      limits.displayNameMaxLength >= 1 &&
        limits.bioMaxLength >= 1 &&
        limits.photoMaxSizeBytes >= 1 &&
        limits.photoMimeTypes.length >= 1 &&
        limits.photoMimeTypes.includes('image/jpeg'),
      `(3) the limits come from configuration (${JSON.stringify(limits)})`,
    );
    refusal(await owner('GET', '/preview', tokA), 404, 'PROFILE_NOT_FOUND', '(3) previewing a profile that does not exist');
    refusal(await owner('PATCH', '', tokA, { expectedRevision: 1, bio: 'x' }), 404, 'PROFILE_NOT_FOUND', '(3) changing a profile that does not exist');
    const stepStatus = async (token: string, step: string): Promise<string> => {
      const req = (await request('/provider/registration/requirements', 'GET', token)).json.data;
      return req.steps.find((s: Json) => s.step === step).status as string;
    };
    assert((await stepStatus(tokA, 'PROFILE')) === 'NOT_STARTED', '(3) the onboarding PROFILE step has not started before a profile exists');
    // nothing public yet: an unknown id, a malformed id and (later) a private profile answer the SAME 404
    const unknownId = randomUUID();
    const unknownReply = await publicJson(unknownId);
    refusal(unknownReply, 404, 'PROFILE_NOT_FOUND', '(3) an unknown public id');
    assert(unknownReply.headers.get('cache-control') === 'no-store', '(3) a public 404 is not cacheable');
    for (const bad of ['x', 'not-a-uuid', '12345', `${unknownId}x`])
      assert(sameError(await publicJson(bad)) === sameError(unknownReply), `(3) a malformed public id (${bad}) must answer exactly like an unknown one`);

    // ---------------------------------------------------------------- (3) create the profile (idempotent); it starts PRIVATE and its public name is the fallback `First L.`
    const create1 = await owner('POST', '', tokA, {});
    assert(create1.status === 201, `(3) creating the profile -> ${create1.status} ${create1.json?.error?.code ?? create1.text.slice(0, 160)}`);
    const created = await stateOf();
    const publicProfileId: string = created.profile.publicProfileId;
    assert(
      created.exists === true &&
        uuidRe.test(publicProfileId) &&
        publicProfileId !== accountId &&
        created.profile.visibility === 'PRIVATE' &&
        created.profile.publishedAt === null &&
        created.profile.displayName === null &&
        created.profile.publicName === fallbackA &&
        created.profile.bio === null &&
        created.profile.photo === null &&
        created.profile.photoPending === false &&
        created.profile.revision >= 1,
      `(3) a new profile is PRIVATE with the derived fallback name ${fallbackA} (${JSON.stringify(created.profile)})`,
    );
    const create2 = await owner('POST', '', tokA, {});
    assert(create2.status === 200, `(3) creating again is idempotent: 200, not a second profile (${create2.status})`);
    assert(
      (await stateOf()).profile.publicProfileId === publicProfileId && (await stateOf()).profile.revision === created.profile.revision,
      '(3) the repeat changed nothing',
    );
    for (const [what, body] of [
      ['an account id', { accountId }],
      ['a public profile id', { publicProfileId }],
      ['a visibility', { visibility: 'PUBLIC' }],
      ['a display name', { displayName: 'x' }],
    ] as const)
      assert((await owner('POST', '', tokA, body)).status === 400, `(3) a create request naming ${what} must be 400`);
    const readiness3 = (await stateOf()).readiness;
    assert(
      readiness3.visibility === 'PRIVATE' &&
        readiness3.publicNameAvailable === true &&
        readiness3.hasPublishedGig === true &&
        typeof readiness3.profileComplete === 'boolean',
      `(3) readiness facts after create (${JSON.stringify(readiness3)})`,
    );
    const stepAfter = await stepStatus(tokA, 'PROFILE');
    assert(
      stepAfter === (readiness3.profileComplete ? 'COMPLETE' : 'IN_PROGRESS'),
      `(3) the onboarding PROFILE step follows the readiness facts (${stepAfter}, profileComplete ${readiness3.profileComplete})`,
    );
    const preview3 = read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, '(3) GET /provider/profile/preview');
    assert(
      preview3.displayName === fallbackA && preview3.preview === true && preview3.visibility === 'PRIVATE',
      `(3) the preview of a new profile shows the fallback name (${preview3.displayName})`,
    );

    // a stale revision, an invalid revision and bodies that name more than they may are refused and change nothing
    const revNow = async (): Promise<number> => (await stateOf()).profile.revision as number;
    const snapshot = async (): Promise<string> => JSON.stringify((await stateOf()).profile);
    const noWrite = async (
      what: string,
      fn: (rev: number) => Promise<Reply>,
      status: number,
      code: ProfileErrorCode,
      issue?: ProfileIssueReason,
    ): Promise<void> => {
      const before = await snapshot();
      const r = await fn(await revNow());
      refusal(r, status, code, `(4) ${what}`);
      if (issue) assert(hasIssue(r, issue), `(4) ${what}: expected the issue ${issue} (${JSON.stringify(r.json?.error?.details?.issues)})`);
      assert((await snapshot()) === before, `(4) ${what} wrote something`);
    };
    const patch = (body: Record<string, unknown>) => (rev: number) => owner('PATCH', '', tokA, { expectedRevision: rev, ...body });

    // ---------------------------------------------------------------- (4) display name: validation, NFC normalisation, clearing back to the fallback
    await noWrite('a stale revision', (rev) => owner('PATCH', '', tokA, { expectedRevision: rev + 1, displayName: 'Stale' }), 409, 'STALE_PROFILE');
    await noWrite('a blank display name', patch({ displayName: '    ' }), 400, 'VALIDATION_FAILED', 'DISPLAY_NAME_BLANK');
    await noWrite(
      'a display name beyond the configured length',
      patch({ displayName: 'N'.repeat(limits.displayNameMaxLength + 1) }),
      400,
      'VALIDATION_FAILED',
      'DISPLAY_NAME_TOO_LONG',
    );
    // a line break is whitespace and is collapsed to one space by the shared text normaliser (as for a Gig title); a real control character is refused
    await noWrite(
      'a control character in the display name',
      patch({ displayName: `Two${String.fromCharCode(7)}Lines` }),
      400,
      'VALIDATION_FAILED',
      'DISPLAY_NAME_FORBIDDEN_CHARACTER',
    );
    await noWrite(
      'a zero-width character in the display name',
      patch({ displayName: `Hidden${String.fromCodePoint(0x200b)}Name` }),
      400,
      'VALIDATION_FAILED',
      'DISPLAY_NAME_FORBIDDEN_CHARACTER',
    );
    await noWrite('markup in the display name', patch({ displayName: '<b>Bold</b>' }), 400, 'VALIDATION_FAILED', 'DISPLAY_NAME_HTML_NOT_ALLOWED');
    for (const [what, body] of [
      ['an account id', { accountId }],
      ['a public profile id', { publicProfileId }],
      ['a visibility', { visibility: 'PUBLIC' }],
      ['a photo', { photo: 'x' }],
      ['a name of the wrong type', { displayName: 5 }],
      ['no field to change', {}],
    ] as const) {
      const before = await snapshot();
      const r = await owner('PATCH', '', tokA, { expectedRevision: await revNow(), ...body });
      assert(r.status === 400, `(4) a change request with ${what} must be 400 (got ${r.status})`);
      assert((await snapshot()) === before, `(4) a change request with ${what} wrote something`);
    }
    for (const [what, rev] of [
      ['a revision of zero', 0],
      ['a fractional revision', 1.5],
      ['a revision as a string', '1'],
      ['a revision of null', null],
    ] as const) {
      const before = await snapshot();
      assert((await owner('PATCH', '', tokA, { expectedRevision: rev, displayName: 'X' })).status === 400, `(4) ${what} must be 400`);
      assert((await snapshot()) === before, `(4) ${what} wrote something`);
    }
    assert((await owner('PATCH', '', tokA, '[]')).status === 400, '(4) a body that is not an object must be 400');
    const named = read(
      OwnerProfileStateResponse,
      await owner('PATCH', '', tokA, { expectedRevision: await revNow(), displayName: displayNfd }),
      200,
      '(4) set the display name',
    );
    assert(
      named.profile.displayName === displayName && named.profile.publicName === displayName && named.profile.revision > created.profile.revision,
      `(4) the display name is stored NFC and becomes the public name (${JSON.stringify(named.profile.displayName)}), the revision grew`,
    );
    const rNamed = named.profile.revision as number;
    const same4 = read(OwnerProfileStateResponse, await owner('PATCH', '', tokA, { expectedRevision: rNamed, displayName }), 200, '(4) the same name again');
    assert(same4.profile.revision === rNamed, '(4) saving an unchanged name does not raise the revision');
    refusal(
      await owner('PATCH', '', tokA, { expectedRevision: created.profile.revision, displayName: 'Late' }),
      409,
      'STALE_PROFILE',
      '(4) an old revision after the change',
    );
    const cleared = read(
      OwnerProfileStateResponse,
      await owner('PATCH', '', tokA, { expectedRevision: rNamed, displayName: null }),
      200,
      '(4) clear the display name',
    );
    assert(
      cleared.profile.displayName === null && cleared.profile.publicName === fallbackA,
      `(4) clearing the display name returns to the fallback ${fallbackA}`,
    );
    read(
      OwnerProfileStateResponse,
      await owner('PATCH', '', tokA, { expectedRevision: cleared.profile.revision, displayName }),
      200,
      '(4) set the display name again',
    );

    // ---------------------------------------------------------------- (5) bio: plain text, multi-line, bounded
    await noWrite('a bio beyond the configured length', patch({ bio: 'B'.repeat(limits.bioMaxLength + 1) }), 400, 'VALIDATION_FAILED', 'BIO_TOO_LONG');
    await noWrite('a blank bio', patch({ bio: '  \n  ' }), 400, 'VALIDATION_FAILED', 'BIO_BLANK');
    await noWrite('a control character in the bio', patch({ bio: `Bell${String.fromCodePoint(7)}` }), 400, 'VALIDATION_FAILED', 'BIO_FORBIDDEN_CHARACTER');
    await noWrite('markup in the bio', patch({ bio: 'Hello <script>alert(1)</script>' }), 400, 'VALIDATION_FAILED', 'BIO_HTML_NOT_ALLOWED');
    const withBio = read(OwnerProfileStateResponse, await owner('PATCH', '', tokA, { expectedRevision: await revNow(), bio }), 200, '(5) set the bio');
    assert(
      withBio.profile.bio === bio && withBio.readiness.bioPresent === true,
      `(5) the bio keeps its line break and is a readiness fact (${JSON.stringify(withBio.profile.bio)})`,
    );

    // ---------------------------------------------------------------- (6) the profile photo: refusals first, then a clean synthetic JPEG that carries GPS EXIF and an orientation
    const original = synthJpegWithGps(256, runId);
    const originalParsed = parseJpeg(original);
    const originalExif = originalParsed.segs.find((s) => s.marker === 0xe1 && s.payload.subarray(0, 6).toString('latin1') === 'Exif\0\0');
    assert(!!originalExif, '(6) the fixture carries an EXIF segment');
    const originalTags = exifTags(originalExif!.payload);
    assert(
      originalTags.tags.includes(0x8825) &&
        originalTags.orientation === 6 &&
        original.includes(Buffer.from(`TRAILER-${runId}`)) &&
        originalParsed.eoiEnd < original.length,
      '(6) the fixture really carries GPS, an orientation of 6, a comment and trailing bytes',
    );
    const authorizePhoto = (rev: number, o: { mimeType: string; sizeBytes: number; sha256?: string }, extra: Record<string, unknown> = {}): Promise<Reply> =>
      owner(
        'POST',
        '/photo/uploads',
        tokA,
        { expectedRevision: rev, mimeType: o.mimeType, sizeBytes: o.sizeBytes, ...(o.sha256 ? { sha256: o.sha256 } : {}), ...extra },
        false,
      );
    for (const mime of ['image/gif', 'image/svg+xml', 'text/html', 'application/pdf', 'image/heic']) {
      const before = await snapshot();
      refusal(await authorizePhoto(await revNow(), { mimeType: mime, sizeBytes: 1000 }), 400, 'MEDIA_REFUSED', `(6) a file type that is not allowed (${mime})`);
      assert((await snapshot()) === before, `(6) a refused authorization (${mime}) wrote something`);
    }
    refusal(
      await authorizePhoto(await revNow(), { mimeType: 'image/jpeg', sizeBytes: limits.photoMaxSizeBytes + 1 }),
      400,
      'MEDIA_REFUSED',
      '(6) a size above the configured profile maximum',
    );
    refusal(await authorizePhoto((await revNow()) + 5, { mimeType: 'image/jpeg', sizeBytes: 1000 }), 409, 'STALE_PROFILE', '(6) a stale revision');
    for (const [what, extra] of [
      ['an account id', { accountId }],
      ['an object key', { objectKey: 'provider/x' }],
      ['a purpose', { purpose: 'GIG_PHOTO' }],
      ['a url', { url: 'http://example.test/x' }],
    ] as const)
      assert(
        (await authorizePhoto(await revNow(), { mimeType: 'image/jpeg', sizeBytes: 1000 }, extra)).status === 400,
        `(6) an upload request naming ${what} must be 400`,
      );
    for (const [what, patchBody] of [
      ['a size of zero', { sizeBytes: 0 }],
      ['a negative size', { sizeBytes: -1 }],
      ['a fractional size', { sizeBytes: 10.5 }],
      ['a size as a string', { sizeBytes: '1000' }],
      ['a malformed hash', { sha256: 'xyz' }],
      ['an upper-case hash', { sha256: 'A'.repeat(64) }],
    ] as const) {
      const body: Record<string, unknown> = { expectedRevision: await revNow(), mimeType: 'image/jpeg', sizeBytes: 1000 };
      Object.assign(body, patchBody);
      assert((await owner('POST', '/photo/uploads', tokA, body, false)).status === 400, `(6) an upload request with ${what} must be 400`);
    }
    assert((await stateOf()).profile.photo === null, '(6) the refused authorizations left no photo');
    // an authorized upload (reserves the one pending photo) -> finalize with something that is not what was declared / a hash that differs: both refused, no photo
    const authorizeOk = async (bytes: Buffer, mime: string, withHash: boolean): Promise<{ upload: Json; revision: number }> => {
      const rev = await revNow();
      const r = await authorizePhoto(rev, { mimeType: mime, sizeBytes: bytes.length, ...(withHash ? { sha256: sha256(bytes) } : {}) });
      const data = read(ProfilePhotoUploadResponse, r, 201, '(6) authorize a profile photo upload');
      assert(
        data.revision === rev + 1 &&
          data.maxSizeBytes === limits.photoMaxSizeBytes &&
          typeof data.upload.url === 'string' &&
          data.upload.url.startsWith('http') &&
          !JSON.stringify(data).includes(accountId) &&
          !/objectKey|object_key|assetId|bucket/i.test(JSON.stringify(data)),
        `(6) the authorization names a one-object target and the next revision, no account, key or asset (${JSON.stringify(Object.keys(data))})`,
      );
      noteUrl(data.upload.url);
      return { upload: data.upload, revision: data.revision };
    };
    const html = Buffer.from(`<html><body>not an image ${runId}</body></html>`.padEnd(300, ' '));
    const fakeJpeg = await authorizeOk(html, 'image/jpeg', false);
    assert((await putTo(fakeJpeg.upload, html, 'image/jpeg')) < 300, '(6) the store accepts the PUT of the authorized object');
    const finHtml = await owner('POST', '/photo/finalize', tokA, { expectedRevision: fakeJpeg.revision });
    refusal(finHtml, 400, 'MEDIA_REFUSED', '(6) a web page declared as a JPEG');
    assert(
      /^[A-Z][A-Z0-9_]*$/.test(String(finHtml.json.error.details?.reason ?? '')),
      `(6) the media refusal names an allow-listed reason (${JSON.stringify(finHtml.json.error.details)})`,
    );
    assert(!finHtml.text.includes('X-Amz') && !/gig-media|profile-photo\//.test(finHtml.text), '(6) the refusal names no object key or link');
    assert((await stateOf()).profile.photo === null, '(6) the refused file is not the profile photo');
    const wrongHash = await authorizeOk(original, 'image/jpeg', false);
    assert((await putTo(wrongHash.upload, original, 'image/jpeg')) < 300, '(6) PUT for the wrong-hash case');
    refusal(
      await owner('POST', '/photo/finalize', tokA, { expectedRevision: wrongHash.revision, sha256: '0'.repeat(64) }),
      400,
      'MEDIA_REFUSED',
      '(6) a client hash that differs from the stored bytes',
    );
    assert((await stateOf()).profile.photo === null, '(6) the hash mismatch left no photo');
    // the good path (a new authorization abandons any earlier unfinished one)
    const good = await authorizeOk(original, 'image/jpeg', true);
    const pendingState = await stateOf();
    assert(
      pendingState.profile.photoPending === true && pendingState.profile.photo === null,
      '(6) an authorized photo is pending and not yet the profile photo',
    );
    assert((await putTo(good.upload, original, 'image/jpeg')) < 300, '(6) PUT of the JPEG to the presigned URL');
    const finGood = read(
      OwnerProfileStateResponse,
      await owner('POST', '/photo/finalize', tokA, { expectedRevision: good.revision, sha256: sha256(original) }),
      200,
      '(6) finalize the photo',
    );
    assert(
      finGood.profile.photoPending === false &&
        finGood.profile.photo?.mimeType === 'image/jpeg' &&
        finGood.profile.photo.width === 256 &&
        finGood.profile.photo.height === 256 &&
        Object.keys(finGood.profile.photo).sort().join() === 'height,mimeType,width' &&
        finGood.readiness.profilePhotoPresent === true,
      `(6) the photo is READY: type and dimensions only, no id, key, hash or url (${JSON.stringify(finGood.profile.photo)})`,
    );
    const again6 = await owner('POST', '/photo/finalize', tokA, { expectedRevision: finGood.profile.revision });
    assert([200, 409].includes(again6.status), `(6) finalizing again must be idempotent or a typed refusal (${again6.status})`);
    // another purpose cannot be smuggled in: the same asset is a profile photo only
    const assetsBefore = await database.query<{ id: string; object_key: string; sha256: string | null; status: string; purpose: string }>(
      `SELECT media_asset_id::text AS id, object_key, sha256, status, purpose FROM provider.media_assets WHERE account_id = $1::uuid`,
      [accountId],
    );
    const ready = assetsBefore.filter((a) => a.status === 'READY');
    assert(
      ready.length === 1 && ready[0]!.purpose === 'PROFILE_PHOTO' && ready[0]!.sha256 === sha256(original),
      `(6) exactly one READY asset: a PROFILE_PHOTO whose server-computed SHA-256 is the hash of the file WITH its GPS EXIF (the stored original keeps it) (${JSON.stringify(ready.map((a) => [a.status, a.purpose]))})`,
    );
    assert(
      assetsBefore.every((a) => a.purpose === 'PROFILE_PHOTO'),
      '(6) every asset of this account is a profile photo (no Gig photo was uploaded)',
    );
    const objectKeys = assetsBefore.map((a) => a.object_key).filter(Boolean);
    const assetIds = assetsBefore.map((a) => a.id);
    const storedSha = sha256(original);

    // ---------------------------------------------------------------- (7) preview: exactly the public projection plus the visibility and the preview marker; PRIVATE is previewable
    const preview7 = read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, '(7) GET /provider/profile/preview');
    assert(
      preview7.preview === true &&
        preview7.visibility === 'PRIVATE' &&
        preview7.publicProfileId === publicProfileId &&
        preview7.displayName === displayName &&
        preview7.bio === bio &&
        preview7.photo?.mimeType === 'image/jpeg' &&
        preview7.photo.width === 256 &&
        preview7.photo.height === 256,
      `(7) the preview of the PRIVATE profile shows name, bio and photo facts (${JSON.stringify({ n: preview7.displayName, v: preview7.visibility })})`,
    );
    const previewKeys = Object.keys(preview7).sort().join();
    assert(
      previewKeys === 'badges,bio,displayName,drops,gigs,market,photo,preview,publicProfileId,ratings,visibility',
      `(7) the preview has exactly the public keys plus preview and visibility (${previewKeys})`,
    );
    assert(preview7.market?.code === marketCode, `(7) the market is the registration's ACTIVE market code only (${JSON.stringify(preview7.market)})`);
    // PRIVATE means private: nobody reaches it by id, with or without a token, and the answer is the same as for an unknown id
    const privateReply = await publicJson(publicProfileId);
    assert(sameError(privateReply) === sameError(unknownReply), '(7) a PRIVATE profile answers exactly like an unknown id');
    assert(
      sameError(await publicJson(publicProfileId, tokA)) === sameError(unknownReply),
      '(7) the owner token does not make the public route show a PRIVATE profile',
    );
    const privatePhoto = await publicPhoto(publicProfileId);
    assert(privatePhoto.status === 404 && !privatePhoto.bytes.includes(Buffer.from('JFIF')), '(7) the photo of a PRIVATE profile is 404');

    // ---------------------------------------------------------------- (8) the safe trust summary: a badge from an APPROVED requirement and its disappearance after the approval expires
    const queue = (await trustAdmin('GET', '/cases?status=IN_REVIEW&limit=50')).json?.data as Json[] | undefined;
    const mine = queue?.find((c: Json) => c.accountId === accountId);
    assert(!!mine, '(8) the verification case of the provider is in the reviewers queue');
    const detail = (await trustAdmin('GET', `/cases/${mine!.verificationCaseId}`)).json.data;
    const idReq = detail.requirements.find((r: Json) => r.requirementCode === 'identity_verification' && !r.superseded);
    const insReq = detail.requirements.find((r: Json) => r.requirementCode === 'liability_insurance' && !r.superseded);
    assert(!!idReq && !!insReq, '(8) the case holds the identity and insurance requirements');
    const trustDetailNeedles: [string, string][] = [
      ['verification case id', String(mine!.verificationCaseId)],
      ['identity requirement id', String(idReq.caseRequirementId)],
      ['insurance requirement id', String(insReq.caseRequirementId)],
      ...[...idReq.documents, ...insReq.documents].map((d: Json): [string, string] => ['verification document id', String(d.verificationDocumentId)]),
      ['document type', 'insurance_certificate'],
      ['document type', 'drivers_license'],
      ['requirement code', 'liability_insurance'],
      ['requirement code', 'identity_verification'],
      ['evidence path', 'trust/evidence'],
    ];
    const badgesOf = (p: Json): string =>
      (p.badges as Json[])
        .map((b) => b.type as string)
        .sort()
        .join();
    assert(
      badgesOf(read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, '(8) preview')) === '',
      '(8) a case that is only PENDING produces no badge',
    );
    assert(
      (await trustAdmin('POST', `/requirements/${idReq.caseRequirementId}/start-review`, { round: idReq.round })).status === 200,
      '(8) start review of identity',
    );
    assert(
      (await trustAdmin('POST', `/requirements/${idReq.caseRequirementId}/approve`, { round: idReq.round })).status === 200,
      '(8) approve identity (no end date)',
    );
    const insuranceEnds = new Date(Date.now() + 12_000).toISOString();
    const approvedIns = await trustAdmin('POST', `/requirements/${insReq.caseRequirementId}/approve`, { round: insReq.round, expiresAt: insuranceEnds });
    assert(approvedIns.status === 200, `(8) approve insurance with an end date -> ${approvedIns.status} ${approvedIns.json?.error?.code ?? ''}`);
    trustDetailNeedles.push(['insurance end date', insuranceEnds], ['insurance end day', insuranceEnds.slice(0, 10)]);
    const withBadges = read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, '(8) preview after the approvals');
    assert(
      badgesOf(withBadges) === 'IDENTITY,INSURANCE' && (withBadges.badges as Json[]).every((b) => Object.keys(b).join() === 'type'),
      `(8) approved requirements produce badges that carry the type only (${badgesOf(withBadges)})`,
    );
    const previewText8 = JSON.stringify(withBadges);
    for (const [what, needle] of trustDetailNeedles) assert(!previewText8.includes(needle), `(8) the preview carries trust detail: ${what}`);
    assert((await stateOf()).readiness.trustSummaryAvailable === true, '(8) the readiness fact says a trust summary is available');
    const waitMs = Date.parse(insuranceEnds) - Date.now() + 2500;
    if (waitMs > 0) await sleep(waitMs);
    const afterExpiry = read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, '(8) preview after the insurance approval expired');
    assert(
      badgesOf(afterExpiry) === 'IDENTITY',
      `(8) the INSURANCE badge disappears with the expired approval, the permanent IDENTITY badge stays (${badgesOf(afterExpiry)})`,
    );

    // ---------------------------------------------------------------- (9) the published Gig summary; (10) a draft, a retired Gig and a draft EDIT never appear
    const gigs = afterExpiry.gigs as Json[];
    assert(gigs.length === 1, `(9) exactly one Gig summary: the published, ACTIVE Gig A (${gigs.map((g) => g.title).join('|')})`);
    const summary = gigs[0]!;
    assert(
      summary.gigId === gigA.gigId &&
        summary.title === gigText.a.title &&
        summary.shortPitch === gigText.a.pitch &&
        summary.serviceTypeCode === serviceType &&
        String(summary.serviceTypeNameContentKey).includes(serviceType) &&
        summary.price?.amountMinor === 15000 &&
        summary.price?.currency === 'USD' &&
        summary.durationMinutes === 120 &&
        summary.variantCount === 2 &&
        summary.addOnCount === 1 &&
        summary.photoCount === 0 &&
        Object.keys(summary).sort().join() ===
          'addOnCount,durationMinutes,gigId,photoCount,price,serviceTypeCode,serviceTypeNameContentKey,shortPitch,title,variantCount',
      `(9) the summary is the PUBLISHED version of Gig A with its counts (${JSON.stringify(summary)})`,
    );
    const previewAll = JSON.stringify(afterExpiry);
    for (const text of [
      gigText.retired.title,
      gigText.draft.title,
      gigText.edit.title,
      gigText.edit.pitch,
      gigR.gigId,
      gigD.gigId,
      variantNames[0]!,
      addOnName,
    ])
      assert(!previewAll.includes(text), `(10) a draft, retired or draft-edit Gig (or an option name) appears in the profile: ${text}`);
    assert((await stateOf()).readiness.hasPublishedGig === true, '(10) the readiness fact still sees the published Gig');

    // ---------------------------------------------------------------- (11) visibility PUBLIC: owner only, expected revision; PRIVATE again is always allowed
    const second = await onboard('b', legalB, false); // the second provider (also used in step 14)
    const tokB = second.token;
    const vis = (rev: number, visibility: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
      owner('POST', '/visibility', tokA, { expectedRevision: rev, visibility, ...extra });
    for (const [what, r] of [
      ['an unknown visibility', await vis(await revNow(), 'HIDDEN')],
      ['a lower-case visibility', await vis(await revNow(), 'public')],
      ['an account id', await vis(await revNow(), 'PUBLIC', { accountId })],
      ['a public profile id', await vis(await revNow(), 'PUBLIC', { publicProfileId })],
    ] as const)
      assert(r.status === 400, `(11) ${what} must be 400 (got ${r.status})`);
    assert((await stateOf()).profile.visibility === 'PRIVATE', '(11) refused visibility requests changed nothing');
    refusal(await vis((await revNow()) + 3, 'PUBLIC'), 409, 'STALE_PROFILE', '(11) a stale revision');
    const published = read(OwnerProfileStateResponse, await vis(await revNow(), 'PUBLIC'), 200, '(11) set the visibility PUBLIC');
    assert(
      published.profile.visibility === 'PUBLIC' && typeof published.profile.publishedAt === 'string' && published.readiness.visibility === 'PUBLIC',
      `(11) the profile is PUBLIC with a publication time (${published.profile.publishedAt})`,
    );
    const repeatPublic = read(OwnerProfileStateResponse, await vis(published.profile.revision, 'PUBLIC'), 200, '(11) PUBLIC again');
    assert(repeatPublic.profile.revision === published.profile.revision, '(11) the same visibility again changes nothing');

    // ---------------------------------------------------------------- (12) the public endpoint (no auth) and the public photo
    const counts0 = await database.query<{ audit: number; events: number }>(
      `SELECT (SELECT count(*)::int FROM provider.profile_audit_events WHERE account_id = $1::uuid) AS audit,
              (SELECT count(*)::int FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.profile-%' AND payload_json->>'accountId' = $1::text) AS events`,
      [accountId],
    );
    const pub = await publicJson(publicProfileId);
    const pubData = read(PublicProviderProfileResponse, pub, 200, '(12) GET /providers/{id} without authentication');
    assert(pub.headers.get('cache-control') === 'no-store', '(12) the public profile is not cacheable');
    assert(
      pubData.publicProfileId === publicProfileId &&
        pubData.displayName === displayName &&
        pubData.bio === bio &&
        pubData.photo?.mimeType === 'image/jpeg' &&
        pubData.photo.width === 256 &&
        pubData.photo.height === 256 &&
        badgesOf(pubData) === 'IDENTITY' &&
        pubData.market?.code === marketCode &&
        pubData.gigs.length === 1 &&
        pubData.gigs[0].gigId === gigA.gigId &&
        pubData.gigs[0].title === gigText.a.title,
      `(12) the public profile is the projection: name, bio, photo facts, IDENTITY badge, market, one Gig (${JSON.stringify({ n: pubData.displayName, b: badgesOf(pubData), g: pubData.gigs.length })})`,
    );
    assert(!('preview' in pubData) && !('visibility' in pubData), '(12) the public profile has neither the preview marker nor the visibility');
    // an Authorization header is ignored (a bogus token, the owner's token and another provider's token give the same body)
    const bodyOf = (r: Reply): string => JSON.stringify(r.json);
    assert(bodyOf(await publicJson(publicProfileId, 'not.a.valid.token')) === bodyOf(pub), '(12) a bogus Authorization header is ignored');
    assert(bodyOf(await publicJson(publicProfileId, tokA)) === bodyOf(pub), "(12) the owner's token changes nothing");
    assert(bodyOf(await publicJson(publicProfileId, tokB)) === bodyOf(pub), "(12) another provider's token changes nothing");
    // the public photo: sanitised bytes through the API, never the stored object
    const photo = await publicPhoto(publicProfileId);
    assert(photo.status === 200, `(12) GET /providers/{id}/photo without authentication -> ${photo.status}`);
    const h = (name: string): string => photo.headers.get(name) ?? '';
    const etag = h('etag');
    assert(
      h('content-type').split(';')[0] === 'image/jpeg' &&
        h('x-content-type-options') === 'nosniff' &&
        h('content-disposition').startsWith('inline') &&
        h('cross-origin-resource-policy') === 'cross-origin' &&
        h('cache-control').includes('no-cache') &&
        !h('cache-control').includes('immutable') &&
        h('content-length') === String(photo.bytes.length) &&
        !photo.headers.has('set-cookie'),
      `(12) the photo headers: forced content type, nosniff, inline, cross-origin resource policy, no-cache (${JSON.stringify([...photo.headers])})`,
    );
    assert(/^W\/"[^"]+"$/.test(etag), `(12) the photo has an opaque weak ETag (${etag})`);
    const servedSha = sha256(photo.bytes);
    for (const secret of [storedSha, servedSha, ...assetIds]) assert(!etag.includes(secret), '(12) the ETag must not be the content hash or an asset id');
    const notModified = await publicPhoto(publicProfileId, null, { 'if-none-match': etag });
    assert(notModified.status === 304 && notModified.bytes.length === 0, `(12) a matching If-None-Match answers 304 without a body (${notModified.status})`);
    const otherTag = await publicPhoto(publicProfileId, null, { 'if-none-match': 'W/"not-the-validator"' });
    assert(otherTag.status === 200 && otherTag.bytes.equals(photo.bytes), '(12) a different validator gets the photo');
    const ownerPhoto = await requestRaw('/provider/profile/photo', tokA);
    assert(ownerPhoto.status === 200 && ownerPhoto.bytes.equals(photo.bytes), "(12) the owner's photo route serves the same sanitised bytes");

    // ---------------------------------------------------------------- (13) deep scan of every public response, and the served photo bytes have NO EXIF/GPS while the stored original keeps it
    const tagBytes = [`GPSDESC-${runId}`, `SmokeCam-${runId}`, `COMMENT-${runId}`, `TRAILER-${runId}`];
    const served = photo.bytes;
    assert(
      served.length > 100 && served.length <= original.length,
      `(13) the served photo is a smaller or equal file (${served.length} vs ${original.length})`,
    );
    for (const t of tagBytes) assert(!served.includes(Buffer.from(t, 'latin1')), `(13) the served photo still carries ${t.split('-')[0]}`);
    assert(
      !served.includes(Buffer.from('GPS', 'latin1')) && !served.includes(Buffer.from('http://ns.adobe.com/xap', 'latin1')),
      '(13) no GPS or XMP text in the served photo',
    );
    const servedParsed = parseJpeg(served);
    assert(servedParsed.eoiEnd === served.length, '(13) the served photo ends at the end-of-image marker (nothing after it)');
    const metaMarkers = servedParsed.segs.map((s) => s.marker);
    assert(!metaMarkers.includes(0xfe) && !metaMarkers.includes(0xed), '(13) no COM comment and no IPTC segment in the served photo');
    for (const s of servedParsed.segs) {
      if (s.marker === 0xe1) {
        assert(s.payload.subarray(0, 6).toString('latin1') === 'Exif\0\0', '(13) the only APP1 allowed is a minimal EXIF block (no XMP)');
        const tags = exifTags(s.payload);
        assert(
          tags.tags.join() === String(0x0112) && tags.orientation === 6 && !tags.hasNextIfd,
          `(13) the EXIF block holds the ORIENTATION only (tags ${tags.tags.map((x) => x.toString(16)).join()}, orientation ${tags.orientation})`,
        );
      }
      if (s.marker === 0xe2) assert(s.payload.subarray(0, 11).toString('latin1') === 'ICC_PROFILE', '(13) the only APP2 allowed is an ICC profile');
    }
    assert(metaMarkers.filter((m) => m === 0xe1).length <= 1, '(13) at most one APP1 segment in the served photo');
    const imageSegments = (b: Buffer): string[] =>
      parseJpeg(b)
        .segs.filter((s) => [0xdb, 0xc4, 0xdd, 0xda].includes(s.marker) || (s.marker >= 0xc0 && s.marker <= 0xc3))
        .map((s) => `${s.marker}:${s.payload.toString('hex')}`);
    assert(imageSegments(served).join('|') === imageSegments(original).join('|'), '(13) the quantisation, frame, Huffman and scan headers are untouched');
    assert(
      served.subarray(servedParsed.scanStart, servedParsed.eoiEnd).equals(original.subarray(originalParsed.scanStart, originalParsed.eoiEnd)),
      '(13) the pixel data (scan to end-of-image) is byte-identical to the original: container-level sanitising, no re-encoding',
    );
    const dims = sof(served);
    assert(dims.width === 256 && dims.height === 256, `(13) the served photo keeps its dimensions (${dims.width}x${dims.height})`);
    assert(servedSha !== storedSha, '(13) the served bytes differ from the stored original (the stored object is never served)');
    const stored13 = await database.query<{ sha256: string | null; status: string; purpose: string }>(
      `SELECT sha256, status, purpose FROM provider.media_assets WHERE account_id = $1::uuid AND status = 'READY'`,
      [accountId],
    );
    assert(
      stored13.length === 1 && stored13[0]!.sha256 === storedSha && stored13[0]!.purpose === 'PROFILE_PHOTO',
      '(13) the stored original still has the hash of the GPS-carrying upload (it is not rewritten)',
    );
    // the deep scan: forbidden KEYS (any depth), forbidden VALUES (every string and every header), strangers (ids, urls, emails, phone numbers, hashes)
    const forbiddenKeys =
      /^(email|emailAddress|phone|phoneNumber|accountId|account_id|userId|subject|sub|objectKey|object_key|storageKey|bucket|url|href|signedUrl|sha256|hash|etag|legalName|fullName|firstName|lastName|givenName|familyName|documentType|documentTypeCode|documentTypes|expiresAt|expiryDate|validUntil|issuedAt|reasonCode|reason|reviewer|notes?|caseId|verificationCaseId|caseRequirementId|requirementId|requirementCode|requirementType|assetId|mediaAssetId|mediaId|scanStatus|revision|visibility|publishedAt|createdAt|updatedAt|verified|isVerified|status|live|isLive|bookable|goLive|rating|averageRating|reviews?|stars|bananaDrop|tier|availability|serviceAreas?|address|latitude|longitude|lat|lng)$/i;
    const allowedPublicIds = new Set<string>([publicProfileId, gigA.gigId]);
    const needles: [string, string][] = [
      ['email', A.email],
      ['Keycloak email', `kc-${A.email}`],
      ['email of the second provider', second.email],
      ['phone', A.e164],
      ['phone digits', `555${A.tail}`],
      ['phone display', `555-${A.tail}`],
      ['account id', accountId],
      ['second account id', second.accountId],
      ['access token', tokA],
      ['password', A.password],
      ['legal last name', legalA.last],
      ['legal last name', legalA.last.toLowerCase()],
      ['legal full name', `${legalA.first} ${legalA.last}`],
      ['second provider legal name', legalB.last],
      ['signature', 'X-Amz'],
      ['bucket path', 'gig-media/'],
      ...(env('S3_BUCKET', '') ? ([['bucket', env('S3_BUCKET', '')]] as [string, string][]) : []),
      ...objectKeys.map((k): [string, string] => ['object key', k]),
      ...assetIds.map((k): [string, string] => ['asset id', k]),
      ['stored file hash', storedSha],
      ['served file hash', servedSha],
      ...secretsOfUrls.map((k): [string, string] => ['URL signature', k]),
      ...trustDetailNeedles,
    ];
    const strangers = (value: Json, where: string, found: string[], path = '$'): void => {
      if (Array.isArray(value)) value.forEach((v, i) => strangers(v, where, found, `${path}[${i}]`));
      else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) {
          if (forbiddenKeys.test(k)) found.push(`${where}: forbidden key ${path}.${k}`);
          strangers(v, where, found, `${path}.${k}`);
        }
      else if (typeof value === 'string') {
        if (uuidRe.test(value)) {
          if (!allowedPublicIds.has(value)) found.push(`${where}: a stranger id at ${path}`);
          return;
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) found.push(`${where}: a URL at ${path}`);
        if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(value)) found.push(`${where}: an email-like value at ${path}`);
        if (/\+?\d[\d\s().-]{8,}\d/.test(value)) found.push(`${where}: a phone-like value at ${path}`);
        if (/[0-9a-f]{64}/i.test(value)) found.push(`${where}: a 64-hex hash at ${path}`);
      }
    };
    // public reads of the final state (more than one, so the scan covers every shape: 200, 404, photo 200/304/404)
    await publicJson(publicProfileId);
    await publicPhoto(publicProfileId);
    let scanned = 0;
    let jsonScanned = 0;
    for (const p of publicSeen) {
      scanned++;
      const problems: string[] = [];
      if (p.text) {
        try {
          strangers(JSON.parse(p.text), p.label, problems);
          jsonScanned++;
        } catch {
          // a non-JSON body is only scanned for values below
        }
      }
      for (const [name, value] of JSON.parse(p.headers) as [string, string][]) {
        // header NAMES are the platform's (etag, content-length ...); the VALUES must hold no hash, email or stranger id. The one exception is the OPAQUE weak ETag, which is itself a digest
        // of (asset id, content hash): it must have exactly that shape, and the needles below prove it is not the stored content hash.
        const opaqueEtag = name.toLowerCase() === 'etag' && /^W\/"[0-9a-f]{64}"$/.test(value);
        if ((!opaqueEtag && /[0-9a-f]{64}/i.test(value)) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(value) || (uuidRe.test(value) && !allowedPublicIds.has(value)))
          problems.push(`${p.label}: header ${name} holds a hash, an email or a stranger id`);
      }
      assert(problems.length === 0, `(13) ${problems.join('; ')}`);
      for (const [what, needle] of needles) {
        assert(!p.text.includes(needle) && !p.headers.includes(needle), `(13) ${p.label}: the response contains ${what}`);
        if (p.bytes) assert(!p.bytes.includes(Buffer.from(needle, 'utf8')), `(13) ${p.label}: the photo bytes contain ${what}`);
      }
    }
    assert(jsonScanned >= 8 && scanned >= 12, `(13) the deep scan covered the public responses (${scanned} responses, ${jsonScanned} JSON bodies)`);
    // reading the public side writes nothing: no audit row, no event (no page-view events)
    const counts1 = await database.query<{ audit: number; events: number }>(
      `SELECT (SELECT count(*)::int FROM provider.profile_audit_events WHERE account_id = $1::uuid) AS audit,
              (SELECT count(*)::int FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.profile-%' AND payload_json->>'accountId' = $1::text) AS events`,
      [accountId],
    );
    assert(counts1[0]!.audit === counts0[0]!.audit && counts1[0]!.events === counts0[0]!.events, '(13) public reads wrote no audit row and no event');
    // PRIVATE again hides profile AND photo at once; PUBLIC again brings them back
    const backToPrivate = read(OwnerProfileStateResponse, await vis(await revNow(), 'PRIVATE'), 200, '(13) set the visibility PRIVATE');
    assert(backToPrivate.profile.visibility === 'PRIVATE' && backToPrivate.profile.publishedAt === null, '(13) PRIVATE clears the publication time');
    assert(sameError(await publicJson(publicProfileId)) === sameError(unknownReply), '(13) a profile made PRIVATE disappears at once');
    assert((await publicPhoto(publicProfileId)).status === 404, '(13) and so does its photo');
    read(OwnerProfileStateResponse, await vis(await revNow(), 'PUBLIC'), 200, '(13) set the visibility PUBLIC again');
    assert((await publicJson(publicProfileId)).status === 200, '(13) PUBLIC again is readable again');

    // ---------------------------------------------------------------- (14) a second provider cannot mutate or read the owner endpoints
    const rA = await revNow();
    const snapA = await snapshot();
    const second14 = await owner('GET', '', tokB);
    const stateB = second14.json?.data;
    assert(
      second14.status === 200 &&
        stateB?.exists === false &&
        stateB.profile === null &&
        !second14.text.includes(publicProfileId) &&
        !second14.text.includes(displayName),
      `(14) the second provider's owner state is their own (no profile), never the owner's (${second14.status})`,
    );
    for (const [what, r] of [
      ['preview', await owner('GET', '/preview', tokB)],
      ['photo', await requestRaw('/provider/profile/photo', tokB).then((x) => ({ status: x.status, text: x.bytes.toString('latin1') }) as unknown as Reply)],
      ['change', await owner('PATCH', '', tokB, { expectedRevision: rA, displayName: 'Hijacked' })],
      ['visibility', await owner('POST', '/visibility', tokB, { expectedRevision: rA, visibility: 'PRIVATE' })],
      ['photo upload', await owner('POST', '/photo/uploads', tokB, { expectedRevision: rA, mimeType: 'image/jpeg', sizeBytes: 1000 }, false)],
      ['photo finalize', await owner('POST', '/photo/finalize', tokB, { expectedRevision: rA })],
      ['photo removal', await owner('DELETE', '/photo', tokB, { expectedRevision: rA })],
    ] as const) {
      assert(r.status === 404, `(14) the second provider's ${what} on the owner's data must be 404, never a success (${r.status})`);
      assert(
        !String(r.text).includes(publicProfileId) && !String(r.text).includes(displayName),
        `(14) the refusal for ${what} leaks nothing of the owner's profile`,
      );
    }
    for (const [what, body] of [
      ['change naming the owner profile id', { expectedRevision: rA, publicProfileId, displayName: 'Hijacked' }],
      ['change naming the owner account id', { expectedRevision: rA, accountId, displayName: 'Hijacked' }],
    ] as const)
      assert((await owner('PATCH', '', tokB, body)).status === 400, `(14) a ${what} must be 400 (the account is the caller's, never in a body)`);
    assert((await snapshot()) === snapA && (await revNow()) === rA, "(14) nothing of the owner's profile changed");
    // the second provider has their own profile, with another opaque id; their changes cannot touch the owner's
    const createB = await owner('POST', '', tokB, {});
    assert(createB.status === 201, `(14) the second provider creates their own profile (${createB.status})`);
    const profileB = (await stateOf(tokB)).profile;
    assert(profileB.publicProfileId !== publicProfileId && profileB.visibility === 'PRIVATE', '(14) the second profile has its own opaque id and is PRIVATE');
    read(
      OwnerProfileStateResponse,
      await owner('PATCH', '', tokB, { expectedRevision: profileB.revision, bio: `Other bio ${runId}` }),
      200,
      '(14) the second provider changes their own bio',
    );
    assert((await snapshot()) === snapA, "(14) the second provider's change did not reach the owner's profile");
    refusal(
      await owner('PATCH', '', tokA, { expectedRevision: profileB.revision + 100, displayName: 'Stale' }),
      409,
      'STALE_PROFILE',
      '(14) a revision of another profile is just a stale revision for the owner',
    );
    const rowsB = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider.public_profiles WHERE account_id IN ($1::uuid, $2::uuid)`, [
      accountId,
      second.accountId,
    ]);
    assert(rowsB[0]!.n === 2, '(14) one profile row per account');

    // ---------------------------------------------------------------- (15) trust detail stays private: no public or owner profile route, and the trust admin routes refuse providers
    const finalPublic = await publicJson(publicProfileId);
    for (const [what, needle] of trustDetailNeedles) assert(!finalPublic.text.includes(needle), `(15) the public profile carries trust detail: ${what}`);
    assert(
      !/verif|evidence|document|insurance|identity_/i.test(finalPublic.text.replace(/IDENTITY/g, '')),
      '(15) no verification vocabulary in the public profile beyond the badge type',
    );
    assert(
      (await trustAdmin('GET', '/cases')).status === 200 && (await request('/admin/trust/cases', 'GET', tokA)).status === 403,
      '(15) a provider token is 403 on the reviewers routes',
    );
    assert((await request('/admin/trust/cases', 'GET', null)).status === 401, '(15) the reviewers routes without a token are 401');
    for (const path of [`/providers/${publicProfileId}/verification`, `/providers/${publicProfileId}/documents`, `/providers/${publicProfileId}/cases`])
      assert((await request(path, 'GET', tokB)).status === 404, `(15) ${path.replace(publicProfileId, ':id')} does not exist`);

    // ---------------------------------------------------------------- (16) Go-Live remains not evaluated; (17) no BananaDrop data, no ratings
    const req16 = (await request('/provider/registration/requirements', 'GET', tokA)).json.data;
    assert(req16.overall.goLive.evaluated === false && req16.overall.goLive.eligible === false, '(16) the registration still does not evaluate Go-Live');
    assert(
      (await stepStatus(tokA, 'PROFILE')) === (readiness3.profileComplete ? 'COMPLETE' : 'IN_PROGRESS'),
      '(16) the PROFILE step stays a fact of the profile, not Go-Live',
    );
    const menu = (await request('/provider/gigs', 'GET', tokA)).json;
    const goLives: Json[] = [];
    const findGoLive = (v: Json): void => {
      if (Array.isArray(v)) v.forEach(findGoLive);
      else if (v && typeof v === 'object') {
        if ('goLive' in v) goLives.push(v.goLive);
        Object.values(v).forEach(findGoLive);
      }
    };
    findGoLive(menu);
    assert(
      goLives.length >= 1 && goLives.every((g) => g.evaluated === false && g.eligible === false),
      '(16) the GigMenu readiness says Go-Live is not evaluated and not eligible',
    );
    const profileBodies = [stateOf, async () => read(PreviewProviderProfileResponse, await owner('GET', '/preview', tokA), 200, 'preview')];
    for (const f of profileBodies) {
      const text = JSON.stringify(await f());
      assert(!/goLive|"live"|isLive|bookable|marketplaceEligib/i.test(text), '(16) a profile response carries no Go-Live or bookability fact');
    }
    assert(!/goLive|"live"|isLive|bookable/i.test(finalPublic.text), '(16) the public profile says nothing about being live or bookable');
    const finalData = read(PublicProviderProfileResponse, finalPublic, 200, '(17) the final public profile');
    assert(
      JSON.stringify(finalData.drops) === '{"available":false}' && JSON.stringify(finalData.ratings) === '{"available":false}',
      '(17) drops and ratings are placeholders with available:false',
    );
    assert(
      !/bananaDrop|drop_|dropEligible|average|rating"|reviewCount|stars|testimonial/i.test(
        finalPublic.text.replace('"ratings":{"available":false}', '').replace('"drops":{"available":false}', ''),
      ),
      '(17) no BananaDrop data and no rating values anywhere',
    );
    assert(
      finalData.gigs.every((g: Json) => !('bananaDrop' in g) && !('tier' in g) && !('rating' in g)),
      '(17) no Gig summary carries BananaDrop or rating fields',
    );

    // ---------------------------------------------------------------- (18) la-oc remains as it was (PLANNED in the seed); the retired Gig stays absent; the market in the profile is the DEV/TEST one
    const laocAfter = (await mgmt('geography', admin, 'GET', '/markets/la-oc')).json.data.status as string;
    assert(laocAfter === laocBefore, `(18) la-oc must stay as it was (${laocBefore} -> ${laocAfter})`);
    assert(finalData.market?.code === marketCode && finalData.market.code !== 'la-oc', '(18) the profile names the DEV/TEST market, never la-oc');
    assert(
      !finalPublic.text.includes(gigR.gigId) && !finalPublic.text.includes(gigText.retired.title),
      '(18) the retired Gig is absent from the public profile',
    );
    const menuAfter = (await request('/provider/gigs', 'GET', tokA)).json?.data?.gigs as Json[] | undefined;
    assert(
      !!menuAfter &&
        gigIdsAll.every((id) => menuAfter.some((g: Json) => g.gig.gigId === id)) &&
        menuAfter.find((g: Json) => g.gig.gigId === gigR.gigId)?.gig.status === 'RETIRED',
      '(18) the retired Gig is RETIRED in the owner menu (the history stays) and only absent publicly',
    );

    // ---------------------------------------------------------------- (19) the audit trail, the outbox and the logs hold no private profile field beyond allowed metadata
    const row = await database.query<{
      public_profile_id: string;
      display_name: string | null;
      bio: string | null;
      visibility_status: string;
      published_at: string | null;
      photo_asset_id: string | null;
      pending_photo_asset_id: string | null;
    }>(
      `SELECT public_profile_id::text, display_name, bio, visibility_status, published_at::text, photo_asset_id::text, pending_photo_asset_id::text
         FROM provider.public_profiles WHERE account_id = $1::uuid`,
      [accountId],
    );
    assert(
      row.length === 1 &&
        row[0]!.public_profile_id === publicProfileId &&
        row[0]!.display_name === displayName &&
        row[0]!.bio === bio &&
        row[0]!.visibility_status === 'PUBLIC' &&
        row[0]!.published_at !== null &&
        row[0]!.photo_asset_id !== null &&
        row[0]!.pending_photo_asset_id === null,
      `(19) the row stores only presentation (name, bio, photo reference, visibility); the photo is an asset reference (${JSON.stringify({ v: row[0]?.visibility_status, p: row[0]?.photo_asset_id !== null })})`,
    );
    const audit = await database.query<{ action: string; changes: string }>(
      `SELECT action, changes::text AS changes FROM provider.profile_audit_events WHERE account_id = $1::uuid`,
      [accountId],
    );
    const actions = new Set<string>(PROFILE_AUDIT_ACTIONS);
    const byAction = Object.fromEntries(PROFILE_AUDIT_ACTIONS.map((a) => [a, audit.filter((r) => r.action === a).length])) as Record<string, number>;
    assert(
      audit.every((r) => actions.has(r.action)) &&
        byAction['PROVIDER_PUBLIC_PROFILE_CREATED'] === 1 &&
        byAction['PROVIDER_PUBLIC_PROFILE_UPDATED']! >= 3 &&
        byAction['PROVIDER_PROFILE_PHOTO_CHANGED']! >= 1 &&
        byAction['PROVIDER_PROFILE_VISIBILITY_CHANGED']! >= 3,
      `(19) the audit trail holds the four actions, one creation (the repeat and the refused calls wrote nothing) (${JSON.stringify(byAction)})`,
    );
    const allowedWords = new Set<string>([...PROFILE_FIELD_NAMES, 'PRIVATE', 'PUBLIC', ...PROFILE_AUDIT_ACTIONS]);
    const onlyMetadata = (v: Json, bad: string[]): void => {
      if (Array.isArray(v)) v.forEach((x) => onlyMetadata(x, bad));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => onlyMetadata(x, bad));
      else if (typeof v === 'string' && !allowedWords.has(v)) bad.push(v.slice(0, 20));
    };
    for (const r of audit) {
      const bad: string[] = [];
      onlyMetadata(JSON.parse(r.changes), bad);
      assert(bad.length === 0, `(19) an audit row (${r.action}) holds a value that is not a field name, a revision or a visibility: ${bad.join()}`);
    }
    const events = await database.query<{ event_type: string; payload_json: Json }>(
      `SELECT event_type, payload_json FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.profile-%' AND payload_json->>'accountId' = $1::text`,
      [accountId],
    );
    assert(
      events.length >= 1 && events.some((e) => e.event_type === 'bananagig.provider.profile-visibility-changed.v1'),
      `(19) the profile events are in the outbox (${events.length})`,
    );
    for (const e of events) {
      const keys = Object.keys(e.payload_json).sort().join();
      if (e.event_type === 'bananagig.provider.profile-updated.v1')
        assert(
          keys === 'accountId,changedFields,publicProfileId,revision' &&
            (e.payload_json.changedFields as string[]).every((f) => (PROFILE_FIELD_NAMES as readonly string[]).includes(f)),
          `(19) the profile-updated payload has exactly the contract fields, field names only (${keys})`,
        );
      else if (e.event_type === 'bananagig.provider.profile-visibility-changed.v1')
        assert(keys === 'accountId,publicProfileId,visibility', `(19) the visibility payload has exactly the contract fields (${keys})`);
      else throw new Error(`(19) an unexpected profile event type ${e.event_type}`);
    }
    const stored = (audit.map((r) => r.changes).join(' ') + ' ' + events.map((e) => JSON.stringify(e.payload_json)).join(' ')) as string;
    const storedNeedles: [string, string][] = [
      ['display name', displayName],
      ['display name', `Smoke ${runId}`],
      ['bio', `care ${runId}`],
      ['bio', 'Second line'],
      ['fallback name', fallbackA],
      ['legal last name', legalA.last],
      ['email', A.email],
      ['phone', A.e164],
      ['phone digits', `555${A.tail}`],
      ['access token', tokA],
      ['signature', 'X-Amz'],
      ...objectKeys.map((k): [string, string] => ['object key', k]),
      ...assetIds.map((k): [string, string] => ['asset id', k]),
      ['file hash', storedSha],
      ['file hash', servedSha],
    ];
    for (const [what, needle] of storedNeedles) assert(!stored.includes(needle), `(19) the audit trail or the outbox holds ${what}`);
    // owner responses: no object key, asset id, hash or link (the upload authorizations, which hold a signed URL by design, were not kept)
    const ownerText = seenOwner.join('\n');
    for (const [what, needle] of [
      ...objectKeys.map((k): [string, string] => ['object key', k]),
      ...assetIds.map((k): [string, string] => ['asset id', k]),
      ['file hash', storedSha],
      ['file hash', servedSha],
      ...secretsOfUrls.map((k): [string, string] => ['URL signature', k]),
      ['signature', 'X-Amz'],
      ['access token', tokA],
    ] as [string, string][])
      assert(!ownerText.includes(needle), `(19) an owner profile response contains ${what}`);
    // logs: the flow reached Loki; the private fields are in no log line; the public path never logged the account id
    const query = async (q: string) =>
      (await (
        await expectOk(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${flowStart}&end=${Date.now() * 1e6 + 60e9}&limit=5`)
      ).json()) as { data: { result: unknown[] } };
    await retry(
      async () => {
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cid}\``)).data.result.length < 1)
          throw new Error('this flow is not in Loki yet');
        if ((await query(`{service_name="bananagig-api"} | correlationId = \`${cidPublic}\``)).data.result.length < 1)
          throw new Error('the public requests are not in Loki yet');
      },
      12,
      2000,
    );
    await sleep(6000);
    const logNeedles: [string, string][] = [
      ['display name', `Smoke ${runId}`],
      ['bio', `care ${runId}`],
      ['legal last name', legalA.last],
      ['email', A.email],
      ['phone', A.e164],
      ['access token', tokA],
      ['signature', 'X-Amz-Signature'],
      ...objectKeys.slice(0, 6).map((k): [string, string] => ['object key', k]),
      ...assetIds.slice(0, 4).map((k): [string, string] => ['asset id', k]),
      ['file hash', storedSha],
      ['file hash', servedSha],
      ...secretsOfUrls.slice(0, 8).map((k): [string, string] => ['URL signature', k]),
    ];
    for (const [what, needle] of logNeedles)
      assert((await query(`{service_name=~"bananagig-.+"} |= \`${needle}\``)).data.result.length === 0, `(19) the ${what} appears in the logs`);
    assert(
      (await query(`{service_name=~"bananagig-.+"} |= \`${cidPublic}\` |= \`${accountId}\``)).data.result.length === 0,
      '(19) the account id appears in a log line of the public requests',
    );

    return (
      `two throwaway providers (registration COMPLETED through the real flows) in a DEV/TEST market; owner journey: profile created idempotently (PRIVATE, fallback "${fallbackA}"), display name (NFC, validation table, clear), multi-line bio, ` +
      `JPEG with GPS EXIF + orientation uploaded through the presigned PUT (refusals: type, size, stale, hostile file, wrong hash), preview, trust badges from approved requirements (IDENTITY, INSURANCE; INSURANCE gone after expiry), ` +
      `one published Gig summary (draft, retired and draft-edit absent), visibility PUBLIC; anonymous read + photo (${scanned} public responses deep-scanned, ${jsonScanned} JSON bodies; sanitised photo: no GPS/EXIF/COM/tail, orientation and pixels kept, ` +
      `stored original keeps its hash), private/unknown/malformed ids answer the same 404, 304 on the opaque ETag; second provider: 404 on every owner route, own profile, no cross effect; trust detail private; Go-Live not evaluated; ` +
      `drops/ratings placeholders; la-oc ${laocBefore} untouched; audit/outbox hold field names only (${audit.length} audit rows, ${events.length} events); no private field in owner responses or logs`
    );
  } finally {
    // cleanup: the trust rule/definition are put back, the Gig template, service type and category are RETIRED and the DEV/TEST market deactivated (entities are never deleted); Keycloak users removed
    try {
      if (admin && ruleOn)
        await request('/admin/trust/requirement-rules', 'PUT', admin, {
          requirementCode: 'liability_insurance',
          marketCode,
          serviceTypeCode: null,
          enabled: false,
        });
      if (admin && definitionOn) await request('/admin/trust/requirement-definitions/liability_insurance/status', 'PUT', admin, { status: 'INACTIVE' });
      if (admin && marketCreated) {
        await request(`/catalog/gig-templates/${tpl}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/service-types/${serviceType}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/catalog/categories/${categoryCode}/status`, 'PUT', admin, { status: 'RETIRED', reason: 'smoke cleanup' });
        await request(`/geography/markets/${marketCode}/activation`, 'POST', admin, { active: false, reason: 'smoke cleanup' });
      }
    } catch {
      // best effort: the failure that got us here is the one to report
    }
    for (const id of kcUserIds) {
      try {
        await kcAdmin('DELETE', `/users/${id}`);
      } catch {
        // best effort
      }
    }
    valkey.disconnect();
    await database.close();
  }
}
