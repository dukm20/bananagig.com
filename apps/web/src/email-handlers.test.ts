// ID-002 web side: the same-origin POST handlers behind /verify-email (handleEmailAction) and the Next route module in front of them. The API is a fake
// client factory with spies: what matters here is WHICH calls are made, with WHAT, in which order, and that a code, a magic token or an address never
// leaves the request body (not into a redirect URL, a log line or a response body).
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AccountEmailSummaryDto, EmailVerificationSentDto, EmailVerifiedDto, SetEmailResultDto } from '@bananagig/contracts';
import { EMAIL_ERROR_CODES } from '@bananagig/contracts';
import { GET as routeGet, POST as routePost } from './app/auth/email/[action]/route';
import * as routeModule from './app/auth/email/[action]/route';
import { ApiError, type AccountCallOptions } from './lib/api-client';
import { EMAIL_ACTIONS, clientIpOf, handleEmailAction, isEmailAction, type EmailAction } from './lib/auth/email-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';

// The route module resolves the process-wide deps through this module: the tests decide what it returns and whether it is touched at all.
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
};
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };

// Distinctive values a person would submit. None of them may be found anywhere but in the request body and in the arguments of the API call.
const CODE_MARKER = '8675309';
const TOKEN_MARKER = `lnk${'Q'.repeat(40)}`;
const EMAIL_MARKER = 'leak.marker+tag@example.test';
const MARKERS = [CODE_MARKER, TOKEN_MARKER, EMAIL_MARKER, 'leak.marker', 'example.test'];
const FIELDS: Record<EmailAction, Record<string, string>> = {
  set: { email: EMAIL_MARKER },
  send: {},
  'confirm-code': { code: CODE_MARKER },
  'confirm-link': { token: TOKEN_MARKER },
};

const SUMMARY: AccountEmailSummaryDto = {
  emailVerificationStatus: 'PENDING',
  primary: null,
  pending: { maskedEmail: 'l***@e***.test', purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null },
};
const SET_RESULT: SetEmailResultDto = { changed: true, email: SUMMARY };
const SENT_RESULT: EmailVerificationSentDto = {
  sentAt: '2026-10-07T12:00:00.000Z',
  expiresAt: '2026-10-07T12:30:00.000Z',
  resendAvailableAt: '2026-10-07T12:00:30.000Z',
  codeLength: 6,
  validityMinutes: 30,
  email: SUMMARY,
};
const VERIFIED_RESULT: EmailVerifiedDto = { changed: true, email: { emailVerificationStatus: 'VERIFIED', primary: null, pending: null } };

interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  /** Every call to a spy, in order: 'set', 'send', 'confirm-code', 'confirm-link'. */
  order: string[];
  /** The access token each `deps.api(token)` was created with. */
  apiTokens: string[];
  logs: string[];
  fns: {
    setActiveRole: Mock<() => Promise<never>>;
    setAccountEmail: Mock<(email: string, o?: AccountCallOptions) => Promise<SetEmailResultDto>>;
    sendEmailVerification: Mock<(o?: AccountCallOptions) => Promise<EmailVerificationSentDto>>;
    confirmEmailCode: Mock<(code: string, o?: AccountCallOptions) => Promise<EmailVerifiedDto>>;
    confirmEmailLink: Mock<(token: string, o?: AccountCallOptions) => Promise<EmailVerifiedDto>>;
  };
  clock: { now: number };
}
function harness(over: Partial<AuthDeps> = {}): Harness {
  const store = new MemorySessionStore();
  const order: string[] = [];
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const clock = { now: Math.floor(Date.now() / 1000) };
  const fns: Harness['fns'] = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the email actions');
    }),
    setAccountEmail: vi.fn(async () => {
      order.push('set');
      return SET_RESULT;
    }),
    sendEmailVerification: vi.fn(async () => {
      order.push('send');
      return SENT_RESULT;
    }),
    confirmEmailCode: vi.fn(async () => {
      order.push('confirm-code');
      return VERIFIED_RESULT;
    }),
    confirmEmailLink: vi.fn(async () => {
      order.push('confirm-link');
      return VERIFIED_RESULT;
    }),
  };
  const deps: AuthDeps = {
    cfg,
    store,
    verifier: {} as never, // only a token refresh uses it
    now: () => clock.now,
    api: (accessToken) => {
      apiTokens.push(accessToken);
      return fns as unknown as ReturnType<NonNullable<AuthDeps['api']>>;
    },
    log: (level, message, attrs) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    ...over,
  };
  return { deps, store, order, apiTokens, logs, fns, clock };
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
const noEmailCalls = (h: Harness): void => {
  expect(h.order).toEqual([]);
  for (const fn of [h.fns.setActiveRole, h.fns.setAccountEmail, h.fns.sendEmailVerification, h.fns.confirmEmailCode, h.fns.confirmEmailLink])
    expect(fn).not.toHaveBeenCalled();
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
const post = (action: string, fields: Record<string, string> | undefined, o: PostOptions = {}): Request => {
  const method = o.method ?? 'POST';
  return new Request(`http://web-app:3000/auth/email/${action}`, {
    method,
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? PUBLIC }),
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? 'bg_session=sid-1' }),
      ...o.headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: o.body !== undefined ? o.body : fields ? new URLSearchParams(fields) : undefined }),
  });
};
/** Everything a browser (or a log reader) can see of a response: the redirect target, every header and the body. */
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectNoMarkers = (text: string, what: string): void => {
  for (const marker of MARKERS) expect(text, `${what} must not contain ${marker}`).not.toContain(marker);
};
const expectRedirect = (res: Response, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}/verify-email${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
  expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'location']);
};

