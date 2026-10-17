// PRO-001 web side, part 1: the BFF half of provider registration. The POST handlers behind /provider/registration (start, market, services, submit, cancel) and the Next
// route module in front of them. The API is a fake client factory with spies: what matters is WHICH call is made, with WHAT, that nothing but a well-formed form reaches
// the API (the server decides everything else), that a result is a fixed 303 target, and that no submitted value, token or log leaks.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { PROVIDER_ERROR_CODES } from '@bananagig/contracts';
import { GET as providerGet, POST as providerPost } from './app/auth/provider/[action]/route';
import { ApiError } from './lib/api-client';
import {
  PROVIDER_ACTIONS,
  PROVIDER_API_ERROR_CODES,
  PROVIDER_GENERIC_ERROR,
  PROVIDER_NOTICES,
  handleProviderAction,
  isProviderAction,
  type ProviderAction,
} from './lib/auth/provider-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { stateDto, registrationDto, requirementsDto, stepsDto } from './testing/provider-stub';

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
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const SESSION_COOKIE = 'bg_session=sid-1';
const apiError = (status: number, code: string, details?: Record<string, unknown>): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1', details);
const STATE = stateDto(registrationDto());

interface Fns {
  setActiveRole: Mock<() => Promise<never>>;
  getProviderRegistration: Mock<(o?: unknown) => Promise<unknown>>;
  startProviderRegistration: Mock<(o?: unknown) => Promise<{ created: boolean; state: unknown }>>;
  selectProviderMarket: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  replaceProviderServices: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  getProviderRequirements: Mock<(q?: unknown, o?: unknown) => Promise<unknown>>;
  submitProviderRegistration: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  cancelProviderRegistration: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
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
      throw new Error('the role switch is not part of the provider actions');
    }),
    getProviderRegistration: vi.fn(async () => STATE),
    startProviderRegistration: vi.fn(async () => ({ created: true, state: STATE })),
    selectProviderMarket: vi.fn(async () => STATE),
    replaceProviderServices: vi.fn(async () => STATE),
    getProviderRequirements: vi.fn(async () => requirementsDto(registrationDto(), stepsDto())),
    submitProviderRegistration: vi.fn(async () => requirementsDto(registrationDto({ status: 'COMPLETED' }), stepsDto())),
    cancelProviderRegistration: vi.fn(async () => STATE),
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
type PostOptions = { method?: string; origin?: string | null; cookie?: string | null; body?: BodyInit | null; headers?: Record<string, string> };
const post = (path: string, fields: Record<string, string> | undefined, o: PostOptions = {}) => {
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
const FIELDS: Record<ProviderAction, Record<string, string>> = {
  start: {},
  market: { marketCode: 'us-orange-county', expectedRevision: '4' },
  services: { expectedRevision: '4' },
  submit: { expectedRevision: '4' },
  cancel: {},
};
/** A urlencoded body of the given pairs (a name may repeat). */
const pairs = (...entries: Array<[string, string]>): URLSearchParams => new URLSearchParams(entries);
const BODIES: Record<ProviderAction, () => URLSearchParams> = {
  start: () => pairs(),
  market: () => pairs(['marketCode', 'us-orange-county'], ['expectedRevision', '4']),
  services: () => pairs(['serviceTypeCode', 'house_cleaning'], ['expectedRevision', '4']),
  submit: () => pairs(['expectedRevision', '4']),
  cancel: () => pairs(),
};
const FN: Record<ProviderAction, keyof Fns> = {
  start: 'startProviderRegistration',
  market: 'selectProviderMarket',
  services: 'replaceProviderServices',
  submit: 'submitProviderRegistration',
  cancel: 'cancelProviderRegistration',
};
const action = (h: Harness, name: ProviderAction, body: BodyInit | null = BODIES[name](), o: PostOptions = {}) =>
  handleProviderAction(post(`/auth/provider/${name}`, undefined, { ...o, body }), h.deps, name);
const noProviderCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectBack = (res: Response, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}/provider/registration${query}`);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};
const expectBadRequest = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('Bad request'); // a fixed body: nothing submitted is echoed
};

describe('PROVIDER_ACTIONS and isProviderAction', () => {
  it('names exactly the five actions and the six notice words', () => {
    expect([...PROVIDER_ACTIONS]).toEqual(['start', 'market', 'services', 'submit', 'cancel']);
    expect([...PROVIDER_NOTICES]).toEqual(['started', 'resumed', 'market_saved', 'services_saved', 'submitted', 'cancelled']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of PROVIDER_ACTIONS) expect(isProviderAction(a)).toBe(true);
    for (const other of [
      '',
      'START',
      'start ',
      '/start',
      'start/x',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'approve',
      'complete',
      'go-live',
    ])
      expect(isProviderAction(other), other).toBe(false);
  });
  it('the error codes a redirect may carry are exactly the API codes of the provider errors, prefixed PROVIDER_', () => {
    expect([...PROVIDER_API_ERROR_CODES]).toEqual(PROVIDER_ERROR_CODES.map((c) => `PROVIDER_${c}`));
    expect(PROVIDER_API_ERROR_CODES).toHaveLength(14);
    expect(PROVIDER_GENERIC_ERROR).toBe('API_ERROR');
  });
});

describe('provider actions: transport and authentication', () => {
  it.each(PROVIDER_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever changes state)', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleProviderAction(post(`/auth/provider/${name}`, FIELDS[name], { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noProviderCalls(h);
  });
  it.each(PROVIDER_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF, 403) before it reads anything', async (name) => {
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
      const res = await action(h, name, undefined, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noProviderCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(PROVIDER_ACTIONS)('%s: a signed-out browser is sent to /session and the API is not called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await action(h, name, undefined, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noProviderCalls(h);
    expect(h.apiTokens).toEqual([]);
  });
  it('refuses to run without an API client (a wiring error, not a request error)', async () => {
    const h = harness(false);
    seed(h);
    await expect(action(h, 'start')).rejects.toThrow('AuthDeps.api');
  });
  it.each(PROVIDER_ACTIONS)('%s: a client without the provider calls is a wiring error too', async (name) => {
    const h = harness();
    seed(h);
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    await expect(handleProviderAction(post(`/auth/provider/${name}`, undefined, { body: BODIES[name]() }), bare, name)).rejects.toThrow('provider calls');
  });
});

describe('provider actions: what each one asks of the API', () => {
  it('start: no arguments but the role, a created attempt says "started"', async () => {
    const h = harness();
    seed(h, { activeRole: 'CUSTOMER' });
    expectBack(await action(h, 'start'), '?notice=started');
    expect(h.fns.startProviderRegistration).toHaveBeenCalledTimes(1);
    expect(h.fns.startProviderRegistration).toHaveBeenCalledWith({ activeRole: 'CUSTOMER' });
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('start: a resumed live attempt (created: false) says "resumed"', async () => {
    const h = harness();
    seed(h);
    h.fns.startProviderRegistration.mockResolvedValueOnce({ created: false, state: STATE });
    expectBack(await action(h, 'start'), '?notice=resumed');
  });
  it('market: forwards exactly the market code and the revision (as a number) with the session token and role', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'market'), '?notice=market_saved');
    expect(h.fns.selectProviderMarket).toHaveBeenCalledTimes(1);
    expect(h.fns.selectProviderMarket).toHaveBeenCalledWith({ marketCode: 'us-orange-county', expectedRevision: 4 }, { activeRole: 'PROVIDER' });
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('market: the revision is optional and is then not sent at all', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'market', pairs(['marketCode', 'us-los-angeles'])), '?notice=market_saved');
    const [input] = h.fns.selectProviderMarket.mock.calls[0]!;
    expect(input).toEqual({ marketCode: 'us-los-angeles' });
    expect(Object.keys(input as object)).toEqual(['marketCode']);
  });
  it('services: forwards every checked box in order, the revision as a number, role and token', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const body = pairs(['serviceTypeCode', 'house_cleaning'], ['serviceTypeCode', 'car_detailing'], ['expectedRevision', '7']);
    expectBack(await action(h, 'services', body), '?notice=services_saved');
    expect(h.fns.replaceProviderServices).toHaveBeenCalledTimes(1);
    expect(h.fns.replaceProviderServices).toHaveBeenCalledWith(
      { serviceTypeCodes: ['house_cleaning', 'car_detailing'], expectedRevision: 7 },
      { activeRole: 'PROVIDER' },
    );
  });
  it('services: no box checked is the EMPTY set (clearing the selection) and the revision is optional', async () => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'services', pairs()), '?notice=services_saved');
    expect(h.fns.replaceProviderServices).toHaveBeenCalledWith({ serviceTypeCodes: [] }, { activeRole: undefined });
    expectBack(await action(h, 'services', pairs(['expectedRevision', '2'])), '?notice=services_saved');
    expect(h.fns.replaceProviderServices).toHaveBeenLastCalledWith({ serviceTypeCodes: [], expectedRevision: 2 }, expect.anything());
  });
  it('submit: forwards exactly the revision as a number with the role and says "submitted"', async () => {
    const h = harness();
    seed(h, { activeRole: 'CUSTOMER' });
    expectBack(await action(h, 'submit'), '?notice=submitted');
    expect(h.fns.submitProviderRegistration).toHaveBeenCalledTimes(1);
    expect(h.fns.submitProviderRegistration).toHaveBeenCalledWith({ expectedRevision: 4 }, { activeRole: 'CUSTOMER' });
  });
  it('cancel: sends an empty request (no reason, no id) with the role and says "cancelled"', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectBack(await action(h, 'cancel'), '?notice=cancelled');
    expect(h.fns.cancelProviderRegistration).toHaveBeenCalledTimes(1);
    expect(h.fns.cancelProviderRegistration).toHaveBeenCalledWith({}, { activeRole: 'PROVIDER' });
  });
  it.each(PROVIDER_ACTIONS)('%s: calls exactly its own API method and no other', async (name) => {
    const h = harness();
    seed(h);
    await action(h, name);
    for (const [other, fn] of Object.entries(h.fns)) {
      if (other === FN[name]) expect(fn, other).toHaveBeenCalledTimes(1);
      else expect(fn, other).not.toHaveBeenCalled();
    }
  });
  it('sends no active role when the session remembers none', async () => {
    const h = harness();
    seed(h);
    await action(h, 'start');
    expect(h.fns.startProviderRegistration.mock.calls[0]![0]).toEqual({ activeRole: undefined });
  });
  it('the revision of the form is not required to be the current one: staleness is the SERVER decision (STALE_REGISTRATION comes back as a code)', async () => {
    const h = harness();
    seed(h);
    h.fns.submitProviderRegistration.mockRejectedValueOnce(apiError(409, 'PROVIDER_STALE_REGISTRATION'));
    expectBack(await action(h, 'submit', pairs(['expectedRevision', '1'])), '?error=PROVIDER_STALE_REGISTRATION');
    expect(h.fns.submitProviderRegistration).toHaveBeenCalledWith({ expectedRevision: 1 }, expect.anything());
  });
});

describe('provider actions: unknown and malformed form values change nothing (400)', () => {
  const REVISIONS_OK = ['1', '4', '9', '123456789'];
  it.each(REVISIONS_OK)('accepts the revision %s (1 to 9 digits, no leading zero)', async (rev) => {
    const h = harness();
    seed(h);
    expectBack(await action(h, 'submit', pairs(['expectedRevision', rev])), '?notice=submitted');
    expect(h.fns.submitProviderRegistration).toHaveBeenCalledWith({ expectedRevision: Number(rev) }, expect.anything());
  });
  const BAD_REVISIONS = ['', '0', '00', '01', '-1', '+1', '1.5', '1e3', '1234567890', '2147483648', ' 4', '4 ', '4\n', '0x10', 'abc', '４', '4;5'];
  it.each(BAD_REVISIONS)('every action with a revision refuses the malformed revision %j', async (rev) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'submit', pairs(['expectedRevision', rev])));
    await expectBadRequest(await action(h, 'market', pairs(['marketCode', 'us-orange-county'], ['expectedRevision', rev])));
    await expectBadRequest(await action(h, 'services', pairs(['serviceTypeCode', 'house_cleaning'], ['expectedRevision', rev])));
    noProviderCalls(h);
  });
  it('submit REQUIRES the revision', async () => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'submit', pairs()));
    noProviderCalls(h);
  });
  const MARKET_CASES: Array<[string, URLSearchParams]> = [
    ['no market code', pairs(['expectedRevision', '4'])],
    ['no fields', pairs()],
    ['empty market code', pairs(['marketCode', ''], ['expectedRevision', '4'])],
    ['upper-case market code', pairs(['marketCode', 'US-ORANGE'], ['expectedRevision', '4'])],
    ['market code with an underscore', pairs(['marketCode', 'us_orange'], ['expectedRevision', '4'])],
    ['market code with a space', pairs(['marketCode', 'us orange'], ['expectedRevision', '4'])],
    ['market code with a path', pairs(['marketCode', 'us-orange/../x'], ['expectedRevision', '4'])],
    ['market code with a query', pairs(['marketCode', 'us-orange?x=1'], ['expectedRevision', '4'])],
    ['market code with markup', pairs(['marketCode', '"><script>'], ['expectedRevision', '4'])],
    ['market code starting with a digit', pairs(['marketCode', '1-orange'], ['expectedRevision', '4'])],
    ['market code with a trailing hyphen', pairs(['marketCode', 'us-'], ['expectedRevision', '4'])],
    ['market code with a trailing newline', pairs(['marketCode', 'us-orange\n'], ['expectedRevision', '4'])],
    ['over-long market code', pairs(['marketCode', `a${'b'.repeat(60)}`], ['expectedRevision', '4'])],
    ['an extra field (accountId)', pairs(['marketCode', 'us-orange-county'], ['accountId', 'x'])],
    ['an extra field (status)', pairs(['marketCode', 'us-orange-county'], ['status', 'COMPLETED'])],
    ['an extra field (role)', pairs(['marketCode', 'us-orange-county'], ['role', 'PROVIDER'])],
    ['a service field on the market form', pairs(['marketCode', 'us-orange-county'], ['serviceTypeCode', 'house_cleaning'])],
    ['the market code twice', pairs(['marketCode', 'us-orange-county'], ['marketCode', 'us-los-angeles'])],
    ['the revision twice', pairs(['marketCode', 'us-orange-county'], ['expectedRevision', '4'], ['expectedRevision', '5'])],
  ];
  it.each(MARKET_CASES)('market: %s', async (_name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'market', body));
    noProviderCalls(h);
  });
  const SERVICE_CASES: Array<[string, URLSearchParams]> = [
    ['an upper-case code', pairs(['serviceTypeCode', 'House_Cleaning'])],
    ['a code with a hyphen', pairs(['serviceTypeCode', 'house-cleaning'])],
    ['a one-letter code', pairs(['serviceTypeCode', 'a'])],
    ['an over-long code', pairs(['serviceTypeCode', `a${'b'.repeat(48)}`])],
    ['an empty code', pairs(['serviceTypeCode', ''])],
    ['a code with a space', pairs(['serviceTypeCode', 'house cleaning'])],
    ['a code with a path', pairs(['serviceTypeCode', 'house_cleaning/../x'])],
    ['a code with markup', pairs(['serviceTypeCode', '"><script>'])],
    ['one good and one malformed code', pairs(['serviceTypeCode', 'house_cleaning'], ['serviceTypeCode', 'Bad Code'])],
    ['a duplicated code', pairs(['serviceTypeCode', 'house_cleaning'], ['serviceTypeCode', 'house_cleaning'])],
    ['a duplicate among others', pairs(['serviceTypeCode', 'a_b'], ['serviceTypeCode', 'c_d'], ['serviceTypeCode', 'a_b'])],
    ['a market field on the services form', pairs(['serviceTypeCode', 'house_cleaning'], ['marketCode', 'us-orange-county'])],
    ['an extra field (accountId)', pairs(['serviceTypeCode', 'house_cleaning'], ['accountId', 'x'])],
    ['a differently spelled field (serviceTypeCodes)', pairs(['serviceTypeCodes', 'house_cleaning'])],
    ['the revision twice', pairs(['expectedRevision', '4'], ['expectedRevision', '5'])],
  ];
  it.each(SERVICE_CASES)('services: %s', async (_name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'services', body));
    noProviderCalls(h);
  });
  it('services: at most 50 boxes (the contract ceiling) are accepted and 51 are refused', async () => {
    const h = harness();
    seed(h);
    const codes = (n: number) => Array.from({ length: n }, (_v, i) => ['serviceTypeCode', `service_${i}`] as [string, string]);
    expectBack(await action(h, 'services', pairs(...codes(50))), '?notice=services_saved');
    expect((h.fns.replaceProviderServices.mock.calls[0]![0] as { serviceTypeCodes: string[] }).serviceTypeCodes).toHaveLength(50);
    h.fns.replaceProviderServices.mockClear();
    await expectBadRequest(await action(h, 'services', pairs(...codes(51))));
    await expectBadRequest(await action(h, 'services', pairs(...codes(500))));
    expect(h.fns.replaceProviderServices).not.toHaveBeenCalled();
  });
  it.each([
    ['start', pairs(['expectedRevision', '4'])],
    ['start', pairs(['marketCode', 'us-orange-county'])],
    ['start', pairs(['accountId', 'a'])],
    ['start', pairs(['reason', 'because'])],
    ['cancel', pairs(['reason', 'because'])],
    ['cancel', pairs(['expectedRevision', '4'])],
    ['cancel', pairs(['accountId', 'a'])],
    ['cancel', pairs(['status', 'CANCELLED'])],
  ] as Array<[ProviderAction, URLSearchParams]>)('%s takes NO field at all: %s is refused', async (name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, name, body));
    noProviderCalls(h);
  });
  it('a field of another action is a forged form: refused', async () => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'submit', pairs(['expectedRevision', '4'], ['marketCode', 'us-orange-county'])));
    await expectBadRequest(await action(h, 'submit', pairs(['expectedRevision', '4'], ['serviceTypeCode', 'house_cleaning'])));
    await expectBadRequest(await action(h, 'market', pairs(['serviceTypeCode', 'house_cleaning'], ['marketCode', 'us-orange-county'])));
    noProviderCalls(h);
  });
  it.each(PROVIDER_ACTIONS)('%s: refuses a file part and a body that is not a form', async (name) => {
    const h = harness();
    seed(h);
    const multipart = new FormData();
    multipart.append('upload', new Blob(['x']), 'x.txt');
    await expectBadRequest(await action(h, name, multipart));
    // a file in the place of a legitimate field
    const filed = new FormData();
    const legit = Object.fromEntries(BODIES[name]());
    const first = Object.keys(legit)[0] ?? 'expectedRevision';
    for (const [k, v] of Object.entries(legit)) if (k !== first) filed.append(k, v);
    filed.append(first, new Blob(['4']), 'x.txt');
    await expectBadRequest(await action(h, name, filed));
    await expectBadRequest(await action(h, name, JSON.stringify(Object.fromEntries(BODIES[name]())), { headers: { 'content-type': 'application/json' } }));
    await expectBadRequest(await action(h, name, null));
    noProviderCalls(h);
  });
  it('services: a file among the checked boxes is refused', async () => {
    const h = harness();
    seed(h);
    const fd = new FormData();
    fd.append('serviceTypeCode', 'house_cleaning');
    fd.append('serviceTypeCode', new Blob(['car_detailing']), 'x.txt');
    await expectBadRequest(await action(h, 'services', fd));
    noProviderCalls(h);
  });
  it('a multipart form of text fields is accepted like a urlencoded one', async () => {
    const h = harness();
    seed(h);
    const fd = new FormData();
    fd.append('serviceTypeCode', 'house_cleaning');
    fd.append('serviceTypeCode', 'lawn_care');
    fd.append('expectedRevision', '3');
    expectBack(await action(h, 'services', fd), '?notice=services_saved');
    expect(h.fns.replaceProviderServices).toHaveBeenCalledWith({ serviceTypeCodes: ['house_cleaning', 'lawn_care'], expectedRevision: 3 }, expect.anything());
  });
  it('is checked AFTER the session (a signed-out browser is only sent to /session)', async () => {
    const h = harness();
    const res = await action(h, 'submit', pairs(['expectedRevision', 'garbage']), { cookie: null });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    noProviderCalls(h);
  });
  it('is checked AFTER the origin (a foreign origin is 403 even for a malformed form)', async () => {
    const h = harness();
    seed(h);
    expect((await action(h, 'submit', pairs(['expectedRevision', 'garbage']), { origin: 'http://evil.example' })).status).toBe(403);
    noProviderCalls(h);
  });
  it("a well-formed form that the server will refuse is the SERVER's decision: it is forwarded unchanged and the refusal comes back as a code", async () => {
    const h = harness();
    seed(h);
    h.fns.selectProviderMarket.mockRejectedValueOnce(apiError(409, 'PROVIDER_MARKET_NOT_ELIGIBLE'));
    expectBack(await action(h, 'market', pairs(['marketCode', 'xx-nowhere'], ['expectedRevision', '4'])), '?error=PROVIDER_MARKET_NOT_ELIGIBLE');
    expect(h.fns.selectProviderMarket).toHaveBeenCalledWith({ marketCode: 'xx-nowhere', expectedRevision: 4 }, expect.anything());
  });
});

describe('provider actions: what the API can answer', () => {
  it.each(PROVIDER_ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
    const h = harness();
    seed(h);
    h.fns[FN[name]].mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await action(h, name);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
    expect(h.logs.join('\n')).not.toContain('provider action refused'); // a revoked session is not an action failure
  });
  it.each(PROVIDER_ACTIONS)('%s: every provider code of the API comes back as ?error=PROVIDER_<code>, and the session stays', async (name) => {
    const h = harness();
    seed(h);
    for (const code of PROVIDER_ERROR_CODES) {
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, `PROVIDER_${code}`));
      expectBack(await action(h, name), `?error=PROVIDER_${code}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(PROVIDER_ACTIONS)('%s: no step-up is required (a STEP_UP_REQUIRED is just an error, never a login round trip)', async (name) => {
    const h = harness();
    seed(h);
    h.fns[FN[name]].mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
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
      apiError(409, 'REGISTRATION_INCOMPLETE'), // without the PROVIDER_ prefix it is not the API's code
      apiError(409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE'),
      apiError(500, 'PROVIDER_UNKNOWN_THING'),
      apiError(500, 'provider_unavailable'),
      apiError(500, 'weird code with spaces'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
      apiError(500, 'PROVIDER_UNAVAILABLE&x=1'),
      new Error('internal detail'),
    ]) {
      h.fns.startProviderRegistration.mockRejectedValueOnce(failure);
      const res = await action(h, 'start');
      expectBack(res, '?error=API_ERROR');
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('no redirect, header, cookie or log line carries a submitted value, a code, a market or a token', async () => {
    const h = harness();
    seed(h);
    const SECRET_MARKET = 'us-secretville';
    const SECRET_SERVICE = 'zz_secret_service';
    const results: Response[] = [];
    results.push(await action(h, 'market', pairs(['marketCode', SECRET_MARKET], ['expectedRevision', '987654321'])));
    h.fns.selectProviderMarket.mockRejectedValueOnce(apiError(409, 'PROVIDER_MARKET_NOT_ELIGIBLE', { marketCode: SECRET_MARKET }));
    results.push(await action(h, 'market', pairs(['marketCode', SECRET_MARKET], ['expectedRevision', '987654321'])));
    results.push(await action(h, 'services', pairs(['serviceTypeCode', SECRET_SERVICE], ['expectedRevision', '987654321'])));
    h.fns.replaceProviderServices.mockRejectedValueOnce(apiError(409, 'PROVIDER_SERVICE_TYPE_NOT_ELIGIBLE', { serviceTypeCodes: [SECRET_SERVICE] }));
    results.push(await action(h, 'services', pairs(['serviceTypeCode', SECRET_SERVICE], ['expectedRevision', '987654321'])));
    h.fns.submitProviderRegistration.mockRejectedValueOnce(apiError(409, 'PROVIDER_REGISTRATION_INCOMPLETE', { blockedBy: ['CONTACT'] }));
    results.push(await action(h, 'submit', pairs(['expectedRevision', '987654321'])));
    results.push(await action(h, 'start'), await action(h, 'cancel'));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of [SECRET_MARKET, SECRET_SERVICE, '987654321', 'blockedBy', TOKENS.access, TOKENS.refresh, TOKENS.id, 'sid-1', 'user-1'])
        expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    for (const marker of [SECRET_MARKET, SECRET_SERVICE, '987654321', 'blockedBy', TOKENS.access, TOKENS.refresh, TOKENS.id, 'user-1'])
      expect(logs).not.toContain(marker);
  });
  it('a refusal is logged with the action, the closed code and the status only', async () => {
    const h = harness();
    seed(h);
    h.fns.submitProviderRegistration.mockRejectedValueOnce(apiError(409, 'PROVIDER_STALE_REGISTRATION'));
    await action(h, 'submit');
    h.fns.cancelProviderRegistration.mockRejectedValueOnce(apiError(500, 'something odd'));
    await action(h, 'cancel');
    h.fns.startProviderRegistration.mockRejectedValueOnce(new Error('boom'));
    await action(h, 'start');
    expect(h.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'warn', message: 'provider action refused', action: 'submit', code: 'PROVIDER_STALE_REGISTRATION', status: 409 },
      { level: 'warn', message: 'provider action refused', action: 'cancel', code: 'API_ERROR', status: 500 },
      { level: 'warn', message: 'provider action refused', action: 'start', code: 'API_ERROR' },
    ]);
  });
  it('a success logs nothing', async () => {
    const h = harness();
    seed(h);
    for (const name of PROVIDER_ACTIONS) await action(h, name);
    expect(h.logs).toEqual([]);
  });
  it('the redirect target is fixed: it never depends on the request host, a header or a field', async () => {
    const h = harness();
    seed(h);
    const req = new Request('http://evil.example/auth/provider/market?returnTo=http://evil.example&next=//evil.example', {
      method: 'POST',
      headers: { origin: PUBLIC, cookie: SESSION_COOKIE, host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
      body: pairs(['marketCode', 'us-orange-county'], ['expectedRevision', '4']),
    });
    expectBack(await handleProviderAction(req, h.deps, 'market'), '?notice=market_saved');
  });
  it('every 303 target of every outcome is below the web public URL /provider/registration', async () => {
    const h = harness();
    seed(h);
    const locations: string[] = [];
    for (const name of PROVIDER_ACTIONS) {
      locations.push((await action(h, name)).headers.get('location')!);
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, 'PROVIDER_CONFLICT'));
      locations.push((await action(h, name)).headers.get('location')!);
    }
    expect(locations).toHaveLength(10);
    for (const l of locations) expect(l.startsWith(`${PUBLIC}/provider/registration?`), l).toBe(true);
  });
});

describe('the Next route module for /auth/provider/<action>', () => {
  it('delegates each known action to the handler with the process-wide deps', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const expected: Record<ProviderAction, string> = {
      start: '?notice=started',
      market: '?notice=market_saved',
      services: '?notice=services_saved',
      submit: '?notice=submitted',
      cancel: '?notice=cancelled',
    };
    for (const name of PROVIDER_ACTIONS) {
      const res = await providerPost(post(`/auth/provider/${name}`, undefined, { body: BODIES[name]() }), { params: Promise.resolve({ action: name }) });
      expect(res.headers.get('location'), name).toBe(`${PUBLIC}/provider/registration${expected[name]}`);
    }
    expect(routeState.calls).toBe(5);
  });
  it('answers an unknown action with 404 without touching the deps, and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'START', 'approve', 'constructor', '__proto__', 'start/x']) {
      const res = await providerPost(post('/auth/provider/x', {}), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = providerGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(routeState.calls).toBe(0);
  });
});

// keeps the unused-field table honest: every action has a fields entry
it('has a sample form for every action', () => {
  expect(Object.keys(FIELDS).sort()).toEqual([...PROVIDER_ACTIONS].sort());
});
