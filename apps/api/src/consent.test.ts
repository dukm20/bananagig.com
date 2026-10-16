// Unit tests of the HTTP layer of the consent API (ID-005, docs/engineering/CONSENT.md) with a FAKE ConsentOperations (the rules of the real service are covered by
// packages/accounts and, against PostgreSQL, by consent.itest.ts): authentication and the identity context (401 before 400, 403 for the admin context), the account
// always coming from the verified token (no route accepts an account id), the strict purpose path parameter, the strict `locale` query, strict RAW bodies, the fixed error
// mapping of the ten consent codes (no service message or detail, no hash, version id or text ever echoed), response shapes equal to the contracts, caching
// (`no-store` on success and on every error), the application session handed to the service, and the generated OpenAPI and AsyncAPI contracts.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  AcceptConsentResponse,
  AccountConsentsResponse,
  CONSENT_ERROR_CODES,
  CONSENT_EVENTS,
  ConsentRequirementsResponse,
  ErrorResponse,
  WithdrawConsentResponse,
  consentErrorMessageKey,
  type ConsentErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService, type ConsentOperations, type SecurityOperations } from '@bananagig/accounts';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
let sessionApp: FastifyInstance;

// ---------------------------------------------------------------- the fakes
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn(), selectActiveRole: vi.fn(), upsertProfile: vi.fn() };
const consentSvc = {
  getConsents: vi.fn(),
  getRequirements: vi.fn(),
  accept: vi.fn(),
  withdraw: vi.fn(),
  listOutstandingConsents: vi.fn(),
  hasRequiredConsents: vi.fn(),
  requireConsents: vi.fn(),
};
const security = { observeSession: vi.fn() };
const noConsentCalls = () => Object.values(consentSvc).every((f) => f.mock.calls.length === 0);
const noServiceCalls = () => noConsentCalls() && Object.values(accountSvc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const SESSION_ID = '0d9b1c52-8a4f-4e63-b7a1-3c2d5e6f7a80';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const VERSION_ID = 'b7e1c0a4-93d2-4f6a-8a15-2c4d6e8f0a1b';
const EVENT_ID = '3c9d2e1f-5a4b-4c7d-8e6f-1a2b3c4d5e6f';
const HASH = 'a3f1c9e7b5d2a4c6e8f0123456789abcdef0123456789abcdef0123456789abc';
const LEGAL_TEXT_MARKER = 'LEGAL-TEXT-MARKER-you-agree-to-everything';
const SERVICE_SECRET_MARKER = 'svc-detail-marker-9f31';
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };

const DOC_REF = { versionId: VERSION_ID, version: 3, locale: 'en-US', bodySha256: HASH };
const EVENT = {
  consentEventId: EVENT_ID,
  purposeCode: 'TERMS_OF_SERVICE',
  eventType: 'ACCEPTED',
  eventSeq: 1,
  document: DOC_REF,
  occurredAt: '2026-02-03T04:05:06.000Z',
  source: 'ACCOUNT_API',
};
const CONSENTS = {
  current: [
    { purposeCode: 'TERMS_OF_SERVICE', labelContentKey: 'account.consent.purpose.terms_of_service', state: 'ACCEPTED', withdrawable: false, latest: EVENT },
    { purposeCode: 'PRIVACY_POLICY', labelContentKey: 'account.consent.purpose.privacy_policy', state: 'NONE', withdrawable: false, latest: null },
  ],
  history: [EVENT],
};
const REQUIREMENTS = {
  locale: 'en-US',
  requirements: [
    {
      purposeCode: 'TERMS_OF_SERVICE',
      labelContentKey: 'account.consent.purpose.terms_of_service',
      required: true,
      status: 'SATISFIED',
      acceptanceState: 'ACCEPTED',
      withdrawable: false,
      reacceptance: 'REACCEPT_REQUIRED',
      document: { entryKey: 'legal.terms_of_service', ...DOC_REF, effectiveFrom: '2026-01-01T00:00:00.000Z' },
      accepted: EVENT,
    },
    {
      purposeCode: 'PRIVACY_POLICY',
      labelContentKey: 'account.consent.purpose.privacy_policy',
      required: true,
      status: 'DOCUMENT_UNAVAILABLE',
      acceptanceState: 'NONE',
      withdrawable: false,
      reacceptance: 'REACCEPT_REQUIRED',
      document: null,
      accepted: null,
    },
  ],
  satisfied: false,
  outstanding: ['PRIVACY_POLICY'],
};
const ACCEPT_RESULT = { changed: true, event: EVENT };
const WITHDRAW_EVENT = { ...EVENT, eventType: 'WITHDRAWN', eventSeq: 2, purposeCode: 'MARKETING_EMAIL' };
const WITHDRAW_RESULT = { changed: true, event: WITHDRAW_EVENT };
const ACCEPT_BODY = { versionId: VERSION_ID, locale: 'en-US', bodySha256: HASH };

const makeContext = (over: Partial<AccountContext> = {}): AccountContext => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: [CUSTOMER],
  memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
  primaryRole: 'CUSTOMER',
  activeRole: 'CUSTOMER',
  profile: null,
  email: { emailVerificationStatus: 'NONE', primary: null, pending: null },
  phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null },
  contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false },
  createdAt: T0,
  created: false,
  ...over,
});

