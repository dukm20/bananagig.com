// Unit tests of the Gig Template API module (CAT-002) with a FAKE GigTemplateService, a FAKE CatalogService and a FAKE ContentService, written by an independent author. The real rules
// are covered by packages/catalog and gig-template.itest.ts; here: authentication and authorization on all 12 operations, strict bodies, strict version path parameters, the public view
// (market required, exact key sets, ONE content batch, label and name fallbacks, a content outage), the management view, the cache policy, error mapping with its allow-list, the
// OpenAPI inventory and the DTO mappers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  CATALOG_ERROR_CODES,
  ErrorResponse,
  GIG_TEMPLATE_EVENTS,
  GigTemplateDetailDto,
  GigTemplateListItemDto,
  GigTemplateVersionDto,
  gigTemplateDescriptionKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldHelpKey,
  gigTemplateFieldLabelKey,
  gigTemplateInstructionsKey,
  gigTemplateNameKey,
  gigTemplateOptionLabelKey,
  type CatalogErrorCode,
} from '@bananagig/contracts';
import {
  CatalogError,
  type CatalogService,
  type GigTemplateFieldView,
  type GigTemplateService,
  type GigTemplateVersionSummaryView,
  type GigTemplateVersionView,
  type GigTemplateView,
} from '@bananagig/catalog';
import type { ContentService } from '@bananagig/content';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';
import { safeDetails } from './modules/catalog/dto';
import { gigTemplateDetailDto, gigTemplateListItemDto, templateKeys, versionDto, versionKeys, versionSummaryDto } from './modules/catalog/gig-template-dto';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let app: FastifyInstance;

// ---------------------------------------------------------------- fakes
const gt = {
  listGigTemplatesForMarket: vi.fn(),
  getGigTemplateForMarket: vi.fn(),
  listGigTemplates: vi.fn(),
  getGigTemplate: vi.fn(),
  getGigTemplateVersion: vi.fn(),
  createGigTemplate: vi.fn(),
  updateGigTemplate: vi.fn(),
  setGigTemplateStatus: vi.fn(),
  createGigTemplateVersion: vi.fn(),
  replaceGigTemplateDraft: vi.fn(),
  publishGigTemplateVersion: vi.fn(),
  retireGigTemplateVersion: vi.fn(),
  setMarketGigTemplateAvailability: vi.fn(),
};
const catalog = { getServiceType: vi.fn(), getServiceTypeForMarket: vi.fn(), getMarketDefaultLocale: vi.fn() };
const content = { resolveRendered: vi.fn(), listLocales: vi.fn() };
const noServiceCalled = () => [...Object.values(gt), ...Object.values(catalog)].every((f) => f.mock.calls.length === 0);
const noContentCalled = () => Object.values(content).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- tokens and requests
const READ = 'catalog-read';
const WRITE = 'catalog-write';
const adminToken = (roles: string[], over: Record<string, unknown> = {}) =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
      ...over,
    },
  });
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1/catalog${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const raw = (method: Method, url: string, token: string, payload: string, type = 'application/json') =>
  app.inject({ method, url: `/api/v1/catalog${url}`, headers: { authorization: `Bearer ${token}`, 'content-type': type }, payload });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const keysOf = (o: object) => Object.keys(o).sort();
const codesOf = (r: { json: () => { data: { code: string }[] } }) => r.json().data.map((x) => x.code);

// ---------------------------------------------------------------- fixtures: the management shape; the fakes strip it for the public view like the real service
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-02T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** content keys that have NO published text in the fixture (to test the fallbacks) */
const UNTEXTED = new Set<string>();

const fieldView = (
  tpl: string,
  fieldKey: string,
  over: Partial<GigTemplateFieldView> & Pick<GigTemplateFieldView, 'fieldType'>,
  order: number,
): GigTemplateFieldView => ({
  fieldKey,
  section: 'DETAILS',
  behavior: 'PROVIDER_CONFIGURABLE',
  customerVisible: true,
  displayOrder: order,
  labelContentKey: gigTemplateFieldLabelKey(tpl, fieldKey),
  helpContentKey: null,
  defaultContentKey: null,
  minLength: null,
  maxLength: null,
  minNumber: null,
  maxNumber: null,
  defaultNumber: null,
  defaultBoolean: null,
  minItems: null,
  maxItems: null,
  options: [],
  ...over,
});
const FD = 'full_detail';
const FD_FIELDS: GigTemplateFieldView[] = [
  fieldView(
    FD,
    'scope_notes',
    {
      fieldType: 'LONG_TEXT',
      behavior: 'PLATFORM_FIXED',
      section: 'SCOPE',
      helpContentKey: gigTemplateFieldHelpKey(FD, 'scope_notes'),
      defaultContentKey: gigTemplateFieldDefaultKey(FD, 'scope_notes'),
      minLength: 20,
      maxLength: 2000,
    },
    1,
  ),
  fieldView(
    FD,
    'wax_type',
    {
      fieldType: 'ENUM',
      section: 'INCLUSIONS',
      helpContentKey: gigTemplateFieldHelpKey(FD, 'wax_type'),
      options: [
        { optionCode: 'carnauba', labelContentKey: gigTemplateOptionLabelKey(FD, 'wax_type', 'carnauba'), isDefault: true, displayOrder: 1 },
        { optionCode: 'synthetic', labelContentKey: gigTemplateOptionLabelKey(FD, 'wax_type', 'synthetic'), isDefault: false, displayOrder: 2 },
      ],
    },
    2,
  ),
  fieldView(FD, 'vehicle_count', { fieldType: 'INTEGER', behavior: 'PROVIDER_REQUIRED', minNumber: 1, maxNumber: 4, defaultNumber: 1 }, 3),
  fieldView(FD, 'detail_minutes', { fieldType: 'DURATION', minNumber: 30, maxNumber: 480, defaultNumber: 120 }, 4),
  fieldView(FD, 'eco_friendly', { fieldType: 'BOOLEAN', defaultBoolean: true, customerVisible: false }, 5),
  fieldView(FD, 'base_amount', { fieldType: 'MONEY', behavior: 'PROVIDER_REQUIRED' }, 6),
  fieldView(FD, 'before_photos', { fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 6 }, 7),
  fieldView(FD, 'after_photos', { fieldType: 'MEDIA', minItems: 0, maxItems: 6 }, 8),
  fieldView(FD, 'interior_photos', { fieldType: 'MEDIA', minItems: 0, maxItems: 0 }, 9),
  fieldView(FD, 'skills', { fieldType: 'SKILL_REFERENCE', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 3 }, 10),
  fieldView(FD, 'size_factor', { fieldType: 'DECIMAL', minNumber: 0.5, maxNumber: 2.25, defaultNumber: 1.5 }, 11),
];
UNTEXTED.add(gigTemplateFieldLabelKey(FD, 'skills')); // label fallback
UNTEXTED.add(gigTemplateOptionLabelKey(FD, 'wax_type', 'synthetic')); // option label fallback
UNTEXTED.add(gigTemplateFieldHelpKey(FD, 'wax_type')); // a help without text is null

const duration = (min: number | null, max: number | null, suggested: number | null) => ({ minMinutes: min, maxMinutes: max, suggestedMinutes: suggested });
const summary = (
  n: number,
  status: GigTemplateVersionSummaryView['status'],
  over: Partial<GigTemplateVersionSummaryView> = {},
): GigTemplateVersionSummaryView => ({
  gigTemplateVersionId: id(100 + n),
  versionNumber: n,
  duration: duration(60, 300, 120),
  pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
  areaModes: ['RADIUS', 'POSTAL_CODES'],
  fieldCount: FD_FIELDS.length,
  status,
  revision: 3,
  publishedAt: status === 'DRAFT' ? null : T1,
  closedAt: status === 'SUPERSEDED' || status === 'RETIRED' ? T1 : null,
  createdAt: T0,
  ...over,
});
const version = (
  n: number,
  status: GigTemplateVersionSummaryView['status'],
  fields = FD_FIELDS,
  over: Partial<GigTemplateVersionView> = {},
): GigTemplateVersionView => ({
  ...summary(n, status, { fieldCount: fields.length }),
  fields,
  requirements: [
    { requirementType: 'LICENSE', referenceCode: null },
    { requirementType: 'SKILL', referenceCode: 'detailing_basic' },
  ],
  ...over,
});
const CLEAN_FIELDS = [fieldView('standard_clean', 'rooms', { fieldType: 'INTEGER', minNumber: 1, maxNumber: 10 }, 1)];

const tpl = (
  code: string,
  serviceTypeCode: string,
  categoryCode: string,
  status: GigTemplateView['status'],
  n: number,
  over: Partial<GigTemplateView> = {},
): GigTemplateView => ({
  gigTemplateId: id(n),
  code,
  serviceTypeCode,
  categoryCode,
  nameContentKey: gigTemplateNameKey(code),
  descriptionContentKey: gigTemplateDescriptionKey(code),
  instructionsContentKey: gigTemplateInstructionsKey(code),
  displayOrder: null,
  status,
  createdAt: T0,
  updatedAt: T1,
  activeVersion: null,
  versions: [],
  ...over,
});
const ORDER: Record<string, number> = { full_detail: 10, standard_clean: 20, unnamed_tpl: 30 };
const TEMPLATES: GigTemplateView[] = [
  tpl('draft_tpl', 'car_detailing', 'auto_services', 'DRAFT', 1),
  tpl('full_detail', 'car_detailing', 'auto_services', 'ACTIVE', 2, {
    activeVersion: version(2, 'ACTIVE'),
    versions: [summary(3, 'DRAFT', { fieldCount: 4, revision: 2 }), summary(2, 'ACTIVE'), summary(1, 'SUPERSEDED')],
  }),
  tpl('retired_tpl', 'car_detailing', 'auto_services', 'RETIRED', 3, { versions: [summary(1, 'RETIRED')] }),
  tpl('standard_clean', 'regular_cleaning', 'home_cleaning', 'ACTIVE', 4, {
    descriptionContentKey: null,
    instructionsContentKey: null,
    activeVersion: version(1, 'ACTIVE', CLEAN_FIELDS, { duration: duration(null, null, null) }),
    versions: [summary(1, 'ACTIVE', { fieldCount: 1 })],
  }),
  tpl('unnamed_tpl', 'regular_cleaning', 'home_cleaning', 'ACTIVE', 5, {
    activeVersion: version(1, 'ACTIVE', CLEAN_FIELDS),
    versions: [summary(1, 'ACTIVE', { fieldCount: 1 })],
  }),
];
UNTEXTED.add(gigTemplateNameKey('unnamed_tpl'));
const PUBLIC_CODES = ['full_detail', 'standard_clean', 'unnamed_tpl'];
const SERVICE_TYPES: Record<string, { status: string; public: boolean }> = {
  car_detailing: { status: 'ACTIVE', public: true },
  regular_cleaning: { status: 'ACTIVE', public: true },
  draft_st: { status: 'DRAFT', public: false },
};

/** text of the content registry: every key of the fixtures except the UNTEXTED ones; the value carries the requested locale so the locale is observable */
const allKeys = (): string[] => {
  const out: string[] = [];
  for (const t of TEMPLATES) {
    out.push(...templateKeys(t, true), ...versionKeys(t.activeVersion));
  }
  out.push(...versionKeys(DRAFT_VERSION), ...versionKeys(ONLY_DRAFT_VERSION));
  return out;
};
const textOf = (key: string, locale: string) => `Text<${key.replace(/\./g, '/')}> [${locale}]`;

const stripVersionSummary = (v: GigTemplateVersionSummaryView): GigTemplateVersionSummaryView => {
  const { status: _s, revision: _r, publishedAt: _p, closedAt: _c, createdAt: _t, ...rest } = v;
  return rest;
};
const publicTpl = (t: GigTemplateView): GigTemplateView => {
  const { status: _s, createdAt: _c, updatedAt: _u, versions: _v, ...rest } = t;
  return {
    ...rest,
    displayOrder: ORDER[t.code]!,
    activeVersion: t.activeVersion
      ? { ...stripVersionSummary(t.activeVersion), fields: t.activeVersion.fields, requirements: t.activeVersion.requirements }
      : null,
  };
};
const PUBLIC_MARKETS: Record<string, string> = { 'us-sf': 'en-US', 'mx-cdmx': 'es-MX' };
const MGMT_MARKET_LOCALES: Record<string, string> = { 'us-sf': 'en-US', 'mx-cdmx': 'es-MX', 'la-oc': 'en-US', 'qa-lab': 'qaa' };
const publicMarket = (code: string) => {
  const defaultLocale = PUBLIC_MARKETS[code];
  if (!defaultLocale) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not available', { code });
  return { code, defaultLocale };
};
const DRAFT_VERSION: GigTemplateVersionView = version(3, 'DRAFT', FD_FIELDS.slice(0, 4), { revision: 2, publishedAt: null, closedAt: null });
const ONLY_DRAFT_VERSION: GigTemplateVersionView = version(1, 'DRAFT', [], { fieldCount: 0, requirements: [], revision: 1 });

const PUBLIC_LIST_KEYS = ['activeVersion', 'categoryCode', 'code', 'description', 'displayOrder', 'gigTemplateId', 'name', 'serviceTypeCode'];
const PUBLIC_DETAIL_KEYS = [...PUBLIC_LIST_KEYS, 'instructions'].sort();
const MGMT_LIST_KEYS = [...PUBLIC_LIST_KEYS, 'createdAt', 'descriptionContentKey', 'instructionsContentKey', 'nameContentKey', 'status', 'updatedAt'].sort();
const MGMT_LIST_KEYS_WITH_MARKET = [...MGMT_LIST_KEYS, 'enabled'].sort();
const MGMT_DETAIL_KEYS = [...MGMT_LIST_KEYS, 'instructions', 'versions'].sort();
const PUBLIC_SUMMARY_KEYS = ['areaModes', 'duration', 'fieldCount', 'gigTemplateVersionId', 'pricingModels', 'versionNumber'];
const MGMT_SUMMARY_KEYS = [...PUBLIC_SUMMARY_KEYS, 'closedAt', 'createdAt', 'publishedAt', 'revision', 'status'].sort();
const PUBLIC_VERSION_KEYS = [...PUBLIC_SUMMARY_KEYS, 'fields', 'requirements'].sort();
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
const PUBLIC_OPTION_KEYS = ['displayOrder', 'isDefault', 'label', 'optionCode'];
const MGMT_OPTION_KEYS = [...PUBLIC_OPTION_KEYS, 'labelContentKey'].sort();
const REQUIREMENT_KEYS = ['referenceCode', 'requirementType'];
const AVAILABILITY_KEYS = ['code', 'displayOrder', 'enabled', 'marketCode'];
/** words that must never appear as a key of any response */
const INTERNAL_WORDS = ['actor', 'audit', 'auditEvents', 'createdBy', 'correlation_id', 'reason', 'price', 'floorPrice', 'radius', 'capacity'];

const availability = (marketCode: string, code: string, enabled = true) => ({ marketCode, code, enabled, displayOrder: 10 });

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({
    cfg,
    verifier,
    configuration: {} as never,
    content: content as unknown as ContentService,
    catalog: catalog as unknown as CatalogService,
    gigTemplates: gt as unknown as GigTemplateService,
    readiness: async () => ({}),
  });
  await app.ready();
});
afterAll(() => app.close());

const mgmtMarket = (o: { marketCode?: string } = {}) => {
  if (o.marketCode !== undefined && !(o.marketCode in MGMT_MARKET_LOCALES))
    throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: o.marketCode });
};
const withMarket = (t: GigTemplateView, marketCode: string | undefined): GigTemplateView =>
  marketCode === undefined ? t : { ...t, enabled: t.status === 'ACTIVE', displayOrder: ORDER[t.code] ?? null };

