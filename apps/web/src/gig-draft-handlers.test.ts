// CAT-004 web side, part 2: the BFF half of the variants, add-ons and photos of a Gig draft. The POST handlers behind the editor (variants, add-ons, photo-upload, photo-finish,
// photo-alt, photo-remove, photo-move) and the Next route module in front of them. The API is a fake client factory with spies: what matters is WHICH call is made, with WHAT, that
// nothing but a well-formed form reaches the API (the server decides everything else), that a result is a 303 to a fixed target, that the upload is authorize -> PUT with node:http
// (the global fetch is a spy that must stay unused) -> finalize with a bounded read of the body, and that no provider text, file name, one-time URL, token or hash leaks into a
// redirect, a header, a cookie or a log line.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GIG_ERROR_CODES, GIG_ISSUE_REASONS, GIG_MEDIA_REFUSAL_REASONS, GIG_MEDIA_FILE_CEILING, gigWireCode } from '@bananagig/contracts';
import { GET as gigGet, POST as gigPost } from './app/auth/provider/gigs/[action]/route';
import { ApiError } from './lib/api-client';
import { GIG_DRAFT_ACTIONS, GIG_DRAFT_NOTICES, handleGigDraftAction, isGigDraftAction, type GigDraftAction } from './lib/auth/gig-draft-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { GIG_ID, detailDto, mediaDto, mediaFieldDto, uploadDto, versionDto } from './testing/gig-stub';

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
const apiError = (status: number, code: string): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1');
const GIG = GIG_ID;
const MEDIA = mediaDto(1).mediaId;
const MEDIA_2 = mediaDto(2).mediaId;
const MEDIA_3 = mediaDto(3).mediaId;
const REVISION = 5;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = createHash('sha256').update(PNG).digest('hex');

// ---- the object store: a REAL local HTTP server. The handler PUTs the bytes to the one-time URL from the server with node:http; the global fetch is a spy that must stay unused.
interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  names: string[];
  body: Buffer;
}
const target = {
  server: undefined as http.Server | undefined,
  port: 0,
  received: [] as Received[],
  status: [] as number[],
  sockets: new Set<import('node:net').Socket>(),
};
const UPLOAD_PATH = '/private/provider/gig-media/one-object.upload?X-Signature=ONE-TIME-SIGNATURE-VALUE&X-Expires=900';
const uploadUrl = (): string => `http://127.0.0.1:${target.port}${UPLOAD_PATH}`;
let fetchMock: Mock<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let order: string[] = [];
beforeAll(async () => {
  target.server = http.createServer((req, res) => {
    order.push('PUT');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      target.received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        names: req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()),
        body: Buffer.concat(chunks),
      });
      res.writeHead(target.status.shift() ?? 200, { connection: 'close' });
      res.end();
    });
  });
  target.server.on('connection', (socket) => {
    target.sockets.add(socket);
    socket.on('close', () => target.sockets.delete(socket));
  });
  await new Promise<void>((resolve) => target.server!.listen(0, '127.0.0.1', resolve));
  target.port = (target.server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of target.sockets) s.destroy();
  await new Promise<void>((resolve) => target.server!.close(() => resolve()));
});
beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error('the global fetch must not be used to hand the file to the object store');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  target.received.length = 0;
  target.status.length = 0;
  for (const s of target.sockets) s.destroy();
});

interface Fns {
  setActiveRole: Mock<() => Promise<never>>;
  getGig: Mock<(gigId: string, o?: unknown) => Promise<unknown>>;
  replaceGigVariants: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  replaceGigAddOns: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  requestGigMediaUpload: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  finalizeGigMedia: Mock<(gigId: string, mediaId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  updateGigMedia: Mock<(gigId: string, mediaId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  detachGigMedia: Mock<(gigId: string, mediaId: string, input: unknown, o?: unknown) => Promise<unknown>>;
  reorderGigMedia: Mock<(gigId: string, input: unknown, o?: unknown) => Promise<unknown>>;
}
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
}
/** A draft at revision 5 with three photos of the field `photos` (orders 1..3) and one of `gallery`, in an order that interleaves the fields. */
const draftDetail = (over: Parameters<typeof versionDto>[0] = {}, max = 10_485_760) => {
  const base = versionDto({
    revision: REVISION,
    fields: [mediaFieldDto(), mediaFieldDto({ fieldKey: 'gallery', displayOrder: 21, required: false, minItems: 0 })],
  });
  return detailDto({
    draft: {
      ...base,
      constraints: { ...base.constraints, media: { ...base.constraints.media, maxFileSizeBytes: max } },
      media: [mediaDto(1), mediaDto(4, { fieldKey: 'gallery', displayOrder: 2 }), mediaDto(2, { displayOrder: 3 }), mediaDto(3, { displayOrder: 4 })],
      ...over,
    },
  });
};
function harness(withApi = true): Harness {
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const DETAIL = draftDetail();
  const calls =
    (name: string) =>
    (...args: unknown[]) => {
      order.push(name);
      void args;
    };
  const fns: Fns = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the Gig draft actions');
    }),
    getGig: vi.fn(async () => {
      calls('getGig')();
      return DETAIL;
    }),
    replaceGigVariants: vi.fn(async () => DETAIL),
    replaceGigAddOns: vi.fn(async () => DETAIL),
    requestGigMediaUpload: vi.fn(async () => {
      order.push('requestGigMediaUpload');
      return uploadDto({ upload: { url: uploadUrl(), headers: { 'content-type': 'image/png' }, expiresAt: '2026-10-17T10:00:00.000Z' }, revision: 6 });
    }),
    finalizeGigMedia: vi.fn(async () => {
      order.push('finalizeGigMedia');
      return DETAIL;
    }),
    updateGigMedia: vi.fn(async () => DETAIL),
    detachGigMedia: vi.fn(async () => DETAIL),
    reorderGigMedia: vi.fn(async () => DETAIL),
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
const newHarness = (withApi = true): Harness => {
  order = [];
  return harness(withApi);
};
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

