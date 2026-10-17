// ACC-001 web side, part 1: the account area shell and its section pages, rendered server-side against the contract-validating account area stub. The registry copy is
// MARKER text (`«key»`), so a test proves every visible word came from the registry; the navigation is whatever the stubbed API returns for the acting role.
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_AREA_COPY, ACCOUNT_SECTIONS, accountSectionDescriptionKey, accountSectionLabelKey, profileIssueMessageKey } from '@bananagig/contracts';
import AccountLayout from './app/account/layout';
import UnknownSection from './app/account/[section]/page';
import HomePage from './app/account/page';
import ContactPage from './app/account/contact/page';
import LanguageRegionPage from './app/account/language-region/page';
import PrivacyPage from './app/account/privacy/page';
import ProfilePage from './app/account/profile/page';
import RolesPage from './app/account/roles/page';
import SecurityPage from './app/account/security/page';
import { CONSENTS_ALL_DONE_KEY, VARIABLE_COPY_KEYS } from './lib/account-area';
import { resetActiveLocalesMemo } from './lib/content';
import { handleAccountForm } from './lib/auth/account-handlers';
import { handleActiveRole } from './lib/auth/handlers';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps } from './lib/auth/types';
import { ACCOUNT_ID } from './testing/account-stub';
import {
  AREA_COPY,
  AREA_KEYS,
  CUSTOMER_ROLE,
  PROVIDER_ROLE,
  SEEDED_SECTIONS,
  attachAccountAreaApi,
  marker,
  section,
  type AccountAreaStub,
} from './testing/account-area-stub';
import { startContentStub, type ContentStub } from './testing/content-stub';

const PUBLIC = 'http://app.localhost:8080';
const state = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1',
  cookie: undefined as string | undefined,
  deps: undefined as unknown,
  pathname: '/account',
  memo: new Map<unknown, Map<string, unknown>>(),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-area', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));
// the real redirect() and notFound() (they throw the errors Next recognises); only the hook that needs the router context is answered by the test
vi.mock('next/navigation', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/navigation')>()), usePathname: () => state.pathname }));
// React's cache() only memoizes inside a server request; here one "request" is the span between two `state.memo.clear()` calls (see visit), so the test can count fetches
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
    const wrapped = (...args: A): R => {
      let perFn = state.memo.get(wrapped);
      if (!perFn) state.memo.set(wrapped, (perFn = new Map()));
      const key = JSON.stringify(args);
      if (!perFn.has(key)) perFn.set(key, fn(...args));
      return perFn.get(key) as R;
    };
    return wrapped;
  };
  return { ...actual, cache };
});

const TOKEN = 'tok-access-SECRET-1'; // secret-scan:allow (a fake access token of the stubbed session: the tests prove it never reaches a page)
const SESSION_ID = 'sid-secret-1';
const S = ACCOUNT_SECTIONS;
type Query = Record<string, string | string[] | undefined>;
type PageFn = (props: { searchParams: Promise<Query> }) => Promise<ReactElement | null> | ReactElement | null | never;
const PAGES: Readonly<Record<string, PageFn>> = {
  '/account': HomePage,
  '/account/profile': ProfilePage,
  '/account/contact': ContactPage,
  '/account/security': SecurityPage,
  '/account/language-region': LanguageRegionPage,
  '/account/privacy': PrivacyPage,
  '/account/roles': RolesPage,
};

type Visit = { kind: 'page'; html: string } | { kind: 'redirect'; to: string } | { kind: 'notFound' };
const digestOf = (err: unknown): string => String((err as { digest?: unknown } | null)?.digest ?? '');
const classify = (err: unknown): Visit => {
  const digest = digestOf(err);
  if (digest.startsWith('NEXT_REDIRECT;')) return { kind: 'redirect', to: digest.split(';')[2]! };
  if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return { kind: 'notFound' };
  throw err;
};

