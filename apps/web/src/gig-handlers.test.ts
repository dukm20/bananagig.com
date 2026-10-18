// CAT-003 web side, part 2: the BFF half of the provider Gigs. The POST handlers behind /provider/gigs (create, save, publish, retire, draft) and the Next route module in front of
// them. The API is a fake client factory with spies: what matters is WHICH call is made, with WHAT, that nothing but a well-formed form reaches the API (the server decides everything
// else), that a result is a 303 to a fixed target, and that no provider text, token or secret leaks into a redirect, a header, a cookie or a log line.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GIG_ERROR_CODES, gigWireCode } from '@bananagig/contracts';
import { GET as gigGet, POST as gigPost } from './app/auth/provider/gigs/[action]/route';
import { ApiError } from './lib/api-client';
import { GIG_ACTIONS, GIG_API_ERROR_CODES, GIG_GENERIC_ERROR, GIG_NOTICES, handleGigAction, isGigAction, type GigAction } from './lib/auth/gig-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { GIG_ID, detailDto, versionDto } from './testing/gig-stub';

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
const DETAIL = detailDto({ draft: versionDto() });
const GIG = GIG_ID;
const REQUEST_ID = '0b5c7c40-2a6e-4f3b-8d1e-6a9f3c2b1d00';

interface Fns {
  setActiveRole: Mock<() => Promise<never>>;
  createGig: Mock<(input: unknown, o?: unknown) => Promise<{ created: boolean; detail: unknown }>>;
  updateGigDraft: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  publishGig: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  retireGig: Mock<(gigId: string, o?: unknown) => Promise<unknown>>;
  createGigVersion: Mock<(gigId: string, o?: unknown) => Promise<unknown>>;
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
      throw new Error('the role switch is not part of the Gig actions');
    }),
    createGig: vi.fn(async () => ({ created: true, detail: DETAIL })),
    updateGigDraft: vi.fn(async () => DETAIL),
    publishGig: vi.fn(async () => DETAIL),
    retireGig: vi.fn(async () => DETAIL),
    createGigVersion: vi.fn(async () => DETAIL),
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
    ...(o.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
};
/** A urlencoded body of the given pairs (a name may repeat). */
const pairs = (...entries: Array<[string, string]>): URLSearchParams => new URLSearchParams(entries);
const SAVE: Array<[string, string]> = [
  ['gigId', GIG],
  ['expectedRevision', '5'],
  ['title', 'Spotless clean'],
  ['shortPitch', 'We bring everything.'],
  ['description', 'Line one\nLine two'],
];
const BODIES: Record<GigAction, () => URLSearchParams> = {
  create: () => pairs(['gigTemplateCode', 'deep_clean'], ['clientRequestId', REQUEST_ID]),
  save: () => pairs(...SAVE),
  publish: () => pairs(['gigId', GIG], ['expectedRevision', '5']),
  retire: () => pairs(['gigId', GIG]),
  draft: () => pairs(['gigId', GIG]),
};
const FN: Record<GigAction, keyof Fns> = { create: 'createGig', save: 'updateGigDraft', publish: 'publishGig', retire: 'retireGig', draft: 'createGigVersion' };
const OK_QUERY: Record<GigAction, string> = {
  create: '?notice=created',
  save: '?notice=saved',
  publish: '?notice=published',
  retire: '?notice=retired',
  draft: '?notice=draft_created',
};
const TARGET: Record<GigAction, string> = {
  create: `/provider/gigs/${GIG}`,
  save: `/provider/gigs/${GIG}`,
  publish: `/provider/gigs/${GIG}`,
  retire: `/provider/gigs/${GIG}`,
  draft: `/provider/gigs/${GIG}`,
};
const ERROR_TARGET: Record<GigAction, string> = { ...TARGET, create: '/provider/gigs' };
const action = (h: Harness, name: GigAction, body: BodyInit | null = BODIES[name](), o: PostOptions = {}) =>
  handleGigAction(post(`/auth/provider/gigs/${name}`, undefined, { ...o, body }), h.deps, name);
const noGigCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
};
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const expectTo = (res: Response, path: string, query: string): void => {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`${PUBLIC}${path}${query}`);
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
const lastBody = (h: Harness): Record<string, unknown> => h.fns.updateGigDraft.mock.calls.at(-1)![1] as Record<string, unknown>;

