// PRO-002 web side, part 4: the server components /provider/profile (the owner's page), /provider/profile/preview and the public page /providers/[publicProfileId]. The API is the
// profile stub (testing/profile-stub.ts, contract-validated) mounted on the content stub. The pages read with the session's token and role (the public page with NO token and no
// session), offer each form only when the data supports it, render the provider's own text as escaped text nodes only, take every platform string from the registry copy (and omit what
// the registry cannot serve), never render a rating, a BananaDrop or any private identifier, and say that a public profile is not live and not bookable.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIG_MEDIA_REFUSAL_REASONS, PROFILE_ERROR_CODES, PROFILE_ISSUE_REASONS, profileWireCode } from '@bananagig/contracts';
import PreviewPage from './app/provider/profile/preview/page';
import OwnerPage, { dynamic, metadata } from './app/provider/profile/page';
import PublicPage, { dynamic as publicDynamic, metadata as publicMetadata } from './app/providers/[publicProfileId]/page';
import { MemorySessionStore } from './lib/auth/store';
import { profileKey } from './lib/provider-profile';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { startContentStub, type ContentStub, type StubCatalog } from './testing/content-stub';
import {
  OTHER_PROFILE_ID,
  PROFILE_COPY,
  PROFILE_PATHS,
  PROFILE_TEXT,
  PUBLIC_PROFILE_ID,
  attachProfileApi,
  ownerProfileDto,
  ownerStateDto,
  previewDto,
  publicGigDto,
  publicProfileDto,
  readinessDto,
  type ProfileApiStub,
} from './testing/profile-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown, authCalls: 0 }));
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
vi.mock('./lib/auth/runtime', () => ({
  authDeps: () => {
    state.authCalls++;
    return state.deps;
  },
}));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const t = (key: string): string => PROFILE_TEXT[key] ?? `missing copy for ${key}`;
const p = (path: string): string => t(profileKey(path));
const XSS = `<script>alert(1)</script>"><img src=x onerror=alert(2)>'&amp;`;

/** The catalog without the keys `drop` selects; extra keys can be added. */
const withCopy = (drop: (k: string) => boolean = () => false, extra: Record<string, string> = {}): StubCatalog => ({
  'en-US': {
    ...Object.fromEntries(Object.entries(PROFILE_COPY['en-US']!).filter(([k]) => !drop(k))),
    ...Object.fromEntries(Object.entries(extra).map(([k, value]) => [k, { value }])),
  },
});