describe('EMAIL_ACTIONS and isEmailAction', () => {
  it('names exactly the four actions, in the order the page uses them', () => {
    expect([...EMAIL_ACTIONS]).toEqual(['set', 'send', 'confirm-code', 'confirm-link']);
  });
  it('accepts each action and nothing else (case-sensitive, no prototype names, no look-alikes)', () => {
    for (const action of EMAIL_ACTIONS) expect(isEmailAction(action), action).toBe(true);
    for (const other of [
      '',
      ' ',
      'SET',
      'Set',
      'confirm',
      'confirm_code',
      'confirm-code ',
      ' set',
      'set/',
      'verify',
      'constructor',
      '__proto__',
      'toString',
      'length',
      '0',
    ])
      expect(isEmailAction(other), JSON.stringify(other)).toBe(false);
  });
});

describe('clientIpOf', () => {
  const ip = (value: string | null): string | undefined =>
    clientIpOf(new Request('http://web-app:3000/', value === null ? {} : { headers: { 'x-forwarded-for': value } }));
  it('is the first entry of the list, trimmed', () => {
    expect(ip('203.0.113.7')).toBe('203.0.113.7');
    expect(ip('203.0.113.7, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.7');
    expect(ip('  203.0.113.7  ,10.0.0.1')).toBe('203.0.113.7');
    expect(ip('203.0.113.7,10.0.0.1')).toBe('203.0.113.7');
  });
  it('keeps IPv6 addresses whole (colons are not separators)', () => {
    expect(ip('2001:db8::1')).toBe('2001:db8::1');
    expect(ip('2001:db8:85a3::8a2e:370:7334, 10.0.0.1')).toBe('2001:db8:85a3::8a2e:370:7334');
    expect(ip('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
  });
  it('is undefined without the header and for an empty or blank first entry (a later entry is never promoted)', () => {
    expect(ip(null)).toBeUndefined();
    expect(ip('')).toBeUndefined();
    expect(ip('   ')).toBeUndefined();
    expect(ip(',10.0.0.1')).toBeUndefined();
    expect(ip(' , 10.0.0.1')).toBeUndefined();
  });
  it('ignores an entry of more than 64 characters (and does not fall back to a later one)', () => {
    expect(ip('a'.repeat(64))).toBe('a'.repeat(64));
    expect(ip('a'.repeat(65))).toBeUndefined();
    expect(ip(`${'a'.repeat(65)}, 203.0.113.7`)).toBeUndefined();
    expect(ip(`  ${'a'.repeat(64)}  , 203.0.113.7`)).toBe('a'.repeat(64)); // the limit applies to the trimmed entry
  });
});

describe('POST /auth/email/<action> (handleEmailAction): refusals before any API call', () => {
  it('is POST only: every other method is 405 with Allow: POST, whatever the Origin and session, and nothing is called', async () => {
    const h = harness();
    seed(h);
    for (const action of EMAIL_ACTIONS)
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        for (const origin of [PUBLIC, null, 'http://evil.example']) {
          const res = await handleEmailAction(post(action, undefined, { method, origin }), h.deps, action);
          expect(res.status, `${method} ${action} ${String(origin)}`).toBe(405);
          expect(res.headers.get('allow')).toBe('POST');
          expect(res.headers.get('cache-control')).toBe('no-store');
          expect(res.headers.get('location')).toBeNull();
        }
      }
    expect(h.apiTokens).toEqual([]);
    noEmailCalls(h);
  });

  it('is same-origin only: a missing, foreign or look-alike Origin is 403 and NO API client is even created', async () => {
    const h = harness();
    seed(h);
    for (const action of EMAIL_ACTIONS)
      for (const origin of [
        null,
        'http://evil.example',
        'http://app.localhost:9999',
        'https://app.localhost:8080',
        'null',
        `${PUBLIC}.evil.example`,
        `${PUBLIC}/`,
        PUBLIC.toUpperCase(),
      ]) {
        const res = await handleEmailAction(post(action, FIELDS[action], { origin }), h.deps, action);
        expect(res.status, `${action} ${String(origin)}`).toBe(403);
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('cache-control')).toBe('no-store');
        expectNoMarkers(await seen(res), '403 response');
      }
    expect(h.apiTokens).toEqual([]);
    noEmailCalls(h);
  });

  it('needs a session: no cookie, an unknown or empty session id or another cookie redirect to the plain page and call nothing', async () => {
    const h = harness();
    for (const action of EMAIL_ACTIONS)
      for (const cookie of [null, 'bg_session=unknown', 'other=sid-1', 'bg_session=', 'bg_session=sid-2']) {
        const res = await handleEmailAction(post(action, FIELDS[action], { cookie }), h.deps, action);
        expectRedirect(res, '');
        expectNoMarkers(await seen(res), 'signed-out redirect');
      }
    expect(h.apiTokens).toEqual([]);
    noEmailCalls(h);
    expect(h.logs).toEqual([]);
  });

  it('treats a session whose access token is expired and cannot be refreshed as signed out (the session is dropped, nothing is called)', async () => {
    const refreshAttempts: string[] = [];
    const h = harness({
      fetch: (async (url: string | URL | Request) => {
        refreshAttempts.push(String(url));
        return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    seed(h, { accessExpiresAt: h.clock.now - 10 });
    const res = await handleEmailAction(post('confirm-code', FIELDS['confirm-code']), h.deps, 'confirm-code');
    expectRedirect(res, '');
    expect(refreshAttempts).toEqual([cfg.endpoints.token]);
    expect(h.store.sessions.size).toBe(0);
    expect(h.apiTokens).toEqual([]);
    noEmailCalls(h);
  });

  it('rejects a body without the action field with 400 before calling the API (wrong field name, JSON, empty, no body, a file)', async () => {
    const h = harness();
    seed(h);
    const file = new FormData();
    file.set('code', new File([CODE_MARKER], 'code.txt'));
    const cases: [EmailAction, string, Request][] = [
      ['set', 'no email field', post('set', {})],
      ['set', 'wrong field name', post('set', { mail: EMAIL_MARKER, code: CODE_MARKER })],
      ['set', 'json body', post('set', undefined, { body: JSON.stringify({ email: EMAIL_MARKER }), headers: { 'content-type': 'application/json' } })],
      ['set', 'no body', post('set', undefined, { body: null })],
      ['confirm-code', 'no code field', post('confirm-code', {})],
      ['confirm-code', 'the token field instead', post('confirm-code', { token: TOKEN_MARKER })],
      ['confirm-code', 'a file instead of text', post('confirm-code', undefined, { body: file })],
      [
        'confirm-code',
        'json body',
        post('confirm-code', undefined, { body: JSON.stringify({ code: CODE_MARKER }), headers: { 'content-type': 'application/json' } }),
      ],
      ['confirm-code', 'no body', post('confirm-code', undefined, { body: null })],
      ['confirm-link', 'no token field', post('confirm-link', {})],
      ['confirm-link', 'the code field instead', post('confirm-link', { code: CODE_MARKER })],
      [
        'confirm-link',
        'garbage body with a form content type',
        post('confirm-link', undefined, { body: String.fromCodePoint(0, 1), headers: { 'content-type': 'multipart/form-data; boundary=x' } }),
      ],
    ];
    for (const [action, what, req] of cases) {
      const res = await handleEmailAction(req, h.deps, action);
      expect(res.status, `${action}: ${what}`).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('location')).toBeNull();
      expectNoMarkers(await seen(res), `${action}: ${what}`);
    }
    noEmailCalls(h);
    expect(h.logs).toEqual([]);
  });

  it('refuses to run without an API client factory, or with a client that lacks the email calls (a wiring mistake must be loud)', async () => {
    const without = harness({ api: undefined });
    seed(without);
    await expect(handleEmailAction(post('send', {}), without.deps, 'send')).rejects.toThrow(/AuthDeps\.api/);
    // the cheap refusals still come first
    expect((await handleEmailAction(post('send', {}, { method: 'GET' }), without.deps, 'send')).status).toBe(405);
    expect((await handleEmailAction(post('send', {}, { origin: 'http://evil.example' }), without.deps, 'send')).status).toBe(403);

    const lacking = harness({
      api: () => ({
        setActiveRole: async () => {
          throw new Error('unused');
        },
      }),
    });
    seed(lacking);
    await expect(handleEmailAction(post('send', {}), lacking.deps, 'send')).rejects.toThrow(/lacks the email verification calls/);
  });
});

describe('POST /auth/email/<action> (handleEmailAction): the actions', () => {
  it('set: stores the address and THEN sends the verification email, with the same options, and redirects to ?ok=sent', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const res = await handleEmailAction(post('set', { email: EMAIL_MARKER }, { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }), h.deps, 'set');
    expectRedirect(res, '?ok=sent');
    expect(h.order).toEqual(['set', 'send']);
    const opts = { activeRole: 'PROVIDER', clientIp: '203.0.113.7' };
    expect(h.fns.setAccountEmail).toHaveBeenCalledTimes(1);
    expect(h.fns.setAccountEmail).toHaveBeenCalledWith(EMAIL_MARKER, opts);
    expect(h.fns.sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(h.fns.sendEmailVerification).toHaveBeenCalledWith(opts);
    expect(h.fns.confirmEmailCode).not.toHaveBeenCalled();
    expect(h.fns.confirmEmailLink).not.toHaveBeenCalled();
    expectNoMarkers(await seen(res), 'redirect');
    expect(h.logs).toEqual([]);
  });

  it('set: forwards the address exactly as typed (trimming, case and validity are the API contract, not the web handler)', async () => {
    const h = harness();
    seed(h);
    for (const typed of ['  Mixed.Case@Example.TEST  ', 'not an address', '', 'a'.repeat(300)]) {
      h.fns.setAccountEmail.mockClear();
      const res = await handleEmailAction(post('set', { email: typed }), h.deps, 'set');
      expectRedirect(res, '?ok=sent');
      expect(h.fns.setAccountEmail.mock.calls[0]![0]).toBe(typed);
    }
  });

  it('set: when the API refuses the address no verification email is requested, and the error is the code only', async () => {
    const h = harness();
    seed(h);
    h.fns.setAccountEmail.mockRejectedValueOnce(new ApiError(400, 'ACCOUNT_EMAIL_INVALID', 'VALIDATION', 'invalid', 'corr-1', { reason: 'INVALID_FORMAT' }));
    const res = await handleEmailAction(post('set', { email: EMAIL_MARKER }), h.deps, 'set');
    expectRedirect(res, '?error=ACCOUNT_EMAIL_INVALID');
    expect(h.order).toEqual([]);
    expect(h.fns.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('set: when the address was stored but the send is refused (cooldown, caps, delivery) the error names that failure', async () => {
    for (const code of ['ACCOUNT_EMAIL_RESEND_TOO_SOON', 'ACCOUNT_EMAIL_SEND_LIMIT', 'ACCOUNT_EMAIL_DELIVERY_FAILED', 'ACCOUNT_EMAIL_RATE_LIMITED']) {
      const h = harness();
      seed(h);
      h.fns.sendEmailVerification.mockRejectedValueOnce(new ApiError(429, code, 'RATE_LIMIT', 'refused', 'corr-2', { retryAfterSeconds: 30 }));
      const res = await handleEmailAction(post('set', { email: EMAIL_MARKER }), h.deps, 'set');
      expectRedirect(res, `?error=${code}`);
      expect(h.order, code).toEqual(['set']);
    }
  });

  it('send: asks for a (new) verification email and redirects to ?ok=sent; no form field is needed', async () => {
    const h = harness();
    seed(h);
    const res = await handleEmailAction(post('send', undefined, { body: null }), h.deps, 'send');
    expectRedirect(res, '?ok=sent');
    expect(h.order).toEqual(['send']);
    expect(h.fns.sendEmailVerification).toHaveBeenCalledWith({ activeRole: undefined, clientIp: undefined });
    expect(h.fns.setAccountEmail).not.toHaveBeenCalled();
    // an unrelated field in the body is ignored, not forwarded
    const noisy = await handleEmailAction(post('send', { email: EMAIL_MARKER, code: CODE_MARKER }), h.deps, 'send');
    expectRedirect(noisy, '?ok=sent');
    expect(h.order).toEqual(['send', 'send']);
    expect(JSON.stringify(h.fns.sendEmailVerification.mock.calls)).not.toMatch(/leak|8675309/);
  });

  it('confirm-code: passes the typed code to the API and redirects to ?ok=verified', async () => {
    const h = harness();
    seed(h, { activeRole: 'CUSTOMER' });
    const res = await handleEmailAction(post('confirm-code', { code: CODE_MARKER }, { headers: { 'x-forwarded-for': '2001:db8::1' } }), h.deps, 'confirm-code');
    expectRedirect(res, '?ok=verified');
    expect(h.order).toEqual(['confirm-code']);
    expect(h.fns.confirmEmailCode).toHaveBeenCalledWith(CODE_MARKER, { activeRole: 'CUSTOMER', clientIp: '2001:db8::1' });
    expectNoMarkers(await seen(res), 'redirect');
  });

  it('confirm-code: forwards the code as typed (the API decides what a valid code looks like) and treats an idempotent repeat as success', async () => {
    const h = harness();
    seed(h);
    h.fns.confirmEmailCode.mockResolvedValue({ ...VERIFIED_RESULT, changed: false });
    for (const typed of [' 12 34 ', 'abc', '']) {
      h.fns.confirmEmailCode.mockClear();
      expectRedirect(await handleEmailAction(post('confirm-code', { code: typed }), h.deps, 'confirm-code'), '?ok=verified');
      expect(h.fns.confirmEmailCode.mock.calls[0]![0]).toBe(typed);
    }
  });

  it('confirm-link: passes the token from the form body to the API and redirects to ?ok=verified', async () => {
    const h = harness();
    seed(h);
    const res = await handleEmailAction(post('confirm-link', { token: TOKEN_MARKER }), h.deps, 'confirm-link');
    expectRedirect(res, '?ok=verified');
    expect(h.order).toEqual(['confirm-link']);
    expect(h.fns.confirmEmailLink).toHaveBeenCalledWith(TOKEN_MARKER, { activeRole: undefined, clientIp: undefined });
    expectNoMarkers(await seen(res), 'redirect');
    expect(h.logs).toEqual([]);
  });

  it('every action calls only its own API method, once', async () => {
    const expected: Record<EmailAction, string[]> = {
      set: ['set', 'send'],
      send: ['send'],
      'confirm-code': ['confirm-code'],
      'confirm-link': ['confirm-link'],
    };
    for (const action of EMAIL_ACTIONS) {
      const h = harness();
      seed(h);
      expect((await handleEmailAction(post(action, FIELDS[action]), h.deps, action)).status).toBe(303);
      expect(h.order, action).toEqual(expected[action]);
      expect(h.fns.setActiveRole).not.toHaveBeenCalled();
    }
  });

  it('uses the access token of the session for the API client, and no other token', async () => {
    for (const action of EMAIL_ACTIONS) {
      const h = harness();
      seed(h);
      await handleEmailAction(post(action, FIELDS[action]), h.deps, action);
      expect(h.apiTokens, action).toEqual([TOKENS.access]);
    }
    // two sessions: each request uses its own session's token
    const h = harness();
    seed(h, { accessToken: 'tok-access-A' }, 'sid-a');
    seed(h, { accessToken: 'tok-access-B' }, 'sid-b');
    await handleEmailAction(post('send', {}, { cookie: 'bg_session=sid-a' }), h.deps, 'send');
    await handleEmailAction(post('send', {}, { cookie: 'bg_session=sid-b' }), h.deps, 'send');
    expect(h.apiTokens).toEqual(['tok-access-A', 'tok-access-B']);
    // the refresh and id tokens are never handed to the client factory or to a call
    expect(JSON.stringify([h.fns.sendEmailVerification.mock.calls, h.apiTokens])).not.toMatch(/refresh|tok-id/);
  });

  it('carries the session active role and the first x-forwarded-for entry in the options of every call', async () => {
    const forwarded: [string | null, string | undefined][] = [
      ['203.0.113.7', '203.0.113.7'],
      [' 203.0.113.7 , 10.0.0.1 ', '203.0.113.7'],
      ['2001:db8::7, 192.0.2.1', '2001:db8::7'],
      [null, undefined],
      ['', undefined],
      [`${'z'.repeat(65)}, 203.0.113.7`, undefined],
    ];
    for (const action of EMAIL_ACTIONS)
      for (const activeRole of ['PROVIDER', undefined])
        for (const [header, clientIp] of forwarded) {
          const h = harness();
          seed(h, activeRole ? { activeRole } : {});
          const res = await handleEmailAction(post(action, FIELDS[action], header === null ? {} : { headers: { 'x-forwarded-for': header } }), h.deps, action);
          expect(res.status).toBe(303);
          const all: unknown[][] = [h.fns.setAccountEmail, h.fns.sendEmailVerification, h.fns.confirmEmailCode, h.fns.confirmEmailLink].flatMap(
            (fn): unknown[][] => fn.mock.calls,
          );
          expect(all.length).toBeGreaterThan(0);
          for (const call of all) expect(call.at(-1), `${action} ${String(header)}`).toEqual({ activeRole, clientIp });
        }
  });

  it('builds the redirect from the configured public URL, not from the request Host or forwarded headers', async () => {
    const h = harness();
    seed(h);
    const res = await handleEmailAction(
      post('send', {}, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-original-url': 'http://evil.example/' } }),
      h.deps,
      'send',
    );
    expectRedirect(res, '?ok=sent');
    expect(String(res.headers.get('location'))).not.toContain('evil');
  });

  it('answers every handled request with Cache-Control: no-store and sets no cookie', async () => {
    for (const action of EMAIL_ACTIONS) {
      const h = harness();
      seed(h);
      const outcomes: Response[] = [
        await handleEmailAction(post(action, FIELDS[action]), h.deps, action), // success
        await handleEmailAction(post(action, FIELDS[action], { cookie: null }), h.deps, action), // signed out
        await handleEmailAction(post(action, FIELDS[action], { origin: null }), h.deps, action), // 403
        await handleEmailAction(post(action, undefined, { method: 'GET' }), h.deps, action), // 405
      ];
      if (action !== 'send') outcomes.push(await handleEmailAction(post(action, {}), h.deps, action)); // 400
      for (const res of outcomes) {
        expect(res.headers.get('cache-control'), `${action} ${res.status}`).toBe('no-store');
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
  });
});

describe('POST /auth/email/<action> (handleEmailAction): failures redirect with a code, never a value', () => {
  // status, code, category: what the API answers for each email error (and a few that every authenticated call can see)
  const failures: [number, string, string][] = [
    [400, 'ACCOUNT_EMAIL_INVALID', 'VALIDATION'],
    [409, 'ACCOUNT_EMAIL_NOT_PENDING', 'CONFLICT'],
    [400, 'ACCOUNT_EMAIL_CODE_INVALID', 'VALIDATION'],
    [400, 'ACCOUNT_EMAIL_LINK_INVALID', 'VALIDATION'],
    [400, 'ACCOUNT_EMAIL_CODE_EXPIRED', 'VALIDATION'],
    [400, 'ACCOUNT_EMAIL_CODE_USED', 'VALIDATION'],
    [429, 'ACCOUNT_EMAIL_VERIFICATION_LOCKED', 'RATE_LIMIT'],
    [429, 'ACCOUNT_EMAIL_RESEND_TOO_SOON', 'RATE_LIMIT'],
    [429, 'ACCOUNT_EMAIL_SEND_LIMIT', 'RATE_LIMIT'],
    [409, 'ACCOUNT_EMAIL_UNAVAILABLE', 'CONFLICT'],
    [503, 'ACCOUNT_EMAIL_DELIVERY_FAILED', 'DEPENDENCY'],
    [429, 'ACCOUNT_EMAIL_RATE_LIMITED', 'RATE_LIMIT'],
    [401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION'],
    [403, 'ACCOUNT_SUSPENDED', 'AUTHORIZATION'],
    [403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION'],
    [0, 'API_UNREACHABLE', 'DEPENDENCY'],
    [502, 'UNEXPECTED_RESPONSE', 'INTERNAL'],
  ];

  it('the table below covers every email error code of the contract', () => {
    expect(
      failures
        .map(([, code]) => code)
        .filter((c) => c.startsWith('ACCOUNT_EMAIL_'))
        .sort(),
    ).toEqual(EMAIL_ERROR_CODES.map((c) => `ACCOUNT_${c}`).sort());
  });

  it('an ApiError becomes 303 ?error=<its code> for every action, and the submitted code, token and address are in no redirect, header, body or log', async () => {
    for (const action of EMAIL_ACTIONS)
      for (const [status, code, category] of failures) {
        const h = harness();
        seed(h);
        // the error itself echoes everything the person submitted (its message, details and correlation id): none of it may reach the browser or the logs
        const echo = new ApiError(status, code, category, `rejected ${CODE_MARKER} ${TOKEN_MARKER} ${EMAIL_MARKER}`, `corr-${CODE_MARKER}`, {
          echoed: [CODE_MARKER, TOKEN_MARKER, EMAIL_MARKER],
          attemptsRemaining: 2,
          retryAfterSeconds: 30,
        });
        for (const fn of [h.fns.setAccountEmail, h.fns.sendEmailVerification, h.fns.confirmEmailCode, h.fns.confirmEmailLink]) fn.mockRejectedValue(echo);
        const res = await handleEmailAction(post(action, FIELDS[action]), h.deps, action);
        expectRedirect(res, `?error=${encodeURIComponent(code)}`);
        expectNoMarkers(await seen(res), `${action} ${code}: response`);
        // one warning with the action, the code and the status: nothing else
        expect(h.logs, `${action} ${code}`).toHaveLength(1);
        const log = JSON.parse(h.logs[0]!) as Record<string, unknown>;
        expect(log).toEqual({ level: 'warn', message: 'email verification action refused', action, code, status });
        expectNoMarkers(h.logs.join('\n'), `${action} ${code}: logs`);
        // the failed call received the submitted value (proof the markers were real submissions), nothing else did
        const submitted = FIELDS[action];
        const arg = Object.values(submitted)[0];
        if (arg !== undefined)
          expect(JSON.stringify([h.fns.setAccountEmail.mock.calls, h.fns.confirmEmailCode.mock.calls, h.fns.confirmEmailLink.mock.calls])).toContain(arg);
      }
  });

  it('URL-encodes the code (a code with reserved characters cannot inject query parameters)', async () => {
    const h = harness();
    seed(h);
    h.fns.sendEmailVerification.mockRejectedValueOnce(new ApiError(400, 'A B&ok=verified#x', 'VALIDATION', 'odd', 'corr-3'));
    const res = await handleEmailAction(post('send', {}), h.deps, 'send');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/verify-email?error=A%20B%26ok%3Dverified%23x`);
    expect(new URL(String(res.headers.get('location'))).searchParams.get('ok')).toBeNull();
  });

  it('a failure that is not an ApiError is ?error=API_ERROR (its message, which may hold anything, is neither redirected nor logged)', async () => {
    const thrown: unknown[] = [
      new Error(`boom ${CODE_MARKER} ${TOKEN_MARKER} ${EMAIL_MARKER}`),
      new TypeError(`fetch failed for ${EMAIL_MARKER}`),
      `plain string with ${CODE_MARKER}`,
      { code: 'ACCOUNT_EMAIL_CODE_INVALID', message: `${TOKEN_MARKER}` }, // looks like an ApiError but is not one
      undefined,
    ];
    for (const action of EMAIL_ACTIONS)
      for (const failure of thrown) {
        const h = harness();
        seed(h);
        for (const fn of [h.fns.setAccountEmail, h.fns.sendEmailVerification, h.fns.confirmEmailCode, h.fns.confirmEmailLink])
          fn.mockImplementation(async () => Promise.reject(failure));
        const res = await handleEmailAction(post(action, FIELDS[action]), h.deps, action);
        expectRedirect(res, '?error=API_ERROR');
        expectNoMarkers(await seen(res), `${action}: response`);
        expect(h.logs).toHaveLength(1);
        expect(JSON.parse(h.logs[0]!)).toEqual({ level: 'warn', message: 'email verification action refused', action, code: 'API_ERROR' });
        expectNoMarkers(h.logs.join('\n'), `${action}: logs`);
      }
  });

  it('works without a logger and still never throws for an API failure', async () => {
    const h = harness({ log: undefined });
    seed(h);
    h.fns.confirmEmailCode.mockRejectedValueOnce(new ApiError(400, 'ACCOUNT_EMAIL_CODE_INVALID', 'VALIDATION', 'wrong', 'corr-4', { attemptsRemaining: 2 }));
    expectRedirect(await handleEmailAction(post('confirm-code', { code: CODE_MARKER }), h.deps, 'confirm-code'), '?error=ACCOUNT_EMAIL_CODE_INVALID');
  });

  it('leaves the session untouched on a failure (the person stays signed in and may try again)', async () => {
    const h = harness();
    const before = seed(h);
    h.fns.confirmEmailCode.mockRejectedValueOnce(new ApiError(400, 'ACCOUNT_EMAIL_CODE_INVALID', 'VALIDATION', 'wrong'));
    await handleEmailAction(post('confirm-code', { code: CODE_MARKER }), h.deps, 'confirm-code');
    expect(h.store.sessions.get('sid-1')).toEqual(before);
    expectRedirect(await handleEmailAction(post('confirm-code', { code: CODE_MARKER }), h.deps, 'confirm-code'), '?ok=verified');
  });
});

describe('/auth/email/[action] route module', () => {
  const ctx = (action: string) => ({ params: Promise.resolve({ action }) });

  it('exports exactly POST, GET and a force-dynamic marker', () => {
    expect(Object.keys(routeModule).sort()).toEqual(['GET', 'POST', 'dynamic']);
    expect(routeModule.dynamic).toBe('force-dynamic');
  });

  it('an unknown action is 404 and the process-wide deps are never touched', async () => {
    routeState.deps = undefined;
    routeState.calls = 0;
    for (const action of ['unknown', '', 'SET', 'confirm', 'confirm_code', 'constructor', '__proto__', 'toString', 'set/..', 'set%2F', ' set']) {
      const res = await routePost(post(action || 'x', FIELDS.set), ctx(action));
      expect(res.status, JSON.stringify(action)).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('location')).toBeNull();
      expectNoMarkers(await seen(res), '404 response');
    }
    expect(routeState.calls).toBe(0);
  });

  it('GET is 405 with Allow: POST and never reaches the deps', async () => {
    routeState.calls = 0;
    const res = routeGet();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(routeState.calls).toBe(0);
  });

  it('a known action is handled with the process-wide deps (success, signed out, and a foreign Origin)', async () => {
    for (const action of EMAIL_ACTIONS) {
      const h = harness();
      seed(h);
      routeState.deps = h.deps;
      routeState.calls = 0;
      expectRedirect(
        await routePost(post(action, FIELDS[action]), ctx(action)),
        action === 'confirm-code' || action === 'confirm-link' ? '?ok=verified' : '?ok=sent',
      );
      expect(routeState.calls).toBe(1);
      expect(h.apiTokens).toEqual([TOKENS.access]);
      expect(h.order).toEqual(action === 'set' ? ['set', 'send'] : [action]);
      expectRedirect(await routePost(post(action, FIELDS[action], { cookie: null }), ctx(action)), '');
      expect((await routePost(post(action, FIELDS[action], { origin: 'http://evil.example' }), ctx(action))).status).toBe(403);
      expect((await routePost(post(action, undefined, { method: 'PUT' }), ctx(action))).status).toBe(405);
      expect(h.apiTokens).toEqual([TOKENS.access]); // the refused requests created no client
    }
  });
});