describe('GIG_ACTIONS and isGigAction', () => {
  it('names exactly the five actions and the five notice words', () => {
    expect([...GIG_ACTIONS]).toEqual(['create', 'save', 'publish', 'retire', 'draft']);
    expect([...GIG_NOTICES]).toEqual(['created', 'saved', 'published', 'draft_created', 'retired']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of GIG_ACTIONS) expect(isGigAction(a)).toBe(true);
    for (const other of [
      '',
      'CREATE',
      'create ',
      '/create',
      'create/x',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'reactivate',
      'delete',
      'unpublish',
      'go-live',
    ])
      expect(isGigAction(other), other).toBe(false);
  });
  it('the error words a redirect may carry are exactly GIG_<API code> and the generic word is API_ERROR', () => {
    expect([...GIG_API_ERROR_CODES]).toEqual(GIG_ERROR_CODES.map((c) => gigWireCode(c)));
    expect(GIG_API_ERROR_CODES).toHaveLength(19);
    for (const c of ['GIG_MEDIA_NOT_FOUND', 'GIG_MEDIA_REFUSED', 'GIG_MEDIA_EXPIRED', 'GIG_MEDIA_SCAN_UNAVAILABLE']) expect(GIG_API_ERROR_CODES).toContain(c);
    expect(GIG_GENERIC_ERROR).toBe('API_ERROR');
  });
});

describe('Gig actions: transport and authentication', () => {
  it.each(GIG_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever changes state)', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleGigAction(post(`/auth/provider/gigs/${name}`, {}, { method }), h.deps, name);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noGigCalls(h);
  });
  it.each(GIG_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF, 403) before it reads anything', async (name) => {
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
    noGigCalls(h);
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(GIG_ACTIONS)('%s: a signed-out browser is sent to /session and the API is not called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await action(h, name, undefined, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noGigCalls(h);
    expect(h.apiTokens).toEqual([]);
  });
  it('refuses to run without an API client (a wiring error, not a request error)', async () => {
    const h = harness(false);
    seed(h);
    await expect(action(h, 'create')).rejects.toThrow('AuthDeps.api');
  });
  it.each(GIG_ACTIONS)('%s: a client without the Gig calls is a wiring error too', async (name) => {
    const h = harness();
    seed(h);
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    await expect(handleGigAction(post(`/auth/provider/gigs/${name}`, undefined, { body: BODIES[name]() }), bare, name)).rejects.toThrow('Gig calls');
  });
});