type PostOptions = { method?: string; origin?: string | null; cookie?: string | null; headers?: Record<string, string>; query?: string };
const post = (path: string, body: BodyInit | null, o: PostOptions = {}) => {
  const method = o.method ?? 'POST';
  return new Request(`http://web-app:3000${path}${o.query ?? ''}`, {
    method,
    headers: {
      ...(o.origin === null ? {} : { origin: o.origin ?? PUBLIC }),
      ...(o.cookie === null ? {} : { cookie: o.cookie ?? SESSION_COOKIE }),
      ...o.headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
};
const pairs = (...entries: Array<[string, string]>): URLSearchParams => new URLSearchParams(entries);
const row = (i: number, r: { key?: string; name?: string; description?: string; price?: string; duration?: string } = {}): Array<[string, string]> => [
  ...(r.key !== undefined ? ([[`row.${i}.key`, r.key]] as Array<[string, string]>) : []),
  [`row.${i}.name`, r.name ?? ''],
  [`row.${i}.description`, r.description ?? ''],
  [`row.${i}.price`, r.price ?? ''],
  [`row.${i}.duration`, r.duration ?? ''],
];
const KEY_A = 'opt_aaaaaaaaaaaa';
const KEY_B = 'opt_bbbbbbbbbbbb';
const KEY_C = 'opt_cccccccccccc';
const THREE: Array<[string, string]> = [
  ...row(0, { key: KEY_A, name: 'Small', price: '500', duration: '15' }),
  ...row(1, { key: KEY_B, name: 'Medium', description: 'Two rooms', price: '1000', duration: '30' }),
  ...row(2, { key: KEY_C, name: 'Large', price: '1500', duration: '45' }),
];
const optionsForm = (intent: string, rows: Array<[string, string]> = THREE, over: Array<[string, string]> = []) =>
  pairs(['gigId', GIG], ['expectedRevision', String(REVISION)], ['intent', intent], ...rows, ...over);
const photoForm = (extra: Array<[string, string]> = [], media = MEDIA) =>
  pairs(['gigId', GIG], ['expectedRevision', String(REVISION)], ['mediaId', media], ...extra);
const BODIES: Record<Exclude<GigDraftAction, 'photo-upload'>, () => URLSearchParams> = {
  variants: () => optionsForm('save'),
  'add-ons': () => optionsForm('save'),
  'photo-finish': () => photoForm(),
  'photo-alt': () => photoForm([['altText', 'A bright kitchen']]),
  'photo-remove': () => photoForm(),
  'photo-move': () => photoForm([['direction', 'down']]),
};

const uploadForm = (
  over: {
    expectedRevision?: string | null;
    fieldKey?: string | null;
    altText?: string | null;
    file?: File | null;
    extra?: Array<[string, string | File]>;
  } = {},
): FormData => {
  const fd = new FormData();
  const expectedRevision = over.expectedRevision === undefined ? String(REVISION) : over.expectedRevision;
  const fieldKey = over.fieldKey === undefined ? 'photos' : over.fieldKey;
  const altText = over.altText === undefined ? 'A bright kitchen' : over.altText;
  if (expectedRevision !== null) fd.append('expectedRevision', expectedRevision);
  if (fieldKey !== null) fd.append('fieldKey', fieldKey);
  if (altText !== null) fd.append('altText', altText);
  const file = over.file === undefined ? new File([PNG as BlobPart], 'my-private-kitchen.png', { type: 'image/png' }) : over.file;
  if (file !== null) fd.append('file', file);
  for (const [k, v] of over.extra ?? []) fd.append(k, v);
  return fd;
};

const run = (h: Harness, name: GigDraftAction, body: BodyInit | null, o: PostOptions = {}) =>
  handleGigDraftAction(post(`/auth/provider/gigs/${name}`, body, { query: name === 'photo-upload' ? `?gigId=${GIG}` : '', ...o }), h.deps, name);
const act = (h: Harness, name: Exclude<GigDraftAction, 'photo-upload'>, body: BodyInit | null = BODIES[name](), o: PostOptions = {}) => run(h, name, body, o);
const upload = (h: Harness, body: BodyInit | null = uploadForm(), o: PostOptions = {}) => run(h, 'photo-upload', body, o);
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
const FRAGMENTS = ['#gig-variants', '#gig-add-ons', '#gig-photos'];
/** The 303 back to the Gig: `query` then the section fragment (any of the three, or exactly `fragment` when given). */
const expectTo = (res: Response, query: string, fragment?: string): void => {
  expect(res.status).toBe(303);
  const loc = res.headers.get('location')!;
  const at = loc.indexOf('#');
  expect(at).toBeGreaterThan(0);
  expect(loc.slice(0, at)).toBe(`${PUBLIC}/provider/gigs/${GIG}${query}`);
  expect(fragment === undefined ? FRAGMENTS : [fragment]).toContain(loc.slice(at));
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.body).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};
const expectBadRequest = async (res: Response): Promise<void> => {
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('Bad request');
};
const noCalls = (h: Harness): void => {
  for (const [name, fn] of Object.entries(h.fns)) expect(fn, name).not.toHaveBeenCalled();
};
const variantsBody = (h: Harness) => h.fns.replaceGigVariants.mock.calls.at(-1)![1] as { expectedRevision: number; variants: Array<Record<string, unknown>> };

describe('GIG_DRAFT_ACTIONS', () => {
  it('names exactly the seven actions and the six notice words', () => {
    expect([...GIG_DRAFT_ACTIONS]).toEqual(['variants', 'add-ons', 'photo-upload', 'photo-finish', 'photo-alt', 'photo-remove', 'photo-move']);
    expect([...GIG_DRAFT_NOTICES]).toEqual(['variants_saved', 'add_ons_saved', 'photo_added', 'photo_removed', 'photo_order_saved', 'photo_saved']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of GIG_DRAFT_ACTIONS) expect(isGigDraftAction(a)).toBe(true);
    for (const other of [
      '',
      'save',
      'VARIANTS',
      'add_ons',
      'addons',
      'photo',
      'photo-',
      'photo-upload ',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ])
      expect(isGigDraftAction(other), other).toBe(false);
  });
});

describe('transport and authentication', () => {
  it.each(GIG_DRAFT_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever changes state)', async (name) => {
    const h = newHarness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await run(h, name, null, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noCalls(h);
  });
  it.each(GIG_DRAFT_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF, 403) before it reads anything', async (name) => {
    const h = newHarness();
    seed(h);
    for (const origin of [null, 'null', 'http://evil.example', 'http://app.localhost:9999', 'https://app.localhost:8080', `${PUBLIC}/`, PUBLIC.toUpperCase()]) {
      const res = await run(h, name, name === 'photo-upload' ? uploadForm() : BODIES[name](), { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    noCalls(h);
  });
  it.each(GIG_DRAFT_ACTIONS)('%s: without a session the person is only sent to /session; nothing is read or called', async (name) => {
    const h = newHarness();
    for (const cookie of [null, 'bg_session=unknown', 'other=1']) {
      const res = await run(h, name, name === 'photo-upload' ? uploadForm() : BODIES[name](), { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    }
    noCalls(h);
    expect(target.received).toEqual([]);
  });
  it('refuses to run without an API client, or with one that lacks the calls (wiring errors, not request errors)', async () => {
    const h = newHarness(false);
    seed(h);
    await expect(act(h, 'variants')).rejects.toThrow('AuthDeps.api');
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    await expect(handleGigDraftAction(post('/auth/provider/gigs/variants', BODIES.variants()), bare, 'variants')).rejects.toThrow('Gig draft calls');
  });
  it("sends the session token and the remembered role on every call (the account is the token's, never a field)", async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    await act(h, 'variants');
    await act(h, 'photo-remove');
    expect(h.apiTokens).toEqual([TOKENS.access, TOKENS.access]);
    expect(h.fns.replaceGigVariants.mock.calls[0]![2]).toEqual({ activeRole: 'PROVIDER' });
    expect(h.fns.detachGigMedia.mock.calls[0]![3]).toEqual({ activeRole: 'PROVIDER' });
  });
});

describe('variants and add-ons: the whole-set form', () => {
  it('save: PUTs the whole list in order, existing keys kept, numbers as numbers, blank description null; 303 with "variants_saved"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'variants'), '?notice=variants_saved');
    expect(h.fns.replaceGigVariants).toHaveBeenCalledTimes(1);
    expect(h.fns.replaceGigVariants.mock.calls[0]![0]).toBe(GIG);
    expect(variantsBody(h)).toEqual({
      expectedRevision: REVISION,
      variants: [
        { key: KEY_A, name: 'Small', description: null, priceDeltaMinor: 500, durationDeltaMinutes: 15 },
        { key: KEY_B, name: 'Medium', description: 'Two rooms', priceDeltaMinor: 1000, durationDeltaMinutes: 30 },
        { key: KEY_C, name: 'Large', description: null, priceDeltaMinor: 1500, durationDeltaMinutes: 45 },
      ],
    });
    expect(h.fns.replaceGigAddOns).not.toHaveBeenCalled();
  });
  it('add-ons: the same form goes to replaceGigAddOns with `addOns` and the "add_ons_saved" notice', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'add-ons'), '?notice=add_ons_saved');
    const body = h.fns.replaceGigAddOns.mock.calls[0]![1] as { addOns: unknown[]; variants?: unknown };
    expect(body.addOns).toHaveLength(3);
    expect(body.variants).toBeUndefined();
    expect(h.fns.replaceGigVariants).not.toHaveBeenCalled();
  });
  it('add: a filled "new item" row (no key) is added at the end; the API mints its key', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'variants', optionsForm('add', [...THREE, ...row(3, { name: 'Extra large', price: '2000', duration: '60' })]));
    const list = variantsBody(h).variants;
    expect(list).toHaveLength(4);
    expect(list[3]).toEqual({ name: 'Extra large', description: null, priceDeltaMinor: 2000, durationDeltaMinutes: 60 });
    expect(list[3]).not.toHaveProperty('key');
  });
  it('a blank "new item" row (no key, nothing typed) is dropped on every intent; a blank price or duration means 0', async () => {
    const h = newHarness();
    seed(h);
    for (const intent of ['save', 'add', 'remove:0']) {
      await act(h, 'variants', optionsForm(intent, [...THREE, ...row(3)]));
      expect(variantsBody(h).variants.length, intent).toBe(intent === 'remove:0' ? 2 : 3);
    }
    await act(h, 'variants', optionsForm('save', row(0, { name: 'Only a name' })));
    expect(variantsBody(h).variants).toEqual([{ name: 'Only a name', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 }]);
  });
  it('remove:<i> removes that row (its key leaves the list); up:<i> and down:<i> swap it with its neighbour', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'variants', optionsForm('remove:1'));
    expect(variantsBody(h).variants.map((v) => v.key)).toEqual([KEY_A, KEY_C]);
    await act(h, 'variants', optionsForm('up:1'));
    expect(variantsBody(h).variants.map((v) => v.key)).toEqual([KEY_B, KEY_A, KEY_C]);
    await act(h, 'variants', optionsForm('down:0'));
    expect(variantsBody(h).variants.map((v) => v.key)).toEqual([KEY_B, KEY_A, KEY_C]);
    await act(h, 'variants', optionsForm('down:1'));
    expect(variantsBody(h).variants.map((v) => v.key)).toEqual([KEY_A, KEY_C, KEY_B]);
    await act(h, 'variants', optionsForm('remove:2'));
    expect(variantsBody(h).variants.map((v) => v.key)).toEqual([KEY_A, KEY_B]);
  });
  it('an intent applies to the rows AS SUBMITTED (typed-but-unsaved edits travel with the move)', async () => {
    const h = newHarness();
    seed(h);
    const edited: Array<[string, string]> = [...row(0, { key: KEY_A, name: 'Small (edited)', price: '700' }), ...row(1, { key: KEY_B, name: 'Medium' })];
    await act(h, 'variants', optionsForm('down:0', edited));
    expect(variantsBody(h).variants).toEqual([
      { key: KEY_B, name: 'Medium', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 },
      { key: KEY_A, name: 'Small (edited)', description: null, priceDeltaMinor: 700, durationDeltaMinutes: 0 },
    ]);
  });
  it('removing every row saves an empty list (the revision still travels)', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'variants', optionsForm('remove:0', row(0, { key: KEY_A, name: 'Only' })));
    expect(variantsBody(h)).toEqual({ expectedRevision: REVISION, variants: [] });
  });
  it('accepts 100 rows (the contract ceiling) and refuses a 101st as a malformed form', async () => {
    const h = newHarness();
    seed(h);
    const many = (n: number): Array<[string, string]> => Array.from({ length: n }, (_v, i) => row(i, { name: `n${i}` })).flat();
    expectTo(await act(h, 'variants', optionsForm('save', many(100))), '?notice=variants_saved');
    expect(variantsBody(h).variants).toHaveLength(100);
    await expectBadRequest(await act(h, 'variants', optionsForm('save', many(101))));
    expect(h.fns.replaceGigVariants).toHaveBeenCalledTimes(1);
  });
  it('forged forms are a 400 and change nothing: unknown, repeated, missing, gapped, out-of-range, non-key, file and bad-intent cases', async () => {
    const h = newHarness();
    seed(h);
    const bad: Array<[string, BodyInit]> = [
      ['unknown field', optionsForm('save', THREE, [['accountId', 'x']])],
      ['repeated gigId', optionsForm('save', THREE, [['gigId', GIG]])],
      ['repeated row part', optionsForm('save', THREE, [['row.0.name', 'twice']])],
      ['missing intent', pairs(['gigId', GIG], ['expectedRevision', '5'], ...THREE)],
      ['missing revision', pairs(['gigId', GIG], ['intent', 'save'], ...THREE)],
      ['revision zero', optionsForm('save', THREE).toString().replace('expectedRevision=5', 'expectedRevision=0')],
      ['revision text', optionsForm('save', THREE).toString().replace('expectedRevision=5', 'expectedRevision=five')],
      ['gig id not a uuid', optionsForm('save', THREE).toString().replace(GIG, 'not-a-uuid')],
      [
        'a row without a name part',
        pairs(['gigId', GIG], ['expectedRevision', '5'], ['intent', 'save'], ['row.0.description', ''], ['row.0.price', ''], ['row.0.duration', '']),
      ],
      ['an index gap', optionsForm('save', [...row(0, { name: 'a' }), ...row(2, { name: 'c' })])],
      ['rows not starting at 0', optionsForm('save', row(1, { name: 'a' }))],
      ['a leading zero index', optionsForm('save', row(0, { name: 'a' }), [['row.01.name', 'b']])],
      ['index 100', optionsForm('save', row(100, { name: 'a' }))],
      ['a key that is not a key', optionsForm('save', row(0, { key: 'NOT A KEY', name: 'a' }))],
      ['an unknown row part', optionsForm('save', THREE, [['row.0.currency', 'USD']])],
      ['intent in the wrong case', optionsForm('SAVE')],
      ['intent with a leading zero', optionsForm('remove:01')],
      ['intent without an index', optionsForm('remove')],
      ['unknown intent', optionsForm('publish')],
      ['remove past the rows', optionsForm('remove:3')],
      ['up on the first row', optionsForm('up:0')],
      ['down on the last row', optionsForm('down:2')],
    ];
    for (const [label, body] of bad) {
      const res = await act(h, 'variants', body);
      expect(res.status, label).toBe(400);
      expect(await res.text(), label).toBe('Bad request');
    }
    const fd = new FormData();
    fd.append('gigId', GIG);
    fd.append('expectedRevision', '5');
    fd.append('intent', 'save');
    fd.append('row.0.name', new File(['x'], 'x.txt', { type: 'text/plain' }));
    await expectBadRequest(await act(h, 'variants', fd));
    await expectBadRequest(await act(h, 'variants', 'gigId=1', { headers: { 'content-type': 'text/plain' } }));
    noCalls(h);
  });
  it('at most 500 row fields are read (the ceiling of rows x parts)', async () => {
    const h = newHarness();
    seed(h);
    const extra: Array<[string, string]> = Array.from({ length: 501 }, (_v, i) => [`row.${i % 100}.key`, 'x']);
    await expectBadRequest(await act(h, 'variants', optionsForm('save', THREE, extra)));
    noCalls(h);
  });
  it('a form above the size cap is refused as too large (413) before it is parsed, declared or streamed', async () => {
    const h = newHarness();
    seed(h);
    const huge = optionsForm('save', row(0, { name: 'x'.repeat(1_100_000) }));
    expect((await act(h, 'variants', huge)).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 12; i++) c.enqueue(new TextEncoder().encode('a=' + 'x'.repeat(100_000) + '&'));
        c.close();
      },
    });
    expect((await act(h, 'variants', stream as unknown as BodyInit, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(413);
    noCalls(h);
  });
  it("a price, duration or length that is not acceptable comes back as a NAMED closed reason (with the row's key when it has one) and the typed text is never echoed", async () => {
    const h = newHarness();
    seed(h);
    const price = 'OPTION_PRICE_DELTA_INVALID';
    const duration = 'OPTION_DURATION_DELTA_INVALID';
    for (const [label, rows, reason, item] of [
      ['price text', row(0, { key: KEY_A, name: 'a', price: 'twelve dollars' }), price, KEY_A],
      ['negative price', row(0, { name: 'a', price: '-5' }), price, undefined],
      ['decimal price', row(0, { key: KEY_B, name: 'a', price: '12.50' }), price, KEY_B],
      ['duration text', row(0, { key: KEY_A, name: 'a', duration: '1h' }), duration, KEY_A],
      ['price above 10^12', row(0, { name: 'a', price: '1000000000001' }), price, undefined],
      ['duration above 100000', row(0, { name: 'a', duration: '100001' }), duration, undefined],
      ['name above the form ceiling', row(0, { key: KEY_C, name: 'x'.repeat(801) }), 'OPTION_NAME_TOO_LONG', KEY_C],
      ['description above the form ceiling', row(0, { name: 'a', description: 'y'.repeat(8001) }), 'OPTION_DESCRIPTION_TOO_LONG', undefined],
    ] as Array<[string, Array<[string, string]>, string, string | undefined]>) {
      const res = await act(h, 'variants', optionsForm('save', rows));
      expectTo(res, `?error=GIG_VALIDATION_FAILED&issue=${reason}&target=variants${item ? `&item=${item}` : ''}`, '#gig-variants');
      expect(await seen(res), label).not.toMatch(/twelve|dollars|12\.50|1000000000001|xxxx|yyyy/);
    }
    expectTo(
      await act(h, 'add-ons', optionsForm('save', row(0, { name: 'a', price: 'x' }))),
      `?error=GIG_VALIDATION_FAILED&issue=${price}&target=addOns`,
      '#gig-add-ons',
    );
    expect(h.fns.replaceGigVariants).not.toHaveBeenCalled();
  });
  it('accepts the edges: a price at the ceiling (10^12 minor units) and a duration of 100000 minutes', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'variants', optionsForm('save', row(0, { name: 'a', price: '1000000000000', duration: '100000' }))), '?notice=variants_saved');
    expect(variantsBody(h).variants[0]).toMatchObject({ priceDeltaMinor: 1_000_000_000_000, durationDeltaMinutes: 100_000 });
  });
  it('the provider text goes to the API in the body and NOWHERE else (redirect, headers, cookies, logs)', async () => {
    const h = newHarness();
    seed(h);
    const secret = 'Zebra-name <b>&\'" 日本語';
    const res = await act(h, 'variants', optionsForm('save', row(0, { name: secret, description: `${secret} long text`, price: '777' })));
    expect(variantsBody(h).variants[0]).toMatchObject({ name: secret, description: `${secret} long text` });
    expect(await seen(res)).not.toMatch(/Zebra|777|%E6/);
    h.fns.replaceGigVariants.mockRejectedValueOnce(apiError(400, 'GIG_VALIDATION_FAILED'));
    const refused = await act(h, 'variants', optionsForm('save', row(0, { name: secret })));
    expect(await seen(refused)).not.toContain('Zebra');
    expect(h.logs.join('\n')).not.toMatch(/Zebra|777|tok-/);
  });
});