const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer', REALM_ROLE_MARKER] }, ...claims } });
const adminToken = () =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: ['customer'] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
    },
  });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const call = async (
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url: `/api/v1/account${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const rawJson = (url: string, token: string | undefined, text: string, headers: Record<string, string> = {}): Promise<Reply> =>
  app.inject({
    method: 'POST',
    url: `/api/v1/account${url}`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: text,
  });
/** Sends ANY JSON value (a number, an array, null, a string) as the body, so a test controls the exact JSON type that reaches the API. */
const sendJson = (url: string, token: string | undefined, value: unknown): Promise<Reply> => rawJson(url, token, JSON.stringify(value));
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const raw = (v: unknown): string => JSON.stringify(v);
/** Every string value inside a JSON value (keys excluded): none of them may come back in an error body. */
const leafStrings = (v: unknown): string[] => {
  if (typeof v === 'string') return v.length > 3 ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(leafStrings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(leafStrings);
  return [];
};
const expectValidation = (r: Reply, rejected: unknown = undefined) => {
  expect(r.statusCode, r.body).toBe(400);
  expect(errorOf(r)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
  const details = errorOf(r).details as { issues: { path: string; message: string }[] };
  expect(Array.isArray(details.issues)).toBe(true);
  for (const issue of details.issues) expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
  for (const value of leafStrings(rejected)) expect(r.body, 'a rejected value was echoed').not.toContain(value);
};
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');

interface Route {
  id: string;
  method: Method;
  url: string;
  body?: unknown;
  fn: keyof typeof consentSvc;
  /** The exact arguments the service must receive for the sample request. */
  args: unknown[];
}
const ROUTES: Route[] = [
  { id: 'getAccountConsents', method: 'GET', url: '/consents', fn: 'getConsents', args: [ACCOUNT_ID] },
  { id: 'getAccountConsentRequirements', method: 'GET', url: '/consents/requirements', fn: 'getRequirements', args: [ACCOUNT_ID, {}] },
  {
    id: 'acceptAccountConsent',
    method: 'POST',
    url: '/consents/TERMS_OF_SERVICE/accept',
    body: ACCEPT_BODY,
    fn: 'accept',
    args: [ACCOUNT_ID, 'TERMS_OF_SERVICE', ACCEPT_BODY, {}],
  },
  {
    id: 'withdrawAccountConsent',
    method: 'POST',
    url: '/consents/MARKETING_EMAIL/withdraw',
    body: {},
    fn: 'withdraw',
    args: [ACCOUNT_ID, 'MARKETING_EMAIL', {}],
  },
];
const POST_ROUTES = ROUTES.filter((r) => r.method === 'POST');
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}) => call(r.method, r.url, token, r.body, headers);

const tokenIdentity = () => ({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: SUB, identityRoles: ['customer', REALM_ROLE_MARKER] });

beforeAll(async () => {
  keys = await createTestKeys('k1');
  verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const deps = {
    cfg,
    verifier,
    configuration: {} as never,
    accounts: accountSvc as unknown as AccountService,
    consent: consentSvc as unknown as ConsentOperations,
    readiness: async () => ({}),
  };
  app = await buildApp(deps);
  await app.ready();
  sessionApp = await buildApp({ ...deps, security: security as unknown as SecurityOperations });
  await sessionApp.ready();
});
afterAll(async () => {
  await app.close();
  await sessionApp.close();
});

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of [...Object.values(accountSvc), ...Object.values(consentSvc), security.observeSession]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async () => makeContext());
  security.observeSession.mockImplementation(async () => ({ applicationSessionId: SESSION_ID, accountDeviceId: null, created: false }));
  consentSvc.getConsents.mockImplementation(async () => CONSENTS);
  consentSvc.getRequirements.mockImplementation(async () => REQUIREMENTS);
  consentSvc.accept.mockImplementation(async () => ACCEPT_RESULT);
  consentSvc.withdraw.mockImplementation(async () => WITHDRAW_RESULT);
});

// ====================================================================== authentication and identity context
describe('consent API authentication', () => {
  it.each(ROUTES)('$method $url requires a token: 401 with the standard envelope, no-store, before any service call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expectNoStore(res);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url rejects every kind of invalid token with 401 invalid_token and never calls a service', async (r) => {
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
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url refuses the admin identity context and any other client with 403 and never calls the consent service', async (r) => {
    const admin = await routeCall(r, await adminToken());
    expect(admin.statusCode).toBe(403);
    expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    expectNoStore(admin);
    for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) expect((await routeCall(r, await webToken({ azp }))).statusCode, azp).toBe(403);
    expect(noConsentCalls()).toBe(true);
  });

  it.each(POST_ROUTES)('$method $url answers 401 before 400 and 403 before 400: an invalid body without a token or with the admin token', async (r) => {
    for (const body of [{ versionId: 1, extra: true }, [], 'text', 7, null]) {
      expect((await sendJson(r.url, undefined, body)).statusCode, raw(body)).toBe(401);
      expect((await sendJson(r.url, 'bad.token', body)).statusCode, raw(body)).toBe(401);
      expect((await sendJson(r.url, await adminToken(), body)).statusCode, raw(body)).toBe(403);
    }
    expect(noServiceCalls()).toBe(true);
  });

  it('answers 401 before 400 on the requirements read: a garbage query without a token is 401', async () => {
    for (const qs of ['?accountId=x', '?locale=', '?locale=a&locale=b']) expect((await call('GET', `/consents/requirements${qs}`)).statusCode, qs).toBe(401);
    expect((await call('POST', '/consents/not-a-purpose/accept', undefined, {})).statusCode).toBe(401);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url passes a guard refusal (suspended or closed account) through as 403 and never calls the consent service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noConsentCalls()).toBe(true);
  });
});

// ====================================================================== the account comes from the token only
describe('consent API: the account', () => {
  it.each(ROUTES)('$method $url resolves the account from the verified token and hands exactly that account to the service', async (r) => {
    const res = await routeCall(r, await webToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
    expect(consentSvc[r.fn]).toHaveBeenCalledTimes(1);
    expect(consentSvc[r.fn].mock.calls[0]).toEqual(r.args);
  });

  it('has no route that takes an account id in the path', async () => {
    for (const url of [
      `/consents/${OTHER_ACCOUNT_ID}`,
      `/consents/${OTHER_ACCOUNT_ID}/TERMS_OF_SERVICE/accept`,
      `/${OTHER_ACCOUNT_ID}/consents`,
      `/consents/TERMS_OF_SERVICE`,
    ]) {
      const res = await call('GET', url, await webToken());
      expect(res.statusCode, url).toBe(404);
      expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(res);
    }
    const post = await call('POST', `/consents/${OTHER_ACCOUNT_ID}/accept`, await webToken(), ACCEPT_BODY);
    expect(post.statusCode).toBe(400); // not a purpose code
    expect(noConsentCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url ignores x-account-id style headers: the token account is used', async (r) => {
    const res = await routeCall(r, await webToken(), { 'x-account-id': OTHER_ACCOUNT_ID, 'x-user-id': OTHER_ACCOUNT_ID, 'x-forwarded-user': SUB });
    expect(res.statusCode, res.body).toBe(200);
    expect(consentSvc[r.fn].mock.calls[0]).toEqual(r.args);
    expect(raw(consentSvc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
  });

  it('rejects an account id in the query of every GET (strict query) and in the body of every POST (strict body)', async () => {
    expectValidation(await call('GET', `/consents?accountId=${OTHER_ACCOUNT_ID}`, await webToken()));
    expectValidation(await call('GET', `/consents/requirements?accountId=${OTHER_ACCOUNT_ID}`, await webToken()));
    expectValidation(await call('GET', `/consents/requirements?locale=en-US&account_id=${OTHER_ACCOUNT_ID}`, await webToken()));
    for (const field of ['accountId', 'account_id', 'subject', 'role', 'occurredAt', 'at', 'source', 'eventType', 'consentEventId']) {
      const body = { ...ACCEPT_BODY, [field]: OTHER_ACCOUNT_ID };
      expectValidation(await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), body), body);
    }
    expectValidation(await call('POST', '/consents/MARKETING_EMAIL/withdraw', await webToken(), { accountId: OTHER_ACCOUNT_ID }), {
      accountId: OTHER_ACCOUNT_ID,
    });
    expect(noConsentCalls()).toBe(true);
  });

  it('hands the application session of the request to the service, and nothing else when there is none', async () => {
    const withSession = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY, {}, sessionApp);
    expect(withSession.statusCode, withSession.body).toBe(200);
    expect(consentSvc.accept.mock.calls[0]).toEqual([ACCOUNT_ID, 'TERMS_OF_SERVICE', ACCEPT_BODY, { applicationSessionId: SESSION_ID }]);
    const withdraw = await call('POST', '/consents/MARKETING_EMAIL/withdraw', await webToken(), undefined, {}, sessionApp);
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    expect(consentSvc.withdraw.mock.calls[0]).toEqual([ACCOUNT_ID, 'MARKETING_EMAIL', { applicationSessionId: SESSION_ID }]);
    // a client cannot choose the session: a body or header naming one is refused / ignored
    expectValidation(
      await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), { ...ACCEPT_BODY, applicationSessionId: SESSION_ID }, {}, sessionApp),
    );
    await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY, { 'x-application-session-id': OTHER_ACCOUNT_ID }, sessionApp);
    expect(consentSvc.accept.mock.calls[1]![3]).toEqual({ applicationSessionId: SESSION_ID });
    // without the security layer the context is empty (the column is optional)
    await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(consentSvc.accept.mock.calls[2]![3]).toEqual({});
  });

  it('a session revoked in the registry is refused before the consent service is called', async () => {
    security.observeSession.mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'));
    const res = await call('GET', '/consents', await webToken(), undefined, {}, sessionApp);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('SESSION_REVOKED');
    expectNoStore(res);
    expect(noConsentCalls()).toBe(true);
  });
});

// ====================================================================== the purpose path parameter
describe('consent API: the purpose path parameter', () => {
  const BAD_PURPOSES = [
    'terms_of_service', // lower case
    'Terms_Of_Service',
    'T', // too short
    '1TERMS',
    '_TERMS',
    'TERMS-OF-SERVICE',
    'TERMS%20OF',
    'TERMS.OF',
    'TERMS%00',
    'TERMS%0A',
    'TERMS_OF_SERVIC%C3%89', // unicode
    '%E2%84%AAEY', // a letter that folds to ASCII
    'A'.repeat(65),
    '%27%20OR%201=1--',
    'TERMS_OF_SERVICE%2Faccept',
    OTHER_ACCOUNT_ID,
  ];
  it.each(BAD_PURPOSES)('accept and withdraw refuse the purpose %s with 400 and never call the service', async (purpose) => {
    for (const [action, body] of [
      ['accept', ACCEPT_BODY],
      ['withdraw', {}],
    ] as const) {
      const res = await call('POST', `/consents/${purpose}/${action}`, await webToken(), body);
      expect(res.statusCode, `${action} ${purpose}: ${res.body}`).toBe(400);
      expect(errorOf(res).category).toBe('VALIDATION');
      expectNoStore(res);
      if (errorOf(res).code === 'VALIDATION_FAILED') {
        expect(errorOf(res).details).toEqual({ issues: [{ path: 'params.purpose', message: 'must be a purpose code' }] });
      }
      // the rejected value is never echoed (lower-cased, decoded or raw)
      const echoed = decodeURIComponent(purpose).toLowerCase();
      if (echoed.length >= 6) expect(res.body.toLowerCase()).not.toContain(echoed);
    }
    expect(noConsentCalls()).toBe(true);
  });

  it('answers a path parameter over the router limit with the standard 400 PATH_PARAMETER_TOO_LONG and no-store', async () => {
    const res = await call('POST', `/consents/${'A'.repeat(300)}/accept`, await webToken(), ACCEPT_BODY);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('PATH_PARAMETER_TOO_LONG');
    expectNoStore(res);
  });

  it('passes a well-formed purpose through unchanged (the service owns existence: unknown is a uniform 404)', async () => {
    consentSvc.accept.mockRejectedValueOnce(
      new AccountError('CONSENT_PURPOSE_NOT_FOUND', `no purpose ${SERVICE_SECRET_MARKER}`, { purposeCode: SERVICE_SECRET_MARKER }),
    );
    const res = await call('POST', '/consents/SOME_UNKNOWN_PURPOSE/accept', await webToken(), ACCEPT_BODY);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({
      category: 'NOT_FOUND',
      code: 'ACCOUNT_CONSENT_PURPOSE_NOT_FOUND',
      details: { messageKey: 'account.consent.error.purpose_not_found' },
    });
    expect(res.body).not.toContain(SERVICE_SECRET_MARKER);
    expect(consentSvc.accept.mock.calls[0]![1]).toBe('SOME_UNKNOWN_PURPOSE');
  });

  it('answers a missing, unknown-method or extra-segment path with 404 ROUTE_NOT_FOUND / no-store, never calling the service', async () => {
    for (const [method, url] of [
      ['GET', '/consents/TERMS_OF_SERVICE/accept'],
      ['PUT', '/consents/TERMS_OF_SERVICE/accept'],
      ['DELETE', '/consents'],
      ['POST', '/consents'],
      ['POST', '/consents/TERMS_OF_SERVICE'],
      ['POST', '/consents/TERMS_OF_SERVICE/accept/extra'],
      ['POST', '/consents/../accept'], // dot segments are resolved by the URL parser: another path, never a purpose
      ['POST', '/consents/%2e%2e/accept'],
    ] as const) {
      const res = await call(method, url, await webToken(), method === 'GET' ? undefined : ACCEPT_BODY);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expectNoStore(res);
    }
    expect(noConsentCalls()).toBe(true);
  });
});

// ====================================================================== the locale query
describe('consent API: the requirements query', () => {
  it('passes a valid locale to the service as given (no normalization)', async () => {
    for (const locale of ['en-US', 'es-419', 'fr', 'EN-us', 'zh-Hant-TW']) {
      consentSvc.getRequirements.mockClear();
      const res = await call('GET', `/consents/requirements?locale=${locale}`, await webToken());
      expect(res.statusCode, `${locale}: ${res.body}`).toBe(200);
      expect(consentSvc.getRequirements.mock.calls[0]).toEqual([ACCOUNT_ID, { locale }]);
    }
  });

  it('calls the service without a locale when none is given', async () => {
    await call('GET', '/consents/requirements', await webToken());
    expect(consentSvc.getRequirements.mock.calls[0]).toEqual([ACCOUNT_ID, {}]);
  });

  const BAD_QUERIES = [
    '?locale=', // empty
    '?locale=e', // too short
    `?locale=${'a'.repeat(36)}`,
    '?locale=en_US',
    '?locale=en%20US',
    '?locale=en-US%00',
    '?locale=en-US%0A',
    '?locale=en-',
    '?locale=-US',
    '?locale=en--US',
    '?locale=en-US&locale=fr-FR', // repeated -> array
    '?locale=en-US&locale=en-US',
    '?locale[]=en-US',
    '?locale[0]=en-US',
    '?locale=en-US&accountId=x',
    '?Locale=en-US',
    '?locales=en-US',
    '?lang=en-US',
    '?x=1',
    '?locale=%27%20OR%201=1--',
    '?locale=%E2%84%AA', // not ASCII
    '?locale=%7B%22a%22%3A1%7D',
  ];
  it.each(BAD_QUERIES)('refuses the query %s with 400 and never calls the service', async (qs) => {
    const res = await call('GET', `/consents/requirements${qs}`, await webToken());
    expect(res.statusCode, `${qs}: ${res.body}`).toBe(400);
    expect(errorOf(res).category).toBe('VALIDATION');
    expectNoStore(res);
    expect(res.body).not.toContain('OR 1=1');
    expect(consentSvc.getRequirements).not.toHaveBeenCalled();
  });

  it.each(['/consents?locale=en-US', '/consents?x=1', '/consents?accountId=x'])('GET %s: the history read takes no query at all', async (url) => {
    expectValidation(await call('GET', url, await webToken()));
    expect(consentSvc.getConsents).not.toHaveBeenCalled();
  });

  it('turns a service-side locale refusal into a 400 with no echo of the locale', async () => {
    consentSvc.getRequirements.mockRejectedValueOnce(
      new AccountError('VALIDATION_FAILED', `locale xx-YY ${SERVICE_SECRET_MARKER}`, {
        reason: 'LOCALE_NOT_AVAILABLE',
        field: 'locale',
        value: SERVICE_SECRET_MARKER,
      }),
    );
    const res = await call('GET', '/consents/requirements?locale=xx-YY', await webToken());
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'ACCOUNT_VALIDATION_FAILED', message: 'The consent request could not be processed' });
    expect(errorOf(res).details).toEqual({ reason: 'LOCALE_NOT_AVAILABLE', field: 'locale' });
    expect(res.body).not.toContain(SERVICE_SECRET_MARKER);
    expectNoStore(res);
  });
});

// ====================================================================== strict bodies
describe('consent API: strict bodies', () => {
  const BAD_ACCEPT_BODIES: [string, unknown][] = [
    ['empty object', {}],
    ['missing versionId', { locale: 'en-US', bodySha256: HASH }],
    ['missing locale', { versionId: VERSION_ID, bodySha256: HASH }],
    ['missing bodySha256', { versionId: VERSION_ID, locale: 'en-US' }],
    ['unknown field', { ...ACCEPT_BODY, extra: 1 }],
    ['numeric versionId', { ...ACCEPT_BODY, versionId: 12345 }],
    ['numeric locale', { ...ACCEPT_BODY, locale: 12 }],
    ['numeric hash', { ...ACCEPT_BODY, bodySha256: 1234 }],
    ['boolean fields', { versionId: true, locale: true, bodySha256: true }],
    ['null fields', { versionId: null, locale: null, bodySha256: null }],
    ['array fields', { versionId: [VERSION_ID], locale: ['en-US'], bodySha256: [HASH] }],
    ['object fields', { versionId: { a: 1 }, locale: { a: 1 }, bodySha256: { a: 1 } }],
    ['non-uuid versionId', { ...ACCEPT_BODY, versionId: 'not-a-uuid' }],
    ['uuid without dashes', { ...ACCEPT_BODY, versionId: VERSION_ID.replaceAll('-', '') }],
    ['uuid with braces', { ...ACCEPT_BODY, versionId: `{${VERSION_ID}}` }],
    ['uuid with spaces', { ...ACCEPT_BODY, versionId: ` ${VERSION_ID} ` }],
    ['upper-case hash', { ...ACCEPT_BODY, bodySha256: HASH.toUpperCase() }],
    ['63-char hash', { ...ACCEPT_BODY, bodySha256: HASH.slice(1) }],
    ['65-char hash', { ...ACCEPT_BODY, bodySha256: `${HASH}0` }],
    ['non-hex hash', { ...ACCEPT_BODY, bodySha256: `${HASH.slice(0, 63)}g` }],
    ['hash with prefix', { ...ACCEPT_BODY, bodySha256: `sha256:${HASH}` }],
    ['one-char locale', { ...ACCEPT_BODY, locale: 'e' }],
    ['36-char locale', { ...ACCEPT_BODY, locale: 'a'.repeat(36) }],
    ['array body', [ACCEPT_BODY]],
    ['null body', null],
    ['string body', 'accept'],
    ['number body', 1],
    ['boolean body', true],
  ];
  it.each(BAD_ACCEPT_BODIES)('accept refuses %s with 400 and never calls the service', async (_name, body) => {
    const res = await sendJson('/consents/TERMS_OF_SERVICE/accept', await webToken(), body);
    expectValidation(res, body);
    expectNoStore(res);
    expect(consentSvc.accept).not.toHaveBeenCalled();
  });

  it('accept refuses a body whose JSON has a duplicate or prototype-polluting key without changing the contract', async () => {
    for (const text of [
      `{"__proto__":{"x":1},"versionId":"${VERSION_ID}","locale":"en-US","bodySha256":"${HASH}"}`,
      `{"constructor":1,"versionId":"${VERSION_ID}","locale":"en-US","bodySha256":"${HASH}"}`,
    ]) {
      const res = await rawJson('/consents/TERMS_OF_SERVICE/accept', await webToken(), text);
      expect(res.statusCode, text).toBe(400);
    }
    expect(consentSvc.accept).not.toHaveBeenCalled();
  });

  it('accept refuses malformed JSON, an empty JSON body and a wrong content type', async () => {
    for (const text of ['{"versionId": ', '{versionId: 1}', '']) {
      const res = await rawJson('/consents/TERMS_OF_SERVICE/accept', await webToken(), text);
      expect(res.statusCode, text).toBe(400);
      expectNoStore(res);
    }
    const form = await app.inject({
      method: 'POST',
      url: '/api/v1/account/consents/TERMS_OF_SERVICE/accept',
      headers: { authorization: `Bearer ${await webToken()}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `versionId=${VERSION_ID}&locale=en-US&bodySha256=${HASH}`,
    });
    expect(form.statusCode).toBeGreaterThanOrEqual(400);
    expect(form.statusCode).toBeLessThan(500);
    expect(consentSvc.accept).not.toHaveBeenCalled();
  });

  it('refuses a huge body before it is parsed (bodyLimit 2048) with a 4xx envelope and no-store', async () => {
    const huge = JSON.stringify({ ...ACCEPT_BODY, locale: 'x'.repeat(100_000) });
    for (const url of ['/consents/TERMS_OF_SERVICE/accept', '/consents/MARKETING_EMAIL/withdraw']) {
      const res = await rawJson(url, await webToken(), huge);
      expect(res.statusCode, url).toBe(413);
      expect(errorOf(res).category).toBe('VALIDATION');
      expectNoStore(res);
    }
    const nested = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect((await rawJson('/consents/TERMS_OF_SERVICE/accept', await webToken(), nested)).statusCode).toBeGreaterThanOrEqual(400);
    expect(consentSvc.accept).not.toHaveBeenCalled();
    expect(consentSvc.withdraw).not.toHaveBeenCalled();
  });

  it('accept hands the service the three fields exactly, with a canonical lower-case version id', async () => {
    const res = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), { ...ACCEPT_BODY, versionId: VERSION_ID.toUpperCase() });
    expect(res.statusCode, res.body).toBe(200);
    expect(consentSvc.accept.mock.calls[0]).toEqual([ACCOUNT_ID, 'TERMS_OF_SERVICE', { versionId: VERSION_ID, locale: 'en-US', bodySha256: HASH }, {}]);
    // locale and hash are compared exactly by the service: the route normalizes neither
    await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), { ...ACCEPT_BODY, locale: 'EN-us' });
    expect(consentSvc.accept.mock.calls[1]![2]).toEqual({ ...ACCEPT_BODY, locale: 'EN-us' });
  });

  it.each([
    ['no body at all', undefined],
    ['an empty object', {}],
  ])('withdraw takes %s', async (_name, body) => {
    const res = await call('POST', '/consents/MARKETING_EMAIL/withdraw', await webToken(), body);
    expect(res.statusCode, res.body).toBe(200);
    expect(consentSvc.withdraw.mock.calls[0]).toEqual([ACCOUNT_ID, 'MARKETING_EMAIL', {}]);
  });

  it.each([
    ['unknown field', { extra: 1 }],
    ['a version to withdraw', { versionId: VERSION_ID }],
    ['an array', []],
    ['an array with an object', [{}]],
    ['null', null],
    ['a string', 'withdraw'],
    ['a number', 0],
    ['a boolean', false],
  ])('withdraw refuses a body that is %s with 400', async (_name, body) => {
    const res = await sendJson('/consents/MARKETING_EMAIL/withdraw', await webToken(), body);
    expectValidation(res, body);
    expectNoStore(res);
    expect(consentSvc.withdraw).not.toHaveBeenCalled();
  });
});

