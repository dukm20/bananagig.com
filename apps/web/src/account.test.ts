// ID-001 web side: the typed account client, the role switch (POST /auth/active-role: handleActiveRole and its route), and the session store update that
// keeps the remaining lifetime. The real API is exercised by apps/api/src/account.itest.ts and `pnpm smoke`; here the API is an injected client or fetch.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER, type AccountDto } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { GET as routeGet, POST as routePost } from './app/auth/active-role/route';
import * as routeModule from './app/auth/active-role/route';
import { ApiError, createApiClient } from './lib/api-client';
import { forgetActiveRole, getSession, handleActiveRole } from './lib/auth/handlers';
import { MemorySessionStore, ValkeySessionStore, type ValkeyLike } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { ACCOUNT_ID, CUSTOMER_ROLE, PROVIDER_ROLE, accountDto } from './testing/account-stub';

const routeState = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => routeState.deps }));

// ---------------------------------------------------------------- the typed client
const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>, token: string | undefined = 'access-token-1') =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: f as unknown as typeof fetch, correlationId: () => 'web-corr-12345', accessToken: () => token });
const errorBody = (code: string, category: string, details?: Record<string, unknown>) => ({
  error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234', ...(details ? { details } : {}) },
});
const headersOf = (f: ReturnType<typeof stubFetch>, call = 0) => f.mock.calls[call]![1]?.headers as Record<string, string>;
const BOTH = accountDto([CUSTOMER_ROLE, PROVIDER_ROLE]);

