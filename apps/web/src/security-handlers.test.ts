// ID-004 web side, part 1: the BFF half of sessions, MFA and recovery. The device cookie, the login parameters of a step-up and of an application-initiated action,
// the callback (session registration, kc_action_status, the one-shot step-up check), the logout, the revoked-session handling, the POST handlers behind /security
// and the public password-reset request, plus the Next route modules in front of them. The API is a fake client factory with spies: what matters is WHICH calls are
// made, with WHAT, and that a secret, an address or a submitted value never leaves the request body (not into a redirect, a cookie, a log line or Valkey).
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { ACR_MFA, ACR_PASSWORD, DEVICE_SECRET_SHAPE, KEYCLOAK_ACTION_OF_METHOD, USER_AGENT_MAX_LENGTH } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { GET as passwordResetGet, POST as passwordResetPost } from './app/auth/password-reset/route';
import { GET as revokedGet } from './app/auth/revoked/route';
import { GET as securityGet, POST as securityPost } from './app/auth/security/[action]/route';
import { ApiError } from './lib/api-client';
import { DEVICE_COOKIE_MAX_AGE_SECONDS, ensureDeviceSecret, userAgentOf } from './lib/auth/device';
import { endRevokedSession, getSession, handleCallback, handleLogin, handleLogout, handleRevokedSession } from './lib/auth/handlers';
import { handlePasswordReset, handleSecurityAction, isSecurityAction, SECURITY_ACTIONS, type SecurityAction } from './lib/auth/security-handlers';
import { MemorySessionStore, ValkeySessionStore, type ValkeyLike } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';

// The route modules resolve the process-wide deps through this module: the tests decide what it returns and whether it is touched at all.
const routeState = vi.hoisted(() => ({ deps: undefined as unknown, calls: 0 }));
vi.mock('./lib/auth/runtime', () => ({
  authDeps: () => {
    routeState.calls++;
    return routeState.deps;
  },
}));

const PUBLIC = 'http://app.localhost:8080';
const cfgFor = (publicUrl = PUBLIC): AuthConfig => {
  const secure = publicUrl.startsWith('https://');
  return {
    clientId: 'bananagig-web',
    webOrigin: new URL(publicUrl).origin,
    webPublicUrl: publicUrl,
    redirectUri: `${publicUrl}/auth/callback`,
    postLogoutRedirectUri: `${publicUrl}/`,
    endpoints: {
      authorization: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/auth',
      endSession: 'http://auth.localhost:8080/realms/bananagig/protocol/openid-connect/logout',
      token: 'http://keycloak-auth:8080/realms/bananagig/protocol/openid-connect/token',
    },
    cookieSecure: secure,
    sessionCookie: secure ? '__Host-bg_session' : 'bg_session',
    txCookie: 'bg_auth_tx',
    deviceCookie: secure ? '__Host-bg_device' : 'bg_device',
    revokedRedirectUri: `${publicUrl}/session?error=session_revoked`,
  };
};

let keys: TestKeys;
beforeAll(async () => {
  keys = await createTestKeys('k-sec');
});
afterEach(() => {
  vi.useRealTimers();
});

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
const UUID_A = '5b0c9d3e-7a41-4f68-9c2d-1e8f0a6b4d21';
const UUID_B = '9a7e2c54-3b18-4d6f-8f90-2c5d7e1a0b36';
const EMAIL_MARKER = 'leak.marker+tag@example.test';
const apiError = (status: number, code: string, details?: Record<string, unknown>): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1', details);
const revoked = (): ApiError => apiError(401, 'SESSION_REVOKED');

interface Fns {
  setActiveRole: Mock<() => Promise<never>>;
  getAccount: Mock<(o?: unknown) => Promise<unknown>>;
  registerSession: Mock<(input: { device: string; userAgent?: string }, o?: unknown) => Promise<unknown>>;
  signOutCurrentSession: Mock<(o?: unknown) => Promise<unknown>>;
  revokeSecuritySession: Mock<(id: string, o?: unknown) => Promise<{ current: boolean }>>;
  revokeAllSecuritySessions: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  trustCurrentDevice: Mock<(o?: unknown) => Promise<unknown>>;
  untrustCurrentDevice: Mock<(o?: unknown) => Promise<unknown>>;
  removeSecurityDevice: Mock<(id: string, o?: unknown) => Promise<unknown>>;
  listSecurityDevices: Mock<(o?: unknown) => Promise<{ devices: Array<{ deviceId: string; current: boolean }> }>>;
  startMfaEnrollment: Mock<(method: string, o?: unknown) => Promise<{ method: string; keycloakAction: string }>>;
  requestPasswordReset: Mock<(email: string, o?: { clientIp?: string }) => Promise<unknown>>;
}
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
  tokenCalls: URLSearchParams[];
  clock: { now: number };
  setTokenResponse(fn: (body: URLSearchParams) => Promise<Response>): void;
}
function harness(publicUrl = PUBLIC, withApi = true): Harness {
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const tokenCalls: URLSearchParams[] = [];
  const clock = { now: Math.floor(Date.now() / 1000) };
  let responder: (body: URLSearchParams) => Promise<Response> = async () => new Response('{}', { status: 500 });
  const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    tokenCalls.push(body);
    return responder(body);
  }) as typeof fetch;
  const fns: Fns = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the security actions');
    }),
    getAccount: vi.fn(async () => ({})),
    registerSession: vi.fn(async () => ({ sessionId: UUID_A, deviceId: UUID_B, deviceTrusted: false, trustedUntil: null })),
    signOutCurrentSession: vi.fn(async () => ({ changed: true, keycloak: 'ENDED' })),
    revokeSecuritySession: vi.fn(async () => ({ current: false })),
    revokeAllSecuritySessions: vi.fn(async () => ({ revokedCount: 1, keycloak: 'ENDED' })),
    trustCurrentDevice: vi.fn(async () => ({ deviceId: UUID_B, trusted: true, trustedUntil: '2026-11-15T10:00:00.000Z' })),
    untrustCurrentDevice: vi.fn(async () => ({ deviceId: UUID_B, trusted: false, trustedUntil: null })),
    listSecurityDevices: vi.fn(async () => ({ devices: [{ deviceId: UUID_B, current: false }] })),
    removeSecurityDevice: vi.fn(async () => ({ deviceId: UUID_B, changed: true, sessionsRevoked: 1, keycloak: 'ENDED' })),
    startMfaEnrollment: vi.fn(async (method: string) => ({ method, keycloakAction: method === 'TOTP' ? 'CONFIGURE_TOTP' : 'CONFIGURE_RECOVERY_AUTHN_CODES' })),
    requestPasswordReset: vi.fn(async () => ({ accepted: true })),
  };
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const deps: AuthDeps = {
    cfg: cfgFor(publicUrl),
    store,
    verifier,
    fetch: fetchStub,
    now: () => clock.now,
    log: (level, message, attrs) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    ...(withApi
      ? {
          api: (accessToken: string) => {
            apiTokens.push(accessToken);
            return fns as unknown as ReturnType<NonNullable<AuthDeps['api']>>;
          },
          publicApi: () => fns as unknown as ReturnType<NonNullable<AuthDeps['publicApi']>>,
        }
      : {}),
  };
  return { deps, store, fns, apiTokens, logs, tokenCalls, clock, setTokenResponse: (fn) => (responder = fn) };
}
const tokenJson = (o: Record<string, unknown>) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
async function issue(nonce: string, claims: Record<string, unknown> = {}, expiresInSec = 300) {
  return {
    access_token: await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims }, expiresInSec }),
    refresh_token: TOKENS.refresh,
    id_token: await signToken(keys, { claims: { typ: 'ID', aud: 'bananagig-web', azp: 'bananagig-web', nonce } }),
    expires_in: expiresInSec,
    refresh_expires_in: 1800,
  };
}
const cookieOf = (res: Response, name: string): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (setCookie: string): string => setCookie.split(';')[0]!.split('=').slice(1).join('=');

/** Starts a login and returns what the browser would hold and what Keycloak would be told. */
async function startLogin(h: Harness, query = 'returnTo=/security', cookie?: string) {
  const res = await handleLogin(new Request(`http://web-app:3000/auth/login?${query}`, { headers: cookie ? { cookie } : {} }), h.deps);
  const authorize = new URL(res.headers.get('location')!);
  const txCookie = `bg_auth_tx=${valueOf(cookieOf(res, 'bg_auth_tx')!)}`;
  return { res, authorize, txCookie };
}
/** Runs the callback for a started login with the token claims Keycloak would have issued. */
async function finishLogin(
  h: Harness,
  login: Awaited<ReturnType<typeof startLogin>>,
  o: { claims?: Record<string, unknown>; extraQuery?: string; headers?: Record<string, string>; cookie?: string } = {},
) {
  const { state, nonce } = Object.fromEntries(login.authorize.searchParams);
  h.setTokenResponse(async () => tokenJson(await issue(nonce!, o.claims)));
  return handleCallback(
    new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}${o.extraQuery ?? ''}`, {
      headers: { cookie: [login.txCookie, o.cookie].filter(Boolean).join('; '), ...o.headers },
    }),
    h.deps,
  );
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
const SESSION_COOKIE = 'bg_session=sid-1';
const post = (
  path: string,
  fields: Record<string, string> | undefined,
  o: { method?: string; origin?: string | null; cookie?: string | null; body?: BodyInit | null; headers?: Record<string, string> } = {},
) => {
  const method = o.method ?? 'POST';
  return new Request(`http://web-app:3000${path}`, {
    method,
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? PUBLIC }),
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? SESSION_COOKIE }),
      ...o.headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: o.body !== undefined ? o.body : new URLSearchParams(fields ?? {}) }),
  });
};
const action = (h: Harness, name: SecurityAction, fields: Record<string, string> = {}, o: Parameters<typeof post>[2] = {}) =>
  handleSecurityAction(post(`/auth/security/${name}`, fields, o), h.deps, name);
const noSecurityCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectBack = (res: Response, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}/security${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};

// ---------------------------------------------------------------- the device cookie
describe('the device cookie', () => {
  const cfg = cfgFor();
  const reqWith = (cookie?: string) => new Request('http://web-app:3000/auth/callback', { headers: cookie ? { cookie } : {} });

  it('mints a 43-character base64url secret for a browser that has none, and every call mints a different one', () => {
    const a = ensureDeviceSecret(reqWith(), cfg);
    const b = ensureDeviceSecret(reqWith(), cfg);
    expect(a.minted).toBe(true);
    expect(a.secret).toMatch(DEVICE_SECRET_SHAPE);
    expect(a.secret).not.toBe(b.secret);
  });
  it('keeps the secret the browser already holds and renews the cookie lifetime', () => {
    const first = ensureDeviceSecret(reqWith(), cfg);
    const again = ensureDeviceSecret(reqWith(`other=1; bg_device=${first.secret}`), cfg);
    expect(again).toMatchObject({ secret: first.secret, minted: false });
    expect(again.setCookie).toContain(`bg_device=${first.secret}`);
    expect(again.setCookie).toContain(`Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`);
  });
  it('replaces a malformed or tampered value instead of trusting it', () => {
    for (const bad of ['', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'a'.repeat(42)}!`, `${'a'.repeat(42)}=`, '../../etc/passwd', 'a b'.padEnd(43, 'c')]) {
      const out = ensureDeviceSecret(reqWith(`bg_device=${bad}`), cfg);
      expect(out.minted, JSON.stringify(bad)).toBe(true);
      expect(out.secret).toMatch(DEVICE_SECRET_SHAPE);
      expect(out.secret).not.toBe(bad);
    }
  });
  it('is HttpOnly, SameSite=Lax, Path=/ and lives 400 days; not Secure over http, no Domain', () => {
    const { setCookie } = ensureDeviceSecret(reqWith(), cfg);
    expect(setCookie).toMatch(/^bg_device=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${34_560_000}`);
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('Domain');
  });
  it('uses the __Host- prefix and Secure over https, still without a Domain', () => {
    const { setCookie } = ensureDeviceSecret(reqWith(), cfgFor('https://app.example.com'));
    expect(setCookie).toMatch(/^__Host-bg_device=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('; Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain');
  });
  it('a bare bg_device cookie is ignored over https (only the __Host- name counts there)', () => {
    const secret = 'a'.repeat(43);
    expect(ensureDeviceSecret(reqWith(`bg_device=${secret}`), cfgFor('https://app.example.com')).minted).toBe(true);
  });
  it('reduces the user agent to a bounded string and says nothing when the browser sent none', () => {
    expect(userAgentOf(reqWith())).toBeUndefined();
    expect(userAgentOf(new Request('http://x/', { headers: { 'user-agent': '   ' } }))).toBeUndefined();
    expect(userAgentOf(new Request('http://x/', { headers: { 'user-agent': 'Mozilla/5.0 Firefox/130' } }))).toBe('Mozilla/5.0 Firefox/130');
    expect(userAgentOf(new Request('http://x/', { headers: { 'user-agent': 'u'.repeat(5000) } }))).toHaveLength(USER_AGENT_MAX_LENGTH);
  });
});

// ---------------------------------------------------------------- login parameters
describe('login: step-up and application-initiated action parameters', () => {
  const q = (u: URL) => Object.fromEntries(u.searchParams);

  it('adds nothing by default', async () => {
    const h = harness();
    const { authorize } = await startLogin(h, 'returnTo=/security');
    for (const p of ['prompt', 'max_age', 'acr_values', 'kc_action']) expect(authorize.searchParams.has(p), p).toBe(false);
    expect([...h.store.transactions.values()][0]!.stepUp).toBeUndefined();
  });
  it('stepUp=recent asks for a fresh authentication (prompt=login) and remembers the attempt in the login transaction only', async () => {
    const h = harness();
    const { authorize } = await startLogin(h, 'returnTo=/security&stepUp=recent');
    expect(q(authorize)).toMatchObject({ prompt: 'login' });
    expect(authorize.searchParams.has('acr_values')).toBe(false);
    expect(authorize.searchParams.has('kc_action')).toBe(false);
    expect([...h.store.transactions.values()][0]).toMatchObject({ returnTo: '/security', stepUp: { level: 'recent', startedAt: h.clock.now } });
  });
  it('stepUp=mfa also asks for the second-factor level', async () => {
    const h = harness();
    const { authorize } = await startLogin(h, 'returnTo=/security&stepUp=mfa');
    expect(q(authorize)).toMatchObject({ prompt: 'login', acr_values: ACR_MFA });
    expect([...h.store.transactions.values()][0]!.stepUp).toMatchObject({ level: 'mfa' });
  });
  it('kcAction=totp / recovery map to the Keycloak actions when this browser session holds the matching one-shot marker; prompt=login is always added', async () => {
    for (const [name, method, kc] of [
      ['totp', 'TOTP', KEYCLOAK_ACTION_OF_METHOD.TOTP],
      ['recovery', 'RECOVERY_CODES', KEYCLOAK_ACTION_OF_METHOD.RECOVERY_CODES],
    ] as const) {
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method }, 300);
      const { authorize } = await startLogin(h, `returnTo=/security&kcAction=${name}`, SESSION_COOKIE);
      expect(authorize.searchParams.get('kc_action')).toBe(kc);
      expect(authorize.searchParams.get('prompt')).toBe('login');
      expect(authorize.searchParams.has('acr_values')).toBe(false);
      // treated like a step-up for the callback's freshness check
      expect([...h.store.transactions.values()][0]!.stepUp).toMatchObject({ level: 'recent', startedAt: h.clock.now });
    }
  });
  it('can combine both: the stronger step-up level is kept', async () => {
    const h = harness();
    seed(h);
    await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
    const { authorize } = await startLogin(h, 'returnTo=/security&stepUp=mfa&kcAction=totp', SESSION_COOKIE);
    expect(q(authorize)).toMatchObject({ prompt: 'login', acr_values: ACR_MFA, kc_action: 'CONFIGURE_TOTP' });
    expect([...h.store.transactions.values()][0]!.stepUp).toMatchObject({ level: 'mfa' });
  });
  describe('kcAction without the one-shot marker is ignored (plain login, no credential setup)', () => {
    const plain = (authorize: URL, h: Harness): void => {
      for (const p of ['kc_action', 'prompt', 'max_age', 'acr_values']) expect(authorize.searchParams.has(p), p).toBe(false);
      expect([...h.store.transactions.values()][0]!.stepUp).toBeUndefined();
    };
    it('no marker at all', async () => {
      const h = harness();
      seed(h);
      const { authorize, res } = await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE);
      expect(res.status).toBe(302);
      plain(authorize, h);
    });
    it('no session cookie, an unknown session cookie, or a signed-out browser', async () => {
      for (const cookie of [undefined, 'bg_session=unknown', 'other=1']) {
        const h = harness();
        seed(h);
        await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
        const { authorize } = await startLogin(h, 'returnTo=/security&kcAction=totp', cookie);
        plain(authorize, h);
        expect(h.store.enrollments.has('sid-1')).toBe(true); // somebody else's marker is not touched
      }
    });
    it('an expired marker', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
      vi.setSystemTime(Date.now() + 301_000);
      plain((await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE)).authorize, h);
    });
    it('a marker of ANOTHER browser session', async () => {
      const h = harness();
      seed(h);
      seed(h, {}, 'sid-2');
      await h.store.putEnrollment('sid-2', { method: 'TOTP' }, 300);
      plain((await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE)).authorize, h);
      expect(h.store.enrollments.has('sid-2')).toBe(true);
    });
    it('a replay: the marker works once', async () => {
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
      expect((await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE)).authorize.searchParams.get('kc_action')).toBe('CONFIGURE_TOTP');
      h.store.transactions.clear();
      plain((await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE)).authorize, h);
    });
    it('the wrong method (and the marker is spent)', async () => {
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
      plain((await startLogin(h, 'returnTo=/security&kcAction=recovery', SESSION_COOKIE)).authorize, h);
      expect(h.store.enrollments.has('sid-1')).toBe(false);
      h.store.transactions.clear();
      plain((await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE)).authorize, h);
    });
    it('a marker alone (no kcAction parameter) starts nothing and is not consumed', async () => {
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
      plain((await startLogin(h, 'returnTo=/security', SESSION_COOKIE)).authorize, h);
      expect(h.store.enrollments.has('sid-1')).toBe(true);
    });
  });
  it('the credential setup is judged like a step-up at the callback: a stale authentication returns with error=step_up_required, a fresh one does not', async () => {
    for (const [authAgo, expected] of [
      [3600, `${PUBLIC}/security?error=step_up_required`],
      [-5, `${PUBLIC}/security`],
    ] as const) {
      const h = harness();
      seed(h);
      await h.store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
      const login = await startLogin(h, 'returnTo=/security&kcAction=totp', SESSION_COOKIE);
      const res = await finishLogin(h, login, { claims: { auth_time: h.clock.now - authAgo, acr: ACR_PASSWORD }, extraQuery: '&kc_action_status=success' });
      expect(res.headers.get('location')).toContain(expected.split('?')[0]!);
      if (authAgo > 0) expect(res.headers.get('location')).toBe(`${PUBLIC}/security?kc_action_status=success&error=step_up_required`);
      else expect(res.headers.get('location')).toBe(`${PUBLIC}/security?kc_action_status=success`);
      expect(res.headers.get('location')).not.toContain('/auth/login');
    }
  });
  it('ignores every value outside the lists (case, padding, repeats, look-alikes, injection) and still logs in', async () => {
    const bad = [
      '',
      'RECENT',
      'Mfa',
      'recent ',
      ' mfa',
      'login',
      'none',
      'recent,mfa',
      'recent&prompt=none',
      'CONFIGURE_TOTP',
      'delete_account',
      'totp%00',
      '../x',
      'constructor',
      '__proto__',
    ];
    for (const v of bad) {
      const h = harness();
      const { authorize, res } = await startLogin(h, `returnTo=/security&stepUp=${encodeURIComponent(v)}&kcAction=${encodeURIComponent(v)}`);
      expect(res.status, v).toBe(302);
      for (const p of ['prompt', 'max_age', 'acr_values', 'kc_action']) expect(authorize.searchParams.has(p), `${v} ${p}`).toBe(false);
      expect([...h.store.transactions.values()][0]!.stepUp, v).toBeUndefined();
    }
  });
  it('ignores a repeated parameter (a client cannot smuggle a second value)', async () => {
    const h = harness();
    const { authorize } = await startLogin(h, 'returnTo=/security&stepUp=recent&stepUp=mfa&kcAction=totp&kcAction=recovery');
    for (const p of ['prompt', 'acr_values', 'kc_action']) expect(authorize.searchParams.has(p), p).toBe(false);
  });
  it('cannot be used to pass arbitrary parameters to Keycloak (prompt=none, max_age, acr_values, kc_action are never taken from the query)', async () => {
    const h = harness();
    const { authorize } = await startLogin(h, 'returnTo=/security&prompt=none&max_age=1&acr_values=evil&kc_action=evil&login_hint=a@b.c');
    for (const p of ['prompt', 'max_age', 'acr_values', 'kc_action', 'login_hint']) expect(authorize.searchParams.has(p), p).toBe(false);
  });
  it('returnTo stays validated: an absolute, protocol-relative or backslash path becomes /', async () => {
    for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/ok\\..\\x', `/${'a'.repeat(600)}`]) {
      const h = harness();
      await startLogin(h, `returnTo=${encodeURIComponent(evil)}&stepUp=recent&kcAction=totp`);
      expect([...h.store.transactions.values()][0]!.returnTo, evil).toBe('/');
    }
  });
});

