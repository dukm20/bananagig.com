// CAT-003 provider Gigs over HTTP, on the REAL stack wired the way apps/api/src/index.ts wires it: the real Fastify app (buildApp), the real AccountService, ConsentService, GeographyService,
// CatalogService, GigTemplateService, ContentService and ConfigurationService, the ProviderRegistrationService (whose `gigs` step is answered by the Gig domain), the ProviderGigService with
// the adapters of modules/provider/gig-wiring.ts, the real auth plugin with forged-but-signed tokens, and one real, isolated PostgreSQL (migration 0020 seeds the five Gig policy
// parameters). The unit layer (gig.test.ts) proves the HTTP edge with a fake service and packages/provider proves the service rules; this file proves the whole path with the database:
// the template choices, create (and the idempotent replay), the draft editor with eager validation, the publish blocks, publish and supersede, the next draft, the history, owner
// isolation on EVERY route, retirement, the template lifecycle (a Gig keeps the exact version it was built from), the configured limits, races, audit rows and events without provider
// text, the GIGS onboarding step, a query-count budget of the GigMenu and a secrecy scan over every response and log line.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountService, ConsentService } from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import {
  CORRELATION_HEADER,
  ErrorResponse,
  GIG_EVENTS,
  GigDetailResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
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
import { ProviderGigService, ProviderRegistrationService } from '@bananagig/provider';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createGigPolicyProvider, createGigPrerequisites, createGigTemplatePort } from './modules/provider/gig-wiring';
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
const TITLE = `${TEXT_MARK} sparkling title`;
const PITCH = `${TEXT_MARK} short pitch`;
const DESCRIPTION = `${TEXT_MARK} a long description`;
const NOTE = `${TEXT_MARK} note`;

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

// the Gig calls
const templatesOf = (a: Actor) => call('GET', '/gig-templates', { as: a });
const menu = (a: Actor) => call('GET', '/gigs', { as: a });
const createGig = (a: Actor, gigTemplateCode: string, clientRequestId?: string) =>
  call('POST', '/gigs', { as: a, body: { gigTemplateCode, ...(clientRequestId === undefined ? {} : { clientRequestId }) } });
