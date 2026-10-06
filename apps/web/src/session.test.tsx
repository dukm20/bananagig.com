import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionPage from './app/session/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps } from './lib/auth/types';
import { REGISTRY_COPY, startContentStub, type ContentStub } from './testing/content-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: () => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-2' }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

describe('session page copy', () => {
  let stub: ContentStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(REGISTRY_COPY);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.calls.length = 0;
    state.baseUrl = stub.baseUrl;
    state.cookie = undefined;
    store.sessions.clear();
  });
  const signedIn = () => {
    store.sessions.set('sid1', {
      subject: 'user-1',
      realmRoles: ['customer'],
      accessToken: 'access',
      refreshToken: 'refresh',
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Math.floor(Date.now() / 1000),
    });
    state.cookie = 'bg_session=sid1';
  };
  const render = async (error?: string) => renderToString(await SessionPage({ searchParams: Promise.resolve({ error }) }));

  it('signed out: status and sign-in label come from the registry', async () => {
    const html = await render();
    expect(html).toContain('Registry signed out');
    expect(html).toContain('>Registry sign in</a>');
    expect(html).not.toContain('Not signed in');
    expect(html).not.toContain('role="alert"');
    expect((stub.calls[0]!.body as { keys: string[] }).keys.sort()).toEqual(['common.action.sign_in', 'session.status.signed_out']);
  });
  it('signed out after a failed login: the error message comes from the registry', async () => {
    const html = await render('login_failed');
    expect(html).toContain('role="alert">Registry login failed');
    expect(html).not.toContain('Sign-in could not be completed');
  });
  it('signed in: status and sign-out label come from the registry', async () => {
    signedIn();
    const html = await render();
    expect(html).toContain('Registry signed in');
    expect(html).toContain('>Registry sign out</button>');
    expect(html).toContain('action="/auth/logout"');
    expect(html).not.toContain('>Sign out<');
  });
  it('registry down, signed out: managed copy is omitted, only the bootstrap sign-in control remains', async () => {
    stub.mode = 'down';
    const html = await render('login_failed');
    expect(html).toContain('<h1>Session</h1>');
    // login must stay possible: the sign-in link uses the bootstrap label
    expect(html).toContain('href="/auth/login?returnTo=/session">Sign in</a>');
    for (const literal of ['Not signed in', 'Sign-in could not', 'role="status"', 'role="alert"']) expect(html).not.toContain(literal);
  });
  it('registry down, signed in: the session facts still render and logout uses the bootstrap label', async () => {
    signedIn();
    stub.mode = 'down';
    const html = await render();
    expect(html).toContain('user-1');
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('>Sign out</button>');
    for (const literal of ['Signed in', 'role="status"']) expect(html).not.toContain(literal);
  });
});