describe('photo actions on one photo', () => {
  it('photo-finish: finalizes with the revision only; "photo_added"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'photo-finish'), '?notice=photo_added');
    expect(h.fns.finalizeGigMedia.mock.calls[0]!.slice(0, 3)).toEqual([GIG, MEDIA, { expectedRevision: REVISION }]);
  });
  it('photo-remove: detaches with the revision only; "photo_removed"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'photo-remove'), '?notice=photo_removed');
    expect(h.fns.detachGigMedia.mock.calls[0]!.slice(0, 3)).toEqual([GIG, MEDIA, { expectedRevision: REVISION }]);
  });
  it('photo-alt: sends the alt text (blank = null); "photo_saved"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'photo-alt'), '?notice=photo_saved');
    expect(h.fns.updateGigMedia.mock.calls[0]!.slice(0, 3)).toEqual([GIG, MEDIA, { expectedRevision: REVISION, altText: 'A bright kitchen' }]);
    await act(h, 'photo-alt', photoForm([['altText', '   ']]));
    expect(h.fns.updateGigMedia.mock.calls[1]![2]).toEqual({ expectedRevision: REVISION, altText: null });
  });
  it('photo-alt: an alt text above the contract ceiling is a validation error word, never echoed', async () => {
    const h = newHarness();
    seed(h);
    const res = await act(h, 'photo-alt', photoForm([['altText', 'y'.repeat(2001)]]));
    expectTo(res, `?error=GIG_VALIDATION_FAILED&issue=MEDIA_ALT_TOO_LONG&target=media&item=${MEDIA}`, '#gig-photos');
    expect(await seen(res)).not.toContain('yyyy');
    expect(h.fns.updateGigMedia).not.toHaveBeenCalled();
  });
  it('ids in upper case are sent in canonical lower case', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'photo-remove', pairs(['gigId', GIG.toUpperCase()], ['expectedRevision', '5'], ['mediaId', MEDIA.toUpperCase()]));
    expect(h.fns.detachGigMedia.mock.calls[0]!.slice(0, 2)).toEqual([GIG, MEDIA]);
  });
  it('forged forms are a 400 and call nothing: extra, repeated or missing fields, bad ids, bad revisions, bad directions', async () => {
    const h = newHarness();
    seed(h);
    const cases: Array<[Exclude<GigDraftAction, 'photo-upload' | 'variants' | 'add-ons'>, BodyInit]> = [
      ['photo-finish', photoForm([['sha256', SHA]])],
      ['photo-finish', pairs(['gigId', GIG], ['expectedRevision', '5'])],
      ['photo-finish', pairs(['gigId', GIG], ['mediaId', MEDIA])],
      ['photo-finish', photoForm([['mediaId', MEDIA]])],
      ['photo-remove', photoForm([], 'not-a-uuid')],
      ['photo-remove', pairs(['gigId', 'nope'], ['expectedRevision', '5'], ['mediaId', MEDIA])],
      ['photo-remove', pairs(['gigId', GIG], ['expectedRevision', '0'], ['mediaId', MEDIA])],
      ['photo-remove', pairs(['gigId', GIG], ['expectedRevision', '1000000000'], ['mediaId', MEDIA])],
      ['photo-alt', photoForm()],
      [
        'photo-alt',
        photoForm([
          ['altText', 'a'],
          ['altText', 'b'],
        ]),
      ],
      ['photo-move', photoForm()],
      ['photo-move', photoForm([['direction', 'sideways']])],
      ['photo-move', photoForm([['direction', 'UP']])],
      [
        'photo-move',
        photoForm([
          ['direction', 'up'],
          ['direction', 'down'],
        ]),
      ],
    ];
    for (const [name, body] of cases) await expectBadRequest(await act(h, name, body));
    noCalls(h);
  });
  it('a file in a text field is a 400', async () => {
    const h = newHarness();
    seed(h);
    const fd = new FormData();
    fd.append('gigId', GIG);
    fd.append('expectedRevision', '5');
    fd.append('mediaId', new File(['x'], 'x.png', { type: 'image/png' }));
    await expectBadRequest(await act(h, 'photo-remove', fd));
    noCalls(h);
  });
});

