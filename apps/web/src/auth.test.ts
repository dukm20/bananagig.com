import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { codeChallengeS256, createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { getSession, handleCallback, handleLogin, handleLogout, handleSession } from './lib/auth/handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps } from './lib/auth/types';

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
  };
};

let keys: TestKeys;
beforeAll(async () => {
  keys = await createTestKeys('k1');
});

interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  tokenCalls: URLSearchParams[];
  clock: { now: number };
  setTokenResponse(fn: (body: URLSearchParams) => Promise<Response>): void;
}
function harness(publicUrl = PUBLIC): Harness {
  const store = new MemorySessionStore();
  const tokenCalls: URLSearchParams[] = [];
  const clock = { now: Math.floor(Date.now() / 1000) };
  let responder: (body: URLSearchParams) => Promise<Response> = async () => new Response('{}', { status: 500 });
  const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    tokenCalls.push(body);
    return responder(body);
  }) as typeof fetch;
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  return {
    deps: { cfg: cfgFor(publicUrl), store, verifier, fetch: fetchStub, now: () => clock.now },
    store,
    tokenCalls,
    clock,
    setTokenResponse: (fn) => (responder = fn),
  };
}
const tokenJson = (o: Record<string, unknown>) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
async function issue(nonce: string, claims: Record<string, unknown> = {}, expiresInSec = 300) {
  return {
    access_token: await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims }, expiresInSec }),
    refresh_token: 'refresh-token-value',
    id_token: await signToken(keys, { claims: { typ: 'ID', aud: 'bananagig-web', azp: 'bananagig-web', nonce } }),
    expires_in: expiresInSec,
    refresh_expires_in: 1800,
  };
}
const cookieOf = (res: Response, name: string): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const valueOf = (setCookie: string): string => setCookie.split(';')[0]!.split('=').slice(1).join('=');

/** Runs login and returns what the browser would hold and what Keycloak would be told. */
async function startLogin(h: Harness, returnTo = '/session') {
  const res = await handleLogin(new Request(`http://web-app:3000/auth/login?returnTo=${encodeURIComponent(returnTo)}`), h.deps);
  const authorize = new URL(res.headers.get('location')!);
  const tx = cookieOf(res, 'bg_auth_tx')!;
  return { res, authorize, txCookie: `bg_auth_tx=${valueOf(tx)}`, tx };
}

