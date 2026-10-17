// Unit tests of the provider registration API module (PRO-001) with a FAKE ProviderRegistrationService and a FAKE AccountService, written by an independent author. The real rules are
// covered by packages/provider and provider.itest.ts; here: authentication and the identity context on all 7 operations (401 before 400, 403 for the admin context and for suspended or
// closed accounts, a customer who is NOT a provider is allowed, the active-role header is NOT honoured), that the service only ever receives the account of the VERIFIED TOKEN, that
// no account id / registration id / role / status / completion flag is accepted from a client, strict bodies and queries, the cache policy (no-store everywhere, router failures included),
// status codes, exact response key sets and the absence of contact / legal / name values, the error mapping for EVERY ProviderError code with its details allow-list, the body size
// limit, the OpenAPI document and the committed specs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ErrorResponse,
  ONBOARDING_STEPS,
  PROVIDER_ERROR_CODES,
  PROVIDER_EVENTS,
  PROVIDER_POLICY_KEYS,
  ProviderRegistrationStateResponse,
  ProviderRequirementsResponse,
  providerErrorKey,
  providerStepLabelKey,
  providerStepStatusKey,
  type ProviderErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService } from '@bananagig/accounts';
import { ProviderError, type ProviderRegistrationService, type RegistrationView, type Requirements } from '@bananagig/provider';
import { GeographyError } from '@bananagig/geography';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { registrationDto, requirementsDto, safeDetails, stateDto } from './modules/provider/dto';
import { PROVIDER_BODY_LIMIT } from './modules/provider/routes';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- fakes
const svc = {
  getRegistration: vi.fn(),
  startRegistration: vi.fn(),
  selectMarket: vi.fn(),
  replaceServiceTypes: vi.fn(),
  getRequirements: vi.fn(),
  submitRegistration: vi.fn(),
  cancelRegistration: vi.fn(),
};
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn() };
const noServiceCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-subject-marker-other-91d3';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const REGISTRATION_ID = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const OTHER_REGISTRATION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const ISO = '2026-10-16T12:00:00.000Z';
/** Values the fake account and the fake service carry: NONE of them may ever appear in a response. */
const SENTINELS = [
  'sentinel.mail@sentinel-contact.example',
  's***l@sentinel-contact.example',
  '+15550001234',
  'Sentinel-First-Name',
  'Sentinel-Last-Name',
  'SENTINEL LEGAL TEXT: you agree to everything',
  'sentinel-body-sha-0123456789',
  'sentinel-consent-event-id',
  SUB,
  KEYCLOAK_SID,
];
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };

const state = {
  memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }] as { code: string; status: 'PENDING' | 'ACTIVE' | 'INACTIVE' }[],
  emailVerified: false,
  phoneVerified: true,
};
const resetState = () => {
  state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
  state.emailVerified = false;
  state.phoneVerified = true;
};
const makeContext = (accountId: string): AccountContext =>
  ({
    accountId,
    status: 'ACTIVE',
    roles: state.memberships.filter((m) => m.status === 'ACTIVE').map((m) => (m.code === 'PROVIDER' ? PROVIDER : CUSTOMER)),
    memberships: state.memberships,
    primaryRole: 'CUSTOMER',
    activeRole: 'CUSTOMER',
    profile: { firstName: 'Sentinel-First-Name', lastName: 'Sentinel-Last-Name', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
    email: { emailVerificationStatus: state.emailVerified ? 'VERIFIED' : 'NONE', primary: { address: 's***l@sentinel-contact.example' }, pending: null },
    phone: { phoneVerificationStatus: 'VERIFIED', primary: { number: '+15550001234' }, pending: null },
    contacts: { emailVerified: state.emailVerified, phoneVerified: state.phoneVerified, contactsVerified: state.emailVerified && state.phoneVerified },
    createdAt: T0,
    created: false,
  }) as unknown as AccountContext;

const view = (over: Partial<RegistrationView> = {}): RegistrationView => ({
  providerRegistrationId: REGISTRATION_ID,
  attempt: 1,
  status: 'IN_PROGRESS',
  revision: 2,
  marketCode: 'us-sf',
  serviceTypeCodes: ['car_detailing', 'regular_cleaning'],
  createdAt: ISO,
  completedAt: null,
  cancelledAt: null,
  ...over,
});
const stateOf = (over: Partial<RegistrationView> = {}, role: 'NONE' | 'PENDING' | 'ACTIVE' | 'INACTIVE' = 'PENDING') => ({
  providerRole: role,
  registration: view(over),
});
const requirementsFixture = (): Requirements => ({
  providerRole: 'PENDING',
  registration: view(),
  steps: [
    { step: 'ACCOUNT', status: 'COMPLETE', owner: 'ID-001' },
    { step: 'CONTACT', status: 'IN_PROGRESS', owner: 'ID-002, ID-003', detail: { email: 'NOT_VERIFIED', phone: 'VERIFIED' } },
    { step: 'LEGAL', status: 'NOT_STARTED', owner: 'ID-005', detail: { outstandingPurposes: ['TERMS_OF_SERVICE'] } },
    { step: 'MARKET', status: 'COMPLETE', owner: 'PRO-001', detail: { marketCode: 'us-sf' } },
    { step: 'SERVICES', status: 'BLOCKED', owner: 'PRO-001', detail: { selected: 2, min: 1, max: 10, notOffered: ['regular_cleaning'] } },
    { step: 'VERIFICATION', status: 'NOT_AVAILABLE', owner: 'TRUST-001' },
    { step: 'SUBSCRIPTION', status: 'NOT_AVAILABLE', owner: 'SUB' },
    { step: 'PROFILE', status: 'NOT_AVAILABLE', owner: 'PRO-002' },
    { step: 'GIGS', status: 'NOT_AVAILABLE', owner: 'CAT-003' },
  ],
  overall: {
    registrationComplete: false,
    registrationReady: false,
    blockedBy: ['CONTACT', 'LEGAL', 'SERVICES'],
    goLive: { evaluated: false, eligible: false },
  },
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
const expectNoSentinel = (r: Reply) => {
  for (const s of SENTINELS) expect(r.body, `leaked ${s}`).not.toContain(s);
};

// ---------------------------------------------------------------- the 7 operations
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  body?: unknown;
  /** A body the route is sent with when it has no required one (see the known defect on the body-less cancel) */
  send?: unknown;
  okStatus: number;
  fn: keyof typeof svc;
}
const MARKET_BODY = { marketCode: 'us-sf', expectedRevision: 2 };
const SERVICES_BODY = { serviceTypeCodes: ['car_detailing', 'regular_cleaning'], expectedRevision: 2 };
const SUBMIT_BODY = { expectedRevision: 2 };
const ROUTES: Route[] = [
  { operationId: 'getProviderRegistration', method: 'GET', url: '/registration', spec: '/api/v1/provider/registration', okStatus: 200, fn: 'getRegistration' },
  {
    operationId: 'startProviderRegistration',
    method: 'POST',
    url: '/registration',
    spec: '/api/v1/provider/registration',
    okStatus: 200,
    fn: 'startRegistration',
  },
  {
    operationId: 'selectProviderMarket',
    method: 'PUT',
    url: '/registration/market',
    spec: '/api/v1/provider/registration/market',
    body: MARKET_BODY,
    okStatus: 200,
    fn: 'selectMarket',
  },
  {
    operationId: 'replaceProviderServices',
    method: 'PUT',
    url: '/registration/services',
    spec: '/api/v1/provider/registration/services',
    body: SERVICES_BODY,
    okStatus: 200,
    fn: 'replaceServiceTypes',
  },
  {
    operationId: 'getProviderRegistrationRequirements',
    method: 'GET',
    url: '/registration/requirements',
    spec: '/api/v1/provider/registration/requirements',
    okStatus: 200,
    fn: 'getRequirements',
  },
  {
    operationId: 'submitProviderRegistration',
    method: 'POST',
    url: '/registration/submit',
    spec: '/api/v1/provider/registration/submit',
    body: SUBMIT_BODY,
    okStatus: 200,
    fn: 'submitRegistration',
  },
  {
    operationId: 'cancelProviderRegistration',
    method: 'POST',
    url: '/registration/cancel',
    spec: '/api/v1/provider/registration/cancel',
    send: {},
    okStatus: 200,
    fn: 'cancelRegistration',
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
  providerRegistrations: svc as unknown as ProviderRegistrationService,
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
  resetState();
  for (const f of [...Object.values(svc), ...Object.values(accountSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }, o: { requestedRole?: string } = {}) => {
    // what the REAL account guard does with the x-active-role header: a role the account does not hold or that is not ACTIVE is a 403
    if (o.requestedRole !== undefined) {
      const m = state.memberships.find((x) => x.code === o.requestedRole);
      if (!m) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold the role', { role: o.requestedRole });
      if (m.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: o.requestedRole });
    }
    return makeContext(identity.subject === OTHER_SUB ? OTHER_ACCOUNT_ID : ACCOUNT_ID);
  });
  svc.getRegistration.mockImplementation(async () => stateOf());
  svc.startRegistration.mockImplementation(async () => ({ created: true, state: stateOf({ revision: 1, marketCode: null, serviceTypeCodes: [] }) }));
  svc.selectMarket.mockImplementation(async () => stateOf({ revision: 3 }));
  svc.replaceServiceTypes.mockImplementation(async () => stateOf({ revision: 3 }));
  svc.getRequirements.mockImplementation(async () => requirementsFixture());
  svc.submitRegistration.mockImplementation(async () => ({
    changed: true,
    state: stateOf({ status: 'COMPLETED', completedAt: ISO }, 'ACTIVE'),
    requirements: { ...requirementsFixture(), providerRole: 'ACTIVE', registration: view({ status: 'COMPLETED', completedAt: ISO }) },
  }));
  svc.cancelRegistration.mockImplementation(async () => ({ changed: true, state: stateOf({ status: 'CANCELLED', cancelledAt: ISO }) }));
});

// ====================================================================== authentication and the identity context
describe('provider API authentication and the account guard', () => {
  it.each(ROUTES)('$method $url ($operationId) requires a token: 401, no-store, before any service or account call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $url ($operationId) rejects every kind of invalid token with 401 invalid_token', async (r) => {
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
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $url ($operationId) refuses the admin identity context and any other client with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED', async (r) => {
    const admin = await routeCall(r, await adminToken());
    expect(admin.statusCode).toBe(403);
    expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    expectNoStore(admin);
    for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) {
      const res = await routeCall(r, await webToken({ azp }));
      expect(res.statusCode, azp).toBe(403);
      expect(errorOf(res).code).toBe('ACCOUNT_CONTEXT_NOT_SUPPORTED');
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $url ($operationId) passes a suspended or closed account through as 403 and never calls the service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 before 400 and 403 before 400: an invalid body without a token or with the admin token', async () => {
    for (const r of BODY_ROUTES)
      for (const body of [{ garbage: true }, [], 'text', 7, null]) {
        expect((await rawBody(r.method, r.url, undefined, JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(r.method, r.url, 'bad.token', JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(r.method, r.url, await adminToken(), JSON.stringify(body))).statusCode, r.url).toBe(403);
      }
    for (const url of ['/registration?accountId=x', '/registration/requirements?locale=e&role=PROVIDER']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
      expect((await call('GET', url, await adminToken())).statusCode, url).toBe(403);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$method $url ($operationId) is open to a web customer who is NOT a provider (the registration is how one becomes one)', async (r) => {
    state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
    const res = await routeCall(r, await webToken());
    expect(res.statusCode, res.body).toBe(r.okStatus === 200 && r.fn === 'startRegistration' ? 201 : r.okStatus);
    expect(svc[r.fn]).toHaveBeenCalledTimes(1);
    expectNoStore(res);
  });

  it.each(ROUTES)(
    '$method $url ($operationId) does NOT honour x-active-role: a PENDING, INACTIVE or unheld PROVIDER role in the header is not a 403',
    async (r) => {
      for (const memberships of [
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'PENDING' },
        ],
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'INACTIVE' },
        ],
        [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      ] as (typeof state.memberships)[]) {
        state.memberships = memberships;
        for (const header of ['PROVIDER', 'CUSTOMER', 'ADMIN', 'PROVIDER,CUSTOMER']) {
          svc[r.fn].mockClear();
          const res = await routeCall(r, await webToken(), { 'x-active-role': header });
          expect(res.statusCode, `${header} ${JSON.stringify(memberships)} ${res.body}`).toBeLessThan(300);
          expect(svc[r.fn]).toHaveBeenCalledTimes(1);
        }
      }
      // and the guard was never ASKED to resolve a role
      for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].requestedRole).toBeUndefined();
    },
  );
});