// ====================================================================== error mapping
describe('consent API: error mapping', () => {
  const EXPECTED: Record<ConsentErrorCode, { status: number; category: string }> = {
    CONSENT_PURPOSE_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    CONSENT_VERSION_NOT_FOUND: { status: 404, category: 'NOT_FOUND' },
    CONSENT_PURPOSE_INACTIVE: { status: 409, category: 'CONFLICT' },
    CONSENT_VERSION_NOT_CURRENT: { status: 409, category: 'CONFLICT' },
    CONSENT_NOT_WITHDRAWABLE: { status: 409, category: 'CONFLICT' },
    CONSENT_NOT_ACCEPTED: { status: 409, category: 'CONFLICT' },
    CONSENT_REQUIRED_FOR_ROLE: { status: 409, category: 'CONFLICT' },
    CONSENT_REQUIRED: { status: 409, category: 'CONFLICT' },
    CONSENT_LOCALE_MISMATCH: { status: 400, category: 'VALIDATION' },
    CONSENT_HASH_MISMATCH: { status: 400, category: 'VALIDATION' },
  };
  const fn = { accept: 'accept', withdraw: 'withdraw', requirements: 'getRequirements', consents: 'getConsents' } as const;
  const requestFor = async (kind: keyof typeof fn): Promise<Reply> => {
    const token = await webToken();
    if (kind === 'accept') return call('POST', '/consents/TERMS_OF_SERVICE/accept', token, ACCEPT_BODY);
    if (kind === 'withdraw') return call('POST', '/consents/MARKETING_EMAIL/withdraw', token, {});
    if (kind === 'requirements') return call('GET', '/consents/requirements', token);
    return call('GET', '/consents', token);
  };
  const hostileDetails = {
    purposeCode: 'TERMS_OF_SERVICE',
    versionId: VERSION_ID,
    bodySha256: HASH,
    locale: 'en-US',
    text: LEGAL_TEXT_MARKER,
    constraint: 'ck_consent_events__marker',
    cause: SERVICE_SECRET_MARKER,
    accountId: ACCOUNT_ID,
  };

  it('covers every consent error code of the contract', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CONSENT_ERROR_CODES].sort());
  });

  it.each(CONSENT_ERROR_CODES)('%s is answered with its status, fixed message and ONLY the message key, on every route', async (code) => {
    for (const kind of Object.keys(fn) as (keyof typeof fn)[]) {
      consentSvc[fn[kind]].mockRejectedValueOnce(
        new AccountError(code, `service message ${LEGAL_TEXT_MARKER} ${SERVICE_SECRET_MARKER} ${HASH}`, hostileDetails),
      );
      const res = await requestFor(kind);
      const e = errorOf(res);
      expect(res.statusCode, `${kind}: ${res.body}`).toBe(EXPECTED[code].status);
      expect(e.category).toBe(EXPECTED[code].category);
      expect(e.code).toBe(`ACCOUNT_${code}`);
      expect(e.message).not.toMatch(new RegExp(`${LEGAL_TEXT_MARKER}|${SERVICE_SECRET_MARKER}|${HASH}`));
      expect(e.message.length).toBeLessThan(80);
      expect(e.details).toEqual({ messageKey: consentErrorMessageKey(code), ...(code === 'CONSENT_REQUIRED' ? { outstanding: [] } : {}) });
      for (const marker of [LEGAL_TEXT_MARKER, SERVICE_SECRET_MARKER, HASH, VERSION_ID, ACCOUNT_ID, 'ck_consent_events'])
        expect(res.body, marker).not.toContain(marker);
      expectNoStore(res);
      expect(e.correlationId).toBeTruthy();
    }
  });

  it('CONSENT_REQUIRED lists only well-formed purpose codes of the service details', async () => {
    consentSvc.accept.mockRejectedValueOnce(
      new AccountError('CONSENT_REQUIRED', 'outstanding', {
        outstanding: ['TERMS_OF_SERVICE', 'privacy_policy', LEGAL_TEXT_MARKER, 42, null, { a: 1 }, 'X'.repeat(65), 'PRIVACY_POLICY'],
      }),
    );
    const res = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({ messageKey: 'account.consent.error.required', outstanding: ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'] });
    expect(res.body).not.toContain(LEGAL_TEXT_MARKER);
  });

  it('CONSENT_REQUIRED never turns a non-array into a list', async () => {
    consentSvc.accept.mockRejectedValueOnce(new AccountError('CONSENT_REQUIRED', 'x', { outstanding: 'TERMS_OF_SERVICE' }));
    const res = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(errorOf(res).details).toEqual({ messageKey: 'account.consent.error.required', outstanding: [] });
  });

  it('answers an unknown and an unpublished version identically (uniform 404, nothing about the version)', async () => {
    const bodies: string[] = [];
    for (const reason of ['UNKNOWN', 'DRAFT', 'OTHER_ENTRY', 'WRONG_SCOPE']) {
      consentSvc.accept.mockRejectedValueOnce(new AccountError('CONSENT_VERSION_NOT_FOUND', `version ${reason}`, { reason }));
      const res = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
      expect(res.statusCode).toBe(404);
      bodies.push(JSON.stringify({ ...errorOf(res), correlationId: '' }));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('keeps the code of other typed account failures but drops the service message and every detail except a reason and a field token', async () => {
    consentSvc.accept.mockRejectedValueOnce(
      new AccountError('CLOSED', `account ${ACCOUNT_ID} closed`, { reason: 'ACCOUNT_CLOSED', field: 'account', accountId: ACCOUNT_ID, constraint: 'ck_x' }),
    );
    const closed = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(closed.statusCode).toBe(403);
    expect(errorOf(closed)).toMatchObject({
      category: 'AUTHORIZATION',
      code: 'ACCOUNT_CLOSED',
      message: 'The consent request could not be processed',
      details: { reason: 'ACCOUNT_CLOSED', field: 'account' },
    });
    expect(closed.body).not.toContain(ACCOUNT_ID);
    expectNoStore(closed);

    consentSvc.accept.mockRejectedValueOnce(
      new AccountError('CONFLICT', 'sequence key', { constraint: 'uq_consent_events__account_purpose_seq', reason: 'a b c', versionId: VERSION_ID }),
    );
    const conflict = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict)).toMatchObject({ category: 'CONFLICT', code: 'ACCOUNT_CONFLICT', details: {} });
    expect(conflict.body).not.toMatch(/uq_consent|a b c|sequence key/);
  });

  it('fails closed with a generic 503 when the policy or the default locale is unavailable (no reason, no key, no cause)', async () => {
    for (const details of [
      { reason: 'POLICY_INVALID', purposeCode: 'TERMS_OF_SERVICE', field: 'required_for' },
      { reason: 'POLICY_UNREADABLE', cause: 'ECONNREFUSED 10.0.0.5' },
      { reason: 'DEFAULT_LOCALE_MISSING' },
    ]) {
      consentSvc.getRequirements.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'the consent policy is not available', details));
      const res = await call('GET', '/consents/requirements', await webToken());
      expect(res.statusCode).toBe(503);
      expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
      expect(errorOf(res).details).toBeUndefined();
      expect(res.body).not.toMatch(/POLICY|ECONNREFUSED|required_for|10\.0\.0\.5/);
      expectNoStore(res);
    }
  });

  it('turns an unexpected exception into a generic 500 with no internal message or stack, and no-store', async () => {
    consentSvc.accept.mockRejectedValueOnce(new Error(`boom password=hunter2 ${HASH}`));
    const res = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(res.body).not.toMatch(/hunter2|boom|stack|at /);
    expectNoStore(res);
  });

  it('echoes a valid correlation id on success and failure', async () => {
    const id = 'corr-consent-0001';
    const ok = await call('GET', '/consents', await webToken(), undefined, { 'x-correlation-id': id });
    expect((ok.json() as { meta: { correlationId: string } }).meta.correlationId).toBe(id);
    consentSvc.getConsents.mockRejectedValueOnce(new AccountError('CONSENT_PURPOSE_NOT_FOUND', 'x'));
    const bad = await call('GET', '/consents', await webToken(), undefined, { 'x-correlation-id': id });
    expect(errorOf(bad).correlationId).toBe(id);
  });
});