describe('login (Authorization Code + PKCE)', () => {
  it('redirects to Keycloak with code flow, S256, state and nonce; no secret; binds the browser with an HttpOnly cookie', async () => {
    const h = harness();
    const { res, authorize, tx } = await startLogin(h);
    expect(res.status).toBe(302);
    expect(authorize.origin + authorize.pathname).toBe(h.deps.cfg.endpoints.authorization);
    const q = Object.fromEntries(authorize.searchParams);
    expect(q).toMatchObject({ response_type: 'code', client_id: 'bananagig-web', redirect_uri: `${PUBLIC}/auth/callback`, code_challenge_method: 'S256' });
    expect(q.state).toBeTruthy();
    expect(q.nonce).toBeTruthy();
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.has('client_secret')).toBe(false);
    expect(tx).toMatch(/HttpOnly/);
    expect(tx).toMatch(/SameSite=Lax/);
    expect(tx).toMatch(/Path=\/auth/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('only accepts same-site return paths', async () => {
    const h = harness();
    await startLogin(h, 'https://evil.example/steal');
    expect([...h.store.transactions.values()][0]!.returnTo).toBe('/');
  });
});

describe('callback', () => {
  async function successfulLogin(h: Harness, publicUrl = PUBLIC) {
    const login = await startLogin(h);
    const { state, nonce, code_challenge } = Object.fromEntries(login.authorize.searchParams);
    h.setTokenResponse(async () => tokenJson(await issue(nonce!)));
    const res = await handleCallback(new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}`, { headers: { cookie: login.txCookie } }), h.deps);
    return { res, login, code_challenge: code_challenge!, publicUrl };
  }

  it('exchanges the code with the PKCE verifier and creates an opaque HttpOnly session; tokens never reach the browser', async () => {
    const h = harness();
    const { res, code_challenge } = await successfulLogin(h);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`); // built from WEB_PUBLIC_URL, not the internal request host
    const call = h.tokenCalls[0]!;
    expect(call.get('grant_type')).toBe('authorization_code');
    expect(call.get('code')).toBe('abc');
    expect(call.has('client_secret')).toBe(false);
    expect(codeChallengeS256(call.get('code_verifier')!)).toBe(code_challenge); // PKCE verifier matches the challenge sent at login
    const sc = cookieOf(res, 'bg_session')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Secure/); // http in development
    const [record] = [...h.store.sessions.values()];
    expect(record).toMatchObject({ subject: 'test-subject-1', realmRoles: ['customer'] });
    const browserVisible = [res.headers.get('location'), ...res.headers.getSetCookie()].join('\n');
    expect(browserVisible).not.toContain(record!.accessToken);
    expect(browserVisible).not.toContain(record!.refreshToken);
    expect(browserVisible).not.toContain(record!.idToken!);
    expect(h.store.transactions.size).toBe(0); // login transaction consumed
  });
  it('uses Secure and the __Host- prefix on https (production)', async () => {
    const h = harness('https://app.example.com');
    const { res } = await successfulLogin(h);
    const sc = cookieOf(res, '__Host-bg_session')!;
    expect(sc).toMatch(/; Secure/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/);
  });
  const expectFailed = (res: Response, h: Harness) => {
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session?error=login_failed`);
    expect(cookieOf(res, 'bg_session')).toBeUndefined();
    expect(h.store.sessions.size).toBe(0);
  };
  it('rejects a callback without the transaction cookie (login CSRF)', async () => {
    const h = harness();
    const login = await startLogin(h);
    const state = login.authorize.searchParams.get('state');
    expectFailed(await handleCallback(new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}`), h.deps), h);
  });
  it('rejects a state mismatch', async () => {
    const h = harness();
    const login = await startLogin(h);
    expectFailed(
      await handleCallback(new Request('http://web-app:3000/auth/callback?code=abc&state=forged', { headers: { cookie: login.txCookie } }), h.deps),
      h,
    );
  });
  it('rejects a replayed callback', async () => {
    const h = harness();
    const login = await startLogin(h);
    const { state, nonce } = Object.fromEntries(login.authorize.searchParams);
    h.setTokenResponse(async () => tokenJson(await issue(nonce!)));
    const req = () => new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}`, { headers: { cookie: login.txCookie } });
    expect((await handleCallback(req(), h.deps)).headers.get('location')).toBe(`${PUBLIC}/session`);
    expect((await handleCallback(req(), h.deps)).headers.get('location')).toContain('login_failed');
  });
  it('rejects an ID token with the wrong nonce', async () => {
    const h = harness();
    const login = await startLogin(h);
    h.setTokenResponse(async () => tokenJson(await issue('some-other-nonce')));
    expectFailed(
      await handleCallback(
        new Request(`http://web-app:3000/auth/callback?code=abc&state=${login.authorize.searchParams.get('state')}`, { headers: { cookie: login.txCookie } }),
        h.deps,
      ),
      h,
    );
  });
  it('rejects tokens for the wrong issuer or audience', async () => {
    const h = harness();
    const login = await startLogin(h);
    const nonce = login.authorize.searchParams.get('nonce')!;
    h.setTokenResponse(async () =>
      tokenJson({ ...(await issue(nonce)), id_token: await signToken(keys, { claims: { typ: 'ID', aud: 'bananagig-admin', nonce } }) }),
    );
    expectFailed(
      await handleCallback(
        new Request(`http://web-app:3000/auth/callback?code=abc&state=${login.authorize.searchParams.get('state')}`, { headers: { cookie: login.txCookie } }),
        h.deps,
      ),
      h,
    );
  });
  it('treats provider errors and failed code exchange as a generic failure without leaking details', async () => {
    const h = harness();
    const login = await startLogin(h);
    h.setTokenResponse(
      async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code not valid: internal detail' }), { status: 400 }),
    );
    const res = await handleCallback(
      new Request(`http://web-app:3000/auth/callback?code=abc&state=${login.authorize.searchParams.get('state')}`, { headers: { cookie: login.txCookie } }),
      h.deps,
    );
    expectFailed(res, h);
    expect(res.headers.get('location')).not.toContain('internal');
    const denied = harness();
    const l2 = await startLogin(denied);
    expectFailed(
      await handleCallback(
        new Request(`http://web-app:3000/auth/callback?error=access_denied&state=${l2.authorize.searchParams.get('state')}`, {
          headers: { cookie: l2.txCookie },
        }),
        denied.deps,
      ),
      denied,
    );
  });
});