beforeEach(() => {
  for (const f of [...Object.values(gt), ...Object.values(catalog), ...Object.values(content)]) f.mockReset();
  gt.listGigTemplatesForMarket.mockImplementation(async (m: string, o: { serviceTypeCode?: string } = {}) => ({
    market: publicMarket(m),
    templates: TEMPLATES.filter((t) => PUBLIC_CODES.includes(t.code) && (!o.serviceTypeCode || t.serviceTypeCode === o.serviceTypeCode)).map(publicTpl),
  }));
  gt.getGigTemplateForMarket.mockImplementation(async (m: string, code: string) => {
    const market = publicMarket(m);
    const t = TEMPLATES.find((x) => x.code === code && PUBLIC_CODES.includes(x.code));
    if (!t) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not available', { code });
    return { market, template: publicTpl(t) };
  });
  gt.listGigTemplates.mockImplementation(async (o: { serviceTypeCode?: string; marketCode?: string } = {}) => {
    mgmtMarket(o);
    return TEMPLATES.filter((t) => !o.serviceTypeCode || t.serviceTypeCode === o.serviceTypeCode).map((t) => {
      const { versions: _v, ...rest } = withMarket(t, o.marketCode);
      return rest;
    });
  });
  gt.getGigTemplate.mockImplementation(async (code: string, o: { marketCode?: string } = {}) => {
    mgmtMarket(o);
    const t = TEMPLATES.find((x) => x.code === code);
    if (!t) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code });
    return withMarket(t, o.marketCode);
  });
  gt.getGigTemplateVersion.mockImplementation(async (code: string, n: number) => {
    const t = TEMPLATES.find((x) => x.code === code);
    if (!t) throw new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template is not registered', { code });
    if (n === 3) return DRAFT_VERSION;
    if (n === 2 && t.activeVersion) return t.activeVersion;
    throw new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'the version is not registered', { code });
  });
  gt.createGigTemplate.mockResolvedValue(tpl('new_tpl', 'car_detailing', 'auto_services', 'DRAFT', 31));
  gt.updateGigTemplate.mockResolvedValue(TEMPLATES[1]);
  gt.setGigTemplateStatus.mockResolvedValue(tpl('full_detail', 'car_detailing', 'auto_services', 'INACTIVE', 2, { activeVersion: version(2, 'ACTIVE') }));
  gt.createGigTemplateVersion.mockResolvedValue(ONLY_DRAFT_VERSION);
  gt.replaceGigTemplateDraft.mockResolvedValue({ ...DRAFT_VERSION, revision: 3 });
  gt.publishGigTemplateVersion.mockResolvedValue(version(3, 'ACTIVE'));
  gt.retireGigTemplateVersion.mockResolvedValue(version(3, 'RETIRED'));
  gt.setMarketGigTemplateAvailability.mockResolvedValue(availability('us-sf', 'full_detail'));
  catalog.getMarketDefaultLocale.mockImplementation(async (m: string) => {
    const l = MGMT_MARKET_LOCALES[m];
    if (!l) throw new CatalogError('MARKET_NOT_FOUND', 'the market is not registered', { code: m });
    return l;
  });
  catalog.getServiceType.mockImplementation(async (code: string) => {
    if (!SERVICE_TYPES[code]) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not registered', { code });
    return { code };
  });
  catalog.getServiceTypeForMarket.mockImplementation(async (m: string, code: string) => {
    const market = publicMarket(m);
    if (!SERVICE_TYPES[code]?.public) throw new CatalogError('SERVICE_TYPE_NOT_FOUND', 'the service type is not available', { code });
    return { market, serviceType: { code } };
  });
  content.resolveRendered.mockImplementation(async (ks: string[], o: { locale: string }) => ({
    items: new Map(ks.filter((k) => !UNTEXTED.has(k)).map((k) => [k, { format: 'text', value: textOf(k, o.locale) }])),
    sources: new Map(),
    missing: new Map(),
    at: new Date(),
  }));
  content.listLocales.mockResolvedValue([
    { locale: 'en-US', isPlatformDefault: true },
    { locale: 'es-US', isPlatformDefault: false },
  ]);
});

// ====================================================================== the 12 operations
type Perm = 'public' | 'write' | 'read';
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  perm: Perm;
  body?: unknown;
  okStatus: number;
  fn: keyof typeof gt;
  /** the service function a PRIVILEGED caller of a shared read reaches */
  mgmtFn?: keyof typeof gt;
}
const REASON = 'unit test reason';
const FIELD_BODY = { fieldKey: 'eco_friendly', fieldType: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE', defaultBoolean: true };
const REPLACE_BODY = {
  expectedRevision: 2,
  duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 120 },
  pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
  areaModes: ['RADIUS'],
  fields: [
    FIELD_BODY,
    {
      fieldKey: 'wax_type',
      fieldType: 'ENUM',
      behavior: 'PROVIDER_REQUIRED',
      options: [{ optionCode: 'carnauba', isDefault: true }, { optionCode: 'synthetic' }],
    },
  ],
  requirements: [{ requirementType: 'SKILL', referenceCode: 'detailing_basic' }],
  reason: REASON,
};
const ROUTES: Route[] = [
  {
    operationId: 'listGigTemplates',
    method: 'GET',
    url: '/gig-templates?market=us-sf',
    spec: '/api/v1/catalog/gig-templates',
    perm: 'public',
    okStatus: 200,
    fn: 'listGigTemplatesForMarket',
    mgmtFn: 'listGigTemplates',
  },
  {
    operationId: 'getGigTemplate',
    method: 'GET',
    url: '/gig-templates/full_detail?market=us-sf',
    spec: '/api/v1/catalog/gig-templates/{code}',
    perm: 'public',
    okStatus: 200,
    fn: 'getGigTemplateForMarket',
    mgmtFn: 'getGigTemplate',
  },
  {
    operationId: 'listServiceTypeGigTemplates',
    method: 'GET',
    url: '/service-types/car_detailing/gig-templates?market=us-sf',
    spec: '/api/v1/catalog/service-types/{code}/gig-templates',
    perm: 'public',
    okStatus: 200,
    fn: 'listGigTemplatesForMarket',
    mgmtFn: 'listGigTemplates',
  },
  {
    operationId: 'getGigTemplateVersion',
    method: 'GET',
    url: '/gig-templates/full_detail/versions/3',
    spec: '/api/v1/catalog/gig-templates/{code}/versions/{version}',
    perm: 'read',
    okStatus: 200,
    fn: 'getGigTemplateVersion',
  },
  {
    operationId: 'createGigTemplate',
    method: 'POST',
    url: '/gig-templates',
    spec: '/api/v1/catalog/gig-templates',
    perm: 'write',
    body: { code: 'new_tpl', serviceTypeCode: 'car_detailing', withDescription: true, withInstructions: false, reason: REASON },
    okStatus: 201,
    fn: 'createGigTemplate',
  },
  {
    operationId: 'updateGigTemplate',
    method: 'PATCH',
    url: '/gig-templates/full_detail',
    spec: '/api/v1/catalog/gig-templates/{code}',
    perm: 'write',
    body: { withDescription: false, withInstructions: true, reason: REASON },
    okStatus: 200,
    fn: 'updateGigTemplate',
  },
  {
    operationId: 'setGigTemplateStatus',
    method: 'PUT',
    url: '/gig-templates/full_detail/status',
    spec: '/api/v1/catalog/gig-templates/{code}/status',
    perm: 'write',
    body: { status: 'INACTIVE', reason: REASON },
    okStatus: 200,
    fn: 'setGigTemplateStatus',
  },
  {
    operationId: 'createGigTemplateVersion',
    method: 'POST',
    url: '/gig-templates/full_detail/versions',
    spec: '/api/v1/catalog/gig-templates/{code}/versions',
    perm: 'write',
    body: { copyFromVersion: 2, reason: REASON },
    okStatus: 201,
    fn: 'createGigTemplateVersion',
  },
  {
    operationId: 'replaceGigTemplateDraft',
    method: 'PUT',
    url: '/gig-templates/full_detail/versions/3',
    spec: '/api/v1/catalog/gig-templates/{code}/versions/{version}',
    perm: 'write',
    body: REPLACE_BODY,
    okStatus: 200,
    fn: 'replaceGigTemplateDraft',
  },
  {
    operationId: 'publishGigTemplateVersion',
    method: 'POST',
    url: '/gig-templates/full_detail/versions/3/publish',
    spec: '/api/v1/catalog/gig-templates/{code}/versions/{version}/publish',
    perm: 'write',
    body: { expectedRevision: 2, reason: REASON },
    okStatus: 200,
    fn: 'publishGigTemplateVersion',
  },
  {
    operationId: 'setGigTemplateVersionStatus',
    method: 'PUT',
    url: '/gig-templates/full_detail/versions/3/status',
    spec: '/api/v1/catalog/gig-templates/{code}/versions/{version}/status',
    perm: 'write',
    body: { status: 'RETIRED', reason: REASON },
    okStatus: 200,
    fn: 'retireGigTemplateVersion',
  },
  {
    operationId: 'setCatalogMarketGigTemplateAvailability',
    method: 'PUT',
    url: '/markets/us-sf/gig-templates/full_detail',
    spec: '/api/v1/catalog/markets/{market}/gig-templates/{code}',
    perm: 'write',
    body: { enabled: true, displayOrder: 10, reason: REASON },
    okStatus: 200,
    fn: 'setMarketGigTemplateAvailability',
  },
];
const PUBLIC_ROUTES = ROUTES.filter((r) => r.perm === 'public');
const PROTECTED = ROUTES.filter((r) => r.perm !== 'public');
const WRITES = ROUTES.filter((r) => r.perm === 'write');
const route = (op: string) => ROUTES.find((r) => r.operationId === op)!;
const bodyless = (r: Route) => (r.method === 'GET' ? [undefined] : [undefined, {}, { garbage: true }, r.body]);
/** the routes that carry a version number in the path */
const VERSION_ROUTES = ROUTES.filter((r) => r.spec.includes('{version}'));

describe('the 12 operations: OpenAPI inventory', () => {
  const swagger = () =>
    app.swagger() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          { operationId: string; tags: string[]; security?: unknown[]; responses: Record<string, unknown>; parameters?: { name: string; schema?: unknown }[] }
        >
      >;
    };
  it('documents exactly the 12 Gig Template operations with the right method, path, tag and security (and the 16 of CAT-001 are still there)', () => {
    const doc = swagger();
    const found: { operationId: string; method: string; path: string; tags: string[]; security: unknown }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith('/api/v1/catalog'))
        for (const [method, op] of Object.entries(item))
          found.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, tags: op.tags, security: op.security });
    expect(found).toHaveLength(28);
    const gtOps = found.filter((f) => f.tags.includes('gig-templates'));
    expect(gtOps).toHaveLength(12);
    expect(gtOps.map((f) => f.operationId).sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
    expect(found.filter((f) => f.tags.includes('catalog'))).toHaveLength(16);
    for (const r of ROUTES) {
      const f = gtOps.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.tags, r.operationId).toEqual(['gig-templates']);
      if (r.perm === 'public') expect(f.security, r.operationId).toEqual([]);
      else expect(f.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    const tagNames = ((doc as unknown as { tags?: { name: string }[] }).tags ?? []).map((t) => t.name);
    expect(tagNames).toContain('gig-templates');
  });
  it('documents the failure responses: 401 and 403 on every protected operation, 400/401/404 and no 403 on the public ones; the creates answer 201', () => {
    const doc = swagger();
    const responses = (r: Route) => Object.keys(doc.paths[r.spec]![r.method.toLowerCase()]!.responses);
    for (const r of PROTECTED) expect(responses(r), r.operationId).toEqual(expect.arrayContaining(['401', '403']));
    for (const r of PUBLIC_ROUTES) {
      expect(responses(r), r.operationId).toEqual(expect.arrayContaining(['200', '400', '401', '404']));
      expect(responses(r), r.operationId).not.toContain('403');
    }
    for (const r of ROUTES) expect(responses(r), r.operationId).toContain(String(r.okStatus));
    for (const r of ROUTES.filter((x) => x.okStatus === 201)) expect(responses(r), r.operationId).not.toContain('200');
  });
  it('documents every version path parameter as an integer bounded 1..2147483647 with the canonical-text description', () => {
    const doc = swagger();
    for (const r of VERSION_ROUTES) {
      const p = doc.paths[r.spec]![r.method.toLowerCase()]!.parameters!.find((x) => x.name === 'version')!;
      expect(p.schema, r.operationId).toMatchObject({ type: 'integer', minimum: 1, maximum: 2_147_483_647 });
      expect(JSON.stringify(p)).toContain('base-10');
    }
  });
  it('is not registered when the app is built without the Gig Template service (the CAT-001 routes still are), nor without catalogue or content', async () => {
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const common = { cfg, verifier, configuration: {} as never, readiness: async () => ({}) };
    const t = await adminToken([READ, WRITE]);
    for (const deps of [
      { ...common, content: content as unknown as ContentService, catalog: catalog as unknown as CatalogService },
      { ...common, gigTemplates: gt as unknown as GigTemplateService },
      { ...common, gigTemplates: gt as unknown as GigTemplateService, content: content as unknown as ContentService },
      { ...common, gigTemplates: gt as unknown as GigTemplateService, catalog: catalog as unknown as CatalogService },
    ]) {
      const bare = await buildApp(deps);
      await bare.ready();
      for (const r of ROUTES) {
        const res = await bare.inject({
          method: r.method,
          url: `/api/v1/catalog${r.url}`,
          headers: { authorization: `Bearer ${t}` },
          ...(r.body ? { payload: r.body as object } : {}),
        });
        // `/service-types/:code/gig-templates` is not a CAT-001 route either; the others share a path with nothing, except none
        expect(res.statusCode, r.operationId).toBe(404);
        expect(res.json().error.code, r.operationId).toBe('ROUTE_NOT_FOUND');
      }
      await bare.close();
    }
    expect(noServiceCalled()).toBe(true);
  });
  it('the committed OpenAPI document lists every operation id and path, and the AsyncAPI document the five events', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    for (const r of ROUTES) {
      expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
      expect(openapi, r.spec).toMatch(new RegExp(`^ {2}${r.spec.replace(/[{}]/g, '\\$&')}:`, 'm'));
    }
    const asyncapi = readFileSync(path.join(root, 'docs/events/asyncapi.yaml'), 'utf8');
    for (const type of Object.values(GIG_TEMPLATE_EVENTS)) expect(asyncapi, type).toContain(type);
    for (const name of ['GigTemplateActivated', 'GigTemplateDeactivated', 'GigTemplateRetired', 'GigTemplatePublished', 'GigTemplateAvailabilityChanged'])
      expect(asyncapi, name).toContain(`send${name}:`);
  });
});

