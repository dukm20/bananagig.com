// ID-005 web side, part 2: the server component /consents, the consent calls of the API client and the link from /session. The API is the account + content stub
// (testing/account-stub.ts): the page reads the requirements and the history with the session's token, takes the legal text from the PUBLIC content resolver, offers
// Accept ONLY for the version it proved is the one in force (same version id and text hash), and every string comes from the registry copy (CONSENT_COPY, worded unlike
// the seeded copy). Nothing is ever pre-ticked, and no token, secret or submitted word is rendered.
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_ERROR_CODES, LEGAL_ENTRY_KEYS } from '@bananagig/contracts';
import ConsentsPage, { dynamic, metadata } from './app/consents/page';
import SessionPage from './app/session/page';
import { ApiError, createApiClient } from './lib/api-client';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import {
  CONSENT_COPY,
  CONSENT_EVENT_ID,
  CONSENT_TEXT,
  PRIVACY_BODY,
  PRIVACY_HASH,
  PRIVACY_VERSION_ID,
  TOS_BODY,
  TOS_HASH,
  TOS_VERSION_ID,
  attachAccountApi,
  consentDocument,
  consentEventDto,
  emptyConsentsDto,
  requirementDto,
  requirementsDto,
  sha256Hex,
  type AccountApiStub,
} from './testing/account-stub';
import { startContentStub, type ContentStub, type StubCatalog } from './testing/content-stub';

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
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-5', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
const t = (key: string): string => CONSENT_TEXT[`account.consent.${key}`] ?? `missing copy for ${key}`;
const TOS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const ACCEPT_FORM = '<form method="post" action="/auth/consents/accept">';
const WITHDRAW_FORM = '<form method="post" action="/auth/consents/withdraw">';

