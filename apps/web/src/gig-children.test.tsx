// CAT-004 web side, part 4: the variants, add-ons and photos on the server-rendered Gig pages: the draft editor sections (whole-set option forms with intent buttons, photos with rules,
// status text, controlled thumbnails and upload forms), the read-only version views, the GigMenu counts and the notices. The API is the Gig stub (contract-validated) mounted on the
// content stub. Every platform string is registry copy; the provider's own text is escaped; nothing rendered contains an object key, a signed URL or a hash.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';
import { GIG_MEDIA_REFUSAL_REASONS } from '@bananagig/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderGigsPage from './app/provider/gigs/page';
import ProviderGigPage from './app/provider/gigs/[gigId]/page';
import ProviderGigVersionPage from './app/provider/gigs/[gigId]/versions/[version]/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps } from './lib/auth/types';
import { startContentStub, type ContentStub, type StubCatalog } from './testing/content-stub';
import {
  GIG_COPY,
  GIG_ID,
  GIG_TEXT,
  attachGigApi,
  childSummary,
  detailDto,
  issueDto,
  mediaDto,
  mediaFieldDto,
  menuDto,
  menuItemDto,
  optionDto,
  publishedVersionDto,
  versionDto,
  type GigApiStub,
} from './testing/gig-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Error(`redirect ${target}`);
  },
  notFound: () => {
    throw new Error('not found');
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
const opt = (s: string): string => t(`provider.gig.options.${s}`);
const med = (s: string): string => t(`provider.gig.media.${s}`);
const menuT = (s: string): string => t(`provider.gig.menu.${s}`);
const FIELD_LABEL = 'Registry label photos';
const GALLERY_LABEL = 'Registry label gallery';
const EXTRA: Record<string, string> = {
  'catalog.gig_template.field.photos.label': FIELD_LABEL,
  'catalog.gig_template.field.gallery.label': GALLERY_LABEL,
};
const withCopy = (drop: (k: string) => boolean = () => false): StubCatalog => ({
  'en-US': {
    ...Object.fromEntries(Object.entries(GIG_COPY['en-US']!).filter(([k]) => !drop(k))),
    ...Object.fromEntries(Object.entries(EXTRA).map(([k, value]) => [k, { value }])),
  },
});
const GALLERY = mediaFieldDto({
  fieldKey: 'gallery',
  displayOrder: 21,
  required: false,
  behavior: 'PROVIDER_CONFIGURABLE',
  minItems: 0,
  maxItems: 2,
  labelContentKey: 'catalog.gig_template.field.gallery.label',
});
const OBJECT_KEY = 'provider/gig-media/0b5c7c40-2a6e-4f3b-8d1e-6a9f3c2b1d00';

describe('variants, add-ons and photos on the Gig pages', () => {
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
    store.sessions.clear();
    store.sessions.set('sid1', {
      subject: 'user-1',
      realmRoles: ['customer'],
      accessToken: TOKENS.access,
      refreshToken: TOKENS.refresh,
      idToken: TOKENS.id,
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Math.floor(Date.now() / 1000),
    });
    state.cookie = 'bg_session=sid1';
  });
  const clean = (html: string): string => html.replaceAll('<!-- -->', '');
  type Q = Record<string, string | string[] | undefined>;
  const renderGig = async (q: Q = {}) =>
    clean(renderToString(await ProviderGigPage({ params: Promise.resolve({ gigId: GIG_ID }), searchParams: Promise.resolve(q) })));
  const renderMenu = async () => clean(renderToString(await ProviderGigsPage({ searchParams: Promise.resolve({}) })));
  const renderVersion = async (version = '1') => clean(renderToString(await ProviderGigVersionPage({ params: Promise.resolve({ gigId: GIG_ID, version }) })));
  const give = (detail: ReturnType<typeof detailDto>) => {
    api.details.set(detail.gig.gigId, detail);
    for (const v of [detail.currentVersion, detail.draftVersion]) if (v) api.versions.set(`${detail.gig.gigId}/${v.versionNumber}`, v);
    return detail;
  };
  const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  const forms = (html: string) =>
    [...html.matchAll(/<form ([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => {
      const a = attrs(m[1]!);
      return {
        attrs: a,
        action: a.action!,
        inner: m[2]!,
        hidden: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => attrs(i[1]!)).filter((i) => i.type === 'hidden'),
        buttons: [...m[2]!.matchAll(/<button ([^>]*)>([\s\S]*?)<\/button>/g)].map((b): Record<string, string> => ({ ...attrs(b[1]!), text: b[2]! })),
      };
    });
  const formTo = (html: string, action: string) => forms(html).find((f) => f.action === `/auth/provider/gigs/${action}`);
  /** The whole `<section id=...>` element, nested sections included. */
  const section = (html: string, id: string): string => {
    const start = html.indexOf(`<section id="${id}"`);
    if (start < 0) return '';
    let depth = 0;
    for (const m of html.slice(start).matchAll(/<section[\s>]|<\/section>/g)) {
      depth += m[0] === '</section>' ? -1 : 1;
      if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
    }
    return html.slice(start);
  };

  /** A draft with a variant list, an add-on list and photos of two template fields. */
  const draftWith = (over: Parameters<typeof versionDto>[0] = {}) =>
    versionDto({
      revision: 7,
      fields: [mediaFieldDto(), GALLERY],
      variants: [optionDto(1, { name: 'Small <b>one</b>', description: 'Line one\nLine two' }), optionDto(2), optionDto(3)],
      addOns: [optionDto(4)],
      media: [
        mediaDto(1, { altText: 'A "bright" <i>kitchen</i>' }),
        mediaDto(2, { status: 'UPLOADING', mimeType: 'image/png', sizeBytes: 10, width: null, height: null }),
        mediaDto(3, { fieldKey: 'gallery', displayOrder: 3 }),
      ],
      ...over,
    });

  describe('the variants and add-ons forms', () => {
    it('are two POST forms to /auth/provider/gigs/variants and /add-ons with the Gig id and the CURRENT revision as their only hidden fields besides the row keys', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      const v = formTo(html, 'variants')!;
      const a = formTo(html, 'add-ons')!;
      expect(v.attrs.method).toBe('post');
      expect(a.attrs.method).toBe('post');
      expect(v.hidden.filter((h) => !h.name!.startsWith('row.'))).toEqual([
        { type: 'hidden', name: 'gigId', value: GIG_ID },
        { type: 'hidden', name: 'expectedRevision', value: '7' },
      ]);
      expect(v.hidden.filter((h) => h.name!.startsWith('row.')).map((h) => h.name)).toEqual(['row.0.key', 'row.1.key', 'row.2.key']);
      expect(a.hidden.filter((h) => h.name!.startsWith('row.')).map((h) => [h.name, h.value])).toEqual([['row.0.key', optionDto(4).key]]);
      for (const f of [v, a]) expect(f.hidden.map((h) => h.name).join()).not.toMatch(/account|status|currency|version|object/i);
    });
    it('headings, intros and the delta note come from the registry; the sections are anchors the issue list can link to', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      expect(html).toContain(`<h3 id="gig-variants-heading">${opt('variants.heading')}</h3>`);
      expect(html).toContain(`<h3 id="gig-add-ons-heading">${opt('add_ons.heading')}</h3>`);
      expect(html).toContain(opt('variants.intro'));
      expect(html).toContain(opt('add_ons.intro'));
      expect(html).toContain(`<p id="gig-variants-delta-note" class="muted">${opt('delta_note')}</p>`);
      expect(html).toContain(`${opt('limit_note')}: 3 / 10`);
      expect(html).toContain(`${opt('limit_note')}: 1 / 20`);
      expect(html).toMatch(/<section id="gig-variants" [^>]*tabindex="-1"/);
      expect(html).toMatch(/<section id="gig-add-ons" [^>]*tabindex="-1"/);
    });
    it('each row is a labelled fieldset: name, description, price delta and duration delta with their current values; provider text is escaped', async () => {
      give(detailDto({ draft: draftWith() }));
      const v = formTo(await renderGig(), 'variants')!;
      expect(v.inner).toContain('<legend id="gig-variants-0-legend">1: Small &lt;b&gt;one&lt;/b&gt;</legend>');
      expect(v.inner).not.toContain('<b>one</b>');
      expect(v.inner).toMatch(/<label for="gig-variants-0-name">Registry options name<\/label>/);
      expect(v.inner).toMatch(/<label for="gig-variants-0-description">Registry options description<\/label>/);
      expect(v.inner).toMatch(/<label for="gig-variants-0-price">Registry options price delta<\/label>/);
      expect(v.inner).toMatch(/<label for="gig-variants-0-duration">Registry options duration delta<\/label>/);
      expect(v.inner).toMatch(
        /<input type="text" id="gig-variants-0-name" name="row.0.name" value="Small &lt;b&gt;one&lt;\/b&gt;" maxLength="80"|<input [^>]*id="gig-variants-0-name"[^>]*name="row.0.name"/,
      );
      expect(v.inner).toMatch(/name="row\.0\.price"[^>]*value="500"/);
      expect(v.inner).toMatch(/name="row\.0\.duration"[^>]*value="15"/);
      expect(v.inner).toMatch(/<textarea [^>]*name="row\.0\.description"[^>]*>Line one\nLine two<\/textarea>/);
      expect(v.inner).toContain('aria-describedby="gig-variants-delta-note"');
    });
    it('the FIRST submit button is the hidden, unfocusable Save (Enter in a text box saves and never removes or moves a row)', async () => {
      give(detailDto({ draft: draftWith() }));
      const v = formTo(await renderGig(), 'variants')!;
      expect(v.buttons[0]).toMatchObject({ name: 'intent', value: 'save', tabindex: '-1', 'aria-hidden': 'true', class: 'gig-default-submit' });
      expect(v.buttons.at(-1)).toMatchObject({ name: 'intent', value: 'save', text: opt('save') });
      expect(v.buttons.at(-1)!.tabindex).toBeUndefined();
    });
    it('Remove, Move up and Move down are submit buttons with intents: no Move up on the first row, no Move down on the last', async () => {
      give(detailDto({ draft: draftWith() }));
      const v = formTo(await renderGig(), 'variants')!;
      const intents = v.buttons.filter((b) => b.name === 'intent' && b.tabindex === undefined).map((b) => b.value);
      expect(intents).toEqual(['down:0', 'remove:0', 'up:1', 'down:1', 'remove:1', 'up:2', 'remove:2', 'add', 'save']);
      expect(v.buttons.find((b) => b.value === 'down:0')!.text).toBe(opt('move_down'));
      expect(v.buttons.find((b) => b.value === 'up:1')!.text).toBe(opt('move_up'));
      expect(v.buttons.find((b) => b.value === 'remove:1')!.text).toBe(opt('remove'));
    });
    it('a trailing "new item" row is offered while the limit allows, with an Add button, no key and the next index', async () => {
      give(detailDto({ draft: draftWith() }));
      const v = formTo(await renderGig(), 'variants')!;
      expect(v.inner).toContain('name="row.3.name"');
      expect(v.inner).toContain('name="row.3.price"');
      expect(v.hidden.map((h) => h.name)).not.toContain('row.3.key');
      expect(v.buttons.find((b) => b.value === 'add')!.text).toBe(opt('add'));
    });
    it('at the configured maximum there is no new row; with a limit of zero or a template that does not allow them there is only the "not permitted" note', async () => {
      const full = draftWith();
      give(detailDto({ draft: { ...full, constraints: { ...full.constraints, variants: { ...full.constraints.variants, maxCount: 3 } } } }));
      const v = formTo(await renderGig(), 'variants')!;
      expect(v.inner).not.toContain('row.3.');
      expect(v.buttons.map((b) => b.value)).not.toContain('add');
      api.reset();
      const none = draftWith({ variants: [], addOns: [] });
      give(detailDto({ draft: { ...none, constraints: { ...none.constraints, variants: { ...none.constraints.variants, permitted: false } } } }));
      const html = await renderGig();
      expect(formTo(html, 'variants')).toBeUndefined();
      expect(section(html, 'gig-variants')).toContain(`<p>${opt('not_permitted')}</p>`);
      expect(formTo(html, 'add-ons')).toBeDefined();
      expect(section(html, 'gig-add-ons')).toContain(`<p>${opt('empty')}</p>`);
    });
    it('a draft that still holds items the template no longer permits shows the note AND the form (the provider can remove them)', async () => {
      const d = draftWith();
      give(detailDto({ draft: { ...d, constraints: { ...d.constraints, addOns: { ...d.constraints.addOns, permitted: false } } } }));
      const html = await renderGig();
      expect(section(html, 'gig-add-ons')).toContain(opt('not_permitted'));
      const a = formTo(html, 'add-ons')!;
      expect(a.buttons.map((b) => b.value)).toEqual(['save', 'remove:0', 'save']);
      expect(a.inner).not.toContain('row.1.');
    });
    it('a label missing from the registry is omitted: no name label or Save label = no form; a missing delta label keeps the VALUE in a hidden field', async () => {
      give(detailDto({ draft: draftWith() }));
      stub.catalog = withCopy((k) => k === 'provider.gig.options.price_delta');
      let v = formTo(await renderGig(), 'variants')!;
      expect(v.inner).not.toContain('for="gig-variants-0-price"');
      expect(v.hidden.find((h) => h.name === 'row.0.price')).toEqual({ type: 'hidden', name: 'row.0.price', value: '500' });
      stub.catalog = withCopy((k) => k === 'provider.gig.options.save');
      expect(formTo(await renderGig(), 'variants')).toBeUndefined();
      stub.catalog = withCopy((k) => k === 'provider.gig.options.name');
      expect(formTo(await renderGig(), 'variants')).toBeUndefined();
      stub.catalog = withCopy((k) => k === 'provider.gig.options.variants.heading');
      const html = await renderGig();
      expect(html).not.toContain('id="gig-variants"');
      expect(formTo(html, 'add-ons')).toBeDefined();
      stub.catalog = withCopy((k) => k === 'provider.gig.options.remove' || k === 'provider.gig.options.move_up');
      v = formTo(await renderGig(), 'variants')!;
      expect(v.buttons.map((b) => b.value)).toEqual(['save', 'down:0', 'down:1', 'add', 'save']);
    });
    it("issues about the list or one item are linked: the summary links to the section, the item's name input is described by (and invalid for) its issue", async () => {
      const first = optionDto(1);
      const issues = [
        issueDto({ target: 'variants', reason: 'OPTIONS_COUNT_EXCEEDED', messageKey: 'provider.gig.issue.options_count_exceeded' }),
        issueDto({ target: 'variants', itemKey: first.key, reason: 'OPTION_NAME_DUPLICATE', messageKey: 'provider.gig.issue.option_name_duplicate' }),
        issueDto({ target: 'addOns', reason: 'OPTIONS_NOT_PERMITTED', messageKey: 'provider.gig.issue.options_not_permitted' }),
      ];
      give(detailDto({ draft: draftWith({ variants: [first, optionDto(2)], publishable: false, issues }) }));
      const html = await renderGig();
      expect(html).toContain('<li id="gig-issue-0"><a href="#gig-variants">Registry issue options_count_exceeded</a></li>');
      expect(html).toContain('<li id="gig-issue-1"><a href="#gig-variants">Registry issue option_name_duplicate</a></li>');
      expect(html).toContain('<li id="gig-issue-2"><a href="#gig-add-ons">Registry issue options_not_permitted</a></li>');
      const v = formTo(html, 'variants')!;
      expect(v.attrs['aria-describedby']).toBe('gig-issue-0');
      expect(v.inner).toMatch(
        /id="gig-variants-0-name"[^>]*aria-describedby="gig-issue-1"[^>]*aria-invalid="true"|aria-describedby="gig-issue-1"[^>]*aria-invalid="true"[^>]*id="gig-variants-0-name"/,
      );
      expect(v.inner).not.toMatch(/id="gig-variants-1-name"[^>]*aria-invalid/);
      expect(formTo(html, 'add-ons')!.attrs['aria-describedby']).toBe('gig-issue-2');
    });
    it('nothing in the options markup carries script, markup from the provider or an inline handler', async () => {
      give(detailDto({ draft: draftWith({ variants: [optionDto(1, { name: '"><script>alert(1)</script>', description: '<img src=x onerror=alert(2)>' })] }) }));
      const html = await renderGig();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  describe('the Photos section', () => {
    it("lists each MEDIA field with its rule as TEXT and the count against the template's bounds", async () => {
      give(detailDto({ draft: draftWith() }));
      const s = section(await renderGig(), 'gig-photos');
      expect(s).toContain(`<h3 id="gig-photos-heading">${med('heading')}</h3>`);
      expect(s).toContain(med('intro'));
      expect(s).toContain(`<h4 id="gig-photos-photos-label">${FIELD_LABEL}</h4>`);
      expect(s).toContain(`<p id="gig-photos-photos-rule">${med('rule_required')}</p>`);
      expect(s).toContain(`${med('count')}: 2 (1–3)`);
      expect(s).toContain(`<h4 id="gig-photos-gallery-label">${GALLERY_LABEL}</h4>`);
      expect(s).toContain(`<p id="gig-photos-gallery-rule">${med('rule_optional')}</p>`);
      expect(s).toContain(`${med('count')}: 1 (0–2)`);
    });
    it('a prohibited field (maximum 0) says so and offers no upload; no MEDIA field at all says "no field"', async () => {
      give(detailDto({ draft: draftWith({ fields: [mediaFieldDto({ maxItems: 0, minItems: 0, required: false })], media: [] }) }));
      let html = await renderGig();
      expect(section(html, 'gig-photos')).toContain(med('rule_prohibited'));
      expect(formTo(html, 'photo-upload')).toBeUndefined();
      api.reset();
      give(detailDto({ draft: draftWith({ fields: [], media: [] }) }));
      html = await renderGig();
      expect(section(html, 'gig-photos')).toContain(`<p>${med('no_field')}</p>`);
      expect(html).not.toContain('photo-upload');
    });
    it('each photo shows its position and a TEXT status (Ready / Uploading) in a labelled group; only a READY photo has a thumbnail', async () => {
      give(detailDto({ draft: draftWith() }));
      const s = section(await renderGig(), 'gig-photos');
      const one = mediaDto(1).mediaId;
      const two = mediaDto(2).mediaId;
      expect(s).toContain(`<div role="group" aria-labelledby="gig-photo-${one}">`);
      // the caption names the photo: its position among the photos of its field, its status as text and its alt text (escaped)
      expect(s).toContain(
        `<p id="gig-photo-${one}"><strong>1 / 2</strong><span class="gig-status"> ${med('status_ready')}</span><span class="gig-text"> A &quot;bright&quot; &lt;i&gt;kitchen&lt;/i&gt;</span></p>`,
      );
      expect(s).toContain(`<p id="gig-photo-${two}"><strong>2 / 2</strong><span class="gig-status"> ${med('status_uploading')}</span></p>`);
      expect(s).toContain(`src="/provider/gigs/${GIG_ID}/media/${one}"`);
      expect(s).not.toContain(`src="/provider/gigs/${GIG_ID}/media/${two}"`);
      // the Preview link is named by its own text AND the caption of its photo, so the links of a list differ
      expect(s).toContain(
        `<a href="/provider/gigs/${GIG_ID}/media/${one}" id="gig-photo-${one}-preview" aria-labelledby="gig-photo-${one}-preview gig-photo-${one}">${med('preview')}</a>`,
      );
    });
    it("a thumbnail goes through the controlled same-origin route with the owner's alt text as an ESCAPED attribute; no object key, signed URL or hash is rendered", async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      expect(html).toContain('alt="A &quot;bright&quot; &lt;i&gt;kitchen&lt;/i&gt;"');
      expect(html).not.toContain('<i>kitchen</i>');
      expect(html).not.toMatch(/X-Signature|X-Amz|https?:\/\/(?!app\.localhost)[^"' ]+\/provider\/|sha256|objectKey|object_key|provider\/gig-media/);
      expect(html).not.toContain(OBJECT_KEY);
      expect(html).toMatch(/<img src="\/provider\/gigs\/[^"]+\/media\/[^"?]+" alt="[^"]*" loading="lazy" class="gig-thumb" width="800" height="600"\/>/);
    });
    it('every photo has an alt-text form, Remove, and Move up / Move down where there is a neighbour in the SAME field; an unfinished one has Finish', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      const one = mediaDto(1).mediaId;
      const two = mediaDto(2).mediaId;
      const alt = forms(html).find((f) => f.action === '/auth/provider/gigs/photo-alt' && f.hidden.some((h) => h.value === one))!;
      expect(alt.hidden).toEqual([
        { type: 'hidden', name: 'gigId', value: GIG_ID },
        { type: 'hidden', name: 'expectedRevision', value: '7' },
        { type: 'hidden', name: 'mediaId', value: one },
      ]);
      expect(alt.inner).toMatch(/<label for="gig-photo-[^"]+-alt">Registry media alt text<\/label>/);
      expect(alt.inner).toContain('value="A &quot;bright&quot; &lt;i&gt;kitchen&lt;/i&gt;"');
      expect(alt.inner).toContain('maxLength="200"');
      expect(alt.buttons).toEqual([
        { type: 'submit', id: `gig-photo-${one}-save-alt`, 'aria-labelledby': `gig-photo-${one}-save-alt gig-photo-${one}`, text: med('save_alt') },
      ]);
      const of = (action: string, id: string) =>
        forms(html).filter((f) => f.action === `/auth/provider/gigs/${action}` && f.hidden.some((h) => h.name === 'mediaId' && h.value === id));
      expect(of('photo-remove', one)).toHaveLength(1);
      expect(of('photo-finish', one)).toHaveLength(0);
      expect(of('photo-finish', two)).toHaveLength(1);
      // field `photos` holds photos 1 and 2 (3 is the gallery): the first has only Down, the second only Up, the gallery photo neither
      expect(of('photo-move', one).map((f) => f.hidden.at(-1)!.value)).toEqual(['down']);
      expect(of('photo-move', two).map((f) => f.hidden.at(-1)!.value)).toEqual(['up']);
      expect(of('photo-move', mediaDto(3).mediaId)).toHaveLength(0);
      expect(of('photo-move', one)[0]!.hidden.map((h) => h.name)).toEqual(['gigId', 'expectedRevision', 'mediaId', 'direction']);
    });
    it('the upload form is multipart, names the Gig in its action query, holds only the revision and the field key as hidden fields, and describes the file by the types and size notes', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      const ups = forms(html).filter((f) => f.action.startsWith('/auth/provider/gigs/photo-upload'));
      expect(ups.map((f) => f.action)).toEqual([`/auth/provider/gigs/photo-upload?gigId=${GIG_ID}`, `/auth/provider/gigs/photo-upload?gigId=${GIG_ID}`]);
      const up = ups[0]!;
      expect(up.attrs.method).toBe('post');
      expect(up.attrs.encType).toBe('multipart/form-data');
      expect(up.hidden).toEqual([
        { type: 'hidden', name: 'expectedRevision', value: '7' },
        { type: 'hidden', name: 'fieldKey', value: 'photos' },
      ]);
      expect(up.inner).toContain('<label for="gig-photos-photos-file">Registry media file</label>');
      const fileInput = attrs(/<input [^>]*type="file"[^>]*>/.exec(up.inner)![0]);
      expect(fileInput).toMatchObject({ name: 'file', accept: 'image/jpeg,image/png,image/webp', required: '' });
      expect(up.inner).toContain(`${med('types_note')}: image/jpeg, image/png, image/webp`);
      expect(up.inner).toContain(`${med('size_note')}: 10 MB`);
      expect(up.inner).toContain('aria-describedby="gig-photos-photos-types gig-photos-photos-size"');
      expect(up.inner).toMatch(/name="altText"/);
      expect(up.buttons).toEqual([{ type: 'submit', text: med('upload') }]);
      expect(ups[1]!.hidden[1]).toEqual({ type: 'hidden', name: 'fieldKey', value: 'gallery' });
    });
    it('no upload form once the field or the whole draft is full, or when the media settings do not permit uploads', async () => {
      const full = draftWith({ media: [mediaDto(1), mediaDto(2), mediaDto(3)] });
      give(detailDto({ draft: full }));
      let html = await renderGig();
      expect(
        forms(html)
          .filter((f) => f.action.startsWith('/auth/provider/gigs/photo-upload'))
          .map((f) => f.hidden[1]!.value),
      ).toEqual(['gallery']); // photos holds 3 of 3
      api.reset();
      give(detailDto({ draft: { ...full, constraints: { ...full.constraints, media: { ...full.constraints.media, maxItems: 3 } } } }));
      html = await renderGig();
      expect(html).not.toContain('photo-upload');
      api.reset();
      give(detailDto({ draft: { ...full, media: [], constraints: { ...full.constraints, media: { ...full.constraints.media, permitted: false } } } }));
      html = await renderGig();
      expect(html).not.toContain('photo-upload');
      expect(section(html, 'gig-photos')).toContain(`<p>${med('unavailable')}</p>`);
    });
    it('a label missing from the registry is omitted (no unlabelled file input, no label-less buttons)', async () => {
      give(detailDto({ draft: draftWith() }));
      stub.catalog = withCopy((k) => k === 'provider.gig.media.file');
      expect(await renderGig()).not.toContain('photo-upload');
      stub.catalog = withCopy((k) => k === 'provider.gig.media.remove' || k === 'provider.gig.media.finish');
      const html = await renderGig();
      expect(html).not.toContain('/auth/provider/gigs/photo-remove');
      expect(html).not.toContain('/auth/provider/gigs/photo-finish');
      stub.catalog = withCopy((k) => k === 'provider.gig.media.heading');
      expect(await renderGig()).not.toContain('gig-photos-heading');
    });
    it("media issues are linked to the section or the field; a field's upload form is described by its issues", async () => {
      const issues = [
        issueDto({ target: 'media', reason: 'MEDIA_REQUIRED', fieldKey: 'photos', messageKey: 'provider.gig.issue.media_required' }),
        issueDto({ target: 'media', reason: 'MEDIA_TOTAL_EXCEEDED', messageKey: 'provider.gig.issue.media_total_exceeded' }),
      ];
      give(detailDto({ draft: draftWith({ media: [], publishable: false, issues }) }));
      const html = await renderGig();
      expect(html).toContain('<li id="gig-issue-0"><a href="#gig-photos-photos">Registry issue media_required</a></li>');
      expect(html).toContain('<li id="gig-issue-1"><a href="#gig-photos">Registry issue media_total_exceeded</a></li>');
      expect(forms(html).find((f) => f.action.startsWith('/auth/provider/gigs/photo-upload'))!.attrs['aria-describedby']).toBe('gig-issue-0');
      expect(html).toMatch(/<section id="gig-photos" [^>]*aria-describedby="gig-issue-1"/);
    });
    it('every control is a plain form: the sections need no script and no drag-and-drop', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      expect(html).not.toMatch(/<script|draggable|ondrag|onclick|onchange|onsubmit/i);
    });
  });

  describe('notices and errors', () => {
    it('a CAT-004 notice is shown only when the data proves it, from the registry; an unknown word shows nothing', async () => {
      give(detailDto({ draft: draftWith() }));
      for (const [word, key] of [
        ['variants_saved', 'variants_saved'],
        ['add_ons_saved', 'add_ons_saved'],
        ['photo_added', 'photo_added'],
        ['photo_removed', 'photo_removed'],
        ['photo_order_saved', 'photo_order_saved'],
        ['photo_saved', 'photo_saved'],
      ]) {
        const html = await renderGig({ notice: word });
        expect(html, word).toContain(`<p role="status">${t(`provider.gig.notice.${key}`)}</p>`);
      }
      expect(await renderGig({ notice: 'photo_zapped' })).not.toContain('role="status"');
      api.reset();
      give(detailDto({ draft: draftWith({ media: [] }) }));
      expect(await renderGig({ notice: 'photo_added' })).not.toContain('role="status"'); // nothing was added, so nothing is claimed
      api.reset();
      give(detailDto({ current: publishedVersionDto(), draft: null }));
      expect(await renderGig({ notice: 'variants_saved' })).not.toContain('role="status"'); // no draft, no claim
    });
    it('the four media error words show their registry text; any other word the generic one', async () => {
      give(detailDto({ draft: draftWith() }));
      for (const code of ['MEDIA_NOT_FOUND', 'MEDIA_REFUSED', 'MEDIA_EXPIRED', 'MEDIA_SCAN_UNAVAILABLE']) {
        expect(await renderGig({ error: `GIG_${code}` }), code).toContain(`<p id="gig-error" role="alert">Registry gig error ${code.toLowerCase()}</p>`);
      }
      expect(await renderGig({ error: 'GIG_<script>' })).toContain('Registry gig error unavailable');
    });
  });

  describe('read-only views', () => {
    const published = (over: Parameters<typeof publishedVersionDto>[0] = {}) =>
      publishedVersionDto({
        versionNumber: 2,
        fields: [mediaFieldDto(), GALLERY],
        variants: [optionDto(1, { name: 'Small', description: 'Two\nlines' }), optionDto(2)],
        addOns: [optionDto(3)],
        media: [mediaDto(1, { altText: 'Front door' }), mediaDto(3, { fieldKey: 'gallery', displayOrder: 2 })],
        ...over,
      });
    it('the current version lists its variants, add-ons and photos (thumbnails through the route WITH the version); no form comes with them', async () => {
      give(detailDto({ current: published() }));
      const html = await renderGig();
      const cur = section(html, 'gig-current') || html.slice(html.indexOf('id="gig-current"'));
      expect(cur).toContain(`<h3 id="gig-v2-variants">${opt('variants.heading')}</h3>`);
      expect(cur).toContain(`<h3 id="gig-v2-add-ons">${opt('add_ons.heading')}</h3>`);
      expect(cur).toContain('<strong>Small</strong>');
      expect(cur).toContain(`<dt>${opt('price_delta')}</dt><dd>500 USD</dd>`);
      expect(cur).toContain(`<dt>${opt('duration_delta')}</dt><dd>15</dd>`);
      expect(cur).toContain(`<span class="gig-text">Two\nlines</span>`);
      expect(cur).toContain(`src="/provider/gigs/${GIG_ID}/media/${mediaDto(1).mediaId}?version=2"`);
      expect(cur).toContain(`<span class="gig-status"> ${med('status_ready')}</span>`);
      expect(cur).toContain('alt="Front door"');
      expect(cur).toContain(`<h4>${FIELD_LABEL}</h4>`);
      expect(cur).toContain(`<h4>${GALLERY_LABEL}</h4>`);
    });
    it("the version page shows the same lists with that version's number in the thumbnail route; it has no form at all", async () => {
      give(detailDto({ current: published({ versionNumber: 1 }), draft: null }));
      const html = await renderVersion('1');
      expect(html).toContain(`<h3 id="gig-v1-variants">${opt('variants.heading')}</h3>`);
      expect(html).toContain(`?version=1"`);
      expect(html).not.toContain('<form');
    });
    it('a version without variants, add-ons or photos shows none of those headings', async () => {
      give(detailDto({ current: publishedVersionDto() }));
      const html = await renderGig();
      expect(html).not.toContain(opt('variants.heading'));
      expect(html).not.toContain(opt('add_ons.heading'));
      expect(html).not.toContain(med('heading'));
    });
    it('provider text of the lists is escaped (names, descriptions and alt texts)', async () => {
      give(
        detailDto({
          current: published({
            variants: [optionDto(1, { name: '<script>alert(1)</script>', description: '<img src=x onerror=alert(2)>' })],
            media: [mediaDto(1, { altText: '"><svg onload=alert(3)>' })],
          }),
        }),
      );
      const html = await renderGig();
      expect(html).not.toMatch(/<script>alert|<img src=x|<svg onload/);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('alt="&quot;&gt;&lt;svg onload=alert(3)&gt;"');
    });
  });

  describe('accessible names, separators and the controls a template does not need', () => {
    const idsOf = (html: string): string[] => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    it('every photo control is named by its own text AND the caption of its photo ("Remove" + "2 / 3 Ready alt text"); every id on the page is unique', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig();
      const one = mediaDto(1).mediaId;
      const two = mediaDto(2).mediaId;
      const buttons = (id: string) => forms(html).flatMap((f) => f.buttons.filter((b) => b.id?.startsWith(`gig-photo-${id}-`)));
      expect(buttons(one).map((b) => [b.id, b['aria-labelledby']])).toEqual([
        [`gig-photo-${one}-save-alt`, `gig-photo-${one}-save-alt gig-photo-${one}`],
        [`gig-photo-${one}-down`, `gig-photo-${one}-down gig-photo-${one}`],
        [`gig-photo-${one}-remove`, `gig-photo-${one}-remove gig-photo-${one}`],
      ]);
      expect(buttons(two).map((b) => b.id?.replace(`gig-photo-${two}-`, ''))).toEqual(['save-alt', 'finish', 'up', 'remove']);
      expect(html).toContain(`<input type="text" id="gig-photo-${one}-alt"`);
      expect(html).toMatch(new RegExp(`id="gig-photo-${one}-alt"[^>]*aria-describedby="gig-photo-${one}-hint gig-photo-${one}"`));
      const ids = idsOf(html);
      expect(new Set(ids).size).toBe(ids.length);
    });
    it('the rows of the option forms are buttons named by their text AND the legend of their row', async () => {
      give(detailDto({ draft: draftWith() }));
      const v = formTo(await renderGig(), 'variants')!;
      const remove = v.buttons.find((b) => b.value === 'remove:1')!;
      expect(remove.id).toBe('gig-variants-1-remove');
      expect(remove['aria-labelledby']).toBe('gig-variants-1-remove gig-variants-1-legend');
      expect(v.buttons.find((b) => b.value === 'up:1')!['aria-labelledby']).toBe('gig-variants-1-up gig-variants-1-legend');
      expect(v.buttons.find((b) => b.value === 'down:1')!['aria-labelledby']).toBe('gig-variants-1-down gig-variants-1-legend');
    });
    it('the read-only photos are captioned "n / m" with status and alt text; the Preview links are named by the caption too', async () => {
      const cur = publishedVersionDto({
        versionNumber: 2,
        fields: [mediaFieldDto()],
        media: [mediaDto(1, { altText: 'Front door' }), mediaDto(2, { displayOrder: 2, altText: 'Back garden' })],
      });
      give(detailDto({ current: cur }));
      const html = await renderGig();
      const one = mediaDto(1).mediaId;
      expect(html).toContain(
        `<p id="gig-v2-photo-${one}"><strong>1 / 2</strong><span class="gig-status"> ${med('status_ready')}</span><span class="gig-text"> Front door</span></p>`,
      );
      expect(html).toContain(`id="gig-v2-photo-${one}-preview" aria-labelledby="gig-v2-photo-${one}-preview gig-v2-photo-${one}"`);
      expect(html).toContain('<strong>2 / 2</strong>');
      const ids = idsOf(html);
      expect(new Set(ids).size).toBe(ids.length);
    });
    it('a note that ends in its own punctuation is followed by its value on its own line; a note without it gets a colon', async () => {
      give(detailDto({ draft: draftWith() }));
      stub.catalog = {
        'en-US': {
          ...withCopy()['en-US']!,
          'provider.gig.options.limit_note': { value: 'The limit is shown next to this list.' },
          'provider.gig.media.types_note': { value: 'Accepted file types…' },
          'provider.gig.media.size_note': { value: 'Largest file:' },
          'provider.gig.media.count': { value: 'Photos' },
        },
      };
      const html = await renderGig();
      expect(html).toContain('The limit is shown next to this list. <span class="gig-values">3 / 10</span>');
      expect(html).not.toContain('list.: ');
      expect(html).toContain('Accepted file types… <span class="gig-values">image/jpeg, image/png, image/webp</span>');
      expect(html).toContain('Largest file: <span class="gig-values">10 MB</span>');
      expect(html).toContain('Photos: 2 (1–3)');
      expect(html).not.toContain('…. image');
      expect(html).not.toContain('::');
    });
    it('the file input is required and the upload form is NOT novalidate, so the browser stops a submit with no file', async () => {
      give(detailDto({ draft: draftWith() }));
      const up = forms(await renderGig()).find((f) => f.action.startsWith('/auth/provider/gigs/photo-upload'))!;
      expect(up.attrs).not.toHaveProperty('noValidate');
      expect(attrs(/<input [^>]*type="file"[^>]*>/.exec(up.inner)![0]).required).toBe('');
    });
    it('a template without duration offers no duration-delta control (the value is kept in a hidden field); with a duration it does', async () => {
      const d = draftWith();
      give(detailDto({ draft: { ...d, constraints: { ...d.constraints, duration: { ...d.constraints.duration, permitted: false } } } }));
      const v = formTo(await renderGig(), 'variants')!;
      expect(v.inner).not.toContain('Registry options duration delta');
      expect(v.inner).not.toMatch(/id="gig-variants-0-duration"/);
      expect(v.hidden.find((h) => h.name === 'row.0.duration')).toEqual({ type: 'hidden', name: 'row.0.duration', value: '15' });
      expect(v.hidden.find((h) => h.name === 'row.3.duration')).toEqual({ type: 'hidden', name: 'row.3.duration', value: '' });
      api.reset();
      give(detailDto({ draft: draftWith() }));
      expect(formTo(await renderGig(), 'variants')!.inner).toContain('for="gig-variants-0-duration"');
    });
  });

  describe('a named problem after a refused save', () => {
    const KEY = optionDto(2).key;
    const alertOf = (html: string): string => /<p id="gig-error" role="alert">(.*?)<\/p>/.exec(html)?.[1] ?? '';
    const issueQ = (over: Q = {}): Q => ({ error: 'GIG_VALIDATION_FAILED', issue: 'OPTION_NAME_DUPLICATE', target: 'variants', item: KEY, ...over });
    type Q = Record<string, string | string[] | undefined>;
    it('the alert says what failed AND which rule was broken (registry copy), the row is aria-invalid and described by the alert, the other rows are not', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig(issueQ());
      expect(alertOf(html)).toBe('Registry gig error validation_failed Registry issue option_name_duplicate');
      const v = formTo(html, 'variants')!;
      expect(v.inner).toMatch(/id="gig-variants-1-name"[^>]*aria-describedby="gig-error"[^>]*aria-invalid="true"/);
      expect(v.inner).not.toMatch(/id="gig-variants-0-name"[^>]*aria-invalid/);
      expect(formTo(html, 'add-ons')!.inner).not.toContain('gig-error');
    });
    it("a problem of a section without a known item describes the whole form; a photo problem marks that photo's alt text", async () => {
      give(detailDto({ draft: draftWith() }));
      let html = await renderGig(issueQ({ item: undefined, issue: 'OPTIONS_COUNT_EXCEEDED' }));
      expect(formTo(html, 'variants')!.attrs['aria-describedby']).toBe('gig-error');
      expect(alertOf(html)).toContain('Registry issue options_count_exceeded');
      const one = mediaDto(1).mediaId;
      html = await renderGig(issueQ({ issue: 'MEDIA_ALT_TOO_LONG', target: 'media', item: one }));
      expect(html).toMatch(new RegExp(`id="gig-photo-${one}-alt"[^>]*aria-describedby="[^"]*gig-error[^"]*"[^>]*aria-invalid="true"`));
      html = await renderGig(issueQ({ issue: 'MEDIA_ALT_TOO_LONG', target: 'media', item: undefined }));
      expect(html).toMatch(/<section id="gig-photos" [^>]*aria-describedby="gig-error"/);
      expect(forms(html).find((f) => f.action.startsWith('/auth/provider/gigs/photo-upload'))!.attrs['aria-describedby']).toBe('gig-error');
    });
    it('anything not on the closed lists is ignored: an unknown reason or target, an unsafe item, an issue without GIG_VALIDATION_FAILED, repeated words', async () => {
      give(detailDto({ draft: draftWith() }));
      for (const q of [
        issueQ({ issue: 'NOT_A_REASON' }),
        issueQ({ issue: '<script>' }),
        issueQ({ issue: 'option_name_duplicate' }),
        issueQ({ target: 'elsewhere' }),
        issueQ({ target: undefined }),
        issueQ({ issue: ['OPTION_NAME_DUPLICATE', 'OPTION_NAME_REQUIRED'] }),
      ]) {
        const html = await renderGig(q);
        expect(alertOf(html), JSON.stringify(q)).toBe('Registry gig error validation_failed');
        expect(html).not.toContain('aria-invalid="true"');
      }
      const unsafe = await renderGig(issueQ({ item: 'Zebra <b>' }));
      expect(alertOf(unsafe)).toContain('Registry issue option_name_duplicate');
      expect(unsafe).not.toContain('Zebra');
      expect(unsafe).not.toMatch(/id="gig-variants-1-name"[^>]*aria-invalid/);
      const other = await renderGig({ error: 'GIG_STALE_DRAFT', issue: 'OPTION_NAME_DUPLICATE', target: 'variants', item: KEY });
      expect(alertOf(other)).toBe('Registry gig error stale_draft');
    });
    it('the alert text comes only from the registry: the words of the URL are never printed', async () => {
      give(detailDto({ draft: draftWith() }));
      const html = await renderGig(issueQ({ item: 'zebra_item' }));
      expect(html).not.toContain('zebra_item');
      expect(html).not.toContain('OPTION_NAME_DUPLICATE');
    });
    it('a missing registry message for the reason leaves the generic message alone', async () => {
      give(detailDto({ draft: draftWith() }));
      stub.catalog = withCopy((k) => k === 'provider.gig.issue.option_name_duplicate');
      expect(alertOf(await renderGig(issueQ()))).toBe('Registry gig error validation_failed');
    });
  });

  describe('a refused photo and the visible echo inside the section', () => {
    const alertOf = (html: string): string => /<p id="gig-error" role="alert">(.*?)<\/p>/.exec(html)?.[1] ?? '';
    it('a closed refusal reason shows its own registry message; every contract reason has one in the stub', async () => {
      give(detailDto({ draft: draftWith() }));
      for (const reason of GIG_MEDIA_REFUSAL_REASONS) {
        expect(alertOf(await renderGig({ error: 'GIG_MEDIA_REFUSED', reason })), reason).toBe(`Registry photo refused ${reason.toLowerCase()}`);
      }
    });
    it('an unknown reason, a reason with another error word, or a missing registry key falls back to the generic refused message and prints no word of the URL', async () => {
      give(detailDto({ draft: draftWith() }));
      for (const reason of ['NOT_A_REASON', 'file_too_large', '<script>', 'Zebra']) {
        const html = await renderGig({ error: 'GIG_MEDIA_REFUSED', reason });
        expect(alertOf(html), reason).toBe('Registry gig error media_refused');
        expect(html).not.toMatch(/Zebra|<script>alert|NOT_A_REASON|file_too_large/);
      }
      expect(alertOf(await renderGig({ error: 'GIG_MEDIA_EXPIRED', reason: 'FILE_TOO_LARGE' }))).toBe('Registry gig error media_expired');
      expect(alertOf(await renderGig({ error: 'GIG_MEDIA_REFUSED', reason: ['FILE_TOO_LARGE', 'SIZE_MISMATCH'] }))).toBe('Registry gig error media_refused');
      stub.catalog = withCopy((k) => k === 'provider.gig.media.refused.file_too_large');
      expect(alertOf(await renderGig({ error: 'GIG_MEDIA_REFUSED', reason: 'FILE_TOO_LARGE' }))).toBe('Registry gig error media_refused');
    });
    it('the notice is repeated, visibly and hidden from assistive technology, inside the section it is about (and only there)', async () => {
      give(detailDto({ draft: draftWith() }));
      const echo = (text: string) => `<p class="gig-note" aria-hidden="true">${text}</p>`;
      let html = await renderGig({ notice: 'variants_saved' });
      expect(section(html, 'gig-variants')).toContain(echo(t('provider.gig.notice.variants_saved')));
      expect(section(html, 'gig-add-ons')).not.toContain('aria-hidden="true">Registry notice');
      expect(section(html, 'gig-photos')).not.toContain('aria-hidden="true">Registry notice');
      expect(html).toContain(`<p role="status">${t('provider.gig.notice.variants_saved')}</p>`);
      html = await renderGig({ notice: 'add_ons_saved' });
      expect(section(html, 'gig-add-ons')).toContain(echo(t('provider.gig.notice.add_ons_saved')));
      html = await renderGig({ notice: 'photo_removed' });
      expect(section(html, 'gig-photos')).toContain(echo(t('provider.gig.notice.photo_removed')));
      html = await renderGig({ notice: 'saved' });
      expect(html).not.toContain('class="gig-note" aria-hidden="true"');
    });
    it('an alert about photos or a named problem is repeated in its section too; an error about no particular section is not', async () => {
      give(detailDto({ draft: draftWith() }));
      let html = await renderGig({ error: 'GIG_MEDIA_REFUSED', reason: 'FILE_TOO_LARGE' });
      expect(section(html, 'gig-photos')).toContain('<p class="gig-note" aria-hidden="true">Registry photo refused file_too_large</p>');
      expect(section(html, 'gig-variants')).not.toContain('class="gig-note" aria-hidden="true"');
      html = await renderGig({ error: 'GIG_VALIDATION_FAILED', issue: 'OPTION_NAME_REQUIRED', target: 'addOns' });
      expect(section(html, 'gig-add-ons')).toContain(
        '<p class="gig-note" aria-hidden="true">Registry gig error validation_failed Registry issue option_name_required</p>',
      );
      html = await renderGig({ error: 'GIG_STALE_DRAFT' });
      expect(html).not.toContain('class="gig-note" aria-hidden="true"');
    });
  });

  describe('the GigMenu', () => {
    it("shows the counts of variants, add-ons and photos of the current version and the draft, from the API's facts", async () => {
      const d = detailDto({
        current: publishedVersionDto({ versionNumber: 2, children: childSummary({ variantCount: 2, addOnCount: 1, mediaCount: 4 }) }),
        draft: versionDto({ versionNumber: 3, children: childSummary({ variantCount: 5, addOnCount: 0, mediaCount: 1 }) }),
      });
      api.menu = menuDto([menuItemDto(d)]);
      const html = await renderMenu();
      const cur = html.slice(html.indexOf(`id="gig-counts-${GIG_ID}-current"`));
      expect(html).toContain(`id="gig-counts-${GIG_ID}-current"`);
      expect(html).toContain(`id="gig-counts-${GIG_ID}-draft"`);
      const rows = (id: string): string[] =>
        [...(new RegExp(`id="${id}"[^>]*>(.*?)</dl>`, 's').exec(html)?.[1] ?? '').matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((m) => `${m[1]}=${m[2]}`);
      expect(rows(`gig-counts-${GIG_ID}-current`)).toEqual([`${menuT('variants')}=2`, `${menuT('add_ons')}=1`, `${menuT('photos')}=4`]);
      expect(rows(`gig-counts-${GIG_ID}-draft`)).toEqual([`${menuT('variants')}=5`, `${menuT('add_ons')}=0`, `${menuT('photos')}=1`]);
      expect(cur.length).toBeGreaterThan(0);
    });
    it('says in text when the photo requirement is not met (and only then); the menu holds no thumbnail, no URL and no link to a photo', async () => {
      const unmet = detailDto({ draft: versionDto({ children: childSummary({ mediaCount: 0, mediaRequirementSatisfied: false }) }) });
      api.menu = menuDto([menuItemDto(unmet)]);
      let html = await renderMenu();
      expect(html).toContain(`<p class="gig-note">${menuT('photos_missing')}</p>`);
      expect(html).not.toMatch(/<img|\/media\/|X-Signature/);
      api.menu = menuDto([menuItemDto(detailDto({ draft: versionDto({ children: childSummary({ mediaCount: 2 }) }) }))]);
      html = await renderMenu();
      expect(html).not.toContain(menuT('photos_missing'));
    });
    it('a count label missing from the registry is omitted', async () => {
      api.menu = menuDto([menuItemDto(detailDto({ draft: versionDto({ children: childSummary({ variantCount: 1 }) }) }))]);
      stub.catalog = withCopy((k) => k === 'provider.gig.menu.add_ons');
      const html = await renderMenu();
      expect(html).toContain(`<dt>${menuT('variants')}</dt><dd>1</dd>`);
      expect(html).not.toContain(menuT('add_ons'));
    });
  });
});

