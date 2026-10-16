// Unit tests of the HTTP layer of the account security API (ID-004, docs/engineering/SESSIONS_AND_MFA.md) with a FAKE SecurityOperations (the rules of the real service
// are covered by packages/accounts and, against PostgreSQL and Keycloak, by security.itest.ts): authentication, the session registry enforcement in requireAccount
// (SESSION_REVOKED, missing `sid`), strict RAW bodies and strict path and query parameters, the account always coming from the verified token (no route accepts an
// account id), the step-up guards and their RFC 9470 challenge, the error mapping of the security codes, privacy (no token, Keycloak session id, device secret, raw id or
// provider field in any response), caching, the PUBLIC password-reset route (one fixed answer) and the generated OpenAPI and AsyncAPI contracts.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ACR_MFA,
  ACR_PASSWORD,
  DeviceRemovedResponse,
  DeviceTrustResponse,
  ErrorResponse,
  MfaEnrollmentResponse,
  PasswordResetAcceptedResponse,
  RegisteredSessionResponse,
  SECURITY_EVENTS,
  SecurityActivityResponse,
  SecurityDevicesResponse,
  SecurityOverviewResponse,
  SecuritySessionsResponse,
  SessionRevokedResponse,
  SessionsRevokedAllResponse,
  SignedOutResponse,
  StepUpDetails,
  authSecurityErrorMessageKey,
  securityErrorMessageKey,
} from '@bananagig/contracts';
import {
  AccountError,
  type AccountContext,
  type AccountService,
  type EmailVerificationService,
  type PhoneVerificationService,
  type SecurityOperations,
  type SecurityPolicy,
} from '@bananagig/accounts';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type SignOptions, type TestKeys } from '@bananagig/identity/testing';
import { SECURITY_DRAIN_TIMEOUT_MS, buildApp } from './app';
import { isNoStorePath } from './plugins/errors';
import { drainWithTimeout } from './modules/security/wiring';
import { requireAccount } from './plugins/account';
import { requireMfa, requireRecentAuthentication, requireStepUp } from './plugins/step-up';
import { isActivityCursor, isIsoInstant } from './modules/security/routes';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
let guardApp: FastifyInstance;

// ---------------------------------------------------------------- the fakes
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn(), selectActiveRole: vi.fn(), upsertProfile: vi.fn() };
const security = {
  observeSession: vi.fn(),
  registerSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  signOutCurrentSession: vi.fn(),
  listDevices: vi.fn(),
  trustCurrentDevice: vi.fn(),
  untrustCurrentDevice: vi.fn(),
  removeDevice: vi.fn(),
  isDeviceTrusted: vi.fn(),
  getOverview: vi.fn(),
  startMfaEnrollment: vi.fn(),
  hasMfaEnrolled: vi.fn(),
  listActivity: vi.fn(),
  getPolicy: vi.fn(),
  requestPasswordReset: vi.fn(),
};
const emailSvc = {
  getEmailDetail: vi.fn(),
  setEmail: vi.fn(),
  sendVerification: vi.fn(),
  confirmCode: vi.fn(),
  confirmLink: vi.fn(),
  getEmailSummary: vi.fn(),
};
const phoneSvc = { getPhoneDetail: vi.fn(), setPhone: vi.fn(), sendVerification: vi.fn(), confirmCode: vi.fn(), getPhoneSummary: vi.fn() };
/** Every call except the session observation made by the guard on each authenticated request. */
const noSecurityCalls = () => Object.entries(security).every(([name, f]) => name === 'observeSession' || name === 'getPolicy' || f.mock.calls.length === 0);
const noCalls = () => Object.values(security).every((f) => f.mock.calls.length === 0) && Object.values(accountSvc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-other-subject-marker-93d0';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const SESSION_ID = '0d9b1c52-8a4f-4e63-b7a1-3c2d5e6f7a80';
const OTHER_SESSION_ID = '7e2a9c14-5b3d-4f08-a1c6-9d4e3b2a1f05';
const DEVICE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const DEVICE_SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'; // 43 base64url characters
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const ISO = '2026-02-03T04:05:06.000Z';
const EVENT_ID = 'b7e1c0a4-93d2-4f6a-8a15-2c4d6e8f0a1b';
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const POLICY: SecurityPolicy = {
  trustedBrowserDays: 30,
  keepSignedInDays: 30,
  stepUpValidMinutes: 15,
  activityLogDays: 90,
  resetLinkValidityMinutes: 60,
  resetMaxRequestsPerHour: 5,
};
const CHROME = { browser: 'CHROME', os: 'MACOS', deviceClass: 'DESKTOP' } as const;

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

/** A web token whose authentication is 30 seconds old (recent for any window) unless a test says otherwise. */
const webToken = (o: SignOptions = {}) =>
  signToken(keys, {
    authTimeAgoSec: 30,
    ...o,
    claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer', REALM_ROLE_MARKER] }, ...o.claims },
  });
const adminToken = () =>
  signToken(keys, {
    authTimeAgoSec: 30,
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: ['customer'] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', 'configuration-read'] } },
    },
  });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const send = async (
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const call = (method: Method, path: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  send(method, `/api/v1/account/security${path}`, token, payload, headers);
/** Sends ANY JSON value (a number, an array, null, a string) as the body, so a test controls the exact JSON type that reaches the API. */
const rawJson = (url: string, token: string | undefined, text: string, headers: Record<string, string> = {}): Promise<Reply> =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: text,
  });
const sendJson = (url: string, token: string | undefined, value: unknown, headers: Record<string, string> = {}) =>
  rawJson(url, token, JSON.stringify(value), headers);
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const raw = (v: unknown): string => JSON.stringify(v);
const header = (r: Reply, name: string): string => String(r.headers[name] ?? '');
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
  // the closed vocabularies of the contract (enum members) legitimately appear in a validation message
  for (const value of leafStrings(rejected).filter((v) => !['TOTP', 'RECOVERY_CODES'].includes(v)))
    expect(r.body, 'a rejected value was echoed').not.toContain(value);
};
/** Anything that must never appear in any body or header the API answers. */
const SECRETS = [
  KEYCLOAK_SID,
  DEVICE_SECRET,
  SUB,
  OTHER_SUB,
  REALM_ROLE_MARKER,
  OTHER_ACCOUNT_ID,
  'deviceHash',
  'device_hash',
  'keycloakSessionId',
  'keycloak_session_id',
];

interface Route {
  id: string;
  method: Method;
  url: string;
  body?: unknown;
  fn: keyof typeof security;
  /** The exact arguments the service must receive for the sample request. */
  args: unknown[];
  /** Needs a recent authentication. */
  guarded?: boolean;
}
const CURRENT = { accountId: ACCOUNT_ID, keycloakSessionId: KEYCLOAK_SID };
const ROUTES: Route[] = [
  {
    id: 'registerAccountSecuritySession',
    method: 'POST',
    url: '/sessions/current',
    body: { device: DEVICE_SECRET, userAgent: USER_AGENT },
    fn: 'registerSession',
    args: [{ ...CURRENT, deviceSecret: DEVICE_SECRET, userAgent: USER_AGENT }, { clientIp: '127.0.0.1' }],
  },
  { id: 'getAccountSecurity', method: 'GET', url: '', fn: 'getOverview', args: [CURRENT, { authTime: expect.any(Number), acr: ACR_PASSWORD }] },
  { id: 'listAccountSecuritySessions', method: 'GET', url: '/sessions', fn: 'listSessions', args: [CURRENT] },
  { id: 'revokeAccountSecuritySession', method: 'DELETE', url: `/sessions/${OTHER_SESSION_ID}`, fn: 'revokeSession', args: [CURRENT, OTHER_SESSION_ID] },
  {
    id: 'revokeAllAccountSecuritySessions',
    method: 'POST',
    url: '/sessions/revoke-all',
    body: {},
    fn: 'revokeAllSessions',
    args: [CURRENT, { includeCurrent: false }],
  },
  { id: 'signOutCurrentAccountSecuritySession', method: 'POST', url: '/sessions/current/sign-out', fn: 'signOutCurrentSession', args: [CURRENT] },
  { id: 'listAccountSecurityDevices', method: 'GET', url: '/devices', fn: 'listDevices', args: [CURRENT] },
  { id: 'trustCurrentAccountSecurityDevice', method: 'POST', url: '/devices/current/trust', fn: 'trustCurrentDevice', args: [CURRENT], guarded: true },
  { id: 'untrustCurrentAccountSecurityDevice', method: 'DELETE', url: '/devices/current/trust', fn: 'untrustCurrentDevice', args: [CURRENT] },
  { id: 'removeAccountSecurityDevice', method: 'DELETE', url: `/devices/${DEVICE_ID}`, fn: 'removeDevice', args: [CURRENT, DEVICE_ID] },
  { id: 'listAccountSecurityActivity', method: 'GET', url: '/activity', fn: 'listActivity', args: [ACCOUNT_ID, {}] },
  {
    id: 'startAccountSecurityMfaEnrollment',
    method: 'POST',
    url: '/mfa/enrollment',
    body: { method: 'TOTP' },
    fn: 'startMfaEnrollment',
    args: [CURRENT, 'TOTP'],
    guarded: true,
  },
];
const POST_WITH_BODY = ROUTES.filter((r) => r.body !== undefined);
const POST_NO_BODY = ROUTES.filter((r) => r.method === 'POST' && r.body === undefined);
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}) => call(r.method, r.url, token, r.body, headers);