// ====================================================================== the account of the token, never of the client
describe('the service is called with the account of the verified token only', () => {
  it.each(ROUTES)('$method $url ($operationId): the first argument is the token account; the identity the guard saw is the token subject', async (r) => {
    await routeCall(r, await webToken());
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(identityOf(SUB));
    const other = await routeCall(r, await webToken({ sub: OTHER_SUB }));
    expect(other.statusCode).toBeLessThan(300);
    expect(svc[r.fn].mock.calls[1]![0]).toBe(OTHER_ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[1]![0]).toEqual(identityOf(OTHER_SUB));
  });

  it.each(ROUTES)('$method $url ($operationId): an account id, registration id or role in a header, the query or the cookie changes nothing', async (r) => {
    const headers = {
      'x-account-id': OTHER_ACCOUNT_ID,
      'x-provider-registration-id': OTHER_REGISTRATION_ID,
      'x-forwarded-user': OTHER_SUB,
      cookie: `accountId=${OTHER_ACCOUNT_ID}`,
    };
    const res = await call(r.method, r.url, await webToken(), r.body ?? r.send, headers);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_REGISTRATION_ID);
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
  });

  it.each(ROUTES)(
    '$method $url ($operationId): an account id, registration id, role, status or completion flag in the QUERY never reaches the service (the GET reads reject it with 400; the writes ignore it)',
    async (r) => {
      for (const q of [
        `accountId=${OTHER_ACCOUNT_ID}`,
        `providerRegistrationId=${OTHER_REGISTRATION_ID}`,
        'role=PROVIDER',
        'status=COMPLETED',
        'completed=true',
      ]) {
        svc[r.fn].mockClear();
        const res = await call(r.method, `${r.url}?${q}`, await webToken(), r.body ?? r.send);
        expectNoStore(res);
        if (r.method === 'GET') {
          expect(res.statusCode, `${r.url}?${q}: ${res.body}`).toBe(400);
          expect(errorOf(res).code).toBe('VALIDATION_FAILED');
          expect(svc[r.fn]).not.toHaveBeenCalled();
        } else {
          // no querystring schema on the writes: the parameter is not read by anything
          expect(res.statusCode, `${r.url}?${q}: ${res.body}`).toBeLessThan(300);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_REGISTRATION_ID);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain('COMPLETED');
          expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
        }
      }
    },
  );

  it.each(BODY_ROUTES)('$method $url ($operationId): an account id, registration id, role, status or completion flag in the BODY is a 400', async (r) => {
    for (const extra of [
      { accountId: OTHER_ACCOUNT_ID },
      { account_id: OTHER_ACCOUNT_ID },
      { providerRegistrationId: OTHER_REGISTRATION_ID },
      { role: 'PROVIDER' },
      { providerRole: 'ACTIVE' },
      { status: 'COMPLETED' },
      { completed: true },
      { registrationComplete: true },
      { goLive: true },
      { attempt: 9 },
      { revision: 9 },
    ]) {
      const res = await call(r.method, r.url, await webToken(), { ...(r.body as object), ...extra });
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
      expectNoStore(res);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/registration'],
    ['POST', '/registration/cancel'],
  ] as const)('%s %s (body optional): an account id, registration id, role, status or completion flag in the body is a 400', async (method, url) => {
    for (const extra of [
      { accountId: OTHER_ACCOUNT_ID },
      { providerRegistrationId: OTHER_REGISTRATION_ID },
      { role: 'PROVIDER' },
      { status: 'COMPLETED' },
      { completed: true },
    ]) {
      const res = await call(method, url, await webToken(), extra);
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
    }
    expect(svc.startRegistration).not.toHaveBeenCalled();
    expect(svc.cancelRegistration).not.toHaveBeenCalled();
  });

  it('the service receives the parsed contract and nothing else: the market, the service types and the revision (cancel receives an empty object, never a reason)', async () => {
    await call('PUT', '/registration/market', await webToken(), MARKET_BODY);
    expect(svc.selectMarket.mock.calls[0]).toEqual([ACCOUNT_ID, { marketCode: 'us-sf', expectedRevision: 2 }]);
    await call('PUT', '/registration/market', await webToken(), { marketCode: 'us-sf' });
    expect(svc.selectMarket.mock.calls[1]).toEqual([ACCOUNT_ID, { marketCode: 'us-sf' }]);
    await call('PUT', '/registration/services', await webToken(), SERVICES_BODY);
    expect(svc.replaceServiceTypes.mock.calls[0]).toEqual([ACCOUNT_ID, SERVICES_BODY]);
    await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: [] });
    expect(svc.replaceServiceTypes.mock.calls[1]).toEqual([ACCOUNT_ID, { serviceTypeCodes: [] }]);
    await call('POST', '/registration/submit', await webToken(), SUBMIT_BODY);
    expect(svc.submitRegistration.mock.calls[0]).toEqual([ACCOUNT_ID, SUBMIT_BODY]);
    await call('POST', '/registration/cancel', await webToken(), {});
    expect(svc.cancelRegistration.mock.calls[0]).toEqual([ACCOUNT_ID, {}]);
    await call('POST', '/registration/cancel', await webToken());
    expect(svc.cancelRegistration.mock.calls[1]).toEqual([ACCOUNT_ID, {}]);
    await rawBody('POST', '/registration/cancel', await webToken(), 'null');
    expect(svc.cancelRegistration.mock.calls[2]).toEqual([ACCOUNT_ID, {}]);
    expect(svc.cancelRegistration).toHaveBeenCalledTimes(3);
    await call('POST', '/registration', await webToken());
    expect(svc.startRegistration.mock.calls[0]).toEqual([ACCOUNT_ID, {}]);
  });

  it('the reads receive the account facts the request guard already loaded (ids, statuses and verified flags only: no contact, no name)', async () => {
    state.memberships = [
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'PENDING' },
    ];
    state.emailVerified = true;
    state.phoneVerified = false;
    const expectedFacts = {
      accountId: ACCOUNT_ID,
      status: 'ACTIVE',
      memberships: [
        { code: 'CUSTOMER', status: 'ACTIVE' },
        { code: 'PROVIDER', status: 'PENDING' },
      ],
      emailVerified: true,
      phoneVerified: false,
    };
    await call('GET', '/registration', await webToken());
    expect(svc.getRegistration.mock.calls[0]).toEqual([ACCOUNT_ID, { facts: expectedFacts }]);
    await call('GET', '/registration/requirements', await webToken());
    expect(svc.getRequirements.mock.calls[0]).toEqual([ACCOUNT_ID, { locale: undefined, facts: expectedFacts }]);
    await call('GET', '/registration/requirements?locale=es-MX', await webToken());
    expect(svc.getRequirements.mock.calls[1]).toEqual([ACCOUNT_ID, { locale: 'es-MX', facts: expectedFacts }]);
    for (const s of SENTINELS) expect(JSON.stringify([...svc.getRegistration.mock.calls, ...svc.getRequirements.mock.calls])).not.toContain(s);
    // the guard asked for no profile (the registration does not need the name)
    for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].includeProfile).toBeFalsy();
  });
});