describe('Gig actions: what each one asks of the API', () => {
  it('create: forwards the template code and the idempotency token with the session token and role; 303 to the new Gig with "created"', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectTo(await action(h, 'create'), `/provider/gigs/${GIG}`, '?notice=created');
    expect(h.fns.createGig).toHaveBeenCalledTimes(1);
    expect(h.fns.createGig).toHaveBeenCalledWith({ gigTemplateCode: 'deep_clean', clientRequestId: REQUEST_ID }, { activeRole: 'PROVIDER' });
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('create: the idempotency token is optional and is then not sent; an idempotent replay (created: false) goes to the same Gig', async () => {
    const h = harness();
    seed(h);
    h.fns.createGig.mockResolvedValueOnce({ created: false, detail: DETAIL });
    expectTo(await action(h, 'create', pairs(['gigTemplateCode', 'deep_clean'])), `/provider/gigs/${GIG}`, '?notice=created');
    expect(h.fns.createGig.mock.calls[0]![0]).toEqual({ gigTemplateCode: 'deep_clean' });
  });
  it('create: an id the API returned that is not a UUID is never put in a path (the menu is the target)', async () => {
    const h = harness();
    seed(h);
    h.fns.createGig.mockResolvedValueOnce({ created: true, detail: { ...DETAIL, gig: { ...DETAIL.gig, gigId: '../../evil' } } });
    expectTo(await action(h, 'create'), '/provider/gigs', '?notice=created');
  });
  it('save: forwards the whole editable content with the revision as a number; blank text becomes null; the currency and the status are not part of it', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const body = pairs(
      ...SAVE,
      ['price', '12500'],
      ['duration', '90'],
      ['field.n.rooms', '3'],
      ['field.t.notes', 'Mind the cat'],
      ['field.d.area', '12.5'],
      ['field.b.pets', 'true'],
      ['field.e.supplies', 'provider'],
    );
    expectTo(await action(h, 'save', body), `/provider/gigs/${GIG}`, '?notice=saved');
    expect(h.fns.updateGigDraft).toHaveBeenCalledTimes(1);
    expect(h.fns.updateGigDraft.mock.calls[0]![0]).toBe(GIG);
    expect(h.fns.updateGigDraft.mock.calls[0]![2]).toEqual({ activeRole: 'PROVIDER' });
    expect(lastBody(h)).toEqual({
      expectedRevision: 5,
      title: 'Spotless clean',
      shortPitch: 'We bring everything.',
      description: 'Line one\nLine two',
      priceAmountMinor: 12500,
      durationMinutes: 90,
      fieldValues: [
        { fieldKey: 'rooms', value: 3 },
        { fieldKey: 'notes', value: 'Mind the cat' },
        { fieldKey: 'area', value: '12.5' },
        { fieldKey: 'pets', value: true },
        { fieldKey: 'supplies', value: 'provider' },
      ],
    });
    expect(Object.keys(lastBody(h)).sort()).toEqual([
      'description',
      'durationMinutes',
      'expectedRevision',
      'fieldValues',
      'priceAmountMinor',
      'shortPitch',
      'title',
    ]);
  });
  it('save: blank title/pitch/description, price and duration and blank field values are cleared (null / left out); a boolean false is kept', async () => {
    const h = harness();
    seed(h);
    const body = pairs(
      ['gigId', GIG],
      ['expectedRevision', '5'],
      ['title', '   '],
      ['shortPitch', ''],
      ['description', '\n'],
      ['price', ''],
      ['duration', ' '],
      ['field.t.notes', ' '],
      ['field.n.rooms', ''],
      ['field.b.pets', 'false'],
      ['field.b.gate', ''],
      ['field.e.supplies', ''],
    );
    expectTo(await action(h, 'save', body), `/provider/gigs/${GIG}`, '?notice=saved');
    expect(lastBody(h)).toEqual({
      expectedRevision: 5,
      title: null,
      shortPitch: null,
      description: null,
      priceAmountMinor: null,
      durationMinutes: null,
      fieldValues: [{ fieldKey: 'pets', value: false }],
    });
  });
  it('save: price and duration are optional fields of the form (a Gig whose template allows neither does not send them)', async () => {
    const h = harness();
    seed(h);
    expectTo(await action(h, 'save'), `/provider/gigs/${GIG}`, '?notice=saved');
    expect(lastBody(h)).toMatchObject({ priceAmountMinor: null, durationMinutes: null, fieldValues: [] });
  });
  it('save: the provider text is forwarded untouched in the request body (the server normalises it)', async () => {
    const h = harness();
    seed(h);
    const text = '  <b>Bold</b>  &  "quotes"\n\tTab ';
    await action(h, 'save', pairs(['gigId', GIG], ['expectedRevision', '5'], ['title', text], ['shortPitch', 'p'], ['description', text]));
    expect(lastBody(h)).toMatchObject({ title: text, description: text });
  });
  it('publish: forwards exactly the revision as a number with the role', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectTo(await action(h, 'publish'), `/provider/gigs/${GIG}`, '?notice=published');
    expect(h.fns.publishGig).toHaveBeenCalledWith(GIG, { expectedRevision: 5 }, { activeRole: 'PROVIDER' });
  });
  it('retire and draft: pass only the Gig id and the role (no reason, no input)', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectTo(await action(h, 'retire'), `/provider/gigs/${GIG}`, '?notice=retired');
    expect(h.fns.retireGig).toHaveBeenCalledWith(GIG, { activeRole: 'PROVIDER' });
    expectTo(await action(h, 'draft'), `/provider/gigs/${GIG}`, '?notice=draft_created');
    expect(h.fns.createGigVersion).toHaveBeenCalledWith(GIG, { activeRole: 'PROVIDER' });
  });
  it('a Gig id in upper case is sent in its canonical lower-case form', async () => {
    const h = harness();
    seed(h);
    expectTo(await action(h, 'retire', pairs(['gigId', GIG.toUpperCase()])), `/provider/gigs/${GIG}`, '?notice=retired');
    expect(h.fns.retireGig.mock.calls[0]![0]).toBe(GIG);
  });
  it.each(GIG_ACTIONS)('%s: calls exactly its own API method and no other, and says its own word', async (name) => {
    const h = harness();
    seed(h);
    expectTo(await action(h, name), TARGET[name], OK_QUERY[name]);
    for (const [other, fn] of Object.entries(h.fns)) {
      if (other === FN[name]) expect(fn, other).toHaveBeenCalledTimes(1);
      else expect(fn, other).not.toHaveBeenCalled();
    }
  });
  it('sends no active role when the session remembers none', async () => {
    const h = harness();
    seed(h);
    await action(h, 'retire');
    expect(h.fns.retireGig.mock.calls[0]![1]).toEqual({ activeRole: undefined });
  });
  it("the revision of the form is not required to be the current one: staleness is the SERVER's decision (GIG_STALE_DRAFT comes back as a code)", async () => {
    const h = harness();
    seed(h);
    h.fns.publishGig.mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT'));
    expectTo(await action(h, 'publish', pairs(['gigId', GIG], ['expectedRevision', '1'])), `/provider/gigs/${GIG}`, '?error=GIG_STALE_DRAFT');
    expect(h.fns.publishGig).toHaveBeenCalledWith(GIG, { expectedRevision: 1 }, expect.anything());
  });
});

