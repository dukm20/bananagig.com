// CAT-003 web side, part 3: the server components /provider/gigs (GigMenu), /provider/gigs/[gigId] (Gig detail and draft editor) and the read-only version page. The API is the Gig
// stub (testing/gig-stub.ts, contract-validated) mounted on the content stub: the pages read with the session's token and role, offer each form only when the data supports it
// (Publish ONLY when the API says the draft is publishable), render the provider's own text as escaped text nodes only, and take every platform string from the registry copy.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIG_ERROR_CODES, gigVersionStatusKey, gigWireCode, type GigFieldDto } from '@bananagig/contracts';
import ProviderGigsPage, { dynamic, metadata } from './app/provider/gigs/page';
import ProviderGigPage, { dynamic as gigDynamic } from './app/provider/gigs/[gigId]/page';
import ProviderGigVersionPage from './app/provider/gigs/[gigId]/versions/[version]/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { REGISTRY_COPY, startContentStub, type ContentStub, type StubCatalog } from './testing/content-stub';
import {
  GIG_COPY,
  GIG_ID,
  GIG_TEXT,
  OTHER_GIG_ID,
  attachGigApi,
  choicesDto,
  detailDto,
  fieldDto,
  issueDto,
  menuDto,
  menuItemDto,
  publishedVersionDto,
  summaryOf,
  versionDto,
  type GigApiStub,
} from './testing/gig-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
const signals = vi.hoisted(() => ({
  Redirect: class RedirectSignal extends Error {
    constructor(public readonly target: string) {
      super(`redirect ${target}`);
    }
  },
  NotFound: class NotFoundSignal extends Error {},
}));
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new signals.Redirect(target);
  },
  notFound: () => {
    throw new signals.NotFound('not found');
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-7', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const t = (key: string): string => GIG_TEXT[key] ?? `missing copy for ${key}`;
const ed = (s: string): string => t(`provider.gig.editor.${s}`);
const menuT = (s: string): string => t(`provider.gig.menu.${s}`);
const createT = (s: string): string => t(`provider.gig.create.${s}`);
const FIELD_LABEL = (k: string): string => `Registry label ${k}`;
const fieldKeys = (k: string): Record<string, string> => ({
  [`catalog.gig_template.field.${k}.label`]: FIELD_LABEL(k),
  [`catalog.gig_template.field.${k}.help`]: `Registry help ${k}`,
});
const EXTRA: Record<string, string> = {
  ...Object.assign({}, ...['rooms', 'notes', 'details', 'area', 'pets', 'supplies', 'length', 'inclusions', 'gear', 'fixedthing'].map(fieldKeys)),
  'catalog.gig_template.field.fixedthing.default': 'Registry fixed default text',
  'catalog.gig_template.field.notes.default': 'Registry notes example',
  'catalog.gig_template.option.provider': 'Registry option provider',
  'catalog.gig_template.option.customer': 'Registry option customer',
  'catalog.gig_template.deep_clean.issue': 'unused',
};
const withCopy = (extra: Record<string, string> = EXTRA, drop: (k: string) => boolean = () => false): StubCatalog => ({
  'en-US': {
    ...Object.fromEntries(Object.entries(GIG_COPY['en-US']!).filter(([k]) => !drop(k))),
    ...Object.fromEntries(Object.entries(extra).map(([k, value]) => [k, { value }])),
  },
});

/** A template with one field of every supported type, a platform-fixed one and an unsupported required one. */
const FIELDS: GigFieldDto[] = [
  fieldDto({
    fieldKey: 'rooms',
    fieldType: 'INTEGER',
    behavior: 'PROVIDER_REQUIRED',
    required: true,
    displayOrder: 1,
    minNumber: 1,
    maxNumber: 10,
    defaultNumber: 2,
    labelContentKey: 'catalog.gig_template.field.rooms.label',
    helpContentKey: 'catalog.gig_template.field.rooms.help',
  }),
  fieldDto({
    fieldKey: 'notes',
    fieldType: 'TEXT',
    displayOrder: 2,
    maxLength: 200,
    labelContentKey: 'catalog.gig_template.field.notes.label',
    defaultContentKey: 'catalog.gig_template.field.notes.default',
  }),
  fieldDto({ fieldKey: 'details', fieldType: 'LONG_TEXT', displayOrder: 3, maxLength: 900, labelContentKey: 'catalog.gig_template.field.details.label' }),
  fieldDto({ fieldKey: 'area', fieldType: 'DECIMAL', displayOrder: 4, labelContentKey: 'catalog.gig_template.field.area.label' }),
  fieldDto({ fieldKey: 'pets', fieldType: 'BOOLEAN', displayOrder: 5, labelContentKey: 'catalog.gig_template.field.pets.label' }),
  fieldDto({
    fieldKey: 'supplies',
    fieldType: 'ENUM',
    behavior: 'PROVIDER_REQUIRED',
    required: true,
    displayOrder: 6,
    labelContentKey: 'catalog.gig_template.field.supplies.label',
    options: [
      { optionCode: 'customer', displayOrder: 2, isDefault: false, labelContentKey: 'catalog.gig_template.option.customer' },
      { optionCode: 'provider', displayOrder: 1, isDefault: true, labelContentKey: 'catalog.gig_template.option.provider' },
    ],
  }),
  fieldDto({
    fieldKey: 'length',
    fieldType: 'DURATION',
    displayOrder: 7,
    minNumber: 15,
    maxNumber: 240,
    labelContentKey: 'catalog.gig_template.field.length.label',
  }),
  fieldDto({
    fieldKey: 'fixedthing',
    fieldType: 'TEXT',
    behavior: 'PLATFORM_FIXED',
    fixed: true,
    displayOrder: 8,
    labelContentKey: 'catalog.gig_template.field.fixedthing.label',
    defaultContentKey: 'catalog.gig_template.field.fixedthing.default',
  }),
  // an equipment reference stays unsupported (MEDIA fields are photos since CAT-004: see gig-children.test.tsx)
  fieldDto({
    fieldKey: 'gear',
    fieldType: 'EQUIPMENT_REFERENCE',
    behavior: 'PROVIDER_REQUIRED',
    supported: false,
    required: false,
    displayOrder: 9,
    labelContentKey: 'catalog.gig_template.field.gear.label',
  }),
];

describe('provider Gig pages', () => {
  let stub: ContentStub;
  let api: GigApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(withCopy());
    api = attachGigApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = withCopy();
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
  const clean = (html: string): string => html.replaceAll('<!-- -->', '').replace(/<form action="([^"]*)" method="post"/g, '<form method="post" action="$1"');
  type Q = Record<string, string | string[] | undefined>;
  const renderMenu = async (q: Q = {}) => clean(renderToString(await ProviderGigsPage({ searchParams: Promise.resolve(q) })));
  const renderGig = async (q: Q = {}, gigId = GIG_ID) =>
    clean(renderToString(await ProviderGigPage({ params: Promise.resolve({ gigId }), searchParams: Promise.resolve(q) })));
  const renderVersion = async (version = '1', gigId = GIG_ID) =>
    clean(renderToString(await ProviderGigVersionPage({ params: Promise.resolve({ gigId, version }) })));
  const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  const formsOf = (html: string) =>
    [...html.matchAll(/<form ([^>]*)>(.*?)<\/form>/g)].map((m) => {
      const a = attrs(m[1]!);
      expect(a.method, m[1]).toBe('post');
      return {
        action: a.action!,
        describedBy: a['aria-describedby'],
        inner: m[2]!,
        hidden: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => attrs(i[1]!)).filter((i) => i.type === 'hidden'),
      };
    });
  const formFor = (html: string, action: string) => formsOf(html).find((f) => f.action === `/auth/provider/gigs/${action}`);
  const actionsOf = (html: string): string[] => formsOf(html).map((f) => f.action.replace('/auth/provider/gigs/', ''));
  const tagOf = (html: string, id: string): string => new RegExp(`<(?:input|textarea|select) [^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';
  const gigCalls = () => api.gigCalls();
  /** Registers a detail (and its versions) with the stub. */
  const give = (detail = detailDto({ draft: versionDto({ revision: 7, fields: FIELDS }) })) => {
    api.details.set(detail.gig.gigId, detail);
    for (const v of [detail.currentVersion, detail.draftVersion]) if (v) api.versions.set(`${detail.gig.gigId}/${v.versionNumber}`, v);
    return detail;
  };

  describe('GigMenu: metadata and signed out', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(gigDynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
    });
    it('shows the registry title and the sign-in control that returns to /provider/gigs; no Gig call is made', async () => {
      const html = await renderMenu();
      expect(html).toContain(`<h1>${t('provider.gig.page.title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/gigs">Registry sign in</a>');
      expect(api.calls).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label)', async () => {
      stub.mode = 'down';
      const html = await renderMenu();
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/gigs">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('shows no notice, no error and no form even when the URL carries them', async () => {
      const html = await renderMenu({ error: 'GIG_STALE_DRAFT', notice: 'created' });
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('<form');
    });
  });

  describe('GigMenu: signed in', () => {
    it('reads the menu and the template choices with the session token and role, and renders the registry copy', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      const html = await renderMenu();
      const calls = gigCalls();
      expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(['GET /api/v1/provider/gig-templates', 'GET /api/v1/provider/gigs']);
      for (const c of calls) expect(c).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'PROVIDER', correlationId: 'web-test-corr-7' });
      expect(html).toContain(`<h1>${t('provider.gig.page.title')}</h1>`);
      expect(html).toContain(`<p>${t('provider.gig.page.intro')}</p>`);
      expect(html).not.toContain('role="alert"');
    });
    it('always says that publishing a Gig does not put the provider live', async () => {
      signedIn();
      expect(await renderMenu()).toContain(`<p class="gig-note">${menuT('not_live_note')}</p>`);
      api.menu = menuDto([], { canCreate: false, cannotCreateReason: 'PROVIDER_NOT_ELIGIBLE' });
      expect(await renderMenu()).toContain(menuT('not_live_note'));
    });
    it('shows the limits as labelled counts (no invented words)', async () => {
      signedIn();
      api.menu = menuDto([], { limits: { maxActive: 25, maxDrafts: 10, activeCount: 3, draftCount: 4 } });
      const html = await renderMenu();
      expect(html).toContain(`<h2 id="gig-limits">${menuT('limits_heading')}</h2>`);
      expect(html).toContain(`<dt>${menuT('limit_active')}</dt><dd>3 / 25</dd>`);
      expect(html).toContain(`<dt>${menuT('limit_drafts')}</dt><dd>4 / 10</dd>`);
    });
    it('an empty menu shows the empty copy and the create form: a labelled select of the registry names of the templates, an empty first option, a one-use token and a submit', async () => {
      signedIn();
      api.choices = choicesDto([
        ['deep_clean', 'house_cleaning'],
        ['window_wash', 'window_cleaning'],
      ]);
      const html = await renderMenu();
      expect(html).toContain(`<p>${menuT('empty')}</p>`);
      expect(actionsOf(html)).toEqual(['create']);
      const form = formFor(html, 'create')!;
      expect(form.inner).toContain(`<label for="gig-template">${createT('template')}</label>`);
      expect(form.inner).toContain(`<option value="">${ed('select_empty')}</option>`);
      expect(form.inner).toContain('<option value="deep_clean">Registry template deep clean</option>');
      expect(form.inner).toContain('<option value="window_wash">Registry template window wash</option>');
      expect(tagOf(html, 'gig-template')).toContain('required');
      expect(attrs(tagOf(html, 'gig-template')).name).toBe('gigTemplateCode');
      expect(form.inner).toContain(`<button type="submit">${createT('submit')}</button>`);
      expect(form.hidden.map((h) => h.name)).toEqual(['clientRequestId']);
      expect(form.hidden[0]!.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(html).toContain(`<h2 id="gig-create">${createT('heading')}</h2>`);
      // nothing is chosen for the person
      expect(form.inner).not.toMatch(/<option [^>]*selected/);
    });
    it('every render carries a fresh idempotency token', async () => {
      signedIn();
      const a = formFor(await renderMenu(), 'create')!.hidden[0]!.value;
      const b = formFor(await renderMenu(), 'create')!.hidden[0]!.value;
      expect(a).not.toBe(b);
    });
    it('a template name the registry cannot serve is shown by its code (an identifier), never by an invented name', async () => {
      signedIn();
      api.choices = choicesDto([['unnamed_template', 'house_cleaning']]);
      const html = await renderMenu();
      expect(html).toContain('<option value="unnamed_template">unnamed_template</option>');
    });
    it('canCreate with no template to choose shows the "none available" copy and no form', async () => {
      signedIn();
      api.choices = choicesDto([]);
      const html = await renderMenu();
      expect(html).toContain(`<p>${createT('none_available')}</p>`);
      expect(html).not.toContain('<form');
    });
    it('a failing choices list is treated as "none available" and is not a page-level failure', async () => {
      signedIn();
      api.forced['GET /provider/gig-templates'] = { status: 503, code: 'GIG_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await renderMenu();
      expect(html).toContain(createT('none_available'));
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('<form');
    });
    it('a provider who cannot create (not eligible) gets no create form, no template read, and a link to the registration', async () => {
      signedIn();
      api.menu = menuDto([], { canCreate: false, cannotCreateReason: 'PROVIDER_NOT_ELIGIBLE' });
      const html = await renderMenu();
      expect(html).toContain(`<a href="/provider/registration">${menuT('not_eligible')}</a>`);
      expect(html).not.toContain('<form');
      expect(gigCalls().map((c) => c.path)).toEqual(['/api/v1/provider/gigs']);
    });
    it('a provider at the draft limit gets the limit note, no create form and no template read', async () => {
      signedIn();
      api.menu = menuDto([], { canCreate: false, cannotCreateReason: 'DRAFT_LIMIT_REACHED' });
      const html = await renderMenu();
      expect(html).toContain(`<p>${menuT('draft_limit')}</p>`);
      expect(html).not.toContain('<form');
      expect(gigCalls().map((c) => c.path)).toEqual(['/api/v1/provider/gigs']);
    });
    it('lists every Gig: registry template name, text status, current version (title, price in minor units with its currency, duration), draft and a link named after the Gig', async () => {
      signedIn();
      const published = give(
        detailDto({
          current: publishedVersionDto({ versionNumber: 2 }),
          draft: versionDto({ versionNumber: 3, title: 'Next spring clean' }),
          gig: { gigId: GIG_ID },
        }),
      );
      const second = detailDto({
        gig: { gigId: OTHER_GIG_ID, gigTemplateCode: 'window_wash', nameContentKey: 'catalog.gig_template.window_wash.name' },
        current: null,
        draft: versionDto({ title: null }),
      });
      api.menu = menuDto([menuItemDto(published), menuItemDto(second)]);
      const html = await renderMenu();
      const items = html.match(/<li>.*?<\/li>/g)!;
      expect(items).toHaveLength(2);
      expect(items[0]).toContain(`<h3 id="gig-name-${GIG_ID}">Registry template deep clean</h3>`);
      expect(items[0]).toContain(`<p class="gig-status">Registry gig state active</p>`);
      expect(items[0]).toContain('Spotless two-room clean');
      expect(items[0]).toContain('12500 USD');
      expect(items[0]).toContain('<dd>120</dd>');
      expect(items[0]).toContain(`${menuT('draft_version')} (${ed('version')} 3): Next spring clean`);
      expect(items[0]).toContain(
        `<a id="gig-open-${GIG_ID}" href="/provider/gigs/${GIG_ID}" aria-labelledby="gig-open-${GIG_ID} gig-name-${GIG_ID}">${menuT('open')}</a>`,
      );
      expect(items[1]).toContain('Registry template window wash');
      expect(items[1]).toContain(`<p>${menuT('no_published')}</p>`);
      expect(items[1]).toContain(`href="/provider/gigs/${OTHER_GIG_ID}"`);
      expect(html).not.toContain(`<p>${menuT('empty')}</p>`);
    });
    it('provider text in the list is escaped: a script or an image handler in a title is text, never markup', async () => {
      signedIn();
      const evil = '<script>alert(1)</script> & <img src=x onerror=alert(2)>';
      const d = detailDto({ current: publishedVersionDto({ title: evil }), draft: versionDto({ title: evil }) });
      api.menu = menuDto([menuItemDto(d)]);
      const html = await renderMenu();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(2)&gt;');
    });
    it('a Gig without a current version does not claim one; a RETIRED Gig is listed with its status', async () => {
      signedIn();
      const retired = detailDto({ gig: { status: 'RETIRED', statusKey: 'provider.gig.status.retired', retiredAt: '2026-10-18T00:00:00.000Z' } });
      api.menu = menuDto([menuItemDto(retired)]);
      const html = await renderMenu();
      expect(html).toContain('Registry gig state retired');
      expect(html).toContain(menuT('no_published'));
    });
  });

  describe('GigMenu: notices and errors come from closed lists of words', () => {
    it.each(GIG_ERROR_CODES)("?error=GIG_%s shows that code's registry message in an alert", async (code) => {
      signedIn();
      const html = await renderMenu({ error: gigWireCode(code) });
      expect(html).toContain(`<p id="gig-error" role="alert">Registry gig error ${code.toLowerCase()}</p>`);
      expect(html.match(/role="alert"/g)).toHaveLength(1);
    });
    it('unknown words, API_ERROR and Object.prototype names show the generic message and are never echoed', async () => {
      signedIn();
      for (const error of ['API_ERROR', 'STALE_DRAFT', 'nope', '"><script>alert(1)</script>', 'constructor', '__proto__', 'toString', 'GIG_NOPE', '']) {
        const html = await renderMenu({ error });
        expect(html, JSON.stringify(error)).toContain(`<p id="gig-error" role="alert">Registry gig error unavailable</p>`);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('NOPE');
      }
    });
    it('a repeated ?error= parameter is ignored', async () => {
      signedIn();
      expect(await renderMenu({ error: ['GIG_CONFLICT', 'x'] })).not.toContain('role="alert"');
    });
    it('the create form is described by the error element when there is an error, and by nothing when there is none', async () => {
      signedIn();
      expect(formFor(await renderMenu({ error: 'GIG_TEMPLATE_NOT_AVAILABLE' }), 'create')!.describedBy).toBe('gig-error');
      expect(formFor(await renderMenu(), 'create')!.describedBy).toBeUndefined();
    });
    it('the menu shows no notice (create and the other actions end on the Gig page)', async () => {
      signedIn();
      expect(await renderMenu({ notice: 'created' })).not.toContain('role="status"');
    });
  });

  describe('GigMenu: failures', () => {
    it('with the menu unreadable the page says it could not be done (generic copy in an alert), offers no form and does not read the templates', async () => {
      signedIn();
      api.forced['GET /provider/gigs'] = { status: 503, code: 'GIG_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await renderMenu();
      expect(html).toContain(`<h1>${t('provider.gig.page.title')}</h1>`);
      expect(html).toContain('<p id="gig-error" role="alert">Registry gig error unavailable</p>');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('GIG_UNAVAILABLE');
      expect(gigCalls()).toHaveLength(1);
    });
    it('a 403 or a 404 of the API is "unavailable" too, never its code', async () => {
      signedIn();
      for (const status of [403, 404, 409]) {
        api.forced['GET /provider/gigs'] = { status, code: 'GIG_PROVIDER_NOT_ELIGIBLE', category: 'AUTHORIZATION' };
        const html = await renderMenu();
        expect(html, String(status)).toContain('Registry gig error unavailable');
        expect(html).not.toContain('NOT_ELIGIBLE');
      }
    });
    it('a response that violates the contract is "unavailable", not a crash', async () => {
      signedIn();
      api.rawBody['GET /provider/gigs'] = { gigs: 'nonsense' };
      const html = await renderMenu();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('<form');
    });
    it('a revoked session goes to /auth/revoked before anything is rendered', async () => {
      signedIn();
      api.revoked = true;
      await expect(renderMenu()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
  });

  describe('every string of the menu is registry copy', () => {
    it('with NO Gig copy in the registry the page shows nothing but identifiers and numbers: no literal replaces a missing text', async () => {
      signedIn();
      const d = detailDto({ current: publishedVersionDto(), draft: versionDto() });
      api.menu = menuDto([menuItemDto(d)]);
      stub.catalog = REGISTRY_COPY;
      const html = await renderMenu({ error: 'GIG_CONFLICT' });
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('<label');
      expect(html).not.toContain('<form'); // nothing to press and no label: no create form
      expect(html).not.toContain('<a id="gig-open'); // a link without text is not offered
    });
    it('no managed word is a literal of the app', async () => {
      signedIn();
      api.menu = menuDto([menuItemDto(detailDto({ current: publishedVersionDto(), draft: versionDto() }))]);
      const text = (await renderMenu({ error: 'GIG_CONFLICT' })).replace(/<[^>]*>/g, ' ').replace(/Registry [a-z_ ]+?(?= {2,}|$)/g, ' ');
      for (const literal of ['Create', 'Open', 'Publish', 'Retire', 'Gig', 'Your', 'Price', 'Draft', 'Version', 'Limit', 'live'])
        expect(text.replace(/Spotless two-room clean|We bring everything\./g, ''), literal).not.toContain(literal);
    });
  });

  describe('GigDetail: ids, access and failures', () => {
    it.each(['x', 'not-a-uuid', `${GIG_ID}0`, '../../etc', GIG_ID.toUpperCase()])(
      'a Gig id that is not a lower-case UUID (%j) is a not-found page and nothing is read',
      async (id) => {
        signedIn();
        await expect(renderGig({}, id)).rejects.toBeInstanceOf(signals.NotFound);
        expect(api.calls).toEqual([]);
      },
    );
    it("another account's (or an unknown) Gig is a 404 from the API and the same not-found page here", async () => {
      signedIn();
      await expect(renderGig({}, OTHER_GIG_ID)).rejects.toBeInstanceOf(signals.NotFound);
      expect(gigCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/provider/gigs/${OTHER_GIG_ID}`]);
    });
    it('signed out: the title and a sign-in control that returns to this Gig, no read', async () => {
      const html = await renderGig();
      expect(html).toContain(`<a href="/auth/login?returnTo=/provider/gigs/${GIG_ID}">Registry sign in</a>`);
      expect(api.calls).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('an API failure is the generic message in an alert, with the back link and no form', async () => {
      signedIn();
      api.forced[`GET /provider/gigs/:gigId`] = { status: 503, code: 'GIG_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await renderGig();
      expect(html).toContain('<p id="gig-error" role="alert">Registry gig error unavailable</p>');
      expect(html).toContain(`<a href="/provider/gigs">${ed('back')}</a>`);
      expect(html).not.toContain('<form');
    });
    it('a revoked session goes to /auth/revoked', async () => {
      signedIn();
      give();
      api.revoked = true;
      await expect(renderGig()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
    it('reads the Gig once with the session token and role', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      give();
      await renderGig();
      expect(gigCalls()).toHaveLength(1);
      expect(gigCalls()[0]).toMatchObject({
        method: 'GET',
        path: `/api/v1/provider/gigs/${GIG_ID}`,
        authorization: `Bearer ${TOKENS.access}`,
        activeRole: 'PROVIDER',
      });
    });
  });

  describe('GigDetail: the draft editor', () => {
    const editorOf = (html: string) => formFor(html, 'save')!;
    it('is one POST form to /auth/provider/gigs/save with the Gig id and the CURRENT revision as its only hidden fields', async () => {
      signedIn();
      give();
      const html = await renderGig();
      expect(actionsOf(html)).toEqual(['save', 'variants', 'add-ons', 'retire']);
      expect(editorOf(html).hidden).toEqual([
        { type: 'hidden', name: 'gigId', value: GIG_ID },
        { type: 'hidden', name: 'expectedRevision', value: '7' },
      ]);
      expect(html).toContain(`<h2 id="gig-draft">${ed('draft_heading')}</h2>`);
      expect(html).toContain(`<button type="submit">${ed('save')}</button>`);
    });
    it('title, short pitch and description have a visible bound label, their hint, the configured maximum length and a text "required" marker', async () => {
      signedIn();
      give();
      const form = editorOf(await renderGig());
      expect(form.inner).toContain(`<label for="gig-title">${ed('title')}<span class="gig-req"> (${ed('required')})</span></label>`);
      expect(form.inner).toContain(`<p id="gig-title-hint" class="muted">${ed('title_hint')}</p>`);
      expect(attrs(tagOf(form.inner, 'gig-title'))).toMatchObject({
        type: 'text',
        name: 'title',
        value: '',
        maxLength: '100',
        'aria-describedby': 'gig-title-hint',
      });
      expect(form.inner).toContain(`<label for="gig-short-pitch">${ed('short_pitch')}`);
      expect(attrs(tagOf(form.inner, 'gig-short-pitch'))).toMatchObject({
        name: 'shortPitch',
        rows: '3',
        maxLength: '1000',
        'aria-describedby': 'gig-short-pitch-hint',
      });
      expect(form.inner).toContain(`<label for="gig-description">${ed('description')}`);
      expect(attrs(tagOf(form.inner, 'gig-description'))).toMatchObject({
        name: 'description',
        rows: '8',
        maxLength: '5000',
        'aria-describedby': 'gig-description-hint',
      });
    });
    it('shows the values of the draft, escaped: a title with markup and quotes cannot break out of the attribute or the text', async () => {
      signedIn();
      const evil = '"><script>alert(1)</script> & <b>x</b>';
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, title: evil, shortPitch: evil, description: `${evil}\nsecond line` }) }));
      const html = await renderGig();
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<b>x</b>');
      expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;"');
      expect(html).toContain('second line</textarea>');
    });
    it('the price is a text input in minor units with the SERVER-derived currency shown as text (never an input); the duration carries its bounds and the suggestion', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, price: { amountMinor: 12500, currency: 'USD' }, durationMinutes: 90 }) }));
      const form = editorOf(await renderGig());
      expect(form.inner).toContain(`<label for="gig-price">${ed('price')}<span class="gig-req"> (${ed('required')})</span></label>`);
      expect(form.inner).toContain(`<p id="gig-currency">${ed('currency')}: USD</p>`);
      expect(attrs(tagOf(form.inner, 'gig-price'))).toMatchObject({
        type: 'text',
        name: 'price',
        inputMode: 'numeric',
        pattern: '[0-9]*',
        value: '12500',
        'aria-describedby': 'gig-price-hint gig-currency',
      });
      expect(form.inner).not.toMatch(/name="(currency|priceCurrency)"/);
      expect(attrs(tagOf(form.inner, 'gig-duration'))).toMatchObject({
        type: 'number',
        inputMode: 'numeric',
        step: '1',
        name: 'duration',
        value: '90',
        min: '30',
        max: '480',
        placeholder: '120',
      });
    });
    it('no price or duration control when the bound template version permits neither', async () => {
      signedIn();
      const draft = versionDto({ revision: 7, fields: FIELDS });
      draft.constraints = {
        ...draft.constraints,
        price: { permitted: false, required: false, currency: null },
        duration: { permitted: false, required: false, minMinutes: null, maxMinutes: null, suggestedMinutes: null },
      };
      give(detailDto({ draft }));
      const form = editorOf(await renderGig());
      expect(form.inner).not.toContain('gig-price');
      expect(form.inner).not.toContain('gig-duration');
      expect(form.inner).not.toContain('name="price"');
      expect(form.inner).not.toContain('name="duration"');
    });
    it('renders one control per supported editable template field by type, in display order, each with a bound label, a text required/optional marker and the right name', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: [...FIELDS].reverse() }) }));
      const html = await renderGig();
      const form = editorOf(html);
      const names = [...form.inner.matchAll(/ name="(field\.[^"]+)"/g)].map((m) => m[1]);
      expect(names).toEqual(['field.n.rooms', 'field.t.notes', 'field.t.details', 'field.d.area', 'field.b.pets', 'field.e.supplies', 'field.n.length']);
      for (const k of ['rooms', 'notes', 'details', 'area', 'pets', 'supplies', 'length'])
        expect(form.inner, k).toContain(`<label for="gig-field-${k}">${FIELD_LABEL(k)}`);
      expect(form.inner).toContain(`${FIELD_LABEL('rooms')}<span class="gig-req"> (${ed('required')})</span></label>`);
      expect(form.inner).toContain(`${FIELD_LABEL('notes')}<span class="gig-req"> (${ed('optional')})</span></label>`);
      expect(tagOf(html, 'gig-field-rooms')).toMatch(/type="number"[^>]*min="1"[^>]*max="10"[^>]*placeholder="2"/);
      expect(tagOf(html, 'gig-field-notes')).toMatch(/type="text"[^>]*maxLength="200"[^>]*placeholder="Registry notes example"/i);
      expect(tagOf(html, 'gig-field-details')).toMatch(/maxLength="900"/i);
      expect(tagOf(html, 'gig-field-area')).toMatch(/inputMode="decimal"/i);
      expect(tagOf(html, 'gig-field-length')).toMatch(/type="number"[^>]*min="15"[^>]*max="240"/);
    });
    it('a BOOLEAN field is a select with an empty, a yes and a no option (so "unset" and "no" differ); an ENUM field lists the options of the template version in order with registry labels', async () => {
      signedIn();
      give(
        detailDto({
          draft: versionDto({
            revision: 7,
            fields: FIELDS,
            fieldValues: [
              { fieldKey: 'pets', value: false },
              { fieldKey: 'supplies', value: 'customer' },
            ],
          }),
        }),
      );
      const form = editorOf(await renderGig());
      const pets = /<select [^>]*id="gig-field-pets"[^>]*>(.*?)<\/select>/.exec(form.inner)![1]!;
      expect(pets).toBe(
        `<option value="">${ed('select_empty')}</option><option value="true">${ed('yes')}</option><option value="false" selected="">${ed('no')}</option>`,
      );
      const supplies = /<select [^>]*id="gig-field-supplies"[^>]*>(.*?)<\/select>/.exec(form.inner)![1]!;
      expect(supplies).toBe(
        `<option value="">${ed('select_empty')}</option><option value="provider">Registry option provider</option><option value="customer" selected="">Registry option customer</option>`,
      );
    });
    it('shows the stored value of every field type', async () => {
      signedIn();
      const values = [
        { fieldKey: 'rooms', value: 3 },
        { fieldKey: 'notes', value: 'Mind the cat' },
        { fieldKey: 'details', value: 'Long\ntext' },
        { fieldKey: 'area', value: '12.5' },
        { fieldKey: 'length', value: 45 },
      ];
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, fieldValues: values }) }));
      const html = await renderGig();
      expect(tagOf(html, 'gig-field-rooms')).toContain('value="3"');
      expect(tagOf(html, 'gig-field-notes')).toContain('value="Mind the cat"');
      expect(html).toContain('Long\ntext</textarea>');
      expect(tagOf(html, 'gig-field-area')).toContain('value="12.5"');
      expect(tagOf(html, 'gig-field-length')).toContain('value="45"');
    });
    it('the help text of a field is linked to its control with aria-describedby', async () => {
      signedIn();
      give();
      const html = await renderGig();
      expect(html).toContain('<p id="gig-field-rooms-help" class="muted">Registry help rooms</p>');
      expect(tagOf(html, 'gig-field-rooms')).toContain('aria-describedby="gig-field-rooms-help"');
      expect(tagOf(html, 'gig-field-notes')).not.toContain('aria-describedby');
    });
    it('a platform-fixed field is never an input: it is listed read-only under the fixed heading with the template value', async () => {
      signedIn();
      give();
      const html = await renderGig();
      expect(html).not.toContain('field.t.fixedthing');
      expect(html).not.toContain('gig-field-fixedthing"');
    });
    it('an unsupported field is listed with the "not available yet" note and is never an input (required ones are marked required)', async () => {
      signedIn();
      give();
      const form = editorOf(await renderGig());
      expect(form.inner).toContain(
        `<li id="gig-field-gear">${FIELD_LABEL('gear')}<span class="gig-req"> (${ed('required')})</span>: ${ed('unsupported_note')}</li>`,
      );
      expect(form.inner).not.toContain('name="field.m');
      expect(form.inner).not.toMatch(/name="[^"]*gear/);
    });
    it('a control whose registry label is missing keeps its VALUE in a hidden field (a save must never silently clear it); no unlabelled control is offered', async () => {
      signedIn();
      give(
        detailDto({
          draft: versionDto({
            revision: 7,
            fields: FIELDS,
            title: 'Kept title',
            shortPitch: 'Kept pitch',
            description: 'Kept description',
            price: { amountMinor: 900, currency: 'USD' },
            durationMinutes: 60,
          }),
        }),
      );
      stub.catalog = withCopy(EXTRA, (k) =>
        [
          'provider.gig.editor.title',
          'provider.gig.editor.short_pitch',
          'provider.gig.editor.description',
          'provider.gig.editor.price',
          'provider.gig.editor.duration',
        ].includes(k),
      );
      const html = await renderGig();
      const form = editorOf(html);
      for (const id of ['gig-title', 'gig-short-pitch', 'gig-description', 'gig-price', 'gig-duration']) expect(form.inner, id).not.toContain(`id="${id}"`);
      const hidden = Object.fromEntries(form.hidden.map((h) => [h.name, h.value]));
      expect(hidden).toMatchObject({ title: 'Kept title', shortPitch: 'Kept pitch', description: 'Kept description', price: '900', duration: '60' });
    });
    it('a template field whose registry label is missing is labelled with its key (an identifier) so it is never unlabelled', async () => {
      signedIn();
      give();
      const { 'catalog.gig_template.field.rooms.label': _label, ...rest } = EXTRA;
      stub.catalog = withCopy(rest, (k) => k === 'catalog.gig_template.field.rooms.label');
      expect(editorOf(await renderGig()).inner).toContain('<label for="gig-field-rooms">rooms');
    });
    it('uses no script and no inline handler; the form is novalidate so the server explains what is wrong', async () => {
      signedIn();
      give();
      const html = await renderGig();
      for (const forbidden of ['<script', 'onclick', 'onload', 'autofocus', 'formaction', 'dangerouslySetInnerHTML'])
        expect(html, forbidden).not.toContain(forbidden);
      expect(html).toMatch(/<form noValidate="" action="\/auth\/provider\/gigs\/save" method="post"/);
    });
  });

  describe('GigDetail: what stands in the way of publishing', () => {
    const issues = [
      issueDto({ target: 'title', reason: 'TITLE_REQUIRED', messageKey: 'provider.gig.issue.title_required' }),
      issueDto({ target: 'price', reason: 'PRICE_REQUIRED', messageKey: 'provider.gig.issue.price_required' }),
      issueDto({ target: 'field', fieldKey: 'rooms', reason: 'FIELD_REQUIRED', messageKey: 'provider.gig.issue.field_required' }),
      issueDto({ target: 'field', fieldKey: 'gear', reason: 'FIELD_TYPE_NOT_SUPPORTED', messageKey: 'provider.gig.issue.field_type_not_supported' }),
      issueDto({ target: 'template', reason: 'TEMPLATE_VERSION_RETIRED', messageKey: 'provider.gig.issue.template_version_retired' }),
    ];
    it('lists the issues of the API with registry messages, each linking to its control; the template issue has no link', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, publishable: false, issues }) }));
      const html = await renderGig();
      expect(html).toContain(`<h3 id="gig-issues-heading">${ed('issues_heading')}</h3>`);
      expect(html).toContain('<li id="gig-issue-0"><a href="#gig-title">Registry issue title_required</a></li>');
      expect(html).toContain('<li id="gig-issue-1"><a href="#gig-price">Registry issue price_required</a></li>');
      expect(html).toContain('<li id="gig-issue-2"><a href="#gig-field-rooms">Registry issue field_required</a></li>');
      expect(html).toContain('<li id="gig-issue-3"><a href="#gig-field-gear">Registry issue field_type_not_supported</a></li>');
      expect(html).toContain('<li id="gig-issue-4">Registry issue template_version_retired</li>');
      // the summary comes before the form, so a keyboard or screen reader user meets it first
      expect(html.indexOf('id="gig-issues"')).toBeLessThan(html.search(/<form [^>]*action="\/auth\/provider\/gigs\/save"/));
    });
    it('links each control to its issues with aria-describedby and marks it aria-invalid; the form is described by the summary', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, publishable: false, issues }) }));
      const html = await renderGig();
      expect(tagOf(html, 'gig-title')).toContain('aria-describedby="gig-title-hint gig-issue-0"');
      expect(tagOf(html, 'gig-title')).toContain('aria-invalid="true"');
      expect(tagOf(html, 'gig-price')).toContain('aria-describedby="gig-price-hint gig-currency gig-issue-1"');
      expect(tagOf(html, 'gig-field-rooms')).toContain('aria-describedby="gig-field-rooms-help gig-issue-2"');
      expect(tagOf(html, 'gig-field-rooms')).toContain('aria-invalid="true"');
      expect(tagOf(html, 'gig-description')).not.toContain('aria-invalid');
      expect(formFor(html, 'save')!.describedBy).toBe('gig-issues');
    });
    it('with an error in the URL as well the forms are described by both the error and the summary', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, publishable: false, issues }) }));
      const html = await renderGig({ error: 'GIG_PUBLISH_BLOCKED' });
      expect(html).toContain('<p id="gig-error" role="alert">Registry gig error publish_blocked</p>');
      expect(formFor(html, 'save')!.describedBy).toBe('gig-error gig-issues');
    });
    it('an issue the registry cannot word is left out, and with none worded there is no summary at all (no empty list)', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS, publishable: false, issues }) }));
      stub.catalog = withCopy(EXTRA, (k) => k.startsWith('provider.gig.issue.'));
      const html = await renderGig();
      expect(html).not.toContain('gig-issues');
      expect(formFor(html, 'save')!.describedBy).toBeUndefined();
    });
    it('Publish is offered ONLY when the API says the draft is publishable, with the current revision as its only field', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 9, fields: FIELDS, publishable: true }) }));
      const html = await renderGig();
      expect(actionsOf(html)).toEqual(['save', 'variants', 'add-ons', 'publish', 'retire']);
      const form = formFor(html, 'publish')!;
      expect(form.hidden).toEqual([
        { type: 'hidden', name: 'gigId', value: GIG_ID },
        { type: 'hidden', name: 'expectedRevision', value: '9' },
      ]);
      expect(form.inner).toContain(`<button type="submit">${ed('publish')}</button>`);
      expect(html).not.toContain('gig-issues');
    });
    it.each([false, null])('no Publish when publishable is %s', async (publishable) => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 9, fields: FIELDS, publishable }) }));
      expect(actionsOf(await renderGig())).toEqual(['save', 'variants', 'add-ons', 'retire']);
    });
    it('without the Publish label in the registry no publish form is offered', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 9, fields: FIELDS, publishable: true }) }));
      stub.catalog = withCopy(EXTRA, (k) => k === 'provider.gig.editor.publish');
      expect(actionsOf(await renderGig())).toEqual(['save', 'variants', 'add-ons', 'retire']);
    });
  });

  describe('GigDetail: states of the Gig', () => {
    it('ACTIVE with a draft: the editor, the current version, the history and retire; no "next draft" (one draft at most)', async () => {
      signedIn();
      const published = publishedVersionDto({ versionNumber: 1, fields: FIELDS });
      give(detailDto({ current: published, draft: versionDto({ versionNumber: 2, revision: 4, fields: FIELDS }) }));
      const html = await renderGig();
      expect(actionsOf(html)).toEqual(['save', 'variants', 'add-ons', 'retire']);
      expect(html).toContain(`<h2 id="gig-current">${ed('current_heading')}</h2>`);
      expect(html).toContain(`<h2 id="gig-history">${ed('history_heading')}</h2>`);
      expect(html).not.toContain(ed('new_draft'));
    });
    it('ACTIVE without a draft: a "next draft" form with only the Gig id, the current version and retire', async () => {
      signedIn();
      give(detailDto({ current: publishedVersionDto({ fields: FIELDS }) }));
      const html = await renderGig();
      expect(actionsOf(html)).toEqual(['draft', 'retire']);
      expect(formFor(html, 'draft')!.hidden).toEqual([{ type: 'hidden', name: 'gigId', value: GIG_ID }]);
      expect(formFor(html, 'draft')!.inner).toContain(`<button type="submit">${ed('new_draft')}</button>`);
      expect(html).not.toContain(`<h2 id="gig-draft">`);
    });
    it('DRAFT (never published): the editor and retire, no current version, no "next draft"', async () => {
      signedIn();
      give();
      const html = await renderGig();
      expect(html).not.toContain('id="gig-current"');
      expect(actionsOf(html)).not.toContain('draft');
      expect(html).toContain('Registry gig state draft');
    });
    it('RETIRED: no form at all, the "not editable" note, the text status and the history', async () => {
      signedIn();
      const retiredVersion = versionDto({
        versionNumber: 2,
        status: 'RETIRED',
        statusKey: gigVersionStatusKey('RETIRED'),
        retiredAt: '2026-10-18T00:00:00.000Z',
        fields: FIELDS,
      });
      const superseded = publishedVersionDto({ versionNumber: 1, status: 'SUPERSEDED', statusKey: gigVersionStatusKey('SUPERSEDED') });
      give(
        detailDto({
          gig: { status: 'RETIRED', statusKey: 'provider.gig.status.retired', retiredAt: '2026-10-18T00:00:00.000Z' },
          draft: retiredVersion,
          extraVersions: [summaryOf(superseded)],
        }),
      );
      const html = await renderGig({ notice: 'retired' });
      expect(html).not.toContain('<form');
      expect(html).toContain(`<p>${ed('not_editable')}</p>`);
      expect(html).toContain('Registry gig state retired');
      expect(html).toContain('<p role="status">Registry notice retired</p>');
      expect(html).toContain(`href="/provider/gigs/${GIG_ID}/versions/1"`);
    });
    it('the history lists every version newest first, linking to its read-only page, with its text status, publication date and title', async () => {
      signedIn();
      const v1 = publishedVersionDto({ versionNumber: 1, status: 'SUPERSEDED', statusKey: gigVersionStatusKey('SUPERSEDED'), title: 'Old title' });
      give(
        detailDto({
          current: publishedVersionDto({ versionNumber: 2, title: 'Current title' }),
          draft: versionDto({ versionNumber: 3, title: null }),
          extraVersions: [summaryOf(v1)],
        }),
      );
      const html = await renderGig();
      const items = html.match(/<li>.*?<\/li>/g)!.filter((li) => li.includes('/versions/'));
      expect(items.map((li) => /versions\/(\d)/.exec(li)![1])).toEqual(['3', '2', '1']);
      expect(items[1]).toContain(`${ed('version')} 2</a>`);
      expect(items[1]).toContain('Registry version state published');
      expect(items[1]).toContain(`${ed('published_at')} 2026-10-17)`);
      expect(items[1]).toContain(': Current title');
      expect(items[2]).toContain('Registry version state superseded');
      expect(items[2]).toContain(': Old title');
    });
    it('retire is a separate form with only the Gig id, described by its note', async () => {
      signedIn();
      give();
      const html = await renderGig();
      const form = formFor(html, 'retire')!;
      expect(form.hidden).toEqual([{ type: 'hidden', name: 'gigId', value: GIG_ID }]);
      expect(form.describedBy).toBe('gig-retire-note');
      expect(html).toContain(`<p id="gig-retire-note">${ed('retire_note')}</p>`);
      expect(html).toContain(`<h2 id="gig-retire">${ed('retire')}</h2>`);
    });
    it('shows the current version read-only: provider text as plain text nodes, the price in minor units with its currency, the duration and the field values', async () => {
      signedIn();
      const evil = '<script>alert(1)</script>';
      give(
        detailDto({
          current: publishedVersionDto({
            fields: FIELDS,
            title: evil,
            description: `${evil}\nsecond`,
            fieldValues: [
              { fieldKey: 'rooms', value: 3 },
              { fieldKey: 'pets', value: true },
              { fieldKey: 'supplies', value: 'provider' },
              { fieldKey: 'notes', value: evil },
            ],
          }),
        }),
      );
      const html = await renderGig();
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain(`<dt>${ed('price')}</dt><dd>12500 USD</dd>`);
      expect(html).toContain(`<dt>${ed('duration')}</dt><dd>120</dd>`);
      expect(html).toContain(`<dt>${FIELD_LABEL('rooms')}</dt><dd><span class="gig-text">3</span></dd>`);
      expect(html).toContain(`<dt>${FIELD_LABEL('pets')}</dt><dd><span class="gig-text">${ed('yes')}</span></dd>`);
      expect(html).toContain(`<dt>${FIELD_LABEL('supplies')}</dt><dd><span class="gig-text">Registry option provider</span></dd>`);
      expect(html).toContain(`<h3>${ed('fixed_heading')}</h3>`);
      expect(html).toContain(`<dt>${FIELD_LABEL('fixedthing')}</dt><dd>Registry fixed default text</dd>`);
    });
  });

  describe('GigDetail: notices and errors come from closed lists, proven by the data', () => {
    it('?notice=saved and draft_created need a draft; published needs a current version; retired needs a RETIRED Gig; created is always true of a Gig that exists', async () => {
      signedIn();
      give(detailDto({ draft: versionDto({ revision: 7, fields: FIELDS }) }));
      expect(await renderGig({ notice: 'saved' })).toContain('<p role="status">Registry notice saved</p>');
      expect(await renderGig({ notice: 'draft_created' })).toContain('<p role="status">Registry notice draft created</p>');
      expect(await renderGig({ notice: 'created' })).toContain('<p role="status">Registry notice created</p>');
      expect(await renderGig({ notice: 'published' })).not.toContain('role="status"');
      expect(await renderGig({ notice: 'retired' })).not.toContain('role="status"');
      give(detailDto({ current: publishedVersionDto({ fields: FIELDS }) }));
      expect(await renderGig({ notice: 'published' })).toContain('<p role="status">Registry notice published</p>');
      expect(await renderGig({ notice: 'saved' })).not.toContain('role="status"');
    });
    it('ignores an unknown notice word, a repeated parameter and Object.prototype names, and never echoes them', async () => {
      signedIn();
      give();
      for (const notice of ['nope', '<script>alert(1)</script>', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ['saved', 'created'], ''] as Array<
        string | string[]
      >) {
        const html = await renderGig({ notice });
        expect(html, JSON.stringify(notice)).not.toContain('role="status"');
        expect(html).not.toContain('<script>alert');
      }
    });
    it.each(GIG_ERROR_CODES)("?error=GIG_%s shows that code's registry message in an alert", async (code) => {
      signedIn();
      give();
      const html = await renderGig({ error: gigWireCode(code) });
      expect(html).toContain(`<p id="gig-error" role="alert">Registry gig error ${code.toLowerCase()}</p>`);
      expect(html.match(/role="alert"/g)).toHaveLength(1);
    });
    it('unknown error words show the generic message and are never echoed; every form is described by the error element', async () => {
      signedIn();
      give(detailDto({ current: publishedVersionDto({ fields: FIELDS }) }));
      for (const error of ['API_ERROR', 'nope', 'STALE_DRAFT', '"><script>', 'constructor', '__proto__']) {
        const html = await renderGig({ error });
        expect(html, error).toContain('<p id="gig-error" role="alert">Registry gig error unavailable</p>');
        expect(html).not.toContain('<script>');
        for (const f of formsOf(html)) expect(f.describedBy, `${error} ${f.action}`).toBe(f.action.endsWith('/retire') ? 'gig-retire-note' : 'gig-error');
      }
    });
    it('with no error the forms are not described by an error element', async () => {
      signedIn();
      give(detailDto({ current: publishedVersionDto({ fields: FIELDS }) }));
      const html = await renderGig();
      expect(html).not.toContain('gig-error');
      expect(formFor(html, 'draft')!.describedBy).toBeUndefined();
    });
  });

  describe('GigDetail: nothing leaks and nothing is invented', () => {
    it('no token, refresh token, id token or account id is rendered; the only identifiers in hidden fields are the Gig id and the revision', async () => {
      signedIn();
      give(
        detailDto({
          current: publishedVersionDto({ fields: FIELDS }),
          draft: versionDto({ versionNumber: 2, revision: 7, fields: FIELDS, publishable: true }),
        }),
      );
      const html = await renderGig();
      for (const secret of [TOKENS.access, TOKENS.refresh, TOKENS.id, 'Bearer', 'accountId', 'gigVersionId', '3f9c1d70', '8b1d4e92'])
        expect(html, secret).not.toContain(secret);
      const names = formsOf(html).flatMap((f) => f.hidden.map((h) => h.name));
      expect([...new Set(names)].sort()).toEqual(['expectedRevision', 'gigId']);
    });
    it('with NO Gig copy in the registry the page shows only the provider’s own text and numbers: no literal replaces a missing text', async () => {
      signedIn();
      give(
        detailDto({
          current: publishedVersionDto({ fields: FIELDS }),
          draft: versionDto({ versionNumber: 2, revision: 7, fields: FIELDS, publishable: true, issues: [issueDto()] }),
        }),
      );
      stub.catalog = REGISTRY_COPY;
      const html = await renderGig({ error: 'GIG_CONFLICT', notice: 'saved' });
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
      // the only labels left are those of template fields, named by their key (an identifier); the platform controls are left out
      expect([...html.matchAll(/<label [^>]*>([^<]*)/g)].map((m) => m[1]).every((l) => /^[a-z][a-z0-9_]*$/.test(l!))).toBe(true);
      for (const id of ['gig-title', 'gig-short-pitch', 'gig-description', 'gig-price', 'gig-duration']) expect(html, id).not.toContain(`id="${id}"`);
    });
    it('no managed word is a literal of the app', async () => {
      signedIn();
      give(
        detailDto({
          current: publishedVersionDto({ fields: FIELDS }),
          draft: versionDto({ versionNumber: 2, revision: 7, fields: FIELDS, publishable: true, issues: [issueDto()] }),
        }),
      );
      const text = (await renderGig({ error: 'GIG_CONFLICT' }))
        .replace(/<[^>]*>/g, ' ')
        .replace(/Registry [a-z_ ]+?(?= {2,}|$)/g, ' ')
        .replace(/Spotless two-room clean|We bring everything\.|A thorough clean of up to two rooms\./g, '');
      for (const literal of [
        'Save',
        'Publish',
        'Retire',
        'Required',
        'Optional',
        'Title',
        'Price',
        'Description',
        'Version',
        'Back',
        'Draft',
        'History',
        'Currency',
        'Yes',
        'No ',
      ])
        expect(text, literal).not.toContain(literal);
    });
  });

  describe('the read-only version page', () => {
    it.each([['x'], ['0'], ['01'], ['-1'], ['1.5'], ['1e3'], ['1234567890']])(
      'a version segment %j is a not-found page and nothing is read',
      async (version) => {
        signedIn();
        await expect(renderVersion(version)).rejects.toBeInstanceOf(signals.NotFound);
        expect(api.calls).toEqual([]);
      },
    );
    it('a Gig id that is not a UUID is a not-found page', async () => {
      signedIn();
      await expect(renderVersion('1', 'nope')).rejects.toBeInstanceOf(signals.NotFound);
    });
    it('signed out: a sign-in control that returns to this version, no read', async () => {
      const html = await renderVersion('2');
      expect(html).toContain(`<a href="/auth/login?returnTo=/provider/gigs/${GIG_ID}/versions/2">Registry sign in</a>`);
      expect(api.calls).toEqual([]);
    });
    it("another account's Gig or an unknown version is a 404 from the API and the same not-found page here", async () => {
      signedIn();
      give();
      await expect(renderVersion('9')).rejects.toBeInstanceOf(signals.NotFound);
      await expect(renderVersion('1', OTHER_GIG_ID)).rejects.toBeInstanceOf(signals.NotFound);
    });
    it('reads exactly that version with the token and role and renders it read-only, with a back link to the Gig, and NO form', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      const v1 = publishedVersionDto({
        versionNumber: 1,
        status: 'SUPERSEDED',
        statusKey: gigVersionStatusKey('SUPERSEDED'),
        fields: FIELDS,
        fieldValues: [{ fieldKey: 'rooms', value: 4 }],
      });
      give(detailDto({ current: publishedVersionDto({ versionNumber: 2 }) }));
      api.versions.set(`${GIG_ID}/1`, v1);
      const html = await renderVersion('1');
      expect(gigCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/provider/gigs/${GIG_ID}/versions/1`]);
      expect(gigCalls()[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'PROVIDER' });
      expect(html).toContain(`<h1>${ed('version')} 1</h1>`);
      expect(html).toContain(`<a href="/provider/gigs/${GIG_ID}">${ed('back')}</a>`);
      expect(html).toContain('<p class="gig-status">Registry version state superseded</p>');
      expect(html).toContain('Spotless two-room clean');
      expect(html).toContain(`<dt>${FIELD_LABEL('rooms')}</dt><dd><span class="gig-text">4</span></dd>`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('<button');
    });
    it('escapes the provider text of the version', async () => {
      signedIn();
      give(detailDto({ current: publishedVersionDto({ title: '<img src=x onerror=alert(1)>', description: '<script>x</script>' }) }));
      const html = await renderVersion('1');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<script>x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
    it('an API failure is the generic message in an alert; a revoked session goes to /auth/revoked', async () => {
      signedIn();
      give();
      api.forced['GET /provider/gigs/:gigId/versions/:version'] = { status: 503, code: 'GIG_UNAVAILABLE', category: 'DEPENDENCY' };
      expect(await renderVersion('1')).toContain('<p role="alert">Registry gig error unavailable</p>');
      api.forced = {};
      api.revoked = true;
      await expect(renderVersion('1')).rejects.toMatchObject({ target: '/auth/revoked' });
    });
  });

  describe('a long list of template and field keys is fetched in chunks of at most 100 keys', () => {
    it('a menu with many Gigs resolves every name (more than one content call)', async () => {
      signedIn();
      const many = Array.from({ length: 130 }, (_v, i) => {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        return menuItemDto(detailDto({ gig: { gigId: id, nameContentKey: `catalog.gig_template.t${i}.name`, gigTemplateCode: `t${i}` }, draft: versionDto() }));
      });
      stub.catalog = {
        'en-US': { ...withCopy()['en-US']!, ...Object.fromEntries(many.map((m, i) => [`catalog.gig_template.t${i}.name`, { value: `Name ${i}` }])) },
      };
      api.menu = menuDto(many, { limits: { maxActive: 500, maxDrafts: 500, activeCount: 0, draftCount: 130 } });
      const html = await renderMenu();
      expect(html).toContain('>Name 0</h3>');
      expect(html).toContain('>Name 129</h3>');
      expect(stub.calls.filter((c) => c.path === '/api/v1/content/resolve-many').length).toBeGreaterThan(1);
      for (const c of stub.calls) expect((c.body as { keys: string[] }).keys.length).toBeLessThanOrEqual(100);
    });
  });
});

describe('Gig page sources', () => {
  const root = path.join(import.meta.dirname, 'app', 'provider', 'gigs');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const full = path.join(dir, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(n)) files.push(full);
    }
  };
  walk(root);
  files.push(path.join(import.meta.dirname, 'lib', 'auth', 'gig-handlers.ts'), path.join(import.meta.dirname, 'lib', 'provider-gigs.ts'));
  it('finds the page sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });
  it('no source injects markup, uses browser storage, or reads the environment directly', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie|process\.env/);
    }
  });
  it('no page imports the database, platform or other forbidden workspace packages (also enforced by boundaries.test.ts and `pnpm deps:check`)', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@bananagig\/(database|platform|configuration|content|provider|catalog)['"/]/);
  });
  const css = readFileSync(path.join(import.meta.dirname, 'app', 'globals.css'), 'utf8');
  it('44px targets and a visible focus indicator cover every control of the Gig pages (asserted from the CSS source)', () => {
    expect(css).toMatch(/\.provider-registration :is\(a, button, select, input:not\(\[type='hidden'\]\)\)\s*\{\s*min-height: 44px;\s*min-width: 44px;/);
    expect(css).toMatch(/\.provider-registration :is\(a, button, select, input\):focus-visible\s*\{\s*outline: 3px solid var\(--fg\)/);
    expect(css).toMatch(/\.provider-gigs :is\(textarea\)\s*\{\s*min-height: 44px;/);
    expect(css).toMatch(/\.provider-gigs :is\(textarea\):focus-visible\s*\{\s*outline: 3px solid var\(--fg\)/);
  });
  it('an invalid control is marked by more than colour (a thicker dashed border)', () => {
    expect(css).toMatch(/\.provider-gigs \[aria-invalid='true'\]\s*\{\s*border-style: dashed/);
  });
  it('every page wraps its content in the classes that carry that CSS', () => {
    for (const f of files.filter((x) => /page\.tsx$/.test(x))) expect(readFileSync(f, 'utf8'), f).toContain('provider-registration provider-gigs');
  });
});