// ---------------------------------------------------------------- callback
describe('callback: device cookie, session registration, kc_action_status, one-shot step-up', () => {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';

  it('issues the device cookie, registers the session with the NEW access token and sends the secret in the request body only', async () => {
    const h = harness();
    const login = await startLogin(h, 'returnTo=/security');
    const res = await finishLogin(h, login, { headers: { 'user-agent': UA } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/security`);
    const device = cookieOf(res, 'bg_device')!;
    expect(device).toMatch(/HttpOnly/);
    expect(device).toMatch(/SameSite=Lax/);
    expect(device).toMatch(/Path=\//);
    const secret = valueOf(device);
    expect(secret).toMatch(DEVICE_SECRET_SHAPE);
    expect(h.fns.registerSession).toHaveBeenCalledTimes(1);
    expect(h.fns.registerSession).toHaveBeenCalledWith({ device: secret, userAgent: UA });
    const [record] = [...h.store.sessions.values()];
    expect(h.apiTokens).toEqual([record!.accessToken]);
    // the secret is nowhere but the cookie and the API body: not in Valkey (sessions, transactions), the redirect, the other cookies or a log line
    expect(JSON.stringify([...h.store.sessions.values()])).not.toContain(secret);
    expect(JSON.stringify([...h.store.transactions.values()])).not.toContain(secret);
    expect(res.headers.get('location')).not.toContain(secret);
    expect(res.headers.getSetCookie().filter((c) => !c.startsWith('bg_device='))).not.toContain(secret);
    expect(
      res.headers
        .getSetCookie()
        .filter((c) => !c.startsWith('bg_device='))
        .join('\n'),
    ).not.toContain(secret);
    expect(h.logs.join('\n')).not.toContain(secret);
    expect(h.logs.join('\n')).not.toContain(UA);
  });
  it('re-registers the device the browser already holds (same secret), renewing the cookie', async () => {
    const h = harness();
    const secret = 'Z'.repeat(43);
    const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${secret}` });
    expect(h.fns.registerSession).toHaveBeenCalledWith({ device: secret });
    expect(valueOf(cookieOf(res, 'bg_device')!)).toBe(secret);
  });
  it('uses __Host-bg_device with Secure over https', async () => {
    const h = harness('https://app.example.com');
    const res = await finishLogin(h, await startLogin(h));
    expect(cookieOf(res, '__Host-bg_device')).toMatch(/; Secure/);
    expect(cookieOf(res, 'bg_device')).toBeUndefined();
  });
  it('sends no userAgent when the browser sent none, and caps a huge one', async () => {
    const h = harness();
    await finishLogin(h, await startLogin(h));
    expect(h.fns.registerSession.mock.calls[0]![0]).not.toHaveProperty('userAgent');
    const h2 = harness();
    await finishLogin(h2, await startLogin(h2), { headers: { 'user-agent': 'u'.repeat(4000) } });
    expect(h2.fns.registerSession.mock.calls[0]![0].userAgent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });
  it('login still succeeds when the registration fails, and the failure is logged as a code only', async () => {
    for (const failure of [apiError(503, 'ACCOUNT_SECURITY_UNAVAILABLE'), apiError(0, 'API_UNREACHABLE'), new Error('boom with secret-detail')]) {
      const h = harness();
      h.fns.registerSession.mockRejectedValueOnce(failure);
      const res = await finishLogin(h, await startLogin(h));
      expect(res.status).toBe(302);
      expect(cookieOf(res, 'bg_session')).toBeDefined();
      expect(cookieOf(res, 'bg_device')).toBeDefined(); // the cookie is set anyway: the next login registers it
      expect(h.store.sessions.size).toBe(1);
      expect(h.logs.some((l) => l.includes('session registration failed'))).toBe(true);
      expect(h.logs.join('\n')).not.toContain('secret-detail');
    }
  });
  it('login still succeeds when the registration hangs: it is abandoned after 2 s', async () => {
    const h = harness();
    let reached!: () => void;
    const called = new Promise<void>((resolve) => (reached = resolve));
    h.fns.registerSession.mockImplementationOnce(() => {
      reached();
      return new Promise(() => undefined);
    });
    const login = await startLogin(h);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = finishLogin(h, login);
    await called;
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(302);
    expect(h.logs.some((l) => l.includes('"reason":"timeout"'))).toBe(true);
  });
  it('works without an API client in the deps (nothing registered, cookie still issued)', async () => {
    const h = harness(PUBLIC, false);
    const res = await finishLogin(h, await startLogin(h));
    expect(res.status).toBe(302);
    expect(cookieOf(res, 'bg_device')).toBeDefined();
  });
  it('does not register anything when the login fails', async () => {
    const h = harness();
    const login = await startLogin(h);
    const res = await handleCallback(new Request('http://web-app:3000/auth/callback?code=abc&state=forged', { headers: { cookie: login.txCookie } }), h.deps);
    expect(res.headers.get('location')).toContain('login_failed');
    expect(cookieOf(res, 'bg_device')).toBeUndefined();
    noSecurityCalls(h);
  });
  it('deletes the session record this browser held before (a step-up login replaces it)', async () => {
    const h = harness();
    seed(h, {}, 'old-sid');
    await finishLogin(h, await startLogin(h), { cookie: 'bg_session=old-sid' });
    expect(h.store.sessions.has('old-sid')).toBe(false);
    expect(h.store.sessions.size).toBe(1);
  });

  describe('device cookie rotation (the secret of a removed device)', () => {
    const OLD = 'R'.repeat(43);
    const noDevice = { sessionId: UUID_A, deviceId: null, deviceTrusted: false, trustedUntil: null };

    it('a held secret that the API answers with deviceId null is replaced: registered once more with a NEW secret, and the new cookie is set', async () => {
      const h = harness();
      h.fns.registerSession.mockResolvedValueOnce(noDevice);
      const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${OLD}` });
      expect(res.status).toBe(302);
      expect(h.fns.registerSession).toHaveBeenCalledTimes(2);
      const [first, second] = h.fns.registerSession.mock.calls.map((c) => c[0].device);
      expect(first).toBe(OLD);
      expect(second).toMatch(DEVICE_SECRET_SHAPE);
      expect(second).not.toBe(OLD);
      const cookies = res.headers.getSetCookie().filter((c) => c.startsWith('bg_device='));
      expect(cookies).toHaveLength(1);
      expect(valueOf(cookies[0]!)).toBe(second);
      expect(cookies[0]).toMatch(/HttpOnly/);
      expect(cookies[0]).toMatch(/SameSite=Lax/);
      // neither secret leaks anywhere else
      const everything = `${res.headers.get('location')}\n${JSON.stringify([...h.store.sessions.values()])}\n${h.logs.join('\n')}`;
      expect(everything).not.toContain(OLD);
      expect(everything).not.toContain(second!);
    });
    it('retries at most once: a second deviceId null keeps the new cookie and does not loop', async () => {
      const h = harness();
      h.fns.registerSession.mockResolvedValue(noDevice);
      const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${OLD}` });
      expect(res.status).toBe(302);
      expect(h.fns.registerSession).toHaveBeenCalledTimes(2);
      expect(valueOf(cookieOf(res, 'bg_device')!)).toBe(h.fns.registerSession.mock.calls[1]![0].device);
    });
    it('a secret minted in this very request is not retried (it cannot belong to a removed device)', async () => {
      const h = harness();
      h.fns.registerSession.mockResolvedValue(noDevice);
      await finishLogin(h, await startLogin(h));
      expect(h.fns.registerSession).toHaveBeenCalledTimes(1);
    });
    it('a malformed cookie is minted, so a null device is not retried either', async () => {
      const h = harness();
      h.fns.registerSession.mockResolvedValue(noDevice);
      await finishLogin(h, await startLogin(h), { cookie: 'bg_device=garbage' });
      expect(h.fns.registerSession).toHaveBeenCalledTimes(1);
    });
    it('a device that was assigned keeps its secret and registers once', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${OLD}` });
      expect(h.fns.registerSession).toHaveBeenCalledTimes(1);
      expect(valueOf(cookieOf(res, 'bg_device')!)).toBe(OLD);
    });
    it('a failed first registration is not retried and keeps the held secret', async () => {
      const h = harness();
      h.fns.registerSession.mockRejectedValueOnce(apiError(503, 'ACCOUNT_SECURITY_UNAVAILABLE'));
      const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${OLD}` });
      expect(h.fns.registerSession).toHaveBeenCalledTimes(1);
      expect(valueOf(cookieOf(res, 'bg_device')!)).toBe(OLD);
    });
    it('a failing second registration still logs in and sets the new cookie', async () => {
      const h = harness();
      h.fns.registerSession.mockResolvedValueOnce(noDevice).mockRejectedValueOnce(new Error('boom'));
      const res = await finishLogin(h, await startLogin(h), { cookie: `bg_device=${OLD}` });
      expect(res.status).toBe(302);
      expect(cookieOf(res, 'bg_session')).toBeDefined();
      expect(valueOf(cookieOf(res, 'bg_device')!)).not.toBe(OLD);
    });
    it('uses __Host-bg_device with Secure on https', async () => {
      const h = harness('https://app.example.com');
      h.fns.registerSession.mockResolvedValueOnce(noDevice);
      const res = await finishLogin(h, await startLogin(h), { cookie: `__Host-bg_device=${OLD}` });
      expect(cookieOf(res, '__Host-bg_device')).toMatch(/; Secure/);
      expect(valueOf(cookieOf(res, '__Host-bg_device')!)).not.toBe(OLD);
    });
  });

  describe('kc_action_status', () => {
    it.each(['success', 'cancelled', 'error'])('passes %s on to the return path as a query parameter', async (status) => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/security&kcAction=totp'), { extraQuery: `&kc_action_status=${status}` });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security?kc_action_status=${status}`);
    });
    it('keeps the query and fragment the return path already has and replaces a same-named parameter', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, `returnTo=${encodeURIComponent('/security?x=1&kc_action_status=forged#top')}`), {
        extraQuery: '&kc_action_status=success',
      });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security?x=1&kc_action_status=success#top`);
    });
    it('drops anything but the three words (case, padding, repeats, injection, long values)', async () => {
      for (const v of ['SUCCESS', 'ok', 'success ', 'success,error', '', '"><script>', '../x', 'a'.repeat(500), 'constructor']) {
        const h = harness();
        const res = await finishLogin(h, await startLogin(h, 'returnTo=/security'), { extraQuery: `&kc_action_status=${encodeURIComponent(v)}` });
        expect(res.headers.get('location'), v).toBe(`${PUBLIC}/security`);
      }
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/security'), { extraQuery: '&kc_action_status=success&kc_action_status=error' });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security`);
    });
    it('is not added to an ordinary login', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/session'));
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    });
  });

  describe('a step-up is one round trip and is judged on the verified token', () => {
    const fresh = (h: Harness, more: Record<string, unknown> = {}) => ({ auth_time: h.clock.now + 5, acr: ACR_PASSWORD, sid: 'kc-sid-1', ...more });

    it('recent: a fresh authentication returns to the return path', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/security&stepUp=recent'), { claims: fresh(h) });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security`);
    });
    it('recent: Keycloak ignored prompt=login (an old auth_time) -> back to the return path with the error, NOT to Keycloak again', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/security&stepUp=recent'), { claims: fresh(h, { auth_time: h.clock.now - 3600 }) });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security?error=step_up_required`);
      expect(res.headers.get('location')).not.toContain('/auth/login');
      expect(res.headers.get('location')).not.toContain('openid-connect');
      expect(h.store.transactions.size).toBe(0); // consumed: a replay cannot start another attempt
      expect(h.store.sessions.size).toBe(1); // the person IS signed in (the login itself was valid)
      expect(cookieOf(res, 'bg_session')).toBeDefined();
    });
    it('recent: a token without auth_time cannot prove freshness', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, 'returnTo=/security&stepUp=recent'), { claims: { acr: ACR_PASSWORD } });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security?error=step_up_required`);
    });
    it('recent: accepts an authentication a few seconds before the attempt began (clock difference), not a minute', async () => {
      const h = harness();
      expect(
        (await finishLogin(h, await startLogin(h, 'returnTo=/security&stepUp=recent'), { claims: fresh(h, { auth_time: h.clock.now - 5 }) })).headers.get(
          'location',
        ),
      ).toBe(`${PUBLIC}/security`);
      const h2 = harness();
      expect(
        (await finishLogin(h2, await startLogin(h2, 'returnTo=/security&stepUp=recent'), { claims: fresh(h2, { auth_time: h2.clock.now - 60 }) })).headers.get(
          'location',
        ),
      ).toContain('error=step_up_required');
    });
    it('mfa: needs the second-factor acr as well as a fresh authentication', async () => {
      const ok = harness();
      expect(
        (await finishLogin(ok, await startLogin(ok, 'returnTo=/security&stepUp=mfa'), { claims: fresh(ok, { acr: ACR_MFA }) })).headers.get('location'),
      ).toBe(`${PUBLIC}/security`);
      for (const claims of [{ acr: ACR_PASSWORD }, { acr: 'bananagig:mfa ' }, { acr: 'mfa' }, { acr: undefined }]) {
        const h = harness();
        const res = await finishLogin(h, await startLogin(h, 'returnTo=/security&stepUp=mfa'), { claims: fresh(h, claims as Record<string, unknown>) });
        expect(res.headers.get('location'), JSON.stringify(claims)).toBe(`${PUBLIC}/security?error=step_up_required`);
      }
      const stale = harness();
      expect(
        (
          await finishLogin(stale, await startLogin(stale, 'returnTo=/security&stepUp=mfa'), {
            claims: fresh(stale, { acr: ACR_MFA, auth_time: stale.clock.now - 3600 }),
          })
        ).headers.get('location'),
      ).toContain('error=step_up_required');
    });
    it('the error is added to the query the return path already has; an ordinary login never gets it', async () => {
      const h = harness();
      const res = await finishLogin(h, await startLogin(h, `returnTo=${encodeURIComponent('/security?x=1')}&stepUp=mfa`), { claims: fresh(h) });
      expect(res.headers.get('location')).toBe(`${PUBLIC}/security?x=1&error=step_up_required`);
      const plain = harness();
      expect((await finishLogin(plain, await startLogin(plain, 'returnTo=/security'), { claims: { auth_time: 1 } })).headers.get('location')).toBe(
        `${PUBLIC}/security`,
      );
    });
    it('the step-up marker is consumed with the transaction: a replayed callback fails', async () => {
      const h = harness();
      const login = await startLogin(h, 'returnTo=/security&stepUp=recent');
      await finishLogin(h, login, { claims: fresh(h) });
      const again = await finishLogin(h, login, { claims: fresh(h) });
      expect(again.headers.get('location')).toContain('login_failed');
    });
  });
});

// ---------------------------------------------------------------- logout
describe('logout: the application session is ended at the API first, best effort', () => {
  const logout = (h: Harness, o: { origin?: string | null; method?: string; cookie?: string | null } = {}) => handleLogout(post('/auth/logout', {}, o), h.deps);

  it('tells the API with the session token and role, then deletes the local session and ends the Keycloak session', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const order: string[] = [];
    h.fns.signOutCurrentSession.mockImplementation(async () => {
      order.push(`api (session present: ${h.store.sessions.has('sid-1')})`);
      return { changed: true, keycloak: 'ENDED' };
    });
    const res = await logout(h);
    expect(order).toEqual(['api (session present: true)']);
    expect(h.apiTokens).toEqual([TOKENS.access]);
    expect(h.fns.signOutCurrentSession).toHaveBeenCalledWith({ activeRole: 'PROVIDER' });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(h.deps.cfg.endpoints.endSession);
    expect(loc.searchParams.get('id_token_hint')).toBe(TOKENS.id);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/`);
    expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it('signs out even when the API refuses, fails, is unreachable or says the session was already revoked', async () => {
    for (const failure of [
      apiError(401, 'SESSION_REVOKED'),
      apiError(503, 'ACCOUNT_SECURITY_UNAVAILABLE'),
      apiError(0, 'API_UNREACHABLE'),
      new Error('boom'),
    ]) {
      const h = harness();
      seed(h);
      h.fns.signOutCurrentSession.mockRejectedValueOnce(failure);
      const res = await logout(h);
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('location')!).pathname).toContain('/logout');
      expect(h.store.sessions.size).toBe(0);
      expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    }
  });
  it('does not wait longer than 2 s for a hanging API', async () => {
    const h = harness();
    seed(h);
    let reached!: () => void;
    const called = new Promise<void>((resolve) => (reached = resolve));
    h.fns.signOutCurrentSession.mockImplementation(() => {
      reached();
      return new Promise(() => undefined);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = logout(h);
    await called;
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(303);
    expect(h.store.sessions.size).toBe(0);
  });
  it('uses a refreshed token when the access token is about to expire', async () => {
    const h = harness();
    seed(h, { accessExpiresAt: h.clock.now + 5 });
    h.setTokenResponse(async () =>
      tokenJson({
        ...(await issue('unused')),
        access_token: await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] } } }),
      }),
    );
    const res = await logout(h);
    expect(res.status).toBe(303);
    expect(h.tokenCalls.at(-1)!.get('grant_type')).toBe('refresh_token');
    expect(h.apiTokens).toHaveLength(1);
    expect(h.apiTokens[0]).not.toBe(TOKENS.access);
    expect(h.store.sessions.size).toBe(0);
  });
  it('a session whose refresh fails is already gone: no API call, still a clean logout', async () => {
    const h = harness();
    seed(h, { accessExpiresAt: h.clock.now + 5 });
    h.setTokenResponse(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const res = await logout(h);
    expect(res.status).toBe(303);
    expect(h.fns.signOutCurrentSession).not.toHaveBeenCalled();
    expect(h.store.sessions.size).toBe(0);
    expect(new URL(res.headers.get('location')!).searchParams.get('id_token_hint')).toBe(TOKENS.id);
  });
  it('stays POST-only and Origin-checked, and the API is not called for a refused request', async () => {
    const h = harness();
    seed(h);
    expect((await logout(h, { method: 'GET' })).status).toBe(405);
    for (const origin of [null, 'http://evil.example', 'http://app.localhost:9999']) expect((await logout(h, { origin })).status).toBe(403);
    noSecurityCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it('without a session there is nothing to tell the API', async () => {
    const h = harness();
    const res = await logout(h, { cookie: null });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/`);
    noSecurityCalls(h);
  });
  it('works without an API client in the deps', async () => {
    const h = harness(PUBLIC, false);
    seed(h);
    const res = await logout(h);
    expect(res.status).toBe(303);
    expect(h.store.sessions.size).toBe(0);
  });
});

// ---------------------------------------------------------------- revoked sessions
describe('a session the API revoked', () => {
  it('endRevokedSession deletes the session, clears the cookie and goes through Keycloak back to /session?error=session_revoked', async () => {
    const h = harness();
    const record = seed(h);
    const res = await endRevokedSession('sid-1', record, h.deps);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(h.deps.cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(loc.searchParams.get('id_token_hint')).toBe(TOKENS.id);
    expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  describe('GET /auth/revoked (where a page sends the browser)', () => {
    const get = (h: Harness, cookie: string | null = SESSION_COOKIE) =>
      handleRevokedSession(new Request('http://web-app:3000/auth/revoked', { headers: cookie ? { cookie } : {} }), h.deps);

    it('re-checks with the API and ends the session only when it confirms SESSION_REVOKED', async () => {
      const h = harness();
      seed(h, { activeRole: 'CUSTOMER' });
      h.fns.getAccount.mockRejectedValueOnce(revoked());
      const res = await get(h);
      expect(h.fns.getAccount).toHaveBeenCalledWith({ activeRole: 'CUSTOMER' });
      expect(new URL(res.headers.get('location')!).searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
      expect(h.store.sessions.size).toBe(0);
    });
    it('does NOT sign anyone out on its own word: a valid session, an API failure or another error keeps the session', async () => {
      for (const outcome of [
        'ok',
        apiError(503, 'ACCOUNT_UNAVAILABLE'),
        apiError(401, 'INVALID_TOKEN'),
        apiError(401, 'STEP_UP_REQUIRED'),
        apiError(403, 'ACCOUNT_SUSPENDED'),
        new Error('boom'),
      ] as const) {
        const h = harness();
        seed(h);
        if (outcome !== 'ok') h.fns.getAccount.mockRejectedValueOnce(outcome);
        const res = await get(h);
        expect(res.headers.get('location'), String(outcome)).toBe(`${PUBLIC}/session`);
        expect(h.store.sessions.size, String(outcome)).toBe(1);
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    });
    it('without a session cookie, or with an unknown one, just goes to /session and calls nothing', async () => {
      const h = harness();
      for (const cookie of [null, 'bg_session=nope']) expect((await get(h, cookie)).headers.get('location')).toBe(`${PUBLIC}/session`);
      noSecurityCalls(h);
    });
    it('the route module answers GET only through the handler and is no-store', async () => {
      const h = harness();
      seed(h);
      h.fns.getAccount.mockRejectedValueOnce(revoked());
      routeState.deps = h.deps;
      const res = await revokedGet(new Request('http://web-app:3000/auth/revoked', { headers: { cookie: SESSION_COOKIE } }));
      expect(res.status).toBe(303);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(h.store.sessions.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- the POST handlers behind /security
describe('SECURITY_ACTIONS and isSecurityAction', () => {
  it('names exactly the six actions', () => {
    expect([...SECURITY_ACTIONS]).toEqual(['revoke-session', 'revoke-all', 'trust-device', 'untrust-device', 'remove-device', 'mfa-enroll']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of SECURITY_ACTIONS) expect(isSecurityAction(a)).toBe(true);
    for (const other of [
      '',
      'REVOKE-ALL',
      'revoke_all',
      'revoke-all ',
      '/revoke-all',
      'constructor',
      '__proto__',
      'toString',
      'mfa-enroll/x',
      'trust',
      'logout',
    ])
      expect(isSecurityAction(other), other).toBe(false);
  });
});

describe('security actions: transport and authentication', () => {
  it.each(SECURITY_ACTIONS)('%s: refuses every method but POST (405) and calls nothing', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleSecurityAction(post(`/auth/security/${name}`, {}, { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    noSecurityCalls(h);
  });
  it.each(SECURITY_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF) before it reads anything', async (name) => {
    const h = harness();
    seed(h);
    for (const origin of [
      null,
      'null',
      'http://evil.example',
      'http://app.localhost:9999',
      'https://app.localhost:8080',
      'http://app.localhost:8080.evil.example',
      `${PUBLIC}/`,
      PUBLIC.toUpperCase(),
    ]) {
      const res = await action(h, name, { sessionId: UUID_A, deviceId: UUID_A, method: 'TOTP' }, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    noSecurityCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(SECURITY_ACTIONS)('%s: a signed-out browser is sent to /session and the API is not called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await action(h, name, { sessionId: UUID_A, deviceId: UUID_A, method: 'TOTP' }, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    }
    noSecurityCalls(h);
  });
  it('refuses to run without an API client (a wiring error, not a request error)', async () => {
    const h = harness(PUBLIC, false);
    seed(h);
    await expect(action(h, 'revoke-all')).rejects.toThrow('AuthDeps.api');
  });
});

describe('security actions: what each one asks of the API', () => {
  it('revoke-session forwards the uuid with the session token and role and comes back with a notice', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'revoke-session', { sessionId: UUID_A }), '?notice=session_revoked');
    expect(h.apiTokens).toEqual([TOKENS.access]);
    expect(h.fns.revokeSecuritySession).toHaveBeenCalledWith(UUID_A, { activeRole: 'PROVIDER' });
    expect(h.fns.revokeAllSecuritySessions).not.toHaveBeenCalled();
  });
  it('revoke-session of the CURRENT session ends it like a logout (local delete, Keycloak end-session, home page)', async () => {
    const h = harness();
    seed(h);
    h.fns.revokeSecuritySession.mockResolvedValueOnce({ current: true });
    const res = await action(h, 'revoke-session', { sessionId: UUID_A });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(h.deps.cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/`);
    expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it('revoke-all signs out the OTHER sessions only (includeCurrent false) and keeps this one', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'revoke-all'), '?notice=signed_out_elsewhere');
    expect(h.fns.revokeAllSecuritySessions).toHaveBeenCalledWith({ includeCurrent: false }, { activeRole: undefined });
    expect(h.store.sessions.size).toBe(1);
  });
  it('trust-device and untrust-device act on this browser', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'trust-device'), '?notice=device_trusted');
    expectBack(await action(h, 'untrust-device'), '?notice=device_untrusted');
    expect(h.fns.trustCurrentDevice).toHaveBeenCalledTimes(1);
    expect(h.fns.untrustCurrentDevice).toHaveBeenCalledTimes(1);
  });
  it('remove-device forwards the uuid', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'remove-device', { deviceId: UUID_B }), '?notice=device_removed');
    expect(h.fns.removeSecurityDevice).toHaveBeenCalledWith(UUID_B, { activeRole: undefined });
  });
  it('accepts upper-case uuids (they are forwarded as submitted; the API validates them again)', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'revoke-session', { sessionId: UUID_A.toUpperCase() }), '?notice=session_revoked');
  });
  it.each([
    ['TOTP', 'totp', 'CONFIGURE_TOTP'],
    ['RECOVERY_CODES', 'recovery', 'CONFIGURE_RECOVERY_AUTHN_CODES'],
  ])(
    'mfa-enroll %s records the request, leaves the one-shot marker for this session and sends the browser to a login with kcAction=%s',
    async (method, kcAction, kc) => {
      const h = harness();
      seed(h);
      const res = await action(h, 'mfa-enroll', { method });
      expect(h.fns.startMfaEnrollment).toHaveBeenCalledWith(method, { activeRole: undefined });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/auth/login?returnTo=/security&kcAction=${kcAction}`);
      expect(res.headers.get('location')).not.toContain(kc);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(h.store.enrollments.get('sid-1')?.marker).toEqual({ method });
      // the marker is bound to the session id and lives 300 s
      expect([...h.store.enrollments.keys()]).toEqual(['sid-1']);
      const ttl = h.store.enrollments.get('sid-1')!.expiresAt - Date.now();
      expect(ttl).toBeGreaterThan(290_000);
      expect(ttl).toBeLessThanOrEqual(300_000);
      // and that login URL really starts that Keycloak action, once
      const login = await startLogin(h, new URL(res.headers.get('location')!).search.slice(1), SESSION_COOKIE);
      expect(login.authorize.searchParams.get('kc_action')).toBe(kc);
      expect(login.authorize.searchParams.get('prompt')).toBe('login');
      expect(h.store.enrollments.size).toBe(0);
    },
  );
  it('mfa-enroll leaves no marker when the API refuses (no recent authentication, MFA not available) or answers oddly', async () => {
    const h = harness();
    seed(h);
    h.fns.startMfaEnrollment.mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'RECENT_AUTHENTICATION' }));
    await action(h, 'mfa-enroll', { method: 'TOTP' });
    h.fns.startMfaEnrollment.mockResolvedValueOnce({ method: 'TOTP', keycloakAction: 'DELETE_ACCOUNT' });
    await action(h, 'mfa-enroll', { method: 'TOTP' });
    expect(h.store.enrollments.size).toBe(0);
  });
  it('a new enrollment request replaces the marker of the same session (the last method wins)', async () => {
    const h = harness();
    seed(h);
    await action(h, 'mfa-enroll', { method: 'TOTP' });
    await action(h, 'mfa-enroll', { method: 'RECOVERY_CODES' });
    expect(h.store.enrollments.get('sid-1')?.marker).toEqual({ method: 'RECOVERY_CODES' });
  });
  it('mfa-enroll does not follow an API answer that differs from the method chosen', async () => {
    const h = harness();
    seed(h);
    h.fns.startMfaEnrollment.mockResolvedValueOnce({ method: 'TOTP', keycloakAction: 'DELETE_ACCOUNT' });
    expectBack(await action(h, 'mfa-enroll', { method: 'TOTP' }), '?error=API_ERROR');
    h.fns.startMfaEnrollment.mockResolvedValueOnce({ method: 'RECOVERY_CODES', keycloakAction: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    expectBack(await action(h, 'mfa-enroll', { method: 'TOTP' }), '?error=API_ERROR');
  });
});

describe('remove-device clears the device cookie when it removes THIS browser', () => {
  it('current device: the response clears the cookie (Max-Age=0, Path=/, HttpOnly), after listing and removing', async () => {
    const h = harness();
    seed(h);
    const order: string[] = [];
    h.fns.listSecurityDevices.mockImplementationOnce(async () => {
      order.push('list');
      return { devices: [{ deviceId: UUID_B, current: true }] };
    });
    h.fns.removeSecurityDevice.mockImplementationOnce(async () => {
      order.push('remove');
      return { deviceId: UUID_B, changed: true, sessionsRevoked: 1, keycloak: 'ENDED' };
    });
    const res = await action(h, 'remove-device', { deviceId: UUID_B });
    expect(order).toEqual(['list', 'remove']);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/security?notice=device_removed`);
    const cookie = cookieOf(res, 'bg_device')!;
    expect(cookie).toMatch(/^bg_device=;/);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(res.headers.getSetCookie()).toHaveLength(1); // the session cookie is left to /auth/revoked
  });
  it('matches the id case-insensitively', async () => {
    const h = harness();
    seed(h);
    h.fns.listSecurityDevices.mockResolvedValueOnce({ devices: [{ deviceId: UUID_B, current: true }] });
    const res = await action(h, 'remove-device', { deviceId: UUID_B.toUpperCase() });
    expect(cookieOf(res, 'bg_device')).toMatch(/Max-Age=0/);
  });
  it('another browser: no cookie is touched', async () => {
    const h = harness();
    seed(h);
    h.fns.listSecurityDevices.mockResolvedValueOnce({
      devices: [
        { deviceId: UUID_A, current: true },
        { deviceId: UUID_B, current: false },
      ],
    });
    expectBack(await action(h, 'remove-device', { deviceId: UUID_B }), '?notice=device_removed');
  });
  it('a list that cannot be read leaves the cookie and still removes the device', async () => {
    const h = harness();
    seed(h);
    h.fns.listSecurityDevices.mockRejectedValueOnce(apiError(503, 'ACCOUNT_SECURITY_UNAVAILABLE'));
    expectBack(await action(h, 'remove-device', { deviceId: UUID_B }), '?notice=device_removed');
    expect(h.fns.removeSecurityDevice).toHaveBeenCalledTimes(1);
  });
  it('a refused removal clears nothing', async () => {
    const h = harness();
    seed(h);
    h.fns.listSecurityDevices.mockResolvedValueOnce({ devices: [{ deviceId: UUID_B, current: true }] });
    h.fns.removeSecurityDevice.mockRejectedValueOnce(apiError(404, 'ACCOUNT_DEVICE_NOT_FOUND'));
    expectBack(await action(h, 'remove-device', { deviceId: UUID_B }), '?error=ACCOUNT_DEVICE_NOT_FOUND');
  });
  it('https: clears __Host-bg_device with Secure', async () => {
    const h = harness('https://app.example.com');
    seed(h, {}, 'sid-1');
    h.fns.listSecurityDevices.mockResolvedValueOnce({ devices: [{ deviceId: UUID_B, current: true }] });
    const res = await handleSecurityAction(
      post('/auth/security/remove-device', { deviceId: UUID_B }, { origin: 'https://app.example.com', cookie: '__Host-bg_session=sid-1' }),
      h.deps,
      'remove-device',
    );
    expect(cookieOf(res, '__Host-bg_device')).toMatch(/Max-Age=0.*Secure|Secure.*Max-Age=0/);
  });
  it('other actions never touch the device cookie', async () => {
    const h = harness();
    seed(h);
    for (const [name, fields] of [
      ['revoke-all', {}],
      ['trust-device', {}],
      ['untrust-device', {}],
      ['revoke-session', { sessionId: UUID_A }],
    ] as const) {
      expect((await action(h, name, fields)).headers.getSetCookie(), name).toEqual([]);
    }
  });
});