describe("photo-move: the order is computed from the server's own list", () => {
  const orderSent = (h: Harness): { expectedRevision: number; mediaIds: string[] } =>
    h.fns.reorderGigMedia.mock.calls.at(-1)![1] as { expectedRevision: number; mediaIds: string[] };
  // global order: MEDIA(1,photos), mediaDto(4)=gallery, MEDIA_2(photos), MEDIA_3(photos)
  const GALLERY = mediaDto(4).mediaId;
  it('down: swaps with the next photo of the SAME field (the gallery photo in between keeps its place); "photo_order_saved"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'down']])), '?notice=photo_order_saved');
    expect(h.fns.getGig).toHaveBeenCalledTimes(1);
    expect(orderSent(h)).toEqual({ expectedRevision: REVISION, mediaIds: [MEDIA_2, GALLERY, MEDIA, MEDIA_3] });
    expect(h.fns.reorderGigMedia.mock.calls[0]![0]).toBe(GIG);
  });
  it('up: swaps with the previous photo of the same field', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'photo-move', photoForm([['direction', 'up']], MEDIA_3));
    expect(orderSent(h).mediaIds).toEqual([MEDIA, GALLERY, MEDIA_3, MEDIA_2]);
  });
  it('a move off either end of its field, a photo that is not in the draft, a stale revision and a missing draft are closed error words and send no order', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'up']])), '?error=GIG_MEDIA_REFUSED');
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'down']], MEDIA_3)), '?error=GIG_MEDIA_REFUSED');
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'up']], GALLERY)), '?error=GIG_MEDIA_REFUSED');
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'up']], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')), '?error=GIG_MEDIA_NOT_FOUND');
    expectTo(await act(h, 'photo-move', pairs(['gigId', GIG], ['expectedRevision', '4'], ['mediaId', MEDIA], ['direction', 'down'])), '?error=GIG_STALE_DRAFT');
    h.fns.getGig.mockResolvedValueOnce(detailDto({ current: null, draft: null }));
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'down']])), '?error=GIG_NO_DRAFT');
    expect(h.fns.reorderGigMedia).not.toHaveBeenCalled();
  });
  it('an API error on the read or on the reorder is reported with its closed word', async () => {
    const h = newHarness();
    seed(h);
    h.fns.getGig.mockRejectedValueOnce(apiError(404, 'GIG_NOT_FOUND'));
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'down']])), '?error=GIG_NOT_FOUND');
    h.fns.reorderGigMedia.mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT'));
    expectTo(await act(h, 'photo-move', photoForm([['direction', 'down']])), '?error=GIG_STALE_DRAFT');
  });
});

