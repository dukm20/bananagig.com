import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeycloakAdminClient, KeycloakAdminError, TOKEN_EXPIRY_MARGIN_MS, type KeycloakAdminErrorCode, type KeycloakAdminOptions } from './keycloak-admin';

const SECRET = 'bananagig_security_dev_only_secret_0001';
const TOKEN = 'eyJ.access.token-value-1';
const USER = '3f6c1e1a-0b6f-4b4e-9d57-2f0f4c7b8a11';
const SID = '9a1b2c3d-1111-2222-3333-444455556666';
const BASE = 'http://keycloak-auth:8080';

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
  redirect: RequestInit['redirect'];
}
type Responder = (req: Recorded) => Response | Promise<Response>;

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const empty = (status = 204): Response => new Response(null, { status });
const tokenResponse = (expiresIn: number | null = 300, token = TOKEN): Response =>
  json({ access_token: token, token_type: 'Bearer', ...(expiresIn === null ? {} : { expires_in: expiresIn }) });

/** A scripted fetch: the token endpoint is answered by `token`, every other call by `api`. All calls are recorded. */
function harness(api: Responder, token: Responder = () => tokenResponse(), overrides: Partial<KeycloakAdminOptions> = {}) {
  const calls: Recorded[] = [];
  let clock = 1_700_000_000_000;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body === undefined ? undefined : String(init.body),
      signal: init?.signal,
      redirect: init?.redirect,
    };
    calls.push(rec);
    return rec.url.pathname.endsWith('/protocol/openid-connect/token') ? token(rec) : api(rec);
  }) as typeof fetch;
  const client = new KeycloakAdminClient({
    baseUrl: BASE,
    realm: 'bananagig',
    clientId: 'bananagig-security',
    clientSecret: SECRET,
    fetch: fetchFake,
    now: () => clock,
    ...overrides,
  });
  return {
    client,
    calls,
    tokenCalls: () => calls.filter((c) => c.url.pathname.endsWith('/protocol/openid-connect/token')),
    apiCalls: () => calls.filter((c) => !c.url.pathname.endsWith('/protocol/openid-connect/token')),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<{ code: KeycloakAdminErrorCode; status?: number; message: string; err: KeycloakAdminError }> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(KeycloakAdminError);
  const e = err as KeycloakAdminError;
  return { code: e.code, status: e.status, message: e.message, err: e };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('construction', () => {
  const ok = { baseUrl: BASE, realm: 'bananagig', clientId: 'c', clientSecret: SECRET };
  it('is available', () => {
    expect(new KeycloakAdminClient(ok).available).toBe(true);
  });
  it.each([
    ['baseUrl not a URL', { baseUrl: 'keycloak' }],
    ['baseUrl not http(s)', { baseUrl: 'ftp://keycloak' }],
    ['no realm', { realm: '' }],
    ['no client id', { clientId: '' }],
    ['no secret', { clientSecret: '' }],
    ['a reset client without a redirect', { resetEmail: { clientId: 'bananagig-web', redirectUri: '' } }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['a fractional timeout', { timeoutMs: 1.5 }],
  ])('refuses %s without echoing the secret', (_name, patch) => {
    let message = '';
    try {
      new KeycloakAdminClient({ ...ok, ...patch });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/KeycloakAdminClient/);
    expect(message).not.toContain(SECRET);
  });
});

describe('client-credentials token', () => {
  it('posts the grant to the realm token endpoint as a form and uses the token as a Bearer', async () => {
    const h = harness(() => json([]));
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(1);
    const t = h.tokenCalls()[0]!;
    expect(t.method).toBe('POST');
    expect(t.url.toString()).toBe(`${BASE}/realms/bananagig/protocol/openid-connect/token`);
    expect(t.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(t.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'bananagig-security', client_secret: SECRET });
    expect(t.url.search).toBe(''); // the secret is in the body, never in the URL
    expect(h.apiCalls()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('strips trailing slashes of the base URL', async () => {
    const h = harness(() => json([]), undefined, { baseUrl: `${BASE}//` });
    await h.client.listSessions(USER);
    expect(h.tokenCalls()[0]!.url.toString()).toBe(`${BASE}/realms/bananagig/protocol/openid-connect/token`);
    expect(h.apiCalls()[0]!.url.toString()).toBe(`${BASE}/admin/realms/bananagig/users/${USER}/sessions`);
  });

  it('encodes the realm in both URLs', async () => {
    const h = harness(() => json([]), undefined, { realm: 'my realm/x' });
    await h.client.listSessions(USER);
    expect(h.tokenCalls()[0]!.url.pathname).toBe('/realms/my%20realm%2Fx/protocol/openid-connect/token');
    expect(h.apiCalls()[0]!.url.pathname).toBe(`/admin/realms/my%20realm%2Fx/users/${USER}/sessions`);
  });

  it('caches the token across calls', async () => {
    const h = harness(() => json([]));
    await h.client.listSessions(USER);
    await h.client.listSessions(USER);
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(1);
    expect(h.apiCalls()).toHaveLength(3);
  });

  it('reuses the token until 30 s before it expires and fetches a new one from then on', async () => {
    let n = 0;
    const h = harness(
      () => json([]),
      () => tokenResponse(300, `token-${++n}`),
    );
    expect(TOKEN_EXPIRY_MARGIN_MS).toBe(30_000);
    await h.client.listSessions(USER);
    h.advance(300_000 - 30_000 - 1); // one millisecond before the margin
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(1);
    h.advance(1); // exactly 30 s before expiry: no longer used
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(2);
    expect(h.apiCalls().map((c) => c.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  });

  it('never caches a token whose lifetime is within the margin', async () => {
    const h = harness(
      () => json([]),
      () => tokenResponse(30),
    );
    await h.client.listSessions(USER);
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(2);
  });

  it('uses a token without a usable lifetime once and does not cache it', async () => {
    const h = harness(
      () => json([]),
      () => tokenResponse(null),
    );
    await h.client.listSessions(USER);
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(2);
    expect(h.apiCalls()).toHaveLength(2);
  });

  it('shares ONE in-flight refresh between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(
      () => json([]),
      async () => {
        await gate;
        return tokenResponse();
      },
    );
    const all = Promise.all([
      h.client.listSessions(USER),
      h.client.listSessions(USER),
      h.client.endSession(SID),
      h.client.getUserSecurity(USER).catch(() => 'x'),
    ]);
    await vi.waitFor(() => expect(h.tokenCalls()).toHaveLength(1));
    release();
    await all;
    expect(h.tokenCalls()).toHaveLength(1);
    expect(h.apiCalls().length).toBeGreaterThanOrEqual(3);
    expect(new Set(h.apiCalls().map((c) => c.headers.authorization))).toEqual(new Set([`Bearer ${TOKEN}`]));
  });

  it('gives every concurrent caller the failure of a shared refresh and retries on the next call', async () => {
    let fail = true;
    const h = harness(
      () => json([]),
      () => (fail ? new Response('{"error":"unauthorized_client","error_description":"secret leaked here"}', { status: 401 }) : tokenResponse()),
    );
    const results = await Promise.allSettled([h.client.listSessions(USER), h.client.listSessions(USER), h.client.listSessions(USER)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(h.tokenCalls()).toHaveLength(1);
    fail = false;
    await expect(h.client.listSessions(USER)).resolves.toEqual([]); // nothing was cached from the failure
    expect(h.tokenCalls()).toHaveLength(2);
  });

  it.each([
    [400, 'TOKEN_REJECTED'],
    [401, 'TOKEN_REJECTED'],
    [403, 'TOKEN_UNAVAILABLE'],
    [500, 'TOKEN_UNAVAILABLE'],
    [503, 'TOKEN_UNAVAILABLE'],
  ] as const)('reduces a %i from the token endpoint to %s and sends no API request', async (status, code) => {
    const h = harness(
      () => json([]),
      () => new Response(`{"error":"x","secret":"${SECRET}"}`, { status }),
    );
    const e = await codeOf(h.client.listSessions(USER));
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
    expect(h.apiCalls()).toHaveLength(0);
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['no access_token', () => json({ expires_in: 300 })],
    ['an empty access_token', () => json({ access_token: '', expires_in: 300 })],
    ['a non-string access_token', () => json({ access_token: 5, expires_in: 300 })],
    ['a JSON array', () => json([TOKEN])],
  ])('rejects a 200 token response that is %s', async (_n, token) => {
    const h = harness(() => json([]), token);
    expect((await codeOf(h.client.listSessions(USER))).code).toBe('TOKEN_UNAVAILABLE');
  });

  it('drops the cached token after a 401 from the admin API so the next call fetches a new one (and does not retry the failed call)', async () => {
    let status = 401;
    let n = 0;
    const h = harness(
      () => (status === 401 ? new Response('', { status: 401 }) : json([])),
      () => tokenResponse(300, `token-${++n}`),
    );
    expect((await codeOf(h.client.listSessions(USER))).code).toBe('UNAUTHORIZED');
    expect(h.apiCalls()).toHaveLength(1); // no retry
    status = 200;
    await h.client.listSessions(USER);
    expect(h.tokenCalls()).toHaveLength(2);
    expect(h.apiCalls()[1]!.headers.authorization).toBe('Bearer token-2');
  });
});

describe('getUserSecurity', () => {
  const day = Date.UTC(2026, 9, 1, 12, 0, 0);
  const respond =
    (user: unknown, credentials: unknown): Responder =>
    (req) =>
      req.url.pathname.endsWith('/credentials') ? json(credentials) : json(user);

  it('reads the user and the credential list with two GETs and reduces them to flags, a date and a lower-case email', async () => {
    const h = harness(
      respond({ id: USER, username: 'x', email: '  Dana.Lee@Example.COM ', emailVerified: true }, [
        { id: 'c1', type: 'password', createdDate: day - 5000, secretData: '{"value":"hash"}', credentialData: '{}' },
        { id: 'c2', type: 'otp', createdDate: day, userLabel: 'phone' },
        { id: 'c3', type: 'recovery-authn-codes', createdDate: day },
      ]),
    );
    const out = await h.client.getUserSecurity(USER);
    expect(out).toEqual({ otpConfigured: true, recoveryCodesConfigured: true, passwordChangedAt: new Date(day - 5000), email: 'dana.lee@example.com' });
    const paths = h.apiCalls().map((c) => `${c.method} ${c.url.pathname}`);
    expect(paths.sort()).toEqual([`GET /admin/realms/bananagig/users/${USER}`, `GET /admin/realms/bananagig/users/${USER}/credentials`]);
    expect(Object.keys(out).sort()).toEqual(['email', 'otpConfigured', 'passwordChangedAt', 'recoveryCodesConfigured']);
  });

  it('reports no second factor, no password date and no email when Keycloak has none', async () => {
    const h = harness(respond({ id: USER }, [{ id: 'c', type: 'password' }]));
    expect(await h.client.getUserSecurity(USER)).toEqual({ otpConfigured: false, recoveryCodesConfigured: false, passwordChangedAt: null, email: null });
  });

  it.each([null, '', '   ', 5, {}])('treats the email %j as none', async (email) => {
    const h = harness(respond({ id: USER, email }, []));
    expect((await h.client.getUserSecurity(USER)).email).toBeNull();
  });

  it('takes the NEWEST password credential and ignores unusable dates', async () => {
    const h = harness(
      respond({ id: USER }, [
        { type: 'password', createdDate: day - 10_000 },
        { type: 'password', createdDate: day },
        { type: 'password', createdDate: 'yesterday' },
        { type: 'password', createdDate: -1 },
        { type: 'password', createdDate: 0 },
      ]),
    );
    expect((await h.client.getUserSecurity(USER)).passwordChangedAt).toEqual(new Date(day));
  });

  it('does not mistake other credential types (webauthn, a label) for TOTP or recovery codes', async () => {
    const h = harness(
      respond({ id: USER }, [{ type: 'webauthn' }, { type: 'password', userLabel: 'otp' }, { type: 'OTP' }, { type: 'recovery-authn-codes-old' }]),
    );
    const out = await h.client.getUserSecurity(USER);
    expect(out.otpConfigured).toBe(false);
    expect(out.recoveryCodesConfigured).toBe(false);
  });

  it.each([
    ['a credentials object', { id: USER }, {}],
    ['a credentials string', { id: USER }, 'x'],
    ['a credential entry without a type', { id: USER }, [{ createdDate: 1 }]],
    ['a null credential entry', { id: USER }, [null]],
    ['a user array', [], []],
    ['a null user', null, []],
  ])('fails with INVALID_RESPONSE on %s', async (_n, user, credentials) => {
    const h = harness(respond(user, credentials));
    expect((await codeOf(h.client.getUserSecurity(USER))).code).toBe('INVALID_RESPONSE');
  });

  it('fails with NOT_FOUND when the user does not exist', async () => {
    const h = harness((req) => (req.url.pathname.endsWith('/credentials') ? json([]) : new Response('{"error":"User not found"}', { status: 404 })));
    expect(await codeOf(h.client.getUserSecurity(USER))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('listSessions', () => {
  it('maps the protocol sessions and sends one GET', async () => {
    const h = harness(() =>
      json([
        {
          id: SID,
          username: 'dana',
          ipAddress: '203.0.113.9',
          start: 1_700_000_000_000,
          lastAccess: 1_700_000_100_000,
          clients: { a: 'bananagig-web' },
          rememberMe: true,
        },
        { id: 'sid-2', start: 1_700_000_200_000 },
      ]),
    );
    const out = await h.client.listSessions(USER);
    expect(out).toEqual([
      { id: SID, startedAt: new Date(1_700_000_000_000), lastAccessAt: new Date(1_700_000_100_000) },
      { id: 'sid-2', startedAt: new Date(1_700_000_200_000), lastAccessAt: new Date(1_700_000_200_000) },
    ]);
    // no raw IP or username leaves the client
    expect(JSON.stringify(out)).not.toContain('203.0.113.9');
    expect(h.apiCalls().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /admin/realms/bananagig/users/${USER}/sessions`]);
  });
  it('returns an empty list', async () => {
    expect(await harness(() => json([])).client.listSessions(USER)).toEqual([]);
  });
  it.each([
    ['an object', {}],
    ['a null', null],
    ['an entry without id', [{ start: 1 }]],
    ['an entry with an empty id', [{ id: '', start: 1 }]],
    ['an entry with a numeric id', [{ id: 5, start: 1 }]],
    ['an entry without start', [{ id: 'a' }]],
    ['an entry with a string start', [{ id: 'a', start: 'now' }]],
    ['a null entry', [null]],
    ['one malformed entry among valid ones', [{ id: 'a', start: 1 }, { id: 'b' }]],
  ])('fails the whole call with INVALID_RESPONSE for %s (a dropped session would look ended)', async (_n, body) => {
    expect((await codeOf(harness(() => json(body)).client.listSessions(USER))).code).toBe('INVALID_RESPONSE');
  });
  it('fails with INVALID_RESPONSE on a 200 that is not JSON', async () => {
    expect((await codeOf(harness(() => new Response('oops', { status: 200 })).client.listSessions(USER))).code).toBe('INVALID_RESPONSE');
  });
});

describe('endSession', () => {
  it('sends DELETE to the realm sessions endpoint and resolves on 204', async () => {
    const h = harness(() => empty(204));
    await expect(h.client.endSession(SID)).resolves.toBeUndefined();
    expect(h.apiCalls().map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`DELETE /admin/realms/bananagig/sessions/${SID}`]);
    expect(h.apiCalls()[0]!.body).toBeUndefined();
  });
  it('treats 404 (the session is already gone) as success', async () => {
    const h = harness(() => new Response('{"error":"Session not found"}', { status: 404 }));
    await expect(h.client.endSession(SID)).resolves.toBeUndefined();
  });
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
    [502, 'PROVIDER_ERROR'],
    [302, 'UNEXPECTED_STATUS'],
  ] as const)('maps %i to %s', async (status, code) => {
    const h = harness(() => new Response('', { status }));
    expect(await codeOf(h.client.endSession(SID))).toMatchObject({ code, status });
  });
});

describe('endAllSessions', () => {
  it('sends POST users/{id}/logout without a body', async () => {
    const h = harness(() => empty(204));
    await h.client.endAllSessions(USER);
    const c = h.apiCalls()[0]!;
    expect(`${c.method} ${c.url.pathname}`).toBe(`POST /admin/realms/bananagig/users/${USER}/logout`);
    expect(c.body).toBeUndefined();
    expect(c.headers['content-type']).toBeUndefined();
  });
  it('does NOT treat a 404 (unknown user) as success', async () => {
    const h = harness(() => new Response('', { status: 404 }));
    expect(await codeOf(h.client.endAllSessions(USER))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('sendPasswordResetEmail', () => {
  it('sends PUT execute-actions-email with the lifespan and ["UPDATE_PASSWORD"]', async () => {
    const h = harness(() => empty(204));
    await h.client.sendPasswordResetEmail(USER, { lifespanSeconds: 3600 });
    const c = h.apiCalls()[0]!;
    expect(`${c.method} ${c.url.pathname}`).toBe(`PUT /admin/realms/bananagig/users/${USER}/execute-actions-email`);
    expect([...c.url.searchParams.entries()]).toEqual([['lifespan', '3600']]);
    expect(JSON.parse(c.body!)).toEqual(['UPDATE_PASSWORD']);
    expect(c.headers['content-type']).toBe('application/json');
  });
  it('adds client_id and redirect_uri (URL-encoded) when configured', async () => {
    const h = harness(() => empty(204), undefined, {
      resetEmail: { clientId: 'bananagig-web', redirectUri: 'http://app.localhost:8080/auth/callback?x=1&y=2' },
    });
    await h.client.sendPasswordResetEmail(USER, { lifespanSeconds: 60 });
    const u = h.apiCalls()[0]!.url;
    expect(u.searchParams.get('client_id')).toBe('bananagig-web');
    expect(u.searchParams.get('redirect_uri')).toBe('http://app.localhost:8080/auth/callback?x=1&y=2');
    expect(u.searchParams.get('lifespan')).toBe('60');
    expect(u.search).toContain('redirect_uri=http%3A%2F%2Fapp.localhost%3A8080%2Fauth%2Fcallback%3Fx%3D1%26y%3D2');
    expect([...u.searchParams.keys()].sort()).toEqual(['client_id', 'lifespan', 'redirect_uri']);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '60' as unknown as number, undefined as unknown as number])(
    'refuses the lifespan %j before sending anything',
    async (lifespanSeconds) => {
      const h = harness(() => empty(204));
      expect((await codeOf(h.client.sendPasswordResetEmail(USER, { lifespanSeconds }))).code).toBe('INVALID_INPUT');
      expect(h.calls).toHaveLength(0);
    },
  );
  it('refuses missing options', async () => {
    const h = harness(() => empty(204));
    expect((await codeOf(h.client.sendPasswordResetEmail(USER, undefined as unknown as { lifespanSeconds: number }))).code).toBe('INVALID_INPUT');
    expect(h.calls).toHaveLength(0);
  });
  it('accepts the largest lifespan Keycloak accepts', async () => {
    const h = harness(() => empty(204));
    await h.client.sendPasswordResetEmail(USER, { lifespanSeconds: 2_147_483_647 });
    expect(h.apiCalls()[0]!.url.searchParams.get('lifespan')).toBe('2147483647');
  });
  it('maps Keycloak refusing (a user without an email) and a mail failure to codes only', async () => {
    const bad = harness(() => new Response(`{"errorMessage":"User email missing for dana@example.com"}`, { status: 400 }));
    const e = await codeOf(bad.client.sendPasswordResetEmail(USER, { lifespanSeconds: 60 }));
    expect(e).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(e.message).not.toContain('dana@example.com');
    const down = harness(() => new Response('{"error":"Failed to send execute actions email"}', { status: 500 }));
    expect(await codeOf(down.client.sendPasswordResetEmail(USER, { lifespanSeconds: 60 }))).toMatchObject({ code: 'PROVIDER_ERROR', status: 500 });
  });
});

describe('ids in URLs', () => {
  it('percent-encodes an id so it can only ever be one path segment', async () => {
    const h = harness(() => json([]));
    await h.client.listSessions('a/b?c=d#e f%2F');
    const u = h.apiCalls()[0]!.url;
    expect(u.pathname).toBe('/admin/realms/bananagig/users/a%2Fb%3Fc%3Dd%23e%20f%252F/sessions');
    expect(u.search).toBe('');
    expect(u.hash).toBe('');
  });
  it('encodes session ids the same way', async () => {
    const h = harness(() => empty());
    await h.client.endSession('../../users/x');
    expect(h.apiCalls()[0]!.url.pathname).toBe('/admin/realms/bananagig/sessions/..%2F..%2Fusers%2Fx');
  });
  it.each(['', '.', '..', 'a\nb', 'a\u0000b', '\u007f', 'x'.repeat(129), undefined as unknown as string, 5 as unknown as string, null as unknown as string])(
    'refuses the id %j before sending anything (all operations)',
    async (id) => {
      const h = harness(() => json([]));
      for (const op of [
        () => h.client.getUserSecurity(id),
        () => h.client.listSessions(id),
        () => h.client.endSession(id),
        () => h.client.endAllSessions(id),
        () => h.client.sendPasswordResetEmail(id, { lifespanSeconds: 60 }),
      ])
        expect((await codeOf(op())).code).toBe('INVALID_INPUT');
      expect(h.calls).toHaveLength(0);
    },
  );
  it('accepts a 128-character id', async () => {
    const h = harness(() => json([]));
    await h.client.listSessions('x'.repeat(128));
    expect(h.apiCalls()).toHaveLength(1);
  });
});

describe('failures are reduced to a code', () => {
  const SECRETS = [SECRET, TOKEN, 'dana@example.com', USER, SID, '203.0.113.9', 'top-secret-body', 'Bearer'];
  const noLeak = (e: { err: KeycloakAdminError }) => {
    const serial = [
      e.err.message,
      e.err.stack?.split('\n')[0] ?? '',
      JSON.stringify(e.err),
      String(e.err),
      JSON.stringify(Object.getOwnPropertyNames(e.err)),
    ].join('\n');
    for (const s of SECRETS) expect(serial).not.toContain(s);
    expect((e.err as { cause?: unknown }).cause).toBeUndefined();
  };

  it('never carries the response body of an API error', async () => {
    const h = harness(
      () => new Response(`{"error":"top-secret-body","email":"dana@example.com","user":"${USER}","token":"${TOKEN}","ip":"203.0.113.9"}`, { status: 500 }),
    );
    const e = await codeOf(h.client.getUserSecurity(USER));
    noLeak(e);
    expect(e.message).toBe('keycloak admin PROVIDER_ERROR (500)');
  });

  it('never carries the token-endpoint body, the secret or the URL of a network failure', async () => {
    const h = harness(
      () => json([]),
      () => {
        throw new TypeError(`fetch failed: connect ECONNREFUSED ${BASE}/realms/bananagig/protocol/openid-connect/token client_secret=${SECRET}`);
      },
    );
    const e = await codeOf(h.client.listSessions(USER));
    expect(e.code).toBe('UNREACHABLE');
    noLeak(e);
    expect(e.message).toBe('keycloak admin UNREACHABLE');
  });

  it('reduces a network failure of an API call to UNREACHABLE without the thrown message', async () => {
    const h = harness(() => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND keycloak-auth for user ${USER} Bearer ${TOKEN}`), { code: 'ENOTFOUND' });
    });
    const e = await codeOf(h.client.endAllSessions(USER));
    expect(e.code).toBe('UNREACHABLE');
    noLeak(e);
  });

  it('reduces a rejected promise of any shape (a string, undefined) to UNREACHABLE', async () => {
    for (const thrown of ['boom', undefined, 42, null]) {
      const h = harness(() => Promise.reject(thrown));
      expect((await codeOf(h.client.listSessions(USER))).code).toBe('UNREACHABLE');
    }
  });

  it('cancels the body of an error response instead of reading it', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(new TextEncoder().encode('top-secret-body'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = harness(() => new Response(body, { status: 503 }));
    const e = await codeOf(h.client.listSessions(USER));
    noLeak(e);
    expect(cancelled).toBe(true);
  });

  it('exposes only a code and a status', async () => {
    const h = harness(() => new Response('', { status: 403 }));
    const e = await codeOf(h.client.listSessions(USER));
    expect(Object.keys(e.err).sort()).toEqual(['code', 'name', 'status']);
    expect(e.err.name).toBe('KeycloakAdminError');
  });

  it('passes redirect: error so a redirect to another host is never followed with the bearer token', async () => {
    const h = harness(() => json([]));
    await h.client.listSessions(USER);
    expect(h.calls.every((c) => c.redirect === 'error')).toBe(true);
  });
});

describe('timeouts', () => {
  /** A fetch that never answers but honours the abort signal. */
  const hang: Responder = (req) =>
    new Promise<Response>((_resolve, reject) => {
      req.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  it('gives every request an abort signal and aborts after 5 s by default (token request)', async () => {
    vi.useFakeTimers();
    const h = harness(() => json([]), hang);
    const p = codeOf(h.client.listSessions(USER));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.tokenCalls()[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.tokenCalls()[0]!.signal!.aborted).toBe(true);
    expect((await p).code).toBe('TIMEOUT');
    expect(h.apiCalls()).toHaveLength(0);
  });

  it('aborts an API request after 5 s by default and reports TIMEOUT', async () => {
    vi.useFakeTimers();
    const h = harness(hang);
    const p = codeOf(h.client.endAllSessions(USER));
    await vi.advanceTimersByTimeAsync(0); // token answered, API call started (waitFor would advance the fake clock)
    expect(h.apiCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.apiCalls()[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.apiCalls()[0]!.signal!.aborted).toBe(true);
    expect((await p).code).toBe('TIMEOUT');
  });

  it('the timeout also covers reading the body (as with a real fetch, aborting errors the body stream)', async () => {
    vi.useFakeTimers();
    const stalled = (req: Recorded): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            req.signal!.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
        { status: 200 },
      );
    const h = harness(stalled);
    const p = codeOf(h.client.listSessions(USER));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).code).toBe('TIMEOUT');
  });

  it('honours a custom timeout', async () => {
    vi.useFakeTimers();
    const h = harness(hang, undefined, { timeoutMs: 250 });
    const p = codeOf(h.client.endAllSessions(USER));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.apiCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(h.apiCalls()[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).code).toBe('TIMEOUT');
  });

  it('clears the timer after a successful call (no late abort of a finished request)', async () => {
    vi.useFakeTimers();
    const h = harness(() => json([]));
    await h.client.listSessions(USER);
    const signals = h.calls.map((c) => c.signal!);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a timed-out token request does not poison the next call', async () => {
    vi.useFakeTimers();
    let hangToken = true;
    const h = harness(
      () => json([]),
      (req) => (hangToken ? hang(req) : tokenResponse()),
    );
    const first = codeOf(h.client.listSessions(USER));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first).code).toBe('TIMEOUT');
    hangToken = false;
    await expect(h.client.listSessions(USER)).resolves.toEqual([]);
  });
});

describe('no retries', () => {
  it('sends a failed API request exactly once', async () => {
    const h = harness(() => new Response('', { status: 500 }));
    await codeOf(h.client.endAllSessions(USER));
    expect(h.apiCalls()).toHaveLength(1);
    expect(h.tokenCalls()).toHaveLength(1);
  });
  it('requests the token exactly once when it fails', async () => {
    const h = harness(
      () => json([]),
      () => new Response('', { status: 500 }),
    );
    await codeOf(h.client.listSessions(USER));
    expect(h.tokenCalls()).toHaveLength(1);
  });
});