describe('sources', () => {
  const read = (...p: string[]): string => readFileSync(path.join(import.meta.dirname, ...p), 'utf8');
  const css = read('app', 'globals.css');
  it('the upload and the thumbnail route never use fetch and never import a workspace package they must not', () => {
    for (const f of [
      ['lib', 'auth', 'gig-draft-handlers.ts'],
      ['lib', 'auth', 'gig-media-preview.ts'],
    ]) {
      const src = read(...f).replace(/\/\/.*$/gm, '');
      expect(src, f.join('/')).not.toMatch(/\bfetch\s*\(/);
      expect(src, f.join('/')).not.toMatch(/localStorage|sessionStorage|document\.cookie|process\.env|dangerouslySetInnerHTML/);
      expect(src, f.join('/')).not.toMatch(/@bananagig\/(database|platform|configuration|content|provider|catalog)['"/]/);
    }
    expect(read('lib', 'auth', 'gig-draft-handlers.ts')).toMatch(/from 'node:http'[\s\S]*from 'node:https'/);
  });
  it('the editor components render text through React only (no raw HTML, no style attribute)', () => {
    for (const f of ['options-editor.tsx', 'media-editor.tsx', 'version-view.tsx']) {
      const src = read('app', 'provider', 'gigs', '_components', f);
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|style=\{/);
    }
  });
  it('the default submit of an option form is visually hidden but the controls keep their 44px targets and focus rings', () => {
    expect(css).toMatch(/\.provider-gigs \.gig-default-submit\s*\{[^}]*position: absolute;[^}]*clip-path: inset\(50%\)/);
    expect(css).toMatch(/\.provider-registration :is\(a, button, select, input:not\(\[type='hidden'\]\)\)\s*\{\s*min-height: 44px;\s*min-width: 44px;/);
    expect(css).toMatch(/\.provider-registration :is\(a, button, select, input\):focus-visible/);
    expect(css).toMatch(/\.provider-gigs \.gig-thumb\s*\{[^}]*max-width: 10rem;[^}]*height: auto;/);
  });
});