describe('consent page', () => {
  let stub: ContentStub;
  let api: AccountApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(CONSENT_COPY);
    api = attachAccountApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = CONSENT_COPY;
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
    renderToString(await ConsentsPage({ searchParams: Promise.resolve(q) }))
      .replaceAll('<!-- -->', '')
      .replace(/<form action="([^"]*)" method="post">/g, '<form method="post" action="$1">');
  const consentCalls = (path = '') => api.calls.filter((c) => c.path.startsWith(`/api/v1/account/consents${path}`));
  const catalogWith = (over: StubCatalog['x'], without: string[] = []): StubCatalog => ({
    'en-US': { ...Object.fromEntries(Object.entries(CONSENT_COPY['en-US']!).filter(([k]) => !without.includes(k))), ...over },
  });
  const resolveCalls = () =>
    stub.calls.filter((c) => c.path === '/api/v1/content/resolve').map((c) => c.body as { key: string; locale: string; variables?: Record<string, unknown> });
  const legalResolves = () => resolveCalls().filter((c) => c.key.startsWith('legal.'));
  /** The hidden fields of every accept form of the page, in order. */
  const acceptForms = (html: string): Array<Record<string, string>> =>
    [...html.matchAll(/<form method="post" action="\/auth\/consents\/accept">(.*?)<\/form>/g)].map((m) =>
      Object.fromEntries([...m[1]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((i) => [i[1]!, i[2]!])),
    );
  const NOT_OFFERED = (html: string) => {
    expect(html).not.toContain(ACCEPT_FORM);
    expect(html).not.toContain(`>${t('action.accept')}</button>`);
  };

  describe('page metadata', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
    });
  });

  describe('signed out', () => {
    it('shows the registry title and the sign-in control that returns to /consents; no consent call is made', async () => {
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/consents">Registry sign in</a>');
      expect(consentCalls()).toEqual([]);
      expect(legalResolves()).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label) and nothing else is shown', async () => {
      stub.mode = 'down';
      const html = await render();
      expect(html).toContain('<a href="/auth/login?returnTo=/consents">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('an unknown session cookie is signed out', async () => {
      state.cookie = 'bg_session=nope';
      expect(await render()).toContain('/auth/login?returnTo=/consents');
    });
  });

  describe('signed in: outstanding purposes', () => {
    it('reads requirements and history with the session token and role, and renders the registry copy', async () => {
      signedIn({ activeRole: 'CUSTOMER' });
      const html = await render();
      for (const path of ['', '/requirements']) {
        const calls = api.calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === `/api/v1/account/consents${path}`);
        expect(calls, path).toHaveLength(1);
        expect(calls[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'CUSTOMER' });
      }
      // the evaluation locale is the API's decision (the account's preferred locale): the page sends none
      expect(api.calls.find((c) => c.path.startsWith('/api/v1/account/consents/requirements'))!.path).toBe('/api/v1/account/consents/requirements');
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p>${t('intro')}</p>`);
      expect(html).toContain(`>${t('requirements.title')}</h2>`);
      expect(html).toContain(`<p>${t('requirements.outstanding_intro')}</p>`);
      expect(html).not.toContain(t('requirements.all_done'));
      expect(html).toContain(`<h3>${t('purpose.terms_of_service')}</h3>`);
      expect(html).toContain(`<h3>${t('purpose.privacy_policy')}</h3>`);
      expect(html).toContain(`<p>${t('status.outstanding')}</p>`);
      expect(html).toContain(t('state.none'));
      expect(html).toContain(`>${t('history.title')}</h2>`);
      expect(html).toContain(`<p>${t('history.empty')}</p>`);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
    });
    it('shows the legal text from the PUBLIC resolver for exactly the entry and locale of the requirement, as sanitized markup', async () => {
      signedIn();
      const html = await render();
      expect(
        legalResolves()
          .map((c) => [c.key, c.locale])
          .sort(),
      ).toEqual([
        [LEGAL_ENTRY_KEYS.PRIVACY_POLICY, 'en-US'],
        [LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE, 'en-US'],
      ]);
      // a plain resolve: no historical instant, no template, no variables, no scope (management-only fields are not sent)
      for (const c of legalResolves()) expect(Object.keys(c).sort()).toEqual(['key', 'locale']);
      expect(html).toContain(TOS_BODY);
      expect(html).toContain(PRIVACY_BODY);
      expect(html).toContain('<h2>Registry terms heading</h2>');
      expect(html).toContain(`>${t('document.read')}</h4>`);
      expect(html).toContain('lang="en-US"');
    });
    it('offers one Accept form per purpose whose hidden fields are EXACTLY the verified document (purpose, version id, locale, hash)', async () => {
      signedIn();
      const html = await render();
      expect(acceptForms(html)).toEqual([
        { purpose: TOS, versionId: TOS_VERSION_ID, locale: 'en-US', bodySha256: TOS_HASH },
        { purpose: PRIVACY, versionId: PRIVACY_VERSION_ID, locale: 'en-US', bodySha256: PRIVACY_HASH },
      ]);
      expect(html).toContain(`<button type="submit">${t('action.accept')}</button>`);
      expect(html.match(/<form /g)).toHaveLength(2);
    });
    it('R-13: nothing is pre-ticked or auto-submitted: no checkbox, no radio, no checked or selected state, no script, no accept link, no GET target', async () => {
      signedIn();
      const html = await render();
      for (const forbidden of [
        'type="checkbox"',
        'type="radio"',
        'checked',
        'selected',
        'defaultChecked',
        '<script',
        'autofocus',
        'onload',
        'onclick',
        'formaction',
        'http-equiv',
      ]) {
        expect(html, forbidden).not.toContain(forbidden);
      }
      // every form posts; the only form fields are hidden; nothing links to an accept endpoint
      for (const m of html.matchAll(/<form [^>]*>/g)) expect(m[0]).toMatch(/method="post"/);
      expect(html).not.toMatch(/<a [^>]*href="[^"]*(accept|withdraw)/);
      expect(html.match(/<input /g)!.length).toBe(html.match(/<input type="hidden"/g)!.length);
    });
    it('renders a text-format document escaped (a script in the text is text, never markup)', async () => {
      signedIn();
      const hostile = '<script>alert(1)</script> & <img src=x onerror=alert(2)>';
      stub.catalog = catalogWith({
        [LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE]: {
          value: hostile,
          format: 'text',
          contentType: 'LEGAL',
          version: { versionId: TOS_VERSION_ID, version: 3, bodySha256: TOS_HASH },
        },
      });
      const html = await render();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(2)&gt;');
      expect(html).toContain('class="legal-text"');
      expect(acceptForms(html)).toHaveLength(2); // the text is the version in force (hash and id match); only its rendering is escaped
    });
    it('shows the version, locale and the shortened accepted-on variables it sends to the registry (variables are typed values, not text)', async () => {
      signedIn();
      await render();
      const versions = resolveCalls().filter((c) => c.key === 'account.consent.document.version');
      expect(versions.map((c) => c.variables).sort((a, b) => Number(a!.version) - Number(b!.version))).toEqual([{ version: 2 }, { version: 3 }]);
      expect(
        resolveCalls()
          .filter((c) => c.key === 'account.consent.document.locale')
          .map((c) => c.variables),
      ).toEqual([{ locale: 'en-US' }]);
    });
    it('every string is registry copy: no managed word is a literal of the app', async () => {
      signedIn();
      const html = await render();
      const text = html.replace(/<[^>]*>/g, ' ');
      for (const literal of ['Accept', 'Withdraw', 'Terms', 'Privacy', 'Consent', 'agree', 'I have read', 'History'])
        expect(text, literal).not.toContain(literal);
    });
    it('no token, refresh token or id token is rendered', async () => {
      signedIn();
      const html = await render();
      for (const secret of [TOKENS.access, TOKENS.refresh, TOKENS.id, 'Bearer']) expect(html).not.toContain(secret);
    });
  });

  describe('the document is proven to be the version in force before Accept is offered', () => {
    const served = (
      purpose: 'TERMS_OF_SERVICE' | 'PRIVACY_POLICY',
      over: Partial<{ value: string; versionId: string; version: number; bodySha256: string }> = {},
    ) => ({
      [LEGAL_ENTRY_KEYS[purpose]]: {
        value: over.value ?? (purpose === TOS ? TOS_BODY : PRIVACY_BODY),
        format: 'html' as const,
        contentType: 'LEGAL' as const,
        version: {
          versionId: over.versionId ?? (purpose === TOS ? TOS_VERSION_ID : PRIVACY_VERSION_ID),
          version: over.version ?? (purpose === TOS ? 3 : 2),
          bodySha256: over.bodySha256 ?? (purpose === TOS ? TOS_HASH : PRIVACY_HASH),
        },
      },
    });
    const UNAVAILABLE_NOTE = `<p role="status">${t('document.unavailable_note')}</p>`;
    it.each([
      ['a different version id (a newer version was published in between)', served(TOS, { versionId: '11111111-2222-4333-8444-555555555555' })],
      ['the same version id but a different text hash', served(TOS, { bodySha256: sha256Hex('another text') })],
      ['the same hash but a different version id', served(TOS, { versionId: 'aaaaaaaa-2222-4333-8444-555555555555' })],
      ['an upper-cased hash', served(TOS, { bodySha256: TOS_HASH.toUpperCase() })],
      ['an upper-cased version id', served(TOS, { versionId: TOS_VERSION_ID.toUpperCase() })],
      ['a text that is empty', served(TOS, { value: '' })],
    ])('refuses Accept for that purpose when the resolver serves %s', async (_name, entry) => {
      signedIn();
      stub.catalog = catalogWith(entry);
      const html = await render();
      // the refused purpose: the note, no text, no hidden fields of it
      expect(html).toContain(UNAVAILABLE_NOTE);
      expect(html).not.toContain(TOS_BODY);
      const forms = acceptForms(html);
      expect(forms.map((f) => f.purpose)).toEqual([PRIVACY]);
      expect(html).not.toContain(TOS_HASH);
      expect(html).not.toContain(TOS_VERSION_ID);
      // the other purpose is untouched
      expect(html).toContain(PRIVACY_BODY);
    });
    it('refuses Accept when the entry served is not a LEGAL document', async () => {
      signedIn();
      stub.catalog = catalogWith({
        [LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE]: {
          value: TOS_BODY,
          format: 'html',
          contentType: 'RICH_TEXT',
          version: { versionId: TOS_VERSION_ID, version: 3, bodySha256: TOS_HASH },
        },
      });
      const html = await render();
      expect(html).toContain(UNAVAILABLE_NOTE);
      expect(acceptForms(html).map((f) => f.purpose)).toEqual([PRIVACY]);
    });
    it('refuses Accept when the registry fell back to another locale (a legal document is exact: the resolver must serve the locale of the version)', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([requirementDto(TOS, { document: consentDocument(TOS, { locale: 'fr-FR' }) }), requirementDto(PRIVACY)]);
      const html = await render();
      expect(legalResolves().find((c) => c.key === LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE)!.locale).toBe('fr-FR');
      expect(html).toContain(UNAVAILABLE_NOTE);
      expect(html).not.toContain(TOS_BODY); // the English fallback is not shown as if it were the French version
      expect(acceptForms(html).map((f) => f.purpose)).toEqual([PRIVACY]);
    });
    it('refuses Accept when the resolver does not know the entry (404) or the registry is down; the note is shown for each purpose', async () => {
      signedIn();
      stub.catalog = catalogWith({}, [LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE, LEGAL_ENTRY_KEYS.PRIVACY_POLICY]);
      const html = await render();
      NOT_OFFERED(html);
      expect(html.split(UNAVAILABLE_NOTE)).toHaveLength(3);
    });
    it('with the whole registry down no legal text, no note and no Accept control is invented', async () => {
      signedIn();
      stub.mode = 'down';
      const html = await render();
      NOT_OFFERED(html);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<h1');
      expect(html).not.toContain(TOS_BODY);
    });
    it('refuses Accept when the requirement itself is not an acceptable request (malformed hash or locale from the API): the note, never a hidden field', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([
        requirementDto(TOS, { document: consentDocument(TOS, { bodySha256: 'zz' }) }),
        requirementDto(PRIVACY, { document: consentDocument(PRIVACY, { locale: 'e' }) }),
      ]);
      const html = await render();
      NOT_OFFERED(html);
      expect(html.split(UNAVAILABLE_NOTE)).toHaveLength(3);
      expect(legalResolves()).toEqual([]);
    });
    it('a requirement without a document (DOCUMENT_UNAVAILABLE) shows the note, resolves nothing and offers nothing', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([
        requirementDto(TOS, { status: 'DOCUMENT_UNAVAILABLE', document: null }),
        requirementDto(PRIVACY, { status: 'DOCUMENT_UNAVAILABLE', document: null }),
      ]);
      const html = await render();
      expect(html.split(UNAVAILABLE_NOTE)).toHaveLength(3);
      expect(html).toContain(`<p>${t('status.document_unavailable')}</p>`);
      NOT_OFFERED(html);
      expect(legalResolves()).toEqual([]);
    });
    it('an OUTSTANDING requirement whose document is null cannot be accepted either', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([requirementDto(TOS, { document: null })]);
      const html = await render();
      expect(html).toContain(UNAVAILABLE_NOTE);
      NOT_OFFERED(html);
    });
    it('the note and the Accept label are omitted (never replaced by a literal) when the registry lacks them', async () => {
      signedIn();
      stub.catalog = catalogWith(served(TOS, { bodySha256: sha256Hex('x') }), ['account.consent.document.unavailable_note']);
      const html = await render();
      expect(html).not.toContain('role="status"');
      stub.catalog = catalogWith({}, ['account.consent.action.accept']);
      const noAccept = await render();
      expect(noAccept).not.toContain('<form');
      expect(noAccept).toContain(TOS_BODY); // the text is still shown; without a label there is simply nothing to press
    });
  });

  describe('satisfied, re-acceptance and withdrawal', () => {
    const acceptedTos = consentEventDto({ occurredAt: '2026-10-16T09:30:00.000Z' });
    it('a SATISFIED purpose shows its state, when and which version, with no text and no Accept control; the all-done copy is shown', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([
        requirementDto(TOS, { status: 'SATISFIED', acceptanceState: 'ACCEPTED', accepted: acceptedTos }),
        requirementDto(PRIVACY, {
          status: 'SATISFIED',
          acceptanceState: 'ACCEPTED',
          accepted: consentEventDto({
            purposeCode: PRIVACY,
            document: { versionId: PRIVACY_VERSION_ID, version: 2, locale: 'en-US', bodySha256: PRIVACY_HASH },
          }),
        }),
      ]);
      const html = await render();
      expect(html).toContain(`<p>${t('requirements.all_done')}</p>`);
      expect(html).not.toContain(t('requirements.outstanding_intro'));
      expect(html).toContain(t('state.accepted'));
      expect(html).toContain(t('accepted_on'));
      NOT_OFFERED(html);
      expect(legalResolves()).toEqual([]); // nothing to read, nothing to resolve
      const on = resolveCalls().filter((c) => c.key === 'account.consent.accepted_on');
      expect(on.map((c) => c.variables)).toEqual([{ date: '2026-10-16 09:30Z' }]); // deduplicated by value; a fixed unambiguous date
    });
    it('a REACCEPTANCE_REQUIRED purpose offers the version in force (and shows that an earlier version was accepted)', async () => {
      signedIn();
      const old = consentEventDto({
        document: { versionId: 'cccccccc-2222-4333-8444-555555555555', version: 2, locale: 'en-US', bodySha256: sha256Hex('old') },
      });
      api.consent.requirements = requirementsDto([requirementDto(TOS, { status: 'REACCEPTANCE_REQUIRED', acceptanceState: 'ACCEPTED', accepted: old })]);
      const html = await render();
      expect(html).toContain(`<p>${t('status.reacceptance_required')}</p>`);
      expect(acceptForms(html)).toEqual([{ purpose: TOS, versionId: TOS_VERSION_ID, locale: 'en-US', bodySha256: TOS_HASH }]);
      expect(html).not.toContain('cccccccc-2222');
      expect(html).not.toContain(sha256Hex('old'));
    });
    it('a withdrawable, accepted purpose that no role requires has a Withdraw form with only the purpose', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([
        requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED', withdrawable: true, accepted: acceptedTos }),
      ]);
      const html = await render();
      expect(html).toContain(
        `${WITHDRAW_FORM}<input type="hidden" name="purpose" value="${TOS}"/><button type="submit">${t('action.withdraw')}</button></form>`,
      );
      expect(html.match(/<input /g)).toHaveLength(1);
      NOT_OFFERED(html);
    });
    it('no Withdraw control for a required purpose, a not-withdrawable one, one not accepted, or when the registry lacks the label', async () => {
      signedIn();
      const cases = [
        requirementDto(TOS, { required: true, status: 'SATISFIED', acceptanceState: 'ACCEPTED', withdrawable: true, accepted: acceptedTos }),
        requirementDto(PRIVACY, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED', withdrawable: false, accepted: acceptedTos }),
        requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'WITHDRAWN', withdrawable: true }),
        requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'NONE', withdrawable: true }),
      ];
      for (const c of cases) {
        api.consent.requirements = requirementsDto([c]);
        expect(await render(), JSON.stringify(c)).not.toContain(WITHDRAW_FORM);
      }
      api.consent.requirements = requirementsDto([cases[0]!, { ...cases[1]!, withdrawable: true, required: false }]);
      stub.catalog = catalogWith({}, ['account.consent.action.withdraw']);
      expect(await render()).not.toContain('<form');
    });
    it('a NOT_REQUIRED purpose that is not accepted offers no Accept (only outstanding or re-acceptance purposes can be accepted from this page)', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'NONE' })]);
      const html = await render();
      NOT_OFFERED(html);
      expect(legalResolves()).toEqual([]);
    });
  });

  describe('history', () => {
    it('lists the events newest first with purpose, event, version, locale, date and a SHORTENED hash (never the whole hash)', async () => {
      signedIn();
      api.consent.consents = {
        ...emptyConsentsDto(),
        history: [
          consentEventDto({ consentEventId: 'e2', eventType: 'WITHDRAWN', eventSeq: 2, occurredAt: '2026-10-17T10:15:00.000Z' }),
          consentEventDto({ consentEventId: 'e1', eventType: 'ACCEPTED', eventSeq: 1, occurredAt: '2026-10-16T09:30:00.000Z' }),
        ],
      };
      const html = await render();
      const items = [...html.matchAll(/<section aria-labelledby="consent-history">.*?<\/section>/g)][0]![0].match(/<li>.*?<\/li>/g)!;
      expect(items).toHaveLength(2);
      expect(items[0]).toContain(t('event.withdrawn'));
      expect(items[1]).toContain(t('event.accepted'));
      expect(items[0]).toContain('<time dateTime="2026-10-17T10:15:00.000Z">2026-10-17 10:15Z</time>');
      expect(items[0]).toContain(t('purpose.terms_of_service'));
      expect(items[0]).toContain(`<code>${TOS_HASH.slice(0, 12)}</code>`);
      const section = html.slice(html.indexOf('<section aria-labelledby="consent-history">'));
      expect(section).not.toContain(TOS_HASH.slice(0, 13)); // never longer than 12 digits in the history
      expect(html).not.toContain(t('history.empty'));
      // the version and locale of each event go through the registry as typed variables
      expect(
        resolveCalls()
          .filter((c) => c.key === 'account.consent.document.version')
          .some((c) => c.variables?.version === 3),
      ).toBe(true);
    });
    it('omits a hash that is not 64 lower-case hex digits and an event whose labels the registry lacks', async () => {
      signedIn();
      api.consent.consents = {
        ...emptyConsentsDto(),
        history: [consentEventDto({ document: { versionId: TOS_VERSION_ID, version: 3, locale: 'en-US', bodySha256: '<b>nothex</b>' } })],
      };
      stub.catalog = catalogWith({}, ['account.consent.event.accepted']);
      const html = await render();
      expect(html).not.toContain('<code>');
      expect(html).not.toContain('nothex');
      expect(html).not.toContain(t('event.accepted'));
    });
    it('the history shows what the API reports and nothing more: no event id, no source, no account id', async () => {
      signedIn();
      api.consent.consents = { ...emptyConsentsDto(), history: [consentEventDto()] };
      const html = await render();
      for (const hidden of [CONSENT_EVENT_ID, 'ACCOUNT_API', 'b2d94f10', 'eventSeq']) expect(html, hidden).not.toContain(hidden);
    });
  });

  describe('notices and errors come from closed lists of words', () => {
    const acceptedBoth = () =>
      (api.consent.requirements = requirementsDto([
        requirementDto(TOS, { status: 'SATISFIED', acceptanceState: 'ACCEPTED', accepted: consentEventDto() }),
        requirementDto(PRIVACY, { status: 'SATISFIED', acceptanceState: 'ACCEPTED', accepted: consentEventDto({ purposeCode: PRIVACY }) }),
      ]));
    it.each([
      ['accepted', 'accepted'],
      ['already_accepted', 'already_accepted'],
    ])('?notice=%s shows its registry message when an acceptance exists', async (word, k) => {
      signedIn();
      acceptedBoth();
      const html = await render({ notice: word });
      expect(html).toContain(`<p role="status">${t(`notice.${k}`)}</p>`);
    });
    it('?notice=withdrawn is shown only when a purpose is withdrawn', async () => {
      signedIn();
      expect(await render({ notice: 'withdrawn' })).not.toContain(t('notice.withdrawn'));
      api.consent.requirements = requirementsDto([
        requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', acceptanceState: 'WITHDRAWN', withdrawable: true }),
      ]);
      expect(await render({ notice: 'withdrawn' })).toContain(`<p role="status">${t('notice.withdrawn')}</p>`);
    });
    it('a typed ?notice=accepted proves nothing: with nothing accepted it is not shown', async () => {
      signedIn();
      const html = await render({ notice: 'accepted' });
      expect(html).not.toContain(t('notice.accepted'));
      expect(html).not.toContain('role="status"');
    });
    it('ignores an unknown notice word, a repeated parameter and Object.prototype names, and never echoes them', async () => {
      signedIn();
      acceptedBoth();
      for (const notice of ['nope', '<script>alert(1)</script>', 'constructor', '__proto__', 'toString', ['accepted', 'withdrawn'], ''] as Array<
        string | string[]
      >) {
        const html = await render({ notice });
        expect(html, JSON.stringify(notice)).not.toContain('role="status"');
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
      }
    });
    it.each(CONSENT_ERROR_CODES)("?error=ACCOUNT_%s shows that code's registry message in an alert", async (code) => {
      signedIn();
      const html = await render({ error: `ACCOUNT_${code}` });
      expect(html).toContain(`<p role="alert">Registry consent error ${code.toLowerCase()}</p>`);
    });
    it('the codes without the ACCOUNT_ prefix, unknown words and API_ERROR show the generic message and are never echoed', async () => {
      signedIn();
      for (const error of ['API_ERROR', 'CONSENT_REQUIRED', 'ACCOUNT_SUSPENDED', 'nope', '"><script>alert(1)</script>', 'constructor', '__proto__', '']) {
        const html = await render({ error });
        expect(html, JSON.stringify(error)).toContain(`<p role="alert">${CONSENT_TEXT['account.consent.error.unavailable']}</p>`);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
        expect(html).not.toContain('SUSPENDED');
      }
    });
    it('a repeated ?error= parameter is ignored (nothing is shown for it)', async () => {
      signedIn();
      expect(await render({ error: ['ACCOUNT_CONSENT_REQUIRED', 'x'] })).not.toContain('role="alert"');
    });
    it('an error wins over a notice; with no copy for the message nothing is invented', async () => {
      signedIn();
      acceptedBoth();
      const both = await render({ error: 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT', notice: 'accepted' });
      expect(both).toContain('role="alert"');
      stub.catalog = catalogWith({}, ['account.consent.error.version_not_current', 'account.consent.error.unavailable']);
      const none = await render({ error: 'ACCOUNT_CONSENT_VERSION_NOT_CURRENT' });
      expect(none).not.toContain('role="alert"');
      expect(none).not.toContain('VERSION_NOT_CURRENT');
    });
  });

  describe('the API or the registry is partly or wholly unavailable', () => {
    it('with the account API down the page says it could not be done (generic copy) and offers nothing', async () => {
      signedIn();
      api.mode = 'down';
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p role="alert">${CONSENT_TEXT['account.consent.error.unavailable']}</p>`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain(t('requirements.title'));
      expect(html).not.toContain(t('history.title'));
      expect(legalResolves()).toEqual([]);
    });
    it('a suspended account is "unavailable", never its status', async () => {
      signedIn();
      api.mode = 'suspended';
      const html = await render();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('SUSPENDED');
      expect(html).not.toContain('<form');
    });
    it('when only the history fails the requirements still work, and the other way round', async () => {
      signedIn();
      api.forced['GET /account/consents'] = { status: 503, code: 'ACCOUNT_UNAVAILABLE', category: 'DEPENDENCY' };
      const noHistory = await render();
      expect(noHistory).toContain(ACCEPT_FORM);
      expect(noHistory).not.toContain(t('history.title'));
      expect(noHistory).not.toContain('role="alert"');
      delete api.forced['GET /account/consents'];
      api.forced['GET /account/consents/requirements'] = { status: 503, code: 'ACCOUNT_UNAVAILABLE', category: 'DEPENDENCY' };
      const noReqs = await render();
      expect(noReqs).not.toContain('<form');
      expect(noReqs).toContain(t('history.title'));
    });
    it('a response that violates the contract is "unavailable", not a crash', async () => {
      signedIn();
      api.consent.requirements = { locale: 'en-US', requirements: [{ nonsense: true }], satisfied: true, outstanding: [] } as never;
      const html = await render();
      expect(html).not.toContain('<form');
      expect(html).toContain(t('history.title'));
    });
    it('a revoked session goes to /auth/revoked (a page cannot clear a cookie) before anything is rendered', async () => {
      signedIn();
      api.revoked = true;
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
      expect(legalResolves()).toEqual([]);
    });
    it('copy missing from the registry is omitted element by element', async () => {
      signedIn();
      stub.catalog = catalogWith({}, [
        'account.consent.title',
        'account.consent.intro',
        'account.consent.requirements.title',
        'account.consent.history.title',
        'account.consent.purpose.terms_of_service',
        'account.consent.status.outstanding',
        'account.consent.state.none',
      ]);
      const html = await render();
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<section');
      // without the requirements heading the whole section (and its forms) is omitted: nothing is offered without its label context
      expect(html).not.toContain('<form');
    });
    it('no requirement with an invalid purpose code is rendered', async () => {
      signedIn();
      api.consent.requirements = requirementsDto([requirementDto(TOS), { ...requirementDto(PRIVACY), purposeCode: 'bad code"><script>' }]);
      const html = await render();
      expect(html).not.toContain('<script>');
      expect(acceptForms(html).map((f) => f.purpose)).toEqual([TOS]);
    });
  });

  describe('a full accept round trip against the stub API (the page, the hidden fields, the client, the page again)', () => {
    it('what the page offers is accepted by the API, the history shows it, and the next render is satisfied with no Accept control', async () => {
      signedIn();
      const first = await render();
      const [tos, privacy] = acceptForms(first);
      const client = createApiClient({ baseUrl: stub.baseUrl, accessToken: () => TOKENS.access });
      const done = await client.acceptConsent(tos!.purpose!, { versionId: tos!.versionId!, locale: tos!.locale!, bodySha256: tos!.bodySha256! });
      expect(done.changed).toBe(true);
      expect(done.event).toMatchObject({
        purposeCode: TOS,
        eventType: 'ACCEPTED',
        eventSeq: 1,
        document: { versionId: TOS_VERSION_ID, version: 3, bodySha256: TOS_HASH },
      });
      const second = await render({ notice: 'accepted' });
      expect(acceptForms(second).map((f) => f.purpose)).toEqual([PRIVACY]);
      expect(second).toContain(`<p role="status">${t('notice.accepted')}</p>`);
      expect(second).toContain(t('state.accepted'));
      expect(second).toContain(`<code>${TOS_HASH.slice(0, 12)}</code>`);
      await client.acceptConsent(privacy!.purpose!, { versionId: privacy!.versionId!, locale: privacy!.locale!, bodySha256: privacy!.bodySha256! });
      const third = await render();
      expect(third).toContain(t('requirements.all_done'));
      NOT_OFFERED(third);
    });
  });

  describe('the link from /session', () => {
    const renderSession = async () => renderToString(await SessionPage({ searchParams: Promise.resolve({}) })).replaceAll('<!-- -->', '');
    it('a signed-in session links to /consents with the registry title; the link is omitted when the registry lacks the title', async () => {
      signedIn();
      const html = await renderSession();
      expect(html).toContain(`<a href="/consents">${t('title')}</a>`);
      stub.catalog = catalogWith({}, ['account.consent.title']);
      expect(await renderSession()).not.toContain('/consents');
    });
    it('a signed-out visitor sees no link to /consents on /session', async () => {
      expect(await renderSession()).not.toContain('/consents');
    });
  });
});