describe('what the API can answer', () => {
  const NAMES = ['variants', 'add-ons', 'photo-finish', 'photo-alt', 'photo-remove'] as const;
  const FN: Record<(typeof NAMES)[number], 'replaceGigVariants' | 'replaceGigAddOns' | 'finalizeGigMedia' | 'updateGigMedia' | 'detachGigMedia'> = {
    variants: 'replaceGigVariants',
    'add-ons': 'replaceGigAddOns',
    'photo-finish': 'finalizeGigMedia',
    'photo-alt': 'updateGigMedia',
    'photo-remove': 'detachGigMedia',
  };
  it.each(NAMES)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
    const h = newHarness();
    seed(h);
    h.fns[FN[name]].mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await act(h, name);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(loc.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/session?error=session_revoked`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
  });
  it.each(NAMES)('%s: every Gig code of the API comes back as ?error=GIG_<code>, and the session stays', async (name) => {
    const h = newHarness();
    seed(h);
    for (const code of GIG_ERROR_CODES) {
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, gigWireCode(code)));
      expectTo(await act(h, name), `?error=${gigWireCode(code)}`);
    }
    expect(h.store.sessions.size).toBe(1);
  });
  it.each(NAMES)('%s: a code outside the closed list, an unreachable API or a non-API error is reduced to API_ERROR', async (name) => {
    const h = newHarness();
    seed(h);
    for (const err of [apiError(500, 'SOMETHING_NEW'), apiError(0, 'API_UNREACHABLE'), apiError(404, 'GIG_SECRET_CODE_Zebra'), new Error('boom Zebra')]) {
      h.fns[FN[name]].mockRejectedValueOnce(err);
      const res = await act(h, name);
      expectTo(res, '?error=API_ERROR');
      expect(await seen(res)).not.toContain('Zebra');
    }
  });
  it('a refusal is logged with the action, the closed code and the status only; a success logs nothing', async () => {
    const h = newHarness();
    seed(h);
    await act(h, 'variants');
    expect(h.logs).toEqual([]);
    h.fns.replaceGigVariants.mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT'));
    await act(h, 'variants', optionsForm('save', row(0, { name: 'Zebra' })));
    expect(h.logs.map((l) => JSON.parse(l))).toEqual([
      { level: 'warn', message: 'gig draft action refused', action: 'variants', code: 'GIG_STALE_DRAFT', status: 409 },
    ]);
  });
  it('the redirect target is fixed: it never depends on the request host or a header', async () => {
    const h = newHarness();
    seed(h);
    const res = await run(h, 'photo-remove', BODIES['photo-remove'](), {
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
    });
    expectTo(res, '?notice=photo_removed');
  });
});

describe('the upload: authorize, hand the bytes to the object store with node:http, finalize', () => {
  it('runs the three steps in this order and says "photo_added"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await upload(h), '?notice=photo_added');
    expect(order).toEqual(['getGig', 'requestGigMediaUpload', 'PUT', 'finalizeGigMedia']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("authorizes with the revision, the field, the file's own type and size, its SHA-256 and the alt text; nothing else (no name, no account, no version)", async () => {
    const h = newHarness();
    seed(h);
    await upload(h);
    expect(h.fns.requestGigMediaUpload.mock.calls[0]).toEqual([
      GIG,
      { expectedRevision: REVISION, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: PNG.byteLength, sha256: SHA, altText: 'A bright kitchen' },
      { activeRole: undefined },
    ]);
    expect(JSON.stringify(h.fns.requestGigMediaUpload.mock.calls[0])).not.toContain('my-private-kitchen');
  });
  it('a blank alt text is sent as null', async () => {
    const h = newHarness();
    seed(h);
    await upload(h, uploadForm({ altText: '  ' }));
    expect((h.fns.requestGigMediaUpload.mock.calls[0]![1] as { altText: unknown }).altText).toBeNull();
  });
  it('step 2 PUTs the exact bytes to the authorized URL (path and signature untouched) with the signed content type and the length, and never through the global fetch', async () => {
    const h = newHarness();
    seed(h);
    await upload(h);
    expect(target.received).toHaveLength(1);
    const r = target.received[0]!;
    expect(r.method).toBe('PUT');
    expect(r.url).toBe(UPLOAD_PATH);
    expect(Buffer.compare(r.body, Buffer.from(PNG))).toBe(0);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-length']).toBe(String(PNG.byteLength));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('the PUT carries no session cookie, token, correlation or role header; extra signed headers pass, forbidden ones (authorization, cookie, host, framing) are dropped', async () => {
    const h = newHarness();
    seed(h, { activeRole: 'PROVIDER' });
    h.fns.requestGigMediaUpload.mockImplementationOnce(async () => {
      order.push('requestGigMediaUpload');
      return uploadDto({
        upload: {
          url: uploadUrl(),
          headers: {
            'content-type': 'image/png',
            'x-amz-meta-purpose': 'gig-media',
            'x-amz-checksum-sha256': 'abc=',
            Authorization: 'Bearer leak',
            cookie: 'bg_session=leak',
            host: 'evil.example',
            'transfer-encoding': 'chunked',
            'bad header': 'x',
            'x-injected': 'a\r\nb: c',
          },
          expiresAt: '2026-10-17T10:00:00.000Z',
        },
        revision: 6,
      });
    });
    await upload(h, uploadForm(), { headers: { 'x-correlation-id': 'corr-123', 'x-active-role': 'PROVIDER' } });
    const r = target.received[0]!;
    expect(r.headers['x-amz-meta-purpose']).toBe('gig-media');
    expect(r.headers['x-amz-checksum-sha256']).toBe('abc=');
    for (const bad of ['authorization', 'cookie', 'x-correlation-id', 'x-active-role', 'x-injected', 'bad header', 'origin', 'referer'])
      expect(r.names, bad).not.toContain(bad);
    expect(r.headers.host).not.toBe('evil.example');
    expect(r.headers['transfer-encoding']).toBeUndefined();
    expect(JSON.stringify(r.headers)).not.toMatch(/leak|tok-|SECRET/);
  });
  it('step 3 finalizes the media the API reserved at the revision AFTER the reservation, with the same SHA-256', async () => {
    const h = newHarness();
    seed(h);
    await upload(h);
    expect(h.fns.finalizeGigMedia.mock.calls[0]!.slice(0, 3)).toEqual([GIG, uploadDto().media.mediaId, { expectedRevision: 6, sha256: SHA }]);
  });
  it('the authorization is asked for the CURRENT draft\'s size bound before the body is read: no draft = "no draft", nothing is read or sent', async () => {
    const h = newHarness();
    seed(h);
    h.fns.getGig.mockResolvedValueOnce(detailDto({ current: null, draft: null }));
    expectTo(await upload(h), '?error=GIG_NO_DRAFT');
    h.fns.getGig.mockRejectedValueOnce(apiError(404, 'GIG_NOT_FOUND'));
    expectTo(await upload(h), '?error=GIG_NOT_FOUND');
    expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });
  it('the gigId is read from the query only: it must be a UUID, present once, and the only query parameter', async () => {
    const h = newHarness();
    seed(h);
    for (const query of ['', '?gigId=nope', `?gigId=${GIG}&gigId=${GIG}`, `?gigId=${GIG}&x=1`, `?x=1`, `?gigId=`]) {
      await expectBadRequest(await upload(h, uploadForm(), { query }));
    }
    noCalls(h);
    expectTo(await upload(h, uploadForm(), { query: `?gigId=${GIG.toUpperCase()}` }), '?notice=photo_added');
  });
  it('forged upload forms are a 400 before anything is sent: extra, repeated, missing fields, two files, no file, an empty file, a bad field key or revision', async () => {
    const h = newHarness();
    seed(h);
    const two = uploadForm();
    two.append('file', new File([PNG as BlobPart], 'b.png', { type: 'image/png' }));
    const dupField = uploadForm();
    dupField.append('fieldKey', 'photos');
    const cases: Array<[string, BodyInit]> = [
      ['extra field', uploadForm({ extra: [['accountId', 'x']] })],
      ['gigId in the body', uploadForm({ extra: [['gigId', GIG]] })],
      ['two files', two],
      ['repeated field', dupField],
      ['no file', uploadForm({ file: null })],
      ['missing revision', uploadForm({ expectedRevision: null })],
      ['missing field key', uploadForm({ fieldKey: null })],
      ['missing alt text', uploadForm({ altText: null })],
      ['revision text', uploadForm({ expectedRevision: 'five' })],
      ['field key in upper case', uploadForm({ fieldKey: 'Photos' })],
      ['field key with a slash', uploadForm({ fieldKey: 'photos/../x' })],
      ['text where the file belongs', uploadForm({ file: null, extra: [['file', 'not a file']] })],
      ['a file where the alt text belongs', uploadForm({ altText: null, extra: [['altText', new File(['x'], 'a.txt')]] })],
    ];
    for (const [label, body] of cases) {
      const res = await upload(h, body);
      expect(res.status, label).toBe(400);
    }
    await expectBadRequest(await upload(h, pairs(['expectedRevision', '5']))); // urlencoded is not an upload
    await expectBadRequest(await upload(h, 'x', { headers: { 'content-type': 'text/plain' } }));
    expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });
  it('an absurd type is "refused" without asking the API; any other type is the API\'s decision', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await upload(h, uploadForm({ file: new File([PNG as BlobPart], 'x', { type: `image/${'a'.repeat(120)}` }) })), '?error=GIG_MEDIA_REFUSED');
    expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
    h.fns.requestGigMediaUpload.mockRejectedValueOnce(apiError(400, 'GIG_MEDIA_REFUSED'));
    expectTo(await upload(h, uploadForm({ file: new File([PNG as BlobPart], 'x.svg', { type: 'image/svg+xml' }) })), '?error=GIG_MEDIA_REFUSED');
    expect((h.fns.requestGigMediaUpload.mock.calls[0]![1] as { mimeType: string }).mimeType).toBe('image/svg+xml');
    expect(target.received).toEqual([]);
  });
  it('an alt text above the contract ceiling is a validation error word, never echoed', async () => {
    const h = newHarness();
    seed(h);
    const res = await upload(h, uploadForm({ altText: 'y'.repeat(2001) }));
    expectTo(res, '?error=GIG_VALIDATION_FAILED&issue=MEDIA_ALT_TOO_LONG&target=media', '#gig-photos');
    expect(await seen(res)).not.toContain('yyyy');
  });

  describe('the body is drained up to the STRUCTURAL ceiling and the configured maximum is applied to the file', () => {
    it('a declared length above the structural ceiling is a 413 before anything is asked of the API', async () => {
      const h = newHarness();
      seed(h);
      const res = await upload(h, uploadForm(), { headers: { 'content-length': String(GIG_MEDIA_FILE_CEILING + 65_536 + 1) } });
      expect(res.status).toBe(413);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('Payload too large');
      noCalls(h);
    });
    it('a file above THIS draft\'s maximum but inside the structural ceiling is read to its end and answered with a 303 "refused" (never a raw 413 / reset); nothing is authorized or sent', async () => {
      const h = newHarness();
      seed(h);
      h.fns.getGig.mockResolvedValue(draftDetail({}, 1000));
      const big = new File([new Uint8Array(300_000)], 'big-private-name.png', { type: 'image/png' });
      const res = await upload(h, uploadForm({ file: big }));
      expectTo(res, '?error=GIG_MEDIA_REFUSED', '#gig-photos');
      expect(await seen(res)).not.toContain('big-private-name');
      expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
      expect(target.received).toEqual([]);
    });
    it('a file exactly at the maximum is accepted, one byte above is refused here', async () => {
      const h = newHarness();
      seed(h);
      h.fns.getGig.mockResolvedValue(draftDetail({}, PNG.byteLength));
      expectTo(await upload(h), '?notice=photo_added', '#gig-photos');
      h.fns.getGig.mockResolvedValue(draftDetail({}, PNG.byteLength - 1));
      expectTo(await upload(h), '?error=GIG_MEDIA_REFUSED', '#gig-photos');
      expect(target.received).toHaveLength(1);
    });
    it('a chunked body (no declared length) is cancelled once it exceeds the structural ceiling: later chunks are never pulled, answer 413', async () => {
      const h = newHarness();
      seed(h);
      let pulled = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1_048_576));
          if (pulled > 80) c.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = await upload(h, stream as unknown as BodyInit, { headers: { 'content-type': 'multipart/form-data; boundary=zzz' } });
      expect(res.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThan(40);
      expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
    });
    it('no file chosen (the browser sends an empty file part) is a 303 with the "refused" word, not a bare 400; a form with no file PART at all is still a 400', async () => {
      const h = newHarness();
      seed(h);
      // what a browser really posts for an untouched file input: a file part with `filename=""` and no bytes
      const part = (name: string, value: string): string => `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      const raw = `${part('expectedRevision', '5')}${part('fieldKey', 'photos')}${part('altText', '')}--B\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--B--\r\n`;
      const res = await upload(h, raw, { headers: { 'content-type': 'multipart/form-data; boundary=B' } });
      expectTo(res, '?error=GIG_MEDIA_REFUSED', '#gig-photos');
      expect(h.fns.requestGigMediaUpload).not.toHaveBeenCalled();
      expect((await upload(h, uploadForm({ file: null }))).status).toBe(400);
    });
  });

  describe('a hand-over that cannot be completed', () => {
    const refused = async (h: Harness, res: Response): Promise<void> => {
      expectTo(res, '?error=GIG_UNAVAILABLE');
      expect(h.fns.finalizeGigMedia).not.toHaveBeenCalled();
      const everything = [await seen(res), ...h.logs].join('\n');
      expect(everything).not.toMatch(/ONE-TIME|X-Signature|my-private|\/private\/|127\.0\.0\.1/);
    };
    it.each([403, 500])('a %s from the object store is reported as unavailable, never finalized, and logged with the status only', async (status) => {
      const h = newHarness();
      seed(h);
      target.status.push(status);
      await refused(h, await upload(h));
      expect(h.logs.map((l) => JSON.parse(l))).toEqual([{ level: 'warn', message: 'gig media hand-over refused', action: 'photo-upload', status }]);
    });
    it('a port nobody listens on, an unparseable URL and a URL that is not http(s) are status 0', async () => {
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      for (const url of [`http://127.0.0.1:${port}/x?X-Signature=ONE-TIME`, 'not a url', 'ftp://example.test/x?sig=ONE-TIME', 'file:///etc/passwd']) {
        const h = newHarness();
        seed(h);
        h.fns.requestGigMediaUpload.mockResolvedValueOnce(uploadDto({ upload: { url, headers: {}, expiresAt: '2026-10-17T10:00:00.000Z' } }));
        await refused(h, await upload(h));
        expect(h.logs.map((l) => JSON.parse(l))[0]).toMatchObject({ status: 0 });
      }
    });
    it('an https URL uses the https client (here it cannot talk TLS to the plain server: a refusal, not a plain-text PUT)', async () => {
      const h = newHarness();
      seed(h);
      h.fns.requestGigMediaUpload.mockResolvedValueOnce(
        uploadDto({ upload: { url: `https://127.0.0.1:${target.port}${UPLOAD_PATH}`, headers: {}, expiresAt: '2026-10-17T10:00:00.000Z' } }),
      );
      await refused(h, await upload(h));
      expect(target.received).toEqual([]);
    });
  });

  it('an API error at authorize or at finalize is its closed word; a revoked session ends the session; the URL and the hash never reach a redirect or a log', async () => {
    const h = newHarness();
    seed(h);
    for (const code of ['GIG_STALE_DRAFT', 'GIG_MEDIA_REFUSED', 'GIG_MEDIA_EXPIRED', 'GIG_MEDIA_SCAN_UNAVAILABLE', 'GIG_LIMIT_REACHED']) {
      h.fns.finalizeGigMedia.mockRejectedValueOnce(apiError(409, code));
      const res = await upload(h);
      expectTo(res, `?error=${code}`);
      expect([await seen(res), ...h.logs].join('\n')).not.toMatch(new RegExp(`ONE-TIME|${SHA}|my-private`));
    }
    h.fns.requestGigMediaUpload.mockRejectedValueOnce(apiError(400, 'SOMETHING_ELSE'));
    expectTo(await upload(h), '?error=API_ERROR');
    h.fns.finalizeGigMedia.mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const revoked = await upload(h);
    expect(new URL(revoked.headers.get('location')!).origin + new URL(revoked.headers.get('location')!).pathname).toBe(cfg.endpoints.endSession);
    expect(h.store.sessions.size).toBe(0);
  });
  it("nothing the person uploaded or the store signed reaches the answer: not the file name, the bytes' hash, the URL or its signature", async () => {
    const h = newHarness();
    seed(h);
    const res = await upload(h);
    expect(await seen(res)).not.toMatch(/my-private|kitchen|ONE-TIME|X-Signature|X-Expires|127\.0\.0\.1/);
    expect(h.logs).toEqual([]);
  });
});