describe('session status and expiry', () => {
  async function loggedIn() {
    const h = harness();
    const login = await startLogin(h);
    const { state, nonce } = Object.fromEntries(login.authorize.searchParams);
    h.setTokenResponse(async () => tokenJson(await issue(nonce!)));
    const res = await handleCallback(new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}`, { headers: { cookie: login.txCookie } }), h.deps);
    return { h, cookie: `bg_session=${valueOf(cookieOf(res, 'bg_session')!)}` };
  }
  it('reports unauthenticated without a cookie and minimal identity with one (never tokens)', async () => {
    const { h, cookie } = await loggedIn();
    const anon = await (await handleSession(new Request('http://web-app:3000/auth/session'), h.deps)).json();
    expect(anon).toEqual({ authenticated: false });
    const res = await handleSession(new Request('http://web-app:3000/auth/session', { headers: { cookie } }), h.deps);
    const body = await res.json();
    expect(body).toMatchObject({ authenticated: true, subject: 'test-subject-1', realmRoles: ['customer'] });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('refreshes an expiring access token transparently', async () => {
    const { h, cookie } = await loggedIn();
    h.clock.now += 290; // inside the refresh skew
    h.setTokenResponse(async () => tokenJson({ ...(await issue('unused')), refresh_token: 'rotated-refresh' }));
    const s = await getSession(cookie, h.deps);
    expect(s?.record.refreshToken).toBe('rotated-refresh');
    expect(h.tokenCalls.at(-1)!.get('grant_type')).toBe('refresh_token');
  });
  it('signs the user out (and deletes the session) when refresh fails', async () => {
    const { h, cookie } = await loggedIn();
    h.clock.now += 290;
    h.setTokenResponse(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    expect(await getSession(cookie, h.deps)).toBeNull();
    expect(h.store.sessions.size).toBe(0);
    expect(await getSession(cookie, h.deps)).toBeNull();
  });
});

describe('logout', () => {
  async function loggedIn() {
    const h = harness();
    const login = await startLogin(h);
    const { state, nonce } = Object.fromEntries(login.authorize.searchParams);
    h.setTokenResponse(async () => tokenJson(await issue(nonce!)));
    const res = await handleCallback(new Request(`http://web-app:3000/auth/callback?code=abc&state=${state}`, { headers: { cookie: login.txCookie } }), h.deps);
    return { h, cookie: `bg_session=${valueOf(cookieOf(res, 'bg_session')!)}` };
  }
  it('is POST-only', async () => {
    const { h, cookie } = await loggedIn();
    const res = await handleLogout(new Request('http://web-app:3000/auth/logout', { method: 'GET', headers: { cookie } }), h.deps);
    expect(res.status).toBe(405);
    expect(h.store.sessions.size).toBe(1);
  });
  it('rejects cross-site and origin-less requests (CSRF) and keeps the session', async () => {
    const { h, cookie } = await loggedIn();
    for (const origin of [undefined, 'http://evil.example', 'http://app.localhost:9999']) {
      const res = await handleLogout(
        new Request('http://web-app:3000/auth/logout', { method: 'POST', headers: { cookie, ...(origin ? { origin } : {}) } }),
        h.deps,
      );
      expect(res.status).toBe(403);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it('same-origin POST deletes the session, clears the cookie and ends the Keycloak session', async () => {
    const { h, cookie } = await loggedIn();
    const idToken = [...h.store.sessions.values()][0]!.idToken;
    const res = await handleLogout(new Request('http://web-app:3000/auth/logout', { method: 'POST', headers: { cookie, origin: PUBLIC } }), h.deps);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(h.deps.cfg.endpoints.endSession);
    expect(loc.searchParams.get('id_token_hint')).toBe(idToken);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/`);
    expect(cookieOf(res, 'bg_session')).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
    expect(await getSession(cookie, h.deps)).toBeNull();
  });
});

describe('browser storage', () => {
  it('never uses localStorage or sessionStorage anywhere in the web app source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const full = path.join(dir, n);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && /localStorage|sessionStorage|document\.cookie|indexedDB/.test(readFileSync(full, 'utf8')))
          offenders.push(full);
      }
    };
    walk(path.join(import.meta.dirname));
    expect(offenders).toEqual([]);
  });
});