describe('security actions: unknown and malformed form values change nothing (400)', () => {
  const CASES: Array<[SecurityAction, Record<string, string>]> = [
    ['revoke-session', {}],
    ['revoke-session', { sessionId: '' }],
    ['revoke-session', { sessionId: 'not-a-uuid' }],
    ['revoke-session', { sessionId: `${UUID_A} ` }],
    ['revoke-session', { sessionId: `${UUID_A}/../x` }],
    ['revoke-session', { sessionId: 'current' }],
    ['revoke-session', { sessionId: UUID_A, deviceId: UUID_B }],
    ['revoke-session', { sessionId: UUID_A, includeCurrent: 'true' }],
    ['revoke-session', { deviceId: UUID_A }],
    ['remove-device', {}],
    ['remove-device', { deviceId: 'current' }],
    ['remove-device', { deviceId: `${UUID_A}?x=1` }],
    ['remove-device', { deviceId: UUID_A, sessionId: UUID_B }],
    ['mfa-enroll', {}],
    ['mfa-enroll', { method: '' }],
    ['mfa-enroll', { method: 'totp' }],
    ['mfa-enroll', { method: 'TOTP ' }],
    ['mfa-enroll', { method: 'SMS' }],
    ['mfa-enroll', { method: 'PASSWORD' }],
    ['mfa-enroll', { method: 'constructor' }],
    ['mfa-enroll', { method: 'TOTP', kcAction: 'DELETE_ACCOUNT' }],
    ['revoke-all', { includeCurrent: 'true' }],
    ['revoke-all', { anything: '1' }],
    ['trust-device', { deviceId: UUID_A }],
    ['trust-device', { until: '2099-01-01' }],
    ['untrust-device', { deviceId: UUID_A }],
  ];
  it.each(CASES)('%s %j', async (name, fields) => {
    const h = harness();
    seed(h);
    const res = await action(h, name, fields);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    noSecurityCalls(h);
  });
  it('refuses a repeated field, a file part and a body that is not a form', async () => {
    const h = harness();
    seed(h);
    const twice = new URLSearchParams();
    twice.append('sessionId', UUID_A);
    twice.append('sessionId', UUID_B);
    expect((await action(h, 'revoke-session', {}, { body: twice })).status).toBe(400);
    const multipart = new FormData();
    multipart.append('sessionId', new Blob([UUID_A]), 'x.txt');
    expect((await action(h, 'revoke-session', {}, { body: multipart })).status).toBe(400);
    expect(
      (await action(h, 'revoke-session', {}, { body: JSON.stringify({ sessionId: UUID_A }), headers: { 'content-type': 'application/json' } })).status,
    ).toBe(400);
    expect((await action(h, 'revoke-all', {}, { body: null })).status).toBe(400);
    noSecurityCalls(h);
  });
  it('is checked AFTER the session (a signed-out browser is only sent to /session) and never reads a body it does not need', async () => {
    const h = harness();
    const res = await action(h, 'revoke-session', { sessionId: 'garbage' }, { cookie: null });
    expect(res.status).toBe(303);
    noSecurityCalls(h);
  });
});