describe('where the redirect lands (section fragments)', () => {
  const FRAGMENT_OF: Record<GigDraftAction, string> = {
    variants: '#gig-variants',
    'add-ons': '#gig-add-ons',
    'photo-upload': '#gig-photos',
    'photo-finish': '#gig-photos',
    'photo-alt': '#gig-photos',
    'photo-remove': '#gig-photos',
    'photo-move': '#gig-photos',
  };
  it.each(GIG_DRAFT_ACTIONS)('%s: success and failure both end in its own section', async (name) => {
    const h = newHarness();
    seed(h);
    const body = () => (name === 'photo-upload' ? uploadForm() : BODIES[name]());
    const ok = await run(h, name, body(), { query: name === 'photo-upload' ? `?gigId=${GIG}` : '' });
    expect(new URL(ok.headers.get('location')!).hash).toBe(FRAGMENT_OF[name]);
    expectTo(
      ok,
      `?notice=${name === 'variants' ? 'variants_saved' : name === 'add-ons' ? 'add_ons_saved' : name === 'photo-upload' || name === 'photo-finish' ? 'photo_added' : name === 'photo-alt' ? 'photo_saved' : name === 'photo-remove' ? 'photo_removed' : 'photo_order_saved'}`,
      FRAGMENT_OF[name],
    );
    const failing: Record<GigDraftAction, Mock<(...a: never[]) => Promise<unknown>>> = {
      variants: h.fns.replaceGigVariants as never,
      'add-ons': h.fns.replaceGigAddOns as never,
      'photo-upload': h.fns.finalizeGigMedia as never,
      'photo-finish': h.fns.finalizeGigMedia as never,
      'photo-alt': h.fns.updateGigMedia as never,
      'photo-remove': h.fns.detachGigMedia as never,
      'photo-move': h.fns.reorderGigMedia as never,
    };
    failing[name].mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT') as never);
    expectTo(await run(h, name, body(), { query: name === 'photo-upload' ? `?gigId=${GIG}` : '' }), '?error=GIG_STALE_DRAFT', FRAGMENT_OF[name]);
  });
  it('a revoked session still leaves through Keycloak (no fragment, no gig path)', async () => {
    const h = newHarness();
    seed(h);
    h.fns.replaceGigVariants.mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await act(h, 'variants');
    expect(res.headers.get('location')).toContain(cfg.endpoints.endSession);
    expect(res.headers.get('location')).not.toContain('#gig-');
  });
});

