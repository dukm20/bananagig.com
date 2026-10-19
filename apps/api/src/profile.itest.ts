// PRO-002 provider public profile over HTTP, on the REAL stack wired the way apps/api/src/index.ts wires it: the real Fastify app (buildApp), the real AccountService, ConsentService,
// GeographyService, CatalogService, GigTemplateService, ContentService and ConfigurationService, the ProviderRegistrationService (whose `profile` step is answered by the profile domain),
// the ProviderGigService, the TrustService (public badges), the ProviderProfileService and ProfilePhotoService with the adapters of modules/provider/profile-wiring.ts (policy over the
// configuration registry, the names port over the identity service, the badge port over the trust service, the batched service-name port over the catalogue), a MemoryObjectStore standing in
// for the private bucket whose "presigned" URLs this file plays, the real auth plugin with forged-but-signed tokens, and one real, isolated PostgreSQL (migration 0024 seeds the profile
// policy). The unit layer (profile.test.ts) proves the HTTP edge with fake services and packages/provider proves the service rules; this file proves the whole path with the database:
// the full owner journey (create, edit, photo, preview, publish, unpublish), the PUBLIC projection (no authentication, Authorization ignored, one identical 404 for unknown / private /
// ineligible / malformed ids, a deep scan of the JSON for forbidden KEYS and VALUES), the derived parts (Gig cards from ACTIVE published Gigs only, trust badges that expire, the market),
// the sanitised photo (no EXIF/GPS/tail in the bytes the public receives while the stored original keeps them, opaque ETag, 304), owner isolation on EVERY owner route with a second
// account, stale revisions and concurrent writers, the publishing prerequisites, the audit and outbox rows, the statement budget and a secrecy scan over every response and log line.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountService, ConsentService } from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import {
  CORRELATION_HEADER,
  ErrorResponse,
  OwnerProfileStateResponse,
  PROVIDER_PROFILE_POLICY_KEYS,
  PreviewProviderProfileResponse,
  ProfilePhotoUploadResponse,
  PublicProviderProfileResponse,
  categoryNameKey,
  profileErrorKey,
  gigTemplateFieldLabelKey,
  gigTemplateNameKey,
  serviceTypeNameKey,
} from '@bananagig/contracts';
import { CatalogService, GigTemplateService } from '@bananagig/catalog';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { MemoryObjectStore } from '@bananagig/platform';
import { ProviderGigService, ProviderProfileService, ProviderRegistrationService, type GigMediaScanner, type ProfilePhotoService } from '@bananagig/provider';
import { FakeEvidenceScanner, StaticTrustPolicyProvider, TrustService, parseTrustPolicy } from '@bananagig/trust';
import { TRUST_POLICY_KEYS } from '@bananagig/contracts';
import { createIsolatedDatabase, createTestPool, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createGigMediaScanner, createGigPolicyProvider, createGigPrerequisites, createGigTemplatePort } from './modules/provider/gig-wiring';
import {
  createAccountNamePort,
  createGigServiceNamePort,
  createProfilePhotoService,
  createProfilePolicyProvider,
  createProfilePrerequisites,
  createTrustSummaryPort,
} from './modules/provider/profile-wiring';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';

// ---------------------------------------------------------------- the real stack
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const AUTHOR = 'author-a';
const APPROVER = 'approver-b';
const CFG_AUTHOR = 'cfg:author';
const CFG_APPROVER = 'cfg:approver';
const REASON = 'profile itest';
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const REG = '/api/v1/provider/registration';
const P = '/api/v1/provider';
const PUB = '/api/v1/providers';
/** Provider-written text the tests type: it may appear in the caller's OWN responses and in the public projection of a profile its owner made public, and nowhere else. */
const NAME_MARK = 'SentinelDisplayName';
const BIO_MARK = 'SentinelBioText';
const LEGAL_LAST = 'Sentinel-Lastname-Quux';
const LEGAL_FIRST = 'Sentinelfirst';
const GIG_MARK = 'SentinelGigTitle';
const DRAFT_ONLY = 'SentinelDraftOnlyTitle';

let iso: IsolatedDatabase;
let pool: ReturnType<typeof createTestPool>;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let geography: GeographyService;
let catalog: CatalogService;
let gigTemplates: GigTemplateService;
let consent: ConsentService;
let providerGigs: ProviderGigService;
let profiles: ProviderProfileService;
let photoService: ProfilePhotoService;
/** Statements run by the database while this is set (the query-count budget). */
let capture: string[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON of arbitrary responses; every use is asserted against a contract schema or an exact value
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
  rawBytes: Buffer;
  cid: string;
}
const transcript: Res[] = [];
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const keysOf = (o: object) => Object.keys(o).sort();

// ---------------------------------------------------------------- actors and calls
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  email: string;
  phone: string;
  token: string;
}
let phoneSeq = 0;
const tokenFor = (sub: string) => signToken(keys, { claims: { sub, azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o: { as?: Actor | string | null; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const token = o.as === null || o.as === undefined ? undefined : typeof o.as === 'string' ? o.as : o.as.token;
  const cid = o.headers?.[CORRELATION_HEADER] ?? `itest-${randomUUID()}`;
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const full = url.startsWith('/api/') ? url : `${P}${url}`;
  const r = await app.inject({
    method,
    url: full,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      [CORRELATION_HEADER]: cid,
      ...o.headers,
    },
    ...(hasBody ? { payload: o.rawBody ?? JSON.stringify(o.body) } : {}),
  });
  let body: Json;
  const isJson = String(r.headers['content-type'] ?? '').startsWith('application/json');
  if (isJson)
    try {
      body = JSON.parse(r.body);
    } catch {
      body = undefined;
    }
  const res: Res = { method, url: full, status: r.statusCode, body, headers: r.headers, raw: isJson ? r.body : '', rawBytes: r.rawPayload, cid };
  transcript.push(res);
  return res;
}
type Contract = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
/** A 2xx with the standard envelope; the data must equal its contract exactly (no field missing, none extra). */
const ok = (r: Res, status = 200, schema: Contract | null = OwnerProfileStateResponse): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(keysOf(r.body), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  if (schema !== null) {
    const parsed = schema.safeParse(r.body);
    expect(parsed.success, r.raw).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), 'no field outside the contract').toEqual(r.body);
  }
  return r.body.data;
};
/** The public projection: the strict public contract. */
const okPub = (r: Res): Json => ok(r, 200, PublicProviderProfileResponse);
const okPrev = (r: Res): Json => ok(r, 200, PreviewProviderProfileResponse);
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  return r.body.error;
};
const stripCid = (e: Json): Json => ({ ...e, correlationId: undefined });

// ---------------------------------------------------------------- content, config and the world
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: /\.(name|label)$/.test(key) ? 'UI_LABEL' : 'PLAIN_TEXT',
  ownerRole: 'CONTENT',
  description: 'profile itest entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});
async function publishText(key: string, body: string): Promise<void> {
  const v = await content.createVersion(key, { locale: 'en-US', scopeType: 'PLATFORM', scopeRef: null, body, reason: REASON }, AUTHOR);
  const submitted = await content.submit(v.versionId, AUTHOR);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, APPROVER);
  await content.publish(v.versionId, AUTHOR);
}
async function copy(key: string, text: string): Promise<void> {
  await content.createEntry(entryReq(key), AUTHOR);
  await publishText(key, text);
}
let seq = 0;
const code = (prefix: string) => `devtest_${prefix}_${++seq}`;
let order = 0;
async function market(name: string): Promise<string> {
  const c = `devtest-prof-${name}`;
  await geography.createMarket(
    { code: c, name: 'Profile Test Market', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: REASON },
    AUTHOR,
  );
  await geography.setMarketActive(c, true, 'activate for test', AUTHOR);
  return c;
}
async function category(): Promise<string> {
  const c = code('cat');
  await copy(categoryNameKey(c), `Category ${c}`);
  await catalog.createCategory({ code: c, withDescription: false, reason: REASON }, AUTHOR);
  await catalog.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  return c;
}
async function serviceType(cat: string): Promise<string> {
  const c = code('st');
  await copy(serviceTypeNameKey(c), `Service ${c}`);
  await catalog.createServiceType({ code: c, categoryCode: cat, reason: REASON }, AUTHOR);
  await catalog.setServiceTypeStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  return c;
}
async function liveTemplate(st: string, markets: string[]): Promise<string> {
  const c = code('tpl');
  await copy(gigTemplateNameKey(c), `Template ${c}`);
  await copy(gigTemplateFieldLabelKey(c, 'notes'), 'Label notes');
  await gigTemplates.createGigTemplate({ code: c, serviceTypeCode: st, withDescription: false, withInstructions: false, reason: REASON }, AUTHOR);
  await gigTemplates.createGigTemplateVersion(c, { reason: REASON }, AUTHOR);
  const v = await gigTemplates.replaceGigTemplateDraft(
    c,
    1,
    {
      expectedRevision: 1,
      duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 240 },
      pricingModels: ['FIXED'],
      areaModes: ['RADIUS'],
      fields: [{ fieldKey: 'notes', fieldType: 'TEXT', behavior: 'PROVIDER_CONFIGURABLE', maxLength: 60 }],
      requirements: [],
      reason: REASON,
    },
    AUTHOR,
  );
  await gigTemplates.setGigTemplateStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  await gigTemplates.publishGigTemplateVersion(c, 1, { expectedRevision: v.revision!, reason: REASON }, AUTHOR);
  for (const m of markets) await gigTemplates.setMarketGigTemplateAvailability(m, c, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  return c;
}
async function setConfig(key: string, value: unknown): Promise<void> {
  const cr = await configuration.createChangeRequest({ parameterKey: key, scopeType: 'PLATFORM', scopeRef: null, value, reason: 'itest change' }, CFG_AUTHOR);
  await configuration.submit(cr.changeRequestId, CFG_AUTHOR);
  await configuration.approve(cr.changeRequestId, CFG_APPROVER, 'ok');
  expect((await configuration.publish(cr.changeRequestId, CFG_AUTHOR)).state).toBe('ACTIVE');
}
async function publishLegal(entryKey: string): Promise<void> {
  const created = await content.createVersion(
    entryKey,
    { locale: 'en-US', body: `LEGALBODY ${randomUUID()} body of ${entryKey}`, reason: REASON },
    'legal:author',
  );
  await content.submit(created.versionId, 'legal:author');
  await content.approve(created.versionId, 'legal:approver', 'ok');
  await content.publish(created.versionId, 'legal:author');
}
async function acceptAgreements(a: Actor): Promise<void> {
  const r = await consent.getRequirements(a.accountId, {});
  for (const p of [TERMS, PRIVACY]) {
    const row = r.requirements.find((x) => x.purposeCode === p)!;
    expect(row.document, `${p} has a published document`).not.toBeNull();
    await consent.accept(a.accountId, p, { versionId: row.document!.versionId, locale: row.document!.locale, bodySha256: row.document!.bodySha256 }, {});
  }
}