describe('account area', () => {
  let stub: ContentStub;
  let api: AccountAreaStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(AREA_COPY);
    api = attachAccountAreaApi(stub);
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = AREA_COPY;
    stub.calls.length = 0;
    api.reset();
    resetActiveLocalesMemo();
    state.baseUrl = stub.baseUrl;
    state.cookie = undefined;
    state.deps = {
      cfg: { sessionCookie: 'bg_session', webOrigin: new URL(PUBLIC).origin, webPublicUrl: PUBLIC },
      store,
      api: (accessToken: string) => ({
        setActiveRole: async (role: string) =>
          (await import('./lib/api-client')).createApiClient({ baseUrl: stub.baseUrl, accessToken: () => accessToken }).setActiveRole(role),
      }),
    } as unknown as AuthDeps;
    store.sessions.clear();
  });
  const signedIn = (over: { activeRole?: string } = {}): void => {
    store.sessions.set(SESSION_ID, {
      subject: 'user-1',
      realmRoles: ['customer'],
      accessToken: TOKEN,
      refreshToken: 'tok-refresh-SECRET-2',
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Math.floor(Date.now() / 1000),
      ...over,
    });
    state.cookie = `bg_session=${SESSION_ID}`;
  };

  /**
   * One request for `path`: the layout and the page start together (as Next renders them), share the per-request memo, and the page HTML replaces the layout's slot.
   * A redirect or notFound thrown by the page is reported as such.
   */
  async function visit(path: string, query: Query = {}): Promise<Visit> {
    state.pathname = path;
    state.memo.clear();
    const Page = PAGES[path] ?? (UnknownSection as unknown as PageFn);
    const [layout, page] = await Promise.allSettled([
      AccountLayout({ children: <div data-slot="" /> }),
      Promise.resolve().then(() => Page({ searchParams: Promise.resolve(query) })),
    ]);
    if (layout.status === 'rejected') throw layout.reason;
    if (page.status === 'rejected') return classify(page.reason);
    const pageHtml = page.value ? renderToString(page.value) : '';
    return { kind: 'page', html: renderToString(layout.value).replace('<div data-slot=""></div>', pageHtml).replaceAll('<!-- -->', '') };
  }
  const html = async (path: string, query: Query = {}): Promise<string> => {
    const v = await visit(path, query);
    if (v.kind !== 'page') throw new Error(`expected a page for ${path}, got ${JSON.stringify(v)}`);
    return v.html;
  };
  const navCalls = () => api.calls.filter((c) => c.path === '/api/v1/account/navigation');
  const batchCalls = () => stub.calls.filter((c) => c.path === '/api/v1/content/resolve-many');
  const singleCalls = () => stub.calls.filter((c) => c.path === '/api/v1/content/resolve');
  /** The links inside the section menu, in document order. */
  const menu = (page: string): { href: string; text: string; current: boolean }[] => {
    const nav = /<nav[^>]*class="account-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? '';
    return [...nav.matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: m[1]!,
      current: m[2]!.includes('aria-current="page"'),
      text: /account-nav-label">([^<]*)</.exec(m[3]!)?.[1] ?? '',
    }));
  };
  /** The attributes of the input called `name` (attribute names lower-cased, as an HTML parser sees them). */
  const inputOf = (page: string, name: string): Record<string, string> | undefined => {
    for (const m of page.matchAll(/<input ([^>]*)\/?>/g)) {
      const attrs = Object.fromEntries([...m[1]!.matchAll(/([A-Za-z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!.toLowerCase(), a[2] ?? '']));
      if (attrs.name === name) {
        const { name: _name, ...rest } = attrs;
        return rest;
      }
    }
    return undefined;
  };
  const decode = (s: string): string =>
    s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
  /** Every text node and every text attribute a person can read or hear. */
  const visibleText = (page: string): string[] => {
    const body = page.replace(/<!--[\s\S]*?-->/g, '');
    const nodes = [...body.matchAll(/>([^<>]+)</g)].map((m) => decode(m[1]!).trim());
    const attrs = [...body.matchAll(/\s(?:aria-label|title|alt|placeholder|aria-description)="([^"]*)"/g)].map((m) => decode(m[1]!).trim());
    return [...nodes, ...attrs].filter((t) => t !== '');
  };
  const MARKER = /^«[a-z0-9_.]+»(?:\{[a-z]+\})?$/;
  /** Every visible word is a registry marker or one of the data values of the page. */
  const expectOnlyRegistryText = (page: string, data: readonly string[] = []): void => {
    const strangers = visibleText(page).filter((t) => !MARKER.test(t) && !data.includes(t));
    expect(strangers).toEqual([]);
  };

  describe('shell', () => {
    it('structure: skip link first, a labelled nav landmark with exactly the sections the API returned in its order, aria-current on the current one, one h1', async () => {
      signedIn();
      const page = await html('/account/security');
      // the skip link is the first element of the shell and jumps to the content, past the menu
      expect(page.startsWith(`<div class="account-shell"><a class="skip-link" href="#account-content">${marker(ACCOUNT_AREA_COPY.skipLink)}</a>`)).toBe(true);
      expect(page).toContain('<div id="account-content" class="account-content" tabindex="-1">');
      expect(page.indexOf('class="skip-link"')).toBeLessThan(page.indexOf('<nav'));
      expect(page).toContain(`<nav class="account-nav" aria-label="${marker(ACCOUNT_AREA_COPY.navLabel)}">`);
      expect(page.match(/<nav/g)).toHaveLength(1);
      // a list of links, one per section, in the order of the navigation
      expect(menu(page).map((m) => m.href)).toEqual(SEEDED_SECTIONS.map((s) => s.route));
      expect(menu(page).map((m) => m.text)).toEqual(SEEDED_SECTIONS.map((s) => marker(s.labelContentKey)));
      expect(page).toMatch(/<nav[^>]*><ul class="account-nav-list"><li><a /);
      // exactly one link is the current page
      expect(
        menu(page)
          .filter((m) => m.current)
          .map((m) => m.href),
      ).toEqual(['/account/security']);
      expect(page.match(/aria-current/g)).toHaveLength(1);
      // one h1, the section label
      expect(page.match(/<h1/g)).toHaveLength(1);
      expect(page).toContain(`<h1>${marker(accountSectionLabelKey(S.security))}</h1>`);
    });
    it('every section page has one h1 = the section label from the registry, in heading order (h1, then h2)', async () => {
      signedIn();
      for (const s of SEEDED_SECTIONS) {
        const page = await html(s.route);
        expect(page.match(/<h1/g), s.route).toHaveLength(1);
        expect(page, s.route).toContain(`<h1>${marker(s.labelContentKey)}</h1>`);
        const levels = [...page.matchAll(/<h([1-6])/g)].map((m) => Number(m[1]));
        expect(levels[0], s.route).toBe(1);
        levels.forEach((l, i) => i > 0 && expect(l, s.route).toBeLessThanOrEqual(levels[i - 1]! + 1));
      }
    });
    it('the home page lists the sections (menu first on a phone) with their descriptions and no section is current; a section page has the back link instead', async () => {
      signedIn();
      const home = await html('/account');
      expect(menu(home).map((m) => m.href)).toEqual(SEEDED_SECTIONS.map((s) => s.route));
      expect(menu(home).some((m) => m.current)).toBe(false);
      expect(home).not.toContain('aria-current');
      for (const s of SEEDED_SECTIONS) expect(home).toContain(`<span class="account-nav-description muted">${marker(s.descriptionContentKey!)}</span>`);
      expect(home).toContain('data-view="home"');
      expect(home).toContain(`<h1>${marker(ACCOUNT_AREA_COPY.title)}</h1>`);
      expect(home).toContain(`<p>${marker(ACCOUNT_AREA_COPY.overviewIntro)}</p>`);
      expect(home).not.toContain('account-back');
      expect(home.match(/<h1/g)).toHaveLength(1);

      const profile = await html('/account/profile');
      expect(profile).toContain('data-view="section"');
      expect(profile).toContain(`<a class="account-back" href="/account">${marker(ACCOUNT_AREA_COPY.navBack)}</a>`);
      // the descriptions belong to the home list; beside a section the menu is compact
      expect(profile).not.toContain('account-nav-description');
      expect(profile).not.toContain('data-view="home"');
      // the back link comes before the heading, the heading before the content
      expect(profile.indexOf('account-back')).toBeLessThan(profile.indexOf('<h1'));
    });
    it('follows whatever the API returns: a CUSTOMER set and a PROVIDER set that differ', async () => {
      api.sections = {
        CUSTOMER: [section(S.profile), section(S.security), section(S.roles)],
        PROVIDER: [section(S.roles), section(S.profile), section(S.contactVerification), section(S.privacyData)],
      };
      signedIn();
      const asCustomer = await html('/account');
      expect(menu(asCustomer).map((m) => m.href)).toEqual(['/account/profile', '/account/security', '/account/roles']);
      signedIn({ activeRole: 'PROVIDER' });
      const asProvider = await html('/account');
      expect(menu(asProvider).map((m) => m.href)).toEqual(['/account/roles', '/account/profile', '/account/contact', '/account/privacy']);
      // sections the role does not have are ABSENT from the markup, not rendered empty or disabled
      for (const absent of [S.contactVerification, S.privacyData, S.languageRegion]) {
        expect(asCustomer).not.toContain(accountSectionLabelKey(absent));
        expect(asCustomer).not.toContain(ROUTE(absent));
      }
      for (const absent of [S.security, S.languageRegion]) {
        expect(asProvider).not.toContain(accountSectionLabelKey(absent));
        expect(asProvider).not.toContain(ROUTE(absent));
      }
      expect(asCustomer).not.toContain('disabled');
      expect(asProvider).not.toContain('disabled');
      // the sections were requested with the role of the session
      expect(api.calls.filter((c) => c.path.endsWith('/navigation')).map((c) => c.activeRole)).toEqual([undefined, 'PROVIDER']);
    });
    const ROUTE = (code: string): string => section(code).route;

    it('switching the role changes the rendered set without a new login (the role switch route, then the next page load)', async () => {
      api.sections = { CUSTOMER: [section(S.profile), section(S.roles)], PROVIDER: [section(S.roles), section(S.privacyData)] };
      signedIn();
      expect(menu(await html('/account/roles')).map((m) => m.href)).toEqual(['/account/profile', '/account/roles']);
      const before = { ...store.sessions.get(SESSION_ID)! };
      const res = await handleActiveRole(
        new Request('http://web-app:3000/auth/active-role', {
          method: 'POST',
          headers: { origin: PUBLIC, cookie: state.cookie! },
          body: new URLSearchParams({ role: 'PROVIDER', next: '/account/roles' }),
        }),
        state.deps as AuthDeps,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${PUBLIC}/account/roles`);
      // only the remembered role changed in the SERVER session: same tokens, same session id
      expect(store.sessions.get(SESSION_ID)).toEqual({ ...before, activeRole: 'PROVIDER' });
      const after = await html('/account/roles');
      expect(menu(after).map((m) => m.href)).toEqual(['/account/roles', '/account/privacy']);
      expect(menu(after).find((m) => m.current)?.href).toBe('/account/roles');
      // the role came from the server session, the API got it as the request header
      expect(navCalls().map((c) => c.activeRole)).toEqual([undefined, 'PROVIDER']);
    });
    it('an account without a usable active role gets the empty-state copy and no menu', async () => {
      api.roles = [];
      api.sections = {};
      signedIn();
      const page = await html('/account');
      expect(page).toContain(`<p role="status">${marker(ACCOUNT_AREA_COPY.overviewEmpty)}</p>`);
      expect(page).not.toContain('<nav');
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.overviewIntro));
      expect(page.match(/<h1/g)).toHaveLength(1);
      // a section URL of such an account is a not-found
      expect(await visit('/account/profile')).toEqual({ kind: 'notFound' });
    });
    it('the current role is shown from the registry copy with the role name as its variable', async () => {
      signedIn();
      const page = await html('/account');
      expect(page).toContain(`<p class="account-role muted">${marker(ACCOUNT_AREA_COPY.activeRole)}{role}</p>`);
      const call = singleCalls().find((c) => (c.body as { key: string }).key === ACCOUNT_AREA_COPY.activeRole)!;
      expect((call.body as { variables: unknown }).variables).toEqual({ role: marker(CUSTOMER_ROLE.nameContentKey) });
    });
    it('unauthenticated: every page redirects to the sign-in with its own path as the return path, the layout renders only its children, and no API call is made', async () => {
      for (const path of Object.keys(PAGES)) expect(await visit(path), path).toEqual({ kind: 'redirect', to: `/auth/login?returnTo=${path}` });
      expect(await visit('/account/notifications')).toEqual({ kind: 'notFound' }); // not a page of the area at all: no redirect for a URL that cannot exist
      expect(api.calls).toEqual([]);
      state.pathname = '/account';
      const shell = renderToString(await AccountLayout({ children: <p>child</p> }));
      expect(shell).toBe('<p>child</p>');
    });
    it('a session the API revoked goes to /auth/revoked', async () => {
      signedIn();
      api.forced['GET /account/navigation'] = { status: 401, code: 'SESSION_REVOKED', category: 'AUTHENTICATION' };
      expect(await visit('/account/profile')).toEqual({ kind: 'redirect', to: '/auth/revoked' });
    });
    it('a remembered role the account no longer holds is forgotten and the area is read again with the default role', async () => {
      signedIn({ activeRole: 'GHOST' });
      const page = await html('/account/profile');
      expect(navCalls().map((c) => c.activeRole)).toEqual(['GHOST', undefined]);
      expect(store.sessions.get(SESSION_ID)!.activeRole).toBeUndefined();
      expect(menu(page)).toHaveLength(SEEDED_SECTIONS.length);
      // the page read after the retry uses the default role too
      expect(api.calls.filter((c) => c.path === '/api/v1/account/profile').map((c) => c.activeRole)).toEqual([undefined]);
    });
    it('an API that cannot answer shows the registry unavailable message (role=alert) and no menu and no section content', async () => {
      signedIn();
      api.mode = 'down';
      const page = await html('/account/profile');
      expect(page).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.unavailable)}</p>`);
      expect(page).not.toContain('<nav');
      expect(page).not.toContain('<form');
      // the page renders nothing here, so the layout's heading (registry copy) is the one h1
      expect(page.match(/<h1/g)).toHaveLength(1);
      expect(page).toContain(`<h1>${marker(ACCOUNT_AREA_COPY.title)}</h1><p role="alert">${marker(ACCOUNT_AREA_COPY.unavailable)}</p>`);
      expectOnlyRegistryText(page);
    });
    it('the registry down: no hardcoded replacement, the pages still render their data', async () => {
      signedIn();
      stub.mode = 'down';
      const page = await html('/account/contact');
      expect(visibleText(page).filter((t) => MARKER.test(t))).toEqual([]);
      expect(page).toContain('a***@example.test');
      expect(page).not.toContain('<nav'); // no label means no link, and a link without a name is omitted
    });
    it('reads the session, the navigation and the copy ONCE per request however many components ask (layout + page share the cache)', async () => {
      signedIn();
      for (const path of Object.keys(PAGES)) {
        api.calls.length = 0;
        stub.calls.length = 0;
        await html(path);
        expect(navCalls(), path).toHaveLength(1);
        expect(batchCalls(), path).toHaveLength(1);
      }
    });
    it('resolves ALL labels in ONE batch: the area copy, the section labels and descriptions of the registry rows, the role names, the statuses; only copy with a variable is resolved on its own', async () => {
      signedIn();
      await html('/account/roles');
      expect(batchCalls()).toHaveLength(1);
      const keys = (batchCalls()[0]!.body as { keys: string[] }).keys;
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBeLessThanOrEqual(100);
      for (const k of Object.values(ACCOUNT_AREA_COPY).filter((k) => !VARIABLE_COPY_KEYS.includes(k))) expect(keys, k).toContain(k);
      // copy with a variable is never in the batch: the API fails the WHOLE call when a template lacks its variable
      for (const k of [ACCOUNT_AREA_COPY.activeRole, ACCOUNT_AREA_COPY.rolesSwitch, ACCOUNT_AREA_COPY.privacyOutstanding]) expect(keys, k).not.toContain(k);
      expect(VARIABLE_COPY_KEYS).toHaveLength(3);
      for (const s of SEEDED_SECTIONS) expect(keys).toEqual(expect.arrayContaining([s.labelContentKey, s.descriptionContentKey!]));
      expect(keys).toEqual(expect.arrayContaining([CUSTOMER_ROLE.nameContentKey, PROVIDER_ROLE.nameContentKey, CONSENTS_ALL_DONE_KEY]));
      expect(keys).toEqual(expect.arrayContaining([profileIssueMessageKey('REQUIRED'), 'account.email.status.pending', 'account.phone.status.verified']));
      // the variable copy: the current role (shell) and "Switch to {role}" (once per other role)
      expect(singleCalls().map((c) => (c.body as { key: string }).key)).toEqual([ACCOUNT_AREA_COPY.activeRole, ACCOUNT_AREA_COPY.rolesSwitch]);
    });
    it('sends the session access token and the session role on every account call, with the propagated correlation id, and never a token to the browser', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      for (const path of Object.keys(PAGES)) await html(path);
      expect(api.calls.length).toBeGreaterThan(Object.keys(PAGES).length);
      for (const c of api.calls) {
        if (c.path.startsWith('/api/v1/account/')) {
          expect(c.authorization, c.path).toBe(`Bearer ${TOKEN}`);
          expect(c.activeRole, c.path).toBe('PROVIDER');
        }
        expect(c.correlationId, c.path).toBe('web-test-corr-area');
      }
      // the public lists of the language page carry no token (the API then returns ACTIVE data only)
      for (const c of api.calls.filter((x) => x.path === '/api/v1/geography/time-zones')) expect(c.authorization).toBeUndefined();
    });
    it('puts no token, session id, account id or subject in any page, form or attribute', async () => {
      signedIn();
      for (const path of Object.keys(PAGES)) {
        const page = await html(path);
        for (const secret of [TOKEN, 'tok-refresh-SECRET-2', SESSION_ID, ACCOUNT_ID, 'user-1']) expect(page, `${path} ${secret}`).not.toContain(secret);
        expect(page, path).not.toMatch(/token|bearer|authorization|<script/i);
      }
    });
  });

  describe('server authority and the dynamic fallback', () => {
    it.each([
      ['/account/contact', 'GET /account/contact-verification'],
      ['/account/security', 'GET /account/security-summary'],
      ['/account/privacy', 'GET /account/privacy'],
      ['/account/roles', 'GET /account/roles'],
      ['/account/profile', 'GET /account/profile'],
      ['/account/language-region', 'GET /account/profile'],
    ])("%s: when its API call answers 404 ACCOUNT_SECTION_NOT_FOUND the page is Next's not-found, even though the menu lists it", async (path, route) => {
      signedIn();
      api.forced[route] = { status: 404, code: 'ACCOUNT_SECTION_NOT_FOUND', category: 'NOT_FOUND' };
      expect(await visit(path)).toEqual({ kind: 'notFound' });
    });
    it('a section the navigation of the role does not list is a not-found for its URL, whatever the section endpoint would say', async () => {
      api.sections = { CUSTOMER: [section(S.profile)], PROVIDER: [section(S.profile)] };
      signedIn();
      for (const path of ['/account/contact', '/account/security', '/account/language-region', '/account/privacy', '/account/roles'])
        expect(await visit(path), path).toEqual({ kind: 'notFound' });
      expect((await visit('/account/profile')).kind).toBe('page');
      // the language fields and the names are different sections: GET /account/profile answers for either, the page checks the section it shows
      api.sections = { CUSTOMER: [section(S.languageRegion)], PROVIDER: [] };
      expect(await visit('/account/profile')).toEqual({ kind: 'notFound' });
      expect((await visit('/account/language-region')).kind).toBe('page');
    });
    it('other API failures (not a 404 of the section) are the unavailable message in the section, not a not-found', async () => {
      signedIn();
      api.forced['GET /account/security-summary'] = { status: 503, code: 'ACCOUNT_UNAVAILABLE', category: 'DEPENDENCY' };
      const page = await html('/account/security');
      expect(page).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.unavailable)}</p>`);
      expect(page).toContain(`<h1>${marker(accountSectionLabelKey(S.security))}</h1>`);
      expect(page).not.toContain('<dl>');
    });
    it('a registry section without a page of its own (notifications, close account, a future one) ends in not-found, even when the API lists it', async () => {
      api.sections = {
        CUSTOMER: [...SEEDED_SECTIONS, section(S.notifications), section(S.closeAccount)],
        PROVIDER: [...SEEDED_SECTIONS],
      };
      signedIn();
      expect(await visit('/account/notifications')).toEqual({ kind: 'notFound' });
      expect(await visit('/account/close')).toEqual({ kind: 'notFound' });
      expect(await visit('/account/a-future-section')).toEqual({ kind: 'notFound' });
      expect(await visit('/account/NOT%20A%20SLUG')).toEqual({ kind: 'notFound' });
    });
    it('the fallback is a notFound() that needs no session and makes no API call', async () => {
      expect(await visit('/account/anything')).toEqual({ kind: 'notFound' });
      signedIn();
      api.calls.length = 0;
      expect(() => UnknownSection()).toThrowError();
      expect(api.calls).toEqual([]);
    });
  });

  describe('profile', () => {
    it('shows the name other people see from the API, the two labelled fields with the stored names and a POST form to the BFF', async () => {
      signedIn();
      const page = await html('/account/profile');
      expect(page).toContain(`<dt>${marker(ACCOUNT_AREA_COPY.profilePublicLabel)}</dt><dd>Ana M.</dd>`);
      expect(page).toContain(`<p class="muted">${marker(ACCOUNT_AREA_COPY.profilePublicHint)}</p>`);
      expect(page).toContain('<form class="account-form" action="/auth/account/profile" method="post">');
      expect(page).toContain(`<label for="account-first-name">${marker(ACCOUNT_AREA_COPY.profileFirstName)}</label><input `);
      expect(page).toContain(`<label for="account-last-name">${marker(ACCOUNT_AREA_COPY.profileLastName)}</label><input `);
      // each label is bound to its input by id, and the browser can fill them in
      expect(inputOf(page, 'firstName')).toEqual({
        id: 'account-first-name',
        type: 'text',
        autocomplete: 'given-name',
        maxlength: '50',
        required: '',
        value: 'Ana',
      });
      expect(inputOf(page, 'lastName')).toEqual({
        id: 'account-last-name',
        type: 'text',
        autocomplete: 'family-name',
        maxlength: '50',
        required: '',
        value: 'Martinez',
      });
      expect(page).toContain(`<button type="submit">${marker(ACCOUNT_AREA_COPY.actionSave)}</button>`);
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.profileEmpty));
      expectOnlyRegistryText(page, ['Ana M.']);
    });
    it('an empty profile shows the prompt and an empty form, and no display name', async () => {
      api.profile = null;
      signedIn();
      const page = await html('/account/profile');
      expect(page).toContain(`<p>${marker(ACCOUNT_AREA_COPY.profileEmpty)}</p>`);
      expect(inputOf(page, 'firstName')?.value).toBe('');
      expect(inputOf(page, 'lastName')?.value).toBe('');
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.profilePublicLabel));
      expect(page).not.toContain('<dl>');
    });
    it('maps the notice and error words after a save (PRG) to registry copy: saved / unchanged as role=status, save / name errors as role=alert; unknown words and values are never echoed', async () => {
      signedIn();
      expect(await html('/account/profile', { saved: '1' })).toContain(`<p role="status">${marker(ACCOUNT_AREA_COPY.noticeSaved)}</p>`);
      expect(await html('/account/profile', { unchanged: '1' })).toContain(`<p role="status">${marker(ACCOUNT_AREA_COPY.noticeUnchanged)}</p>`);
      expect(await html('/account/profile', { error: 'save' })).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.errorSaveFailed)}</p>`);
      // anything else is ignored: not mapped, not rendered
      for (const query of [
        { error: '<script>alert(1)</script>' },
        { error: 'choice' },
        // the old field-less words are not reflected any more, and neither are words of a field the form does not have
        { error: 'name_required' },
        { error: 'name_too_long' },
        { error: 'middle_name_required' },
        { error: 'first_name_unknown' },
        { error: 'first_name_' },
        { error: ['__proto__', 'constructor'] },
        { error: '__proto__' },
        { error: 'constructor' },
        { saved: 'yes' },
        { saved: '0' },
        { unchanged: '<b>' },
      ]) {
        const page = await html('/account/profile', query);
        expect(page, JSON.stringify(query)).not.toContain('role="alert"');
        expect(page, JSON.stringify(query)).not.toContain('role="status"');
        expect(page).not.toContain('alert(1)');
      }
      // after an error the form shows the STORED names, never a submitted value
      const failed = await html('/account/profile', { error: 'first_name_required', firstName: 'Mallory' });
      expect(failed).not.toContain('Mallory');
      expect(failed).toContain('value="Ana"');
    });
    it('a name error is shown next to the offending field: an element with an id, aria-invalid on the input and aria-describedby pointing at it; the other field and the top of the page stay clean', async () => {
      signedIn();
      for (const code of ['required', 'too_long', 'invalid_characters']) {
        const first = await html('/account/profile', { error: `first_name_${code}` });
        const message = `<p id="account-first-name-error" role="alert">${marker(`account.error.name_${code}`)}</p>`;
        expect(first, code).toContain(message);
        expect(inputOf(first, 'firstName'), code).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'account-first-name-error', value: 'Ana' });
        // the message follows its input inside the same field, after the label
        expect(first, code).toMatch(/<label for="account-first-name">[^<]*<\/label><input [^>]*\/><p id="account-first-name-error"/);
        expect(inputOf(first, 'lastName')?.['aria-invalid']).toBeUndefined();
        expect(inputOf(first, 'lastName')?.['aria-describedby']).toBeUndefined();
        // announced once: this is the only alert of the page
        expect(first.match(/role="alert"/g), code).toHaveLength(1);
        expect(first).not.toContain(marker(ACCOUNT_AREA_COPY.errorSaveFailed));

        const last = await html('/account/profile', { error: `last_name_${code}` });
        expect(last, code).toContain(`<p id="account-last-name-error" role="alert">${marker(`account.error.name_${code}`)}</p>`);
        expect(inputOf(last, 'lastName'), code).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'account-last-name-error' });
        expect(inputOf(last, 'firstName')?.['aria-invalid']).toBeUndefined();
        expect(last.match(/role="alert"/g), code).toHaveLength(1);
      }
    });
    it('both names invalid: both fields carry their own message (repeated ?error= words), the first word per field wins and nothing else is announced', async () => {
      signedIn();
      const page = await html('/account/profile', { error: ['first_name_too_long', 'last_name_required'] });
      expect(page).toContain(`<p id="account-first-name-error" role="alert">${marker('account.error.name_too_long')}</p>`);
      expect(page).toContain(`<p id="account-last-name-error" role="alert">${marker('account.error.name_required')}</p>`);
      expect(inputOf(page, 'firstName')).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'account-first-name-error' });
      expect(inputOf(page, 'lastName')).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': 'account-last-name-error' });
      expect(page.match(/role="alert"/g)).toHaveLength(2);
      // a second word for the same field is ignored; a stray word does not add a message
      const noisy = await html('/account/profile', { error: ['first_name_required', 'first_name_too_long', 'bogus', 'save'] });
      expect(noisy).toContain(`<p id="account-first-name-error" role="alert">${marker('account.error.name_required')}</p>`);
      expect(noisy).not.toContain(marker('account.error.name_too_long'));
      expect(noisy).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.errorSaveFailed)}</p>`); // 'save' is a different statement and keeps its place at the top
      expect(inputOf(noisy, 'lastName')?.['aria-invalid']).toBeUndefined();
    });
    it('a plain failure (?error=save) is the one alert at the top and marks no field', async () => {
      signedIn();
      const page = await html('/account/profile', { error: 'save' });
      expect(page).not.toContain('aria-invalid');
      expect(page).not.toContain('aria-describedby');
      expect(page.match(/role="alert"/g)).toHaveLength(1);
    });
  });

  describe('contact details', () => {
    it('shows the masked email with its status label, a phone that was not added, the not-all-verified summary and the link to the email verification page', async () => {
      signedIn();
      const page = await html('/account/contact');
      expect(page).toContain(
        `<dt>${marker(ACCOUNT_AREA_COPY.contactEmail)}</dt><dd><span>a***@example.test</span><span class="account-badge">${marker('account.email.status.verified')}</span></dd>`,
      );
      expect(page).toContain(`<dt>${marker(ACCOUNT_AREA_COPY.contactPhone)}</dt><dd>${marker(ACCOUNT_AREA_COPY.contactNotAdded)}</dd>`);
      expect(page).toContain(`<p>${marker(ACCOUNT_AREA_COPY.contactNotAllVerified)}</p>`);
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.contactAllVerified));
      // a verified address with nothing pending needs no verify link
      expect(page).not.toContain('/verify-email');
      expectOnlyRegistryText(page, ['a***@example.test']);
    });
    it('a pending email and a verified phone: the waiting note, the statuses, the all-verified summary only when both are verified, and the link to /verify-email', async () => {
      api.contact = {
        email: {
          emailVerificationStatus: 'PENDING',
          primary: null,
          pending: { maskedEmail: 'n***@example.test', purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null },
        },
        phone: {
          phoneVerificationStatus: 'VERIFIED',
          primary: { maskedPhone: '+*******0142', countryCode: 'US', verifiedAt: '2026-02-03T04:05:06.000Z', source: 'USER_ENTERED' },
          pending: null,
        },
        contacts: { emailVerified: false, phoneVerified: true, contactsVerified: false },
      };
      signedIn();
      const page = await html('/account/contact');
      expect(page).toContain(`<span>n***@example.test</span><span class="account-badge">${marker('account.email.status.pending')}</span>`);
      expect(page).toContain(`<span>+*******0142</span><span class="account-badge">${marker('account.phone.status.verified')}</span>`);
      expect(page).toContain(`<a class="account-link" href="/verify-email">${marker(ACCOUNT_AREA_COPY.contactVerifyEmail)}</a>`);
      // there is no phone action: no phone page exists
      expect(page).not.toMatch(/href="[^"]*phone/i);
      expect(page).not.toContain('<form');
      expectOnlyRegistryText(page, ['n***@example.test', '+*******0142']);
      // both verified
      api.contact.email = {
        emailVerificationStatus: 'VERIFIED',
        primary: { maskedEmail: 'a***@example.test', verifiedAt: '2026-02-03T04:05:06.000Z', source: 'USER_ENTERED' },
        pending: null,
      };
      api.contact.contacts = { emailVerified: true, phoneVerified: true, contactsVerified: true };
      expect(await html('/account/contact')).toContain(`<p>${marker(ACCOUNT_AREA_COPY.contactAllVerified)}</p>`);
    });
    it('a verified address with a replacement waiting shows both, the waiting note before the new masked value', async () => {
      api.contact.email = {
        emailVerificationStatus: 'VERIFIED',
        primary: { maskedEmail: 'a***@example.test', verifiedAt: '2026-02-03T04:05:06.000Z', source: 'USER_ENTERED' },
        pending: { maskedEmail: 'z***@example.test', purpose: 'CHANGE_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null },
      };
      signedIn();
      const page = await html('/account/contact');
      expect(page).toContain(`<span class="account-pending">${marker(ACCOUNT_AREA_COPY.contactPendingNote)} <span>z***@example.test</span></span>`);
      expect(page).toContain('/verify-email');
    });
  });

  describe('security', () => {
    it('summarizes two-step verification, the number of sessions and this browser, and links to the security centre without any session or MFA control', async () => {
      signedIn();
      const page = await html('/account/security');
      expect(page).toContain(`<dt>${marker(ACCOUNT_AREA_COPY.securityMfa)}</dt><dd>${marker(ACCOUNT_AREA_COPY.securityMfaOn)}</dd>`);
      expect(page).toContain(`<dt>${marker(ACCOUNT_AREA_COPY.securitySessions)}</dt><dd>3</dd>`);
      expect(page).toContain(`<dt>${marker(ACCOUNT_AREA_COPY.securityBrowser)}</dt><dd>${marker(ACCOUNT_AREA_COPY.securityBrowserNotTrusted)}</dd>`);
      expect(page).toContain(`<a class="account-link" href="/security">${marker(ACCOUNT_AREA_COPY.securityOpen)}</a>`);
      expect(page).not.toContain('<form');
      expect(page).not.toContain('<button');
      expectOnlyRegistryText(page, ['3']);
    });
    it.each([
      [{ available: true, enabled: false }, ACCOUNT_AREA_COPY.securityMfaOff],
      [{ available: false, enabled: false }, ACCOUNT_AREA_COPY.securityMfaUnknown],
      [{ available: false, enabled: true }, ACCOUNT_AREA_COPY.securityMfaUnknown],
    ])('two-step %j reads as %s (an unreachable identity provider is "unknown", never "off")', async (mfa, key) => {
      api.security = { mfa, activeSessionCount: 1, currentBrowserTrusted: true };
      signedIn();
      const page = await html('/account/security');
      expect(page).toContain(`<dd>${marker(key)}</dd>`);
      expect(page).toContain(`<dd>${marker(ACCOUNT_AREA_COPY.securityBrowserTrusted)}</dd>`);
      for (const other of [ACCOUNT_AREA_COPY.securityMfaOn, ACCOUNT_AREA_COPY.securityMfaOff, ACCOUNT_AREA_COPY.securityMfaUnknown].filter((k) => k !== key))
        expect(page).not.toContain(marker(other));
    });
  });

  describe('language and region', () => {
    it('offers the ACTIVE content locales and the ACTIVE time zones, each with the default choice first (an empty value), the stored values selected, and a POST form to the BFF', async () => {
      api.profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-US', timeZone: 'America/New_York' };
      signedIn();
      const page = await html('/account/language-region');
      expect(page).toContain('<form class="account-form" action="/auth/account/language-region" method="post">');
      expect(page).toContain(
        `<label for="account-locale">${marker(ACCOUNT_AREA_COPY.languageLocale)}</label><select id="account-locale" name="preferredLocale">`,
      );
      expect(page).toContain(
        `<label for="account-time-zone">${marker(ACCOUNT_AREA_COPY.languageTimeZone)}</label><select id="account-time-zone" name="timeZone">`,
      );
      const options = (name: string): { value: string; text: string; selected: boolean }[] => {
        const select = new RegExp(`<select id="[^"]*" name="${name}">([\\s\\S]*?)</select>`).exec(page)![1]!;
        return [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
          value: m[1]!,
          text: m[3]!,
          selected: m[2]!.includes('selected'),
        }));
      };
      expect(options('preferredLocale')).toEqual([
        { value: '', text: marker(ACCOUNT_AREA_COPY.defaultOption), selected: false },
        { value: 'en-US', text: 'English (United States)', selected: false },
        { value: 'es-US', text: 'Espanol (Estados Unidos)', selected: true },
      ]);
      expect(options('timeZone')).toEqual([
        { value: '', text: marker(ACCOUNT_AREA_COPY.defaultOption), selected: false },
        { value: 'America/Los_Angeles', text: 'America/Los_Angeles', selected: false },
        { value: 'America/New_York', text: 'America/New_York', selected: true },
      ]);
      // the inactive locale is not offered
      expect(page).not.toContain('fr-FR');
      expect(page).toContain(`<button type="submit">${marker(ACCOUNT_AREA_COPY.actionSave)}</button>`);
      expectOnlyRegistryText(page, ['English (United States)', 'Espanol (Estados Unidos)', 'America/Los_Angeles', 'America/New_York']);
    });
    /** What the browser would submit for the language form: the selected option of each select (the first one when none is selected). */
    const submittedLanguageForm = (page: string, choose: Record<string, string> = {}): URLSearchParams => {
      const body = new URLSearchParams();
      for (const m of page.matchAll(/<select id="[^"]*" name="([^"]+)">([\s\S]*?)<\/select>/g)) {
        const options = [...m[2]!.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map((o) => ({ value: o[1]!, selected: o[2]!.includes('selected') }));
        body.set(m[1]!, choose[m[1]!] ?? (options.find((o) => o.selected) ?? options[0]!).value);
      }
      return body;
    };
    /** Sends a browser form to the real BFF handler; resolves to the PATCH body the API would receive. */
    const patchFor = async (form: URLSearchParams): Promise<unknown> => {
      const patches: unknown[] = [];
      const deps = {
        cfg: { sessionCookie: 'bg_session', webOrigin: new URL(PUBLIC).origin, webPublicUrl: PUBLIC },
        store,
        api: () => ({
          patchAccountProfile: async (patch: unknown) => {
            patches.push(patch);
            return { changed: true, profile: { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null, displayName: 'Ana M.' } };
          },
        }),
      } as unknown as AuthDeps;
      const res = await handleAccountForm(
        new Request('http://web-app:3000/auth/account/language-region', { method: 'POST', headers: { origin: PUBLIC, cookie: state.cookie! }, body: form }),
        deps,
        'language-region',
      );
      expect(res.headers.get('location')).toBe(`${PUBLIC}/account/language-region?saved=1`);
      expect(patches).toHaveLength(1);
      return patches[0];
    };
    it('a stored locale that is no longer ACTIVE is offered as a selected option (the tag itself, marked data-inactive, right after the default), so changing only the time zone submits it back unchanged', async () => {
      api.profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'fr-FR', timeZone: 'America/Los_Angeles' };
      signedIn();
      const page = await html('/account/language-region');
      const locale = /<select id="account-locale"[^>]*>([\s\S]*?)<\/select>/.exec(page)![1]!;
      expect([...locale.matchAll(/<option ([^>]*)>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
        ['value=""', marker(ACCOUNT_AREA_COPY.defaultOption)],
        ['value="fr-FR" data-inactive="" selected=""', 'fr-FR'],
        ['value="en-US"', 'English (United States)'],
        ['value="es-US"', 'Espanol (Estados Unidos)'],
      ]);
      // the zone is active and stored: no extra option there
      expect(page.match(/data-inactive/g)).toHaveLength(1);
      // the person changes only the time zone: the form still carries the stored locale
      const form = submittedLanguageForm(page, { timeZone: 'America/New_York' });
      expect(form.get('preferredLocale')).toBe('fr-FR');
      expect(await patchFor(form)).toEqual({ preferredLocale: 'fr-FR', timeZone: 'America/New_York' });
      // picking another locale, or the default option, still works
      expect(await patchFor(submittedLanguageForm(page, { preferredLocale: 'en-US' }))).toEqual({ preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' });
      expect(await patchFor(submittedLanguageForm(page, { preferredLocale: '' }))).toEqual({ preferredLocale: null, timeZone: 'America/Los_Angeles' });
      expectOnlyRegistryText(page, ['fr-FR', 'English (United States)', 'Espanol (Estados Unidos)', 'America/Los_Angeles', 'America/New_York']);
    });
    it('a stored time zone that is no longer ACTIVE (or unknown to the list) is offered the same way, so changing only the locale keeps it', async () => {
      api.profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'Europe/Paris' };
      signedIn();
      const page = await html('/account/language-region');
      const zone = /<select id="account-time-zone"[^>]*>([\s\S]*?)<\/select>/.exec(page)![1]!;
      expect([...zone.matchAll(/<option ([^>]*)>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
        ['value=""', marker(ACCOUNT_AREA_COPY.defaultOption)],
        ['value="Europe/Paris" data-inactive="" selected=""', 'Europe/Paris'],
        ['value="America/Los_Angeles"', 'America/Los_Angeles'],
        ['value="America/New_York"', 'America/New_York'],
      ]);
      expect(page.match(/data-inactive/g)).toHaveLength(1);
      expect(await patchFor(submittedLanguageForm(page, { preferredLocale: 'es-US' }))).toEqual({ preferredLocale: 'es-US', timeZone: 'Europe/Paris' });
      expect(await patchFor(submittedLanguageForm(page, { timeZone: '' }))).toEqual({ preferredLocale: 'en-US', timeZone: null });
    });
    it('a stored value that IS active is selected where it stands and never duplicated; no stored value adds no extra option', async () => {
      api.profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-US', timeZone: 'America/New_York' };
      signedIn();
      const page = await html('/account/language-region');
      expect(page.match(/value="es-US"/g)).toHaveLength(1);
      expect(page.match(/value="America\/New_York"/g)).toHaveLength(1);
      expect(page).not.toContain('data-inactive');
      expect(await patchFor(submittedLanguageForm(page))).toEqual({ preferredLocale: 'es-US', timeZone: 'America/New_York' });
      api.profile = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: null, timeZone: null };
      const plain = await html('/account/language-region');
      expect(plain).not.toContain('data-inactive');
      expect(plain.match(/<option /g)).toHaveLength(6); // default + the 2 active locales, default + the 2 zones
    });
    it('no stored preference: the default option is the selected one in both lists', async () => {
      signedIn();
      const page = await html('/account/language-region');
      expect(page.match(/<option value="" selected="">/g)).toHaveLength(2);
      expect(page.match(/ selected=""/g)).toHaveLength(2);
    });
    it('shows only ACTIVE time zones even if the list carries other statuses', async () => {
      api.timeZones = [
        { ianaName: 'America/Los_Angeles', status: 'ACTIVE' },
        { ianaName: 'Europe/Paris', status: 'PLANNED' },
        { ianaName: 'Asia/Tokyo', status: 'INACTIVE' },
      ];
      signedIn();
      const page = await html('/account/language-region');
      expect(page).toContain('value="America/Los_Angeles"');
      expect(page).not.toContain('Europe/Paris');
      expect(page).not.toContain('Asia/Tokyo');
    });
    it('without a profile there is nothing to change yet: the prompt and a link to the Profile section instead of a form that could only fail', async () => {
      api.profile = null;
      signedIn();
      const page = await html('/account/language-region');
      expect(page).not.toContain('<form');
      expect(page).toContain(`<p>${marker(ACCOUNT_AREA_COPY.profileEmpty)}</p>`);
      expect(page).toContain(`<a class="account-link" href="/account/profile">${marker(accountSectionLabelKey(S.profile))}</a>`);
    });
    it('a list that cannot be read shows the unavailable message and no form', async () => {
      signedIn();
      api.forced['GET /geography/time-zones'] = { status: 503, code: 'UNAVAILABLE', category: 'DEPENDENCY' };
      const page = await html('/account/language-region');
      expect(page).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.unavailable)}</p>`);
      expect(page).not.toContain('<form');
    });
    it('the notice and error words: saved, unchanged, choice (invalid_choice) and save', async () => {
      signedIn();
      expect(await html('/account/language-region', { saved: '1' })).toContain(`<p role="status">${marker(ACCOUNT_AREA_COPY.noticeSaved)}</p>`);
      expect(await html('/account/language-region', { unchanged: '1' })).toContain(`<p role="status">${marker(ACCOUNT_AREA_COPY.noticeUnchanged)}</p>`);
      expect(await html('/account/language-region', { error: 'choice' })).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.errorInvalidChoice)}</p>`);
      expect(await html('/account/language-region', { error: 'save' })).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.errorSaveFailed)}</p>`);
      expect(await html('/account/language-region', { error: 'first_name_required' })).not.toContain('role="alert"');
    });
  });

  describe('privacy and data', () => {
    it('shows "N agreements need your attention" with the count as the copy variable, the link to /consents and the data download as not available', async () => {
      signedIn();
      const page = await html('/account/privacy');
      expect(page).toContain(
        `<h2 id="account-privacy-consents">${marker(ACCOUNT_AREA_COPY.privacyConsents)}</h2><p>${marker(ACCOUNT_AREA_COPY.privacyOutstanding)}{count}</p>`,
      );
      const call = singleCalls().find((c) => (c.body as { key: string }).key === ACCOUNT_AREA_COPY.privacyOutstanding)!;
      expect((call.body as { variables: unknown }).variables).toEqual({ count: 2 });
      expect(page).toContain(`<a class="account-link" href="/consents">${marker(ACCOUNT_AREA_COPY.privacyOpenConsents)}</a>`);
      expect(page).toContain(
        `<h2 id="account-privacy-download">${marker(ACCOUNT_AREA_COPY.privacyDownload)}</h2><p>${marker(ACCOUNT_AREA_COPY.privacyDownloadUnavailable)}</p>`,
      );
      expect(page).not.toContain(marker(CONSENTS_ALL_DONE_KEY));
      // no download control while the API says it is not available
      expect(page).not.toContain('<form');
      expect(page).not.toContain('<button');
      expectOnlyRegistryText(page);
    });
    it('everything accepted: the "all done" copy and no count is resolved', async () => {
      api.privacy = { consents: { locale: 'en-US', satisfied: true, outstandingCount: 0 }, dataDownload: { available: false } };
      signedIn();
      const page = await html('/account/privacy');
      expect(page).toContain(`<p>${marker(CONSENTS_ALL_DONE_KEY)}</p>`);
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.privacyOutstanding));
      expect(singleCalls().map((c) => (c.body as { key: string }).key)).not.toContain(ACCOUNT_AREA_COPY.privacyOutstanding);
    });
    it("the download message is the API's call: shown while available is false", async () => {
      signedIn();
      expect(await html('/account/privacy')).toContain(marker(ACCOUNT_AREA_COPY.privacyDownloadUnavailable));
    });
  });

  describe('roles', () => {
    it('lists the roles with the current one marked and one no-script POST switch form per OTHER role to the existing BFF route, returning to this page', async () => {
      signedIn();
      const page = await html('/account/roles');
      expect(page).toContain(
        `<li><span>${marker(CUSTOMER_ROLE.nameContentKey)}</span><span class="account-badge">${marker(ACCOUNT_AREA_COPY.rolesCurrent)}</span></li>`,
      );
      expect(page).toContain(`<li><span>${marker(PROVIDER_ROLE.nameContentKey)}</span></li>`);
      expect(page).toContain(`<h2 id="account-roles-held">${marker(ACCOUNT_AREA_COPY.rolesHeld)}</h2>`);
      const forms = [...page.matchAll(/<form [^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
      expect(forms).toEqual([
        `<form class="account-form" action="/auth/active-role" method="post"><input type="hidden" name="role" value="PROVIDER"/><input type="hidden" name="next" value="/account"/><button type="submit">${marker(ACCOUNT_AREA_COPY.rolesSwitch)}{role}</button></form>`,
      ]);
      const call = singleCalls().find((c) => (c.body as { key: string }).key === ACCOUNT_AREA_COPY.rolesSwitch)!;
      expect((call.body as { variables: unknown }).variables).toEqual({ role: marker(PROVIDER_ROLE.nameContentKey) });
      expect(page).not.toContain(marker(ACCOUNT_AREA_COPY.rolesSingle));
      expect(page).not.toContain('<script');
    });
    it('after a switch the other role is the current one and the form offers the way back', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      const page = await html('/account/roles');
      expect(page).toContain(`<li><span>${marker(PROVIDER_ROLE.nameContentKey)}</span><span class="account-badge">`);
      expect(page).toContain('<input type="hidden" name="role" value="CUSTOMER"/>');
      expect(page).not.toContain('value="PROVIDER"');
    });
    it('a single role: the message instead of a switch', async () => {
      api.roles = [CUSTOMER_ROLE];
      signedIn();
      const page = await html('/account/roles');
      expect(page).toContain(`<p>${marker(ACCOUNT_AREA_COPY.rolesSingle)}</p>`);
      expect(page).not.toContain('<form');
      expect(page).not.toContain('/auth/active-role');
    });
    it('a refused switch comes back as ?error=role: the registry error message (role=alert)', async () => {
      signedIn();
      expect(await html('/account/roles', { error: 'role' })).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.rolesSwitchFailed)}</p>`);
      expect(await html('/account', { error: 'role' })).toContain(`<p role="alert">${marker(ACCOUNT_AREA_COPY.rolesSwitchFailed)}</p>`);
      expect(await html('/account/roles', { error: 'other' })).not.toContain('role="alert"');
    });
  });

  describe('no hardcoded copy', () => {
    it('every visible text node and text attribute of every page is a registry marker or a value of the data (the layout, the six pages and the home)', async () => {
      signedIn();
      const data = ['Ana M.', 'a***@example.test', '3', 'English (United States)', 'Espanol (Estados Unidos)', 'America/Los_Angeles', 'America/New_York'];
      for (const path of Object.keys(PAGES)) {
        const page = await html(path);
        expect(visibleText(page).length, path).toBeGreaterThan(3);
        expectOnlyRegistryText(page, data);
      }
      // with feedback on the page too
      const withFeedback: [string, Query][] = [
        ['/account/profile', { error: 'first_name_too_long' }],
        ['/account/profile', { error: ['first_name_required', 'last_name_invalid_characters'] }],
        ['/account/profile', { saved: '1' }],
        ['/account/language-region', { error: 'choice' }],
        ['/account/roles', { error: 'role' }],
      ];
      for (const [path, query] of withFeedback) expectOnlyRegistryText(await html(path, query), data);
    });
    it('uses only keys the stub knows (a key missing from the registry would show nothing, and the stub catalog has every key the area asks for)', async () => {
      signedIn();
      for (const path of Object.keys(PAGES)) await html(path);
      const asked = new Set(
        batchCalls()
          .flatMap((c) => (c.body as { keys: string[] }).keys)
          .concat(singleCalls().map((c) => (c.body as { key: string }).key)),
      );
      for (const k of asked) expect(AREA_KEYS, k).toContain(k);
    });
    it('titles come from the registry too (generateMetadata uses the same cached read)', async () => {
      signedIn();
      state.memo.clear();
      const { generateMetadata } = await import('./app/account/profile/page');
      expect(await generateMetadata()).toEqual({ title: marker(accountSectionLabelKey(S.profile)) });
      const home = await import('./app/account/page');
      expect(await home.generateMetadata()).toEqual({ title: marker(ACCOUNT_AREA_COPY.title) });
      expect(accountSectionDescriptionKey(S.profile)).toBe('account.area.section.profile.description');
    });
  });
});