describe('"Add" with nothing typed', () => {
  it('saves what else was typed but claims nothing: no notice, back to the section', async () => {
    const h = newHarness();
    seed(h);
    const res = await act(h, 'variants', optionsForm('add', [...THREE, ...row(3)]));
    expectTo(res, '', '#gig-variants');
    expect(res.headers.get('location')).toBe(`${PUBLIC}/provider/gigs/${GIG}#gig-variants`);
    expect(variantsBody(h).variants).toHaveLength(3);
    const addOns = await act(h, 'add-ons', optionsForm('add', [...THREE, ...row(3)]));
    expect(addOns.headers.get('location')).toBe(`${PUBLIC}/provider/gigs/${GIG}#gig-add-ons`);
  });
  it('a filled new row IS added with the "saved" notice; Save with a blank new row still says "saved"', async () => {
    const h = newHarness();
    seed(h);
    expectTo(await act(h, 'variants', optionsForm('add', [...THREE, ...row(3, { name: 'New' })])), '?notice=variants_saved', '#gig-variants');
    expectTo(await act(h, 'variants', optionsForm('save', [...THREE, ...row(3)])), '?notice=variants_saved', '#gig-variants');
  });
  it('an API refusal of such an Add is still reported', async () => {
    const h = newHarness();
    seed(h);
    h.fns.replaceGigVariants.mockRejectedValueOnce(apiError(409, 'GIG_STALE_DRAFT'));
    expectTo(await act(h, 'variants', optionsForm('add', [...THREE, ...row(3)])), '?error=GIG_STALE_DRAFT', '#gig-variants');
  });
});