describe('API client: consent calls', () => {
  let stub: ContentStub;
  let api: AccountApiStub;
  beforeAll(async () => {
    stub = await startContentStub(CONSENT_COPY);
    api = attachAccountApi(stub);
  });
  afterAll(() => stub.close());
  beforeEach(() => api.reset());
  const client = (token = 'tok-A') => createApiClient({ baseUrl: stub.baseUrl, accessToken: () => token, correlationId: () => 'corr-consent' });
  const body = { versionId: TOS_VERSION_ID, locale: 'en-US', bodySha256: TOS_HASH };
  const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  };

  it('getConsentRequirements: GET with the bearer token, the role header and the optional locale, parsed with the contract', async () => {
    const r = await client().getConsentRequirements({}, { activeRole: 'CUSTOMER' });
    expect(r.requirements.map((x) => x.purposeCode)).toEqual([TOS, PRIVACY]);
    expect(r.satisfied).toBe(false);
    expect(r.outstanding).toEqual([TOS, PRIVACY]);
    expect(api.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/api/v1/account/consents/requirements',
      authorization: 'Bearer tok-A',
      activeRole: 'CUSTOMER',
      correlationId: 'corr-consent',
    });
    await client().getConsentRequirements({ locale: 'fr-FR&x=1' });
    expect(api.calls.at(-1)!.path).toBe('/api/v1/account/consents/requirements?locale=fr-FR%26x%3D1');
  });
  it('getAccountConsents: GET /account/consents parsed with the contract', async () => {
    api.consent.consents.history = [consentEventDto()];
    const r = await client().getAccountConsents();
    expect(r.history[0]).toMatchObject({ purposeCode: TOS, eventType: 'ACCEPTED' });
    expect(r.current.map((c) => c.state)).toEqual(['NONE', 'NONE']);
    expect(api.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/account/consents', activeRole: undefined });
  });
  it('acceptConsent: POST /account/consents/<purpose>/accept with exactly the three fields; the purpose is encoded', async () => {
    const r = await client().acceptConsent(TOS, body, { activeRole: 'PROVIDER' });
    expect(r).toMatchObject({ changed: true, event: { eventType: 'ACCEPTED' } });
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/account/consents/${TOS}/accept`, body, activeRole: 'PROVIDER' });
    expect((await refusal(client().acceptConsent('A/../B', body))).status).toBe(404);
    expect(api.calls.at(-1)!.path).toBe('/api/v1/account/consents/A%2F..%2FB/accept');
  });
  it('acceptConsent: a repeat is changed: false; a refusal is an ApiError with the API code', async () => {
    await client().acceptConsent(TOS, body);
    expect((await client().acceptConsent(TOS, body)).changed).toBe(false);
    const stale = await refusal(client().acceptConsent(TOS, { ...body, versionId: '11111111-2222-4333-8444-555555555555' }));
    expect([stale.status, stale.code]).toEqual([404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND']);
    const hash = await refusal(client().acceptConsent(TOS, { ...body, bodySha256: 'f'.repeat(64) }));
    expect([hash.status, hash.code]).toEqual([400, 'ACCOUNT_CONSENT_HASH_MISMATCH']);
    const loc = await refusal(client().acceptConsent(TOS, { ...body, locale: 'de-DE' }));
    expect([loc.status, loc.code]).toEqual([400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH']);
    const unknown = await refusal(client().acceptConsent('NO_SUCH', body));
    expect([unknown.status, unknown.code]).toEqual([404, 'ACCOUNT_CONSENT_PURPOSE_NOT_FOUND']);
  });
  it('withdrawConsent: POST /account/consents/<purpose>/withdraw with an empty JSON body; the API decides', async () => {
    api.consent.requirements = requirementsDto([requirementDto(TOS, { required: false, status: 'NOT_REQUIRED', withdrawable: true })]);
    expect((await refusal(client().withdrawConsent(TOS))).code).toBe('ACCOUNT_CONSENT_NOT_ACCEPTED');
    await client().acceptConsent(TOS, body);
    const r = await client().withdrawConsent(TOS, { activeRole: 'CUSTOMER' });
    expect(r).toMatchObject({ changed: true, event: { eventType: 'WITHDRAWN', eventSeq: 2 } });
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/account/consents/${TOS}/withdraw`, body: {}, activeRole: 'CUSTOMER' });
    expect((await client().withdrawConsent(TOS)).changed).toBe(false);
  });
  it('withdrawConsent: a required purpose and a not-withdrawable one are conflicts', async () => {
    api.consent.requirements = requirementsDto([requirementDto(TOS, { withdrawable: true }), requirementDto(PRIVACY, { withdrawable: false })]);
    await client().acceptConsent(TOS, body);
    expect((await refusal(client().withdrawConsent(TOS))).code).toBe('ACCOUNT_CONSENT_REQUIRED_FOR_ROLE');
    const nw = await refusal(client().withdrawConsent(PRIVACY));
    expect([nw.status, nw.code]).toEqual([409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE']);
  });
  it('without a token the API answers 401, and a revoked session is 401 SESSION_REVOKED', async () => {
    expect((await refusal(client('').getConsentRequirements())).status).toBe(401);
    api.revoked = true;
    const err = await refusal(client().acceptConsent(TOS, body));
    expect([err.status, err.code]).toEqual([401, 'SESSION_REVOKED']);
  });
  it('a body that violates the contract is UNEXPECTED_RESPONSE, not a crash of the caller', async () => {
    api.forced['GET /account/consents'] = { status: 503, code: 'ACCOUNT_UNAVAILABLE', category: 'DEPENDENCY' };
    expect((await refusal(client().getAccountConsents())).code).toBe('ACCOUNT_UNAVAILABLE');
    delete api.forced['GET /account/consents'];
    api.consent.requirements = { locale: 'en-US', requirements: [{ purposeCode: TOS }], satisfied: true, outstanding: [] } as never;
    expect((await refusal(client().getConsentRequirements())).code).toBe('UNEXPECTED_RESPONSE');
    api.reset();
    api.consent.consents = { current: [], history: [{ ...consentEventDto(), eventType: 'DECLINED' }] } as never;
    expect((await refusal(client().getAccountConsents())).code).toBe('UNEXPECTED_RESPONSE');
  });
});
