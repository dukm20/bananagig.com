// PRO-002 web side, part 2: the BFF half of the provider public profile. The POST handlers behind /provider/profile (save, visibility, photo-upload, photo-remove) and the Next route
// module in front of them. The API is a fake client factory with spies: what matters is WHICH call is made, with WHAT, that nothing but a well-formed form reaches the API (the server
// decides everything else), that a result is a 303 to a fixed target with a closed word, that the upload is authorize -> PUT with node:http (the global fetch is a spy that must stay
// unused) -> finalize with a bounded read of the body, and that no provider text, file name, one-time URL, token or hash leaks into a redirect, a header, a cookie or a log line.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GIG_MEDIA_FILE_CEILING, GIG_MEDIA_REFUSAL_REASONS, PROFILE_ERROR_CODES, PROFILE_ISSUE_REASONS, profileWireCode } from '@bananagig/contracts';
import { GET as profileGet, POST as profilePost } from './app/auth/provider/profile/[action]/route';
import { ApiError } from './lib/api-client';
import {
  PROFILE_ACTIONS,
  handleProfileAction,
  isProfileAction,
  profileErrorWordOf,
  profileIssueQueryOf,
  type ProfileAction,
} from './lib/auth/profile-handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { ownerProfileDto, ownerStateDto, photoUploadDto } from './testing/profile-stub';

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
const REVISION = 4;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = createHash('sha256').update(PNG).digest('hex');
const SECRET_NAME = 'Zed-Private-Name-9931';
const SECRET_BIO = 'Private bio line 7742 <script>alert(1)</script>';

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
const UPLOAD_PATH = '/private/provider/profile-photo/one-object.upload?X-Signature=ONE-TIME-SIGNATURE-VALUE&X-Expires=900';
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
  getProviderProfile: Mock<(o?: unknown) => Promise<unknown>>;
  createProviderProfile: Mock<(o?: unknown) => Promise<{ created: boolean; state: unknown }>>;
  updateProviderProfile: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  setProviderProfileVisibility: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  requestProviderProfilePhotoUpload: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  finalizeProviderProfilePhoto: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
  removeProviderProfilePhoto: Mock<(input: unknown, o?: unknown) => Promise<unknown>>;
}
interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  fns: Fns;
  apiTokens: string[];
  logs: string[];
}
function harness(withApi = true): Harness {
  order = [];
  const store = new MemorySessionStore();
  const apiTokens: string[] = [];
  const logs: string[] = [];
  const STATE = ownerStateDto(ownerProfileDto({ revision: REVISION }));
  const fns: Fns = {
    setActiveRole: vi.fn(async () => {
      throw new Error('the role switch is not part of the profile actions');
    }),
    getProviderProfile: vi.fn(async () => STATE),
    createProviderProfile: vi.fn(async () => ({ created: true, state: ownerStateDto(ownerProfileDto({ revision: 1, displayName: null, bio: null })) })),
    updateProviderProfile: vi.fn(async () => STATE),
    setProviderProfileVisibility: vi.fn(async () => STATE),
    requestProviderProfilePhotoUpload: vi.fn(async () => {
      order.push('requestProviderProfilePhotoUpload');
      return photoUploadDto({ upload: { url: uploadUrl(), headers: { 'content-type': 'image/png' }, expiresAt: '2026-10-17T10:00:00.000Z' }, revision: 6 });
    }),
    finalizeProviderProfilePhoto: vi.fn(async () => {
      order.push('finalizeProviderProfilePhoto');
      return STATE;
    }),
    removeProviderProfilePhoto: vi.fn(async () => STATE),
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
const BODIES: Record<Exclude<ProfileAction, 'photo-upload'>, () => URLSearchParams> = {
  save: () => pairs(['displayName', 'Sunny Home Care'], ['bio', 'We clean homes.'], ['expectedRevision', String(REVISION)]),
  visibility: () => pairs(['expectedRevision', String(REVISION)], ['visibility', 'PUBLIC']),
  'photo-remove': () => pairs(['expectedRevision', String(REVISION)]),
};
const uploadForm = (over: { expectedRevision?: string | null; file?: File | null; extra?: Array<[string, string | File]> } = {}): FormData => {
  const fd = new FormData();
  const expectedRevision = over.expectedRevision === undefined ? String(REVISION) : over.expectedRevision;
  if (expectedRevision !== null) fd.append('expectedRevision', expectedRevision);
  const file = over.file === undefined ? new File([PNG as BlobPart], 'my-private-face.png', { type: 'image/png' }) : over.file;
  if (file !== null) fd.append('file', file);
  for (const [k, v] of over.extra ?? []) fd.append(k, v);
  return fd;
};
const run = (h: Harness, name: ProfileAction, body: BodyInit | null, o: PostOptions = {}) =>
  handleProfileAction(post(`/auth/provider/profile/${name}`, body, o), h.deps, name);
const act = (h: Harness, name: Exclude<ProfileAction, 'photo-upload'>, body: BodyInit | null = BODIES[name](), o: PostOptions = {}) => run(h, name, body, o);
const upload = (h: Harness, body: BodyInit | null = uploadForm(), o: PostOptions = {}) => run(h, 'photo-upload', body, o);
const seen = async (res: Response): Promise<string> =>
  [res.headers.get('location'), ...[...res.headers].map(([k, v]) => `${k}: ${v}`), await res.text()].join('\n');
/** The 303 back to the profile page: `query`, then the fragment of the MESSAGE it carries (the notice, the list of named problems, or the alert). */
const expectTo = (res: Response, query: string, _name?: ProfileAction): void => {
  expect(res.status).toBe(303);
  const fragment = query.startsWith('?notice=') ? '#profile-notice' : query.includes('&issue=') ? '#profile-issues' : '#profile-error';
  expect(res.headers.get('location')).toBe(`${PUBLIC}/provider/profile${query}${fragment}`);
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
const FN: Record<ProfileAction, keyof Fns> = {
  save: 'updateProviderProfile',
  visibility: 'setProviderProfileVisibility',
  'photo-upload': 'finalizeProviderProfilePhoto',
  'photo-remove': 'removeProviderProfilePhoto',
};
const bodyFor = (name: ProfileAction): BodyInit => (name === 'photo-upload' ? uploadForm() : BODIES[name]());

describe('PROFILE_ACTIONS and isProfileAction', () => {
  it('names exactly the four actions', () => {
    expect([...PROFILE_ACTIONS]).toEqual(['save', 'visibility', 'photo-upload', 'photo-remove']);
  });
  it('accepts each action and nothing else', () => {
    for (const a of PROFILE_ACTIONS) expect(isProfileAction(a)).toBe(true);
    for (const other of ['', 'SAVE', 'save ', '/save', 'save/x', 'constructor', '__proto__', 'toString', 'publish', 'create', 'delete', 'photo'])
      expect(isProfileAction(other), other).toBe(false);
  });
  it('the error words a redirect may carry are exactly the wire codes of the contract', () => {
    expect(profileErrorWordOf(apiError(409, 'STALE_PROFILE'))).toBe('STALE_PROFILE');
    for (const c of PROFILE_ERROR_CODES) expect(profileErrorWordOf(apiError(409, profileWireCode(c)))).toBe(profileWireCode(c));
    for (const bad of ['VALIDATION_FAILED', 'UNAVAILABLE', 'profile_unavailable', 'PROFILE_UNKNOWN', 'GIG_UNAVAILABLE', 'PROFILE_UNAVAILABLE&x=1', 'a=b'])
      expect(profileErrorWordOf(apiError(500, bad))).toBe('API_ERROR');
    expect(profileErrorWordOf(new Error('boom'))).toBe('API_ERROR');
  });
});

describe('profile actions: transport and authentication', () => {
  it.each(PROFILE_ACTIONS)('%s: refuses every method but POST (405) and calls nothing (no GET ever changes state)', async (name) => {
    const h = harness();
    seed(h);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const res = await run(h, name, null, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noCalls(h);
  });
  it.each(PROFILE_ACTIONS)('%s: refuses a missing, foreign or look-alike Origin (CSRF, 403) before it reads anything', async (name) => {
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
      const res = await run(h, name, bodyFor(name), { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noCalls(h);
  });
  it.each(PROFILE_ACTIONS)('%s: a signed-out browser is sent to /session and the API is not called', async (name) => {
    const h = harness();
    for (const cookie of [null, 'bg_session=unknown-sid', 'other=1']) {
      const res = await run(h, name, bodyFor(name), { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    noCalls(h);
    expect(h.apiTokens).toEqual([]);
  });
  it('refuses to run without an API client, or with one that lacks the profile calls (a wiring error, not a request error)', async () => {
    const none = harness(false);
    seed(none);
    await expect(act(none, 'save')).rejects.toThrow('AuthDeps.api');
    const h = harness();
    seed(h);
    const bare = { ...h.deps, api: () => ({ setActiveRole: h.fns.setActiveRole }) } as unknown as AuthDeps;
    for (const name of PROFILE_ACTIONS)
      await expect(handleProfileAction(post(`/auth/provider/profile/${name}`, bodyFor(name)), bare, name)).rejects.toThrow('profile calls');
  });
});

describe('profile actions: what each one asks of the API', () => {
  it('save on an existing profile: PATCHes exactly the revision and both texts, with the session token and role; says "saved"', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectTo(await act(h, 'save'), '?notice=saved', 'save');
    expect(h.fns.updateProviderProfile).toHaveBeenCalledTimes(1);
    expect(h.fns.updateProviderProfile).toHaveBeenCalledWith(
      { expectedRevision: REVISION, displayName: 'Sunny Home Care', bio: 'We clean homes.' },
      { activeRole: 'PROVIDER' },
    );
    expect(h.fns.createProviderProfile).not.toHaveBeenCalled();
    expect(h.apiTokens).toEqual([TOKENS.access]);
  });
  it('save: a blank field is sent as null (it clears the field); the typed text is sent untrimmed (the server normalises)', async () => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'save', pairs(['displayName', '   '], ['bio', ''], ['expectedRevision', '4'])), '?notice=saved', 'save');
    expect(h.fns.updateProviderProfile).toHaveBeenLastCalledWith({ expectedRevision: 4, displayName: null, bio: null }, expect.anything());
    await act(h, 'save', pairs(['displayName', '  Padded  '], ['bio', 'Line 1\r\nLine 2'], ['expectedRevision', '4']));
    expect(h.fns.updateProviderProfile).toHaveBeenLastCalledWith(
      { expectedRevision: 4, displayName: '  Padded  ', bio: 'Line 1\r\nLine 2' },
      expect.anything(),
    );
  });
  it('save with no revision (no profile yet): creates the profile, then saves the text at the revision the API answered; says "created"', async () => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'save', pairs(['displayName', 'Sunny'], ['bio', ''])), '?notice=created', 'save');
    expect(h.fns.createProviderProfile).toHaveBeenCalledTimes(1);
    expect(h.fns.updateProviderProfile).toHaveBeenCalledWith({ expectedRevision: 1, displayName: 'Sunny', bio: null }, expect.anything());
  });
  it('save with no revision and nothing typed only creates the profile', async () => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'save', pairs(['displayName', ''], ['bio', ''])), '?notice=created', 'save');
    expect(h.fns.createProviderProfile).toHaveBeenCalledTimes(1);
    expect(h.fns.updateProviderProfile).not.toHaveBeenCalled();
  });
  it('save with no revision where the profile already exists (create answers created: false) saves the text and says "saved"', async () => {
    const h = harness();
    seed(h);
    h.fns.createProviderProfile.mockResolvedValueOnce({ created: false, state: ownerStateDto(ownerProfileDto({ revision: 9 })) });
    expectTo(await act(h, 'save', pairs(['displayName', ''], ['bio', ''])), '?notice=saved', 'save');
    expect(h.fns.updateProviderProfile).toHaveBeenCalledWith({ expectedRevision: 9, displayName: null, bio: null }, expect.anything());
  });
  it('save: a create that answers no profile is an API fault (a closed error word), and nothing is saved', async () => {
    const h = harness();
    seed(h);
    h.fns.createProviderProfile.mockResolvedValueOnce({ created: true, state: ownerStateDto(null) });
    expectTo(await act(h, 'save', pairs(['displayName', 'x'], ['bio', ''])), '?error=API_ERROR', 'save');
    expect(h.fns.updateProviderProfile).not.toHaveBeenCalled();
  });
  it('visibility: forwards exactly the revision and the closed word; PUBLIC says "published", PRIVATE says "unpublished"', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    expectTo(await act(h, 'visibility'), '?notice=published', 'visibility');
    expect(h.fns.setProviderProfileVisibility).toHaveBeenCalledWith({ expectedRevision: REVISION, visibility: 'PUBLIC' }, { activeRole: 'PROVIDER' });
    expectTo(await act(h, 'visibility', pairs(['expectedRevision', '5'], ['visibility', 'PRIVATE'])), '?notice=unpublished', 'visibility');
    expect(h.fns.setProviderProfileVisibility).toHaveBeenLastCalledWith({ expectedRevision: 5, visibility: 'PRIVATE' }, expect.anything());
  });
  it('photo-remove: sends the revision only and says "photo_removed"', async () => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'photo-remove'), '?notice=photo_removed', 'photo-remove');
    expect(h.fns.removeProviderProfilePhoto).toHaveBeenCalledWith({ expectedRevision: REVISION }, expect.anything());
  });
  it.each(PROFILE_ACTIONS)('%s: calls only its own API methods', async (name) => {
    const h = harness();
    seed(h);
    await run(h, name, bodyFor(name));
    const expected: Record<ProfileAction, Array<keyof Fns>> = {
      save: ['updateProviderProfile'],
      visibility: ['setProviderProfileVisibility'],
      'photo-upload': ['getProviderProfile', 'requestProviderProfilePhotoUpload', 'finalizeProviderProfilePhoto'],
      'photo-remove': ['removeProviderProfilePhoto'],
    };
    for (const [other, fn] of Object.entries(h.fns)) {
      if (expected[name].includes(other as keyof Fns)) expect(fn, other).toHaveBeenCalledTimes(1);
      else expect(fn, other).not.toHaveBeenCalled();
    }
  });
  it('the revision of the form need not be the current one: staleness is the SERVER decision (STALE_PROFILE comes back as a code)', async () => {
    const h = harness();
    seed(h);
    h.fns.updateProviderProfile.mockRejectedValueOnce(apiError(409, 'STALE_PROFILE'));
    expectTo(await act(h, 'save', pairs(['displayName', 'a'], ['bio', 'b'], ['expectedRevision', '1'])), '?error=STALE_PROFILE', 'save');
    expect(h.fns.updateProviderProfile).toHaveBeenCalledWith({ expectedRevision: 1, displayName: 'a', bio: 'b' }, expect.anything());
  });
});

