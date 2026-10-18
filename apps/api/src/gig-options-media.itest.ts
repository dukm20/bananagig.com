// CAT-004 variants, add-ons and photos over HTTP, on the REAL stack wired the way apps/api/src/index.ts wires it: the real Fastify app (buildApp), the real AccountService,
// ConsentService, GeographyService, CatalogService, GigTemplateService, ContentService and ConfigurationService, the ProviderRegistrationService, the ProviderGigService with the
// adapters of modules/provider/gig-wiring.ts (policy over the configuration registry, the scanner adapter over the trust DEV/TEST scanner, a MemoryObjectStore standing in for the
// private bucket whose "presigned" URLs this file plays), the real auth plugin with forged-but-signed tokens, and one real, isolated PostgreSQL (migration 0021 seeds the variant,
// add-on and photo policy). The unit layer (gig-options-media.test.ts) proves the HTTP edge with a fake service and packages/provider proves the service rules; this file proves the
// whole path with the database: the full variants / add-ons / photo journey (authorize, play the upload, finalize, alt text, order, detach), revisions, the template permissions and
// the configured limits, every refusal of a photo, publishing with and without photos, the freeze of published children, the next draft that copies options and re-attaches the same
// photos, owner isolation on EVERY new route, wrong states, races, and a secrecy scan over every response, log line, audit row and event.
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
  GigDetailResponse,
  GigMediaPreviewResponse,
  GigMediaUploadResponse,
  PROVIDER_GIG_MEDIA_POLICY_KEYS,
  PROVIDER_GIG_OPTIONS_POLICY_KEYS,
  PROVIDER_GIG_POLICY_KEYS,
  categoryNameKey,
  gigErrorKey,
  gigIssueKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldLabelKey,
  gigTemplateNameKey,
  gigTemplateOptionLabelKey,
  serviceTypeNameKey,
} from '@bananagig/contracts';
import { CatalogService, GigTemplateService } from '@bananagig/catalog';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { MemoryObjectStore } from '@bananagig/platform';
import { ProviderGigService, ProviderRegistrationService, type GigMediaScanner } from '@bananagig/provider';
import { EICAR_TEST_STRING, FakeEvidenceScanner } from '@bananagig/trust';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createGigMediaScanner, createGigPolicyProvider, createGigPrerequisites, createGigTemplatePort } from './modules/provider/gig-wiring';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';