const stubReplies = () => {
  security.observeSession.mockImplementation(async () => ({ applicationSessionId: SESSION_ID, accountDeviceId: null, created: false }));
  security.getPolicy.mockImplementation(async () => POLICY);
  security.registerSession.mockImplementation(async () => ({ sessionId: SESSION_ID, deviceId: DEVICE_ID, deviceTrusted: false, trustedUntil: null }));
  security.getOverview.mockImplementation(async () => ({
    mfa: { available: true, totpConfigured: true, recoveryCodesConfigured: false },
    stepUp: { authenticatedAt: ISO, mfaSatisfied: false, recentUntil: ISO },
    currentSession: { sessionId: SESSION_ID, deviceId: DEVICE_ID, deviceTrusted: false, trustedUntil: null },
    policy: { trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 },
  }));
  security.listSessions.mockImplementation(async () => ({
    sessions: [
      {
        sessionId: SESSION_ID,
        current: true,
        status: 'ACTIVE',
        device: CHROME,
        deviceId: DEVICE_ID,
        createdAt: ISO,
        lastSeenAt: ISO,
        trusted: false,
        trustedUntil: null,
      },
    ],
    reconciled: true,
  }));
  security.revokeSession.mockImplementation(async (_c: unknown, id: string) => ({ sessionId: id, changed: true, current: false, keycloak: 'ENDED' }));
  security.revokeAllSessions.mockImplementation(async () => ({ revokedCount: 2, keycloak: 'ENDED' }));
  security.signOutCurrentSession.mockImplementation(async () => ({ changed: true, keycloak: 'ENDED' }));
  security.listDevices.mockImplementation(async () => ({
    devices: [{ deviceId: DEVICE_ID, current: true, device: CHROME, firstSeenAt: ISO, lastSeenAt: ISO, trusted: true, trustedUntil: ISO }],
  }));
  security.trustCurrentDevice.mockImplementation(async () => ({ deviceId: DEVICE_ID, trusted: true, trustedUntil: ISO }));
  security.untrustCurrentDevice.mockImplementation(async () => ({ deviceId: DEVICE_ID, trusted: false, trustedUntil: null }));
  security.removeDevice.mockImplementation(async (_c: unknown, id: string) => ({ deviceId: id, changed: true, sessionsRevoked: 1, keycloak: 'ENDED' }));
  security.listActivity.mockImplementation(async () => ({ entries: [], nextBefore: null }));
  security.startMfaEnrollment.mockImplementation(async (_c: unknown, method: string) => ({
    method,
    keycloakAction: method === 'TOTP' ? 'CONFIGURE_TOTP' : 'CONFIGURE_RECOVERY_AUTHN_CODES',
  }));
  security.hasMfaEnrolled.mockImplementation(async () => true);
  security.requestPasswordReset.mockImplementation(async () => undefined);
  security.isDeviceTrusted.mockImplementation(async () => false);
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
  const deps = {
    cfg,
    verifier,
    configuration: {} as never,
    accounts: accountSvc as unknown as AccountService,
    emailVerification: emailSvc as unknown as EmailVerificationService,
    phoneVerification: phoneSvc as unknown as PhoneVerificationService,
    security: security as unknown as SecurityOperations,
    readiness: async () => ({}),
  };
  app = await buildApp(deps);
  await app.ready();
  // a second app with one probe route per guard (the guards are listed after requireAccount, as on the real routes)
  guardApp = await buildApp(deps);
  const probe = async () => ({ ok: true });
  guardApp.get('/probe/recent', { preValidation: [requireAccount(), requireRecentAuthentication()] }, probe);
  guardApp.get('/probe/mfa', { preValidation: [requireAccount(), requireMfa()] }, probe);
  guardApp.get('/probe/step-up-recent', { preValidation: [requireAccount(), requireStepUp('RECENT_AUTHENTICATION')] }, probe);
  guardApp.get('/probe/step-up-mfa', { preValidation: [requireAccount(), requireStepUp('MFA')] }, probe);
  guardApp.get('/probe/account-only', { preValidation: [requireAccount()] }, probe);
  // guards listed WITHOUT requireAccount must still refuse a token of another identity context
  guardApp.get('/probe/bare-recent', { preValidation: [requireRecentAuthentication()] }, probe);
  guardApp.get('/probe/bare-mfa', { preValidation: [requireMfa()] }, probe);
  guardApp.get('/probe/bare-step-up-mfa', { preValidation: [requireStepUp('MFA')] }, probe);
  guardApp.get('/probe/bare-step-up-recent', { preValidation: [requireStepUp('RECENT_AUTHENTICATION')] }, probe);
  await guardApp.ready();
});
afterAll(async () => {
  await app.close();
  await guardApp.close();
});

beforeEach(() => {
  for (const f of [...Object.values(accountSvc), ...Object.values(security), ...Object.values(emailSvc), ...Object.values(phoneSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }) =>
    makeContext({ accountId: identity.subject === OTHER_SUB ? OTHER_ACCOUNT_ID : ACCOUNT_ID }),
  );
  accountSvc.getAccountContext.mockImplementation(async (accountId: string) => makeContext({ accountId }));
  stubReplies();
});

// ====================================================================== authentication, identity context and the session registry
describe('security API authentication', () => {
  it.each(ROUTES)('$method $url requires a token: 401 with the standard envelope and a Bearer challenge, before any service call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(errorOf(res).correlationId).toBeTruthy();
    expect(header(res, 'www-authenticate')).toBe('Bearer realm="bananagig"');
    expect(noCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url rejects every kind of invalid token with 401 invalid_token and never calls a service', async (r) => {
    const invalid = [
      'not.a.token',
      await signToken(keys, { expiresInSec: -3600 }),
      await signToken(keys, { claims: { aud: 'someone-else' } }),
      await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } }),
      await signToken(keys, { claims: { typ: 'ID' } }),
      unsignedToken(),
      await hmacToken(),
    ];
    for (const token of invalid) {
      const res = await routeCall(r, token);
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expect(header(res, 'www-authenticate')).toContain('error="invalid_token"');
    }
    expect(noCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url refuses the admin identity context and any other client with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED', async (r) => {
    for (const token of [await adminToken(), await webToken({ claims: { azp: 'other' } }), await webToken({ claims: { azp: 'bananagig-dev-test' } })]) {
      const res = await routeCall(r, token);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    }
    expect(security.observeSession).not.toHaveBeenCalled();
    expect(noSecurityCalls()).toBe(true);
  });

  it.each(POST_WITH_BODY)('$method $url answers 401 before 400 and 403 (admin) before 400', async (r) => {
    for (const body of [{ unknown: 'x'.repeat(10) }, [], 'text', 7, null]) {
      const none = await sendJson(`/api/v1/account/security${r.url}`, undefined, body);
      expect(none.statusCode, raw(body)).toBe(401);
      const bad = await sendJson(`/api/v1/account/security${r.url}`, 'bad.token', body);
      expect(bad.statusCode, raw(body)).toBe(401);
      expect((await sendJson(`/api/v1/account/security${r.url}`, await adminToken(), body)).statusCode).toBe(403);
    }
    expect(noCalls()).toBe(true);
  });

  it.each(ROUTES)('$method $url resolves the session from the verified token only: the account and the `sid`, never the client', async (r) => {
    const res = await routeCall(r, await webToken(), { 'x-session-id': OTHER_SESSION_ID, 'x-sid': 'client-chosen-sid', 'x-account-id': OTHER_ACCOUNT_ID });
    expect(res.statusCode, res.body).toBe(200);
    expect(security.observeSession).toHaveBeenCalledTimes(1);
    expect(security.observeSession.mock.calls[0]![0]).toEqual({ accountId: ACCOUNT_ID, keycloakSessionId: KEYCLOAK_SID, authTime: expect.any(Number) });
    expect(accountSvc.ensureAccountForIdentity).toHaveBeenCalledTimes(1);
  });

  it('observes the session after the account is resolved and passes auth_time as an epoch-seconds number', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 120;
    await call('GET', '/sessions', await webToken({ authTime }));
    expect(security.observeSession.mock.calls[0]![0]).toEqual({ accountId: ACCOUNT_ID, keycloakSessionId: KEYCLOAK_SID, authTime });
  });

  it('passes an undefined authTime for a token without auth_time (the service decides)', async () => {
    const res = await call('GET', '/sessions', await signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(security.observeSession.mock.calls[0]![0].authTime).toBeUndefined();
  });

  it.each(ROUTES)(
    '$method $url refuses a token without `sid` with 401 INVALID_TOKEN (the session cannot be resolved) and calls no security operation',
    async (r) => {
      const res = await routeCall(r, await webToken({ omit: ['sid'] }));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expect(header(res, 'www-authenticate')).toBe('Bearer realm="bananagig", error="invalid_token"');
      expect(security.observeSession).not.toHaveBeenCalled();
      expect(noSecurityCalls()).toBe(true);
    },
  );

  it('treats an empty or non-string sid as missing', async () => {
    for (const sid of ['', 12, null, ['a']]) {
      const res = await call('GET', '/sessions', await webToken({ claims: { sid } }));
      expect(res.statusCode, String(sid)).toBe(401);
      expect(errorOf(res).code).toBe('INVALID_TOKEN');
    }
    expect(security.observeSession).not.toHaveBeenCalled();
  });

  it('gives each token its own account', async () => {
    await call('GET', '/sessions', await webToken());
    await call('GET', '/sessions', await webToken({ claims: { sub: OTHER_SUB, sid: 'other-sid' } }));
    expect(security.listSessions.mock.calls.map((c) => c[0])).toEqual([CURRENT, { accountId: OTHER_ACCOUNT_ID, keycloakSessionId: 'other-sid' }]);
  });
});

