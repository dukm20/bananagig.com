// Unit tests of the account API module with a fake AccountService (the rules of the real service are covered by packages/accounts and the identity
// integration tests): authentication and the identity context, the account always coming from the verified token, strict raw bodies, the role switch
// and profile routes, error mapping, and the privacy guarantees (no token, subject, issuer or realm role in a response, no route that grants a role).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ACCOUNT_ERROR_CODES, AccountDto, AccountResponse, CORRELATION_HEADER, ErrorResponse, type AccountErrorCode } from '@bananagig/contracts';
import { AccountError, AccountService, type AccountContext } from '@bananagig/accounts';
import type { Database } from '@bananagig/database';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;

const svc = {
  ensureAccountForIdentity: vi.fn(),
  getAccountContext: vi.fn(),
  selectActiveRole: vi.fn(),
  upsertProfile: vi.fn(),
};
const noServiceCalls = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-other-subject-marker-93d0';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const REALM_ROLES = ['customer', REALM_ROLE_MARKER, 'offline_access'];
const ACCOUNT_OF: Record<string, string> = { [SUB]: ACCOUNT_ID, [OTHER_SUB]: OTHER_ACCOUNT_ID };

const T0 = new Date('2026-01-01T00:00:00.000Z');
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };
const PROFILE = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
const makeContext = (over: Partial<AccountContext> = {}): AccountContext => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: [CUSTOMER, PROVIDER],
  memberships: [
    { code: 'CUSTOMER', status: 'ACTIVE' },
    { code: 'PROVIDER', status: 'ACTIVE' },
  ],
  primaryRole: 'CUSTOMER',
  activeRole: 'CUSTOMER',
  profile: null,
  createdAt: T0,
  created: false,
  ...over,
});

const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, azp: 'bananagig-web', realm_access: { roles: REALM_ROLES }, ...claims } });
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
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string | string[]> = {}) =>
  app.inject({
    method,
    url: `/api/v1/account${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } as Record<string, string>,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const dataOf = (r: { json: () => unknown }) => AccountResponse.parse(r.json()).data;
const keysOf = (o: object) => Object.keys(o).sort();
const ACCOUNT_KEYS = ['accountId', 'activeRole', 'createdAt', 'primaryRole', 'profile', 'roles', 'status'];
const raw = (v: unknown): string => JSON.stringify(v);

/** The identity every service call must carry: the verified token's, never anything the client wrote. */
const tokenIdentity = (sub: string = SUB, roles: string[] = REALM_ROLES) => ({
  providerType: 'KEYCLOAK',
  issuer: TEST_ISSUER,
  subject: sub,
  identityRoles: roles,
});
const everyEnsureUsedTheTokenIdentity = (sub: string = SUB) => {
  expect(svc.ensureAccountForIdentity.mock.calls.length).toBeGreaterThan(0);
  for (const [identity] of svc.ensureAccountForIdentity.mock.calls) expect(identity).toEqual(tokenIdentity(sub));
};

/** A real service whose database is never reachable: its validation runs, anything past it fails loudly. */
const untouchable = (): Database =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the database was touched (${String(prop)})`);
      },
    },
  ) as unknown as Database;

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, configuration: {} as never, accounts: svc as unknown as AccountService, readiness: async () => ({}) });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }, o: { requestedRole?: string; includeProfile?: boolean } = {}) =>
    makeContext({
      accountId: ACCOUNT_OF[identity.subject] ?? ACCOUNT_ID,
      activeRole: o.requestedRole ?? 'CUSTOMER',
      profile: o.includeProfile ? PROFILE : null,
    }),
  );
  svc.getAccountContext.mockImplementation(async (accountId: string, o: { requestedRole?: string; includeProfile?: boolean } = {}) =>
    makeContext({ accountId, activeRole: o.requestedRole ?? 'CUSTOMER', profile: o.includeProfile ? { ...PROFILE, firstName: 'Updated' } : null }),
  );
  svc.selectActiveRole.mockImplementation(async (accountId: string, role: string) => makeContext({ accountId, activeRole: role, profile: PROFILE }));
  svc.upsertProfile.mockImplementation(async (_id: string, input: typeof PROFILE) => ({ changed: true, profile: input }));
});

const validProfileBody = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
type Route = { method: Method; url: string; body?: unknown };
const routes: Route[] = [
  { method: 'GET', url: '/me' },
  { method: 'POST', url: '/active-role', body: { role: 'PROVIDER' } },
  { method: 'PUT', url: '/profile', body: validProfileBody },
];