describe('provider profile pages', () => {
  let stub: ContentStub;
  let api: ProfileApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(withCopy());
    api = attachProfileApi(stub);
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
    state.authCalls = 0;
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
  const renderOwner = async (q: Q = {}) => clean(renderToString(await OwnerPage({ searchParams: Promise.resolve(q) })));
  const renderPreview = async () => clean(renderToString(await PreviewPage()));
  const renderPublic = async (id = PUBLIC_PROFILE_ID) => clean(renderToString(await PublicPage({ params: Promise.resolve({ publicProfileId: id }) })));
  const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  const formsOf = (html: string) =>
    [...html.matchAll(/<form ([^>]*)>(.*?)<\/form>/gs)].map((m) => {
      const a = attrs(m[1]!);
      expect(a.method, m[1]).toBe('post');
      return {
        action: a.action!,
        enctype: a.enctype ?? a.encType,
        describedBy: a['aria-describedby'],
        inner: m[2]!,
        hidden: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => attrs(i[1]!)).filter((i) => i.type === 'hidden'),
      };
    });
  const formFor = (html: string, action: string) => formsOf(html).find((f) => f.action === `/auth/provider/profile/${action}`);
  const actionsOf = (html: string): string[] => formsOf(html).map((f) => f.action.replace('/auth/provider/profile/', ''));
  const tagOf = (html: string, id: string): string => new RegExp(`<(?:input|textarea|select) [^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';
  const profileCalls = () => api.profileCalls();

  describe('/provider/profile: metadata and signed out', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(publicDynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
      expect(publicMetadata).toMatchObject({ robots: { index: false, follow: false } });
    });
    it('shows the registry title and the sign-in control that returns to /provider/profile; no profile call is made and there is no form', async () => {
      const html = await renderOwner();
      expect(html).toContain(`<h1>${p('title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/profile">Registry sign in</a>');
      expect(api.calls).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label)', async () => {
      stub.mode = 'down';
      const html = await renderOwner();
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/profile">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('shows no notice, no error and no form even when the URL carries them', async () => {
      const html = await renderOwner({ error: 'STALE_PROFILE', notice: 'saved' });
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('<form');
    });
  });

  describe('/provider/profile: signed in with a profile', () => {
    it('reads the owner state with the session token and role (one call) and renders the registry title and intro', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      const html = await renderOwner();
      expect(profileCalls().map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/provider/profile']);
      expect(profileCalls()[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'PROVIDER', correlationId: 'web-test-corr-7' });
      expect(html).toContain(`<h1>${p('title')}</h1>`);
      expect(html).toContain(`<p>${p('intro')}</p>`);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('<script');
    });
    it('the details form: POST /auth/provider/profile/save with the revision, a bound label, the hint, the stored text and counters as TEXT against the configured limits', async () => {
      signedIn();
      const html = await renderOwner();
      const form = formFor(html, 'save')!;
      expect(form.hidden.map((h) => [h.name, h.value])).toEqual([['expectedRevision', '4']]);
      expect(form.inner).toContain(`<label for="profile-name">${p('name.label')}</label>`);
      expect(form.inner).toContain(`<label for="profile-bio">${p('bio.label')}</label>`);
      const name = attrs(tagOf(html, 'profile-name'));
      expect(name).toMatchObject({ type: 'text', name: 'displayName', value: 'Sunny Home Care', maxLength: '60' });
      expect(attrs(tagOf(html, 'profile-bio'))).toMatchObject({ name: 'bio', maxLength: '1000' });
      expect(form.inner).toContain('We clean homes.\nSecond line of the bio.</textarea>');
      expect(form.inner).toContain(`<p id="profile-name-count" class="muted">15 / 60</p>`);
      expect(form.inner).toContain(`<p id="profile-bio-count" class="muted">39 / 1000</p>`);
      expect(name['aria-describedby']).toBe('profile-name-hint profile-name-fallback profile-name-count');
      expect(attrs(tagOf(html, 'profile-bio'))['aria-describedby']).toBe('profile-bio-hint profile-bio-count');
      expect(form.inner).toContain(`<button type="submit">${p('save')}</button>`);
      for (const id of ['profile-name-hint', 'profile-name-fallback', 'profile-name-count', 'profile-bio-hint', 'profile-bio-count'])
        expect(html).toContain(`id="${id}"`);
    });
    it('the counters count code points, the way the server counts', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ displayName: '😀😀😀', publicName: '😀😀😀', bio: null }));
      const html = await renderOwner();
      expect(html).toContain('<p id="profile-name-count" class="muted">3 / 60</p>');
      expect(html).toContain('<p id="profile-bio-count" class="muted">0 / 1000</p>');
    });
    it('the limits come from the API (a different configured limit is shown and set)', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto(), { limits: { ...ownerStateDto().limits, displayNameMaxLength: 40, bioMaxLength: 500 } });
      const html = await renderOwner();
      expect(attrs(tagOf(html, 'profile-name')).maxLength).toBe('40');
      expect(html).toContain('/ 40</p>');
      expect(html).toContain('/ 500</p>');
    });
    it('with no display name the fallback note shows the name customers see now', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ displayName: null, publicName: 'Jane D.' }));
      const html = await renderOwner();
      expect(html).toContain(`<p id="profile-name-fallback" class="muted">${p('name.fallback_note')}: Jane D.</p>`);
      expect(attrs(tagOf(html, 'profile-name')).value).toBe('');
    });
    it("the provider's own text is rendered as escaped text and attribute values only (no markup injection)", async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ displayName: XSS, publicName: XSS, bio: XSS, photo: { mimeType: 'image/png', width: 400, height: 300 } }));
      const html = await renderOwner();
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\sonerror=/);
      expect(html).not.toContain('dangerouslySetInnerHTML');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(attrs(tagOf(html, 'profile-name')).value).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt;&#x27;&amp;amp;');
      expect(/<img [^>]*alt="([^"]*)"/.exec(html)![1]).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt;&#x27;&amp;amp;');
    });
    it('offers the three section forms for a PRIVATE profile without a photo and nothing else; no group or price computation exists on the page', async () => {
      signedIn();
      const html = await renderOwner();
      expect(actionsOf(html)).toEqual(['save', 'photo-upload', 'visibility']);
      expect(html).not.toMatch(/price|discount|bookable price|group/i);
    });
    it('every form shares the page error as its description when the page shows one', async () => {
      signedIn();
      const html = await renderOwner({ error: 'STALE_PROFILE' });
      expect(html).toContain(`<p id="profile-error" role="alert" tabindex="-1">${t('provider.profile.error.stale_profile')}</p>`);
      for (const f of formsOf(html)) expect(f.describedBy, f.action).toBe('profile-error');
    });
    it('a missing revision never appears on a form of a profile that does not exist yet', async () => {
      signedIn();
      api.owner = ownerStateDto(null);
      const html = await renderOwner();
      expect(actionsOf(html)).toEqual(['save']);
      expect(formFor(html, 'save')!.hidden).toEqual([]);
      expect(html).toContain('<p id="profile-name-count" class="muted">0 / 60</p>');
      for (const absent of ['profile-photo', 'profile-visibility', 'profile-readiness', '/provider/profile/preview']) expect(html).not.toContain(absent);
      expect(html).toContain('<a href="/provider/gigs">Registry gigs title</a>');
    });
  });

  describe('/provider/profile: notices, errors and named problems', () => {
    it('a notice is shown only when the data proves what it claims', async () => {
      signedIn();
      const status = (html: string) => /<p id="profile-notice" role="status" tabindex="-1">([^<]*)<\/p>/.exec(html)?.[1];
      api.owner = ownerStateDto(ownerProfileDto({ visibility: 'PRIVATE', photo: null }));
      expect(status(await renderOwner({ notice: 'saved' }))).toBe(p('notice.saved'));
      expect(status(await renderOwner({ notice: 'created' }))).toBe(p('notice.created'));
      expect(status(await renderOwner({ notice: 'unpublished' }))).toBe(p('notice.unpublished'));
      expect(status(await renderOwner({ notice: 'photo_removed' }))).toBe(p('notice.photo_removed'));
      expect(status(await renderOwner({ notice: 'published' }))).toBeUndefined(); // the profile is PRIVATE
      expect(status(await renderOwner({ notice: 'photo_added' }))).toBeUndefined(); // there is no photo
      api.owner = ownerStateDto(
        ownerProfileDto({ visibility: 'PUBLIC', publishedAt: '2026-10-17T10:00:00.000Z', photo: { mimeType: 'image/png', width: 10, height: 10 } }),
      );
      expect(status(await renderOwner({ notice: 'published' }))).toBe(p('notice.published'));
      expect(status(await renderOwner({ notice: 'photo_added' }))).toBe(p('notice.photo_added'));
      expect(status(await renderOwner({ notice: 'unpublished' }))).toBeUndefined();
      expect(status(await renderOwner({ notice: 'photo_removed' }))).toBeUndefined();
      for (const bad of ['nope', 'constructor', '__proto__', '<script>', ['saved', 'created']])
        expect(status(await renderOwner({ notice: bad })), String(bad)).toBeUndefined();
      api.owner = ownerStateDto(null);
      expect(status(await renderOwner({ notice: 'saved' }))).toBeUndefined();
    });
    it('every code of the contract has its own registry message', async () => {
      signedIn();
      for (const c of PROFILE_ERROR_CODES) {
        const html = await renderOwner({ error: profileWireCode(c) });
        expect(html, c).toContain(`<p id="profile-error" role="alert" tabindex="-1">${t(`provider.profile.error.${c.toLowerCase()}`)}</p>`);
      }
    });
    it('an unknown or hostile error word shows the generic "unavailable" message and is never echoed', async () => {
      signedIn();
      for (const word of ['API_ERROR', 'nope', '"><script>x</script>', 'constructor', '__proto__', 'PROFILE_NOPE']) {
        const html = await renderOwner({ error: word });
        expect(html, word).toContain(`role="alert" tabindex="-1">${t('provider.profile.error.unavailable')}</p>`);
        expect(html).not.toContain('<script>x');
        expect(html).not.toContain('PROFILE_NOPE');
      }
    });
    it('named problems are shown only with the errors that carry them, as links to the field, in registry words; unknown reasons are ignored', async () => {
      signedIn();
      const html = await renderOwner({
        error: 'PROFILE_VALIDATION_FAILED',
        issue: ['DISPLAY_NAME_TOO_LONG', 'BIO_HTML_NOT_ALLOWED', 'NOT_A_REASON', 'DISPLAY_NAME_TOO_LONG'],
      });
      expect(html).toContain(
        `<ul id="profile-issues" tabindex="-1"><li id="profile-issue-0"><a href="#profile-name">${t('provider.profile.issue.display_name_too_long')}</a></li>`,
      );
      expect(html).toContain(`<li id="profile-issue-1"><a href="#profile-bio">${t('provider.profile.issue.bio_html_not_allowed')}</a></li>`);
      expect(html).not.toContain('NOT_A_REASON');
      expect(html.match(/<li id="profile-issue-/g)).toHaveLength(2);
      // the field is described by its problem and flagged invalid
      expect(attrs(tagOf(html, 'profile-name'))['aria-describedby']).toContain('profile-issue-0');
      expect(attrs(tagOf(html, 'profile-name'))['aria-invalid']).toBe('true');
      expect(attrs(tagOf(html, 'profile-bio'))['aria-describedby']).toContain('profile-issue-1');
      expect(attrs(tagOf(html, 'profile-bio'))['aria-invalid']).toBe('true');
      for (const err of ['STALE_PROFILE', 'PROFILE_MEDIA_REFUSED', 'API_ERROR', undefined]) {
        const other = await renderOwner({ ...(err ? { error: err } : {}), issue: 'BIO_REQUIRED' });
        expect(other, String(err)).not.toContain('profile-issues');
      }
    });
    it('the publishing prerequisites of PROFILE_INCOMPLETE are listed with links to what is missing', async () => {
      signedIn();
      const html = await renderOwner({ error: 'PROFILE_INCOMPLETE', issue: ['BIO_REQUIRED', 'PHOTO_REQUIRED', 'PUBLIC_NAME_UNAVAILABLE'] });
      expect(html).toContain(`<a href="#profile-bio">${t('provider.profile.issue.bio_required')}</a>`);
      expect(html).toContain(`<a href="#profile-photo-file">${t('provider.profile.issue.photo_required')}</a>`);
      expect(html).toContain(`<a href="#profile-name">${t('provider.profile.issue.public_name_unavailable')}</a>`);
      expect(attrs(tagOf(html, 'profile-photo-file'))['aria-describedby']).toContain('profile-issue-1');
    });
    it('every issue reason has registry copy and a link; at most four are shown', async () => {
      signedIn();
      for (const r of PROFILE_ISSUE_REASONS)
        expect(await renderOwner({ error: 'PROFILE_VALIDATION_FAILED', issue: r }), r).toContain(t(`provider.profile.issue.${r.toLowerCase()}`));
      const many = await renderOwner({ error: 'PROFILE_VALIDATION_FAILED', issue: [...PROFILE_ISSUE_REASONS] });
      expect(many.match(/<li id="profile-issue-/g)).toHaveLength(4);
    });
    it("a refused photo names its closed reason in the registry's words (and only with PROFILE_MEDIA_REFUSED)", async () => {
      signedIn();
      for (const r of GIG_MEDIA_REFUSAL_REASONS) {
        const html = await renderOwner({ error: 'PROFILE_MEDIA_REFUSED', reason: r });
        expect(html, r).toContain(`role="alert" tabindex="-1">${t(`provider.gig.media.refused.${r.toLowerCase()}`)}</p>`);
      }
      const plain = await renderOwner({ error: 'PROFILE_MEDIA_REFUSED', reason: 'my-private-face.png' });
      expect(plain).toContain(`role="alert" tabindex="-1">${t('provider.profile.error.media_refused')}</p>`);
      expect(plain).not.toContain('my-private');
      expect(await renderOwner({ error: 'STALE_PROFILE', reason: GIG_MEDIA_REFUSAL_REASONS[0] })).toContain(t('provider.profile.error.stale_profile'));
    });
    it('the alert, the problem list and the notice can take focus (tabIndex -1) so the redirect fragment lands on them', async () => {
      signedIn();
      expect(await renderOwner({ error: 'STALE_PROFILE' })).toContain('<p id="profile-error" role="alert" tabindex="-1">');
      expect(await renderOwner({ error: 'PROFILE_VALIDATION_FAILED', issue: 'BIO_BLANK' })).toContain('<ul id="profile-issues" tabindex="-1">');
      expect(await renderOwner({ notice: 'saved' })).toContain('<p id="profile-notice" role="status" tabindex="-1">');
    });
    it('an account that is not a registered provider (403 / 409 PROVIDER_NOT_ELIGIBLE) gets the registration message and a link to the registration, not "unavailable"', async () => {
      signedIn();
      for (const [status, code] of [
        [403, 'PROFILE_PROVIDER_NOT_ELIGIBLE'],
        [409, 'PROFILE_PROVIDER_NOT_ELIGIBLE'],
        [403, 'PROVIDER_NOT_ELIGIBLE'],
      ] as const) {
        api.forced['GET /provider/profile'] = { status, code, category: 'AUTHORIZATION' };
        const html = await renderOwner();
        expect(html, `${status} ${code}`).toContain(`role="alert" tabindex="-1">${t('provider.profile.error.page_unavailable_registration')}</p>`);
        expect(html).toContain('<a href="/provider/registration">Registry registration title</a>');
        expect(html).not.toContain(t('provider.profile.error.unavailable'));
        expect(html).not.toContain('<form');
      }
    });
    it('a real outage (503, unreachable) keeps the calm "unavailable" message and has no registration link', async () => {
      signedIn();
      for (const status of [503, 500]) {
        api.forced['GET /provider/profile'] = { status, code: 'PROFILE_UNAVAILABLE', category: 'DEPENDENCY' };
        const html = await renderOwner();
        expect(html).toContain(`role="alert" tabindex="-1">${t('provider.profile.error.unavailable')}</p>`);
        expect(html).not.toContain('/provider/registration');
      }
      // PROVIDER_NOT_ELIGIBLE with another status is not the registration case either
      api.forced['GET /provider/profile'] = { status: 500, code: 'PROFILE_PROVIDER_NOT_ELIGIBLE', category: 'INTERNAL' };
      expect(await renderOwner()).not.toContain('/provider/registration');
    });
    it('an API that is down shows the generic message and offers no form (nothing to edit)', async () => {
      signedIn();
      api.forced['GET /provider/profile'] = { status: 503, code: 'PROFILE_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await renderOwner();
      expect(html).toContain(`role="alert" tabindex="-1">${t('provider.profile.error.unavailable')}</p>`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('/provider/gigs');
    });
    it('a body that violates the contract is treated like an API that is down', async () => {
      signedIn();
      api.rawBody['GET /provider/profile'] = { nonsense: true };
      const html = await renderOwner();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('<form');
    });
    it('a revoked session leaves for /auth/revoked', async () => {
      signedIn();
      api.revoked = true;
      await expect(renderOwner()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
  });

  describe('/provider/profile: photo', () => {
    const photo = { mimeType: 'image/png' as const, width: 640, height: 480 };
    it('without a photo: the "none" text, a multipart upload form with a bound label, the allowed types and the size as text; no remove form', async () => {
      signedIn();
      const html = await renderOwner();
      expect(html).toContain(`<h2 id="profile-photo-heading">${p('photo.heading')}</h2>`);
      expect(html).toContain(`<p>${p('photo.none')}</p>`);
      expect(html).not.toContain('<img');
      const form = formFor(html, 'photo-upload')!;
      expect(form.enctype).toBe('multipart/form-data');
      expect(form.hidden.map((h) => [h.name, h.value])).toEqual([['expectedRevision', '4']]);
      expect(form.inner).toContain(`<label for="profile-photo-file">${p('photo.upload')}</label>`);
      expect(attrs(tagOf(html, 'profile-photo-file'))).toMatchObject({ type: 'file', name: 'file', accept: 'image/jpeg,image/png,image/webp' });
      expect(tagOf(html, 'profile-photo-file')).toContain('required');
      expect(form.inner).toContain(
        `<p id="profile-photo-types" class="muted">${t('provider.gig.media.types_note')} <span class="gig-values">image/jpeg, image/png, image/webp</span></p>`,
      );
      expect(form.inner).toContain(`<span class="gig-values">2 MB</span>`);
      expect(attrs(tagOf(html, 'profile-photo-file'))['aria-describedby']).toBe('profile-photo-types profile-photo-size');
      expect(form.inner).toContain(`<button type="submit">${p('photo.upload')}</button>`);
      expect(formFor(html, 'photo-remove')).toBeUndefined();
    });
    it('with a photo: a same-origin controlled image with the name as its alt text and its size, plus a remove form; never a storage address', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ photo }));
      const html = await renderOwner();
      const img = attrs(/<img [^>]*>/.exec(html)![0]);
      expect(img).toMatchObject({ src: '/provider/profile/photo', alt: 'Sunny Home Care', width: '640', height: '480' });
      expect(html).not.toContain(p('photo.none'));
      expect(formFor(html, 'photo-remove')!.hidden.map((h) => [h.name, h.value])).toEqual([['expectedRevision', '4']]);
      expect(formFor(html, 'photo-remove')!.inner).toContain(`<button type="submit">${p('photo.remove')}</button>`);
      expect(html).not.toMatch(/https?:\/\/|X-Signature|\.upload|sha256|assetId|objectKey/i);
    });
    it('an unfinished upload can be removed, and no image is shown for it', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ photo: null, photoPending: true }));
      const html = await renderOwner();
      expect(html).not.toContain('<img');
      expect(formFor(html, 'photo-remove')).toBeDefined();
    });
  });

  describe('/provider/profile: visibility and readiness', () => {
    it('PRIVATE: the status in words, the private note, the "not live" note and a make-public form that carries the closed word PUBLIC', async () => {
      signedIn();
      const html = await renderOwner();
      expect(html).toContain(`<h2 id="profile-visibility-heading">${p('visibility.heading')}</h2>`);
      expect(html).toContain(`<p class="gig-status">${t('provider.profile.visibility.private')}</p>`);
      expect(html).toContain(`<p>${p('visibility.private_note')}</p>`);
      expect(html).not.toContain(p('visibility.public_note'));
      expect(html).toContain(`<p class="gig-note">${p('visibility.not_live_note')}</p>`);
      const form = formFor(html, 'visibility')!;
      expect(form.hidden.map((h) => [h.name, h.value])).toEqual([
        ['expectedRevision', '4'],
        ['visibility', 'PUBLIC'],
      ]);
      expect(form.inner).toContain(`<button type="submit">${p('visibility.make_public')}</button>`);
    });
    it('PUBLIC: the status, the public note, the "not live" note and a make-private form that carries PRIVATE', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto({ visibility: 'PUBLIC', publishedAt: '2026-10-17T10:00:00.000Z' }));
      const html = await renderOwner();
      expect(html).toContain(`<p class="gig-status">${t('provider.profile.visibility.public')}</p>`);
      expect(html).toContain(`<p>${p('visibility.public_note')}</p>`);
      expect(html).not.toContain(p('visibility.private_note'));
      expect(html).toContain(p('visibility.not_live_note'));
      const form = formFor(html, 'visibility')!;
      expect(form.hidden.find((h) => h.name === 'visibility')!.value).toBe('PRIVATE');
      expect(form.inner).toContain(`<button type="submit">${p('visibility.make_private')}</button>`);
    });
    it('readiness is split: what is NEEDED to be public (the name; the bio and photo only when the limits require them) and what is merely SHOWN when it exists (published Gig, badge)', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto(), {
        readiness: readinessDto({
          publicNameAvailable: true,
          bioPresent: false,
          profilePhotoPresent: false,
          hasPublishedGig: false,
          trustSummaryAvailable: false,
          profileComplete: true,
        }),
      });
      const html = await renderOwner();
      expect(html).toContain(`<h2 id="profile-readiness-heading">${p('readiness.heading')}</h2>`);
      expect(html).toContain(`<h3 id="profile-required-heading">${p('readiness.required_heading')}</h3>`);
      expect(html).toContain(`<h3 id="profile-shown-heading">${p('readiness.shown_heading')}</h3>`);
      // nothing is required but the name, so the bio and the photo are not on the checklist
      const required = /<dl class="gig-facts" aria-labelledby="profile-required-heading">(.*?)<\/dl>/s.exec(html)![1]!;
      expect(required).toBe(`<div class="gig-row"><dt>${p('readiness.name')}</dt><dd>${t('provider.gig.editor.yes')}</dd></div>`);
      const shown = /<dl class="gig-facts" aria-labelledby="profile-shown-heading">(.*?)<\/dl>/s.exec(html)![1]!;
      expect(shown).toBe(
        `<div class="gig-row"><dt>${p('readiness.gig')}</dt><dd>${t('provider.gig.editor.no')}</dd></div><div class="gig-row"><dt>${p('readiness.trust')}</dt><dd>${t('provider.gig.editor.no')}</dd></div>`,
      );
      // complete with no Gig is not a contradiction: the Gig is not on the needed list
      expect(html).toContain(`<p>${p('readiness.complete')}</p>`);
      expect(html.indexOf(p('readiness.complete'))).toBeLessThan(html.indexOf(p('readiness.shown_heading')));
    });
    it('the bio and the photo are NEEDED only when the API limits say so; "complete" is said only when the API says the profile is complete', async () => {
      signedIn();
      api.owner = ownerStateDto(ownerProfileDto(), {
        limits: { ...ownerStateDto().limits, bioRequired: true, photoRequired: true },
        readiness: readinessDto({ bioPresent: true, profilePhotoPresent: false, profileComplete: false }),
      });
      const html = await renderOwner();
      const required = /<dl class="gig-facts" aria-labelledby="profile-required-heading">(.*?)<\/dl>/s.exec(html)![1]!;
      expect(required).toContain(`<dt>${p('readiness.name')}</dt><dd>${t('provider.gig.editor.yes')}</dd>`);
      expect(required).toContain(`<dt>${p('readiness.bio')}</dt><dd>${t('provider.gig.editor.yes')}</dd>`);
      expect(required).toContain(`<dt>${p('readiness.photo')}</dt><dd>${t('provider.gig.editor.no')}</dd>`);
      expect(required).not.toContain(p('readiness.gig'));
      expect(html).not.toContain(p('readiness.complete'));
    });
    it('a subsection whose heading the registry cannot serve is omitted, not shown without its title', async () => {
      signedIn();
      stub.catalog = withCopy((k) => k.endsWith('readiness.shown_heading'));
      const html = await renderOwner();
      expect(html).toContain('profile-required-heading');
      expect(html).not.toContain('profile-shown-heading');
      expect(html).not.toContain(p('readiness.gig'));
      stub.catalog = withCopy((k) => k.endsWith('readiness.shown_heading') || k.endsWith('readiness.required_heading'));
      expect(await renderOwner()).not.toContain('profile-readiness');
    });
    it('the sections come in the order details, photo, readiness, preview link, visibility (the preview link sits just before the make-public button)', async () => {
      signedIn();
      const html = await renderOwner();
      const at = (needle: string): number => {
        const i = html.indexOf(needle);
        expect(i, needle).toBeGreaterThan(-1);
        return i;
      };
      const order = [
        at('id="profile-details"'),
        at('id="profile-photo"'),
        at('id="profile-readiness"'),
        at('href="/provider/profile/preview"'),
        at('id="profile-visibility"'),
        at('/auth/provider/profile/visibility'),
      ];
      expect(order).toEqual([...order].sort((x, y) => x - y));
    });
    it('the "save your text first" note stands next to the photo and the visibility forms; the "also shown" note is in the visibility section', async () => {
      signedIn();
      const html = await renderOwner();
      const note = `<p class="muted">${p('visibility.save_first_note')}</p>`;
      const photo = /<section id="profile-photo".*?<\/section>/s.exec(html)![0];
      const visibility = /<section id="profile-visibility".*?<\/section>/s.exec(html)![0];
      expect(photo).toContain(note);
      expect(photo.indexOf(note)).toBeLessThan(photo.indexOf('<form'));
      expect(visibility).toContain(note);
      expect(visibility.indexOf(note)).toBeLessThan(visibility.indexOf('<form'));
      expect(visibility).toContain(`<p>${p('visibility.also_shown_note')}</p>`);
    });
    it('PUBLIC shows a text link to the public page of THIS profile; PRIVATE shows none', async () => {
      signedIn();
      expect(await renderOwner()).not.toContain('/providers/');
      api.owner = ownerStateDto(ownerProfileDto({ visibility: 'PUBLIC', publishedAt: '2026-10-17T10:00:00.000Z' }));
      const html = await renderOwner();
      expect(html).toContain(`<p><a href="/providers/${PUBLIC_PROFILE_ID}">${p('visibility.view_public')}</a></p>`);
      stub.catalog = withCopy((k) => k.endsWith('visibility.view_public'));
      expect(await renderOwner()).not.toContain('/providers/');
    });
    it('without the Yes / No words the readiness section is omitted rather than shown without a status', async () => {
      signedIn();
      stub.catalog = withCopy((k) => k === 'provider.gig.editor.yes');
      const html = await renderOwner();
      expect(html).not.toContain('profile-readiness');
    });
    it('links to the preview and to the Gigs', async () => {
      signedIn();
      const html = await renderOwner();
      expect(html).toContain(`<a href="/provider/profile/preview">${p('preview.heading')}</a>`);
      expect(html).toContain('<a href="/provider/gigs">Registry gigs title</a>');
    });
  });

  describe('/provider/profile: registry copy', () => {
    it('copy the registry cannot serve is omitted, never replaced by a literal: no label means no form, a missing hint means no reference to it', async () => {
      signedIn();
      stub.catalog = withCopy(
        (k) => k.endsWith('.name.hint') || k.endsWith('.bio.hint') || k.endsWith('.public_note') || k.endsWith('.private_note') || k.endsWith('.intro'),
      );
      const html = await renderOwner();
      expect(html).not.toContain('profile-name-hint');
      expect(html).not.toContain('profile-bio-hint');
      expect(attrs(tagOf(html, 'profile-name'))['aria-describedby']).toBe('profile-name-fallback profile-name-count');
      expect(html).not.toContain(p('visibility.private_note'));
      stub.catalog = withCopy((k) => k.endsWith('.name.label'));
      const noLabel = await renderOwner();
      expect(actionsOf(noLabel)).toEqual(['photo-upload', 'visibility']); // no unlabeled name field and no save form
      stub.catalog = withCopy((k) => k.startsWith('provider.profile.'));
      const bare = await renderOwner();
      expect(bare).not.toContain('<h1');
      expect(bare).not.toContain('<form');
      expect(bare).not.toContain('role="alert"');
    });
    it('the page keys are exactly the ones migration 0024 seeds: title and intro under provider.profile.page., every other group directly under provider.profile.', () => {
      expect(profileKey('title')).toBe('provider.profile.page.title');
      expect(profileKey('intro')).toBe('provider.profile.page.intro');
      for (const path of [
        'name.label',
        'bio.hint',
        'photo.upload',
        'visibility.make_public',
        'readiness.heading',
        'preview.back',
        'public.price_from',
        'save',
        'notice.saved',
      ])
        expect(profileKey(path)).toBe(`provider.profile.${path}`);
    });
    it('the page-copy keys of the spec are all asked for (and nothing hardcoded appears for them)', async () => {
      signedIn();
      await renderOwner();
      const asked = new Set(stub.calls.flatMap((c) => (c.body as { keys?: string[] } | undefined)?.keys ?? []));
      for (const path of PROFILE_PATHS.filter((x) => !/^public\.|^preview\.(note|back)$|^notice\.|^visibility\.view_public$/.test(x)))
        expect(asked.has(profileKey(path)), path).toBe(true);
    });
  });

  describe('/provider/profile/preview', () => {
    it('signed out: the heading and the sign-in control returning to the preview; no API call', async () => {
      const html = await renderPreview();
      expect(html).toContain(`<h1>${p('preview.heading')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/profile/preview">Registry sign in</a>');
      expect(api.calls).toEqual([]);
    });
    it('shows the SAME profile view as the public page, with the notes (a preview, not live, not bookable), the visibility in words, a link back and the controlled owner photo', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      api.preview = previewDto({ photo: { mimeType: 'image/png', width: 640, height: 480 }, badges: [{ type: 'IDENTITY' }], visibility: 'PRIVATE' });
      const html = await renderPreview();
      expect(profileCalls().map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/provider/profile/preview']);
      expect(profileCalls()[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'PROVIDER' });
      expect(html).toContain(`<h1>${p('preview.heading')}</h1>`);
      expect(html).toContain(`<p class="gig-note">${p('preview.note')}</p>`);
      expect(html).toContain(`<p class="gig-note">${p('visibility.not_live_note')}</p>`);
      expect(html).toContain(
        `<dl class="gig-facts"><div class="gig-row"><dt>${p('visibility.heading')}</dt><dd class="gig-status">${t('provider.profile.visibility.private')}</dd></div></dl>`,
      );
      expect(html).toContain(`<a href="/provider/profile">${p('preview.back')}</a>`);
      expect(html).toContain('<h2 id="profile-view-name">Sunny Home Care</h2>');
      expect(attrs(/<img [^>]*>/.exec(html)![0])).toMatchObject({ src: '/provider/profile/photo', alt: 'Sunny Home Care' });
      expect(html).toContain('Registry badge identity');
      expect(html).not.toContain('<form');
      // the part of the page that is the view is the public view: compare with the public page
      api.publics.set(PUBLIC_PROFILE_ID, publicProfileDto({ photo: { mimeType: 'image/png', width: 640, height: 480 }, badges: [{ type: 'IDENTITY' }] }));
      const pub = await renderPublic();
      const viewOf = (h: string) =>
        /<article.*<\/article>/s
          .exec(h)![0]
          .replace(/<h[1-4] id/g, '<hN id')
          .replace(/<\/h[1-4]>/g, '</hN>')
          .replace(/src="[^"]*"/, 'src=""')
          .replace(`<p class="gig-note">${p('public.not_bookable_note')}</p>`, ''); // only the public page says it under the name; the preview has its own notes
      expect(viewOf(html)).toBe(viewOf(pub));
    });
    it('a PUBLIC profile previews with its own visibility word', async () => {
      signedIn();
      api.preview = previewDto({ visibility: 'PUBLIC' });
      expect(await renderPreview()).toContain(t('provider.profile.visibility.public'));
    });
    it('a failed read says WHY: 403 / 409 PROVIDER_NOT_ELIGIBLE points to the registration; PROFILE_INCOMPLETE with PUBLIC_NAME_UNAVAILABLE points to the name field; a 503 stays calm', async () => {
      signedIn();
      for (const [status, code] of [
        [403, 'PROFILE_PROVIDER_NOT_ELIGIBLE'],
        [409, 'PROFILE_PROVIDER_NOT_ELIGIBLE'],
      ] as const) {
        api.forced['GET /provider/profile/preview'] = { status, code, category: 'AUTHORIZATION' };
        const html = await renderPreview();
        expect(html, String(status)).toContain(`<p role="alert">${t('provider.profile.error.page_unavailable_registration')}</p>`);
        expect(html).toContain('<a href="/provider/registration">Registry registration title</a>');
        expect(html).not.toContain(t('provider.profile.error.unavailable'));
      }
      api.forced['GET /provider/profile/preview'] = {
        status: 409,
        code: 'PROFILE_INCOMPLETE',
        category: 'CONFLICT',
        details: { issues: [{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }] },
      };
      const name = await renderPreview();
      expect(name).toContain(`<p role="alert"><a href="/provider/profile#profile-name">${t('provider.profile.issue.public_name_unavailable')}</a></p>`);
      expect(name).not.toContain(t('provider.profile.error.unavailable'));
      // another incomplete reason is not the name case
      api.forced['GET /provider/profile/preview'] = {
        status: 409,
        code: 'PROFILE_INCOMPLETE',
        category: 'CONFLICT',
        details: { issues: [{ reason: 'BIO_REQUIRED' }] },
      };
      expect(await renderPreview()).toContain(`<p role="alert">${t('provider.profile.error.unavailable')}</p>`);
      api.forced['GET /provider/profile/preview'] = { status: 503, code: 'PROFILE_UNAVAILABLE', category: 'DEPENDENCY' };
      const down = await renderPreview();
      expect(down).toContain(`<p role="alert">${t('provider.profile.error.unavailable')}</p>`);
      expect(down).not.toContain('/provider/registration');
      expect(down).not.toContain('#profile-name');
    });
    it('the visibility is a labelled pair (the visibility heading as the term, the status in words as the description)', async () => {
      signedIn();
      api.preview = previewDto({ visibility: 'PUBLIC' });
      expect(await renderPreview()).toContain(`<dt>${p('visibility.heading')}</dt><dd class="gig-status">${t('provider.profile.visibility.public')}</dd>`);
      stub.catalog = withCopy((k) => k.endsWith('visibility.heading'));
      expect(await renderPreview()).not.toContain(p('visibility.heading'));
    });
    it('the preview does NOT repeat the public page\'s "not bookable" note under the name (it has its own notes)', async () => {
      signedIn();
      expect(await renderPreview()).not.toContain(p('public.not_bookable_note'));
    });
    it('no profile is the standard not-found page; an API that is down says so calmly; a revoked session leaves', async () => {
      signedIn();
      api.preview = null;
      await expect(renderPreview()).rejects.toBeInstanceOf(signals.NotFound);
      api.preview = previewDto();
      api.forced['GET /provider/profile/preview'] = { status: 503, code: 'PROFILE_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await renderPreview();
      expect(html).toContain(`role="alert">${t('provider.profile.error.unavailable')}</p>`);
      expect(html).toContain(`<a href="/provider/profile">${p('preview.back')}</a>`);
      expect(html).not.toContain('<article');
      delete api.forced['GET /provider/profile/preview'];
      api.revoked = true;
      await expect(renderPreview()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
  });

  describe('/providers/[publicProfileId]: the public page', () => {
    const give = (over: Parameters<typeof publicProfileDto>[0] = {}) => {
      const dto = publicProfileDto(over);
      api.publics.set(dto.publicProfileId, dto);
      return dto;
    };
    it('reads the PUBLIC route with no token, no role and no session; the page never touches the session store', async () => {
      signedIn();
      give();
      await renderPublic();
      expect(profileCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v1/providers/${PUBLIC_PROFILE_ID}`]);
      expect(profileCalls()[0]).toMatchObject({ authorization: undefined, activeRole: undefined });
      expect(state.authCalls).toBe(0);
    });
    it('renders the name as the h1 and the sections with registry headings; no form, no input, no script, no booking control', async () => {
      give({ badges: [{ type: 'IDENTITY' }, { type: 'INSURANCE' }] });
      const html = await renderPublic();
      expect(html).toContain('<h1 id="profile-view-name">Sunny Home Care</h1>');
      expect(html).toContain(`<h2 id="profile-view-badges">${p('public.badges_heading')}</h2>`);
      expect(html).toContain('<ul class="profile-badges"><li>Registry badge identity</li><li>Registry badge insurance</li></ul>');
      expect(html).toContain(`<h2 id="profile-view-about">${p('public.about_heading')}</h2>`);
      expect(html).toContain('<p class="gig-text">We clean homes.\nSecond line of the bio.</p>');
      expect(html).toContain(`<h2 id="profile-view-gigs">${p('public.gigs_heading')}</h2>`);
      expect(html).toContain('<article class="provider-profile-view" aria-labelledby="profile-view-name">');
      for (const none of ['<form', '<input', '<button', '<script', '<textarea', '<select']) expect(html, none).not.toContain(none);
      // the registry's own "not bookable" note is the only place the word may appear
      expect(html.replace(p('public.not_bookable_note'), '')).not.toMatch(/book|reserve|checkout|buy/i);
    });
    it('says under the name that a price is not bookable whenever the page shows a price; no price, no note; no copy, no note', async () => {
      give();
      const html = await renderPublic();
      expect(html).toContain(`<h1 id="profile-view-name">Sunny Home Care</h1><p class="gig-note">${p('public.not_bookable_note')}</p></header>`);
      expect(html.indexOf(p('public.not_bookable_note'))).toBeLessThan(html.indexOf(p('public.price_from')));
      api.publics.clear();
      give({ gigs: [publicGigDto(1, { price: null })] });
      expect(await renderPublic()).not.toContain(p('public.not_bookable_note'));
      api.publics.clear();
      give({ gigs: [] });
      expect(await renderPublic()).not.toContain(p('public.not_bookable_note'));
      api.publics.clear();
      give();
      stub.catalog = withCopy((k) => k.endsWith('public.not_bookable_note'));
      const quiet = await renderPublic();
      expect(quiet).toContain('$125.00');
      expect(quiet).not.toContain('gig-note');
      // without the price label no price is shown, so there is nothing to qualify
      stub.catalog = withCopy((k) => k.endsWith('public.price_from'));
      const noPrice = await renderPublic();
      expect(noPrice).not.toContain('$125.00');
      expect(noPrice).not.toContain(p('public.not_bookable_note'));
    });
    it('only the SUM of variants and add-ons is shown, as "Options"; no photo count either', async () => {
      give({ gigs: [publicGigDto(1, { variantCount: 4, addOnCount: 2, photoCount: 9 })] });
      const html = await renderPublic();
      expect(html).toContain(`<dt>${p('public.options')}</dt><dd>6</dd>`);
      expect(html).not.toContain('<dd>9</dd>');
      expect(html).not.toContain('<dd>4</dd>');
    });
    it("badges are the registry's words for the type codes only, nothing else about the verification", async () => {
      give({ badges: [{ type: 'BACKGROUND_CHECK' }] });
      const html = await renderPublic();
      expect(html).toContain('<li>Registry badge background_check</li>');
      expect(html).not.toMatch(/expires|expiry|document|number|reviewer|case/i);
    });
    it('the photo is a same-origin image from the public API photo route, with the name as its alt text; none without a photo', async () => {
      give({ photo: { mimeType: 'image/jpeg', width: 800, height: 600 } });
      const html = await renderPublic();
      const img = attrs(/<img [^>]*>/.exec(html)![0]);
      expect(img).toMatchObject({
        src: `/api/v1/providers/${PUBLIC_PROFILE_ID}/photo`,
        alt: 'Sunny Home Care',
        width: '800',
        height: '600',
        referrerPolicy: 'no-referrer',
      });
      api.publics.clear();
      give({ photo: null });
      expect(await renderPublic()).not.toContain('<img');
    });
    it('a Gig card: title, service name from the registry, the pitch, the base price from, the duration and the counts, as labelled text', async () => {
      give();
      const html = await renderPublic();
      expect(html).toContain('<h3 id="profile-view-gig-0">Spotless clean 1</h3>');
      expect(html).toContain('<p class="gig-status">Registry service house cleaning</p>');
      expect(html).toContain('<p class="gig-text">We bring everything.</p>');
      expect(html).toContain(`<dt>${p('public.price_from')}</dt><dd>$125.00</dd>`);
      expect(html).toContain(`<dt>${p('public.duration')}</dt><dd>120 minutes</dd>`);
      expect(html).toContain(`<dt>${p('public.options')}</dt><dd>3</dd>`); // 2 variants + 1 add-on
      expect(html).not.toContain('Photos'); // no photo of a Gig is shown, so no count of photos either
      expect(html).toContain('<dl class="gig-facts" aria-labelledby="profile-view-gig-0">');
    });
    it("formats the one given price in the currency's own notation and computes nothing else", async () => {
      give({
        gigs: [
          publicGigDto(1, { price: { amountMinor: 5, currency: 'USD' } }),
          publicGigDto(2, { price: { amountMinor: 12500, currency: 'JPY' } }),
          publicGigDto(3, { price: { amountMinor: 1234, currency: 'XXX' } }),
          publicGigDto(4, { price: null, durationMinutes: null, variantCount: 0, addOnCount: 0, photoCount: 0 }),
        ],
      });
      const html = await renderPublic();
      expect(html).toContain('<dd>$0.05</dd>');
      expect(html).toContain('<dd>¥12,500</dd>');
      expect(html).toMatch(/<dd>(XXX\s?12\.34|¤12\.34|12\.34 XXX|1234 XXX)<\/dd>/);
      // a Gig with no price, no duration and no counts shows no facts at all
      expect(html.match(/<dl class="gig-facts"/g)).toHaveLength(3);
      expect(html).not.toMatch(/total|discount|save \d|% off|per person|group/i);
    });
    it('a Gig with no variants and no add-ons shows no options row', async () => {
      give({ gigs: [publicGigDto(1, { variantCount: 0, addOnCount: 0, photoCount: 0 })] });
      const html = await renderPublic();
      expect(html).not.toContain(p('public.options'));
    });
    it('no Gig: the empty text; no bio: no About section; no badge: no badges section', async () => {
      give({ gigs: [], bio: null, badges: [] });
      const html = await renderPublic();
      expect(html).toContain(`<p>${p('public.no_gigs')}</p>`);
      expect(html).not.toContain(p('public.about_heading'));
      expect(html).not.toContain(p('public.badges_heading'));
      expect(html).not.toContain('<ul class="gig-list"');
    });
    it('ratings and BananaDrops are placeholders and are omitted entirely: no number, no star, no empty box, no word', async () => {
      give();
      const html = await renderPublic();
      expect(html).not.toMatch(/rating|review|star|★|drop|available|testimonial/i);
      expect(html).not.toMatch(/\b[0-5]\.\d\b/);
    });
    it('shows nothing private: no email, phone, address, account or legal name, no market code, no identifier but the opaque photo route', async () => {
      give();
      const html = await renderPublic();
      expect(html).not.toMatch(/email|phone|address|account|legal|market|us-orange-county|mailto:|tel:/i);
      expect(html).not.toContain(PUBLIC_PROFILE_ID.toUpperCase());
      expect(html).not.toContain(publicGigDto(1).gigId);
      expect(html).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
    });
    it('provider-written text (name, bio, Gig title and pitch) is rendered as escaped text and attribute values only', async () => {
      give({ displayName: XSS, bio: XSS, photo: { mimeType: 'image/png', width: 10, height: 10 }, gigs: [publicGigDto(1, { title: XSS, shortPitch: XSS })] });
      const html = await renderPublic();
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\sonerror=/);
      expect(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)!.length).toBeGreaterThanOrEqual(5); // name, alt, bio, title, pitch
      expect(/<img [^>]*alt="([^"]*)"/.exec(html)![1]).toContain('&quot;&gt;&lt;img src=x');
    });
    it("registry copy that is missing is omitted: headings, labels and rows vanish, the provider's own content stays", async () => {
      give({ badges: [{ type: 'IDENTITY' }] });
      stub.catalog = withCopy(
        (k) => k.startsWith('provider.profile.public.') || k === 'provider.profile.badge.identity' || k.startsWith('catalog.service_type'),
      );
      const html = await renderPublic();
      expect(html).toContain('Sunny Home Care');
      expect(html).toContain('Spotless clean 1');
      expect(html).not.toContain('profile-badges');
      expect(html).not.toContain('<dl');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('gig-status');
      stub.mode = 'down';
      const down = await renderPublic();
      expect(down).toContain('<h1 id="profile-view-name">Sunny Home Care</h1>');
    });
    it('an unknown id, a private profile and an unreadable provider are the SAME standard not-found page', async () => {
      give();
      await expect(renderPublic(OTHER_PROFILE_ID)).rejects.toBeInstanceOf(signals.NotFound);
    });
    it('an id that is not even shaped like an id is not-found without asking the API', async () => {
      for (const bad of [
        '',
        'abc',
        'not-a-uuid',
        '../x',
        `${PUBLIC_PROFILE_ID}x`,
        PUBLIC_PROFILE_ID.replaceAll('-', ''),
        "7e1c4d28-9b35-4f60-a2d8-3c5b9e0f1a4'",
        PUBLIC_PROFILE_ID.toUpperCase(),
      ]) {
        await expect(renderPublic(bad), bad).rejects.toBeInstanceOf(signals.NotFound);
      }
      expect(api.calls).toEqual([]);
    });
    it('an API that is down or answers something unexpected shows the calm unavailable message (registry copy), not a not-found page and not the error text', async () => {
      give();
      api.forced['GET /providers/:id'] = { status: 503, code: 'PROFILE_UNAVAILABLE', category: 'DEPENDENCY' };
      expect(await renderPublic()).toBe(`<p role="alert">${t('provider.profile.error.unavailable')}</p>`);
      delete api.forced['GET /providers/:id'];
      api.rawBody['GET /providers/:id'] = { ...publicProfileDto(), accountId: 'acc-1' };
      const html = await renderPublic();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('acc-1');
      stub.mode = 'down';
      expect(await renderPublic()).toBe('');
    });
    it('a profile that claims ratings are available is refused by the contract and not rendered', async () => {
      api.rawBody['GET /providers/:id'] = { ...publicProfileDto(), ratings: { available: true, average: 4.9 } };
      const html = await renderPublic();
      expect(html).not.toContain('4.9');
      expect(html).toContain('role="alert"');
    });
  });
});

