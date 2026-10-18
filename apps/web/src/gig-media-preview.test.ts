// CAT-004 web side, part 3: the controlled thumbnail route `GET /provider/gigs/<gigId>/media/<mediaId>[?version=<n>]`. It asks the API (fake client with spies) for the owner's short-lived
// one-object GET target and answers a 303 to it with `no-store`. What matters: only the owner gets the 303 (every other case is the SAME 404), the target exists nowhere but the
// `Location` header of that one answer (no body, no cookie, no log), the version query is closed, and a failing API is a 502, not a 404.
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GET as routeGet, POST as routePost } from './app/provider/gigs/[gigId]/media/[mediaId]/route';
import { ApiError } from './lib/api-client';
import { handleGigMediaPreview } from './lib/auth/gig-media-preview';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthConfig, AuthDeps, SessionRecord } from './lib/auth/types';
import { GIG_ID, MEDIA_ID } from './testing/gig-stub';

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
const TARGET = 'https://store.example/private/provider/gig-media/one-object?X-Signature=ONE-TIME-SIGNATURE&X-Expires=60';

interface Harness {
  deps: AuthDeps;
  store: MemorySessionStore;
  preview: Mock<(gigId: string, mediaId: string, version?: number, o?: unknown) => Promise<{ url: string; expiresAt: string }>>;
  logs: string[];
}
function harness(): Harness {
  const store = new MemorySessionStore();
  const logs: string[] = [];
  const preview: Harness['preview'] = vi.fn(async () => ({ url: TARGET, expiresAt: '2026-10-17T10:00:00.000Z' }));
  const deps = {
    cfg,
    store,
    verifier: {},
    now: () => Math.floor(Date.now() / 1000),
    log: (level: string, message: string, attrs?: Record<string, unknown>) => void logs.push(JSON.stringify({ level, message, ...attrs })),
    api: () => ({ getGigMediaPreview: preview, setActiveRole: vi.fn() }),
  } as unknown as AuthDeps;
  return { deps, store, preview, logs };
}
const seed = (h: Harness, over: Partial<SessionRecord> = {}): void => {
  h.store.sessions.set('sid-1', {
    subject: 'user-1',
    realmRoles: ['customer'],
    accessToken: TOKENS.access,
    refreshToken: TOKENS.refresh,
    idToken: TOKENS.id,
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    ...over,
  });
};
const get = (h: Harness, query = '', o: { cookie?: string | null; method?: string; gig?: string; media?: string } = {}) =>
  handleGigMediaPreview(
    new Request(`http://web-app:3000/provider/gigs/${o.gig ?? GIG_ID}/media/${o.media ?? MEDIA_ID}${query}`, {
      method: o.method ?? 'GET',
      headers: o.cookie === null ? {} : { cookie: o.cookie ?? 'bg_session=sid-1' },
    }),
    h.deps,
    o.gig ?? GIG_ID,
    o.media ?? MEDIA_ID,
  );
const apiError = (status: number, code: string): ApiError => new ApiError(status, code, 'TEST', code, 'corr-1');
const expectNotFound = async (res: Response): Promise<void> => {
  expect(res.status).toBe(404);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('Not found');
};