// ====================================================================== response shape and privacy
describe('consent API: responses equal the contracts', () => {
  it('GET /consents returns exactly AccountConsentsResponse', async () => {
    const res = await call('GET', '/consents', await webToken());
    expect(res.statusCode).toBe(200);
    expectNoStore(res);
    const body = res.json() as { data: unknown; meta: { correlationId: string } };
    expect(AccountConsentsResponse.parse(body)).toEqual(body);
    expect(body.data).toEqual(CONSENTS);
    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    expect(Object.keys(body.meta)).toEqual(['correlationId']);
  });

  it('GET /consents/requirements returns exactly ConsentRequirementsResponse (a null document and a null accepted stay null)', async () => {
    const res = await call('GET', '/consents/requirements?locale=en-US', await webToken());
    expect(res.statusCode).toBe(200);
    expectNoStore(res);
    const body = res.json() as { data: typeof REQUIREMENTS };
    expect(ConsentRequirementsResponse.parse(body)).toEqual(body);
    expect(body.data).toEqual(REQUIREMENTS);
    expect(body.data.requirements[1]!.document).toBeNull();
  });

  it('POST accept and withdraw return exactly the result responses (changed true and false)', async () => {
    const accept = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect(accept.statusCode).toBe(200);
    expectNoStore(accept);
    expect(AcceptConsentResponse.parse(accept.json())).toEqual(accept.json());
    expect((accept.json() as { data: unknown }).data).toEqual(ACCEPT_RESULT);

    consentSvc.accept.mockResolvedValueOnce({ changed: false, event: EVENT });
    const again = await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY);
    expect((again.json() as { data: { changed: boolean } }).data.changed).toBe(false);

    const withdraw = await call('POST', '/consents/MARKETING_EMAIL/withdraw', await webToken());
    expect(withdraw.statusCode).toBe(200);
    expectNoStore(withdraw);
    expect(WithdrawConsentResponse.parse(withdraw.json())).toEqual(withdraw.json());
    expect((withdraw.json() as { data: unknown }).data).toEqual(WITHDRAW_RESULT);
  });

  it('drops any field the service returns beyond the contract (no legal text, no internal id can leak through a response)', async () => {
    const leaky = {
      ...ACCEPT_RESULT,
      accountId: ACCOUNT_ID,
      bodyText: LEGAL_TEXT_MARKER,
      event: {
        ...EVENT,
        accountId: ACCOUNT_ID,
        ipAddress: '10.1.2.3',
        applicationSessionId: SESSION_ID,
        correlationId: SERVICE_SECRET_MARKER,
        document: { ...DOC_REF, body: LEGAL_TEXT_MARKER },
      },
    };
    consentSvc.accept.mockResolvedValueOnce(leaky);
    consentSvc.getConsents.mockResolvedValueOnce({ ...CONSENTS, body: LEGAL_TEXT_MARKER, history: [leaky.event] });
    consentSvc.getRequirements.mockResolvedValueOnce({ ...REQUIREMENTS, text: LEGAL_TEXT_MARKER });
    for (const res of [
      await call('POST', '/consents/TERMS_OF_SERVICE/accept', await webToken(), ACCEPT_BODY),
      await call('GET', '/consents', await webToken()),
      await call('GET', '/consents/requirements', await webToken()),
    ]) {
      expect(res.statusCode, res.body).toBe(200);
      for (const marker of [LEGAL_TEXT_MARKER, ACCOUNT_ID, '10.1.2.3', SESSION_ID, SERVICE_SECRET_MARKER, 'ipAddress', 'bodyText'])
        expect(res.body, marker).not.toContain(marker);
    }
  });

  it('never returns a token, a subject, the realm roles or an issuer', async () => {
    for (const r of ROUTES) {
      const res = await routeCall(r, await webToken());
      for (const marker of [SUB, KEYCLOAK_SID, REALM_ROLE_MARKER, TEST_ISSUER]) expect(res.body, marker).not.toContain(marker);
    }
  });
});

