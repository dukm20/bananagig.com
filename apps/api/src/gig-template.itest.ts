// CAT-002 end to end, written by an independent author: the REAL Gig Template API (routes, auth, strict validation), the REAL GigTemplateService and CatalogService, GeographyService
// (the market gate), ContentService (names, labels, help, defaults) and PostgreSQL (an isolated, migrated database), wired as apps/api/src/index.ts wires them. Tokens are signed test
// tokens verified by the real verifier. Every scenario builds its own markets and codes (devtest_*), so the order of the tests does not matter; only the lifecycle test is one long story.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { MemoryConfigCache } from '@bananagig/configuration';
import {
  GIG_TEMPLATE_EVENTS,
  categoryDescriptionKey,
  categoryNameKey,
  gigTemplateDescriptionKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldHelpKey,
  gigTemplateFieldLabelKey,
  gigTemplateInstructionsKey,
  gigTemplateNameKey,
  gigTemplateOptionLabelKey,
  serviceTypeNameKey,
} from '@bananagig/contracts';
import { CatalogService, GigTemplateService } from '@bananagig/catalog';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
let geography: GeographyService;
let content: ContentService;
let catalog: CatalogService;
let gigTemplates: GigTemplateService;
let cache: MemoryConfigCache;
let staff: string; // catalog-read + catalog-write, subject staff-a
let reader: string; // catalog-read only, subject reader-r
let writer: string; // catalog-write only, subject writer-w
let customer: string;
let norole: string; // admin context without a catalog role
let contentStaff: string;
const A = 'author-a';
const B = 'approver-b';
let seq = 0;

const adminToken = (sub: string, roles: string[]) =>
  signToken(keys, {
    claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } } },
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  status: number;
  body: Json;
  raw: string;
  headers: Record<string, unknown>;
}
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const api = async (method: Method, url: string, t?: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
  const r = await app.inject({
    method,
    url: `/api/v1/catalog${url}`,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as Json, raw: r.body, headers: r.headers };
};
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const keysOf = (o: object) => Object.keys(o).sort();
const REASON = 'integration test';
const code = (prefix: string) => `devtest_${prefix}${++seq}`;
const cids = (n: string) => ({ 'x-correlation-id': `gt-itest-${n}-${++seq}` });
const cidOf = (h: Record<string, string>) => h['x-correlation-id']!;
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n);
const codesOf = (r: Res): string[] => r.body.data.map((x: { code: string }) => x.code);

// ---------------------------------------------------------------- content helpers (the real workflow, the way the other itests do it)
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: 'UI_LABEL',
  ownerRole: 'CONTENT',
  description: 'neutral Gig Template test entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});
async function publishText(key: string, locale: string, body: string): Promise<void> {
  const v = await content.createVersion(key, { locale, scopeType: 'PLATFORM', scopeRef: null, body, reason: REASON }, A);
  const submitted = await content.submit(v.versionId, A);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
  await content.publish(v.versionId, A);
}
/** the content type of a key: names and labels are UI labels, everything else is plain text */
const typeOf = (key: string): CreateEntryInput['contentType'] => (/\.(name|label)$/.test(key) ? 'UI_LABEL' : 'PLAIN_TEXT');
/** Creates the entry and (unless `text` is false) publishes the English text; `es` adds Spanish. */
async function copy(key: string, text: string | false, es?: string, over: Partial<CreateEntryInput> = {}): Promise<void> {
  await content.createEntry(entryReq(key, { contentType: typeOf(key), ...over }), A);
  if (text !== false) await publishText(key, 'en-US', text);
  if (es) await publishText(key, 'es-US', es);
}
const textOfKey = (key: string): string => `Copy of ${key.replace(/^catalog\.gig_template\./, '')}`;

// ---------------------------------------------------------------- domain helpers (through the HTTP API, as an administrator does)
async function market(name: string, state: 'PLANNED' | 'ACTIVE' | 'INACTIVE', defaultLocale = 'en-US'): Promise<string> {
  const c = `devtest-gt-${name}`;
  await geography.createMarket(
    { code: c, name: 'Gig Template Test Market', countryCode: 'US', defaultLocale, currencyCode: 'USD', defaultTimeZone: 'America/Denver', reason: REASON },
    A,
  );
  if (state !== 'PLANNED') await geography.setMarketActive(c, true, 'activate for test', A);
  if (state === 'INACTIVE') await geography.setMarketActive(c, false, 'retire for test', A);
  return c;
}
const setAvail = (m: string, kind: 'categories' | 'service-types', c: string, enabled: boolean, displayOrder?: number) =>
  api('PUT', `/markets/${m}/${kind}/${c}`, staff, { enabled, ...(displayOrder === undefined ? {} : { displayOrder }), reason: REASON });
const setStatus = (kind: 'categories' | 'service-types' | 'gig-templates', c: string, status: string, headers: Record<string, string> = {}) =>
  api('PUT', `/${kind}/${c}/status`, staff, { status, reason: REASON }, headers);
interface World {
  m: string;
  cat: string;
  st: string;
}
/** A public market with an ACTIVE category and ACTIVE service type, both enabled in it. */
async function world(name: string, defaultLocale = 'en-US', state: 'PLANNED' | 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<World> {
  const m = await market(name, state, defaultLocale);
  const cat = code('gc');
  await copy(categoryNameKey(cat), `Category ${cat}`, `Categoria ${cat}`);
  await copy(categoryDescriptionKey(cat), `About ${cat}`);
  expect((await api('POST', '/categories', staff, { code: cat, withDescription: true, reason: REASON })).status).toBe(201);
  expect((await setStatus('categories', cat, 'ACTIVE')).status).toBe(200);
  expect((await setAvail(m, 'categories', cat, true, 10)).status).toBe(200);
  const st = code('gs');
  await copy(serviceTypeNameKey(st), `Service ${st}`, `Servicio ${st}`);
  expect((await api('POST', '/service-types', staff, { code: st, categoryCode: cat, reason: REASON })).status).toBe(201);
  expect((await setStatus('service-types', st, 'ACTIVE')).status).toBe(200);
  expect((await setAvail(m, 'service-types', st, true, 10)).status).toBe(200);
  return { m, cat, st };
}

const field = (fieldKey: string, fieldType: string, behavior: string, over: Record<string, unknown> = {}) => ({ fieldKey, fieldType, behavior, ...over });
/** A definition with every kind of structure: a fixed text, an enum with a default, numbers, a duration, three kinds of media, a reference. */
const definition = (over: Record<string, unknown> = {}) => ({
  expectedRevision: 1,
  duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 240 },
  pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
  areaModes: ['RADIUS', 'POSTAL_CODES'],
  fields: [
    field('scope_notes', 'LONG_TEXT', 'PLATFORM_FIXED', { section: 'SCOPE', withHelp: true, withDefaultText: true, minLength: 10, maxLength: 500 }),
    field('wax_type', 'ENUM', 'PROVIDER_CONFIGURABLE', {
      section: 'INCLUSIONS',
      withHelp: true,
      options: [{ optionCode: 'carnauba', isDefault: true }, { optionCode: 'synthetic' }],
    }),
    field('vehicle_count', 'INTEGER', 'PROVIDER_REQUIRED', { minNumber: 1, maxNumber: 4, defaultNumber: 1 }),
    field('detail_minutes', 'DURATION', 'PROVIDER_CONFIGURABLE', { minNumber: 30, maxNumber: 480, defaultNumber: 120 }),
    field('before_photos', 'MEDIA', 'PROVIDER_REQUIRED', { minItems: 1, maxItems: 6 }),
    field('interior_photos', 'MEDIA', 'PROVIDER_CONFIGURABLE', { minItems: 0, maxItems: 0, customerVisible: false }),
    field('skills', 'SKILL_REFERENCE', 'PROVIDER_REQUIRED', { minItems: 1 }),
  ],
  requirements: [{ requirementType: 'LICENSE' }, { requirementType: 'SKILL', referenceCode: 'detailing_basic' }],
  reason: REASON,
  ...over,
});
type Def = ReturnType<typeof definition>;
/** every content key a definition references (the reference implementation of the derivation, written from the contract helpers) */
const copyKeys = (
  c: string,
  def: { fields: { fieldKey: string; withHelp?: boolean; withDefaultText?: boolean; options?: { optionCode: string }[] }[] },
): string[] =>
  def.fields.flatMap((f) => [
    gigTemplateFieldLabelKey(c, f.fieldKey),
    ...(f.withHelp ? [gigTemplateFieldHelpKey(c, f.fieldKey)] : []),
    ...(f.withDefaultText ? [gigTemplateFieldDefaultKey(c, f.fieldKey)] : []),
    ...(f.options ?? []).map((o) => gigTemplateOptionLabelKey(c, f.fieldKey, o.optionCode)),
  ]);
/** creates the entries of a definition's keys; `noText` keeps the entry but publishes nothing; `es` also publishes Spanish for those keys */
async function defCopy(c: string, def: Parameters<typeof copyKeys>[1], o: { noText?: string[]; es?: string[]; skip?: string[] } = {}): Promise<string[]> {
  const ks = copyKeys(c, def);
  for (const k of ks) {
    if (o.skip?.includes(k)) continue;
    await copy(k, o.noText?.includes(k) ? false : textOfKey(k), o.es?.includes(k) ? `ES ${textOfKey(k)}` : undefined);
  }
  return ks;
}
/** a template with name, description and instructions copy (published) created through the API */
async function template(
  w: World,
  prefix: string,
  o: { description?: boolean; instructions?: boolean; headers?: Record<string, string> } = {},
): Promise<string> {
  const c = code(prefix);
  await copy(gigTemplateNameKey(c), `Name ${c}`, `Nombre ${c}`);
  if (o.description !== false) await copy(gigTemplateDescriptionKey(c), `About ${c}`, `Sobre ${c}`);
  if (o.instructions !== false) await copy(gigTemplateInstructionsKey(c), `Instructions ${c}`);
  const r = await api(
    'POST',
    '/gig-templates',
    staff,
    { code: c, serviceTypeCode: w.st, withDescription: o.description !== false, withInstructions: o.instructions !== false, reason: REASON },
    o.headers,
  );
  expect(r.status, r.raw).toBe(201);
  return c;
}
const createDraft = async (c: string, body: Record<string, unknown> = {}) => api('POST', `/gig-templates/${c}/versions`, staff, { reason: REASON, ...body });
const replace = (c: string, n: number, def: object, h: Record<string, string> = {}) => api('PUT', `/gig-templates/${c}/versions/${n}`, staff, def, h);
const publish = (c: string, n: number, expectedRevision: number, h: Record<string, string> = {}) =>
  api('POST', `/gig-templates/${c}/versions/${n}/publish`, staff, { expectedRevision, reason: REASON }, h);