describe('GET /provider/gigs/<gigId>/media/<mediaId>', () => {
  it('the owner gets a 303 to the short-lived target with no-store and no referrer, an empty body and no cookie', async () => {
    const h = harness();
    seed(h);
    const res = await get(h);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(TARGET);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.body).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it("without ?version it asks for the DRAFT photo; with ?version=<n> for that version's; the role of the session is sent", async () => {
    const h = harness();
    seed(h, { activeRole: 'PROVIDER' });
    await get(h);
    await get(h, '?version=3');
    expect(h.preview.mock.calls[0]).toEqual([GIG_ID, MEDIA_ID, undefined, { activeRole: 'PROVIDER' }]);
    expect(h.preview.mock.calls[1]).toEqual([GIG_ID, MEDIA_ID, 3, { activeRole: 'PROVIDER' }]);
  });
  it('ids in upper case are asked for in canonical lower case', async () => {
    const h = harness();
    seed(h);
    await get(h, '', { gig: GIG_ID.toUpperCase(), media: MEDIA_ID.toUpperCase() });
    expect(h.preview.mock.calls[0]!.slice(0, 2)).toEqual([GIG_ID, MEDIA_ID]);
  });
  it('signed out, an unknown session and a revoked session are the same 404 (nothing says whether the photo exists)', async () => {
    const h = harness();
    await expectNotFound(await get(h, '', { cookie: null }));
    await expectNotFound(await get(h, '', { cookie: 'bg_session=unknown' }));
    expect(h.preview).not.toHaveBeenCalled();
    seed(h);
    h.preview.mockRejectedValueOnce(apiError(401, 'SESSION_REVOKED'));
    await expectNotFound(await get(h));
    expect(h.store.sessions.size).toBe(1); // a thumbnail request never ends the session; the page does
  });
  it("another account's photo, an unknown photo or version and a refused role are all 404", async () => {
    const h = harness();
    seed(h);
    for (const [status, code] of [
      [404, 'GIG_NOT_FOUND'],
      [404, 'GIG_MEDIA_NOT_FOUND'],
      [404, 'GIG_VERSION_NOT_FOUND'],
      [403, 'ACCOUNT_ROLE_NOT_HELD'],
    ] as const) {
      h.preview.mockRejectedValueOnce(apiError(status, code));
      await expectNotFound(await get(h));
    }
  });
  it('malformed ids and queries are a 404 and nothing is asked of the API', async () => {
    const h = harness();
    seed(h);
    await expectNotFound(await get(h, '', { gig: 'not-a-uuid' }));
    await expectNotFound(await get(h, '', { media: '../x' }));
    for (const q of [
      '?version=0',
      '?version=01',
      '?version=-1',
      '?version=1.5',
      '?version=abc',
      '?version=1234567890',
      '?version=',
      '?version=1&version=2',
      '?version=1&x=1',
      '?x=1',
      '?download=1',
    ]) {
      await expectNotFound(await get(h, q));
    }
    expect(h.preview).not.toHaveBeenCalled();
  });
  it('an API that is down, slow to answer wrongly or unexpected is a 502 with a fixed body (not a 404), logged without the target', async () => {
    const h = harness();
    seed(h);
    for (const err of [apiError(0, 'API_UNREACHABLE'), apiError(500, 'INTERNAL'), apiError(502, 'UNEXPECTED_RESPONSE'), new Error(`boom ${TARGET}`)]) {
      h.preview.mockRejectedValueOnce(err);
      const res = await get(h);
      expect(res.status).toBe(502);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('Bad gateway');
    }
    expect(h.logs.join('\n')).not.toMatch(/ONE-TIME|X-Signature|store\.example|tok-/);
  });
  it('a target that is not an http(s) URL is never redirected to', async () => {
    const h = harness();
    seed(h);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//evil.example/x', 'not a url', '']) {
      h.preview.mockResolvedValueOnce({ url, expiresAt: 'x' });
      const res = await get(h);
      expect(res.status, url).toBe(502);
      expect(res.headers.get('location')).toBeNull();
    }
  });
  it('only GET is served (405 for the rest) and a missing API client is a wiring error', async () => {
    const h = harness();
    seed(h);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await get(h, '', { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
    expect(h.preview).not.toHaveBeenCalled();
    const bare = { ...h.deps, api: undefined } as unknown as AuthDeps;
    await expect(
      handleGigMediaPreview(new Request(`http://web-app:3000/x`, { headers: { cookie: 'bg_session=sid-1' } }), bare, GIG_ID, MEDIA_ID),
    ).rejects.toThrow('AuthDeps.api');
  });
  it('the target is only ever in the Location header: not in the body, any other header, a cookie or a log', async () => {
    const h = harness();
    seed(h);
    const res = await get(h);
    const rest =
      [...res.headers]
        .filter(([k]) => k !== 'location')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n') + (await res.text());
    expect(rest).not.toMatch(/ONE-TIME|X-Signature|store\.example/);
    expect(h.logs).toEqual([]);
  });
});

describe('the Next route module', () => {
  it('delegates GET to the handler with the process-wide deps and the path ids; POST is 405', async () => {
    const h = harness();
    seed(h);
    routeState.deps = h.deps;
    routeState.calls = 0;
    const res = await routeGet(
      new Request(`http://web-app:3000/provider/gigs/${GIG_ID}/media/${MEDIA_ID}?version=2`, { headers: { cookie: 'bg_session=sid-1' } }),
      {
        params: Promise.resolve({ gigId: GIG_ID, mediaId: MEDIA_ID }),
      },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(TARGET);
    expect(h.preview.mock.calls[0]!.slice(0, 3)).toEqual([GIG_ID, MEDIA_ID, 2]);
    expect(routeState.calls).toBe(1);
    const post = routePost();
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});
