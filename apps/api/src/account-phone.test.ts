// Unit tests of the HTTP layer of the phone contact and verification API (ID-003, docs/engineering/PHONE_VERIFICATION.md) with a FAKE
// PhoneVerificationService (the rules of the real service are covered by packages/accounts and by account-phone.itest.ts): authentication and the identity
// context (401 before 400, 403 for the admin context), strict RAW bodies (a number is never coerced to a string and a rejected value is never echoed), the
// account always coming from the verified token, the client address handed to the abuse limits, the error mapping of the thirteen phone codes on every route,
// privacy (masked numbers only, no code, no hash, no internals in any response or log line), caching, registration and the generated OpenAPI contract.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  AccountPhoneResponse,
  CORRELATION_HEADER,
  ErrorResponse,
  PHONE_ERROR_CODES,
  PhoneVerificationSentResponse,
  PhoneVerifiedResponse,
  SetPhoneResponse,
  maskPhone,
  phoneErrorMessageKey,
  type PhoneErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService, type EmailVerificationService, type PhoneVerificationService } from '@bananagig/accounts';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;

// ---------------------------------------------------------------- the fakes
const accountSvc = {
  ensureAccountForIdentity: vi.fn(),
  getAccountContext: vi.fn(),
  selectActiveRole: vi.fn(),
  upsertProfile: vi.fn(),
};
const phoneSvc = {
  getPhoneDetail: vi.fn(),
  setPhone: vi.fn(),
  sendVerification: vi.fn(),
  confirmCode: vi.fn(),
  getPhoneSummary: vi.fn(),
};
const emailSvc = {
  getEmailDetail: vi.fn(),
  setEmail: vi.fn(),
  sendVerification: vi.fn(),
  confirmCode: vi.fn(),
  confirmLink: vi.fn(),
  getEmailSummary: vi.fn(),
};
const noPhoneCalls = () => Object.values(phoneSvc).every((f) => f.mock.calls.length === 0);
const noServiceCalls = () => noPhoneCalls() && Object.values(accountSvc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-other-subject-marker-93d0';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const ACCOUNT_OF: Record<string, string> = { [SUB]: ACCOUNT_ID, [OTHER_SUB]: OTHER_ACCOUNT_ID };
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };

/** The number the fakes "hold". It must never appear in a response: only its masked form does. */
const FULL_NUMBER = '+12025550142';
const NATIONAL_NUMBER = '(202) 555-0142';
const MASKED = maskPhone(FULL_NUMBER);
const CODE = '123456';
const LF = String.fromCharCode(10);

const NONE_SUMMARY = { phoneVerificationStatus: 'NONE', primary: null, pending: null } as const;
const PENDING_SUMMARY = {
  phoneVerificationStatus: 'PENDING',
  primary: null,
  pending: {
    maskedPhone: MASKED,
    countryCode: 'US',
    purpose: 'INITIAL_PHONE',
    status: 'PENDING',
    lastSentAt: '2026-01-01T00:05:00.000Z',
    expiresAt: '2026-01-01T00:15:00.000Z',
  },
} as const;
const VERIFIED_SUMMARY = {
  phoneVerificationStatus: 'VERIFIED',
  primary: { maskedPhone: MASKED, countryCode: 'US', verifiedAt: '2026-01-01T00:06:00.000Z', source: 'USER_ENTERED' },
  pending: null,
} as const;
const CHANGING_SUMMARY = {
  phoneVerificationStatus: 'VERIFIED',
  primary: VERIFIED_SUMMARY.primary,
  pending: { maskedPhone: '+*******0199', countryCode: 'US', purpose: 'CHANGE_PHONE', status: 'REPLACEMENT_PENDING', lastSentAt: null, expiresAt: null },
} as const;
const SENT_AT = new Date('2026-01-01T00:05:00.000Z');
const EXPIRES_AT = new Date('2026-01-01T00:15:00.000Z');
const RESEND_AT = new Date('2026-01-01T00:05:30.000Z');

const makeContext = (over: Partial<AccountContext> = {}): AccountContext => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: [CUSTOMER],
  memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
  primaryRole: 'CUSTOMER',
  activeRole: 'CUSTOMER',
  profile: null,
  email: { emailVerificationStatus: 'NONE', primary: null, pending: null },
  phone: NONE_SUMMARY,
  contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false },
  createdAt: T0,
  created: false,
  ...over,
});

const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, azp: 'bananagig-web', realm_access: { roles: ['customer', REALM_ROLE_MARKER] }, ...claims } });
const adminToken = (roles: string[] = []) =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: ['customer'] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
    },
  });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  app.inject({
    method,
    url: `/api/v1/account${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
/** Sends ANY JSON value (a number, an array, null, a string) as the body, so a test controls the exact JSON type that reaches the API. */
const sendJson = (url: string, token: string | undefined, value: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  rawJson(url, token, JSON.stringify(value), headers);
const rawJson = (url: string, token: string | undefined, text: string, headers: Record<string, string> = {}): Promise<Reply> =>
  app.inject({
    method: 'POST',
    url: `/api/v1/account${url}`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: text,
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const keysOf = (o: object) => Object.keys(o).sort();
const raw = (v: unknown): string => JSON.stringify(v);
/** Every string value inside a JSON value (keys excluded): none of them may come back in an error body. */
const leafStrings = (v: unknown): string[] => {
  if (typeof v === 'string') return v.length > 3 ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(leafStrings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(leafStrings);
  return [];
};

interface Route {
  id: string;
  method: Method;
  url: string;
  body?: unknown;
  fn: keyof typeof phoneSvc;
  /** The exact arguments the service must receive for the sample request, given the client address. */
  args: (clientIp?: string) => unknown[];
}
const ROUTES: Route[] = [
  { id: 'getAccountPhone', method: 'GET', url: '/phone', fn: 'getPhoneDetail', args: () => [ACCOUNT_ID] },
  {
    id: 'setAccountPhone',
    method: 'POST',
    url: '/phone',
    body: { phone: FULL_NUMBER },
    fn: 'setPhone',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, FULL_NUMBER, { clientIp: ip }],
  },
  {
    id: 'sendAccountPhoneVerification',
    method: 'POST',
    url: '/phone/verification/send',
    body: {},
    fn: 'sendVerification',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, { clientIp: ip }],
  },
  {
    id: 'confirmAccountPhoneCode',
    method: 'POST',
    url: '/phone/verification/confirm-code',
    body: { code: CODE },
    fn: 'confirmCode',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, CODE, { clientIp: ip }],
  },
];
const POST_ROUTES = ROUTES.filter((r) => r.method === 'POST');
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}) => call(r.method, r.url, token, r.body, headers);

const tokenIdentity = (sub: string = SUB) => ({
  providerType: 'KEYCLOAK',
  issuer: TEST_ISSUER,
  subject: sub,
  identityRoles: ['customer', REALM_ROLE_MARKER],
});

const expectValidation = (r: Reply, rejected: unknown = undefined) => {
  expect(r.statusCode, r.body).toBe(400);
  expect(errorOf(r)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
  const details = errorOf(r).details as { issues: { path: string; message: string }[] };
  expect(Array.isArray(details.issues)).toBe(true);
  for (const issue of details.issues) expect(keysOf(issue)).toEqual(['message', 'path']);
  for (const value of leafStrings(rejected)) expect(r.body, 'a rejected value was echoed').not.toContain(value);
};

beforeAll(async () => {
  keys = await createTestKeys('k1');
  verifier = createTokenVerifier({
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
    accounts: accountSvc as unknown as AccountService,
    phoneVerification: phoneSvc as unknown as PhoneVerificationService,
    readiness: async () => ({}),
  });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of [...Object.values(accountSvc), ...Object.values(phoneSvc), ...Object.values(emailSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }) =>
    makeContext({ accountId: ACCOUNT_OF[identity.subject] ?? ACCOUNT_ID }),
  );
  accountSvc.getAccountContext.mockImplementation(async (accountId: string) => makeContext({ accountId }));
  accountSvc.selectActiveRole.mockImplementation(async (accountId: string, role: string) => makeContext({ accountId, activeRole: role }));
  accountSvc.upsertProfile.mockImplementation(async (_id: string, input: object) => ({ changed: true, profile: input }));
  phoneSvc.getPhoneDetail.mockImplementation(async () => ({
    ...PENDING_SUMMARY,
    resendAvailableAt: RESEND_AT,
    attemptsRemaining: 5,
    codeLength: 6,
    validityMinutes: 10,
  }));
  phoneSvc.setPhone.mockImplementation(async () => ({ changed: true, phone: PENDING_SUMMARY }));
  phoneSvc.sendVerification.mockImplementation(async () => ({
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    resendAvailableAt: RESEND_AT,
    codeLength: 6,
    validityMinutes: 10,
    phone: PENDING_SUMMARY,
  }));
  phoneSvc.confirmCode.mockImplementation(async () => ({ changed: true, phone: VERIFIED_SUMMARY }));
});

// ====================================================================== authentication and identity context
describe('phone API authentication', () => {
  it.each(ROUTES)('$method $url requires a token: 401 with the standard envelope and a Bearer challenge, before any service call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(errorOf(res).correlationId).toBeTruthy();
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url rejects every kind of invalid token with 401 invalid_token and never calls a service', async (r) => {
    const invalid = [
      'not.a.token',
      'abc',
      await signToken(keys, { expiresInSec: -3600 }),
      await signToken(keys, { claims: { aud: 'someone-else' } }),
      await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } }),
      await signToken(keys, { claims: { typ: 'ID' } }),
      await signToken(await createTestKeys('k1'), {}), // the right kid, a different private key
      unsignedToken(),
      await hmacToken(),
    ];
    for (const token of invalid) {
      const res = await routeCall(r, token);
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    }
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url treats a non-Bearer Authorization header as an invalid token', async (r) => {
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer', `Token ${await webToken()}`]) {
      const res = await app.inject({
        method: r.method,
        url: `/api/v1/account${r.url}`,
        headers: { authorization },
        ...(r.body ? { payload: r.body as object } : {}),
      });
      expect(res.statusCode, authorization.slice(0, 12)).toBe(401);
    }
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url refuses the admin identity context with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED and never calls the phone service', async (r) => {
    for (const token of [await adminToken(), await adminToken(['configuration-read', 'configuration-write', 'content-write', 'geography-read'])]) {
      const res = await routeCall(r, token);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
      expect(errorOf(res).details).toBeUndefined();
    }
    expect(noServiceCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url refuses a token issued to any other client (azp) with 403', async (r) => {
    for (const azp of ['other', 'bananagig-dev-test', 'bananagig-api', 'BANANAGIG-WEB', 'bananagig-web ']) {
      const res = await routeCall(r, await webToken({ azp }));
      expect(res.statusCode, azp).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    }
    expect(noServiceCalls()).toBe(true);
  });

  it.each(POST_ROUTES)('$method $url answers 401 before 400: an invalid body without a token (or with a bad one) is 401', async (r) => {
    for (const body of [{ code: 123456, phone: 2, country: 3, extra: true }, { unknown: 'x'.repeat(10) }, [], 'text', 7, null]) {
      const none = await sendJson(r.url, undefined, body);
      expect(none.statusCode, raw(body)).toBe(401);
      expect(errorOf(none).code).toBe('AUTHENTICATION_REQUIRED');
      const bad = await sendJson(r.url, 'bad.token', body);
      expect(bad.statusCode, raw(body)).toBe(401);
      expect(errorOf(bad).code).toBe('INVALID_TOKEN');
    }
    expect(noServiceCalls()).toBe(true);
  });

  it('answers 401 before 400 on GET /phone too: garbage query parameters without a token are 401', async () => {
    for (const qs of ['?accountId=x', '?a=b&c=d', '?x']) expect((await call('GET', `/phone${qs}`)).statusCode, qs).toBe(401);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(POST_ROUTES)('$method $url answers 403 (not 400) for the admin context, even with an invalid body', async (r) => {
    expect((await sendJson(r.url, await adminToken(), { code: 1, phone: 2, country: 3, extra: 4 })).statusCode).toBe(403);
    expect((await sendJson(r.url, await adminToken(), [])).statusCode).toBe(403);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(POST_ROUTES)(
    '$method $url: a malformed JSON body is rejected by the parser (400 BAD_REQUEST) before the token is looked at, and nothing is called',
    async (r) => {
      for (const text of ['{"phone": ', '{phone: 1}', '']) {
        const res = await rawJson(r.url, undefined, text);
        expect(res.statusCode, text).toBe(400);
        expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
      }
      expect(noServiceCalls()).toBe(true);
    },
  );

  it.each(ROUTES)('$method $url passes a guard refusal (suspended or closed account) through as 403 and never calls the phone service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}`, details: { status: code } });
    }
    expect(noPhoneCalls()).toBe(true);
  });

  it('runs the account guard exactly once per request on every route', async () => {
    for (const r of ROUTES) await routeCall(r, await webToken());
    expect(accountSvc.ensureAccountForIdentity).toHaveBeenCalledTimes(ROUTES.length);
  });
});

