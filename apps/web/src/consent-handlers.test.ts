// ID-005 web side, part 1: the BFF half of consent. The POST handlers behind /consents (accept, withdraw) and the Next route module in front of them. The API is a fake
// client factory with spies: what matters is WHICH calls are made, with WHAT, that nothing but a well-formed form reaches the API (the server decides whether the
// version is in force), that a result is a fixed 303 target, and that no submitted value, token or hash is ever put in a redirect, a cookie or a log line.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { CONSENT_ERROR_CODES } from '@bananagig/contracts';
import { GET as consentsGet, POST as consentsPost } from './app/auth/consents/[action]/route';
import { ApiError } from './lib/api-client';
import {
  CONSENT_ACTIONS,
  CONSENT_API_ERROR_CODES,
  CONSENT_GENERIC_ERROR,
  CONSENT_NOTICES,
  handleConsentAction,
  isConsentAction,
  type ConsentAction,
} from './lib/auth/consent-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { TOS_HASH, TOS_VERSION_ID } from './testing/account-stub';

const routeState = vi.hoisted(() => ({ deps: undefined as unknown, calls: 0 }));
vi.mock('./lib/auth/runtime', () => ({
  authDeps: () => {
    routeState.calls++;
    return routeState.deps;
  },
}));

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
  deviceCookie: 'bg_device',
  revokedRedirectUri: `${PUBLIC}/session?error=session_revoked`,
};
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
const SESSION_COOKIE = 'bg_session=sid-1';
const apiError = (status: number, code: string, details?: Record<string, unknown>): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1', details);
const OK_EVENT = {
  consentEventId: 'b2d94f10-7e3a-4a68-9c15-3d8e6f0a7b24',
  purposeCode: 'TERMS_OF_SERVICE',
  eventType: 'ACCEPTED',
  eventSeq: 1,
  document: { versionId: TOS_VERSION_ID, version: 3, locale: 'en-US', bodySha256: TOS_HASH },
  occurredAt: '2026-10-16T09:30:00.000Z',
  source: 'ACCOUNT_API',
};

interface Fns {
  setActiveRole: Mock<() => Promise<never>>;
  acceptConsent: Mock<(purpose: string, input: unknown, o?: unknown) => Promise<{ changed: boolean; event: unknown }>>;
  withdrawConsent: Mock<(purpose: string, o?: unknown) => Promise<{ changed: boolean; event: unknown }>>;
  getAccount: Mock<(o?: unknown) => Promise<unknown>>;
}
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
}
function harness(withApi = true): Harness {
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const fns: Fns = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the consent actions');
    }),
    acceptConsent: vi.fn(async () => ({ changed: true, event: OK_EVENT })),
    withdrawConsent: vi.fn(async () => ({ changed: true, event: { ...OK_EVENT, eventType: 'WITHDRAWN', eventSeq: 2 } })),
    getAccount: vi.fn(async () => ({})),
  };
  const deps = {
    cfg,
    store,
    verifier: {},
    now: () => Math.floor(Date.now() / 1000),
    log: (level: string, message: string, attrs?: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    ...(withApi
      ? {
          api: (accessToken: string) => {
            apiTokens.push(accessToken);
            return fns as unknown as ReturnType<NonNullable<AuthDeps['api']>>;
          },
        }
      : {}),
  } as unknown as AuthDeps;
  return { deps, store, fns, apiTokens, logs };
}
const seed = (h: Harness, over: Partial<SessionRecord> = {}): SessionRecord => {
  const record: SessionRecord = {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    idToken: TOKENS.id,
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    ...over,
  };
  h.store.sessions.set('sid-1', record);
  return record;
};
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
const ACCEPT_FIELDS = { purpose: 'TERMS_OF_SERVICE', versionId: TOS_VERSION_ID, locale: 'en-US', bodySha256: TOS_HASH };
const FIELDS: Record<ConsentAction, Record<string, string>> = { accept: ACCEPT_FIELDS, withdraw: { purpose: 'PRIVACY_POLICY' } };
const action = (h: Harness, name: ConsentAction, fields: Record<string, string> = FIELDS[name], o: Parameters<typeof post>[2] = {}) =>
  handleConsentAction(post(`/auth/consents/${name}`, fields, o), h.deps, name);
const noConsentCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectBack = (res: Response, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}/consents${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};

describe('CONSENT_ACTIONS and isConsentAction', () => {
  it('names exactly the two actions', () => {
    expect([...CONSENT_ACTIONS]).toEqual(['accept', 'withdraw']);
    expect([...CONSENT_NOTICES]).toEqual(['accepted', 'withdrawn', 'already_accepted']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of CONSENT_ACTIONS) expect(isConsentAction(a)).toBe(true);
    for (const other of ['', 'ACCEPT', 'accept ', '/accept', 'accept/x', 'constructor', '__proto__', 'toString', 'revoke', 'reject', 'decline'])
      expect(isConsentAction(other), other).toBe(false);
  });
  it('the error codes a redirect may carry are exactly the API codes of the consent errors', () => {
    expect([...CONSENT_API_ERROR_CODES]).toEqual(CONSENT_ERROR_CODES.map((c) => `ACCOUNT_${c}`));
    expect(CONSENT_GENERIC_ERROR).toBe('API_ERROR');
  });
});