describe('api client: account', () => {
  it('getAccount GETs /account/me with the bearer token, no body and no role header, and validates the contract', async () => {
    const f = stubFetch(() => json(200, { data: BOTH, meta }));
    const account = await clientWith(f).getAccount();
    expect(account).toEqual(BOTH);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/me');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(f)).toMatchObject({ authorization: 'Bearer access-token-1', accept: 'application/json', [CORRELATION_HEADER]: 'web-corr-12345' });
    expect(headersOf(f)[ACTIVE_ROLE_HEADER]).toBeUndefined();
    expect(String(url)).not.toContain('access-token-1');
  });

  it('getAccount sends the active role as x-active-role when given (and only then)', async () => {
    const f = stubFetch(() => json(200, { data: { ...BOTH, activeRole: 'PROVIDER' }, meta }));
    const account = await clientWith(f).getAccount({ activeRole: 'PROVIDER' });
    expect(account.activeRole).toBe('PROVIDER');
    expect(headersOf(f)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
    expect(ACTIVE_ROLE_HEADER).toBe('x-active-role');
    await clientWith(f).getAccount({});
    expect(headersOf(f, 1)[ACTIVE_ROLE_HEADER]).toBeUndefined();
    await clientWith(f).getAccount({ activeRole: undefined });
    expect(headersOf(f, 2)[ACTIVE_ROLE_HEADER]).toBeUndefined();
  });

  it('setActiveRole POSTs { role } as JSON to /account/active-role and returns the account acting as that role', async () => {
    const f = stubFetch(() => json(200, { data: { ...BOTH, activeRole: 'PROVIDER' }, meta }));
    const account = await clientWith(f).setActiveRole('PROVIDER');
    expect(account).toMatchObject({ accountId: ACCOUNT_ID, activeRole: 'PROVIDER', primaryRole: 'CUSTOMER' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/active-role');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ role: 'PROVIDER' });
    expect(headersOf(f)).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer access-token-1' });
    expect(String(init?.body)).not.toContain('access-token-1');
  });

  it('updateProfile PUTs the profile to /account/profile (optionally acting as a role) and returns the account', async () => {
    const profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
    const f = stubFetch(() => json(200, { data: { ...BOTH, profile }, meta }));
    const account = await clientWith(f).updateProfile(profile, { activeRole: 'CUSTOMER' });
    expect(account.profile).toEqual(profile);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/profile');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual(profile);
    expect(headersOf(f)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'CUSTOMER' });
    await clientWith(f).updateProfile({ firstName: 'Ana', lastName: 'M' });
    expect(headersOf(f, 1)[ACTIVE_ROLE_HEADER]).toBeUndefined();
  });

  it('keeps the existing GET and POST behaviour of the other methods (no accidental PUT, no header leak)', async () => {
    const f = stubFetch((url) =>
      url.endsWith('/system/info')
        ? json(200, {
            data: { service: 'api', environment: 'test', version: '1', apiVersion: 'v1', serverTime: new Date().toISOString(), uptimeSeconds: 1 },
            meta,
          })
        : json(200, { data: { evaluatedAt: new Date().toISOString(), items: [] }, meta }),
    );
    await clientWith(f).getSystemInfo();
    await clientWith(f).resolveManyContent({ keys: ['a.b'], locale: 'en-US' });
    expect(f.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
    for (const i of [0, 1]) expect(headersOf(f, i)[ACTIVE_ROLE_HEADER]).toBeUndefined();
  });

  it('maps every API failure to ApiError with the standard code, category, correlation id and details', async () => {
    const roleRefused = errorBody('ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: 'PROVIDER' });
    const err = await clientWith(stubFetch(() => json(403, roleRefused)))
      .setActiveRole('PROVIDER')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 403,
      code: 'ACCOUNT_ROLE_NOT_HELD',
      category: 'AUTHORIZATION',
      correlationId: 'corr-err-1234',
      details: { role: 'PROVIDER' },
    });

    const issues = { reason: 'INVALID_PROFILE', issues: [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }] };
    await expect(
      clientWith(stubFetch(() => json(400, errorBody('ACCOUNT_VALIDATION_FAILED', 'VALIDATION', issues)))).updateProfile({ firstName: 'x', lastName: 'y' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'ACCOUNT_VALIDATION_FAILED',
      details: issues,
    });
    await expect(
      clientWith(
        stubFetch(() => json(401, errorBody('AUTHENTICATION_REQUIRED', 'AUTHENTICATION'))),
        undefined,
      ).getAccount(),
    ).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
    for (const [status, code] of [
      [403, 'ACCOUNT_SUSPENDED'],
      [403, 'ACCOUNT_CLOSED'],
      [403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED'],
      [503, 'ACCOUNT_UNAVAILABLE'],
    ] as const)
      await expect(
        clientWith(stubFetch(() => json(status, errorBody(code, status === 503 ? 'DEPENDENCY' : 'AUTHORIZATION')))).getAccount(),
      ).rejects.toMatchObject({ status, code });
    // a failure that is not the standard envelope is an unexpected response, not a crash
    await expect(clientWith(stubFetch(() => json(500, { oops: true }))).getAccount()).rejects.toMatchObject({
      status: 500,
      code: 'UNEXPECTED_RESPONSE',
      category: 'INTERNAL',
    });
  });

  it('reports an unreachable API as a DEPENDENCY error and a body that breaks the contract as UNEXPECTED_RESPONSE', async () => {
    const unreachable = await clientWith(
      stubFetch(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    )
      .getAccount()
      .catch((e) => e);
    expect(unreachable).toMatchObject({ status: 0, code: 'API_UNREACHABLE', category: 'DEPENDENCY' });
    const broken: Record<string, AccountDto | Record<string, unknown>> = {
      'unknown status': { ...BOTH, status: 'WEIRD' },
      'not a uuid': { ...BOTH, accountId: 'nope' },
      'role without a key': { ...BOTH, roles: [{ code: 'CUSTOMER' }] },
      'numeric active role': { ...BOTH, activeRole: 7 } as Record<string, unknown>,
      'missing roles': { accountId: ACCOUNT_ID, status: 'ACTIVE' },
    };
    for (const [what, data] of Object.entries(broken))
      await expect(clientWith(stubFetch(() => json(200, { data, meta }))).getAccount(), what).rejects.toMatchObject({
        status: 200,
        code: 'UNEXPECTED_RESPONSE',
        category: 'INTERNAL',
      });
    await expect(clientWith(stubFetch(() => json(200, { data: BOTH }))).setActiveRole('PROVIDER')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' }); // no meta
  });
});

// ---------------------------------------------------------------- the role switch
const PUBLIC = 'http://app.localhost:8080';
const cfg: AuthConfig = {
  clientId: 'bananagig-web',
  webOrigin: new URL(PUBLIC).origin,
  webPublicUrl: PUBLIC,
  redirectUri: `${PUBLIC}/auth/callback`,
  postLogoutRedirectUri: `${PUBLIC}/`,
  endpoints: {
    authorization: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/auth',
    endSession: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/logout',
    token: 'http://keycloak-auth:8080/realms/bananagig/protocol/openid-connect/token',
  },
  cookieSecure: false,
  sessionCookie: 'bg_session',
  txCookie: 'bg_auth_tx',
};
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };

interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  apiCalls: { token: string; role: string }[];
  tokenCalls: URLSearchParams[];
  logs: string[];
  clock: { now: number };
  /** What the API answers to the switch. */
  api: { answer: (role: string) => Promise<AccountDto> };
  setTokenResponse(fn: (body: URLSearchParams) => Promise<Response>): void;
}
function harness(over: Partial<AuthDeps> = {}): Harness {
  const store = new MemorySessionStore();
  const apiCalls: Harness['apiCalls'] = [];
  const tokenCalls: URLSearchParams[] = [];
  const logs: string[] = [];
  const clock = { now: Math.floor(Date.now() / 1000) };
  const api = { answer: async (role: string): Promise<AccountDto> => ({ ...BOTH, activeRole: role }) };
  let responder: (body: URLSearchParams) => Promise<Response> = async () => new Response('{}', { status: 500 });
  const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    tokenCalls.push(body);
    return responder(body);
  }) as typeof fetch;
  const deps: AuthDeps = {
    cfg,
    store,
    verifier: {} as never, // only a token refresh uses it
    fetch: fetchStub,
    now: () => clock.now,
    api: (token) => ({
      setActiveRole: async (role) => {
        apiCalls.push({ token, role });
        return api.answer(role);
      },
    }),
    log: (level, message, attrs) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    ...over,
  };
  return { deps, store, apiCalls, tokenCalls, logs, clock, api, setTokenResponse: (fn) => (responder = fn) };
}
const seed = (h: Harness, over: Partial<SessionRecord> = {}, id = 'sid-1'): SessionRecord => {
  const record: SessionRecord = {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    idToken: TOKENS.id,
    accessExpiresAt: h.clock.now + 3600,
    createdAt: h.clock.now,
    ...over,
  };
  h.store.sessions.set(id, record);
  return record;
};
interface PostOptions {
  method?: string;
  /** null: no Origin header. */
  origin?: string | null;
  /** null: no cookie. */
  cookie?: string | null;
  body?: BodyInit | null;
  headers?: Record<string, string>;
}
const post = (fields: Record<string, string> | undefined, o: PostOptions = {}): Request => {
  const method = o.method ?? 'POST';
  return new Request('http://web-app:3000/auth/active-role', {
    method,
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? PUBLIC }),
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? 'bg_session=sid-1' }),
      ...o.headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: o.body !== undefined ? o.body : fields ? new URLSearchParams(fields) : undefined }),
  });
};
const visible = (res: Response): string => [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`)].join('\n');

describe('POST /auth/active-role (handleActiveRole)', () => {
  it('is POST only: every other method is 405 and nothing is called or changed', async () => {
    const h = harness();
    const before = seed(h);
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleActiveRole(post({ role: 'PROVIDER' }, { method }), h.deps);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    expect(h.apiCalls).toEqual([]);
    expect(h.store.sessions.get('sid-1')).toEqual(before);
  });

  it('is same-origin only: a missing, foreign or lookalike Origin is 403, and the session is kept untouched', async () => {
    const h = harness();
    const before = seed(h);
    for (const origin of [null, 'http://evil.example', 'http://app.localhost:9999', 'https://app.localhost:8080', 'null', `${PUBLIC}.evil.example`]) {
      const res = await handleActiveRole(post({ role: 'PROVIDER' }, { origin }), h.deps);
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    expect(h.apiCalls).toEqual([]);
    expect(h.store.sessions.get('sid-1')).toEqual(before);
  });

  it('requires a session: no cookie, an unknown session id or another cookie only redirect to /session and call nothing', async () => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown', 'other=sid-1', 'bg_session=']) {
      const res = await handleActiveRole(post({ role: 'PROVIDER' }, { cookie }), h.deps);
      expect(res.status, String(cookie)).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    }
    expect(h.apiCalls).toEqual([]);
    expect(h.store.sessions.size).toBe(0);
  });

  it('on API success stores the role in the server session (nothing else changes) and redirects to /session; the browser gets no token, no cookie, no body', async () => {
    const h = harness();
    const before = seed(h);
    const res = await handleActiveRole(post({ role: 'PROVIDER' }), h.deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'location']);
    for (const secret of [...Object.values(TOKENS), 'PROVIDER']) expect(visible(res), secret).not.toContain(secret);
    // the API was asked once, with the session access token
    expect(h.apiCalls).toEqual([{ token: TOKENS.access, role: 'PROVIDER' }]);
    // the record is the same record plus the role: same tokens, same expiry, same id
    expect(h.store.sessions.size).toBe(1);
    expect(h.store.sessions.get('sid-1')).toEqual({ ...before, activeRole: 'PROVIDER' });
    // no new Keycloak login or refresh: the token endpoint was never called and no login transaction exists
    expect(h.tokenCalls).toEqual([]);
    expect(h.store.transactions.size).toBe(0);
    expect(h.logs.join('\n')).not.toMatch(/SECRET/);
  });

  it('switches back and repeats idempotently', async () => {
    const h = harness();
    seed(h);
    const roleAfter = async (role: string) => {
      expect((await handleActiveRole(post({ role }), h.deps)).status).toBe(303);
      return h.store.sessions.get('sid-1')!.activeRole;
    };
    expect(await roleAfter('PROVIDER')).toBe('PROVIDER');
    expect(await roleAfter('PROVIDER')).toBe('PROVIDER');
    expect(await roleAfter('CUSTOMER')).toBe('CUSTOMER');
    expect(h.apiCalls.map((c) => c.role)).toEqual(['PROVIDER', 'PROVIDER', 'CUSTOMER']);
    expect(h.tokenCalls).toEqual([]);
  });

  it('leaves the session unchanged and redirects to /session?error=role when the API answers 403 (role not held, not active, suspended, closed)', async () => {
    for (const code of ['ACCOUNT_ROLE_NOT_HELD', 'ACCOUNT_ROLE_NOT_ACTIVE', 'ACCOUNT_SUSPENDED', 'ACCOUNT_CLOSED']) {
      const h = harness();
      const before = seed(h, { activeRole: 'CUSTOMER' });
      h.api.answer = async () => {
        throw new ApiError(403, code, 'AUTHORIZATION', 'refused', 'corr-1');
      };
      const res = await handleActiveRole(post({ role: 'PROVIDER' }), h.deps);
      expect(res.status, code).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session?error=role`);
      expect(h.store.sessions.get('sid-1'), code).toEqual(before);
      expect(h.tokenCalls).toEqual([]);
      expect(visible(res)).not.toMatch(/SECRET/);
      const log = h.logs.find((l) => l.includes('refused'))!;
      expect(JSON.parse(log)).toMatchObject({ level: 'warn', message: 'active role switch refused', code, status: 403 });
      expect(log).not.toMatch(/SECRET|PROVIDER/);
    }
  });

  it('changes nothing either when the API fails, is unreachable, or answers with a different role', async () => {
    const failures: [string, (role: string) => Promise<AccountDto>][] = [
      [
        'unavailable',
        async () => {
          throw new ApiError(503, 'ACCOUNT_UNAVAILABLE', 'DEPENDENCY', 'down');
        },
      ],
      [
        'unreachable',
        async () => {
          throw new ApiError(0, 'API_UNREACHABLE', 'DEPENDENCY', 'down');
        },
      ],
      [
        'unauthenticated',
        async () => {
          throw new ApiError(401, 'INVALID_TOKEN', 'AUTHENTICATION', 'expired');
        },
      ],
      [
        'unexpected error',
        async () => {
          throw new Error('boom');
        },
      ],
      ['other role', async () => ({ ...BOTH, activeRole: 'CUSTOMER' })],
      ['no active role', async () => ({ ...BOTH, activeRole: null })],
    ];
    for (const [what, answer] of failures) {
      const h = harness();
      const before = seed(h);
      h.api.answer = answer;
      const res = await handleActiveRole(post({ role: 'PROVIDER' }), h.deps);
      expect(res.headers.get('location'), what).toBe(`${PUBLIC}/session?error=role`);
      expect(h.store.sessions.get('sid-1'), what).toEqual(before);
    }
  });

  it('rejects a body that is not the switch form (missing, malformed or lowercase role, JSON, empty) with 400 before calling the API', async () => {
    const h = harness();
    const before = seed(h);
    const bad: [string, Request][] = [
      ['no role field', post({})],
      ['empty role', post({ role: '' })],
      ['lowercase', post({ role: 'provider' })],
      ['with a space', post({ role: 'PRO VIDER' })],
      ['too long', post({ role: 'A'.repeat(31) })],
      ['wrong field name', post({ activeRole: 'PROVIDER' })],
      ['json body', post(undefined, { body: JSON.stringify({ role: 'PROVIDER' }), headers: { 'content-type': 'application/json' } })],
      ['no body', post(undefined, { body: null })],
    ];
    for (const [what, req] of bad) {
      const res = await handleActiveRole(req, h.deps);
      expect(res.status, what).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(h.apiCalls).toEqual([]);
    expect(h.store.sessions.get('sid-1')).toEqual(before);
  });

  it('refuses to run without an API client (a wiring mistake must be loud, not a silent no-op)', async () => {
    const h = harness({ api: undefined });
    seed(h);
    await expect(handleActiveRole(post({ role: 'PROVIDER' }), h.deps)).rejects.toThrow(/AuthDeps\.api/);
    // but the cheap refusals still come first
    expect((await handleActiveRole(post({ role: 'PROVIDER' }, { method: 'GET' }), h.deps)).status).toBe(405);
  });

  it('does not overwrite a token refresh that happened while the API call ran', async () => {
    const h = harness();
    seed(h);
    h.api.answer = async (role) => {
      // another request refreshed the tokens during the API call
      h.store.sessions.set('sid-1', { ...h.store.sessions.get('sid-1')!, accessToken: 'tok-access-REFRESHED', refreshToken: 'tok-refresh-ROTATED' });
      return { ...BOTH, activeRole: role };
    };
    await handleActiveRole(post({ role: 'PROVIDER' }), h.deps);
    expect(h.store.sessions.get('sid-1')).toMatchObject({ activeRole: 'PROVIDER', accessToken: 'tok-access-REFRESHED', refreshToken: 'tok-refresh-ROTATED' });
  });

  it('does nothing when the session disappeared during the API call (no resurrection of a logged-out session)', async () => {
    const h = harness();
    seed(h);
    h.api.answer = async (role) => {
      h.store.sessions.delete('sid-1');
      return { ...BOTH, activeRole: role };
    };
    const res = await handleActiveRole(post({ role: 'PROVIDER' }), h.deps);
    expect(res.status).toBe(303);
    expect(h.store.sessions.size).toBe(0);
  });

  it('keeps the role across a token refresh and forgets it on request, leaving the tokens alone', async () => {
    const keys: TestKeys = await createTestKeys('k1');
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const h = harness({ verifier });
    seed(h, { activeRole: 'PROVIDER', accessExpiresAt: h.clock.now + 10 }); // inside the refresh skew
    h.setTokenResponse(async () =>
      json(200, {
        access_token: await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] } } }),
        refresh_token: 'rotated-refresh',
        id_token: await signToken(keys, { claims: { typ: 'ID', aud: 'bananagig-web', azp: 'bananagig-web', nonce: 'n' } }),
        expires_in: 300,
        refresh_expires_in: 1800,
      }),
    );
    const s = await getSession('bg_session=sid-1', h.deps);
    expect(h.tokenCalls.map((c) => c.get('grant_type'))).toEqual(['refresh_token']);
    expect(s?.record).toMatchObject({ activeRole: 'PROVIDER', refreshToken: 'rotated-refresh' });
    expect(h.store.sessions.get('sid-1')!.activeRole).toBe('PROVIDER');

    await forgetActiveRole('sid-1', h.deps);
    const after = h.store.sessions.get('sid-1')!;
    expect('activeRole' in after).toBe(false);
    expect(after.refreshToken).toBe('rotated-refresh');
    await forgetActiveRole('sid-1', h.deps); // nothing to forget: no change, no error
    await forgetActiveRole('missing', h.deps);
    expect(h.store.sessions.get('sid-1')).toEqual(after);
  });

  it('forwards the remembered role as x-active-role on later account calls (real client, stub fetch)', async () => {
    const seen: { method: string; url: string; role: string | undefined; auth: string | undefined }[] = [];
    const f = stubFetch((url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ method: String(init.method), url, role: headers[ACTIVE_ROLE_HEADER], auth: headers.authorization });
      const role = (init.body ? (JSON.parse(String(init.body)) as { role: string }).role : headers[ACTIVE_ROLE_HEADER]) ?? 'CUSTOMER';
      return json(200, { data: { ...BOTH, activeRole: role }, meta });
    });
    const real = (token: string) => createApiClient({ baseUrl: 'http://api.test', fetch: f as unknown as typeof fetch, accessToken: () => token });
    const h = harness({ api: (token) => real(token) });
    seed(h);
    expect((await handleActiveRole(post({ role: 'PROVIDER' }), h.deps)).headers.get('location')).toBe(`${PUBLIC}/session`);
    const record = h.store.sessions.get('sid-1')!;
    const account = await real(record.accessToken).getAccount({ activeRole: record.activeRole });
    expect(account.activeRole).toBe('PROVIDER');
    expect(seen).toEqual([
      { method: 'POST', url: 'http://api.test/api/v1/account/active-role', role: undefined, auth: `Bearer ${TOKENS.access}` },
      { method: 'GET', url: 'http://api.test/api/v1/account/me', role: 'PROVIDER', auth: `Bearer ${TOKENS.access}` },
    ]);
    expect(h.tokenCalls).toEqual([]);
  });
});