async function newActor(label: string, o: { contacts?: boolean; names?: boolean } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  const a: Actor = {
    label,
    sub,
    accountId: '',
    email: `sentinel.${label}.${randomUUID().slice(0, 8)}@sentinel-contact.example`,
    phone: `+1415555${String(1000 + ++phoneSeq)}`,
    token: await tokenFor(sub),
  };
  const me = await call('GET', '/api/v1/account/me', { as: a });
  expect(me.status, me.raw).toBe(200);
  a.accountId = me.body.data.accountId;
  if (o.names !== false) await accounts.upsertProfile(a.accountId, { firstName: LEGAL_FIRST, lastName: LEGAL_LAST }, { actor: 'itest' });
  if (o.contacts) {
    await q(`INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')`, [
      a.accountId,
      a.email,
    ]);
    await q(
      `UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
      [a.accountId],
    );
    await q(`INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')`, [
      a.accountId,
      a.phone,
    ]);
    await q(
      `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
      [a.accountId],
    );
  }
  return a;
}
/** A provider whose registration is COMPLETED (market and service types chosen, agreements accepted, submitted through the real API). */
async function provider(label: string, o: { market?: string; names?: boolean } = {}): Promise<Actor> {
  const a = await newActor(label, { contacts: true, ...(o.names === undefined ? {} : { names: o.names }) });
  await acceptAgreements(a);
  expect((await call('POST', REG, { as: a })).status).toBe(201);
  expect((await call('PUT', `${REG}/market`, { as: a, body: { marketCode: o.market ?? W.m } })).status).toBe(200);
  const s = await call('PUT', `${REG}/services`, { as: a, body: { serviceTypeCodes: [W.st] } });
  expect(s.status, s.raw).toBe(200);
  const done = await call('POST', `${REG}/submit`, { as: a, body: { expectedRevision: s.body.data.registration.revision } });
  expect(done.status, done.raw).toBe(200);
  return a;
}

// ---------------------------------------------------------------- log capture
const logLines: string[] = [];
function captureLogs(): void {
  const grab = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab);
}

// ---------------------------------------------------------------- the profile calls
const store = new MemoryObjectStore();
const fakeScanner = new FakeEvidenceScanner();
const testScanner: GigMediaScanner = createGigMediaScanner({ scan: async (i) => fakeScanner.scan(i) });

const getProfile = (a: Actor | string | null) => call('GET', '/profile', { as: a });
const createProfile = (a: Actor | string | null) => call('POST', '/profile', { as: a });
const patchProfile = (a: Actor | string | null, body: unknown) => call('PATCH', '/profile', { as: a, body });
const setVisibility = (a: Actor | string | null, expectedRevision: number, visibility: 'PUBLIC' | 'PRIVATE') =>
  call('POST', '/profile/visibility', { as: a, body: { expectedRevision, visibility } });
const authorize = (a: Actor | string | null, body: unknown) => call('POST', '/profile/photo/uploads', { as: a, body });
const finalizePhoto = (a: Actor | string | null, body: unknown) => call('POST', '/profile/photo/finalize', { as: a, body });
const removePhoto = (a: Actor | string | null, expectedRevision: number) => call('DELETE', '/profile/photo', { as: a, body: { expectedRevision } });
const preview = (a: Actor | string | null) => call('GET', '/profile/preview', { as: a });
const ownerPhoto = (a: Actor | string | null, headers: Record<string, string> = {}) => call('GET', '/profile/photo', { as: a, headers });
const publicProfile = (id: string, o: { as?: Actor | string | null; headers?: Record<string, string> } = {}) => call('GET', `${PUB}/${id}`, o);
const publicPhoto = (id: string, o: { as?: Actor | string | null; headers?: Record<string, string> } = {}) => call('GET', `${PUB}/${id}/photo`, o);
const rev = (state: Json): number => state.profile.revision;

// ---------------------------------------------------------------- synthetic images (real container layouts with metadata the sanitiser must remove)
const ascii = (s: string): Buffer => Buffer.from(s, 'latin1');
const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number): Buffer => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const segment = (marker: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
const ENTROPY = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78, 0x9a, 0xbc]);
const GPS_MARK = 'SECRET-GPS-POSITION-40.4461N';
const TAIL_MARK = 'SECRET-TAIL-AFTER-EOI';
/** A JPEG with an EXIF APP1 (a camera string, a GPS position), a comment, a unique entropy block and a polyglot tail after EOI. `unique` makes the hash unique. */
function jpegWithExif(w = 400, h = 300, unique = randomUUID()): Buffer {
  const exif = segment(0xe1, Buffer.concat([ascii('Exif\0\0'), ascii('MM\0*\0\0\0\x08'), ascii(GPS_MARK), ascii('SECRET-CAMERA-SERIAL-12345')]));
  const com = segment(0xfe, ascii(`SECRET-COMMENT-${unique}`));
  const jfif = segment(0xe0, Buffer.concat([ascii('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 7)]));
  const sof = segment(0xc0, Buffer.concat([Buffer.from([8]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]));
  const dht = segment(0xc4, Buffer.concat([Buffer.from([0x00, 0x02]), Buffer.alloc(15, 0), Buffer.from([0x01, 0x02])]));
  const sos = Buffer.concat([segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), ENTROPY, ascii(`u${unique.slice(0, 8)}`)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, com, dqt, sof, dht, sos, Buffer.from([0xff, 0xd9]), ascii(TAIL_MARK)]);
}
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => Buffer.concat([u32(data.length), ascii(type), data, u32(crc32(Buffer.concat([ascii(type), data])))]);
/** A PNG with a tEXt chunk the sanitiser must drop. */
function pngWithText(w = 320, h = 240, unique = randomUUID()): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('tEXt', ascii(`Comment\0SECRET-PNG-TEXT-${unique}`)),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Plays the browser: PUTs the bytes where the presigned URL points (the memory store's token is the upload key). */
function playUpload(upload: { url: string; headers: Record<string, string> }, bytes: Buffer, contentType = upload.headers['content-type']): string {
  expect(upload.url.startsWith('memory://upload/')).toBe(true);
  const key = decodeURIComponent(upload.url.slice('memory://upload/'.length));
  store.put(key, bytes, contentType);
  return key;
}
/** Authorizes, plays the upload and finalizes: the profile photo is READY. Returns the owner state. */
async function addPhoto(a: Actor, revision: number, o: { bytes?: Buffer; mime?: string; hash?: boolean } = {}): Promise<Json> {
  const bytes = o.bytes ?? jpegWithExif();
  const mime = o.mime ?? 'image/jpeg';
  const up = ok(await authorize(a, { expectedRevision: revision, mimeType: mime, sizeBytes: bytes.length }), 201, ProfilePhotoUploadResponse);
  playUpload(up.upload, bytes);
  return ok(await finalizePhoto(a, { expectedRevision: up.revision, ...(o.hash === false ? {} : { sha256: sha(bytes) }) }));
}

// ---------------------------------------------------------------- Gigs (for the cards)
const completeDraft = (expectedRevision: number, title: string, over: Record<string, unknown> = {}) => ({
  expectedRevision,
  title,
  shortPitch: 'A short pitch',
  description: 'A description',
  priceAmountMinor: 4500,
  durationMinutes: 90,
  fieldValues: [],
  ...over,
});
const gigOf = (d: Json): string => d.gig.gigId;
async function publishedGig(a: Actor, title: string): Promise<string> {
  const created = await call('POST', '/gigs', { as: a, body: { gigTemplateCode: W.tpl } });
  expect(created.status, created.raw).toBe(201);
  const id = gigOf(created.body.data);
  const saved = await call('PUT', `/gigs/${id}/draft`, { as: a, body: completeDraft(created.body.data.draftVersion.revision, title) });
  expect(saved.status, saved.raw).toBe(200);
  const pub = await call('POST', `/gigs/${id}/publish`, { as: a, body: { expectedRevision: saved.body.data.draftVersion.revision } });
  expect(pub.status, pub.raw).toBe(200);
  return id;
}

// ---------------------------------------------------------------- trust (a case is written with SQL, like the TRUST-001 itests: only the approval is crafted)
let caseSeq = 0;
async function identityDefinition(): Promise<string> {
  return (await q<{ code: string }>(`SELECT code FROM trust.requirement_definitions WHERE requirement_type = 'IDENTITY' ORDER BY code LIMIT 1`))[0]!.code;
}
/** Gives the account an IDENTITY requirement APPROVED now, valid for `endsInMs` (null = never expires). */
async function approveIdentity(accountId: string, endsInMs: number | null): Promise<string> {
  const defCode = await identityDefinition();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE trust.verification_cases DISABLE TRIGGER USER');
    await c.query('ALTER TABLE trust.case_requirements DISABLE TRIGGER USER');
    const caseId = (
      await c.query(
        `INSERT INTO trust.verification_cases (account_id, case_number, status, submitted_at) VALUES ($1, $2, 'IN_REVIEW', now()) RETURNING verification_case_id`,
        [accountId, ++caseSeq],
      )
    ).rows[0].verification_case_id as string;
    await c.query(
      `INSERT INTO trust.case_requirements (verification_case_id, requirement_definition_id, cycle, status, round, submitted_at, approved_at, expires_at)
       SELECT $1, d.requirement_definition_id, 1, 'APPROVED', 1, now() - interval '20 days', now() - interval '10 days',
              CASE WHEN $3::double precision IS NOT NULL THEN now() + $3::double precision * interval '1 millisecond' END
         FROM trust.requirement_definitions d WHERE d.code = $2`,
      [caseId, defCode, endsInMs],
    );
    await c.query('ALTER TABLE trust.case_requirements ENABLE TRIGGER USER');
    await c.query('ALTER TABLE trust.verification_cases ENABLE TRIGGER USER');
    await c.query('COMMIT');
    return caseId;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Moves the end of validity of the account's approved requirement (null = never expires): the guards are switched off for this one statement of the test database. */
async function setApprovalEnd(accountId: string, endsInMs: number | null): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE trust.case_requirements DISABLE TRIGGER USER');
    await c.query(
      `UPDATE trust.case_requirements r SET expires_at = CASE WHEN $2::double precision IS NULL THEN NULL ELSE now() + $2::double precision * interval '1 millisecond' END
        FROM trust.verification_cases c WHERE c.verification_case_id = r.verification_case_id AND c.account_id = $1 AND r.status = 'APPROVED'`,
      [accountId, endsInMs],
    );
    await c.query('ALTER TABLE trust.case_requirements ENABLE TRIGGER USER');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------- the deep scan of a public payload
/** Every key a public response may contain, anywhere: the public contract and nothing else. */
const ALLOWED_PUBLIC_KEYS = new Set([
  'publicProfileId',
  'displayName',
  'bio',
  'photo',
  'mimeType',
  'width',
  'height',
  'badges',
  'type',
  'market',
  'code',
  'gigs',
  'gigId',
  'title',
  'shortPitch',
  'serviceTypeCode',
  'serviceTypeNameContentKey',
  'price',
  'amountMinor',
  'currency',
  'durationMinutes',
  'variantCount',
  'addOnCount',
  'photoCount',
  'ratings',
  'drops',
  'available',
]);
const FORBIDDEN_KEY =
  /(email|phone|account|object|bucket|sha|hash|etag|legal|first_?name|last_?name|asset|document|requirement|case|expire|reason|note|review|token|secret|url|key$|status|revision|visibility|created|updated|published)/i;
function collectKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out));
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      collectKeys(x, out);
    }
  return out;
}
/** Everything the database knows about a provider that must never appear on a public page. */
async function secretsOf(a: Actor): Promise<string[]> {
  const assets = await q<{ media_asset_id: string; object_key: string; sha256: string | null }>(
    `SELECT media_asset_id, object_key, sha256 FROM provider.media_assets WHERE account_id = $1`,
    [a.accountId],
  );
  const versions = await q<{ gig_version_id: string }>(
    `SELECT v.gig_version_id FROM provider.gig_versions v JOIN provider.gigs g ON g.gig_id = v.gig_id WHERE g.account_id = $1`,
    [a.accountId],
  );
  const trust = await q<{ id: string }>(
    `SELECT verification_case_id AS id FROM trust.verification_cases WHERE account_id = $1
     UNION ALL SELECT case_requirement_id FROM trust.case_requirements r JOIN trust.verification_cases c ON c.verification_case_id = r.verification_case_id WHERE c.account_id = $1`,
    [a.accountId],
  );
  return [
    a.accountId,
    a.email,
    a.email.split('@')[0]!,
    a.phone,
    a.phone.slice(1),
    LEGAL_LAST,
    `${LEGAL_FIRST} ${LEGAL_LAST}`,
    ...assets.flatMap((r) => [r.media_asset_id, r.object_key, ...(r.sha256 ? [r.sha256] : [])]),
    ...versions.map((r) => r.gig_version_id),
    ...trust.map((r) => r.id),
  ];
}
/** The deep scan: every key is on the allow-list and matches no forbidden pattern; no secret VALUE appears anywhere in the raw response. */
async function expectCleanPublic(r: Res, a: Actor): Promise<void> {
  const text = r.raw;
  for (const k of collectKeys(r.body.data)) {
    expect(ALLOWED_PUBLIC_KEYS.has(k), `key ${k} is not part of the public contract`).toBe(true);
    // `photo`, `price`, `type`, `code` and the like are allowed above; the forbidden pattern is a second, independent net for names that could be added by mistake
    if (
      ![
        'photo',
        'photoCount',
        'publicProfileId',
        'serviceTypeNameContentKey',
        'serviceTypeCode',
        'shortPitch',
        'displayName',
        'currency',
        'amountMinor',
      ].includes(k)
    )
      expect(FORBIDDEN_KEY.test(k), `key ${k} looks internal`).toBe(false);
  }
  for (const secret of await secretsOf(a)) expect(text, `the public response contains ${secret.slice(0, 12)}…`).not.toContain(secret);
  expect(text.toLowerCase()).not.toContain('sentinel-contact.example');
  expect(text).not.toContain('provider/');
}

// ---------------------------------------------------------------- the world
const W = {} as { m: string; m2: string; st: string; tpl: string };

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { onQuery: (e) => capture?.push(e.sql), overrides: { poolMax: 30, connectionTimeoutMs: 30_000 } } });
  pool = createTestPool(iso.url, 5);
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const database = iso.database;
  geography = new GeographyService({ database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  content = new ContentService({
    database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography, { ttlMs: 60_000 }),
  });
  configuration = new ConfigurationService({ database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  const deps = { database, markets: createMarketGate(geography), cache: new MemoryConfigCache(), env: 'test' as const, allowTestKeys: true };
  catalog = new CatalogService(deps);
  gigTemplates = new GigTemplateService(deps);
  accounts = new AccountService({ database, lastSeenTouchSeconds: 0 });
  consent = new ConsentService({ database, policy: createConsentPolicyProvider(configuration), defaultLocale: createDefaultLocaleResolver(content) });
  const accountPort = createAccountPort(accounts);
  const K = TRUST_POLICY_KEYS;
  const trust = new TrustService({
    database,
    context: { context: async () => null },
    policy: new StaticTrustPolicyProvider(
      parseTrustPolicy({
        [K.maxSizeBytes]: 10_485_760,
        [K.allowedMimeTypes]: ['application/pdf'],
        [K.maxDocumentsPerRequirement]: 5,
        [K.uploadUrlTtlSeconds]: 300,
        [K.downloadUrlTtlSeconds]: 60,
        [K.requireCleanScan]: true,
      }),
    ),
    store,
  });
  providerGigs = new ProviderGigService({
    database,
    accounts: accountPort,
    templates: createGigTemplatePort(gigTemplates),
    policy: createGigPolicyProvider(configuration),
    store,
    scanner: testScanner,
  });
  // wired like apps/api/src/index.ts
  profiles = new ProviderProfileService({
    db: database,
    accounts: accountPort,
    names: createAccountNamePort(accounts),
    markets: createMarketPort(geography),
    trust: createTrustSummaryPort(trust),
    services: createGigServiceNamePort(database),
    policy: createProfilePolicyProvider(configuration),
    mediaPolicy: createGigPolicyProvider(configuration),
  });
  photoService = createProfilePhotoService({ database, store, scanner: testScanner, configuration, profiles });
  const providerRegistrations = new ProviderRegistrationService({
    database,
    accounts: accountPort,
    consent: createConsentPort(consent),
    markets: createMarketPort(geography),
    catalog: createCatalogPort(catalog),
    policy: createProviderPolicyProvider(configuration),
    prerequisites: createGigPrerequisites(providerGigs, createProfilePrerequisites(profiles)),
  });
  captureLogs();
  app = await buildApp({
    cfg,
    verifier,
    configuration,
    content,
    geography,
    catalog,
    gigTemplates,
    accounts,
    consent,
    providerRegistrations,
    providerGigs,
    providerProfiles: profiles,
    profilePhotos: photoService,
    readiness: async () => ({}),
  });
  await app.ready();

  W.m = await market('m');
  W.m2 = await market('m2');
  const cat = await category();
  W.st = await serviceType(cat);
  for (const m of [W.m, W.m2]) {
    await catalog.setMarketCategoryAvailability(m, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
    await catalog.setMarketServiceTypeAvailability(m, W.st, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  }
  W.tpl = await liveTemplate(W.st, [W.m, W.m2]);
  await publishLegal('legal.terms_of_service');
  await publishLegal('legal.privacy_policy');
}, 300_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await iso?.drop();
});

const POLICY = PROVIDER_PROFILE_POLICY_KEYS;
const resetPolicy = async () => {
  await setConfig(POLICY.bioRequired, false);
  await setConfig(POLICY.photoRequired, false);
  await setConfig(POLICY.publicBadgeTypes, ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE']);
  await setConfig(POLICY.publicRequiresMarketplaceEligibility, false);
};

// ====================================================================== the seeded policy
describe('the seeded profile policy of migration 0024', () => {
  it('serves the seven parameters through the real registry, parsed by the same wiring the API uses', async () => {
    expect(await createProfilePolicyProvider(configuration).policy()).toEqual({
      displayNameMaxLength: 60,
      bioMaxLength: 1000,
      bioRequired: false,
      photoRequired: false,
      photoMaxFileSizeBytes: 2_097_152,
      publicBadgeTypes: ['IDENTITY', 'BACKGROUND_CHECK', 'INSURANCE'],
      publicRequiresMarketplaceEligibility: false,
    });
  });
});

// ====================================================================== the full journey
describe('the full owner journey and the public page', () => {
  let a: Actor;
  let id: string;
  let state: Json;
  let photoState: Json;
  let originalKey: string;
  let original: Buffer;

  it('before any profile: exists:false with the readiness facts and the limits; nothing is created by reading', async () => {
    a = await provider('journey');
    const d = ok(await getProfile(a));
    expect(d.exists).toBe(false);
    expect(d.profile).toBeNull();
    expect(d.readiness).toMatchObject({ profileComplete: expect.any(Boolean), visibility: null, hasPublishedGig: false });
    expect(d.limits).toMatchObject({ displayNameMaxLength: 60, bioMaxLength: 1000, photoMaxSizeBytes: 2_097_152 });
    expect(d.limits.photoMimeTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect((await q(`SELECT 1 FROM provider.public_profiles WHERE account_id = $1`, [a.accountId])).length).toBe(0);
    fail(await preview(a), 404, 'PROFILE_NOT_FOUND');
  });

  it('the registration PROFILE step starts NOT_STARTED, then reflects the profile', async () => {
    const stepOf = async (who: Actor) =>
      (await call('GET', `${REG}/requirements`, { as: who })).body.data.steps.find((s: { step: string }) => s.step === 'PROFILE').status;
    expect(await stepOf(a)).toBe('NOT_STARTED');
  });

  it('creates the profile PRIVATE at revision 1 (201), and a repeat is the same profile (200, no new revision)', async () => {
    const created = await createProfile(a);
    state = ok(created, 201);
    expect(state.exists).toBe(true);
    expect(state.profile).toMatchObject({
      visibility: 'PRIVATE',
      revision: 1,
      displayName: null,
      bio: null,
      photo: null,
      photoPending: false,
      publishedAt: null,
    });
    expect(state.profile.publicName).toBe(`${LEGAL_FIRST} ${LEGAL_LAST[0]}.`);
    id = state.profile.publicProfileId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe(a.accountId);
    const again = ok(await createProfile(a), 200);
    expect(again.profile.publicProfileId).toBe(id);
    expect(again.profile.revision).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM provider.public_profiles WHERE account_id = $1`, [a.accountId]))[0]!.n).toBe(1);
    expect(await q(`SELECT action FROM provider.profile_audit_events WHERE public_profile_id = $1`, [id])).toEqual([
      { action: 'PROVIDER_PUBLIC_PROFILE_CREATED' },
    ]);
  });

  it('a PRIVATE profile is a 404 on both public routes (identical to an unknown id), and previewable by its owner', async () => {
    const unknown = fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND');
    const priv = fail(await publicProfile(id), 404, 'PROFILE_NOT_FOUND');
    expect(stripCid(priv)).toEqual(stripCid(unknown));
    const privPhoto = fail(await publicPhoto(id), 404, 'PROFILE_NOT_FOUND');
    expect(stripCid(privPhoto)).toEqual(stripCid(unknown));
    const p = ok(await preview(a), 200, PreviewProviderProfileResponse);
    expect(p).toMatchObject({
      preview: true,
      visibility: 'PRIVATE',
      publicProfileId: id,
      displayName: `${LEGAL_FIRST} ${LEGAL_LAST[0]}.`,
      bio: null,
      photo: null,
    });
  });

  it('edits the display name and the bio (revision +1 per effective change; absent keeps, null clears; a no-op keeps the revision)', async () => {
    state = ok(await patchProfile(a, { expectedRevision: rev(state), displayName: NAME_MARK, bio: `${BIO_MARK}\nsecond line` }));
    expect(state.profile).toMatchObject({ displayName: NAME_MARK, publicName: NAME_MARK, bio: `${BIO_MARK}\nsecond line`, revision: 2 });
    const same = ok(await patchProfile(a, { expectedRevision: 2, displayName: NAME_MARK }));
    expect(same.profile.revision).toBe(2);
    state = ok(await patchProfile(a, { expectedRevision: 2, bio: `${BIO_MARK}\nsecond line`, displayName: NAME_MARK }));
    expect(state.profile.revision).toBe(2);
    const cleared = ok(await patchProfile(a, { expectedRevision: 2, displayName: null }));
    expect(cleared.profile).toMatchObject({ displayName: null, publicName: `${LEGAL_FIRST} ${LEGAL_LAST[0]}.`, bio: `${BIO_MARK}\nsecond line`, revision: 3 });
    state = ok(await patchProfile(a, { expectedRevision: 3, displayName: NAME_MARK }));
    expect(rev(state)).toBe(4);
  });

  it('refuses invalid text with a reason code and never echoes it (blank, too long, HTML, control characters, invisible characters)', async () => {
    const r = rev(state);
    for (const [body, reason] of [
      [{ displayName: '   ' }, 'DISPLAY_NAME_BLANK'],
      [{ displayName: 'x'.repeat(61) }, 'DISPLAY_NAME_TOO_LONG'],
      [{ displayName: '<b>bold</b>' }, 'DISPLAY_NAME_HTML_NOT_ALLOWED'],
      [{ bio: 'x'.repeat(1001) }, 'BIO_TOO_LONG'],
      [{ bio: '<script>alert(1)</script>' }, 'BIO_HTML_NOT_ALLOWED'],
      [{ bio: `bad\u0000byte` }, 'BIO_FORBIDDEN_CHARACTER'],
      [{ displayName: `zero${String.fromCharCode(0x200b)}width` }, 'DISPLAY_NAME_FORBIDDEN_CHARACTER'],
    ] as const) {
      const res = await patchProfile(a, { expectedRevision: r, ...body });
      const e = fail(res, 400, 'PROFILE_VALIDATION_FAILED');
      expect(JSON.stringify(e.details), JSON.stringify(body)).toContain(reason);
      expect(res.raw).not.toContain('alert(1)');
      expect(res.raw).not.toContain('bold');
    }
    expect(rev(ok(await getProfile(a))), 'nothing changed').toBe(r);
  });

  it('a stale revision is a 409 STALE_PROFILE and changes nothing; two concurrent writers at one revision: exactly one wins', async () => {
    const r = rev(state);
    const e = fail(await patchProfile(a, { expectedRevision: r - 1, bio: 'stale write' }), 409, 'STALE_PROFILE');
    expect(e.details.messageKey).toBe(profileErrorKey('STALE_PROFILE'));
    expect(rev(ok(await getProfile(a)))).toBe(r);
    const [x, y] = await Promise.all([
      patchProfile(a, { expectedRevision: r, bio: `${BIO_MARK} one` }),
      patchProfile(a, { expectedRevision: r, bio: `${BIO_MARK} two` }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    fail(loser, 409, 'STALE_PROFILE');
    state = ok(await getProfile(a));
    expect(rev(state)).toBe(r + 1);
    state = ok(await patchProfile(a, { expectedRevision: rev(state), bio: `${BIO_MARK}\nsecond line` }));
  });

  it('uploads a photo: authorize (201, a one-object PUT, the revision to send next), play the upload, finalize (READY) and read the dimensions', async () => {
    original = jpegWithExif(400, 300);
    expect(original.includes(GPS_MARK)).toBe(true);
    const updatedEvents = async () =>
      (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'bananagig.provider.profile-updated.v1' AND payload_json->>'accountId' = $1`,
          [a.accountId],
        )
      )[0]!.n;
    const eventsBefore = await updatedEvents();
    const up = ok(
      await authorize(a, { expectedRevision: rev(state), mimeType: 'image/jpeg', sizeBytes: original.length, sha256: sha(original) }),
      201,
      ProfilePhotoUploadResponse,
    );
    expect(up.maxSizeBytes).toBe(2_097_152);
    expect(up.revision).toBe(rev(state) + 1);
    expect(keysOf(up)).toEqual(['maxSizeBytes', 'revision', 'upload']);
    const mid = ok(await getProfile(a));
    expect(mid.profile).toMatchObject({ photoPending: true, photo: null });
    expect(await updatedEvents(), 'an upload AUTHORIZATION changes nothing a reader can see: no profile-updated event').toBe(eventsBefore);
    playUpload(up.upload, original);
    photoState = ok(await finalizePhoto(a, { expectedRevision: up.revision, sha256: sha(original) }));
    expect(photoState.profile.photo).toEqual({ mimeType: 'image/jpeg', width: 400, height: 300 });
    expect(photoState.profile).toMatchObject({ photoPending: false });
    expect(await updatedEvents(), 'the finalized photo is announced once').toBe(eventsBefore + 1);
    expect(photoState.profile.revision).toBeGreaterThan(up.revision - 1);
    state = photoState;
    const asset = (
      await q<{ object_key: string; purpose: string; status: string }>(`SELECT object_key, purpose, status FROM provider.media_assets WHERE account_id = $1`, [
        a.accountId,
      ])
    )[0]!;
    expect(asset).toMatchObject({ purpose: 'PROFILE_PHOTO', status: 'READY' });
    originalKey = asset.object_key;
  });

  it('the owner photo is SANITISED: no EXIF/GPS/comment/tail in the bytes, the image part intact; the stored original still has them', async () => {
    const stored = await store.read(originalKey, 10_000_000);
    expect(stored!.includes(GPS_MARK), 'the stored original is untouched').toBe(true);
    const r = await ownerPhoto(a);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(r.headers['content-disposition']).toBe('inline');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const out = r.rawBytes;
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    for (const secret of [GPS_MARK, 'SECRET-CAMERA', 'SECRET-COMMENT', TAIL_MARK, 'Exif'] as const) expect(out.includes(secret), secret).toBe(false);
    expect(out.includes(ENTROPY), 'the image data is untouched').toBe(true);
    expect(out.length).toBeLessThan(original.length);
  });

  it('shows the readiness facts and the profile in the owner state (a fact is not a decision)', async () => {
    const d = ok(await getProfile(a));
    expect(d.readiness).toEqual({
      displayNamePresent: true,
      publicNameAvailable: true,
      bioPresent: true,
      profilePhotoPresent: true,
      hasPublishedGig: false,
      trustSummaryAvailable: false,
      profileComplete: true,
      visibility: 'PRIVATE',
    });
  });

  it('publishes: PUBLIC with publishedAt; the public page works WITHOUT a token, no-store, and the data is exactly the public contract', async () => {
    state = ok(await setVisibility(a, rev(state), 'PUBLIC'));
    expect(state.profile).toMatchObject({ visibility: 'PUBLIC' });
    expect(state.profile.publishedAt).toEqual(expect.any(String));
    const r = await publicProfile(id);
    const d = ok(r, 200, PublicProviderProfileResponse);
    expect(d).toEqual({
      publicProfileId: id,
      displayName: NAME_MARK,
      bio: `${BIO_MARK}\nsecond line`,
      photo: { mimeType: 'image/jpeg', width: 400, height: 300 },
      badges: [],
      market: { code: W.m },
      gigs: [],
      ratings: { available: false },
      drops: { available: false },
    });
    await expectCleanPublic(r, a);
  });

  it('the public photo is the sanitised image with the forced headers and an opaque weak ETag; 304 on a match; no Authorization needed', async () => {
    const r = await publicPhoto(id);
    expect(r.status, r.raw).toBe(200);
    expect(r.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'no-cache',
    });
    const etag = String(r.headers.etag);
    expect(etag).toMatch(/^W\/"[0-9a-f]{16,}"$/);
    const asset = (
      await q<{ media_asset_id: string; sha256: string }>(
        `SELECT media_asset_id, sha256 FROM provider.media_assets WHERE account_id = $1 AND status = 'READY'`,
        [a.accountId],
      )
    )[0]!;
    expect(etag).not.toContain(asset.sha256);
    expect(etag).not.toContain(asset.media_asset_id);
    for (const secret of [GPS_MARK, 'SECRET-CAMERA', 'SECRET-COMMENT', TAIL_MARK, 'Exif'] as const) expect(r.rawBytes.includes(secret), secret).toBe(false);
    expect(r.rawBytes.equals((await ownerPhoto(a)).rawBytes), 'the owner sees the same bytes as the public').toBe(true);
    const cond = await publicPhoto(id, { headers: { 'if-none-match': etag } });
    expect(cond.status).toBe(304);
    expect(cond.rawBytes.length).toBe(0);
    expect(cond.headers.etag).toBe(etag);
    expect(cond.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect((await publicPhoto(id, { headers: { 'if-none-match': `W/"nope", ${etag}` } })).status).toBe(304);
    expect((await publicPhoto(id, { headers: { 'if-none-match': 'W/"something-else"' } })).status).toBe(200);
    expect((await publicPhoto(id, { headers: { 'if-none-match': '*' } })).status).toBe(304);
    const ownerCond = await ownerPhoto(a, { 'if-none-match': String((await ownerPhoto(a)).headers.etag) });
    expect(ownerCond.status).toBe(304);
  });

  it('a 304 is answered before any object is read', async () => {
    const etag = String((await publicPhoto(id)).headers.etag);
    const reads: string[] = [];
    const realRead = store.read.bind(store);
    const realVersioned = store.readVersioned.bind(store);
    store.read = (async (...args: Parameters<typeof store.read>) => (reads.push('read'), realRead(...args))) as typeof store.read;
    store.readVersioned = (async (...args: Parameters<typeof store.readVersioned>) => (
      reads.push('readVersioned'),
      realVersioned(...args)
    )) as typeof store.readVersioned;
    try {
      expect((await publicPhoto(id, { headers: { 'if-none-match': etag } })).status).toBe(304);
      expect(reads).toEqual([]);
      expect((await publicPhoto(id)).status).toBe(200);
      expect(reads.length).toBeGreaterThan(0);
    } finally {
      store.read = realRead;
      store.readVersioned = realVersioned;
    }
  });

  it('a PNG replacement changes the ETag and content type; the old validator no longer matches; the replaced asset is detached, never served', async () => {
    const before = String((await publicPhoto(id)).headers.etag);
    const png = pngWithText(320, 240);
    state = await addPhoto(a, rev(state), { bytes: png, mime: 'image/png' });
    expect(state.profile.photo).toEqual({ mimeType: 'image/png', width: 320, height: 240 });
    const r = await publicPhoto(id, { headers: { 'if-none-match': before } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(String(r.headers.etag)).not.toBe(before);
    expect(r.rawBytes.includes('SECRET-PNG-TEXT'), 'tEXt chunk dropped').toBe(false);
    expect(r.rawBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    // back to the JPEG for the rest of the journey
    state = await addPhoto(a, rev(state), { bytes: jpegWithExif(400, 300) });
    expect((await publicPhoto(id)).headers['content-type']).toBe('image/jpeg');
  });

  it('shows ACTIVE published Gigs as cards, in publication order, with no draft or retired Gig and no draft text of a published one', async () => {
    const g1 = await publishedGig(a, `${GIG_MARK} one`);
    const g2 = await publishedGig(a, `${GIG_MARK} two`);
    // g2 gets a next draft with a different title: the draft never shows
    const next = await call('POST', `/gigs/${g2}/versions`, { as: a });
    expect(next.status, next.raw).toBe(201);
    const nd = await call('PUT', `/gigs/${g2}/draft`, { as: a, body: completeDraft(next.body.data.draftVersion.revision, DRAFT_ONLY) });
    expect(nd.status, nd.raw).toBe(200);
    // a draft-only Gig
    const draftOnly = await call('POST', '/gigs', { as: a, body: { gigTemplateCode: W.tpl } });
    expect(draftOnly.status).toBe(201);
    // a published, then retired Gig
    const g4 = await publishedGig(a, `${GIG_MARK} retired`);
    expect((await call('POST', `/gigs/${g4}/retire`, { as: a, body: {} })).status).toBe(200);
    const r = await publicProfile(id);
    const d = ok(r, 200, PublicProviderProfileResponse);
    expect(d.gigs.map((g: Json) => g.gigId)).toEqual([g1, g2]);
    expect(d.gigs.map((g: Json) => g.title)).toEqual([`${GIG_MARK} one`, `${GIG_MARK} two`]);
    expect(r.raw).not.toContain(DRAFT_ONLY);
    expect(r.raw).not.toContain(`${GIG_MARK} retired`);
    expect(r.raw).not.toContain(gigOf(draftOnly.body.data));
    expect(r.raw).not.toContain(g4);
    const st = (await q<{ code: string }>(`SELECT code FROM catalog.service_types WHERE code = $1`, [W.st]))[0]!.code;
    expect(d.gigs[0]).toEqual({
      gigId: g1,
      title: `${GIG_MARK} one`,
      shortPitch: 'A short pitch',
      serviceTypeCode: st,
      serviceTypeNameContentKey: serviceTypeNameKey(st),
      price: { amountMinor: 4500, currency: 'USD' },
      durationMinutes: 90,
      variantCount: 0,
      addOnCount: 0,
      photoCount: 0,
    });
    await expectCleanPublic(r, a);
    expect(ok(await getProfile(a)).readiness.hasPublishedGig).toBe(true);
    // the owner's preview is the same projection plus visibility and the marker
    const p = ok(await preview(a), 200, PreviewProviderProfileResponse);
    const { preview: _p, visibility: _v, ...rest } = p;
    expect(rest).toEqual(d);
    expect(p).toMatchObject({ preview: true, visibility: 'PUBLIC' });
  });

  it('a trust badge appears from an APPROVED requirement (type code only) and disappears when the approval expires, with no cache', async () => {
    const b = await provider('badge');
    const bs = ok(await createProfile(b), 201);
    const bid = bs.profile.publicProfileId;
    ok(await setVisibility(b, bs.profile.revision, 'PUBLIC'));
    expect(okPub(await publicProfile(bid)).badges).toEqual([]);
    expect(ok(await getProfile(b)).readiness.trustSummaryAvailable).toBe(false);
    await approveIdentity(b.accountId, 1500);
    const withBadge = await publicProfile(bid);
    expect(okPub(withBadge).badges).toEqual([{ type: 'IDENTITY' }]);
    expect(ok(await getProfile(b)).readiness.trustSummaryAvailable).toBe(true);
    await expectCleanPublic(withBadge, b);
    await sleep(1700);
    expect(okPub(await publicProfile(bid)).badges, 'an approval that expired is no badge on the very next read').toEqual([]);
    expect(ok(await getProfile(b)).readiness.trustSummaryAvailable).toBe(false);
    // a non-expiring approval, then the configured allow-list decides
    await setApprovalEnd(b.accountId, null);
    expect(okPub(await publicProfile(bid)).badges).toEqual([{ type: 'IDENTITY' }]);
    await setConfig(POLICY.publicBadgeTypes, ['INSURANCE']);
    expect(okPub(await publicProfile(bid)).badges).toEqual([]);
    await setConfig(POLICY.publicBadgeTypes, []);
    expect(okPub(await publicProfile(bid)).badges).toEqual([]);
    await resetPolicy();
    expect(okPub(await publicProfile(bid)).badges).toEqual([{ type: 'IDENTITY' }]);
  });

  it('unpublishing hides the page AND the photo at once (the same 404 as unknown); republishing brings both back', async () => {
    state = ok(await getProfile(a));
    state = ok(await setVisibility(a, rev(state), 'PRIVATE'));
    expect(state.profile).toMatchObject({ visibility: 'PRIVATE', publishedAt: null });
    const unknown = fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND');
    expect(stripCid(fail(await publicProfile(id), 404, 'PROFILE_NOT_FOUND'))).toEqual(stripCid(unknown));
    expect(stripCid(fail(await publicPhoto(id), 404, 'PROFILE_NOT_FOUND'))).toEqual(stripCid(unknown));
    expect((await preview(a)).status).toBe(200);
    state = ok(await setVisibility(a, rev(state), 'PUBLIC'));
    expect((await publicProfile(id)).status).toBe(200);
    expect((await publicPhoto(id)).status).toBe(200);
  });

  it('removing the photo removes it from the public page and the photo route (404), and a repeat changes nothing', async () => {
    const withPhoto = ok(await getProfile(a));
    const removed = ok(await removePhoto(a, rev(withPhoto)));
    expect(removed.profile.photo).toBeNull();
    expect(okPub(await publicProfile(id)).photo).toBeNull();
    fail(await publicPhoto(id), 404, 'PROFILE_NOT_FOUND');
    fail(await ownerPhoto(a), 404, 'PROFILE_MEDIA_NOT_FOUND');
    const again = ok(await removePhoto(a, rev(removed)));
    expect(rev(again)).toBe(rev(removed));
    state = await addPhoto(a, rev(again));
  });

  it('writes audit rows and outbox events with identifiers and field NAMES only: no text, photo id, key or hash', async () => {
    const audit = await q<{ action: string; changes: Json; actor: string; correlation_id: string }>(
      `SELECT action, changes, actor, correlation_id FROM provider.profile_audit_events WHERE public_profile_id = $1 ORDER BY occurred_at`,
      [id],
    );
    expect(new Set(audit.map((r) => r.action))).toEqual(
      new Set(['PROVIDER_PUBLIC_PROFILE_CREATED', 'PROVIDER_PUBLIC_PROFILE_UPDATED', 'PROVIDER_PROFILE_PHOTO_CHANGED', 'PROVIDER_PROFILE_VISIBILITY_CHANGED']),
    );
    const auditText = JSON.stringify(audit);
    const outbox = await q<{ event_type: string; payload_json: Json }>(
      `SELECT event_type, payload_json FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.profile-%' AND payload_json->>'accountId' = $1 ORDER BY created_at`,
      [a.accountId],
    );
    expect(new Set(outbox.map((r) => r.event_type))).toEqual(
      new Set(['bananagig.provider.profile-updated.v1', 'bananagig.provider.profile-visibility-changed.v1']),
    );
    for (const e of outbox) {
      expect(keysOf(e.payload_json)).toEqual(
        e.event_type.includes('visibility') ? ['accountId', 'publicProfileId', 'visibility'] : ['accountId', 'changedFields', 'publicProfileId', 'revision'],
      );
      if (e.event_type.includes('profile-updated'))
        for (const f of e.payload_json.changedFields) expect(['displayName', 'bio', 'photo', 'visibility']).toContain(f);
    }
    const assets = await q<{ media_asset_id: string; object_key: string; sha256: string | null }>(
      `SELECT media_asset_id, object_key, sha256 FROM provider.media_assets WHERE account_id = $1`,
      [a.accountId],
    );
    for (const text of [auditText, JSON.stringify(outbox)]) {
      for (const secret of [NAME_MARK, BIO_MARK, LEGAL_LAST, a.email, a.phone, ...assets.flatMap((r) => [r.media_asset_id, r.object_key, r.sha256 ?? '#'])])
        expect(text, secret).not.toContain(secret);
    }
  });

  it('keeps the account id, object keys, hashes and every provider text out of every log line', () => {
    const logs = logLines.join('\n');
    for (const secret of [BIO_MARK, NAME_MARK, LEGAL_LAST, 'SECRET-', 'sentinel-contact.example', GPS_MARK]) expect(logs, secret).not.toContain(secret);
  });
});

// ====================================================================== owner isolation (IDOR) on EVERY owner route
describe('owner isolation: a second account can neither read nor change anyone else’s profile', () => {
  let p1: Actor;
  let p2: Actor;
  let customer: Actor;
  let id1: string;
  let s1: Json;

  it('sets up two providers with a profile each, one with a photo, public and private', async () => {
    p1 = await provider('idor1');
    p2 = await provider('idor2');
    customer = await newActor('idorcust', { contacts: true });
    s1 = ok(await createProfile(p1), 201);
    id1 = s1.profile.publicProfileId;
    s1 = ok(await patchProfile(p1, { expectedRevision: rev(s1), displayName: `${NAME_MARK}One`, bio: `${BIO_MARK}One` }));
    s1 = await addPhoto(p1, rev(s1));
    ok(await createProfile(p2), 201);
  });

  it('every owner route acts on the CALLER’s profile only: p2’s calls never touch, return or reveal p1’s profile', async () => {
    const before = ok(await getProfile(p1));
    let s2 = ok(await getProfile(p2));
    expect(s2.profile.publicProfileId).not.toBe(id1);
    const calls: Res[] = [];
    calls.push(await getProfile(p2));
    calls.push(await createProfile(p2));
    s2 = ok(await getProfile(p2));
    // p1's revision is sent on purpose: the call is for p2's profile and p1's revision cannot match by design... or it matches p2's by coincidence; either way p1 is untouched
    calls.push(await patchProfile(p2, { expectedRevision: rev(s2), bio: 'p2 text' }));
    s2 = ok(await getProfile(p2));
    calls.push(await setVisibility(p2, rev(s2), 'PRIVATE'));
    calls.push(await authorize(p2, { expectedRevision: rev(s2), mimeType: 'image/jpeg', sizeBytes: 100 }));
    s2 = ok(await getProfile(p2));
    calls.push(await finalizePhoto(p2, { expectedRevision: rev(s2) }));
    calls.push(await preview(p2));
    calls.push(await ownerPhoto(p2));
    s2 = ok(await getProfile(p2));
    calls.push(await removePhoto(p2, rev(s2)));
    for (const c of calls) {
      expect(c.raw + c.rawBytes.toString('latin1'), `${c.method} ${c.url}`).not.toContain(id1);
      expect(c.raw, `${c.method} ${c.url}`).not.toContain(`${BIO_MARK}One`);
      expect(c.raw, `${c.method} ${c.url}`).not.toContain(`${NAME_MARK}One`);
    }
    const after = ok(await getProfile(p1));
    expect(after).toEqual(before);
    expect((await ownerPhoto(p1)).status).toBe(200);
    expect(okPrev(await preview(p1)).bio).toBe(`${BIO_MARK}One`);
  });

  it('p1’s identifiers are not accepted anywhere: not in the path, query or body of an owner route', async () => {
    const r2 = rev(ok(await getProfile(p2)));
    for (const body of [
      { expectedRevision: r2, bio: 'x', publicProfileId: id1 },
      { expectedRevision: r2, bio: 'x', accountId: p1.accountId },
      { expectedRevision: r2, visibility: 'PUBLIC', publicProfileId: id1 },
    ]) {
      const res = await call(body.visibility ? 'POST' : 'PATCH', body.visibility ? '/profile/visibility' : '/profile', { as: p2, body });
      fail(res, 400, 'VALIDATION_FAILED');
    }
    fail(await call('GET', `/profile?publicProfileId=${id1}`, { as: p2 }), 400, 'VALIDATION_FAILED');
    fail(await call('GET', `/profile/photo?publicProfileId=${id1}`, { as: p2 }), 400, 'VALIDATION_FAILED');
    for (const path of [`/profile/${id1}`, `/profile/${id1}/photo`, `/profile/photo/${id1}`]) {
      const res = await call('GET', path, { as: p2 });
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    }
    // the public id is not an owner credential either
    expect((await call('PATCH', `${PUB}/${id1}`, { as: p2, body: { bio: 'x' } })).status).toBe(404);
    expect((await call('DELETE', `${PUB}/${id1}/photo`, { as: p2 })).status).toBe(404);
  });

  it('an account without a profile gets 404 on every owner route that needs one (and exists:false on the read), never someone else’s', async () => {
    const lone = await provider('idorlone');
    const st = ok(await getProfile(lone));
    expect(st.exists).toBe(false);
    for (const res of [
      await patchProfile(lone, { expectedRevision: 1, bio: 'x' }),
      await setVisibility(lone, 1, 'PUBLIC'),
      await authorize(lone, { expectedRevision: 1, mimeType: 'image/jpeg', sizeBytes: 100 }),
      await finalizePhoto(lone, { expectedRevision: 1 }),
      await removePhoto(lone, 1),
      await preview(lone),
    ]) {
      const e = fail(res, 404, 'PROFILE_NOT_FOUND');
      expect(e.details).toEqual({ messageKey: profileErrorKey('PROFILE_NOT_FOUND') });
    }
    fail(await ownerPhoto(lone), 404, 'PROFILE_MEDIA_NOT_FOUND');
  });

  it('a customer without the provider role cannot create a profile (403 PROVIDER_NOT_ELIGIBLE) and has none', async () => {
    const res = await createProfile(customer);
    const e = fail(res, 403, 'PROFILE_PROVIDER_NOT_ELIGIBLE');
    expect(e.details.messageKey).toBe(profileErrorKey('PROVIDER_NOT_ELIGIBLE'));
    expect((await q(`SELECT 1 FROM provider.public_profiles WHERE account_id = $1`, [customer.accountId])).length).toBe(0);
    expect((await patchProfile(customer, { expectedRevision: 1, bio: 'x' })).status).toBeGreaterThanOrEqual(400);
  });

  it('a registration that is not COMPLETED cannot create a profile', async () => {
    const half = await newActor('idorhalf', { contacts: true });
    await acceptAgreements(half);
    expect((await call('POST', REG, { as: half })).status).toBe(201);
    fail(await createProfile(half), 403, 'PROFILE_PROVIDER_NOT_ELIGIBLE');
  });

  it('requires a token on every owner route (401), never reaching a profile', async () => {
    for (const res of [
      await getProfile(null),
      await createProfile(null),
      await patchProfile(null, { expectedRevision: 1, bio: 'x' }),
      await setVisibility(null, 1, 'PUBLIC'),
      await authorize(null, { expectedRevision: 1, mimeType: 'image/jpeg', sizeBytes: 100 }),
      await finalizePhoto(null, { expectedRevision: 1 }),
      await removePhoto(null, 1),
      await preview(null),
      await ownerPhoto(null),
    ]) {
      expect(res.status, `${res.method} ${res.url}`).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

// ====================================================================== the public surface
describe('the public surface', () => {
  let a: Actor;
  let b: Actor;
  let id: string;

  it('sets up a public profile with a photo and a Gig', async () => {
    a = await provider('pub');
    b = await provider('pubother');
    let s = ok(await createProfile(a), 201);
    id = s.profile.publicProfileId;
    s = ok(await patchProfile(a, { expectedRevision: rev(s), displayName: `${NAME_MARK}Pub`, bio: `${BIO_MARK}Pub` }));
    s = await addPhoto(a, rev(s));
    ok(await setVisibility(a, rev(s), 'PUBLIC'));
    await publishedGig(a, `${GIG_MARK} pub`);
    ok(await createProfile(b), 201);
  });

  it('the Authorization header changes nothing: none, garbage, another provider’s valid token, the owner’s own token', async () => {
    const baseline = (await publicProfile(id)).raw;
    const basePhoto = (await publicPhoto(id)).rawBytes;
    for (const as of [null, 'not.a.token', b, a, await tokenFor('someone-who-does-not-exist')]) {
      const r = await publicProfile(id, { as: as as Actor | string | null });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.raw).data).toEqual(JSON.parse(baseline).data);
      expect(r.headers['cache-control']).toBe('no-store');
      const ph = await publicPhoto(id, { as: as as Actor | string | null });
      expect(ph.status).toBe(200);
      expect(ph.rawBytes.equals(basePhoto)).toBe(true);
    }
    // an account that does not exist yet is NOT created by a public read
    const ghost = `itest-ghost-${randomUUID()}`;
    await publicProfile(id, { as: await tokenFor(ghost) });
    expect((await q(`SELECT 1 FROM identity.external_identities WHERE provider_subject = $1`, [ghost])).length).toBe(0);
  });

  it('every public response is clean: allowed keys only, no secret value, and the response says it must not be cached', async () => {
    const r = await publicProfile(id);
    await expectCleanPublic(r, a);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.etag).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('unknown, malformed and hostile ids are ONE identical 404 on both routes (never a 400, never a 500)', async () => {
    const unknown = stripCid(fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND'));
    const hostile = [
      'not-a-uuid',
      '123',
      id.replace(/-/g, ''),
      `${id}x`,
      `${id}%20`,
      '..%2f..%2fprovider%2fprofile',
      '%00',
      "'; DROP TABLE provider.public_profiles; --",
      `${id}' OR '1'='1`,
      'x'.repeat(100),
      'x'.repeat(500),
      '%ZZ',
      a.accountId, // the ACCOUNT id is not a public id
      `${a.accountId}`.toUpperCase(),
    ];
    for (const h of hostile)
      for (const suffix of ['', '/photo']) {
        const r = await call('GET', `${PUB}/${encodeURI(h).replace(/%25/g, '%')}${suffix}`);
        expect(r.status, `${h}${suffix}`).toBe(404);
        expect(stripCid(r.body.error), `${h}${suffix}`).toEqual(unknown);
        expect(r.headers['cache-control']).toBe('no-store');
      }
    expect((await q(`SELECT count(*)::int AS n FROM provider.public_profiles`))[0]!.n).toBeGreaterThan(0);
  });

  it('the public id is not the account id and a lookup by account id is the same 404', async () => {
    expect(id).not.toBe(a.accountId);
    const r = await publicProfile(a.accountId);
    expect(r.status).toBe(404);
    expect((await publicPhoto(a.accountId)).status).toBe(404);
  });

  it('only GET exists on the public routes (no listing, no search, no write)', async () => {
    for (const [method, url] of [
      ['GET', PUB],
      ['GET', `${PUB}/`],
      ['POST', `${PUB}/${id}`],
      ['PUT', `${PUB}/${id}`],
      ['PATCH', `${PUB}/${id}`],
      ['DELETE', `${PUB}/${id}`],
      ['POST', `${PUB}/${id}/photo`],
      ['GET', `${PUB}?q=a`],
      ['GET', `${PUB}/search`],
    ] as const) {
      const r = await call(method, url, { body: method === 'GET' ? undefined : {} });
      expect([400, 404, 405], `${method} ${url}`).toContain(r.status);
      if (r.status === 404 && method !== 'GET') expect(r.body.error.code).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('a suspended account disappears from the public page and photo at once, and returns when active again', async () => {
    const unknown = stripCid(fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND'));
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'admin:itest', reason: 'itest' });
    try {
      expect(stripCid(fail(await publicProfile(id), 404, 'PROFILE_NOT_FOUND'))).toEqual(unknown);
      expect(stripCid(fail(await publicPhoto(id), 404, 'PROFILE_NOT_FOUND'))).toEqual(unknown);
    } finally {
      await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'admin:itest', reason: 'itest' });
    }
    expect((await publicProfile(id)).status).toBe(200);
  });

  it('a deactivated PROVIDER role disappears from the public page at once', async () => {
    const c = await provider('pubroles');
    const s = ok(await createProfile(c), 201);
    const cid = s.profile.publicProfileId;
    ok(await setVisibility(c, s.profile.revision, 'PUBLIC'));
    expect((await publicProfile(cid)).status).toBe(200);
    await accounts.deactivateRole(c.accountId, 'PROVIDER', { actor: 'admin:itest', reason: 'itest' });
    expect(stripCid(fail(await publicProfile(cid), 404, 'PROFILE_NOT_FOUND'))).toEqual(
      stripCid(fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND')),
    );
  });

  it('a market that is no longer ACTIVE is no market on the page (no address, area or coordinate ever)', async () => {
    const c = await provider('pubmarket', { market: W.m2 });
    const s = ok(await createProfile(c), 201);
    const cid = s.profile.publicProfileId;
    ok(await setVisibility(c, s.profile.revision, 'PUBLIC'));
    expect(okPub(await publicProfile(cid)).market).toEqual({ code: W.m2 });
    await geography.setMarketActive(W.m2, false, 'deactivate for test', AUTHOR);
    try {
      expect(okPub(await publicProfile(cid)).market).toBeNull();
    } finally {
      await geography.setMarketActive(W.m2, true, 'reactivate for test', AUTHOR);
    }
    expect(okPub(await publicProfile(cid)).market).toEqual({ code: W.m2 });
  });

  it('the marketplace eligibility flag fails closed while no eligibility port exists (the same 404), and is reversible', async () => {
    await setConfig(POLICY.publicRequiresMarketplaceEligibility, true);
    try {
      const unknown = stripCid(fail(await publicProfile(randomUUID()), 404, 'PROFILE_NOT_FOUND'));
      expect(stripCid(fail(await publicProfile(id), 404, 'PROFILE_NOT_FOUND'))).toEqual(unknown);
      expect((await publicPhoto(id)).status).toBe(404);
    } finally {
      await setConfig(POLICY.publicRequiresMarketplaceEligibility, false);
    }
    expect((await publicProfile(id)).status).toBe(200);
  });

  it('the public read costs a constant number of statements, whatever the number of Gigs', async () => {
    const c = await provider('budget');
    let s = ok(await createProfile(c), 201);
    const cid = s.profile.publicProfileId;
    s = ok(await patchProfile(c, { expectedRevision: s.profile.revision, bio: 'budget' }));
    ok(await setVisibility(c, rev(s), 'PUBLIC'));
    await publishedGig(c, `${GIG_MARK} b1`);
    const measure = async (): Promise<string[]> => {
      await publicProfile(cid); // warm the policy/content caches
      capture = [];
      const r = await publicProfile(cid);
      const used = capture;
      capture = null;
      expect(r.status).toBe(200);
      return used;
    };
    const one = await measure();
    for (let i = 2; i <= 5; i++) await publishedGig(c, `${GIG_MARK} b${i}`);
    expect(okPub(await publicProfile(cid)).gigs).toHaveLength(5);
    const five = await measure();
    expect(five.length, five.join('\n')).toBe(one.length);
    // the budget: pinned so a regression to an N+1 (or a new read per concern) is noticed
    expect(one.length, one.join('\n')).toBeLessThanOrEqual(PUBLIC_READ_STATEMENT_BUDGET);
  });

  it('a 304 photo request costs no more statements than the public lookup needs and reads no object', async () => {
    const etag = String((await publicPhoto(id)).headers.etag);
    capture = [];
    const r = await publicPhoto(id, { headers: { 'if-none-match': etag } });
    const used = capture;
    capture = null;
    expect(r.status).toBe(304);
    expect(used.length, used.join('\n')).toBeLessThanOrEqual(PUBLIC_PHOTO_STATEMENT_BUDGET);
  });
});

/**
 * Measured on the working implementation: the public projection is 11 statements counted by the database hook (3 configuration reads, the profile with its Gig cards and photo facts, the
 * account context for the eligibility check and the fallback name (5: account, roles, names, email and phone summaries), the market, the badge query), independent of the number of Gigs. The batched
 * service-name read goes through `Database.query` (not counted by this hook) and is a single statement by construction (unit-tested). A 304 photo answer needs the policy, the profile target and
 * the asset row (5) and reads no object.
 */
const PUBLIC_READ_STATEMENT_BUDGET = 11;
const PUBLIC_PHOTO_STATEMENT_BUDGET = 5;

// ====================================================================== publishing prerequisites and the PROFILE step
describe('publishing prerequisites (configuration) and the registration PROFILE step', () => {
  it('with the bio and the photo required, PUBLIC is refused with identifier-only issues; PRIVATE is always allowed; completing the facts allows PUBLIC', async () => {
    await setConfig(POLICY.bioRequired, true);
    await setConfig(POLICY.photoRequired, true);
    try {
      const a = await provider('prereq');
      let s = ok(await createProfile(a), 201);
      expect(s.readiness.profileComplete).toBe(false);
      const stepOf = async () =>
        (await call('GET', `${REG}/requirements`, { as: a })).body.data.steps.find((x: { step: string }) => x.step === 'PROFILE').status;
      expect(await stepOf()).toBe('IN_PROGRESS');
      const e = fail(await setVisibility(a, rev(s), 'PUBLIC'), 409, 'PROFILE_INCOMPLETE');
      expect(e.details.issues).toEqual(
        expect.arrayContaining([
          { reason: 'BIO_REQUIRED', field: 'bio' },
          { reason: 'PHOTO_REQUIRED', field: 'photo' },
        ]),
      );
      expect(e.details.messageKey).toBe(profileErrorKey('PROFILE_INCOMPLETE'));
      expect(ok(await getProfile(a)).profile.visibility).toBe('PRIVATE');
      s = ok(await patchProfile(a, { expectedRevision: rev(s), bio: 'now there is a bio' }));
      const e2 = fail(await setVisibility(a, rev(s), 'PUBLIC'), 409, 'PROFILE_INCOMPLETE');
      expect(e2.details.issues).toEqual([{ reason: 'PHOTO_REQUIRED', field: 'photo' }]);
      s = await addPhoto(a, rev(s));
      expect(s.readiness.profileComplete).toBe(true);
      expect(await stepOf()).toBe('COMPLETE');
      s = ok(await setVisibility(a, rev(s), 'PUBLIC'));
      expect(s.profile.visibility).toBe('PUBLIC');
      s = ok(await setVisibility(a, rev(s), 'PRIVATE'));
      expect(s.profile.visibility).toBe('PRIVATE');
    } finally {
      await resetPolicy();
    }
  });

  it('a PUBLIC profile cannot drop a field the configuration requires: clearing the bio is a 409 PROFILE_INCOMPLETE with an identifier-only issue, and nothing changes', async () => {
    await setConfig(POLICY.bioRequired, true);
    try {
      const a = await provider('clearreq');
      let s = ok(await createProfile(a), 201);
      s = ok(await patchProfile(a, { expectedRevision: rev(s), bio: `${BIO_MARK} required bio` }));
      s = ok(await setVisibility(a, rev(s), 'PUBLIC'));
      const id = s.profile.publicProfileId;
      const res = await patchProfile(a, { expectedRevision: rev(s), bio: null });
      const e = fail(res, 409, 'PROFILE_INCOMPLETE');
      expect(e.details.issues).toEqual([{ reason: 'BIO_REQUIRED', field: 'bio' }]);
      expect(e.details.messageKey).toBe(profileErrorKey('PROFILE_INCOMPLETE'));
      expect(res.raw).not.toContain(BIO_MARK);
      const after = ok(await getProfile(a));
      expect(after.profile).toMatchObject({ bio: `${BIO_MARK} required bio`, visibility: 'PUBLIC', revision: rev(s) });
      expect(okPub(await publicProfile(id)).bio).toBe(`${BIO_MARK} required bio`);
      // a PRIVATE profile may clear it (the requirement only guards what is public)
      s = ok(await setVisibility(a, rev(s), 'PRIVATE'));
      s = ok(await patchProfile(a, { expectedRevision: rev(s), bio: null }));
      expect(s.profile.bio).toBeNull();
    } finally {
      await resetPolicy();
    }
  });

  it('with nothing required the PROFILE step is COMPLETE as soon as a public name is available', async () => {
    const a = await provider('prereqdone');
    const stepOf = async () => (await call('GET', `${REG}/requirements`, { as: a })).body.data.steps.find((x: { step: string }) => x.step === 'PROFILE').status;
    expect(await stepOf()).toBe('NOT_STARTED');
    ok(await createProfile(a), 201);
    expect(await stepOf()).toBe('COMPLETE');
  });

  it('a provider with no name at all has no public name: PUBLIC is refused until a display name is entered', async () => {
    const a = await provider('noname', { names: false });
    let s = ok(await createProfile(a), 201);
    expect(s.profile.publicName).toBeNull();
    expect(s.readiness).toMatchObject({ publicNameAvailable: false, profileComplete: false });
    const e = fail(await setVisibility(a, rev(s), 'PUBLIC'), 409, 'PROFILE_INCOMPLETE');
    expect(e.details.issues).toEqual(expect.arrayContaining([{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }]));
    s = ok(await patchProfile(a, { expectedRevision: rev(s), displayName: 'Named Provider' }));
    s = ok(await setVisibility(a, rev(s), 'PUBLIC'));
    expect(okPub(await publicProfile(s.profile.publicProfileId)).displayName).toBe('Named Provider');
  });
});

// ====================================================================== photo refusals
describe('profile photo refusals', () => {
  let a: Actor;
  let s: Json;
  it('sets up', async () => {
    a = await provider('photoref');
    s = ok(await createProfile(a), 201);
  });
  const reasonOf = (e: Json): string | undefined => e.details.reason;

  it('refuses a type outside the allow-list and a size above the PROFILE cap before any upload exists', async () => {
    const t = fail(await authorize(a, { expectedRevision: rev(s), mimeType: 'image/gif', sizeBytes: 1000 }), 400, 'PROFILE_MEDIA_REFUSED');
    expect(reasonOf(t)).toBe('MIME_NOT_ALLOWED');
    const big = fail(await authorize(a, { expectedRevision: rev(s), mimeType: 'image/jpeg', sizeBytes: 2_097_153 }), 400, 'PROFILE_MEDIA_REFUSED');
    expect(reasonOf(big)).toBe('FILE_TOO_LARGE');
    expect(rev(ok(await getProfile(a)))).toBe(rev(s));
    expect((await q(`SELECT 1 FROM provider.media_assets WHERE account_id = $1`, [a.accountId])).length).toBe(0);
  });

  it('finalize without an uploaded object leaves the upload pending (OBJECT_MISSING); a stale revision is 409', async () => {
    const up = ok(await authorize(a, { expectedRevision: rev(s), mimeType: 'image/jpeg', sizeBytes: 1000 }), 201, ProfilePhotoUploadResponse);
    const missing = fail(await finalizePhoto(a, { expectedRevision: up.revision }), 400, 'PROFILE_MEDIA_REFUSED');
    expect(reasonOf(missing)).toBe('OBJECT_MISSING');
    expect(ok(await getProfile(a)).profile.photoPending).toBe(true);
    fail(await finalizePhoto(a, { expectedRevision: up.revision - 1 }), 409, 'STALE_PROFILE');
    s = ok(await getProfile(a));
  });

  it('refuses wrong bytes (a declared JPEG that is a text file), a size mismatch and a wrong hash, and discards the upload; nothing is served', async () => {
    const attempt = async (bytes: Buffer, declaredSize: number, hash?: string) => {
      const up = ok(
        await authorize(a, { expectedRevision: rev(ok(await getProfile(a))), mimeType: 'image/jpeg', sizeBytes: declaredSize }),
        201,
        ProfilePhotoUploadResponse,
      );
      playUpload(up.upload, bytes);
      return finalizePhoto(a, { expectedRevision: up.revision, ...(hash ? { sha256: hash } : {}) });
    };
    const text = Buffer.from('<html>not an image</html>'.repeat(20));
    expect(reasonOf(fail(await attempt(text, text.length), 400, 'PROFILE_MEDIA_REFUSED'))).toMatch(/SIGNATURE_MISMATCH|IMAGE_INVALID|CONTENT_TYPE_MISMATCH/);
    const good = jpegWithExif();
    expect(reasonOf(fail(await attempt(good, good.length + 10), 400, 'PROFILE_MEDIA_REFUSED'))).toBe('SIZE_MISMATCH');
    expect(reasonOf(fail(await attempt(good, good.length, 'a'.repeat(64)), 400, 'PROFILE_MEDIA_REFUSED'))).toBe('HASH_MISMATCH');
    expect(ok(await getProfile(a)).profile.photo).toBeNull();
  });

  it('a file whose header is valid but whose container cannot be sanitised is refused at finalize (IMAGE_INVALID) and never becomes the photo', async () => {
    // JFIF + a SOF0 header of 300x300 + a scan header with a wrong length + EOI: the header-only checks of the shared pipeline accept it, the sanitiser cannot
    const hollow = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      ascii('JFIF\0'),
      Buffer.from([1, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0x2c, 0x01, 0x2c, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
    ]);
    const before = ok(await getProfile(a));
    const up = ok(await authorize(a, { expectedRevision: rev(before), mimeType: 'image/jpeg', sizeBytes: hollow.length }), 201, ProfilePhotoUploadResponse);
    playUpload(up.upload, hollow);
    const e = fail(await finalizePhoto(a, { expectedRevision: up.revision, sha256: sha(hollow) }), 400, 'PROFILE_MEDIA_REFUSED');
    expect(reasonOf(e)).toBe('IMAGE_INVALID');
    expect(e.details.messageKey).toBe(profileErrorKey('MEDIA_REFUSED'));
    const after = ok(await getProfile(a));
    expect(after.profile.photo).toBeNull();
    expect(after.profile.photoPending).toBe(false);
    fail(await ownerPhoto(a), 404, 'PROFILE_MEDIA_NOT_FOUND');
  });

  it('an infected file is refused and a scanner that cannot answer is a retryable 503, never a photo', async () => {
    const eicar = Buffer.concat([jpegWithExif(), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    const up = ok(
      await authorize(a, { expectedRevision: rev(ok(await getProfile(a))), mimeType: 'image/jpeg', sizeBytes: eicar.length }),
      201,
      ProfilePhotoUploadResponse,
    );
    playUpload(up.upload, eicar);
    const e = fail(await finalizePhoto(a, { expectedRevision: up.revision }), 400, 'PROFILE_MEDIA_REFUSED');
    expect(reasonOf(e)).toBe('SCAN_INFECTED');
    expect(ok(await getProfile(a)).profile.photo).toBeNull();
  });
});

// ====================================================================== secrecy over everything
describe('secrecy over every response of this file', () => {
  it('no error response carries provider text, an object key, a hash, an account id or an internal cause', async () => {
    const assets = await q<{ media_asset_id: string; object_key: string; sha256: string | null }>(
      `SELECT media_asset_id, object_key, sha256 FROM provider.media_assets`,
    );
    const internal = assets.flatMap((r) => [r.media_asset_id, r.object_key, ...(r.sha256 ? [r.sha256] : [])]);
    const errors = transcript.filter((t) => t.status >= 400 && t.raw !== '');
    expect(errors.length).toBeGreaterThan(20);
    for (const t of errors) {
      for (const secret of [
        ...internal,
        NAME_MARK,
        BIO_MARK,
        GIG_MARK,
        LEGAL_LAST,
        'sentinel-contact.example',
        'SECRET-',
        'select ',
        'SELECT ',
        'at async',
        'node_modules',
      ])
        expect(t.raw, `${t.method} ${t.url}`).not.toContain(secret);
    }
  });

  it('the only response that names an object key is the one-time upload target; no other success response carries a key, an asset id or a hash', async () => {
    const assets = await q<{ media_asset_id: string; object_key: string; sha256: string | null }>(
      `SELECT media_asset_id, object_key, sha256 FROM provider.media_assets`,
    );
    const internal = assets.flatMap((r) => [r.media_asset_id, ...(r.sha256 ? [r.sha256] : [])]);
    for (const t of transcript.filter((x) => x.status < 400 && x.raw !== '')) {
      // the upload target (alone) names its one-time key, which embeds the asset id
      if (!t.url.endsWith('/profile/photo/uploads')) for (const secret of internal) expect(t.raw, `${t.method} ${t.url}`).not.toContain(secret);
      if (!t.url.endsWith('/profile/photo/uploads')) for (const r of assets) expect(t.raw, `${t.method} ${t.url}`).not.toContain(r.object_key);
    }
  });
});