describe('profile actions: unknown and malformed form values change nothing (400)', () => {
  it.each(['1', '4', '9', '123456789'])('accepts the revision %s (1 to 9 digits, no leading zero)', async (rev) => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'photo-remove', pairs(['expectedRevision', rev])), '?notice=photo_removed', 'photo-remove');
    expect(h.fns.removeProviderProfilePhoto).toHaveBeenCalledWith({ expectedRevision: Number(rev) }, expect.anything());
  });
  it.each(['', '0', '00', '01', '-1', '+1', '1.5', '1e3', '1234567890', '2147483648', ' 4', '4 ', '4\n', '0x10', 'abc', '４', '4;5'])(
    'every action refuses the malformed revision %j',
    async (rev) => {
      const h = harness();
      seed(h);
      await expectBadRequest(await act(h, 'photo-remove', pairs(['expectedRevision', rev])));
      await expectBadRequest(await act(h, 'visibility', pairs(['expectedRevision', rev], ['visibility', 'PUBLIC'])));
      await expectBadRequest(await act(h, 'save', pairs(['displayName', 'a'], ['bio', 'b'], ['expectedRevision', rev])));
      await expectBadRequest(await upload(h, uploadForm({ expectedRevision: rev })));
      noCalls(h);
    },
  );
  it.each([
    ['visibility', pairs(['expectedRevision', '4'])],
    ['visibility', pairs(['visibility', 'PUBLIC'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'LIVE'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'public'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'BOOKABLE'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', ''])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'PUBLIC'], ['visibility', 'PRIVATE'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'PUBLIC'], ['accountId', 'a'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'PUBLIC'], ['publicProfileId', 'a'])],
    ['visibility', pairs(['expectedRevision', '4'], ['visibility', 'PUBLIC'], ['status', 'ACTIVE'])],
    ['photo-remove', pairs()],
    ['photo-remove', pairs(['expectedRevision', '4'], ['expectedRevision', '5'])],
    ['photo-remove', pairs(['expectedRevision', '4'], ['assetId', 'x'])],
    ['photo-remove', pairs(['expectedRevision', '4'], ['photo', 'x'])],
    ['save', pairs(['displayName', 'a'], ['expectedRevision', '4'])],
    ['save', pairs(['bio', 'b'], ['expectedRevision', '4'])],
    ['save', pairs(['expectedRevision', '4'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['displayName', 'c'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['bio', 'c'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['expectedRevision', '4'], ['expectedRevision', '5'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['visibility', 'PUBLIC'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['accountId', 'x'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['photo', 'x'])],
    ['save', pairs(['displayName', 'a'], ['bio', 'b'], ['publishedAt', '2026-01-01'])],
  ] as Array<[Exclude<ProfileAction, 'photo-upload'>, URLSearchParams]>)('%s: refuses %s', async (name, body) => {
    const h = harness();
    seed(h);
    await expectBadRequest(await act(h, name, body));
    noCalls(h);
  });
  it.each(['save', 'visibility', 'photo-remove'] as const)('%s: refuses a file part and a body that is not a form', async (name) => {
    const h = harness();
    seed(h);
    const multipart = new FormData();
    multipart.append('upload', new Blob(['x']), 'x.txt');
    await expectBadRequest(await act(h, name, multipart));
    const filed = new FormData();
    const legit = Object.fromEntries(BODIES[name]());
    const first = Object.keys(legit)[0]!;
    for (const [k, v] of Object.entries(legit)) if (k !== first) filed.append(k, v);
    filed.append(first, new Blob(['4']), 'x.txt');
    await expectBadRequest(await act(h, name, filed));
    await expectBadRequest(await act(h, name, JSON.stringify(Object.fromEntries(BODIES[name]())), { headers: { 'content-type': 'application/json' } }));
    await expectBadRequest(await act(h, name, null));
    noCalls(h);
  });
  it('a multipart form of text fields is accepted like a urlencoded one', async () => {
    const h = harness();
    seed(h);
    const fd = new FormData();
    fd.append('displayName', 'Multi');
    fd.append('bio', 'Part');
    fd.append('expectedRevision', '3');
    expectTo(await act(h, 'save', fd), '?notice=saved', 'save');
    expect(h.fns.updateProviderProfile).toHaveBeenCalledWith({ expectedRevision: 3, displayName: 'Multi', bio: 'Part' }, expect.anything());
  });
  it('is checked AFTER the origin and the session (a foreign origin is 403, a signed-out browser is sent to /session, even for a malformed form)', async () => {
    const h = harness();
    seed(h);
    expect((await act(h, 'visibility', pairs(['expectedRevision', 'garbage']), { origin: 'http://evil.example' })).status).toBe(403);
    const res = await act(h, 'visibility', pairs(['expectedRevision', 'garbage']), { cookie: null });
    expect(res.headers.get('location')).toBe(`${PUBLIC}/session`);
    noCalls(h);
  });
  it('a text beyond the contract ceiling is a NAMED validation problem without asking the API and without echoing the text', async () => {
    const h = harness();
    seed(h);
    const name = await act(h, 'save', pairs(['displayName', 'n'.repeat(401)], ['bio', 'ok'], ['expectedRevision', '4']));
    expectTo(name, '?error=PROFILE_VALIDATION_FAILED&issue=DISPLAY_NAME_TOO_LONG', 'save');
    const bio = await act(h, 'save', pairs(['displayName', 'ok'], ['bio', 'b'.repeat(20_001)], ['expectedRevision', '4']));
    expectTo(bio, '?error=PROFILE_VALIDATION_FAILED&issue=BIO_TOO_LONG', 'save');
    const both = await act(h, 'save', pairs(['displayName', 'n'.repeat(401)], ['bio', 'b'.repeat(20_001)]));
    expectTo(both, '?error=PROFILE_VALIDATION_FAILED&issue=DISPLAY_NAME_TOO_LONG&issue=BIO_TOO_LONG', 'save');
    noCalls(h);
    expect(await seen(bio)).not.toContain('bbbb');
  });
  it('a text AT the contract ceiling is forwarded (the configured limit is the server decision)', async () => {
    const h = harness();
    seed(h);
    expectTo(await act(h, 'save', pairs(['displayName', 'n'.repeat(400)], ['bio', 'b'.repeat(20_000)], ['expectedRevision', '4'])), '?notice=saved', 'save');
    expect((h.fns.updateProviderProfile.mock.calls[0]![0] as { bio: string }).bio).toHaveLength(20_000);
  });
  it('a form body above the bound is a 413 and the stream is cancelled; nothing is asked of the API', async () => {
    const h = harness();
    seed(h);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(65_536));
        if (pulled > 500) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await act(h, 'save', stream as unknown as BodyInit, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(100);
    const declared = await act(h, 'visibility', pairs(['expectedRevision', '4'], ['visibility', 'PUBLIC']), { headers: { 'content-length': '999999999' } });
    expect(declared.status).toBe(413);
    noCalls(h);
  });
});

describe('the redirect lands on the message (keyboard and screen-reader users start reading at the outcome)', () => {
  it.each(PROFILE_ACTIONS)('%s: a success lands on #profile-notice', async (name) => {
    const h = harness();
    seed(h);
    expect((await run(h, name, bodyFor(name))).headers.get('location')).toMatch(/\?notice=[a-z_]+#profile-notice$/);
  });
  it.each(['save', 'visibility', 'photo-remove'] as const)(
    '%s: a refusal lands on #profile-error, and on #profile-issues when it names problems',
    async (name) => {
      const h = harness();
      seed(h);
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, 'STALE_PROFILE'));
      expect((await act(h, name)).headers.get('location')).toBe(`${PUBLIC}/provider/profile?error=STALE_PROFILE#profile-error`);
      h.fns[FN[name]].mockRejectedValueOnce(apiError(409, 'PROFILE_INCOMPLETE', { issues: [{ reason: 'BIO_REQUIRED' }] }));
      expect((await act(h, name)).headers.get('location')).toBe(`${PUBLIC}/provider/profile?error=PROFILE_INCOMPLETE&issue=BIO_REQUIRED#profile-issues`);
    },
  );
  it('photo-upload: every refusal (local, API, hand-over) lands on #profile-error', async () => {
    const h = harness();
    seed(h);
    h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(apiError(400, 'PROFILE_MEDIA_REFUSED', { reason: GIG_MEDIA_REFUSAL_REASONS[0] }));
    expect((await upload(h)).headers.get('location')).toBe(
      `${PUBLIC}/provider/profile?error=PROFILE_MEDIA_REFUSED&reason=${GIG_MEDIA_REFUSAL_REASONS[0]}#profile-error`,
    );
    expect((await upload(h, uploadForm({ file: new File([], 'x.png', { type: 'image/png' }) }))).headers.get('location')).toBe(
      `${PUBLIC}/provider/profile?error=PROFILE_MEDIA_REFUSED#profile-error`,
    );
    target.status.push(500);
    expect((await upload(h)).headers.get('location')).toBe(`${PUBLIC}/provider/profile?error=PROFILE_UNAVAILABLE#profile-error`);
  });
  it('a text beyond the ceiling lands on the problem list', async () => {
    const h = harness();
    seed(h);
    const res = await act(h, 'save', pairs(['displayName', 'n'.repeat(401)], ['bio', 'ok'], ['expectedRevision', '4']));
    expect(res.headers.get('location')).toBe(`${PUBLIC}/provider/profile?error=PROFILE_VALIDATION_FAILED&issue=DISPLAY_NAME_TOO_LONG#profile-issues`);
  });
});

describe('profile actions: what the API can answer', () => {
  it.each(PROFILE_ACTIONS)('%s: 401 SESSION_REVOKED ends the local session through Keycloak', async (name) => {
    const h = harness();
    seed(h);
    const first = name === 'photo-upload' ? h.fns.getProviderProfile : h.fns[FN[name]];
    first.mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    const res = await run(h, name, bodyFor(name));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cfg.endpoints.endSession);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('bg_session='))).toMatch(/Max-Age=0/);
    expect(h.store.sessions.size).toBe(0);
    expect(h.logs.join('\n')).not.toContain('profile action refused');
  });
  it.each(['save', 'visibility', 'photo-remove'] as const)(
    '%s: every profile code of the API comes back as ?error=<wire code>, and the session stays',
    async (name) => {
      const h = harness();
      seed(h);
      for (const code of PROFILE_ERROR_CODES) {
        h.fns[FN[name]].mockRejectedValueOnce(apiError(409, profileWireCode(code)));
        expectTo(await act(h, name), `?error=${profileWireCode(code)}`, name);
      }
      expect(h.store.sessions.size).toBe(1);
    },
  );
  it('a code outside the closed list, an unreachable API or a non-API error is reduced to API_ERROR (never echoed)', async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      apiError(403, 'ACCOUNT_SUSPENDED'),
      apiError(400, 'VALIDATION_FAILED'),
      apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }),
      apiError(500, 'PROFILE_UNKNOWN_THING'),
      apiError(500, 'profile_unavailable'),
      apiError(500, 'X'.repeat(200)),
      apiError(500, 'a=b&c=d'),
      apiError(500, '"><script>'),
      apiError(500, 'PROFILE_UNAVAILABLE&x=1'),
      new Error('internal detail'),
    ]) {
      h.fns.removeProviderProfilePhoto.mockRejectedValueOnce(failure);
      const res = await act(h, 'photo-remove');
      expectTo(res, '?error=API_ERROR', 'photo-remove');
      expect(await res.text()).toBe('');
    }
    expect(h.logs.join('\n')).not.toContain('internal detail');
    expect(h.logs.join('\n')).not.toContain('script');
  });
  it('a refused text names the DISTINCT closed issue reasons the API listed (at most four); anything else in the details is dropped', async () => {
    const h = harness();
    seed(h);
    h.fns.updateProviderProfile.mockRejectedValueOnce(
      apiError(400, 'PROFILE_VALIDATION_FAILED', {
        issues: [
          { reason: 'DISPLAY_NAME_FORBIDDEN_CHARACTER', field: 'displayName' },
          { reason: 'DISPLAY_NAME_FORBIDDEN_CHARACTER', field: 'displayName' },
          { reason: 'BIO_HTML_NOT_ALLOWED', field: 'bio' },
          { reason: 'NOT_A_REASON' },
          { reason: 'BIO_TOO_LONG\n&x=1' },
          'text',
          null,
          { reason: 'BIO_BLANK' },
          { reason: 'DISPLAY_NAME_BLANK' },
          { reason: 'PHOTO_REQUIRED' },
        ],
        typed: SECRET_NAME,
      }),
    );
    const res = await act(h, 'save');
    expectTo(
      res,
      '?error=PROFILE_VALIDATION_FAILED&issue=DISPLAY_NAME_FORBIDDEN_CHARACTER&issue=BIO_HTML_NOT_ALLOWED&issue=BIO_BLANK&issue=DISPLAY_NAME_BLANK',
      'save',
    );
    expect(await seen(res)).not.toContain(SECRET_NAME);
  });
  it('an incomplete profile names what is missing (PROFILE_INCOMPLETE issues)', async () => {
    const h = harness();
    seed(h);
    h.fns.setProviderProfileVisibility.mockRejectedValueOnce(
      apiError(409, 'PROFILE_INCOMPLETE', {
        issues: [
          { reason: 'BIO_REQUIRED', field: 'bio' },
          { reason: 'PHOTO_REQUIRED', field: 'photo' },
        ],
      }),
    );
    expectTo(await act(h, 'visibility'), '?error=PROFILE_INCOMPLETE&issue=BIO_REQUIRED&issue=PHOTO_REQUIRED', 'visibility');
  });
  it('profileIssueQueryOf names issues only for the codes that carry them, and every contract reason is accepted', () => {
    expect(profileIssueQueryOf(apiError(409, 'STALE_PROFILE', { issues: [{ reason: 'BIO_REQUIRED' }] }))).toBe('');
    expect(profileIssueQueryOf(apiError(409, 'PROFILE_INCOMPLETE', { issues: 'BIO_REQUIRED' }))).toBe('');
    expect(profileIssueQueryOf(apiError(409, 'PROFILE_INCOMPLETE'))).toBe('');
    expect(profileIssueQueryOf(new Error('x'))).toBe('');
    for (const reason of PROFILE_ISSUE_REASONS)
      expect(profileIssueQueryOf(apiError(400, 'PROFILE_VALIDATION_FAILED', { issues: [{ reason }] }))).toBe(`&issue=${reason}`);
  });
  it('no step-up is required (a STEP_UP_REQUIRED is just an error, never a login round trip)', async () => {
    const h = harness();
    seed(h);
    h.fns.setProviderProfileVisibility.mockRejectedValueOnce(apiError(401, 'STEP_UP_REQUIRED', { requirement: 'MFA' }));
    expectTo(await act(h, 'visibility'), '?error=API_ERROR', 'visibility');
    expect(h.store.sessions.size).toBe(1);
  });
  it('no redirect, header, cookie or log line carries the typed text, a token or the session', async () => {
    const h = harness();
    seed(h);
    const results: Response[] = [];
    const save = () => act(h, 'save', pairs(['displayName', SECRET_NAME], ['bio', SECRET_BIO], ['expectedRevision', '987654321']));
    results.push(await save());
    h.fns.updateProviderProfile.mockRejectedValueOnce(
      apiError(400, 'PROFILE_VALIDATION_FAILED', { displayName: SECRET_NAME, bio: SECRET_BIO, issues: [{ reason: 'BIO_BLANK' }] }),
    );
    results.push(await save());
    h.fns.updateProviderProfile.mockRejectedValueOnce(apiError(409, 'STALE_PROFILE', { current: SECRET_BIO }));
    results.push(await save());
    results.push(await act(h, 'visibility'), await act(h, 'photo-remove'));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of [SECRET_NAME, SECRET_BIO, 'Private bio', '987654321', TOKENS.access, TOKENS.refresh, TOKENS.id, 'sid-1', 'user-1'])
        expect(text, marker).not.toContain(marker);
    }
    const logs = h.logs.join('\n');
    for (const marker of [SECRET_NAME, SECRET_BIO, 'Private bio', '987654321', TOKENS.access, TOKENS.refresh, TOKENS.id, 'user-1'])
      expect(logs).not.toContain(marker);
  });
  it('a refusal is logged with the action, the closed code and the status only; a success logs nothing', async () => {
    const h = harness();
    seed(h);
    for (const name of PROFILE_ACTIONS) await run(h, name, bodyFor(name));
    expect(h.logs).toEqual([]);
    h.fns.setProviderProfileVisibility.mockRejectedValueOnce(apiError(409, 'PROFILE_INCOMPLETE'));
    await act(h, 'visibility');
    h.fns.removeProviderProfilePhoto.mockRejectedValueOnce(apiError(500, 'something odd'));
    await act(h, 'photo-remove');
    h.fns.updateProviderProfile.mockRejectedValueOnce(new Error('boom'));
    await act(h, 'save');
    expect(h.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'warn', message: 'profile action refused', action: 'visibility', code: 'PROFILE_INCOMPLETE', status: 409 },
      { level: 'warn', message: 'profile action refused', action: 'photo-remove', code: 'API_ERROR', status: 500 },
      { level: 'warn', message: 'profile action refused', action: 'save', code: 'API_ERROR' },
    ]);
  });
  it('the redirect target is fixed: it never depends on the request host, a header, a query or a field', async () => {
    const h = harness();
    seed(h);
    const req = new Request('http://evil.example/auth/provider/profile/save?returnTo=http://evil.example&next=//evil.example', {
      method: 'POST',
      headers: { origin: PUBLIC, cookie: SESSION_COOKIE, host: 'evil.example', 'x-forwarded-host': 'evil.example', referer: 'http://evil.example/x' },
      body: BODIES.save(),
    });
    expectTo(await handleProfileAction(req, h.deps, 'save'), '?notice=saved', 'save');
  });
  it('every 303 target of every outcome is below the web public URL /provider/profile', async () => {
    const h = harness();
    seed(h);
    const locations: string[] = [];
    for (const name of PROFILE_ACTIONS) {
      locations.push((await run(h, name, bodyFor(name))).headers.get('location')!);
      (name === 'photo-upload' ? h.fns.getProviderProfile : h.fns[FN[name]]).mockRejectedValueOnce(apiError(409, 'PROFILE_CONFLICT'));
      locations.push((await run(h, name, bodyFor(name))).headers.get('location')!);
    }
    expect(locations).toHaveLength(8);
    for (const l of locations) expect(l.startsWith(`${PUBLIC}/provider/profile?`), l).toBe(true);
  });
});

