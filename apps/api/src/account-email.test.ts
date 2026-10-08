// Unit tests of the HTTP layer of the email contact and verification API (ID-002, docs/engineering/EMAIL_VERIFICATION.md) with a FAKE
// EmailVerificationService (the rules of the real service are covered by packages/accounts and by account-email.itest.ts): authentication and the identity
// context (401 before 400, 403 for the admin context), strict RAW bodies (DEBT-0043: a number is never coerced to a string), the account always coming
// from the verified token, the client address handed to the abuse limits, the error mapping of the twelve email codes, privacy (no full address, no
// code, no token, no internals in any response or log line), caching, registration and the generated OpenAPI contract.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  AccountEmailResponse,
  CORRELATION_HEADER,
  EMAIL_ERROR_CODES,
  EmailVerificationSentResponse,
  EmailVerifiedResponse,
  ErrorResponse,
  SetEmailResponse,
  type EmailErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService, type EmailVerificationService } from '@bananagig/accounts';
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
const emailSvc = {
  getEmailDetail: vi.fn(),
  setEmail: vi.fn(),
  sendVerification: vi.fn(),
  confirmCode: vi.fn(),
  confirmLink: vi.fn(),
  getEmailSummary: vi.fn(),
};
const noEmailCalls = () => Object.values(emailSvc).every((f) => f.mock.calls.length === 0);
const noServiceCalls = () => noEmailCalls() && Object.values(accountSvc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-other-subject-marker-93d0';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const ACCOUNT_OF: Record<string, string> = { [SUB]: ACCOUNT_ID, [OTHER_SUB]: OTHER_ACCOUNT_ID };
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };

/** The address the fakes "hold". It must never appear in a response: only its masked form does. */
const FULL_ADDRESS = 'customer.dev@bananagig.localhost';
const MASKED = 'c***@b***.localhost';
/** A valid code and a valid magic-link token (43 base64url characters, built so no credential-looking literal sits in this file). */
const CODE = '123456';
const LINK_MARKER = 'aB3_-'.repeat(8) + 'xyz';
const LF = String.fromCharCode(10);

const NONE_SUMMARY = { emailVerificationStatus: 'NONE', primary: null, pending: null } as const;
const PENDING_SUMMARY = {
  emailVerificationStatus: 'PENDING',
  primary: null,
  pending: { maskedEmail: MASKED, purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: '2026-01-01T00:05:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z' },
} as const;
const VERIFIED_SUMMARY = {
  emailVerificationStatus: 'VERIFIED',
  primary: { maskedEmail: MASKED, verifiedAt: '2026-01-01T00:06:00.000Z', source: 'USER_ENTERED' },
  pending: null,
} as const;
const CHANGING_SUMMARY = {
  emailVerificationStatus: 'VERIFIED',
  primary: VERIFIED_SUMMARY.primary,
  pending: { maskedEmail: 'n***@e***.test', purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING', lastSentAt: null, expiresAt: null },
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
  email: NONE_SUMMARY,
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
  fn: keyof typeof emailSvc;
  /** The exact arguments the service must receive for the sample request, given the client address. */
  args: (clientIp?: string) => unknown[];
}
const ROUTES: Route[] = [
  { id: 'getAccountEmail', method: 'GET', url: '/email', fn: 'getEmailDetail', args: () => [ACCOUNT_ID] },
  {
    id: 'setAccountEmail',
    method: 'POST',
    url: '/email',
    body: { email: 'ana@example.test' },
    fn: 'setEmail',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, 'ana@example.test', { clientIp: ip }],
  },
  {
    id: 'sendAccountEmailVerification',
    method: 'POST',
    url: '/email/verification/send',
    body: {},
    fn: 'sendVerification',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, { clientIp: ip }],
  },
  {
    id: 'confirmAccountEmailCode',
    method: 'POST',
    url: '/email/verification/confirm-code',
    body: { code: CODE },
    fn: 'confirmCode',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, CODE, { clientIp: ip }],
  },
  {
    id: 'confirmAccountEmailLink',
    method: 'POST',
    url: '/email/verification/confirm-link',
    body: { token: LINK_MARKER },
    fn: 'confirmLink',
    args: (ip = '127.0.0.1') => [ACCOUNT_ID, LINK_MARKER, { clientIp: ip }],
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
    emailVerification: emailSvc as unknown as EmailVerificationService,
    readiness: async () => ({}),
  });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of [...Object.values(accountSvc), ...Object.values(emailSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }) =>
    makeContext({ accountId: ACCOUNT_OF[identity.subject] ?? ACCOUNT_ID }),
  );
  accountSvc.getAccountContext.mockImplementation(async (accountId: string) => makeContext({ accountId }));
  accountSvc.selectActiveRole.mockImplementation(async (accountId: string, role: string) => makeContext({ accountId, activeRole: role }));
  accountSvc.upsertProfile.mockImplementation(async (_id: string, input: object) => ({ changed: true, profile: input }));
  emailSvc.getEmailDetail.mockImplementation(async () => ({
    ...PENDING_SUMMARY,
    resendAvailableAt: RESEND_AT,
    attemptsRemaining: 5,
    codeLength: 6,
    validityMinutes: 10,
  }));
  emailSvc.setEmail.mockImplementation(async () => ({ changed: true, email: PENDING_SUMMARY }));
  emailSvc.sendVerification.mockImplementation(async () => ({
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    resendAvailableAt: RESEND_AT,
    codeLength: 6,
    validityMinutes: 10,
    email: PENDING_SUMMARY,
  }));
  emailSvc.confirmCode.mockImplementation(async () => ({ changed: true, email: VERIFIED_SUMMARY }));
  emailSvc.confirmLink.mockImplementation(async () => ({ changed: true, email: VERIFIED_SUMMARY }));
});