const getGig = (a: Actor, gigId: string) => call('GET', `/gigs/${gigId}`, { as: a });
const getVersion = (a: Actor, gigId: string, v: number | string) => call('GET', `/gigs/${gigId}/versions/${v}`, { as: a });
const nextDraft = (a: Actor, gigId: string) => call('POST', `/gigs/${gigId}/versions`, { as: a });
const saveDraft = (a: Actor, gigId: string, body: unknown) => call('PUT', `/gigs/${gigId}/draft`, { as: a, body });
const publish = (a: Actor, gigId: string, expectedRevision: number) => call('POST', `/gigs/${gigId}/publish`, { as: a, body: { expectedRevision } });
const retire = (a: Actor, gigId: string) => call('POST', `/gigs/${gigId}/retire`, { as: a, body: {} });

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
/** A template with every supported type: a fixed text, an enum, a required integer, a text, a boolean, a decimal and a duration. */
const mainDefinition = () => ({
  expectedRevision: 1,
  duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 240 },
  pricingModels: ['FIXED'],
  areaModes: ['RADIUS'],
  fields: [
    field('intro', 'LONG_TEXT', 'PLATFORM_FIXED', { section: 'SCOPE', withDefaultText: true, minLength: 10, maxLength: 500 }),
    field('size', 'ENUM', 'PROVIDER_CONFIGURABLE', { options: [{ optionCode: 'small', isDefault: true }, { optionCode: 'large' }] }),
    field('rooms', 'INTEGER', 'PROVIDER_REQUIRED', { minNumber: 1, maxNumber: 20 }),
    field('notes', 'TEXT', 'PROVIDER_CONFIGURABLE', { maxLength: 60 }),
    field('pets', 'BOOLEAN', 'PROVIDER_CONFIGURABLE'),
    field('area_m2', 'DECIMAL', 'PROVIDER_CONFIGURABLE', { minNumber: 0, maxNumber: 1000 }),
    field('prep_minutes', 'DURATION', 'PROVIDER_CONFIGURABLE', { minNumber: 5, maxNumber: 120 }),
  ],
  requirements: [{ requirementType: 'LICENSE' }],
  reason: REASON,
});
/** A template with no duration facts at all: a Gig of it takes no duration and needs none (a base price is always allowed and required). */
const noPriceDefinition = () => ({
  expectedRevision: 1,
  pricingModels: ['FIXED'],
  areaModes: ['RADIUS'],
  fields: [field('notes', 'TEXT', 'PROVIDER_CONFIGURABLE', { maxLength: 60 })],
  requirements: [],
  reason: REASON,
});
/** A template with a required photo field (1 to 6 photos): such a Gig cannot be published without a READY photo (CAT-004). */
const mediaDefinition = () => ({
  expectedRevision: 1,
  duration: { minMinutes: 30, maxMinutes: 240 },
  pricingModels: ['FIXED'],
  areaModes: ['RADIUS'],
  fields: [field('before_photos', 'MEDIA', 'PROVIDER_REQUIRED', { minItems: 1, maxItems: 6 })],
  requirements: [],
  reason: REASON,
});
type Def = ReturnType<typeof mainDefinition>;
async function liveTemplate(
  st: string,
  prefix: string,
  markets: string[],
  def: Def | ReturnType<typeof noPriceDefinition> | ReturnType<typeof mediaDefinition>,
): Promise<string> {
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
const G = PROVIDER_GIG_POLICY_KEYS;
const DEFAULT_POLICY: Record<string, unknown> = {
  [G.maxActive]: 25,
  [G.maxDrafts]: 10,
  [G.titleMaxLength]: 100,
  [G.shortPitchMaxLength]: 1000,
  [G.descriptionMaxLength]: 5000,
};
const resetPolicy = async (only?: string[]) => {
  for (const [k, v] of Object.entries(DEFAULT_POLICY)) if (!only || only.includes(k)) await setConfig(k, v);
};

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

const W = {} as {
  m: string; // the market of the providers (USD)
  n: string; // another market
  stA: string;
  stB: string; // offered in M but never selected by the providers
  stN: string; // offered in N only
  tplMain: string;
  tplNoPrice: string;
  tplMedia: string;
  tplOtherService: string;
  tplOnlyN: string;
};

// the draft content a complete main Gig needs
const completeDraft = (expectedRevision: number, over: Record<string, unknown> = {}) => ({
  expectedRevision,
  title: TITLE,
  shortPitch: PITCH,
  description: DESCRIPTION,
  priceAmountMinor: 4500,
  durationMinutes: 90,
  fieldValues: [
    { fieldKey: 'rooms', value: 3 },
    { fieldKey: 'size', value: 'large' },
    { fieldKey: 'notes', value: NOTE },
    { fieldKey: 'pets', value: true },
    { fieldKey: 'area_m2', value: '45.5' },
    { fieldKey: 'prep_minutes', value: 15 },
  ],
  ...over,
});
/** Creates a Gig of the main template and returns its detail. */
async function gigOf(a: Actor, tpl: string = W.tplMain): Promise<Json> {
  return ok(await createGig(a, tpl), 201);
}
/** A Gig with a published v1. */
async function publishedGig(a: Actor, tpl: string = W.tplMain): Promise<Json> {
  const d = await gigOf(a, tpl);
  const s = ok(await saveDraft(a, d.gig.gigId, completeDraft(d.draftVersion.revision)));
  return ok(await publish(a, d.gig.gigId, s.draftVersion.revision));
}

// ---------------------------------------------------------------- log capture
const logLines: string[] = [];
function captureLogs(): void {
  const grab = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab);
}

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
  const providerGigs = new ProviderGigService({
    database,
    accounts: accountPort,
    templates: createGigTemplatePort(gigTemplates),
    policy: createGigPolicyProvider(configuration),
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

  // the world
  W.m = await market('m');
  W.n = await market('n');
  const cat = await category();
  W.stA = await serviceType(cat);
  W.stB = await serviceType(cat);
  W.stN = await serviceType(cat);
  for (const m of [W.m, W.n]) await catalog.setMarketCategoryAvailability(m, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  for (const st of [W.stA, W.stB]) await catalog.setMarketServiceTypeAvailability(W.m, st, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  await catalog.setMarketServiceTypeAvailability(W.n, W.stN, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  await catalog.setMarketServiceTypeAvailability(W.n, W.stA, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
  W.tplMain = await liveTemplate(W.stA, 'tpl_main', [W.m, W.n], mainDefinition());
  W.tplNoPrice = await liveTemplate(W.stA, 'tpl_np', [W.m], noPriceDefinition());
  W.tplMedia = await liveTemplate(W.stA, 'tpl_media', [W.m], mediaDefinition());
  W.tplOtherService = await liveTemplate(W.stB, 'tpl_other', [W.m], noPriceDefinition());
  // enabled in market N only, but for a service type (stA) that providers of market M select
  W.tplOnlyN = await liveTemplate(W.stA, 'tpl_onlyn', [W.n], noPriceDefinition());
  // the legal documents providers must accept to complete a registration
  await publishLegal('legal.terms_of_service');
  await publishLegal('legal.privacy_policy');
  await resetPolicy();
}, 300_000);
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== seeded policy
describe('the seeded Gig policy of migration 0020', () => {
  it('serves the five parameters through the real registry with the documented defaults', async () => {
    const values = (await configuration.resolveMany(Object.values(G))).values;
    expect(Object.fromEntries([...values].map(([k, v]) => [k, v.value]))).toEqual(DEFAULT_POLICY);
  });
});

// ====================================================================== eligibility and the template choices
describe('who can start a Gig', () => {
  it('a customer without a registration reads empty choices and a GigMenu that cannot create; creating is refused with 403 PROVIDER_NOT_ELIGIBLE', async () => {
    const c = await newActor('customer', { contacts: true });
    const t = ok(await templatesOf(c), 200, GigTemplateChoicesResponse);
    expect(t).toEqual({ marketCode: null, templates: [] });
    const m = ok(await menu(c), 200, GigMenuResponse);
    expect(m).toMatchObject({
      gigs: [],
      canCreate: false,
      cannotCreateReason: 'PROVIDER_NOT_ELIGIBLE',
      readiness: { hasPublishedGig: false, goLive: { evaluated: false, eligible: false } },
    });
    const e = gigFail(await createGig(c, W.tplMain), 403, 'PROVIDER_NOT_ELIGIBLE');
    expect(e.details.reason).toMatch(/^(ROLE_NOT_ACTIVE|REGISTRATION_NOT_COMPLETED)$/);
    expect(await q(`SELECT 1 FROM provider.gigs WHERE account_id = $1`, [c.accountId])).toHaveLength(0);
  });

  it('a provider whose registration is in progress cannot create', async () => {
    const a = await newActor('inprogress', { contacts: true });
    await call('POST', REG, { as: a });
    await call('PUT', `${REG}/market`, { as: a, body: { marketCode: W.m } });
    await call('PUT', `${REG}/services`, { as: a, body: { serviceTypeCodes: [W.stA] } });
    gigFail(await createGig(a, W.tplMain), 403, 'PROVIDER_NOT_ELIGIBLE');
  });

  it('a completed provider sees exactly the templates of its market and selected service types, with content keys only', async () => {
    const a = await provider('choices');
    const t = ok(await templatesOf(a), 200, GigTemplateChoicesResponse);
    expect(t.marketCode).toBe(W.m);
    const codes = t.templates.map((x: Json) => x.gigTemplateCode).sort();
    expect(codes).toEqual([W.tplMain, W.tplNoPrice, W.tplMedia].sort());
    for (const x of t.templates) {
      expect(keysOf(x)).toEqual(['categoryCode', 'descriptionContentKey', 'gigTemplateCode', 'gigTemplateVersionNumber', 'nameContentKey', 'serviceTypeCode']);
      expect(x.serviceTypeCode).toBe(W.stA);
      expect(x.gigTemplateVersionNumber).toBe(1);
    }
  });

  it('creating from a template of a service type the provider did not select, from one not enabled in its market, and from an unknown code is refused', async () => {
    const a = await provider('refusals');
    const notSelected = gigFail(await createGig(a, W.tplOtherService), 403, 'PROVIDER_NOT_ELIGIBLE');
    expect(notSelected.details.reason).toBe('SERVICE_NOT_SELECTED');
    const notInMarket = await createGig(a, W.tplOnlyN);
    expect([404, 409]).toContain(notInMarket.status);
    expect(notInMarket.body.error.code).toMatch(/^(GIG_TEMPLATE_NOT_AVAILABLE|GIG_TEMPLATE_NOT_FOUND)$/);
    gigFail(await createGig(a, 'devtest_no_such_template'), 404, 'GIG_TEMPLATE_NOT_FOUND');
    expect(await q(`SELECT 1 FROM provider.gigs WHERE account_id = $1`, [a.accountId])).toHaveLength(0);
  });
});

// ====================================================================== the life of a Gig
describe('create, edit, publish, supersede, retire', () => {
  let a: Actor;
  let gigId: string;
  let v1Id: string;
  let templateVersionId: string;

  it('creates a Gig (201) bound to the ACTIVE template version, as a DRAFT v1 with the editor structure; the client names no version, currency or owner', async () => {
    a = await provider('flow');
    const rid = randomUUID();
    const d = ok(await createGig(a, W.tplMain, rid), 201);
    gigId = d.gig.gigId;
    expect(d.gig).toMatchObject({ status: 'DRAFT', gigTemplateCode: W.tplMain, serviceTypeCode: W.stA, retiredAt: null });
    expect(d.currentVersion).toBeNull();
    expect(d.versions).toHaveLength(1);
    const v = d.draftVersion;
    v1Id = v.gigVersionId;
    expect(v).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      revision: 1,
      gigTemplateVersionNumber: 1,
      title: null,
      price: null,
      durationMinutes: null,
      fieldValues: [],
      publishable: false,
    });
    expect(v.template).toMatchObject({
      gigTemplateCode: W.tplMain,
      gigTemplateVersionNumber: 1,
      versionStatus: 'ACTIVE',
      templateStatus: 'ACTIVE',
      serviceTypeCode: W.stA,
    });
    templateVersionId = v.template.gigTemplateVersionId;
    expect(v.template.requirements).toEqual([{ requirementType: 'LICENSE', referenceCode: null }]);
    // the editor structure: the fixed field is resolved from the template (never copied), the required one is flagged
    const byKey = Object.fromEntries(v.fields.map((f: Json) => [f.fieldKey, f]));
    expect(byKey.intro).toMatchObject({ fixed: true, behavior: 'PLATFORM_FIXED', supported: true });
    expect(byKey.rooms).toMatchObject({ required: true, fixed: false, minNumber: 1, maxNumber: 20 });
    expect(byKey.size.options.map((o: Json) => o.optionCode)).toEqual(['small', 'large']);
    expect(byKey.size.defaultOption).toBe('small');
    expect(v.constraints).toMatchObject({
      title: { maxLength: 100 },
      shortPitch: { maxLength: 1000 },
      description: { maxLength: 5000 },
      price: { permitted: true, required: true, currency: 'USD' },
      duration: { permitted: true, required: true, minMinutes: 30, maxMinutes: 240, suggestedMinutes: 60 },
    });
    // what the database holds
    const rows = await q<Json>(
      `SELECT gv.gig_template_version_id, gv.status, gv.version_number, g.client_request_id FROM provider.gigs g JOIN provider.gig_versions gv ON gv.gig_id = g.gig_id WHERE g.gig_id = $1`,
      [gigId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gig_template_version_id: templateVersionId, status: 'DRAFT', version_number: 1, client_request_id: rid });
    // idempotent replay: the same Gig, 200, nothing new
    const replay = ok(await createGig(a, W.tplMain, rid), 200);
    expect(replay.gig.gigId).toBe(gigId);
    expect(await q(`SELECT 1 FROM provider.gigs WHERE account_id = $1`, [a.accountId])).toHaveLength(1);
  });

  it('refuses invalid draft values eagerly, with identifier-only issues, and stores nothing', async () => {
    const base = (over: Record<string, unknown>) => completeDraft(1, over);
    const cases: [string, Record<string, unknown>, string, string, string?][] = [
      ['a platform-fixed field', { fieldValues: [{ fieldKey: 'intro', value: 'x'.repeat(20) }] }, 'field', 'FIELD_NOT_PROVIDER_EDITABLE', 'intro'],
      ['an unknown field', { fieldValues: [{ fieldKey: 'no_such_field', value: 1 }] }, 'field', 'FIELD_UNKNOWN', 'no_such_field'],
      ['an integer below its bound', { fieldValues: [{ fieldKey: 'rooms', value: 0 }] }, 'field', 'FIELD_VALUE_OUT_OF_RANGE', 'rooms'],
      ['an integer above its bound', { fieldValues: [{ fieldKey: 'rooms', value: 21 }] }, 'field', 'FIELD_VALUE_OUT_OF_RANGE', 'rooms'],
      ['text for an integer', { fieldValues: [{ fieldKey: 'rooms', value: 'three' }] }, 'field', 'FIELD_VALUE_INVALID', 'rooms'],
      ['an option the enum does not have', { fieldValues: [{ fieldKey: 'size', value: 'huge' }] }, 'field', 'FIELD_OPTION_UNKNOWN', 'size'],
      ['a boolean as text', { fieldValues: [{ fieldKey: 'pets', value: 'yes' }] }, 'field', 'FIELD_VALUE_INVALID', 'pets'],
      ['a decimal that is not a decimal string', { fieldValues: [{ fieldKey: 'area_m2', value: 'a lot' }] }, 'field', 'FIELD_VALUE_INVALID', 'area_m2'],
      ['a decimal above its bound', { fieldValues: [{ fieldKey: 'area_m2', value: '1000.5' }] }, 'field', 'FIELD_VALUE_OUT_OF_RANGE', 'area_m2'],
      ['a duration field out of range', { fieldValues: [{ fieldKey: 'prep_minutes', value: 500 }] }, 'field', 'FIELD_VALUE_OUT_OF_RANGE', 'prep_minutes'],
      ['text above its field length', { fieldValues: [{ fieldKey: 'notes', value: 'x'.repeat(61) }] }, 'field', 'FIELD_TOO_LONG', 'notes'],
      ['a title above the configured length', { title: 'x'.repeat(101) }, 'title', 'TITLE_TOO_LONG'],
      ['markup in the title', { title: '<b>bold</b>' }, 'title', 'HTML_NOT_ALLOWED'],
      ['a control character in the pitch', { shortPitch: 'bad\u0007pitch' }, 'shortPitch', 'FORBIDDEN_CHARACTER'],
      ['a duration below the template minimum', { durationMinutes: 10 }, 'duration', 'DURATION_OUT_OF_RANGE'],
      ['a duration above the template maximum', { durationMinutes: 241 }, 'duration', 'DURATION_OUT_OF_RANGE'],
    ];
    for (const [label, over, target, reason, fieldKey] of cases) {
      const r = await saveDraft(a, gigId, base(over));
      const e = gigFail(r, 400, 'VALIDATION_FAILED');
      expect(hasIssue(e, target, reason, fieldKey), `${label}: ${r.raw}`).toBe(true);
      expect(r.raw, label).not.toContain('Sentinel');
    }
    const row = (await q<Json>(`SELECT revision, title FROM provider.gig_versions WHERE gig_version_id = $1`, [v1Id]))[0]!;
    expect(row).toEqual({ revision: 1, title: null });
  });

  it('a stale revision is 409 GIG_STALE_DRAFT and changes nothing', async () => {
    const r = await saveDraft(a, gigId, completeDraft(7));
    gigFail(r, 409, 'STALE_DRAFT');
    expect(r.raw).not.toContain(TITLE);
    expect((await q<Json>(`SELECT revision FROM provider.gig_versions WHERE gig_version_id = $1`, [v1Id]))[0]).toEqual({ revision: 1 });
  });

  it('an incomplete draft saves (200, revision +1, the market currency set by the server) and publishing it is 409 GIG_PUBLISH_BLOCKED with the missing pieces', async () => {
    const d = ok(
      await saveDraft(a, gigId, {
        expectedRevision: 1,
        title: TITLE,
        shortPitch: null,
        description: null,
        priceAmountMinor: 4500,
        durationMinutes: null,
        fieldValues: [],
      }),
    );
    expect(d.draftVersion).toMatchObject({ revision: 2, title: TITLE, shortPitch: null, price: { amountMinor: 4500, currency: 'USD' }, publishable: false });
    const reasons = d.draftVersion.issues.map((i: Json) => `${i.target}:${i.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining(['shortPitch:SHORT_PITCH_REQUIRED', 'description:DESCRIPTION_REQUIRED', 'duration:DURATION_REQUIRED', 'field:FIELD_REQUIRED']),
    );
    const r = await publish(a, gigId, 2);
    const e = gigFail(r, 409, 'PUBLISH_BLOCKED');
    expect(hasIssue(e, 'shortPitch', 'SHORT_PITCH_REQUIRED')).toBe(true);
    expect(hasIssue(e, 'field', 'FIELD_REQUIRED', 'rooms')).toBe(true);
    expect(r.raw).not.toContain(TITLE);
    expect((await q<Json>(`SELECT status FROM provider.gigs WHERE gig_id = $1`, [gigId]))[0]).toEqual({ status: 'DRAFT' });
  });

  it('saving replaces the whole content: an omitted value is cleared, platform-fixed values are never copied, and the typed values are stored in their own columns', async () => {
    const d = ok(await saveDraft(a, gigId, completeDraft(2)));
    expect(d.draftVersion).toMatchObject({
      revision: 3,
      title: TITLE,
      shortPitch: PITCH,
      description: DESCRIPTION,
      durationMinutes: 90,
      publishable: true,
      issues: [],
    });
    const values = Object.fromEntries(d.draftVersion.fieldValues.map((f: Json) => [f.fieldKey, f.value]));
    expect(values).toEqual({ rooms: 3, size: 'large', notes: NOTE, pets: true, area_m2: '45.5', prep_minutes: 15 });
    const stored = await q<Json>(
      `SELECT f.field_key, fv.text_value, fv.integer_value::text AS integer_value, fv.decimal_value::text AS decimal_value, fv.boolean_value, fv.option_code, fv.duration_minutes
         FROM provider.gig_version_field_values fv JOIN catalog.gig_template_fields f ON f.gig_template_field_id = fv.gig_template_field_id WHERE fv.gig_version_id = $1 ORDER BY f.field_key`,
      [v1Id],
    );
    expect(stored.map((s: Json) => s.field_key)).toEqual(['area_m2', 'notes', 'pets', 'prep_minutes', 'rooms', 'size']);
    expect(stored.find((s: Json) => s.field_key === 'rooms')).toMatchObject({ integer_value: '3', text_value: null });
    expect(stored.find((s: Json) => s.field_key === 'size')).toMatchObject({ option_code: 'large' });
    // a smaller second save clears what it omits
    const smaller = ok(await saveDraft(a, gigId, completeDraft(3, { fieldValues: [{ fieldKey: 'rooms', value: 2 }] })));
    expect(smaller.draftVersion.fieldValues).toEqual([{ fieldKey: 'rooms', value: 2 }]);
    ok(await saveDraft(a, gigId, completeDraft(4)));
  });

  it('publishes v1: ACTIVE Gig, PUBLISHED v1 (frozen), no draft; the GigMenu and the readiness facts follow; a second publish of the same revision is refused', async () => {
    const d = ok(await publish(a, gigId, 5));
    expect(d.gig.status).toBe('ACTIVE');
    expect(d.draftVersion).toBeNull();
    expect(d.currentVersion).toMatchObject({ versionNumber: 1, status: 'PUBLISHED', title: TITLE, publishable: null, issues: [] });
    expect(d.currentVersion.publishedAt).not.toBeNull();
    const again = await publish(a, gigId, 5);
    expect([404, 409]).toContain(again.status);
    expect(again.body.error.code).toMatch(/^GIG_(STALE_DRAFT|NO_DRAFT)$/);
    expect(await q(`SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status = 'PUBLISHED'`, [gigId])).toHaveLength(1);
    const m = ok(await menu(a), 200, GigMenuResponse);
    expect(m.gigs).toHaveLength(1);
    expect(m.gigs[0]).toMatchObject({
      gig: { gigId, status: 'ACTIVE' },
      currentVersion: { versionNumber: 1, title: TITLE, price: { amountMinor: 4500, currency: 'USD' } },
      draftVersion: null,
      versionCount: 1,
    });
    expect(m.readiness).toEqual({ hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 0, goLive: { evaluated: false, eligible: false } });
    expect(m.limits).toMatchObject({ maxActive: 25, maxDrafts: 10, activeCount: 1, draftCount: 0 });
    expect(m.canCreate).toBe(true);
  });

  it('the registration GIGS step is answered by the Gig domain: COMPLETE once a Gig is published, and never BLOCKED', async () => {
    const r = await call('GET', `${REG}/requirements`, { as: a });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.data.steps.find((s: Json) => s.step === 'GIGS').status).toBe('COMPLETE');
    expect(r.body.data.overall.goLive).toEqual({ evaluated: false, eligible: false });
    const fresh = await provider('gigs-step');
    const before = await call('GET', `${REG}/requirements`, { as: fresh });
    expect(before.body.data.steps.find((s: Json) => s.step === 'GIGS').status).toBe('NOT_STARTED');
    await gigOf(fresh);
    const during = await call('GET', `${REG}/requirements`, { as: fresh });
    expect(during.body.data.steps.find((s: Json) => s.step === 'GIGS').status).toBe('IN_PROGRESS');
    expect(during.body.data.overall.blockedBy).not.toContain('GIGS');
  });

  it('a published version is frozen in the database', async () => {
    await expect(q(`UPDATE provider.gig_versions SET title = 'tampered' WHERE gig_version_id = $1`, [v1Id])).rejects.toMatchObject({ code: '23000' });
    await expect(q(`DELETE FROM provider.gig_versions WHERE gig_version_id = $1`, [v1Id])).rejects.toBeTruthy();
    await expect(q(`DELETE FROM provider.gigs WHERE gig_id = $1`, [gigId])).rejects.toBeTruthy();
  });

  it('starts v2 from the published version (201), bound to the SAME template version; a second draft is 409 GIG_DRAFT_EXISTS', async () => {
    const d = ok(await nextDraft(a, gigId), 201);
    expect(d.currentVersion.versionNumber).toBe(1);
    expect(d.draftVersion).toMatchObject({ versionNumber: 2, status: 'DRAFT', revision: 1, gigTemplateVersionNumber: 1 });
    expect(d.draftVersion.template.gigTemplateVersionId).toBe(templateVersionId);
    expect(d.versions.map((v: Json) => `${v.versionNumber}:${v.status}`)).toEqual(expect.arrayContaining(['1:PUBLISHED', '2:DRAFT']));
    gigFail(await nextDraft(a, gigId), 409, 'DRAFT_EXISTS');
    expect(await q(`SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status = 'DRAFT'`, [gigId])).toHaveLength(1);
  });

  it('publishes v2: v1 becomes SUPERSEDED in the same step, stays readable and unchanged; v2 is the only PUBLISHED version', async () => {
    const draft = ok(await getGig(a, gigId)).draftVersion;
    const saved = ok(await saveDraft(a, gigId, completeDraft(draft.revision, { title: `${TITLE} v2`, priceAmountMinor: 5000 })));
    const d = ok(await publish(a, gigId, saved.draftVersion.revision));
    expect(d.currentVersion).toMatchObject({ versionNumber: 2, status: 'PUBLISHED', title: `${TITLE} v2`, price: { amountMinor: 5000, currency: 'USD' } });
    expect(d.draftVersion).toBeNull();
    const v1 = ok(await getVersion(a, gigId, 1), 200, GigVersionResponse);
    expect(v1).toMatchObject({ versionNumber: 1, status: 'SUPERSEDED', title: TITLE, price: { amountMinor: 4500, currency: 'USD' } });
    expect(v1.supersededAt).not.toBeNull();
    const statuses = (await q<Json>(`SELECT version_number, status FROM provider.gig_versions WHERE gig_id = $1 ORDER BY version_number`, [gigId])).map(
      (r: Json) => `${r.version_number}:${r.status}`,
    );
    expect(statuses).toEqual(['1:SUPERSEDED', '2:PUBLISHED']);
    gigFail(await getVersion(a, gigId, 99), 404, 'GIG_VERSION_NOT_FOUND');
  });

  it('a draft refuses invalid values with 400 but a retired Gig, a published version and a missing draft refuse edits with 409', async () => {
    gigFail(await saveDraft(a, gigId, completeDraft(1)), 409, 'NO_DRAFT');
    gigFail(await publish(a, gigId, 1), 409, 'NO_DRAFT');
  });

  it('retires the Gig (200): terminal, the draft and the published version are RETIRED, superseded history stays, everything stays readable; no reactivation, no edits', async () => {
    ok(await nextDraft(a, gigId), 201);
    const d = ok(await retire(a, gigId));
    expect(d.gig.status).toBe('RETIRED');
    expect(d.gig.retiredAt).not.toBeNull();
    expect(d.currentVersion).toBeNull();
    expect(d.draftVersion).toBeNull();
    expect(d.versions.map((v: Json) => `${v.versionNumber}:${v.status}`).sort()).toEqual(['1:SUPERSEDED', '2:RETIRED', '3:RETIRED']);
    expect(ok(await getGig(a, gigId)).gig.status).toBe('RETIRED');
    expect(ok(await getVersion(a, gigId, 1), 200, GigVersionResponse).status).toBe('SUPERSEDED');
    expect(ok(await getVersion(a, gigId, 2), 200, GigVersionResponse).status).toBe('RETIRED');
    const m = ok(await menu(a), 200, GigMenuResponse);
    expect(m.gigs[0].gig.status).toBe('RETIRED');
    expect(m.readiness.hasPublishedGig).toBe(false);
    for (const r of [await nextDraft(a, gigId), await saveDraft(a, gigId, completeDraft(1)), await publish(a, gigId, 1)]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toMatch(/^(GIG_RETIRED|GIG_NO_DRAFT)$/);
    }
    await expect(q(`UPDATE provider.gigs SET status = 'ACTIVE', retired_at = NULL WHERE gig_id = $1`, [gigId])).rejects.toMatchObject({ code: '23000' });
  });

  it('wrote audit rows and outbox events with identifiers only: no title, pitch, description or text value anywhere', async () => {
    const audit = await q<Json>(
      `SELECT action, actor, changes, correlation_id FROM provider.gig_audit_events WHERE gig_id = $1 ORDER BY occurred_at, audit_event_id`,
      [gigId],
    );
    const actions = audit.map((r: Json) => r.action);
    for (const expected of ['GIG_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_DRAFT_CREATED', 'GIG_RETIRED'])
      expect(actions, expected).toContain(expected);
    for (const r of audit) {
      expect(r.actor).toBe(`account:${a.accountId}`);
      expect(r.correlation_id).toBeTruthy();
    }
    const events = await q<Json>(
      `SELECT event_type, aggregate_type, payload_json FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, outbox_event_id`,
      [gigId],
    );
    const types = events.map((e: Json) => e.event_type);
    expect(types).toEqual(expect.arrayContaining([GIG_EVENTS.gigCreated, GIG_EVENTS.gigVersionPublished, GIG_EVENTS.gigRetired]));
    expect(events.filter((e: Json) => e.event_type === GIG_EVENTS.gigVersionPublished)).toHaveLength(2);
    for (const e of events) expect(e.aggregate_type).toBe('provider-gig');
    const blob = JSON.stringify([audit, events]);
    for (const mark of [TEXT_MARK, 'sparkling', '4500', '5000']) expect(blob, mark).not.toContain(mark);
  });
});

// ====================================================================== owner isolation
describe('another account cannot see or touch a Gig: 404 on every route, identical to a Gig that does not exist', () => {
  it('covers every route that addresses a Gig or a version', async () => {
    const owner = await provider('idor-owner');
    const other = await provider('idor-other');
    const d = await publishedGig(owner);
    const gigId = d.gig.gigId;
    const ghost = randomUUID();
    const draft = ok(await nextDraft(owner, gigId), 201).draftVersion;
    const before = await q<Json>(
      `SELECT g.status, v.status AS vstatus, v.revision, v.title FROM provider.gigs g JOIN provider.gig_versions v USING (gig_id) WHERE g.gig_id = $1 ORDER BY v.version_number`,
      [gigId],
    );
    const routes: [string, () => Promise<Res>, () => Promise<Res>][] = [
      ['GET gig', () => getGig(other, gigId), () => getGig(other, ghost)],
      ['GET version', () => getVersion(other, gigId, 1), () => getVersion(other, ghost, 1)],
      ['POST versions', () => nextDraft(other, gigId), () => nextDraft(other, ghost)],
      [
        'PUT draft',
        () => saveDraft(other, gigId, completeDraft(draft.revision, { title: 'hijacked' })),
        () => saveDraft(other, ghost, completeDraft(1, { title: 'hijacked' })),
      ],
      ['POST publish', () => publish(other, gigId, draft.revision), () => publish(other, ghost, 1)],
      ['POST retire', () => retire(other, gigId), () => retire(other, ghost)],
    ];
    for (const [label, real, none] of routes) {
      const x = await real();
      const y = await none();
      expect(x.status, `${label}: ${x.raw}`).toBe(404);
      expect(x.body.error.code, label).toMatch(/^GIG_(VERSION_)?NOT_FOUND$/);
      expect(y.status, label).toBe(404);
      expect({ code: x.body.error.code, message: x.body.error.message, details: x.body.error.details }, `${label} cannot reveal existence`).toEqual({
        code: y.body.error.code,
        message: y.body.error.message,
        details: y.body.error.details,
      });
      expect(x.raw).not.toContain(gigId);
    }
    // nothing changed, and the other account's menu is empty
    const after = await q<Json>(
      `SELECT g.status, v.status AS vstatus, v.revision, v.title FROM provider.gigs g JOIN provider.gig_versions v USING (gig_id) WHERE g.gig_id = $1 ORDER BY v.version_number`,
      [gigId],
    );
    expect(after).toEqual(before);
    expect(ok(await menu(other), 200, GigMenuResponse).gigs).toEqual([]);
    // the same idempotency token of ANOTHER account never returns the owner's Gig
    const rid = randomUUID();
    const mine = ok(await createGig(owner, W.tplMain, rid), 201);
    const theirs = ok(await createGig(other, W.tplMain, rid), 201);
    expect(theirs.gig.gigId).not.toBe(mine.gig.gigId);
  });

  it('a customer that is not a provider reads and writes nothing of anyone else either', async () => {
    const owner = await provider('idor-owner2');
    const d = await gigOf(owner);
    const customer = await newActor('idor-customer', { contacts: true });
    gigFail(await getGig(customer, d.gig.gigId), 404, 'GIG_NOT_FOUND');
    gigFail(await saveDraft(customer, d.gig.gigId, completeDraft(1)), 404, 'GIG_NOT_FOUND');
  });
});

// ====================================================================== pricing and duration rules
describe('price and duration follow the exact template version', () => {
  it('a template without duration facts refuses a duration and publishes without one; the price is always permitted and required', async () => {
    const a = await provider('nodur');
    const d = await gigOf(a, W.tplNoPrice);
    expect(d.draftVersion.constraints.price).toMatchObject({ permitted: true, required: true, currency: 'USD' });
    expect(d.draftVersion.constraints.duration).toMatchObject({ permitted: false, required: false });
    const timed = await saveDraft(a, d.gig.gigId, {
      expectedRevision: 1,
      title: 't',
      shortPitch: 's',
      description: 'd',
      priceAmountMinor: 100,
      durationMinutes: 30,
      fieldValues: [],
    });
    expect(hasIssue(gigFail(timed, 400, 'VALIDATION_FAILED'), 'duration', 'DURATION_NOT_PERMITTED')).toBe(true);
    const unpriced = ok(
      await saveDraft(a, d.gig.gigId, {
        expectedRevision: 1,
        title: 't',
        shortPitch: 's',
        description: 'd',
        priceAmountMinor: null,
        durationMinutes: null,
        fieldValues: [],
      }),
    );
    expect(unpriced.draftVersion.publishable).toBe(false);
    expect(hasIssue(gigFail(await publish(a, d.gig.gigId, unpriced.draftVersion.revision), 409, 'PUBLISH_BLOCKED'), 'price', 'PRICE_REQUIRED')).toBe(true);
    const saved = ok(
      await saveDraft(a, d.gig.gigId, {
        expectedRevision: unpriced.draftVersion.revision,
        title: 't',
        shortPitch: 's',
        description: 'd',
        priceAmountMinor: 100,
        durationMinutes: null,
        fieldValues: [],
      }),
    );
    expect(saved.draftVersion.publishable).toBe(true);
    expect(ok(await publish(a, d.gig.gigId, saved.draftVersion.revision)).gig.status).toBe('ACTIVE');
  });

  it('a price of zero saves in a draft but blocks publishing (PRICE_NOT_POSITIVE); the currency is the market currency whatever the client does', async () => {
    const a = await provider('zero');
    const d = await gigOf(a);
    const saved = ok(await saveDraft(a, d.gig.gigId, completeDraft(1, { priceAmountMinor: 0 })));
    expect(saved.draftVersion.price).toEqual({ amountMinor: 0, currency: 'USD' });
    const e = gigFail(await publish(a, d.gig.gigId, saved.draftVersion.revision), 409, 'PUBLISH_BLOCKED');
    expect(hasIssue(e, 'price', 'PRICE_NOT_POSITIVE')).toBe(true);
    const withCurrency = await saveDraft(a, d.gig.gigId, { ...completeDraft(saved.draftVersion.revision), priceCurrency: 'EUR' });
    fail(withCurrency, 400, 'VALIDATION_FAILED');
    const rows = await q<Json>(`SELECT price_currency FROM provider.gig_versions WHERE gig_id = $1`, [d.gig.gigId]);
    expect(rows[0]).toEqual({ price_currency: 'USD' });
  });

  it('a required media field takes photos, never a value (CAT-004): a value is refused with FIELD_MEDIA_NOT_A_VALUE and publishing is blocked with MEDIA_REQUIRED until a photo is attached', async () => {
    const a = await provider('media');
    const d = await gigOf(a, W.tplMedia);
    const media = d.draftVersion.fields.find((f: Json) => f.fieldKey === 'before_photos');
    expect(media).toMatchObject({ supported: true, minItems: 1, maxItems: 6 });
    const attempt = await saveDraft(a, d.gig.gigId, {
      expectedRevision: 1,
      title: 't',
      shortPitch: 's',
      description: 'd',
      priceAmountMinor: 100,
      durationMinutes: 60,
      fieldValues: [{ fieldKey: 'before_photos', value: 'x' }],
    });
    expect(hasIssue(gigFail(attempt, 400, 'VALIDATION_FAILED'), 'field', 'FIELD_MEDIA_NOT_A_VALUE', 'before_photos')).toBe(true);
    const saved = ok(
      await saveDraft(a, d.gig.gigId, {
        expectedRevision: 1,
        title: 't',
        shortPitch: 's',
        description: 'd',
        priceAmountMinor: 100,
        durationMinutes: 60,
        fieldValues: [],
      }),
    );
    expect(saved.draftVersion.publishable).toBe(false);
    const e = gigFail(await publish(a, d.gig.gigId, saved.draftVersion.revision), 409, 'PUBLISH_BLOCKED');
    expect(hasIssue(e, 'media', 'MEDIA_REQUIRED', 'before_photos')).toBe(true);
  });
});

// ====================================================================== the template lifecycle
describe('a Gig keeps the exact template version it was built from', () => {
  it('a newer template version does not migrate a Gig; a retired template blocks publishing and new Gigs but never reading', async () => {
    const cat = await category();
    const st = await serviceType(cat);
    // an isolated template of its own, so retiring it disturbs no other test
    await catalog.setMarketCategoryAvailability(W.m, cat, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
    await catalog.setMarketServiceTypeAvailability(W.m, st, { enabled: true, displayOrder: ++order, reason: REASON }, AUTHOR);
    const tpl = await liveTemplate(st, 'tpl_life', [W.m], mainDefinition());
    const a = await provider('lifecycle', [st]);
    const first = await gigOf(a, tpl);
    const gigId = first.gig.gigId;
    const v1Link = first.draftVersion.template;
    // publish template version 2 (v1 becomes SUPERSEDED)
    await gigTemplates.createGigTemplateVersion(tpl, { reason: REASON }, AUTHOR);
    const v2 = await gigTemplates.replaceGigTemplateDraft(tpl, 2, { ...mainDefinition(), duration: { minMinutes: 10, maxMinutes: 600 } }, AUTHOR);
    await gigTemplates.publishGigTemplateVersion(tpl, 2, { expectedRevision: v2.revision!, reason: REASON }, AUTHOR);
    const after = ok(await getGig(a, gigId));
    expect(after.draftVersion.template).toMatchObject({
      gigTemplateVersionId: v1Link.gigTemplateVersionId,
      gigTemplateVersionNumber: 1,
      versionStatus: 'SUPERSEDED',
    });
    expect(after.draftVersion.constraints.duration).toMatchObject({ minMinutes: 30, maxMinutes: 240 });
    // the Gig can still be completed and published on the version it keeps
    const saved = ok(await saveDraft(a, gigId, completeDraft(after.draftVersion.revision)));
    const published = ok(await publish(a, gigId, saved.draftVersion.revision));
    expect(published.currentVersion.template.gigTemplateVersionNumber).toBe(1);
    // a NEW Gig binds the new version
    const second = await gigOf(a, tpl);
    expect(second.draftVersion.template.gigTemplateVersionNumber).toBe(2);
    // the next draft of the first Gig still binds version 1
    expect(ok(await nextDraft(a, gigId), 201).draftVersion.template.gigTemplateVersionNumber).toBe(1);
    // retire the template: reading works, publishing is blocked, a new Gig is refused
    await gigTemplates.setGigTemplateStatus(tpl, { status: 'RETIRED', reason: REASON }, AUTHOR);
    const read = ok(await getGig(a, gigId));
    expect(read.draftVersion.template.templateStatus).toBe('RETIRED');
    expect(ok(await getVersion(a, gigId, 1), 200, GigVersionResponse).status).toBe('PUBLISHED');
    const draft = read.draftVersion;
    const blocked = await publish(a, gigId, draft.revision);
    expect(blocked.status, blocked.raw).toBe(409);
    expect(blocked.body.error.code).toMatch(/^(GIG_PUBLISH_BLOCKED|GIG_TEMPLATE_NOT_AVAILABLE)$/);
    const fresh = await createGig(a, tpl);
    expect([404, 409]).toContain(fresh.status);
    expect(fresh.body.error.code).toMatch(/^(GIG_TEMPLATE_NOT_AVAILABLE|GIG_TEMPLATE_NOT_FOUND)$/);
    // the published version and the history are untouched, and the Gig can still be retired
    expect(ok(await retire(a, gigId)).gig.status).toBe('RETIRED');
  });
});

// ====================================================================== configured limits
describe('the configured limits', () => {
  it('provider.gig.max_drafts caps the draft versions of the account; freeing a draft frees room; the cap is read from configuration', async () => {
    const a = await provider('draftcap');
    await setConfig(G.maxDrafts, 2);
    try {
      const g1 = await gigOf(a);
      await gigOf(a);
      const e = gigFail(await createGig(a, W.tplMain), 409, 'LIMIT_REACHED');
      expect(e.details.limit ?? e.details.max).toBe(2);
      const m = ok(await menu(a), 200, GigMenuResponse);
      expect(m.limits).toMatchObject({ maxDrafts: 2, draftCount: 2 });
      expect(m).toMatchObject({ canCreate: false, cannotCreateReason: 'DRAFT_LIMIT_REACHED' });
      // retiring a Gig frees its draft
      ok(await retire(a, g1.gig.gigId));
      expect(ok(await createGig(a, W.tplMain), 201).gig.status).toBe('DRAFT');
    } finally {
      await resetPolicy([G.maxDrafts]);
    }
  });

  it('provider.gig.max_active caps the ACTIVE Gigs at the first publish only', async () => {
    const a = await provider('activecap');
    await setConfig(G.maxActive, 1);
    try {
      const first = await publishedGig(a);
      const second = await gigOf(a);
      const saved = ok(await saveDraft(a, second.gig.gigId, completeDraft(second.draftVersion.revision)));
      gigFail(await publish(a, second.gig.gigId, saved.draftVersion.revision), 409, 'LIMIT_REACHED');
      // a new VERSION of the published Gig is not a new active Gig
      const next = ok(await nextDraft(a, first.gig.gigId), 201).draftVersion;
      const savedNext = ok(await saveDraft(a, first.gig.gigId, completeDraft(next.revision, { title: `${TITLE} next` })));
      expect(ok(await publish(a, first.gig.gigId, savedNext.draftVersion.revision)).currentVersion.versionNumber).toBe(2);
    } finally {
      await resetPolicy([G.maxActive]);
    }
  });

  it('the configured text lengths apply (title max length read from configuration)', async () => {
    const a = await provider('titlecap');
    const d = await gigOf(a);
    await setConfig(G.titleMaxLength, 10);
    try {
      const long = await saveDraft(a, d.gig.gigId, completeDraft(1, { title: 'x'.repeat(11) }));
      expect(hasIssue(gigFail(long, 400, 'VALIDATION_FAILED'), 'title', 'TITLE_TOO_LONG')).toBe(true);
      expect(ok(await saveDraft(a, d.gig.gigId, completeDraft(1, { title: 'x'.repeat(10) }))).draftVersion.constraints.title.maxLength).toBe(10);
    } finally {
      await resetPolicy([G.titleMaxLength]);
    }
  });
});

// ====================================================================== races
describe('concurrency', () => {
  it('two simultaneous creates with one client request id produce ONE Gig (one 201, one 200)', async () => {
    const a = await provider('race-create');
    const rid = randomUUID();
    const rs = await Promise.all([createGig(a, W.tplMain, rid), createGig(a, W.tplMain, rid)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(new Set(rs.map((r) => r.body.data.gig.gigId)).size).toBe(1);
    expect(await q(`SELECT 1 FROM provider.gigs WHERE account_id = $1`, [a.accountId])).toHaveLength(1);
  });

  it('two simultaneous publishes of the same revision: exactly one succeeds and exactly one version is PUBLISHED', async () => {
    const a = await provider('race-publish');
    const d = await gigOf(a);
    const saved = ok(await saveDraft(a, d.gig.gigId, completeDraft(1)));
    const rs = await Promise.all([publish(a, d.gig.gigId, saved.draftVersion.revision), publish(a, d.gig.gigId, saved.draftVersion.revision)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await q(`SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status = 'PUBLISHED'`, [d.gig.gigId])).toHaveLength(1);
  });

  it('two simultaneous saves of the same revision: one wins, the other is a stale draft', async () => {
    const a = await provider('race-save');
    const d = await gigOf(a);
    const rs = await Promise.all([
      saveDraft(a, d.gig.gigId, completeDraft(1, { title: 'first' })),
      saveDraft(a, d.gig.gigId, completeDraft(1, { title: 'second' })),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('GIG_STALE_DRAFT');
  });

  it('two simultaneous next-draft requests create one draft', async () => {
    const a = await provider('race-next');
    const d = await publishedGig(a);
    const rs = await Promise.all([nextDraft(a, d.gig.gigId), nextDraft(a, d.gig.gigId)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await q(`SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status = 'DRAFT'`, [d.gig.gigId])).toHaveLength(1);
  });

  it('retire racing a publish ends in a consistent state: either a PUBLISHED version of an ACTIVE Gig or a RETIRED Gig with no live version', async () => {
    const a = await provider('race-retire');
    const d = await gigOf(a);
    const saved = ok(await saveDraft(a, d.gig.gigId, completeDraft(1)));
    await Promise.all([publish(a, d.gig.gigId, saved.draftVersion.revision), retire(a, d.gig.gigId)]);
    const g = (await q<Json>(`SELECT status FROM provider.gigs WHERE gig_id = $1`, [d.gig.gigId]))[0]!;
    const live = await q(`SELECT 1 FROM provider.gig_versions WHERE gig_id = $1 AND status IN ('PUBLISHED','DRAFT')`, [d.gig.gigId]);
    if (g.status === 'RETIRED') expect(live).toHaveLength(0);
    else expect(g.status).toBe('ACTIVE');
  });
});

// ====================================================================== headers, bodies and the GigMenu budget
describe('the HTTP edge on the real stack', () => {
  it('rejects unauthenticated calls and the admin context on every route, and no response is cacheable', async () => {
    const a = await provider('edge');
    const d = await gigOf(a);
    const calls: [string, string, unknown?][] = [
      ['GET', '/gig-templates'],
      ['GET', '/gigs'],
      ['POST', '/gigs', { gigTemplateCode: W.tplMain }],
      ['GET', `/gigs/${d.gig.gigId}`],
      ['POST', `/gigs/${d.gig.gigId}/versions`],
      ['GET', `/gigs/${d.gig.gigId}/versions/1`],
      ['PUT', `/gigs/${d.gig.gigId}/draft`, completeDraft(1)],
      ['POST', `/gigs/${d.gig.gigId}/publish`, { expectedRevision: 1 }],
      ['POST', `/gigs/${d.gig.gigId}/retire`, {}],
    ];
    const admin = await signToken(keys, {
      claims: {
        sub: 'admin-a',
        azp: 'bananagig-admin',
        realm_access: { roles: [] },
        resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
      },
    });
    for (const [method, url, body] of calls) {
      const anon = await call(method as never, url, { body });
      fail(anon, 401, 'AUTHENTICATION_REQUIRED');
      const adm = await call(method as never, url, { as: admin, body });
      fail(adm, 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    }
    expect(await q(`SELECT 1 FROM provider.gigs WHERE account_id = $1`, [a.accountId])).toHaveLength(1);
  });

  it('refuses client-supplied owners, versions, statuses and currencies, and strict-typed values are NOT coerced (3 stays an integer, true a boolean, null clears)', async () => {
    const a = await provider('strict');
    const d = await gigOf(a);
    fail(await call('POST', '/gigs', { as: a, body: { gigTemplateCode: W.tplMain, accountId: randomUUID() } }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', '/gigs', { as: a, body: { gigTemplateCode: W.tplMain, gigTemplateVersionId: randomUUID() } }), 400, 'VALIDATION_FAILED');
    fail(await call('PUT', `/gigs/${d.gig.gigId}/draft`, { as: a, body: { ...completeDraft(1), status: 'PUBLISHED' } }), 400, 'VALIDATION_FAILED');
    fail(await call('PUT', `/gigs/${d.gig.gigId}/draft`, { as: a, body: { ...completeDraft(1), expectedRevision: '1' } }), 400, 'VALIDATION_FAILED');
    fail(await call('GET', `/gigs/${d.gig.gigId}/versions/1e0`, { as: a }), 400, 'VALIDATION_FAILED');
    fail(await call('GET', `/gigs/not-a-uuid`, { as: a }), 400, 'VALIDATION_FAILED');
    const saved = ok(await saveDraft(a, d.gig.gigId, completeDraft(1)));
    const values = Object.fromEntries(saved.draftVersion.fieldValues.map((f: Json) => [f.fieldKey, f.value]));
    expect(values.rooms).toBe(3);
    expect(values.pets).toBe(true);
    const cleared = ok(
      await saveDraft(a, d.gig.gigId, { ...completeDraft(saved.draftVersion.revision), title: null, fieldValues: [{ fieldKey: 'notes', value: null }] }),
    );
    expect(cleared.draftVersion.title).toBeNull();
    expect(cleared.draftVersion.fieldValues).toEqual([]);
  });

  it('the GigMenu reads in a constant number of statements however many Gigs the account has', async () => {
    const a = await provider('budget');
    await publishedGig(a);
    const measure = async (): Promise<number> => {
      capture = [];
      const r = await menu(a);
      const n = capture.length;
      capture = null;
      expect(r.status, r.raw).toBe(200);
      return n;
    };
    await measure(); // warm-up (caches, the account row)
    const one = await measure();
    for (let i = 0; i < 4; i++) await gigOf(a);
    await publishedGig(a);
    const six = await measure();
    expect(ok(await menu(a), 200, GigMenuResponse).gigs).toHaveLength(6);
    expect(six).toBe(one);
  });
});

// ====================================================================== secrecy
describe('provider text reaches only the owner, in successful Gig responses', () => {
  it('no error response, log line, audit row or event carries any text a provider typed', async () => {
    for (const t of transcript.filter((x) => x.status >= 400)) {
      expect(t.raw, `${t.method} ${t.url}`).not.toContain(TEXT_MARK);
      expect(t.raw, `${t.method} ${t.url}`).not.toContain('Sentinel');
    }
    // every Gig response is no-store, errors included
    for (const t of transcript.filter((x) => x.url.startsWith(`${P}/gig`))) expect(t.headers['cache-control'], `${t.method} ${t.url}`).toBe('no-store');
    for (const line of logLines) expect(line).not.toContain(TEXT_MARK);
    const audit = JSON.stringify(await q(`SELECT changes FROM provider.gig_audit_events`));
    const outbox = JSON.stringify(await q(`SELECT payload_json FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'`));
    expect(audit).not.toContain(TEXT_MARK);
    expect(outbox).not.toContain(TEXT_MARK);
    // provider text appears only in 2xx responses of Gig routes
    for (const t of transcript.filter((x) => x.status < 400 && x.raw.includes(TEXT_MARK)))
      expect(t.url, `${t.method} ${t.url}`).toMatch(new RegExp(`^${P}/gigs`));
    // the Gig responses never carry internal ids of other tables
    const textEvents = await q<Json>(`SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.gig-%'`);
    expect(textEvents[0]!.n).toBeGreaterThan(0);
  });
});