describe('security actions: what the API can answer', () => {
  const ACTIONS: Array<[SecurityAction, Record<string, string>, keyof Fns]> = [
    ['revoke-session', { sessionId: UUID_A }, 'revokeSecuritySession'],
    ['revoke-all', {}, 'revokeAllSecuritySessions'],
    ['trust-device', {}, 'trustCurrentDevice'],
    ['untrust-device', {}, 'untrustCurrentDevice'],
    ['remove-device', { deviceId: UUID_B }, 'removeSecurityDevice'],
    ['mfa-enroll', { method: 'TOTP' }, 'startMfaEnrollment'],
  ];

  it.each(ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name, fields, fn) => {
    const h = harness();
    seed(h);
    h.fns[fn].mockRejectedValueOnce(revoked());
    const res = await action(h, name, fields);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(h.deps.cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it.each(ACTIONS)('%s: 401 STEP_UP_REQUIRED becomes ONE login round trip for a recent authentication', async (name, fields, fn) => {
    const h = harness();
    seed(h);
    h.fns[fn].mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'RECENT_AUTHENTICATION', maxAgeSeconds: 900 }));
    const res = await action(h, name, fields);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/auth/login?returnTo=/security&stepUp=recent`);
    expect(h.store.sessions.size).toBe(1); // nothing is deleted: the person is still signed in until the login completes
    expect(h.fns[fn]).toHaveBeenCalledTimes(1); // the action is NOT repeated automatically
  });
  it('STEP_UP_REQUIRED for MFA asks for the second factor; an unknown or missing requirement asks for the weaker, safe default', async () => {
    const h = harness();
    seed(h);
    h.fns.trustCurrentDevice.mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA', maxAgeSeconds: 900, acrValues: ACR_MFA }));
    expect((await action(h, 'trust-device')).headers.get('location')).toBe(`${PUBLIC}/auth/login?returnTo=/security&stepUp=mfa`);
    for (const details of [undefined, {}, { requirement: 'mfa' }, { requirement: 'evil&prompt=none' }]) {
      h.fns.trustCurrentDevice.mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', details));
      expect((await action(h, 'trust-device')).headers.get('location'), JSON.stringify(details)).toBe(`${PUBLIC}/auth/login?returnTo=/security&stepUp=recent`);
    }
  });
  it('the step-up login URL the handler returns really asks Keycloak for it, once', async () => {
    const h = harness();
    seed(h);
    h.fns.trustCurrentDevice.mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
    const next = (await action(h, 'trust-device')).headers.get('location')!;
    const login = await startLogin(h, new URL(next).search.slice(1));
    expect(login.authorize.searchParams.get('prompt')).toBe('login');
    expect(login.authorize.searchParams.get('acr_values')).toBe(ACR_MFA);
  });
  it('a STEP_UP_REQUIRED that is not a 401 is just an error code', async () => {
    const h = harness();
    seed(h);
    h.fns.trustCurrentDevice.mockRejectedValueOnce(apiError(403, 'STEP_UP_REQUIRED'));
    expectBack(await action(h, 'trust-device'), '?error=STEP_UP_REQUIRED');
  });
  it('MFA_ENROLLMENT_REQUIRED and other API codes come back as ?error=<code>', async () => {
    const h = harness();
    seed(h);
    for (const [status, code] of [
      [403, 'MFA_ENROLLMENT_REQUIRED'],
      [404, 'ACCOUNT_SESSION_NOT_FOUND'],
      [404, 'ACCOUNT_DEVICE_NOT_FOUND'],
      [409, 'ACCOUNT_DEVICE_REQUIRED'],
      [503, 'ACCOUNT_SECURITY_UNAVAILABLE'],
      [403, 'ACCOUNT_SUSPENDED'],
    ] as const) {
      h.fns.revokeSecuritySession.mockRejectedValueOnce(apiError(status, code));
      expectBack(await action(h, 'revoke-session', { sessionId: UUID_A }), `?error=${code}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it('an unreachable API, a non-API error or an odd code is reduced to API_ERROR (never echoed)', async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      new Error('internal detail'),
      apiError(500, 'weird code with spaces'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
    ]) {
      h.fns.revokeAllSecuritySessions.mockRejectedValueOnce(failure);
      const res = await action(h, 'revoke-all');
      const expected = failure instanceof ApiError && failure.code === 'API_UNREACHABLE' ? 'API_UNREACHABLE' : 'API_ERROR';
      expectBack(res, `?error=${expected}`);
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('no redirect, header, cookie or log line carries a submitted id, the token or a Keycloak value', async () => {
    const h = harness();
    seed(h);
    const results: Response[] = [];
    results.push(await action(h, 'revoke-session', { sessionId: UUID_A }));
    h.fns.removeSecurityDevice.mockRejectedValueOnce(apiError(404, 'ACCOUNT_DEVICE_NOT_FOUND'));
    results.push(await action(h, 'remove-device', { deviceId: UUID_B }));
    results.push(await action(h, 'mfa-enroll', { method: 'RECOVERY_CODES' }));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of [UUID_A, UUID_B, TOKENS.access, TOKENS.refresh, TOKENS.id, 'CONFIGURE_']) expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    for (const marker of [UUID_A, UUID_B, TOKENS.access, TOKENS.refresh, TOKENS.id]) expect(logs).not.toContain(marker);
  });
});

describe('the Next route module for /auth/security/<action>', () => {
  it('delegates a known action to the handler with the process-wide deps', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const res = await securityPost(post('/auth/security/revoke-all', {}), { params: Promise.resolve({ action: 'revoke-all' }) });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/security?notice=signed_out_elsewhere`);
    expect(routeState.calls).toBe(1);
  });
  it('answers an unknown action with 404 without touching the deps, and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'REVOKE-ALL', 'constructor', '__proto__']) {
      const res = await securityPost(post('/auth/security/x', {}), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = securityGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(routeState.calls).toBe(0);
  });
});

// ---------------------------------------------------------------- the public password-reset request
describe('POST /auth/password-reset', () => {
  const reset = (h: Harness, fields: Record<string, string> | undefined, o: Parameters<typeof post>[2] = {}) =>
    handlePasswordReset(post('/auth/password-reset', fields, { cookie: null, ...o }), h.deps);
  const redirectTo = (res: Response, status: string): void => {
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/forgot-password?status=${status}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.body).toBeNull();
  };

  it('needs no session: forwards the address in the body and the browser address (the LAST x-forwarded-for entry) and says accepted', async () => {
    const h = harness();
    redirectTo(await reset(h, { email: EMAIL_MARKER }, { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } }), 'accepted');
    expect(h.fns.requestPasswordReset).toHaveBeenCalledWith(EMAIL_MARKER, { clientIp: '203.0.113.9' });
    expect(h.apiTokens).toEqual([]); // no token is involved
  });
  it('the answer is identical for every address (no account enumeration) and carries no address', async () => {
    const h = harness();
    const a = await reset(h, { email: 'exists@example.test' });
    const b = await reset(h, { email: 'nobody@example.test' });
    const c = await reset(h, { email: EMAIL_MARKER });
    expect(await seen(a)).toBe(await seen(b));
    expect(await seen(b)).toBe(await seen(c));
    for (const marker of [EMAIL_MARKER, 'leak.marker', 'example.test']) expect(await seen(c)).not.toContain(marker);
    expect(h.logs.join('\n')).not.toContain('example.test');
  });
  it('works for a signed-in browser too, and ignores its session', async () => {
    const h = harness();
    seed(h);
    redirectTo(await reset(h, { email: 'a@example.test' }, { cookie: SESSION_COOKIE }), 'accepted');
    expect(h.apiTokens).toEqual([]);
  });
  it('an empty, blank or over-long address is "invalid" without calling the API', async () => {
    const h = harness();
    for (const email of ['', '   ', '\t\n', `${'a'.repeat(310)}@example.test`]) redirectTo(await reset(h, { email }), 'invalid');
    expect(h.fns.requestPasswordReset).not.toHaveBeenCalled();
  });
  it('maps the API outcomes: 429 -> rate_limited, 400 -> invalid, anything else -> unavailable (never accepted)', async () => {
    for (const [failure, status] of [
      [apiError(429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED'), 'rate_limited'],
      [apiError(400, 'VALIDATION_FAILED'), 'invalid'],
      [apiError(503, 'ACCOUNT_SECURITY_UNAVAILABLE'), 'unavailable'],
      [apiError(500, 'INTERNAL'), 'unavailable'],
      [apiError(0, 'API_UNREACHABLE'), 'unavailable'],
      [new Error('boom'), 'unavailable'],
    ] as const) {
      const h = harness();
      h.fns.requestPasswordReset.mockRejectedValueOnce(failure);
      redirectTo(await reset(h, { email: EMAIL_MARKER }), status);
      expect(h.logs.join('\n')).not.toContain('example.test');
    }
  });
  it('is POST-only and Origin-checked (a cross-site form cannot make the server send mail)', async () => {
    const h = harness();
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await reset(h, {}, { method })).status).toBe(405);
    for (const origin of [null, 'http://evil.example', 'http://app.localhost:9999', 'null'])
      expect((await reset(h, { email: 'a@example.test' }, { origin })).status).toBe(403);
    expect(h.fns.requestPasswordReset).not.toHaveBeenCalled();
  });
  it('refuses a missing field, an extra field, a repeated field, a file and a non-form body (400)', async () => {
    const h = harness();
    expect((await reset(h, {})).status).toBe(400);
    expect((await reset(h, { email: 'a@example.test', accountId: UUID_A })).status).toBe(400);
    expect((await reset(h, { email: 'a@example.test', next: 'https://evil.example' })).status).toBe(400);
    const twice = new URLSearchParams();
    twice.append('email', 'a@example.test');
    twice.append('email', 'b@example.test');
    expect((await reset(h, undefined, { body: twice })).status).toBe(400);
    const multipart = new FormData();
    multipart.append('email', new Blob(['a@example.test']), 'x.txt');
    expect((await reset(h, undefined, { body: multipart })).status).toBe(400);
    expect((await reset(h, undefined, { body: '{"email":"a@example.test"}', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect(h.fns.requestPasswordReset).not.toHaveBeenCalled();
  });
  it('refuses to run without a public API client', async () => {
    const h = harness(PUBLIC, false);
    await expect(reset(h, { email: 'a@example.test' })).rejects.toThrow('publicApi');
  });
  it('the route module delegates POST and answers GET with 405 and no side effect', async () => {
    const h = harness();
    routeState.deps = h.deps;
    const ok = await passwordResetPost(post('/auth/password-reset', { email: 'a@example.test' }, { cookie: null }));
    expect(ok.headers.get('location')).toBe(`${PUBLIC}/forgot-password?status=accepted`);
    const get = await passwordResetGet(post('/auth/password-reset', {}, { method: 'GET', cookie: null }));
    expect(get.status).toBe(405);
    expect(h.fns.requestPasswordReset).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- single-flight token refresh
describe('getSession: the token refresh is single-flight per session id', () => {
  const cookieFor = (id: string) => `bg_session=${id}`;
  /** A harness whose token endpoint counts its calls, answers after a short delay (so callers overlap) and rotates the refresh token. */
  function refreshing() {
    const h = harness();
    const seen: string[] = [];
    h.setTokenResponse(async (body) => {
      seen.push(body.get('refresh_token')!);
      await new Promise((r) => setTimeout(r, 15));
      return tokenJson({ ...(await issue('unused')), refresh_token: `rotated-from-${body.get('refresh_token')}` });
    });
    return { h, seen };
  }
  const expiring = (h: Harness, id = 'sid-1', refreshToken = TOKENS.refresh) => seed(h, { refreshToken, accessExpiresAt: h.clock.now + 5 }, id);

  it.each([5, 20])('%i concurrent callers cause ONE token request and all receive the same refreshed record', async (n) => {
    const { h, seen } = refreshing();
    expiring(h);
    const results = await Promise.all(Array.from({ length: n }, () => getSession(cookieFor('sid-1'), h.deps)));
    expect(h.tokenCalls).toHaveLength(1);
    expect(seen).toEqual([TOKENS.refresh]);
    expect(results.every((r) => r !== null && r.id === 'sid-1')).toBe(true);
    const first = results[0]!.record;
    expect(first.refreshToken).toBe(`rotated-from-${TOKENS.refresh}`);
    expect(first.accessToken).not.toBe(TOKENS.access);
    for (const r of results) expect(r!.record).toBe(first); // the very same record
    expect(h.store.sessions.get('sid-1')).toEqual(first);
    expect(h.store.puts).toBe(1); // written once, with the refresh lifetime
    expect(h.store.sessionTtls.get('sid-1')).toBe(1800);
  });
  it('keeps what else the record holds (active role, subject, created time)', async () => {
    const { h } = refreshing();
    seed(h, { activeRole: 'PROVIDER', accessExpiresAt: h.clock.now + 5 });
    const [a] = await Promise.all([getSession(cookieFor('sid-1'), h.deps), getSession(cookieFor('sid-1'), h.deps)]);
    expect(a!.record).toMatchObject({ activeRole: 'PROVIDER', subject: 'user-1', createdAt: h.clock.now });
  });
  it('a fresh session is not refreshed, and a later call after the refresh does not refresh again', async () => {
    const { h } = refreshing();
    seed(h);
    await Promise.all(Array.from({ length: 5 }, () => getSession(cookieFor('sid-1'), h.deps)));
    expect(h.tokenCalls).toHaveLength(0);
    const e = refreshing();
    expiring(e.h);
    await Promise.all(Array.from({ length: 5 }, () => getSession(cookieFor('sid-1'), e.h.deps)));
    await getSession(cookieFor('sid-1'), e.h.deps);
    expect(e.h.tokenCalls).toHaveLength(1);
  });
  it('a caller that read the stale record just before the refresh finished does not refresh a second time', async () => {
    const { h } = refreshing();
    expiring(h);
    const stale = { ...h.store.sessions.get('sid-1')! };
    const first = getSession(cookieFor('sid-1'), h.deps);
    while (h.tokenCalls.length === 0) await new Promise((r) => setTimeout(r, 2)); // the refresh is under way
    // the slow reader gets the stale record only AFTER the flight finished, then decides
    const realGet = h.store.getSession.bind(h.store);
    let slowReads = 0;
    h.store.getSession = async (id) => {
      if (slowReads++ === 0) {
        await first;
        return stale;
      }
      return realGet(id);
    };
    const second = getSession(cookieFor('sid-1'), h.deps);
    const [a, b] = await Promise.all([first, second]);
    expect(h.tokenCalls).toHaveLength(1);
    expect(b!.record).toEqual(a!.record);
  });
  it('a failed refresh: every waiter sees signed out, the session is deleted once, and the entry is cleared so the next call retries', async () => {
    const h = harness();
    expiring(h);
    h.setTokenResponse(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => getSession(cookieFor('sid-1'), h.deps)));
    expect(results.every((r) => r === null)).toBe(true);
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.store.sessions.size).toBe(0);
    expect(h.logs.filter((l) => l.includes('session expired'))).toHaveLength(1);
    // the entry was cleared: when the session exists again and the endpoint works, the next call refreshes (a new token request)
    expiring(h);
    h.setTokenResponse(async () => tokenJson({ ...(await issue('unused')), refresh_token: 'rotated-after-retry' }));
    const retry = await getSession(cookieFor('sid-1'), h.deps);
    expect(retry?.record.refreshToken).toBe('rotated-after-retry');
    expect(h.tokenCalls).toHaveLength(2);
  });
  it('a token that fails verification is the same failure (signed out, deleted)', async () => {
    const h = harness();
    expiring(h);
    h.setTokenResponse(async () => tokenJson({ ...(await issue('unused')), access_token: 'not-a-jwt' }));
    const results = await Promise.all([getSession(cookieFor('sid-1'), h.deps), getSession(cookieFor('sid-1'), h.deps)]);
    expect(results).toEqual([null, null]);
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.store.sessions.size).toBe(0);
  });
  it('different session ids refresh independently, each with its own refresh token', async () => {
    const { h, seen } = refreshing();
    expiring(h, 'sid-1', 'refresh-one');
    expiring(h, 'sid-2', 'refresh-two');
    const calls = [
      ...Array.from({ length: 5 }, () => getSession(cookieFor('sid-1'), h.deps)),
      ...Array.from({ length: 5 }, () => getSession(cookieFor('sid-2'), h.deps)),
    ];
    const results = await Promise.all(calls);
    expect(h.tokenCalls).toHaveLength(2);
    expect([...seen].sort()).toEqual(['refresh-one', 'refresh-two']);
    expect(results.slice(0, 5).every((r) => r?.record.refreshToken === 'rotated-from-refresh-one')).toBe(true);
    expect(results.slice(5).every((r) => r?.record.refreshToken === 'rotated-from-refresh-two')).toBe(true);
    expect(h.store.sessions.get('sid-1')!.refreshToken).toBe('rotated-from-refresh-one');
    expect(h.store.sessions.get('sid-2')!.refreshToken).toBe('rotated-from-refresh-two');
  });
  it('one failing session does not affect another that refreshes at the same time', async () => {
    const h = harness();
    expiring(h, 'sid-1', 'bad-refresh');
    expiring(h, 'sid-2', 'good-refresh');
    h.setTokenResponse(async (body) =>
      body.get('refresh_token') === 'bad-refresh'
        ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        : tokenJson({ ...(await issue('unused')), refresh_token: 'rotated-good' }),
    );
    const [bad, good] = await Promise.all([getSession(cookieFor('sid-1'), h.deps), getSession(cookieFor('sid-2'), h.deps)]);
    expect(bad).toBeNull();
    expect(good?.record.refreshToken).toBe('rotated-good');
    expect(h.store.sessions.has('sid-1')).toBe(false);
    expect(h.store.sessions.has('sid-2')).toBe(true);
  });
  it('the single-flight map is per store: the same id in another store refreshes on its own', async () => {
    const a = refreshing();
    const b = refreshing();
    expiring(a.h);
    expiring(b.h);
    await Promise.all([getSession(cookieFor('sid-1'), a.h.deps), getSession(cookieFor('sid-1'), b.h.deps)]);
    expect(a.h.tokenCalls).toHaveLength(1);
    expect(b.h.tokenCalls).toHaveLength(1);
  });
  it('the security actions share it: concurrent POSTs of one browser cause one refresh', async () => {
    const { h } = refreshing();
    expiring(h);
    const results = await Promise.all([action(h, 'revoke-all'), action(h, 'trust-device'), action(h, 'untrust-device')]);
    expect(results.every((r) => r.status === 303)).toBe(true);
    expect(h.tokenCalls).toHaveLength(1);
  });
});

describe('ValkeySessionStore enrollment marker', () => {
  function fake() {
    const data = new Map<string, { value: string; ttl: number }>();
    const client: ValkeyLike = {
      set: (async (key: string, value: string, _mode: string, ttl: number) => {
        data.set(key, { value, ttl });
        return 'OK';
      }) as ValkeyLike['set'],
      get: async (key) => data.get(key)?.value ?? null,
      del: async (key) => data.delete(key),
      getdel: async (key) => {
        const v = data.get(key)?.value ?? null;
        data.delete(key);
        return v;
      },
    };
    return { data, store: new ValkeySessionStore(client, 'test') };
  }
  it('stores the method under a key bound to the session id with the TTL, and takes it exactly once', async () => {
    const { data, store } = fake();
    await store.putEnrollment('sid-1', { method: 'TOTP' }, 300);
    expect([...data.keys()]).toEqual(['bg:test:web:enroll:sid-1']);
    expect(data.get('bg:test:web:enroll:sid-1')!.ttl).toBe(300);
    expect(await store.takeEnrollment('sid-2')).toBeNull();
    expect(await store.takeEnrollment('sid-1')).toEqual({ method: 'TOTP' });
    expect(await store.takeEnrollment('sid-1')).toBeNull();
  });
  it('treats a corrupt or foreign value as no marker', async () => {
    const { data, store } = fake();
    for (const raw of ['not json', '{"method":"SMS"}', '{}', 'null']) {
      data.set('bg:test:web:enroll:sid-1', { value: raw, ttl: 1 });
      expect(await store.takeEnrollment('sid-1'), raw).toBeNull();
    }
  });
});