// ====================================================================== caching
describe('consent API: caching', () => {
  it.each(ROUTES)('$method $url is Cache-Control no-store on success', async (r) => {
    expectNoStore(await routeCall(r, await webToken()));
  });
  it.each(ROUTES)('$method $url is Cache-Control no-store on a service failure', async (r) => {
    consentSvc[r.fn].mockRejectedValueOnce(new AccountError('CONSENT_PURPOSE_NOT_FOUND', 'x'));
    const res = await routeCall(r, await webToken());
    expect(res.statusCode).toBe(404);
    expectNoStore(res);
  });
  it('is no-store on router-level failures under /account/consents (a malformed URL, an unknown sub-path)', async () => {
    expectNoStore(await app.inject({ method: 'GET', url: '/api/v1/account/consents/%E0%A4%A' }));
    expectNoStore(await app.inject({ method: 'GET', url: '/api/v1/account/consents/nothing/here/at/all' }));
    expectNoStore(await app.inject({ method: 'GET', url: '/api/v1/ACCOUNT/Consents' }));
  });
});

// ====================================================================== wiring
describe('consent wiring', () => {
  const resolved = (map: Record<string, unknown>) => ({
    resolveMany: vi.fn(async (ks: string[]) => ({
      values: new Map(ks.filter((k) => k in map).map((k) => [k, { value: map[k] }])),
      sources: new Map(),
      at: new Date(),
    })),
  });

  it('reads the two configuration keys of the purpose at platform scope and returns the parsed policy', async () => {
    const cfgSvc = resolved({
      'consent.terms_of_service.required_for': ['CUSTOMER', 'PROVIDER'],
      'consent.terms_of_service.reacceptance': 'REACCEPT_REQUIRED',
    });
    const policy = await createConsentPolicyProvider(cfgSvc as never).policy('TERMS_OF_SERVICE');
    expect(policy).toEqual({ requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    expect(cfgSvc.resolveMany).toHaveBeenCalledTimes(1);
    expect(cfgSvc.resolveMany.mock.calls[0]).toEqual([['consent.terms_of_service.required_for', 'consent.terms_of_service.reacceptance']]);
  });

  it('accepts an empty role list (nobody is required)', async () => {
    const cfgSvc = resolved({ 'consent.x_y.required_for': [], 'consent.x_y.reacceptance': 'NO_REACCEPT' });
    expect(await createConsentPolicyProvider(cfgSvc as never).policy('X_Y')).toEqual({ requiredForRoles: [], reacceptance: 'NO_REACCEPT' });
  });

  it.each([
    ['a missing required_for', { 'consent.p1.reacceptance': 'NO_REACCEPT' }],
    ['a missing reacceptance', { 'consent.p1.required_for': [] }],
    ['a string instead of an array', { 'consent.p1.required_for': 'CUSTOMER', 'consent.p1.reacceptance': 'NO_REACCEPT' }],
    ['a non-string role', { 'consent.p1.required_for': [1], 'consent.p1.reacceptance': 'NO_REACCEPT' }],
    ['a lower-case role', { 'consent.p1.required_for': ['customer'], 'consent.p1.reacceptance': 'NO_REACCEPT' }],
    ['a duplicate role', { 'consent.p1.required_for': ['CUSTOMER', 'CUSTOMER'], 'consent.p1.reacceptance': 'NO_REACCEPT' }],
    ['an unknown mode', { 'consent.p1.required_for': [], 'consent.p1.reacceptance': 'SOMETIMES' }],
    ['a lower-case mode', { 'consent.p1.required_for': [], 'consent.p1.reacceptance': 'no_reaccept' }],
    ['a null mode', { 'consent.p1.required_for': [], 'consent.p1.reacceptance': null }],
  ])('fails closed (UNAVAILABLE / POLICY_INVALID, never a default) on %s', async (_name, map) => {
    await expect(createConsentPolicyProvider(resolved(map) as never).policy('P1')).rejects.toMatchObject({
      name: 'AccountError',
      code: 'UNAVAILABLE',
      details: { reason: 'POLICY_INVALID' },
    });
  });

  it('fails closed when the registry throws, without carrying its cause, and for a malformed purpose code', async () => {
    const down = { resolveMany: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5'))) };
    const err = await createConsentPolicyProvider(down as never)
      .policy('P1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
    expect(raw((err as AccountError).details)).not.toContain('10.0.0.5');
    const never = resolved({});
    await expect(createConsentPolicyProvider(never as never).policy('bad code')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(never.resolveMany).not.toHaveBeenCalled();
  });

  it('resolves the default locale from the platform default row and caches nothing', async () => {
    const locales = [
      { locale: 'es-US', isPlatformDefault: false },
      { locale: 'en-US', isPlatformDefault: true },
    ];
    const content = { listLocales: vi.fn(async () => locales) };
    const resolve = createDefaultLocaleResolver(content as never);
    expect(await resolve()).toBe('en-US');
    locales[0]!.isPlatformDefault = true;
    locales[1]!.isPlatformDefault = false;
    expect(await resolve()).toBe('es-US');
    expect(content.listLocales).toHaveBeenCalledTimes(2);
    expect(content.listLocales.mock.calls[0]).toEqual([{ activeOnly: true }]);
  });

  it('fails closed when there is no default locale or the registry cannot be read', async () => {
    await expect(createDefaultLocaleResolver({ listLocales: async () => [{ locale: 'en-US', isPlatformDefault: false }] } as never)()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'DEFAULT_LOCALE_MISSING' },
    });
    await expect(createDefaultLocaleResolver({ listLocales: async () => Promise.reject(new Error('db down')) } as never)()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'DEFAULT_LOCALE_UNREADABLE' },
    });
  });

  it('registers the consent routes only when the service is provided with accounts', async () => {
    const bare = await buildApp({ cfg, verifier, configuration: {} as never, accounts: accountSvc as unknown as AccountService, readiness: async () => ({}) });
    const res = await bare.inject({ method: 'GET', url: '/api/v1/account/consents', headers: { authorization: `Bearer ${await webToken()}` } });
    expect(res.statusCode).toBe(404);
    const noAccounts = await buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      consent: consentSvc as unknown as ConsentOperations,
      readiness: async () => ({}),
    });
    expect((await noAccounts.inject({ method: 'GET', url: '/api/v1/account/consents' })).statusCode).toBe(404);
    await bare.close();
    await noAccounts.close();
  });
});

