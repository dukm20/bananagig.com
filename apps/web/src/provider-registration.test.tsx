// PRO-001 web side, part 3: the server component /provider/registration. The API is the provider stub (testing/provider-stub.ts, contract-validated) mounted on the content
// stub: the page reads the state and the requirements with the session's token and role, takes the options from the two PUBLIC lists, offers each form only when the data
// supports it (Submit ONLY when the API says the registration is ready), and every string comes from the registry copy (PROVIDER_COPY, worded unlike the seeded copy).
// Nothing is ever pre-ticked, and no token, secret or submitted word is rendered.
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ERROR_CODES, type ProviderRegistrationDto } from '@bananagig/contracts';
import ProviderRegistrationPage, { dynamic, metadata } from './app/provider/registration/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { REGISTRY_COPY, startContentStub, type ContentStub } from './testing/content-stub';
import {
  PROVIDER_COPY,
  PROVIDER_TEXT,
  attachProviderApi,
  marketDto,
  registrationDto,
  requirementsDto,
  serviceTypeDto,
  stateDto,
  stepsDto,
  type ProviderApiStub,
} from './testing/provider-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
const redirects = vi.hoisted(() => ({
  Signal: class RedirectSignal extends Error {
    constructor(public readonly target: string) {
      super(`redirect ${target}`);
    }
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new redirects.Signal(target);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-6', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const t = (suffix: string): string => PROVIDER_TEXT[`provider.registration.page.${suffix}`] ?? `missing copy for ${suffix}`;
const STEP_ORDER = ['account', 'contact', 'legal', 'market', 'services', 'verification', 'subscription', 'profile', 'gigs'];

describe('provider registration page', () => {
  let stub: ContentStub;
  let api: ProviderApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(PROVIDER_COPY);
    api = attachProviderApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = PROVIDER_COPY;
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
  const render = async (q: Record<string, string | string[] | undefined> = {}) =>
    renderToString(await ProviderRegistrationPage({ searchParams: Promise.resolve(q) }))
      .replaceAll('<!-- -->', '')
      .replace(/<form action="([^"]*)" method="post"/g, '<form method="post" action="$1"');
  const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  interface FormInfo {
    action: string;
    describedBy: string | undefined;
    inner: string;
    inputs: Array<Record<string, string>>;
    boolean: string[];
    buttons: string[];
  }
  const formsOf = (html: string): FormInfo[] =>
    [...html.matchAll(/<form ([^>]*)>(.*?)<\/form>/g)].map((m) => {
      const a = attrs(m[1]!);
      expect(a.method, m[1]).toBe('post');
      return {
        action: a.action!,
        describedBy: a['aria-describedby'],
        inner: m[2]!,
        inputs: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => attrs(i[1]!)),
        boolean: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => i[1]!),
        buttons: [...m[2]!.matchAll(/<button type="submit">(.*?)<\/button>/g)].map((b) => b[1]!),
      };
    });
  const formFor = (html: string, action: string): FormInfo | undefined => formsOf(html).find((f) => f.action === `/auth/provider/${action}`);
  const actionsOf = (html: string): string[] => formsOf(html).map((f) => f.action.replace('/auth/provider/', ''));
  const providerCalls = () => api.providerCalls();
  const live = (over: Partial<ProviderRegistrationDto> = {}) => registrationDto({ revision: 9, ...over });
  /** A registration in the given status with its requirements (steps default to everything COMPLETE). */
  const setRegistration = (
    registration: ProviderRegistrationDto | null,
    o: { ready?: boolean; steps?: ReturnType<typeof stepsDto>; role?: 'NONE' | 'PENDING' | 'ACTIVE' | 'INACTIVE' } = {},
  ) => {
    api.state = stateDto(registration, o.role ?? (registration ? 'PENDING' : 'NONE'));
    api.requirements = requirementsDto(registration, o.steps ?? stepsDto(), {
      ready: o.ready ?? false,
      providerRole: o.role ?? (registration ? 'PENDING' : 'NONE'),
    });
  };

  describe('page metadata', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
    });
  });

  describe('signed out', () => {
    it('shows the registry title and the sign-in control that returns to /provider/registration; no provider call is made', async () => {
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/registration">Registry sign in</a>');
      expect(api.calls).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label) and nothing else is shown', async () => {
      stub.mode = 'down';
      const html = await render();
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/registration">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('an unknown session cookie is signed out', async () => {
      state.cookie = 'bg_session=nope';
      expect(await render()).toContain('/auth/login?returnTo=/provider/registration');
      expect(api.calls).toEqual([]);
    });
    it('shows no notice, no error and no form even when the URL carries them', async () => {
      const html = await render({ notice: 'submitted', error: 'PROVIDER_CONFLICT' });
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('<form');
    });
  });

  describe('signed in, no registration yet', () => {
    it('reads the state and the requirements with the session token and role, and renders the registry copy', async () => {
      signedIn({ activeRole: 'CUSTOMER' });
      const html = await render();
      const calls = providerCalls();
      expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(['GET /api/v1/provider/registration', 'GET /api/v1/provider/registration/requirements']);
      for (const c of calls) expect(c).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'CUSTOMER', correlationId: 'web-test-corr-6' });
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p>${t('intro')}</p>`);
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.role.none']}</p>`);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
    });
    it('offers ONLY the start form: a POST to /auth/provider/start with no field but the button', async () => {
      signedIn();
      const html = await render();
      expect(actionsOf(html)).toEqual(['start']);
      const form = formFor(html, 'start')!;
      expect(form.inputs).toEqual([]);
      expect(form.buttons).toEqual([t('start_action')]);
      expect(html).not.toContain(t('restart_action'));
      expect(html).not.toContain(t('cancel_action'));
      expect(html).not.toContain(t('submit_action'));
    });
    it('does not read the market or service lists and shows no registration status', async () => {
      signedIn();
      const html = await render();
      expect(api.calls.filter((c) => !c.path.startsWith('/api/v1/provider/'))).toEqual([]);
      expect(html).not.toContain('Registry registration');
      expect(html).not.toContain(t('market_heading'));
      expect(html).not.toContain(t('services_heading'));
    });
    it('shows the progress list of all nine steps in order with the registry label and status of each', async () => {
      signedIn();
      setRegistration(null, {
        steps: stepsDto({ ACCOUNT: 'NOT_STARTED', CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED', MARKET: 'NOT_STARTED', SERVICES: 'NOT_STARTED' }),
      });
      const html = await render();
      expect(html).toContain(`<h2 id="provider-progress">${t('progress_heading')}</h2>`);
      const items = html.match(/<li>.*?<\/li>/g)!;
      expect(items).toHaveLength(9);
      items.forEach((li, i) => {
        const step = STEP_ORDER[i]!;
        const future = ['verification', 'subscription', 'profile', 'gigs'].includes(step);
        expect(li).toBe(`<li><span>Registry step ${step}</span> <span>Registry state ${future ? 'not_available' : 'not_started'}</span></li>`);
      });
    });
    it('the start form is not offered when the registry lacks its label (nothing to press), and no literal replaces it', async () => {
      signedIn();
      stub.catalog = { 'en-US': Object.fromEntries(Object.entries(PROVIDER_COPY['en-US']!).filter(([k]) => k !== 'provider.registration.page.start_action')) };
      const html = await render();
      expect(html).not.toContain('<form');
      expect(html).toContain(`<h1>${t('title')}</h1>`);
    });
  });

  describe('signed in, registration IN_PROGRESS without a market', () => {
    it('shows the role and status copy and a market form: one radio per market, labelled with htmlFor, none chosen, required', async () => {
      signedIn();
      setRegistration(live());
      const html = await render();
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.role.pending']}</p>`);
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.status.in_progress']}</p>`);
      const form = formFor(html, 'market')!;
      expect(form).toBeDefined();
      const radios = form.inputs.filter((i) => i.type === 'radio');
      expect(radios.map((r) => r.value)).toEqual(['us-orange-county', 'us-los-angeles']);
      for (const r of radios) {
        expect(r.name).toBe('marketCode');
        expect(r.id).toBe(`provider-market-${r.value}`);
        expect(r.required).toBeDefined();
      }
      expect(form.boolean.filter((b) => b.includes('type="radio"')).some((b) => /\bchecked\b/.test(b))).toBe(false);
      expect(form.inner).toContain('<label for="provider-market-us-orange-county">Orange County</label>');
      expect(form.inner).toContain('<label for="provider-market-us-los-angeles">Los Angeles</label>');
      expect(form.inner).toContain(`<legend>${t('market_label')}</legend>`);
      expect(form.inner).toContain(`<p id="provider-market-help">${t('market_help')}</p>`);
      expect(form.inner).toContain('<fieldset aria-describedby="provider-market-help">');
      expect(form.buttons).toEqual([t('save_action')]);
      expect(html).toContain(`<h2 id="provider-market">${t('market_heading')}</h2>`);
    });
    it('carries the CURRENT revision of the registration as the only hidden field of the market form', async () => {
      signedIn();
      setRegistration(live({ revision: 37 }));
      const form = formFor(await render(), 'market')!;
      expect(form.inputs.filter((i) => i.type === 'hidden')).toEqual([{ type: 'hidden', name: 'expectedRevision', value: '37' }]);
      expect(form.inputs.filter((i) => i.type !== 'hidden' && i.type !== 'radio')).toEqual([]);
    });
    it('offers no service form (the market decides the choices), reads no service list, and shows a cancel form', async () => {
      signedIn();
      setRegistration(live());
      const html = await render();
      expect(actionsOf(html)).toEqual(['market', 'cancel']);
      expect(html).not.toContain(t('services_heading'));
      expect(api.calls.some((c) => c.path.startsWith('/api/v1/catalog/service-types'))).toBe(false);
      const cancel = formFor(html, 'cancel')!;
      expect(cancel.inputs).toEqual([]);
      expect(cancel.buttons).toEqual([t('cancel_action')]);
    });
    it('reads the PUBLIC market list once', async () => {
      signedIn();
      setRegistration(live());
      await render();
      expect(api.calls.filter((c) => c.path === '/api/v1/geography/markets')).toHaveLength(1);
    });
    it('escapes a market name (a script in the name is text, never markup)', async () => {
      signedIn();
      setRegistration(live());
      api.markets = [marketDto('us-orange-county', '<script>alert(1)</script> & <img src=x onerror=alert(2)>')];
      const html = await render();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(2)&gt;');
    });
    it('lists at most 200 markets', async () => {
      signedIn();
      setRegistration(live());
      api.markets = Array.from({ length: 250 }, (_v, i) => marketDto(`m-${i}`, `Market ${i}`));
      const radios = formFor(await render(), 'market')!.inputs.filter((i) => i.type === 'radio');
      expect(radios).toHaveLength(200);
      expect(radios[199]!.value).toBe('m-199');
    });
    it('no market (an empty list or a failing one) shows the empty copy, no market form and keeps the cancel form', async () => {
      signedIn();
      setRegistration(live());
      api.markets = [];
      const empty = await render();
      expect(empty).toContain(`<p>${t('empty_markets')}</p>`);
      expect(actionsOf(empty)).toEqual(['cancel']);
      api.markets = [marketDto('us-orange-county', 'Orange County')];
      api.forced['GET /geography/markets'] = { status: 503, code: 'UNAVAILABLE', category: 'DEPENDENCY' };
      const failing = await render();
      expect(failing).toContain(`<p>${t('empty_markets')}</p>`);
      expect(actionsOf(failing)).toEqual(['cancel']);
      expect(failing).not.toContain('role="alert"'); // a missing option list is not a failure of the registration itself
    });
  });

  describe('signed in, registration IN_PROGRESS with a market', () => {
    const withMarket = (selected: string[] = [], revision = 12) => {
      setRegistration(live({ marketCode: 'us-orange-county', serviceTypeCodes: selected, revision }));
    };
    it('checks only the radio of the chosen market', async () => {
      signedIn();
      withMarket();
      const form = formFor(await render(), 'market')!;
      const radios = form.boolean.filter((b) => b.includes('type="radio"'));
      expect(radios).toHaveLength(2);
      expect(radios.map((b) => /\bchecked\b/.test(b))).toEqual([true, false]);
      expect(radios[0]).toContain('value="us-orange-county"');
    });
    it('reads the PUBLIC service list of exactly that market and offers a service form: one checkbox per service type, labelled, only the selected ones checked', async () => {
      signedIn();
      withMarket(['car_detailing', 'lawn_care']);
      const html = await render();
      expect(api.calls.filter((c) => c.path.startsWith('/api/v1/catalog/service-types')).map((c) => c.path)).toEqual([
        '/api/v1/catalog/service-types?market=us-orange-county',
      ]);
      const form = formFor(html, 'services')!;
      expect(form).toBeDefined();
      const boxes = form.boolean.filter((b) => b.includes('type="checkbox"'));
      expect(boxes.map((b) => attrs(b).value)).toEqual(['house_cleaning', 'car_detailing', 'lawn_care']);
      expect(boxes.map((b) => /\bchecked\b/.test(b))).toEqual([false, true, true]);
      for (const b of boxes) {
        expect(attrs(b).name).toBe('serviceTypeCode');
        expect(attrs(b).id).toBe(`provider-service-${attrs(b).value}`);
      }
      expect(form.inner).toContain('<label for="provider-service-house_cleaning">House cleaning</label>');
      expect(form.inner).toContain('<label for="provider-service-lawn_care">Lawn care</label>');
      expect(form.inner).toContain(`<legend>${t('services_heading')}</legend>`);
      expect(form.inner).toContain(`<p id="provider-services-help">${t('services_help')}</p>`);
      expect(form.buttons).toEqual([t('save_action')]);
      expect(html).toContain(`<h2 id="provider-services">${t('services_heading')}</h2>`);
    });
    it('with nothing selected no checkbox is checked', async () => {
      signedIn();
      withMarket([]);
      const form = formFor(await render(), 'services')!;
      expect(form.boolean.filter((b) => b.includes('type="checkbox"'))).toHaveLength(3);
      expect(form.boolean.some((b) => /\bchecked\b/.test(b))).toBe(false);
    });
    it('a stored selection that the market no longer offers is not rendered (no hidden field of it, no checked ghost)', async () => {
      signedIn();
      withMarket(['retired_thing', 'lawn_care']);
      const html = await render();
      expect(html).not.toContain('retired_thing');
      const boxes = formFor(html, 'services')!.boolean.filter((b) => b.includes('type="checkbox"'));
      expect(boxes.map((b) => /\bchecked\b/.test(b))).toEqual([false, false, true]);
    });
    it('both choice forms carry the same current revision as their only hidden field', async () => {
      signedIn();
      withMarket(['lawn_care'], 41);
      const html = await render();
      for (const name of ['market', 'services']) {
        expect(
          formFor(html, name)!.inputs.filter((i) => i.type === 'hidden'),
          name,
        ).toEqual([{ type: 'hidden', name: 'expectedRevision', value: '41' }]);
      }
    });
    it('escapes a service type name and lists at most 200 service types', async () => {
      signedIn();
      withMarket();
      api.serviceTypes = [serviceTypeDto('x_one', '<b>bold</b>'), ...Array.from({ length: 250 }, (_v, i) => serviceTypeDto(`svc_${i}`, `Service ${i}`))];
      const html = await render();
      expect(html).not.toContain('<b>bold</b>');
      expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
      expect(formFor(html, 'services')!.inputs.filter((i) => i.type === 'checkbox')).toHaveLength(200);
    });
    it('a market without service types shows the empty copy instead of a form; a failing list does too', async () => {
      signedIn();
      withMarket();
      api.serviceTypes = [];
      const empty = await render();
      expect(empty).toContain(`<p>${t('empty_services')}</p>`);
      expect(actionsOf(empty)).toEqual(['market', 'cancel']);
      api.serviceTypes = [serviceTypeDto('lawn_care', 'Lawn care')];
      api.forced['GET /catalog/service-types'] = { status: 503, code: 'UNAVAILABLE', category: 'DEPENDENCY' };
      const failing = await render();
      expect(failing).toContain(`<p>${t('empty_services')}</p>`);
      expect(actionsOf(failing)).toEqual(['market', 'cancel']);
    });
  });

  describe('Submit is offered only when the API says the registration is ready', () => {
    it('offers a submit form with the current revision as its only field when registrationReady is true', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county', serviceTypeCodes: ['lawn_care'], revision: 15 }), { ready: true });
      const html = await render();
      expect(actionsOf(html)).toEqual(['market', 'services', 'submit', 'cancel']);
      const form = formFor(html, 'submit')!;
      expect(form.inputs).toEqual([{ type: 'hidden', name: 'expectedRevision', value: '15' }]);
      expect(form.buttons).toEqual([t('submit_action')]);
    });
    it('offers NO submit form when registrationReady is false, even if every step the page can see looks complete', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county', serviceTypeCodes: ['lawn_care'] }), { ready: false, steps: stepsDto() });
      const html = await render();
      expect(actionsOf(html)).toEqual(['market', 'services', 'cancel']);
      expect(html).not.toContain(t('submit_action'));
    });
    it('offers NO submit form when the requirements cannot be read (nothing proves readiness)', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      api.forced['GET /provider/registration/requirements'] = { status: 503, code: 'PROVIDER_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(actionsOf(html)).not.toContain('submit');
      expect(actionsOf(html)).toContain('cancel');
    });
    it('readiness is only used for an IN_PROGRESS registration: COMPLETED and CANCELLED never get a submit form', async () => {
      signedIn();
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county', completedAt: '2026-10-17T10:00:00.000Z' }), { ready: true });
      expect(actionsOf(await render())).toEqual([]);
      setRegistration(live({ status: 'CANCELLED', cancelledAt: '2026-10-17T10:00:00.000Z' }), { ready: true });
      expect(actionsOf(await render())).toEqual(['start']);
    });
    it('the submit form is omitted (never replaced by a literal) when the registry lacks its label', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      stub.catalog = { 'en-US': Object.fromEntries(Object.entries(PROVIDER_COPY['en-US']!).filter(([k]) => k !== 'provider.registration.page.submit_action')) };
      expect(actionsOf(await render())).not.toContain('submit');
    });
  });

  describe('the progress list and the hints', () => {
    it('lists the steps in the order the API gave them with their registry label and status', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), {
        steps: stepsDto({ CONTACT: 'IN_PROGRESS', LEGAL: 'NOT_REQUIRED', MARKET: 'COMPLETE', SERVICES: 'BLOCKED' }),
      });
      const html = await render();
      const items = html.match(/<li>.*?<\/li>/g)!;
      expect(
        items.map((li) =>
          li
            .replace(/<[^>]*>/g, '|')
            .replace(/\| \|/g, '|')
            .replace(/\|+/g, '|'),
        ),
      ).toEqual([
        '|Registry step account|Registry state complete|',
        '|Registry step contact|Registry state in_progress|',
        '|Registry step legal|Registry state not_required|',
        '|Registry step market|Registry state complete|',
        '|Registry step services|Registry state blocked|',
        '|Registry step verification|Registry state not_available|',
        '|Registry step subscription|Registry state not_available|',
        '|Registry step profile|Registry state not_available|',
        '|Registry step gigs|Registry state not_available|',
      ]);
    });
    it.each(['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED'] as const)(
      'shows the contact hint while the CONTACT step is %s, and not the legal hint',
      async (status) => {
        signedIn();
        setRegistration(live(), { steps: stepsDto({ CONTACT: status }) });
        const html = await render();
        expect(html).toContain(`<p>${t('contact_hint')}</p>`);
        expect(html).not.toContain(t('legal_hint'));
      },
    );
    it.each(['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED'] as const)(
      'shows the legal hint (a link to /consents) while the LEGAL step is %s, and not the contact hint',
      async (status) => {
        signedIn();
        setRegistration(live(), { steps: stepsDto({ LEGAL: status }) });
        const html = await render();
        expect(html).toContain(`<p><a href="/consents">${t('legal_hint')}</a></p>`);
        expect(html).not.toContain(t('contact_hint'));
      },
    );
    it.each(['COMPLETE', 'NOT_REQUIRED'] as const)('shows neither hint when CONTACT and LEGAL are %s', async (status) => {
      signedIn();
      setRegistration(live(), { steps: stepsDto({ CONTACT: status, LEGAL: status }) });
      const html = await render();
      expect(html).not.toContain(t('contact_hint'));
      expect(html).not.toContain(t('legal_hint'));
      expect(html).not.toContain('/consents');
    });
    it('shows both hints when both steps are unmet', async () => {
      signedIn();
      setRegistration(live(), { steps: stepsDto({ CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED' }) });
      const html = await render();
      expect(html).toContain(t('contact_hint'));
      expect(html).toContain(t('legal_hint'));
    });
    it('the hints belong to a registration in progress: none for COMPLETED, CANCELLED or no registration', async () => {
      signedIn();
      const unmet = stepsDto({ CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED' });
      for (const reg of [live({ status: 'COMPLETED', marketCode: 'us-orange-county' }), live({ status: 'CANCELLED' }), null]) {
        setRegistration(reg, { steps: unmet });
        const html = await render();
        expect(html, String(reg?.status)).not.toContain(t('contact_hint'));
        expect(html, String(reg?.status)).not.toContain(t('legal_hint'));
      }
    });
    it('without the progress heading in the registry the whole progress section (and its hints) is omitted', async () => {
      signedIn();
      setRegistration(live(), { steps: stepsDto({ CONTACT: 'NOT_STARTED' }) });
      stub.catalog = {
        'en-US': Object.fromEntries(Object.entries(PROVIDER_COPY['en-US']!).filter(([k]) => k !== 'provider.registration.page.progress_heading')),
      };
      const html = await render();
      expect(html).not.toContain('<ul>');
      expect(html).not.toContain(t('contact_hint'));
    });
    it('a step whose label or status the registry lacks keeps its row but shows no invented text', async () => {
      signedIn();
      setRegistration(live());
      stub.catalog = {
        'en-US': Object.fromEntries(
          Object.entries(PROVIDER_COPY['en-US']!).filter(
            ([k]) => k !== 'provider.registration.step.gigs.label' && k !== 'provider.registration.step_status.not_available',
          ),
        ),
      };
      const items = (await render()).match(/<li>.*?<\/li>/g)!;
      expect(items).toHaveLength(9);
      expect(items[8]).toBe('<li> </li>');
    });
  });

  describe('CANCELLED and COMPLETED registrations', () => {
    it('CANCELLED: offers the restart form (a new attempt) and no choice, submit or cancel form', async () => {
      signedIn();
      setRegistration(live({ status: 'CANCELLED', cancelledAt: '2026-10-17T10:00:00.000Z' }), { steps: stepsDto({ ACCOUNT: 'NOT_STARTED' }) });
      const html = await render();
      expect(actionsOf(html)).toEqual(['start']);
      const form = formFor(html, 'start')!;
      expect(form.inputs).toEqual([]);
      expect(form.buttons).toEqual([t('restart_action')]);
      expect(html).not.toContain(t('start_action'));
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.status.cancelled']}</p>`);
      expect(html).not.toContain(t('market_heading'));
      expect(api.calls.some((c) => !c.path.startsWith('/api/v1/provider/'))).toBe(false);
    });
    it('COMPLETED: shows the Go-Live note and the status, and offers NO form at all', async () => {
      signedIn();
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county', serviceTypeCodes: ['lawn_care'], completedAt: '2026-10-17T10:00:00.000Z' }), {
        ready: true,
        role: 'ACTIVE',
      });
      const html = await render();
      expect(html).toContain(`<p>${t('golive_note')}</p>`);
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.status.completed']}</p>`);
      expect(html).toContain(`<p>${PROVIDER_TEXT['provider.registration.role.active']}</p>`);
      expect(html).not.toContain('<form');
      expect(api.calls.some((c) => !c.path.startsWith('/api/v1/provider/'))).toBe(false);
    });
    it('the Go-Live note belongs to COMPLETED only', async () => {
      signedIn();
      for (const reg of [null, live(), live({ status: 'CANCELLED' })]) {
        setRegistration(reg);
        expect(await render(), String(reg?.status)).not.toContain(t('golive_note'));
      }
    });
    it('COMPLETED without the Go-Live copy shows no note (omitted, not replaced)', async () => {
      signedIn();
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      stub.catalog = { 'en-US': Object.fromEntries(Object.entries(PROVIDER_COPY['en-US']!).filter(([k]) => k !== 'provider.registration.page.golive_note')) };
      expect(await render()).not.toContain('Registry golive');
    });
  });

  describe('notices and errors come from closed lists of words', () => {
    it('?notice=submitted is shown only for a COMPLETED registration', async () => {
      signedIn();
      setRegistration(live());
      expect(await render({ notice: 'submitted' })).not.toContain(t('completed_notice'));
      setRegistration(live({ status: 'CANCELLED' }));
      expect(await render({ notice: 'submitted' })).not.toContain(t('completed_notice'));
      setRegistration(null);
      expect(await render({ notice: 'submitted' })).not.toContain(t('completed_notice'));
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      expect(await render({ notice: 'submitted' })).toContain(`<p role="status">${t('completed_notice')}</p>`);
    });
    it('?notice=cancelled is shown only for a CANCELLED registration', async () => {
      signedIn();
      setRegistration(live());
      expect(await render({ notice: 'cancelled' })).not.toContain(t('cancelled_notice'));
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      expect(await render({ notice: 'cancelled' })).not.toContain(t('cancelled_notice'));
      setRegistration(null);
      expect(await render({ notice: 'cancelled' })).not.toContain(t('cancelled_notice'));
      setRegistration(live({ status: 'CANCELLED' }));
      expect(await render({ notice: 'cancelled' })).toContain(`<p role="status">${t('cancelled_notice')}</p>`);
    });
    it('the other notice words carry no message of their own: the page state reflects them', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }));
      for (const notice of ['started', 'resumed', 'market_saved', 'services_saved']) {
        const html = await render({ notice });
        expect(html, notice).not.toContain('role="status"');
        expect(html).not.toContain(notice);
      }
    });
    it('the submitted notice does not cross over: submitted on a CANCELLED page says nothing and cancelled on a COMPLETED page says nothing', async () => {
      signedIn();
      setRegistration(live({ status: 'CANCELLED' }));
      const a = await render({ notice: 'submitted' });
      expect(a).not.toContain('role="status"');
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      const b = await render({ notice: 'cancelled' });
      expect(b).not.toContain('role="status"');
    });
    it('ignores an unknown notice word, a repeated parameter and Object.prototype names, and never echoes them', async () => {
      signedIn();
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      for (const notice of [
        'nope',
        '<script>alert(1)</script>',
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        ['submitted', 'cancelled'],
        '',
      ] as Array<string | string[]>) {
        const html = await render({ notice });
        expect(html, JSON.stringify(notice)).not.toContain('role="status"');
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
      }
    });
    it.each(PROVIDER_ERROR_CODES)("?error=PROVIDER_%s shows that code's registry message in an alert", async (code) => {
      signedIn();
      setRegistration(live());
      const html = await render({ error: `PROVIDER_${code}` });
      expect(html).toContain(`<p id="provider-error" role="alert">Registry provider error ${code.toLowerCase()}</p>`);
      expect(html.match(/role="alert"/g)).toHaveLength(1);
    });
    it('the codes without the PROVIDER_ prefix, unknown words and API_ERROR show the generic message and are never echoed', async () => {
      signedIn();
      setRegistration(live());
      for (const error of [
        'API_ERROR',
        'REGISTRATION_INCOMPLETE',
        'ACCOUNT_SUSPENDED',
        'PROVIDER_NOPE',
        'provider_conflict',
        'nope',
        '"><script>alert(1)</script>',
        'constructor',
        '__proto__',
        'toString',
        '',
      ]) {
        const html = await render({ error });
        expect(html, JSON.stringify(error)).toContain(`<p id="provider-error" role="alert">${PROVIDER_TEXT['provider.registration.error.unavailable']}</p>`);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
        expect(html).not.toContain('SUSPENDED');
        expect(html).not.toContain('NOPE');
      }
    });
    it('a repeated ?error= parameter is ignored (nothing is shown for it)', async () => {
      signedIn();
      setRegistration(live());
      expect(await render({ error: ['PROVIDER_CONFLICT', 'x'] })).not.toContain('role="alert"');
    });
    it('every form is described by the error element when there is an error, and by nothing when there is none', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      const withError = await render({ error: 'PROVIDER_STALE_REGISTRATION' });
      const forms = formsOf(withError);
      expect(forms.map((f) => f.action)).toEqual(['/auth/provider/market', '/auth/provider/services', '/auth/provider/submit', '/auth/provider/cancel']);
      for (const f of forms) expect(f.describedBy, f.action).toBe('provider-error');
      expect(withError.match(/id="provider-error"/g)).toHaveLength(1);
      const clean = await render();
      for (const f of formsOf(clean)) expect(f.describedBy, f.action).toBeUndefined();
      expect(clean).not.toContain('provider-error');
    });
    it('the start form and the restart form are described by the error as well', async () => {
      signedIn();
      setRegistration(null);
      expect(formFor(await render({ error: 'PROVIDER_CONFLICT' }), 'start')!.describedBy).toBe('provider-error');
      setRegistration(live({ status: 'CANCELLED' }));
      expect(formFor(await render({ error: 'PROVIDER_CONFLICT' }), 'start')!.describedBy).toBe('provider-error');
    });
    it('an error wins visually over a notice (both may show) and with no copy for the message nothing is invented, forms are not described', async () => {
      signedIn();
      setRegistration(live({ status: 'COMPLETED', marketCode: 'us-orange-county' }));
      const both = await render({ error: 'PROVIDER_CONFLICT', notice: 'submitted' });
      expect(both).toContain('role="alert"');
      expect(both).toContain('role="status"');
      setRegistration(live());
      stub.catalog = {
        'en-US': Object.fromEntries(
          Object.entries(PROVIDER_COPY['en-US']!).filter(
            ([k]) => k !== 'provider.registration.error.conflict' && k !== 'provider.registration.error.unavailable',
          ),
        ),
      };
      const none = await render({ error: 'PROVIDER_CONFLICT' });
      expect(none).not.toContain('role="alert"');
      expect(none).not.toContain('CONFLICT');
      for (const f of formsOf(none)) expect(f.describedBy).toBeUndefined();
    });
  });

  describe('nothing is pre-ticked or auto-submitted, and no consent is taken here', () => {
    it('no checkbox or radio is checked on the pages that offer none; the only checkboxes of any page are service types', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { steps: stepsDto({ LEGAL: 'NOT_STARTED' }), ready: true });
      const html = await render();
      for (const b of formsOf(html).flatMap((f) => f.boolean)) {
        if (b.includes('type="checkbox"')) expect(attrs(b).name).toBe('serviceTypeCode');
        if (b.includes('type="radio"')) expect(attrs(b).name).toBe('marketCode');
      }
      expect(html).not.toMatch(/<input[^>]*(consent|agree|accept)/i);
      for (const forbidden of ['<script', 'autofocus', 'onload', 'onclick', 'formaction', 'http-equiv', 'selected', 'defaultChecked'])
        expect(html, forbidden).not.toContain(forbidden);
    });
    it('every form posts to a fixed /auth/provider/ action; nothing links to an action endpoint and the only link is /consents', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { steps: stepsDto({ LEGAL: 'NOT_STARTED' }), ready: true });
      const html = await render();
      for (const f of formsOf(html)) expect(f.action).toMatch(/^\/auth\/provider\/(start|market|services|submit|cancel)$/);
      expect([...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/consents']);
    });
    it('no hidden field ever carries an account id, a role, a status or a completion flag', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      const names = formsOf(await render()).flatMap((f) => f.inputs.filter((i) => i.type === 'hidden').map((i) => i.name));
      expect([...new Set(names)]).toEqual(['expectedRevision']);
    });
    it('no token, refresh token, id token or registration identifier is rendered', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      const html = await render();
      for (const secret of [TOKENS.access, TOKENS.refresh, TOKENS.id, 'Bearer', 'providerRegistrationId', '7c1f0e52']) expect(html).not.toContain(secret);
    });
  });

  describe('every string is registry copy', () => {
    it('with NO provider copy in the registry the page shows nothing but the names of the options: no literal replaces a missing text', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true, steps: stepsDto({ CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED' }) });
      stub.catalog = REGISTRY_COPY;
      const html = await render({ error: 'PROVIDER_CONFLICT' });
      const text = html
        .replace(/<[^>]*>/g, ' ')
        .replace(/Orange County|Los Angeles|House cleaning|Car detailing|Lawn care/g, '')
        .replace(/\s+/g, '');
      expect(text).toBe('');
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('<button'); // nothing to press without a label
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('<legend');
    });
    it('no managed word is a literal of the app', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true, steps: stepsDto({ CONTACT: 'NOT_STARTED', LEGAL: 'NOT_STARTED' }) });
      const text = (await render({ error: 'PROVIDER_CONFLICT' })).replace(/<[^>]*>/g, ' ').replace(/Registry [a-z_ ]+?(?= {2,}|$)/g, ' ');
      for (const literal of ['Start', 'Submit', 'Cancel', 'Save', 'Provider', 'Market', 'Service', 'Register', 'Become', 'Contact', 'Go live', 'Go-Live'])
        expect(text.replace(/Orange County|Los Angeles|House cleaning|Car detailing|Lawn care/g, ''), literal).not.toContain(literal);
    });
    it.each([
      ['title', '<h1'],
      ['market_heading', 'id="provider-market"'],
      ['market_label', '<legend>'],
      ['market_help', 'provider-market-help"'],
      ['save_action', '<button'],
      ['cancel_action', 'action="/auth/provider/cancel"'],
    ])('without %s in the registry that element is omitted', async (suffix, marker) => {
      signedIn();
      setRegistration(live());
      stub.catalog = {
        'en-US': Object.fromEntries(
          Object.entries(PROVIDER_COPY['en-US']!).filter(
            ([k]) => k !== `provider.registration.page.${suffix}` && !(suffix === 'save_action' && k === 'provider.registration.page.cancel_action'),
          ),
        ),
      };
      const html = await render();
      if (suffix === 'market_help') expect(html).not.toContain('<p id="provider-market-help">');
      else expect(html).not.toContain(marker);
    });
  });

  describe('the API is partly or wholly unavailable', () => {
    it('with the state unreadable the page says it could not be done (generic copy in an alert) and offers no form', async () => {
      signedIn();
      api.forced['GET /provider/registration'] = { status: 503, code: 'PROVIDER_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p id="provider-error" role="alert">${PROVIDER_TEXT['provider.registration.error.unavailable']}</p>`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain(t('start_action'));
      expect(html).not.toContain('PROVIDER_UNAVAILABLE');
    });
    it('with BOTH calls failing the page still renders without a crash', async () => {
      signedIn();
      api.forced['GET /provider/registration'] = { status: 500, code: 'INTERNAL', category: 'INTERNAL' };
      api.forced['GET /provider/registration/requirements'] = { status: 503, code: 'PROVIDER_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<li>');
    });
    it('a 403 or a 404 of the API is "unavailable" too, never its code', async () => {
      signedIn();
      for (const status of [403, 404, 409]) {
        api.forced['GET /provider/registration'] = { status, code: 'PROVIDER_REGISTRATION_NOT_FOUND', category: 'AUTHORIZATION' };
        const html = await render();
        expect(html, String(status)).toContain(PROVIDER_TEXT['provider.registration.error.unavailable']);
        expect(html).not.toContain('NOT_FOUND');
      }
    });
    it('when only the requirements fail the state still works: the forms of the state are offered, without a progress list, hints or submit', async () => {
      signedIn();
      setRegistration(live({ marketCode: 'us-orange-county' }), { ready: true });
      api.forced['GET /provider/registration/requirements'] = { status: 503, code: 'PROVIDER_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(actionsOf(html)).toEqual(['market', 'services', 'cancel']);
      expect(html).not.toContain('<li>');
      expect(html).not.toContain(t('progress_heading'));
      expect(html).not.toContain('role="alert"'); // the state is fine: not a page-level failure
    });
    it('when only the state fails the progress list is still shown, with no forms', async () => {
      signedIn();
      setRegistration(live());
      api.forced['GET /provider/registration'] = { status: 503, code: 'PROVIDER_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(html.match(/<li>/g)).toHaveLength(9);
      expect(html).not.toContain('<form');
    });
    it('a response that violates the contract is "unavailable", not a crash', async () => {
      signedIn();
      api.rawBody['GET /provider/registration'] = { providerRole: 'NONE', registration: { status: 'SUBMITTED' } };
      const html = await render();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('<form');
      api.rawBody = { 'GET /provider/registration/requirements': { steps: 'nonsense' } };
      setRegistration(live());
      const second = await render();
      expect(second).not.toContain('<li>');
      expect(actionsOf(second)).toContain('cancel');
    });
    it('a revoked session goes to /auth/revoked (a page cannot clear a cookie) before anything is rendered', async () => {
      signedIn();
      api.revoked = true;
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
    it('a revoked session found while reading the options also goes to /auth/revoked', async () => {
      signedIn();
      setRegistration(live());
      api.forced['GET /geography/markets'] = { status: 401, code: 'SESSION_REVOKED', category: 'AUTHENTICATION' };
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
    it('with the registry copy down the page renders without text and without crashing', async () => {
      signedIn();
      setRegistration(live());
      stub.mode = 'down';
      const html = await render();
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<button');
    });
  });
});
