// ACC-001 web side, part 2: the BFF half of the account area. The POST handlers behind /account/profile and /account/language-region and the Next route modules in front of
// them, plus the `next` field of the role switch. The API is a fake client factory with spies: what matters is WHICH call is made, with WHAT body and role, that nothing but a
// well-formed form reaches the API, that a result is a fixed 303 target with a closed word, and that no submitted value, token or header is ever put in a redirect or a log line.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PROFILE_ISSUE_CODES } from '@bananagig/contracts';
import { GET as languageGet, POST as languagePost } from './app/auth/account/language-region/route';
import { GET as profileGet, POST as profilePost } from './app/auth/account/profile/route';
import { ApiError } from './lib/api-client';
import {
  ACCOUNT_FORM_ACTIONS,
  ACCOUNT_FORM_ERRORS,
  ACCOUNT_FORM_MAX_BYTES,
  NAME_ERROR_WORDS,
  handleAccountForm,
  isAccountFormAction,
  type AccountFormAction,
} from './lib/auth/account-handlers';
import { ACTIVE_ROLE_NEXT_ALLOWLIST, handleActiveRole } from './lib/auth/handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';

const routeState = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => routeState.deps }));

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
const PATCHED = { changed: true, profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null, displayName: 'Ana M.' } };