const enable = (m: string, c: string, enabled: boolean, displayOrder?: number, h: Record<string, string> = {}) =>
  api('PUT', `/markets/${m}/gig-templates/${c}`, staff, { enabled, ...(displayOrder === undefined ? {} : { displayOrder }), reason: REASON }, h);
const pub = (m: string, path = '/gig-templates', extra = '') => api('GET', `${path}${path.includes('?') ? '&' : '?'}market=${m}${extra}`);
/** a fully published, ACTIVE, enabled template with one ACTIVE version (v1) */
async function liveTemplate(w: World, prefix: string, order: number, def: Def = definition()): Promise<string> {
  const c = await template(w, prefix);
  await defCopy(c, def);
  expect((await createDraft(c)).status).toBe(201);
  const r = await replace(c, 1, def);
  expect(r.status, r.raw).toBe(200);
  expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
  const p = await publish(c, 1, r.body.data.revision);
  expect(p.status, p.raw).toBe(200);
  const e = await enable(w.m, c, true, order);
  expect(e.status, e.raw).toBe(200);
  return c;
}

const auditOf = (cid: string) =>
  q<{
    action: string;
    actor: string;
    changes: Json;
    reason: string;
    gig_template_id: string | null;
    gig_template_version_id: string | null;
    market_id: string | null;
    category_id: string | null;
    service_type_id: string | null;
  }>(
    'SELECT action, actor, changes, reason, gig_template_id, gig_template_version_id, market_id, category_id, service_type_id FROM catalog.audit_events WHERE correlation_id = $1 ORDER BY occurred_at, audit_event_id',
    [cid],
  );
const outboxOf = (cid: string) =>
  q<{ event_type: string; aggregate_type: string; aggregate_id: string; actor_type: string; actor_id: string; payload_json: Json }>(
    'SELECT event_type, aggregate_type, aggregate_id::text, actor_type, actor_id, payload_json FROM integration.outbox_events WHERE correlation_id = $1 ORDER BY created_at, outbox_event_id',
    [cid],
  );
const stateOf = async (): Promise<number[]> => {
  const out: number[] = [];
  for (const t of [
    'catalog.gig_templates',
    'catalog.gig_template_versions',
    'catalog.gig_template_fields',
    'catalog.gig_template_field_options',
    'catalog.gig_template_requirements',
    'catalog.market_gig_templates',
    'catalog.audit_events',
    'integration.outbox_events',
  ])
    out.push(await count(t));
  return out;
};
const pubDetailVersion = (r: Res): number | undefined => (r.body.data.activeVersion ? r.body.data.activeVersion.versionNumber : undefined);
const versionRows = (c: string) =>
  q<{ version_number: number; status: string; revision: number; published_at: Date | null; closed_at: Date | null; gig_template_version_id: string }>(
    `SELECT v.version_number, v.status, v.revision, v.published_at, v.closed_at, v.gig_template_version_id FROM catalog.gig_template_versions v
       JOIN catalog.gig_templates t USING (gig_template_id) WHERE t.code = $1 ORDER BY v.version_number`,
    [c],
  );