describe('consent actions: transport and authentication', () => {
  it.each(CONSENT_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever accepts)', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleConsentAction(post(`/auth/consents/${name}`, FIELDS[name], { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    noConsentCalls(h);
  });
  it.each(CONSENT_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF) before it reads anything', async (name) => {
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
      const res = await action(h, name, FIELDS[name], { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    noConsentCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(CONSENT_ACTIONS)('%s: a signed-out browser is sent to /session and the API is not called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await action(h, name, FIELDS[name], { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    }
    noConsentCalls(h);
  });
  it('refuses to run without an API client (a wiring error, not a request error)', async () => {
    const h = harness(false);
    seed(h);
    await expect(action(h, 'accept')).rejects.toThrow('AuthDeps.api');
  });
  it('a client without the consent calls is a wiring error too', async () => {
    const h = harness();
    seed(h);
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    await expect(handleConsentAction(post('/auth/consents/accept', ACCEPT_FIELDS), bare, 'accept')).rejects.toThrow('consent calls');
    await expect(handleConsentAction(post('/auth/consents/withdraw', { purpose: 'PRIVACY_POLICY' }), bare, 'withdraw')).rejects.toThrow('consent calls');
  });
});

describe('consent actions: what each one asks of the API', () => {
  it('accept forwards the purpose and EXACTLY the shown version (id, locale, hash) with the session token and role, and comes back with a notice', async () => {
    const h = harness();
    seed(h, { activeRole: 'CUSTOMER' });
    const res = await action(h, 'accept');
    expectBack(res, '?notice=accepted');
    expect(h.fns.acceptConsent).toHaveBeenCalledTimes(1);
    expect(h.fns.acceptConsent).toHaveBeenCalledWith(
      'TERMS_OF_SERVICE',
      { versionId: TOS_VERSION_ID, locale: 'en-US', bodySha256: TOS_HASH },
      { activeRole: 'CUSTOMER' },
    );
    expect(h.apiTokens).toEqual([TOKENS.access]);
    expect(h.fns.withdrawConsent).not.toHaveBeenCalled();
  });
  it('accept: an idempotent repeat (changed: false) says so', async () => {
    const h = harness();
    seed(h);
    h.fns.acceptConsent.mockResolvedValueOnce({ changed: false, event: OK_EVENT });
    expectBack(await action(h, 'accept'), '?notice=already_accepted');
  });
  it('withdraw forwards only the purpose with the session token and role and comes back with a notice (a repeat too)', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'withdraw'), '?notice=withdrawn');
    expect(h.fns.withdrawConsent).toHaveBeenCalledWith('PRIVACY_POLICY', { activeRole: 'PROVIDER' });
    h.fns.withdrawConsent.mockResolvedValueOnce({ changed: false, event: OK_EVENT });
    expectBack(await action(h, 'withdraw'), '?notice=withdrawn');
    expect(h.fns.acceptConsent).not.toHaveBeenCalled();
  });
  it('sends no active role when the session remembers none', async () => {
    const h = harness();
    seed(h);
    await action(h, 'accept');
    expect(h.fns.acceptConsent.mock.calls[0]![2]).toEqual({ activeRole: undefined });
  });
  it('a withdraw is never an accept: a forged field set for the other action is refused', async () => {
    const h = harness();
    seed(h);
    expect((await action(h, 'withdraw', ACCEPT_FIELDS)).status).toBe(400);
    expect((await action(h, 'accept', { purpose: 'PRIVACY_POLICY' })).status).toBe(400);
    noConsentCalls(h);
  });
});