// ====================================================================== authentication and identity context
describe('email API authentication', () => {
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

  it.each(ROUTES)('$method $url refuses the admin identity context with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED and never calls the email service', async (r) => {
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
    for (const body of [{ code: 123456, token: 1, email: 2, extra: true }, { unknown: 'x'.repeat(10) }, [], 'text', 7, null]) {
      const none = await sendJson(r.url, undefined, body);
      expect(none.statusCode, raw(body)).toBe(401);
      expect(errorOf(none).code).toBe('AUTHENTICATION_REQUIRED');
      const bad = await sendJson(r.url, 'bad.token', body);
      expect(bad.statusCode, raw(body)).toBe(401);
      expect(errorOf(bad).code).toBe('INVALID_TOKEN');
    }
    expect(noServiceCalls()).toBe(true);
  });

  it('answers 401 before 400 on GET /email too: garbage query parameters without a token are 401', async () => {
    for (const qs of ['?accountId=x', '?a=b&c=d', '?x']) expect((await call('GET', `/email${qs}`)).statusCode, qs).toBe(401);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(POST_ROUTES)('$method $url answers 403 (not 400) for the admin context, even with an invalid body', async (r) => {
    expect((await sendJson(r.url, await adminToken(), { code: 1, token: 2, email: 3, extra: 4 })).statusCode).toBe(403);
    expect((await sendJson(r.url, await adminToken(), [])).statusCode).toBe(403);
    expect(noServiceCalls()).toBe(true);
  });

  it.each(POST_ROUTES)(
    '$method $url: a malformed JSON body is rejected by the parser (400 BAD_REQUEST) before the token is looked at, and nothing is called',
    async (r) => {
      // Fastify parses the body before any preValidation hook runs; the ID-001 routes behave the same. The envelope is still the standard one.
      for (const text of ['{"code": ', '{code: 1}', '']) {
        const res = await rawJson(r.url, undefined, text);
        expect(res.statusCode, text).toBe(400);
        expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
      }
      expect(noServiceCalls()).toBe(true);
    },
  );

  it.each(ROUTES)('$method $url passes a guard refusal (suspended or closed account) through as 403 and never calls the email service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}`, details: { status: code } });
    }
    expect(noEmailCalls()).toBe(true);
  });

  it('runs the account guard exactly once per request on every route', async () => {
    for (const r of ROUTES) await routeCall(r, await webToken());
    expect(accountSvc.ensureAccountForIdentity).toHaveBeenCalledTimes(ROUTES.length);
  });
});

// ====================================================================== the account comes from the token, the client address from the request
describe('email API: the account and the client address', () => {
  it.each(ROUTES)('$method $url resolves the account from the verified token and hands exactly that account to the service', async (r) => {
    const res = await routeCall(r, await webToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.ensureAccountForIdentity).toHaveBeenCalledTimes(1);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
    expect(emailSvc[r.fn]).toHaveBeenCalledTimes(1);
    expect(emailSvc[r.fn].mock.calls[0]).toEqual(r.args());
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
    expect(emailSvc[r.fn].mock.calls[0]).toEqual(r.args());
    for (const c of emailSvc[r.fn].mock.calls) expect(raw(c)).not.toContain(OTHER_ACCOUNT_ID);
    expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
  });

  it.each(POST_ROUTES)('$method $url rejects an account id in the body (strict) and never calls the service', async (r) => {
    const body = { ...(r.body as object), accountId: OTHER_ACCOUNT_ID };
    const res = await call(r.method, r.url, await webToken(), body);
    expectValidation(res, body);
    expect(noEmailCalls()).toBe(true);
  });

  it('gives each token its own account', async () => {
    await call('GET', '/email', await webToken());
    await call('GET', '/email', await webToken({ sub: OTHER_SUB }));
    expect(emailSvc.getEmailDetail.mock.calls).toEqual([[ACCOUNT_ID], [OTHER_ACCOUNT_ID]]);
    expect(accountSvc.ensureAccountForIdentity.mock.calls.map((c) => c[0].subject)).toEqual([SUB, OTHER_SUB]);
  });

  it.each(POST_ROUTES)('$method $url hands the request address to the abuse limits (x-forwarded-for, trustProxy)', async (r) => {
    const res = await routeCall(r, await webToken(), { 'x-forwarded-for': '203.0.113.9' });
    expect(res.statusCode, res.body).toBe(200);
    expect(emailSvc[r.fn].mock.calls[0]).toEqual(r.args('203.0.113.9'));
    const ctx = emailSvc[r.fn].mock.calls[0]!.at(-1) as Record<string, unknown>;
    expect(keysOf(ctx)).toEqual(['clientIp']);
  });

  it('uses the connection address when there is no forwarding header, and the client end of a forwarding chain', async () => {
    await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE });
    expect(emailSvc.confirmCode.mock.calls[0]![2]).toEqual({ clientIp: '127.0.0.1' });
    await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    expect(emailSvc.confirmCode.mock.calls[1]![2]).toEqual({ clientIp: '203.0.113.9' });
  });

  it('never takes the client address from the body or a query parameter', async () => {
    await call(
      'POST',
      `/email/verification/confirm-code?clientIp=198.51.100.1&ip=198.51.100.2`,
      await webToken(),
      { code: CODE },
      { 'x-real-ip': '198.51.100.3' },
    );
    expect(emailSvc.confirmCode.mock.calls[0]![2]).toEqual({ clientIp: '127.0.0.1' });
    const rejected = await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE, clientIp: '198.51.100.4' });
    expect(rejected.statusCode).toBe(400);
  });

  it('reads the detail with the account id only (no address context, no device id)', async () => {
    await call('GET', '/email', await webToken(), undefined, { 'x-forwarded-for': '203.0.113.9' });
    expect(emailSvc.getEmailDetail.mock.calls[0]).toEqual([ACCOUNT_ID]);
  });

  it('hands the x-active-role header to the account guard like every account route', async () => {
    await call('GET', '/email', await webToken(), undefined, { 'x-active-role': 'PROVIDER' });
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ requestedRole: 'PROVIDER' });
  });

  it('never gives a service the token, the subject, the issuer or the realm roles on an email call', async () => {
    const token = await webToken();
    for (const r of ROUTES) await routeCall(r, token);
    for (const f of Object.values(emailSvc))
      for (const c of f.mock.calls) for (const secret of [token, SUB, TEST_ISSUER, REALM_ROLE_MARKER]) expect(raw(c)).not.toContain(secret);
  });
});