describe('photo-upload: authorize, hand the bytes to the object store with node:http, finalize', () => {
  it('runs authorize -> PUT -> finalize in that order, sends the file facts, and says "photo_added"', async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    const res = await upload(h);
    expectTo(res, '?notice=photo_added', 'photo-upload');
    expect(order).toEqual(['requestProviderProfilePhotoUpload', 'PUT', 'finalizeProviderProfilePhoto']);
    expect(h.fns.requestProviderProfilePhotoUpload).toHaveBeenCalledWith(
      { expectedRevision: REVISION, mimeType: 'image/png', sizeBytes: PNG.byteLength, sha256: SHA },
      { activeRole: 'PROVIDER' },
    );
    // finalize carries the revision the reservation answered and the same hash
    expect(h.fns.finalizeProviderProfilePhoto).toHaveBeenCalledWith({ expectedRevision: 6, sha256: SHA }, { activeRole: 'PROVIDER' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('the PUT carries the bytes, the content type and length, and neither the session token nor a cookie nor the origin', async () => {
    const h = harness();
    seed(h);
    await upload(h);
    expect(target.received).toHaveLength(1);
    const got = target.received[0]!;
    expect(got.method).toBe('PUT');
    expect(got.url).toBe(UPLOAD_PATH);
    expect(got.body.equals(Buffer.from(PNG))).toBe(true);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-length']).toBe(String(PNG.byteLength));
    for (const forbidden of ['authorization', 'cookie', 'origin', 'x-active-role', 'x-correlation-id']) expect(got.names, forbidden).not.toContain(forbidden);
    expect(JSON.stringify(got.headers)).not.toContain('SECRET');
  });
  it('reads the limit from the profile first and refuses to upload when there is no profile', async () => {
    const h = harness();
    seed(h);
    h.fns.getProviderProfile.mockResolvedValueOnce(ownerStateDto(null));
    expectTo(await upload(h), '?error=PROFILE_NOT_FOUND', 'photo-upload');
    expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });
  it('refuses a query string, an unknown or repeated field, a file in the wrong place and a body that is not multipart (400)', async () => {
    const h = harness();
    seed(h);
    await expectBadRequest(await upload(h, uploadForm(), { query: '?gigId=x' }));
    const cases: Array<[string, BodyInit]> = [
      ['no file part', uploadForm({ file: null })],
      ['no revision', uploadForm({ expectedRevision: null })],
      ['an extra field', uploadForm({ extra: [['accountId', 'x']] })],
      ['an extra purpose field', uploadForm({ extra: [['purpose', 'GIG_PHOTO']] })],
      ['the revision twice', uploadForm({ extra: [['expectedRevision', '5']] })],
      ['two files', uploadForm({ extra: [['file', new File([PNG as BlobPart], 'b.png', { type: 'image/png' })]] })],
      ['text where the file belongs', uploadForm({ file: null, extra: [['file', 'not a file']] })],
      ['a file where the revision belongs', uploadForm({ expectedRevision: null, extra: [['expectedRevision', new File(['4'], 'a.txt')]] })],
      ['a malformed revision', uploadForm({ expectedRevision: '0' })],
    ];
    for (const [label, body] of cases) expect((await upload(h, body)).status, label).toBe(400);
    await expectBadRequest(await upload(h, pairs(['expectedRevision', '5'])));
    await expectBadRequest(await upload(h, 'x', { headers: { 'content-type': 'text/plain' } }));
    expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });
  it('an absurdly typed file is "refused" without asking the API; any other type is the API\'s decision', async () => {
    const h = harness();
    seed(h);
    expectTo(
      await upload(h, uploadForm({ file: new File([PNG as BlobPart], 'x', { type: `image/${'a'.repeat(120)}` }) })),
      '?error=PROFILE_MEDIA_REFUSED',
      'photo-upload',
    );
    expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
    h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(apiError(400, 'PROFILE_MEDIA_REFUSED', { reason: 'MIME_NOT_ALLOWED' }));
    const res = await upload(h, uploadForm({ file: new File([PNG as BlobPart], 'x.svg', { type: 'image/svg+xml' }) }));
    expect((h.fns.requestProviderProfilePhotoUpload.mock.calls[0]![0] as { mimeType: string }).mimeType).toBe('image/svg+xml');
    expect(res.headers.get('location')).toMatch(/^[^&#]*\?error=PROFILE_MEDIA_REFUSED(&reason=[A-Z_]+)?#profile-error$/);
    expect(target.received).toEqual([]);
  });
  it('a refusal reason from the contract list is named; any other reason is dropped', async () => {
    const h = harness();
    seed(h);
    for (const reason of GIG_MEDIA_REFUSAL_REASONS) {
      h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(apiError(400, 'PROFILE_MEDIA_REFUSED', { reason }));
      expectTo(await upload(h), `?error=PROFILE_MEDIA_REFUSED&reason=${reason}`, 'photo-upload');
    }
    h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(apiError(400, 'PROFILE_MEDIA_REFUSED', { reason: 'my-private-face.png' }));
    expectTo(await upload(h), '?error=PROFILE_MEDIA_REFUSED', 'photo-upload');
  });

  describe('the body is drained up to the STRUCTURAL ceiling and the configured maximum is applied to the file', () => {
    it('a declared length above the structural ceiling is a 413 before anything is asked of the API', async () => {
      const h = harness();
      seed(h);
      const res = await upload(h, uploadForm(), { headers: { 'content-length': String(GIG_MEDIA_FILE_CEILING + 65_536 + 1) } });
      expect(res.status).toBe(413);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('Payload too large');
      noCalls(h);
    });
    it('a file above the profile maximum but inside the structural ceiling is read to its end and answered with a 303 "refused" (never a reset); nothing is authorized or sent', async () => {
      const h = harness();
      seed(h);
      h.fns.getProviderProfile.mockResolvedValue({ ...ownerStateDto(ownerProfileDto()), limits: { ...ownerStateDto().limits, photoMaxSizeBytes: 1000 } });
      const big = new File([new Uint8Array(300_000)], 'big-private-name.png', { type: 'image/png' });
      const res = await upload(h, uploadForm({ file: big }));
      expectTo(res, '?error=PROFILE_MEDIA_REFUSED', 'photo-upload');
      expect(await seen(res)).not.toContain('big-private-name');
      expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
      expect(target.received).toEqual([]);
    });
    it('a file exactly at the maximum is accepted, one byte above is refused here', async () => {
      const h = harness();
      seed(h);
      const limited = (n: number) => ({ ...ownerStateDto(ownerProfileDto()), limits: { ...ownerStateDto().limits, photoMaxSizeBytes: n } });
      h.fns.getProviderProfile.mockResolvedValue(limited(PNG.byteLength));
      expectTo(await upload(h), '?notice=photo_added', 'photo-upload');
      h.fns.getProviderProfile.mockResolvedValue(limited(PNG.byteLength - 1));
      expectTo(await upload(h), '?error=PROFILE_MEDIA_REFUSED', 'photo-upload');
      expect(target.received).toHaveLength(1);
    });
    it('a chunked body (no declared length) is cancelled once it exceeds the structural ceiling: later chunks are never pulled, answer 413', async () => {
      const h = harness();
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
      expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
    });
    it('no file chosen (the browser sends an empty file part) is a 303 "refused", not a bare 400; a form with no file PART at all is still a 400', async () => {
      const h = harness();
      seed(h);
      const part = (name: string, value: string): string => `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      const raw = `${part('expectedRevision', '4')}--B\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--B--\r\n`;
      const res = await upload(h, raw, { headers: { 'content-type': 'multipart/form-data; boundary=B' } });
      expectTo(res, '?error=PROFILE_MEDIA_REFUSED', 'photo-upload');
      expect(h.fns.requestProviderProfilePhotoUpload).not.toHaveBeenCalled();
      expect((await upload(h, uploadForm({ file: null }))).status).toBe(400);
    });
  });

  describe('a hand-over that cannot be completed', () => {
    const refused = async (h: Harness, res: Response): Promise<void> => {
      expectTo(res, '?error=PROFILE_UNAVAILABLE', 'photo-upload');
      expect(h.fns.finalizeProviderProfilePhoto).not.toHaveBeenCalled();
      const everything = [await seen(res), ...h.logs].join('\n');
      expect(everything).not.toMatch(/ONE-TIME|X-Signature|my-private|\/private\/|127\.0\.0\.1/);
    };
    it.each([403, 500])('a %s from the object store is reported as unavailable, never finalized, and logged with the status only', async (status) => {
      const h = harness();
      seed(h);
      target.status.push(status);
      await refused(h, await upload(h));
      expect(h.logs.map((l) => JSON.parse(l))).toEqual([{ level: 'warn', message: 'profile photo hand-over refused', action: 'photo-upload', status }]);
    });
    it('a port nobody listens on, an unparseable URL and a URL that is not http(s) are status 0', async () => {
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      for (const url of [`http://127.0.0.1:${port}/x?X-Signature=ONE-TIME`, 'not a url', 'ftp://example.test/x?sig=ONE-TIME', 'file:///etc/passwd']) {
        const h = harness();
        seed(h);
        h.fns.requestProviderProfilePhotoUpload.mockResolvedValueOnce(photoUploadDto({ upload: { url, headers: {}, expiresAt: '2026-10-17T10:00:00.000Z' } }));
        await refused(h, await upload(h));
        expect(h.logs.map((l) => JSON.parse(l))[0]).toMatchObject({ status: 0 });
      }
    });
    it('headers the API lists are forwarded only when they are plain signed headers: the session, the framing and the host never travel', async () => {
      const h = harness();
      seed(h);
      h.fns.requestProviderProfilePhotoUpload.mockResolvedValueOnce(
        photoUploadDto({
          upload: {
            url: uploadUrl(),
            headers: {
              'content-type': 'image/png',
              'x-amz-meta-purpose': 'profile',
              Authorization: 'Bearer LEAK',
              Cookie: 'a=b',
              Host: 'evil.example',
              'Content-Length': '1',
              'x bad': 'v',
              'x-ok': 'line\r\nbreak',
            },
            expiresAt: '2026-10-17T10:00:00.000Z',
          },
        }),
      );
      expectTo(await upload(h), '?notice=photo_added', 'photo-upload');
      const got = target.received[0]!;
      expect(got.headers['x-amz-meta-purpose']).toBe('profile');
      for (const n of ['authorization', 'cookie', 'x bad', 'x-ok']) expect(got.names, n).not.toContain(n);
      expect(got.headers.host).toBe(`127.0.0.1:${target.port}`);
      expect(got.headers['content-length']).toBe(String(PNG.byteLength));
    });
    it("a finalize that the API refuses is a closed error word; the unfinished upload is the API's to replace", async () => {
      const h = harness();
      seed(h);
      h.fns.finalizeProviderProfilePhoto.mockRejectedValueOnce(apiError(409, 'PROFILE_MEDIA_SCAN_UNAVAILABLE'));
      expectTo(await upload(h), '?error=PROFILE_MEDIA_SCAN_UNAVAILABLE', 'photo-upload');
      h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(apiError(409, 'STALE_PROFILE'));
      expectTo(await upload(h), '?error=STALE_PROFILE', 'photo-upload');
      expect(target.received).toHaveLength(1); // the stale authorization never reached the store
    });
  });
  it('no redirect, header or log line carries the file name, the bytes, the hash, the one-time URL or the typed revision', async () => {
    const h = harness();
    seed(h);
    const results = [await upload(h), await upload(h, uploadForm({ file: new File([], 'my-private-face.png', { type: 'image/png' }) }))];
    h.fns.requestProviderProfilePhotoUpload.mockRejectedValueOnce(
      apiError(400, 'PROFILE_MEDIA_REFUSED', { reason: 'MIME_NOT_ALLOWED', fileName: 'my-private-face.png', sha256: SHA }),
    );
    results.push(await upload(h));
    for (const res of results) {
      const text = await seen(res);
      for (const marker of ['my-private', SHA, 'ONE-TIME', 'X-Signature', TOKENS.access, '127.0.0.1']) expect(text, marker).not.toContain(marker);
    }
    for (const marker of ['my-private', SHA, 'ONE-TIME', 'X-Signature', TOKENS.access]) expect(h.logs.join('\n')).not.toContain(marker);
  });
});

describe('the Next route module for /auth/provider/profile/<action>', () => {
  it('delegates each known action to the handler with the process-wide deps', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const expected: Record<ProfileAction, string> = {
      save: '?notice=saved#profile-notice',
      visibility: '?notice=published#profile-notice',
      'photo-upload': '?notice=photo_added#profile-notice',
      'photo-remove': '?notice=photo_removed#profile-notice',
    };
    for (const name of PROFILE_ACTIONS) {
      const res = await profilePost(post(`/auth/provider/profile/${name}`, bodyFor(name)), { params: Promise.resolve({ action: name }) });
      expect(res.headers.get('location'), name).toBe(`${PUBLIC}/provider/profile${expected[name]}`);
    }
    expect(routeState.calls).toBe(4);
  });
  it('answers an unknown action with 404 without touching the deps, and GET with 405', async () => {
    routeState.calls = 0;
    for (const bad of ['', 'nope', 'SAVE', 'publish', 'constructor', '__proto__', 'save/x', 'create']) {
      const res = await profilePost(post('/auth/provider/profile/x', pairs()), { params: Promise.resolve({ action: bad }) });
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const get = profileGet();
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(routeState.calls).toBe(0);
  });
});