const PUBLIC_LIST_KEYS = ['activeVersion', 'categoryCode', 'code', 'description', 'displayOrder', 'gigTemplateId', 'name', 'serviceTypeCode'];
const PUBLIC_DETAIL_KEYS = [...PUBLIC_LIST_KEYS, 'instructions'].sort();
const PUBLIC_SUMMARY_KEYS = ['areaModes', 'duration', 'fieldCount', 'gigTemplateVersionId', 'pricingModels', 'versionNumber'];
const PUBLIC_VERSION_KEYS = [...PUBLIC_SUMMARY_KEYS, 'fields', 'requirements'].sort();
const MGMT_SUMMARY_KEYS = [...PUBLIC_SUMMARY_KEYS, 'closedAt', 'createdAt', 'publishedAt', 'revision', 'status'].sort();
const MGMT_VERSION_KEYS = [...MGMT_SUMMARY_KEYS, 'fields', 'requirements'].sort();
const PUBLIC_FIELD_KEYS = [
  'behavior',
  'customerVisible',
  'defaultBoolean',
  'defaultNumber',
  'defaultText',
  'displayOrder',
  'fieldKey',
  'fieldType',
  'help',
  'label',
  'maxItems',
  'maxLength',
  'maxNumber',
  'mediaRule',
  'minItems',
  'minLength',
  'minNumber',
  'options',
  'section',
];
const MGMT_FIELD_KEYS = [...PUBLIC_FIELD_KEYS, 'defaultContentKey', 'helpContentKey', 'labelContentKey'].sort();

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  geography = new GeographyService({ database: iso.database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  content = new ContentService({
    database: iso.database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography, { ttlMs: 60_000 }),
  });
  cache = new MemoryConfigCache();
  const deps = { database: iso.database, markets: createMarketGate(geography), cache, env: 'test', allowTestKeys: true };
  catalog = new CatalogService(deps);
  gigTemplates = new GigTemplateService(deps);
  app = await buildApp({ cfg, verifier, configuration: {} as never, content, geography, catalog, gigTemplates, readiness: async () => ({}) });
  await app.ready();
  await content.registerLocale({ locale: 'es-US', active: true, reason: REASON }, A);
  await geography.updateCountry('US', { supportedLocales: ['en-US', 'es-US'], reason: 'Spanish support for the tests' }, A);
  staff = await adminToken('staff-a', ['catalog-read', 'catalog-write']);
  reader = await adminToken('reader-r', ['catalog-read']);
  writer = await adminToken('writer-w', ['catalog-write']);
  norole = await adminToken('norole-n', ['admin-console-access']);
  contentStaff = await adminToken('content-c', ['content-read', 'content-write', 'geography-read', 'geography-write', 'configuration-write']);
  customer = await signToken(keys, { claims: { sub: 'customer-c', azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
});
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== the seed and the guards at the door
describe('the seeded templates and access control (real token verification)', () => {
  it('ships two DRAFT templates without versions and with published copy: nothing is public, the management view shows them with resolved text and the content keys', async () => {
    const list = await api('GET', '/gig-templates', reader);
    expect(list.status).toBe(200);
    const seeded = list.body.data.filter((t: { code: string }) => ['full_detail', 'standard_clean'].includes(t.code));
    expect(seeded.map((t: Json) => [t.code, t.status, t.name, t.serviceTypeCode, t.categoryCode, t.activeVersion])).toEqual([
      ['full_detail', 'DRAFT', 'Full Detail', 'car_detailing', 'auto_services', null],
      ['standard_clean', 'DRAFT', 'Standard Clean', 'regular_cleaning', 'home_cleaning', null],
    ]);
    expect(seeded[0]).toMatchObject({
      nameContentKey: 'catalog.gig_template.full_detail.name',
      descriptionContentKey: 'catalog.gig_template.full_detail.description',
      instructionsContentKey: 'catalog.gig_template.full_detail.instructions',
      description: 'A complete interior and exterior detail of one vehicle.',
      displayOrder: null,
    });
    const detail = await api('GET', '/gig-templates/full_detail', reader);
    expect(detail.body.data.versions).toEqual([]);
    expect(detail.body.data.instructions).toMatch(/Describe what your detail includes/);
    expect(await count('catalog.gig_template_versions')).toBe(0);
    expect(await count('catalog.market_gig_templates')).toBe(0);
    expect(await count('catalog.audit_events')).toBe(8);
    expect((await q("SELECT 1 FROM catalog.audit_events WHERE action = 'GIG_TEMPLATE_CREATED' AND gig_template_id IS NOT NULL")).length).toBe(2);
    for (const m of ['us-sf', 'la-oc', 'devtest-nothing']) {
      for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) {
        const r = await pub(m, u);
        expect([r.status, r.body.error.code], `${m} ${u}`).toEqual([404, 'CATALOG_MARKET_NOT_FOUND']);
      }
    }
    // the version read of a template without versions
    const nv = await api('GET', '/gig-templates/full_detail/versions/1', reader);
    expect([nv.status, nv.body.error.code]).toEqual([404, 'CATALOG_GIG_TEMPLATE_VERSION_NOT_FOUND']);
    const nt = await api('GET', '/gig-templates/nope_tpl/versions/1', reader);
    expect([nt.status, nt.body.error.code]).toEqual([404, 'CATALOG_GIG_TEMPLATE_NOT_FOUND']);
  });

  it('401 without or with a bad token, 403 for a customer, an admin without a catalog role, a read-only admin and foreign registry roles; the database is untouched', async () => {
    const before = await stateOf();
    const rq = { reason: REASON };
    const calls: [Method, string, unknown][] = [
      ['POST', '/gig-templates', { code: code('denied'), serviceTypeCode: 'car_detailing', ...rq }],
      ['PATCH', '/gig-templates/full_detail', { withDescription: true, ...rq }],
      ['PUT', '/gig-templates/full_detail/status', { status: 'ACTIVE', ...rq }],
      ['POST', '/gig-templates/full_detail/versions', rq],
      ['PUT', '/gig-templates/full_detail/versions/1', definition()],
      ['POST', '/gig-templates/full_detail/versions/1/publish', { expectedRevision: 1, ...rq }],
      ['PUT', '/gig-templates/full_detail/versions/1/status', { status: 'RETIRED', ...rq }],
      ['PUT', '/markets/la-oc/gig-templates/full_detail', { enabled: true, displayOrder: 1, ...rq }],
    ];
    for (const [t, expected] of [
      [undefined, 401],
      ['not.a.token', 401],
      [customer, 403],
      [norole, 403],
      [reader, 403],
      [contentStaff, 403],
    ] as const)
      for (const [m, u, b] of calls) expect((await api(m, u, t, b)).status, `${m} ${u} ${t === undefined ? 'anon' : ''}`).toBe(expected);
    for (const t of [customer, norole, contentStaff]) expect((await api('GET', '/gig-templates/full_detail/versions/1', t)).status).toBe(403);
    expect((await api('GET', '/gig-templates/full_detail/versions/1')).status).toBe(401);
    // 401 / 403 win over a malformed version
    expect((await api('GET', '/gig-templates/full_detail/versions/01')).status).toBe(401);
    expect((await api('GET', '/gig-templates/full_detail/versions/01', customer)).status).toBe(403);
    expect((await api('PUT', '/gig-templates/full_detail/versions/1e0', reader, definition())).status).toBe(403);
    // the writer-only token may read the management view; the others see the public view and need the market
    expect((await api('GET', '/gig-templates', writer)).status).toBe(200);
    expect((await api('GET', '/gig-templates/full_detail/versions/9', writer)).status).toBe(404);
    for (const t of [customer, norole, contentStaff]) expect((await api('GET', '/gig-templates', t)).status).toBe(400);
    expect(await stateOf()).toEqual(before);
  });
});

// ====================================================================== refused requests write nothing
describe('a refused request writes NOTHING (the whole state is compared)', () => {
  it('coerced bodies, malformed version numbers, stale revisions, unknown templates and versions, wrong states: 4xx and an unchanged database', async () => {
    const w = await world('refuse');
    const c = await template(w, 'ref');
    const def = definition();
    await defCopy(c, def);
    expect((await createDraft(c)).status).toBe(201);
    const before = await stateOf();
    const bad: [string, Method, string, unknown, number][] = [
      ['create: extra key', 'POST', '/gig-templates', { code: code('x'), serviceTypeCode: w.st, reason: REASON, price: 5 }, 400],
      ['create: unknown service type', 'POST', '/gig-templates', { code: code('x'), serviceTypeCode: 'nope_st', reason: REASON }, 404],
      ['create: name copy missing', 'POST', '/gig-templates', { code: code('noname'), serviceTypeCode: w.st, reason: REASON }, 400],
      ['create: description copy missing', 'POST', '/gig-templates', { code: c + 'z', serviceTypeCode: w.st, withDescription: true, reason: REASON }, 400],
      ['create: coerced flag', 'POST', '/gig-templates', { code: code('x'), serviceTypeCode: w.st, withDescription: 'true', reason: REASON }, 400],
      ['update: nothing to change', 'PATCH', `/gig-templates/${c}`, { reason: REASON }, 400],
      ['update: unknown template', 'PATCH', '/gig-templates/nope_tpl', { withDescription: false, reason: REASON }, 404],
      ['status: DRAFT is no target', 'PUT', `/gig-templates/${c}/status`, { status: 'DRAFT', reason: REASON }, 400],
      ['status: unknown template', 'PUT', '/gig-templates/nope_tpl/status', { status: 'ACTIVE', reason: REASON }, 404],
      ['version: second draft', 'POST', `/gig-templates/${c}/versions`, { reason: REASON }, 409],
      ['version: copy of a missing version', 'POST', `/gig-templates/${c}/versions`, { copyFromVersion: 7, reason: REASON }, 404],
      ['version: unknown template', 'POST', '/gig-templates/nope_tpl/versions', { reason: REASON }, 404],
      ['replace: stale revision', 'PUT', `/gig-templates/${c}/versions/1`, { ...def, expectedRevision: 9 }, 409],
      ['replace: unknown version', 'PUT', `/gig-templates/${c}/versions/2`, def, 404],
      ['replace: unknown template', 'PUT', '/gig-templates/nope_tpl/versions/1', def, 404],
      ['replace: coerced revision', 'PUT', `/gig-templates/${c}/versions/1`, { ...def, expectedRevision: '1' }, 400],
      ['replace: provider field', 'PUT', `/gig-templates/${c}/versions/1`, { ...def, price: 100 }, 400],
      ['replace: missing copy', 'PUT', `/gig-templates/${c}/versions/1`, { ...def, fields: [field('no_copy_here', 'BOOLEAN', 'PROVIDER_REQUIRED')] }, 400],
      ['replace: version 01', 'PUT', `/gig-templates/${c}/versions/01`, def, 400],
      ['replace: version 1e0', 'PUT', `/gig-templates/${c}/versions/1e0`, def, 400],
      ['replace: version 2147483648', 'PUT', `/gig-templates/${c}/versions/2147483648`, def, 400],
      ['publish: template is DRAFT', 'POST', `/gig-templates/${c}/versions/1/publish`, { expectedRevision: 1, reason: REASON }, 409],
      ['publish: unknown version', 'POST', `/gig-templates/${c}/versions/5/publish`, { expectedRevision: 1, reason: REASON }, 404],
      ['publish: version 0', 'POST', `/gig-templates/${c}/versions/0/publish`, { expectedRevision: 1, reason: REASON }, 400],
      ['publish: coerced revision', 'POST', `/gig-templates/${c}/versions/1/publish`, { expectedRevision: 1.5, reason: REASON }, 400],
      ['discard: status ACTIVE', 'PUT', `/gig-templates/${c}/versions/1/status`, { status: 'ACTIVE', reason: REASON }, 400],
      ['discard: unknown version', 'PUT', `/gig-templates/${c}/versions/4/status`, { status: 'RETIRED', reason: REASON }, 404],
      ['availability: order missing for a new row', 'PUT', `/markets/${w.m}/gig-templates/${c}`, { enabled: true, reason: REASON }, 400],
      ['availability: order out of range', 'PUT', `/markets/${w.m}/gig-templates/${c}`, { enabled: true, displayOrder: 10000, reason: REASON }, 400],
      ['availability: unknown market', 'PUT', `/markets/nowhere/gig-templates/${c}`, { enabled: true, displayOrder: 1, reason: REASON }, 404],
      ['availability: unknown template', 'PUT', `/markets/${w.m}/gig-templates/nope_tpl`, { enabled: true, displayOrder: 1, reason: REASON }, 404],
    ];
    for (const [name, m, u, b, status] of bad) {
      const r = await api(m, u, staff, b);
      expect(r.status, `${name}: ${r.raw}`).toBe(status);
      expect(r.body.error.correlationId).toEqual(expect.any(String));
    }
    expect(await stateOf()).toEqual(before);
    // the draft is exactly as it was
    const v = await api('GET', `/gig-templates/${c}/versions/1`, reader);
    expect(v.body.data).toMatchObject({ status: 'DRAFT', revision: 1, fieldCount: 0, fields: [] });
  });

  it('a missing content entry names the copy to create (contentKeys, at most 20) and rolls the whole replace back', async () => {
    const w = await world('missing');
    const c = await template(w, 'mis');
    expect((await createDraft(c)).status).toBe(201);
    const def = definition();
    const expected = copyKeys(c, def);
    expect(expected.length).toBeLessThanOrEqual(20);
    const before = await stateOf();
    const r = await replace(c, 1, def);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED', details: { reason: 'CONTENT_ENTRY_MISSING', contentKeys: expected } });
    expect(await stateOf()).toEqual(before);
    // only some of them are missing: only those are named
    const have = expected.slice(0, 5);
    for (const k of have) await copy(k, textOfKey(k));
    const r2 = await replace(c, 1, def);
    expect(r2.body.error.details.contentKeys).toEqual(expected.slice(5));
    // a draft is not changed by a failed replace even when an earlier definition was stored
    for (const k of expected.slice(5)) await copy(k, textOfKey(k));
    expect((await replace(c, 1, def)).status).toBe(200);
    const stored = await api('GET', `/gig-templates/${c}/versions/1`, reader);
    const sizeBefore = await stateOf();
    const broken = await replace(c, 2, {
      ...def,
      expectedRevision: stored.body.data.revision,
      fields: [...def.fields, field('missing_one', 'BOOLEAN', 'PROVIDER_REQUIRED')],
    });
    expect(broken.status).toBe(404); // version 2 does not exist
    const broken2 = await replace(c, 1, {
      ...def,
      expectedRevision: stored.body.data.revision,
      fields: [...def.fields, field('missing_one', 'BOOLEAN', 'PROVIDER_REQUIRED')],
    });
    expect(broken2.status).toBe(400);
    expect(broken2.body.error.details.contentKeys).toEqual([gigTemplateFieldLabelKey(c, 'missing_one')]);
    expect(await stateOf()).toEqual(sizeBefore);
    expect((await api('GET', `/gig-templates/${c}/versions/1`, reader)).body.data).toEqual(stored.body.data);
  });

  it('a huge expectedRevision is a plain STALE_DRAFT; a copyFromVersion at the 32-bit bound is a typed 404', async () => {
    const w = await world('huge');
    const c = await template(w, 'hug');
    expect((await createDraft(c)).status).toBe(201);
    for (const n of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect((await replace(c, 1, definition({ expectedRevision: n }))).status, `expectedRevision ${n}`).toBe(409);
      expect((await publish(c, 1, n)).status).toBe(409);
    }
    const r = await createDraft(c, { copyFromVersion: 2_147_483_647 });
    expect([r.status, r.body.error.code]).toEqual([404, 'CATALOG_GIG_TEMPLATE_VERSION_NOT_FOUND']);
  });

  // copyFromVersion is bounded by the largest 32-bit integer in the contract: a larger value is a 400 (it used to reach PostgreSQL and become a 500)
  it('a copyFromVersion above 2147483647 is a client error, not a 500', async () => {
    const w = await world('huge2');
    const c = await template(w, 'hg2');
    expect((await createDraft(c)).status).toBe(201);
    for (const n of [2_147_483_648, 99_999_999_999]) {
      const r = await createDraft(c, { copyFromVersion: n });
      expect(r.status, `copyFromVersion ${n}: ${r.raw}`).toBeLessThan(500);
    }
  });
});

// ====================================================================== the lifecycle over HTTP
describe('the lifecycle of a Gig Template over HTTP: audit rows and outbox events per step, in SQL', () => {
  it('create, link copy, draft, replace, activate, publish, expose, v2, supersede, discard, pause, retire — each step with exactly its audit rows and events', async () => {
    const w = await world('life');
    const c = code('life');
    const steps: string[] = [];
    const run = async (name: string, f: (h: Record<string, string>) => Promise<Res>, status: number, audit: string[], events: string[]): Promise<Res> => {
      const h = cids(name);
      const r = await f(h);
      steps.push(name);
      expect(r.status, `${name}: ${r.raw.slice(0, 600)}`).toBe(status);
      expect(
        (await auditOf(cidOf(h))).map((a) => a.action),
        `${name} audit`,
      ).toEqual(audit);
      expect(
        (await outboxOf(cidOf(h))).map((e) => e.event_type),
        `${name} events`,
      ).toEqual(events);
      return r;
    };
    const def = definition();

    // ---- the template
    await copy(gigTemplateNameKey(c), `Name ${c}`, `Nombre ${c}`);
    await copy(gigTemplateDescriptionKey(c), `About ${c}`);
    await copy(gigTemplateInstructionsKey(c), `Instructions ${c}`);
    const body = { code: c, serviceTypeCode: w.st, withDescription: true, withInstructions: true, reason: REASON };
    const created = await run('create', (h) => api('POST', '/gig-templates', staff, body, h), 201, ['GIG_TEMPLATE_CREATED'], []);
    expect(keysOf(created.body.data)).toEqual(
      [...PUBLIC_DETAIL_KEYS, 'createdAt', 'descriptionContentKey', 'instructionsContentKey', 'nameContentKey', 'status', 'updatedAt', 'versions'].sort(),
    );
    expect(created.body.data).toMatchObject({
      code: c,
      serviceTypeCode: w.st,
      categoryCode: w.cat,
      status: 'DRAFT',
      name: `Name ${c}`,
      description: `About ${c}`,
      instructions: `Instructions ${c}`,
      activeVersion: null,
      versions: [],
      nameContentKey: gigTemplateNameKey(c),
    });
    await run('create-again', (h) => api('POST', '/gig-templates', staff, body, h), 409, [], []);
    const dup = await api('POST', '/gig-templates', staff, body);
    expect(dup.body.error).toMatchObject({ code: 'CATALOG_CONFLICT', details: { reason: 'CODE_TAKEN' } });
    await run(
      'update-off',
      (h) => api('PATCH', `/gig-templates/${c}`, staff, { withInstructions: false, reason: REASON }, h),
      200,
      ['GIG_TEMPLATE_UPDATED'],
      [],
    );
    await run('update-off-again', (h) => api('PATCH', `/gig-templates/${c}`, staff, { withInstructions: false, reason: REASON }, h), 200, [], []);
    const relinked = await run(
      'update-on',
      (h) => api('PATCH', `/gig-templates/${c}`, staff, { withInstructions: true, reason: REASON }, h),
      200,
      ['GIG_TEMPLATE_UPDATED'],
      [],
    );
    expect(relinked.body.data.instructions).toBe(`Instructions ${c}`);

    // ---- nothing is public yet
    expect(codesOf(await pub(w.m))).not.toContain(c);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);

    // ---- the first draft
    const d1 = await run(
      'draft-1',
      (h) => api('POST', `/gig-templates/${c}/versions`, staff, { reason: REASON }, h),
      201,
      ['GIG_TEMPLATE_VERSION_CREATED'],
      [],
    );
    expect(keysOf(d1.body.data)).toEqual(MGMT_VERSION_KEYS);
    expect(d1.body.data).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      revision: 1,
      publishedAt: null,
      closedAt: null,
      fieldCount: 0,
      fields: [],
      requirements: [],
    });
    expect(d1.body.data.duration).toEqual({ minMinutes: null, maxMinutes: null, suggestedMinutes: null });
    const dr = await run('draft-1-again', (h) => api('POST', `/gig-templates/${c}/versions`, staff, { reason: REASON }, h), 409, [], []);
    expect(dr.body.error.details).toEqual({ reason: 'DRAFT_EXISTS' });

    // ---- replace the draft (copy missing, then there)
    const missing = await run('replace-missing', (h) => replace(c, 1, def, h), 400, [], []);
    expect(missing.body.error.details.reason).toBe('CONTENT_ENTRY_MISSING');
    const fieldKeys = await defCopy(c, def, { noText: copyKeys(c, def) }); // entries exist, no text yet
    const r1 = await run('replace', (h) => replace(c, 1, def, h), 200, ['GIG_TEMPLATE_VERSION_CHANGED'], []);
    expect(r1.body.data).toMatchObject({ versionNumber: 1, status: 'DRAFT', revision: 2, fieldCount: 7 });
    expect(r1.body.data.fields.map((f: Json) => [f.fieldKey, f.displayOrder])).toEqual(def.fields.map((f, i) => [f.fieldKey, i + 1]));
    expect(r1.body.data.fields.map((f: Json) => f.labelContentKey)).toEqual(def.fields.map((f) => gigTemplateFieldLabelKey(c, f.fieldKey)));
    expect(r1.body.data.fields[1].options.map((o: Json) => [o.optionCode, o.isDefault, o.displayOrder])).toEqual([
      ['carnauba', true, 1],
      ['synthetic', false, 2],
    ]);
    expect(r1.body.data.duration).toEqual({ minMinutes: 30, maxMinutes: 240, suggestedMinutes: 60 });
    expect(r1.body.data.pricingModels).toEqual(['FIXED', 'DROP_ELIGIBLE']);
    expect(r1.body.data.areaModes).toEqual(['RADIUS', 'POSTAL_CODES']);
    expect(r1.body.data.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'detailing_basic' },
    ]);
    // the audit row of a change holds identifiers and counts only
    const changed = (
      await q<{ changes: Json; reason: string }>(
        "SELECT changes, reason FROM catalog.audit_events WHERE action = 'GIG_TEMPLATE_VERSION_CHANGED' AND gig_template_version_id = $1",
        [r1.body.data.gigTemplateVersionId],
      )
    )[0]!;
    expect(changed.reason).toBe(REASON);
    expect(changed.changes.revision).toEqual([1, 2]);
    expect(JSON.stringify(changed.changes)).not.toMatch(/Copy of|Name |About /);
    // an equal definition changes nothing; a stale revision is refused
    const same = await run('replace-same', (h) => replace(c, 1, { ...def, expectedRevision: 2 }, h), 200, [], []);
    expect(same.body.data.revision).toBe(2);
    expect(same.body.data).toEqual(r1.body.data);
    const stale = await run('replace-stale', (h) => replace(c, 1, { ...def, expectedRevision: 1 }, h), 409, [], []);
    expect(stale.body.error.details).toEqual({ reason: 'STALE_DRAFT' });
    // a real change bumps the revision once
    const changedDef = { ...def, expectedRevision: 2, duration: { minMinutes: 30, suggestedMinutes: 90, maxMinutes: 240 } };
    const r3 = await run('replace-2', (h) => replace(c, 1, changedDef, h), 200, ['GIG_TEMPLATE_VERSION_CHANGED'], []);
    expect([r3.body.data.revision, r3.body.data.duration.suggestedMinutes]).toEqual([3, 90]);

    // ---- publication needs an ACTIVE template and published copy
    const notActive = await run('publish-draft-template', (h) => publish(c, 1, 3, h), 409, [], []);
    expect(notActive.body.error.details).toEqual({ reason: 'GIG_TEMPLATE_NOT_ACTIVE' });
    await run('activate', (h) => setStatus('gig-templates', c, 'ACTIVE', h), 200, ['GIG_TEMPLATE_STATUS_CHANGED'], [GIG_TEMPLATE_EVENTS.activated]);
    await run('activate-again', (h) => setStatus('gig-templates', c, 'ACTIVE', h), 200, [], []);
    const unpublished = await run('publish-no-text', (h) => publish(c, 1, 3, h), 409, [], []);
    expect(unpublished.body.error.details.reason).toBe('CONTENT_NOT_PUBLISHED');
    expect([...unpublished.body.error.details.contentKeys].sort()).toEqual([...fieldKeys].sort());
    for (const k of fieldKeys) await publishText(k, 'en-US', textOfKey(k));
    for (const k of [fieldKeys[0]!, fieldKeys[1]!]) await publishText(k, 'es-US', `ES ${textOfKey(k)}`);
    const staleP = await run('publish-stale', (h) => publish(c, 1, 2, h), 409, [], []);
    expect(staleP.body.error.details).toEqual({ reason: 'STALE_DRAFT' });
    const live = await run('publish', (h) => publish(c, 1, 3, h), 200, ['GIG_TEMPLATE_VERSION_PUBLISHED'], [GIG_TEMPLATE_EVENTS.published]);
    const v1Id = live.body.data.gigTemplateVersionId as string;
    expect(live.body.data).toMatchObject({ versionNumber: 1, status: 'ACTIVE', revision: 3, closedAt: null });
    expect(live.body.data.publishedAt).toEqual(expect.any(String));
    expect(await outboxOf(live.headers['x-correlation-id'] as string)).toEqual([
      expect.objectContaining({
        event_type: GIG_TEMPLATE_EVENTS.published,
        aggregate_type: 'catalog_gig_template',
        actor_type: 'user',
        actor_id: 'staff-a',
        payload_json: { gigTemplateCode: c, serviceTypeCode: w.st, versionNumber: 1, gigTemplateVersionId: v1Id },
      }),
    ]);
    // a repeat with the same revision is a no-op, a frozen version refuses every change
    await run('publish-again', (h) => publish(c, 1, 3, h), 200, [], []);
    const frozen = await run('replace-frozen', (h) => replace(c, 1, { ...def, expectedRevision: 3 }, h), 409, [], []);
    expect(frozen.body.error.details).toEqual({ reason: 'VERSION_NOT_DRAFT' });
    const noDiscard = await run(
      'discard-active',
      (h) => api('PUT', `/gig-templates/${c}/versions/1/status`, staff, { status: 'RETIRED', reason: REASON }, h),
      409,
      [],
      [],
    );
    expect(noDiscard.body.error.details).toEqual({ reason: 'ONLY_DRAFT_CAN_BE_DISCARDED' });

    // ---- still not public: not enabled in the market
    expect(codesOf(await pub(w.m))).not.toContain(c);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);
    const mgmtBefore = await api('GET', `/gig-templates/${c}?market=${w.m}`, reader);
    expect(mgmtBefore.body.data).toMatchObject({ status: 'ACTIVE', enabled: false, displayOrder: null });
    const e1 = await run(
      'enable',
      (h) => enable(w.m, c, true, 20, h),
      200,
      ['MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'],
      [GIG_TEMPLATE_EVENTS.availabilityChanged],
    );
    expect(e1.body.data).toEqual({ marketCode: w.m, code: c, enabled: true, displayOrder: 20 });
    await run('enable-again', (h) => enable(w.m, c, true, 20, h), 200, [], []);
    const outboxAvail = await outboxOf(e1.headers['x-correlation-id'] as string);
    expect(outboxAvail[0]!.payload_json).toEqual({ marketCode: w.m, gigTemplateCode: c, enabled: true });
    expect(outboxAvail[0]!.aggregate_type).toBe('catalog_market_availability');

    // ---- the public view: resolved text, the frozen v1 structure, only public fields
    const pubList = await pub(w.m);
    expect(pubList.status).toBe(200);
    expect(codesOf(pubList)).toEqual([c]);
    expect(keysOf(pubList.body.data[0])).toEqual(PUBLIC_LIST_KEYS);
    expect(pubList.body.data[0]).toMatchObject({ name: `Name ${c}`, description: `About ${c}`, displayOrder: 20, serviceTypeCode: w.st, categoryCode: w.cat });
    expect(pubList.body.data[0].activeVersion).toEqual({
      gigTemplateVersionId: v1Id,
      versionNumber: 1,
      duration: { minMinutes: 30, maxMinutes: 240, suggestedMinutes: 90 },
      pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
      areaModes: ['RADIUS', 'POSTAL_CODES'],
      fieldCount: 7,
    });
    const pubDetail = await pub(w.m, `/gig-templates/${c}`);
    expect(keysOf(pubDetail.body.data)).toEqual(PUBLIC_DETAIL_KEYS);
    expect(keysOf(pubDetail.body.data.activeVersion)).toEqual(PUBLIC_VERSION_KEYS);
    expect(pubDetail.body.data.instructions).toBe(`Instructions ${c}`);
    const pf = pubDetail.body.data.activeVersion.fields as Json[];
    for (const f of pf) {
      expect(keysOf(f), f.fieldKey).toEqual(PUBLIC_FIELD_KEYS);
      expect(f.label).toBe(textOfKey(gigTemplateFieldLabelKey(c, f.fieldKey)));
    }
    expect(pf.map((f) => [f.fieldKey, f.mediaRule])).toEqual([
      ['scope_notes', null],
      ['wax_type', null],
      ['vehicle_count', null],
      ['detail_minutes', null],
      ['before_photos', 'REQUIRED'],
      ['interior_photos', 'PROHIBITED'],
      ['skills', null],
    ]);
    expect(pf[0]).toMatchObject({
      behavior: 'PLATFORM_FIXED',
      section: 'SCOPE',
      defaultText: textOfKey(gigTemplateFieldDefaultKey(c, 'scope_notes')),
      help: textOfKey(gigTemplateFieldHelpKey(c, 'scope_notes')),
      minLength: 10,
      maxLength: 500,
    });
    expect(pf[1].options.map((o: Json) => [o.optionCode, o.label, o.isDefault])).toEqual([
      ['carnauba', textOfKey(gigTemplateOptionLabelKey(c, 'wax_type', 'carnauba')), true],
      ['synthetic', textOfKey(gigTemplateOptionLabelKey(c, 'wax_type', 'synthetic')), false],
    ]);
    expect(pf[2]).toMatchObject({ fieldType: 'INTEGER', minNumber: 1, maxNumber: 4, defaultNumber: 1 });
    expect(pf[5]).toMatchObject({ customerVisible: false, minItems: 0, maxItems: 0 });
    expect((await pub(w.m, `/service-types/${w.st}/gig-templates`)).body.data.map((t: Json) => t.code)).toEqual([c]);
    // locale: Spanish where published, English where not (the content chain), explicit and market default
    const es = await pub(w.m, `/gig-templates/${c}`, '&locale=es-US');
    expect(es.body.data.name).toBe(`Nombre ${c}`);
    expect(es.body.data.description).toBe(`About ${c}`); // no Spanish description: falls back
    expect(es.body.data.activeVersion.fields[0].label).toBe(`ES ${textOfKey(gigTemplateFieldLabelKey(c, 'scope_notes'))}`);
    expect(es.body.data.activeVersion.fields[2].label).toBe(textOfKey(gigTemplateFieldLabelKey(c, 'vehicle_count')));
    expect((await pub(w.m, `/gig-templates/${c}`, '&locale=fr-FR')).body.data.name).toBe(`Name ${c}`);

    // ---- the management view: every version, the revision, the keys
    const mg = await api('GET', `/gig-templates/${c}?market=${w.m}`, reader);
    expect(mg.body.data).toMatchObject({ status: 'ACTIVE', enabled: true, displayOrder: 20 });
    expect(mg.body.data.versions.map((v: Json) => [v.versionNumber, v.status, v.revision, v.fieldCount])).toEqual([[1, 'ACTIVE', 3, 7]]);
    for (const f of mg.body.data.activeVersion.fields) expect(keysOf(f)).toEqual(MGMT_FIELD_KEYS);

    // ---- version 2: copied, edited, published; version 1 is preserved
    const d2 = await run(
      'draft-2',
      (h) => api('POST', `/gig-templates/${c}/versions`, staff, { copyFromVersion: 1, reason: REASON }, h),
      201,
      ['GIG_TEMPLATE_VERSION_CREATED'],
      [],
    );
    expect(d2.body.data).toMatchObject({ versionNumber: 2, status: 'DRAFT', revision: 1, fieldCount: 7 });
    expect(d2.body.data.fields.map((f: Json) => f.fieldKey)).toEqual(def.fields.map((f) => f.fieldKey));
    expect(d2.body.data.duration).toEqual({ minMinutes: 30, maxMinutes: 240, suggestedMinutes: 90 });
    const created2 = (
      await auditOf(
        (
          await q<{ correlation_id: string }>(
            "SELECT correlation_id FROM catalog.audit_events WHERE action = 'GIG_TEMPLATE_VERSION_CREATED' AND gig_template_version_id = $1",
            [d2.body.data.gigTemplateVersionId],
          )
        )[0]!.correlation_id,
      )
    ).find((a) => a.action === 'GIG_TEMPLATE_VERSION_CREATED')!;
    expect(created2.changes).toMatchObject({ versionNumber: [null, 2], status: [null, 'DRAFT'], copiedFromVersion: [null, 1] });
    expect(pubDetailVersion(await pub(w.m, `/gig-templates/${c}`))).toBe(1); // the draft is not public
    const def2 = {
      ...definition({ expectedRevision: 1 }),
      fields: [
        ...def.fields.map((f) => (f.fieldKey === 'vehicle_count' ? { ...f, maxNumber: 6 } : f)),
        field('extra_note', 'TEXT', 'PROVIDER_CONFIGURABLE', { maxLength: 200 }),
      ],
    };
    await copy(gigTemplateFieldLabelKey(c, 'extra_note'), 'Extra note');
    const r2 = await run('replace-v2', (h) => replace(c, 2, def2, h), 200, ['GIG_TEMPLATE_VERSION_CHANGED'], []);
    expect([r2.body.data.revision, r2.body.data.fieldCount]).toEqual([2, 8]);
    const p2 = await run('publish-v2', (h) => publish(c, 2, 2, h), 200, ['GIG_TEMPLATE_VERSION_PUBLISHED'], [GIG_TEMPLATE_EVENTS.published]);
    const v2Id = p2.body.data.gigTemplateVersionId as string;
    expect(v2Id).not.toBe(v1Id);
    expect(await versionRows(c)).toEqual([
      expect.objectContaining({ version_number: 1, status: 'SUPERSEDED', revision: 3, gig_template_version_id: v1Id }),
      expect.objectContaining({ version_number: 2, status: 'ACTIVE', revision: 2, gig_template_version_id: v2Id }),
    ]);
    expect((await versionRows(c))[0]!.closed_at).not.toBeNull();
    expect((await versionRows(c))[1]!.closed_at).toBeNull();
    const pub2 = (await pub(w.m, `/gig-templates/${c}`)).body.data;
    expect(pub2.activeVersion).toMatchObject({ versionNumber: 2, gigTemplateVersionId: v2Id, fieldCount: 8 });
    expect(pub2.activeVersion.fields.find((f: Json) => f.fieldKey === 'vehicle_count').maxNumber).toBe(6);
    expect(pub2.activeVersion.fields.find((f: Json) => f.fieldKey === 'extra_note').label).toBe('Extra note');
    // version 1 is preserved exactly as it was published
    const old = await api('GET', `/gig-templates/${c}/versions/1`, reader);
    expect(old.body.data).toMatchObject({ versionNumber: 1, status: 'SUPERSEDED', revision: 3, fieldCount: 7, gigTemplateVersionId: v1Id });
    expect(old.body.data.closedAt).toEqual(expect.any(String));
    expect(old.body.data.fields.find((f: Json) => f.fieldKey === 'vehicle_count').maxNumber).toBe(4);
    expect(old.body.data.fields.map((f: Json) => f.fieldKey)).toEqual(def.fields.map((f) => f.fieldKey));
    const mg2 = await api('GET', `/gig-templates/${c}`, reader);
    expect(mg2.body.data.versions.map((v: Json) => [v.versionNumber, v.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'SUPERSEDED'],
    ]);
    // a SUPERSEDED version can neither be published again nor discarded
    expect((await run('publish-superseded', (h) => publish(c, 1, 3, h), 409, [], [])).body.error.details).toEqual({ reason: 'VERSION_NOT_DRAFT' });
    expect(
      (
        await run(
          'discard-superseded',
          (h) => api('PUT', `/gig-templates/${c}/versions/1/status`, staff, { status: 'RETIRED', reason: REASON }, h),
          409,
          [],
          [],
        )
      ).body.error.details,
    ).toEqual({
      reason: 'ONLY_DRAFT_CAN_BE_DISCARDED',
    });

    // ---- version 3: created, discarded (idempotent), never published; the next number is 4
    await run(
      'draft-3',
      (h) => api('POST', `/gig-templates/${c}/versions`, staff, { copyFromVersion: 2, reason: REASON }, h),
      201,
      ['GIG_TEMPLATE_VERSION_CREATED'],
      [],
    );
    const dis = await run(
      'discard-3',
      (h) => api('PUT', `/gig-templates/${c}/versions/3/status`, staff, { status: 'RETIRED', reason: REASON }, h),
      200,
      ['GIG_TEMPLATE_VERSION_RETIRED'],
      [],
    );
    expect(dis.body.data).toMatchObject({ versionNumber: 3, status: 'RETIRED' });
    await run('discard-3-again', (h) => api('PUT', `/gig-templates/${c}/versions/3/status`, staff, { status: 'RETIRED', reason: REASON }, h), 200, [], []);
    expect((await run('publish-discarded', (h) => publish(c, 3, 1, h), 409, [], [])).body.error.details).toEqual({ reason: 'VERSION_NOT_DRAFT' });
    expect((await run('replace-discarded', (h) => replace(c, 3, definition(), h), 409, [], [])).body.error.details).toEqual({ reason: 'VERSION_NOT_DRAFT' });
    const d4 = await run(
      'draft-4',
      (h) => api('POST', `/gig-templates/${c}/versions`, staff, { reason: REASON }, h),
      201,
      ['GIG_TEMPLATE_VERSION_CREATED'],
      [],
    );
    expect(d4.body.data.versionNumber).toBe(4);
    expect(pubDetailVersion(await pub(w.m, `/gig-templates/${c}`))).toBe(2); // the drafts are not public

    // ---- pause and resume
    await run('pause', (h) => setStatus('gig-templates', c, 'INACTIVE', h), 200, ['GIG_TEMPLATE_STATUS_CHANGED'], [GIG_TEMPLATE_EVENTS.deactivated]);
    expect(codesOf(await pub(w.m))).not.toContain(c);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);
    expect((await pub(w.m, `/service-types/${w.st}/gig-templates`)).body.data).toEqual([]);
    expect((await api('GET', `/gig-templates/${c}`, reader)).body.data).toMatchObject({
      status: 'INACTIVE',
      activeVersion: { versionNumber: 2, status: 'ACTIVE' },
    });
    expect((await publish(c, 4, 1)).status).toBe(409); // a paused template accepts no publication
    await run('resume', (h) => setStatus('gig-templates', c, 'ACTIVE', h), 200, ['GIG_TEMPLATE_STATUS_CHANGED'], [GIG_TEMPLATE_EVENTS.activated]);
    expect(pubDetailVersion(await pub(w.m, `/gig-templates/${c}`))).toBe(2);

    // ---- retire: the open draft is discarded, the ACTIVE version is closed, every version stays
    await run(
      'retire',
      (h) => setStatus('gig-templates', c, 'RETIRED', h),
      200,
      ['GIG_TEMPLATE_VERSION_RETIRED', 'GIG_TEMPLATE_STATUS_CHANGED', 'GIG_TEMPLATE_VERSION_RETIRED'],
      [GIG_TEMPLATE_EVENTS.retired],
    );
    expect(codesOf(await pub(w.m))).not.toContain(c);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);
    const history = await api('GET', `/gig-templates/${c}`, reader);
    expect(history.body.data).toMatchObject({ status: 'RETIRED', activeVersion: null });
    expect(history.body.data.versions.map((v: Json) => [v.versionNumber, v.status])).toEqual([
      [4, 'RETIRED'],
      [3, 'RETIRED'],
      [2, 'RETIRED'],
      [1, 'SUPERSEDED'],
    ]);
    for (const v of history.body.data.versions) expect(v.closedAt, `v${v.versionNumber} closedAt`).toEqual(expect.any(String));
    expect((await api('GET', `/gig-templates/${c}/versions/2`, reader)).body.data.fields).toHaveLength(8); // the structure is kept
    await run('retire-again', (h) => setStatus('gig-templates', c, 'RETIRED', h), 200, [], []);
    const afterRetire = await run('draft-after-retire', (h) => api('POST', `/gig-templates/${c}/versions`, staff, { reason: REASON }, h), 409, [], []);
    expect(afterRetire.body.error.details).toEqual({ reason: 'GIG_TEMPLATE_RETIRED' });
    expect((await run('reactivate-retired', (h) => setStatus('gig-templates', c, 'ACTIVE', h), 409, [], [])).body.error.details).toEqual({
      reason: 'STATUS_TRANSITION',
    });
    expect((await run('publish-retired', (h) => publish(c, 4, 1, h), 409, [], [])).body.error.details).toBeDefined();
    // a RETIRED template can be switched off in a market, but never on again
    await run(
      'disable-retired',
      (h) => enable(w.m, c, false, 20, h),
      200,
      ['MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'],
      [GIG_TEMPLATE_EVENTS.availabilityChanged],
    );
    const enableRetired = await run('enable-retired', (h) => enable(w.m, c, true, 21, h), 409, [], []);
    expect(enableRetired.body.error.details).toEqual({ reason: 'ITEM_RETIRED' });
    expect(codesOf(await pub(w.m))).not.toContain(c);
    expect(steps.length).toBeGreaterThan(40); // every step above ran and asserted its audit rows and events
  });
});