// ====================================================================== cache policy
describe('Cache-Control: no-store on every response', () => {
  it.each(ROUTES)('$method $url ($operationId): success, validation, service errors and an unexpected failure are all no-store', async (r) => {
    const ok = await routeCall(r, await webToken());
    expectNoStore(ok);
    for (const code of PROVIDER_ERROR_CODES) {
      svc[r.fn].mockRejectedValueOnce(new ProviderError(code, 'x'));
      expectNoStore(await routeCall(r, await webToken()));
    }
    svc[r.fn].mockRejectedValueOnce(new Error('kaboom'));
    const boom = await routeCall(r, await webToken());
    expect(boom.statusCode).toBe(500);
    expectNoStore(boom);
  });

  it('401, 403 and 400 are no-store', async () => {
    expectNoStore(await call('GET', '/registration'));
    expectNoStore(await call('GET', '/registration', 'bad.token'));
    expectNoStore(await call('GET', '/registration', await adminToken()));
    expectNoStore(await call('PUT', '/registration/market', await webToken(), {}));
    expectNoStore(await call('GET', '/registration/requirements?locale=e', await webToken()));
  });

  it('router-level failures under the prefix are no-store too: unknown paths, wrong methods and an undecodable URL', async () => {
    for (const [m, u] of [
      ['GET', '/'],
      ['GET', '/nope'],
      ['GET', '/registration/nope'],
      ['DELETE', '/registration'],
      ['PATCH', '/registration/market'],
      ['POST', '/registration/market'],
      ['GET', '/registration/market'],
      ['GET', '/registration/submit'],
      ['GET', '/registration/cancel'],
    ] as const) {
      const anon = await call(m, u);
      expect(anon.statusCode, `${m} ${u}`).toBe(404);
      expect(errorOf(anon).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(anon);
    }
    const bad = await app.inject({ method: 'GET', url: '/api/v1/provider/registration/%E0%A4%A' });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('BAD_URL');
    expectNoStore(bad);
    const upper = await app.inject({ method: 'GET', url: '/API/V1/PROVIDER/registration' });
    expect(upper.statusCode).toBe(404);
    expectNoStore(upper);
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== status codes and response shapes
describe('status codes and response shapes', () => {
  it('POST /registration answers 201 when the attempt was created and 200 when a live one was resumed', async () => {
    const created = await call('POST', '/registration', await webToken());
    expect(created.statusCode, created.body).toBe(201);
    svc.startRegistration.mockResolvedValueOnce({ created: false, state: stateOf() });
    const resumed = await call('POST', '/registration', await webToken());
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(dataOf(resumed).registration).toMatchObject({ providerRegistrationId: REGISTRATION_ID });
    expect(ProviderRegistrationStateResponse.safeParse(created.json()).success).toBe(true);
    expect(ProviderRegistrationStateResponse.safeParse(resumed.json()).success).toBe(true);
  });

  it('every other operation answers 200', async () => {
    for (const r of ROUTES.filter((x) => x.fn !== 'startRegistration')) expect((await routeCall(r, await webToken())).statusCode, r.operationId).toBe(200);
  });

  const REGISTRATION_KEYS = [
    'attempt',
    'cancelledAt',
    'completedAt',
    'createdAt',
    'marketCode',
    'providerRegistrationId',
    'revision',
    'serviceTypeCodes',
    'status',
  ];
  it.each(ROUTES.filter((r) => r.fn !== 'getRequirements' && r.fn !== 'submitRegistration'))(
    '$operationId: exactly { data: { providerRole, registration }, meta: { correlationId } } with the nine registration keys',
    async (r) => {
      const res = await routeCall(r, await webToken());
      const body = res.json() as { data: { registration: object }; meta: object };
      expect(keysOf(body)).toEqual(['data', 'meta']);
      expect(keysOf(body.meta)).toEqual(['correlationId']);
      expect(keysOf(body.data)).toEqual(['providerRole', 'registration']);
      expect(keysOf(body.data.registration)).toEqual(REGISTRATION_KEYS);
      expect(ProviderRegistrationStateResponse.safeParse(body).success).toBe(true);
      expectNoSentinel(res);
    },
  );

  it('the provider role of every state is passed on as the service reports it (NONE, PENDING, ACTIVE, INACTIVE), on every operation that returns one', async () => {
    for (const role of ['NONE', 'PENDING', 'ACTIVE', 'INACTIVE'] as const) {
      const st = { providerRole: role, registration: role === 'NONE' ? null : view() };
      svc.getRegistration.mockResolvedValueOnce(st);
      svc.startRegistration.mockResolvedValueOnce({ created: false, state: st });
      svc.selectMarket.mockResolvedValueOnce(st);
      svc.replaceServiceTypes.mockResolvedValueOnce(st);
      svc.cancelRegistration.mockResolvedValueOnce({ changed: false, state: st });
      svc.getRequirements.mockResolvedValueOnce({ ...requirementsFixture(), providerRole: role });
      svc.submitRegistration.mockResolvedValueOnce({ changed: false, state: st, requirements: { ...requirementsFixture(), providerRole: role } });
      for (const r of ROUTES) expect(dataOf(await routeCall(r, await webToken())).providerRole, `${r.operationId} ${role}`).toBe(role);
      expect(stateDto(st).providerRole).toBe(role);
      expect(requirementsDto({ ...requirementsFixture(), providerRole: role }).providerRole).toBe(role);
    }
  });

  it('a never-started account reads { providerRole: NONE, registration: null }', async () => {
    svc.getRegistration.mockResolvedValueOnce({ providerRole: 'NONE', registration: null });
    const res = await call('GET', '/registration', await webToken());
    expect(dataOf(res)).toEqual({ providerRole: 'NONE', registration: null });
  });

  it.each(ROUTES.filter((r) => r.fn === 'getRequirements' || r.fn === 'submitRegistration'))(
    '$operationId: the requirements shape, with keys, labels and status keys resolved from the contract helpers',
    async (r) => {
      const res = await routeCall(r, await webToken());
      const d = dataOf(res) as { providerRole: string; registration: object; steps: Record<string, unknown>[]; overall: Record<string, unknown> };
      expect(keysOf(d)).toEqual(['overall', 'providerRole', 'registration', 'steps']);
      expect(keysOf(d.registration)).toEqual(REGISTRATION_KEYS);
      expect(d.steps.map((s) => s.step)).toEqual([...ONBOARDING_STEPS]);
      for (const s of d.steps) {
        expect(Object.keys(s).every((k) => ['step', 'status', 'owner', 'labelKey', 'statusKey', 'detail'].includes(k))).toBe(true);
        expect(s.labelKey).toBe(providerStepLabelKey(s.step as never));
        expect(s.statusKey).toBe(providerStepStatusKey(s.status as never));
      }
      expect(keysOf(d.overall)).toEqual(['blockedBy', 'goLive', 'registrationComplete', 'registrationReady']);
      expect(d.overall.goLive).toEqual({ evaluated: false, eligible: false });
      expect(ProviderRequirementsResponse.safeParse(res.json()).success).toBe(true);
      expectNoSentinel(res);
    },
  );

  it('the step details carry only the documented typed facts', async () => {
    const res = await call('GET', '/registration/requirements', await webToken());
    const steps = (dataOf(res) as { steps: { step: string; detail?: object }[] }).steps;
    const detail = (s: string) => steps.find((x) => x.step === s)!.detail;
    expect(detail('CONTACT')).toEqual({ email: 'NOT_VERIFIED', phone: 'VERIFIED' });
    expect(detail('LEGAL')).toEqual({ outstandingPurposes: ['TERMS_OF_SERVICE'] });
    expect(detail('MARKET')).toEqual({ marketCode: 'us-sf' });
    expect(detail('SERVICES')).toEqual({ selected: 2, min: 1, max: 10, notOffered: ['regular_cleaning'] });
    for (const s of ['ACCOUNT', 'VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']) expect(steps.find((x) => x.step === s)).not.toHaveProperty('detail');
  });

  it('a hostile service result (contacts, names, legal text, ids, a go-live flag) never reaches the client', async () => {
    const hostile = {
      ...stateOf(),
      email: SENTINELS[0],
      phone: SENTINELS[2],
      accountId: ACCOUNT_ID,
      legalText: SENTINELS[5],
      registration: {
        ...view(),
        accountId: ACCOUNT_ID,
        email: SENTINELS[0],
        firstName: SENTINELS[3],
        market_id: 'raw-market-id',
        bodySha256: SENTINELS[6],
      },
    };
    svc.getRegistration.mockResolvedValueOnce(hostile);
    svc.selectMarket.mockResolvedValueOnce(hostile);
    svc.replaceServiceTypes.mockResolvedValueOnce(hostile);
    svc.startRegistration.mockResolvedValueOnce({ created: true, state: hostile });
    svc.cancelRegistration.mockResolvedValueOnce({ changed: true, state: hostile });
    for (const r of ROUTES.filter((x) => !['getRequirements', 'submitRegistration'].includes(x.fn))) {
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.operationId).toBeLessThan(300);
      expectNoSentinel(res);
      expect(res.body).not.toContain('raw-market-id');
      expect(res.body).not.toContain(ACCOUNT_ID);
      expect(keysOf(dataOf(res))).toEqual(['providerRole', 'registration']);
      expect(keysOf(dataOf(res).registration as object)).toEqual(REGISTRATION_KEYS);
    }
    const req = requirementsFixture();
    const hostileReq = {
      ...req,
      email: SENTINELS[0],
      legalText: SENTINELS[5],
      steps: req.steps.map((s) => ({ ...s, text: SENTINELS[5], detail: s.detail ? { ...s.detail, email_address: SENTINELS[0] } : undefined })),
      overall: { ...req.overall, goLive: { evaluated: true, eligible: true }, live: true },
    };
    svc.getRequirements.mockResolvedValueOnce(hostileReq);
    const res = await call('GET', '/registration/requirements', await webToken());
    expectNoSentinel(res);
    expect(dataOf(res).overall).toMatchObject({ goLive: { evaluated: false, eligible: false } });
    expect(res.body).not.toContain('"live"');
    svc.submitRegistration.mockResolvedValueOnce({ changed: true, state: hostile, requirements: hostileReq });
    const sub = await call('POST', '/registration/submit', await webToken(), SUBMIT_BODY);
    expectNoSentinel(sub);
    expect(dataOf(sub).overall).toMatchObject({ goLive: { evaluated: false, eligible: false } });
  });

  it('the response never carries the sentinels of the account for any operation', async () => {
    for (const r of ROUTES) expectNoSentinel(await routeCall(r, await webToken()));
  });

  it('the returned arrays are copies: a later service mutation cannot change a response already built', () => {
    const v = view();
    const dto = registrationDto(v);
    expect(dto.serviceTypeCodes).toEqual(v.serviceTypeCodes);
    expect(dto.serviceTypeCodes).not.toBe(v.serviceTypeCodes);
    const req = requirementsFixture();
    expect(requirementsDto(req).overall.blockedBy).not.toBe(req.overall.blockedBy);
  });

  it('the mappers produce what the contracts accept, and always the literal go-live false, whatever the input says', () => {
    expect(ProviderRegistrationStateResponse.shape.data.safeParse(stateDto(stateOf())).success).toBe(true);
    expect(ProviderRegistrationStateResponse.shape.data.safeParse(stateDto({ providerRole: 'NONE', registration: null })).success).toBe(true);
    expect(ProviderRequirementsResponse.shape.data.safeParse(requirementsDto(requirementsFixture())).success).toBe(true);
    const lying = {
      ...requirementsFixture(),
      overall: { ...requirementsFixture().overall, goLive: { evaluated: true, eligible: true } },
    } as unknown as Requirements;
    expect(requirementsDto(lying).overall.goLive).toEqual({ evaluated: false, eligible: false });
    expect(stateDto({ providerRole: 'NONE', registration: null })).toEqual({ providerRole: 'NONE', registration: null });
    // a step without a detail has no `detail` key at all (not `detail: undefined`)
    expect(Object.keys(requirementsDto(requirementsFixture()).steps[0]!)).not.toContain('detail');
  });

  it('the mappers build the DTO field by field: extras on the service view (ids, contacts, names, texts) never survive the mapper itself', () => {
    const dirty = { ...view(), accountId: ACCOUNT_ID, email: SENTINELS[0], market_id: 'raw', bodySha256: SENTINELS[6] } as unknown as RegistrationView;
    expect(keysOf(registrationDto(dirty))).toEqual([
      'attempt',
      'cancelledAt',
      'completedAt',
      'createdAt',
      'marketCode',
      'providerRegistrationId',
      'revision',
      'serviceTypeCodes',
      'status',
    ]);
    expect(keysOf(stateDto({ providerRole: 'PENDING', registration: dirty, email: SENTINELS[0] } as never))).toEqual(['providerRole', 'registration']);
    const req = requirementsFixture();
    const dirtyReq = {
      ...req,
      email: SENTINELS[0],
      registration: dirty,
      steps: req.steps.map((s) => ({ ...s, text: SENTINELS[5], detail: s.detail ? { ...s.detail } : undefined })),
      overall: { ...req.overall, live: true },
    } as unknown as Requirements;
    const out = requirementsDto(dirtyReq);
    expect(keysOf(out)).toEqual(['overall', 'providerRole', 'registration', 'steps']);
    expect(keysOf(out.overall)).toEqual(['blockedBy', 'goLive', 'registrationComplete', 'registrationReady']);
    expect(keysOf(out.registration!)).toEqual(keysOf(registrationDto(view())));
    for (const s of out.steps) expect(Object.keys(s).every((k) => ['step', 'status', 'owner', 'labelKey', 'statusKey', 'detail'].includes(k))).toBe(true);
    expect(out.steps.map((s) => s.owner)).toEqual(req.steps.map((s) => s.owner));
    expect(out.overall.blockedBy).toEqual(req.overall.blockedBy);
    expect(out.overall.registrationReady).toBe(false);
    expect(out.providerRole).toBe('PENDING');
  });
});

// ====================================================================== strict bodies and queries
describe('strict bodies and queries', () => {
  it.each(BODY_ROUTES)('$method $url ($operationId): a body with an unknown key, a non-object body or no body is a 400', async (r) => {
    for (const body of [{ ...(r.body as object), unknown: 1 }, [], 'text', 7, true, {}]) {
      const res = await rawBody(r.method, r.url, await webToken(), JSON.stringify(body));
      // {} is invalid for these three (a required field) as well
      expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
    }
    const none = await call(r.method, r.url, await webToken());
    expect(none.statusCode).toBe(400);
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('rejected values are never echoed back in a validation error', async () => {
    const secret = 'Echo-Me-Not-4F7A9C'; // secret-scan:allow deliberate fake echo canary
    for (const [m, u, b] of [
      ['PUT', '/registration/market', { marketCode: secret }],
      ['PUT', '/registration/services', { serviceTypeCodes: [secret] }],
      ['PUT', '/registration/services', { serviceTypeCodes: [], unknownkey: secret }],
      ['POST', '/registration/submit', { expectedRevision: secret }],
      ['POST', '/registration/cancel', { reason: `${secret}${String.fromCharCode(0)}` }],
      ['POST', '/registration', { unknownkey: secret }],
    ] as const) {
      const res = await call(m, u, await webToken(), b);
      expect(res.statusCode, u).toBe(400);
      expect(res.body, u).not.toContain(secret);
      const issues = (errorOf(res).details as { issues: { path: string; message: string }[] }).issues;
      for (const issue of issues) expect(keysOf(issue)).toEqual(['message', 'path']);
    }
  });

  it('does NOT coerce: strings for numbers, numbers for strings and truthy values are 400 (the raw body is validated before Ajv can coerce it)', async () => {
    for (const [m, u, b] of [
      ['PUT', '/registration/market', { marketCode: 'us-sf', expectedRevision: '2' }],
      ['PUT', '/registration/market', { marketCode: 'us-sf', expectedRevision: 2.0000001 }],
      ['PUT', '/registration/market', { marketCode: 1 }],
      ['PUT', '/registration/market', { marketCode: true }],
      ['PUT', '/registration/market', { marketCode: ['us-sf'] }],
      ['PUT', '/registration/services', { serviceTypeCodes: 'car_detailing' }],
      ['PUT', '/registration/services', { serviceTypeCodes: [7] }],
      ['PUT', '/registration/services', { serviceTypeCodes: [], expectedRevision: '2' }],
      ['PUT', '/registration/services', { serviceTypeCodes: [], expectedRevision: true }],
      ['POST', '/registration/submit', { expectedRevision: '2' }],
      ['POST', '/registration/submit', { expectedRevision: true }],
      ['POST', '/registration/submit', { expectedRevision: null }],
      ['POST', '/registration/submit', { expectedRevision: 0 }],
      ['POST', '/registration/submit', { expectedRevision: 2_147_483_648 }],
      ['POST', '/registration/cancel', { reason: 7 }],
      ['POST', '/registration/cancel', { reason: true }],
    ] as const) {
      const res = await call(m, u, await webToken(), b);
      expect(res.statusCode, `${u} ${JSON.stringify(b)} ${res.body}`).toBe(400);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('services: duplicates, more than 50 codes and bad codes are 400; exactly 50 distinct codes pass through', async () => {
    const codes = Array.from({ length: 51 }, (_, i) => `service_${String(i).padStart(2, '0')}`);
    expect((await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: ['ab', 'ab'] })).statusCode).toBe(400);
    expect((await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: codes })).statusCode).toBe(400);
    expect((await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: ['Car'] })).statusCode).toBe(400);
    expect(svc.replaceServiceTypes).not.toHaveBeenCalled();
    const fifty = await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: codes.slice(0, 50) });
    expect(fifty.statusCode, fifty.body).toBe(200);
    expect(svc.replaceServiceTypes.mock.calls[0]![1].serviceTypeCodes).toHaveLength(50);
  });

  it('market: a malformed code is a 400 before the service', async () => {
    for (const marketCode of ['', 'US-SF', 'us_sf', 'us sf', 'us-', '-us', '1us', `a${'b'.repeat(60)}`, 'us-sf\n']) {
      const res = await call('PUT', '/registration/market', await webToken(), { marketCode });
      expect(res.statusCode, JSON.stringify(marketCode)).toBe(400);
    }
    expect(svc.selectMarket).not.toHaveBeenCalled();
  });

  it('cancel takes no input: ANY reason (free text would land in the immutable audit trail) is a 400 and never reaches the service, a normal one included', async () => {
    const ch = (...c: number[]) => String.fromCharCode(...c);
    for (const reason of [
      'moving away',
      'x'.repeat(1000),
      'x'.repeat(1001),
      '',
      ' ',
      '\t',
      ch(0x200b),
      `a${ch(0)}b`,
      `a${ch(0x202e)}b`,
      7,
      true,
      null,
      ['x'],
    ]) {
      const res = await call('POST', '/registration/cancel', await webToken(), { reason });
      expect(res.statusCode, JSON.stringify(reason)).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
    }
    expect(svc.cancelRegistration).not.toHaveBeenCalled();
    // the same refusal through the raw body (no JSON helper involved)
    const raw = await rawBody('POST', '/registration/cancel', await webToken(), '{"reason":"moving away"}');
    expect(raw.statusCode, raw.body).toBe(400);
    expect(raw.body).not.toContain('moving away');
    expect(svc.cancelRegistration).not.toHaveBeenCalled();
    expect((await call('POST', '/registration/cancel', await webToken(), {})).statusCode).toBe(200);
    expect(svc.cancelRegistration).toHaveBeenCalledTimes(1);
  });

  it('start accepts no body, an empty object and an explicit JSON null; cancel accepts an empty object; anything else is a 400', async () => {
    for (const [m, u] of [
      ['POST', '/registration'],
      ['POST', '/registration/cancel'],
    ] as const) {
      expect([200, 201], `${u} {}`).toContain((await call(m, u, await webToken(), {})).statusCode);
      for (const bad of ['[]', '"x"', '7', 'true', '{"a":1}']) {
        const res = await rawBody(m, u, await webToken(), bad);
        expect(res.statusCode, `${u} ${bad}`).toBe(400);
      }
    }
    expect([200, 201]).toContain((await call('POST', '/registration', await webToken())).statusCode);
    expect([200, 201]).toContain((await rawBody('POST', '/registration', await webToken(), 'null')).statusCode);
  });

  // the route declares no Ajv body schema (Ajv would reject an absent body as "must be object"): the raw body is validated by the contract
  it('cancel accepts a request with NO body at all, a JSON null and {} alike (each reaches the service with {}), and still refuses a body with any key', async () => {
    const none = await call('POST', '/registration/cancel', await webToken());
    expect(none.statusCode, none.body).toBe(200);
    const nul = await rawBody('POST', '/registration/cancel', await webToken(), 'null');
    expect(nul.statusCode, nul.body).toBe(200);
    const empty = await rawBody('POST', '/registration/cancel', await webToken(), '{}');
    expect(empty.statusCode, empty.body).toBe(200);
    expect(svc.cancelRegistration.mock.calls).toEqual([
      [ACCOUNT_ID, {}],
      [ACCOUNT_ID, {}],
      [ACCOUNT_ID, {}],
    ]);
    expect((await rawBody('POST', '/registration/cancel', await webToken(), '{"reason":"x"}')).statusCode).toBe(400);
    expect(svc.cancelRegistration).toHaveBeenCalledTimes(3);
  });

  it.each(BODY_ROUTES)('$method $url ($operationId): malformed JSON, a wrong content type and a form body are 4xx and never reach the service', async (r) => {
    for (const [text, type] of [
      ['{', 'application/json'],
      ['{"a":', 'application/json'],
      ['not json', 'application/json'],
      ['marketCode=us-sf', 'application/x-www-form-urlencoded'],
      ['marketCode=us-sf', 'text/plain'],
      ['<a/>', 'application/xml'],
    ] as const) {
      const res = await rawBody(r.method, r.url, await webToken(), text, type);
      expect(res.statusCode, `${text} ${type}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${text} ${type}`).toBeLessThan(500);
      expectNoStore(res);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('prototype pollution keys in a body are rejected, not merged', async () => {
    for (const text of ['{"marketCode":"us-sf","__proto__":{"admin":true}}', '{"marketCode":"us-sf","constructor":{"prototype":{"x":1}}}']) {
      const res = await rawBody('PUT', '/registration/market', await webToken(), text);
      expect(res.statusCode, text).toBe(400);
    }
    expect(svc.selectMarket).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  describe('GET /registration/requirements?locale=', () => {
    it.each(['en-US', 'en', 'es-MX', 'zh-Hant-CN', 'x'.repeat(35), 'qaa'])('accepts the locale %s and hands it to the service unchanged', async (locale) => {
      const res = await call('GET', `/registration/requirements?locale=${locale}`, await webToken());
      expect(res.statusCode, res.body).toBe(200);
      expect(svc.getRequirements.mock.calls[0]![1].locale).toBe(locale);
    });
    it('without a locale the service receives undefined (the account locale applies)', async () => {
      await call('GET', '/registration/requirements', await webToken());
      expect(svc.getRequirements.mock.calls[0]![1].locale).toBeUndefined();
    });
    it.each([
      ['empty', 'locale='],
      ['one character', 'locale=e'],
      ['36 characters', `locale=${'x'.repeat(36)}`],
      ['repeated', 'locale=en-US&locale=es-US'],
      ['an underscore', 'locale=en_US'],
      ['a space', 'locale=en%20US'],
      ['a leading hyphen', 'locale=-en'],
      ['a trailing hyphen', 'locale=en-'],
      ['a double hyphen', 'locale=en--US'],
      ['a slash', 'locale=en%2FUS'],
      ['a dot', 'locale=en.US'],
      ['a percent-encoded newline', 'locale=en-US%0A'],
      ['an accented letter', 'locale=en-%C3%9CS'],
      ['an injection attempt', "locale=en';DROP TABLE x;--"],
      ['an unknown parameter', 'accountId=x'],
      ['an unknown parameter next to a locale', 'locale=en-US&role=PROVIDER'],
      ['a bracket array', 'locale[]=en-US'],
      ['an object-style parameter', 'locale[a]=en-US'],
    ])('rejects %s with 400 before the service', async (_n, q) => {
      const res = await call('GET', `/registration/requirements?${q}`, await webToken());
      expect(res.statusCode, `${q}: ${res.body}`).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
      expect(svc.getRequirements).not.toHaveBeenCalled();
    });
  });

  it('GET /registration takes no parameter at all', async () => {
    expect((await call('GET', '/registration?x=1', await webToken())).statusCode).toBe(400);
    expect((await call('GET', '/registration?locale=en-US', await webToken())).statusCode).toBe(400);
    expect(svc.getRegistration).not.toHaveBeenCalled();
  });
});

// ====================================================================== body size
describe('request body size limit', () => {
  it('the limit is far below the framework default and above the largest legitimate body (50 codes of 48 characters)', () => {
    expect(PROVIDER_BODY_LIMIT).toBeLessThanOrEqual(8192);
    const largest = JSON.stringify({
      serviceTypeCodes: Array.from({ length: 50 }, (_, i) => `a${'b'.repeat(46)}${String(i % 10)}`),
      expectedRevision: 2_147_483_647,
    });
    expect(largest.length).toBeLessThan(PROVIDER_BODY_LIMIT);
  });

  it.each(ROUTES.filter((r) => r.method !== 'GET'))('$method $url ($operationId): a body over the limit is refused with 413 before it is parsed', async (r) => {
    const huge = JSON.stringify({ ...(r.body as object | undefined), pad: 'x'.repeat(PROVIDER_BODY_LIMIT + 100) });
    const res = await rawBody(r.method, r.url, await webToken(), huge);
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).category).toBe('VALIDATION');
    expectNoStore(res);
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('a deeply nested body is a 4xx and never reaches the service', async () => {
    const nested = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    for (const r of ROUTES.filter((x) => x.method !== 'GET'))
      expect((await rawBody(r.method, r.url, await webToken(), nested)).statusCode, r.url).toBeGreaterThanOrEqual(400);
    expect(noServiceCalled()).toBe(true);
  });

  it('a legitimate body of 50 codes passes', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `${'b'.repeat(40)}_${String(i).padStart(2, '0')}`);
    const res = await call('PUT', '/registration/services', await webToken(), { serviceTypeCodes: codes, expectedRevision: 2_147_483_647 });
    expect(res.statusCode, res.body).toBe(200);
  });
});

// ====================================================================== error mapping
const EXPECTED_ERRORS: Record<ProviderErrorCode, { category: string; status: number; message: string }> = {
  REGISTRATION_NOT_FOUND: { category: 'NOT_FOUND', status: 404, message: 'The provider registration was not started' },
  REGISTRATION_NOT_IN_PROGRESS: { category: 'CONFLICT', status: 409, message: 'The registration is no longer in progress' },
  ROLE_INACTIVE: { category: 'CONFLICT', status: 409, message: 'The provider role is inactive' },
  ACCOUNT_NOT_ACTIVE: { category: 'CONFLICT', status: 409, message: 'The account is not active' },
  PREREQUISITE_NOT_MET: { category: 'CONFLICT', status: 409, message: 'A prerequisite step is not complete' },
  MARKET_NOT_ELIGIBLE: { category: 'VALIDATION', status: 400, message: 'Provider registration is not open in that market' },
  MARKET_REQUIRED: { category: 'CONFLICT', status: 409, message: 'Choose where you work first' },
  SERVICE_TYPE_NOT_ELIGIBLE: { category: 'VALIDATION', status: 400, message: 'A selected service type is not available' },
  SERVICE_COUNT_OUT_OF_RANGE: { category: 'VALIDATION', status: 400, message: 'The number of selected service types is outside the allowed range' },
  REGISTRATION_INCOMPLETE: { category: 'CONFLICT', status: 409, message: 'Some registration steps are still open' },
  STALE_REGISTRATION: { category: 'CONFLICT', status: 409, message: 'The registration changed since it was read' },
  VALIDATION_FAILED: { category: 'VALIDATION', status: 400, message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', status: 409, message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', status: 503, message: 'Provider registration is temporarily unavailable' },
};
/** What a hostile or sloppy service might put in `details`: only the allow-listed tokens may come back. */
const HOSTILE_DETAILS = {
  reason: 'STALE_REGISTRATION',
  field: 'locale',
  step: 'MARKET',
  retryable: true,
  steps: ['CONTACT', 'LEGAL', 'EVIL; DROP TABLE', 'MARKET', 7, null],
  codes: ['car_detailing', 'Bad Code', 'x', 'ok_code'],
  min: 1,
  max: 10,
  sql: 'SELECT * FROM identity.accounts WHERE secret_table = 1',
  cause: new Error('boom: password=hunter2'),
  constraint: 'uq_registrations__live',
  detail: 'provider_rule:SECRET_RULE',
  email: 'victim@leak-check.example',
  nested: { deep: { token: 'nested-test-token-value' } },
  stack: 'Error: at /Users/dukm/secret.ts:1',
};
const LEAKS = [
  'secret_table',
  'hunter2',
  'uq_registrations__live',
  'SECRET_RULE',
  'victim@leak-check.example',
  'nested-test-token-value',
  '/Users/dukm',
  'EVIL',
  'Bad Code',
  'boom',
];

describe('provider error mapping', () => {
  it('the table in this test covers every code of the contract', () => {
    expect(Object.keys(EXPECTED_ERRORS).sort()).toEqual([...PROVIDER_ERROR_CODES].sort());
  });

  it.each(PROVIDER_ERROR_CODES)('%s maps onto its category, HTTP status, PROVIDER_ code, fixed message and message key (on every operation)', async (code) => {
    const want = EXPECTED_ERRORS[code];
    for (const r of ROUTES) {
      svc[r.fn].mockRejectedValueOnce(new ProviderError(code, `service wording that must not be passed on: ${code} SELECT 1`));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, `${r.operationId} ${res.body}`).toBe(want.status);
      const e = errorOf(res);
      expect(e).toMatchObject({ category: want.category, code: `PROVIDER_${code}`, message: want.message });
      expect(e.details).toEqual({ messageKey: providerErrorKey(code) });
      expect(res.body).not.toContain('SELECT 1');
      expect(res.body).not.toContain('service wording');
      expectNoStore(res);
    }
  });

  it.each(PROVIDER_ERROR_CODES)('%s: hostile details never leak; only the allow-listed tokens come back (UNAVAILABLE has none)', async (code) => {
    svc.selectMarket.mockRejectedValueOnce(new ProviderError(code, 'SELECT secret', HOSTILE_DETAILS));
    const res = await call('PUT', '/registration/market', await webToken(), MARKET_BODY);
    expect(res.statusCode).toBe(EXPECTED_ERRORS[code].status);
    for (const leak of LEAKS) expect(res.body, leak).not.toContain(leak);
    const details = errorOf(res).details as Record<string, unknown>;
    if (code === 'UNAVAILABLE') {
      expect(details).toEqual({ messageKey: providerErrorKey(code) });
    } else {
      expect(details).toEqual({
        reason: 'STALE_REGISTRATION',
        field: 'locale',
        step: 'MARKET',
        retryable: true,
        steps: ['CONTACT', 'LEGAL', 'MARKET'],
        codes: ['car_detailing', 'ok_code'],
        min: 1,
        max: 10,
        messageKey: providerErrorKey(code),
      });
    }
  });

  it('the message key cannot be overridden by a service detail', async () => {
    svc.getRegistration.mockRejectedValueOnce(new ProviderError('CONFLICT', 'x', { messageKey: 'evil.key', message: 'evil' }));
    const res = await call('GET', '/registration', await webToken());
    expect(errorOf(res).details).toEqual({ messageKey: 'provider.registration.error.conflict' });
  });

  it('REGISTRATION_INCOMPLETE names the open steps and nothing else', async () => {
    svc.submitRegistration.mockRejectedValueOnce(
      new ProviderError('REGISTRATION_INCOMPLETE', 'x', {
        reason: 'REGISTRATION_INCOMPLETE',
        steps: ['CONTACT', 'LEGAL', 'SERVICES'],
        outstanding: ['TERMS_OF_SERVICE'],
      }),
    );
    const res = await call('POST', '/registration/submit', await webToken(), SUBMIT_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({
      reason: 'REGISTRATION_INCOMPLETE',
      steps: ['CONTACT', 'LEGAL', 'SERVICES'],
      messageKey: 'provider.registration.error.registration_incomplete',
    });
  });

  it('SERVICE_COUNT_OUT_OF_RANGE carries the configured bounds', async () => {
    svc.replaceServiceTypes.mockRejectedValueOnce(
      new ProviderError('SERVICE_COUNT_OUT_OF_RANGE', 'x', { reason: 'SERVICE_COUNT_OUT_OF_RANGE', min: 1, max: 10 }),
    );
    const res = await call('PUT', '/registration/services', await webToken(), SERVICES_BODY);
    expect(errorOf(res).details).toMatchObject({ min: 1, max: 10 });
  });

  it('SERVICE_TYPE_NOT_ELIGIBLE lists at most 20 codes', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `service_${String(i).padStart(2, '0')}`);
    svc.replaceServiceTypes.mockRejectedValueOnce(new ProviderError('SERVICE_TYPE_NOT_ELIGIBLE', 'x', { reason: 'SERVICE_TYPE_NOT_ELIGIBLE', codes }));
    const res = await call('PUT', '/registration/services', await webToken(), SERVICES_BODY);
    expect((errorOf(res).details as { codes: string[] }).codes).toEqual(codes.slice(0, 20));
  });

  it('a non-typed failure of the service is a plain 500 INTERNAL_ERROR with no detail', async () => {
    for (const err of [
      new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2'),
      new TypeError('x is undefined'),
      Object.assign(new Error('pg'), { code: '23505', detail: 'secret' }),
    ]) {
      svc.getRegistration.mockRejectedValueOnce(err);
      const res = await call('GET', '/registration', await webToken());
      expect(res.statusCode).toBe(500);
      expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('ECONNREFUSED');
      expect(res.body).not.toContain('secret');
      expectNoStore(res);
    }
  });

  it('the account guard failing mid-request (a service outage of the account registry) is not mistaken for a provider error', async () => {
    accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'db down: host=10.1.1.1'));
    const res = await call('GET', '/registration', await webToken());
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe('ACCOUNT_UNAVAILABLE');
    expect(res.body).not.toContain('10.1.1.1');
    expect(svc.getRegistration).not.toHaveBeenCalled();
  });

  describe('safeDetails (the allow-list itself)', () => {
    it('drops everything that is not a short machine token, a known step, a catalogue code or a small integer', () => {
      expect(safeDetails(HOSTILE_DETAILS)).toEqual({
        reason: 'STALE_REGISTRATION',
        field: 'locale',
        step: 'MARKET',
        retryable: true,
        steps: ['CONTACT', 'LEGAL', 'MARKET'],
        codes: ['car_detailing', 'ok_code'],
        min: 1,
        max: 10,
      });
      expect(safeDetails({})).toEqual({});
    });
    it('tokens: letters, digits, underscore, dot and hyphen, at most 64 characters (longer is cut to 64 and only when the cut is still a token)', () => {
      expect(safeDetails({ reason: 'A.b-c_9' })).toEqual({ reason: 'A.b-c_9' });
      expect(safeDetails({ reason: 'has space' })).toEqual({});
      expect(safeDetails({ reason: 'semi;colon' })).toEqual({});
      expect(safeDetails({ reason: '' })).toEqual({});
      expect(safeDetails({ reason: 7 })).toEqual({});
      expect(safeDetails({ reason: 'x'.repeat(64) })).toEqual({ reason: 'x'.repeat(64) });
      expect(safeDetails({ reason: 'x'.repeat(200) })).toEqual({ reason: 'x'.repeat(64) });
      expect(safeDetails({ field: 'a b', step: 'ok' })).toEqual({ step: 'ok' });
    });
    it('retryable is only ever the literal true', () => {
      expect(safeDetails({ retryable: true })).toEqual({ retryable: true });
      for (const v of [false, 'true', 1, null, {}]) expect(safeDetails({ retryable: v })).toEqual({});
    });
    it('steps: only onboarding step names, in the given order; none left means no key', () => {
      expect(safeDetails({ steps: ['SERVICES', 'ACCOUNT', 'NOPE', 'contact'] })).toEqual({ steps: ['SERVICES', 'ACCOUNT'] });
      expect(safeDetails({ steps: ['NOPE'] })).toEqual({});
      expect(safeDetails({ steps: [] })).toEqual({});
      expect(safeDetails({ steps: 'CONTACT' })).toEqual({});
      expect(safeDetails({ steps: { 0: 'CONTACT' } })).toEqual({});
    });
    it('codes: catalogue-shaped codes only, at most 20', () => {
      const many = Array.from({ length: 25 }, (_, i) => `code_${String(i).padStart(2, '0')}`);
      expect((safeDetails({ codes: many }).codes as string[]).length).toBe(20);
      expect(safeDetails({ codes: many }).codes).toEqual(many.slice(0, 20));
      expect(safeDetails({ codes: ['Aa', '1a', 'a-b', 'a', `a${'b'.repeat(48)}`, 'a b', 'ab\n'] })).toEqual({});
      expect(safeDetails({ codes: ['ab', `a${'b'.repeat(47)}`] })).toEqual({ codes: ['ab', `a${'b'.repeat(47)}`] });
      expect(safeDetails({ codes: 'ab' })).toEqual({});
    });
    it('min and max: integers from 0 to 1000 only', () => {
      expect(safeDetails({ min: 0, max: 1000 })).toEqual({ min: 0, max: 1000 });
      for (const v of [-1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined])
        expect(safeDetails({ min: v, max: v }), String(v)).toEqual({});
    });
    it('does not copy or alias the input and ignores prototype keys', () => {
      const input = JSON.parse('{"reason":"ok","__proto__":{"polluted":true},"constructor":"x"}') as Record<string, unknown>;
      const out = safeDetails(input);
      expect(out).toEqual({ reason: 'ok' });
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    });
  });
});