// ---------------------------------------------------------------- the real stack
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const AUTHOR = 'author-a';
const APPROVER = 'approver-b';
const CFG_AUTHOR = 'cfg:author';
const CFG_APPROVER = 'cfg:approver';
const REASON = 'gig itest';
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const REG = '/api/v1/provider/registration';
const P = `/api/v1/provider`;
/** Provider-written text the tests type: it may appear in the caller's OWN Gig responses and nowhere else. */
const TEXT_MARK = 'SentinelGigText';

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let geography: GeographyService;
let catalog: CatalogService;
let gigTemplates: GigTemplateService;
let consent: ConsentService;
/** Statements run by the database while this is set (the query-count budget). */
let capture: string[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
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
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  const res: Res = { method, url: full, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}
/** A 2xx with the standard envelope; the data must equal its contract exactly (no field missing, none extra). */
type Contract = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
const ok = (r: Res, status = 200, schema: Contract | null = GigDetailResponse): Json => {
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
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  return r.body.error;
};
/** A Gig failure: status, the GIG_ code and the fixed message key (the details are checked by the caller). */
const gigFail = (r: Res, status: number, code: string): Json => {
  const e = fail(r, status, code.startsWith('GIG_') ? code : `GIG_${code}`);
  expect(e.details.messageKey, r.raw).toBe(gigErrorKey(code as never));
  return e;
};
const issuesOf = (e: Json): Json[] => e.details.issues ?? [];
const hasIssue = (e: Json, target: string, reason: string, fieldKey?: string): boolean =>
  issuesOf(e).some(
    (i) => i.target === target && i.reason === reason && (fieldKey === undefined || i.fieldKey === fieldKey) && i.messageKey === gigIssueKey(reason as never),
  );

let providerGigs: ProviderGigService;
// ---------------------------------------------------------------- content, config and the world
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: /\.(name|label)$/.test(key) ? 'UI_LABEL' : 'PLAIN_TEXT',
  ownerRole: 'CONTENT',
  description: 'gig itest entry',
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
  const c = `devtest-gig-${name}`;
  await geography.createMarket(
    { code: c, name: 'Gig Test Market', countryCode: 'US', defaultLocale: 'en-US', currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: REASON },
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

const field = (fieldKey: string, fieldType: string, behavior: string, over: Record<string, unknown> = {}) => ({ fieldKey, fieldType, behavior, ...over });
async function liveTemplate(st: string, prefix: string, markets: string[], def: { fields: unknown[] } & Record<string, unknown>): Promise<string> {
  const c = code(prefix);
  await copy(gigTemplateNameKey(c), `Template ${c}`);
  for (const f of def.fields as { fieldKey: string; withDefaultText?: boolean; options?: { optionCode: string }[] }[]) {
    await copy(gigTemplateFieldLabelKey(c, f.fieldKey), `Label ${f.fieldKey}`);
    if (f.withDefaultText) await copy(gigTemplateFieldDefaultKey(c, f.fieldKey), 'Platform written default text for the Gig');
    for (const o of f.options ?? []) await copy(gigTemplateOptionLabelKey(c, f.fieldKey, o.optionCode), `Option ${o.optionCode}`);
  }
  await gigTemplates.createGigTemplate({ code: c, serviceTypeCode: st, withDescription: false, withInstructions: false, reason: REASON }, AUTHOR);
  await gigTemplates.createGigTemplateVersion(c, { reason: REASON }, AUTHOR);
  const v = await gigTemplates.replaceGigTemplateDraft(c, 1, def, AUTHOR);
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

async function newActor(label: string, o: { contacts?: boolean } = {}): Promise<Actor> {
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
async function provider(label: string, services: string[] = [W.stA], market: string = W.m): Promise<Actor> {
  const a = await newActor(label, { contacts: true });
  await acceptAgreements(a);
  expect((await call('POST', REG, { as: a })).status).toBe(201);
  expect((await call('PUT', `${REG}/market`, { as: a, body: { marketCode: market } })).status).toBe(200);
  const s = await call('PUT', `${REG}/services`, { as: a, body: { serviceTypeCodes: services } });
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

// ---------------------------------------------------------------- the CAT-004 calls
const store = new MemoryObjectStore();
const fakeScanner = new FakeEvidenceScanner();
/** `error` makes the scanner unable to answer (ERROR), as the production default does. */
let scanMode: 'real' | 'error' = 'real';
const testScanner: GigMediaScanner = createGigMediaScanner({ scan: async (i) => (scanMode === 'error' ? { status: 'ERROR' } : fakeScanner.scan(i)) });

const draftPath = (gigId: string) => `/gigs/${gigId}/draft`;
const putVariants = (a: Actor | string | null, gigId: string, expectedRevision: number, variants: unknown[]) =>
  call('PUT', `${draftPath(gigId)}/variants`, { as: a, body: { expectedRevision, variants } });
const putAddOns = (a: Actor | string | null, gigId: string, expectedRevision: number, addOns: unknown[]) =>
  call('PUT', `${draftPath(gigId)}/add-ons`, { as: a, body: { expectedRevision, addOns } });
const authorize = (a: Actor | string | null, gigId: string, body: unknown) => call('POST', `${draftPath(gigId)}/media/uploads`, { as: a, body });
const finalizeMedia = (a: Actor | string | null, gigId: string, mediaId: string, body: unknown) =>
  call('POST', `${draftPath(gigId)}/media/${mediaId}/finalize`, { as: a, body });
const putAlt = (a: Actor | string | null, gigId: string, mediaId: string, expectedRevision: number, altText: string | null) =>
  call('PUT', `${draftPath(gigId)}/media/${mediaId}`, { as: a, body: { expectedRevision, altText } });
const detachMedia = (a: Actor | string | null, gigId: string, mediaId: string, expectedRevision: number) =>
  call('DELETE', `${draftPath(gigId)}/media/${mediaId}`, { as: a, body: { expectedRevision } });
const putOrder = (a: Actor | string | null, gigId: string, expectedRevision: number, mediaIds: string[]) =>
  call('PUT', `${draftPath(gigId)}/media/order`, { as: a, body: { expectedRevision, mediaIds } });
const previewDraft = (a: Actor | string | null, gigId: string, mediaId: string) => call('GET', `${draftPath(gigId)}/media/${mediaId}/preview`, { as: a });
const previewVersion = (a: Actor | string | null, gigId: string, version: number | string, mediaId: string) =>
  call('GET', `/gigs/${gigId}/versions/${version}/media/${mediaId}/preview`, { as: a });
const getGig = (a: Actor, gigId: string) => call('GET', `/gigs/${gigId}`, { as: a });
const getVersion = (a: Actor, gigId: string, v: number | string) => call('GET', `/gigs/${gigId}/versions/${v}`, { as: a });
const menu = (a: Actor) => call('GET', '/gigs', { as: a });
const createGig = (a: Actor, gigTemplateCode: string) => call('POST', '/gigs', { as: a, body: { gigTemplateCode } });
const saveDraft = (a: Actor, gigId: string, body: unknown) => call('PUT', `/gigs/${gigId}/draft`, { as: a, body });
const publish = (a: Actor, gigId: string, expectedRevision: number) => call('POST', `/gigs/${gigId}/publish`, { as: a, body: { expectedRevision } });
const nextDraft = (a: Actor, gigId: string) => call('POST', `/gigs/${gigId}/versions`, { as: a });
const retire = (a: Actor, gigId: string) => call('POST', `/gigs/${gigId}/retire`, { as: a, body: {} });

const opt = (name: string, priceDeltaMinor = 0, durationDeltaMinutes = 0, description: string | null = null, key?: string) => ({
  ...(key === undefined ? {} : { key }),
  name,
  description,
  priceDeltaMinor,
  durationDeltaMinutes,
});

// ---------------------------------------------------------------- synthetic images (headers only: the server reads dimensions from the header and never decodes)
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const png = (w: number, h: number): Buffer =>
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(w),
    ...u32be(h),
    8,
    2,
    0,
    0,
    0,
    ...u32be(0),
    ...u32be(0),
    ...ascii('IEND'),
    ...u32be(0),
  ]);
const jpeg = (w: number, h: number): Buffer =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii('JFIF'),
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    0x00,
    0x02,
    0xff,
    0xd9,
  ]);
const webp = (w: number, h: number): Buffer => {
  const body = Buffer.from([...ascii('WEBP'), ...ascii('VP8X'), ...u32le(10), 0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
  return Buffer.from([...ascii('RIFF'), ...u32le(body.length), ...body]);
};
/** A different valid PNG each time (a trailing comment makes the hash unique). */
const uniquePng = (w = 300, h = 300): Buffer => Buffer.concat([png(w, h), Buffer.from(`unique:${randomUUID()}`)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Plays the browser: PUTs the bytes where the presigned URL points (the memory store's token is the upload key). */
function playUpload(upload: { url: string; headers: Record<string, string> }, bytes: Buffer, contentType = upload.headers['content-type']): string {
  expect(upload.url.startsWith('memory://upload/')).toBe(true);
  const key = decodeURIComponent(upload.url.slice('memory://upload/'.length));
  store.put(key, bytes, contentType);
  return key;
}

interface Added {
  mediaId: string;
  revision: number;
  detail: Json;
  uploadKey: string;
  authorized: Json;
}
/** Authorizes, plays the upload and finalizes: one READY photo. */
async function addPhoto(
  a: Actor,
  gigId: string,
  revision: number,
  o: { fieldKey?: string; bytes?: Buffer; mime?: string; alt?: string | null; hash?: boolean } = {},
): Promise<Added> {
  const bytes = o.bytes ?? uniquePng();
  const mime = o.mime ?? 'image/png';
  const up = ok(
    await authorize(a, gigId, {
      expectedRevision: revision,
      fieldKey: o.fieldKey ?? 'before_photos',
      mimeType: mime,
      sizeBytes: bytes.length,
      altText: o.alt ?? null,
    }),
    201,
    GigMediaUploadResponse,
  );
  const uploadKey = playUpload(up.upload, bytes);
  const detail = ok(await finalizeMedia(a, gigId, up.media.mediaId, { expectedRevision: up.revision, ...(o.hash === false ? {} : { sha256: sha(bytes) }) }));
  return { mediaId: up.media.mediaId, revision: detail.draftVersion.revision, detail, uploadKey, authorized: up };
}

// ---------------------------------------------------------------- the world
const OPTIONS_POLICY = PROVIDER_GIG_OPTIONS_POLICY_KEYS;
const MEDIA_POLICY = PROVIDER_GIG_MEDIA_POLICY_KEYS;
const W = {} as { m: string; stA: string; tplFull: string; tplVariants: string; tplPlain: string };
const tplDefinition = (pricingModels: string[], fields: unknown[]) => ({
  expectedRevision: 1,
  duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 240 },
  pricingModels,
  areaModes: ['RADIUS'],
  fields,
  requirements: [],
  reason: REASON,
});
const completeDraft = (expectedRevision: number, over: Record<string, unknown> = {}) => ({
  expectedRevision,
  title: `${TEXT_MARK} title`,
  shortPitch: `${TEXT_MARK} pitch`,
  description: `${TEXT_MARK} description`,
  priceAmountMinor: 4500,
  durationMinutes: 90,
  fieldValues: [],
  ...over,
});
const newGig = async (a: Actor, tpl: string = W.tplFull): Promise<Json> => ok(await createGig(a, tpl), 201);
const revOf = (detail: Json): number => detail.draftVersion.revision;
const idOf = (detail: Json): string => detail.gig.gigId;
const NAME_MARK = 'SentinelOptionName';
const ALT_MARK = 'SentinelAltText';
const defaults = {
  [OPTIONS_POLICY.variantMaxCount]: 10,
  [OPTIONS_POLICY.addOnMaxCount]: 20,
  [MEDIA_POLICY.maxItems]: 50,
  [MEDIA_POLICY.requireCleanScan]: true,
};
const resetPolicy = async () => {
  for (const [k, v] of Object.entries(defaults)) await setConfig(k, v);
};
/** Every object key and asset id the database knows (they must appear in no response except the one upload target that names the key). */
async function internalIds(): Promise<string[]> {
  const rows = await q<{ media_asset_id: string; object_key: string; sha256: string | null }>(
    `SELECT media_asset_id, object_key, sha256 FROM provider.media_assets`,
  );
  return rows.flatMap((r) => [r.media_asset_id, r.object_key, ...(r.sha256 ? [r.sha256] : [])]);
}
const sqlError = async (text: string, params: unknown[] = []): Promise<{ code?: string; detail?: string; message: string } | null> => {
  try {
    await q(text, params);
    return null;
  } catch (e) {
    return e as { code?: string; detail?: string; message: string };
  }
};

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { onQuery: (e) => capture?.push(e.sql), overrides: { poolMax: 30, connectionTimeoutMs: 30_000 } } });
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
  // wired like apps/api/src/index.ts: the registry policy, the private store and the scanner adapter
  providerGigs = new ProviderGigService({
    database,
    accounts: accountPort,
    templates: createGigTemplatePort(gigTemplates),
    policy: createGigPolicyProvider(configuration),
    store,
    scanner: testScanner,
  });
  const providerRegistrations = new ProviderRegistrationService({
    database,
    accounts: accountPort,
    consent: createConsentPort(consent),
    markets: createMarketPort(geography),
    catalog: createCatalogPort(catalog),
    policy: createProviderPolicyProvider(configuration),
    prerequisites: createGigPrerequisites(providerGigs),
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
    readiness: async () => ({}),
  });
  await app.ready();

  W.m = await market('m');
  const cat = await category();
  W.stA = await serviceType(cat);
  await catalog.setMarketCategoryAvailability(W.m, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  await catalog.setMarketServiceTypeAvailability(W.m, W.stA, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  W.tplFull = await liveTemplate(
    W.stA,
    'tpl_full',
    [W.m],
    tplDefinition(
      ['FIXED', 'FIXED_WITH_VARIANTS', 'ADD_ONS'],
      [
        field('before_photos', 'MEDIA', 'PROVIDER_REQUIRED', { minItems: 1, maxItems: 3 }),
        field('extra_photos', 'MEDIA', 'PROVIDER_CONFIGURABLE', { minItems: 0, maxItems: 2 }),
        field('no_photos', 'MEDIA', 'PROVIDER_CONFIGURABLE', { minItems: 0, maxItems: 0 }),
      ],
    ),
  );
  W.tplVariants = await liveTemplate(
    W.stA,
    'tpl_var',
    [W.m],
    tplDefinition(['FIXED_WITH_VARIANTS'], [field('gallery', 'MEDIA', 'PROVIDER_CONFIGURABLE', { minItems: 0, maxItems: 5 })]),
  );
  W.tplPlain = await liveTemplate(W.stA, 'tpl_plain', [W.m], tplDefinition(['FIXED'], [field('notes', 'TEXT', 'PROVIDER_CONFIGURABLE', { maxLength: 60 })]));
  await publishLegal('legal.terms_of_service');
  await publishLegal('legal.privacy_policy');
  await resetPolicy();
}, 300_000);
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== the seeded policy
describe('the seeded variant, add-on and photo policy of migration 0021', () => {
  it('serves the fifteen parameters through the real registry, parsed by the same wiring the API uses', async () => {
    const policy = createGigPolicyProvider(configuration);
    expect(await policy.options()).toEqual({ variantMaxCount: 10, addOnMaxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 });
    expect(await policy.media()).toEqual({
      maxFileSizeBytes: 10_485_760,
      maxItems: 50,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      uploadTtlSeconds: 900,
      requireCleanScan: true,
      minEdgePixels: 200,
      maxEdgePixels: 12_000,
      maxPixels: 50_000_000,
      downloadTtlSeconds: 60,
      orphanGraceSeconds: 86_400,
      altTextMaxLength: 200,
    });
  });
});

// ====================================================================== variants and add-ons
describe('variants and add-ons of the draft', () => {
  it('replaces the whole list under the revision: server-minted keys, array order, one revision bump, counts in the children facts', async () => {
    const a = await provider('opt-journey');
    const d = await newGig(a);
    const r0 = revOf(d);
    expect(d.draftVersion.constraints.variants).toMatchObject({ permitted: true, maxCount: 10, nameMaxLength: 80, descriptionMaxLength: 500 });
    expect(d.draftVersion.constraints.addOns).toMatchObject({ permitted: true, maxCount: 20 });
    const v = ok(await putVariants(a, idOf(d), r0, [opt(`${NAME_MARK} Deep clean`, 2500, 60, 'All rooms'), opt('Windows', 0, 0)]));
    expect(revOf(v)).toBe(r0 + 1);
    expect(v.draftVersion.variants.map((x: Json) => [x.name, x.priceDeltaMinor, x.durationDeltaMinutes, x.displayOrder])).toEqual([
      [`${NAME_MARK} Deep clean`, 2500, 60, 1],
      ['Windows', 0, 0, 2],
    ]);
    for (const x of v.draftVersion.variants) expect(x.key).toMatch(/^opt_[0-9a-f]{12}$/);
    expect(v.draftVersion.variants[0].description).toBe('All rooms');
    expect(v.draftVersion.variants[1].description).toBeNull();
    expect(v.draftVersion.children).toMatchObject({ variantCount: 2, addOnCount: 0, variantsValid: true });
    // the price is the BASE; a variant only adds to it, in the same currency (never sent, not on the item)
    for (const x of v.draftVersion.variants)
      expect(keysOf(x)).toEqual(['description', 'displayOrder', 'durationDeltaMinutes', 'key', 'name', 'priceDeltaMinor']);

    // an independent list: add-ons do not touch the variants but do raise the revision
    const ad = ok(await putAddOns(a, idOf(d), revOf(v), [opt('Oven', 1500, 20), opt('Fridge', 1000, 15)]));
    expect(revOf(ad)).toBe(revOf(v) + 1);
    expect(ad.draftVersion.addOns.map((x: Json) => [x.name, x.displayOrder])).toEqual([
      ['Oven', 1],
      ['Fridge', 2],
    ]);
    expect(ad.draftVersion.variants).toEqual(v.draftVersion.variants);
    expect(ad.draftVersion.children).toMatchObject({ variantCount: 2, addOnCount: 2 });
    const rows = await q<Json>(`SELECT item_key, display_order FROM provider.gig_version_variants WHERE gig_version_id = $1 ORDER BY display_order`, [
      ad.draftVersion.gigVersionId,
    ]);
    expect(rows.map((r) => r.item_key)).toEqual(v.draftVersion.variants.map((x: Json) => x.key));
  });

  it('keeps an item that is sent with its key, reorders by array order, and a semantically identical list is a no-op (no revision bump, no audit row)', async () => {
    const a = await provider('opt-keys');
    const d = await newGig(a);
    const v1 = ok(await putVariants(a, idOf(d), revOf(d), [opt('One', 100), opt('Two', 200)]));
    const [k1, k2] = v1.draftVersion.variants.map((x: Json) => x.key);
    const auditBefore = (
      await q<Json>(`SELECT count(*)::int n FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_VARIANTS_UPDATED'`, [idOf(d)])
    )[0]!.n;
    const same = ok(await putVariants(a, idOf(d), revOf(v1), [opt('One', 100, 0, null, k1), opt('Two', 200, 0, null, k2)]));
    expect(revOf(same)).toBe(revOf(v1));
    expect(
      (await q<Json>(`SELECT count(*)::int n FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_VARIANTS_UPDATED'`, [idOf(d)]))[0]!.n,
    ).toBe(auditBefore);
    // moved and edited: the keys survive, the order follows the array
    const moved = ok(await putVariants(a, idOf(d), revOf(same), [opt('Two', 250, 5, null, k2), opt('One', 100, 0, null, k1), opt('Three', 300)]));
    expect(revOf(moved)).toBe(revOf(same) + 1);
    expect(moved.draftVersion.variants.map((x: Json) => [x.key, x.name, x.priceDeltaMinor, x.displayOrder]).slice(0, 2)).toEqual([
      [k2, 'Two', 250, 1],
      [k1, 'One', 100, 2],
    ]);
    expect(moved.draftVersion.variants[2].key).not.toBe(k1);
    // an empty list clears them
    const cleared = ok(await putVariants(a, idOf(d), revOf(moved), []));
    expect(cleared.draftVersion.variants).toEqual([]);
    expect(cleared.draftVersion.children.variantCount).toBe(0);
  });

  it('a stale revision is 409 GIG_STALE_DRAFT and changes nothing', async () => {
    const a = await provider('opt-stale');
    const d = await newGig(a);
    const v = ok(await putVariants(a, idOf(d), revOf(d), [opt('One')]));
    gigFail(await putVariants(a, idOf(d), revOf(d), [opt('Other')]), 409, 'STALE_DRAFT');
    gigFail(await putAddOns(a, idOf(d), revOf(d), [opt('Other')]), 409, 'STALE_DRAFT');
    const after = ok(await getGig(a, idOf(d)));
    expect(after.draftVersion.variants.map((x: Json) => x.name)).toEqual(['One']);
    expect(revOf(after)).toBe(revOf(v));
  });

  it.each([
    ['an unknown key', () => [opt('One', 0, 0, null, 'opt_000000000000')], 'OPTION_KEY_INVALID'],
    ['a duplicate name, case-insensitively and after normalisation', () => [opt('Deep Clean'), opt('  deep   clean ')], 'OPTION_NAME_DUPLICATE'],
    ['a blank name', () => [opt('   ')], 'OPTION_NAME_REQUIRED'],
    ['a name above the configured length', () => [opt('x'.repeat(81))], 'OPTION_NAME_TOO_LONG'],
    ['a description above the configured length', () => [opt('One', 0, 0, 'y'.repeat(501))], 'OPTION_DESCRIPTION_TOO_LONG'],
  ] as [string, () => unknown[], string][])('%s is 400 VALIDATION_FAILED with an identifier-only issue and nothing is written', async (_n, make, reason) => {
    const a = await provider(`opt-bad-${reason.toLowerCase()}`);
    const d = await newGig(a);
    const r = await putVariants(a, idOf(d), revOf(d), make());
    const e = gigFail(r, 400, 'VALIDATION_FAILED');
    expect(hasIssue(e, 'variants', reason)).toBe(true);
    for (const i of issuesOf(e)) expect(Object.keys(i).sort()).toEqual(expect.arrayContaining(['messageKey', 'reason', 'target']));
    expect(r.raw).not.toContain('Deep Clean');
    expect(r.raw).not.toContain('xxxxxxxx');
    const after = ok(await getGig(a, idOf(d)));
    expect(after.draftVersion.variants).toEqual([]);
    expect(revOf(after)).toBe(revOf(d));
  });

  it('the item limits follow the configuration: a count above the configured maximum is refused, and raising the limit admits it', async () => {
    const a = await provider('opt-limit');
    const d = await newGig(a);
    await setConfig(OPTIONS_POLICY.variantMaxCount, 2);
    try {
      const e = gigFail(await putVariants(a, idOf(d), revOf(d), [opt('A'), opt('B'), opt('C')]), 400, 'VALIDATION_FAILED');
      expect(hasIssue(e, 'variants', 'OPTIONS_COUNT_EXCEEDED')).toBe(true);
      ok(await putVariants(a, idOf(d), revOf(d), [opt('A'), opt('B')]));
      const fresh = ok(await getGig(a, idOf(d)));
      expect(fresh.draftVersion.constraints.variants.maxCount).toBe(2);
    } finally {
      await setConfig(OPTIONS_POLICY.variantMaxCount, 10);
    }
    const fresh = ok(await getGig(a, idOf(d)));
    ok(await putVariants(a, idOf(d), revOf(fresh), [opt('A'), opt('B'), opt('C')]));
  });

  it('the template version decides: no variants without FIXED_WITH_VARIANTS, no add-ons without the ADD_ONS permission; an empty list is always fine', async () => {
    const a = await provider('opt-permission');
    const plain = await newGig(a, W.tplPlain);
    expect(plain.draftVersion.constraints.variants.permitted).toBe(false);
    expect(plain.draftVersion.constraints.addOns.permitted).toBe(false);
    expect(hasIssue(gigFail(await putVariants(a, idOf(plain), revOf(plain), [opt('A')]), 400, 'VALIDATION_FAILED'), 'variants', 'OPTIONS_NOT_PERMITTED')).toBe(
      true,
    );
    expect(hasIssue(gigFail(await putAddOns(a, idOf(plain), revOf(plain), [opt('A')]), 400, 'VALIDATION_FAILED'), 'addOns', 'OPTIONS_NOT_PERMITTED')).toBe(
      true,
    );
    expect(revOf(ok(await putVariants(a, idOf(plain), revOf(plain), [])))).toBe(revOf(plain));

    const variantsOnly = await newGig(a, W.tplVariants);
    expect(variantsOnly.draftVersion.constraints.variants.permitted).toBe(true);
    expect(variantsOnly.draftVersion.constraints.addOns.permitted).toBe(false);
    ok(await putVariants(a, idOf(variantsOnly), revOf(variantsOnly), [opt('A')]));
    expect(
      hasIssue(
        gigFail(await putAddOns(a, idOf(variantsOnly), revOf(variantsOnly) + 1, [opt('A')]), 400, 'VALIDATION_FAILED'),
        'addOns',
        'OPTIONS_NOT_PERMITTED',
      ),
    ).toBe(true);
    // the database backstop says the same
    const err = await sqlError(
      `INSERT INTO provider.gig_version_add_ons (add_on_id, gig_version_id, item_key, name, price_delta_minor, duration_delta_minutes, display_order)
       VALUES (gen_random_uuid(), $1, 'opt_aaaaaaaaaaaa', 'x', 0, 0, 1)`,
      [variantsOnly.draftVersion.gigVersionId],
    );
    expect(err?.code).toBe('23000');
    expect(err?.detail).toContain('ADD_ONS_NOT_PERMITTED');
  });

  it('audit rows and events carry counts only: never a name, a description, a key or an amount', async () => {
    const a = await provider('opt-audit');
    const d = await newGig(a);
    ok(await putVariants(a, idOf(d), revOf(d), [opt(`${NAME_MARK} audit`, 12345, 7, `${NAME_MARK} description`)]));
    const rows = await q<Json>(`SELECT action, changes FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_VARIANTS_UPDATED'`, [idOf(d)]);
    expect(rows).toHaveLength(1);
    const json = JSON.stringify(rows[0]);
    for (const secret of [NAME_MARK, '12345', 'opt_']) expect(json, secret).not.toContain(secret);
    expect(rows[0]!.changes).toMatchObject({ added: 1, removed: 0, count: [0, 1] });
  });
});

// ====================================================================== photos
describe('photos: authorize, upload, finalize, alt text, order, detach', () => {
  it('the whole journey: UPLOADING then READY, verified header facts, promoted bytes, one revision per mutation, no key or hash in any default payload', async () => {
    const a = await provider('photo-journey');
    const d = await newGig(a);
    const r0 = revOf(d);
    const bytes = uniquePng(640, 480);
    const up = ok(
      await authorize(a, idOf(d), {
        expectedRevision: r0,
        fieldKey: 'before_photos',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        sha256: sha(bytes),
        altText: `${ALT_MARK} kitchen`,
      }),
      201,
      GigMediaUploadResponse,
    );
    expect(keysOf(up)).toEqual(['maxSizeBytes', 'media', 'revision', 'upload']);
    expect(up.revision).toBe(r0 + 1);
    expect(up.maxSizeBytes).toBe(10_485_760);
    expect(up.media).toMatchObject({
      fieldKey: 'before_photos',
      displayOrder: 1,
      status: 'UPLOADING',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      width: null,
      height: null,
    });
    expect(up.upload.headers).toEqual({ 'content-type': 'image/png', 'content-length': String(bytes.length) });
    expect(new Date(up.upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // a pending asset exists, owned by the account; the draft shows the pending photo
    const pending = await q<Json>(
      `SELECT status, mime_type, size_bytes, sha256, width, scan_status, account_id FROM provider.media_assets WHERE object_key LIKE 'provider/gig-media/%' AND account_id = $1`,
      [a.accountId],
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'UPLOAD_PENDING', mime_type: 'image/png', sha256: null, width: null, scan_status: 'PENDING' });
    const mid = ok(await getGig(a, idOf(d)));
    expect(mid.draftVersion.media).toHaveLength(1);
    expect(mid.draftVersion.media[0].status).toBe('UPLOADING');
    // publishing is blocked while the photo is unfinished
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(up.revision)));
    const blocked = gigFail(await publish(a, idOf(d), revOf(saved)), 409, 'PUBLISH_BLOCKED');
    expect(blocked.details.issues.some((i: Json) => i.target === 'media' && ['MEDIA_NOT_READY', 'MEDIA_REQUIRED'].includes(i.reason))).toBe(true);

    // the browser PUTs to the presigned URL, then finalizes; a stale revision is refused before anything is read
    const uploadKey = playUpload(up.upload, bytes);
    gigFail(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: r0 }), 409, 'STALE_DRAFT');
    const done = ok(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: revOf(saved), sha256: sha(bytes) }));
    expect(revOf(done)).toBe(revOf(saved) + 1);
    expect(done.draftVersion.media[0]).toMatchObject({
      mediaId: up.media.mediaId,
      status: 'READY',
      width: 640,
      height: 480,
      mimeType: 'image/png',
      altText: `${ALT_MARK} kitchen`,
    });
    expect(done.draftVersion.children).toMatchObject({ mediaCount: 1, mediaRequirementSatisfied: true });
    // while the upload was unfinished the photo did not count as a delivered one
    expect(mid.draftVersion.children).toMatchObject({ mediaCount: 0, mediaRequirementSatisfied: false });
    const asset = (
      await q<Json>(
        `SELECT a.*, m.gig_version_media_id FROM provider.media_assets a JOIN provider.gig_version_media m USING (media_asset_id) WHERE m.gig_version_media_id = $1`,
        [up.media.mediaId],
      )
    )[0]!;
    expect(asset).toMatchObject({ status: 'READY', width: 640, height: 480, scan_status: 'CLEAN', sha256: sha(bytes) });
    expect(asset.ready_at).not.toBeNull();
    // promoted: the final key holds exactly the verified bytes, the upload key is gone
    expect(store.objects.get(asset.object_key as string)?.bytes.equals(bytes)).toBe(true);
    expect(store.objects.has(uploadKey)).toBe(false);
    expect(uploadKey).toBe(`${asset.object_key as string}.upload`);
    // idempotent: finishing again returns the Gig and changes nothing
    const again = ok(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: revOf(done) }));
    expect(revOf(again)).toBe(revOf(done));
    expect(again.draftVersion.media[0].status).toBe('READY');
    // the upload-replay problem: a still-valid presigned PUT writes again after finalize; nothing ever reads that key again
    store.put(uploadKey, Buffer.from('replayed bytes'), 'image/png');
    expect(store.objects.get(asset.object_key as string)?.bytes.equals(bytes)).toBe(true);
    expect(ok(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: revOf(done) })).draftVersion.media[0].status).toBe('READY');
    expect(store.objects.get(asset.object_key as string)?.bytes.equals(bytes)).toBe(true);
    store.objects.delete(uploadKey);

    // no response outside the one upload target names an asset, a key or a hash
    for (const secret of [asset.media_asset_id as string, asset.object_key as string, asset.sha256 as string])
      for (const t of transcript.filter((x) => x.url.includes(idOf(d)) && !(x.method === 'POST' && x.url.endsWith('/media/uploads'))))
        expect(t.raw, `${t.method} ${t.url}`).not.toContain(secret);
  });

  it('JPEG, PNG and WebP are verified by their own header and the photo records the real dimensions and the type', async () => {
    const a = await provider('photo-types');
    const d = await newGig(a);
    const j = await addPhoto(a, idOf(d), revOf(d), {
      bytes: Buffer.concat([jpeg(1024, 768), Buffer.from(randomUUID())]),
      mime: 'image/jpeg',
      fieldKey: 'before_photos',
    });
    const w = await addPhoto(a, idOf(d), j.revision, {
      bytes: Buffer.concat([webp(800, 600), Buffer.from(randomUUID())]),
      mime: 'image/webp',
      fieldKey: 'before_photos',
    });
    const media = w.detail.draftVersion.media;
    expect(media.map((m: Json) => [m.mimeType, m.width, m.height, m.status])).toEqual([
      ['image/jpeg', 1024, 768, 'READY'],
      ['image/webp', 800, 600, 'READY'],
    ]);
  });

  it('the alt text: set, cleared, bounded and plain; every change is one revision and the audit row holds a flag only', async () => {
    const a = await provider('photo-alt');
    const d = await newGig(a);
    const p = await addPhoto(a, idOf(d), revOf(d));
    const set = ok(await putAlt(a, idOf(d), p.mediaId, p.revision, `${ALT_MARK} a sunny kitchen`));
    expect(revOf(set)).toBe(p.revision + 1);
    expect(set.draftVersion.media[0].altText).toBe(`${ALT_MARK} a sunny kitchen`);
    const same = ok(await putAlt(a, idOf(d), p.mediaId, revOf(set), `${ALT_MARK} a sunny kitchen`));
    expect(revOf(same)).toBe(revOf(set));
    const cleared = ok(await putAlt(a, idOf(d), p.mediaId, revOf(same), null));
    expect(cleared.draftVersion.media[0].altText).toBeNull();
    expect(revOf(cleared)).toBe(revOf(same) + 1);
    const long = gigFail(await putAlt(a, idOf(d), p.mediaId, revOf(cleared), 'z'.repeat(201)), 400, 'VALIDATION_FAILED');
    expect(hasIssue(long, 'media', 'MEDIA_ALT_TOO_LONG')).toBe(true);
    gigFail(await putAlt(a, idOf(d), p.mediaId, revOf(cleared) - 1, 'x'), 409, 'STALE_DRAFT');
    const audit = JSON.stringify(
      await q(`SELECT changes FROM provider.gig_audit_events WHERE gig_id = $1 AND action IN ('GIG_MEDIA_UPDATED', 'GIG_MEDIA_ATTACHED')`, [idOf(d)]),
    );
    expect(audit).not.toContain(ALT_MARK);
  });

  it("order: the whole set in one call, a set that is not exactly the draft's photos is refused, detach keeps the order of the rest and an UPLOADING photo is abandoned with its objects", async () => {
    const a = await provider('photo-order');
    const d = await newGig(a);
    const p1 = await addPhoto(a, idOf(d), revOf(d));
    const p2 = await addPhoto(a, idOf(d), p1.revision);
    const p3 = await addPhoto(a, idOf(d), p2.revision);
    const ids = [p1.mediaId, p2.mediaId, p3.mediaId];
    const ordered = ok(await putOrder(a, idOf(d), p3.revision, [ids[2]!, ids[0]!, ids[1]!]));
    expect(ordered.draftVersion.media.map((m: Json) => [m.mediaId, m.displayOrder])).toEqual([
      [ids[2], 1],
      [ids[0], 2],
      [ids[1], 3],
    ]);
    expect(revOf(ordered)).toBe(p3.revision + 1);
    // the same order again is a no-op
    expect(revOf(ok(await putOrder(a, idOf(d), revOf(ordered), [ids[2]!, ids[0]!, ids[1]!])))).toBe(revOf(ordered));
    // a missing, an extra and a foreign id are all refused
    for (const bad of [
      [ids[0]!, ids[1]!],
      [...ids, randomUUID()],
      [ids[0]!, ids[1]!, randomUUID()],
    ]) {
      const e = gigFail(await putOrder(a, idOf(d), revOf(ordered), bad), 400, 'VALIDATION_FAILED');
      expect(hasIssue(e, 'media', 'MEDIA_ORDER_INVALID')).toBe(true);
    }
    gigFail(await putOrder(a, idOf(d), revOf(ordered) - 1, [ids[2]!, ids[0]!, ids[1]!]), 409, 'STALE_DRAFT');

    // the third photo of the required field is the last one the template allows
    const full = await authorize(a, idOf(d), {
      expectedRevision: revOf(ordered),
      fieldKey: 'before_photos',
      mimeType: 'image/png',
      sizeBytes: 100,
      altText: null,
    });
    expect(hasIssue(gigFail(full, 400, 'VALIDATION_FAILED'), 'media', 'MEDIA_TOO_MANY', 'before_photos')).toBe(true);

    // detach a READY photo: the attachment goes, the asset and its bytes stay (it is not referenced by a published version yet, so only the clean-up may delete it later)
    const asset1 = (
      await q<Json>(
        `SELECT media_asset_id, object_key FROM provider.media_assets a WHERE a.media_asset_id = (SELECT media_asset_id FROM provider.gig_version_media WHERE gig_version_media_id = $1)`,
        [ids[0]],
      )
    )[0]!;
    const gone = ok(await detachMedia(a, idOf(d), ids[0]!, revOf(ordered)));
    expect(revOf(gone)).toBe(revOf(ordered) + 1);
    // the order of the remaining photos is kept (a gap in the numbers is fine: only the relative order counts)
    expect(gone.draftVersion.media.map((m: Json) => m.mediaId)).toEqual([ids[2], ids[1]]);
    expect(gone.draftVersion.media[0].displayOrder).toBeLessThan(gone.draftVersion.media[1].displayOrder);
    expect((await q<Json>(`SELECT status FROM provider.media_assets WHERE media_asset_id = $1`, [asset1.media_asset_id]))[0]!.status).toBe('READY');
    expect(store.objects.has(asset1.object_key as string)).toBe(true);
    gigFail(await detachMedia(a, idOf(d), ids[0]!, revOf(gone)), 404, 'MEDIA_NOT_FOUND');

    // an UPLOADING photo that is detached is abandoned and its objects deleted
    const up = ok(
      await authorize(a, idOf(d), { expectedRevision: revOf(gone), fieldKey: 'extra_photos', mimeType: 'image/jpeg', sizeBytes: 900, altText: null }),
      201,
      GigMediaUploadResponse,
    );
    const uploadKey = playUpload(up.upload, Buffer.alloc(900, 1), 'image/jpeg');
    const abandoned = ok(await detachMedia(a, idOf(d), up.media.mediaId, up.revision));
    expect(abandoned.draftVersion.media).toHaveLength(2);
    expect(store.objects.has(uploadKey)).toBe(false);
    const row = (await q<Json>(`SELECT status FROM provider.media_assets WHERE object_key = $1`, [uploadKey.replace(/\.upload$/, '')]))[0]!;
    expect(row.status).toBe('ABANDONED');
  });

  it.each([
    ['a type that is not allowed', { mimeType: 'image/gif', sizeBytes: 100 }, 'MIME_NOT_ALLOWED'],
    ['SVG', { mimeType: 'image/svg+xml', sizeBytes: 100 }, 'MIME_NOT_ALLOWED'],
    ['HEIC (deferred until a verified reader exists)', { mimeType: 'image/heic', sizeBytes: 100 }, 'MIME_NOT_ALLOWED'],
    ['a file above the configured size', { mimeType: 'image/png', sizeBytes: 10_485_761 }, 'FILE_TOO_LARGE'],
  ] as [string, Json, string][])('authorizing %s is 400 GIG_MEDIA_REFUSED with a reason code and creates nothing', async (_n, over, reason) => {
    const a = await provider(`photo-auth-${reason.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`);
    const d = await newGig(a);
    const r = await authorize(a, idOf(d), { expectedRevision: revOf(d), fieldKey: 'before_photos', altText: null, ...over });
    const e = gigFail(r, 400, 'MEDIA_REFUSED');
    expect(e.details.reason).toBe(reason);
    expect(await q(`SELECT 1 FROM provider.media_assets WHERE account_id = $1`, [a.accountId])).toHaveLength(0);
    expect(revOf(ok(await getGig(a, idOf(d))))).toBe(revOf(d));
  });

  it('the template decides where photos go: an unknown field, a prohibited field (max 0) and a template without a MEDIA field are all refused', async () => {
    const a = await provider('photo-rules');
    const full = await newGig(a);
    const body = (over: Json) => ({ expectedRevision: revOf(full), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: 100, altText: null, ...over });
    expect(
      hasIssue(gigFail(await authorize(a, idOf(full), body({ fieldKey: 'no_photos' })), 400, 'VALIDATION_FAILED'), 'media', 'MEDIA_NOT_PERMITTED', 'no_photos'),
    ).toBe(true);
    expect(hasIssue(gigFail(await authorize(a, idOf(full), body({ fieldKey: 'nope' })), 400, 'VALIDATION_FAILED'), 'media', 'MEDIA_FIELD_UNKNOWN')).toBe(true);
    const plain = await newGig(a, W.tplPlain);
    expect(plain.draftVersion.constraints.media.permitted).toBe(false);
    expect(
      hasIssue(
        gigFail(await authorize(a, idOf(plain), { ...body({ fieldKey: 'notes' }), expectedRevision: revOf(plain) }), 400, 'VALIDATION_FAILED'),
        'media',
        'MEDIA_FIELD_UNKNOWN',
      ),
    ).toBe(true);
    expect(await q(`SELECT 1 FROM provider.media_assets WHERE account_id = $1`, [a.accountId])).toHaveLength(0);
    // the optional field takes up to its own maximum (2); the total maximum is configurable
    const p1 = await addPhoto(a, idOf(full), revOf(full), { fieldKey: 'extra_photos' });
    const p2 = await addPhoto(a, idOf(full), p1.revision, { fieldKey: 'extra_photos' });
    expect(
      hasIssue(
        gigFail(await authorize(a, idOf(full), { ...body({ fieldKey: 'extra_photos' }), expectedRevision: p2.revision }), 400, 'VALIDATION_FAILED'),
        'media',
        'MEDIA_TOO_MANY',
        'extra_photos',
      ),
    ).toBe(true);
    await setConfig(MEDIA_POLICY.maxItems, 2);
    try {
      const total = gigFail(
        await authorize(a, idOf(full), { ...body({ fieldKey: 'before_photos' }), expectedRevision: p2.revision }),
        400,
        'VALIDATION_FAILED',
      );
      expect(hasIssue(total, 'media', 'MEDIA_TOTAL_EXCEEDED')).toBe(true);
    } finally {
      await setConfig(MEDIA_POLICY.maxItems, 50);
    }
  });

  describe('finalize refusals: the photo is removed from the draft, its objects are deleted and the audit row holds a reason code only', () => {
    const refuse = async (
      label: string,
      make: () => { bytes: Buffer; authorizedMime?: string; authorizedSize?: number; storedMime?: string; hash?: string },
      status: number,
      code: string,
      reason: string,
    ) => {
      const a = await provider(`photo-ref-${label}`);
      const d = await newGig(a);
      const f = make();
      const mime = f.authorizedMime ?? 'image/png';
      const up = ok(
        await authorize(a, idOf(d), {
          expectedRevision: revOf(d),
          fieldKey: 'before_photos',
          mimeType: mime,
          sizeBytes: f.authorizedSize ?? f.bytes.length,
          altText: null,
        }),
        201,
        GigMediaUploadResponse,
      );
      const uploadKey = playUpload(up.upload, f.bytes, f.storedMime ?? mime);
      const r = await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision, ...(f.hash ? { sha256: f.hash } : {}) });
      const e = status === 400 ? gigFail(r, 400, code) : gigFail(r, status, code);
      expect(e.details.reason).toBe(reason);
      const after = ok(await getGig(a, idOf(d)));
      expect(after.draftVersion.media).toEqual([]);
      expect(revOf(after)).toBe(up.revision + 1);
      expect(store.objects.has(uploadKey)).toBe(false);
      const asset = (await q<Json>(`SELECT status, sha256 FROM provider.media_assets WHERE object_key = $1`, [uploadKey.replace(/\.upload$/, '')]))[0]!;
      expect(asset.status).toBe('ABANDONED');
      expect(store.objects.has(uploadKey.replace(/\.upload$/, ''))).toBe(false);
      const audit = await q<Json>(`SELECT changes FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_MEDIA_UPLOAD_REFUSED'`, [idOf(d)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.changes).toMatchObject({ reason });
      expect(r.raw).not.toContain(uploadKey);
    };

    it('wrong signature: a PNG that is not a PNG', () =>
      refuse('sig', () => ({ bytes: Buffer.from('<html>this is not an image</html>'.padEnd(400, ' ')) }), 400, 'MEDIA_REFUSED', 'SIGNATURE_MISMATCH'));
    it('a lying type: JPEG bytes declared as PNG', () => refuse('lie', () => ({ bytes: jpeg(300, 300) }), 400, 'MEDIA_REFUSED', 'SIGNATURE_MISMATCH'));
    it('a size that differs from the authorized one', () =>
      refuse('size', () => ({ bytes: uniquePng(), authorizedSize: 99_999 }), 400, 'MEDIA_REFUSED', 'SIZE_MISMATCH'));
    it('a stored content type that differs from the authorized one', () =>
      refuse('ctype', () => ({ bytes: uniquePng(), storedMime: 'text/html' }), 400, 'MEDIA_REFUSED', 'CONTENT_TYPE_MISMATCH'));
    it('a hash that differs from the one the client sent', () =>
      refuse('hash', () => ({ bytes: uniquePng(), hash: 'ab'.repeat(32) }), 400, 'MEDIA_REFUSED', 'HASH_MISMATCH'));
    it('an image that is too small', () => refuse('small', () => ({ bytes: uniquePng(100, 100) }), 400, 'MEDIA_REFUSED', 'IMAGE_TOO_SMALL'));
    it('a decompression-bomb header: a tiny file that claims a huge image', () =>
      refuse('bomb', () => ({ bytes: png(30_000, 30_000) }), 400, 'MEDIA_REFUSED', 'IMAGE_TOO_LARGE'));
    it('a malformed image header', () =>
      refuse('bad', () => ({ bytes: Buffer.concat([png(300, 300).subarray(0, 20)]) }), 400, 'MEDIA_REFUSED', 'IMAGE_INVALID'));
    it('an infected file (the EICAR test string)', () =>
      refuse('eicar', () => ({ bytes: Buffer.concat([png(300, 300), Buffer.from(EICAR_TEST_STRING, 'latin1')]) }), 400, 'MEDIA_REFUSED', 'SCAN_INFECTED'));
  });

  it('an object that is not there yet is a refusal that keeps the photo pending: the browser may upload again, then finalize works', async () => {
    const a = await provider('photo-missing');
    const d = await newGig(a);
    const bytes = uniquePng();
    const up = ok(
      await authorize(a, idOf(d), { expectedRevision: revOf(d), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: bytes.length, altText: null }),
      201,
      GigMediaUploadResponse,
    );
    const e = gigFail(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision }), 400, 'MEDIA_REFUSED');
    expect(e.details.reason).toBe('OBJECT_MISSING');
    expect(ok(await getGig(a, idOf(d))).draftVersion.media[0].status).toBe('UPLOADING');
    playUpload(up.upload, bytes);
    expect(ok(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision })).draftVersion.media[0].status).toBe('READY');
  });

  it('a scanner that cannot answer is 503 GIG_MEDIA_SCAN_UNAVAILABLE, the photo stays pending, and the call can be repeated; without the clean-scan requirement it is attached with the ERROR verdict', async () => {
    const a = await provider('photo-scan');
    const d = await newGig(a);
    const bytes = uniquePng();
    const up = ok(
      await authorize(a, idOf(d), { expectedRevision: revOf(d), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: bytes.length, altText: null }),
      201,
      GigMediaUploadResponse,
    );
    playUpload(up.upload, bytes);
    scanMode = 'error';
    try {
      for (let i = 0; i < 2; i++) {
        const r = await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision });
        const e = gigFail(r, 503, 'MEDIA_SCAN_UNAVAILABLE');
        expect(e.details).toEqual({ retryable: true, messageKey: gigErrorKey('MEDIA_SCAN_UNAVAILABLE') });
      }
      expect(ok(await getGig(a, idOf(d))).draftVersion.media[0].status).toBe('UPLOADING');
      // a pending photo cannot be previewed
      gigFail(await previewDraft(a, idOf(d), up.media.mediaId), 404, 'MEDIA_NOT_FOUND');
      await setConfig(MEDIA_POLICY.requireCleanScan, false);
      try {
        const done = ok(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision }));
        expect(done.draftVersion.media[0].status).toBe('READY');
        expect((await q<Json>(`SELECT scan_status FROM provider.media_assets WHERE account_id = $1`, [a.accountId]))[0]!.scan_status).toBe('ERROR');
      } finally {
        await setConfig(MEDIA_POLICY.requireCleanScan, true);
      }
    } finally {
      scanMode = 'real';
    }
  });

  it('an authorization that was never finished expires: finalize is 409 GIG_MEDIA_EXPIRED and the photo is removed', async () => {
    const a = await provider('photo-expired');
    const d = await newGig(a);
    const bytes = uniquePng();
    const up = ok(
      await authorize(a, idOf(d), { expectedRevision: revOf(d), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: bytes.length, altText: null }),
      201,
      GigMediaUploadResponse,
    );
    playUpload(up.upload, bytes);
    // the authorization window is immutable by design: move it into the past with the guard switched off for this one statement (the table is the test database's own)
    await q(`ALTER TABLE provider.media_assets DISABLE TRIGGER USER`);
    try {
      await q(`UPDATE provider.media_assets SET upload_expires_at = created_at + interval '1 millisecond' WHERE account_id = $1`, [a.accountId]);
    } finally {
      await q(`ALTER TABLE provider.media_assets ENABLE TRIGGER USER`);
    }
    const e = gigFail(await finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision }), 409, 'MEDIA_EXPIRED');
    expect(e.details.reason).toBe('UPLOAD_EXPIRED');
    expect(ok(await getGig(a, idOf(d))).draftVersion.media).toEqual([]);
    expect((await q<Json>(`SELECT status FROM provider.media_assets WHERE account_id = $1`, [a.accountId]))[0]!.status).toBe('ABANDONED');
  });

  it('without an object store nothing can be attached: the operations answer 503 GIG_UNAVAILABLE and the draft is untouched', async () => {
    const bare = new ProviderGigService({
      database: iso.database,
      accounts: createAccountPort(accounts),
      templates: createGigTemplatePort(gigTemplates),
      policy: createGigPolicyProvider(configuration),
    });
    await expect(bare.requestMediaUpload('00000000-0000-4000-8000-000000000001', randomUUID(), {})).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(bare.cleanupMedia({ limit: 1 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

// ====================================================================== publish, freeze, the next draft
describe('publishing with photos, the freeze of published children, and the next draft', () => {
  it('a required photo blocks publishing until a READY one exists; publishing counts photos, variants and add-ons in the audit and the event only', async () => {
    const a = await provider('pub-journey');
    const d = await newGig(a);
    const r1 = ok(await putVariants(a, idOf(d), revOf(d), [opt(`${NAME_MARK} V1`, 500, 10), opt('V2', 900, 20)]));
    const r2 = ok(await putAddOns(a, idOf(d), revOf(r1), [opt(`${NAME_MARK} A1`, 300, 5)]));
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(revOf(r2))));
    const e = gigFail(await publish(a, idOf(d), revOf(saved)), 409, 'PUBLISH_BLOCKED');
    expect(hasIssue(e, 'media', 'MEDIA_REQUIRED', 'before_photos')).toBe(true);
    expect(saved.draftVersion.publishable).toBe(false);
    expect(saved.draftVersion.children.mediaRequirementSatisfied).toBe(false);

    const photo = await addPhoto(a, idOf(d), revOf(saved), { alt: `${ALT_MARK} before` });
    expect(photo.detail.draftVersion.publishable).toBe(true);
    const published = ok(await publish(a, idOf(d), photo.revision));
    expect(published.currentVersion).toMatchObject({ versionNumber: 1, status: 'PUBLISHED' });
    expect(published.currentVersion.variants).toHaveLength(2);
    expect(published.currentVersion.addOns).toHaveLength(1);
    expect(published.currentVersion.media).toHaveLength(1);
    expect(published.currentVersion.children).toMatchObject({ variantCount: 2, addOnCount: 1, mediaCount: 1, mediaRequirementSatisfied: true });
    expect(published.draftVersion).toBeNull();

    const events = await q<Json>(`SELECT payload_json FROM integration.outbox_events WHERE event_type = 'bananagig.provider.gig-version-published.v1'`);
    const mine = events.map((x) => x.payload_json).find((p: Json) => p.gigId === idOf(d));
    expect(mine).toMatchObject({ variantCount: 2, addOnCount: 1, mediaCount: 1, versionNumber: 1 });
    const pubAudit = await q<Json>(`SELECT changes FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_VERSION_PUBLISHED'`, [idOf(d)]);
    expect(pubAudit[0]!.changes).toMatchObject({ variantCount: 2, addOnCount: 1, mediaCount: 1 });
    for (const text of [JSON.stringify(mine), JSON.stringify(pubAudit)])
      for (const secret of [NAME_MARK, ALT_MARK, 'opt_', 'provider/gig-media']) expect(text, secret).not.toContain(secret);

    // the menu carries the facts, no URL
    const m = ok(await menu(a), 200, null);
    const item = m.gigs.find((g: Json) => g.gig.gigId === idOf(d));
    expect(item.currentVersion.children).toMatchObject({
      variantCount: 2,
      addOnCount: 1,
      mediaCount: 1,
      variantsValid: true,
      addOnsValid: true,
      mediaRequirementSatisfied: true,
    });
    expect(item.draftVersion).toBeNull();
  });

  it('a published version is frozen: no draft route works, and the database refuses every change and delete of its children', async () => {
    const a = await provider('pub-frozen');
    const d = await newGig(a);
    const v = ok(await putVariants(a, idOf(d), revOf(d), [opt('V1', 100)]));
    const ad = ok(await putAddOns(a, idOf(d), revOf(v), [opt('A1', 100)]));
    const photo = await addPhoto(a, idOf(d), revOf(ad));
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(photo.revision)));
    const pub = ok(await publish(a, idOf(d), revOf(saved)));
    const versionId = pub.currentVersion.gigVersionId;
    // without a draft every child mutation is a wrong state, not a 404
    gigFail(await putVariants(a, idOf(d), 1, []), 409, 'NO_DRAFT');
    gigFail(await putAddOns(a, idOf(d), 1, []), 409, 'NO_DRAFT');
    gigFail(
      await authorize(a, idOf(d), { expectedRevision: 1, fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: 100, altText: null }),
      409,
      'NO_DRAFT',
    );
    gigFail(await detachMedia(a, idOf(d), photo.mediaId, 1), 409, 'NO_DRAFT');
    gigFail(await putOrder(a, idOf(d), 1, [photo.mediaId]), 409, 'NO_DRAFT');
    gigFail(await putAlt(a, idOf(d), photo.mediaId, 1, null), 409, 'NO_DRAFT');
    gigFail(await finalizeMedia(a, idOf(d), photo.mediaId, { expectedRevision: 1 }), 409, 'NO_DRAFT');
    // the database refuses every write to the children of a published version
    for (const statement of [
      `UPDATE provider.gig_version_variants SET name = 'x' WHERE gig_version_id = $1`,
      `DELETE FROM provider.gig_version_variants WHERE gig_version_id = $1`,
      `UPDATE provider.gig_version_add_ons SET price_delta_minor = 1 WHERE gig_version_id = $1`,
      `DELETE FROM provider.gig_version_add_ons WHERE gig_version_id = $1`,
      `UPDATE provider.gig_version_media SET alt_text = 'x' WHERE gig_version_id = $1`,
      `DELETE FROM provider.gig_version_media WHERE gig_version_id = $1`,
    ]) {
      const err = await sqlError(statement, [versionId]);
      expect(err?.code, statement).toBe('23000');
      // since 0022 an UPDATE of a variant or add-on is refused outright (NO_UPDATE: the set is replaced by delete and insert); every other write is VERSION_FROZEN
      const expected = /^UPDATE provider\.gig_version_(variants|add_ons)\b/.test(statement) ? 'NO_UPDATE' : 'VERSION_FROZEN';
      expect(err?.detail, statement).toContain(expected);
    }
    const v1 = ok(await getVersion(a, idOf(d), 1), 200, null);
    expect(v1.variants).toHaveLength(1);
    expect(v1.media).toHaveLength(1);
  });

  it('the next draft copies variants and add-ons (same keys, same order) and re-attaches the SAME photos; editing v2 never touches v1', async () => {
    const a = await provider('pub-next');
    const d = await newGig(a);
    const v = ok(await putVariants(a, idOf(d), revOf(d), [opt('Small', 100, 10), opt('Large', 300, 30)]));
    const ad = ok(await putAddOns(a, idOf(d), revOf(v), [opt('Oven', 500, 15)]));
    const p1 = await addPhoto(a, idOf(d), revOf(ad));
    const p2 = await addPhoto(a, idOf(d), p1.revision, { fieldKey: 'extra_photos' });
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(p2.revision)));
    const pub = ok(await publish(a, idOf(d), revOf(saved)));
    const v1Keys = pub.currentVersion.variants.map((x: Json) => x.key);
    const v1Media = pub.currentVersion.media;
    const assetsBefore = await q<Json>(`SELECT media_asset_id FROM provider.media_assets WHERE account_id = $1 ORDER BY media_asset_id`, [a.accountId]);
    const objectsBefore = store.objects.size;

    const next = ok(await nextDraft(a, idOf(d)), 201);
    expect(next.draftVersion.versionNumber).toBe(2);
    expect(next.draftVersion.variants.map((x: Json) => [x.key, x.name, x.priceDeltaMinor, x.durationDeltaMinutes, x.displayOrder])).toEqual(
      pub.currentVersion.variants.map((x: Json) => [x.key, x.name, x.priceDeltaMinor, x.durationDeltaMinutes, x.displayOrder]),
    );
    expect(next.draftVersion.addOns.map((x: Json) => x.key)).toEqual(pub.currentVersion.addOns.map((x: Json) => x.key));
    expect(next.draftVersion.media).toHaveLength(2);
    expect(next.draftVersion.media.map((m: Json) => [m.fieldKey, m.displayOrder, m.status, m.width])).toEqual(
      v1Media.map((m: Json) => [m.fieldKey, m.displayOrder, 'READY', m.width]),
    );
    // new attachment ids (version-scoped), but the very same assets and no new bytes
    for (const m of next.draftVersion.media) expect(v1Media.map((x: Json) => x.mediaId)).not.toContain(m.mediaId);
    expect(await q<Json>(`SELECT media_asset_id FROM provider.media_assets WHERE account_id = $1 ORDER BY media_asset_id`, [a.accountId])).toEqual(
      assetsBefore,
    );
    expect(store.objects.size).toBe(objectsBefore);
    const shared = await q<Json>(
      `SELECT media_asset_id, count(*)::int n FROM provider.gig_version_media WHERE gig_version_id IN (SELECT gig_version_id FROM provider.gig_versions WHERE gig_id = $1) GROUP BY media_asset_id`,
      [idOf(d)],
    );
    expect(shared.every((r) => r.n === 2)).toBe(true);
    const copyAudit = JSON.stringify(await q(`SELECT changes FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_DRAFT_CREATED'`, [idOf(d)]));
    expect(copyAudit).not.toContain('opt_');

    // edit v2: change a variant, drop a photo, add a new one; v1 is untouched and the shared asset survives the detach
    const edited = ok(await putVariants(a, idOf(d), revOf(next), [opt('Small', 150, 10, null, v1Keys[0]), opt('Brand new', 999, 1)]));
    expect(edited.draftVersion.variants[0].key).toBe(v1Keys[0]);
    const dropped = ok(await detachMedia(a, idOf(d), next.draftVersion.media[1].mediaId, revOf(edited)));
    expect(dropped.draftVersion.media).toHaveLength(1);
    const added = await addPhoto(a, idOf(d), revOf(dropped), { fieldKey: 'extra_photos' });
    expect(added.detail.draftVersion.media).toHaveLength(2);
    const v1After = ok(await getVersion(a, idOf(d), 1), 200, null);
    expect(v1After.variants).toEqual(pub.currentVersion.variants);
    expect(v1After.addOns).toEqual(pub.currentVersion.addOns);
    expect(v1After.media).toEqual(v1Media);
    for (const m of v1Media) {
      expect(
        (
          await q<Json>(
            `SELECT a.status FROM provider.media_assets a JOIN provider.gig_version_media m USING (media_asset_id) WHERE m.gig_version_media_id = $1`,
            [m.mediaId],
          )
        )[0]!.status,
      ).toBe('READY');
      ok(await previewVersion(a, idOf(d), 1, m.mediaId), 200, GigMediaPreviewResponse);
    }
    // publishing v2 supersedes v1, whose children stay exactly as they were
    const s2 = ok(await saveDraft(a, idOf(d), completeDraft(added.revision)));
    const pub2 = ok(await publish(a, idOf(d), revOf(s2)));
    expect(pub2.currentVersion.versionNumber).toBe(2);
    expect(ok(await getVersion(a, idOf(d), 1), 200, null).variants).toEqual(pub.currentVersion.variants);
    expect(ok(await getVersion(a, idOf(d), 1), 200, null).status).toBe('SUPERSEDED');
  });

  it('retiring the Gig freezes everything; the photos stay readable and previewable by the owner', async () => {
    const a = await provider('pub-retire');
    const d = await newGig(a);
    const photo = await addPhoto(a, idOf(d), revOf(d));
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(photo.revision)));
    ok(await publish(a, idOf(d), revOf(saved)));
    const next = ok(await nextDraft(a, idOf(d)), 201);
    ok(await retire(a, idOf(d)));
    gigFail(await putVariants(a, idOf(d), revOf(next), []), 409, 'GIG_RETIRED');
    gigFail(
      await authorize(a, idOf(d), { expectedRevision: revOf(next), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: 100, altText: null }),
      409,
      'GIG_RETIRED',
    );
    const v1 = ok(await getVersion(a, idOf(d), 1), 200, null);
    expect(v1.status).toBe('RETIRED');
    expect(v1.media).toHaveLength(1);
    expect(v1.media[0].mediaId).toBe(photo.mediaId);
    ok(await previewVersion(a, idOf(d), 1, photo.mediaId), 200, GigMediaPreviewResponse);
    // the retired draft keeps its (re-attached) photo as well
    const v2 = ok(await getVersion(a, idOf(d), 2), 200, null);
    expect(v2.status).toBe('RETIRED');
    expect(v2.media).toHaveLength(1);
  });
});