// ====================================================================== visibility
describe('market availability and the public view', () => {
  it('a market that is PLANNED, INACTIVE, unknown or la-oc is never public (404, the same answer), although an administrator can prepare it', async () => {
    const w = await world('vis');
    const c = await liveTemplate(w, 'vis', 10);
    expect(codesOf(await pub(w.m))).toEqual([c]);
    const planned = await market('vis-planned', 'PLANNED');
    const inactive = await market('vis-inactive', 'INACTIVE');
    // prepare the template in each of them: any market status accepts the row, and the seeded la-oc too
    for (const m of [planned, inactive, 'la-oc']) {
      const e = await enable(m, c, true, 10);
      expect(e.status, `${m}: ${e.raw}`).toBe(200);
    }
    const answers = new Set<string>();
    for (const m of [planned, inactive, 'la-oc', 'nowhere', 'devtest-gt-unknown']) {
      for (const u of ['/gig-templates', `/gig-templates/${c}`, `/service-types/${w.st}/gig-templates`]) {
        const r = await pub(m, u);
        expect([r.status, r.body.error.code], `${m} ${u}`).toEqual([404, 'CATALOG_MARKET_NOT_FOUND']);
        const { correlationId: _c, details: _d, ...rest } = r.body.error;
        answers.add(JSON.stringify(rest));
      }
    }
    expect(answers.size).toBe(1);
    // the administrator sees the prepared row in every one of them
    for (const m of [planned, inactive, 'la-oc']) {
      const r = await api('GET', `/gig-templates?market=${m}&serviceType=${w.st}`, reader);
      expect(r.body.data.find((t: Json) => t.code === c)).toMatchObject({ enabled: true, displayOrder: 10 });
    }
    // activating the planned market makes the prepared row public at once
    await geography.setMarketActive(planned, true, 'launch', A);
    expect(codesOf(await pub(planned))).toEqual([]); // the service type is not enabled in that market yet
    expect((await setAvail(planned, 'categories', w.cat, true, 10)).status).toBe(200);
    expect((await setAvail(planned, 'service-types', w.st, true, 10)).status).toBe(200);
    expect(codesOf(await pub(planned))).toEqual([c]);
    // deactivating the market hides it again
    await geography.setMarketActive(planned, false, 'pause', A);
    expect((await pub(planned)).status).toBe(404);
    // la-oc stays hidden, whatever is enabled there
    expect((await pub('la-oc')).status).toBe(404);
  });

  it('a template is public only while market, category, service type and template are all ACTIVE and enabled and an ACTIVE version exists', async () => {
    const w = await world('chain');
    const c = await liveTemplate(w, 'chain', 10);
    const visible = async () => codesOf(await pub(w.m)).includes(c);
    expect(await visible()).toBe(true);
    // the template switched off in the market, and on again
    expect((await enable(w.m, c, false)).status).toBe(200);
    expect(await visible()).toBe(false);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);
    expect((await api('GET', `/gig-templates/${c}?market=${w.m}`, reader)).body.data).toMatchObject({ enabled: false, status: 'ACTIVE' });
    expect((await enable(w.m, c, true)).status).toBe(200); // the order is kept
    expect(await visible()).toBe(true);
    // the service type switched off in the market (the category stays), then on again
    expect((await setAvail(w.m, 'service-types', w.st, false)).status).toBe(200);
    expect(await visible()).toBe(false);
    const st404 = await pub(w.m, `/service-types/${w.st}/gig-templates`);
    expect([st404.status, st404.body.error.code]).toEqual([404, 'CATALOG_SERVICE_TYPE_NOT_FOUND']);
    expect((await setAvail(w.m, 'service-types', w.st, true)).status).toBe(200);
    expect(await visible()).toBe(true);
    // the service type paused: the template is hidden, and the service type cannot leave ACTIVE... it can, a template does not block it
    expect((await setStatus('service-types', w.st, 'INACTIVE')).status).toBe(200);
    expect(await visible()).toBe(false);
    expect((await pub(w.m, `/service-types/${w.st}/gig-templates`)).status).toBe(404);
    expect((await api('GET', `/service-types/${w.st}/gig-templates`, reader)).body.data.map((t: Json) => t.code)).toContain(c);
    expect((await setStatus('service-types', w.st, 'ACTIVE')).status).toBe(200);
    expect(await visible()).toBe(true);
    // the category switched off in the market takes the service type (and so the template) with it
    expect((await setAvail(w.m, 'categories', w.cat, false)).status).toBe(200);
    expect(await visible()).toBe(false);
    expect((await setAvail(w.m, 'categories', w.cat, true)).status).toBe(200);
    expect((await setAvail(w.m, 'service-types', w.st, true)).status).toBe(200);
    expect(await visible()).toBe(true);
    // the template paused, activated
    expect((await setStatus('gig-templates', c, 'INACTIVE')).status).toBe(200);
    expect(await visible()).toBe(false);
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    expect(await visible()).toBe(true);
  });

  it('a template without an ACTIVE version is never public, even ACTIVE and enabled; a service type that is not ACTIVE cannot host an ACTIVE template or a publication', async () => {
    const w = await world('noact');
    const c = await template(w, 'noact');
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    expect((await enable(w.m, c, true, 10)).status).toBe(200);
    expect(codesOf(await pub(w.m))).toEqual([]);
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(404);
    // the management view lists it, activeVersion null
    expect((await api('GET', `/gig-templates?market=${w.m}`, reader)).body.data.find((t: Json) => t.code === c)).toMatchObject({
      status: 'ACTIVE',
      activeVersion: null,
      enabled: true,
    });
    // a DRAFT service type: a template under it cannot become ACTIVE
    const draftSt = code('gsd');
    await copy(serviceTypeNameKey(draftSt), `Draft service ${draftSt}`);
    expect((await api('POST', '/service-types', staff, { code: draftSt, categoryCode: w.cat, reason: REASON })).status).toBe(201);
    const t2c = code('under');
    await copy(gigTemplateNameKey(t2c), 'Under a draft service type');
    expect((await api('POST', '/gig-templates', staff, { code: t2c, serviceTypeCode: draftSt, reason: REASON })).status).toBe(201);
    const act = await setStatus('gig-templates', t2c, 'ACTIVE');
    expect([act.status, act.body.error.details]).toEqual([409, { reason: 'SERVICE_TYPE_NOT_ACTIVE' }]);
  });

  it('orders the public list by the display order of the market; the order is unique per market; the first row needs one', async () => {
    const w = await world('order');
    const a = await liveTemplate(w, 'oa', 30);
    const b = await liveTemplate(w, 'ob', 10);
    const c = await liveTemplate(w, 'oc', 20);
    expect(codesOf(await pub(w.m))).toEqual([b, c, a]);
    expect((await pub(w.m)).body.data.map((t: Json) => t.displayOrder)).toEqual([10, 20, 30]);
    const taken = await enable(w.m, c, true, 10);
    expect([taken.status, taken.body.error.details]).toEqual([409, { reason: 'DISPLAY_ORDER_TAKEN' }]);
    expect((await enable(w.m, b, true, 40)).status).toBe(200); // move b last
    expect(codesOf(await pub(w.m))).toEqual([c, a, b]);
    const fresh = await template(w, 'of');
    const noOrder = await enable(w.m, fresh, true);
    expect([noOrder.status, noOrder.body.error.details]).toEqual([400, { reason: 'DISPLAY_ORDER_REQUIRED', field: 'displayOrder' }]);
    // the order of another market is independent
    const m2 = await market('order-b', 'ACTIVE');
    expect((await enable(m2, c, true, 10)).status).toBe(200);
    // the service type route lists only its own templates
    const other = await world('order-other');
    const o = await liveTemplate(other, 'oo', 10);
    expect(codesOf(await pub(w.m, `/service-types/${w.st}/gig-templates`))).toEqual([c, a, b]);
    expect(codesOf(await pub(other.m, `/service-types/${other.st}/gig-templates`))).toEqual([o]);
    expect(codesOf(await pub(w.m, '/gig-templates', `&serviceType=${other.st}`))).toEqual([]);
    expect(codesOf(await pub(w.m, '/gig-templates', `&serviceType=${w.st}`))).toEqual([c, a, b]);
    // a template of another market is not found here
    expect((await pub(w.m, `/gig-templates/${o}`)).status).toBe(404);
  });

  it('a market default locale decides the text; an explicit locale wins; INTERNAL copy is never shown publicly and falls back (name: omitted, label: field key, option: code, description: null)', async () => {
    const w = await world('loc', 'es-US');
    const c = code('loc');
    await copy(gigTemplateNameKey(c), `Name ${c}`, `Nombre ${c}`);
    await copy(gigTemplateDescriptionKey(c), `About ${c}`, `Sobre ${c}`);
    const def = definition();
    const ks = copyKeys(c, def);
    const internalLabel = gigTemplateFieldLabelKey(c, 'vehicle_count');
    const internalOption = gigTemplateOptionLabelKey(c, 'wax_type', 'synthetic');
    for (const k of ks) await copy(k, textOfKey(k), `ES ${textOfKey(k)}`, k === internalLabel || k === internalOption ? { sensitivity: 'INTERNAL' } : {});
    expect((await api('POST', '/gig-templates', staff, { code: c, serviceTypeCode: w.st, withDescription: true, reason: REASON })).status).toBe(201);
    expect((await createDraft(c)).status).toBe(201);
    expect((await replace(c, 1, def)).status).toBe(200);
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    expect((await publish(c, 1, 2)).status).toBe(200);
    expect((await enable(w.m, c, true, 10)).status).toBe(200);
    const d = (await pub(w.m, `/gig-templates/${c}`)).body.data;
    expect(d.name).toBe(`Nombre ${c}`); // the default locale of the market
    expect(d.description).toBe(`Sobre ${c}`);
    expect(d.instructions).toBeNull();
    const fieldsByKey = Object.fromEntries(d.activeVersion.fields.map((f: Json) => [f.fieldKey, f]));
    expect(fieldsByKey.scope_notes.label).toBe(`ES ${textOfKey(gigTemplateFieldLabelKey(c, 'scope_notes'))}`);
    expect(fieldsByKey.vehicle_count.label).toBe('vehicle_count'); // INTERNAL copy: the field key, not the text
    expect(fieldsByKey.wax_type.options[1]).toMatchObject({ optionCode: 'synthetic', label: 'synthetic' });
    expect(fieldsByKey.wax_type.options[0].label).toBe(`ES ${textOfKey(gigTemplateOptionLabelKey(c, 'wax_type', 'carnauba'))}`);
    expect(JSON.stringify(d)).not.toContain(textOfKey(internalLabel));
    // an explicit locale wins over the market default
    const en = (await pub(w.m, `/gig-templates/${c}`, '&locale=en-US')).body.data;
    expect(en.name).toBe(`Name ${c}`);
    expect(en.activeVersion.fields[0].label).toBe(textOfKey(gigTemplateFieldLabelKey(c, 'scope_notes')));
    // the management view shows the INTERNAL text, in the platform default locale without a market and in the market's with one
    const mg = (await api('GET', `/gig-templates/${c}`, reader)).body.data;
    expect(mg.name).toBe(`Name ${c}`);
    expect(mg.activeVersion.fields.find((f: Json) => f.fieldKey === 'vehicle_count').label).toBe(textOfKey(internalLabel));
    const mgm = (await api('GET', `/gig-templates/${c}?market=${w.m}`, reader)).body.data;
    expect(mgm.name).toBe(`Nombre ${c}`);
    // an INTERNAL name: omitted from the public list, a 404 in the public detail, key-shaped fallback never shown
    const hidden = code('hid');
    await content.createEntry(entryReq(gigTemplateNameKey(hidden), { sensitivity: 'INTERNAL' }), A);
    await publishText(gigTemplateNameKey(hidden), 'en-US', 'Staff only template name');
    const hdef = definition({ fields: [field('only_one', 'BOOLEAN', 'PROVIDER_REQUIRED')] });
    await defCopy(hidden, hdef);
    expect((await api('POST', '/gig-templates', staff, { code: hidden, serviceTypeCode: w.st, reason: REASON })).status).toBe(201);
    expect((await createDraft(hidden)).status).toBe(201);
    expect((await replace(hidden, 1, hdef)).status).toBe(200);
    expect((await setStatus('gig-templates', hidden, 'ACTIVE')).status).toBe(200);
    expect((await publish(hidden, 1, 2)).status).toBe(200);
    expect((await enable(w.m, hidden, true, 20)).status).toBe(200);
    const list = await pub(w.m);
    expect(codesOf(list)).toEqual([c]);
    expect(list.raw).not.toContain('Staff only');
    expect(list.raw).not.toContain(gigTemplateNameKey(hidden));
    const detail = await pub(w.m, `/gig-templates/${hidden}`);
    expect([detail.status, detail.body.error.code]).toEqual([404, 'CATALOG_GIG_TEMPLATE_NOT_FOUND']);
    expect(detail.raw).not.toContain('Staff only');
    expect(codesOf(await pub(w.m, `/service-types/${w.st}/gig-templates`))).toEqual([c]);
    expect((await api('GET', `/gig-templates/${hidden}`, reader)).body.data.name).toBe('Staff only template name');
  });

  it('a content outage is a 503 on the public reads and degrades the management reads to content keys (real service, failing registry)', async () => {
    const w = await world('outage');
    const c = await liveTemplate(w, 'out', 10);
    const spy = vi.spyOn(content, 'resolveRendered').mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const u of ['/gig-templates', `/gig-templates/${c}`, `/service-types/${w.st}/gig-templates`]) {
        const r = await pub(w.m, u);
        expect([r.status, r.body.error.code], u).toEqual([503, 'CATALOG_UNAVAILABLE']);
        expect(r.raw).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
      }
      const m = await api('GET', `/gig-templates/${c}`, reader);
      expect(m.status).toBe(200);
      expect(m.body.data.name).toBe(gigTemplateNameKey(c));
      expect(m.body.data.activeVersion.fields[0].label).toBe(gigTemplateFieldLabelKey(c, 'scope_notes'));
      expect((await api('GET', `/gig-templates/${c}/versions/1`, reader)).status).toBe(200);
    } finally {
      spy.mockRestore();
      logs.mockRestore();
    }
    expect((await pub(w.m, `/gig-templates/${c}`)).status).toBe(200);
  });
});