// ====================================================================== OpenAPI inventory and the committed specs
describe('OpenAPI inventory and the committed documents', () => {
  const swagger = () =>
    app.swagger() as unknown as {
      tags?: { name: string }[];
      paths: Record<
        string,
        Record<string, { operationId: string; tags: string[]; security?: unknown[]; responses: Record<string, unknown>; parameters?: { name: string }[] }>
      >;
    };

  it('documents exactly the 7 provider operations with the right method, path, tag and bearer security', () => {
    const doc = swagger();
    const found: { operationId: string; method: string; path: string; tags: string[]; security: unknown }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith('/api/v1/provider'))
        for (const [method, op] of Object.entries(item))
          found.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, tags: op.tags, security: op.security });
    expect(found).toHaveLength(7);
    expect(found.map((f) => f.operationId).sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
    for (const r of ROUTES) {
      const f = found.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.tags, r.operationId).toEqual(['provider']);
      expect(f.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    expect((doc.tags ?? []).map((t) => t.name)).toContain('provider');
  });

  it('documents the failure responses of every operation, 200 and 201 for the start, and no path parameter anywhere (the account decides)', () => {
    const doc = swagger();
    for (const r of ROUTES) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      expect(Object.keys(op.responses), r.operationId).toEqual(expect.arrayContaining(['200', '400', '401', '403', '404', '409', '503']));
      expect(
        (op.parameters ?? []).filter((p) => p.name !== 'locale'),
        r.operationId,
      ).toEqual([]);
    }
    expect(Object.keys(doc.paths['/api/v1/provider/registration']!.post!.responses)).toEqual(expect.arrayContaining(['200', '201']));
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1/provider') && p.includes('{'))).toEqual([]);
  });

  it('documents the locale query of the requirements read and no other query parameter on the registration reads', () => {
    const doc = swagger();
    expect(doc.paths['/api/v1/provider/registration/requirements']!.get!.parameters!.map((p) => p.name)).toEqual(['locale']);
    expect(doc.paths['/api/v1/provider/registration']!.get!.parameters ?? []).toEqual([]);
  });

  it('is not registered without the service, nor without the account service', async () => {
    const withoutService = await makeApp({ providerRegistrations: undefined });
    const withoutAccounts = await makeApp({ accounts: undefined });
    for (const target of [withoutService, withoutAccounts])
      for (const r of ROUTES) {
        const res = await routeCall(r, await webToken(), {}, target);
        expect(res.statusCode, r.operationId).toBe(404);
        expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
        expectNoStore(res);
      }
    expect(noServiceCalled()).toBe(true);
  });

  it('the committed OpenAPI document lists every operation id and path, and the AsyncAPI document the three events', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    for (const r of ROUTES) {
      expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
      expect(openapi, r.spec).toMatch(new RegExp(`^ {2}${r.spec}:`, 'm'));
    }
    expect([...openapi.matchAll(/^ {2}(\/api\/v1\/provider[^:]*):/gm)].map((m) => m[1]).sort()).toEqual([...new Set(ROUTES.map((r) => r.spec))].sort());
    const asyncapi = readFileSync(path.join(root, 'docs/events/asyncapi.yaml'), 'utf8');
    for (const type of Object.values(PROVIDER_EVENTS)) expect(asyncapi, type).toContain(type);
    for (const name of ['ProviderRegistrationStarted', 'ProviderRegistrationCompleted', 'ProviderRegistrationCancelled'])
      expect(asyncapi, name).toContain(`send${name}:`);
    expect(asyncapi).toContain('provider_registrationStarted:');
  });

  it('the committed OpenAPI document equals the one the app generates for the provider paths (no hand edit, no stale file)', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    const doc = swagger();
    for (const r of ROUTES) {
      const summary = (doc.paths[r.spec]![r.method.toLowerCase()] as unknown as { summary: string }).summary;
      // the YAML writer may quote the summary; compare on the first words
      expect(openapi, r.operationId).toContain(summary.slice(0, 40).replace(/"/g, ''));
    }
  });
});