describe('security API: SESSION_REVOKED', () => {
  const revoked = () =>
    new AccountError('SESSION_REVOKED', 'revoked', { applicationSessionId: SESSION_ID, keycloakSessionId: KEYCLOAK_SID, reason: 'SIGN_OUT_EVERYWHERE' });

  it.each(ROUTES)('$method $url: a revoked session is refused at once with 401 SESSION_REVOKED and the route service is never called', async (r) => {
    security.observeSession.mockRejectedValueOnce(revoked());
    const res = await routeCall(r, await webToken());
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({
      category: 'AUTHENTICATION',
      code: 'SESSION_REVOKED',
      message: 'The session was revoked',
      details: { messageKey: authSecurityErrorMessageKey('SESSION_REVOKED') },
    });
    expect(header(res, 'www-authenticate')).toBe('Bearer realm="bananagig", error="invalid_token"');
    expect(header(res, 'cache-control')).toBe('no-store');
    expect(errorOf(res).correlationId).toBeTruthy();
    for (const secret of [KEYCLOAK_SID, SESSION_ID, 'SIGN_OUT_EVERYWHERE', 'applicationSessionId', SUB]) expect(res.body).not.toContain(secret);
    expect(noSecurityCalls()).toBe(true);
  });

  it('refuses a revoked session on the EXISTING account routes too (the whole account API is behind the registry)', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/v1/account/me', undefined],
      ['PUT', '/api/v1/account/profile', { firstName: 'A', lastName: 'B' }],
      ['POST', '/api/v1/account/active-role', { role: 'CUSTOMER' }],
      ['GET', '/api/v1/account/email', undefined],
      ['GET', '/api/v1/account/phone', undefined],
    ] as const) {
      security.observeSession.mockRejectedValueOnce(revoked());
      const res = await send(method, url, await webToken(), body);
      expect(res.statusCode, url).toBe(401);
      expect(errorOf(res).code, url).toBe('SESSION_REVOKED');
    }
    for (const f of [emailSvc.getEmailDetail, phoneSvc.getPhoneDetail, accountSvc.upsertProfile, accountSvc.selectActiveRole]) expect(f).not.toHaveBeenCalled();
  });

  it('maps a SESSION_REVOKED raised by a route operation (not only by the guard) to the same 401 with the realm challenge', async () => {
    security.registerSession.mockRejectedValueOnce(revoked());
    const res = await call('POST', '/sessions/current', await webToken(), { device: DEVICE_SECRET });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ code: 'SESSION_REVOKED', details: { messageKey: 'account.security.error.session_revoked' } });
    expect(header(res, 'www-authenticate')).toBe('Bearer realm="bananagig", error="invalid_token"');
    expect(res.body).not.toContain(KEYCLOAK_SID);
  });

  it('maps other observation failures through the account error model (an outage is a generic 503, a bug a generic 500)', async () => {
    security.observeSession.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'db down', { cause: 'ECONNREFUSED 10.0.0.5' }));
    const out = await call('GET', '/sessions', await webToken());
    expect(out.statusCode).toBe(503);
    expect(errorOf(out)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE' });
    expect(out.body).not.toContain('10.0.0.5');
    security.observeSession.mockRejectedValueOnce(new Error('boom password=hunter2'));
    const bug = await call('GET', '/sessions', await webToken());
    expect(bug.statusCode).toBe(500);
    expect(errorOf(bug)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
    expect(bug.body).not.toContain('hunter2');
  });

  it('a first-sight session whose authentication predates the watermark is the same SESSION_REVOKED (the service decides, the API only maps)', async () => {
    security.observeSession.mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'authenticated before the watermark'));
    const res = await call('GET', '', await webToken({ authTimeAgoSec: 100000 }));
    expect(res.statusCode).toBe(401);
  });

  it('refuses a suspended or closed account before the session is observed (403), so the registry is never touched', async () => {
    accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError('SUSPENDED', 'refused', { status: 'SUSPENDED' }));
    const res = await call('GET', '/sessions', await webToken());
    expect(res.statusCode).toBe(403);
    expect(security.observeSession).not.toHaveBeenCalled();
  });
});

// ====================================================================== the responses
describe('security API responses', () => {
  const PARSERS: Record<string, { parse: (v: unknown) => unknown }> = {
    registerAccountSecuritySession: RegisteredSessionResponse,
    getAccountSecurity: SecurityOverviewResponse,
    listAccountSecuritySessions: SecuritySessionsResponse,
    revokeAccountSecuritySession: SessionRevokedResponse,
    revokeAllAccountSecuritySessions: SessionsRevokedAllResponse,
    signOutCurrentAccountSecuritySession: SignedOutResponse,
    listAccountSecurityDevices: SecurityDevicesResponse,
    trustCurrentAccountSecurityDevice: DeviceTrustResponse,
    untrustCurrentAccountSecurityDevice: DeviceTrustResponse,
    removeAccountSecurityDevice: DeviceRemovedResponse,
    listAccountSecurityActivity: SecurityActivityResponse,
    startAccountSecurityMfaEnrollment: MfaEnrollmentResponse,
  };

  it.each(ROUTES)(
    '$method $url answers 200 with the contract envelope, the correlation id, no-store and exactly the arguments of the verified token',
    async (r) => {
      const res = await routeCall(r, await webToken(), { 'x-correlation-id': 'corr-id-12345678' });
      expect(res.statusCode, res.body).toBe(200);
      const parsed = PARSERS[r.id]!.parse(res.json()) as { meta: { correlationId: string } };
      expect(parsed.meta.correlationId).toBe('corr-id-12345678');
      expect(header(res, 'x-correlation-id')).toBe('corr-id-12345678');
      expect(header(res, 'cache-control')).toBe('no-store');
      expect(security[r.fn]).toHaveBeenCalledTimes(1);
      expect(security[r.fn].mock.calls[0]).toEqual(r.args);
      expect(Object.keys(res.json() as object).sort()).toEqual(['data', 'meta']);
    },
  );

  it('strips every field the contract does not name, so a service that returns more cannot leak it (hashes, Keycloak ids, raw agents, addresses)', async () => {
    const extras = {
      keycloakSessionId: KEYCLOAK_SID,
      device_hash: 'f'.repeat(64),
      deviceHash: 'e'.repeat(64),
      userAgent: USER_AGENT,
      ip: '203.0.113.9',
      accountId: ACCOUNT_ID,
      token: 'tok',
    };
    security.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: SESSION_ID,
          current: true,
          status: 'ACTIVE',
          device: CHROME,
          deviceId: DEVICE_ID,
          createdAt: ISO,
          lastSeenAt: ISO,
          trusted: false,
          trustedUntil: null,
          ...extras,
        },
      ],
      reconciled: true,
      ...extras,
    });
    const sessions = await call('GET', '/sessions', await webToken());
    security.listDevices.mockResolvedValueOnce({
      devices: [
        {
          deviceId: DEVICE_ID,
          current: true,
          device: CHROME,
          firstSeenAt: ISO,
          lastSeenAt: ISO,
          trusted: false,
          trustedUntil: null,
          ...extras,
        },
      ],
      ...extras,
    });
    const devices = await call('GET', '/devices', await webToken());
    security.registerSession.mockResolvedValueOnce({ sessionId: SESSION_ID, deviceId: DEVICE_ID, deviceTrusted: false, trustedUntil: null, ...extras });
    const registered = await call('POST', '/sessions/current', await webToken(), { device: DEVICE_SECRET });
    for (const res of [sessions, devices, registered]) {
      expect(res.statusCode, res.body).toBe(200);
      for (const value of [...Object.values(extras), ...Object.keys(extras)]) expect(res.body, value).not.toContain(value);
    }
    expect(Object.keys((registered.json() as { data: object }).data).sort()).toEqual(['deviceId', 'deviceTrusted', 'sessionId', 'trustedUntil']);
  });

  it('no response of any route contains the Keycloak session id, the device secret, the subject, a realm role or another account', async () => {
    for (const r of ROUTES) {
      const res = await routeCall(r, await webToken());
      for (const secret of SECRETS) expect(res.body, `${r.id} ${secret}`).not.toContain(secret);
      for (const [name, value] of Object.entries(res.headers))
        for (const secret of SECRETS) expect(String(value), `${r.id} header ${name}`).not.toContain(secret);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('passes the overview the facts of the verified token (auth_time and acr), never anything the client sent', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 45;
    const res = await call('GET', '', await webToken({ authTime, acr: ACR_MFA }), undefined, { 'x-acr': ACR_MFA, 'x-auth-time': '1' });
    expect(res.statusCode).toBe(200);
    expect(security.getOverview).toHaveBeenCalledWith(CURRENT, { authTime, acr: ACR_MFA });
  });

  it('answers errors with no-store as well, including a 404 for an unknown route under the prefix and a 400', async () => {
    const missing = await call('GET', '/nothing-here', await webToken());
    expect(missing.statusCode).toBe(404);
    const bad = await call('DELETE', '/sessions/not-a-uuid', await webToken());
    expect(bad.statusCode).toBe(400);
    expect(header(bad, 'cache-control')).toBe('no-store');
    const unauthenticated = await call('GET', '/sessions');
    expect(header(unauthenticated, 'cache-control')).toBe('no-store');
  });
});