// ====================================================================== the account comes from the token, the client address from the request
describe('phone API: the account and the client address', () => {
  it.each(ROUTES)('$method $url resolves the account from the verified token and hands exactly that account to the service', async (r) => {
    const res = await routeCall(r, await webToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.ensureAccountForIdentity).toHaveBeenCalledTimes(1);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
    expect(phoneSvc[r.fn]).toHaveBeenCalledTimes(1);
    expect(phoneSvc[r.fn].mock.calls[0]).toEqual(r.args());
  });

  it.each(ROUTES)('$method $url ignores x-account-id style headers and a ?accountId query: the token account is used', async (r) => {
    const res = await call(
      r.method,
      `${r.url}?accountId=${OTHER_ACCOUNT_ID}&account_id=${OTHER_ACCOUNT_ID}&contactId=${OTHER_ACCOUNT_ID}`,
      await webToken(),
      r.body,
      {
        'x-account-id': OTHER_ACCOUNT_ID,
        'x-user-id': OTHER_ACCOUNT_ID,
        'x-subject': OTHER_SUB,
        'x-forwarded-user': OTHER_SUB,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(phoneSvc[r.fn].mock.calls[0]).toEqual(r.args());
    for (const c of phoneSvc[r.fn].mock.calls) expect(raw(c)).not.toContain(OTHER_ACCOUNT_ID);
    expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
  });

  it.each(POST_ROUTES)('$method $url rejects an account id in the body (strict) and never calls the service', async (r) => {
    const body = { ...(r.body as object), accountId: OTHER_ACCOUNT_ID };
    const res = await call(r.method, r.url, await webToken(), body);
    expectValidation(res, body);
    expect(noPhoneCalls()).toBe(true);
  });

  it('gives each token its own account', async () => {
    await call('GET', '/phone', await webToken());
    await call('GET', '/phone', await webToken({ sub: OTHER_SUB }));
    expect(phoneSvc.getPhoneDetail.mock.calls).toEqual([[ACCOUNT_ID], [OTHER_ACCOUNT_ID]]);
    expect(accountSvc.ensureAccountForIdentity.mock.calls.map((c) => c[0].subject)).toEqual([SUB, OTHER_SUB]);
  });

  it.each(POST_ROUTES)('$method $url hands the request address to the abuse limits (x-forwarded-for, trustProxy)', async (r) => {
    const res = await routeCall(r, await webToken(), { 'x-forwarded-for': '203.0.113.9' });
    expect(res.statusCode, res.body).toBe(200);
    expect(phoneSvc[r.fn].mock.calls[0]).toEqual(r.args('203.0.113.9'));
    const ctx = phoneSvc[r.fn].mock.calls[0]!.at(-1) as Record<string, unknown>;
    expect(Object.keys(ctx).filter((k) => ctx[k] !== undefined)).toEqual(['clientIp']);
  });

  it.each(POST_ROUTES)('$method $url uses the connection address when there is no forwarding header (ctx.clientIp = request.ip)', async (r) => {
    await routeCall(r, await webToken());
    expect((phoneSvc[r.fn].mock.calls[0]!.at(-1) as { clientIp: string }).clientIp).toBe('127.0.0.1');
  });

  it.each(POST_ROUTES)(
    '$method $url takes the entry the trusted proxy wrote (the LAST) from a forwarding chain, never the client-chosen leftmost (DEBT-0055)',
    async (r) => {
      await routeCall(r, await webToken(), { 'x-forwarded-for': 'spoofed-by-client, 203.0.113.9' });
      expect((phoneSvc[r.fn].mock.calls[0]!.at(-1) as { clientIp: string }).clientIp).toBe('203.0.113.9');
      await routeCall(r, await webToken(), { 'x-forwarded-for': '198.51.100.7, 198.51.100.8, 203.0.113.9' });
      expect((phoneSvc[r.fn].mock.calls[1]!.at(-1) as { clientIp: string }).clientIp).toBe('203.0.113.9');
    },
  );

  it.each(POST_ROUTES)('$method $url passes an IPv6 client address through', async (r) => {
    await routeCall(r, await webToken(), { 'x-forwarded-for': '2001:db8::1' });
    expect((phoneSvc[r.fn].mock.calls[0]!.at(-1) as { clientIp: string }).clientIp).toBe('2001:db8::1');
  });

  it('never takes the client address from the body, a query parameter or x-real-ip', async () => {
    await call(
      'POST',
      `/phone/verification/confirm-code?clientIp=198.51.100.1&ip=198.51.100.2`,
      await webToken(),
      { code: CODE },
      { 'x-real-ip': '198.51.100.3', forwarded: 'for=198.51.100.4' },
    );
    expect(phoneSvc.confirmCode.mock.calls[0]![2]).toEqual({ clientIp: '127.0.0.1' });
    const rejected = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE, clientIp: '198.51.100.4' });
    expect(rejected.statusCode).toBe(400);
  });

  it('never takes the client address from a clientIp or deviceId field of the set-phone body', async () => {
    for (const extra of [{ clientIp: '198.51.100.9' }, { deviceId: 'device-1' }, { ip: '198.51.100.9' }]) {
      const res = await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER, ...extra });
      expectValidation(res, extra);
    }
    expect(phoneSvc.setPhone).not.toHaveBeenCalled();
  });

  it('reads the detail with the account id only (no address context, no device id)', async () => {
    await call('GET', '/phone', await webToken(), undefined, { 'x-forwarded-for': '203.0.113.9' });
    expect(phoneSvc.getPhoneDetail.mock.calls[0]).toEqual([ACCOUNT_ID]);
  });

  it('hands the x-active-role header to the account guard like every account route', async () => {
    await call('GET', '/phone', await webToken(), undefined, { 'x-active-role': 'PROVIDER' });
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ requestedRole: 'PROVIDER' });
  });

  it('never gives a service the token, the subject, the issuer or the realm roles on a phone call', async () => {
    const token = await webToken();
    for (const r of ROUTES) await routeCall(r, token);
    for (const f of Object.values(phoneSvc))
      for (const c of f.mock.calls) for (const marker of [token, SUB, TEST_ISSUER, REALM_ROLE_MARKER]) expect(raw(c)).not.toContain(marker);
  });
});