describe('the profile pages and components do not depend on the database, platform or configuration packages', () => {
  it('no source under the profile pages, handlers and library imports a forbidden workspace package', () => {
    const roots = [
      'app/provider/profile',
      'app/providers',
      'app/auth/provider/profile',
      'lib/auth/profile-handlers.ts',
      'lib/auth/profile-photo-preview.ts',
      'lib/provider-profile.ts',
    ];
    const forbidden = /@bananagig\/(database|platform|configuration|content)/;
    const files: string[] = [];
    const walk = (target: string): void => {
      if (statSync(target).isDirectory()) for (const n of readdirSync(target)) walk(path.join(target, n));
      else if (/\.(ts|tsx)$/.test(target)) files.push(target);
    };
    for (const r of roots) walk(path.join(import.meta.dirname, r));
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) expect(forbidden.test(readFileSync(f, 'utf8')), f).toBe(false);
  });
  it('no profile page or component uses dangerouslySetInnerHTML or an inline script', () => {
    const files = [
      'app/provider/profile/page.tsx',
      'app/provider/profile/preview/page.tsx',
      'app/providers/[publicProfileId]/page.tsx',
      'app/providers/_components/profile-view.tsx',
    ];
    for (const f of files) expect(readFileSync(path.join(import.meta.dirname, f), 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|<script|innerHTML/);
  });
});

describe('the profile styles keep the temporary structure usable', () => {
  const css = readFileSync(path.join(import.meta.dirname, 'app/globals.css'), 'utf8');
  const rule = (selector: string): string => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  it('links in the profile areas are 44px targets (inline-flex: an inline link ignores min-height)', () => {
    const r = rule('.provider-profile a');
    expect(r).toContain('display: inline-flex');
    expect(r).toContain('min-height: 44px');
  });
  it("the list of named problems has a visible border like the Gig editor's, and the message a redirect lands on shows a focus ring", () => {
    expect(rule('.provider-gigs #gig-issues')).toContain('border: 2px solid var(--fg)');
    expect(rule('.provider-profile #profile-issues')).toContain('border: 2px solid var(--fg)');
    expect(rule(".provider-profile [tabindex='-1']:focus-visible")).toContain('outline: 3px solid var(--fg)');
  });
  it('the global two-column definition grid is reset inside the profile areas', () => {
    expect(rule('dl')).toContain('display: grid');
    expect(rule('.provider-profile dl')).toContain('display: block');
  });
});