// ====================================================================== strict bodies
describe('security API strict bodies', () => {
  const wrongBodies: Record<string, unknown[]> = {
    registerAccountSecuritySession: [
      {},
      { device: 123 },
      { device: DEVICE_SECRET.slice(1) },
      { device: `${DEVICE_SECRET}A` },
      { device: `${DEVICE_SECRET.slice(0, 42)}+` },
      { device: `${DEVICE_SECRET.slice(0, 42)} ` },
      { device: DEVICE_SECRET, userAgent: 5 },
      { device: DEVICE_SECRET, userAgent: 'x'.repeat(513) },
      { device: DEVICE_SECRET, userAgent: null },
      { device: DEVICE_SECRET, accountId: OTHER_ACCOUNT_ID },
      { device: DEVICE_SECRET, deviceId: DEVICE_ID },
      { device: DEVICE_SECRET, sessionId: SESSION_ID },
      { device: [DEVICE_SECRET] },
      [{ device: DEVICE_SECRET }],
      [],
      null,
      'text',
      7,
      true,
    ],
    revokeAllAccountSecuritySessions: [
      { includeCurrent: 'true' },
      { includeCurrent: 1 },
      { includeCurrent: 0 },
      { includeCurrent: null },
      { includeCurrent: [true] },
      { includeCurrent: true, accountId: OTHER_ACCOUNT_ID },
      { other: 1 },
      [],
      null,
      'text',
      7,
    ],
    startAccountSecurityMfaEnrollment: [
      {},
      { method: 'totp' },
      { method: 'SMS' },
      { method: ' TOTP' },
      { method: 1 },
      { method: ['TOTP'] },
      { method: 'TOTP', accountId: OTHER_ACCOUNT_ID },
      { method: 'TOTP', kcAction: 'CONFIGURE_TOTP' },
      [],
      null,
      'TOTP',
    ],
  };

  for (const route of POST_WITH_BODY) {
    it(`${route.method} ${route.url} rejects every wrongly typed, unknown-field, coerced or non-object body with VALIDATION_FAILED and never echoes the value`, async () => {
      for (const body of wrongBodies[route.id]!) {
        const res = await sendJson(`/api/v1/account/security${route.url}`, await webToken(), body);
        expectValidation(res, body);
      }
      expect(security[route.fn]).not.toHaveBeenCalled();
      expect(security.registerSession).not.toHaveBeenCalled();
      expect(security.revokeAllSessions).not.toHaveBeenCalled();
      expect(security.startMfaEnrollment).not.toHaveBeenCalled();
    });
  }

  it('a rejected registration never echoes the device secret nor the user agent', async () => {
    const res = await sendJson('/api/v1/account/security/sessions/current', await webToken(), { device: DEVICE_SECRET, userAgent: 5, extra: USER_AGENT });
    expectValidation(res, { device: DEVICE_SECRET, extra: USER_AGENT });
    expect(res.body).not.toContain(DEVICE_SECRET);
  });

  it('accepts a registration without a user agent and passes the device exactly (no trimming, no coercion)', async () => {
    const res = await call('POST', '/sessions/current', await webToken(), { device: DEVICE_SECRET });
    expect(res.statusCode, res.body).toBe(200);
    expect(security.registerSession).toHaveBeenCalledWith({ ...CURRENT, deviceSecret: DEVICE_SECRET }, { clientIp: '127.0.0.1' });
    expect(security.registerSession.mock.calls[0]![0].userAgent).toBeUndefined();
  });

  it('accepts a user agent of exactly 512 characters', async () => {
    const res = await call('POST', '/sessions/current', await webToken(), { device: DEVICE_SECRET, userAgent: 'u'.repeat(512) });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('revoke-all: includeCurrent defaults to false and true is passed through as the boolean true', async () => {
    expect((await call('POST', '/sessions/revoke-all', await webToken(), {})).statusCode).toBe(200);
    expect(security.revokeAllSessions).toHaveBeenLastCalledWith(CURRENT, { includeCurrent: false });
    expect((await call('POST', '/sessions/revoke-all', await webToken(), { includeCurrent: true })).statusCode).toBe(200);
    expect(security.revokeAllSessions).toHaveBeenLastCalledWith(CURRENT, { includeCurrent: true });
    expect((await call('POST', '/sessions/revoke-all', await webToken(), { includeCurrent: false })).statusCode).toBe(200);
    expect(security.revokeAllSessions).toHaveBeenLastCalledWith(CURRENT, { includeCurrent: false });
  });

  it.each(['TOTP', 'RECOVERY_CODES'] as const)('mfa enrollment accepts the method %s and returns the Keycloak action of the service', async (method) => {
    const res = await call('POST', '/mfa/enrollment', await webToken(), { method });
    expect(res.statusCode, res.body).toBe(200);
    expect(security.startMfaEnrollment).toHaveBeenLastCalledWith(CURRENT, method);
    expect(MfaEnrollmentResponse.parse(res.json()).data).toEqual({
      method,
      keycloakAction: method === 'TOTP' ? 'CONFIGURE_TOTP' : 'CONFIGURE_RECOVERY_AUTHN_CODES',
    });
  });

  it.each(POST_NO_BODY)('$method $url takes no body: none or {} is fine, anything else is a 400 and nothing is called', async (r) => {
    expect((await call(r.method, r.url, await webToken())).statusCode).toBe(200);
    expect((await call(r.method, r.url, await webToken(), {})).statusCode).toBe(200);
    expect(security[r.fn]).toHaveBeenCalledTimes(2);
    security[r.fn].mockClear();
    for (const body of [{ accountId: OTHER_ACCOUNT_ID }, { includeCurrent: true }, [], null, 'x', 7]) {
      const res = await sendJson(`/api/v1/account/security${r.url}`, await webToken(), body);
      expectValidation(res, body);
    }
    expect(security[r.fn]).not.toHaveBeenCalled();
  });

  it.each(POST_WITH_BODY)('$method $url rejects malformed JSON before the token is looked at (400 BAD_REQUEST)', async (r) => {
    for (const text of ['{"device": ', '{device: 1}', '']) {
      const res = await rawJson(`/api/v1/account/security${r.url}`, undefined, text);
      expect(res.statusCode, text).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
    }
    expect(noCalls()).toBe(true);
  });

  it('rejects a duplicate-key JSON body that hides an extra field behind the last value (the parsed object is what is validated, extras are 400)', async () => {
    const res = await rawJson('/api/v1/account/security/sessions/revoke-all', await webToken(), '{"includeCurrent":true,"includeCurrent":"yes"}');
    expectValidation(res);
  });
});

// ====================================================================== strict path and query parameters
describe('security API strict parameters', () => {
  const BAD_IDS = [
    'not-a-uuid',
    'current',
    'revoke-all',
    '00000000-0000-0000-0000-00000000000', // one character short
    `${SESSION_ID}0`,
    encodeURIComponent(` ${SESSION_ID}`),
    encodeURIComponent(`${SESSION_ID} `),
    encodeURIComponent(`{${SESSION_ID}}`),
    SESSION_ID.replace(/-/g, ''),
    '%00',
    '..%2f..%2fetc',
    '1',
    'null',
    'undefined',
  ];

  it.each([
    ['DELETE', '/sessions/', 'revokeSession'],
    ['DELETE', '/devices/', 'removeDevice'],
  ] as const)('%s %s<id> rejects anything that is not a UUID with 400 and never calls the service', async (method, prefix, fn) => {
    for (const id of BAD_IDS) {
      const res = await call(method, `${prefix}${id}`, await webToken());
      // a router-level rejection (an over-long or malformed component) uses the same envelope
      expect(res.statusCode, id).toBe(res.statusCode === 404 ? 404 : 400);
      if (res.statusCode === 400) expect(errorOf(res).category).toBe('VALIDATION');
      expect(res.body, id).not.toContain('etc/passwd');
    }
    expect(security[fn]).not.toHaveBeenCalled();
  });

  it('a path id failure is VALIDATION_FAILED naming the parameter and never its value', async () => {
    const res = await call('DELETE', '/sessions/definitely-not-a-uuid-marker', await webToken());
    expectValidation(res, 'definitely-not-a-uuid-marker');
    expect((errorOf(res).details as { issues: { path: string }[] }).issues[0]!.path).toBe('params.sessionId');
    expect(res.body).not.toContain('definitely-not-a-uuid-marker');
  });

  it('answers 401 before 400 for a bad id without a token, and 403 for the admin context', async () => {
    expect((await call('DELETE', '/sessions/not-a-uuid')).statusCode).toBe(401);
    expect((await call('DELETE', '/devices/not-a-uuid', 'bad.token')).statusCode).toBe(401);
    expect((await call('DELETE', '/sessions/not-a-uuid', await adminToken())).statusCode).toBe(403);
    expect(security.revokeSession).not.toHaveBeenCalled();
  });

  it('hands the service the lower-case canonical form of an upper-case UUID', async () => {
    await call('DELETE', `/sessions/${OTHER_SESSION_ID.toUpperCase()}`, await webToken());
    await call('DELETE', `/devices/${DEVICE_ID.toUpperCase()}`, await webToken());
    expect(security.revokeSession).toHaveBeenCalledWith(CURRENT, OTHER_SESSION_ID);
    expect(security.removeDevice).toHaveBeenCalledWith(CURRENT, DEVICE_ID);
  });

  it('does not route "current" or "revoke-all" to the id route: DELETE /devices/current/trust is the trust route, DELETE /sessions/current is a 400', async () => {
    expect((await call('DELETE', '/devices/current/trust', await webToken())).statusCode).toBe(200);
    expect(security.untrustCurrentDevice).toHaveBeenCalledTimes(1);
    expect(security.removeDevice).not.toHaveBeenCalled();
    expect((await call('DELETE', '/sessions/current', await webToken())).statusCode).toBe(400);
    expect(security.revokeSession).not.toHaveBeenCalled();
  });

  it('a session or a device of another account is whatever the service says (404 from the service), the API adds no pre-check', async () => {
    security.revokeSession.mockRejectedValueOnce(new AccountError('SESSION_NOT_FOUND', 'x', { sessionId: OTHER_SESSION_ID, accountId: OTHER_ACCOUNT_ID }));
    const res = await call('DELETE', `/sessions/${OTHER_SESSION_ID}`, await webToken());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({
      category: 'NOT_FOUND',
      code: 'ACCOUNT_SESSION_NOT_FOUND',
      details: { messageKey: securityErrorMessageKey('SESSION_NOT_FOUND') },
    });
    expect(res.body).not.toContain(OTHER_SESSION_ID);
    expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
  });

  describe('GET /activity query', () => {
    const activity = (qs: string, token?: string) => call('GET', `/activity${qs}`, token);

    it.each(['0', '101', '-1', '+5', '05', '1e3', '0x10', '1.0', '25.5', '', ' 5', '5 ', 'abc', 'Infinity', 'NaN', '1,5', '9999999999999999999', '１２'])(
      'rejects limit=%j with a field-level VALIDATION_FAILED and never echoes it',
      async (limit) => {
        const res = await activity(`?limit=${encodeURIComponent(limit)}`, await webToken());
        expect(res.statusCode, limit).toBe(400);
        expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
        if (limit.length > 2) expect(res.body).not.toContain(limit);
        expect(security.listActivity).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['1', 1],
      ['25', 25],
      ['100', 100],
    ])('accepts limit=%s and passes the integer %d', async (text, value) => {
      const res = await activity(`?limit=${text}`, await webToken());
      expect(res.statusCode, res.body).toBe(200);
      expect(security.listActivity).toHaveBeenLastCalledWith(ACCOUNT_ID, { limit: value });
    });

    it('rejects a repeated limit and a repeated before', async () => {
      expect((await activity('?limit=1&limit=2', await webToken())).statusCode).toBe(400);
      expect((await activity(`?before=${ISO}&before=${ISO}`, await webToken())).statusCode).toBe(400);
      expect(security.listActivity).not.toHaveBeenCalled();
    });

    it.each([
      '',
      'yesterday',
      '2026-02-03',
      '2026-02-03T04:05:06',
      '2026-02-30T04:05:06Z',
      '2026-13-03T04:05:06Z',
      '2026-02-03T25:05:06Z',
      '2026-02-03T04:60:06Z',
      '2026-02-03 04:05:06Z',
      '1700000000',
      '2026-02-03T04:05:06Z; DROP TABLE x',
      '2026-02-03T04:05:06.1234567Z',
      `${ISO}${'0'.repeat(30)}`,
      '＜script＞',
      // the composite cursor: the tie-breaker must be a well-formed uuid after exactly one underscore on a valid instant
      `${ISO}_`,
      `${ISO}_not-a-uuid`,
      `${ISO}_${EVENT_ID.slice(1)}`,
      `${ISO}_${EVENT_ID}0`,
      `${ISO}_${EVENT_ID.replace(/-/g, '')}`,
      `${ISO}__${EVENT_ID}`,
      `${ISO}_${EVENT_ID}_${EVENT_ID}`,
      `${ISO}_${EVENT_ID}; DROP TABLE x`,
      `_${EVENT_ID}`,
      `2026-02-30T04:05:06Z_${EVENT_ID}`,
      `2026-02-03T04:05:06_${EVENT_ID}`,
      `${ISO}-${EVENT_ID}`,
      `${ISO}_${EVENT_ID.replace('a', 'g')}`,
      `${ISO} ${EVENT_ID}`,
      `${ISO}_ ${EVENT_ID}`,
    ])('rejects before=%j', async (before) => {
      const res = await activity(`?before=${encodeURIComponent(before)}`, await webToken());
      expect(res.statusCode, before).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(res.body).not.toContain('DROP TABLE');
      expect(security.listActivity).not.toHaveBeenCalled();
    });

    it.each([
      ISO,
      '2026-02-03T04:05:06Z',
      '2026-02-03T04:05:06.123456Z',
      '2026-02-03T04:05:06+02:00',
      '2024-02-29T00:00:00.000Z',
      `${ISO}_${EVENT_ID}`,
      `2026-02-03T04:05:06.123456Z_${EVENT_ID}`,
      `2026-02-03T04:05:06.123456Z_${EVENT_ID.toUpperCase()}`,
      `2026-02-03T04:05:06+02:00_${EVENT_ID}`,
    ])('accepts before=%s and passes it unchanged', async (before) => {
      const res = await activity(`?before=${encodeURIComponent(before)}&limit=10`, await webToken());
      expect(res.statusCode, res.body).toBe(200);
      expect(security.listActivity).toHaveBeenLastCalledWith(ACCOUNT_ID, { limit: 10, before });
    });

    it('rejects unknown query parameters, in particular an account id, and never uses them', async () => {
      for (const qs of [`?accountId=${OTHER_ACCOUNT_ID}`, `?account_id=${OTHER_ACCOUNT_ID}`, '?sessionId=x', '?x', `?limit=5&userId=${OTHER_ACCOUNT_ID}`]) {
        const res = await activity(qs, await webToken());
        expect(res.statusCode, qs).toBe(400);
        expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
      }
      expect(security.listActivity).not.toHaveBeenCalled();
    });

    it('answers 401 before 400 and 403 for the admin context', async () => {
      expect((await activity('?limit=0')).statusCode).toBe(401);
      expect((await activity('?limit=0', 'bad.token')).statusCode).toBe(401);
      expect((await activity('?limit=0', await adminToken())).statusCode).toBe(403);
      expect(security.listActivity).not.toHaveBeenCalled();
    });

    it('rejects query parameters on the other read routes (no account id can ride along)', async () => {
      for (const path of ['/', '/sessions', '/devices']) {
        const res = await call('GET', `${path === '/' ? '' : path}?accountId=${OTHER_ACCOUNT_ID}`, await webToken());
        expect(res.statusCode, path).toBe(400);
      }
    });
  });

  it('isActivityCursor accepts an instant, optionally with _ and a uuid, and nothing else', () => {
    expect(isActivityCursor(`${ISO}_${EVENT_ID}`)).toBe(true);
    expect(isActivityCursor(ISO)).toBe(true);
    expect(isActivityCursor(`${ISO}_x`)).toBe(false);
    expect(isActivityCursor(`${ISO}_${EVENT_ID}`.repeat(2))).toBe(false);
    expect(isActivityCursor(undefined)).toBe(false);
    expect(isActivityCursor(5)).toBe(false);
  });

  it('isIsoInstant is a real calendar check', () => {
    expect(isIsoInstant('2026-02-30T00:00:00Z')).toBe(false);
    expect(isIsoInstant('2025-02-29T00:00:00Z')).toBe(false);
    expect(isIsoInstant('2024-02-29T00:00:00Z')).toBe(true);
    expect(isIsoInstant(20260203)).toBe(false);
    expect(isIsoInstant(undefined)).toBe(false);
  });
});

// ====================================================================== no route accepts an account id
describe('security API: the account always comes from the verified token', () => {
  it.each(ROUTES)('$method $url ignores account ids offered in headers and cookies and hands the service only the token account', async (r) => {
    const res = await routeCall(r, await webToken(), {
      'x-account-id': OTHER_ACCOUNT_ID,
      'x-user-id': OTHER_ACCOUNT_ID,
      'x-subject': OTHER_SUB,
      cookie: `accountId=${OTHER_ACCOUNT_ID}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(security[r.fn].mock.calls[0]).toEqual(r.args);
    for (const c of security[r.fn].mock.calls) expect(raw(c)).not.toContain(OTHER_ACCOUNT_ID);
    expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
  });

  it.each(POST_WITH_BODY)('$method $url rejects an account id in the body (strict)', async (r) => {
    const body = { ...(r.body as object), accountId: OTHER_ACCOUNT_ID };
    expectValidation(await call(r.method, r.url, await webToken(), body), body);
    expect(security[r.fn]).not.toHaveBeenCalled();
  });

  it('the generated OpenAPI document has no account id, subject, Keycloak session id or token in any parameter or request body of the security routes', async () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; requestBody?: unknown; operationId?: string }>>;
    };
    let operations = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!path.includes('/account/security') && !path.includes('/auth/password-reset')) continue;
      for (const op of Object.values(item)) {
        operations += 1;
        const request = raw({ parameters: op.parameters ?? [], requestBody: op.requestBody });
        for (const word of ['accountId', 'account_id', 'subject', 'userId', 'keycloakSessionId', 'sid', 'token'])
          expect(request, `${op.operationId} ${word}`).not.toContain(`"${word}"`);
        for (const p of op.parameters ?? []) expect(['sessionId', 'deviceId', 'limit', 'before']).toContain(p.name);
      }
    }
    expect(operations).toBe(ROUTES.length + 1);
  });
});

// ====================================================================== the error mapping of the security codes
describe('security API error mapping', () => {
  const LEAKY = {
    sessionId: OTHER_SESSION_ID,
    deviceId: DEVICE_ID,
    accountId: OTHER_ACCOUNT_ID,
    keycloakSessionId: KEYCLOAK_SID,
    cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM identity.accounts',
    constraint: 'uq_application_sessions__keycloak_session',
    reason: 'SOME_REASON',
  };
  const LEAKS = [...Object.values(LEAKY), 'ECONNREFUSED', 'SELECT', 'identity.accounts', 'constraint', 'cause'];
  const err = (code: ConstructorParameters<typeof AccountError>[0]) => new AccountError(code, `${code} service text with ${OTHER_SESSION_ID}`, LEAKY);

  const cases: { code: Parameters<typeof err>[0]; status: number; category: string; apiCode: string; message: string; route: string }[] = [
    {
      code: 'SESSION_NOT_FOUND',
      status: 404,
      category: 'NOT_FOUND',
      apiCode: 'ACCOUNT_SESSION_NOT_FOUND',
      message: 'The session was not found',
      route: 'revokeSession',
    },
    {
      code: 'DEVICE_NOT_FOUND',
      status: 404,
      category: 'NOT_FOUND',
      apiCode: 'ACCOUNT_DEVICE_NOT_FOUND',
      message: 'The browser was not found',
      route: 'removeDevice',
    },
    {
      code: 'DEVICE_REQUIRED',
      status: 409,
      category: 'CONFLICT',
      apiCode: 'ACCOUNT_DEVICE_REQUIRED',
      message: 'This session has no registered browser',
      route: 'trustCurrentDevice',
    },
    {
      code: 'SECURITY_UNAVAILABLE',
      status: 503,
      category: 'DEPENDENCY',
      apiCode: 'ACCOUNT_SECURITY_UNAVAILABLE',
      message: 'The security service is temporarily unavailable',
      route: 'listSessions',
    },
  ];
  const routeOf = (fn: string) => ROUTES.find((r) => r.fn === fn)!;

  it.each(cases)('maps $code to $status $apiCode with a fixed message, only the managed message key as details, and no internals', async (c) => {
    security[routeOf(c.route).fn].mockRejectedValueOnce(err(c.code));
    const res = await routeCall(routeOf(c.route), await webToken());
    expect(res.statusCode).toBe(c.status);
    expect(errorOf(res)).toMatchObject({ category: c.category, code: c.apiCode, message: c.message });
    expect(errorOf(res).details).toEqual(
      c.code === 'SECURITY_UNAVAILABLE'
        ? { retryable: true, messageKey: securityErrorMessageKey(c.code) }
        : { messageKey: securityErrorMessageKey(c.code as 'SESSION_NOT_FOUND') },
    );
    for (const leak of LEAKS) expect(res.body, leak).not.toContain(leak);
    expect(header(res, 'cache-control')).toBe('no-store');
  });

  it.each([
    ['SESSION_NOT_FOUND', 'listSessions'],
    ['DEVICE_NOT_FOUND', 'listDevices'],
    ['SECURITY_UNAVAILABLE', 'removeDevice'],
    ['DEVICE_REQUIRED', 'untrustCurrentDevice'],
    ['DEVICE_REQUIRED', 'registerSession'],
  ] as const)('maps %s on any route that calls the service (here %s)', async (code, fn) => {
    security[fn].mockRejectedValueOnce(err(code));
    const res = await routeCall(routeOf(fn), await webToken());
    expect(errorOf(res).code).toBe(`ACCOUNT_${code}`);
    for (const leak of LEAKS) expect(res.body, leak).not.toContain(leak);
  });

  it('maps a database outage and an unexpected failure of a route operation to generic answers', async () => {
    security.listDevices.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'x', { cause: LEAKY.cause }));
    const out = await call('GET', '/devices', await webToken());
    expect(out.statusCode).toBe(503);
    expect(errorOf(out)).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
    expect(out.body).not.toContain('ECONNREFUSED');
    security.listDevices.mockRejectedValueOnce(new Error('boom: password=hunter2 identity.accounts'));
    const bug = await call('GET', '/devices', await webToken());
    expect(bug.statusCode).toBe(500);
    expect(errorOf(bug)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
    expect(bug.body).not.toContain('hunter2');
  });
});

// ====================================================================== the step-up guards
describe('security API: step-up (RFC 9470)', () => {
  const GUARDED = ROUTES.filter((r) => r.guarded);
  const RECENT =
    'Bearer realm="bananagig", error="insufficient_user_authentication", error_description="A more recent or stronger authentication is required", max_age="900"';
  const now = () => Math.floor(Date.now() / 1000);

  it('guards exactly the trust route and the enrollment route (and no other)', () => {
    expect(GUARDED.map((r) => r.id).sort()).toEqual(['startAccountSecurityMfaEnrollment', 'trustCurrentAccountSecurityDevice']);
  });

  it.each(GUARDED)('$method $url answers 401 STEP_UP_REQUIRED with the RFC 9470 challenge when auth_time is missing', async (r) => {
    const res = await routeCall(r, await signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID } }));
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'STEP_UP_REQUIRED' });
    expect(header(res, 'www-authenticate')).toBe(RECENT);
    expect(StepUpDetails.parse(errorOf(res).details)).toEqual({ requirement: 'RECENT_AUTHENTICATION', maxAgeSeconds: 900 });
    expect(errorOf(res).details).toEqual({ requirement: 'RECENT_AUTHENTICATION', maxAgeSeconds: 900, messageKey: 'account.security.error.step_up_required' });
    expect(header(res, 'cache-control')).toBe('no-store');
    expect(security[r.fn]).not.toHaveBeenCalled();
  });

  it.each(GUARDED)('$method $url: an authentication older than the window is refused, one inside it passes (boundary at max_age)', async (r) => {
    expect((await routeCall(r, await webToken({ authTimeAgoSec: 901 }))).statusCode).toBe(401);
    expect((await routeCall(r, await webToken({ authTimeAgoSec: 100000 }))).statusCode).toBe(401);
    expect(security[r.fn]).not.toHaveBeenCalled();
    expect((await routeCall(r, await webToken({ authTimeAgoSec: 890 }))).statusCode).toBe(200);
    expect((await routeCall(r, await webToken({ authTimeAgoSec: 0 }))).statusCode).toBe(200);
    expect(security[r.fn]).toHaveBeenCalledTimes(2);
  });

  it.each(GUARDED)('$method $url: an auth_time far in the future is not recent (clock skew is tolerated, forgery is not)', async (r) => {
    expect((await routeCall(r, await webToken({ authTime: now() + 3600 }))).statusCode).toBe(401);
    expect((await routeCall(r, await webToken({ authTime: now() + 10 }))).statusCode).toBe(200);
  });

  it.each(GUARDED)('$method $url: the window comes from the configuration read per request, never from code', async (r) => {
    security.getPolicy.mockResolvedValue({ ...POLICY, stepUpValidMinutes: 1 });
    const stale = await routeCall(r, await webToken({ authTimeAgoSec: 120 }));
    expect(stale.statusCode).toBe(401);
    expect(StepUpDetails.parse(errorOf(stale).details).maxAgeSeconds).toBe(60);
    expect(header(stale, 'www-authenticate')).toContain('max_age="60"');
    security.getPolicy.mockResolvedValue({ ...POLICY, stepUpValidMinutes: 60 });
    expect((await routeCall(r, await webToken({ authTimeAgoSec: 3000 }))).statusCode).toBe(200);
    expect(security.getPolicy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(GUARDED)('$method $url: an unreadable configuration fails closed with 503 and the operation is not performed', async (r) => {
    security.getPolicy.mockRejectedValue(new AccountError('UNAVAILABLE', 'configuration down', { cause: 'ECONNREFUSED' }));
    const res = await routeCall(r, await webToken());
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE' });
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(security[r.fn]).not.toHaveBeenCalled();
  });

  it.each(GUARDED)(
    '$method $url: a step-up never depends on `acr` (a password login is enough for RECENT_AUTHENTICATION) and a trusted browser never replaces it',
    async (r) => {
      security.isDeviceTrusted.mockResolvedValue(true);
      security.observeSession.mockResolvedValue({ applicationSessionId: SESSION_ID, accountDeviceId: DEVICE_ID, created: false });
      expect((await routeCall(r, await webToken({ acr: ACR_PASSWORD, authTimeAgoSec: 5000 }))).statusCode).toBe(401);
      expect((await routeCall(r, await webToken({ acr: ACR_PASSWORD, authTimeAgoSec: 5 }))).statusCode).toBe(200);
    },
  );

  it.each(GUARDED)('$method $url: 401 and 403 win over the step-up (no token, invalid token, admin context, revoked session)', async (r) => {
    const stale = await webToken({ authTimeAgoSec: 100000 });
    expect(errorOf(await routeCall(r)).code).toBe('AUTHENTICATION_REQUIRED');
    expect(errorOf(await routeCall(r, 'bad.token')).code).toBe('INVALID_TOKEN');
    expect((await routeCall(r, await adminToken())).statusCode).toBe(403);
    security.observeSession.mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'));
    expect(errorOf(await routeCall(r, stale)).code).toBe('SESSION_REVOKED');
  });

  it('the step-up is checked before the body: a stale authentication with an invalid body is 401, a fresh one with an invalid body is 400', async () => {
    const bad = { method: 'sms', extra: true };
    expect((await call('POST', '/mfa/enrollment', await webToken({ authTimeAgoSec: 100000 }), bad)).statusCode).toBe(401);
    expect((await call('POST', '/mfa/enrollment', await webToken({ authTimeAgoSec: 5 }), bad)).statusCode).toBe(400);
    expect((await call('POST', '/devices/current/trust', await webToken({ authTimeAgoSec: 100000 }), bad)).statusCode).toBe(401);
    expect((await call('POST', '/devices/current/trust', await webToken({ authTimeAgoSec: 5 }), bad)).statusCode).toBe(400);
  });

  it('a spoofed acr or auth_time in a header, a cookie, a body or a query changes nothing: only the verified claims count', async () => {
    const stale = await webToken({ authTimeAgoSec: 100000, acr: ACR_PASSWORD });
    const res = await send('POST', `/api/v1/account/security/devices/current/trust?auth_time=${now()}&acr=${ACR_MFA}`, stale, undefined, {
      'x-auth-time': String(now()),
      'x-acr': ACR_MFA,
      cookie: `auth_time=${now()}`,
    });
    expect(res.statusCode).toBe(401);
    expect(security.trustCurrentDevice).not.toHaveBeenCalled();
  });

  it('lets the other routes through without any step-up, however old the authentication is', async () => {
    const stale = await webToken({ authTimeAgoSec: 1_000_000 });
    for (const r of ROUTES.filter((x) => !x.guarded)) expect((await routeCall(r, stale)).statusCode, r.id).toBe(200);
  });

  describe('requireMfa and requireStepUp', () => {
    const probe = (path: string, token: string) => send('GET', `/probe/${path}`, token, undefined, {}, guardApp);
    const MFA_CHALLENGE = `${RECENT}, acr_values="${ACR_MFA}"`;

    it('lets an MFA authentication within the window through without asking the identity provider', async () => {
      const res = await probe('mfa', await webToken({ acr: ACR_MFA, authTimeAgoSec: 20 }));
      expect(res.statusCode, res.body).toBe(200);
      expect(security.hasMfaEnrolled).not.toHaveBeenCalled();
    });

    it('asks for a second factor when the login used a password only and one is enrolled: 401 with acr_values', async () => {
      security.hasMfaEnrolled.mockResolvedValue(true);
      const res = await probe('mfa', await webToken({ acr: ACR_PASSWORD, authTimeAgoSec: 20 }));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'STEP_UP_REQUIRED' });
      expect(header(res, 'www-authenticate')).toBe(MFA_CHALLENGE);
      expect(StepUpDetails.parse(errorOf(res).details)).toEqual({ requirement: 'MFA', maxAgeSeconds: 900, acrValues: ACR_MFA });
      expect(security.hasMfaEnrolled).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    it('asks for a fresh MFA authentication when the old one included a second factor but is no longer recent', async () => {
      const res = await probe('mfa', await webToken({ acr: ACR_MFA, authTimeAgoSec: 5000 }));
      expect(res.statusCode).toBe(401);
      expect(header(res, 'www-authenticate')).toBe(MFA_CHALLENGE);
      expect(StepUpDetails.parse(errorOf(res).details).requirement).toBe('MFA');
    });

    it('answers 403 MFA_ENROLLMENT_REQUIRED when no second factor is enrolled (a step-up that cannot succeed is not requested)', async () => {
      security.hasMfaEnrolled.mockResolvedValue(false);
      const res = await probe('mfa', await webToken({ acr: ACR_PASSWORD }));
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({
        category: 'AUTHORIZATION',
        code: 'MFA_ENROLLMENT_REQUIRED',
        details: { messageKey: authSecurityErrorMessageKey('MFA_ENROLLMENT_REQUIRED') },
      });
      expect(res.headers['www-authenticate']).toBeUndefined();
    });

    it('fails closed with 503 ACCOUNT_SECURITY_UNAVAILABLE when the identity provider cannot be asked (null or a failure)', async () => {
      security.hasMfaEnrolled.mockResolvedValue(null);
      const res = await probe('mfa', await webToken({ acr: ACR_PASSWORD }));
      expect(res.statusCode).toBe(503);
      expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_SECURITY_UNAVAILABLE' });
      expect(res.headers['www-authenticate']).toBeUndefined();
      security.hasMfaEnrolled.mockRejectedValue(new AccountError('SECURITY_UNAVAILABLE', 'down', { cause: 'ECONNREFUSED' }));
      const again = await probe('mfa', await webToken({ acr: ACR_PASSWORD }));
      expect(again.statusCode).toBe(503);
      expect(again.body).not.toContain('ECONNREFUSED');
    });

    it.each(['bananagig:MFA', 'bananagig:mfa ', ' bananagig:mfa', 'mfa', 'bananagig:mfa,bananagig:password', '2', 'urn:mfa'])(
      'does not treat the acr %j as a second factor',
      async (acr) => {
        security.hasMfaEnrolled.mockResolvedValue(true);
        const res = await probe('mfa', await webToken({ acr, authTimeAgoSec: 10 }));
        expect(res.statusCode, acr).toBe(401);
      },
    );

    it('treats a token without acr as password-only', async () => {
      security.hasMfaEnrolled.mockResolvedValue(true);
      const res = await probe('mfa', await signToken(keys, { omit: ['acr'], authTimeAgoSec: 10, claims: { sub: SUB, sid: KEYCLOAK_SID } }));
      expect(res.statusCode).toBe(401);
      expect(StepUpDetails.parse(errorOf(res).details).requirement).toBe('MFA');
    });

    it('requireStepUp dispatches by requirement', async () => {
      security.hasMfaEnrolled.mockResolvedValue(true);
      const password = await webToken({ acr: ACR_PASSWORD, authTimeAgoSec: 10 });
      expect((await probe('step-up-recent', password)).statusCode).toBe(200);
      const mfa = await probe('step-up-mfa', password);
      expect(mfa.statusCode).toBe(401);
      expect(StepUpDetails.parse(errorOf(mfa).details).requirement).toBe('MFA');
      expect((await probe('step-up-mfa', await webToken({ acr: ACR_MFA, authTimeAgoSec: 10 }))).statusCode).toBe(200);
    });

    it('requireRecentAuthentication on the probe behaves like the real routes', async () => {
      expect((await probe('recent', await webToken({ authTimeAgoSec: 10 }))).statusCode).toBe(200);
      const stale = await probe('recent', await webToken({ authTimeAgoSec: 5000 }));
      expect(stale.statusCode).toBe(401);
      expect(header(stale, 'www-authenticate')).toBe(RECENT);
    });

    it.each(['bare-recent', 'bare-mfa', 'bare-step-up-mfa', 'bare-step-up-recent'])(
      'the guard on %s authenticates and refuses the admin and any other client context itself (403 ACCOUNT_CONTEXT_NOT_SUPPORTED), before any step-up or provider call',
      async (path) => {
        for (const token of [await adminToken(), await webToken({ claims: { azp: 'other' } })]) {
          const res = await probe(path, token);
          expect(res.statusCode, path).toBe(403);
          expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
          expect(res.headers['www-authenticate']).toBeUndefined();
        }
        expect(security.hasMfaEnrolled).not.toHaveBeenCalled();
        const none = await send('GET', `/probe/${path}`, undefined, undefined, {}, guardApp);
        expect(errorOf(none).code).toBe('AUTHENTICATION_REQUIRED');
      },
    );

    it('a guard used alone works for a web token (recent passes, stale is the step-up challenge)', async () => {
      expect((await probe('bare-recent', await webToken({ authTimeAgoSec: 10 }))).statusCode).toBe(200);
      expect((await probe('bare-recent', await webToken({ authTimeAgoSec: 5000 }))).statusCode).toBe(401);
      expect((await probe('bare-step-up-mfa', await webToken({ acr: ACR_MFA, authTimeAgoSec: 10 }))).statusCode).toBe(200);
      // MFA without requireAccount has no account to ask the provider about: a programming error, never a pass
      expect((await probe('bare-mfa', await webToken({ acr: ACR_PASSWORD, authTimeAgoSec: 10 }))).statusCode).toBe(500);
    });

    it('a route with requireAccount only has no step-up', async () => {
      expect((await probe('account-only', await webToken({ authTimeAgoSec: 1_000_000 }))).statusCode).toBe(200);
    });

    it('the challenge is a single well-formed Bearer header whose parameters are quoted and contain no control characters', async () => {
      security.hasMfaEnrolled.mockResolvedValue(true);
      const res = await probe('mfa', await webToken({ acr: ACR_PASSWORD }));
      const challenge = header(res, 'www-authenticate');
      expect(challenge).toMatch(
        /^Bearer realm="bananagig", error="insufficient_user_authentication", error_description="[^"\r\n]+", max_age="\d+", acr_values="[^"\r\n]+"$/,
      );
      expect(Array.isArray(res.headers['www-authenticate'])).toBe(false);
    });
  });
});

// ====================================================================== the device id reaches the abuse limits of the email and phone routes
describe('security API: the device id in the email and phone request contexts (DEBT-0054)', () => {
  const emailDetail = { emailVerificationStatus: 'NONE', primary: null, pending: null };
  it('adds the application device of the session to the email and phone request contexts, and omits it when the session has none', async () => {
    emailSvc.setEmail.mockResolvedValue({ changed: true, email: emailDetail });
    phoneSvc.setPhone.mockResolvedValue({ changed: true, phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null } });
    security.observeSession.mockResolvedValue({ applicationSessionId: SESSION_ID, accountDeviceId: DEVICE_ID, created: false });
    await send('POST', '/api/v1/account/email', await webToken(), { email: 'a@example.com' });
    await send('POST', '/api/v1/account/phone', await webToken(), { phone: '+12025550142' });
    expect(emailSvc.setEmail.mock.calls[0]![2]).toEqual({ clientIp: '127.0.0.1', deviceId: DEVICE_ID });
    expect(phoneSvc.setPhone.mock.calls[0]![2]).toEqual({ country: undefined, clientIp: '127.0.0.1', deviceId: DEVICE_ID });
    security.observeSession.mockResolvedValue({ applicationSessionId: SESSION_ID, accountDeviceId: null, created: false });
    await send('POST', '/api/v1/account/email', await webToken(), { email: 'a@example.com' });
    await send('POST', '/api/v1/account/phone', await webToken(), { phone: '+12025550142' });
    expect(emailSvc.setEmail.mock.calls[1]![2]).toEqual({ clientIp: '127.0.0.1' });
    expect('deviceId' in (emailSvc.setEmail.mock.calls[1]![2] as object)).toBe(false);
    expect('deviceId' in (phoneSvc.setPhone.mock.calls[1]![2] as object)).toBe(false);
  });

  it('passes the same device to the registration call (the device dimension of the abuse limits)', async () => {
    security.observeSession.mockResolvedValue({ applicationSessionId: SESSION_ID, accountDeviceId: DEVICE_ID, created: false });
    await call('POST', '/sessions/current', await webToken(), { device: DEVICE_SECRET });
    expect(security.registerSession.mock.calls[0]![1]).toEqual({ clientIp: '127.0.0.1', deviceId: DEVICE_ID });
  });
});

// ====================================================================== the PUBLIC password-reset request
describe('POST /api/v1/auth/password-reset (public)', () => {
  const URL = '/api/v1/auth/password-reset';
  const reset = (body: unknown, headers: Record<string, string> = {}) => sendJson(URL, undefined, body, { 'x-correlation-id': 'reset-corr-0001', ...headers });
  const EMAILS = [
    'someone@example.com', // an account exists
    'nobody-at-all@example.com', // no account
    'SomeOne@Example.COM', // other case
    ' someone@example.com ', // padded
    'not-an-email', // not a valid address
    '', // empty
    'a@b', // no TLD
    'ünï@exämple.com', // unicode
    '"quoted"@example.com',
    `${'a'.repeat(64)}@${'b'.repeat(60)}.com`,
    'x'.repeat(320), // exactly the maximum length
    'closed-account@example.com', // a closed or suspended account
    '<script>alert(1)</script>@example.com',
    "robert'); DROP TABLE accounts;--@example.com",
  ];

  it('answers EVERY input class with the same status and byte-identical body (given the same correlation id) and never echoes the address', async () => {
    const answers = [];
    for (const email of EMAILS) {
      const res = await reset({ email });
      answers.push(res);
      expect(res.statusCode, email).toBe(202);
      expect(res.body, email).toBe(answers[0]!.body);
      expect(PasswordResetAcceptedResponse.parse(res.json())).toEqual({ data: { accepted: true }, meta: { correlationId: 'reset-corr-0001' } });
      if (email.length > 3) expect(res.body).not.toContain(email.trim());
      expect(header(res, 'cache-control')).toBe('no-store');
      expect(header(res, 'content-type')).toContain('application/json');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.headers['retry-after']).toBeUndefined();
    }
    expect(security.requestPasswordReset).toHaveBeenCalledTimes(EMAILS.length);
    expect(new Set(answers.map((a) => raw(Object.keys(a.headers).sort()))).size).toBe(1);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
  });

  it('hands the service the address exactly as sent (the service canonicalizes) and the trusted-hop client address, nothing else', async () => {
    await reset({ email: 'SomeOne@Example.COM ' });
    expect(security.requestPasswordReset).toHaveBeenCalledWith('SomeOne@Example.COM ', { clientIp: '127.0.0.1' });
    expect(security.requestPasswordReset.mock.calls[0]).toHaveLength(2);
  });

  it('uses the address Fastify resolves from the trusted proxy hops, never a client-chosen X-Forwarded-For entry (TRUSTED_PROXY_HOPS is 1 in test: the last entry)', async () => {
    await reset({ email: 'a@example.com' }, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' });
    expect(security.requestPasswordReset.mock.calls[0]![1]).toEqual({ clientIp: '203.0.113.7' });
  });

  it('needs no token and no account: an Authorization header is ignored (valid, expired or garbage), and the account service is never called', async () => {
    for (const authorization of [
      `Bearer ${await webToken()}`,
      `Bearer ${await signToken(keys, { expiresInSec: -3600 })}`,
      'Bearer garbage',
      'Basic dXNlcjpwYXNz',
    ]) {
      const res = await reset({ email: 'a@example.com' }, { authorization });
      expect(res.statusCode, authorization.slice(0, 12)).toBe(202);
      expect(res.body).toBe((await reset({ email: 'a@example.com' })).body);
    }
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
    expect(security.observeSession).not.toHaveBeenCalled();
  });

  it('a verified token changes nothing in the answer, and the request is not attributed to the token account', async () => {
    const anonymous = await reset({ email: 'a@example.com' });
    const signedIn = await reset({ email: 'a@example.com' }, { authorization: `Bearer ${await webToken()}` });
    expect(signedIn.body).toBe(anonymous.body);
    for (const c of security.requestPasswordReset.mock.calls) expect(raw(c)).not.toContain(ACCOUNT_ID);
  });

  it('does not wait on or reflect anything the service decides for an accepted request, including a service that resolves with a value', async () => {
    security.requestPasswordReset.mockResolvedValueOnce({ sent: true, accountId: ACCOUNT_ID, subject: SUB } as never);
    const res = await reset({ email: 'someone@example.com' });
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain(ACCOUNT_ID);
    expect(res.body).not.toContain(SUB);
    expect(res.body).toBe((await reset({ email: 'nobody@example.com' })).body);
  });

  it.each([
    {},
    { email: 123 },
    { email: null },
    { email: ['a@example.com'] },
    { email: { value: 'a@example.com' } },
    { email: true },
    { email: 'a@example.com', accountId: OTHER_ACCOUNT_ID },
    { email: 'a@example.com', extra: 1 },
    { email: 'a'.repeat(321) },
    { Email: 'a@example.com' },
    [],
    'a@example.com',
    7,
    null,
  ])('rejects the body %j with VALIDATION_FAILED, calls nothing and echoes nothing', async (body) => {
    const res = await reset(body);
    expectValidation(res, body);
    expect(security.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and an over-large body (400, standard envelope)', async () => {
    const malformed = await rawJson(URL, undefined, '{"email": ');
    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed).code).toBe('BAD_REQUEST');
    const big = await reset({ email: 'a@example.com', padding: 'x'.repeat(5000) });
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
    expect(big.statusCode).toBeLessThan(500);
    expect(security.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('is a POST only (GET, PUT and DELETE are 404) and takes no query parameters into account', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) expect((await send(method, URL)).statusCode, method).toBe(404);
    const res = await sendJson(`${URL}?email=a@example.com&accountId=${OTHER_ACCOUNT_ID}`, undefined, { email: 'b@example.com' });
    expect(res.statusCode).toBe(202);
    expect(security.requestPasswordReset.mock.calls[0]![0]).toBe('b@example.com');
  });

  it('answers 429 with Retry-After and a fixed body that names no dimension, whatever the limiter says', async () => {
    security.requestPasswordReset.mockRejectedValueOnce(
      new AccountError('PASSWORD_RESET_RATE_LIMITED', 'rule password-reset:email for a@example.com', {
        retryAfterSeconds: 1800,
        dimension: 'email',
        rule: 'password-reset:email',
        email: 'a@example.com',
      }),
    );
    const res = await reset({ email: 'a@example.com' });
    expect(res.statusCode).toBe(429);
    expect(errorOf(res)).toMatchObject({
      category: 'RATE_LIMIT',
      code: 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED',
      message: 'Too many password reset requests',
      details: { retryAfterSeconds: 1800, messageKey: 'account.security.error.password_reset_rate_limited' },
    });
    expect(header(res, 'retry-after')).toBe('1800');
    for (const leak of ['dimension', 'password-reset:email', 'a@example.com', 'rule']) expect(res.body, leak).not.toContain(leak);
    expect(header(res, 'cache-control')).toBe('no-store');
  });

  it.each([undefined, -5, 1.5, '30', NaN, null])('omits Retry-After when the wait is not a non-negative integer (%j)', async (wait) => {
    security.requestPasswordReset.mockRejectedValueOnce(new AccountError('PASSWORD_RESET_RATE_LIMITED', 'x', { retryAfterSeconds: wait }));
    const res = await reset({ email: 'a@example.com' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(errorOf(res).details).toEqual({ messageKey: 'account.security.error.password_reset_rate_limited' });
  });

  it('fails closed with 503 when the limit cannot be applied (the limiter is down), without internals', async () => {
    security.requestPasswordReset.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'valkey down', { cause: 'ECONNREFUSED 10.0.0.5:6379' }));
    const res = await reset({ email: 'a@example.com' });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE' });
    expect(res.body).not.toContain('10.0.0.5');
    expect(res.body).not.toContain('a@example.com');
  });

  it('turns an unexpected failure into the generic 500 with nothing from the request or the cause', async () => {
    security.requestPasswordReset.mockRejectedValueOnce(new Error('smtp password=hunter2 for a@example.com'));
    const res = await reset({ email: 'a@example.com' });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('a@example.com');
  });

  it('is public in OpenAPI (security: []) and documents 202, 400, 429 and 503', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown>; operationId: string }>>;
    };
    const op = doc.paths['/api/v1/auth/password-reset']!.post!;
    expect(op.operationId).toBe('requestPasswordReset');
    expect(op.security).toEqual([]);
    expect(Object.keys(op.responses).sort()).toEqual(['202', '400', '429', '503']);
  });
});

// ====================================================================== wiring and contracts
describe('security API wiring and generated contracts', () => {
  it('without the security service nothing about sessions is registered and requireAccount behaves as before', async () => {
    const plain = await buildApp({ cfg, verifier, configuration: {} as never, accounts: accountSvc as unknown as AccountService, readiness: async () => ({}) });
    await plain.ready();
    const doc = plain.swagger() as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).filter((p) => p.includes('/security') || p.includes('password-reset'))).toEqual([]);
    // a token without sid is fine here, and no session is observed
    const res = await send('GET', '/api/v1/account/me', await signToken(keys, { omit: ['sid'], claims: { sub: SUB } }), undefined, {}, plain);
    expect(res.statusCode, res.body).toBe(200);
    expect((await send('POST', '/api/v1/auth/password-reset', undefined, { email: 'a@example.com' }, {}, plain)).statusCode).toBe(404);
    expect(security.observeSession).not.toHaveBeenCalled();
    await plain.close();
  });

  it('documents every security operation as an authenticated operation with the standard error responses', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { operationId: string; security?: unknown[]; tags?: string[]; responses: Record<string, unknown> }>>;
    };
    const ids = new Map<string, { security?: unknown[]; tags?: string[]; responses: Record<string, unknown> }>();
    for (const [path, item] of Object.entries(doc.paths))
      if (path.includes('/account/security')) for (const op of Object.values(item)) ids.set(op.operationId, op);
    expect([...ids.keys()].sort()).toEqual(ROUTES.map((r) => r.id).sort());
    for (const [id, op] of ids) {
      expect(op.security, id).toEqual([{ bearerAuth: [] }]);
      expect(op.tags, id).toEqual(['security']);
      for (const code of ['200', '400', '401', '403', '429', '503']) expect(Object.keys(op.responses), `${id} ${code}`).toContain(code);
    }
  });

  it('declares the security tag', () => {
    const doc = app.swagger() as unknown as { tags?: { name: string }[] };
    expect(doc.tags?.map((t) => t.name)).toContain('security');
  });

  it('the committed AsyncAPI document announces the seven security events', () => {
    const text = readFileSync(new URL('../../../docs/events/asyncapi.yaml', import.meta.url), 'utf8');
    for (const type of Object.values(SECURITY_EVENTS)) expect(text, type).toContain(`address: ${type}`);
    for (const secret of ['password:', 'token:', 'deviceHash', 'keycloakSessionId']) expect(text.split('IdentitySession')[1] ?? '').not.toContain(secret);
  });

  it('the committed OpenAPI document lists the security paths', () => {
    const text = readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
    for (const path of [
      '/api/v1/account/security/sessions/current:',
      '/api/v1/account/security/devices/current/trust:',
      '/api/v1/account/security/mfa/enrollment:',
      '/api/v1/auth/password-reset:',
    ])
      expect(text, path).toContain(path);
  });
});

// ====================================================================== graceful shutdown
describe('security API shutdown', () => {
  const build = (drain: (() => Promise<void>) | undefined) =>
    buildApp({
      cfg,
      verifier,
      configuration: {} as never,
      accounts: accountSvc as unknown as AccountService,
      security: { ...security, drain } as unknown as SecurityOperations,
      readiness: async () => ({}),
    });

  it('app.close() waits for a late drain of the security layer (before the caller closes the database)', async () => {
    let finished = false;
    const a = await build(async () => {
      await new Promise((r) => setTimeout(r, 150));
      finished = true;
    });
    await a.ready();
    await a.close();
    expect(finished).toBe(true);
  });

  it('does not wait longer than the timeout for a drain that never finishes, and ignores a drain that fails', async () => {
    expect(SECURITY_DRAIN_TIMEOUT_MS).toBe(5000);
    const started = Date.now();
    await drainWithTimeout(() => new Promise<void>(() => undefined), 80);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(drainWithTimeout(async () => Promise.reject(new Error('boom password=hunter2')), 80)).resolves.toBeUndefined();
    await expect(drainWithTimeout(undefined)).resolves.toBeUndefined();
  });

  it('closes normally when the security service has no drain', async () => {
    const a = await build(undefined);
    await a.ready();
    await expect(a.close()).resolves.toBeUndefined();
  });
});

// ====================================================================== no-store on every response under /api/v1/account and /api/v1/auth
describe('Cache-Control: no-store on router-level and generic errors', () => {
  const noStore = (r: Reply, where: string) => expect(header(r, 'cache-control'), where).toBe('no-store');

  it('sets it on unknown paths (404), too-long path parameters, malformed URLs and wrong methods under both prefixes', async () => {
    const long = 'x'.repeat(300);
    const bad = [
      ['GET', '/api/v1/account/nothing-here'],
      ['GET', '/api/v1/account'],
      ['GET', '/api/v1/auth/nothing-here'],
      ['GET', '/api/v1/auth/password-reset'], // wrong method
      ['PUT', '/api/v1/account/security/sessions'],
      ['DELETE', `/api/v1/account/security/sessions/${long}`], // PATH_PARAMETER_TOO_LONG
      ['DELETE', `/api/v1/account/security/devices/${long}`],
      ['GET', '/api/v1/account/security/%E0%A4%A'], // BAD_URL
      ['GET', '/api/v1/auth/%E0%A4%A'],
      ['GET', '/API/V1/ACCOUNT/nothing'],
      ['GET', '/api/v1/account/nothing?x=1'],
    ] as const;
    for (const [method, url] of bad) {
      const res = await send(method, url, await webToken());
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
      noStore(res, `${method} ${url}`);
      expect(errorOf(res).correlationId).toBeTruthy();
    }
  });

  it('keeps the standard codes of those router-level failures', async () => {
    const tooLong = await send('DELETE', `/api/v1/account/security/sessions/${'x'.repeat(300)}`, await webToken());
    expect(errorOf(tooLong)).toMatchObject({ code: 'PATH_PARAMETER_TOO_LONG' });
    const badUrl = await send('GET', '/api/v1/account/security/%E0%A4%A', await webToken());
    expect(errorOf(badUrl)).toMatchObject({ code: 'BAD_URL' });
    expect(errorOf(await send('GET', '/api/v1/account/zzz', await webToken()))).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });

  it('sets it on generic errors without a route hook too (an unauthenticated 401, a framework 4xx such as an unsupported media type, a 500)', async () => {
    noStore(await send('GET', '/api/v1/auth/password-reset'), 'GET reset');
    const media = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', headers: { 'content-type': 'text/plain' }, payload: 'a@example.com' });
    expect(media.statusCode).toBe(400);
    noStore(media, 'text/plain');
    security.requestPasswordReset.mockRejectedValueOnce(new Error('boom'));
    noStore(await sendJson('/api/v1/auth/password-reset', undefined, { email: 'a@example.com' }), '500');
  });

  it('does not touch other prefixes (no-store is not forced on the public system and registry routes) and does not match lookalike prefixes', async () => {
    for (const url of ['/api/v1/accounting', '/api/v1/authority', '/api/v1/system/nothing', '/healthz-nope']) {
      const res = await send('GET', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['cache-control'], url).toBeUndefined();
    }
  });

  it('isNoStorePath matches the two prefixes and nothing else', () => {
    for (const ok of ['/api/v1/account', '/api/v1/account/', '/api/v1/account/x?y=1', '/api/v1/auth/password-reset', '/API/V1/Auth/x'])
      expect(isNoStorePath(ok), ok).toBe(true);
    for (const no of ['/api/v1/accounts', '/api/v1/accountx/a', '/api/v1/authority', '/api/v2/account/x', '/x/api/v1/account', '/', ''])
      expect(isNoStorePath(no), no).toBe(false);
  });
});