describe('/auth/active-role route', () => {
  it('exposes POST (and GET, which the handler answers with 405) wired to the handler with the process-wide deps', async () => {
    expect(Object.keys(routeModule).sort()).toEqual(['GET', 'POST', 'dynamic']);
    const h = harness();
    routeState.deps = h.deps;
    seed(h);
    const ok = await routePost(post({ role: 'PROVIDER' }));
    expect(ok.status).toBe(303);
    expect(h.store.sessions.get('sid-1')!.activeRole).toBe('PROVIDER');
    const get = await routeGet(post(undefined, { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await routePost(post({ role: 'PROVIDER' }, { origin: 'http://evil.example' }))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- the Valkey session store
class FakeValkey implements ValkeyLike {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly commands: unknown[][] = [];
  async set(key: string, value: string, mode: 'EX' | 'KEEPTTL', arg: number | 'XX'): Promise<unknown> {
    this.commands.push(['set', key, mode, arg]);
    if (mode === 'EX') {
      this.values.set(key, value);
      this.ttls.set(key, arg as number);
      return 'OK';
    }
    if (!this.values.has(key)) return null; // XX: only an existing key; KEEPTTL: the TTL stays what it was
    this.values.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async del(key: string): Promise<unknown> {
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
  async getdel(key: string): Promise<string | null> {
    const v = this.values.get(key) ?? null;
    await this.del(key);
    return v;
  }
}

describe('session store: updateSession keeps the remaining lifetime', () => {
  const record: SessionRecord = {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    accessExpiresAt: 2_000_000_000,
    createdAt: 1_900_000_000,
  };
  it('Valkey: rewrites an existing session with KEEPTTL XX (no new expiry) and refuses to resurrect a missing one', async () => {
    const client = new FakeValkey();
    const store = new ValkeySessionStore(client, 'test');
    await store.putSession('s1', record, 1800.9);
    const key = 'bg:test:web:session:s1';
    expect(client.ttls.get(key)).toBe(1800);
    expect(await store.updateSession('s1', { ...record, activeRole: 'PROVIDER' })).toBe(true);
    expect(client.commands.at(-1)).toEqual(['set', key, 'KEEPTTL', 'XX']);
    expect(client.ttls.get(key), 'the lifetime was not reset').toBe(1800);
    expect(await store.getSession('s1')).toEqual({ ...record, activeRole: 'PROVIDER' });
    // a session that expired or was logged out is not brought back
    await store.deleteSession('s1');
    expect(await store.updateSession('s1', record)).toBe(false);
    expect(await store.getSession('s1')).toBeNull();
    expect(client.values.size).toBe(0);
  });
  it('memory: updates only an existing session', async () => {
    const store = new MemorySessionStore();
    expect(await store.updateSession('s1', record)).toBe(false);
    expect(store.sessions.size).toBe(0);
    await store.putSession('s1', record);
    expect(await store.updateSession('s1', { ...record, activeRole: 'CUSTOMER' })).toBe(true);
    expect((await store.getSession('s1'))?.activeRole).toBe('CUSTOMER');
  });
});