describe('Gig actions: forged and malformed forms change nothing (400)', () => {
  const BAD_REVISIONS = ['', '0', '00', '01', '-1', '+1', '1.5', '1e3', '1234567890', ' 5', '5 ', '5\n', '0x10', 'abc', '４', '5;6'];
  it.each(BAD_REVISIONS)('save and publish refuse the malformed revision %j', async (rev) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'publish', pairs(['gigId', GIG], ['expectedRevision', rev])));
    await expectBadRequest(
      await action(h, 'save', pairs(['gigId', GIG], ['expectedRevision', rev], ['title', 't'], ['shortPitch', 'p'], ['description', 'd'])),
    );
    noGigCalls(h);
  });
  const BAD_IDS = [
    '',
    'x',
    GIG.slice(1),
    `${GIG}0`,
    `${GIG}/../x`,
    `${GIG}?x=1`,
    '"><script>',
    ' ' + GIG,
    GIG + '\n',
    GIG.replace(/-/g, ''),
    '00000000-0000-0000-0000-00000000000g',
  ];
  it.each(BAD_IDS)('every Gig action refuses the Gig id %j', async (id) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'retire', pairs(['gigId', id])));
    await expectBadRequest(await action(h, 'draft', pairs(['gigId', id])));
    await expectBadRequest(await action(h, 'publish', pairs(['gigId', id], ['expectedRevision', '5'])));
    await expectBadRequest(await action(h, 'save', pairs(['gigId', id], ['expectedRevision', '5'], ['title', 't'], ['shortPitch', 'p'], ['description', 'd'])));
    noGigCalls(h);
  });
  const CREATE_CASES: Array<[string, URLSearchParams]> = [
    ['no template code', pairs()],
    ['an empty template code', pairs(['gigTemplateCode', ''])],
    ['an upper-case code', pairs(['gigTemplateCode', 'Deep_Clean'])],
    ['a code with a space', pairs(['gigTemplateCode', 'deep clean'])],
    ['a code with a path', pairs(['gigTemplateCode', 'deep_clean/../x'])],
    ['a code with markup', pairs(['gigTemplateCode', '"><script>'])],
    ['the code twice', pairs(['gigTemplateCode', 'a_b'], ['gigTemplateCode', 'c_d'])],
    ['a malformed idempotency token', pairs(['gigTemplateCode', 'deep_clean'], ['clientRequestId', 'not-a-uuid'])],
    ['the token twice', pairs(['gigTemplateCode', 'deep_clean'], ['clientRequestId', REQUEST_ID], ['clientRequestId', REQUEST_ID])],
    ['an extra field (accountId)', pairs(['gigTemplateCode', 'deep_clean'], ['accountId', 'x'])],
    ['an extra field (status)', pairs(['gigTemplateCode', 'deep_clean'], ['status', 'ACTIVE'])],
    ['an extra field (gigTemplateVersionId)', pairs(['gigTemplateCode', 'deep_clean'], ['gigTemplateVersionId', GIG])],
    ['a price', pairs(['gigTemplateCode', 'deep_clean'], ['price', '1'])],
  ];
  it.each(CREATE_CASES)('create: %s', async (_name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'create', body));
    noGigCalls(h);
  });
  const SAVE_CASES: Array<[string, URLSearchParams]> = [
    ['no Gig id', pairs(['expectedRevision', '5'], ['title', 't'], ['shortPitch', 'p'], ['description', 'd'])],
    ['no revision', pairs(['gigId', GIG], ['title', 't'], ['shortPitch', 'p'], ['description', 'd'])],
    ['no title', pairs(['gigId', GIG], ['expectedRevision', '5'], ['shortPitch', 'p'], ['description', 'd'])],
    ['no description', pairs(['gigId', GIG], ['expectedRevision', '5'], ['title', 't'], ['shortPitch', 'p'])],
    ['the title twice', pairs(...SAVE, ['title', 'again'])],
    ['an extra field (currency)', pairs(...SAVE, ['currency', 'EUR'])],
    ['an extra field (priceCurrency)', pairs(...SAVE, ['priceCurrency', 'EUR'])],
    ['an extra field (status)', pairs(...SAVE, ['status', 'PUBLISHED'])],
    ['an extra field (accountId)', pairs(...SAVE, ['accountId', 'x'])],
    ['an extra field (gigTemplateVersionId)', pairs(...SAVE, ['gigTemplateVersionId', 'x'])],
    ['a field value without the field. prefix', pairs(...SAVE, ['rooms', '3'])],
    ['a field value of an unknown kind', pairs(...SAVE, ['field.x.rooms', '3'])],
    ['a field key with upper case', pairs(...SAVE, ['field.n.Rooms', '3'])],
    ['a field key with a path', pairs(...SAVE, ['field.n.rooms/../x', '3'])],
    ['a field key with a dot', pairs(...SAVE, ['field.n.rooms.x', '3'])],
    ['a field key twice', pairs(...SAVE, ['field.n.rooms', '3'], ['field.n.rooms', '4'])],
    ['an expectedRevision as a field name variant', pairs(...SAVE, ['expected_revision', '5'])],
  ];
  it.each(SAVE_CASES)('save: %s', async (_name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, 'save', body));
    noGigCalls(h);
  });
  it('save: at most 64 field values are accepted (the contract ceiling) and 65 are refused', async () => {
    const h = harness();
    seed(h);
    const many = (n: number) => Array.from({ length: n }, (_v, i) => [`field.t.f_${i}`, `v${i}`] as [string, string]);
    expectTo(await action(h, 'save', pairs(...SAVE, ...many(64))), `/provider/gigs/${GIG}`, '?notice=saved');
    expect((lastBody(h).fieldValues as unknown[]).length).toBe(64);
    h.fns.updateGigDraft.mockClear();
    await expectBadRequest(await action(h, 'save', pairs(...SAVE, ...many(65))));
    expect(h.fns.updateGigDraft).not.toHaveBeenCalled();
  });
  it.each([
    ['publish', pairs(['gigId', GIG], ['expectedRevision', '5'], ['title', 't'])],
    ['publish', pairs(['expectedRevision', '5'])],
    ['publish', pairs(['gigId', GIG])],
    ['retire', pairs(['gigId', GIG], ['reason', 'because'])],
    ['retire', pairs(['gigId', GIG], ['expectedRevision', '5'])],
    ['draft', pairs(['gigId', GIG], ['title', 'x'])],
    ['retire', pairs()],
    ['draft', pairs()],
    ['retire', pairs(['gigId', GIG], ['gigId', GIG])],
  ] as Array<[GigAction, URLSearchParams]>)('%s takes exactly its fields: %s is refused', async (name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await action(h, name, body));
    noGigCalls(h);
  });
  it.each(GIG_ACTIONS)('%s: refuses a file part and a body that is not a form', async (name) => {
    const h = harness();
    seed(h);
    const multipart = new FormData();
    multipart.append('upload', new Blob(['x']), 'x.txt');
    await expectBadRequest(await action(h, name, multipart));
    const legit = Object.fromEntries(BODIES[name]());
    const first = Object.keys(legit)[0]!;
    const filed = new FormData();
    for (const [k, v] of Object.entries(legit)) if (k !== first) filed.append(k, v);
    filed.append(first, new Blob(['x']), 'x.txt');
    await expectBadRequest(await action(h, name, filed));
    await expectBadRequest(await action(h, name, JSON.stringify(legit), { headers: { 'content-type': 'application/json' } }));
    await expectBadRequest(await action(h, name, null));
    noGigCalls(h);
  });
  it('a multipart form of text fields is accepted like a urlencoded one', async () => {
    const h = harness();
    seed(h);
    const fd = new FormData();
    for (const [k, v] of Object.entries(Object.fromEntries(BODIES.publish()))) fd.append(k, v);
    expectTo(await action(h, 'publish', fd), `/provider/gigs/${GIG}`, '?notice=published');
  });
  it('is checked AFTER the session (a signed-out browser is only sent to /session) and AFTER the origin (a foreign origin is 403 even for a malformed form)', async () => {
    const h = harness();
    const res = await action(h, 'publish', pairs(['gigId', 'garbage']), { cookie: null });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    seed(h);
    expect((await action(h, 'publish', pairs(['gigId', 'garbage']), { origin: 'http://evil.example' })).status).toBe(403);
    noGigCalls(h);
  });
});