// ====================================================================== authentication and identity context
describe('account API authentication', () => {
  it.each(routes)('$method $url requires a token: 401 with the standard envelope and a Bearer challenge, before any service call', async (r) => {
    const res = await call(r.method, r.url, undefined, r.body);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(errorOf(res).correlationId).toBeTruthy();
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expect(noServiceCalls()).toBe(true);
  });

  it.each(routes)('$method $url rejects every kind of invalid token with 401 invalid_token and never calls the service', async (r) => {
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
      const res = await call(r.method, r.url, token, r.body);
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    }
    expect(noServiceCalls()).toBe(true);
  });
  it.each(routes)('$method $url treats a non-Bearer Authorization header as an invalid token', async (r) => {
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

  it.each(routes)('$method $url refuses the admin identity context with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED and never calls the service', async (r) => {
    for (const token of [
      await adminToken(),
      await adminToken(['configuration-read', 'configuration-write', 'content-write', 'geography-read', 'geography-write']),
    ]) {
      const res = await call(r.method, r.url, token, r.body);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
      expect(errorOf(res).details).toBeUndefined();
    }
    expect(noServiceCalls()).toBe(true);
  });
  it.each(routes)('$method $url refuses a token issued to any other client (azp) with 403', async (r) => {
    for (const azp of ['other', 'bananagig-dev-test', 'bananagig-api', 'BANANAGIG-WEB', 'bananagig-web ']) {
      const res = await call(r.method, r.url, await webToken({ azp }), r.body);
      expect(res.statusCode, azp).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    }
    expect(noServiceCalls()).toBe(true);
  });
  it('refuses the admin context before it validates the body: 403, not 400', async () => {
    expect((await call('POST', '/active-role', await adminToken(), { role: 1, extra: true })).statusCode).toBe(403);
    expect((await call('PUT', '/profile', await adminToken(), { firstName: 1 })).statusCode).toBe(403);
    expect(noServiceCalls()).toBe(true);
  });
});

// ====================================================================== GET /account/me
describe('GET /account/me', () => {
  it('resolves the account from the verified token: provider type, issuer, subject and the realm roles of that token, nothing else', async () => {
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(200);
    expect(svc.ensureAccountForIdentity).toHaveBeenCalledTimes(1);
    const [identity, options] = svc.ensureAccountForIdentity.mock.calls[0]!;
    expect(identity).toEqual({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: SUB, identityRoles: REALM_ROLES });
    expect(keysOf(identity)).toEqual(['identityRoles', 'issuer', 'providerType', 'subject']);
    expect(options).toEqual({ requestedRole: undefined, includeProfile: true });
    expect(svc.getAccountContext).not.toHaveBeenCalled();
    expect(svc.selectActiveRole).not.toHaveBeenCalled();
    expect(svc.upsertProfile).not.toHaveBeenCalled();
  });
  it('passes the realm roles of each token (a provider token carries provider, a token without roles carries none)', async () => {
    await call('GET', '/me', await webToken({ realm_access: { roles: ['provider'] } }));
    await call('GET', '/me', await webToken({ realm_access: { roles: [] } }));
    await call('GET', '/me', await webToken({ realm_access: undefined }));
    expect(svc.ensureAccountForIdentity.mock.calls.map((c) => c[0].identityRoles)).toEqual([['provider'], [], []]);
  });
  it('answers with the AccountDto envelope: exactly accountId, status, roles, primaryRole, activeRole, profile and createdAt', async () => {
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>; meta: { correlationId: string } };
    expect(keysOf(body)).toEqual(['data', 'meta']);
    expect(keysOf(body.data)).toEqual(ACCOUNT_KEYS);
    expect(AccountDto.parse(body.data)).toEqual(body.data);
    expect(body.data).toEqual({
      accountId: ACCOUNT_ID,
      status: 'ACTIVE',
      roles: [CUSTOMER, PROVIDER],
      primaryRole: 'CUSTOMER',
      activeRole: 'CUSTOMER',
      profile: PROFILE,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(keysOf(body.meta)).toEqual(['correlationId']);
    expect(res.headers['content-type']).toContain('application/json');
  });
  it('echoes the correlation id of the request in the meta', async () => {
    const res = await call('GET', '/me', await webToken(), undefined, { [CORRELATION_HEADER]: 'corr-123' });
    expect((res.json() as { meta: { correlationId: string } }).meta.correlationId).toBe('corr-123');
  });
  it('returns no role, no primary role and no profile for an account without them', async () => {
    svc.ensureAccountForIdentity.mockResolvedValueOnce(makeContext({ roles: [], memberships: [], primaryRole: null, activeRole: null, profile: null }));
    const res = await call('GET', '/me', await webToken());
    expect(dataOf(res)).toMatchObject({ roles: [], primaryRole: null, activeRole: null, profile: null });
  });
  it('never contains the token, the Keycloak subject, the issuer or any realm role of the token', async () => {
    const token = await webToken();
    const res = await call('GET', '/me', token);
    expect(res.statusCode).toBe(200);
    for (const secret of [
      token,
      token.split('.')[1]!,
      token.split('.')[2]!,
      SUB,
      TEST_ISSUER,
      'auth.localhost',
      REALM_ROLE_MARKER,
      'offline_access',
      'realm_access',
      'issuer',
      'subject',
      'azp',
      'bananagig-web',
    ]) {
      expect(res.body, secret).not.toContain(secret);
    }
    for (const [name, value] of Object.entries(res.headers)) {
      expect(String(value), name).not.toContain(token);
      expect(String(value), name).not.toContain(SUB);
    }
  });
  it('builds the response from explicit fields: internal attributes of the service result never reach the client', async () => {
    svc.ensureAccountForIdentity.mockResolvedValueOnce({
      ...makeContext({ created: true }),
      subject: SUB,
      issuer: TEST_ISSUER,
      token: 'tok-secret',
      externalIdentityId: 'ei-secret',
    });
    const res = await call('GET', '/me', await webToken());
    expect(keysOf((res.json() as { data: object }).data)).toEqual(ACCOUNT_KEYS);
    for (const word of ['memberships', '"created"', 'tok-secret', 'ei-secret', SUB, TEST_ISSUER]) expect(res.body, word).not.toContain(word);
  });

  describe('the requested active role (x-active-role)', () => {
    it('is passed to the service as requestedRole, for the service to validate against the memberships', async () => {
      const res = await call('GET', '/me', await webToken(), undefined, { 'x-active-role': 'PROVIDER' });
      expect(res.statusCode).toBe(200);
      expect(svc.ensureAccountForIdentity.mock.calls[0]![1]).toEqual({ requestedRole: 'PROVIDER', includeProfile: true });
      expect(dataOf(res).activeRole).toBe('PROVIDER');
    });
    it('is read case-insensitively by header name', async () => {
      await call('GET', '/me', await webToken(), undefined, { 'X-Active-Role': 'PROVIDER' });
      expect(svc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ requestedRole: 'PROVIDER' });
    });
    it('is undefined without the header', async () => {
      await call('GET', '/me', await webToken());
      expect(svc.ensureAccountForIdentity.mock.calls[0]![1].requestedRole).toBeUndefined();
    });
    it('is passed verbatim when it is not a valid role code: the service rejects it, the API never guesses', async () => {
      for (const value of ['provider', 'CUSTOMER,PROVIDER', 'X; DROP TABLE identity.roles', 'NOPE', '']) {
        svc.ensureAccountForIdentity.mockClear();
        await call('GET', '/me', await webToken(), undefined, { 'x-active-role': value });
        expect(svc.ensureAccountForIdentity.mock.calls[0]![1].requestedRole, value).toBe(value);
      }
    });
    it('joins a repeated header into one comma-separated string, which the service then rejects as an invalid role', async () => {
      const res = await call('GET', '/me', await webToken(), undefined, { 'x-active-role': ['CUSTOMER', 'PROVIDER'] });
      expect(res.statusCode).toBe(200);
      expect(svc.ensureAccountForIdentity.mock.calls[0]![1].requestedRole).toBe('CUSTOMER,PROVIDER');
    });
    it('is passed as a comma-separated string when the client sent one value with a comma', async () => {
      await call('GET', '/me', await webToken(), undefined, { 'x-active-role': 'CUSTOMER,PROVIDER' });
      expect(svc.ensureAccountForIdentity.mock.calls[0]![1].requestedRole).toBe('CUSTOMER,PROVIDER');
    });
  });

  describe('a client-supplied account id never selects an account', () => {
    it.each(['accountId', 'account_id', 'id', 'sub', 'subject', 'role', 'userId'])(
      'rejects the query parameter ?%s with 400 and uses only the token identity',
      async (name) => {
        const res = await call('GET', `/me?${name}=${OTHER_ACCOUNT_ID}`, await webToken());
        expect(res.statusCode).toBe(400);
        expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
        expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
        everyEnsureUsedTheTokenIdentity();
        expect(svc.getAccountContext).not.toHaveBeenCalled();
      },
    );
    it('rejects an empty query parameter too', async () => {
      expect((await call('GET', '/me?accountId=', await webToken())).statusCode).toBe(400);
    });
    it.each(['x-account-id', 'x-user-id', 'x-subject', 'x-forwarded-user', 'x-keycloak-sub'])(
      'ignores the header %s: the response is the token account',
      async (name) => {
        const res = await call('GET', '/me', await webToken(), undefined, { [name]: OTHER_ACCOUNT_ID });
        expect(res.statusCode).toBe(200);
        expect(dataOf(res).accountId).toBe(ACCOUNT_ID);
        everyEnsureUsedTheTokenIdentity();
        expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
      },
    );
    it('gives each token its own account', async () => {
      const mine = await call('GET', '/me', await webToken());
      const theirs = await call('GET', '/me', await webToken({ sub: OTHER_SUB }));
      expect(dataOf(mine).accountId).toBe(ACCOUNT_ID);
      expect(dataOf(theirs).accountId).toBe(OTHER_ACCOUNT_ID);
      expect(svc.ensureAccountForIdentity.mock.calls.map((c) => c[0].subject)).toEqual([SUB, OTHER_SUB]);
    });
    it('ignores a JSON body sent with a GET (a body account id selects nothing)', async () => {
      const res = await call('GET', '/me', await webToken(), { accountId: OTHER_ACCOUNT_ID }, { 'content-type': 'application/json' });
      expect(res.statusCode).toBe(200);
      expect(dataOf(res).accountId).toBe(ACCOUNT_ID);
      everyEnsureUsedTheTokenIdentity();
      expect(svc.getAccountContext).not.toHaveBeenCalled();
    });
  });
});

// ====================================================================== POST /account/active-role
describe('POST /account/active-role', () => {
  it('returns 401 before 400: an invalid body without a token is 401', async () => {
    for (const body of [{ role: 1 }, {}, { role: 'PROVIDER', accountId: OTHER_ACCOUNT_ID }, undefined]) {
      const res = await call('POST', '/active-role', undefined, body);
      expect(res.statusCode, raw(body)).toBe(401);
    }
    expect((await call('POST', '/active-role', 'bad.token', { role: 1 })).statusCode).toBe(401);
    expect(noServiceCalls()).toBe(true);
  });

  const invalidBodies: [string, unknown][] = [
    ['an extra property', { role: 'PROVIDER', extra: 1 }],
    ['an account id', { role: 'PROVIDER', accountId: OTHER_ACCOUNT_ID }],
    ['a missing role', {}],
    ['a numeric role', { role: 1 }],
    ['a boolean role', { role: true }],
    ['a false role', { role: false }],
    ['a null role', { role: null }],
    ['a lower-case code', { role: 'provider' }],
    ['a padded code', { role: ' PROVIDER' }],
    ['an array role', { role: ['PROVIDER'] }],
    ['an object role', { role: { code: 'PROVIDER' } }],
    ['an over-long code', { role: `A${'B'.repeat(30)}` }],
    ['a top-level array', [{ role: 'PROVIDER' }]],
    ['a top-level array of codes', ['PROVIDER']],
    ['an empty array', []],
  ];
  it.each(invalidBodies)('rejects %s with 400 and the standard envelope, and never switches the role', async (_label, body) => {
    const res = await call('POST', '/active-role', await webToken(), body);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
    expect(svc.selectActiveRole).not.toHaveBeenCalled();
    expect(svc.upsertProfile).not.toHaveBeenCalled();
    expect(svc.getAccountContext).not.toHaveBeenCalled();
    everyEnsureUsedTheTokenIdentity();
  });
  it.each([
    ['a JSON string', '"PROVIDER"'],
    ['a JSON number', '1'],
    ['a JSON boolean', 'true'],
    ['JSON null', 'null'],
  ])('rejects %s as the whole body with 400', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/active-role',
      headers: { authorization: `Bearer ${await webToken()}`, 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).category).toBe('VALIDATION');
    expect(svc.selectActiveRole).not.toHaveBeenCalled();
  });
  it('rejects a missing body, an unparseable body and a plain text body with 400, and a form body with 415, all in the standard envelope', async () => {
    const authorization = `Bearer ${await webToken()}`;
    const url = '/api/v1/account/active-role';
    const attempts: [string, Record<string, string>, string | undefined, number][] = [
      ['a missing body', { authorization }, undefined, 400],
      ['an unparseable JSON body', { authorization, 'content-type': 'application/json' }, '{"role": ', 400],
      ['a plain text body', { authorization, 'content-type': 'text/plain' }, 'PROVIDER', 400],
      ['a form body', { authorization, 'content-type': 'application/x-www-form-urlencoded' }, 'role=PROVIDER', 415],
    ];
    for (const [label, headers, payload, status] of attempts) {
      const res = await app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
      expect(res.statusCode, label).toBe(status);
      expect(errorOf(res).category, label).toBe('VALIDATION');
    }
    expect(svc.selectActiveRole).not.toHaveBeenCalled();
  });
  it('never echoes a rejected value', async () => {
    const res = await call('POST', '/active-role', await webToken(), { role: 'secret-role-value', accountId: 'secret-account-value' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('secret-role-value');
    expect(res.body).not.toContain('secret-account-value');
  });

  it('switches to the requested role for the account of the token and answers with the AccountDto', async () => {
    const res = await call('POST', '/active-role', await webToken(), { role: 'PROVIDER' });
    expect(res.statusCode).toBe(200);
    expect(svc.selectActiveRole).toHaveBeenCalledTimes(1);
    expect(svc.selectActiveRole).toHaveBeenCalledWith(ACCOUNT_ID, 'PROVIDER');
    expect(keysOf((res.json() as { data: object }).data)).toEqual(ACCOUNT_KEYS);
    expect(dataOf(res)).toMatchObject({ accountId: ACCOUNT_ID, activeRole: 'PROVIDER', profile: PROFILE });
    expect(svc.upsertProfile).not.toHaveBeenCalled();
  });
  it('resolves the account WITHOUT the x-active-role header (the body is the request) and without the profile', async () => {
    const res = await call('POST', '/active-role', await webToken(), { role: 'PROVIDER' }, { 'x-active-role': 'CUSTOMER' });
    expect(res.statusCode).toBe(200);
    expect(svc.ensureAccountForIdentity.mock.calls[0]![1]).toEqual({ requestedRole: undefined, includeProfile: undefined });
    expect(svc.selectActiveRole).toHaveBeenCalledWith(ACCOUNT_ID, 'PROVIDER');
    expect(dataOf(res).activeRole).toBe('PROVIDER');
  });
  it('does not even look at a malformed x-active-role header', async () => {
    const res = await call('POST', '/active-role', await webToken(), { role: 'PROVIDER' }, { 'x-active-role': 'not a valid role!' });
    expect(res.statusCode).toBe(200);
    expect(svc.ensureAccountForIdentity.mock.calls[0]![1].requestedRole).toBeUndefined();
  });
  it.each(['x-account-id', 'x-user-id'])('ignores the header %s and the query ?accountId: the role switch applies to the token account only', async (name) => {
    const res = await call('POST', `/active-role?accountId=${OTHER_ACCOUNT_ID}`, await webToken(), { role: 'PROVIDER' }, { [name]: OTHER_ACCOUNT_ID });
    expect(res.statusCode).toBe(200);
    expect(svc.selectActiveRole).toHaveBeenCalledWith(ACCOUNT_ID, 'PROVIDER');
    expect(dataOf(res).accountId).toBe(ACCOUNT_ID);
    everyEnsureUsedTheTokenIdentity();
  });
  it('never contains the token, the subject, the issuer or the realm roles', async () => {
    const token = await webToken();
    const res = await call('POST', '/active-role', token, { role: 'PROVIDER' });
    for (const secret of [token, SUB, TEST_ISSUER, REALM_ROLE_MARKER, 'realm_access']) expect(res.body, secret).not.toContain(secret);
  });
});

// ====================================================================== PUT /account/profile
describe('PUT /account/profile', () => {
  it('returns 401 before 400: an invalid body without a token is 401', async () => {
    for (const body of [{ firstName: 1 }, {}, { ...validProfileBody, accountId: OTHER_ACCOUNT_ID }, undefined]) {
      expect((await call('PUT', '/profile', undefined, body)).statusCode, raw(body)).toBe(401);
    }
    expect((await call('PUT', '/profile', 'bad.token', { firstName: 1 })).statusCode).toBe(401);
    expect(noServiceCalls()).toBe(true);
  });

  const invalidBodies: [string, unknown][] = [
    ['an extra property', { ...validProfileBody, extra: 'x' }],
    ['an account id', { ...validProfileBody, accountId: OTHER_ACCOUNT_ID }],
    ['a role', { ...validProfileBody, role: 'PROVIDER' }],
    ['a numeric first name', { ...validProfileBody, firstName: 1 }],
    ['a boolean first name', { ...validProfileBody, firstName: true }],
    ['a numeric last name', { ...validProfileBody, lastName: 2 }],
    ['a null first name', { ...validProfileBody, firstName: null }],
    ['an array last name', { ...validProfileBody, lastName: ['Martinez'] }],
    ['a missing first name', { lastName: 'Martinez' }],
    ['a missing last name', { firstName: 'Ana' }],
    ['an empty object', {}],
    ['a name above 500 characters', { ...validProfileBody, firstName: 'a'.repeat(501) }],
    ['a numeric locale', { ...validProfileBody, preferredLocale: 5 }],
    ['an underscore locale', { ...validProfileBody, preferredLocale: 'en_US' }],
    ['a boolean time zone', { ...validProfileBody, timeZone: false }],
    ['an offset as time zone', { ...validProfileBody, timeZone: '+05:00' }],
    ['a top-level array', [validProfileBody]],
    ['an empty array', []],
  ];
  it.each(invalidBodies)('rejects %s with 400 and the standard envelope, and never writes', async (_label, body) => {
    const res = await call('PUT', '/profile', await webToken(), body);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
    expect(svc.upsertProfile).not.toHaveBeenCalled();
    expect(svc.getAccountContext).not.toHaveBeenCalled();
    expect(svc.selectActiveRole).not.toHaveBeenCalled();
    everyEnsureUsedTheTokenIdentity();
  });
  it.each([
    ['a JSON string', '"Ana"'],
    ['a JSON number', '7'],
    ['JSON null', 'null'],
  ])('rejects %s as the whole body with 400', async (_label, payload) => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { authorization: `Bearer ${await webToken()}`, 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(svc.upsertProfile).not.toHaveBeenCalled();
  });
  it('never echoes a rejected value', async () => {
    const res = await call('PUT', '/profile', await webToken(), { firstName: 'secret-first-name', lastName: 9, accountId: 'secret-account-value' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('secret-first-name');
    expect(res.body).not.toContain('secret-account-value');
  });

  it('replaces the profile of the token account, then reads the account back with the profile', async () => {
    const res = await call('PUT', '/profile', await webToken(), validProfileBody);
    expect(res.statusCode).toBe(200);
    expect(svc.upsertProfile).toHaveBeenCalledTimes(1);
    expect(svc.upsertProfile).toHaveBeenCalledWith(
      ACCOUNT_ID,
      { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
      { actor: `account:${ACCOUNT_ID}` },
    );
    expect(svc.getAccountContext).toHaveBeenCalledTimes(1);
    expect(svc.getAccountContext).toHaveBeenCalledWith(ACCOUNT_ID, { includeProfile: true, requestedRole: undefined });
    expect(svc.upsertProfile.mock.invocationCallOrder[0]!).toBeLessThan(svc.getAccountContext.mock.invocationCallOrder[0]!);
    expect(keysOf((res.json() as { data: object }).data)).toEqual(ACCOUNT_KEYS);
    expect(dataOf(res)).toMatchObject({ accountId: ACCOUNT_ID, profile: { ...PROFILE, firstName: 'Updated' } });
  });
  it('resolves the account of the guard without the profile (the profile is read after the write)', async () => {
    await call('PUT', '/profile', await webToken(), validProfileBody);
    expect(svc.ensureAccountForIdentity.mock.calls[0]![1]).toEqual({ requestedRole: undefined, includeProfile: undefined });
  });
  it('accepts names only and passes explicit nulls to clear the locale and time zone', async () => {
    expect((await call('PUT', '/profile', await webToken(), { firstName: 'Ana', lastName: 'Martinez' })).statusCode).toBe(200);
    expect(svc.upsertProfile.mock.calls[0]![1]).toEqual({ firstName: 'Ana', lastName: 'Martinez' });
    expect(
      (await call('PUT', '/profile', await webToken(), { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null })).statusCode,
    ).toBe(200);
    expect(svc.upsertProfile.mock.calls[1]![1]).toEqual({ firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null });
  });
  it('hands the names to the service unmodified: trimming and the 1 to 50 rule belong to the service, which owns the audit of what changed', async () => {
    const body = { firstName: '  Ana  ', lastName: 'x'.repeat(60) };
    expect((await call('PUT', '/profile', await webToken(), body)).statusCode).toBe(200);
    expect(svc.upsertProfile.mock.calls[0]![1]).toEqual(body);
  });
  it('honors x-active-role for the account it returns (guard and read-back)', async () => {
    const res = await call('PUT', '/profile', await webToken(), validProfileBody, { 'x-active-role': 'PROVIDER' });
    expect(res.statusCode).toBe(200);
    expect(svc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ requestedRole: 'PROVIDER' });
    expect(svc.getAccountContext).toHaveBeenCalledWith(ACCOUNT_ID, { includeProfile: true, requestedRole: 'PROVIDER' });
    expect(dataOf(res).activeRole).toBe('PROVIDER');
  });
  it('writes the profile of the token account whatever header or query parameter names another account', async () => {
    const res = await call('PUT', `/profile?accountId=${OTHER_ACCOUNT_ID}`, await webToken(), validProfileBody, { 'x-account-id': OTHER_ACCOUNT_ID });
    expect(res.statusCode).toBe(200);
    expect(svc.upsertProfile.mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(svc.upsertProfile.mock.calls[0]![2]).toEqual({ actor: `account:${ACCOUNT_ID}` });
    expect(svc.getAccountContext.mock.calls[0]![0]).toBe(ACCOUNT_ID);
    for (const call of [...svc.upsertProfile.mock.calls, ...svc.getAccountContext.mock.calls]) expect(raw(call)).not.toContain(OTHER_ACCOUNT_ID);
  });
  it('writes the profile of the account of each token', async () => {
    await call('PUT', '/profile', await webToken({ sub: OTHER_SUB }), validProfileBody);
    expect(svc.upsertProfile.mock.calls[0]![0]).toBe(OTHER_ACCOUNT_ID);
    expect(svc.upsertProfile.mock.calls[0]![2]).toEqual({ actor: `account:${OTHER_ACCOUNT_ID}` });
  });
  it('never gives the service the token, the subject, the issuer or the realm roles on a profile write', async () => {
    await call('PUT', '/profile', await webToken(), validProfileBody);
    for (const args of [...svc.upsertProfile.mock.calls, ...svc.getAccountContext.mock.calls]) {
      for (const secret of [SUB, TEST_ISSUER, REALM_ROLE_MARKER]) expect(raw(args), secret).not.toContain(secret);
    }
  });

  describe('a name the service rejects', () => {
    const TYPED = 'Zq9-typed-name-marker';
    /** The real service validation (never reaches its database): the 400 and its issues are what a client would really see. */
    const useRealValidation = () => {
      const real = new AccountService({ database: untouchable() });
      svc.upsertProfile.mockImplementation((...args: Parameters<AccountService['upsertProfile']>) => real.upsertProfile(...args));
    };

    it('is 400 ACCOUNT_VALIDATION_FAILED with the issues as field, code and content key, and not the typed value', async () => {
      useRealValidation();
      const res = await call('PUT', '/profile', await webToken(), { firstName: `${TYPED}${'a'.repeat(60)}`, lastName: '   ' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'ACCOUNT_VALIDATION_FAILED' });
      expect(errorOf(res).details).toEqual({
        reason: 'INVALID_PROFILE',
        issues: [
          { field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' },
          { field: 'lastName', code: 'REQUIRED', messageKey: 'account.error.name_required' },
        ],
      });
      expect(res.body).not.toContain(TYPED);
      expect(svc.getAccountContext).not.toHaveBeenCalled();
    });
    it('reports control characters as INVALID_CHARACTERS without echoing them', async () => {
      useRealValidation();
      const res = await call('PUT', '/profile', await webToken(), { firstName: `${TYPED}${String.fromCharCode(7)}`, lastName: 'Martinez' });
      expect(res.statusCode).toBe(400);
      expect((errorOf(res).details as { issues: unknown[] }).issues).toEqual([
        { field: 'firstName', code: 'INVALID_CHARACTERS', messageKey: 'account.error.name_invalid_characters' },
      ]);
      expect(res.body).not.toContain(TYPED);
    });
    it('is mapped from a service error carrying issues exactly as the service built them', async () => {
      svc.upsertProfile.mockRejectedValueOnce(
        new AccountError('VALIDATION_FAILED', 'the profile is not valid', {
          reason: 'INVALID_PROFILE',
          issues: [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }],
        }),
      );
      const res = await call('PUT', '/profile', await webToken(), { firstName: TYPED, lastName: 'Martinez' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toMatchObject({ issues: [{ messageKey: 'account.error.name_too_long' }] });
      expect(res.body).not.toContain(TYPED);
    });
  });
});

// ====================================================================== routes that must not exist
describe('no route grants or edits roles, and unknown routes are 404', () => {
  it.each([
    ['POST', '/roles'],
    ['POST', '/roles/provider'],
    ['POST', '/roles/PROVIDER'],
    ['PUT', '/roles/provider'],
    ['PUT', '/roles'],
    ['DELETE', '/roles/provider'],
    ['GET', '/roles'],
    ['PATCH', '/roles/provider'],
    ['POST', '/role'],
    ['POST', '/provider'],
    ['POST', '/status'],
    ['PUT', '/status'],
    ['POST', '/primary-role'],
    ['PUT', '/primary-role'],
    ['GET', '/'],
    ['GET', '/profile'],
    ['POST', '/me'],
    ['PUT', '/me'],
    ['DELETE', '/me'],
    ['GET', '/active-role'],
    ['PUT', '/active-role'],
    ['POST', '/profile'],
    ['DELETE', '/profile'],
    ['GET', `/${ACCOUNT_ID}`],
    ['GET', `/${OTHER_ACCOUNT_ID}/profile`],
    ['PUT', `/${OTHER_ACCOUNT_ID}/profile`],
    ['POST', `/${OTHER_ACCOUNT_ID}/roles/provider`],
    ['GET', '/identities'],
    ['POST', '/identities'],
  ] as const)('%s /api/v1/account%s is 404 ROUTE_NOT_FOUND, anonymous and with a valid web token', async (method, url) => {
    for (const t of [undefined, await webToken()]) {
      const res = await call(method, url, t, method === 'GET' || method === 'DELETE' ? undefined : { role: 'PROVIDER' });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    }
    expect(noServiceCalls()).toBe(true);
  });
  it('also has no account route outside /api/v1/account', async () => {
    for (const url of [
      '/api/v1/accounts',
      '/api/v1/accounts/me',
      '/api/v1/me',
      '/api/v1/roles',
      '/account/me',
      '/api/v1/geography/account/me',
      '/api/v1/users/me',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await webToken()}` } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(noServiceCalls()).toBe(true);
  });
  it('is not registered when the app is built without an account service', async () => {
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const bare = await buildApp({ cfg, verifier, configuration: {} as never, readiness: async () => ({}) });
    await bare.ready();
    const authorization = `Bearer ${await webToken()}`;
    expect((await bare.inject({ method: 'GET', url: '/api/v1/account/me', headers: { authorization } })).statusCode).toBe(404);
    expect(
      (await bare.inject({ method: 'POST', url: '/api/v1/account/active-role', headers: { authorization }, payload: { role: 'PROVIDER' } })).statusCode,
    ).toBe(404);
    expect((await bare.inject({ method: 'PUT', url: '/api/v1/account/profile', headers: { authorization }, payload: validProfileBody })).statusCode).toBe(404);
    await bare.close();
  });
});

// ====================================================================== OpenAPI
describe('account OpenAPI document', () => {
  type Operation = { operationId?: string; security?: unknown[]; tags?: string[]; parameters?: { name: string; in: string }[]; requestBody?: unknown };
  const doc = () => app.swagger() as { paths: Record<string, Record<string, Operation>>; components?: { securitySchemes?: Record<string, unknown> } };
  const accountOperations = () =>
    Object.entries(doc().paths)
      .filter(([path]) => path.startsWith('/api/v1/account'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([method, o]) => ({ path, method, op: o })));

  it('lists exactly the three account operations: getAccountMe, setAccountActiveRole, updateAccountProfile', () => {
    const ops = accountOperations();
    expect(ops.map((o) => o.op.operationId).sort()).toEqual(['getAccountMe', 'setAccountActiveRole', 'updateAccountProfile']);
    expect(ops.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort()).toEqual([
      'GET /api/v1/account/me',
      'POST /api/v1/account/active-role',
      'PUT /api/v1/account/profile',
    ]);
  });
  it('requires the bearer token on every account operation and tags them account', () => {
    for (const { op } of accountOperations()) {
      expect(op.security, op.operationId).toEqual([{ bearerAuth: [] }]);
      expect(op.tags, op.operationId).toEqual(['account']);
    }
    expect(doc().components?.securitySchemes).toHaveProperty('bearerAuth');
  });
  it('documents no account id, subject, issuer or role claim as a request parameter or body property', () => {
    for (const { op } of accountOperations()) {
      const request = raw({ parameters: (op.parameters ?? []).filter((p) => p.in !== 'header'), requestBody: op.requestBody });
      for (const word of ['accountId', 'account_id', 'subject', 'issuer', 'userId', 'sub"']) expect(request, `${op.operationId} ${word}`).not.toContain(word);
    }
  });
  it('documents the x-active-role header only on the read route', () => {
    const byId: Record<string, Operation> = Object.fromEntries(accountOperations().map((o) => [o.op.operationId ?? '', o.op]));
    expect((byId['getAccountMe']!.parameters ?? []).map((p) => p.name)).toContain('x-active-role');
    expect((byId['setAccountActiveRole']!.parameters ?? []).map((p) => p.name)).not.toContain('x-active-role');
  });
  it('has no role-granting, status or other account paths', () => {
    expect(
      Object.keys(doc().paths)
        .filter((p) => /account/.test(p))
        .sort(),
    ).toEqual(['/api/v1/account/active-role', '/api/v1/account/me', '/api/v1/account/profile']);
  });
});

// ====================================================================== error mapping
describe('account API error mapping', () => {
  const expected: Record<AccountErrorCode, [number, string]> = {
    NOT_FOUND: [404, 'NOT_FOUND'],
    ROLE_NOT_FOUND: [404, 'NOT_FOUND'],
    SUSPENDED: [403, 'AUTHORIZATION'],
    CLOSED: [403, 'AUTHORIZATION'],
    ROLE_NOT_HELD: [403, 'AUTHORIZATION'],
    ROLE_NOT_ACTIVE: [403, 'AUTHORIZATION'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    INVALID_STATE: [409, 'CONFLICT'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
  };
  it('covers every AccountError code', () => {
    expect(Object.keys(expected).sort()).toEqual([...ACCOUNT_ERROR_CODES].sort());
  });

  const error = (code: AccountErrorCode) =>
    new AccountError(code, `${code} happened`, {
      reason: 'SOME_REASON',
      status: 'SUSPENDED',
      constraint: 'uq_external_identities__provider_issuer_subject',
      cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM identity.accounts password=hunter2',
    });
  const LEAKS = [
    'ECONNREFUSED',
    'SELECT',
    'hunter2',
    'cause',
    'constraint',
    'uq_external_identities',
    'identity.accounts',
    '10.0.0.5',
    SUB,
    TEST_ISSUER,
    REALM_ROLE_MARKER,
  ];

  it.each(ACCOUNT_ERROR_CODES)('maps %s to the standard error model on every route and every service call, without leaking internals', async (code) => {
    const [status, category] = expected[code];
    const check = (r: { statusCode: number; body: string; json: () => unknown }, where: string) => {
      expect(r.statusCode, where).toBe(status);
      expect(errorOf(r), where).toMatchObject({ category, code: `ACCOUNT_${code}` });
      expect(errorOf(r).correlationId, where).toBeTruthy();
      for (const leak of LEAKS) expect(r.body, `${where} leaks ${leak}`).not.toContain(leak);
      if (code === 'UNAVAILABLE') {
        expect(errorOf(r).message, where).toBe('The account service is temporarily unavailable');
        expect(errorOf(r).details, where).toBeUndefined();
      } else {
        expect(errorOf(r).message, where).toBe(`${code} happened`);
        expect(errorOf(r).details, where).toEqual({ reason: 'SOME_REASON', status: 'SUSPENDED' });
      }
    };
    const token = await webToken();
    svc.ensureAccountForIdentity.mockRejectedValueOnce(error(code));
    check(await call('GET', '/me', token), 'GET /me (guard)');
    svc.ensureAccountForIdentity.mockRejectedValueOnce(error(code));
    check(await call('POST', '/active-role', token, { role: 'PROVIDER' }), 'POST /active-role (guard)');
    svc.ensureAccountForIdentity.mockRejectedValueOnce(error(code));
    check(await call('PUT', '/profile', token, validProfileBody), 'PUT /profile (guard)');
    svc.selectActiveRole.mockRejectedValueOnce(error(code));
    check(await call('POST', '/active-role', token, { role: 'PROVIDER' }), 'POST /active-role (selectActiveRole)');
    svc.upsertProfile.mockRejectedValueOnce(error(code));
    check(await call('PUT', '/profile', token, validProfileBody), 'PUT /profile (upsertProfile)');
    svc.getAccountContext.mockRejectedValueOnce(error(code));
    check(await call('PUT', '/profile', token, validProfileBody), 'PUT /profile (getAccountContext)');
  });

  it.each([
    ['ROLE_NOT_HELD', 403, 'ACCOUNT_ROLE_NOT_HELD'],
    ['ROLE_NOT_ACTIVE', 403, 'ACCOUNT_ROLE_NOT_ACTIVE'],
    ['SUSPENDED', 403, 'ACCOUNT_SUSPENDED'],
    ['CLOSED', 403, 'ACCOUNT_CLOSED'],
  ] as const)('answers %s with %s %s on a role request', async (code, status, apiCode) => {
    svc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { role: 'PROVIDER' }));
    const res = await call('GET', '/me', await webToken(), undefined, { 'x-active-role': 'PROVIDER' });
    expect(res.statusCode).toBe(status);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: apiCode, details: { role: 'PROVIDER' } });
  });
  it('drops the constraint name and the cause even when only those are present', async () => {
    svc.ensureAccountForIdentity.mockRejectedValueOnce(
      new AccountError('CONFLICT', 'a record with this identity already exists', { reason: 'DUPLICATE', constraint: 'uq_x', cause: 'boom' }),
    );
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({ reason: 'DUPLICATE' });
  });
  it('maps a typed error that carries no details', async () => {
    svc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError('NOT_FOUND', 'the account does not exist'));
    const res = await call('GET', '/me', await webToken());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', message: 'the account does not exist' });
  });
  it('reports unexpected (non-account) failures as a generic 500 without the cause', async () => {
    const token = await webToken();
    svc.ensureAccountForIdentity.mockRejectedValueOnce(new Error('boom: password=hunter2 identity.accounts'));
    const guard = await call('GET', '/me', token);
    expect(guard.statusCode).toBe(500);
    expect(errorOf(guard)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
    svc.selectActiveRole.mockRejectedValueOnce(new TypeError('x is undefined: hunter2'));
    const sw = await call('POST', '/active-role', token, { role: 'PROVIDER' });
    expect(sw.statusCode).toBe(500);
    svc.upsertProfile.mockRejectedValueOnce(new Error('boom hunter2'));
    const pf = await call('PUT', '/profile', token, validProfileBody);
    expect(pf.statusCode).toBe(500);
    for (const r of [guard, sw, pf]) {
      expect(r.body).not.toContain('hunter2');
      expect(r.body).not.toContain('identity.accounts');
    }
  });
  it('does not call the read-back after a failed profile write', async () => {
    svc.upsertProfile.mockRejectedValueOnce(error('CONFLICT'));
    const res = await call('PUT', '/profile', await webToken(), validProfileBody);
    expect(res.statusCode).toBe(409);
    expect(svc.getAccountContext).not.toHaveBeenCalled();
  });
});

// ====================================================================== caching of personal data
describe('account responses are never cached', () => {
  it('sends Cache-Control: no-store on every account route, for successes and for errors', async () => {
    const t = await webToken();
    for (const r of [
      await call('GET', '/me', t),
      await call('POST', '/active-role', t, { role: 'CUSTOMER' }),
      await call('PUT', '/profile', t, { firstName: 'Ana', lastName: 'Martin' }),
      await call('GET', '/me'), // 401
      await call('POST', '/active-role', t, { role: 1 }), // 400
      await call('GET', '/me', await adminToken([])), // 403
    ])
      expect(r.headers['cache-control'], String(r.statusCode)).toBe('no-store');
  });
});