// ====================================================================== the cache
describe('the public read cache (the catalogue generation counter)', () => {
  it('every effective change is visible at once; a malformed entry is a miss; a cache outage degrades to the database', async () => {
    const w = await world('cache');
    const c = await liveTemplate(w, 'cch', 10);
    expect(codesOf(await pub(w.m))).toEqual([c]); // warms the entry
    const keyOf = () => [...cache.data.keys()].find((k) => k.startsWith(`bg:test:cat:v1:gt:market:${w.m}:`))!;
    const key = keyOf();
    expect(key).toBeTruthy();
    // the snapshot holds structure and content keys, never text
    expect(cache.data.get(key)).toContain(gigTemplateNameKey(c));
    expect(cache.data.get(key)).not.toContain(`Name ${c}`);
    expect(cache.data.get(key)).not.toMatch(/staff-a|integration test/);
    for (const poison of ['not json', '{"v":{"templates":"x"}}', '{"v":null}', '{}', '[]', '{"v":{"templates":[{"code":5}]}}']) {
      cache.data.set(key, poison);
      const r = await pub(w.m);
      expect(r.status, poison).toBe(200);
      expect(codesOf(r), poison).toEqual([c]);
      expect(JSON.parse(cache.data.get(key)!).v.templates).toHaveLength(1);
    }
    // publish v2 and read at once: the generation moved
    expect((await createDraft(c, { copyFromVersion: 1 })).status).toBe(201);
    expect(pubDetailVersion(await pub(w.m, `/gig-templates/${c}`))).toBe(1);
    expect((await publish(c, 2, 1)).status).toBe(200);
    expect(pubDetailVersion(await pub(w.m, `/gig-templates/${c}`))).toBe(2);
    const g1 = cache.data.get('bg:test:cat:gen');
    // an idempotent repeat does not move it
    expect((await publish(c, 2, 1)).status).toBe(200);
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    expect(cache.data.get('bg:test:cat:gen')).toBe(g1);
    expect((await enable(w.m, c, true, 10)).status).toBe(200);
    expect(cache.data.get('bg:test:cat:gen')).toBe(g1);
    // a refused change does not move it either
    expect((await publish(c, 2, 9)).status).toBe(409);
    expect(cache.data.get('bg:test:cat:gen')).toBe(g1);
    // the cache is down: the database answers, and a change made meanwhile is visible at once
    cache.fail = true;
    try {
      expect(codesOf(await pub(w.m))).toEqual([c]);
      expect((await enable(w.m, c, false)).status).toBe(200);
      expect(codesOf(await pub(w.m))).toEqual([]);
    } finally {
      cache.fail = false;
    }
    expect((await enable(w.m, c, true)).status).toBe(200);
    expect(codesOf(await pub(w.m))).toEqual([c]);
  });
});