describe('Gig actions: values that are not well-formed for their field type come back as a closed error word, never echoed', () => {
  const VALIDATION = '?error=GIG_VALIDATION_FAILED';
  const cases: Array<[string, Array<[string, string]>]> = [
    ['a price with a decimal point', [['price', '12.50']]],
    ['a negative price', [['price', '-5']]],
    ['a price with text', [['price', '12 dollars']]],
    ['a price with a currency sign', [['price', '$12']]],
    ['a price of 16 digits', [['price', '1234567890123456']]],
    ['a duration with text', [['duration', 'ninety']]],
    ['a duration with a decimal', [['duration', '1.5']]],
    ['a duration of 7 digits', [['duration', '1234567']]],
    ['an integer field with text', [['field.n.rooms', 'three']]],
    ['an integer field with an exponent', [['field.n.rooms', '1e3']]],
    ['an integer field with a decimal', [['field.n.rooms', '3.5']]],
    ['a decimal field with a comma', [['field.d.area', '12,5']]],
    ['a decimal field with 7 fraction digits', [['field.d.area', '1.1234567']]],
    ['a boolean that is neither true nor false', [['field.b.pets', 'yes']]],
    ['an option code with upper case', [['field.e.supplies', 'Provider']]],
    ['an option code with a path', [['field.e.supplies', 'a/b']]],
    [
      'one key with two kinds',
      [
        ['field.n.rooms', '3'],
        ['field.t.rooms', 'x'],
      ],
    ],
    ['a title over the structural ceiling of the contract', [['title', 'x'.repeat(801)]]],
  ];
  it.each(cases)('%s', async (_name, extra) => {
    const h = harness();
    seed(h);
    const base = SAVE.filter(([k]) => !extra.some(([e]) => e === k));
    const res = await action(h, 'save', pairs(...base, ...extra));
    expectTo(res, `/provider/gigs/${GIG}`, VALIDATION);
    expect(h.fns.updateGigDraft).not.toHaveBeenCalled();
    expect(await seen(res)).not.toContain('dollars');
  });
  it('a form above the size cap is a 400 before anything is parsed or sent, declared or not (chunked bodies declare no length)', async () => {
    const h = harness();
    seed(h);
    const huge = new URLSearchParams(SAVE);
    huge.set('description', 'x'.repeat(1_100_000));
    await expectBadRequest(await action(h, 'save', huge));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 12; i++) c.enqueue(new TextEncoder().encode('a=' + 'x'.repeat(100_000) + '&'));
        c.close();
      },
    });
    await expectBadRequest(await action(h, 'save', stream as unknown as BodyInit, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
    await expectBadRequest(await action(h, 'save', 'x', { headers: { 'content-type': 'text/plain' } }));
    expect(h.fns.updateGigDraft).not.toHaveBeenCalled();
  });
  it('accepts the edges: a price at the ceiling (10^12 minor units), a duration of 6 digits, a negative integer, a decimal with 6 fraction digits', async () => {
    const h = harness();
    seed(h);
    expectTo(
      await action(h, 'save', pairs(...SAVE, ['price', '1000000000000'], ['duration', '100000'], ['field.n.offset', '-3'], ['field.d.area', '-0.123456'])),
      `/provider/gigs/${GIG}`,
      '?notice=saved',
    );
    expect(lastBody(h)).toMatchObject({ priceAmountMinor: 1000000000000, durationMinutes: 100000 });
  });
  it('a price above the ceiling or the safe integer range is a validation error (never a rounded number)', async () => {
    const h = harness();
    seed(h);
    expectTo(await action(h, 'save', pairs(...SAVE, ['price', '999999999999'])), `/provider/gigs/${GIG}`, '?notice=saved');
    h.fns.updateGigDraft.mockClear();
    expectTo(await action(h, 'save', pairs(...SAVE, ['price', '1000000000001'])), `/provider/gigs/${GIG}`, '?error=GIG_VALIDATION_FAILED');
    expectTo(await action(h, 'save', pairs(...SAVE, ['price', '9007199254740993'])), `/provider/gigs/${GIG}`, '?error=GIG_VALIDATION_FAILED');
    expect(h.fns.updateGigDraft).not.toHaveBeenCalled();
  });
});