interface Fns {
  setActiveRole: Mock<(role: string) => Promise<{ activeRole: string }>>;
  patchAccountProfile: Mock<(input: unknown, o?: unknown) => Promise<typeof PATCHED>>;
}
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
}
function harness(withPatch = true): Harness {
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const fns: Fns = {
    setActiveRole: vi.fn(async (role: string) => ({ activeRole: role })),
    patchAccountProfile: vi.fn(async () => PATCHED),
  };
  const deps = {
    cfg,
    store,
    verifier: {},
    now: () => Math.floor(Date.now() / 1000),
    log: (level: string, message: string, attrs?: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    api: (accessToken: string) => {
      apiTokens.push(accessToken);
      return (withPatch ? fns : { setActiveRole: fns.setActiveRole }) as unknown as ReturnType<NonNullable<AuthDeps['api']>>;
    },
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
const FIELDS: Record<AccountFormAction, Record<string, string>> = {
  profile: { firstName: 'Ana', lastName: 'Martinez' },
  'language-region': { preferredLocale: 'es-US', timeZone: 'America/New_York' },
};
const submit = (h: Harness, name: AccountFormAction, fields: Record<string, string> = FIELDS[name], o: Parameters<typeof post>[2] = {}) =>
  handleAccountForm(post(`/auth/account/${name}`, fields, o), h.deps, name);
const PAGE: Record<AccountFormAction, string> = { profile: '/account/profile', 'language-region': '/account/language-region' };
const expectBack = (res: Response, name: AccountFormAction, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}${PAGE[name]}${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
  expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'location']);
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const NAMES = ['profile', 'language-region'] as const;

describe('ACCOUNT_FORM_ACTIONS', () => {
  it('names exactly the two forms and the closed list of error words', () => {
    expect([...ACCOUNT_FORM_ACTIONS]).toEqual(['profile', 'language-region']);
    expect([...ACCOUNT_FORM_ERRORS]).toEqual([
      'save',
      'choice',
      'first_name_required',
      'first_name_too_long',
      'first_name_invalid_characters',
      'last_name_required',
      'last_name_too_long',
      'last_name_invalid_characters',
    ]);
    // the field-less words of the first version are gone
    for (const old of ['name_required', 'name_too_long', 'name_invalid_characters']) expect(ACCOUNT_FORM_ERRORS as readonly string[]).not.toContain(old);
    expect(Object.keys(NAME_ERROR_WORDS)).toHaveLength(2 * PROFILE_ISSUE_CODES.length);
    expect(NAME_ERROR_WORDS.last_name_too_long).toEqual({ field: 'lastName', code: 'TOO_LONG' });
    for (const a of ACCOUNT_FORM_ACTIONS) expect(isAccountFormAction(a)).toBe(true);
    for (const other of ['', 'PROFILE', 'profile ', '/profile', 'roles', 'constructor', '__proto__']) expect(isAccountFormAction(other), other).toBe(false);
  });
});

describe('account forms: transport and authentication', () => {
  it.each(NAMES)('%s: refuses every method but POST (405) and calls nothing', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleAccountForm(post(`/auth/account/${name}`, FIELDS[name], { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
    expect(h.apiTokens).toEqual([]);
  });
  it.each(NAMES)('%s: is same-origin only: a missing, foreign or lookalike Origin is 403 and nothing is called', async (name) => {
    const h = harness();
    seed(h);
    for (const origin of [null, 'http://evil.example', 'http://app.localhost:9999', 'https://app.localhost:8080', 'null', `${PUBLIC}.evil.example`]) {
      const res = await submit(h, name, FIELDS[name], { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
  });
  it.each(NAMES)('%s: requires a session: without one the browser is sent back to the page (which sends it to sign in) and nothing is called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown', 'other=sid-1', 'bg_session=']) {
      expectBack(await submit(h, name, FIELDS[name], { cookie }), name, '');
    }
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
    expect(h.apiTokens).toEqual([]);
  });
  it.each(NAMES)('%s: a wiring without the account area calls is a thrown error (500), not an API failure shown to the person', async (name) => {
    const h = harness(false);
    seed(h);
    await expect(submit(h, name)).rejects.toThrow(/lacks the account area calls/);
  });
});

describe('account forms: the body', () => {
  it.each(NAMES)('%s: only application/x-www-form-urlencoded is read: JSON, multipart, plain text and no content type are 400', async (name) => {
    const h = harness();
    seed(h);
    const form = new FormData();
    for (const [k, v] of Object.entries(FIELDS[name])) form.set(k, v);
    const encoded = new URLSearchParams(FIELDS[name]).toString();
    const bodies: Parameters<typeof post>[2][] = [
      { body: JSON.stringify(FIELDS[name]), headers: { 'content-type': 'application/json' } },
      { body: form, headers: {} },
      { body: encoded, headers: { 'content-type': 'text/plain' } },
      { body: encoded, headers: { 'content-type': 'multipart/form-data; boundary=x' } },
    ];
    for (const body of bodies) expect((await submit(h, name, undefined, body)).status).toBe(400);
    // a string body without a content type is text/plain for the platform
    expect((await submit(h, name, undefined, { body: encoded })).status).toBe(400);
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
  });
  it.each(NAMES)(
    '%s: a form carries EXACTLY the fields of its action, each once: an unknown, repeated or missing field is 400 and changes nothing',
    async (name) => {
      const h = harness();
      seed(h);
      const ok = FIELDS[name];
      const first = Object.keys(ok)[0]!;
      const cases: Record<string, string>[] = [
        { ...ok, extra: 'x' },
        { ...ok, role: 'PROVIDER' },
        { ...ok, accountId: '3f8a6c1e-9d2b-4c7a-8e51-0b6d4f2a9c13' },
        { ...ok, __proto__x: 'y' },
        Object.fromEntries(Object.entries(ok).slice(1)),
        {},
      ];
      for (const fields of cases) expect((await submit(h, name, fields)).status, JSON.stringify(fields)).toBe(400);
      // a repeated field
      const repeated = `${new URLSearchParams(ok).toString()}&${first}=again`;
      expect((await submit(h, name, undefined, { body: repeated, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(400);
      expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
    },
  );
  it.each(NAMES)('%s: refuses a body above the limit (declared or actual) and a field above its limit', async (name) => {
    const h = harness();
    seed(h);
    const big = 'x'.repeat(ACCOUNT_FORM_MAX_BYTES + 1);
    const [firstField, secondField] = Object.keys(FIELDS[name]) as [string, string];
    expect((await submit(h, name, { [firstField]: big, [secondField]: 'a' })).status).toBe(400);
    const url = { 'content-type': 'application/x-www-form-urlencoded' };
    expect(
      (
        await submit(h, name, undefined, {
          body: `${firstField}=a&${secondField}=b`,
          headers: { ...url, 'content-length': String(ACCOUNT_FORM_MAX_BYTES + 1) },
        })
      ).status,
    ).toBe(400);
    // many short fields that together exceed the limit
    expect(
      (await submit(h, name, undefined, { body: `${firstField}=a&${secondField}=b&pad=${'z'.repeat(ACCOUNT_FORM_MAX_BYTES)}`, headers: url })).status,
    ).toBe(400);
    // a field just above its own limit (names 500, locale 35, time zone 64)
    const limit = name === 'profile' ? 500 : 35;
    expect((await submit(h, name, { [firstField]: 'a'.repeat(limit + 1), [secondField]: 'b' })).status).toBe(400);
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
  });
});

describe('profile form', () => {
  it('PATCHes exactly {firstName, lastName} with the session token and role, and redirects to ?saved=1', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const res = await submit(h, 'profile', { firstName: 'Ana', lastName: 'Martinez' });
    expectBack(res, 'profile', '?saved=1');
    expect(h.fns.patchAccountProfile).toHaveBeenCalledTimes(1);
    expect(h.fns.patchAccountProfile.mock.calls[0]).toEqual([{ firstName: 'Ana', lastName: 'Martinez' }, { activeRole: 'PROVIDER' }]);
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('sends no role when the session remembers none, and forwards empty names for the API to judge (REQUIRED comes back as a word)', async () => {
    const h = harness();
    seed(h);
    h.fns.patchAccountProfile.mockRejectedValueOnce(
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', {
        reason: 'INVALID_PROFILE',
        issues: [{ field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' }],
      }),
    );
    expectBack(await submit(h, 'profile', { firstName: '', lastName: 'Martinez' }), 'profile', '?error=first_name_required');
    expect(h.fns.patchAccountProfile.mock.calls[0]).toEqual([{ firstName: '', lastName: 'Martinez' }, { activeRole: undefined }]);
  });
  it('an unchanged profile redirects to ?unchanged=1', async () => {
    const h = harness();
    seed(h);
    h.fns.patchAccountProfile.mockResolvedValueOnce({ ...PATCHED, changed: false });
    expectBack(await submit(h, 'profile'), 'profile', '?unchanged=1');
  });
  it.each(PROFILE_ISSUE_CODES)(
    'a name rejected with %s comes back as ?error=<first_name|last_name>_<code>: the word carries the field (the closed list)',
    async (code) => {
      const h = harness();
      seed(h);
      for (const [field, word] of [
        ['firstName', 'first_name'],
        ['lastName', 'last_name'],
      ] as const) {
        h.fns.patchAccountProfile.mockRejectedValueOnce(
          apiError(400, 'ACCOUNT_VALIDATION_FAILED', {
            reason: 'INVALID_PROFILE',
            issues: [{ field, code, messageKey: `account.error.name_${code.toLowerCase()}` }],
          }),
        );
        expectBack(await submit(h, 'profile'), 'profile', `?error=${word}_${code.toLowerCase()}`);
      }
    },
  );
  it('both names rejected: two words, the first issue of each field, first name first whatever the order of the issues; a repeated field adds nothing', async () => {
    const h = harness();
    seed(h);
    const issue = (field: string, code: string) => ({ field, code, messageKey: `account.error.name_${code.toLowerCase()}` });
    for (const [issues, query] of [
      [[issue('lastName', 'REQUIRED'), issue('firstName', 'TOO_LONG')], '?error=first_name_too_long&error=last_name_required'],
      [[issue('firstName', 'INVALID_CHARACTERS'), issue('lastName', 'TOO_LONG')], '?error=first_name_invalid_characters&error=last_name_too_long'],
      [[issue('firstName', 'REQUIRED'), issue('firstName', 'TOO_LONG'), issue('lastName', 'REQUIRED')], '?error=first_name_required&error=last_name_required'],
      // an unusable issue of one field does not hide the usable one of the other
      [[issue('firstName', 'SOMETHING_NEW'), issue('lastName', 'REQUIRED')], '?error=last_name_required'],
    ] as const) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'INVALID_PROFILE', issues }));
      expectBack(await submit(h, 'profile'), 'profile', query);
    }
  });
  it('an issue of a field the form does not have, or without a field, is a plain ?error=save; the message and the values of the API never reach the redirect', async () => {
    const h = harness();
    seed(h);
    for (const issues of [
      [{ field: 'preferredLocale', code: 'REQUIRED' }],
      [{ code: 'REQUIRED' }],
      [{ field: '__proto__', code: 'REQUIRED' }],
      [{ field: 'firstName' }],
      ['firstName'],
      [null],
    ]) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'INVALID_PROFILE', issues }));
      expectBack(await submit(h, 'profile'), 'profile', '?error=save');
    }
    h.fns.patchAccountProfile.mockRejectedValueOnce(
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', {
        reason: 'INVALID_PROFILE',
        issues: [{ field: 'firstName', code: 'TOO_LONG', message: 'Canary-Message', value: 'Canary-Value' }],
      }),
    );
    const res = await submit(h, 'profile', { firstName: 'Canary-Value', lastName: 'x' });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/account/profile?error=first_name_too_long`);
    expect(await seen(res)).not.toContain('Canary');
  });
  it('every other failure is ?error=save: an unknown issue code, a 400 without issues, a 404, a 403, a 429, a 503, an unreachable API, a bug', async () => {
    const h = harness();
    seed(h);
    const failures: unknown[] = [
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'INVALID_PROFILE', issues: [{ field: 'firstName', code: 'SOMETHING_NEW', messageKey: 'x' }] }),
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'INVALID_PROFILE', issues: [{ field: 'firstName', code: '__proto__' }] }),
      apiError(400, 'VALIDATION_FAILED'),
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'PROFILE_REQUIRED' }),
      apiError(404, 'ACCOUNT_SECTION_NOT_FOUND'),
      apiError(403, 'ACCOUNT_ROLE_NOT_HELD'),
      apiError(429, 'RATE_LIMITED'),
      apiError(503, 'ACCOUNT_UNAVAILABLE'),
      apiError(0, 'API_UNREACHABLE'),
      new Error('boom'),
    ];
    for (const failure of failures) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(failure);
      expectBack(await submit(h, 'profile'), 'profile', '?error=save');
    }
    // a profile form never reports a locale or time zone word
    h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'UNKNOWN_LOCALE' }));
    expectBack(await submit(h, 'profile'), 'profile', '?error=save');
    expect(h.store.sessions.size).toBe(1);
  });
});

describe('language and region form', () => {
  it('PATCHes {preferredLocale, timeZone} with the session token and role and redirects to ?saved=1', async () => {
    const h = harness();
    seed(h, { activeRole: 'CUSTOMER' });
    expectBack(await submit(h, 'language-region', { preferredLocale: 'es-US', timeZone: 'America/New_York' }), 'language-region', '?saved=1');
    expect(h.fns.patchAccountProfile.mock.calls[0]).toEqual([{ preferredLocale: 'es-US', timeZone: 'America/New_York' }, { activeRole: 'CUSTOMER' }]);
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('the "use the default for my area" choice (an empty value) is null, each field on its own', async () => {
    const h = harness();
    seed(h);
    await submit(h, 'language-region', { preferredLocale: '', timeZone: '' });
    await submit(h, 'language-region', { preferredLocale: 'es-US', timeZone: '' });
    await submit(h, 'language-region', { preferredLocale: '', timeZone: 'Pacific/Honolulu' });
    expect(h.fns.patchAccountProfile.mock.calls.map((c) => c[0])).toEqual([
      { preferredLocale: null, timeZone: null },
      { preferredLocale: 'es-US', timeZone: null },
      { preferredLocale: null, timeZone: 'Pacific/Honolulu' },
    ]);
  });
  it('an unchanged choice redirects to ?unchanged=1', async () => {
    const h = harness();
    seed(h);
    h.fns.patchAccountProfile.mockResolvedValueOnce({ ...PATCHED, changed: false });
    expectBack(await submit(h, 'language-region'), 'language-region', '?unchanged=1');
  });
  it('a value the SERVER rejects (an unknown locale or time zone) comes back as ?error=choice', async () => {
    const h = harness();
    seed(h);
    for (const reason of ['UNKNOWN_LOCALE', 'UNKNOWN_TIME_ZONE']) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason, field: 'x' }));
      expectBack(await submit(h, 'language-region'), 'language-region', '?error=choice');
    }
  });
  it('a value that is not even well-formed is ?error=choice WITHOUT calling the API', async () => {
    const h = harness();
    seed(h);
    for (const fields of [
      { preferredLocale: 'en US', timeZone: '' },
      { preferredLocale: '<script>', timeZone: '' },
      { preferredLocale: '', timeZone: '../../etc/passwd' },
      { preferredLocale: '', timeZone: 'America/New York' },
      { preferredLocale: 'x'.repeat(21), timeZone: '' },
    ])
      expectBack(await submit(h, 'language-region', fields), 'language-region', '?error=choice');
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
  });
  it("every other failure is ?error=save (no profile yet, the section is not the role's, the API is down)", async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'PROFILE_REQUIRED' }),
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'INVALID_PROFILE', issues: [{ code: 'REQUIRED' }] }),
      apiError(404, 'ACCOUNT_SECTION_NOT_FOUND'),
      apiError(503, 'ACCOUNT_UNAVAILABLE'),
      new Error('boom'),
    ]) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(failure);
      expectBack(await submit(h, 'language-region'), 'language-region', '?error=save');
    }
  });
});

describe('account forms: revoked sessions, secrets and values', () => {
  it.each(NAMES)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
    const h = harness();
    seed(h);
    h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await submit(h, name);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it.each(NAMES)('%s: never puts a submitted value, a token or a header in a redirect, a cookie, a body or a log line', async (name) => {
    const h = harness();
    seed(h);
    const canary: Record<AccountFormAction, Record<string, string>> = {
      profile: { firstName: 'CanaryFirst', lastName: 'CanaryLast' },
      'language-region': { preferredLocale: 'zz-CANARY', timeZone: 'Canary/Zone' },
    };
    const outcomes: Response[] = [await submit(h, name, canary[name])]; // malformed language values are refused locally; names reach the API
    for (const failure of [
      apiError(400, 'ACCOUNT_VALIDATION_FAILED', { reason: 'UNKNOWN_LOCALE', echoed: 'CanaryFirst CanaryLast zz-CANARY Canary/Zone' }),
      apiError(500, 'INTERNAL', { echoed: 'CanaryFirst' }),
      new Error('CanaryFirst CanaryLast tok-access-SECRET-1'),
    ]) {
      h.fns.patchAccountProfile.mockRejectedValueOnce(failure);
      outcomes.push(await submit(h, name, canary[name]));
    }
    for (const res of outcomes) {
      const everything = await seen(res);
      for (const secret of [...Object.values(TOKENS), 'Canary', 'zz-CANARY', 'sid-1', 'user-1', 'PROVIDER']) expect(everything, secret).not.toContain(secret);
    }
    expect(h.logs.join('\n')).not.toMatch(/Canary|SECRET|sid-1|zz-/);
  });
  it('logs a refusal with the action and the API code only', async () => {
    const h = harness();
    seed(h);
    h.fns.patchAccountProfile.mockRejectedValueOnce(apiError(503, 'ACCOUNT_UNAVAILABLE'));
    await submit(h, 'profile');
    expect(h.logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'warn', message: 'account form refused', action: 'profile', code: 'ACCOUNT_UNAVAILABLE', status: 503 },
    ]);
  });
});

describe('route modules', () => {
  const run = async (route: { POST: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }, name: AccountFormAction) => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    const posted = await route.POST(post(`/auth/account/${name}`, FIELDS[name]));
    const read = await route.GET(post(`/auth/account/${name}`, undefined, { method: 'GET' }));
    return { h, posted, read };
  };
  it('POST /auth/account/profile and /auth/account/language-region call their handler; a GET never changes anything (405)', async () => {
    for (const [route, name] of [
      [{ POST: profilePost, GET: profileGet }, 'profile'],
      [{ POST: languagePost, GET: languageGet }, 'language-region'],
    ] as const) {
      const { h, posted, read } = await run(route, name);
      expectBack(posted, name, '?saved=1');
      expect(read.status).toBe(405);
      expect(read.headers.get('allow')).toBe('POST');
      expect(h.fns.patchAccountProfile).toHaveBeenCalledTimes(1);
    }
  });
  it('each route is bound to its own action (a profile post to the language route is a 400, not a profile change)', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    expect((await languagePost(post('/auth/account/language-region', FIELDS.profile))).status).toBe(400);
    expect((await profilePost(post('/auth/account/profile', FIELDS['language-region']))).status).toBe(400);
    expect(h.fns.patchAccountProfile).not.toHaveBeenCalled();
  });
});

describe('POST /auth/active-role with the optional `next` field', () => {
  const switchTo = async (h: Harness, fields: Record<string, string>, body?: BodyInit) =>
    handleActiveRole(
      post('/auth/active-role', fields, body === undefined ? {} : { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      h.deps,
    );
  it('the allow-list is exactly the roles page and the account home', () => {
    expect([...ACTIVE_ROLE_NEXT_ALLOWLIST]).toEqual(['/account/roles', '/account']);
  });
  it.each(['/account/roles', '/account'])('accepts %s: the role is stored and the browser goes there', async (next) => {
    const h = harness();
    seed(h);
    const res = await switchTo(h, { role: 'PROVIDER', next });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}${next}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.store.sessions.get('sid-1')!.activeRole).toBe('PROVIDER');
    expect(h.fns.setActiveRole).toHaveBeenCalledWith('PROVIDER');
  });
  it('without `next` the redirect stays /session', async () => {
    const h = harness();
    seed(h);
    expect((await switchTo(h, { role: 'PROVIDER' })).headers.get('location')).toBe(`${PUBLIC}/session`);
  });
  it.each([
    '//evil.example',
    '//evil.example/account/roles',
    'https://evil.example/account/roles',
    'http://app.localhost:8080/account/roles',
    '/\\evil.example',
    '\\\\evil.example',
    '/account/roles/',
    '/account/roles?x=1',
    '/account/roles#frag',
    '/account/roles/../session',
    '/account/profile',
    '/account/',
    '/ACCOUNT',
    '/session',
    '/',
    '',
    ' /account',
    '/account ',
    '/account\n',
    '/account%2Froles',
    'account',
    'javascript:alert(1)',
    '/auth/logout',
  ])('rejects %j: the role is still switched but the redirect is /session', async (next) => {
    const h = harness();
    seed(h);
    const res = await switchTo(h, { role: 'PROVIDER', next });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    expect(h.store.sessions.get('sid-1')!.activeRole).toBe('PROVIDER');
  });
  it('a repeated `next` is ignored (it cannot smuggle a second value past the list)', async () => {
    const h = harness();
    seed(h);
    const res = await switchTo(h, {}, 'role=PROVIDER&next=/account&next=//evil.example');
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
  });
  it('a refused switch returns to the same allowed page with ?error=role and changes nothing; an unallowed next keeps /session?error=role', async () => {
    for (const [next, expected] of [
      ['/account/roles', '/account/roles?error=role'],
      ['/account', '/account?error=role'],
      ['//evil.example', '/session?error=role'],
      [undefined, '/session?error=role'],
    ] as const) {
      const h = harness();
      const before = seed(h);
      h.fns.setActiveRole.mockRejectedValueOnce(apiError(403, 'ACCOUNT_ROLE_NOT_HELD'));
      const res = await switchTo(h, { role: 'PROVIDER', ...(next ? { next } : {}) });
      expect(res.headers.get('location')).toBe(`${PUBLIC}${expected}`);
      expect(h.store.sessions.get('sid-1')).toEqual(before);
    }
  });
  it('the role, the origin and the session are still required with `next` present', async () => {
    const h = harness();
    seed(h);
    expect((await handleActiveRole(post('/auth/active-role', { role: 'PROVIDER', next: '/account' }, { origin: 'http://evil.example' }), h.deps)).status).toBe(
      403,
    );
    expect((await handleActiveRole(post('/auth/active-role', { role: 'not-a-role', next: '/account' }), h.deps)).status).toBe(400);
    expect((await handleActiveRole(post('/auth/active-role', { next: '/account' }), h.deps)).status).toBe(400);
    const signedOut = await handleActiveRole(post('/auth/active-role', { role: 'PROVIDER', next: '/account/roles' }, { cookie: null }), h.deps);
    expect(signedOut.headers.get('location')).toBe(`${PUBLIC}/session`);
    expect(h.fns.setActiveRole).not.toHaveBeenCalled();
  });
});