// ====================================================================== concurrency
describe('concurrency (real PostgreSQL, parallel HTTP requests)', () => {
  it('two simultaneous publish requests of the same draft: both answer 200, ONE publication (one audit row, one event, one ACTIVE version)', async () => {
    const w = await world('race-pub');
    const c = await template(w, 'rp');
    const def = definition();
    await defCopy(c, def);
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    expect((await createDraft(c)).status).toBe(201);
    expect((await replace(c, 1, def)).status).toBe(200);
    for (const round of [1, 2]) {
      if (round === 2) {
        expect((await createDraft(c, { copyFromVersion: 1 })).status).toBe(201);
      }
      const hs = [cids('pa'), cids('pb')];
      const rs = await Promise.all(hs.map((h) => publish(c, round, round === 1 ? 2 : 1, h)));
      expect(
        rs.map((r) => r.status),
        rs.map((r) => r.raw).join(' '),
      ).toEqual([200, 200]);
      expect(rs[0]!.body.data.gigTemplateVersionId).toBe(rs[1]!.body.data.gigTemplateVersionId);
      const audits = (await Promise.all(hs.map((h) => auditOf(cidOf(h))))).flat().map((a) => a.action);
      expect(audits).toEqual(['GIG_TEMPLATE_VERSION_PUBLISHED']);
      const events = (await Promise.all(hs.map((h) => outboxOf(cidOf(h))))).flat().map((e) => e.event_type);
      expect(events).toEqual([GIG_TEMPLATE_EVENTS.published]);
      const rows = await versionRows(c);
      expect(rows.filter((v) => v.status === 'ACTIVE')).toHaveLength(1);
      expect(rows.find((v) => v.version_number === round)!.status).toBe('ACTIVE');
    }
    expect((await versionRows(c)).map((v) => v.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
  });

  it("two simultaneous replaces of the same revision: exactly one wins, the other is STALE_DRAFT; the stored draft is the winner's", async () => {
    const w = await world('race-rep');
    const c = await template(w, 'rr');
    const base = definition();
    await defCopy(c, base);
    expect((await createDraft(c)).status).toBe(201);
    for (let round = 0; round < 4; round++) {
      const rev = (await api('GET', `/gig-templates/${c}/versions/1`, reader)).body.data.revision as number;
      // two definitions that differ from each other AND from the stored one (an equal definition is a no-op that still passes the revision check)
      const a = { ...base, expectedRevision: rev, duration: { minMinutes: 100 + round * 2, suggestedMinutes: 120 + round * 2, maxMinutes: 140 + round * 2 } };
      const b = { ...base, expectedRevision: rev, duration: { minMinutes: 101 + round * 2, suggestedMinutes: 121 + round * 2, maxMinutes: 141 + round * 2 } };
      const [ra, rb] = await Promise.all([replace(c, 1, a), replace(c, 1, b)]);
      const statuses = [ra.status, rb.status].sort();
      expect(statuses, `${ra.raw.slice(0, 300)} ${rb.raw.slice(0, 300)}`).toEqual([200, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expect(loser.body.error.details).toEqual({ reason: 'STALE_DRAFT' });
      const winner = ra.status === 200 ? ra : rb;
      const stored = (await api('GET', `/gig-templates/${c}/versions/1`, reader)).body.data;
      expect(stored.revision).toBe(rev + 1);
      expect(stored.duration).toEqual(winner.body.data.duration);
    }
  });

  it('two simultaneous draft creations: one 201, one 409 DRAFT_EXISTS, contiguous numbers; and publish vs discard of the same draft never leaves both', async () => {
    const w = await world('race-draft');
    const c = await template(w, 'rd');
    const rs = await Promise.all([createDraft(c), createDraft(c), createDraft(c)]);
    expect(rs.map((r) => r.status).sort(), rs.map((r) => r.raw).join(' ')).toEqual([201, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body.error.details).toEqual({ reason: 'DRAFT_EXISTS' });
    expect((await versionRows(c)).map((v) => v.version_number)).toEqual([1]);
    const def = definition();
    await defCopy(c, def);
    expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
    const r1 = await replace(c, 1, def);
    expect(r1.status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const n = (await versionRows(c)).length;
      const rev = (await api('GET', `/gig-templates/${c}/versions/${n}`, reader)).body.data.revision as number;
      const [p, d] = await Promise.all([
        publish(c, n, rev),
        api('PUT', `/gig-templates/${c}/versions/${n}/status`, staff, { status: 'RETIRED', reason: REASON }),
      ]);
      expect(
        [p.status, d.status].every((s) => [200, 409].includes(s)),
        `${p.raw} ${d.raw}`,
      ).toBe(true);
      expect(p.status === 200 && d.status === 200 && (await versionRows(c))[n - 1]!.status === 'RETIRED' && p.body.data.status === 'ACTIVE', 'both won').toBe(
        false,
      );
      const row = (await versionRows(c))[n - 1]!;
      expect(['ACTIVE', 'RETIRED', 'SUPERSEDED']).toContain(row.status);
      if (row.status === 'ACTIVE') {
        // the next round: copy the active version into a new draft
        expect((await createDraft(c, { copyFromVersion: n })).status).toBe(201);
      } else {
        expect((await createDraft(c)).status).toBe(201);
        expect((await replace(c, n + 1, definition())).status).toBe(200);
      }
    }
    const rows = await versionRows(c);
    expect(rows.filter((v) => v.status === 'ACTIVE').length).toBeLessThanOrEqual(1);
    expect(rows.filter((v) => v.status === 'DRAFT').length).toBeLessThanOrEqual(1);
    expect(rows.map((v) => v.version_number)).toEqual(rows.map((_, i) => i + 1));
  });

  it('retiring a template while a version is published or created: never a RETIRED template with an ACTIVE version or an open draft (repeated)', async () => {
    const w = await world('race-ret');
    for (let i = 0; i < 5; i++) {
      const c = await template(w, `rt${i}`);
      const def = definition();
      await defCopy(c, def);
      expect((await setStatus('gig-templates', c, 'ACTIVE')).status).toBe(200);
      expect((await createDraft(c)).status).toBe(201);
      expect((await replace(c, 1, def)).status).toBe(200);
      const [retire, pubR, mk] = await Promise.all([setStatus('gig-templates', c, 'RETIRED'), publish(c, 1, 2), createDraft(c)]);
      for (const r of [retire, pubR, mk]) expect([200, 201, 409], `${r.raw}`).toContain(r.status);
      expect(retire.status, retire.raw).toBe(200);
      const rows = await versionRows(c);
      expect(
        rows.filter((v) => v.status === 'ACTIVE' || v.status === 'DRAFT'),
        `round ${i}`,
      ).toEqual([]);
      expect((await api('GET', `/gig-templates/${c}`, reader)).body.data).toMatchObject({ status: 'RETIRED', activeVersion: null });
    }
  });

  it('simultaneous enable of two templates on ONE display order: exactly one wins; the same request twice is one effect', async () => {
    const w = await world('race-ord');
    const [a, b] = [await template(w, 'oa'), await template(w, 'ob')];
    const rs = await Promise.all([enable(w.m, a, true, 7), enable(w.m, b, true, 7)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.details).toEqual({ reason: 'DISPLAY_ORDER_TAKEN' });
    const hs = [cids('ea'), cids('eb')];
    const same = await Promise.all(hs.map((h) => enable(w.m, a === (rs[0]!.status === 200 ? a : b) ? b : a, true, 8, h)));
    expect(same.map((r) => r.status).every((s) => s === 200)).toBe(true);
    const audits = (await Promise.all(hs.map((h) => auditOf(cidOf(h))))).flat();
    expect(audits).toHaveLength(1);
  });
});

// ====================================================================== privacy and response checks
describe('responses: sizes, leaks and the OpenAPI route table', () => {
  it('no response, public or management, contains a token, the actor, the reason, a column name or SQL; the public ones no management word either', async () => {
    const w = await world('leak');
    const c = await liveTemplate(w, 'lk', 10);
    const publicResponses = [await pub(w.m), await pub(w.m, `/gig-templates/${c}`), await pub(w.m, `/service-types/${w.st}/gig-templates`)];
    const mgmtResponses = [
      await api('GET', '/gig-templates', staff),
      await api('GET', `/gig-templates/${c}`, staff),
      await api('GET', `/gig-templates/${c}/versions/1`, staff),
      await api('GET', `/gig-templates?market=${w.m}`, staff),
    ];
    const mutationResponses = [
      await createDraft(c, { copyFromVersion: 1 }),
      await api('PATCH', `/gig-templates/${c}`, staff, { withDescription: true, reason: REASON }),
      await enable(w.m, c, true, 10),
      await api('PUT', `/gig-templates/${c}/versions/2/status`, staff, { status: 'RETIRED', reason: REASON }),
    ];
    const everything = [...publicResponses, ...mgmtResponses, ...mutationResponses];
    for (const r of everything) {
      expect(r.status, r.raw.slice(0, 200)).toBeLessThan(300);
      expect(r.raw, 'token').not.toMatch(/Bearer|eyJ[A-Za-z0-9_-]{10,}/);
      for (const word of [
        'staff-a',
        'reader-r',
        REASON,
        'author-a',
        'actor',
        'audit',
        'SELECT ',
        'gig_template_id',
        'display_order',
        'label_content_key',
        'service_type_id',
        'price',
        'floorPrice',
      ])
        expect(r.raw, word).not.toContain(word);
    }
    for (const r of publicResponses) {
      for (const word of [
        '"status"',
        '"enabled"',
        'revision',
        'publishedAt',
        'closedAt',
        'createdAt',
        'updatedAt',
        'ContentKey',
        'versions',
        'catalog.gig_template.',
        'DRAFT',
        'SUPERSEDED',
      ])
        expect(r.raw, `public ${word}`).not.toContain(word);
      expect(r.raw.length).toBeLessThan(20_000);
      expect(r.headers['cache-control'] ?? '').not.toMatch(/no-store/);
    }
    for (const r of [...mgmtResponses, ...mutationResponses]) expect(String(r.headers['cache-control'])).toMatch(/private, no-store/);
    for (const r of publicResponses) expect(String(r.headers.vary)).toMatch(/authorization/i);
    // the public detail carries every field of the definition and the whole thing stays small
    const detail = publicResponses[1]!;
    expect(detail.body.data.activeVersion.fields).toHaveLength(7);
    expect(detail.raw.length).toBeLessThan(8_000);
    // the management version read holds the content keys and nothing of the audit trail
    const v = mgmtResponses[2]!.body.data;
    expect(keysOf(v)).toEqual(MGMT_VERSION_KEYS);
    for (const f of v.fields) expect(keysOf(f)).toEqual(MGMT_FIELD_KEYS);
  });

  it('the audit rows and events of the whole run hold identifiers only: no copy, no token, no personal data; every row has one subject, an actor and a reason', async () => {
    const rows = await q<{ action: string; changes: Json; reason: string; actor: string }>(
      'SELECT action, changes, reason, actor FROM catalog.audit_events WHERE gig_template_id IS NOT NULL',
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.reason.trim().length).toBeGreaterThan(0);
      expect(r.actor.trim().length).toBeGreaterThan(0);
      expect(JSON.stringify(r.changes ?? {}), r.action).not.toMatch(/Copy of|Name devtest|About devtest|Instructions devtest|Bearer|eyJ|@/);
    }
    const bad = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM catalog.audit_events
        WHERE action LIKE 'GIG\\_TEMPLATE\\_%' AND (gig_template_id IS NULL OR category_id IS NOT NULL OR service_type_id IS NOT NULL OR prohibited_service_id IS NOT NULL OR market_id IS NOT NULL)`,
    );
    expect(bad[0]!.n).toBe('0');
    const events = await q<{ event_type: string; payload_json: Json; actor_type: string }>(
      "SELECT event_type, payload_json, actor_type FROM integration.outbox_events WHERE event_type LIKE 'bananagig.catalog.gig-template-%'",
    );
    expect(events.length).toBeGreaterThan(8);
    const allowed = new Set(['gigTemplateCode', 'serviceTypeCode', 'versionNumber', 'gigTemplateVersionId', 'marketCode', 'enabled']);
    for (const e of events) {
      expect(Object.values(GIG_TEMPLATE_EVENTS)).toContain(e.event_type);
      expect(e.actor_type).toBe('user');
      for (const k of Object.keys(e.payload_json)) expect(allowed.has(k), `${e.event_type} ${k}`).toBe(true);
      expect(JSON.stringify(e.payload_json)).not.toMatch(/Name devtest|Copy of|staff-a|integration test|Bearer/);
    }
  });

  it('the OpenAPI route table contains every Gig Template operation exactly once', () => {
    const doc = app.swagger() as unknown as { paths: Record<string, Record<string, { operationId: string; tags?: string[] }>> };
    const ops: string[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      for (const op of Object.values(item)) if (p.startsWith('/api/v1/catalog') && op.tags?.includes('gig-templates')) ops.push(op.operationId);
    expect(ops.sort()).toEqual(
      [
        'createGigTemplate',
        'createGigTemplateVersion',
        'getGigTemplate',
        'getGigTemplateVersion',
        'listGigTemplates',
        'listServiceTypeGigTemplates',
        'publishGigTemplateVersion',
        'replaceGigTemplateDraft',
        'setCatalogMarketGigTemplateAvailability',
        'setGigTemplateStatus',
        'setGigTemplateVersionStatus',
        'updateGigTemplate',
      ].sort(),
    );
    expect(new Set(ops).size).toBe(ops.length);
  });
});