describe('Gig actions: what the API can answer', () => {
  it.each(GIG_ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
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
    expect(h.logs.join('\n')).not.toContain('gig action refused');
  });
  it.each(GIG_ACTIONS)('%s: every Gig code of the API comes back as ?error=GIG_<code>, and the session stays', async (name) => {
    const h = harness();
    seed(h);
    for (const code of GIG_ERROR_CODES) {
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, gigWireCode(code)));
      expectTo(await action(h, name), ERROR_TARGET[name], `?error=${gigWireCode(code)}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(GIG_ACTIONS)('%s: no step-up is required (a STEP_UP_REQUIRED is just an error, never a login round trip)', async (name) => {
    const h = harness();
    seed(h);
    h.fns[FN[name]].mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
    expectTo(await action(h, name), ERROR_TARGET[name], '?error=API_ERROR');
    expect(h.store.sessions.size).toBe(1);
  });
  it('a code outside the closed list, an unreachable API or a non-API error is reduced to API_ERROR (never echoed)', async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      apiError(403, 'ACCOUNT_SUSPENDED'),
      apiError(400, 'VALIDATION_FAILED'), // without the GIG_ prefix it is not the Gig API's code
      apiError(409, 'STALE_DRAFT'),
      apiError(500, 'GIG_UNKNOWN_THING'),
      apiError(500, 'gig_unavailable'),
      apiError(500, 'weird code with spaces'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
      apiError(500, 'GIG_UNAVAILABLE&x=1'),
      new Error('internal detail'),
    ]) {
      h.fns.retireGig.mockRejectedValueOnce(failure);
      const res = await action(h, 'retire');
      expectTo(res, `/provider/gigs/${GIG}`, '?error=API_ERROR');
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('no redirect, header, cookie or log line carries the provider text, a price, a template code or a token', async () => {
    const h = harness();
    seed(h);
    const SECRET_TITLE = 'Zebra-Zorro-Title-8841';
    const SECRET_PITCH = 'Quokka-Pitch-7712';
    const SECRET_DESC = 'Marmot-Description-5503';
    const SECRET_FIELD = 'Ocelot-Note-3390';
    const SECRET_TEMPLATE = 'zz_secret_template';
    const body = pairs(
      ['gigId', GIG],
      ['expectedRevision', '987654321'],
      ['title', SECRET_TITLE],
      ['shortPitch', SECRET_PITCH],
      ['description', SECRET_DESC],
      ['price', '424242'],
      ['field.t.notes', SECRET_FIELD],
    );
    const results: Response[] = [];
    results.push(await action(h, 'save', body));
    h.fns.updateGigDraft.mockRejectedValueOnce(
      apiError(422, 'GIG_PUBLISH_BLOCKED', { title: SECRET_TITLE, issues: [{ target: 'title', reason: 'TITLE_TOO_LONG' }] }),
    );
    results.push(await action(h, 'save', body));
    h.fns.updateGigDraft.mockRejectedValueOnce(apiError(500, 'something odd', { description: SECRET_DESC }));
    results.push(await action(h, 'save', body));
    results.push(await action(h, 'save', pairs(...SAVE, ['title', SECRET_TITLE], ['price', 'ninety-nine-424242'])));
    results.push(await action(h, 'create', pairs(['gigTemplateCode', SECRET_TEMPLATE], ['clientRequestId', REQUEST_ID])));
    h.fns.createGig.mockRejectedValueOnce(apiError(409, 'GIG_TEMPLATE_NOT_AVAILABLE', { gigTemplateCode: SECRET_TEMPLATE }));
    results.push(await action(h, 'create', pairs(['gigTemplateCode', SECRET_TEMPLATE], ['clientRequestId', REQUEST_ID])));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of [
        SECRET_TITLE,
        SECRET_PITCH,
        SECRET_DESC,
        SECRET_FIELD,
        SECRET_TEMPLATE,
        '987654321',
        '424242',
        REQUEST_ID,
        TOKENS.access,
        TOKENS.refresh,
        TOKENS.id,
        'sid-1',
        'user-1',
      ])
        expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    for (const marker of [
      SECRET_TITLE,
      SECRET_PITCH,
      SECRET_DESC,
      SECRET_FIELD,
      SECRET_TEMPLATE,
      '987654321',
      '424242',
      REQUEST_ID,
      TOKENS.access,
      TOKENS.refresh,
      TOKENS.id,
      'user-1',
    ])
      expect(logs).not.toContain(marker);
  });
  it('save: a 400 GIG_VALIDATION_FAILED that names an issue passes ONE closed reason and target (never typed text); anything else is dropped', async () => {
    const h = harness();
    seed(h);
    const refused = (issues: unknown[]) => new ApiError(400, 'GIG_VALIDATION_FAILED', 'VALIDATION', 'x', 'corr-1', { issues });
    h.fns.updateGigDraft.mockRejectedValueOnce(refused([{ target: 'title', reason: 'TITLE_TOO_LONG', messageKey: '' }]));
    expectTo(await action(h, 'save'), `/provider/gigs/${GIG}`, '?error=GIG_VALIDATION_FAILED&issue=TITLE_TOO_LONG&target=title');
    h.fns.updateGigDraft.mockRejectedValueOnce(refused([{ target: 'title', reason: 'Zebra', messageKey: '' }]));
    expectTo(await action(h, 'save'), `/provider/gigs/${GIG}`, '?error=GIG_VALIDATION_FAILED');
    h.fns.updateGigDraft.mockRejectedValueOnce(refused([{ target: 'nowhere', reason: 'TITLE_TOO_LONG', messageKey: '' }]));
    expectTo(await action(h, 'save'), `/provider/gigs/${GIG}`, '?error=GIG_VALIDATION_FAILED');
  });
  it('a refusal is logged with the action, the closed code and the status only', async () => {
    const h = harness();
    seed(h);
    h.fns.publishGig.mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT'));
    await action(h, 'publish');
    h.fns.retireGig.mockRejectedValueOnce(apiError(500, 'something odd'));
    await action(h, 'retire');
    h.fns.createGig.mockRejectedValueOnce(new Error('boom'));
    await action(h, 'create');
    expect(h.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'warn', message: 'gig action refused', action: 'publish', code: 'GIG_STALE_DRAFT', status: 409 },
      { level: 'warn', message: 'gig action refused', action: 'retire', code: 'API_ERROR', status: 500 },
      { level: 'warn', message: 'gig action refused', action: 'create', code: 'API_ERROR' },
    ]);
  });
  it('a success logs nothing', async () => {
    const h = harness();
    seed(h);
    for (const name of GIG_ACTIONS) await action(h, name);
    expect(h.logs).toEqual([]);
  });
  it('the redirect target is fixed: it never depends on the request host, a header or a free field', async () => {
    const h = harness();
    seed(h);
    const req = new Request('http://evil.example/auth/provider/gigs/retire?returnTo=http://evil.example&next=//evil.example', {
      method: 'POST',
      headers: { origin: PUBLIC, cookie: SESSION_COOKIE, host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
      body: pairs(['gigId', GIG]),
    });
    expectTo(await handleGigAction(req, h.deps, 'retire'), `/provider/gigs/${GIG}`, '?notice=retired');
  });
  it('every 303 target of every outcome is below the web public URL /provider/gigs', async () => {
    const h = harness();
    seed(h);
    const locations: string[] = [];
    for (const name of GIG_ACTIONS) {
      locations.push((await action(h, name)).headers.get('location')!);
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, 'GIG_CONFLICT'));
      locations.push((await action(h, name)).headers.get('location')!);
    }
    expect(locations).toHaveLength(10);
    for (const l of locations) expect(l.startsWith(`${PUBLIC}/provider/gigs`), l).toBe(true);
    for (const l of locations) expect(l).toMatch(new RegExp(`^${PUBLIC.replace(/\./g, '\\.')}/provider/gigs(/${GIG})?\\?(notice|error)=[a-z_A-Z]+$`));
  });
});

describe('the Next route module for /auth/provider/gigs/<action>', () => {
  it('delegates each known action to the handler with the process-wide deps', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    for (const name of GIG_ACTIONS) {
      const res = await gigPost(post(`/auth/provider/gigs/${name}`, undefined, { body: BODIES[name]() }), { params: Promise.resolve({ action: name }) });
      expect(res.headers.get('location'), name).toBe(`${PUBLIC}${TARGET[name]}${OK_QUERY[name]}`);
    }
    expect(routeState.calls).toBe(5);
  });
  it('answers an unknown action with 404 without touching the deps, and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'CREATE', 'reactivate', 'constructor', '__proto__', 'create/x']) {
      const res = await gigPost(post('/auth/provider/gigs/x', {}), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = gigGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(routeState.calls).toBe(0);
  });
});
