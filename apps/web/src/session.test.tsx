import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionPage from './app/session/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { ACCOUNT_COPY, ACCOUNT_ID, CUSTOMER_ROLE, PROVIDER_ROLE, accountDto, attachAccountApi, type AccountApiStub } from './testing/account-stub';
import { REGISTRY_COPY, startContentStub, type ContentStub } from './testing/content-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-2', accessToken: () => accessToken }) };
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

describe('session page account (ID-001)', () => {
  let stub: ContentStub;
  let api: AccountApiStub;
  const store = new MemorySessionStore();
  const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
  beforeAll(async () => {
    stub = await startContentStub(ACCOUNT_COPY);
    api = attachAccountApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = ACCOUNT_COPY;
    stub.calls.length = 0;
    api.reset();
    state.baseUrl = stub.baseUrl;
    state.cookie = undefined;
    store.sessions.clear();
  });
  const signedIn = (over: Partial<SessionRecord> = {}) => {
    store.sessions.set('sid1', {
      subject: 'user-1',
      realmRoles: ['customer'],
      accessToken: TOKENS.access,
      refreshToken: TOKENS.refresh,
      idToken: TOKENS.id,
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Math.floor(Date.now() / 1000),
      ...over,
    });
    state.cookie = 'bg_session=sid1';
  };
  /** The rendered page without React's text-node separators, so adjacent text reads as the browser shows it. */
  const render = async (error?: string) => renderToString(await SessionPage({ searchParams: Promise.resolve({ error }) })).replaceAll('<!-- -->', '');
  const meCalls = () => api.calls.filter((c) => c.path === '/api/v1/account/me');
  const bothRoles = () => (api.account = accountDto([CUSTOMER_ROLE, PROVIDER_ROLE]));

  it('shows the account id, the status label, the role names and the active role from the registry, read with the session token', async () => {
    signedIn();
    const html = await render();
    expect(html).toContain(`<dt>Registry account id</dt><dd>${ACCOUNT_ID}</dd>`);
    expect(html).toContain('<dt>Registry account status</dt><dd>Registry status active</dd>');
    expect(html).toContain('<dt>Registry application roles</dt><dd>Registry Customer</dd>');
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Customer</dd>');
    // the existing identity rows stay
    expect(html).toContain('<dt>subject</dt><dd>user-1</dd>');
    expect(html).toContain('<dd>web client (bananagig-web)</dd>');
    expect(html).toContain('>Registry sign out</button>');
    // none of the account words is a hardcoded replacement
    for (const literal of ['>Account<', 'Account status', 'Application roles', 'Active role', 'ACTIVE', 'CUSTOMER', 'role="alert"'])
      expect(html).not.toContain(literal);
    expect(meCalls()).toHaveLength(1);
    expect(meCalls()[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: undefined });
    // one batched registry call for the whole page
    expect(stub.calls).toHaveLength(1);
    expect((stub.calls[0]!.body as { keys: string[] }).keys.sort()).toEqual(
      [
        'account.status.active',
        'common.action.sign_out',
        'identity.role.customer.name',
        'session.account.active_role',
        'session.account.id',
        'session.account.roles',
        'session.account.status',
        'session.status.signed_in',
      ].sort(),
    );
    // a single role: nothing to switch to
    expect(html).not.toContain('/auth/active-role');
  });

  it('never exposes a token: not in the page, in a form, or in an attribute', async () => {
    signedIn();
    bothRoles();
    const html = await render();
    for (const t of Object.values(TOKENS)) expect(html).not.toContain(t);
    expect(html).not.toMatch(/token|bearer|authorization/i);
    expect(html).not.toContain('<script');
  });

  it('with several roles: one small POST form per OTHER role, labelled with the role name from the registry (no script)', async () => {
    signedIn();
    bothRoles();
    const html = await render();
    expect(html).toContain('<dt>Registry application roles</dt><dd>Registry Customer, Registry Provider</dd>');
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Customer</dd>');
    expect(html).toContain(
      '<form action="/auth/active-role" method="post"><input type="hidden" name="role" value="PROVIDER"/><button type="submit">Registry Provider</button></form>',
    );
    expect(html.match(/action="\/auth\/active-role"/g)).toHaveLength(1); // the active role has no switch to itself
    expect(html).not.toContain('value="CUSTOMER"');
    expect(html).toContain('action="/auth/logout"');
    for (const literal of ['onclick', 'onClick', 'javascript:', '<script']) expect(html).not.toContain(literal);
  });

  it('sends the role remembered by the session as x-active-role and shows it as the active role, with the switch back to the other role', async () => {
    signedIn({ activeRole: 'PROVIDER' });
    bothRoles();
    const html = await render();
    expect(meCalls()).toHaveLength(1);
    expect(meCalls()[0]!.activeRole).toBe('PROVIDER');
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Provider</dd>');
    expect(html).toContain('name="role" value="CUSTOMER"/><button type="submit">Registry Customer</button>');
    expect(html).not.toContain('value="PROVIDER"');
    // the stored role is only a hint the API validates: the page never invents or alters it
    expect(store.sessions.get('sid1')!.activeRole).toBe('PROVIDER');
  });

  it('forgets a remembered role the account no longer holds and shows the account with its default role (tokens untouched)', async () => {
    signedIn({ activeRole: 'PROVIDER' });
    api.account = accountDto([CUSTOMER_ROLE]); // provider role removed while the session lived
    const before = { ...store.sessions.get('sid1')! };
    const html = await render();
    expect(meCalls().map((c) => c.activeRole)).toEqual(['PROVIDER', undefined]);
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Customer</dd>');
    expect(html).not.toContain('Registry account unavailable');
    const { activeRole: forgotten, ...rest } = store.sessions.get('sid1')!;
    expect(forgotten).toBeUndefined();
    const { activeRole: _was, ...expected } = before;
    expect(rest).toEqual(expected);
    // the next render sends no role at all
    api.calls.length = 0;
    await render();
    expect(meCalls().map((c) => c.activeRole)).toEqual([undefined]);
  });

  it('API unavailable, account suspended or API unreachable: shows the registry "unavailable" message instead of crashing, the rest of the page stays', async () => {
    for (const mode of ['down', 'suspended'] as const) {
      signedIn();
      api.mode = mode;
      const html = await render();
      expect(html, mode).toContain('<p role="status">Registry account unavailable</p>');
      for (const literal of ['Registry account id', 'Registry application roles', ACCOUNT_ID, '/auth/active-role']) expect(html, mode).not.toContain(literal);
      expect(html).toContain('<dt>subject</dt><dd>user-1</dd>');
      expect(html).toContain('action="/auth/logout"');
      expect(meCalls(), `${mode}: a role-less session is not retried`).toHaveLength(1);
      api.calls.length = 0;
    }
    // a suspended account is not a stale-role problem even when the session names a role: the role is kept, nothing is retried
    signedIn({ activeRole: 'PROVIDER' });
    api.mode = 'suspended';
    await render();
    expect(meCalls()).toHaveLength(1);
    expect(store.sessions.get('sid1')!.activeRole).toBe('PROVIDER');
    // the whole API unreachable
    api.calls.length = 0;
    state.baseUrl = 'http://127.0.0.1:1';
    const html = await render();
    expect(html).toContain('<h1>Session</h1>');
    expect(html).toContain('unavailable (API_UNREACHABLE)');
    expect(html).toContain('action="/auth/logout"');
  });

  it('registry down: the account facts that need copy are omitted (no id, no raw status or role code, no switch), sign out keeps its bootstrap label', async () => {
    signedIn();
    bothRoles();
    stub.mode = 'down';
    const html = await render();
    for (const literal of [ACCOUNT_ID, 'ACTIVE', 'CUSTOMER', 'PROVIDER', '/auth/active-role', 'Account', 'role="status"']) expect(html).not.toContain(literal);
    expect(html).toContain('<dt>subject</dt><dd>user-1</dd>');
    expect(html).toContain('>Sign out</button>');
  });

  it('a key the registry does not serve omits only its own element', async () => {
    signedIn();
    bothRoles();
    const copy = structuredClone(ACCOUNT_COPY);
    delete copy['en-US']!['session.account.status'];
    delete copy['en-US']!['identity.role.provider.name'];
    stub.catalog = copy;
    const html = await render();
    expect(html).toContain(`<dt>Registry account id</dt><dd>${ACCOUNT_ID}</dd>`);
    expect(html).not.toContain('Registry status active'); // the status row needs both its label and the status text
    expect(html).toContain('<dt>Registry application roles</dt><dd>Registry Customer</dd>'); // the unnamed role is not listed with a code instead
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Customer</dd>');
    expect(html).not.toContain('/auth/active-role'); // no name, no button, no hardcoded text
    expect(html).not.toContain('PROVIDER');
  });

  it('shows no hardcoded message for a refused role switch (?error=role): the account stays as it was', async () => {
    signedIn({ activeRole: 'PROVIDER' });
    bothRoles();
    const html = await render('role');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('<dt>Registry active role</dt><dd>Registry Provider</dd>');
  });
});