describe('a refused value names the problem (closed reason, safe item)', () => {
  const validation = (issues: unknown[]): ApiError => new ApiError(400, 'GIG_VALIDATION_FAILED', 'VALIDATION', 'x', 'corr-1', { issues });
  const issue = (reason: string, target: string, itemKey?: string) => ({ target, reason, ...(itemKey ? { itemKey } : {}), messageKey: '' });
  it('passes the first issue whose reason and target are on the closed lists, with the item key', async () => {
    const h = newHarness();
    seed(h);
    h.fns.replaceGigVariants.mockRejectedValueOnce(
      validation([issue('NOT_A_REASON', 'variants'), issue('OPTION_NAME_DUPLICATE', 'variants', KEY_B), issue('OPTION_NAME_REQUIRED', 'variants', KEY_A)]),
    );
    expectTo(await act(h, 'variants'), `?error=GIG_VALIDATION_FAILED&issue=OPTION_NAME_DUPLICATE&target=variants&item=${KEY_B}`, '#gig-variants');
  });
  it('every reason of the contract passes; nothing else does', async () => {
    const h = newHarness();
    seed(h);
    for (const reason of GIG_ISSUE_REASONS) {
      h.fns.replaceGigAddOns.mockRejectedValueOnce(validation([issue(reason, 'addOns')]));
      expectTo(await act(h, 'add-ons'), `?error=GIG_VALIDATION_FAILED&issue=${reason}&target=addOns`, '#gig-add-ons');
    }
    for (const bad of ['option_name_required', 'OPTION_NAME_REQUIRED ', 'OPTION_NAME_REQUIRED&x=1', '<script>', '', 'Zebra']) {
      h.fns.replaceGigAddOns.mockRejectedValueOnce(validation([issue(bad, 'addOns')]));
      expectTo(await act(h, 'add-ons'), '?error=GIG_VALIDATION_FAILED', '#gig-add-ons');
    }
  });
  it('a target outside the contract list, or an item that is not a key or a photo id, is dropped (the reason alone is not enough without a target)', async () => {
    const h = newHarness();
    seed(h);
    h.fns.replaceGigVariants.mockRejectedValueOnce(validation([issue('OPTION_NAME_REQUIRED', 'elsewhere')]));
    expectTo(await act(h, 'variants'), '?error=GIG_VALIDATION_FAILED', '#gig-variants');
    for (const item of ['Zebra name', 'OPT_UPPER', 'a', '../x', 'a&b=c', 'x'.repeat(41), '1234']) {
      h.fns.replaceGigVariants.mockRejectedValueOnce(validation([issue('OPTION_NAME_REQUIRED', 'variants', item)]));
      expectTo(await act(h, 'variants'), '?error=GIG_VALIDATION_FAILED&issue=OPTION_NAME_REQUIRED&target=variants', '#gig-variants');
    }
    h.fns.updateGigMedia.mockRejectedValueOnce(validation([issue('MEDIA_ALT_TOO_LONG', 'media', MEDIA)]));
    expectTo(await act(h, 'photo-alt'), `?error=GIG_VALIDATION_FAILED&issue=MEDIA_ALT_TOO_LONG&target=media&item=${MEDIA}`, '#gig-photos');
  });
  it('only a 400 GIG_VALIDATION_FAILED carries an issue; details of any other code are ignored, and no detail text is ever echoed', async () => {
    const h = newHarness();
    seed(h);
    h.fns.replaceGigVariants.mockRejectedValueOnce(
      new ApiError(409, 'GIG_STALE_DRAFT', 'CONFLICT', 'x', 'corr-1', { issues: [issue('OPTION_NAME_REQUIRED', 'variants')], message: 'Zebra' }),
    );
    const res = await act(h, 'variants');
    expectTo(res, '?error=GIG_STALE_DRAFT', '#gig-variants');
    h.fns.replaceGigVariants.mockRejectedValueOnce(validation([{ ...issue('OPTION_NAME_REQUIRED', 'variants'), messageKey: 'Zebra', fieldKey: 'Zebra' }]));
    expect(await seen(await act(h, 'variants'))).not.toContain('Zebra');
  });
  it('the upload names an API refusal of the alt text the same way', async () => {
    const h = newHarness();
    seed(h);
    h.fns.requestGigMediaUpload.mockRejectedValueOnce(validation([issue('MEDIA_ALT_TOO_LONG', 'media')]));
    expectTo(await upload(h), '?error=GIG_VALIDATION_FAILED&issue=MEDIA_ALT_TOO_LONG&target=media', '#gig-photos');
  });
});

describe('a refused photo names its reason (closed list)', () => {
  const refused = (reason: unknown): ApiError => new ApiError(400, 'GIG_MEDIA_REFUSED', 'VALIDATION', 'x', 'corr-1', { reason });
  it.each(['finalize', 'authorize'] as const)('%s: every reason of the contract passes as &reason=<REASON>', async (via) => {
    const h = newHarness();
    seed(h);
    expect(GIG_MEDIA_REFUSAL_REASONS).toHaveLength(13);
    for (const reason of GIG_MEDIA_REFUSAL_REASONS) {
      if (via === 'finalize') {
        h.fns.finalizeGigMedia.mockRejectedValueOnce(refused(reason));
        expectTo(await act(h, 'photo-finish'), `?error=GIG_MEDIA_REFUSED&reason=${reason}`, '#gig-photos');
      } else {
        h.fns.requestGigMediaUpload.mockRejectedValueOnce(refused(reason));
        expectTo(await upload(h), `?error=GIG_MEDIA_REFUSED&reason=${reason}`, '#gig-photos');
      }
    }
  });
  it('an unknown, malformed or non-string reason is dropped and never echoed', async () => {
    const h = newHarness();
    seed(h);
    for (const bad of [
      'FILE_TOO_BIG',
      'file_too_large',
      'FILE_TOO_LARGE ',
      'FILE_TOO_LARGE&x=1',
      '<script>',
      'Zebra-reason',
      '',
      7,
      null,
      ['FILE_TOO_LARGE'],
      { reason: 'FILE_TOO_LARGE' },
    ]) {
      h.fns.finalizeGigMedia.mockRejectedValueOnce(refused(bad));
      const res = await act(h, 'photo-finish');
      expectTo(res, '?error=GIG_MEDIA_REFUSED', '#gig-photos');
      expect(await seen(res)).not.toMatch(/Zebra|script|FILE_TOO/);
    }
    h.fns.finalizeGigMedia.mockRejectedValueOnce(new ApiError(400, 'GIG_MEDIA_REFUSED', 'VALIDATION', 'x', 'corr-1'));
    expectTo(await act(h, 'photo-finish'), '?error=GIG_MEDIA_REFUSED', '#gig-photos');
  });
  it('a reason on any other code is ignored', async () => {
    const h = newHarness();
    seed(h);
    h.fns.finalizeGigMedia.mockRejectedValueOnce(new ApiError(409, 'GIG_MEDIA_EXPIRED', 'CONFLICT', 'x', 'corr-1', { reason: 'UPLOAD_EXPIRED' }));
    expectTo(await act(h, 'photo-finish'), '?error=GIG_MEDIA_EXPIRED', '#gig-photos');
  });
});

describe('the Next route module for /auth/provider/gigs/<action> (CAT-004 actions)', () => {
  it('delegates each draft action to its handler with the process-wide deps', async () => {
    const h = newHarness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    for (const name of GIG_DRAFT_ACTIONS) {
      const body = name === 'photo-upload' ? uploadForm() : BODIES[name]();
      const res = await gigPost(post(`/auth/provider/gigs/${name}`, body, { query: name === 'photo-upload' ? `?gigId=${GIG}` : '' }), {
        params: Promise.resolve({ action: name }),
      });
      expect(res.status, name).toBe(303);
      expect(res.headers.get('location'), name).toContain(`${PUBLIC}/provider/gigs/${GIG}?notice=`);
    }
    expect(routeState.calls).toBe(7);
  });
  it('still answers an unknown action with 404 and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'photo', 'Photo-Upload', 'variants/x', 'constructor', '__proto__']) {
      const res = await gigPost(post('/auth/provider/gigs/x', null), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
    }
    expect(gigGet().status).toBe(405);
    expect(routeState.calls).toBe(0);
  });
});