// ====================================================================== access control
describe('Gig Template API access control', () => {
  it('returns 401 before any validation on every protected route, with an empty, invalid or missing body and malformed params', async () => {
    for (const r of PROTECTED)
      for (const payload of bodyless(r)) {
        const res = await call(r.method, r.url, undefined, payload);
        expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(payload)}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers['www-authenticate']).toContain('Bearer');
      }
    for (const [m, u] of [
      ['GET', '/gig-templates/full_detail/versions/01'],
      ['GET', '/gig-templates/BAD/versions/1'],
      ['PUT', '/gig-templates/full_detail/versions/1e0'],
      ['PUT', '/gig-templates/full_detail/versions/99999999999'],
      ['POST', '/gig-templates/full_detail/versions/0/publish'],
      ['PUT', '/gig-templates/full_detail/versions/+1/status'],
      ['PATCH', '/gig-templates/BAD'],
      ['PUT', '/gig-templates/BAD/status'],
      ['POST', '/gig-templates/BAD/versions'],
      ['PUT', '/markets/BAD_MARKET/gig-templates/BAD'],
      ['PUT', `/gig-templates/${'a'.repeat(49)}/status`],
    ] as const)
      expect((await call(m, u, undefined, m === 'GET' ? undefined : {})).statusCode, `${m} ${u}`).toBe(401);
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    for (const bad of ['not.a.token', expired, unsignedToken({ azp: 'bananagig-admin' })])
      for (const r of PROTECTED) {
        const res = await call(r.method, r.url, bad, r.method === 'GET' ? undefined : r.body);
        expect(res.statusCode, `${r.operationId}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
      }
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('returns 403 (before validation) when an admin lacks the permission: catalog-read cannot write, and no role at all cannot do anything', async () => {
    for (const r of PROTECTED) {
      const refused = r.perm === 'read' ? [[]] : [[READ], []];
      for (const roles of refused) {
        for (const payload of r.method === 'GET' ? [undefined] : [{}, { garbage: true }, r.body]) {
          const res = await call(r.method, r.url, await adminToken(roles), payload);
          expect(res.statusCode, `${r.method} ${r.url} [${roles}]`).toBe(403);
          expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
        }
      }
    }
    // 403 wins over a malformed version number too
    for (const v of ['01', '1.0', '+1', '1e0', '0', '99999999999'])
      for (const r of VERSION_ROUTES) {
        const url = r.url.replace('/versions/3', `/versions/${v}`);
        const res = await call(r.method, url, await adminToken([READ]), r.method === 'GET' ? undefined : {});
        if (r.perm === 'write') expect(res.statusCode, `${r.method} ${url}`).toBe(403);
      }
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('catalog-write implies read (the version read and the management view), the reverse never holds', async () => {
    const writeOnly = await adminToken([WRITE]);
    const readOnly = await adminToken([READ]);
    expect((await call('GET', '/gig-templates/full_detail/versions/3', writeOnly)).statusCode).toBe(200);
    expect((await call('GET', '/gig-templates/full_detail/versions/3', readOnly)).statusCode).toBe(200);
    const mgmt = await call('GET', '/gig-templates', writeOnly);
    expect(codesOf(mgmt)).toEqual(TEMPLATES.map((t) => t.code));
    expect(keysOf(mgmt.json().data[0])).toEqual(MGMT_LIST_KEYS);
    for (const r of WRITES) expect((await call(r.method, r.url, readOnly, r.body)).statusCode, r.operationId).toBe(403);
    expect(gt.createGigTemplate).not.toHaveBeenCalled();
    expect(gt.publishGigTemplateVersion).not.toHaveBeenCalled();
  });

  it('does not let the content, configuration, geography or look-alike role names grant Gig Template access', async () => {
    const foreign = await adminToken([
      'content-read',
      'content-write',
      'content-approve',
      'configuration-read',
      'configuration-write',
      'geography-read',
      'geography-write',
      'catalog-admin',
      'catalog',
      'gig-template-write',
      'Catalog-Read',
      'CATALOG-WRITE',
      'catalog-read ',
    ]);
    for (const r of PROTECTED) expect((await call(r.method, r.url, foreign, r.method === 'GET' ? undefined : r.body)).statusCode, r.operationId).toBe(403);
    // and the shared reads stay in the PUBLIC view for such a token
    const res = await call('GET', '/gig-templates?market=us-sf', foreign);
    expect(res.statusCode).toBe(200);
    expect(keysOf(res.json().data[0])).toEqual(PUBLIC_LIST_KEYS);
    expect(gt.listGigTemplates).not.toHaveBeenCalled();
  });

  it('keeps customers, web-client tokens and other clients out even when they carry the role names', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const spoofedOnWebClient = await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } });
    const webWithAdminResource = await signToken(keys, {
      claims: { azp: 'bananagig-web', resource_access: { 'bananagig-admin': { roles: ['admin-console-access', READ, WRITE] } } },
    });
    const realmRoles = await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: [READ, WRITE, 'admin-console-access'] } } });
    const adminRolesFromOtherClient = await signToken(keys, {
      claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: [READ, WRITE] } } },
    });
    for (const t of [customer, spoofedOnWebClient, webWithAdminResource, realmRoles, adminRolesFromOtherClient]) {
      for (const r of PROTECTED) {
        const res = await call(r.method, r.url, t, r.method === 'GET' ? undefined : r.body);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      }
      // the shared reads: the PUBLIC view, and the market is required for them too
      for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) {
        const noMarket = await call('GET', u, t);
        expect(noMarket.statusCode, u).toBe(400);
        expect(errorOf(noMarket).details).toMatchObject({ reason: 'MARKET_REQUIRED', field: 'market' });
        const withMkt = await call('GET', `${u}?market=us-sf`, t);
        expect(withMkt.statusCode, u).toBe(200);
        const first = Array.isArray(withMkt.json().data) ? withMkt.json().data[0] : withMkt.json().data;
        expect(keysOf(first), u).toEqual(u === '/gig-templates/full_detail' ? PUBLIC_DETAIL_KEYS : PUBLIC_LIST_KEYS);
      }
    }
    for (const f of ['listGigTemplates', 'getGigTemplate', 'getGigTemplateVersion'] as const) expect(gt[f], f).not.toHaveBeenCalled();
    expect(catalog.getServiceType).not.toHaveBeenCalled();
  });

  it('with catalog-write: every mutation calls the service with the validated body and the TOKEN SUBJECT as actor, answers 201/200 with the management view and a correlation id', async () => {
    const t = await adminToken([WRITE], { sub: 'staff-77' });
    for (const r of WRITES) {
      const res = await call(r.method, r.url, t, r.body);
      expect(res.statusCode, `${r.method} ${r.url} ${res.body.slice(0, 200)}`).toBe(r.okStatus);
      expect(res.json().meta.correlationId).toEqual(expect.any(String));
      expect(keysOf(res.json().meta)).toEqual(['correlationId']);
    }
    // each service function was called exactly once, with the path values, the parsed body and the actor
    expect(gt.createGigTemplate).toHaveBeenCalledExactlyOnceWith(route('createGigTemplate').body, 'staff-77');
    expect(gt.updateGigTemplate).toHaveBeenCalledExactlyOnceWith('full_detail', route('updateGigTemplate').body, 'staff-77');
    expect(gt.setGigTemplateStatus).toHaveBeenCalledExactlyOnceWith('full_detail', { status: 'INACTIVE', reason: REASON }, 'staff-77');
    expect(gt.createGigTemplateVersion).toHaveBeenCalledExactlyOnceWith('full_detail', { copyFromVersion: 2, reason: REASON }, 'staff-77');
    expect(gt.publishGigTemplateVersion).toHaveBeenCalledExactlyOnceWith('full_detail', 3, { expectedRevision: 2, reason: REASON }, 'staff-77');
    expect(gt.retireGigTemplateVersion).toHaveBeenCalledExactlyOnceWith('full_detail', 3, { status: 'RETIRED', reason: REASON }, 'staff-77');
    expect(gt.setMarketGigTemplateAvailability).toHaveBeenCalledExactlyOnceWith(
      'us-sf',
      'full_detail',
      { enabled: true, displayOrder: 10, reason: REASON },
      'staff-77',
    );
    // the version number reaches the service as a NUMBER, the body with the defaults of the contract applied
    const [codeArg, versionArg, bodyArg, actorArg] = gt.replaceGigTemplateDraft.mock.calls[0]!;
    expect([codeArg, typeof versionArg, versionArg, actorArg]).toEqual(['full_detail', 'number', 3, 'staff-77']);
    expect(bodyArg.fields[0]).toMatchObject({
      fieldKey: 'eco_friendly',
      section: 'DETAILS',
      customerVisible: true,
      withHelp: false,
      withDefaultText: false,
      options: [],
    });
    expect(bodyArg.fields[1].options).toEqual([
      { optionCode: 'carnauba', isDefault: true },
      { optionCode: 'synthetic', isDefault: false },
    ]);
    expect(bodyArg.requirements).toEqual([{ requirementType: 'SKILL', referenceCode: 'detailing_basic' }]);
    // a different admin is a different actor
    await call('PUT', '/gig-templates/full_detail/status', await adminToken([WRITE], { sub: 'staff-88' }), { status: 'ACTIVE', reason: REASON });
    expect(gt.setGigTemplateStatus).toHaveBeenLastCalledWith('full_detail', { status: 'ACTIVE', reason: REASON }, 'staff-88');
  });

  it('applies the contract defaults to a minimal replace body (requirements []), and never invents values', async () => {
    const t = await adminToken([WRITE]);
    await call('PUT', '/gig-templates/full_detail/versions/3', t, {
      expectedRevision: 1,
      pricingModels: ['FIXED'],
      areaModes: ['POLYGON'],
      fields: [],
      reason: REASON,
    });
    expect(gt.replaceGigTemplateDraft).toHaveBeenCalledWith(
      'full_detail',
      3,
      { expectedRevision: 1, pricingModels: ['FIXED'], areaModes: ['POLYGON'], fields: [], requirements: [], reason: REASON },
      'admin-a',
    );
    await call('POST', '/gig-templates/full_detail/versions', t, { reason: REASON });
    expect(gt.createGigTemplateVersion).toHaveBeenCalledWith('full_detail', { reason: REASON }, 'admin-a');
  });

  it('the response of each mutation is the management view of the right shape (and the fake service cannot smuggle extra fields through)', async () => {
    const t = await adminToken([WRITE]);
    const dirtyField = {
      ...FD_FIELDS[1]!,
      actor: 'staff-1',
      price: 99,
      options: FD_FIELDS[1]!.options.map((o) => ({ ...o, actor: 'staff-1', durationMinutes: 30 })),
    };
    const dirtyVersion = {
      ...version(3, 'ACTIVE'),
      fields: [dirtyField],
      actor: 'staff-1',
      auditEvents: [{ actor: 'staff-1' }],
      price: 99,
      requirements: [{ requirementType: 'LICENSE', referenceCode: null, actor: 'staff-1' }],
    };
    const dirtyTemplate = { ...TEMPLATES[1]!, actor: 'staff-1', auditEvents: [{ actor: 'staff-1' }], price: 99, radius: 5, activeVersion: dirtyVersion };
    gt.createGigTemplate.mockResolvedValue(dirtyTemplate);
    gt.updateGigTemplate.mockResolvedValue(dirtyTemplate);
    gt.setGigTemplateStatus.mockResolvedValue(dirtyTemplate);
    for (const f of ['createGigTemplateVersion', 'replaceGigTemplateDraft', 'publishGigTemplateVersion', 'retireGigTemplateVersion'] as const)
      gt[f].mockResolvedValue(dirtyVersion);
    gt.getGigTemplateVersion.mockResolvedValue(dirtyVersion);
    gt.setMarketGigTemplateAvailability.mockResolvedValue({ ...availability('us-sf', 'full_detail', false), actor: 'staff-1', reason: 'secret' });
    for (const r of WRITES.concat(route('getGigTemplateVersion'))) {
      const res = await call(r.method, r.url, t, r.body);
      expect(res.statusCode, r.operationId).toBe(r.okStatus);
      const d = res.json().data;
      if (r.fn === 'setMarketGigTemplateAvailability') {
        expect(keysOf(d)).toEqual(AVAILABILITY_KEYS);
        expect(d).toEqual(availability('us-sf', 'full_detail', false));
      } else if (r.operationId.endsWith('Template') || r.operationId === 'setGigTemplateStatus') {
        expect(keysOf(d), r.operationId).toEqual(MGMT_DETAIL_KEYS.filter((k) => k !== 'versions' || d.versions));
        expect(keysOf(d.activeVersion)).toEqual(MGMT_VERSION_KEYS);
        expect(keysOf(d.activeVersion.fields[0])).toEqual(MGMT_FIELD_KEYS);
        expect(keysOf(d.activeVersion.fields[0].options[0])).toEqual(MGMT_OPTION_KEYS);
      } else {
        expect(keysOf(d), r.operationId).toEqual(MGMT_VERSION_KEYS);
        expect(keysOf(d.fields[0]), r.operationId).toEqual(MGMT_FIELD_KEYS);
        expect(keysOf(d.requirements[0])).toEqual(REQUIREMENT_KEYS);
      }
      for (const w of ['staff-1', 'secret', 'price', 'radius', 'auditEvents', 'durationMinutes']) expect(res.body, `${r.operationId} ${w}`).not.toContain(w);
    }
  });

  it('a create answers 201 and ONLY a create does: update, status, replace, publish, retire and availability are 200', () => {
    expect(ROUTES.filter((r) => r.okStatus === 201).map((r) => r.operationId)).toEqual(['createGigTemplate', 'createGigTemplateVersion']);
  });
});

// ====================================================================== strict validation
describe('strict bodies, queries and params (400, standard envelope, never echoed, service never called)', () => {
  const SENTINEL = 'SENTINEL_VALUE_7c1e';

  it('rejects unknown fields, wrong types, coerced values and malformed bodies on every mutation', async () => {
    const t = await adminToken([WRITE]);
    for (const r of WRITES) {
      const good = r.body as Record<string, unknown>;
      const bad: unknown[] = [
        {},
        { ...good, extra: SENTINEL },
        { ...good, price: 5, durationMinutes: 30, radiusKm: 4, capacity: 2, floorPrice: 1 },
        { ...good, actor: SENTINEL, gigTemplateId: id(1), name: SENTINEL },
        { ...good, reason: '' },
        { ...good, reason: '   ' },
        { ...good, reason: `bad${String.fromCharCode(7)}${SENTINEL}` },
        { ...good, reason: SENTINEL.repeat(200) },
        { ...good, reason: 12 },
        { ...good, reason: [SENTINEL] },
        (({ reason: _r, ...rest }) => rest)(good),
        [good],
        [SENTINEL],
        SENTINEL,
        12345,
        true,
      ];
      for (const key of Object.keys(good)) {
        if (key === 'reason') continue;
        bad.push({ ...good, [key]: null });
        bad.push({ ...good, [key]: key === 'displayOrder' || key === 'expectedRevision' ? String(good[key]) : 'x' + SENTINEL });
        bad.push({ ...good, [key]: [SENTINEL] });
        bad.push({ ...good, [key]: { v: SENTINEL } });
      }
      if ('code' in good)
        bad.push(
          { ...good, code: 'Bad_Code' },
          { ...good, code: 'a' },
          { ...good, code: 'a'.repeat(49) },
          { ...good, code: 'ab__cd' },
          { ...good, code: `${SENTINEL}!` },
        );
      if ('serviceTypeCode' in good) bad.push({ ...good, serviceTypeCode: 'Bad' }, { ...good, serviceTypeCode: id(1) });
      if ('withDescription' in good) bad.push({ ...good, withDescription: 'true' }, { ...good, withDescription: 1 }, { ...good, withDescription: 0 });
      if ('enabled' in good) bad.push({ ...good, enabled: 'true' }, { ...good, enabled: 1 }, { ...good, enabled: null });
      if ('displayOrder' in good)
        bad.push(
          { ...good, displayOrder: '10' },
          { ...good, displayOrder: 0 },
          { ...good, displayOrder: 10000 },
          { ...good, displayOrder: 1.5 },
          { ...good, displayOrder: '1e3' },
        );
      if ('expectedRevision' in good)
        bad.push(
          { ...good, expectedRevision: 0 },
          { ...good, expectedRevision: -1 },
          { ...good, expectedRevision: 1.5 },
          { ...good, expectedRevision: '1' },
          { ...good, expectedRevision: '1e0' },
          { ...good, expectedRevision: true },
        );
      if ('copyFromVersion' in good)
        bad.push({ ...good, copyFromVersion: 0 }, { ...good, copyFromVersion: '2' }, { ...good, copyFromVersion: 1.5 }, { ...good, copyFromVersion: -2 });
      if ('status' in good)
        bad.push(
          { ...good, status: 'DRAFT' },
          { ...good, status: 'active' },
          { ...good, status: 'DELETED' },
          { ...good, status: null },
          { ...good, status: 1 },
        );
      if (r.fn === 'retireGigTemplateVersion')
        bad.push({ ...good, status: 'ACTIVE' }, { ...good, status: 'INACTIVE' }, { ...good, status: 'SUPERSEDED' }, { ...good, status: 'DRAFT' });
      if (r.fn === 'updateGigTemplate') bad.push({ reason: REASON });
      for (const payload of bad) {
        const res = await raw(r.method, r.url, t, JSON.stringify(payload));
        expect(res.statusCode, `${r.operationId} ${JSON.stringify(payload).slice(0, 120)}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
        expect(res.body, `${r.operationId} ${JSON.stringify(payload).slice(0, 80)}`).not.toContain(SENTINEL);
        expect(res.body).not.toContain('"stack"');
      }
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('rejects an invalid replace definition at the door: every field rule, every list rule (400 with the issue path, the value never echoed)', async () => {
    const t = await adminToken([WRITE]);
    const base = REPLACE_BODY;
    const withField = (f: Record<string, unknown>) => ({ ...base, fields: [f] });
    const cases: [string, unknown, string][] = [
      ['no pricing model', { ...base, pricingModels: [] }, 'pricingModels'],
      ['only an eligibility flag', { ...base, pricingModels: ['BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE'] }, 'pricingModels'],
      ['duplicate pricing model', { ...base, pricingModels: ['FIXED', 'FIXED'] }, 'pricingModels'],
      ['unknown pricing model', { ...base, pricingModels: ['HOURLY'] }, 'pricingModels.0'],
      ['no area mode', { ...base, areaModes: [] }, 'areaModes'],
      ['duplicate area mode', { ...base, areaModes: ['RADIUS', 'RADIUS'] }, 'areaModes'],
      ['unknown area mode', { ...base, areaModes: ['CIRCLE'] }, 'areaModes.0'],
      ['duplicate field keys', { ...base, fields: [FIELD_BODY, FIELD_BODY] }, 'fields'],
      ['61 fields', { ...base, fields: Array.from({ length: 61 }, (_, i) => ({ ...FIELD_BODY, fieldKey: `field_${i}` })) }, 'fields'],
      [
        '31 requirements',
        { ...base, requirements: Array.from({ length: 31 }, (_, i) => ({ requirementType: 'SKILL', referenceCode: `skill_${i}` })) },
        'requirements',
      ],
      ['duplicate requirement', { ...base, requirements: [{ requirementType: 'LICENSE' }, { requirementType: 'LICENSE' }] }, 'requirements'],
      ['duration order', { ...base, duration: { minMinutes: 90, maxMinutes: 30 } }, 'duration.maxMinutes'],
      ['duration zero', { ...base, duration: { minMinutes: 0 } }, 'duration.minMinutes'],
      ['duration unknown key', { ...base, duration: { minMinutes: 30, hours: 1 } }, 'duration'],
      ['text with numeric bounds', withField({ fieldKey: 'notes', fieldType: 'TEXT', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 1 }), 'fields.0.minNumber'],
      ['fixed text without default', withField({ fieldKey: 'notes', fieldType: 'TEXT', behavior: 'PLATFORM_FIXED' }), 'fields.0.behavior'],
      ['money fixed', withField({ fieldKey: 'amount', fieldType: 'MONEY', behavior: 'PLATFORM_FIXED' }), 'fields.0.behavior'],
      ['money with a bound', withField({ fieldKey: 'amount', fieldType: 'MONEY', behavior: 'PROVIDER_REQUIRED', maxNumber: 100 }), 'fields.0.minNumber'],
      ['integer fraction', withField({ fieldKey: 'count', fieldType: 'INTEGER', behavior: 'PROVIDER_REQUIRED', minNumber: 1.5 }), 'fields.0.minNumber'],
      ['duration zero minutes', withField({ fieldKey: 'minutes', fieldType: 'DURATION', behavior: 'PROVIDER_REQUIRED', minNumber: 0 }), 'fields.0.minNumber'],
      [
        'default above max',
        withField({ fieldKey: 'count', fieldType: 'INTEGER', behavior: 'PROVIDER_REQUIRED', maxNumber: 3, defaultNumber: 4 }),
        'fields.0.defaultNumber',
      ],
      [
        'enum duplicate options',
        withField({ fieldKey: 'kind', fieldType: 'ENUM', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'aa' }, { optionCode: 'aa' }] }),
        'fields.0.options',
      ],
      [
        'enum two defaults',
        withField({
          fieldKey: 'kind',
          fieldType: 'ENUM',
          behavior: 'PROVIDER_REQUIRED',
          options: [
            { optionCode: 'aa', isDefault: true },
            { optionCode: 'bb', isDefault: true },
          ],
        }),
        'fields.0.options',
      ],
      [
        'enum fixed without default option',
        withField({ fieldKey: 'kind', fieldType: 'ENUM', behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'aa' }] }),
        'fields.0.behavior',
      ],
      [
        'options on a text',
        withField({ fieldKey: 'notes', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED', options: [{ optionCode: 'aa' }] }),
        'fields.0.options',
      ],
      ['required media without minItems', withField({ fieldKey: 'photos_a', fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED' }), 'fields.0.minItems'],
      [
        'reference with maxItems 0',
        withField({ fieldKey: 'tools', fieldType: 'EQUIPMENT_REFERENCE', behavior: 'PROVIDER_REQUIRED', maxItems: 0 }),
        'fields.0.maxItems',
      ],
      ['bad field key', withField({ fieldKey: 'Bad_Key', fieldType: 'BOOLEAN', behavior: 'PROVIDER_REQUIRED' }), 'fields.0.fieldKey'],
      ['unknown field property', withField({ ...FIELD_BODY, price: 5 }), 'fields.0'],
      ['unknown behavior', withField({ ...FIELD_BODY, behavior: 'FIXED' }), 'fields.0.behavior'],
      ['null metadata', withField({ ...FIELD_BODY, defaultBoolean: null }), 'fields.0.defaultBoolean'],
    ];
    for (const [name, payload, issuePath] of cases) {
      const res = await call('PUT', '/gig-templates/full_detail/versions/3', t, payload);
      expect(res.statusCode, name).toBe(400);
      const e = errorOf(res);
      expect(e.category, name).toBe('VALIDATION');
      const issues = ((e.details ?? {}) as { issues?: { path: string }[] }).issues ?? [];
      expect(
        issues.map((i) => i.path),
        name,
      ).toEqual(expect.arrayContaining([issuePath]));
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('rejects `__proto__` / constructor keys, non-JSON text and a missing body without calling the service', async () => {
    const t = await adminToken([WRITE]);
    for (const r of WRITES) {
      const rawBody = JSON.stringify(r.body).slice(0, -1);
      for (const payload of [`${rawBody},"__proto__":{"admin":true}}`, `${rawBody},"constructor":{"prototype":{"x":1}}}`]) {
        const res = await raw(r.method, r.url, t, payload);
        expect(res.statusCode, `${r.operationId} ${payload.slice(-40)}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
      for (const [payload, type] of [
        ['{not json', 'application/json'],
        ['', 'application/json'],
        ['null', 'application/json'],
        ['"text"', 'application/json'],
        [`code=${SENTINEL}`, 'application/x-www-form-urlencoded'],
        [JSON.stringify(r.body), 'text/plain'],
      ] as const) {
        const res = await raw(r.method, r.url, t, payload, type);
        expect([400, 415], `${r.operationId} ${type} ${payload.slice(0, 20)}`).toContain(res.statusCode);
        expect(res.body).not.toContain(SENTINEL);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
      expect((await call(r.method, r.url, t)).statusCode, `${r.operationId} no body`).toBe(400);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('refuses a huge or deeply nested body with a client error, not a 5xx, and without calling the service', async () => {
    const t = await adminToken([WRITE]);
    const huge = 'x'.repeat(3 * 1024 * 1024);
    for (const r of [route('createGigTemplate'), route('replaceGigTemplateDraft'), route('publishGigTemplateVersion')]) {
      const res = await call(r.method, r.url, t, { ...(r.body as object), reason: huge });
      expect(res.statusCode, r.operationId).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, r.operationId).toBeLessThan(500);
      expect(res.body.length).toBeLessThan(2000);
    }
    for (const nested of ['['.repeat(200_000), `{"fields":${'['.repeat(200_000)}`, `{"a":`.repeat(50_000)]) {
      const res = await raw('PUT', '/gig-templates/full_detail/versions/3', t, nested);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    // 60 fields with 3 options each (180, under the 200 options a version may have) is a legal definition and stays a quick 200 (the schema cost is bounded)
    const fat = {
      ...REPLACE_BODY,
      fields: Array.from({ length: 60 }, (_, i) => ({
        fieldKey: `field_${i}`,
        fieldType: 'ENUM',
        behavior: 'PROVIDER_CONFIGURABLE',
        options: Array.from({ length: 3 }, (_, j) => ({ optionCode: `option_${j}` })),
      })),
    };
    const started = Date.now();
    expect((await call('PUT', '/gig-templates/full_detail/versions/3', t, fat)).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(gt.replaceGigTemplateDraft).toHaveBeenCalledTimes(1);
    // 201 options in total is refused before the service is called (400), however they are spread over the fields
    gt.replaceGigTemplateDraft.mockClear();
    const tooMany = {
      ...fat,
      fields: fat.fields.map((f, i) => (i === 0 ? { ...f, options: Array.from({ length: 24 }, (_, j) => ({ optionCode: `option_${j}` })) } : f)),
    };
    const refused = await call('PUT', '/gig-templates/full_detail/versions/3', t, tooMany);
    expect(refused.statusCode).toBe(400);
    expect(gt.replaceGigTemplateDraft).not.toHaveBeenCalled();
  });

  it.each([
    '01',
    '1.0',
    '+1',
    '1e0',
    '0',
    ' 1',
    '99999999999',
    '2147483648',
    '-1',
    '0x1',
    '1_0',
    'abc',
    '1.',
    '1%2C0',
    '१',
    '%EF%BC%91',
    '1%00',
    '1%0A',
    '1e3',
    '00',
    '1 ',
    '١',
  ])('a version path parameter of %j is a 400 on every route that takes one (after authorization, before the service)', async (v) => {
    const t = await adminToken([READ, WRITE]);
    const encoded = v.includes('%') ? v : encodeURIComponent(v).replace(/%2B/g, '+');
    for (const r of VERSION_ROUTES) {
      const url = r.url.replace('/versions/3', `/versions/${encoded}`);
      const res = await call(r.method, url, t, r.method === 'GET' ? undefined : r.body);
      expect(res.statusCode, `${r.method} ${url}`).toBe(400);
      const e = errorOf(res);
      expect(e.category).toBe('VALIDATION');
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(e.details)).toContain('params.version');
      expect(res.body).not.toContain('99999999999');
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('accepts the canonical version numbers 1 and 2147483647 and passes them on as numbers; one above the bound is refused', async () => {
    const t = await adminToken([READ, WRITE]);
    for (const [v, ok] of [
      ['1', true],
      ['2', true],
      ['10', true],
      ['2147483647', true],
      ['2147483648', false],
    ] as const) {
      const g = await call('GET', `/gig-templates/full_detail/versions/${v}`, t);
      expect(g.statusCode === 400, `GET ${v}`).toBe(!ok);
      const p = await call('POST', `/gig-templates/full_detail/versions/${v}/publish`, t, { expectedRevision: 1, reason: REASON });
      expect(p.statusCode === 400, `publish ${v}`).toBe(!ok);
    }
    expect(gt.getGigTemplateVersion).toHaveBeenCalledWith('full_detail', 2_147_483_647);
    expect(gt.publishGigTemplateVersion).toHaveBeenCalledWith('full_detail', 2_147_483_647, expect.anything(), 'admin-a');
    for (const [, n] of gt.getGigTemplateVersion.mock.calls) expect(typeof n).toBe('number');
  });

  it('validates the code and market path parameters: canonical, `__proto__`, case, length, encoded newline and percent-encoding are refused', async () => {
    const t = await adminToken([READ, WRITE]);
    const badCodes = [
      'Bad',
      'BAD_CODE',
      'a',
      'a'.repeat(49),
      'ab__cd',
      '_ab',
      'ab_',
      '1ab',
      '__proto__',
      'ab%0A',
      'ab%20cd',
      'ab%2Fcd',
      'caf%C3%A9',
      'ab-cd',
      'ab.cd',
      '%00ab',
    ];
    const forms = (c: string): [Method, string, unknown?][] => [
      ['GET', `/gig-templates/${c}?market=us-sf`],
      ['GET', `/service-types/${c}/gig-templates?market=us-sf`],
      ['GET', `/gig-templates/${c}/versions/1`],
      ['PATCH', `/gig-templates/${c}`, { withDescription: true, reason: REASON }],
      ['PUT', `/gig-templates/${c}/status`, { status: 'ACTIVE', reason: REASON }],
      ['POST', `/gig-templates/${c}/versions`, { reason: REASON }],
      ['PUT', `/gig-templates/${c}/versions/1`, REPLACE_BODY],
      ['POST', `/gig-templates/${c}/versions/1/publish`, { expectedRevision: 1, reason: REASON }],
      ['PUT', `/gig-templates/${c}/versions/1/status`, { status: 'RETIRED', reason: REASON }],
      ['PUT', `/markets/us-sf/gig-templates/${c}`, { enabled: true, displayOrder: 5, reason: REASON }],
    ];
    for (const c of badCodes)
      for (const [m, u, b] of forms(c)) {
        const res = await call(m, u, t, b);
        expect(res.statusCode, `${m} ${u}`).toBe(400);
        expect(errorOf(res).category).toBe('VALIDATION');
      }
    for (const mk of ['US-SF', 'us_sf', '-us', 'us--sf', '1us', 'a'.repeat(61), '__proto__', 'us%0A', 'us%20sf']) {
      const res = await call('PUT', `/markets/${mk}/gig-templates/full_detail`, t, { enabled: true, displayOrder: 5, reason: REASON });
      expect(res.statusCode, mk).toBe(400);
    }
    expect(noServiceCalled()).toBe(true);
    // the longest valid code is routed to the service
    expect((await call('GET', `/gig-templates/${'a'.repeat(48)}?market=us-sf`)).statusCode).toBe(404);
    expect(gt.getGigTemplateForMarket).toHaveBeenCalledTimes(1);
  });

  it('validates the query of the shared reads: unknown parameters, arrays, bad market/locale/serviceType, `__proto__` are 400 for anonymous AND for privileged callers', async () => {
    const t = await adminToken([READ]);
    const urls = (q: string): string[] => [`/gig-templates?${q}`, `/gig-templates/full_detail?${q}`, `/service-types/car_detailing/gig-templates?${q}`];
    const badQueries = [
      'market=us-sf&bogus=1',
      'market=US-SF',
      'market=us_sf',
      'market=',
      'market=us-sf&market=mx-cdmx',
      'market[]=us-sf',
      'market=us-sf&locale=en_US',
      'market=us-sf&locale=EN-us',
      'market=us-sf&locale=',
      'market=us-sf&locale=en-US&locale=es-US',
      `market=us-sf&locale=${'a'.repeat(25)}`,
      'market=us-sf&status=ACTIVE',
      'market=us-sf&enabled=true',
      'market=us-sf&version=1',
      'market=us-sf&category=auto_services',
      '__proto__=1&market=us-sf',
      'market=us-sf&constructor=1',
      `market=${'a'.repeat(61)}`,
    ];
    for (const token of [undefined, t])
      for (const q of badQueries)
        for (const u of urls(q)) {
          const res = await call('GET', u, token);
          expect(res.statusCode, `${token ? 'mgmt' : 'anon'} ${u}`).toBe(400);
          expect(errorOf(res).category).toBe('VALIDATION');
        }
    for (const token of [undefined, t])
      for (const q of [
        'serviceType=Bad&market=us-sf',
        'serviceType=a&market=us-sf',
        'serviceType=&market=us-sf',
        'serviceType=car_detailing&serviceType=regular_cleaning&market=us-sf',
        'serviceType[]=car_detailing',
      ])
        expect((await call('GET', `/gig-templates?${q}`, token)).statusCode, `list ${q}`).toBe(400);
    // `serviceType` is accepted ONLY by the list
    for (const u of [
      '/gig-templates/full_detail?market=us-sf&serviceType=car_detailing',
      '/service-types/car_detailing/gig-templates?market=us-sf&serviceType=car_detailing',
    ])
      expect((await call('GET', u)).statusCode, u).toBe(400);
    expect(noServiceCalled()).toBe(true);
    expect(noContentCalled()).toBe(true);
  });

  it('answers 401 for a credential that is presented but invalid on the shared reads (never silently downgraded to anonymous), with `Vary: Authorization`', async () => {
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    const unsigned = unsignedToken({ azp: 'bananagig-admin' });
    for (const url of [
      '/gig-templates?market=us-sf',
      '/gig-templates/full_detail?market=us-sf',
      '/service-types/car_detailing/gig-templates?market=us-sf',
      '/gig-templates',
    ]) {
      for (const bad of ['not.a.token', expired, unsigned]) {
        const res = await call('GET', url, bad);
        expect(res.statusCode, url).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers.vary).toMatch(/authorization/i);
      }
      const basic = await app.inject({ method: 'GET', url: `/api/v1/catalog${url}`, headers: { authorization: 'Basic abc' } });
      expect(basic.statusCode, `${url} basic`).toBe(401);
    }
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== headers
describe('headers: Vary, cache policy, correlation id', () => {
  const noStore = /private, no-store/;
  it('every response of a shared read carries `Vary: Authorization`: 200, 400, 401, 404, with and without a token (and it is kept once)', async () => {
    const t = await adminToken([READ]);
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const cases: [string, string | undefined, number][] = [
      ['/gig-templates?market=us-sf', undefined, 200],
      ['/gig-templates?market=us-sf', t, 200],
      ['/gig-templates?market=us-sf', customer, 200],
      ['/gig-templates/full_detail?market=us-sf', undefined, 200],
      ['/service-types/car_detailing/gig-templates?market=us-sf', undefined, 200],
      ['/gig-templates/full_detail', t, 200],
      ['/gig-templates', undefined, 400],
      ['/gig-templates?market=us-sf&bogus=1', undefined, 400],
      ['/gig-templates/Bad?market=us-sf', undefined, 400],
      ['/gig-templates?market=us-sf', 'garbage', 401],
      ['/gig-templates?market=la-oc', undefined, 404],
      ['/gig-templates/draft_tpl?market=us-sf', undefined, 404],
      ['/service-types/draft_st/gig-templates?market=us-sf', undefined, 404],
    ];
    for (const [url, token, status] of cases) {
      const res = await call('GET', url, token);
      expect(res.statusCode, `${url} ${token ? 'token' : 'anon'}`).toBe(status);
      expect(res.headers.vary, `${url} ${status}`).toMatch(/\bauthorization\b/i);
      expect(
        String(res.headers.vary)
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s === 'authorization'),
      ).toHaveLength(1);
    }
  });

  it('the management view, the version read and EVERY mutation (success and failure) are `Cache-Control: private, no-store`; the public view is not', async () => {
    const t = await adminToken([READ, WRITE]);
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    for (const url of [
      '/gig-templates',
      '/gig-templates/full_detail',
      '/service-types/car_detailing/gig-templates',
      '/gig-templates?market=us-sf',
      '/gig-templates/full_detail?market=us-sf',
      '/service-types/car_detailing/gig-templates?market=la-oc',
      '/gig-templates/full_detail/versions/3',
    ])
      expect(String((await call('GET', url, t)).headers['cache-control']), `${url} management`).toMatch(noStore);
    // management errors too
    for (const url of [
      '/gig-templates/nope_tpl',
      '/gig-templates/full_detail/versions/9',
      '/gig-templates/nope_tpl/versions/3',
      '/gig-templates?market=nowhere',
      '/gig-templates/full_detail/versions/01',
    ])
      expect(String((await call('GET', url, t)).headers['cache-control']), `${url} management error`).toMatch(noStore);
    for (const r of WRITES) {
      const ok = await call(r.method, r.url, t, r.body);
      expect(ok.statusCode).toBe(r.okStatus);
      expect(String(ok.headers['cache-control']), `${r.operationId} ok`).toMatch(noStore);
      const invalid = await call(r.method, r.url, t, { nope: 1 });
      expect(invalid.statusCode).toBe(400);
      expect(String(invalid.headers['cache-control']), `${r.operationId} 400`).toMatch(noStore);
      const denied = await call(r.method, r.url, await adminToken([READ]), r.body);
      expect(denied.statusCode).toBe(403);
      expect(String(denied.headers['cache-control']), `${r.operationId} 403`).toMatch(noStore);
      const anon = await call(r.method, r.url, undefined, r.body);
      expect(anon.statusCode).toBe(401);
      expect(String(anon.headers['cache-control']), `${r.operationId} 401`).toMatch(noStore);
      gt[r.fn].mockRejectedValueOnce(new CatalogError('CONFLICT', 'fixed', { reason: 'STALE_DRAFT' }));
      const conflict = await call(r.method, r.url, t, r.body);
      expect(conflict.statusCode).toBe(409);
      expect(String(conflict.headers['cache-control']), `${r.operationId} 409`).toMatch(noStore);
    }
    for (const token of [undefined, customer])
      for (const url of ['/gig-templates?market=us-sf', '/gig-templates/full_detail?market=us-sf', '/service-types/car_detailing/gig-templates?market=us-sf'])
        expect(String((await call('GET', url, token)).headers['cache-control'] ?? ''), `${url} public`).not.toMatch(noStore);
  });

  it('never marks a Gig Template response as publicly cacheable by the server and sets no cookie', async () => {
    const t = await adminToken([READ, WRITE]);
    const responses = [
      await call('GET', '/gig-templates?market=us-sf'),
      await call('GET', '/gig-templates?market=us-sf', t),
      await call('GET', '/gig-templates/full_detail/versions/3', t),
      await call('POST', '/gig-templates', t, route('createGigTemplate').body),
      await call('GET', '/gig-templates'),
      await call('GET', '/gig-templates?market=la-oc'),
    ];
    for (const r of responses) {
      expect(String(r.headers['cache-control'] ?? ''), `${r.statusCode}`).not.toMatch(/public|s-maxage/i);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('echoes the correlation id in the header and in the meta / error envelope', async () => {
    const t = await adminToken([READ, WRITE]);
    const ok = await call('GET', '/gig-templates?market=us-sf', undefined, undefined, { 'x-correlation-id': 'corr-gt-1' });
    expect(ok.json().meta.correlationId).toBe('corr-gt-1');
    expect(ok.headers['x-correlation-id']).toBe('corr-gt-1');
    const created = await call('POST', '/gig-templates', t, route('createGigTemplate').body, { 'x-correlation-id': 'corr-gt-2' });
    expect(created.json().meta.correlationId).toBe('corr-gt-2');
    const version = await call('GET', '/gig-templates/full_detail/versions/3', t, undefined, { 'x-correlation-id': 'corr-gt-3' });
    expect(version.json().meta.correlationId).toBe('corr-gt-3');
    const missing = await call('GET', '/gig-templates/draft_tpl?market=us-sf', undefined, undefined, { 'x-correlation-id': 'corr-gt-4' });
    expect(errorOf(missing).correlationId).toBe('corr-gt-4');
    const badVersion = await call('GET', '/gig-templates/full_detail/versions/01', t, undefined, { 'x-correlation-id': 'corr-gt-5' });
    expect(errorOf(badVersion).correlationId).toBe('corr-gt-5');
  });
});

// ====================================================================== the public view
describe('the PUBLIC view (anonymous and every caller without catalog-read)', () => {
  const callers = async () => [
    { token: undefined as string | undefined, label: 'anonymous' },
    { token: await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } }), label: 'customer' },
    {
      token: await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } }),
      label: 'web client with the role names',
    },
    { token: await adminToken(['content-read', 'configuration-read', 'geography-read']), label: 'admin without catalog roles' },
  ];
  const walk = (o: unknown, fn: (k: string, v: unknown) => void): void => {
    if (Array.isArray(o)) o.forEach((x) => walk(x, fn));
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) {
        fn(k, v);
        walk(v, fn);
      }
  };

  it('REQUIRES the market on all three reads (400 MARKET_REQUIRED, field market) for anonymous callers and for tokens without catalog-read; the service is not asked', async () => {
    for (const { token, label } of await callers())
      for (const u of [
        '/gig-templates',
        '/gig-templates/full_detail',
        '/service-types/car_detailing/gig-templates',
        '/gig-templates?serviceType=car_detailing',
        '/gig-templates?locale=en-US',
      ]) {
        const res = await call('GET', u, token);
        expect(res.statusCode, `${label} ${u}`).toBe(400);
        expect(errorOf(res)).toMatchObject({
          category: 'VALIDATION',
          code: 'CATALOG_VALIDATION_FAILED',
          details: { reason: 'MARKET_REQUIRED', field: 'market' },
        });
      }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers a market that is not public (unknown, PLANNED, INACTIVE: the same for all) with 404 CATALOG_MARKET_NOT_FOUND on all three reads, identical to each other', async () => {
    for (const { token, label } of await callers()) {
      const answers: unknown[] = [];
      for (const market of ['la-oc', 'nowhere', 'old-mkt', 'devtest-x'])
        for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) {
          const res = await call('GET', `${u}?market=${market}`, token);
          expect(res.statusCode, `${label} ${u} ${market}`).toBe(404);
          expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'CATALOG_MARKET_NOT_FOUND' });
          const { correlationId: _c, ...rest } = errorOf(res);
          answers.push({ ...rest, details: { ...(rest.details as object), code: '*' } });
        }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size, label).toBe(1);
    }
    expect(content.resolveRendered).not.toHaveBeenCalled();
  });

  it('a template that is not public is the same 404 as one that does not exist (draft, retired, unknown)', async () => {
    const answers = new Set<string>();
    for (const code of ['draft_tpl', 'retired_tpl', 'nope_tpl', 'a'.repeat(48)]) {
      const res = await call('GET', `/gig-templates/${code}?market=us-sf`);
      expect(res.statusCode, code).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'CATALOG_GIG_TEMPLATE_NOT_FOUND' });
      const { correlationId: _c, details, ...rest } = errorOf(res);
      answers.add(JSON.stringify({ ...rest, details: { ...(details as object), code: '*' } }));
    }
    expect(answers.size).toBe(1);
    // the same for a version that does not exist or is not the public one: the version read is not public at all
    expect((await call('GET', '/gig-templates/full_detail/versions/3')).statusCode).toBe(401);
  });

  it('lists the public templates in the order of the market with ONLY the public fields (exact key sets at every level, no status, enabled, revision, content keys, timestamps, audit)', async () => {
    const list = await call('GET', '/gig-templates?market=us-sf');
    expect(list.statusCode).toBe(200);
    expect(codesOf(list)).toEqual(['full_detail', 'standard_clean']); // unnamed_tpl is omitted: it has no published name
    for (const t of list.json().data) {
      expect(keysOf(t)).toEqual(PUBLIC_LIST_KEYS);
      expect(keysOf(t.activeVersion)).toEqual(PUBLIC_SUMMARY_KEYS);
      expect(keysOf(t.activeVersion.duration)).toEqual(['maxMinutes', 'minMinutes', 'suggestedMinutes']);
      expect(t).not.toHaveProperty('instructions');
    }
    expect(list.json().data[0]).toEqual({
      gigTemplateId: id(2),
      code: 'full_detail',
      serviceTypeCode: 'car_detailing',
      categoryCode: 'auto_services',
      name: textOf(gigTemplateNameKey('full_detail'), 'en-US'),
      description: textOf(gigTemplateDescriptionKey('full_detail'), 'en-US'),
      displayOrder: 10,
      activeVersion: {
        gigTemplateVersionId: id(102),
        versionNumber: 2,
        duration: { minMinutes: 60, maxMinutes: 300, suggestedMinutes: 120 },
        pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
        areaModes: ['RADIUS', 'POSTAL_CODES'],
        fieldCount: FD_FIELDS.length,
      },
    });
    expect(list.json().data[1]).toMatchObject({ code: 'standard_clean', description: null, displayOrder: 20 });
    expect(list.json().data[1].activeVersion.duration).toEqual({ minMinutes: null, maxMinutes: null, suggestedMinutes: null });
    expect(keysOf(list.json().meta)).toEqual(['correlationId']);
    expect(gt.listGigTemplatesForMarket).toHaveBeenCalledWith('us-sf', { serviceTypeCode: undefined });
    expect(gt.listGigTemplates).not.toHaveBeenCalled();
    expect(gt.getGigTemplate).not.toHaveBeenCalled();
  });

  it('the detail has the full structure with ONLY the public fields at every level (template, version, field, option, requirement)', async () => {
    const res = await call('GET', '/gig-templates/full_detail?market=us-sf');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(keysOf(d)).toEqual(PUBLIC_DETAIL_KEYS);
    expect(keysOf(d.activeVersion)).toEqual(PUBLIC_VERSION_KEYS);
    expect(d.instructions).toBe(textOf(gigTemplateInstructionsKey('full_detail'), 'en-US'));
    expect(d.activeVersion.fields).toHaveLength(FD_FIELDS.length);
    for (const f of d.activeVersion.fields) {
      expect(keysOf(f), f.fieldKey).toEqual(PUBLIC_FIELD_KEYS);
      for (const o of f.options) expect(keysOf(o)).toEqual(PUBLIC_OPTION_KEYS);
    }
    for (const q of d.activeVersion.requirements) expect(keysOf(q)).toEqual(REQUIREMENT_KEYS);
    expect(d.activeVersion.requirements).toEqual([
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'detailing_basic' },
    ]);
    // the typed metadata is carried as is
    const byKey = Object.fromEntries(d.activeVersion.fields.map((f: { fieldKey: string }) => [f.fieldKey, f]));
    expect(byKey.vehicle_count).toMatchObject({
      fieldType: 'INTEGER',
      behavior: 'PROVIDER_REQUIRED',
      minNumber: 1,
      maxNumber: 4,
      defaultNumber: 1,
      minLength: null,
      minItems: null,
    });
    expect(byKey.size_factor).toMatchObject({ fieldType: 'DECIMAL', minNumber: 0.5, maxNumber: 2.25, defaultNumber: 1.5 });
    expect(byKey.eco_friendly).toMatchObject({ fieldType: 'BOOLEAN', defaultBoolean: true, customerVisible: false });
    expect(byKey.detail_minutes).toMatchObject({ fieldType: 'DURATION', minNumber: 30, maxNumber: 480, defaultNumber: 120 });
    expect(byKey.scope_notes).toMatchObject({ behavior: 'PLATFORM_FIXED', section: 'SCOPE', minLength: 20, maxLength: 2000 });
    expect(byKey.scope_notes.defaultText).toBe(textOf(gigTemplateFieldDefaultKey('full_detail', 'scope_notes'), 'en-US'));
    expect(byKey.scope_notes.help).toBe(textOf(gigTemplateFieldHelpKey('full_detail', 'scope_notes'), 'en-US'));
    expect(
      byKey.wax_type.options.map((o: { optionCode: string; isDefault: boolean; displayOrder: number }) => [o.optionCode, o.isDefault, o.displayOrder]),
    ).toEqual([
      ['carnauba', true, 1],
      ['synthetic', false, 2],
    ]);
    expect(byKey.base_amount).toMatchObject({ fieldType: 'MONEY', minNumber: null, maxNumber: null, defaultNumber: null });
    expect(gt.getGigTemplateForMarket).toHaveBeenCalledWith('us-sf', 'full_detail');
  });

  it('the service-type list answers the templates of that service type only, after a service type check in the same market', async () => {
    const res = await call('GET', '/service-types/car_detailing/gig-templates?market=us-sf');
    expect(res.statusCode).toBe(200);
    expect(codesOf(res)).toEqual(['full_detail']);
    for (const t of res.json().data) expect(keysOf(t)).toEqual(PUBLIC_LIST_KEYS);
    expect(catalog.getServiceTypeForMarket).toHaveBeenCalledWith('us-sf', 'car_detailing');
    expect(gt.listGigTemplatesForMarket).toHaveBeenCalledWith('us-sf', { serviceTypeCode: 'car_detailing' });
    expect(catalog.getServiceType).not.toHaveBeenCalled();
    expect(gt.listGigTemplates).not.toHaveBeenCalled();
    // a service type that is not public in the market is a 404 (not an empty list), the templates are never asked
    gt.listGigTemplatesForMarket.mockClear();
    for (const st of ['draft_st', 'nope_st']) {
      const r = await call('GET', `/service-types/${st}/gig-templates?market=us-sf`);
      expect(r.statusCode, st).toBe(404);
      expect(errorOf(r).code).toBe('CATALOG_SERVICE_TYPE_NOT_FOUND');
    }
    expect(gt.listGigTemplatesForMarket).not.toHaveBeenCalled();
    // the optional filter of the list
    const filtered = await call('GET', '/gig-templates?market=us-sf&serviceType=regular_cleaning');
    expect(codesOf(filtered)).toEqual(['standard_clean']);
    expect(gt.listGigTemplatesForMarket).toHaveBeenCalledWith('us-sf', { serviceTypeCode: 'regular_cleaning' });
    expect(codesOf(await call('GET', '/gig-templates?market=us-sf&serviceType=nope_st'))).toEqual([]);
  });

  it('the mediaRule is derived per field: PROHIBITED (maxItems 0), REQUIRED (provider required), OPTIONAL, and null for every non-media field', async () => {
    const d = (await call('GET', '/gig-templates/full_detail?market=us-sf')).json().data;
    const rule = Object.fromEntries(d.activeVersion.fields.map((f: { fieldKey: string; mediaRule: string | null }) => [f.fieldKey, f.mediaRule]));
    expect(rule).toEqual({
      scope_notes: null,
      wax_type: null,
      vehicle_count: null,
      detail_minutes: null,
      eco_friendly: null,
      base_amount: null,
      before_photos: 'REQUIRED',
      after_photos: 'OPTIONAL',
      interior_photos: 'PROHIBITED',
      skills: null,
      size_factor: null,
    });
  });

  it('never exposes a management, audit or provider field even if the service returned them (defense in depth)', async () => {
    const dirtyOption = { ...FD_FIELDS[1]!.options[0]!, actor: 'staff-1', price: 3 };
    const dirtyField = { ...FD_FIELDS[1]!, options: [dirtyOption], status: 'DRAFT', actor: 'staff-1', price: 3 };
    const dirtyVersion = {
      ...version(2, 'ACTIVE'), // the MANAGEMENT summary: status, revision, timestamps
      fields: [dirtyField],
      requirements: [{ requirementType: 'LICENSE', referenceCode: null, actor: 'staff-1' }],
      actor: 'staff-1',
      auditEvents: [{ actor: 'staff-1' }],
      price: 3,
    };
    const dirty = {
      ...TEMPLATES[1]!,
      displayOrder: 10,
      enabled: false,
      actor: 'staff-1',
      auditEvents: [{ actor: 'staff-1' }],
      price: 5,
      radius: 5,
      capacity: 3,
      activeVersion: dirtyVersion,
    };
    gt.listGigTemplatesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, templates: [dirty] });
    gt.getGigTemplateForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, template: dirty });
    for (const u of ['/gig-templates?market=us-sf', '/gig-templates/full_detail?market=us-sf', '/service-types/car_detailing/gig-templates?market=us-sf']) {
      const r = await call('GET', u);
      expect(r.statusCode, u).toBe(200);
      const item = Array.isArray(r.json().data) ? r.json().data[0] : r.json().data;
      const detail = !Array.isArray(r.json().data);
      expect(keysOf(item), u).toEqual(detail ? PUBLIC_DETAIL_KEYS : PUBLIC_LIST_KEYS);
      expect(keysOf(item.activeVersion), u).toEqual(detail ? PUBLIC_VERSION_KEYS : PUBLIC_SUMMARY_KEYS);
      if (detail) {
        expect(keysOf(item.activeVersion.fields[0])).toEqual(PUBLIC_FIELD_KEYS);
        expect(keysOf(item.activeVersion.fields[0].options[0])).toEqual(PUBLIC_OPTION_KEYS);
        expect(keysOf(item.activeVersion.requirements[0])).toEqual(REQUIREMENT_KEYS);
      }
      for (const w of [
        'staff-1',
        'DRAFT',
        'price',
        'radius',
        'capacity',
        'auditEvents',
        'revision',
        'publishedAt',
        'closedAt',
        'createdAt',
        'updatedAt',
        'ContentKey',
        '"status"',
        '"enabled"',
      ])
        expect(r.body, `${u} ${w}`).not.toContain(w);
      expect(r.body).not.toContain('catalog.gig_template.');
    }
  });

  it('no key of any public response is a management or internal word, at any depth, for the full fixture', async () => {
    for (const u of ['/gig-templates?market=us-sf', '/gig-templates/full_detail?market=us-sf', '/gig-templates/standard_clean?market=us-sf']) {
      const r = await call('GET', u);
      walk(r.json().data, (k) => {
        expect(
          ['status', 'enabled', 'revision', 'createdAt', 'updatedAt', 'publishedAt', 'closedAt', 'versions', ...INTERNAL_WORDS],
          `${u} ${k}`,
        ).not.toContain(k);
        expect(k, `${u} ${k}`).not.toMatch(/ContentKey$/);
      });
    }
  });

  it('resolves ALL texts with ONE resolveRendered call: market in the context, includeInternal FALSE, the market default locale, unique keys', async () => {
    await call('GET', '/gig-templates?market=us-sf');
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const [keysArg, opts] = content.resolveRendered.mock.calls[0]!;
    expect(opts).toEqual({ locale: 'en-US', context: { market: 'us-sf' }, includeInternal: false });
    expect(new Set(keysArg).size).toBe(keysArg.length);
    // the list asks for the names and descriptions of the templates; NOT the instructions, NOT the labels of the fields
    const expected = TEMPLATES.filter((t) => PUBLIC_CODES.includes(t.code)).flatMap((t) => [
      t.nameContentKey,
      ...(t.descriptionContentKey ? [t.descriptionContentKey] : []),
    ]);
    expect([...keysArg].sort()).toEqual([...expected].sort());
    expect(keysArg.some((k: string) => k.endsWith('.instructions') || k.includes('.field.'))).toBe(false);
    expect(content.listLocales).not.toHaveBeenCalled(); // the market supplies the default locale
    content.resolveRendered.mockClear();
    await call('GET', '/service-types/car_detailing/gig-templates?market=mx-cdmx');
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    expect(content.resolveRendered.mock.calls[0]![1]).toEqual({ locale: 'es-MX', context: { market: 'mx-cdmx' }, includeInternal: false });
  });

  it('asks the registry for each key ONCE even when the service lists a key twice (two templates sharing copy)', async () => {
    const full = publicTpl(TEMPLATES[1]!);
    gt.listGigTemplatesForMarket.mockResolvedValue({
      market: { code: 'us-sf', defaultLocale: 'en-US' },
      templates: [full, { ...full, code: 'twin_tpl', gigTemplateId: id(9) }],
    });
    const r = await call('GET', '/gig-templates?market=us-sf');
    expect(r.json().data.map((t: { code: string }) => t.code)).toEqual(['full_detail', 'twin_tpl']);
    const keysArg = content.resolveRendered.mock.calls[0]![0] as string[];
    expect(keysArg).toHaveLength(2);
    expect(new Set(keysArg).size).toBe(2);
  });

  it('the detail resolves name, description, instructions and every label, help, default text and option label of the version in ONE call', async () => {
    await call('GET', '/gig-templates/full_detail?market=us-sf');
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const [keysArg, opts] = content.resolveRendered.mock.calls[0]!;
    expect(opts).toEqual({ locale: 'en-US', context: { market: 'us-sf' }, includeInternal: false });
    expect(new Set(keysArg).size).toBe(keysArg.length);
    const expected = [
      gigTemplateNameKey('full_detail'),
      gigTemplateDescriptionKey('full_detail'),
      gigTemplateInstructionsKey('full_detail'),
      ...versionKeys(TEMPLATES[1]!.activeVersion),
    ];
    expect([...keysArg].sort()).toEqual([...new Set(expected)].sort());
    expect(keysArg).toContain(gigTemplateOptionLabelKey('full_detail', 'wax_type', 'carnauba'));
    expect(keysArg).toContain(gigTemplateFieldDefaultKey('full_detail', 'scope_notes'));
    expect(keysArg).toContain(gigTemplateFieldHelpKey('full_detail', 'scope_notes'));
    expect(keysArg).toContain(gigTemplateFieldLabelKey('full_detail', 'base_amount'));
  });

  it('uses the locale of the request when given, otherwise the default locale of the MARKET (not the platform default)', async () => {
    const mx = await call('GET', '/gig-templates?market=mx-cdmx');
    expect(mx.json().data[0].name).toBe(textOf(gigTemplateNameKey('full_detail'), 'es-MX'));
    const es = await call('GET', '/gig-templates?market=us-sf&locale=es-US');
    expect(es.json().data[0].name).toBe(textOf(gigTemplateNameKey('full_detail'), 'es-US'));
    const explicitOverMarket = await call('GET', '/gig-templates/full_detail?market=mx-cdmx&locale=en-US');
    expect(explicitOverMarket.json().data.name).toBe(textOf(gigTemplateNameKey('full_detail'), 'en-US'));
    expect(explicitOverMarket.json().data.activeVersion.fields[0].label).toBe(textOf(gigTemplateFieldLabelKey('full_detail', 'scope_notes'), 'en-US'));
    expect(content.resolveRendered.mock.calls.map((c) => c[1].locale)).toEqual(['es-MX', 'es-US', 'en-US']);
    expect(content.listLocales).not.toHaveBeenCalled();
  });

  it('falls back to the PLATFORM default locale when the market has none and the request names none', async () => {
    gt.listGigTemplatesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: undefined }, templates: [publicTpl(TEMPLATES[1]!)] });
    const r = await call('GET', '/gig-templates?market=us-sf');
    expect(r.json().data[0].name).toBe(textOf(gigTemplateNameKey('full_detail'), 'en-US'));
    expect(content.listLocales).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('OMITS a template whose NAME has no published text (list) and answers 404 for it (detail); a missing description or instructions is null, not a failure', async () => {
    const list = await call('GET', '/gig-templates?market=us-sf');
    expect(codesOf(list)).not.toContain('unnamed_tpl');
    const one = await call('GET', '/gig-templates/unnamed_tpl?market=us-sf');
    expect(one.statusCode).toBe(404);
    expect(errorOf(one)).toMatchObject({ category: 'NOT_FOUND', code: 'CATALOG_GIG_TEMPLATE_NOT_FOUND' });
    expect(one.body).not.toContain('catalog.gig_template.');
    const st = await call('GET', '/service-types/regular_cleaning/gig-templates?market=us-sf');
    expect(codesOf(st)).toEqual(['standard_clean']);
    // a template with neither description nor instructions linked
    const clean = (await call('GET', '/gig-templates/standard_clean?market=us-sf')).json().data;
    expect(clean).toMatchObject({ description: null, instructions: null });
    // a linked description whose text is withdrawn is null
    UNTEXTED.add(gigTemplateDescriptionKey('full_detail'));
    UNTEXTED.add(gigTemplateInstructionsKey('full_detail'));
    try {
      const d = (await call('GET', '/gig-templates/full_detail?market=us-sf')).json().data;
      expect(d).toMatchObject({ description: null, instructions: null });
      expect(d.name).toBe(textOf(gigTemplateNameKey('full_detail'), 'en-US'));
    } finally {
      UNTEXTED.delete(gigTemplateDescriptionKey('full_detail'));
      UNTEXTED.delete(gigTemplateInstructionsKey('full_detail'));
    }
    // nothing resolved at all: an empty list, not an error
    content.resolveRendered.mockResolvedValue({ items: new Map(), sources: new Map(), missing: new Map(), at: new Date() });
    const empty = await call('GET', '/gig-templates?market=us-sf');
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toEqual([]);
  });

  it('falls back to the field KEY and the option CODE for a label that has no published text (public), never to a content key', async () => {
    const d = (await call('GET', '/gig-templates/full_detail?market=us-sf')).json().data;
    const skills = d.activeVersion.fields.find((f: { fieldKey: string }) => f.fieldKey === 'skills');
    expect(skills.label).toBe('skills');
    const wax = d.activeVersion.fields.find((f: { fieldKey: string }) => f.fieldKey === 'wax_type');
    expect(wax.options.map((o: { optionCode: string; label: string }) => [o.optionCode, o.label])).toEqual([
      ['carnauba', textOf(gigTemplateOptionLabelKey('full_detail', 'wax_type', 'carnauba'), 'en-US')],
      ['synthetic', 'synthetic'],
    ]);
    expect(wax.help).toBeNull(); // the help text is not published: null
    expect(d.activeVersion.fields.find((f: { fieldKey: string }) => f.fieldKey === 'eco_friendly').label).toBe(
      textOf(gigTemplateFieldLabelKey('full_detail', 'eco_friendly'), 'en-US'),
    );
    expect(JSON.stringify(d)).not.toContain('catalog.gig_template.');
  });

  it('treats a text that resolved as html (not plain text) as unresolved: the template is omitted, never rendered as markup', async () => {
    content.resolveRendered.mockImplementation(async (ks: string[]) => ({
      items: new Map(ks.map((k) => [k, { format: 'html', value: '<b>bold</b>' }])),
      sources: new Map(),
      missing: new Map(),
      at: new Date(),
    }));
    const r = await call('GET', '/gig-templates?market=us-sf');
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([]);
    expect(r.body).not.toContain('<b>');
    const d = await call('GET', '/gig-templates/full_detail?market=us-sf');
    expect(d.statusCode).toBe(404);
  });

  it('a content outage is a generic 503 CATALOG_UNAVAILABLE on EVERY public read (never an empty 200, never a misleading 404), without the cause', async () => {
    content.resolveRendered.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2'));
    for (const u of ['/gig-templates?market=us-sf', '/gig-templates/full_detail?market=us-sf', '/service-types/car_detailing/gig-templates?market=us-sf'])
      for (const { token } of await callers()) {
        const r = await call('GET', u, token);
        expect(r.statusCode, u).toBe(503);
        expect(errorOf(r)).toMatchObject({ category: 'DEPENDENCY', code: 'CATALOG_UNAVAILABLE', message: 'The catalogue is temporarily unavailable' });
        expect(errorOf(r).details).toBeUndefined();
        expect(r.headers.vary).toMatch(/authorization/i);
        for (const w of ['ECONNREFUSED', 'hunter2', '10.1.2.3']) expect(r.body, `${u} ${w}`).not.toContain(w);
      }
    // a registry that ANSWERS without the name is the omission / 404 (above), only one that cannot answer is a 503
    content.resolveRendered.mockReset();
    content.resolveRendered.mockResolvedValue({ items: new Map(), sources: new Map(), missing: new Map(), at: new Date() });
    expect((await call('GET', '/gig-templates?market=us-sf')).statusCode).toBe(200);
    expect((await call('GET', '/gig-templates/full_detail?market=us-sf')).statusCode).toBe(404);
  });

  it('no text lookup at all (an empty page) is not an outage: nothing to resolve, no content call, 200', async () => {
    gt.listGigTemplatesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, templates: [] });
    content.resolveRendered.mockRejectedValue(new Error('down'));
    const r = await call('GET', '/gig-templates?market=us-sf');
    expect([r.statusCode, r.json().data]).toEqual([200, []]);
    expect(content.resolveRendered).not.toHaveBeenCalled();
  });

  it('a template without an ACTIVE version is listed with activeVersion null and the detail still answers', async () => {
    const bare = { ...publicTpl(TEMPLATES[3]!), activeVersion: null };
    gt.listGigTemplatesForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, templates: [bare] });
    gt.getGigTemplateForMarket.mockResolvedValue({ market: { code: 'us-sf', defaultLocale: 'en-US' }, template: bare });
    expect((await call('GET', '/gig-templates?market=us-sf')).json().data[0].activeVersion).toBeNull();
    expect((await call('GET', '/gig-templates/standard_clean?market=us-sf')).json().data.activeVersion).toBeNull();
  });

  it('a service failure that is not a CatalogError is a generic 500 with no internal text', async () => {
    gt.listGigTemplatesForMarket.mockRejectedValue(new Error('relation "catalog.gig_templates" does not exist password=hunter2'));
    const r = await call('GET', '/gig-templates?market=us-sf');
    expect(r.statusCode).toBe(500);
    expect(errorOf(r)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(r.body).not.toContain('hunter2');
    expect(r.body).not.toContain('does not exist');
  });
});

// ====================================================================== the management view
describe('the MANAGEMENT view (admin context with catalog-read or catalog-write)', () => {
  it('lists every status, with management fields, without a market; the market is optional; the version list is not part of a list item', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/gig-templates', t);
    expect(list.statusCode).toBe(200);
    expect(codesOf(list)).toEqual(TEMPLATES.map((x) => x.code));
    expect(list.json().data.map((c: { status: string }) => c.status)).toEqual(['DRAFT', 'ACTIVE', 'RETIRED', 'ACTIVE', 'ACTIVE']);
    for (const c of list.json().data) {
      expect(keysOf(c)).toEqual(MGMT_LIST_KEYS);
      expect(c.displayOrder).toBeNull();
    }
    const active = list.json().data[1];
    expect(keysOf(active.activeVersion)).toEqual(MGMT_SUMMARY_KEYS);
    expect(active.activeVersion).toMatchObject({ status: 'ACTIVE', revision: 3, publishedAt: T1, closedAt: null, createdAt: T0 });
    expect(list.json().data[0].activeVersion).toBeNull();
    expect(active).toMatchObject({
      createdAt: T0,
      updatedAt: T1,
      nameContentKey: 'catalog.gig_template.full_detail.name',
      instructionsContentKey: 'catalog.gig_template.full_detail.instructions',
    });
    expect(gt.listGigTemplates).toHaveBeenCalledWith({ serviceTypeCode: undefined, marketCode: undefined });
    expect(gt.listGigTemplatesForMarket).not.toHaveBeenCalled();
    // the optional service type filter
    const filtered = await call('GET', '/gig-templates?serviceType=regular_cleaning', t);
    expect(codesOf(filtered)).toEqual(['standard_clean', 'unnamed_tpl']);
    expect(gt.listGigTemplates).toHaveBeenLastCalledWith({ serviceTypeCode: 'regular_cleaning', marketCode: undefined });
  });

  it('the detail adds the instructions and EVERY version (newest first), with the revision, the status and the content keys at every level', async () => {
    const t = await adminToken([READ]);
    const res = await call('GET', '/gig-templates/full_detail', t);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(keysOf(d)).toEqual(MGMT_DETAIL_KEYS);
    expect(d.versions.map((v: { versionNumber: number; status: string; revision: number }) => [v.versionNumber, v.status, v.revision])).toEqual([
      [3, 'DRAFT', 2],
      [2, 'ACTIVE', 3],
      [1, 'SUPERSEDED', 3],
    ]);
    for (const v of d.versions) expect(keysOf(v)).toEqual(MGMT_SUMMARY_KEYS);
    expect(keysOf(d.activeVersion)).toEqual(MGMT_VERSION_KEYS);
    for (const f of d.activeVersion.fields) {
      expect(keysOf(f)).toEqual(MGMT_FIELD_KEYS);
      expect(f.labelContentKey).toBe(gigTemplateFieldLabelKey('full_detail', f.fieldKey));
      for (const o of f.options) expect(keysOf(o)).toEqual(MGMT_OPTION_KEYS);
    }
    expect(d.activeVersion.fields[0].defaultContentKey).toBe(gigTemplateFieldDefaultKey('full_detail', 'scope_notes'));
    expect(d.activeVersion.fields[2].helpContentKey).toBeNull();
    expect((await call('GET', '/gig-templates/draft_tpl', t)).json().data).toMatchObject({
      status: 'DRAFT',
      activeVersion: null,
      name: textOf(gigTemplateNameKey('draft_tpl'), 'en-US'),
    });
    expect(gt.getGigTemplate).toHaveBeenCalledWith('full_detail', { marketCode: undefined });
    expect(gt.getGigTemplateForMarket).not.toHaveBeenCalled();
    expect((await call('GET', '/gig-templates/nope_tpl', t)).statusCode).toBe(404);
  });

  it('the version read is the full definition of ANY version with the revision (a DRAFT too), 404 for an unknown template or version', async () => {
    const t = await adminToken([READ]);
    const res = await call('GET', '/gig-templates/full_detail/versions/3', t);
    expect(res.statusCode).toBe(200);
    expect(keysOf(res.json().data)).toEqual(MGMT_VERSION_KEYS);
    expect(res.json().data).toMatchObject({ versionNumber: 3, status: 'DRAFT', revision: 2, publishedAt: null, closedAt: null, fieldCount: 4 });
    expect(res.json().data.fields).toHaveLength(4);
    expect(gt.getGigTemplateVersion).toHaveBeenCalledWith('full_detail', 3);
    // a version without any field (a fresh draft)
    gt.getGigTemplateVersion.mockResolvedValueOnce(ONLY_DRAFT_VERSION);
    const empty = await call('GET', '/gig-templates/full_detail/versions/1', t);
    expect(empty.json().data).toMatchObject({ fields: [], requirements: [], fieldCount: 0, status: 'DRAFT' });
    const noVersion = await call('GET', '/gig-templates/full_detail/versions/9', t);
    expect(noVersion.statusCode).toBe(404);
    expect(errorOf(noVersion).code).toBe('CATALOG_GIG_TEMPLATE_VERSION_NOT_FOUND');
    const noTemplate = await call('GET', '/gig-templates/nope_tpl/versions/1', t);
    expect(noTemplate.statusCode).toBe(404);
    expect(errorOf(noTemplate).code).toBe('CATALOG_GIG_TEMPLATE_NOT_FOUND');
    // the version read is not part of the public API: no market makes it public
    expect((await call('GET', '/gig-templates/full_detail/versions/2?market=us-sf')).statusCode).toBe(401);
    expect(
      (await call('GET', '/gig-templates/full_detail/versions/2?market=us-sf', await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } })))
        .statusCode,
    ).toBe(403);
  });

  it('with a market (any status of the market): the availability flag and the order of that market are added; an unregistered market is a 404', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/gig-templates?market=la-oc', t);
    expect(list.statusCode).toBe(200);
    for (const c of list.json().data) expect(keysOf(c)).toEqual(MGMT_LIST_KEYS_WITH_MARKET);
    expect(list.json().data[1]).toMatchObject({ code: 'full_detail', enabled: true, displayOrder: 10 });
    expect(gt.listGigTemplates).toHaveBeenCalledWith({ serviceTypeCode: undefined, marketCode: 'la-oc' });
    expect((await call('GET', '/service-types/car_detailing/gig-templates?market=la-oc', t)).statusCode).toBe(200);
    expect(gt.listGigTemplates).toHaveBeenLastCalledWith({ serviceTypeCode: 'car_detailing', marketCode: 'la-oc' });
    const detail = await call('GET', '/gig-templates/full_detail?market=la-oc', t);
    expect(detail.statusCode).toBe(200);
    expect(keysOf(detail.json().data)).toEqual([...MGMT_DETAIL_KEYS, 'enabled'].sort());
    expect(gt.getGigTemplate).toHaveBeenCalledWith('full_detail', { marketCode: 'la-oc' });
    const missing = await call('GET', '/gig-templates?market=nowhere', t);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('CATALOG_MARKET_NOT_FOUND');
    expect(errorOf(await call('GET', '/gig-templates/full_detail?market=nowhere', t)).code).toBe('CATALOG_MARKET_NOT_FOUND');
  });

  it('the service-type list of the management view checks the service type first (404 for an unknown one) and lists every status', async () => {
    const t = await adminToken([READ]);
    const res = await call('GET', '/service-types/car_detailing/gig-templates', t);
    expect(res.statusCode).toBe(200);
    expect(codesOf(res)).toEqual(['draft_tpl', 'full_detail', 'retired_tpl']);
    expect(catalog.getServiceType).toHaveBeenCalledWith('car_detailing');
    expect(catalog.getServiceTypeForMarket).not.toHaveBeenCalled();
    const unknown = await call('GET', '/service-types/nope_st/gig-templates', t);
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('CATALOG_SERVICE_TYPE_NOT_FOUND');
    // a service type that exists but is not public is fine for an administrator
    expect((await call('GET', '/service-types/draft_st/gig-templates', t)).statusCode).toBe(200);
    expect(gt.listGigTemplates).toHaveBeenLastCalledWith({ serviceTypeCode: 'draft_st', marketCode: undefined });
  });

  it('falls back to the content KEY as the name (and the label, and the option label) when no text is published; the public view omits or uses codes', async () => {
    const t = await adminToken([READ]);
    const list = await call('GET', '/gig-templates', t);
    const unnamed = list.json().data.find((c: { code: string }) => c.code === 'unnamed_tpl');
    expect(unnamed.name).toBe('catalog.gig_template.unnamed_tpl.name');
    const one = await call('GET', '/gig-templates/unnamed_tpl', t);
    expect(one.statusCode).toBe(200);
    expect(one.json().data.name).toBe('catalog.gig_template.unnamed_tpl.name');
    const d = (await call('GET', '/gig-templates/full_detail', t)).json().data;
    const skills = d.activeVersion.fields.find((f: { fieldKey: string }) => f.fieldKey === 'skills');
    expect(skills.label).toBe(gigTemplateFieldLabelKey('full_detail', 'skills'));
    const wax = d.activeVersion.fields.find((f: { fieldKey: string }) => f.fieldKey === 'wax_type');
    expect(wax.options[1]).toMatchObject({ optionCode: 'synthetic', label: gigTemplateOptionLabelKey('full_detail', 'wax_type', 'synthetic') });
    expect(wax.help).toBeNull();
    // the version read falls back the same way
    const v = (await call('GET', '/gig-templates/full_detail/versions/2', t)).json().data;
    expect(v.fields.find((f: { fieldKey: string }) => f.fieldKey === 'skills').label).toBe(gigTemplateFieldLabelKey('full_detail', 'skills'));
  });

  it('resolves the text with ONE call: no includeInternal restriction for administrators, the market (when named) in the context, the platform default locale unless asked', async () => {
    const t = await adminToken([READ]);
    await call('GET', '/gig-templates', t);
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const [keysArg, opts] = content.resolveRendered.mock.calls[0]!;
    expect(opts.includeInternal).not.toBe(false);
    expect(opts.locale).toBe('en-US');
    expect(opts.context).toBeUndefined();
    expect(content.listLocales).toHaveBeenCalledWith({ activeOnly: true });
    expect(new Set(keysArg).size).toBe(keysArg.length);
    // names and descriptions of every template (the list does not ask for instructions or the fields)
    expect(keysArg.some((k: string) => k.endsWith('.instructions') || k.includes('.field.'))).toBe(false);
    content.resolveRendered.mockClear();
    await call('GET', '/gig-templates?market=la-oc&locale=es-US', t);
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    expect(content.resolveRendered.mock.calls[0]![1]).toMatchObject({ locale: 'es-US', context: { market: 'la-oc' } });
    expect(content.resolveRendered.mock.calls[0]![1].includeInternal).not.toBe(false);
    // the detail: the instructions and every version key in the same single call
    content.resolveRendered.mockClear();
    await call('GET', '/gig-templates/full_detail', t);
    expect(content.resolveRendered).toHaveBeenCalledTimes(1);
    const detailKeys = content.resolveRendered.mock.calls[0]![0] as string[];
    expect(detailKeys).toContain(gigTemplateInstructionsKey('full_detail'));
    expect(detailKeys).toContain(gigTemplateFieldLabelKey('full_detail', 'wax_type'));
    // the version read and the mutations use the platform default locale and no market
    for (const [method, url, body] of [
      ['GET', '/gig-templates/full_detail/versions/3', undefined],
      ['POST', '/gig-templates', route('createGigTemplate').body],
      ['PUT', '/gig-templates/full_detail/versions/3', REPLACE_BODY],
      ['POST', '/gig-templates/full_detail/versions/3/publish', route('publishGigTemplateVersion').body],
    ] as const) {
      content.resolveRendered.mockClear();
      await call(method, url, await adminToken([READ, WRITE]), body);
      expect(content.resolveRendered, url).toHaveBeenCalledTimes(1);
      const o = content.resolveRendered.mock.calls[0]![1];
      expect([url, o.locale, o.context]).toEqual([url, 'en-US', undefined]);
      expect(o.includeInternal).not.toBe(false);
    }
  });

  it('a management view WITH a market resolves text in the default locale of THAT market, on lists and on details; an explicit locale wins; without a market the platform default', async () => {
    const t = await adminToken([READ]);
    const localeOfLast = () => content.resolveRendered.mock.calls.at(-1)![1].locale;
    for (const [market, locale] of [
      ['mx-cdmx', 'es-MX'],
      ['qa-lab', 'qaa'],
      ['la-oc', 'en-US'],
    ] as const)
      for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) {
        content.resolveRendered.mockClear();
        const r = await call('GET', `${u}?market=${market}`, t);
        expect(r.statusCode, `${u} ${market}`).toBe(200);
        expect(localeOfLast(), `${u} ${market}`).toBe(locale);
        expect(content.resolveRendered.mock.calls.at(-1)![1].context).toEqual({ market });
      }
    for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) {
      content.resolveRendered.mockClear();
      await call('GET', `${u}?market=mx-cdmx&locale=en-US`, t);
      expect(localeOfLast(), u).toBe('en-US');
    }
    catalog.getMarketDefaultLocale.mockClear();
    content.resolveRendered.mockClear();
    for (const u of ['/gig-templates', '/gig-templates/full_detail', '/service-types/car_detailing/gig-templates']) await call('GET', u, t);
    expect(catalog.getMarketDefaultLocale).not.toHaveBeenCalled();
    for (const c of content.resolveRendered.mock.calls) expect(c[1].locale).toBe('en-US');
    // the public view never asks for it (the gate already supplied the locale)
    catalog.getMarketDefaultLocale.mockClear();
    await call('GET', '/gig-templates?market=mx-cdmx');
    await call('GET', '/gig-templates/full_detail?market=mx-cdmx');
    await call('GET', '/service-types/car_detailing/gig-templates?market=mx-cdmx');
    expect(catalog.getMarketDefaultLocale).not.toHaveBeenCalled();
  });

  it('a content outage never fails the management reads or the mutation responses: the texts fall back to the content keys (200), with a warn log that holds no cause', async () => {
    const t = await adminToken([READ, WRITE]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    try {
      content.resolveRendered.mockRejectedValue(new Error('content down password=hunter2'));
      for (const u of [
        '/gig-templates',
        '/gig-templates/full_detail',
        '/service-types/car_detailing/gig-templates',
        '/gig-templates?market=la-oc',
        '/gig-templates/full_detail/versions/3',
      ]) {
        const r = await call('GET', u, t);
        expect(r.statusCode, u).toBe(200);
        expect(r.body).not.toContain('hunter2');
      }
      for (const r of WRITES) expect((await call(r.method, r.url, t, r.body)).statusCode, r.operationId).toBe(r.okStatus);
      const names = (await call('GET', '/gig-templates', t)).json().data.map((c: { name: string }) => c.name);
      expect(names).toEqual(TEMPLATES.map((c) => c.nameContentKey));
      const v = (await call('GET', '/gig-templates/full_detail/versions/3', t)).json().data;
      expect(v.fields.map((f: { label: string }) => f.label)).toEqual(DRAFT_VERSION.fields.map((f) => f.labelContentKey));
      content.listLocales.mockRejectedValue(new Error('locales down'));
      expect((await call('GET', '/gig-templates', t)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const out = logged.join('\n');
    expect(out).toContain('catalogue text could not be resolved');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('content down');
  });
});

// ====================================================================== error mapping
describe('error mapping: every CatalogError code becomes the standard envelope with a CATALOG_ code', () => {
  const EXPECTED: Record<CatalogErrorCode, { status: number; category: string }> = {
    CATEGORY_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    SERVICE_TYPE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    PROHIBITED_SERVICE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    GIG_TEMPLATE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    GIG_TEMPLATE_VERSION_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    MARKET_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    VALIDATION_FAILED: { status: 400, category: 'VALIDATION' },
    CONFLICT: { status: 409, category: 'CONFLICT' },
    INVALID_STATE: { status: 409, category: 'CONFLICT' },
    UNAVAILABLE: { status: 503, category: 'DEPENDENCY' },
  };
  const ALLOWED_DETAILS = new Set(['reason', 'field', 'retryable', 'code', 'contentKeys']);
  const detailsFor = (code: CatalogErrorCode): Record<string, unknown> =>
    code === 'UNAVAILABLE'
      ? {}
      : code === 'CONFLICT'
        ? { reason: 'STALE_DRAFT', retryable: true }
        : code === 'VALIDATION_FAILED'
          ? { reason: 'CONTENT_ENTRY_MISSING', field: 'code', contentKeys: ['catalog.gig_template.x_y.name'] }
          : code === 'INVALID_STATE'
            ? {
                reason: 'CONTENT_NOT_PUBLISHED',
                contentKeys: ['catalog.gig_template.full_detail.field.wax_type.label', 'catalog.gig_template.full_detail.name'],
              }
            : { code: 'some_code' };

  it('covers every code of the contract, including the two new not-found codes', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CATALOG_ERROR_CODES].sort());
  });

  it.each([...CATALOG_ERROR_CODES])('%s on a mutation, the version read, a management read and a public read', async (code) => {
    const details = detailsFor(code);
    const failure = () => new CatalogError(code, `fixed message for ${code}`, details);
    const t = await adminToken([READ, WRITE]);
    gt.publishGigTemplateVersion.mockRejectedValueOnce(failure());
    gt.getGigTemplateVersion.mockRejectedValueOnce(failure());
    gt.getGigTemplate.mockRejectedValueOnce(failure());
    gt.listGigTemplatesForMarket.mockRejectedValueOnce(failure());
    const results = [
      await call('POST', '/gig-templates/full_detail/versions/3/publish', t, route('publishGigTemplateVersion').body),
      await call('GET', '/gig-templates/full_detail/versions/3', t),
      await call('GET', '/gig-templates/full_detail', t),
      await call('GET', '/gig-templates?market=us-sf'),
    ];
    for (const res of results) {
      expect(res.statusCode, code).toBe(EXPECTED[code].status);
      const e = errorOf(res);
      expect(e).toMatchObject({ code: `CATALOG_${code}`, category: EXPECTED[code].category });
      if (code === 'UNAVAILABLE') {
        expect(e.message).toBe('The catalogue is temporarily unavailable');
        expect(e.details).toBeUndefined();
      } else {
        expect(e.message).toBe(`fixed message for ${code}`);
        for (const k of Object.keys(e.details ?? {})) expect(ALLOWED_DETAILS.has(k), `${code} detail ${k}`).toBe(true);
        expect(e.details).toEqual(details);
      }
      expect(res.body).not.toContain('"stack"');
    }
  });

  it('every operation maps a CatalogError (the service function, and for the shared reads the management one too)', async () => {
    const t = await adminToken([READ, WRITE]);
    for (const r of ROUTES) {
      gt[r.fn].mockRejectedValueOnce(new CatalogError('CONFLICT', 'fixed', { reason: 'STALE_DRAFT' }));
      const res = await call(r.method, r.url, r.perm === 'public' ? undefined : t, r.body);
      expect(res.statusCode, r.operationId).toBe(409);
      expect(errorOf(res).code, r.operationId).toBe('CATALOG_CONFLICT');
      expect(errorOf(res).details).toEqual({ reason: 'STALE_DRAFT' });
    }
    for (const r of PUBLIC_ROUTES) {
      gt[r.mgmtFn!].mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text: connect ECONNREFUSED 10.9.9.9:5432'));
      const res = await call(r.method, r.url, t);
      expect(res.statusCode, r.operationId).toBe(503);
      expect(res.body).not.toContain('ECONNREFUSED');
      expect(res.body).not.toContain('10.9.9.9');
    }
    // the neighbours of the shared reads: the service type lookups and the market locale lookup
    catalog.getServiceType.mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text 10.9.9.9'));
    expect((await call('GET', '/service-types/car_detailing/gig-templates', t)).statusCode).toBe(503);
    catalog.getServiceTypeForMarket.mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text 10.9.9.9'));
    expect((await call('GET', '/service-types/car_detailing/gig-templates?market=us-sf')).statusCode).toBe(503);
    catalog.getMarketDefaultLocale.mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text 10.9.9.9'));
    expect((await call('GET', '/gig-templates/full_detail?market=la-oc', t)).statusCode).toBe(503);
  });

  it('details are an ALLOW-list: sql, detail, table, host, cause, constraint and any unknown key are dropped on EVERY route and error path', async () => {
    const t = await adminToken([READ, WRITE]);
    const hostile = (): Record<string, unknown> => ({
      reason: 'GIG_TEMPLATE_NOT_ACTIVE',
      field: 'displayOrder',
      code: 'some_code',
      retryable: true,
      contentKeys: ['catalog.gig_template.full_detail.name'],
      sql: 'SELECT secret FROM catalog.gig_templates',
      detail: 'Key (code)=(x) already exists',
      table: 'gig_templates',
      host: '10.0.0.5',
      schema: 'catalog',
      value: 'hunter2',
      constraint: 'fk_gig_template_fields__label_content_key',
      cause: new Error('pg: password authentication failed'),
      nested: { reason: 'sneaky' },
    });
    const expected = {
      reason: 'GIG_TEMPLATE_NOT_ACTIVE',
      field: 'displayOrder',
      code: 'some_code',
      retryable: true,
      contentKeys: ['catalog.gig_template.full_detail.name'],
    };
    const forbidden = [
      'SELECT',
      'already exists',
      'gig_templates"',
      '10.0.0.5',
      'hunter2',
      'fk_',
      'password',
      'sneaky',
      '"sql"',
      '"table"',
      '"host"',
      '"nested"',
    ];
    for (const ec of CATALOG_ERROR_CODES.filter((c) => c !== 'UNAVAILABLE')) {
      for (const r of ROUTES) {
        gt[r.fn].mockRejectedValueOnce(new CatalogError(ec, 'fixed message', hostile()));
        const res = await call(r.method, r.url, r.perm === 'public' ? undefined : t, r.body);
        expect(errorOf(res).details, `${ec} ${r.operationId}`).toEqual(expected);
        for (const w of forbidden) expect(res.body.replace(/"message":"[^"]*"/, ''), `${ec} ${r.operationId} ${w}`).not.toContain(w);
      }
      // the management reads on the shared routes and their neighbours
      for (const [target, fn, url] of [
        [gt, 'listGigTemplates', '/gig-templates'],
        [gt, 'getGigTemplate', '/gig-templates/full_detail'],
        [gt, 'listGigTemplates', '/service-types/car_detailing/gig-templates'],
        [catalog, 'getServiceType', '/service-types/car_detailing/gig-templates'],
        [catalog, 'getMarketDefaultLocale', '/gig-templates?market=la-oc'],
        [catalog, 'getMarketDefaultLocale', '/gig-templates/full_detail?market=la-oc'],
        [catalog, 'getServiceTypeForMarket', '/service-types/car_detailing/gig-templates?market=us-sf'],
      ] as const) {
        const token = url.includes('market=us-sf') ? undefined : t;
        (target as Record<string, ReturnType<typeof vi.fn>>)[fn]!.mockRejectedValueOnce(new CatalogError(ec, 'fixed message', hostile()));
        const res = await call('GET', url, token);
        expect(errorOf(res).details, `${ec} ${fn} ${url}`).toEqual(expected);
      }
    }
    gt.createGigTemplate.mockRejectedValueOnce(new CatalogError('UNAVAILABLE', 'driver text', hostile()));
    const down = await call('POST', '/gig-templates', t, route('createGigTemplate').body);
    expect(down.statusCode).toBe(503);
    expect(errorOf(down).details).toBeUndefined();
    for (const w of forbidden) expect(down.body).not.toContain(w);
  });

  describe('contentKeys: only key-shaped tokens, at most 20, nothing else', () => {
    const publish = async (details: Record<string, unknown>, code: CatalogErrorCode = 'INVALID_STATE') => {
      gt.publishGigTemplateVersion.mockRejectedValueOnce(new CatalogError(code, 'fixed message', details));
      return call('POST', '/gig-templates/full_detail/versions/3/publish', await adminToken([WRITE]), route('publishGigTemplateVersion').body);
    };
    const key = (n: number) => `catalog.gig_template.full_detail.field.field_${n}.label`;

    it('passes the missing keys of a failed publication through, in order', async () => {
      const ks = [key(1), key(2), 'catalog.gig_template.full_detail.name'];
      const r = await publish({ reason: 'CONTENT_NOT_PUBLISHED', contentKeys: ks });
      expect(r.statusCode).toBe(409);
      expect(errorOf(r).details).toEqual({ reason: 'CONTENT_NOT_PUBLISHED', contentKeys: ks });
    });
    it('keeps at most 20 keys (the first 20)', async () => {
      const ks = Array.from({ length: 25 }, (_, i) => key(i));
      const r = await publish({ contentKeys: ks });
      expect(errorOf(r).details!.contentKeys).toEqual(ks.slice(0, 20));
      const exactly = Array.from({ length: 20 }, (_, i) => key(i));
      expect(errorOf(await publish({ contentKeys: exactly })).details!.contentKeys).toEqual(exactly);
      // the cut applies AFTER the invalid ones are dropped
      const mixed = [...Array.from({ length: 10 }, () => 'NOT A KEY'), ...Array.from({ length: 25 }, (_, i) => key(i))];
      expect(errorOf(await publish({ contentKeys: mixed })).details!.contentKeys).toEqual(Array.from({ length: 20 }, (_, i) => key(i)));
    });
    it('drops everything that is not a lower-case dot-separated key: other types, upper case, one segment, empty segments, spaces, quotes, SQL, leading digits, hyphens', async () => {
      const good = [key(1)];
      const junk: unknown[] = [
        5,
        null,
        undefined,
        true,
        { a: 'b' },
        ['x.y'],
        '',
        'nodots',
        'Upper.case',
        'upper.Case',
        'a..b',
        '.a.b',
        'a.b.',
        'a.b c',
        'a. b',
        "x';drop.table",
        'SELECT.1',
        'a-b.c',
        'a.1b',
        '1a.b',
        'a.b\n',
        'a.b\u0000',
        '<script>.x',
        'café.x',
        'a.b/../c',
        '__.x',
        '_a.b',
      ];
      const r = await publish({ contentKeys: [...junk, ...good] });
      expect(errorOf(r).details).toEqual({ contentKeys: good });
    });
    it('omits the property when nothing valid is left, when it is empty or when it is not an array', async () => {
      for (const v of [[], ['NOT A KEY', 5, null], 'catalog.gig_template.full_detail.name', { 0: 'a.b' }, 5, null, true, new Set(['a.b'])]) {
        const r = await publish({ reason: 'X', contentKeys: v });
        expect(errorOf(r).details, JSON.stringify(v)).toEqual({ reason: 'X' });
      }
    });
    it('is allowed on every CatalogError code except UNAVAILABLE (which has no details at all)', async () => {
      for (const ec of CATALOG_ERROR_CODES.filter((c) => c !== 'UNAVAILABLE')) {
        const r = await publish({ contentKeys: [key(1)] }, ec);
        expect(errorOf(r).details, ec).toEqual({ contentKeys: [key(1)] });
      }
      const down = await publish({ contentKeys: [key(1)] }, 'UNAVAILABLE');
      expect(down.statusCode).toBe(503);
      expect(errorOf(down).details).toBeUndefined();
    });
    it('safeDetails unit: the same rules, and every other property is still dropped', () => {
      expect(safeDetails({ contentKeys: [key(1), 'BAD', key(2)] })).toEqual({ contentKeys: [key(1), key(2)] });
      expect(safeDetails({ contentKeys: [] })).toEqual({});
      expect(safeDetails({ contentKeys: 'catalog.x.y' })).toEqual({});
      expect(safeDetails({ contentkeys: [key(1)], content_keys: [key(1)], keys: [key(1)] })).toEqual({});
      expect(Object.keys(safeDetails({ reason: 'r', field: 'f', code: 'c', retryable: true, contentKeys: [key(1)], extra: 1 })).sort()).toEqual([
        'code',
        'contentKeys',
        'field',
        'reason',
        'retryable',
      ]);
    });
    it('a key-shaped token longer than the 160 characters of a content key is dropped', () => {
      const huge = `catalog.${'a'.repeat(5000)}.x`;
      expect(JSON.stringify(safeDetails({ contentKeys: [huge] }))).not.toContain('aaaaaaaaaa');
    });
  });

  it('a non-CatalogError failure of a mutation is a generic 500 (no internal text)', async () => {
    const t = await adminToken([WRITE]);
    for (const r of WRITES) {
      gt[r.fn].mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint "uq_gig_templates__code" password=hunter2'), { code: '23505' }),
      );
      const res = await call(r.method, r.url, t, r.body);
      expect(res.statusCode, r.operationId).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_ERROR');
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('uq_gig_templates');
    }
  });
});

// ====================================================================== the DTO mappers
describe('the DTO mappers: field by field, validated by the contract schemas', () => {
  const textsOf = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  const none = textsOf({});
  const all = (): Record<string, string> => Object.fromEntries(allKeys().map((k) => [k, `T:${k}`]));
  const FULL = TEMPLATES[1]!;

  it('what the mappers produce is accepted by the contract schemas, in both views, for every fixture template and version', () => {
    for (const management of [false, true]) {
      for (const t of TEMPLATES.filter((x) => management || PUBLIC_CODES.includes(x.code))) {
        const view = management ? t : publicTpl(t);
        const list = gigTemplateListItemDto(view, textsOf(all()), management);
        const detail = gigTemplateDetailDto(view, textsOf(all()), management);
        expect(GigTemplateListItemDto.safeParse(list).success, `${t.code} list ${management}`).toBe(true);
        expect(GigTemplateDetailDto.safeParse(detail).success, `${t.code} detail ${management}`).toBe(true);
      }
      for (const v of [FULL.activeVersion!, DRAFT_VERSION, ONLY_DRAFT_VERSION])
        expect(GigTemplateVersionDto.safeParse(versionDto(v, textsOf(all()), management)).success, `v${v.versionNumber} ${management}`).toBe(true);
    }
  });

  it('a template whose name has no text is null in the public view and falls back to its key in the management view', () => {
    expect(gigTemplateListItemDto(publicTpl(FULL), none, false)).toBeNull();
    expect(gigTemplateDetailDto(publicTpl(FULL), none, false)).toBeNull();
    expect(gigTemplateListItemDto(FULL, none, true)!.name).toBe(FULL.nameContentKey);
    expect(gigTemplateDetailDto(FULL, none, true)!.name).toBe(FULL.nameContentKey);
    // description / instructions without text are null, never the key
    const d = gigTemplateDetailDto(FULL, textsOf({ [FULL.nameContentKey]: 'N' }), true)!;
    expect([d.name, d.description, d.instructions]).toEqual(['N', null, null]);
  });

  it('the list item never carries instructions; the detail does (null when not linked)', () => {
    const texts = textsOf(all());
    expect(gigTemplateListItemDto(FULL, texts, true)).not.toHaveProperty('instructions');
    expect(gigTemplateListItemDto(publicTpl(FULL), texts, false)).not.toHaveProperty('instructions');
    expect(gigTemplateDetailDto(publicTpl(FULL), texts, false)).toHaveProperty('instructions', `T:${FULL.instructionsContentKey}`);
    expect(gigTemplateDetailDto(publicTpl(TEMPLATES[3]!), texts, false)).toHaveProperty('instructions', null);
  });

  it('the management-only template fields are added only for the management view, and only when the service supplied them', () => {
    const texts = textsOf(all());
    const mgmt = gigTemplateDetailDto(FULL, texts, true)!;
    expect(Object.keys(mgmt).sort()).toEqual(MGMT_DETAIL_KEYS);
    const bare = { ...FULL };
    delete (bare as Partial<GigTemplateView>).status;
    delete (bare as Partial<GigTemplateView>).createdAt;
    delete (bare as Partial<GigTemplateView>).updatedAt;
    delete (bare as Partial<GigTemplateView>).versions;
    const k = Object.keys(gigTemplateDetailDto(bare, texts, true)!).sort();
    expect(k).toEqual(MGMT_DETAIL_KEYS.filter((x) => !['status', 'createdAt', 'updatedAt', 'versions'].includes(x)));
    // a management-shaped view in the public mapper leaks nothing
    expect(Object.keys(gigTemplateDetailDto(FULL, texts, false)!).sort()).toEqual(PUBLIC_DETAIL_KEYS);
    expect(Object.keys(gigTemplateListItemDto(FULL, texts, false)!).sort()).toEqual(PUBLIC_LIST_KEYS);
    expect(Object.keys(versionDto(FULL.activeVersion!, texts, false)).sort()).toEqual(PUBLIC_VERSION_KEYS);
    expect(Object.keys(versionSummaryDto(FULL.activeVersion!, false)).sort()).toEqual(PUBLIC_SUMMARY_KEYS);
    expect(Object.keys(versionSummaryDto(FULL.activeVersion!, true)).sort()).toEqual(MGMT_SUMMARY_KEYS);
    // a summary without the management fields stays without them in the management view
    expect(Object.keys(versionSummaryDto(stripVersionSummary(FULL.activeVersion!), true)).sort()).toEqual(PUBLIC_SUMMARY_KEYS);
  });

  it('mediaRule: PROHIBITED wins over REQUIRED, REQUIRED needs PROVIDER_REQUIRED, everything else OPTIONAL, non-media null', () => {
    const f = (over: Partial<GigTemplateFieldView>) => ({ ...FD_FIELDS[7]!, ...over });
    const rule = (over: Partial<GigTemplateFieldView>) => {
      const v = { ...FULL.activeVersion!, fields: [f(over)] };
      return versionDto(v, none, false).fields[0]!.mediaRule;
    };
    expect(rule({ fieldType: 'MEDIA', maxItems: 0, behavior: 'PROVIDER_REQUIRED' })).toBe('PROHIBITED');
    expect(rule({ fieldType: 'MEDIA', maxItems: 0, behavior: 'PROVIDER_CONFIGURABLE' })).toBe('PROHIBITED');
    expect(rule({ fieldType: 'MEDIA', maxItems: 5, behavior: 'PROVIDER_REQUIRED' })).toBe('REQUIRED');
    expect(rule({ fieldType: 'MEDIA', maxItems: null, behavior: 'PROVIDER_REQUIRED' })).toBe('REQUIRED');
    expect(rule({ fieldType: 'MEDIA', maxItems: 5, behavior: 'PROVIDER_CONFIGURABLE' })).toBe('OPTIONAL');
    expect(rule({ fieldType: 'MEDIA', maxItems: null, behavior: 'PROVIDER_CONFIGURABLE' })).toBe('OPTIONAL');
    expect(rule({ fieldType: 'MEDIA', maxItems: 5, behavior: 'PLATFORM_FIXED' })).toBe('OPTIONAL');
    for (const t of ['TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION', 'MONEY', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE'] as const) {
      expect(rule({ fieldType: t, maxItems: 0 }), t).toBeNull();
      expect(rule({ fieldType: t, maxItems: 5, behavior: 'PROVIDER_REQUIRED' }), t).toBeNull();
    }
  });

  it('versionKeys / templateKeys list exactly the keys the texts need: label always, help and default only when linked, one per option; name always, instructions only on a detail', () => {
    expect(versionKeys(null)).toEqual([]);
    expect(versionKeys(undefined)).toEqual([]);
    expect(versionKeys({ ...ONLY_DRAFT_VERSION })).toEqual([]);
    const f = FD_FIELDS[1]!; // wax_type: label + help + 2 options
    expect(versionKeys({ ...DRAFT_VERSION, fields: [f] })).toEqual([
      gigTemplateFieldLabelKey('full_detail', 'wax_type'),
      gigTemplateFieldHelpKey('full_detail', 'wax_type'),
      gigTemplateOptionLabelKey('full_detail', 'wax_type', 'carnauba'),
      gigTemplateOptionLabelKey('full_detail', 'wax_type', 'synthetic'),
    ]);
    expect(versionKeys({ ...DRAFT_VERSION, fields: [FD_FIELDS[0]!] })).toEqual([
      gigTemplateFieldLabelKey('full_detail', 'scope_notes'),
      gigTemplateFieldHelpKey('full_detail', 'scope_notes'),
      gigTemplateFieldDefaultKey('full_detail', 'scope_notes'),
    ]);
    expect(versionKeys({ ...DRAFT_VERSION, fields: [FD_FIELDS[2]!] })).toEqual([gigTemplateFieldLabelKey('full_detail', 'vehicle_count')]);
    expect(templateKeys(FULL, false)).toEqual([gigTemplateNameKey('full_detail'), gigTemplateDescriptionKey('full_detail')]);
    expect(templateKeys(FULL, true)).toEqual([
      gigTemplateNameKey('full_detail'),
      gigTemplateDescriptionKey('full_detail'),
      gigTemplateInstructionsKey('full_detail'),
    ]);
    expect(templateKeys(TEMPLATES[3]!, true)).toEqual([gigTemplateNameKey('standard_clean')]);
  });

  it('copies the typed metadata and the requirements as they are and never mutates its input', () => {
    const before = JSON.stringify(FULL);
    const dto = gigTemplateDetailDto(FULL, textsOf(all()), true)!;
    expect(JSON.stringify(FULL)).toBe(before);
    expect(dto.activeVersion!.fields.map((x) => x.fieldKey)).toEqual(FD_FIELDS.map((x) => x.fieldKey));
    expect(dto.activeVersion!.requirements).toEqual(FULL.activeVersion!.requirements);
    // the arrays are copies: mutating the response does not touch the view
    dto.activeVersion!.pricingModels.push('BUNDLE_ELIGIBLE');
    expect(FULL.activeVersion!.pricingModels).toEqual(['FIXED', 'DROP_ELIGIBLE']);
  });
});