// ====================================================================== strict raw bodies (DEBT-0043)
describe('POST /account/email: strict body', () => {
  const invalidBodies: [string, unknown][] = [
    ['a numeric email', { email: 123456 }],
    ['a boolean email', { email: true }],
    ['a null email', { email: null }],
    ['an array email', { email: ['typed-marker@example.test'] }],
    ['an object email', { email: { address: 'typed-marker@example.test' } }],
    ['a missing email', {}],
    ['an extra property', { email: 'typed-marker@example.test', extra: 1 }],
    ['an account id', { email: 'typed-marker@example.test', accountId: OTHER_ACCOUNT_ID }],
    ['a primary flag', { email: 'typed-marker@example.test', primary: true }],
    ['a verified flag', { email: 'typed-marker@example.test', verified: true }],
    ['a purpose', { email: 'typed-marker@example.test', purpose: 'CHANGE_EMAIL' }],
    ['an email above 1024 characters', { email: `${'a'.repeat(1020)}@b.co` }],
    ['a top-level array', [{ email: 'typed-marker@example.test' }]],
    ['an empty array', []],
    ['a string body', 'typed-marker@example.test'],
    ['a number body', 7],
    ['a boolean body', true],
    ['a null body', null],
  ];
  it.each(invalidBodies)('rejects %s with 400 VALIDATION_FAILED, never echoes the value and never calls the service', async (_label, body) => {
    const res = await sendJson('/email', await webToken(), body);
    expectValidation(res, body);
    expect(noEmailCalls()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
  });

  it('does NOT coerce a number to a string: {"email":123456} is a 400, the service is not called', async () => {
    const res = await rawJson('/email', await webToken(), '{"email":123456}');
    expectValidation(res);
    expect(emailSvc.setEmail).not.toHaveBeenCalled();
  });

  it('hands the typed address to the service VERBATIM (canonicalization and the INVALID_* issues belong to the service)', async () => {
    const typed = '  Ana.B+Tag@Example.TEST ';
    expect((await call('POST', '/email', await webToken(), { email: typed })).statusCode).toBe(200);
    expect(emailSvc.setEmail.mock.calls[0]![1]).toBe(typed);
    const odd = `a${String.fromCharCode(7)}b@example.test`;
    expect((await call('POST', '/email', await webToken(), { email: odd })).statusCode).toBe(200);
    expect(emailSvc.setEmail.mock.calls[1]![1]).toBe(odd);
  });

  it('accepts an email of exactly 1024 characters at the API boundary and passes it to the service unchanged', async () => {
    const edge = `${'a'.repeat(1019)}@b.co`;
    expect(edge).toHaveLength(1024);
    const res = await call('POST', '/email', await webToken(), { email: edge });
    expect(res.statusCode).toBe(200);
    expect(emailSvc.setEmail.mock.calls[0]![1]).toBe(edge);
  });

  it('rejects an empty-string email only in the service (the API contract has no minimum), which answers EMAIL_INVALID', async () => {
    emailSvc.setEmail.mockRejectedValueOnce(
      new AccountError('EMAIL_INVALID', 'the email address is not valid', { reason: 'REQUIRED', messageKey: 'account.email.error.required' }),
    );
    const res = await call('POST', '/email', await webToken(), { email: '' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ code: 'ACCOUNT_EMAIL_INVALID', details: { reason: 'REQUIRED', messageKey: 'account.email.error.required' } });
    expect(emailSvc.setEmail.mock.calls[0]![1]).toBe('');
  });
});

describe('POST /account/email/verification/send: strict body', () => {
  const url = '/email/verification/send';
  it('accepts exactly {} (the body the web app sends)', async () => {
    const res = await call('POST', url, await webToken(), {});
    expect(res.statusCode).toBe(200);
    expect(emailSvc.sendVerification).toHaveBeenCalledTimes(1);
  });
  const invalidBodies: [string, unknown][] = [
    ['an extra property', { extra: 1 }],
    ['an email', { email: 'typed-marker@example.test' }],
    ['an account id', { accountId: OTHER_ACCOUNT_ID }],
    ['a code', { code: CODE }],
    ['a force flag', { force: true }],
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
    expect(noEmailCalls()).toBe(true);
  });
  it('rejects a request with NO body at all: 400 VALIDATION_FAILED (the contract is an object, `{}`), and nothing is sent', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/account${url}`, headers: { authorization: `Bearer ${await webToken()}` } });
    expectValidation(res);
    expect(emailSvc.sendVerification).not.toHaveBeenCalled();
  });
  it('rejects a JSON content type with an EMPTY body in the parser: 400 BAD_REQUEST, and nothing is sent', async () => {
    const res = await rawJson(url, await webToken(), '');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
    expect(emailSvc.sendVerification).not.toHaveBeenCalled();
  });
});

describe('POST /account/email/verification/confirm-code: strict body', () => {
  const url = '/email/verification/confirm-code';
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
    expect(noEmailCalls()).toBe(true);
  });
  it('does NOT coerce a number to a string: {"code":123456} is a 400 and the service is not called', async () => {
    const res = await rawJson(url, await webToken(), '{"code":123456}');
    expectValidation(res);
    expect(emailSvc.confirmCode).not.toHaveBeenCalled();
  });
  it.each(['1234', '000000', '0123456789', '999999'])(
    'accepts the well-formed code %s and passes it to the service as the exact string (length is a configuration check)',
    async (code) => {
      const res = await call('POST', url, await webToken(), { code });
      expect(res.statusCode).toBe(200);
      expect(emailSvc.confirmCode.mock.calls[0]![1]).toBe(code);
    },
  );
});

describe('POST /account/email/verification/confirm-link: strict body', () => {
  const url = '/email/verification/confirm-link';
  const tokenOf = (len: number, filler = 'a') => filler.repeat(len);
  const invalidBodies: [string, unknown][] = [
    ['a token of 42 characters', { token: tokenOf(42) }],
    ['a token of 44 characters', { token: tokenOf(44) }],
    ['a padded base64 token (=)', { token: `${tokenOf(42)}=` }],
    ['a token with a plus sign', { token: `${tokenOf(42)}+` }],
    ['a token with a slash', { token: `${tokenOf(42)}/` }],
    ['a token with a dot', { token: `${tokenOf(42)}.` }],
    ['a token with a space', { token: `${tokenOf(42)} ` }],
    ['a token with a leading space', { token: ` ${tokenOf(42)}` }],
    ['a token with a trailing newline', { token: `${tokenOf(42)}${LF}` }],
    ['a token with a percent sign', { token: `${tokenOf(42)}%` }],
    ['a token with a non-ASCII letter', { token: `${tokenOf(42)}${String.fromCodePoint(0xe9)}` }],
    ['an empty token', { token: '' }],
    ['a null token', { token: null }],
    ['a boolean token', { token: true }],
    ['an array token', { token: [tokenOf(43)] }],
    ['an object token', { token: { value: tokenOf(43) } }],
    ['a missing token', {}],
    ['an extra property', { token: tokenOf(43), extra: 1 }],
    ['an account id', { token: tokenOf(43), accountId: OTHER_ACCOUNT_ID }],
    ['a code next to the token', { token: tokenOf(43), code: CODE }],
    ['a top-level array', [tokenOf(43)]],
    ['a string body', tokenOf(43)],
    ['a null body', null],
  ];
  it.each(invalidBodies)('rejects %s with 400 VALIDATION_FAILED and never calls the service', async (_label, body) => {
    const res = await sendJson(url, await webToken(), body);
    expectValidation(res, body);
    expect(noEmailCalls()).toBe(true);
  });
  it('does NOT coerce a 43-digit JSON number to a token string', async () => {
    const res = await rawJson(url, await webToken(), `{"token":${'1'.repeat(43)}}`);
    expectValidation(res);
    expect(emailSvc.confirmLink).not.toHaveBeenCalled();
  });
  it('accepts a token of exactly 43 base64url characters, including - and _, and passes it to the service verbatim', async () => {
    expect(LINK_MARKER).toHaveLength(43);
    const res = await call('POST', url, await webToken(), { token: LINK_MARKER });
    expect(res.statusCode).toBe(200);
    expect(emailSvc.confirmLink.mock.calls[0]![1]).toBe(LINK_MARKER);
    const digits = '7'.repeat(43);
    expect((await call('POST', url, await webToken(), { token: digits })).statusCode).toBe(200);
    expect(emailSvc.confirmLink.mock.calls[1]![1]).toBe(digits);
  });
});

describe('email API: content types and query strings', () => {
  it.each(POST_ROUTES)(
    '$method $url: a plain text body is a 400 (not an object), a form, XML or vendor JSON body a 415, all in the standard envelope',
    async (r) => {
      const authorization = `Bearer ${await webToken()}`;
      const text = JSON.stringify(r.body);
      const attempts: [string, string, number][] = [
        ['text/plain', text, 400],
        ['application/x-www-form-urlencoded', 'code=123456&email=a%40example.test', 415],
        ['application/xml', '<code>123456</code>', 415],
        ['application/vnd.api+json', text, 415],
      ];
      for (const [contentType, payload, status] of attempts) {
        const res = await app.inject({ method: 'POST', url: `/api/v1/account${r.url}`, headers: { authorization, 'content-type': contentType }, payload });
        expect(res.statusCode, contentType).toBe(status);
        expect(errorOf(res).category, contentType).toBe('VALIDATION');
      }
      expect(noEmailCalls()).toBe(true);
    },
  );

  it('ignores a JSON body sent with GET /email (a body selects nothing) and unknown query parameters', async () => {
    const res = await call('GET', '/email?accountId=x&foo=1', await webToken(), { accountId: OTHER_ACCOUNT_ID }, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(emailSvc.getEmailDetail.mock.calls).toEqual([[ACCOUNT_ID]]);
  });
});

// ====================================================================== responses
describe('email API responses', () => {
  it.each(ROUTES)('$method $url answers {data, meta:{correlationId}} and nothing else, JSON, echoing the request correlation id', async (r) => {
    const res = await routeCall(r, await webToken(), { [CORRELATION_HEADER]: 'corr-id-002' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: object; meta: { correlationId: string } };
    expect(keysOf(body)).toEqual(['data', 'meta']);
    expect(body.meta).toEqual({ correlationId: 'corr-id-002' });
    expect(res.headers[CORRELATION_HEADER]).toBe('corr-id-002');
    expect(String(res.headers['content-type'])).toContain('application/json');
    const schema =
      { getAccountEmail: AccountEmailResponse, setAccountEmail: SetEmailResponse, sendAccountEmailVerification: EmailVerificationSentResponse }[r.id] ??
      EmailVerifiedResponse;
    expect(schema.safeParse(body).success, res.body).toBe(true);
  });

  it('GET /email serializes every date as an ISO string, null stays null, and exposes the detail fields exactly', async () => {
    const res = await call('GET', '/email', await webToken());
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(['attemptsRemaining', 'codeLength', 'emailVerificationStatus', 'pending', 'primary', 'resendAvailableAt', 'validityMinutes']);
    expect(data).toMatchObject({
      resendAvailableAt: '2026-01-01T00:05:30.000Z',
      attemptsRemaining: 5,
      codeLength: 6,
      validityMinutes: 10,
      emailVerificationStatus: 'PENDING',
    });
    expect(new Date(data.resendAvailableAt as string).toISOString()).toBe(data.resendAvailableAt);
    emailSvc.getEmailDetail.mockResolvedValueOnce({ ...NONE_SUMMARY, resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 10 });
    const empty = ((await call('GET', '/email', await webToken())).json() as { data: Record<string, unknown> }).data;
    expect(empty).toMatchObject({ resendAvailableAt: null, attemptsRemaining: null, pending: null, primary: null, emailVerificationStatus: 'NONE' });
  });

  it('GET /email never contains a full address: only the masked form', async () => {
    const res = await call('GET', '/email', await webToken());
    expect(res.body).toContain(MASKED);
    for (const word of [FULL_ADDRESS, 'customer.dev', 'bananagig.localhost']) expect(res.body).not.toContain(word);
  });

  it('builds the responses from the declared fields: internal attributes a service result carries never reach the client', async () => {
    const leak = { fullAddress: FULL_ADDRESS, codeHash: 'a'.repeat(64), token: LINK_MARKER, challengeId: OTHER_ACCOUNT_ID };
    emailSvc.getEmailDetail.mockResolvedValueOnce({
      ...PENDING_SUMMARY,
      resendAvailableAt: null,
      attemptsRemaining: 5,
      codeLength: 6,
      validityMinutes: 10,
      ...leak,
    });
    emailSvc.setEmail.mockResolvedValueOnce({ changed: true, email: PENDING_SUMMARY, ...leak });
    emailSvc.confirmCode.mockResolvedValueOnce({ changed: true, email: VERIFIED_SUMMARY, ...leak });
    emailSvc.confirmLink.mockResolvedValueOnce({ changed: true, email: VERIFIED_SUMMARY, ...leak });
    emailSvc.sendVerification.mockResolvedValueOnce({
      sentAt: SENT_AT,
      expiresAt: EXPIRES_AT,
      resendAvailableAt: RESEND_AT,
      codeLength: 6,
      validityMinutes: 10,
      email: PENDING_SUMMARY,
      ...leak,
    });
    const token = await webToken();
    for (const r of ROUTES) {
      const res = await routeCall(r, token);
      expect(res.statusCode, r.id).toBe(200);
      for (const value of [FULL_ADDRESS, 'a'.repeat(64), LINK_MARKER, 'fullAddress', 'codeHash', 'challengeId'])
        expect(res.body, `${r.id} leaks ${value}`).not.toContain(value);
    }
  });

  it('never lets an unexpected attribute inside the email summary through (the response fails closed instead of leaking it)', async () => {
    emailSvc.setEmail.mockResolvedValueOnce({
      changed: true,
      email: { ...PENDING_SUMMARY, pending: { ...PENDING_SUMMARY.pending, address: FULL_ADDRESS } },
    });
    const res = await call('POST', '/email', await webToken(), { email: 'ana@example.test' });
    expect(res.body).not.toContain(FULL_ADDRESS);
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 500) expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  it('POST /email/verification/send serializes sentAt, expiresAt and resendAvailableAt as ISO strings with the code policy', async () => {
    const res = await call('POST', '/email/verification/send', await webToken(), {});
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(['codeLength', 'email', 'expiresAt', 'resendAvailableAt', 'sentAt', 'validityMinutes']);
    expect(data).toMatchObject({
      sentAt: '2026-01-01T00:05:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      resendAvailableAt: '2026-01-01T00:05:30.000Z',
      codeLength: 6,
      validityMinutes: 10,
    });
    // the answer never carries the code or the link: they exist only in the email
    expect(res.body).not.toMatch(/verification_code|verification_url|magic|"code"|"token"/);
  });

  it('POST /email and the confirm routes answer {changed, email} and the confirm routes expose the VERIFIED summary, masked', async () => {
    const set = (await call('POST', '/email', await webToken(), { email: 'ana@example.test' })).json() as { data: Record<string, unknown> };
    expect(keysOf(set.data)).toEqual(['changed', 'email']);
    expect(set.data.changed).toBe(true);
    for (const r of POST_ROUTES.filter((x) => x.fn === 'confirmCode' || x.fn === 'confirmLink')) {
      const res = await routeCall(r, await webToken());
      const data = (res.json() as { data: { changed: boolean; email: typeof VERIFIED_SUMMARY } }).data;
      expect(keysOf(data)).toEqual(['changed', 'email']);
      expect(data.email).toEqual(VERIFIED_SUMMARY);
      expect(res.body).not.toContain(FULL_ADDRESS);
    }
  });

  it('passes changed:false (an idempotent repeat) through unchanged', async () => {
    emailSvc.confirmCode.mockResolvedValueOnce({ changed: false, email: VERIFIED_SUMMARY });
    emailSvc.confirmLink.mockResolvedValueOnce({ changed: false, email: VERIFIED_SUMMARY });
    emailSvc.setEmail.mockResolvedValueOnce({ changed: false, email: CHANGING_SUMMARY });
    expect(
      ((await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE })).json() as { data: { changed: boolean } }).data.changed,
    ).toBe(false);
    expect(
      ((await call('POST', '/email/verification/confirm-link', await webToken(), { token: LINK_MARKER })).json() as { data: { changed: boolean } }).data
        .changed,
    ).toBe(false);
    expect(((await call('POST', '/email', await webToken(), { email: 'n@e.test' })).json() as { data: { changed: boolean } }).data.changed).toBe(false);
  });
});

describe('email API responses are never cached', () => {
  it.each(ROUTES)('$method $url sends Cache-Control: no-store on successes and on every kind of error', async (r) => {
    const t = await webToken();
    const results: Reply[] = [await routeCall(r, t), await routeCall(r), await routeCall(r, await adminToken([]))];
    if (r.method === 'POST') results.push(await sendJson(r.url, t, { bogus: true }));
    for (const [code, status] of [
      ['EMAIL_RESEND_TOO_SOON', 429],
      ['EMAIL_UNAVAILABLE', 409],
      ['EMAIL_DELIVERY_FAILED', 503],
      ['EMAIL_CODE_INVALID', 400],
    ] as const) {
      emailSvc[r.fn].mockRejectedValueOnce(new AccountError(code, 'x', {}));
      const res = await routeCall(r, t);
      expect(res.statusCode).toBe(status);
      results.push(res);
    }
    emailSvc[r.fn].mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    results.push(await routeCall(r, t)); // 500
    expect(new Set(results.map((x) => x.statusCode)).size).toBeGreaterThanOrEqual(5);
    for (const res of results) expect(res.headers['cache-control'], String(res.statusCode)).toBe('no-store');
  });
});

// ====================================================================== error mapping
describe('email API error mapping', () => {
  const MESSAGE_KEY: Record<EmailErrorCode, string> = {
    EMAIL_INVALID: 'account.email.error.invalid_format', // carried by the service (an issue code), passed through
    EMAIL_NOT_PENDING: 'account.email.error.not_pending',
    EMAIL_CODE_INVALID: 'account.email.error.code_invalid',
    EMAIL_LINK_INVALID: 'account.email.error.link_invalid',
    EMAIL_CODE_EXPIRED: 'account.email.error.code_expired',
    EMAIL_CODE_USED: 'account.email.error.code_used',
    EMAIL_VERIFICATION_LOCKED: 'account.email.error.verification_locked',
    EMAIL_RESEND_TOO_SOON: 'account.email.error.resend_too_soon',
    EMAIL_SEND_LIMIT: 'account.email.error.send_limit',
    EMAIL_UNAVAILABLE: 'account.email.error.unavailable',
    EMAIL_DELIVERY_FAILED: 'account.email.error.delivery_failed',
    EMAIL_RATE_LIMITED: 'account.email.error.rate_limited',
  };
  const EXPECTED: Record<EmailErrorCode, [number, string]> = {
    EMAIL_INVALID: [400, 'VALIDATION'],
    EMAIL_NOT_PENDING: [409, 'CONFLICT'],
    EMAIL_CODE_INVALID: [400, 'VALIDATION'],
    EMAIL_LINK_INVALID: [400, 'VALIDATION'],
    EMAIL_CODE_EXPIRED: [400, 'VALIDATION'],
    EMAIL_CODE_USED: [400, 'VALIDATION'],
    EMAIL_VERIFICATION_LOCKED: [429, 'RATE_LIMIT'],
    EMAIL_RESEND_TOO_SOON: [429, 'RATE_LIMIT'],
    EMAIL_SEND_LIMIT: [429, 'RATE_LIMIT'],
    EMAIL_UNAVAILABLE: [409, 'CONFLICT'],
    EMAIL_DELIVERY_FAILED: [503, 'DEPENDENCY'],
    EMAIL_RATE_LIMITED: [429, 'RATE_LIMIT'],
  };
  const RATE_LIMITED = ['EMAIL_VERIFICATION_LOCKED', 'EMAIL_RESEND_TOO_SOON', 'EMAIL_SEND_LIMIT', 'EMAIL_RATE_LIMITED'] as const;
  const MAPPED_WITH_KEY = EMAIL_ERROR_CODES.filter((c) => c !== 'EMAIL_INVALID' && c !== 'EMAIL_DELIVERY_FAILED');

  /** What a hostile or sloppy service could attach: the API must drop the cause and the constraint name whatever else it passes. */
  const failure = (code: EmailErrorCode, extra: Record<string, unknown> = {}) =>
    new AccountError(code, `${code} happened`, {
      reason: 'SOME_REASON',
      constraint: 'uq_email_contacts__verified_address',
      cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM identity.email_contacts password=hunter2',
      ...(code === 'EMAIL_INVALID' ? { messageKey: MESSAGE_KEY.EMAIL_INVALID } : {}),
      ...extra,
    });
  const LEAKS = [
    'ECONNREFUSED',
    'SELECT',
    'hunter2',
    'cause',
    'constraint',
    'uq_email_contacts',
    'identity.email_contacts',
    '10.0.0.5',
    SUB,
    TEST_ISSUER,
    REALM_ROLE_MARKER,
  ];

  it('covers every email error code', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...EMAIL_ERROR_CODES].sort());
    expect(Object.keys(MESSAGE_KEY).sort()).toEqual([...EMAIL_ERROR_CODES].sort());
  });

  it.each(EMAIL_ERROR_CODES)(
    'maps %s to the standard error model on all five routes: status, category, ACCOUNT_ code, message key, no internals',
    async (code) => {
      const [status, category] = EXPECTED[code];
      const token = await webToken();
      for (const r of ROUTES) {
        emailSvc[r.fn].mockRejectedValueOnce(failure(code));
        const res = await routeCall(r, token);
        const where = `${r.method} ${r.url}`;
        expect(res.statusCode, where).toBe(status);
        expect(errorOf(res), where).toMatchObject({ category, code: `ACCOUNT_${code}` });
        expect(errorOf(res).correlationId, where).toBe(res.headers[CORRELATION_HEADER]);
        for (const leak of LEAKS) expect(res.body, `${where} leaks ${leak}`).not.toContain(leak);
        if (code === 'EMAIL_DELIVERY_FAILED') {
          expect(errorOf(res).message, where).toBe('The verification email could not be sent');
          expect(errorOf(res).details, where).toEqual({ retryable: false, messageKey: MESSAGE_KEY[code] });
        } else {
          expect(errorOf(res).message, where).toBe(`${code} happened`);
          expect(errorOf(res).details, where).toEqual({ reason: 'SOME_REASON', messageKey: MESSAGE_KEY[code] });
        }
      }
    },
  );

  it.each(MAPPED_WITH_KEY)("%s: the message key is the API's own, whatever the service put in its details", async (code) => {
    emailSvc.confirmCode.mockRejectedValueOnce(failure(code, { messageKey: 'account.email.error.something_else' }));
    const res = await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE });
    expect((errorOf(res).details as { messageKey: string }).messageKey).toBe(MESSAGE_KEY[code]);
  });

  it('EMAIL_INVALID passes the issue code and its message key through (400 VALIDATION), and still drops the cause and constraint', async () => {
    emailSvc.setEmail.mockRejectedValueOnce(failure('EMAIL_INVALID', { reason: 'INVALID_FORMAT', messageKey: 'account.email.error.invalid_format' }));
    const res = await call('POST', '/email', await webToken(), { email: 'typed-marker' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({
      category: 'VALIDATION',
      code: 'ACCOUNT_EMAIL_INVALID',
      details: { reason: 'INVALID_FORMAT', messageKey: 'account.email.error.invalid_format' },
    });
    expect(res.body).not.toContain('typed-marker');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('EMAIL_CODE_INVALID carries the attempts remaining as a number', async () => {
    emailSvc.confirmCode.mockRejectedValueOnce(new AccountError('EMAIL_CODE_INVALID', 'the code is not correct', { attemptsRemaining: 3 }));
    const res = await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual({ attemptsRemaining: 3, messageKey: 'account.email.error.code_invalid' });
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it.each(RATE_LIMITED)('%s: 429 with Retry-After equal to details.retryAfterSeconds', async (code) => {
    for (const r of ROUTES) {
      emailSvc[r.fn].mockRejectedValueOnce(failure(code, { retryAfterSeconds: 42 }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.url).toBe(429);
      expect(res.headers['retry-after'], r.url).toBe('42');
      expect((errorOf(res).details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(42);
      expect(errorOf(res).details).toMatchObject({ messageKey: MESSAGE_KEY[code] });
    }
  });

  it.each(RATE_LIMITED)('%s without a wait time sends no Retry-After (absent, null or a non-number)', async (code) => {
    for (const details of [{}, { retryAfterSeconds: null }, { retryAfterSeconds: '42' }, { retryAfterSeconds: undefined }]) {
      emailSvc.sendVerification.mockRejectedValueOnce(new AccountError(code, 'wait', details));
      const res = await call('POST', '/email/verification/send', await webToken(), {});
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after'], raw(details)).toBeUndefined();
    }
  });

  it('never sends Retry-After on a non-429 answer, even when the service attaches a wait time', async () => {
    for (const code of EMAIL_ERROR_CODES.filter((c) => !(RATE_LIMITED as readonly string[]).includes(c))) {
      emailSvc.confirmCode.mockRejectedValueOnce(failure(code, { retryAfterSeconds: 42 }));
      const res = await call('POST', '/email/verification/confirm-code', await webToken(), { code: CODE });
      expect(res.statusCode, code).not.toBe(429);
      expect(res.headers['retry-after'], code).toBeUndefined();
    }
  });

  it('a rate-limit refusal never names the refusing dimension (account, address, source address, device): code, message and details are the same shape', async () => {
    const token = await webToken();
    const bodies: unknown[] = [];
    for (const wait of [3, 1800]) {
      emailSvc.setEmail.mockRejectedValueOnce(new AccountError('EMAIL_RATE_LIMITED', 'too many requests', { retryAfterSeconds: wait }));
      const res = await call('POST', '/email', token, { email: 'ana@example.test' });
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
  ])('EMAIL_DELIVERY_FAILED is 503 DEPENDENCY with a generic message and retryable=%s -> %s (only a boolean true counts)', async (given, expected) => {
    for (const r of POST_ROUTES) {
      emailSvc[r.fn].mockRejectedValueOnce(
        new AccountError('EMAIL_DELIVERY_FAILED', 'smtp 10.0.0.9:25 refused rcpt customer.dev@bananagig.localhost', { retryable: given, cause: 'smtp' }),
      );
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(503);
      expect(errorOf(res)).toMatchObject({
        category: 'DEPENDENCY',
        code: 'ACCOUNT_EMAIL_DELIVERY_FAILED',
        message: 'The verification email could not be sent',
        details: { retryable: expected, messageKey: 'account.email.error.delivery_failed' },
      });
      expect(keysOf(errorOf(res).details!)).toEqual(['messageKey', 'retryable']);
      for (const leak of ['10.0.0.9', 'smtp', FULL_ADDRESS, 'rcpt']) expect(res.body).not.toContain(leak);
    }
  });

  it('answers a limiter or policy outage (UNAVAILABLE) with a generic 503 and no details, on every route', async () => {
    for (const r of ROUTES) {
      emailSvc[r.fn].mockRejectedValueOnce(
        new AccountError('UNAVAILABLE', 'the request cannot be accepted right now', { reason: 'RATE_LIMITER_UNAVAILABLE', cause: 'valkey down' }),
      );
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.url).toBe(503);
      expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
      expect(errorOf(res).details).toBeUndefined();
      for (const leak of ['RATE_LIMITER_UNAVAILABLE', 'valkey', 'cause']) expect(res.body).not.toContain(leak);
    }
  });

  it('reports unexpected (non-account) failures as a generic 500 without the cause', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const r of ROUTES) {
      emailSvc[r.fn].mockRejectedValueOnce(new Error(`boom: password=hunter2 identity.email_contacts ${FULL_ADDRESS}`));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.url).toBe(500);
      expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
      for (const leak of ['hunter2', 'identity.email_contacts', FULL_ADDRESS, 'boom']) expect(res.body).not.toContain(leak);
    }
  });

  it('keeps the ID-001 codes mapped the same way on the email routes (a closed account is 403, a missing account 404)', async () => {
    emailSvc.getEmailDetail.mockRejectedValueOnce(new AccountError('NOT_FOUND', 'the account does not exist'));
    expect((await call('GET', '/email', await webToken())).statusCode).toBe(404);
    emailSvc.setEmail.mockRejectedValueOnce(new AccountError('CLOSED', 'closed', { status: 'CLOSED' }));
    expect((await call('POST', '/email', await webToken(), { email: 'ana@example.test' })).statusCode).toBe(403);
  });
});

// ====================================================================== registration
describe('email routes are registered only when the email service is provided', () => {
  const authorized = async () => ({ authorization: `Bearer ${await webToken()}` });

  it('without emailVerification the five email routes are 404 ROUTE_NOT_FOUND while the three ID-001 routes keep working', async () => {
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
    expect(noEmailCalls()).toBe(true);
    const paths = Object.keys((bare.swagger() as { paths: object }).paths).filter((p) => p.includes('/account/'));
    expect(paths.sort()).toEqual(['/api/v1/account/active-role', '/api/v1/account/me', '/api/v1/account/profile']);
    expect(bare.hasDecorator('emailVerification')).toBe(false);
    await bare.close();
  });

  it('without the account service nothing account-related is registered, even with an email service', async () => {
    const noAccounts = await buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      emailVerification: emailSvc as unknown as EmailVerificationService,
      readiness: async () => ({}),
    });
    await noAccounts.ready();
    const headers = await authorized();
    for (const r of ROUTES) {
      const res = await noAccounts.inject({ method: r.method, url: `/api/v1/account${r.url}`, headers, ...(r.body ? { payload: r.body as object } : {}) });
      expect(res.statusCode, r.url).toBe(404);
    }
    expect(noEmailCalls()).toBe(true);
    await noAccounts.close();
  });

  const absent: [Method, string][] = [
    ['GET', '/email/verification/confirm-code'],
    ['GET', '/email/verification/confirm-link'],
    ['GET', `/email/verification/confirm-link?token=${LINK_MARKER}`],
    ['GET', '/email/verification/send'],
    ['PUT', '/email'],
    ['PATCH', '/email'],
    ['DELETE', '/email'],
    ['PUT', '/email/verification/send'],
    ['DELETE', '/email/verification/send'],
    ['GET', '/email/verification'],
    ['POST', '/email/verification'],
    ['POST', '/email/verification/confirm'],
    ['POST', '/email/resend'],
    ['POST', '/email/verify'],
    ['POST', '/email/primary'],
    ['POST', '/email/change'],
    ['GET', '/email/contacts'],
    ['GET', `/email/${ACCOUNT_ID}`],
    ['POST', `/email/${ACCOUNT_ID}`],
    ['POST', `/email/${ACCOUNT_ID}/verification/send`],
    ['GET', `/${OTHER_ACCOUNT_ID}/email`],
    ['POST', `/${OTHER_ACCOUNT_ID}/email/verification/send`],
    ['POST', `/email/verification/confirm-code/${CODE}`],
    ['GET', `/email/verification/${LINK_MARKER}`],
    ['POST', '/email/verification/confirm-code/'],
    ['GET', '/emails'],
    ['POST', '/emails'],
  ];
  it.each(absent)('%s /api/v1/account%s does not exist: 404 ROUTE_NOT_FOUND, anonymous and with a valid token', async (method, url) => {
    for (const t of [undefined, await webToken()]) {
      const res = await call(method, url, t, method === 'GET' || method === 'DELETE' ? undefined : { email: 'ana@example.test' });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    }
    expect(noServiceCalls()).toBe(true);
  });

  it('has no email route outside /api/v1/account', async () => {
    for (const url of [
      '/api/v1/email',
      '/api/v1/emails',
      '/api/v1/verification/send',
      '/api/v1/geography/account/email',
      '/account/email',
      '/api/v1/users/me/email',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: await authorized() });
      expect(res.statusCode, url).toBe(404);
    }
    expect(noServiceCalls()).toBe(true);
  });
});

// ====================================================================== GET /account/me
describe('GET /account/me carries the email state, masked', () => {
  const ACCOUNT_KEYS = ['accountId', 'activeRole', 'createdAt', 'email', 'primaryRole', 'profile', 'roles', 'status'];

  it('adds exactly one new key, `email`, taken from the account context; the email service is not consulted', async () => {
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(keysOf(data)).toEqual(ACCOUNT_KEYS);
    expect(data.email).toEqual(NONE_SUMMARY);
    expect(Object.values(emailSvc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ['PENDING', PENDING_SUMMARY],
    ['VERIFIED', VERIFIED_SUMMARY],
    ['VERIFIED with a pending replacement', CHANGING_SUMMARY],
  ] as const)('reports the %s state with masked values only and never a full address', async (_label, summary) => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ email: summary as unknown as AccountContext['email'] }));
    const res = await call('GET', '/me', await webToken());
    const data = (res.json() as { data: Record<string, unknown> }).data;
    expect(data.email).toEqual(summary);
    for (const word of [FULL_ADDRESS, 'customer.dev', 'bananagig.localhost']) expect(res.body).not.toContain(word);
    expect(res.body).toMatch(/\*\*\*@/);
  });

  it('PENDING carries the purpose and the timing of the newest verification, and no code, token or hash', async () => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ email: PENDING_SUMMARY as unknown as AccountContext['email'] }));
    const res = await call('GET', '/me', await webToken());
    const email = (res.json() as { data: { email: typeof PENDING_SUMMARY } }).data.email;
    expect(keysOf(email.pending)).toEqual(['expiresAt', 'lastSentAt', 'maskedEmail', 'purpose', 'status']);
    expect(raw(email)).not.toMatch(/hash|token|"code"|challenge/i);
  });

  it('builds the email block from the declared fields: an attribute a context carries beyond the summary is dropped', async () => {
    accountSvc.ensureAccountForIdentity.mockResolvedValueOnce(
      makeContext({ email: { ...NONE_SUMMARY, rawEmail: FULL_ADDRESS } as unknown as AccountContext['email'] }),
    );
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FULL_ADDRESS);
    expect(res.body).not.toContain('rawEmail');
  });
});

// ====================================================================== OpenAPI
describe('email OpenAPI contract', () => {
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
      .filter(([path]) => path.startsWith('/api/v1/account/email'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));
  const byId = (id: string) => operations().find((o) => o.op.operationId === id)!;

  it('lists exactly the five email operations under /api/v1/account/email*', () => {
    expect(
      operations()
        .map((o) => `${o.op.operationId} ${o.method.toUpperCase()} ${o.path}`)
        .sort(),
    ).toEqual(
      [
        'confirmAccountEmailCode POST /api/v1/account/email/verification/confirm-code',
        'confirmAccountEmailLink POST /api/v1/account/email/verification/confirm-link',
        'getAccountEmail GET /api/v1/account/email',
        'sendAccountEmailVerification POST /api/v1/account/email/verification/send',
        'setAccountEmail POST /api/v1/account/email',
      ].sort(),
    );
  });

  it('keeps the account path set to the three ID-001 paths plus the four email paths, and nothing else', () => {
    expect(
      Object.keys(doc().paths)
        .filter((p) => /account/.test(p))
        .sort(),
    ).toEqual(
      [
        '/api/v1/account/active-role',
        '/api/v1/account/email',
        '/api/v1/account/email/verification/confirm-code',
        '/api/v1/account/email/verification/confirm-link',
        '/api/v1/account/email/verification/send',
        '/api/v1/account/me',
        '/api/v1/account/profile',
      ].sort(),
    );
  });

  it('requires the bearer token on every email operation and tags them account', () => {
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
      for (const word of ['accountId', 'account_id', 'contactId', 'emailContactId', 'challengeId', 'subject', 'issuer', 'userId', 'role', 'clientIp']) {
        expect(request, `${op.operationId} ${word}`).not.toContain(word);
      }
    }
  });

  it.each(['getAccountEmail', 'setAccountEmail', 'sendAccountEmailVerification', 'confirmAccountEmailCode', 'confirmAccountEmailLink'])(
    '%s documents 200, 400, 401, 403, 409, 429 and 503',
    (id) => {
      expect(Object.keys(byId(id).op.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '429', '503']);
    },
  );

  it('documents the request bodies as strict objects (additionalProperties false) with the same rules the API enforces', () => {
    const schemaOf = (id: string): Schema => byId(id).op.requestBody!.content['application/json'].schema;
    expect(byId('getAccountEmail').op.requestBody).toBeUndefined();
    for (const id of ['setAccountEmail', 'sendAccountEmailVerification', 'confirmAccountEmailCode', 'confirmAccountEmailLink']) {
      expect(schemaOf(id).type, id).toBe('object');
      expect(schemaOf(id).additionalProperties, id).toBe(false);
      expect(byId(id).op.requestBody!.required, id).toBe(true);
    }
    expect(Object.keys(schemaOf('sendAccountEmailVerification').properties ?? {})).toEqual([]);
    expect(schemaOf('setAccountEmail')).toMatchObject({ required: ['email'], properties: { email: { type: 'string', maxLength: 1024 } } });
    expect(schemaOf('confirmAccountEmailCode')).toMatchObject({ required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{4,10}$' } } });
    expect(schemaOf('confirmAccountEmailLink')).toMatchObject({
      required: ['token'],
      properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
    });
  });

  it('documents the 200 responses with the masked summary only (no property named email of type string, no address field)', () => {
    for (const { op } of operations()) {
      const ok = raw(op.responses['200']);
      expect(ok, op.operationId).toContain('maskedEmail');
      for (const word of ['"address"', '"emailNormalized"', '"email_normalized"', 'codeHash', 'magicToken', 'verification_code'])
        expect(ok, `${op.operationId} ${word}`).not.toContain(word);
    }
  });
});

// ====================================================================== secrecy of the logs
describe('email API keeps credentials and addresses out of the logs', () => {
  it('writes no code, link token or address to any log line, for successes, validation failures and mapped errors', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    const typedAddress = 'sentinel.person@example.test';
    const typedCode = '908172';
    const typedToken = 'Sx9_-'.repeat(8) + 'abc';
    const token = await webToken();
    await call('POST', '/email', token, { email: typedAddress });
    await call('POST', '/email', token, { email: 4242 }); // 400
    await call('POST', '/email/verification/send', token, {});
    await call('POST', '/email/verification/confirm-code', token, { code: typedCode });
    await call('POST', '/email/verification/confirm-code', token, { code: Number(typedCode) }); // 400
    emailSvc.confirmCode.mockRejectedValueOnce(new AccountError('EMAIL_CODE_INVALID', 'the code is not correct', { attemptsRemaining: 2 }));
    await call('POST', '/email/verification/confirm-code', token, { code: typedCode });
    await call('POST', '/email/verification/confirm-link', token, { token: typedToken });
    emailSvc.confirmLink.mockRejectedValueOnce(new AccountError('EMAIL_LINK_INVALID', 'the verification link is not valid'));
    await call('POST', '/email/verification/confirm-link', token, { token: typedToken });
    await call('GET', '/email', token);
    await call('POST', '/email/verification/confirm-code', 'invalid.token.value', { code: typedCode });
    expect(lines.some((l) => l.includes('request completed'))).toBe(true);
    const logged = lines.join('\n');
    for (const value of [typedAddress, 'sentinel.person', typedCode, typedToken, token, SUB, FULL_ADDRESS, 'Bearer '])
      expect(logged, `a log line contains ${value.slice(0, 12)}`).not.toContain(value);
  });
});