// ====================================================================== the adapters of the composition root (modules/provider/wiring.ts)
describe('the ports over the owning services', () => {
  const memberships = [
    { code: 'CUSTOMER', status: 'ACTIVE' as const },
    { code: 'PROVIDER', status: 'PENDING' as const },
  ];
  const ctx = (over: Record<string, unknown> = {}) => ({ ...makeContext(ACCOUNT_ID), memberships, ...over });
  const refused = async (p: Promise<unknown>) =>
    (await p.then(
      () => null,
      (e: unknown) => e,
    )) as ProviderError | null;

  describe('createAccountPort', () => {
    it('reads the facts with allowUnusable (a suspended account is reported with its status, not hidden) and maps nothing else', async () => {
      const getAccountContext = vi
        .fn()
        .mockResolvedValue(ctx({ status: 'SUSPENDED', contacts: { emailVerified: true, phoneVerified: false, contactsVerified: false } }));
      const facts = await createAccountPort({ getAccountContext, grantRole: vi.fn() } as never).facts(ACCOUNT_ID);
      expect(getAccountContext).toHaveBeenCalledWith(ACCOUNT_ID, { allowUnusable: true });
      expect(facts).toEqual({ accountId: ACCOUNT_ID, status: 'SUSPENDED', memberships, emailVerified: true, phoneVerified: false });
      expect(JSON.stringify(facts)).not.toContain('Sentinel');
    });
    it('an unknown account is ACCOUNT_NOT_ACTIVE, a registry outage is UNAVAILABLE, anything else passes through', async () => {
      const port = (err: unknown) => createAccountPort({ getAccountContext: vi.fn().mockRejectedValue(err), grantRole: vi.fn() } as never);
      const gone = await refused(port(new AccountError('NOT_FOUND', 'x')).facts(ACCOUNT_ID));
      expect(gone).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE', details: { reason: 'ACCOUNT_NOT_FOUND' } });
      expect(await refused(port(new AccountError('UNAVAILABLE', 'db down')).facts(ACCOUNT_ID))).toMatchObject({ code: 'UNAVAILABLE' });
      const odd = new Error('boom');
      await expect(port(odd).facts(ACCOUNT_ID)).rejects.toBe(odd);
    });
    it('grantRole requests the role as the registration says, with source SIGNUP, and returns the owner answer', async () => {
      const grantRole = vi.fn().mockResolvedValue({ changed: true, status: 'PENDING' });
      const out = await createAccountPort({ getAccountContext: vi.fn(), grantRole } as never).grantRole(ACCOUNT_ID, 'PROVIDER', {
        pending: true,
        actor: `account:${ACCOUNT_ID}`,
        reason: 'why',
      });
      expect(out).toEqual({ changed: true, status: 'PENDING' });
      expect(grantRole).toHaveBeenCalledWith(ACCOUNT_ID, 'PROVIDER', { actor: `account:${ACCOUNT_ID}`, reason: 'why', source: 'SIGNUP', pending: true });
      await createAccountPort({ getAccountContext: vi.fn(), grantRole } as never).grantRole(ACCOUNT_ID, 'PROVIDER', {
        pending: false,
        actor: 'a',
        reason: 'r',
      });
      expect(grantRole.mock.calls[1]![2].pending).toBe(false);
    });
    it('an INACTIVE membership that would have to become PENDING is ROLE_INACTIVE; an outage is UNAVAILABLE; anything else passes through', async () => {
      const port = (err: unknown) => createAccountPort({ getAccountContext: vi.fn(), grantRole: vi.fn().mockRejectedValue(err) } as never);
      const opts = { pending: true, actor: 'a', reason: 'r' };
      expect(await refused(port(new AccountError('INVALID_STATE', 'x')).grantRole(ACCOUNT_ID, 'PROVIDER', opts))).toMatchObject({
        code: 'ROLE_INACTIVE',
        details: { reason: 'ROLE_INACTIVE' },
      });
      expect(await refused(port(new AccountError('UNAVAILABLE', 'x')).grantRole(ACCOUNT_ID, 'PROVIDER', opts))).toMatchObject({ code: 'UNAVAILABLE' });
      const odd = new AccountError('VALIDATION_FAILED', 'x');
      await expect(port(odd).grantRole(ACCOUNT_ID, 'PROVIDER', opts)).rejects.toBe(odd);
      const plain = new Error('boom');
      await expect(port(plain).grantRole(ACCOUNT_ID, 'PROVIDER', opts)).rejects.toBe(plain);
    });
    // a concurrent change of the identity domain is the caller's to retry (409 PROVIDER_CONFLICT, details.retryable), never a 500
    it('an AccountError CONFLICT from grantRole is a retryable CONFLICT (CONCURRENT_UPDATE), for the PENDING request and for the activation alike', async () => {
      const port = () =>
        createAccountPort({ getAccountContext: vi.fn(), grantRole: vi.fn().mockRejectedValue(new AccountError('CONFLICT', 'LEAKED-OWNER-TEXT')) } as never);
      for (const pending of [true, false]) {
        const e = await refused(port().grantRole(ACCOUNT_ID, 'PROVIDER', { pending, actor: 'a', reason: 'r' }));
        expect(e).toBeInstanceOf(ProviderError);
        expect(e).toMatchObject({ code: 'CONFLICT', details: { reason: 'CONCURRENT_UPDATE', retryable: true } });
        expect(JSON.stringify([e!.message, e!.details])).not.toContain('LEAKED-OWNER-TEXT');
      }
    });
    it('an AccountError CONFLICT from facts is a retryable CONFLICT (CONCURRENT_UPDATE) and the other codes keep their mapping', async () => {
      const port = (err: unknown) => createAccountPort({ getAccountContext: vi.fn().mockRejectedValue(err), grantRole: vi.fn() } as never);
      const e = await refused(port(new AccountError('CONFLICT', 'LEAKED-OWNER-TEXT')).facts(ACCOUNT_ID));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e).toMatchObject({ code: 'CONFLICT', details: { reason: 'CONCURRENT_UPDATE', retryable: true } });
      expect(JSON.stringify([e!.message, e!.details])).not.toContain('LEAKED-OWNER-TEXT');
      expect(e!.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
      const other = new AccountError('VALIDATION_FAILED', 'x');
      await expect(port(other).facts(ACCOUNT_ID)).rejects.toBe(other);
    });
    it('the retryable CONFLICT reaches the client as HTTP 409 PROVIDER_CONFLICT with details.retryable (not a 500)', async () => {
      svc.selectMarket.mockRejectedValueOnce(new ProviderError('CONFLICT', 'x', { reason: 'CONCURRENT_UPDATE', retryable: true }));
      const res = await call('PUT', '/registration/market', await webToken(), MARKET_BODY);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'PROVIDER_CONFLICT', details: { reason: 'CONCURRENT_UPDATE', retryable: true } });
    });
  });

  describe('createConsentPort', () => {
    const requirement = (purposeCode: string, required: boolean, status: string) => ({ purposeCode, required, status });
    it('reports satisfaction, the outstanding purposes, the required purposes whose document is not published and how many are required (not-required purposes do not count)', async () => {
      const getRequirements = vi.fn().mockResolvedValue({
        satisfied: false,
        outstanding: ['PRIVACY_POLICY', 'TERMS_OF_SERVICE'],
        requirements: [
          requirement('PRIVACY_POLICY', true, 'DOCUMENT_UNAVAILABLE'),
          requirement('TERMS_OF_SERVICE', true, 'NOT_ACCEPTED'),
          requirement('MARKETING_EMAIL', false, 'DOCUMENT_UNAVAILABLE'),
          requirement('SECOND_OPTIONAL', false, 'NOT_ACCEPTED'),
        ],
      });
      const out = await createConsentPort({ getRequirements }).requirements(ACCOUNT_ID, { locale: 'es-MX' });
      expect(out).toEqual({ satisfied: false, outstanding: ['PRIVACY_POLICY', 'TERMS_OF_SERVICE'], unavailable: ['PRIVACY_POLICY'], requiredCount: 2 });
      expect(getRequirements).toHaveBeenCalledWith(ACCOUNT_ID, { locale: 'es-MX' });
      await createConsentPort({ getRequirements }).requirements(ACCOUNT_ID, {});
      expect(getRequirements).toHaveBeenLastCalledWith(ACCOUNT_ID, {});
    });
    it('a locale the consent domain rejects is VALIDATION_FAILED on the locale; every other failure is an outage (fail closed)', async () => {
      const port = (err: unknown) => createConsentPort({ getRequirements: vi.fn().mockRejectedValue(err) });
      expect(await refused(port(new AccountError('VALIDATION_FAILED', 'x')).requirements(ACCOUNT_ID, { locale: 'xx' }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'INVALID_LOCALE', field: 'locale' },
      });
      for (const err of [new AccountError('UNAVAILABLE', 'x'), new Error('policy unreadable'), new TypeError('bad'), new AccountError('CONFLICT', 'x')]) {
        const e = await refused(port(err).requirements(ACCOUNT_ID, {}));
        expect(e, String(err)).toBeInstanceOf(ProviderError);
        expect(e!.code, String(err)).toBe('UNAVAILABLE');
        expect(JSON.stringify(e!.details)).not.toContain('policy unreadable');
      }
    });
  });

  describe('createMarketPort', () => {
    const market = (over: Record<string, unknown> = {}) => ({
      code: 'us-sf',
      status: 'ACTIVE',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      ...over,
    });
    const lookup = (m: unknown, now = '2026-06-01T00:00:00.000Z') => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      const getMarket = vi.fn().mockResolvedValue(m);
      return { getMarket, port: createMarketPort({ getMarket } as never) };
    };
    afterEach(() => vi.useRealTimers());
    it('asks the registry for any status (management read) and reports the status', async () => {
      const { getMarket, port } = lookup(market({ status: 'PLANNED' }));
      expect(await port.lookup('us-sf')).toEqual({ code: 'us-sf', status: 'PLANNED', inEffect: true });
      expect(getMarket).toHaveBeenCalledWith('us-sf', { management: true });
    });
    it('a market without a status is INACTIVE (never assumed ACTIVE)', async () => {
      expect((await lookup(market({ status: undefined })).port.lookup('us-sf'))!.status).toBe('INACTIVE');
    });
    it('the window is half-open [effectiveFrom, effectiveTo): before, at the start, inside, one millisecond before the end, at the end and after', async () => {
      const w = { effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: '2026-04-01T00:00:00.000Z' };
      const at = async (now: string) => (await lookup(market(w), now).port.lookup('us-sf'))!.inEffect;
      expect(await at('2026-02-28T23:59:59.999Z')).toBe(false);
      expect(await at('2026-03-01T00:00:00.000Z')).toBe(true);
      expect(await at('2026-03-15T00:00:00.000Z')).toBe(true);
      expect(await at('2026-03-31T23:59:59.999Z')).toBe(true);
      expect(await at('2026-04-01T00:00:00.000Z')).toBe(false);
      expect(await at('2027-01-01T00:00:00.000Z')).toBe(false);
      expect((await lookup(market({ effectiveFrom: '2026-07-01T00:00:00.000Z' })).port.lookup('us-sf'))!.inEffect).toBe(false);
      expect((await lookup(market({ effectiveTo: null }), '2099-01-01T00:00:00.000Z').port.lookup('us-sf'))!.inEffect).toBe(true);
    });
    it('an unknown market is null; a registry failure is UNAVAILABLE (fail closed)', async () => {
      const port = (err: unknown) => createMarketPort({ getMarket: vi.fn().mockRejectedValue(err) } as never);
      expect(await port(new GeographyError('MARKET_NOT_FOUND', 'x')).lookup('zz')).toBeNull();
      for (const err of [new GeographyError('UNAVAILABLE', 'x'), new Error('db'), new GeographyError('VALIDATION_FAILED', 'x')])
        expect(await refused(port(err).lookup('us-sf')), String(err)).toMatchObject({ code: 'UNAVAILABLE' });
    });
  });

  describe('createCatalogPort', () => {
    it('hands the codes through and turns any failure into UNAVAILABLE', async () => {
      const offered = vi.fn().mockResolvedValue(['a_one', 'b_two']);
      expect(await createCatalogPort({ offeredServiceTypeCodes: offered }).offeredServiceTypes('us-sf')).toEqual(['a_one', 'b_two']);
      expect(offered).toHaveBeenCalledWith('us-sf');
      const e = await refused(createCatalogPort({ offeredServiceTypeCodes: vi.fn().mockRejectedValue(new Error('sql: secret')) }).offeredServiceTypes('us-sf'));
      expect(e).toMatchObject({ code: 'UNAVAILABLE' });
      expect(JSON.stringify(e!.details)).not.toContain('secret');
    });
  });

  describe('createProviderPolicyProvider', () => {
    const P = PROVIDER_POLICY_KEYS;
    const resolved = (over: Record<string, unknown> = {}) =>
      new Map(
        Object.entries({
          [P.requireVerifiedEmail]: true,
          [P.requireVerifiedPhone]: false,
          [P.marketStatusesAllowed]: ['ACTIVE', 'PLANNED'],
          [P.minServiceTypes]: 2,
          [P.maxServiceTypes]: 7,
          ...over,
        }).map(([k, v]) => [k, { value: v }]),
      );
    const provider = (values: unknown, spy = vi.fn()) => ({
      spy,
      p: createProviderPolicyProvider({ resolveMany: spy.mockResolvedValue({ values }) } as never),
    });
    it('reads exactly the five keys, in one batched read, and returns the typed policy', async () => {
      const { spy, p } = provider(resolved());
      expect(await p.policy()).toEqual({
        requireVerifiedEmail: true,
        requireVerifiedPhone: false,
        marketStatusesAllowed: ['ACTIVE', 'PLANNED'],
        minServiceTypes: 2,
        maxServiceTypes: 7,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect([...spy.mock.calls[0]![0]].sort()).toEqual(Object.values(P).sort());
    });
    it('reads fresh every time (nothing is cached by the provider)', async () => {
      const { spy, p } = provider(resolved());
      await p.policy();
      await p.policy();
      expect(spy).toHaveBeenCalledTimes(2);
    });
    it('an unreadable registry is UNAVAILABLE POLICY_UNREADABLE; a missing, mistyped or contradictory value is UNAVAILABLE POLICY_INVALID (no code default)', async () => {
      const failing = createProviderPolicyProvider({ resolveMany: vi.fn().mockRejectedValue(new Error('cfg down: password=x')) } as never);
      const e = await refused(failing.policy());
      expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
      expect(JSON.stringify(e)).not.toContain('password');
      const missing = resolved();
      missing.delete(P.minServiceTypes);
      for (const values of [
        new Map(),
        missing,
        resolved({ [P.maxServiceTypes]: 'ten' }),
        resolved({ [P.minServiceTypes]: 9, [P.maxServiceTypes]: 3 }),
        resolved({ [P.marketStatusesAllowed]: [] }),
        resolved({ [P.requireVerifiedEmail]: 'yes' }),
      ])
        expect(await refused(provider(values).p.policy())).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
    });
  });
});