// ====================================================================== strict raw bodies (DEBT-0043)
describe('POST /account/phone: strict body', () => {
  const invalidBodies: [string, unknown][] = [
    ['a numeric phone', { phone: 12025550142 }],
    ['a floating point phone', { phone: 2025550142.5 }],
    ['a boolean phone', { phone: true }],
    ['a null phone', { phone: null }],
    ['an array phone', { phone: ['+12025550142'] }],
    ['an object phone', { phone: { number: '+12025550142' } }],
    ['a missing phone', {}],
    ['a missing phone with a country', { country: 'US' }],
    ['an extra property', { phone: '+12025550142', extra: 1 }],
    ['an account id', { phone: '+12025550142', accountId: OTHER_ACCOUNT_ID }],
    ['a primary flag', { phone: '+12025550142', primary: true }],
    ['a verified flag', { phone: '+12025550142', verified: true }],
    ['a purpose', { phone: '+12025550142', purpose: 'CHANGE_PHONE' }],
    ['a line type', { phone: '+12025550142', lineType: 'MOBILE' }],
    ['a calling code', { phone: '2025550142', callingCode: '1' }],
    ['a code next to the phone', { phone: '+12025550142', code: CODE }],
    ['a phone above 64 characters', { phone: `+1${'2'.repeat(63)}` }],
    ['a lower-case country', { country: 'us', phone: '2025550142' }],
    ['a mixed-case country', { country: 'Us', phone: '2025550142' }],
    ['a three letter country', { country: 'USA', phone: '2025550142' }],
    ['a one letter country', { country: 'U', phone: '2025550142' }],
    ['an empty country', { country: '', phone: '2025550142' }],
    ['a numeric country', { country: 1, phone: '2025550142' }],
    ['a null country', { country: null, phone: '2025550142' }],
    ['an array country', { country: ['US'], phone: '2025550142' }],
    ['an object country', { country: { code: 'US' }, phone: '2025550142' }],
    ['a country with a leading space', { country: ' US', phone: '2025550142' }],
    ['a country with a trailing space', { country: 'US ', phone: '2025550142' }],
    ['a country with a trailing newline', { country: `US${LF}`, phone: '2025550142' }],
    ['a country with digits', { country: 'U1', phone: '2025550142' }],
    ['a country written with full-width letters', { country: String.fromCodePoint(0xff35, 0xff33), phone: '2025550142' }],
    ['a country written as a country name', { country: 'United States', phone: '2025550142' }],
    ['a top-level array', [{ phone: '+12025550142' }]],
    ['an empty array', []],
    ['a string body', '+12025550142'],
    ['a number body', 12025550142],
    ['a boolean body', true],
    ['a null body', null],
  ];
  it.each(invalidBodies)('rejects %s with 400 VALIDATION_FAILED, never echoes the value and never calls the service', async (_label, body) => {
    const res = await sendJson('/phone', await webToken(), body);
    expectValidation(res, body);
    expect(noPhoneCalls()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
  });

  it('does NOT coerce a number to a string: {"phone":12025550142} is a 400, the service is not called', async () => {
    const res = await rawJson('/phone', await webToken(), '{"phone":12025550142}');
    expectValidation(res);
    expect(phoneSvc.setPhone).not.toHaveBeenCalled();
  });

  it('does NOT coerce a boolean or a null phone either', async () => {
    for (const text of ['{"phone":true}', '{"phone":null}', '{"phone":0}']) {
      expectValidation(await rawJson('/phone', await webToken(), text));
    }
    expect(phoneSvc.setPhone).not.toHaveBeenCalled();
  });

  it.each([
    ['an international number', FULL_NUMBER, undefined],
    ['a national number with a country', NATIONAL_NUMBER, 'US'],
    ['a national number with a GB country', '020 7946 0958', 'GB'],
    ['a number with letters (INVALID_CHARACTERS is the service rule)', '202-555-CALL', 'US'],
    ['a number with an extension (the service refuses it)', '+12025550142 x12', undefined],
    ['a number with a bidi control character', `+1202555${String.fromCodePoint(0x202e)}0142`, undefined],
    ['a number with a NUL character', `+1202555${String.fromCharCode(0)}0142`, undefined],
    ['a padded number', '  +1 202 555 0142  ', undefined],
    ['full-width digits', String.fromCodePoint(0xff0b, 0xff11, 0xff12, 0xff10, 0xff12, 0xff15, 0xff15, 0xff15, 0xff10, 0xff11, 0xff14, 0xff12), undefined],
    ['an empty string (the contract has no minimum; the service answers REQUIRED)', '', undefined],
    ['a whitespace-only string', '   ', undefined],
    ['an unknown country code the service decides on', '2025550142', 'ZZ'],
  ])('hands %s to the service VERBATIM (canonicalization and the issue codes belong to the service)', async (_label, phone, country) => {
    const res = await call('POST', '/phone', await webToken(), { phone, ...(country ? { country } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    expect(phoneSvc.setPhone.mock.calls[0]![1]).toBe(phone);
    expect(phoneSvc.setPhone.mock.calls[0]![2]).toEqual({ ...(country ? { country } : {}), clientIp: '127.0.0.1' });
  });

  it('accepts a phone of exactly 64 characters at the API boundary and passes it to the service unchanged', async () => {
    const edge = `+1${' '.repeat(62)}2`;
    expect(edge).toHaveLength(65);
    const sixtyFour = `+1${' '.repeat(61)}2`;
    expect(sixtyFour).toHaveLength(64);
    const res = await call('POST', '/phone', await webToken(), { phone: sixtyFour });
    expect(res.statusCode).toBe(200);
    expect(phoneSvc.setPhone.mock.calls[0]![1]).toBe(sixtyFour);
    expectValidation(await call('POST', '/phone', await webToken(), { phone: edge }), { phone: edge });
  });

  it('passes the service refusal of an empty phone through with its issue code and message key', async () => {
    phoneSvc.setPhone.mockRejectedValueOnce(
      new AccountError('PHONE_INVALID', 'the phone number is not valid', { reason: 'REQUIRED', messageKey: 'account.phone.error.required' }),
    );
    const res = await call('POST', '/phone', await webToken(), { phone: '' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ code: 'ACCOUNT_PHONE_INVALID', details: { reason: 'REQUIRED', messageKey: 'account.phone.error.required' } });
  });
});

describe('POST /account/phone/verification/send: strict body', () => {
  const url = '/phone/verification/send';
  it('accepts exactly {} (the body the web app sends)', async () => {
    const res = await call('POST', url, await webToken(), {});
    expect(res.statusCode).toBe(200);
    expect(phoneSvc.sendVerification).toHaveBeenCalledTimes(1);
  });
  const invalidBodies: [string, unknown][] = [
    ['an extra property', { extra: 1 }],
    ['a phone', { phone: FULL_NUMBER }],
    ['a country', { country: 'US' }],
    ['an account id', { accountId: OTHER_ACCOUNT_ID }],
    ['a code', { code: CODE }],
    ['a force flag', { force: true }],
    ['a channel', { channel: 'VOICE' }],
    ['a top-level array', []],
    ['a non-empty array', [{}]],
    ['a string body', 'typed-marker'],
    ['a number body', 7],
    ['a boolean body', false],
    ['a null body', null],
  ];
  it.each(invalidBodies)('rejects %s with 400 VALIDATION_FAILED and never sends', async (_label, body) => {
    const res = await sendJson(url, await webToken(), body);
    expectValidation(res, body);
    expect(noPhoneCalls()).toBe(true);
  });
  it('rejects a request with NO body at all: 400 VALIDATION_FAILED (the contract is an object, `{}`), and nothing is sent', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/account${url}`, headers: { authorization: `Bearer ${await webToken()}` } });
    expectValidation(res);
    expect(phoneSvc.sendVerification).not.toHaveBeenCalled();
  });
  it('rejects a JSON content type with an EMPTY body in the parser: 400 BAD_REQUEST, and nothing is sent', async () => {
    const res = await rawJson(url, await webToken(), '');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
    expect(phoneSvc.sendVerification).not.toHaveBeenCalled();
  });
});

describe('POST /account/phone/verification/confirm-code: strict body', () => {
  const url = '/phone/verification/confirm-code';
  const invalidBodies: [string, unknown][] = [
    ['a numeric code (not coerced to a string)', { code: 123456 }],
    ['a numeric code of another length', { code: 1234 }],
    ['a fractional code', { code: 123456.5 }],
    ['a boolean code', { code: true }],
    ['a null code', { code: null }],
    ['an array code', { code: ['123456'] }],
    ['an object code', { code: { value: '123456' } }],
    ['a missing code', {}],
    ['an extra property', { code: '123456', extra: 1 }],
    ['an account id', { code: '123456', accountId: OTHER_ACCOUNT_ID }],
    ['a phone next to the code', { code: '123456', phone: FULL_NUMBER }],
    ['a token next to the code', { code: '123456', token: 'x'.repeat(43) }],
    ['a code of 3 digits', { code: '123' }],
    ['a code of 11 digits', { code: '12345678901' }],
    ['an empty code', { code: '' }],
    ['a code with a letter', { code: '12345a' }],
    ['a code with a space inside', { code: '123 456' }],
    ['a code with a leading space', { code: ' 123456' }],
    ['a code with a trailing space', { code: '123456 ' }],
    ['a code with a trailing newline', { code: `123456${LF}` }],
    ['a code with a dash', { code: '123-456' }],
    ['a code with a plus sign', { code: '+123456' }],
    ['a hexadecimal code', { code: '0x1234' }],
    ['an exponent code', { code: '1e50000' }],
    ['a code of full-width digits', { code: String.fromCodePoint(0xff11, 0xff12, 0xff13, 0xff14, 0xff15, 0xff16) }],
    ['a code of Arabic-Indic digits', { code: String.fromCodePoint(0x661, 0x662, 0x663, 0x664, 0x665, 0x666) }],
    ['a top-level array', ['123456']],
    ['a string body', '123456'],
    ['a number body', 123456],
    ['a null body', null],
  ];
  it.each(invalidBodies)('rejects %s with 400 VALIDATION_FAILED and never counts an attempt', async (_label, body) => {
    const res = await sendJson(url, await webToken(), body);
    expectValidation(res, body);
    expect(noPhoneCalls()).toBe(true);
  });
  it('does NOT coerce a number to a string: {"code":123456} is a 400 and the service is not called', async () => {
    const res = await rawJson(url, await webToken(), '{"code":123456}');
    expectValidation(res);
    expect(phoneSvc.confirmCode).not.toHaveBeenCalled();
  });
  it('does NOT coerce a leading-zero number: {"code":000123} is not even JSON, {"code":123} is a 400', async () => {
    expect((await rawJson(url, await webToken(), '{"code":000123}')).statusCode).toBe(400);
    expectValidation(await rawJson(url, await webToken(), '{"code":123}'));
    expect(phoneSvc.confirmCode).not.toHaveBeenCalled();
  });
  it.each(['1234', '000000', '0123456789', '999999'])(
    'accepts the well-formed code %s and passes it to the service as the exact string (length is a configuration check)',
    async (code) => {
      const res = await call('POST', url, await webToken(), { code });
      expect(res.statusCode).toBe(200);
      expect(phoneSvc.confirmCode.mock.calls[0]![1]).toBe(code);
    },
  );
});

describe('phone API: content types and query strings', () => {
  it.each(POST_ROUTES)(
    '$method $url: a plain text body is a 400 (not an object), a form, XML or vendor JSON body a 415, all in the standard envelope',
    async (r) => {
      const authorization = `Bearer ${await webToken()}`;
      const text = JSON.stringify(r.body);
      const attempts: [string, string, number][] = [
        ['text/plain', text, 400],
        ['application/x-www-form-urlencoded', 'code=123456&phone=%2B12025550142', 415],
        ['application/xml', '<code>123456</code>', 415],
        ['application/vnd.api+json', text, 415],
      ];
      for (const [contentType, payload, status] of attempts) {
        const res = await app.inject({ method: 'POST', url: `/api/v1/account${r.url}`, headers: { authorization, 'content-type': contentType }, payload });
        expect(res.statusCode, contentType).toBe(status);
        expect(errorOf(res).category, contentType).toBe('VALIDATION');
      }
      expect(noPhoneCalls()).toBe(true);
    },
  );

  it('ignores a JSON body sent with GET /phone (a body selects nothing) and unknown query parameters', async () => {
    const res = await call('GET', '/phone?accountId=x&foo=1', await webToken(), { accountId: OTHER_ACCOUNT_ID }, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(phoneSvc.getPhoneDetail.mock.calls).toEqual([[ACCOUNT_ID]]);
  });

  it('never takes the phone number or the code from the query string', async () => {
    const res = await call('POST', `/phone?phone=${encodeURIComponent(FULL_NUMBER)}&country=US`, await webToken(), {});
    expectValidation(res);
    const res2 = await call('POST', `/phone/verification/confirm-code?code=${CODE}`, await webToken(), {});
    expectValidation(res2);
    expect(noPhoneCalls()).toBe(true);
  });
});

// ====================================================================== responses
describe('phone API responses', () => {
  it.each(ROUTES)('$method $url answers {data, meta:{correlationId}} and nothing else, JSON, echoing the request correlation id', async (r) => {
    const res = await routeCall(r, await webToken(), { [CORRELATION_HEADER]: 'corr-id-003' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: object; meta: { correlationId: string } };
    expect(keysOf(body)).toEqual(['data', 'meta']);
    expect(body.meta).toEqual({ correlationId: 'corr-id-003' });
    expect(res.headers[CORRELATION_HEADER]).toBe('corr-id-003');
    expect(String(res.headers['content-type'])).toContain('application/json');
    const schema =
      { getAccountPhone: AccountPhoneResponse, setAccountPhone: SetPhoneResponse, sendAccountPhoneVerification: PhoneVerificationSentResponse }[r.id] ??
      PhoneVerifiedResponse;
    expect(schema.safeParse(body).success, res.body).toBe(true);
  });

  it('GET /phone serializes every date as an ISO string, null stays null, and exposes the detail fields exactly', async () => {
    const res = await call('GET', '/phone', await webToken());
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(['attemptsRemaining', 'codeLength', 'pending', 'phoneVerificationStatus', 'primary', 'resendAvailableAt', 'validityMinutes']);
    expect(data).toMatchObject({
      resendAvailableAt: '2026-01-01T00:05:30.000Z',
      attemptsRemaining: 5,
      codeLength: 6,
      validityMinutes: 10,
      phoneVerificationStatus: 'PENDING',
    });
    expect(new Date(data.resendAvailableAt as string).toISOString()).toBe(data.resendAvailableAt);
    phoneSvc.getPhoneDetail.mockResolvedValueOnce({ ...NONE_SUMMARY, resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 10 });
    const empty = ((await call('GET', '/phone', await webToken())).json() as { data: Record<string, unknown> }).data;
    expect(empty).toMatchObject({ resendAvailableAt: null, attemptsRemaining: null, pending: null, primary: null, phoneVerificationStatus: 'NONE' });
  });

  it('GET /phone with a service Date resendAvailableAt of null keeps null (no "Invalid Date")', async () => {
    phoneSvc.getPhoneDetail.mockResolvedValueOnce({ ...PENDING_SUMMARY, resendAvailableAt: null, attemptsRemaining: 5, codeLength: 6, validityMinutes: 10 });
    const res = await call('GET', '/phone', await webToken());
    expect((res.json() as { data: { resendAvailableAt: unknown } }).data.resendAvailableAt).toBeNull();
    expect(res.body).not.toContain('Invalid');
  });

  it.each(ROUTES)('$method $url never contains a full number: only the masked form', async (r) => {
    const res = await routeCall(r, await webToken());
    expect(res.body).toContain(MASKED);
    for (const word of [FULL_NUMBER, '12025550142', '2025550142', '202555']) expect(res.body).not.toContain(word);
  });

  it('builds the responses from the declared fields: internal attributes a service result carries never reach the client', async () => {
    const leak = { fullNumber: FULL_NUMBER, e164: FULL_NUMBER, codeHash: 'a'.repeat(64), code: '908172', challengeId: OTHER_ACCOUNT_ID, lineType: 'VOIP' };
    phoneSvc.getPhoneDetail.mockResolvedValueOnce({
      ...PENDING_SUMMARY,
      resendAvailableAt: null,
      attemptsRemaining: 5,
      codeLength: 6,
      validityMinutes: 10,
      ...leak,
    });
    phoneSvc.setPhone.mockResolvedValueOnce({ changed: true, phone: PENDING_SUMMARY, ...leak });
    phoneSvc.confirmCode.mockResolvedValueOnce({ changed: true, phone: VERIFIED_SUMMARY, ...leak });
    phoneSvc.sendVerification.mockResolvedValueOnce({
      sentAt: SENT_AT,
      expiresAt: EXPIRES_AT,
      resendAvailableAt: RESEND_AT,
      codeLength: 6,
      validityMinutes: 10,
      phone: PENDING_SUMMARY,
      ...leak,
    });
    const token = await webToken();
    for (const r of ROUTES) {
      const res = await routeCall(r, token);
      expect(res.statusCode, r.id).toBe(200);
      for (const value of [FULL_NUMBER, 'a'.repeat(64), '908172', 'fullNumber', 'e164', 'codeHash', 'challengeId', 'lineType', 'VOIP'])
        expect(res.body, `${r.id} leaks ${value}`).not.toContain(value);
    }
  });

  it('never lets an unexpected attribute inside the phone summary through (the response fails closed instead of leaking it)', async () => {
    phoneSvc.setPhone.mockResolvedValueOnce({
      changed: true,
      phone: { ...PENDING_SUMMARY, pending: { ...PENDING_SUMMARY.pending, number: FULL_NUMBER } },
    });
    const res = await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER });
    expect(res.body).not.toContain(FULL_NUMBER);
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 500) expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  it('POST /phone/verification/send serializes sentAt, expiresAt and resendAvailableAt as ISO strings with the code policy', async () => {
    const res = await call('POST', '/phone/verification/send', await webToken(), {});
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(['codeLength', 'expiresAt', 'phone', 'resendAvailableAt', 'sentAt', 'validityMinutes']);
    expect(data).toMatchObject({
      sentAt: '2026-01-01T00:05:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      resendAvailableAt: '2026-01-01T00:05:30.000Z',
      codeLength: 6,
      validityMinutes: 10,
    });
    // the answer never carries the code: it exists only in the SMS
    expect(res.body).not.toMatch(/verification_code|"code"|"token"|"body"/);
  });

  it('POST /phone and the confirm route answer {changed, phone}; the confirm route exposes the VERIFIED summary, masked', async () => {
    const set = (await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER })).json() as { data: Record<string, unknown> };
    expect(keysOf(set.data)).toEqual(['changed', 'phone']);
    expect(set.data.changed).toBe(true);
    const res = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE });
    const data = (res.json() as { data: { changed: boolean; phone: typeof VERIFIED_SUMMARY } }).data;
    expect(keysOf(data)).toEqual(['changed', 'phone']);
    expect(data.phone).toEqual(VERIFIED_SUMMARY);
    expect(res.body).not.toContain(FULL_NUMBER);
  });

  it('passes changed:false (an idempotent repeat or an unchanged number) through unchanged', async () => {
    phoneSvc.confirmCode.mockResolvedValueOnce({ changed: false, phone: VERIFIED_SUMMARY });
    phoneSvc.setPhone.mockResolvedValueOnce({ changed: false, phone: CHANGING_SUMMARY });
    expect(
      ((await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE })).json() as { data: { changed: boolean } }).data.changed,
    ).toBe(false);
    expect(((await call('POST', '/phone', await webToken(), { phone: '+12025550199' })).json() as { data: { changed: boolean } }).data.changed).toBe(false);
  });

  it('exposes a pending replacement next to the verified primary, both masked', async () => {
    phoneSvc.setPhone.mockResolvedValueOnce({ changed: true, phone: CHANGING_SUMMARY });
    const res = await call('POST', '/phone', await webToken(), { phone: '+12025550199' });
    const phone = (res.json() as { data: { phone: typeof CHANGING_SUMMARY } }).data.phone;
    expect(phone).toEqual(CHANGING_SUMMARY);
    expect(phone.pending.purpose).toBe('CHANGE_PHONE');
    expect(res.body).not.toContain('+12025550199');
  });
});

describe('phone API responses are never cached', () => {
  it.each(ROUTES)('$method $url sends Cache-Control: no-store on successes and on every kind of error', async (r) => {
    const t = await webToken();
    const results: Reply[] = [await routeCall(r, t), await routeCall(r), await routeCall(r, await adminToken([]))];
    if (r.method === 'POST') results.push(await sendJson(r.url, t, { bogus: true }));
    for (const [code, status] of [
      ['PHONE_RESEND_TOO_SOON', 429],
      ['PHONE_UNAVAILABLE', 409],
      ['PHONE_DELIVERY_FAILED', 503],
      ['PHONE_CODE_INVALID', 400],
    ] as const) {
      phoneSvc[r.fn].mockRejectedValueOnce(new AccountError(code, 'x', {}));
      const res = await routeCall(r, t);
      expect(res.statusCode).toBe(status);
      results.push(res);
    }
    phoneSvc[r.fn].mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    results.push(await routeCall(r, t)); // 500
    expect(new Set(results.map((x) => x.statusCode)).size).toBeGreaterThanOrEqual(5);
    for (const res of results) expect(res.headers['cache-control'], String(res.statusCode)).toBe('no-store');
  });
});

// ====================================================================== error mapping
describe('phone API error mapping', () => {
  const MESSAGE_KEY: Record<PhoneErrorCode, string> = {
    PHONE_INVALID: 'account.phone.error.invalid_number', // carried by the service (an issue code), passed through
    PHONE_NOT_PENDING: 'account.phone.error.not_pending',
    PHONE_CODE_INVALID: 'account.phone.error.code_invalid',
    PHONE_CODE_EXPIRED: 'account.phone.error.code_expired',
    PHONE_CODE_USED: 'account.phone.error.code_used',
    PHONE_VERIFICATION_LOCKED: 'account.phone.error.verification_locked',
    PHONE_RESEND_TOO_SOON: 'account.phone.error.resend_too_soon',
    PHONE_SEND_LIMIT: 'account.phone.error.send_limit',
    PHONE_UNAVAILABLE: 'account.phone.error.unavailable',
    PHONE_NOT_ACCEPTED: 'account.phone.error.not_accepted',
    PHONE_RISK_UNAVAILABLE: 'account.phone.error.risk_unavailable',
    PHONE_DELIVERY_FAILED: 'account.phone.error.delivery_failed',
    PHONE_RATE_LIMITED: 'account.phone.error.rate_limited',
  };
  const EXPECTED: Record<PhoneErrorCode, [number, string]> = {
    PHONE_INVALID: [400, 'VALIDATION'],
    PHONE_NOT_PENDING: [409, 'CONFLICT'],
    PHONE_CODE_INVALID: [400, 'VALIDATION'],
    PHONE_CODE_EXPIRED: [400, 'VALIDATION'],
    PHONE_CODE_USED: [400, 'VALIDATION'],
    PHONE_VERIFICATION_LOCKED: [429, 'RATE_LIMIT'],
    PHONE_RESEND_TOO_SOON: [429, 'RATE_LIMIT'],
    PHONE_SEND_LIMIT: [429, 'RATE_LIMIT'],
    PHONE_UNAVAILABLE: [409, 'CONFLICT'],
    PHONE_NOT_ACCEPTED: [400, 'VALIDATION'],
    PHONE_RISK_UNAVAILABLE: [503, 'DEPENDENCY'],
    PHONE_DELIVERY_FAILED: [503, 'DEPENDENCY'],
    PHONE_RATE_LIMITED: [429, 'RATE_LIMIT'],
  };
  const RATE_LIMITED = ['PHONE_VERIFICATION_LOCKED', 'PHONE_RESEND_TOO_SOON', 'PHONE_SEND_LIMIT', 'PHONE_RATE_LIMITED'] as const;
  const MAPPED_WITH_KEY = PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID' && c !== 'PHONE_RISK_UNAVAILABLE' && c !== 'PHONE_DELIVERY_FAILED');
  const GENERIC = {
    PHONE_RISK_UNAVAILABLE: 'The phone number could not be checked right now',
    PHONE_DELIVERY_FAILED: 'The verification text could not be sent',
  } as const;

  /** What a hostile or sloppy service could attach: the API must drop the cause and the constraint name whatever else it passes. */
  const failure = (code: PhoneErrorCode, extra: Record<string, unknown> = {}) =>
    new AccountError(code, `${code} happened`, {
      reason: 'SOME_REASON',
      constraint: 'uq_phone_contacts__verified_number',
      cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM identity.phone_contacts password=hunter2',
      ...(code === 'PHONE_INVALID' ? { messageKey: MESSAGE_KEY.PHONE_INVALID } : {}),
      ...extra,
    });
  const LEAKS = [
    'ECONNREFUSED',
    'SELECT',
    'hunter2',
    'cause',
    'constraint',
    'uq_phone_contacts',
    'identity.phone_contacts',
    '10.0.0.5',
    SUB,
    TEST_ISSUER,
    REALM_ROLE_MARKER,
  ];
  const cases = PHONE_ERROR_CODES.flatMap((code) => ROUTES.map((r) => [code, r] as const));

  it('covers every phone error code', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PHONE_ERROR_CODES].sort());
    expect(Object.keys(MESSAGE_KEY).sort()).toEqual([...PHONE_ERROR_CODES].sort());
    expect(PHONE_ERROR_CODES).toHaveLength(13);
  });

  it('the managed message keys are derived by phoneErrorMessageKey', () => {
    for (const code of PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID'))
      expect(phoneErrorMessageKey(code as Exclude<PhoneErrorCode, 'PHONE_INVALID'>)).toBe(MESSAGE_KEY[code]);
  });

  it.each(cases.map(([code, r]) => [code, r.id, r] as const))(
    'maps %s on %s to the standard error model: status, category, ACCOUNT_ code, message key, hostile details dropped',
    async (code, _id, r) => {
      const [status, category] = EXPECTED[code];
      phoneSvc[r.fn].mockRejectedValueOnce(failure(code));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, res.body).toBe(status);
      expect(errorOf(res)).toMatchObject({ category, code: `ACCOUNT_${code}` });
      expect(errorOf(res).correlationId).toBe(res.headers[CORRELATION_HEADER]);
      for (const leak of LEAKS) expect(res.body, `leaks ${leak}`).not.toContain(leak);
      if (code === 'PHONE_RISK_UNAVAILABLE' || code === 'PHONE_DELIVERY_FAILED') {
        expect(errorOf(res).message).toBe(GENERIC[code]);
        expect(errorOf(res).details).toEqual({ retryable: code === 'PHONE_RISK_UNAVAILABLE', messageKey: MESSAGE_KEY[code] });
      } else {
        expect(errorOf(res).message).toBe(`${code} happened`);
        expect(errorOf(res).details).toEqual({ reason: 'SOME_REASON', messageKey: MESSAGE_KEY[code] });
      }
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it.each(MAPPED_WITH_KEY)("%s: the message key is the API's own, whatever the service put in its details", async (code) => {
    phoneSvc.confirmCode.mockRejectedValueOnce(failure(code, { messageKey: 'account.phone.error.something_else' }));
    const res = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE });
    expect((errorOf(res).details as { messageKey: string }).messageKey).toBe(MESSAGE_KEY[code]);
  });

  it.each(['PHONE_RISK_UNAVAILABLE', 'PHONE_DELIVERY_FAILED'] as const)('%s ignores the message key and extra details a service attaches', async (code) => {
    phoneSvc.setPhone.mockRejectedValueOnce(failure(code, { messageKey: 'account.phone.error.something_else', extra: FULL_NUMBER, retryable: true }));
    const res = await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER });
    expect(res.statusCode).toBe(503);
    expect(keysOf(errorOf(res).details!)).toEqual(['messageKey', 'retryable']);
    expect((errorOf(res).details as { messageKey: string }).messageKey).toBe(MESSAGE_KEY[code]);
    expect(res.body).not.toContain(FULL_NUMBER);
  });

  it('PHONE_INVALID passes the issue code and its message key through (400 VALIDATION), and still drops the cause and constraint', async () => {
    phoneSvc.setPhone.mockRejectedValueOnce(failure('PHONE_INVALID', { reason: 'INVALID_NUMBER', messageKey: 'account.phone.error.invalid_number' }));
    const res = await call('POST', '/phone', await webToken(), { phone: 'typed-marker' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({
      category: 'VALIDATION',
      code: 'ACCOUNT_PHONE_INVALID',
      details: { reason: 'INVALID_NUMBER', messageKey: 'account.phone.error.invalid_number' },
    });
    expect(res.body).not.toContain('typed-marker');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it.each(['REQUIRED', 'TOO_LONG', 'INVALID_CHARACTERS', 'INVALID_NUMBER', 'COUNTRY_REQUIRED', 'COUNTRY_NOT_SUPPORTED'])(
    'PHONE_INVALID with the issue %s keeps the issue code in details.reason',
    async (reason) => {
      phoneSvc.setPhone.mockRejectedValueOnce(
        new AccountError('PHONE_INVALID', 'the phone number is not valid', { reason, messageKey: `account.phone.error.${reason.toLowerCase()}` }),
      );
      const res = await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toEqual({ reason, messageKey: `account.phone.error.${reason.toLowerCase()}` });
    },
  );

  it('PHONE_CODE_INVALID carries the attempts remaining as a number', async () => {
    phoneSvc.confirmCode.mockRejectedValueOnce(new AccountError('PHONE_CODE_INVALID', 'the code is not correct', { attemptsRemaining: 3 }));
    const res = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual({ attemptsRemaining: 3, messageKey: 'account.phone.error.code_invalid' });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('PHONE_CODE_INVALID with zero attempts remaining keeps the zero', async () => {
    phoneSvc.confirmCode.mockRejectedValueOnce(new AccountError('PHONE_CODE_INVALID', 'the code is not correct', { attemptsRemaining: 0 }));
    const res = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE });
    expect((errorOf(res).details as { attemptsRemaining: number }).attemptsRemaining).toBe(0);
  });

  it.each(RATE_LIMITED.flatMap((code) => ROUTES.map((r) => [code, r.id, r] as const)))(
    '%s on %s: 429 with Retry-After equal to details.retryAfterSeconds',
    async (code, _id, r) => {
      phoneSvc[r.fn].mockRejectedValueOnce(failure(code, { retryAfterSeconds: 42 }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
      expect((errorOf(res).details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(42);
      expect(errorOf(res).details).toMatchObject({ messageKey: MESSAGE_KEY[code] });
    },
  );

  it.each(RATE_LIMITED)('%s without a wait time sends no Retry-After (absent, null or a non-number)', async (code) => {
    for (const details of [{}, { retryAfterSeconds: null }, { retryAfterSeconds: '42' }, { retryAfterSeconds: undefined }]) {
      phoneSvc.sendVerification.mockRejectedValueOnce(new AccountError(code, 'wait', details));
      const res = await call('POST', '/phone/verification/send', await webToken(), {});
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after'], raw(details)).toBeUndefined();
    }
  });

  it.each([1, 30, 600, 3600, 86400])('Retry-After carries %s seconds as a plain integer string', async (wait) => {
    phoneSvc.sendVerification.mockRejectedValueOnce(new AccountError('PHONE_RESEND_TOO_SOON', 'wait', { retryAfterSeconds: wait }));
    const res = await call('POST', '/phone/verification/send', await webToken(), {});
    expect(res.headers['retry-after']).toBe(String(wait));
    expect(res.headers['retry-after']).toMatch(/^[0-9]+$/);
  });

  it.each(PHONE_ERROR_CODES.filter((c) => !(RATE_LIMITED as readonly string[]).includes(c)))(
    '%s never sends Retry-After, even when the service attaches a wait time',
    async (code) => {
      phoneSvc.confirmCode.mockRejectedValueOnce(failure(code, { retryAfterSeconds: 42 }));
      const res = await call('POST', '/phone/verification/confirm-code', await webToken(), { code: CODE });
      expect(res.statusCode, code).not.toBe(429);
      expect(res.headers['retry-after'], code).toBeUndefined();
    },
  );

  it('a rate-limit refusal never names the refusing dimension (account, number, source address, device): code, message and details are the same shape', async () => {
    const token = await webToken();
    const bodies: unknown[] = [];
    for (const wait of [3, 1800]) {
      phoneSvc.setPhone.mockRejectedValueOnce(new AccountError('PHONE_RATE_LIMITED', 'too many requests', { retryAfterSeconds: wait }));
      const res = await call('POST', '/phone', token, { phone: FULL_NUMBER });
      expect(res.statusCode).toBe(429);
      const error = errorOf(res);
      expect(keysOf(error)).toEqual(['category', 'code', 'correlationId', 'details', 'message']);
      expect(keysOf(error.details!)).toEqual(['messageKey', 'retryAfterSeconds']);
      expect(error.message).toBe('too many requests');
      expect(keysOf(res.headers).filter((h) => h.startsWith('x-ratelimit') || h.startsWith('ratelimit'))).toEqual([]);
      bodies.push({ code: error.code, message: error.message, detailKeys: keysOf(error.details!) });
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it.each([
    [true, true],
    [false, false],
    ['yes', false],
    [undefined, false],
    [1, false],
  ])('PHONE_DELIVERY_FAILED is 503 DEPENDENCY with a generic message and retryable=%s -> %s (only a boolean true counts)', async (given, expected) => {
    for (const r of POST_ROUTES) {
      phoneSvc[r.fn].mockRejectedValueOnce(
        new AccountError('PHONE_DELIVERY_FAILED', `sms gateway 10.0.0.9:2775 refused ${FULL_NUMBER}`, { retryable: given, cause: 'smpp' }),
      );
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(503);
      expect(errorOf(res)).toMatchObject({
        category: 'DEPENDENCY',
        code: 'ACCOUNT_PHONE_DELIVERY_FAILED',
        message: 'The verification text could not be sent',
        details: { retryable: expected, messageKey: 'account.phone.error.delivery_failed' },
      });
      expect(keysOf(errorOf(res).details!)).toEqual(['messageKey', 'retryable']);
      for (const leak of ['10.0.0.9', 'smpp', FULL_NUMBER, 'gateway']) expect(res.body).not.toContain(leak);
    }
  });

  it.each([true, false, 'yes', undefined, 1])('PHONE_RISK_UNAVAILABLE is always retryable (service said %s) with a generic message', async (given) => {
    phoneSvc.setPhone.mockRejectedValueOnce(
      new AccountError('PHONE_RISK_UNAVAILABLE', `lookup vendor timed out for ${FULL_NUMBER}`, { retryable: given, cause: 'timeout' }),
    );
    const res = await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).details).toEqual({ retryable: true, messageKey: 'account.phone.error.risk_unavailable' });
    expect(errorOf(res).message).toBe('The phone number could not be checked right now');
    expect(res.body).not.toContain('vendor');
    expect(res.body).not.toContain(FULL_NUMBER);
  });

  it('answers a limiter or policy outage (UNAVAILABLE) with a generic 503 and no details, on every route', async () => {
    for (const r of ROUTES) {
      phoneSvc[r.fn].mockRejectedValueOnce(
        new AccountError('UNAVAILABLE', 'the request cannot be accepted right now', { reason: 'RATE_LIMITER_UNAVAILABLE', cause: 'valkey down' }),
      );
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.url).toBe(503);
      expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
      expect(errorOf(res).details).toBeUndefined();
      for (const leak of ['RATE_LIMITER_UNAVAILABLE', 'valkey', 'cause']) expect(res.body).not.toContain(leak);
    }
  });

  it.each(ROUTES.map((r) => [r.id, r] as const))('reports an unexpected (non-account) failure on %s as a generic 500 without the cause', async (_id, r) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    phoneSvc[r.fn].mockRejectedValueOnce(new Error(`boom: password=hunter2 identity.phone_contacts ${FULL_NUMBER}`));
    const res = await routeCall(r, await webToken());
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
    for (const leak of ['hunter2', 'identity.phone_contacts', FULL_NUMBER, 'boom']) expect(res.body).not.toContain(leak);
  });

  it('keeps the ID-001 codes mapped the same way on the phone routes (a closed account is 403, a missing account 404)', async () => {
    phoneSvc.getPhoneDetail.mockRejectedValueOnce(new AccountError('NOT_FOUND', 'the account does not exist'));
    expect((await call('GET', '/phone', await webToken())).statusCode).toBe(404);
    phoneSvc.setPhone.mockRejectedValueOnce(new AccountError('CLOSED', 'closed', { status: 'CLOSED' }));
    expect((await call('POST', '/phone', await webToken(), { phone: FULL_NUMBER })).statusCode).toBe(403);
    phoneSvc.sendVerification.mockRejectedValueOnce(new AccountError('SUSPENDED', 'suspended', { status: 'SUSPENDED' }));
    expect((await call('POST', '/phone/verification/send', await webToken(), {})).statusCode).toBe(403);
  });

  it('does not map an email code specially on a phone route: it keeps its own mapping', async () => {
    phoneSvc.sendVerification.mockRejectedValueOnce(new AccountError('EMAIL_CODE_INVALID', 'x', {}));
    const res = await call('POST', '/phone/verification/send', await webToken(), {});
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('ACCOUNT_EMAIL_CODE_INVALID');
  });
});

// ====================================================================== registration
describe('phone routes are registered only when the phone service is provided', () => {
  const authorized = async () => ({ authorization: `Bearer ${await webToken()}` });

  it('without phoneVerification the four phone routes are 404 ROUTE_NOT_FOUND while the three ID-001 routes keep working', async () => {
    const bare = await buildApp({ cfg, verifier, configuration: {} as never, accounts: accountSvc as unknown as AccountService, readiness: async () => ({}) });
    await bare.ready();
    const headers = await authorized();
    for (const r of ROUTES) {
      const res = await bare.inject({ method: r.method, url: `/api/v1/account${r.url}`, headers, ...(r.body ? { payload: r.body as object } : {}) });
      expect(res.statusCode, r.url).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    }
    expect((await bare.inject({ method: 'GET', url: '/api/v1/account/me', headers })).statusCode).toBe(200);
    expect((await bare.inject({ method: 'POST', url: '/api/v1/account/active-role', headers, payload: { role: 'CUSTOMER' } })).statusCode).toBe(200);
    expect((await bare.inject({ method: 'PUT', url: '/api/v1/account/profile', headers, payload: { firstName: 'Ana', lastName: 'M' } })).statusCode).toBe(200);
    expect(noPhoneCalls()).toBe(true);
    const paths = Object.keys((bare.swagger() as { paths: object }).paths).filter((p) => p.includes('/account/'));
    expect(paths.sort()).toEqual(['/api/v1/account/active-role', '/api/v1/account/me', '/api/v1/account/profile']);
    expect(bare.hasDecorator('phoneVerification')).toBe(false);
    await bare.close();
  });

  it('with only the email service the email routes work and the phone routes are absent', async () => {
    const withEmail = await buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      accounts: accountSvc as unknown as AccountService,
      emailVerification: emailSvc as unknown as EmailVerificationService,
      readiness: async () => ({}),
    });
    await withEmail.ready();
    const headers = await authorized();
    emailSvc.getEmailDetail.mockResolvedValue({
      emailVerificationStatus: 'NONE',
      primary: null,
      pending: null,
      resendAvailableAt: null,
      attemptsRemaining: null,
      codeLength: 6,
      validityMinutes: 10,
    });
    expect((await withEmail.inject({ method: 'GET', url: '/api/v1/account/email', headers })).statusCode).toBe(200);
    for (const r of ROUTES) {
      const res = await withEmail.inject({ method: r.method, url: `/api/v1/account${r.url}`, headers, ...(r.body ? { payload: r.body as object } : {}) });
      expect(res.statusCode, r.url).toBe(404);
    }
    expect(noPhoneCalls()).toBe(true);
    await withEmail.close();
  });

  it('with only the phone service the phone routes work and the email routes are absent', async () => {
    const headers = await authorized();
    for (const url of ['/api/v1/account/email', '/api/v1/account/email/verification/send']) {
      const res = await app.inject({ method: url.endsWith('send') ? 'POST' : 'GET', url, headers, ...(url.endsWith('send') ? { payload: {} } : {}) });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/account/phone', headers })).statusCode).toBe(200);
  });

  it('with both services both families are registered', async () => {
    const both = await buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      accounts: accountSvc as unknown as AccountService,
      emailVerification: emailSvc as unknown as EmailVerificationService,
      phoneVerification: phoneSvc as unknown as PhoneVerificationService,
      readiness: async () => ({}),
    });
    await both.ready();
    const paths = Object.keys((both.swagger() as { paths: object }).paths).filter((p) => /phone|email/.test(p));
    expect(paths.filter((p) => p.includes('/phone'))).toHaveLength(3);
    expect(paths.filter((p) => p.includes('/email'))).toHaveLength(4);
    expect(both.hasDecorator('phoneVerification')).toBe(true);
    expect(both.hasDecorator('emailVerification')).toBe(true);
    await both.close();
  });

  it('without the account service nothing account-related is registered, even with a phone service', async () => {
    const noAccounts = await buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      phoneVerification: phoneSvc as unknown as PhoneVerificationService,
      readiness: async () => ({}),
    });
    await noAccounts.ready();
    const headers = await authorized();
    for (const r of ROUTES) {
      const res = await noAccounts.inject({ method: r.method, url: `/api/v1/account${r.url}`, headers, ...(r.body ? { payload: r.body as object } : {}) });
      expect(res.statusCode, r.url).toBe(404);
    }
    expect(noPhoneCalls()).toBe(true);
    await noAccounts.close();
  });

  const absent: [Method, string][] = [
    ['GET', '/phone/verification/confirm-code'],
    ['GET', '/phone/verification/send'],
    ['PUT', '/phone'],
    ['PATCH', '/phone'],
    ['DELETE', '/phone'],
    ['PUT', '/phone/verification/send'],
    ['DELETE', '/phone/verification/send'],
    ['DELETE', '/phone/verification/confirm-code'],
    ['GET', '/phone/verification'],
    ['POST', '/phone/verification'],
    ['POST', '/phone/verification/confirm'],
    ['POST', '/phone/verification/confirm-link'],
    ['POST', '/phone/verification/call'],
    ['POST', '/phone/resend'],
    ['POST', '/phone/verify'],
    ['POST', '/phone/primary'],
    ['POST', '/phone/change'],
    ['GET', '/phone/contacts'],
    ['GET', `/phone/${ACCOUNT_ID}`],
    ['POST', `/phone/${ACCOUNT_ID}`],
    ['POST', `/phone/${ACCOUNT_ID}/verification/send`],
    ['GET', `/${OTHER_ACCOUNT_ID}/phone`],
    ['POST', `/${OTHER_ACCOUNT_ID}/phone/verification/send`],
    ['POST', `/phone/verification/confirm-code/${CODE}`],
    ['POST', '/phone/verification/confirm-code/'],
    ['GET', '/phones'],
    ['POST', '/phones'],
    ['GET', '/phone-numbers'],
  ];
  it.each(absent)('%s /api/v1/account%s does not exist: 404 ROUTE_NOT_FOUND, anonymous and with a valid token', async (method, url) => {
    for (const t of [undefined, await webToken()]) {
      const res = await call(method, url, t, method === 'GET' || method === 'DELETE' ? undefined : { phone: FULL_NUMBER });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    }
    expect(noServiceCalls()).toBe(true);
  });

  it('has no phone route outside /api/v1/account', async () => {
    for (const url of [
      '/api/v1/phone',
      '/api/v1/phones',
      '/api/v1/verification/send',
      '/api/v1/geography/account/phone',
      '/account/phone',
      '/api/v1/users/me/phone',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: await authorized() });
      expect(res.statusCode, url).toBe(404);
    }
    expect(noServiceCalls()).toBe(true);
  });
});

// ====================================================================== GET /account/me
describe('GET /account/me carries the phone state and the derived contacts summary, masked', () => {
  const ACCOUNT_KEYS = ['accountId', 'activeRole', 'contacts', 'createdAt', 'email', 'phone', 'primaryRole', 'profile', 'roles', 'status'];

  it('carries `phone` and `contacts`, taken from the account context; the phone service is not consulted', async () => {
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(ACCOUNT_KEYS);
    expect(data.phone).toEqual(NONE_SUMMARY);
    expect(data.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    expect(noPhoneCalls()).toBe(true);
  });

  it.each([
    ['PENDING', PENDING_SUMMARY],
    ['VERIFIED', VERIFIED_SUMMARY],
    ['VERIFIED with a pending replacement', CHANGING_SUMMARY],
  ] as const)('reports the %s state with masked values only and never a full number', async (_label, summary) => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ phone: summary as unknown as AccountContext['phone'] }));
    const res = await call('GET', '/me', await webToken());
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(data.phone).toEqual(summary);
    for (const word of [FULL_NUMBER, '12025550142', '2025550142']) expect(res.body).not.toContain(word);
    expect(res.body).toMatch(/\+\*{7}\d{4}/);
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])('passes the derived contacts through exactly (email %s, phone %s, both %s)', async (emailVerified, phoneVerified, contactsVerified) => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ contacts: { emailVerified, phoneVerified, contactsVerified } }));
    const res = await call('GET', '/me', await webToken());
    expect((res.json() as { data: { contacts: unknown } }).data.contacts).toEqual({ emailVerified, phoneVerified, contactsVerified });
  });

  it('PENDING carries the purpose and the timing of the newest verification, and no code or hash', async () => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ phone: PENDING_SUMMARY as unknown as AccountContext['phone'] }));
    const res = await call('GET', '/me', await webToken());
    const phone = (res.json() as { data: { phone: typeof PENDING_SUMMARY } }).data.phone;
    expect(keysOf(phone.pending)).toEqual(['countryCode', 'expiresAt', 'lastSentAt', 'maskedPhone', 'purpose', 'status']);
    expect(raw(phone)).not.toMatch(/hash|token|"code"|challenge/i);
  });

  it('builds the phone and contacts blocks from the declared fields: an attribute a context carries beyond them is dropped', async () => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(
      makeContext({
        phone: { ...NONE_SUMMARY, rawPhone: FULL_NUMBER } as unknown as AccountContext['phone'],
        contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false, rawPhone: FULL_NUMBER } as unknown as AccountContext['contacts'],
      }),
    );
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FULL_NUMBER);
    expect(res.body).not.toContain('rawPhone');
  });

  it('PUT /account/profile and POST /account/active-role also carry phone and contacts', async () => {
    const t = await webToken();
    for (const res of [
      await call('PUT', '/profile', t, { firstName: 'Ana', lastName: 'Martin' }),
      await call('POST', '/active-role', t, { role: 'CUSTOMER' }),
    ]) {
      const data = (res.json() as { data: Record<string, unknown> }).data;
      expect(keysOf(data)).toEqual(ACCOUNT_KEYS);
    }
  });
});

// ====================================================================== OpenAPI
describe('phone OpenAPI contract', () => {
  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
    pattern?: string;
    maxLength?: number;
  };
  type Operation = {
    operationId?: string;
    summary?: string;
    security?: unknown[];
    tags?: string[];
    parameters?: { name: string; in: string }[];
    requestBody?: { required?: boolean; content: { 'application/json': { schema: Schema } } };
    responses: Record<string, unknown>;
  };
  const doc = () =>
    app.swagger() as unknown as { paths: Record<string, Record<string, Operation>>; components?: { securitySchemes?: Record<string, unknown> } };
  const operations = () =>
    Object.entries(doc().paths)
      .filter(([path]) => path.startsWith('/api/v1/account/phone'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));
  const byId = (id: string) => operations().find((o) => o.op.operationId === id)!;
  const IDS = ['getAccountPhone', 'setAccountPhone', 'sendAccountPhoneVerification', 'confirmAccountPhoneCode'];

  it('lists exactly the four phone operations under /api/v1/account/phone*', () => {
    expect(
      operations()
        .map((o) => `${o.op.operationId} ${o.method.toUpperCase()} ${o.path}`)
        .sort(),
    ).toEqual(
      [
        'confirmAccountPhoneCode POST /api/v1/account/phone/verification/confirm-code',
        'getAccountPhone GET /api/v1/account/phone',
        'sendAccountPhoneVerification POST /api/v1/account/phone/verification/send',
        'setAccountPhone POST /api/v1/account/phone',
      ].sort(),
    );
  });

  it('keeps the account path set to the three ID-001 paths plus the three phone paths, and nothing else', () => {
    expect(
      Object.keys(doc().paths)
        .filter((p) => /account/.test(p))
        .sort(),
    ).toEqual(
      [
        '/api/v1/account/active-role',
        '/api/v1/account/me',
        '/api/v1/account/phone',
        '/api/v1/account/phone/verification/confirm-code',
        '/api/v1/account/phone/verification/send',
        '/api/v1/account/profile',
      ].sort(),
    );
  });

  it('requires the bearer token on every phone operation and tags them account', () => {
    for (const { op } of operations()) {
      expect(op.security, op.operationId).toEqual([{ bearerAuth: [] }]);
      expect(op.tags, op.operationId).toEqual(['account']);
    }
    expect(doc().components?.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('has no path parameter and no query parameter: there is no way to name another account, contact or challenge', () => {
    for (const { path, op } of operations()) {
      expect(path, op.operationId).not.toMatch(/[{}:]/);
      expect(op.parameters ?? [], op.operationId).toEqual([]);
    }
  });

  it('documents no account id, contact id, challenge id, subject or role claim in any request body', () => {
    for (const { op } of operations()) {
      const request = raw(op.requestBody ?? null);
      for (const word of [
        'accountId',
        'account_id',
        'contactId',
        'phoneContactId',
        'challengeId',
        'subject',
        'issuer',
        'userId',
        'role',
        'clientIp',
        'deviceId',
      ]) {
        expect(request, `${op.operationId} ${word}`).not.toContain(word);
      }
    }
  });

  it.each(IDS)('%s documents 200, 400, 401, 403, 404, 409, 429 and 503', (id) => {
    expect(Object.keys(byId(id).op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '429', '503']);
  });

  it.each(IDS)('%s has a summary that mentions neither a provider nor a secret', (id) => {
    const summary = byId(id).op.summary ?? '';
    expect(summary.length).toBeGreaterThan(20);
    for (const word of ['twilio', 'vonage', 'password', 'api key']) expect(summary.toLowerCase()).not.toContain(word);
  });

  it('documents the request bodies as strict objects (additionalProperties false) with the same rules the API enforces', () => {
    const schemaOf = (id: string): Schema => byId(id).op.requestBody!.content['application/json'].schema;
    expect(byId('getAccountPhone').op.requestBody).toBeUndefined();
    for (const id of ['setAccountPhone', 'sendAccountPhoneVerification', 'confirmAccountPhoneCode']) {
      expect(schemaOf(id).type, id).toBe('object');
      expect(schemaOf(id).additionalProperties, id).toBe(false);
      expect(byId(id).op.requestBody!.required, id).toBe(true);
    }
    expect(Object.keys(schemaOf('sendAccountPhoneVerification').properties ?? {})).toEqual([]);
    expect(schemaOf('setAccountPhone')).toMatchObject({
      required: ['phone'],
      properties: { phone: { type: 'string', maxLength: 64 }, country: { type: 'string', pattern: '^[A-Z]{2}$' } },
    });
    expect(schemaOf('confirmAccountPhoneCode')).toMatchObject({ required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{4,10}$' } } });
  });

  it('documents the 200 responses with the masked summary only (no full-number field, no code, no hash)', () => {
    for (const { op } of operations()) {
      const ok = raw(op.responses['200']);
      expect(ok, op.operationId).toContain('maskedPhone');
      for (const word of ['"e164"', '"number"', '"phoneNumber"', 'codeHash', 'verification_code', '"lineType"'])
        expect(ok, `${op.operationId} ${word}`).not.toContain(word);
    }
  });

  it('documents the phone operations as the only new operations in the account family', () => {
    const ids = Object.values(doc().paths)
      .flatMap((m) => Object.values(m))
      .map((o) => o.operationId)
      .filter((id): id is string => !!id && /Account/.test(id))
      .sort();
    expect(ids).toEqual([...IDS, 'getAccountMe', 'setAccountActiveRole', 'updateAccountProfile'].sort());
  });
});

// ====================================================================== secrecy of the logs
describe('phone API keeps codes and numbers out of the logs', () => {
  it('writes no code or number to any log line, for successes, validation failures and mapped errors', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    const typedNumber = '+14165550188';
    const typedCode = '908172';
    const token = await webToken();
    await call('POST', '/phone', token, { phone: typedNumber });
    await call('POST', '/phone', token, { phone: 4165550188 }); // 400
    await call('POST', '/phone/verification/send', token, {});
    await call('POST', '/phone/verification/confirm-code', token, { code: typedCode });
    await call('POST', '/phone/verification/confirm-code', token, { code: Number(typedCode) }); // 400
    phoneSvc.confirmCode.mockRejectedValueOnce(new AccountError('PHONE_CODE_INVALID', 'the code is not correct', { attemptsRemaining: 2 }));
    await call('POST', '/phone/verification/confirm-code', token, { code: typedCode });
    phoneSvc.setPhone.mockRejectedValueOnce(new AccountError('PHONE_NOT_ACCEPTED', 'the phone number cannot be used', {}));
    await call('POST', '/phone', token, { phone: typedNumber });
    await call('GET', '/phone', token);
    await call('POST', '/phone/verification/confirm-code', 'invalid.token.value', { code: typedCode });
    expect(lines.some((l) => l.includes('request completed'))).toBe(true);
    const logged = lines.join('\n');
    for (const value of [typedNumber, '4165550188', typedCode, token, SUB, FULL_NUMBER, 'Bearer '])
      expect(logged, `a log line contains ${value.slice(0, 12)}`).not.toContain(value);
  });

  it('logs no number or code when the service fails unexpectedly', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    phoneSvc.confirmCode.mockRejectedValueOnce(new Error('boom'));
    await call('POST', '/phone/verification/confirm-code', await webToken(), { code: '908172' });
    expect(lines.join('\n')).not.toContain('908172');
  });
});
