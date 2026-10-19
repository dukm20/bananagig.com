// PRO-002 web side, part 3: the controlled owner photo route `GET /provider/profile/photo`. It reads the OWNER's own sanitised photo from the API with the session's token and answers
// the bytes itself. What matters: only the owner gets bytes (every other case is the SAME 404), no storage URL or hash exists on the path, the validator is opaque and conditional
// requests are answered 304, the response is never cacheable by a shared cache and is not sniffable, and a failing API is a 502, not a 404.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GET as routeGet, POST as routePost } from './app/provider/profile/photo/route';
import { ApiError, type ProfilePhotoResponse } from './lib/api-client';
import { handleProfilePhotoPreview } from './lib/auth/profile-photo-preview';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps } from './lib/auth/types';

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
  endpoints: { authorization: 'http://auth.localhost/auth', endSession: 'http://auth.localhost/logout', token: 'http://keycloak/token' },
  cookieSecure: false,
  sessionCookie: 'bg_session',
  txCookie: 'bg_auth_tx',
  deviceCookie: 'bg_device',
  revokedRedirectUri: `${PUBLIC}/session?error=session_revoked`,
};
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);

interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  photo: Mock<(o?: unknown, q?: { ifNoneMatch?: string }) => Promise<ProfilePhotoResponse>>;
  logs: string[];
}
function harness(): Harness {
  const store = new MemorySessionStore();
  const logs: string[] = [];
  const photo: Harness['photo'] = vi.fn(async () => ({ kind: 'bytes' as const, bytes: BYTES, contentType: 'image/jpeg', etag: 'W/"abc123"' }));
  const deps = {
    cfg,
    store,
    verifier: {},
    now: () => Math.floor(Date.now() / 1000),
    log: (level: string, message: string, attrs?: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    api: () => ({ getProviderProfilePhoto: photo, setActiveRole: vi.fn() }),
  } as unknown as AuthDeps;
  return { deps, store, photo, logs };
}
const seed = (h: Harness, activeRole?: string): void => {
  h.store.sessions.set('sid-1', {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    idToken: TOKENS.id,
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    ...(activeRole ? { activeRole } : {}),
  });
};
const get = (h: Harness, o: { query?: string; cookie?: string | null; method?: string; headers?: Record<string, string> } = {}) =>
  handleProfilePhotoPreview(
    new Request(`http://web-app:3000/provider/profile/photo${o.query ?? ''}`, {
      method: o.method ?? 'GET',
      headers: { ...(o.cookie === null ? {} : { cookie: o.cookie ?? 'bg_session=sid-1' }), ...o.headers },
    }),
    h.deps,
  );
const apiError = (status: number, code: string): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1');
const expectNotFound = async (res: Response): Promise<void> => {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe('Not found');
  expect(res.headers.get('cache-control')).toBe('private, no-cache');
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.getSetCookie()).toEqual([]);
};

describe('GET /provider/profile/photo', () => {
  it("serves the owner's sanitised bytes with the content type, length, opaque ETag and the safe headers; the API is asked with the token and the role", async () => {
    const h = harness();
    seed(h, 'PROVIDER');
    const res = await get(h);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(res.headers.get('etag')).toBe('W/"abc123"');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(h.photo).toHaveBeenCalledWith({ activeRole: 'PROVIDER' }, {});
  });
  it('forwards a well-formed If-None-Match and answers the API\'s "not modified" with a 304 and the validator; a malformed one is not forwarded', async () => {
    const h = harness();
    seed(h);
    h.photo.mockResolvedValueOnce({ kind: 'not-modified', etag: 'W/"abc123"' });
    const res = await get(h, { headers: { 'if-none-match': 'W/"abc123"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('W/"abc123"');
    expect(await res.text()).toBe('');
    expect(h.photo.mock.calls[0]![1]).toEqual({ ifNoneMatch: 'W/"abc123"' });
    await get(h, { headers: { 'if-none-match': 'W/"a b"; x-evil=1' } });
    expect(h.photo.mock.calls[1]![1]).toEqual({});
  });
  it('an ETag from the API that is not an opaque quoted token is dropped, never echoed', async () => {
    const h = harness();
    seed(h);
    h.photo.mockResolvedValueOnce({ kind: 'bytes', bytes: BYTES, contentType: 'image/png', etag: 'abc"; evil=1' });
    expect((await get(h)).headers.get('etag')).toBeNull();
  });
  it('a signed-out visitor, an unknown session and any query are the SAME 404 and the API is not asked', async () => {
    const h = harness();
    seed(h);
    for (const o of [{ cookie: null }, { cookie: 'bg_session=unknown' }, { query: '?assetId=1' }, { query: '?x=' }, { query: '?r=1&r=2' }])
      await expectNotFound(await get(h, o));
    expect(h.photo).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])('an API %s is the same 404 (nothing says whether a photo exists)', async (status) => {
    const h = harness();
    seed(h);
    h.photo.mockRejectedValueOnce(apiError(status, 'PROFILE_NOT_FOUND'));
    await expectNotFound(await get(h));
  });
  it('an API that is down or answers something unexpected is a 502 with a fixed body, logged with the code and status only', async () => {
    const h = harness();
    seed(h);
    for (const failure of [
      apiError(0, 'API_UNREACHABLE'),
      apiError(502, 'UNEXPECTED_RESPONSE'),
      apiError(500, 'PROFILE_UNAVAILABLE'),
      new Error('internal detail with /private/key'),
    ]) {
      h.photo.mockRejectedValueOnce(failure);
      const res = await get(h);
      expect(res.status).toBe(502);
      expect(await res.text()).toBe('Bad gateway');
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
    }
    const logs = h.logs.join('\n');
    expect(logs).not.toContain('internal detail');
    expect(logs).not.toContain('/private/key');
    expect(logs).not.toContain(TOKENS.access);
  });
  it('refuses every method but GET (405) without asking the API', async () => {
    const h = harness();
    seed(h);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await get(h, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
    expect(h.photo).not.toHaveBeenCalled();
  });
  it('refuses to run without an API client or with one that lacks the photo call (a wiring error)', async () => {
    const h = harness();
    seed(h);
    await expect(
      handleProfilePhotoPreview(new Request('http://web-app:3000/provider/profile/photo'), { ...h.deps, api: undefined } as unknown as AuthDeps),
    ).rejects.toThrow('AuthDeps.api');
    await expect(
      handleProfilePhotoPreview(new Request('http://web-app:3000/provider/profile/photo', { headers: { cookie: 'bg_session=sid-1' } }), {
        ...h.deps,
        api: () => ({}),
      } as unknown as AuthDeps),
    ).rejects.toThrow('photo call');
  });
});

describe('the Next route module for /provider/profile/photo', () => {
  it('delegates GET to the handler with the process-wide deps and refuses POST', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const res = await routeGet(new Request('http://web-app:3000/provider/profile/photo', { headers: { cookie: 'bg_session=sid-1' } }));
    expect(res.status).toBe(200);
    expect(routeState.calls).toBe(1);
    const post = routePost();
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect(post.headers.get('cache-control')).toBe('no-store');
  });
});