// ====================================================================== generated contracts
describe('generated OpenAPI and AsyncAPI', () => {
  const openapi = readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
  const asyncapi = readFileSync(new URL('../../../docs/events/asyncapi.yaml', import.meta.url), 'utf8');

  it('documents the four routes with their operation ids, the consent tag and bearer security', () => {
    for (const id of ROUTES.map((r) => r.id)) expect(openapi, id).toContain(`operationId: ${id}`);
    for (const path of [
      '/api/v1/account/consents:',
      '/api/v1/account/consents/requirements:',
      '/api/v1/account/consents/{purpose}/accept:',
      '/api/v1/account/consents/{purpose}/withdraw:',
    ]) {
      expect(openapi, path).toContain(`  ${path}`);
    }
    expect(openapi).toContain('- name: consent');
  });

  it('documents no account id parameter on any consent path', () => {
    const start = openapi.indexOf('  /api/v1/account/consents:');
    const end = openapi.indexOf('\n  /api/v1/', openapi.indexOf('  /api/v1/account/consents/{purpose}/withdraw:') + 10);
    const section = openapi.slice(start, end === -1 ? undefined : end);
    expect(section).not.toMatch(/name: (accountId|account_id|subject)/);
  });

  it('declares the two consent events with the contract subjects', () => {
    expect(asyncapi).toContain(CONSENT_EVENTS.accepted);
    expect(asyncapi).toContain(CONSENT_EVENTS.withdrawn);
    expect(asyncapi).toContain('IdentityConsentAccepted');
    expect(asyncapi).toContain('IdentityConsentWithdrawn');
  });
});