// ====================================================================== previews
describe('previews are owner-only, short-lived, no-store and never part of a default payload', () => {
  it('the draft preview and the version preview answer a one-object GET URL (inline, the configured TTL) for a READY photo', async () => {
    const a = await provider('prev-ok');
    const d = await newGig(a);
    const photo = await addPhoto(a, idOf(d), revOf(d));
    store.issued.length = 0;
    const draftPreview = ok(await previewDraft(a, idOf(d), photo.mediaId), 200, GigMediaPreviewResponse);
    expect(keysOf(draftPreview)).toEqual(['expiresAt', 'url']);
    expect(draftPreview.url.startsWith('memory://download/')).toBe(true);
    expect(new Date(draftPreview.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(draftPreview.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(store.issued).toEqual([expect.objectContaining({ kind: 'download', ttlSeconds: 60, disposition: 'inline' })]);
    const versionPreview = ok(await previewVersion(a, idOf(d), 1, photo.mediaId), 200, GigMediaPreviewResponse);
    expect(versionPreview.url.startsWith('memory://download/')).toBe(true);
    // the preview URL appears in no other response
    for (const t of transcript.filter((x) => !x.url.endsWith('/preview'))) expect(t.raw).not.toContain('memory://download/');
  });

  it('a media id of another Gig or version, an unknown id and a malformed one are 404 or 400 and indistinguishable from "not yours"', async () => {
    const a = await provider('prev-404');
    const d1 = await newGig(a);
    const d2 = await newGig(a);
    const p1 = await addPhoto(a, idOf(d1), revOf(d1));
    const strange = await previewDraft(a, idOf(d2), p1.mediaId);
    const unknown = await previewDraft(a, idOf(d2), randomUUID());
    gigFail(strange, 404, 'MEDIA_NOT_FOUND');
    gigFail(unknown, 404, 'MEDIA_NOT_FOUND');
    expect({ ...strange.body.error, correlationId: 0 }).toEqual({ ...unknown.body.error, correlationId: 0 });
    gigFail(await previewVersion(a, idOf(d2), 1, p1.mediaId), 404, 'MEDIA_NOT_FOUND');
    gigFail(await previewVersion(a, idOf(d1), 9, p1.mediaId), 404, 'GIG_VERSION_NOT_FOUND');
    expect((await previewDraft(a, idOf(d1), 'not-a-uuid')).status).toBe(400);
    expect((await previewVersion(a, idOf(d1), '01', p1.mediaId)).status).toBe(400);
  });
});

// ====================================================================== owner isolation on EVERY new route
describe('another account cannot see or touch variants, add-ons or photos: 404 on every route, identical to a Gig that does not exist', () => {
  it('nine routes, one stranger', async () => {
    const owner = await provider('idor-owner');
    const stranger = await provider('idor-stranger');
    const d = await newGig(owner);
    const v = ok(await putVariants(owner, idOf(d), revOf(d), [opt(`${NAME_MARK} private`)]));
    const photo = await addPhoto(owner, idOf(d), revOf(v));
    const published = ok(
      await publish(
        owner,
        idOf(d),
        await (async () => {
          const s = ok(await saveDraft(owner, idOf(d), completeDraft(photo.revision)));
          return revOf(s);
        })(),
      ),
    );
    const next = ok(await nextDraft(owner, idOf(d)), 201);
    const mediaOfDraft = next.draftVersion.media[0].mediaId as string;
    const mediaOfV1 = published.currentVersion.media[0].mediaId as string;
    const ghost = randomUUID();
    const attempts: [string, (a: Actor, gig: string, media: string) => Promise<Res>][] = [
      ['PUT variants', (a, g) => putVariants(a, g, 2, [opt('x')])],
      ['PUT add-ons', (a, g) => putAddOns(a, g, 2, [opt('x')])],
      ['POST uploads', (a, g) => authorize(a, g, { expectedRevision: 2, fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: 100, altText: null })],
      ['POST finalize', (a, g, m) => finalizeMedia(a, g, m, { expectedRevision: 2 })],
      ['PUT alt text', (a, g, m) => putAlt(a, g, m, 2, 'x')],
      ['DELETE media', (a, g, m) => detachMedia(a, g, m, 2)],
      ['PUT order', (a, g, m) => putOrder(a, g, 2, [m])],
      ['GET draft preview', (a, g, m) => previewDraft(a, g, m)],
      ['GET version preview', (a, g, m) => previewVersion(a, g, 1, m)],
    ];
    const before =
      JSON.stringify(await q(`SELECT * FROM provider.gig_version_variants ORDER BY item_key`)) +
      JSON.stringify(await q(`SELECT * FROM provider.gig_version_media ORDER BY gig_version_media_id`));
    for (const [label, fn] of attempts) {
      const real = await fn(stranger, idOf(d), mediaOfDraft);
      const realV1 = await fn(stranger, idOf(d), mediaOfV1);
      const absent = await fn(stranger, ghost, mediaOfDraft);
      gigFail(real, 404, 'GIG_NOT_FOUND');
      gigFail(realV1, 404, 'GIG_NOT_FOUND');
      gigFail(absent, 404, 'GIG_NOT_FOUND');
      expect({ ...real.body.error, correlationId: 0 }, label).toEqual({ ...absent.body.error, correlationId: 0 });
      for (const r of [real, realV1]) {
        expect(r.raw, label).not.toContain(NAME_MARK);
        expect(r.raw, label).not.toContain(idOf(d) === ghost ? '' : mediaOfDraft);
      }
      // without a token: 401 whatever the id
      expect((await fn(null as never, idOf(d), mediaOfDraft)).status, label).toBe(401);
    }
    expect(
      JSON.stringify(await q(`SELECT * FROM provider.gig_version_variants ORDER BY item_key`)) +
        JSON.stringify(await q(`SELECT * FROM provider.gig_version_media ORDER BY gig_version_media_id`)),
    ).toBe(before);
    // the owner's own media id under the owner's OTHER Gig (or the stranger's own Gig) is a missing photo, never someone else's
    const own = await newGig(stranger);
    gigFail(await previewDraft(stranger, idOf(own), mediaOfDraft), 404, 'MEDIA_NOT_FOUND');
    gigFail(await detachMedia(stranger, idOf(own), mediaOfDraft, revOf(own)), 404, 'MEDIA_NOT_FOUND');
    gigFail(await finalizeMedia(stranger, idOf(own), mediaOfDraft, { expectedRevision: revOf(own) }), 404, 'MEDIA_NOT_FOUND');
    gigFail(await putAlt(stranger, idOf(own), mediaOfDraft, revOf(own), 'x'), 404, 'MEDIA_NOT_FOUND');
    // and an asset can never be attached by a second account: it only ever sees its own uploads
    expect(
      (
        await q<Json>(
          `SELECT count(*)::int n FROM provider.gig_version_media m JOIN provider.gig_versions v USING (gig_version_id) JOIN provider.gigs g USING (gig_id) WHERE g.account_id = $1`,
          [stranger.accountId],
        )
      )[0]!.n,
    ).toBe(0);
    // the database says the same if anything tried: the asset owner must be the Gig's account
    const assetOfOwner = (await q<Json>(`SELECT media_asset_id FROM provider.media_assets WHERE account_id = $1 LIMIT 1`, [owner.accountId]))[0]!
      .media_asset_id;
    const field = (await q<Json>(`SELECT gig_template_field_id FROM catalog.gig_template_fields WHERE field_key = 'before_photos' LIMIT 1`))[0]!
      .gig_template_field_id;
    const err = await sqlError(
      `INSERT INTO provider.gig_version_media (gig_version_media_id, gig_version_id, media_asset_id, gig_template_field_id, display_order) VALUES (gen_random_uuid(), $1, $2, $3, 1)`,
      [own.draftVersion.gigVersionId, assetOfOwner, field],
    );
    expect(err?.code).toBe('23000');
    expect(err?.detail).toMatch(/ASSET_OWNER|FIELD_NOT_IN_TEMPLATE_VERSION/);
  });
});

// ====================================================================== wrong states
describe('wrong states', () => {
  it('a Gig that has only a published version has no draft to edit; a request for a body that is not the contract is 400 before anything is looked up', async () => {
    const a = await provider('state-nodraft');
    const d = await newGig(a);
    const p = await addPhoto(a, idOf(d), revOf(d));
    const s = ok(await saveDraft(a, idOf(d), completeDraft(p.revision)));
    ok(await publish(a, idOf(d), revOf(s)));
    gigFail(await putVariants(a, idOf(d), 1, []), 409, 'NO_DRAFT');
    const bad = await call('PUT', `${draftPath(idOf(d))}/variants`, { as: a, body: { expectedRevision: 1, variants: [{ name: 5 }] } });
    expect(fail(bad, 400, 'VALIDATION_FAILED')).toBeDefined();
  });
});

// ====================================================================== concurrency
describe('concurrency', () => {
  it("two simultaneous replacements at the same revision: exactly one wins, the other is a stale draft, and the list is the winner's", async () => {
    const a = await provider('race-replace');
    const d = await newGig(a);
    const r = revOf(d);
    const [x, y] = await Promise.all([putVariants(a, idOf(d), r, [opt('From X')]), putVariants(a, idOf(d), r, [opt('From Y')])]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    gigFail(loser, 409, 'STALE_DRAFT');
    const winner = x.status === 200 ? x : y;
    const now = ok(await getGig(a, idOf(d)));
    expect(now.draftVersion.variants.map((v: Json) => v.name)).toEqual(winner.body.data.draftVersion.variants.map((v: Json) => v.name));
    expect(revOf(now)).toBe(r + 1);
  });

  it('a replacement racing the publish: either the publish includes the new list or the replacement is refused; the published version is never half-changed', async () => {
    const a = await provider('race-publish');
    const d = await newGig(a);
    const photo = await addPhoto(a, idOf(d), revOf(d));
    const saved = ok(await saveDraft(a, idOf(d), completeDraft(photo.revision)));
    const r = revOf(saved);
    const [rep, pub] = await Promise.all([putVariants(a, idOf(d), r, [opt('Racing')]), publish(a, idOf(d), r)]);
    expect([200, 409]).toContain(rep.status);
    expect([200, 409]).toContain(pub.status);
    expect([rep.status, pub.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const v1 = (await getVersion(a, idOf(d), 1)).body.data;
    if (pub.status === 200) {
      // the published list is whichever won, but it is complete and frozen
      expect(v1.status).toBe('PUBLISHED');
      expect(v1.variants.length === 0 || (v1.variants.length === 1 && v1.variants[0].name === 'Racing')).toBe(true);
      const again = (await getVersion(a, idOf(d), 1)).body.data;
      expect(again.variants).toEqual(v1.variants);
    }
  });

  it('two finalizations of the same upload at once: the photo is READY once and both callers get an answer', async () => {
    const a = await provider('race-finalize');
    const d = await newGig(a);
    const bytes = uniquePng();
    const up = ok(
      await authorize(a, idOf(d), { expectedRevision: revOf(d), fieldKey: 'before_photos', mimeType: 'image/png', sizeBytes: bytes.length, altText: null }),
      201,
      GigMediaUploadResponse,
    );
    playUpload(up.upload, bytes);
    const results = await Promise.all([
      finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision }),
      finalizeMedia(a, idOf(d), up.media.mediaId, { expectedRevision: up.revision }),
    ]);
    for (const r of results) expect(r.status, r.raw).toBe(200);
    expect(ok(await getGig(a, idOf(d))).draftVersion.media).toHaveLength(1);
    const audit = await q<Json>(`SELECT 1 FROM provider.gig_audit_events WHERE gig_id = $1 AND action = 'GIG_MEDIA_ATTACHED'`, [idOf(d)]);
    expect(audit).toHaveLength(1);
  });
});

// ====================================================================== the GigMenu and PRO-003 facts
describe('the GigMenu carries the facts about the children, in a constant number of statements', () => {
  it('draft and current versions report counts and the three booleans; no URL, name or key', async () => {
    const a = await provider('menu-facts');
    const d = await newGig(a);
    const v = ok(await putVariants(a, idOf(d), revOf(d), [opt(`${NAME_MARK} menu`)]));
    const empty = ok(await menu(a), 200, null);
    expect(empty.gigs[0].draftVersion.children).toEqual({
      variantCount: 1,
      addOnCount: 0,
      mediaCount: 0,
      variantsValid: true,
      addOnsValid: true,
      mediaRequirementSatisfied: false,
    });
    expect(empty.gigs[0].currentVersion).toBeNull();
    const photo = await addPhoto(a, idOf(d), revOf(v));
    const s = ok(await saveDraft(a, idOf(d), completeDraft(photo.revision)));
    ok(await publish(a, idOf(d), revOf(s)));
    const full = await menu(a);
    expect(full.status).toBe(200);
    expect(full.body.data.gigs[0].currentVersion.children).toEqual({
      variantCount: 1,
      addOnCount: 0,
      mediaCount: 1,
      variantsValid: true,
      addOnsValid: true,
      mediaRequirementSatisfied: true,
    });
    expect(full.body.data.readiness.goLive).toEqual({ evaluated: false, eligible: false });
    expect(full.raw).not.toMatch(/https?:|memory:/);
    for (const secret of [NAME_MARK, 'opt_', ...(await internalIds())]) expect(full.raw, secret).not.toContain(secret);
  });

  it('the number of statements does not grow with the number of Gigs', async () => {
    const one = await provider('menu-q1');
    await newGig(one);
    const many = await provider('menu-q7');
    for (let i = 0; i < 7; i++) {
      const g = await newGig(many);
      if (i % 2 === 0) ok(await putVariants(many, idOf(g), revOf(g), [opt('A'), opt('B')]));
    }
    const count = async (who: Actor) => {
      capture = [];
      ok(await menu(who), 200, null);
      const n = capture.length;
      capture = null;
      return n;
    };
    await count(one);
    expect(await count(many)).toBe(await count(one));
  });
});

// ====================================================================== secrecy
describe('provider text, object keys, hashes and URLs reach only the owner, in successful responses that need them', () => {
  it('no error response, log line, audit row or event carries an option name, an alt text, an object key, an asset id or a hash', async () => {
    const ids = await internalIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const t of transcript.filter((x) => x.status >= 400)) {
      for (const secret of [NAME_MARK, ALT_MARK, TEXT_MARK, 'Sentinel', 'provider/gig-media', ...ids])
        expect(t.raw, `${t.method} ${t.url}`).not.toContain(secret);
    }
    for (const line of logLines)
      for (const secret of [NAME_MARK, ALT_MARK, TEXT_MARK, 'provider/gig-media', 'memory://', 'X-Amz-Signature', ...ids])
        expect(line, secret).not.toContain(secret);
    const audit = JSON.stringify(await q(`SELECT action, changes FROM provider.gig_audit_events`));
    const outbox = JSON.stringify(await q(`SELECT payload_json FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'`));
    for (const text of [audit, outbox])
      for (const secret of [NAME_MARK, ALT_MARK, TEXT_MARK, 'provider/gig-media', ...ids]) expect(text, secret).not.toContain(secret);
    const actions = (await q<Json>(`SELECT DISTINCT action FROM provider.gig_audit_events`)).map((r) => r.action);
    for (const a of [
      'GIG_VARIANTS_UPDATED',
      'GIG_ADD_ONS_UPDATED',
      'GIG_MEDIA_UPLOAD_AUTHORIZED',
      'GIG_MEDIA_UPLOAD_REFUSED',
      'GIG_MEDIA_ATTACHED',
      'GIG_MEDIA_DETACHED',
      'GIG_MEDIA_REORDERED',
      'GIG_MEDIA_UPDATED',
    ])
      expect(actions, a).toContain(a);
    // only the three CAT-003 events exist: a mutation of the children emits none of its own
    const types = (await q<Json>(`SELECT DISTINCT event_type FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'`))
      .map((r) => r.event_type)
      .sort();
    expect(types).toEqual(['bananagig.provider.gig-created.v1', 'bananagig.provider.gig-retired.v1', 'bananagig.provider.gig-version-published.v1']);
    // every response of these routes is no-store, errors included
    for (const t of transcript.filter((x) => x.url.startsWith(`${P}/gigs`))) expect(t.headers['cache-control'], `${t.method} ${t.url}`).toBe('no-store');
    // the upload target is the only response that names an object, and only in its own URL
    const targets = transcript.filter((x) => x.method === 'POST' && x.url.endsWith('/media/uploads') && x.status === 201);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(GigMediaUploadResponse.safeParse(t.body).success).toBe(true);
    // unused imports keep the contract visible to the reader
    expect(ErrorResponse).toBeDefined();
    expect(vi).toBeDefined();
    expect(gigIssueKey('MEDIA_REQUIRED')).toBe('provider.gig.issue.media_required');
    expect(GigDetailResponse).toBeDefined();
    expect(PROVIDER_GIG_POLICY_KEYS).toBeDefined();
  });
});