describe('consent actions: unknown and malformed form values change nothing (400)', () => {
  const bad = (over: Record<string, string | undefined>): Record<string, string> =>
    Object.fromEntries(Object.entries({ ...ACCEPT_FIELDS, ...over }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const ACCEPT_CASES: Array<[string, Record<string, string>]> = [
    ['no fields', {}],
    ['no purpose', bad({ purpose: undefined })],
    ['empty purpose', bad({ purpose: '' })],
    ['lower-case purpose', bad({ purpose: 'terms_of_service' })],
    ['purpose with a space', bad({ purpose: 'TERMS OF SERVICE' })],
    ['purpose with a path', bad({ purpose: 'TERMS_OF_SERVICE/../x' })],
    ['purpose with a query', bad({ purpose: 'TERMS_OF_SERVICE?x=1' })],
    ['over-long purpose', bad({ purpose: `A${'B'.repeat(64)}` })],
    ['purpose starting with a digit', bad({ purpose: '1TERMS' })],
    ['no versionId', bad({ versionId: undefined })],
    ['empty versionId', bad({ versionId: '' })],
    ['versionId not a uuid', bad({ versionId: 'not-a-uuid' })],
    ['versionId with trailing space', bad({ versionId: `${TOS_VERSION_ID} ` })],
    ['versionId with a path', bad({ versionId: `${TOS_VERSION_ID}/../x` })],
    ['no locale', bad({ locale: undefined })],
    ['empty locale', bad({ locale: '' })],
    ['one-letter locale', bad({ locale: 'e' })],
    ['over-long locale', bad({ locale: `en-${'x'.repeat(40)}` })],
    ['locale with underscore', bad({ locale: 'en_US' })],
    ['locale with a space', bad({ locale: 'en US' })],
    ['locale with markup', bad({ locale: 'en"><script>' })],
    ['locale with a query', bad({ locale: 'en-US&x=1' })],
    ['no bodySha256', bad({ bodySha256: undefined })],
    ['empty bodySha256', bad({ bodySha256: '' })],
    ['upper-case hash', bad({ bodySha256: TOS_HASH.toUpperCase() })],
    ['short hash', bad({ bodySha256: TOS_HASH.slice(0, 63) })],
    ['long hash', bad({ bodySha256: `${TOS_HASH}0` })],
    ['non-hex hash', bad({ bodySha256: 'z'.repeat(64) })],
    ['hash with trailing newline', bad({ bodySha256: `${TOS_HASH}\n` })],
    ['an extra field (accountId)', bad({ accountId: 'x' })],
    ['an extra field (accepted)', bad({ accepted: 'true' })],
    ['an extra field (at)', bad({ at: '2026-01-01T00:00:00Z' })],
    ['an extra field (consent checkbox)', bad({ agree: 'on' })],
  ];
  it.each(ACCEPT_CASES)('accept: %s', async (_name, fields) => {
    const h = harness();
    seed(h);
    const res = await action(h, 'accept', fields);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('Bad request'); // a fixed body: nothing submitted is echoed
    noConsentCalls(h);
  });
  const WITHDRAW_CASES: Array<[string, Record<string, string>]> = [
    ['no fields', {}],
    ['empty purpose', { purpose: '' }],
    ['lower-case purpose', { purpose: 'privacy_policy' }],
    ['purpose with a path', { purpose: 'PRIVACY_POLICY/accept' }],
    ['an extra field', { purpose: 'PRIVACY_POLICY', versionId: TOS_VERSION_ID }],
    ['an unknown field', { purpose: 'PRIVACY_POLICY', force: '1' }],
  ];
  it.each(WITHDRAW_CASES)('withdraw: %s', async (_name, fields) => {
    const h = harness();
    seed(h);
    expect((await action(h, 'withdraw', fields)).status).toBe(400);
    noConsentCalls(h);
  });
  it.each(CONSENT_ACTIONS)('%s: refuses a repeated field, a file part and a body that is not a form', async (name) => {
    const h = harness();
    seed(h);
    const twice = new URLSearchParams(FIELDS[name]);
    twice.append('purpose', 'PRIVACY_POLICY');
    expect((await action(h, name, {}, { body: twice })).status).toBe(400);
    const multipart = new FormData();
    for (const [k, v] of Object.entries(FIELDS[name])) {
      if (k === 'purpose') multipart.append(k, new Blob([v]), 'x.txt');
      else multipart.append(k, v);
    }
    expect((await action(h, name, {}, { body: multipart })).status).toBe(400);
    expect((await action(h, name, {}, { body: JSON.stringify(FIELDS[name]), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await action(h, name, {}, { body: null })).status).toBe(400);
    noConsentCalls(h);
  });
  it('is checked AFTER the session (a signed-out browser is only sent to /session)', async () => {
    const h = harness();
    const res = await action(h, 'accept', { purpose: 'garbage' }, { cookie: null });
    expect(res.status).toBe(303);
    noConsentCalls(h);
  });
  it("a well-formed but unknown or stale form is the SERVER's decision: it is forwarded unchanged and the refusal comes back as a code", async () => {
    const h = harness();
    seed(h);
    h.fns.acceptConsent.mockRejectedValueOnce(apiError(404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND'));
    const forged = { ...ACCEPT_FIELDS, versionId: '11111111-2222-4333-8444-555555555555', bodySha256: 'f'.repeat(64) };
    expectBack(await action(h, 'accept', forged), '?error=ACCOUNT_CONSENT_VERSION_NOT_FOUND');
    expect(h.fns.acceptConsent).toHaveBeenCalledWith(
      'TERMS_OF_SERVICE',
      { versionId: forged.versionId, locale: 'en-US', bodySha256: forged.bodySha256 },
      expect.anything(),
    );
  });
});

describe('consent actions: what the API can answer', () => {
  const ACTIONS: Array<[ConsentAction, keyof Fns]> = [
    ['accept', 'acceptConsent'],
    ['withdraw', 'withdrawConsent'],
  ];
  it.each(ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name, fn) => {
    const h = harness();
    seed(h);
    h.fns[fn].mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await action(h, name);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it.each(ACTIONS)('%s: every consent code of the API comes back as ?error=<code>, and the session stays', async (name, fn) => {
    const h = harness();
    seed(h);
    for (const code of CONSENT_API_ERROR_CODES) {
      h.fns[fn].mockRejectedValueOnce(apiError(409, code));
      expectBack(await action(h, name), `?error=${code}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(ACTIONS)('%s: no step-up is required (a STEP_UP_REQUIRED is just an error, never a login round trip)', async (name, fn) => {
    const h = harness();
    seed(h);
    h.fns[fn].mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
    expectBack(await action(h, name), '?error=API_ERROR');
    expect(h.store.sessions.size).toBe(1);
  });
  it('a code outside the closed list, an unreachable API or a non-API error is reduced to API_ERROR (never echoed)', async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      apiError(403, 'ACCOUNT_SUSPENDED'),
      apiError(400, 'VALIDATION_FAILED'),
      apiError(409, 'CONSENT_REQUIRED_FOR_ROLE'), // without the ACCOUNT_ prefix it is not the API's code
      apiError(500, 'ACCOUNT_CONSENT_UNKNOWN'),
      apiError(500, 'weird code with spaces'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
      new Error('internal detail'),
    ]) {
      h.fns.acceptConsent.mockRejectedValueOnce(failure);
      const res = await action(h, 'accept');
      expectBack(res, '?error=API_ERROR');
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('no redirect, header, cookie or log line carries a submitted value, a hash, a version id or a token', async () => {
    const h = harness();
    seed(h);
    const results: Response[] = [];
    results.push(await action(h, 'accept'));
    h.fns.acceptConsent.mockRejectedValueOnce(apiError(400, 'ACCOUNT_CONSENT_HASH_MISMATCH', { messageKey: 'account.consent.error.hash_mismatch' }));
    results.push(await action(h, 'accept'));
    h.fns.acceptConsent.mockResolvedValueOnce({ changed: false, event: OK_EVENT });
    results.push(await action(h, 'accept'));
    results.push(await action(h, 'withdraw'));
    h.fns.withdrawConsent.mockRejectedValueOnce(apiError(409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE'));
    results.push(await action(h, 'withdraw'));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of [TOS_VERSION_ID, TOS_HASH, 'TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'en-US', TOKENS.access, TOKENS.refresh, TOKENS.id])
        expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    for (const marker of [TOS_VERSION_ID, TOS_HASH, 'PRIVACY_POLICY', TOKENS.access, TOKENS.refresh, TOKENS.id]) expect(logs).not.toContain(marker);
  });
  it('a refusal is logged with the action, the closed code and the status only', async () => {
    const h = harness();
    seed(h);
    h.fns.acceptConsent.mockRejectedValueOnce(apiError(409, 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT'));
    await action(h, 'accept');
    expect(h.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'warn', message: 'consent action refused', action: 'accept', code: 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', status: 409 },
    ]);
  });
  it('the redirect target is fixed: it never depends on the request host, a header or a field', async () => {
    const h = harness();
    seed(h);
    const req = new Request('http://evil.example/auth/consents/accept?returnTo=http://evil.example&next=//evil.example', {
      method: 'POST',
      headers: { origin: PUBLIC, cookie: SESSION_COOKIE, host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
      body: new URLSearchParams(ACCEPT_FIELDS),
    });
    expectBack(await handleConsentAction(req, h.deps, 'accept'), '?notice=accepted');
  });
});

describe('the Next route module for /auth/consents/<action>', () => {
  it('delegates a known action to the handler with the process-wide deps', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const res = await consentsPost(post('/auth/consents/accept', ACCEPT_FIELDS), { params: Promise.resolve({ action: 'accept' }) });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/consents?notice=accepted`);
    expect(routeState.calls).toBe(1);
    const w = await consentsPost(post('/auth/consents/withdraw', { purpose: 'PRIVACY_POLICY' }), { params: Promise.resolve({ action: 'withdraw' }) });
    expect(w.headers.get('location')).toBe(`${PUBLIC}/consents?notice=withdrawn`);
  });
  it('answers an unknown action with 404 without touching the deps, and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'ACCEPT', 'decline', 'constructor', '__proto__']) {
      const res = await consentsPost(post('/auth/consents/x', {}), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = consentsGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(routeState.calls).toBe(0);
  });
});
