// Unit tests of the provider Gig API module (CAT-003) with a FAKE ProviderGigService and a FAKE AccountService. The real rules are covered by packages/provider and gig.itest.ts; here:
// authentication and the identity context on all 9 operations (401 before 400, 403 for the admin context and for suspended or closed accounts, the active-role header is NOT honoured),
// that the service only ever receives the account of the VERIFIED TOKEN, that no owner / status / market / currency / template version is accepted from a client, strict bodies, strict
// path parameters, the cache policy (no-store everywhere), status codes (201 vs 200), exact response key sets and the absence of unknown service properties, the error mapping for EVERY
// GigError code with its details allow-list (never provider text), the policy and template wiring, the OpenAPI document and the committed specs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ErrorResponse,
  GIG_ERROR_CODES,
  GIG_EVENTS,
  GIG_ISSUE_REASONS,
  GigCreatedPayload,
  GigRetiredPayload,
  GigVersionPublishedPayload,
  GigDetailResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  PROVIDER_GIG_POLICY_KEYS,
  gigErrorKey,
  gigIssueKey,
  gigStatusKey,
  gigVersionStatusKey,
  type GigDetailDto,
  type GigErrorCode,
  type GigMenuDto,
  type GigTemplateChoicesDto,
  type GigVersionDto,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService } from '@bananagig/accounts';
import { GigError, type ProviderGigService } from '@bananagig/provider';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { gigApiErrorCode, safeDetails, toAppError } from './modules/provider/gig-dto';
import { GIG_BODY_LIMIT, GIG_SMALL_BODY_LIMIT } from './modules/provider/gig-routes';
import { CatalogError, type GigTemplateVersionDetailView } from '@bananagig/catalog';
import { createGigPolicyProvider, createGigPrerequisites, createGigTemplatePort, toGigTemplateStructure } from './modules/provider/gig-wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- fakes
const svc = {
  listGigTemplates: vi.fn(),
  listProviderGigs: vi.fn(),
  createGig: vi.fn(),
  getGig: vi.fn(),
  createNextDraft: vi.fn(),
  getGigVersion: vi.fn(),
  updateDraft: vi.fn(),
  publish: vi.fn(),
  retire: vi.fn(),
};
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn() };
const noServiceCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-subject-marker-other-91d3';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const GIG_ID = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const VERSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TEMPLATE_VERSION_ID = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const REQUEST_ID = '2c9f7e1a-8b3d-4f6a-a0c5-1e2d3c4b5a69';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const ISO = '2026-10-16T12:00:00.000Z';
/** Values a fake service carries that must NEVER appear in an ERROR or outside the own-Gig fields. */
const TEXT_SENTINEL = 'Sentinel provider text: call me at 555-0100';
const SENTINELS = ['sentinel.mail@sentinel-contact.example', '+15550001234', 'Sentinel-First-Name', SUB, KEYCLOAK_SID, 'raw-internal-id'];
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };

const state = { memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }] as { code: string; status: 'PENDING' | 'ACTIVE' | 'INACTIVE' }[] };
const makeContext = (accountId: string): AccountContext =>
  ({
    accountId,
    status: 'ACTIVE',
    roles: state.memberships.filter((m) => m.status === 'ACTIVE').map((m) => (m.code === 'PROVIDER' ? PROVIDER : CUSTOMER)),
    memberships: state.memberships,
    primaryRole: 'CUSTOMER',
    activeRole: 'CUSTOMER',
    profile: { firstName: 'Sentinel-First-Name', lastName: 'Sentinel-Last-Name', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
    email: { emailVerificationStatus: 'VERIFIED', primary: { address: 'sentinel.mail@sentinel-contact.example' }, pending: null },
    phone: { phoneVerificationStatus: 'VERIFIED', primary: { number: '+15550001234' }, pending: null },
    contacts: { emailVerified: true, phoneVerified: true, contactsVerified: true },
    createdAt: T0,
    created: false,
  }) as unknown as AccountContext;

const template = (over: Partial<GigVersionDto['template']> = {}): GigVersionDto['template'] => ({
  gigTemplateCode: 'regular_cleaning_basic',
  gigTemplateVersionId: TEMPLATE_VERSION_ID,
  gigTemplateVersionNumber: 2,
  versionStatus: 'ACTIVE',
  templateStatus: 'ACTIVE',
  serviceTypeCode: 'regular_cleaning',
  categoryCode: 'home_cleaning',
  nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
  descriptionContentKey: null,
  instructionsContentKey: null,
  requirements: [{ requirementType: 'VERIFICATION', referenceCode: 'identity' }],
  ...over,
});
const versionFixture = (over: Partial<GigVersionDto> = {}): GigVersionDto => ({
  gigVersionId: VERSION_ID,
  versionNumber: 1,
  status: 'DRAFT',
  statusKey: gigVersionStatusKey('DRAFT'),
  revision: 3,
  gigTemplateVersionNumber: 2,
  title: TEXT_SENTINEL,
  createdAt: ISO,
  updatedAt: ISO,
  publishedAt: null,
  supersededAt: null,
  retiredAt: null,
  shortPitch: 'A short pitch',
  description: 'A description',
  price: { amountMinor: 4500, currency: 'USD' },
  durationMinutes: 90,
  fieldValues: [
    { fieldKey: 'rooms', value: 3 },
    { fieldKey: 'pets', value: true },
    { fieldKey: 'notes', value: 'bring supplies' },
    { fieldKey: 'extra', value: null },
  ],
  template: template(),
  fields: [
    {
      fieldKey: 'rooms',
      fieldType: 'INTEGER',
      section: 'DETAILS',
      behavior: 'PROVIDER_REQUIRED',
      displayOrder: 1,
      customerVisible: true,
      supported: true,
      required: true,
      fixed: false,
      labelContentKey: 'catalog.field.rooms.label',
      helpContentKey: null,
      defaultContentKey: null,
      defaultNumber: null,
      defaultBoolean: null,
      defaultOption: null,
      minLength: null,
      maxLength: null,
      minNumber: 1,
      maxNumber: 20,
      options: [],
    },
    {
      fieldKey: 'size',
      fieldType: 'ENUM',
      section: 'DETAILS',
      behavior: 'PROVIDER_CONFIGURABLE',
      displayOrder: 2,
      customerVisible: true,
      supported: true,
      required: false,
      fixed: false,
      labelContentKey: 'catalog.field.size.label',
      helpContentKey: 'catalog.field.size.help',
      defaultContentKey: null,
      defaultNumber: null,
      defaultBoolean: null,
      defaultOption: 'small',
      minLength: null,
      maxLength: null,
      minNumber: null,
      maxNumber: null,
      options: [
        { optionCode: 'small', displayOrder: 1, isDefault: true, labelContentKey: 'catalog.option.small' },
        { optionCode: 'large', displayOrder: 2, isDefault: false },
      ],
    },
  ],
  constraints: {
    title: { maxLength: 100 },
    shortPitch: { maxLength: 1000 },
    description: { maxLength: 5000 },
    price: { permitted: true, required: true, currency: 'USD' },
    duration: { permitted: true, required: true, minMinutes: 30, maxMinutes: 480, suggestedMinutes: 90 },
  },
  publishable: false,
  issues: [{ target: 'title', reason: 'TITLE_REQUIRED', messageKey: gigIssueKey('TITLE_REQUIRED') }],
  ...over,
});
const gigFixture = (over: Partial<GigDetailDto['gig']> = {}): GigDetailDto['gig'] => ({
  gigId: GIG_ID,
  status: 'DRAFT',
  statusKey: gigStatusKey('DRAFT'),
  gigTemplateCode: 'regular_cleaning_basic',
  serviceTypeCode: 'regular_cleaning',
  categoryCode: 'home_cleaning',
  nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
  createdAt: ISO,
  updatedAt: ISO,
  retiredAt: null,
  ...over,
});
const detailFixture = (): GigDetailDto => {
  const draft = versionFixture();
  return {
    gig: gigFixture(),
    currentVersion: null,
    draftVersion: draft,
    versions: [{ ...draft }].map(
      ({
        shortPitch: _a,
        description: _b,
        price: _c,
        durationMinutes: _d,
        fieldValues: _e,
        template: _f,
        fields: _g,
        constraints: _h,
        publishable: _i,
        issues: _j,
        ...s
      }) => s,
    ),
  };
};
const menuFixture = (): GigMenuDto => ({
  gigs: [
    {
      gig: gigFixture({ status: 'ACTIVE', statusKey: gigStatusKey('ACTIVE') }),
      currentVersion: {
        versionNumber: 1,
        title: 'Published title',
        shortPitch: 'Pitch',
        price: { amountMinor: 4500, currency: 'USD' },
        durationMinutes: 90,
        publishedAt: ISO,
      },
      draftVersion: { versionNumber: 2, revision: 4, title: null, updatedAt: ISO },
      versionCount: 2,
    },
  ],
  readiness: { hasPublishedGig: true, publishedGigCount: 1, draftVersionCount: 1, goLive: { evaluated: false, eligible: false } },
  limits: { maxActive: 25, maxDrafts: 10, activeCount: 1, draftCount: 1 },
  canCreate: true,
  cannotCreateReason: null,
});
const choicesFixture = (): GigTemplateChoicesDto => ({
  marketCode: 'us-sf',
  templates: [
    {
      gigTemplateCode: 'regular_cleaning_basic',
      serviceTypeCode: 'regular_cleaning',
      categoryCode: 'home_cleaning',
      nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
      descriptionContentKey: null,
      gigTemplateVersionNumber: 2,
    },
  ],
});

// ---------------------------------------------------------------- tokens and requests
const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims } });
const adminToken = () =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: ['customer'] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
    },
  });
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const call = (
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url: `/api/v1/provider${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const rawBody = (method: Method, url: string, token: string | undefined, text: string, contentType = 'application/json'): Promise<Reply> =>
  app.inject({
    method,
    url: `/api/v1/provider${url}`,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: text,
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');
const keysOf = (o: object) => Object.keys(o).sort();
const dataOf = (r: Reply) => (r.json() as { data: Record<string, unknown> }).data;
const identityOf = (sub: string) => ({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: sub, identityRoles: ['customer'] });

// ---------------------------------------------------------------- the 9 operations
interface Route {
  operationId: string;
  method: Method;
  /** The path as called. */
  url: string;
  /** The OpenAPI path. */
  spec: string;
  body?: unknown;
  /** A body-less POST is sent with this instead. */
  send?: unknown;
  okStatus: number;
  fn: keyof typeof svc;
}
const CREATE_BODY = { gigTemplateCode: 'regular_cleaning_basic', clientRequestId: REQUEST_ID };
const DRAFT_BODY = {
  expectedRevision: 3,
  title: 'A title',
  shortPitch: 'A pitch',
  description: 'A description',
  priceAmountMinor: 4500,
  durationMinutes: 90,
  fieldValues: [
    { fieldKey: 'rooms', value: 3 },
    { fieldKey: 'pets', value: true },
    { fieldKey: 'notes', value: 'text' },
    { fieldKey: 'size', value: null },
  ],
};
const PUBLISH_BODY = { expectedRevision: 3 };
const ROUTES: Route[] = [
  {
    operationId: 'listProviderGigTemplates',
    method: 'GET',
    url: '/gig-templates',
    spec: '/api/v1/provider/gig-templates',
    okStatus: 200,
    fn: 'listGigTemplates',
  },
  { operationId: 'listProviderGigs', method: 'GET', url: '/gigs', spec: '/api/v1/provider/gigs', okStatus: 200, fn: 'listProviderGigs' },
  { operationId: 'createProviderGig', method: 'POST', url: '/gigs', spec: '/api/v1/provider/gigs', body: CREATE_BODY, okStatus: 201, fn: 'createGig' },
  { operationId: 'getProviderGig', method: 'GET', url: `/gigs/${GIG_ID}`, spec: '/api/v1/provider/gigs/{gigId}', okStatus: 200, fn: 'getGig' },
  {
    operationId: 'createProviderGigVersion',
    method: 'POST',
    url: `/gigs/${GIG_ID}/versions`,
    spec: '/api/v1/provider/gigs/{gigId}/versions',
    send: {},
    okStatus: 201,
    fn: 'createNextDraft',
  },
  {
    operationId: 'getProviderGigVersion',
    method: 'GET',
    url: `/gigs/${GIG_ID}/versions/1`,
    spec: '/api/v1/provider/gigs/{gigId}/versions/{version}',
    okStatus: 200,
    fn: 'getGigVersion',
  },
  {
    operationId: 'updateProviderGigDraft',
    method: 'PUT',
    url: `/gigs/${GIG_ID}/draft`,
    spec: '/api/v1/provider/gigs/{gigId}/draft',
    body: DRAFT_BODY,
    okStatus: 200,
    fn: 'updateDraft',
  },
  {
    operationId: 'publishProviderGig',
    method: 'POST',
    url: `/gigs/${GIG_ID}/publish`,
    spec: '/api/v1/provider/gigs/{gigId}/publish',
    body: PUBLISH_BODY,
    okStatus: 200,
    fn: 'publish',
  },
  {
    operationId: 'retireProviderGig',
    method: 'POST',
    url: `/gigs/${GIG_ID}/retire`,
    spec: '/api/v1/provider/gigs/{gigId}/retire',
    send: {},
    okStatus: 200,
    fn: 'retire',
  },
];
const BODY_ROUTES = ROUTES.filter((r) => r.body !== undefined);
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  call(r.method, r.url, token, r.body ?? r.send, headers, target);

// ---------------------------------------------------------------- the apps
const baseDeps = (): AppDeps => ({
  cfg,
  verifier,
  configuration: {} as never,
  accounts: accountSvc as unknown as AccountService,
  providerGigs: svc as unknown as ProviderGigService,
  readiness: async () => ({}),
});
async function makeApp(over: Partial<AppDeps>): Promise<FastifyInstance> {
  const instance = await buildApp({ ...baseDeps(), ...over });
  await instance.ready();
  extraApps.push(instance);
  return instance;
}

beforeAll(async () => {
  keys = await createTestKeys('k1');
  verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await makeApp({});
});
afterAll(async () => {
  for (const a of extraApps) await a.close();
});

beforeEach(() => {
  state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
  for (const f of [...Object.values(svc), ...Object.values(accountSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }, o: { requestedRole?: string } = {}) => {
    if (o.requestedRole !== undefined) {
      const m = state.memberships.find((x) => x.code === o.requestedRole);
      if (!m) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold the role', { role: o.requestedRole });
      if (m.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: o.requestedRole });
    }
    return makeContext(identity.subject === OTHER_SUB ? OTHER_ACCOUNT_ID : ACCOUNT_ID);
  });
  svc.listGigTemplates.mockImplementation(async () => choicesFixture());
  svc.listProviderGigs.mockImplementation(async () => menuFixture());
  svc.createGig.mockImplementation(async () => ({ created: true, detail: detailFixture() }));
  svc.getGig.mockImplementation(async () => detailFixture());
  svc.createNextDraft.mockImplementation(async () => detailFixture());
  svc.getGigVersion.mockImplementation(async () => versionFixture());
  svc.updateDraft.mockImplementation(async () => detailFixture());
  svc.publish.mockImplementation(async () => detailFixture());
  svc.retire.mockImplementation(async () => detailFixture());
});

// ====================================================================== authentication and the identity context
describe('provider Gig API authentication and the account guard', () => {
  it.each(ROUTES)('$method $spec ($operationId) requires a token: 401, no-store, before any service or account call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $spec ($operationId) rejects every kind of invalid token with 401', async (r) => {
    const invalid = [
      'not.a.token',
      await signToken(keys, { expiresInSec: -3600 }),
      await signToken(keys, { claims: { aud: 'someone-else' } }),
      await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } }),
      unsignedToken(),
      await hmacToken(),
    ];
    for (const token of invalid) {
      const res = await routeCall(r, token);
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$method $spec ($operationId) refuses the admin identity context and any other client with 403', async (r) => {
    const admin = await routeCall(r, await adminToken());
    expect(admin.statusCode).toBe(403);
    expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) {
      const res = await routeCall(r, await webToken({ azp }));
      expect(res.statusCode, azp).toBe(403);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$method $spec ($operationId) passes a suspended or closed account through as 403 and never calls the service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 before 400 and 403 before 400: invalid bodies and parameters without a token or with the admin token', async () => {
    for (const r of BODY_ROUTES)
      for (const body of [{ garbage: true }, [], 'text', 7, null]) {
        expect((await rawBody(r.method, r.url, undefined, JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(r.method, r.url, await adminToken(), JSON.stringify(body))).statusCode, r.url).toBe(403);
      }
    for (const url of ['/gigs/not-a-uuid', `/gigs/${GIG_ID}/versions/0`, `/gigs/${GIG_ID}/versions/1e3`, '/gigs?accountId=x']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
      expect((await call('GET', url, await adminToken())).statusCode, url).toBe(403);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)(
    "$method $spec ($operationId) does NOT honour x-active-role: an unheld or inactive PROVIDER role in the header is not a 403 (eligibility is the service's decision)",
    async (r) => {
      for (const memberships of [
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'PENDING' },
        ],
        [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      ] as (typeof state.memberships)[]) {
        state.memberships = memberships;
        for (const header of ['PROVIDER', 'CUSTOMER', 'ADMIN']) {
          svc[r.fn].mockClear();
          const res = await routeCall(r, await webToken(), { 'x-active-role': header });
          expect(res.statusCode, `${header} ${res.body}`).toBeLessThan(300);
          expect(svc[r.fn]).toHaveBeenCalledTimes(1);
        }
      }
      for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].requestedRole).toBeUndefined();
    },
  );
});

// ====================================================================== the account of the token, never of the client
describe('the service is called with the account of the verified token only', () => {
  it.each(ROUTES)('$method $spec ($operationId): the first argument is the token account', async (r) => {
    await routeCall(r, await webToken());
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(identityOf(SUB));
    const other = await routeCall(r, await webToken({ sub: OTHER_SUB }));
    expect(other.statusCode).toBeLessThan(300);
    expect(svc[r.fn].mock.calls[1]![0]).toBe(OTHER_ACCOUNT_ID);
  });

  it.each(ROUTES)('$method $spec ($operationId): an account id in a header or cookie changes nothing', async (r) => {
    const headers = { 'x-account-id': OTHER_ACCOUNT_ID, 'x-forwarded-user': OTHER_SUB, cookie: `accountId=${OTHER_ACCOUNT_ID}` };
    const res = await routeCall(r, await webToken(), headers);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
  });

  it.each(ROUTES.filter((r) => r.method === 'GET'))(
    '$method $spec ($operationId): an account id, owner, status or market in the QUERY is a 400 and never reaches the service',
    async (r) => {
      for (const q of [`accountId=${OTHER_ACCOUNT_ID}`, 'status=ACTIVE', 'market=us-sf', 'owner=x', 'locale=en']) {
        const res = await call(r.method, `${r.url}?${q}`, await webToken());
        expect(res.statusCode, `${q}: ${res.body}`).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(svc[r.fn]).not.toHaveBeenCalled();
    },
  );

  it.each(BODY_ROUTES)('$method $spec ($operationId): an owner, status, market, currency or template version in the BODY is a 400', async (r) => {
    for (const extra of [
      { accountId: OTHER_ACCOUNT_ID },
      { account_id: OTHER_ACCOUNT_ID },
      { gigId: GIG_ID },
      { role: 'PROVIDER' },
      { status: 'ACTIVE' },
      { marketCode: 'us-sf' },
      { currency: 'EUR' },
      { priceCurrency: 'EUR' },
      { serviceTypeCode: 'regular_cleaning' },
      { gigTemplateVersionId: TEMPLATE_VERSION_ID },
      { gigTemplateVersionNumber: 9 },
      { versionStatus: 'PUBLISHED' },
      { goLive: true },
      { published: true },
    ]) {
      const res = await call(r.method, r.url, await webToken(), { ...(r.body as object), ...extra });
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
      expectNoStore(res);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it.each(ROUTES.filter((r) => r.send !== undefined))('$method $spec ($operationId) (body optional): any property in the body is a 400', async (r) => {
    for (const extra of [{ accountId: OTHER_ACCOUNT_ID }, { reason: TEXT_SENTINEL }, { status: 'RETIRED' }, { note: 'x' }]) {
      const res = await call(r.method, r.url, await webToken(), extra);
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(res.body).not.toContain(TEXT_SENTINEL);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('the service receives the parsed contract and nothing else', async () => {
    const token = await webToken();
    await call('POST', '/gigs', token, CREATE_BODY);
    expect(svc.createGig.mock.calls[0]).toEqual([ACCOUNT_ID, CREATE_BODY]);
    await call('POST', '/gigs', token, { gigTemplateCode: 'regular_cleaning_basic' });
    expect(svc.createGig.mock.calls[1]).toEqual([ACCOUNT_ID, { gigTemplateCode: 'regular_cleaning_basic' }]);
    await call('PUT', `/gigs/${GIG_ID}/draft`, token, DRAFT_BODY);
    expect(svc.updateDraft.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID, DRAFT_BODY]);
    await call('POST', `/gigs/${GIG_ID}/publish`, token, PUBLISH_BODY);
    expect(svc.publish.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID, PUBLISH_BODY]);
    await call('POST', `/gigs/${GIG_ID}/retire`, token, {});
    await call('POST', `/gigs/${GIG_ID}/retire`, token);
    await rawBody('POST', `/gigs/${GIG_ID}/retire`, token, 'null');
    expect(svc.retire.mock.calls).toEqual([
      [ACCOUNT_ID, GIG_ID, {}],
      [ACCOUNT_ID, GIG_ID, {}],
      [ACCOUNT_ID, GIG_ID, {}],
    ]);
    await call('POST', `/gigs/${GIG_ID}/versions`, token);
    expect(svc.createNextDraft.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID, {}]);
    await call('GET', `/gigs/${GIG_ID}/versions/12`, token);
    expect(svc.getGigVersion.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID, 12]);
    await call('GET', `/gigs/${GIG_ID}`, token);
    expect(svc.getGig.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID]);
    await call('GET', '/gigs', token);
    expect(svc.listProviderGigs.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('GET', '/gig-templates', token);
    expect(svc.listGigTemplates.mock.calls[0]).toEqual([ACCOUNT_ID]);
  });
});

// ====================================================================== strict bodies and parameters
describe('strict bodies', () => {
  const bad = (r: Route, mutate: (b: Record<string, unknown>) => unknown, label: string) =>
    it(`${r.operationId}: ${label} is a 400 and the service is not called`, async () => {
      const res = await call(r.method, r.url, await webToken(), mutate(structuredClone(r.body as Record<string, unknown>)));
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
      expect(svc[r.fn]).not.toHaveBeenCalled();
    });
  const create = ROUTES.find((r) => r.fn === 'createGig')!;
  const update = ROUTES.find((r) => r.fn === 'updateDraft')!;
  const publish = ROUTES.find((r) => r.fn === 'publish')!;
  bad(create, (b) => ({ ...b, gigTemplateCode: 'Not A Code' }), 'a malformed template code');
  bad(create, (b) => ({ ...b, clientRequestId: 'not-a-uuid' }), 'a malformed clientRequestId');
  bad(create, (b) => ({ ...b, gigTemplateCode: 5 }), 'a non-string template code');
  bad(create, () => ({}), 'a missing template code');
  bad(update, (b) => ({ ...b, expectedRevision: '3' }), 'a string revision (no coercion)');
  bad(update, (b) => ({ ...b, expectedRevision: 0 }), 'revision 0');
  bad(update, (b) => ({ ...b, expectedRevision: 1.5 }), 'a fractional revision');
  bad(update, (b) => ({ ...b, priceAmountMinor: 12.5 }), 'a fractional price');
  bad(update, (b) => ({ ...b, priceAmountMinor: -1 }), 'a negative price');
  bad(update, (b) => ({ ...b, priceAmountMinor: '4500' }), 'a string price (no coercion)');
  bad(update, (b) => ({ ...b, durationMinutes: 0 }), 'duration 0');
  bad(update, (b) => ({ ...b, durationMinutes: 100_001 }), 'duration above the ceiling');
  bad(update, (b) => ({ ...b, title: 12 }), 'a numeric title');
  bad(
    update,
    (b) => ({
      ...b,
      fieldValues: [
        { fieldKey: 'rooms', value: 1 },
        { fieldKey: 'rooms', value: 2 },
      ],
    }),
    'a duplicated field key',
  );
  bad(update, (b) => ({ ...b, fieldValues: [{ fieldKey: 'rooms', value: 1.5 }] }), 'a fractional field value');
  bad(update, (b) => ({ ...b, fieldValues: [{ fieldKey: 'rooms', value: { nested: 1 } }] }), 'an object field value');
  bad(update, (b) => ({ ...b, fieldValues: [{ fieldKey: 'rooms', value: [1] }] }), 'an array field value');
  bad(update, (b) => ({ ...b, fieldValues: [{ fieldKey: 'rooms', value: 1, priceAmountMinor: 1 }] }), 'an unknown key inside a field value');
  bad(update, (b) => ({ ...b, fieldValues: [{ fieldKey: 'Bad Key', value: 1 }] }), 'a malformed field key');
  bad(update, (b) => ({ ...b, fieldValues: Array.from({ length: 65 }, (_, i) => ({ fieldKey: `field_${i}`, value: i })) }), 'more field values than allowed');
  bad(update, (b) => ({ ...b, priceCurrency: 'USD' }), 'a client-supplied currency');
  bad(
    update,
    (b) => {
      const { title: _t, ...rest } = b;
      return rest;
    },
    'an omitted title (the draft replaces the whole content)',
  );
  bad(publish, (b) => ({ ...b, expectedRevision: -1 }), 'a negative revision');
  bad(publish, () => ({}), 'a missing revision');

  it.each([
    ['text/plain', '{"gigTemplateCode":"regular_cleaning_basic"}'],
    ['application/json', '{"gigTemplateCode":'],
    ['application/json', '[]'],
    ['application/json', '"x"'],
  ])('a %s body %s is rejected with a 4xx and the service is not called', async (contentType, text) => {
    const res = await rawBody('POST', '/gigs', await webToken(), text, contentType);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expectNoStore(res);
    expect(svc.createGig).not.toHaveBeenCalled();
  });

  it('a draft body above the limit is 413, a small body above its limit is 413 too, and the service is not called', async () => {
    const huge = JSON.stringify({ ...DRAFT_BODY, description: 'x'.repeat(GIG_BODY_LIMIT) });
    expect((await rawBody('PUT', `/gigs/${GIG_ID}/draft`, await webToken(), huge)).statusCode).toBe(413);
    const bigSmall = JSON.stringify({ gigTemplateCode: 'regular_cleaning_basic', pad: 'x'.repeat(GIG_SMALL_BODY_LIMIT) });
    expect((await rawBody('POST', '/gigs', await webToken(), bigSmall)).statusCode).toBe(413);
    expect(noServiceCalled()).toBe(true);
  });

  it('provider text in a rejected body is never echoed', async () => {
    const res = await call('PUT', `/gigs/${GIG_ID}/draft`, await webToken(), { ...DRAFT_BODY, title: TEXT_SENTINEL, extra: TEXT_SENTINEL });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(TEXT_SENTINEL);
  });
});

describe('strict path parameters', () => {
  it.each(['not-a-uuid', '123', `${GIG_ID}x`, GIG_ID.toUpperCase(), '%20', `${GIG_ID}%00`, '..'])(
    'a gigId %s is a 400 on every Gig route and the service is not called',
    async (id) => {
      for (const r of ROUTES.filter((x) => x.spec.includes('{gigId}'))) {
        const url = r.url.replace(GIG_ID, id);
        const res = await call(r.method, url, await webToken(), r.body ?? r.send);
        expect([400, 404], `${r.method} ${url} ${res.body}`).toContain(res.statusCode);
        expectNoStore(res);
      }
      expect(noServiceCalled()).toBe(true);
    },
  );

  it.each(['0', '01', '+1', '1.0', '1e3', '0x10', ' 1', '-1', 'abc', '1000000000', '99999999999999999999'])(
    'a version %s is a 400 and the service is not called',
    async (v) => {
      const res = await call('GET', `/gigs/${GIG_ID}/versions/${encodeURIComponent(v)}`, await webToken());
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(svc.getGigVersion).not.toHaveBeenCalled();
    },
  );

  it('the largest accepted version is 999999999', async () => {
    expect((await call('GET', `/gigs/${GIG_ID}/versions/999999999`, await webToken())).statusCode).toBe(200);
    expect(svc.getGigVersion.mock.calls[0]).toEqual([ACCOUNT_ID, GIG_ID, 999_999_999]);
  });
});

// ====================================================================== cache policy
describe('Cache-Control: no-store on every response', () => {
  it.each(ROUTES)('$method $spec ($operationId): success, every service error and an unexpected failure are no-store', async (r) => {
    expectNoStore(await routeCall(r, await webToken()));
    for (const code of GIG_ERROR_CODES) {
      svc[r.fn].mockRejectedValueOnce(new GigError(code, 'x'));
      expectNoStore(await routeCall(r, await webToken()));
    }
    svc[r.fn].mockRejectedValueOnce(new Error('kaboom'));
    const boom = await routeCall(r, await webToken());
    expect(boom.statusCode).toBe(500);
    expectNoStore(boom);
  });

  it('router-level failures under the prefix are no-store: unknown paths and wrong methods', async () => {
    for (const [m, u] of [
      ['GET', '/gigs/nope/nope'],
      ['DELETE', '/gigs'],
      ['DELETE', `/gigs/${GIG_ID}`],
      ['PATCH', `/gigs/${GIG_ID}/draft`],
      ['POST', `/gigs/${GIG_ID}/draft`],
      ['GET', `/gigs/${GIG_ID}/publish`],
      ['PUT', `/gigs/${GIG_ID}/versions/1`],
      ['POST', '/gig-templates'],
    ] as const) {
      const anon = await call(m, u);
      expect(anon.statusCode, `${m} ${u}`).toBe(404);
      expect(errorOf(anon).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(anon);
    }
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== status codes and response shapes
describe('status codes and response shapes', () => {
  it('POST /gigs answers 201 when the Gig was created and 200 on an idempotent replay', async () => {
    const created = await call('POST', '/gigs', await webToken(), CREATE_BODY);
    expect(created.statusCode, created.body).toBe(201);
    svc.createGig.mockResolvedValueOnce({ created: false, detail: detailFixture() });
    const replay = await call('POST', '/gigs', await webToken(), CREATE_BODY);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(GigDetailResponse.safeParse(created.json()).success).toBe(true);
    expect(GigDetailResponse.safeParse(replay.json()).success).toBe(true);
  });

  it('every operation answers its documented success status', async () => {
    for (const r of ROUTES) expect((await routeCall(r, await webToken())).statusCode, r.operationId).toBe(r.okStatus);
  });

  it.each(ROUTES.filter((r) => ['createGig', 'getGig', 'createNextDraft', 'updateDraft', 'publish', 'retire'].includes(r.fn)))(
    '$operationId: exactly { data: { gig, currentVersion, draftVersion, versions }, meta: { correlationId } } and it parses as the contract',
    async (r) => {
      const res = await routeCall(r, await webToken());
      const body = res.json() as { data: Record<string, unknown>; meta: object };
      expect(keysOf(body)).toEqual(['data', 'meta']);
      expect(keysOf(body.meta)).toEqual(['correlationId']);
      expect(keysOf(body.data)).toEqual(['currentVersion', 'draftVersion', 'gig', 'versions']);
      expect(GigDetailResponse.safeParse(body).success).toBe(true);
      expect(keysOf(body.data.gig as object)).toEqual(
        ['categoryCode', 'createdAt', 'gigId', 'gigTemplateCode', 'nameContentKey', 'retiredAt', 'serviceTypeCode', 'status', 'statusKey', 'updatedAt'].sort(),
      );
      expect(body.data).toEqual(JSON.parse(JSON.stringify(detailFixture())));
    },
  );

  it('the version, the menu and the template choices parse as their contracts and round-trip unchanged', async () => {
    const v = await call('GET', `/gigs/${GIG_ID}/versions/1`, await webToken());
    expect(GigVersionResponse.safeParse(v.json()).success).toBe(true);
    expect(dataOf(v)).toEqual(JSON.parse(JSON.stringify(versionFixture())));
    const m = await call('GET', '/gigs', await webToken());
    expect(GigMenuResponse.safeParse(m.json()).success).toBe(true);
    expect(dataOf(m)).toEqual(JSON.parse(JSON.stringify(menuFixture())));
    const c = await call('GET', '/gig-templates', await webToken());
    expect(GigTemplateChoicesResponse.safeParse(c.json()).success).toBe(true);
    expect(dataOf(c)).toEqual(JSON.parse(JSON.stringify(choicesFixture())));
  });

  it('field values keep their JSON types: integer, boolean, text and null', async () => {
    const v = dataOf(await call('GET', `/gigs/${GIG_ID}/versions/1`, await webToken())) as unknown as GigVersionDto;
    expect(v.fieldValues).toEqual([
      { fieldKey: 'rooms', value: 3 },
      { fieldKey: 'pets', value: true },
      { fieldKey: 'notes', value: 'bring supplies' },
      { fieldKey: 'extra', value: null },
    ]);
  });

  it('a hostile service result (extra properties, ids, contacts, a go-live flag) never reaches the client', async () => {
    const hostile = {
      ...detailFixture(),
      accountId: ACCOUNT_ID,
      email: SENTINELS[0],
      gig: { ...gigFixture(), accountId: ACCOUNT_ID, gigTemplateId: 'raw-internal-id', clientRequestId: REQUEST_ID },
      draftVersion: {
        ...versionFixture(),
        gigId: 'raw-internal-id',
        accountId: ACCOUNT_ID,
        phone: SENTINELS[1],
        price: { amountMinor: 4500, currency: 'USD', floatValue: 45.0, accountId: ACCOUNT_ID },
        template: {
          ...template(),
          gigTemplateId: 'raw-internal-id',
          requirements: [{ requirementType: 'VERIFICATION', referenceCode: 'identity', internal: 'raw-internal-id' }],
        },
      },
    };
    svc.getGig.mockResolvedValueOnce(hostile);
    const res = await call('GET', `/gigs/${GIG_ID}`, await webToken());
    expect(res.statusCode).toBe(200);
    for (const s of [...SENTINELS.slice(0, 2), 'raw-internal-id', ACCOUNT_ID, REQUEST_ID, 'floatValue', 'clientRequestId'])
      expect(res.body, s).not.toContain(s);
    expect(keysOf((dataOf(res).draftVersion as { price: object }).price)).toEqual(['amountMinor', 'currency']);

    svc.listProviderGigs.mockResolvedValueOnce({
      ...menuFixture(),
      accountId: ACCOUNT_ID,
      readiness: { ...menuFixture().readiness, goLive: { evaluated: true, eligible: true }, live: true },
    });
    const menu = await call('GET', '/gigs', await webToken());
    expect(menu.body).not.toContain(ACCOUNT_ID);
    expect(dataOf(menu).readiness).toEqual({
      hasPublishedGig: true,
      publishedGigCount: 1,
      draftVersionCount: 1,
      goLive: { evaluated: false, eligible: false },
    });
  });

  it('an issue message key is derived from the reason, never taken from the service', async () => {
    const v = versionFixture({ issues: [{ target: 'field', fieldKey: 'rooms', reason: 'FIELD_REQUIRED', messageKey: 'Sentinel-message-text' }] });
    svc.getGigVersion.mockResolvedValueOnce(v);
    const res = await call('GET', `/gigs/${GIG_ID}/versions/1`, await webToken());
    expect((dataOf(res).issues as unknown[])[0]).toEqual({
      target: 'field',
      fieldKey: 'rooms',
      reason: 'FIELD_REQUIRED',
      messageKey: gigIssueKey('FIELD_REQUIRED'),
    });
    expect(res.body).not.toContain('Sentinel-message-text');
  });
});

// ====================================================================== error mapping
describe('typed Gig failures become the standard error envelope', () => {
  const EXPECTED: Record<GigErrorCode, [number, string]> = {
    GIG_NOT_FOUND: [404, 'NOT_FOUND'],
    GIG_VERSION_NOT_FOUND: [404, 'NOT_FOUND'],
    GIG_TEMPLATE_NOT_FOUND: [404, 'NOT_FOUND'],
    GIG_TEMPLATE_NOT_AVAILABLE: [409, 'CONFLICT'],
    PROVIDER_NOT_ELIGIBLE: [403, 'AUTHORIZATION'],
    ACCOUNT_NOT_ACTIVE: [403, 'AUTHORIZATION'],
    GIG_RETIRED: [409, 'CONFLICT'],
    DRAFT_EXISTS: [409, 'CONFLICT'],
    NO_DRAFT: [409, 'CONFLICT'],
    STALE_DRAFT: [409, 'CONFLICT'],
    PUBLISH_BLOCKED: [409, 'CONFLICT'],
    LIMIT_REACHED: [409, 'CONFLICT'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
  };

  it('covers every contract error code', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...GIG_ERROR_CODES].sort());
  });

  it.each(GIG_ERROR_CODES)('%s: status, category, GIG_ code and message key', async (code) => {
    const [status, category] = EXPECTED[code];
    svc.getGig.mockRejectedValueOnce(new GigError(code, TEXT_SENTINEL, { reason: 'SOME_REASON' }));
    const res = await call('GET', `/gigs/${GIG_ID}`, await webToken());
    expect(res.statusCode).toBe(status);
    const e = errorOf(res);
    expect(e.category).toBe(category);
    expect(e.code).toBe(gigApiErrorCode(code));
    expect(e.code).toBe(code.startsWith('GIG_') ? code : `GIG_${code}`);
    expect(e.message).not.toContain(TEXT_SENTINEL);
    expect(res.body).not.toContain(TEXT_SENTINEL);
    expect((e.details as Record<string, unknown>).messageKey).toBe(gigErrorKey(code));
    expectNoStore(res);
    expect(ErrorResponse.safeParse(res.json()).success).toBe(true);
  });

  it('UNAVAILABLE carries only the message key (no reason, no cause)', async () => {
    svc.listProviderGigs.mockRejectedValueOnce(
      new GigError('UNAVAILABLE', 'db down: password=hunter2', { reason: 'POLICY_INVALID', cause: 'ECONNREFUSED 10.0.0.1' }),
    );
    const res = await call('GET', '/gigs', await webToken());
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).details).toEqual({ messageKey: gigErrorKey('UNAVAILABLE') });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('10.0.0.1');
  });

  it('PUBLISH_BLOCKED lists identifier-only issues (target, field key, reason, derived message key) and drops everything else', async () => {
    svc.publish.mockRejectedValueOnce(
      new GigError('PUBLISH_BLOCKED', 'blocked', {
        issues: [
          { target: 'title', reason: 'TITLE_REQUIRED', messageKey: 'evil', text: TEXT_SENTINEL },
          { target: 'field', fieldKey: 'rooms', reason: 'FIELD_REQUIRED', value: TEXT_SENTINEL },
          { target: 'field', fieldKey: 'Not A Key!', reason: 'FIELD_REQUIRED' },
          { target: 'bogus', reason: 'TITLE_REQUIRED' },
          { target: 'price', reason: 'NOT_A_REASON' },
          'a string',
          null,
        ],
        title: TEXT_SENTINEL,
        value: TEXT_SENTINEL,
      }),
    );
    const res = await call('POST', `/gigs/${GIG_ID}/publish`, await webToken(), PUBLISH_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('GIG_PUBLISH_BLOCKED');
    expect(errorOf(res).details).toEqual({
      messageKey: gigErrorKey('PUBLISH_BLOCKED'),
      issues: [
        { target: 'title', reason: 'TITLE_REQUIRED', messageKey: gigIssueKey('TITLE_REQUIRED') },
        { target: 'field', fieldKey: 'rooms', reason: 'FIELD_REQUIRED', messageKey: gigIssueKey('FIELD_REQUIRED') },
        { target: 'field', reason: 'FIELD_REQUIRED', messageKey: gigIssueKey('FIELD_REQUIRED') },
      ],
    });
    expect(res.body).not.toContain(TEXT_SENTINEL);
  });

  it('every issue reason has a derived message key and survives the allow-list', () => {
    for (const reason of GIG_ISSUE_REASONS) {
      const d = safeDetails({ issues: [{ target: 'title', reason }] });
      expect(d.issues).toEqual([{ target: 'title', reason, messageKey: gigIssueKey(reason) }]);
    }
  });

  it('the details allow-list keeps short tokens, small integer bounds and the retryable flag only', () => {
    const d = safeDetails({
      reason: 'ROLE_NOT_ACTIVE',
      field: 'title',
      code: 'MAX_ACTIVE',
      retryable: true,
      limit: 25,
      max: 10,
      count: 3,
      text: TEXT_SENTINEL,
      title: TEXT_SENTINEL,
      sql: 'select 1',
      cause: new Error('x'),
    });
    expect(d).toEqual({ reason: 'ROLE_NOT_ACTIVE', field: 'title', code: 'MAX_ACTIVE', retryable: true, limit: 25, max: 10, count: 3 });
    expect(safeDetails({ reason: TEXT_SENTINEL, field: 'a b', code: 'x'.repeat(65), limit: -1, max: 1.5, count: 100_001, retryable: 'yes' })).toEqual({});
    expect(safeDetails({ issues: Array.from({ length: 200 }, () => ({ target: 'title', reason: 'TITLE_REQUIRED' })) }).issues).toHaveLength(64);
  });

  it('LIMIT_REACHED and STALE_DRAFT keep their allow-listed details', async () => {
    svc.createGig.mockRejectedValueOnce(new GigError('LIMIT_REACHED', 'x', { reason: 'MAX_DRAFTS', limit: 10, secret: TEXT_SENTINEL }));
    const res = await call('POST', '/gigs', await webToken(), CREATE_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: 'MAX_DRAFTS', limit: 10, messageKey: gigErrorKey('LIMIT_REACHED') });
    svc.updateDraft.mockRejectedValueOnce(new GigError('STALE_DRAFT', 'x', { reason: 'REVISION_MISMATCH', retryable: true }));
    const stale = await call('PUT', `/gigs/${GIG_ID}/draft`, await webToken(), DRAFT_BODY);
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details).toEqual({ reason: 'REVISION_MISMATCH', retryable: true, messageKey: gigErrorKey('STALE_DRAFT') });
  });

  it('an unexpected (non-Gig) failure stays a generic 500 and leaks nothing', async () => {
    svc.getGig.mockRejectedValueOnce(new Error(`kaboom ${TEXT_SENTINEL}`));
    const res = await call('GET', `/gigs/${GIG_ID}`, await webToken());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('kaboom');
    expect(res.body).not.toContain(TEXT_SENTINEL);
  });

  it('toAppError rethrows anything that is not a GigError', () => {
    const boom = new Error('x');
    expect(() => toAppError(boom)).toThrow(boom);
  });
});

// ====================================================================== wiring
describe('the policy provider reads the configuration registry with no code default', () => {
  const values = (over: Record<string, unknown> = {}) =>
    new Map(
      Object.entries({
        [PROVIDER_GIG_POLICY_KEYS.maxActive]: 25,
        [PROVIDER_GIG_POLICY_KEYS.maxDrafts]: 10,
        [PROVIDER_GIG_POLICY_KEYS.titleMaxLength]: 100,
        [PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength]: 1000,
        [PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength]: 5000,
        ...over,
      }).map(([k, value]) => [k, { value }]),
    );

  it('returns the typed policy and asks for exactly the five keys', async () => {
    const resolveMany = vi.fn(async () => ({ values: values() }));
    const policy = await createGigPolicyProvider({ resolveMany } as never).policy();
    expect(policy).toEqual({ maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 });
    expect((resolveMany.mock.calls[0] as unknown as [string[]])[0].sort()).toEqual(Object.values(PROVIDER_GIG_POLICY_KEYS).sort());
  });

  it.each([
    ['a missing value', () => ({ values: new Map([...values()].filter(([k]) => k !== PROVIDER_GIG_POLICY_KEYS.maxActive)) })],
    ['a malformed value', () => ({ values: values({ [PROVIDER_GIG_POLICY_KEYS.maxDrafts]: '10' }) })],
    ['a value above the ceiling', () => ({ values: values({ [PROVIDER_GIG_POLICY_KEYS.titleMaxLength]: 201 }) })],
    ['a value below the floor', () => ({ values: values({ [PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength]: 0 }) })],
  ])('%s fails closed with UNAVAILABLE (POLICY_INVALID)', async (_n, make) => {
    const provider = createGigPolicyProvider({ resolveMany: async () => make() } as never);
    await expect(provider.policy()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
  });

  it('an unreadable registry fails closed with UNAVAILABLE (POLICY_UNREADABLE)', async () => {
    const provider = createGigPolicyProvider({ resolveMany: async () => Promise.reject(new Error('redis down')) } as never);
    await expect(provider.policy()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
  });
});

// ====================================================================== the Gig Template port and the onboarding step
describe('the Gig Template port over the catalogue', () => {
  const detail = (over: Partial<GigTemplateVersionDetailView> = {}): GigTemplateVersionDetailView =>
    ({
      gigTemplateId: '11111111-1111-4111-8111-111111111111',
      code: 'regular_cleaning_basic',
      templateStatus: 'ACTIVE',
      serviceTypeCode: 'regular_cleaning',
      serviceTypeStatus: 'ACTIVE',
      categoryCode: 'home_cleaning',
      nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
      descriptionContentKey: null,
      instructionsContentKey: 'catalog.gig_template.regular_cleaning_basic.instructions',
      version: {
        gigTemplateVersionId: TEMPLATE_VERSION_ID,
        versionNumber: 2,
        duration: { minMinutes: 30, maxMinutes: 480, suggestedMinutes: 90 },
        pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
        areaModes: ['RADIUS'],
        fieldCount: 2,
        status: 'ACTIVE',
      },
      fields: [
        {
          gigTemplateFieldId: '22222222-2222-4222-8222-222222222222',
          fieldKey: 'size',
          fieldType: 'ENUM',
          section: 'DETAILS',
          behavior: 'PROVIDER_CONFIGURABLE',
          customerVisible: true,
          displayOrder: 1,
          labelContentKey: 'catalog.field.size.label',
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
          options: [
            { optionCode: 'small', labelContentKey: 'catalog.option.small', isDefault: false, displayOrder: 1 },
            { optionCode: 'large', labelContentKey: 'catalog.option.large', isDefault: true, displayOrder: 2 },
          ],
        },
      ],
      requirements: [{ requirementType: 'VERIFICATION', referenceCode: 'identity' }],
      ...over,
    }) as GigTemplateVersionDetailView;
  const listed = (code: string, serviceTypeCode: string, displayOrder: number | null, withVersion = true) => ({
    code,
    serviceTypeCode,
    categoryCode: 'home_cleaning',
    nameContentKey: `catalog.gig_template.${code}.name`,
    descriptionContentKey: null,
    displayOrder,
    activeVersion: withVersion ? { versionNumber: 4 } : null,
  });
  const catalog = (over: Record<string, unknown> = {}) => ({
    listGigTemplatesForMarket: vi.fn(async () => ({ templates: [] as unknown[] })),
    getGigTemplateForMarket: vi.fn(),
    getGigTemplateVersionById: vi.fn(async () => detail()),
    getGigTemplateStructure: vi.fn(async () => detail()),
    isGigTemplateEnabledInMarket: vi.fn(async () => true),
    ...over,
  });
  const portOf = (c: ReturnType<typeof catalog>) => createGigTemplatePort(c as never);

  it('maps the exact version into the Gig facts: pricing models, default option, field identities, content keys, requirement hooks', () => {
    const f = toGigTemplateStructure(detail());
    expect(f).toMatchObject({
      gigTemplateId: '11111111-1111-4111-8111-111111111111',
      gigTemplateCode: 'regular_cleaning_basic',
      templateStatus: 'ACTIVE',
      serviceTypeStatus: 'ACTIVE',
      gigTemplateVersionId: TEMPLATE_VERSION_ID,
      versionNumber: 2,
      versionStatus: 'ACTIVE',
      duration: { minMinutes: 30, maxMinutes: 480, suggestedMinutes: 90 },
      pricing: { fixed: true, fixedWithVariants: false },
      requirements: [{ requirementType: 'VERIFICATION', referenceCode: 'identity' }],
    });
    expect(f.fields[0]).toMatchObject({ gigTemplateFieldId: '22222222-2222-4222-8222-222222222222', fieldKey: 'size', defaultOption: 'large' });
    expect(f.fields[0]!.options.map((o) => o.optionCode)).toEqual(['small', 'large']);
    expect(toGigTemplateStructure(detail({ version: { ...detail().version, pricingModels: ['FIXED_WITH_VARIANTS'] } })).pricing).toEqual({
      fixed: false,
      fixedWithVariants: true,
    });
  });

  it('a version without a status (a public view) is an outage, never a guess', () => {
    const d = detail();
    expect(() => toGigTemplateStructure({ ...d, version: { ...d.version, status: undefined } })).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
  });

  it('offered: only the wanted service types, only templates with an active version, in the market order then code; nothing wanted means no catalogue read', async () => {
    const c = catalog({
      listGigTemplatesForMarket: vi.fn(async () => ({
        templates: [
          listed('b_tpl', 'regular_cleaning', 2),
          listed('a_tpl', 'regular_cleaning', 2),
          listed('other', 'car_detailing', 1),
          listed('first', 'regular_cleaning', 1),
          listed('none', 'regular_cleaning', 0, false),
        ],
      })),
    });
    const port = portOf(c);
    const offers = await port.offered('us-sf', ['regular_cleaning']);
    expect(offers.map((o) => o.gigTemplateCode)).toEqual(['first', 'a_tpl', 'b_tpl']);
    expect(offers[0]).toEqual({
      gigTemplateCode: 'first',
      serviceTypeCode: 'regular_cleaning',
      categoryCode: 'home_cleaning',
      nameContentKey: 'catalog.gig_template.first.name',
      descriptionContentKey: null,
      versionNumber: 4,
    });
    expect(await port.offered('us-sf', [])).toEqual([]);
    expect(c.listGigTemplatesForMarket).toHaveBeenCalledTimes(1);
  });

  it('offered: a market the public catalogue does not know offers nothing; any other catalogue failure is UNAVAILABLE', async () => {
    const port = portOf(catalog({ listGigTemplatesForMarket: vi.fn(async () => Promise.reject(new CatalogError('MARKET_NOT_FOUND', 'x'))) }));
    expect(await port.offered('zz-nowhere', ['regular_cleaning'])).toEqual([]);
    const down = portOf(catalog({ listGigTemplatesForMarket: vi.fn(async () => Promise.reject(new Error('connection refused'))) }));
    await expect(down.offered('us-sf', ['regular_cleaning'])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('forCreate: the structure of the ACTIVE version the market offers; null when the market does not offer the template or it has no active version', async () => {
    const c = catalog({ getGigTemplateForMarket: vi.fn(async () => ({ template: { activeVersion: { gigTemplateVersionId: TEMPLATE_VERSION_ID } } })) });
    expect((await portOf(c).forCreate('us-sf', 'regular_cleaning_basic'))?.gigTemplateVersionId).toBe(TEMPLATE_VERSION_ID);
    expect(c.getGigTemplateVersionById).toHaveBeenCalledWith(TEMPLATE_VERSION_ID);
    for (const code of ['GIG_TEMPLATE_NOT_FOUND', 'MARKET_NOT_FOUND'] as const) {
      const none = catalog({ getGigTemplateForMarket: vi.fn(async () => Promise.reject(new CatalogError(code, 'x'))) });
      expect(await portOf(none).forCreate('us-sf', 'nope')).toBeNull();
    }
    const noVersion = catalog({ getGigTemplateForMarket: vi.fn(async () => ({ template: { activeVersion: null } })) });
    expect(await portOf(noVersion).forCreate('us-sf', 'regular_cleaning_basic')).toBeNull();
    const down = catalog({ getGigTemplateForMarket: vi.fn(async () => Promise.reject(new Error('timeout'))) });
    await expect(portOf(down).forCreate('us-sf', 'x')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('byCode and exactVersion: null for an unknown code or version, UNAVAILABLE for anything else', async () => {
    const port = portOf(catalog());
    expect((await port.byCode('regular_cleaning_basic'))?.gigTemplateCode).toBe('regular_cleaning_basic');
    expect((await port.exactVersion(TEMPLATE_VERSION_ID))?.versionNumber).toBe(2);
    const missing = portOf(
      catalog({
        getGigTemplateStructure: vi.fn(async () => Promise.reject(new CatalogError('GIG_TEMPLATE_NOT_FOUND', 'x'))),
        getGigTemplateVersionById: vi.fn(async () => Promise.reject(new CatalogError('GIG_TEMPLATE_VERSION_NOT_FOUND', 'x'))),
      }),
    );
    expect(await missing.byCode('nope')).toBeNull();
    expect(await missing.exactVersion(TEMPLATE_VERSION_ID)).toBeNull();
    const down = portOf(catalog({ getGigTemplateVersionById: vi.fn(async () => Promise.reject(new Error('boom'))) }));
    await expect(down.exactVersion(TEMPLATE_VERSION_ID)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('enabledInMarket delegates; a catalogue failure is UNAVAILABLE', async () => {
    const c = catalog();
    expect(await portOf(c).enabledInMarket('us-sf', 'tpl-id')).toBe(true);
    expect(c.isGigTemplateEnabledInMarket).toHaveBeenCalledWith('us-sf', 'tpl-id');
    const down = portOf(catalog({ isGigTemplateEnabledInMarket: vi.fn(async () => Promise.reject(new Error('boom'))) }));
    await expect(down.enabledInMarket('us-sf', 'tpl-id')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('the onboarding GIGS step is answered by the Gig domain', () => {
  const facts = (over: Record<string, unknown>) => ({
    hasPublishedGig: false,
    publishedGigCount: 0,
    draftVersionCount: 0,
    goLive: { evaluated: false, eligible: false },
    ...over,
  });
  const stepOf = (f: () => Promise<unknown>) => createGigPrerequisites({ getGigReadinessFacts: f } as never);

  it.each([
    ['no Gig at all', facts({}), 'NOT_STARTED'],
    ['a draft and nothing published', facts({ draftVersionCount: 1 }), 'IN_PROGRESS'],
    ['a published Gig', facts({ hasPublishedGig: true, publishedGigCount: 1 }), 'COMPLETE'],
  ])('%s', async (_n, f, status) => {
    expect(await stepOf(async () => f).gigs(ACCOUNT_ID)).toEqual({ status });
  });

  it('a failure of the Gig domain reports NOT_AVAILABLE and never breaks the registration read; the other steps stay as they were', async () => {
    const p = stepOf(async () => Promise.reject(new Error('down')));
    expect(await p.gigs(ACCOUNT_ID)).toEqual({ status: 'NOT_AVAILABLE' });
    for (const step of ['verification', 'subscription', 'profile'] as const) expect(await p[step](ACCOUNT_ID), step).toEqual({ status: 'NOT_AVAILABLE' });
    const withRest = createGigPrerequisites({ getGigReadinessFacts: async () => facts({}) } as never, {
      verification: async () => ({ status: 'COMPLETE' }),
      subscription: async () => ({ status: 'NOT_AVAILABLE' }),
      profile: async () => ({ status: 'NOT_AVAILABLE' }),
      gigs: async () => ({ status: 'NOT_AVAILABLE' }),
    });
    expect(await withRest.verification(ACCOUNT_ID)).toEqual({ status: 'COMPLETE' });
  });
});

// ====================================================================== OpenAPI and the committed specs
describe('OpenAPI and the committed specs', () => {
  const swagger = () =>
    app.swagger() as unknown as {
      tags?: { name: string }[];
      paths: Record<
        string,
        Record<
          string,
          { operationId: string; tags: string[]; security?: unknown[]; responses: Record<string, unknown>; parameters?: { name: string; in: string }[] }
        >
      >;
    };

  it('documents exactly the 9 Gig operations with the right method, path, tag and bearer security', () => {
    const doc = swagger();
    const found: { operationId: string; method: string; path: string; tags: string[]; security: unknown }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith('/api/v1/provider'))
        for (const [method, op] of Object.entries(item))
          found.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, tags: op.tags, security: op.security });
    expect(found).toHaveLength(9);
    expect(found.map((f) => f.operationId).sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
    for (const r of ROUTES) {
      const f = found.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.tags, r.operationId).toEqual(['gigs']);
      expect(f.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    expect((doc.tags ?? []).map((t) => t.name)).toContain('gigs');
  });

  it('documents the failure responses, the 201/200 of the create, and the path parameters only where a Gig is addressed', () => {
    const doc = swagger();
    for (const r of ROUTES) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      expect(Object.keys(op.responses), r.operationId).toEqual(expect.arrayContaining([String(r.okStatus), '400', '401', '403', '404', '409', '503']));
      const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      expect(pathParams, r.operationId).toEqual(r.spec.includes('{version}') ? ['gigId', 'version'] : r.spec.includes('{gigId}') ? ['gigId'] : []);
    }
    expect(Object.keys(doc.paths['/api/v1/provider/gigs']!.post!.responses)).toEqual(expect.arrayContaining(['200', '201']));
    expect(Object.keys(doc.paths['/api/v1/provider/gigs/{gigId}/versions']!.post!.responses)).toContain('201');
  });

  it('declares no account id, owner or market anywhere in the documented parameters', () => {
    const doc = swagger();
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith('/api/v1/provider/gig'))
        for (const op of Object.values(item))
          for (const prm of op.parameters ?? []) expect(['accountId', 'owner', 'market', 'marketCode', 'status']).not.toContain(prm.name);
  });

  it('is not registered without the service, nor without the account service', async () => {
    const withoutService = await makeApp({ providerGigs: undefined });
    const withoutAccounts = await makeApp({ accounts: undefined });
    for (const target of [withoutService, withoutAccounts])
      for (const r of ROUTES) {
        const res = await routeCall(r, await webToken(), {}, target);
        expect(res.statusCode, r.operationId).toBe(404);
      }
    expect(noServiceCalled()).toBe(true);
  });

  it('the committed OpenAPI document contains every Gig operation and the committed AsyncAPI the three Gig events', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    for (const r of ROUTES) expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
    const asyncapi = readFileSync(path.join(root, 'docs/events/asyncapi.yaml'), 'utf8');
    for (const type of Object.values(GIG_EVENTS)) expect(asyncapi, type).toContain(type);
  });

  it('the Gig event payloads carry identifiers and counts only: no title, pitch, description, price or text property', () => {
    for (const payload of [GigCreatedPayload, GigVersionPublishedPayload, GigRetiredPayload])
      for (const key of Object.keys(payload.shape))
        expect(key, key).toMatch(/^(accountId|gigId|gigVersionId|versionNumber|gigTemplateVersionId|supersededGigVersionId)$/);
  });
});
