// TRUST-001 web side, part 3: the server component /provider/verification. The API is the verification stub (testing/verification-stub.ts, contract-validated) mounted on the
// content stub: the page reads the verification with the session's token and role, offers each form only when the data supports it (Submit ONLY when every requirement waiting
// for evidence has a draft document; Open ONLY when the prerequisite is met and something is required), shows every status the API derived, and every string comes from the
// registry copy (VERIFICATION_COPY, worded unlike the seeded copy). It offers no download of evidence and no control that approves anything, and renders no URL of an object.
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRUST_ERROR_CODES, TRUST_REQUIREMENT_STATUSES, type ProviderVerificationDto } from '@bananagig/contracts';
import ProviderVerificationPage, { dynamic, metadata } from './app/provider/verification/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { REGISTRY_COPY, startContentStub, type ContentStub } from './testing/content-stub';
import {
  UPLOAD_URL,
  VERIFICATION_COPY,
  VERIFICATION_DOCUMENT_ID,
  VERIFICATION_TEXT,
  attachVerificationApi,
  caseDto,
  documentDto,
  requirementDto,
  verificationDto,
  type VerificationApiStub,
} from './testing/verification-stub';

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
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-7', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' }; // secret-scan:allow (fake test fixtures)
const t = (suffix: string): string => VERIFICATION_TEXT[`trust.verification.page.${suffix}`] ?? `missing copy for ${suffix}`;
const ERROR_ID = 'verification-error';
const ACTION = '/auth/provider/verification/';

describe('provider verification page', () => {
  let stub: ContentStub;
  let api: VerificationApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(VERIFICATION_COPY);
    api = attachVerificationApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = VERIFICATION_COPY;
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
    renderToString(await ProviderVerificationPage({ searchParams: Promise.resolve(q) })).replaceAll('<!-- -->', '');
  const attrs = (tag: string): Record<string, string> =>
    Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
  interface FormInfo {
    action: string;
    method: string | undefined;
    enctype: string | undefined;
    describedBy: string | undefined;
    inner: string;
    inputs: Array<Record<string, string>>;
    buttons: string[];
  }
  const formsOf = (html: string): FormInfo[] =>
    [...html.matchAll(/<form ([^>]*)>(.*?)<\/form>/g)].map((m) => {
      const a = attrs(m[1]!);
      return {
        action: a.action!,
        method: a.method,
        enctype: a.enctype,
        describedBy: a['aria-describedby'],
        inner: m[2]!,
        inputs: [...m[2]!.matchAll(/<input ([^>]*)\/>/g)].map((i) => attrs(i[1]!)),
        buttons: [...m[2]!.matchAll(/<button type="submit">(.*?)<\/button>/g)].map((b) => b[1]!),
      };
    });
  const formsFor = (html: string, action: string): FormInfo[] => formsOf(html).filter((f) => f.action === `${ACTION}${action}`);
  const formFor = (html: string, action: string): FormInfo | undefined => formsFor(html, action)[0];
  const actionsOf = (html: string): string[] => formsOf(html).map((f) => f.action.replace(ACTION, ''));
  const textOf = (html: string): string =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const set = (over: Parameters<typeof verificationDto>[0]) => {
    api.verification = verificationDto(over);
  };
  const without = (...suffixes: string[]) => {
    const drop = new Set(suffixes.map((s) => `trust.verification.page.${s}`));
    stub.catalog = { 'en-US': Object.fromEntries(Object.entries(VERIFICATION_COPY['en-US']!).filter(([k]) => !drop.has(k))) };
  };
  const withoutKeys = (...keys: string[]) => {
    stub.catalog = { 'en-US': Object.fromEntries(Object.entries(VERIFICATION_COPY['en-US']!).filter(([k]) => !keys.includes(k))) };
  };
  /** A fully populated case: one requirement per interesting state, used by the "everything at once" checks. */
  const rich = (): ProviderVerificationDto =>
    verificationDto({
      case: caseDto({ status: 'ACTION_REQUIRED', revision: 41 }),
      requirements: [
        requirementDto({
          status: 'ACTION_REQUIRED',
          reasonCode: 'DOCUMENT_UNREADABLE',
          documents: [
            documentDto({ status: 'ATTACHED' }),
            documentDto({ verificationDocumentId: '1c2d3e4f-0000-4000-8000-000000000001', status: 'SUBMITTED', round: 1 }),
          ],
        }),
        requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', status: 'EXPIRED', expiresAt: '2026-12-31T23:59:59.000Z' }),
      ],
    });

  describe('page metadata', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
    });
  });

  describe('signed out', () => {
    it('shows the registry title and the sign-in control that returns to /provider/verification; no call to the verification API is made', async () => {
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/verification">Registry sign in</a>');
      expect(api.calls).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label) and nothing else is shown', async () => {
      stub.mode = 'down';
      const html = await render();
      expect(html).toContain('<a href="/auth/login?returnTo=/provider/verification">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('an unknown session cookie is signed out', async () => {
      state.cookie = 'bg_session=nope';
      expect(await render()).toContain('/auth/login?returnTo=/provider/verification');
      expect(api.calls).toEqual([]);
    });
    it('shows no notice, no error, no requirement and no form even when the URL carries them', async () => {
      const html = await render({ notice: 'submitted', error: 'TRUST_STALE_CASE' });
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('<form');
      expect(html).not.toContain(t('golive_note'));
    });
  });

  describe('signed in: what is read and how it is shown', () => {
    it('reads the verification once with the session token, the role and a correlation id, and shows the registry title, intro and overall status', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      const html = await render();
      const calls = api.verificationCalls();
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/provider/verification']);
      expect(calls[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'PROVIDER', correlationId: 'web-test-corr-7' });
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p>${t('intro')}</p>`);
      expect(html).toContain(`<p><strong>${t('status_label')}: </strong>${VERIFICATION_TEXT['trust.verification.status.not_started']}</p>`);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
    });
    it('sends no role without an active role in the session, and reads nothing but the verification (no mutation on render)', async () => {
      signedIn();
      await render();
      expect(api.verificationCalls()[0]!.activeRole).toBeUndefined();
      expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
      expect(api.calls).toHaveLength(1);
    });
    it('wraps everything in provider-registration, whose stylesheet rule gives links, buttons, selects and inputs a 44px target; the page uses no other control', async () => {
      signedIn();
      set({ prerequisiteMet: false });
      const html = await render();
      expect(html.startsWith('<div class="provider-registration">')).toBe(true);
      const css = readFileSync(new URL('./app/globals.css', import.meta.url), 'utf8');
      expect(css).toMatch(/\.provider-registration :is\(a, button, select, input:not\(\[type='hidden'\]\)\) \{\s*min-height: 44px;\s*min-width: 44px;/);
      signedIn();
      api.verification = rich();
      const full = await render();
      const tags = new Set([...full.matchAll(/<([a-z][a-z0-9]*)[\s>/]/g)].map((m) => m[1]));
      for (const interactive of ['textarea', 'a', 'details', 'summary', 'dialog', 'audio', 'video', 'iframe', 'object', 'embed', 'img', 'script'])
        expect(tags.has(interactive), interactive).toBe(false);
    });
    it('shows no overall status line when the registry lacks its words, and shows the status of the API, not a guess', async () => {
      signedIn();
      set({ case: caseDto({ status: 'IN_REVIEW' }), requirements: [requirementDto({ status: 'PENDING' })] });
      expect(await render()).toContain(`${VERIFICATION_TEXT['trust.verification.status.in_review']}</p>`);
      withoutKeys('trust.verification.status.in_review');
      const html = await render();
      expect(html).not.toContain('Registry overall');
      expect(html.slice(0, html.indexOf('<section'))).not.toContain('<strong>');
    });
    it('never shows a token, a refresh token, an id token, the case id or the case number', async () => {
      signedIn();
      api.verification = rich();
      const html = await render();
      for (const secret of [TOKENS.access, TOKENS.refresh, TOKENS.id, 'Bearer', 'verificationCaseId', '3f0d6a1e', 'caseRequirementId', '5d2b8f47'])
        expect(html).not.toContain(secret);
    });
  });

  describe('the API is unavailable or lies', () => {
    it('with the verification unreadable the page says it could not be done (generic copy in an alert), offers no form and no Go-Live note', async () => {
      signedIn();
      api.forced['GET /provider/verification'] = { status: 503, code: 'TRUST_UNAVAILABLE', category: 'DEPENDENCY' };
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain(`<p id="${ERROR_ID}" role="alert">${VERIFICATION_TEXT['trust.verification.error.unavailable']}</p>`);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<li>');
      expect(html).not.toContain(t('golive_note'));
      expect(html).not.toContain('TRUST_UNAVAILABLE');
    });
    it('a 403, a 404 or a 409 of the API is "unavailable" too, never its code', async () => {
      signedIn();
      for (const status of [403, 404, 409, 500]) {
        api.forced['GET /provider/verification'] = { status, code: 'TRUST_NOT_FOUND', category: 'AUTHORIZATION' };
        const html = await render();
        expect(html, String(status)).toContain(VERIFICATION_TEXT['trust.verification.error.unavailable']);
        expect(html).not.toContain('NOT_FOUND');
        expect(html).not.toContain(VERIFICATION_TEXT['trust.verification.error.not_found']);
      }
    });
    it('a response that violates the contract is "unavailable", not a crash: unknown status, Go-Live claimed, missing field', async () => {
      signedIn();
      const good = verificationDto();
      for (const bad of [
        { ...good, goLive: { evaluated: true, eligible: true } },
        { ...good, overall: { ...good.overall, status: 'VERIFIED' } },
        { ...good, requirements: [{ ...good.requirements[0], status: 'APPROVED_ISH' }] },
        { prerequisiteMet: true },
        { nonsense: true },
      ]) {
        api.rawBody['GET /provider/verification'] = bad;
        const html = await render();
        expect(html).toContain('role="alert"');
        expect(html).not.toContain('<form');
      }
    });
    it('with the registry copy down the page renders without text and without crashing', async () => {
      signedIn();
      api.verification = rich();
      stub.mode = 'down';
      const html = await render();
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<button');
    });
    it('a revoked session goes to /auth/revoked (a page cannot clear a cookie) before anything is rendered', async () => {
      signedIn();
      api.revoked = true;
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
    it('a 401 SESSION_REVOKED on the read is the same', async () => {
      signedIn();
      api.forced['GET /provider/verification'] = { status: 401, code: 'SESSION_REVOKED', category: 'AUTHENTICATION' };
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
    it('a 401 that is not a revocation is "unavailable"', async () => {
      signedIn();
      api.forced['GET /provider/verification'] = { status: 401, code: 'AUTHENTICATION_REQUIRED', category: 'AUTHENTICATION' };
      const html = await render();
      expect(html).toContain('role="alert"');
    });
  });

  describe('the prerequisite hint and the open form', () => {
    it('prerequisite not met: a link to /provider/registration with the registry hint, and NO open form', async () => {
      signedIn();
      set({ prerequisiteMet: false });
      const html = await render();
      expect(html).toContain(`<p><a href="/provider/registration">${t('prerequisite_hint')}</a></p>`);
      expect(actionsOf(html)).not.toContain('open');
      expect(html).not.toContain(t('open_action'));
    });
    it('prerequisite met: no hint', async () => {
      signedIn();
      set({ prerequisiteMet: true });
      const html = await render();
      expect(html).not.toContain(t('prerequisite_hint'));
      expect(html).not.toContain('/provider/registration');
    });
    it('offers the open form when the prerequisite is met, there is no case and something is required: a POST with no field but the button', async () => {
      signedIn();
      set({});
      const html = await render();
      const form = formFor(html, 'open')!;
      expect(form).toBeDefined();
      expect(form.method).toBe('post');
      expect(form.inputs).toEqual([]);
      expect(form.buttons).toEqual([t('open_action')]);
      expect(form.describedBy).toBeUndefined();
      expect(formsFor(html, 'open')).toHaveLength(1);
    });
    it('offers NO open form when nothing is required (requiredCount 0), even with the prerequisite met and no case', async () => {
      signedIn();
      set({ requiredCount: 0 });
      expect(actionsOf(await render())).not.toContain('open');
      set({ requirements: [] });
      const html = await render();
      expect(actionsOf(html)).toEqual([]);
      expect(html).toContain(`<p>${t('empty_requirements')}</p>`);
    });
    it('offers NO open form once a case exists (the case is opened; the same form would only resume it)', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      expect(actionsOf(await render())).not.toContain('open');
    });
    it('offers NO open form when the prerequisite is not met even though something is required', async () => {
      signedIn();
      set({ prerequisiteMet: false, requiredCount: 3 });
      expect(actionsOf(await render())).not.toContain('open');
    });
    it('the open form and the hint are omitted (never replaced by a literal) when the registry lacks their words', async () => {
      signedIn();
      set({});
      without('open_action');
      expect(actionsOf(await render())).not.toContain('open');
      without('prerequisite_hint');
      set({ prerequisiteMet: false });
      const html = await render();
      expect(html).not.toContain('<a ');
    });
  });

  describe('the requirement list', () => {
    it('lists the requirements in the order of the API with name, instructions and status from THEIR content keys', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({ requirementCode: 'identity_verification', status: 'PENDING', canAttachEvidence: false }),
          requirementDto({ requirementCode: 'background_check', requirementType: 'BACKGROUND_CHECK', evidenceKind: 'EXTERNAL', status: 'IN_REVIEW' }),
          requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', status: 'APPROVED', canAttachEvidence: false }),
        ],
      });
      const html = await render();
      expect(html).toContain(`<h2 id="verification-requirements">${t('requirements_heading')}</h2>`);
      expect([...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1])).toEqual([
        'Registry check identity_verification',
        'Registry check background_check',
        'Registry check professional_license',
      ]);
      for (const [code, status] of [
        ['identity_verification', 'pending'],
        ['background_check', 'in_review'],
        ['professional_license', 'approved'],
      ] as const) {
        expect(html).toContain(
          `<h3>Registry check ${code}</h3><p>Registry how to ${code}</p><p><strong>${t('status_label')}: </strong>Registry check state ${status}</p>`,
        );
      }
    });
    it('every word comes from the key the API sent, not from the code or the status: a different nameKey, instructionsKey and statusKey shows THAT copy', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            requirementCode: 'identity_verification',
            status: 'APPROVED',
            canAttachEvidence: false,
            nameKey: 'trust.requirement.custom_check.name',
            instructionsKey: 'trust.requirement.liability_insurance.instructions',
            statusKey: 'trust.verification.requirement_status.expired',
          }),
        ],
      });
      const html = await render();
      expect(html).toContain('<h3>Registry check custom_check</h3>');
      expect(html).toContain('<p>Registry how to liability_insurance</p>');
      expect(html).toContain('Registry check state expired');
      expect(html).not.toContain('Registry check identity_verification');
      expect(html).not.toContain('Registry check state approved');
    });
    it.each(TRUST_REQUIREMENT_STATUSES)('shows the registry word of the %s status', async (status) => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status })] });
      expect(await render()).toContain(`Registry check state ${status.toLowerCase()}`);
    });
    it('with no requirement the empty copy is shown instead of the list and its heading', async () => {
      signedIn();
      set({ requirements: [] });
      const html = await render();
      expect(html).toContain(`<p>${t('empty_requirements')}</p>`);
      expect(html).not.toContain('verification-requirements');
      expect(html).not.toContain('<h3');
    });
    it('a requirement whose name or instructions the registry lacks keeps its status but shows no invented heading or text', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false })] });
      withoutKeys('trust.requirement.identity_verification.name', 'trust.requirement.identity_verification.instructions');
      const html = await render();
      expect(html).not.toContain('<h3');
      expect(html).toContain('Registry check state pending');
      expect(html).not.toContain('identity_verification</');
      expect(html).not.toContain('Registry how to');
    });
    it('escapes registry text (markup in a name or status is text, never markup)', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false })] });
      stub.catalog = {
        'en-US': {
          ...VERIFICATION_COPY['en-US']!,
          'trust.requirement.identity_verification.name': { value: '<script>alert(1)</script> & <img src=x onerror=alert(2)>' },
        },
      };
      const html = await render();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(2)&gt;');
    });
    it('the valid-until date of an approval is shown as an unambiguous UTC day after the registry word, and only when there is one', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'APPROVED' }),
        requirements: [
          requirementDto({ status: 'APPROVED', canAttachEvidence: false, expiresAt: '2027-03-09T10:00:00.000Z' }),
          requirementDto({
            requirementCode: 'professional_license',
            requirementType: 'LICENSE',
            status: 'APPROVED',
            canAttachEvidence: false,
            expiresAt: null,
          }),
          requirementDto({
            requirementCode: 'liability_insurance',
            requirementType: 'INSURANCE',
            status: 'APPROVED',
            canAttachEvidence: false,
            expiresAt: '2026-12-31T23:30:00-05:00',
          }),
        ],
      });
      const html = await render();
      expect(html).toContain(`Registry check state approved (${t('valid_until_label')} 2027-03-09)</p>`);
      expect(html).toContain(`Registry check state approved (${t('valid_until_label')} 2027-01-01)</p>`);
      expect(html.match(/good through/g)).toHaveLength(2);
      expect(html).toContain('Registry check state approved</p>');
    });
    it('without the valid-until word of the registry the date is omitted too (no literal stands in for it)', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'APPROVED', canAttachEvidence: false, expiresAt: '2027-03-09T10:00:00.000Z' })] });
      without('valid_until_label');
      const html = await render();
      expect(html).not.toContain('2027-03-09');
      expect(html).toContain('Registry check state approved</p>');
    });
    it('the reviewer reason is a note (with its label) for ACTION_REQUIRED and REJECTED, from the reason key of the API', async () => {
      signedIn();
      for (const status of ['ACTION_REQUIRED', 'REJECTED'] as const) {
        set({ case: caseDto(), requirements: [requirementDto({ status, reasonCode: 'NAME_MISMATCH' })] });
        const html = await render();
        expect(html, status).toContain(`<p role="note"><strong>${t('reason_label')}: </strong>Registry because name_mismatch</p>`);
        expect(html.match(/role="note"/g)).toHaveLength(1);
      }
    });
    it('the reason shows the text of the reasonKey, not of the reasonCode', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [requirementDto({ status: 'REJECTED', reasonCode: 'NAME_MISMATCH', reasonKey: 'trust.reason.insurance_expired.name' })],
      });
      const html = await render();
      expect(html).toContain('Registry because insurance_expired');
      expect(html).not.toContain('Registry because name_mismatch');
    });
    it('no note without a reason: statuses that carry none show no note', async () => {
      signedIn();
      set({ case: caseDto(), requirements: TRUST_REQUIREMENT_STATUSES.map((status) => requirementDto({ status, requirementCode: 'identity_verification' })) });
      const html = await render();
      expect(html).not.toContain('role="note"');
      expect(html).not.toContain('Registry because');
    });
    it('a reason the registry cannot word shows no note at all; without the label the note has no label', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'ACTION_REQUIRED', reasonCode: 'LICENSE_INVALID' })] });
      withoutKeys('trust.reason.license_invalid.name');
      expect(await render()).not.toContain('role="note"');
      stub.catalog = VERIFICATION_COPY;
      without('reason_label');
      const html = await render();
      expect(html).toContain('<p role="note">Registry because license_invalid</p>');
    });
  });

  describe('the upload form', () => {
    const open = () => set({ case: caseDto(), requirements: [requirementDto({ status: 'NOT_STARTED' })] });
    it('is a multipart POST to the upload action with the requirement code as its only hidden field', async () => {
      signedIn();
      open();
      const html = await render();
      const form = formFor(html, 'upload')!;
      expect(form).toBeDefined();
      expect(form.method).toBe('post');
      expect(form.enctype).toBe('multipart/form-data');
      expect(form.inputs.filter((i) => i.type === 'hidden')).toEqual([{ type: 'hidden', name: 'requirementCode', value: 'identity_verification' }]);
      expect(form.inputs.filter((i) => i.type !== 'hidden' && i.type !== 'file')).toEqual([]);
      expect(form.buttons).toEqual([t('upload_action')]);
      expect(form.inner).toContain(`<h4>${t('upload_heading')}</h4>`);
    });
    it('has a labelled select of the document types of the DTO, in order, with the registry names, required', async () => {
      signedIn();
      open();
      const form = formFor(await render(), 'upload')!;
      expect(form.inner).toContain('<label for="type-identity_verification">' + t('document_type_label') + '</label>');
      const select = form.inner.match(/<select ([^>]*)>(.*?)<\/select>/)!;
      expect(attrs(select[1]!)).toMatchObject({ id: 'type-identity_verification', name: 'documentTypeCode' });
      expect(select[1]).toContain('required');
      expect([...select[2]!.matchAll(/<option value="([^"]*)">(.*?)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
        ['drivers_license', 'Registry paper drivers_license'],
        ['state_id', 'Registry paper state_id'],
        ['passport', 'Registry paper passport'],
      ]);
      expect(select[2]).not.toContain('selected');
    });
    it('the document types are those of THIS requirement, not a fixed list: another set shows another select', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            requirementCode: 'professional_license',
            requirementType: 'LICENSE',
            documentTypes: [{ code: 'business_license', nameKey: 'trust.document_type.business_license.name' }],
          }),
        ],
      });
      const form = formFor(await render(), 'upload')!;
      expect([...form.inner.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1])).toEqual(['business_license']);
      expect(form.inner).not.toContain('passport');
    });
    it('has a labelled file input that accepts PDF, JPEG and PNG, is required, single, and is described by its help text', async () => {
      signedIn();
      open();
      const form = formFor(await render(), 'upload')!;
      expect(form.inner).toContain('<label for="file-identity_verification">' + t('file_label') + '</label>');
      const file = form.inputs.find((i) => i.type === 'file')!;
      expect(file).toMatchObject({
        id: 'file-identity_verification',
        name: 'file',
        accept: 'application/pdf,image/jpeg,image/png',
        'aria-describedby': 'file-help-identity_verification',
      });
      expect(form.inner).toMatch(/<input [^>]*type="file"[^>]*required=""/);
      expect(form.inner).not.toMatch(/<input [^>]*multiple/);
      expect(form.inner).not.toMatch(/<input [^>]*capture/);
      expect(form.inner).toContain(`<p id="file-help-identity_verification">${t('file_help')}</p>`);
    });
    it('every control has a label: each select and each visible input has a <label for> whose id exists exactly once on the page', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({ requirementCode: 'identity_verification' }),
          requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE' }),
        ],
      });
      const html = await render();
      const labelled = [...html.matchAll(/<label for="([^"]*)">/g)].map((m) => m[1]!);
      expect(labelled.sort()).toEqual(['file-identity_verification', 'file-professional_license', 'type-identity_verification', 'type-professional_license']);
      const controls = [...html.matchAll(/<(?:input|select) ([^>]*)>/g)].map((m) => attrs(m[1]!)).filter((a) => a.type !== 'hidden');
      expect(controls.map((c) => c.id).sort()).toEqual(labelled);
      for (const id of labelled) expect(html.match(new RegExp(`id="${id}"`, 'g')), id).toHaveLength(1);
      for (const c of controls.filter((x) => x.type === 'file')) expect(html.match(new RegExp(`id="${c['aria-describedby']}"`, 'g'))).toHaveLength(1);
    });
    it.each(['NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED'] as const)('is offered while the API says the evidence can be attached (%s)', async (status) => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status })] });
      expect(actionsOf(await render())).toContain('upload');
    });
    it.each(['PENDING', 'IN_REVIEW', 'APPROVED', 'EXPIRED', 'NOT_REQUIRED'] as const)(
      'is NOT offered while the API says it cannot be attached (%s)',
      async (status) => {
        signedIn();
        set({ case: caseDto(), requirements: [requirementDto({ status, canAttachEvidence: false })] });
        const html = await render();
        expect(actionsOf(html)).not.toContain('upload');
        expect(html).not.toContain(t('upload_heading'));
        expect(html).not.toContain('type="file"');
      },
    );
    it('the page offers what the API says, not what the status suggests: canAttachEvidence decides', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'NOT_STARTED', canAttachEvidence: false })] });
      expect(actionsOf(await render())).not.toContain('upload');
      set({ case: caseDto(), requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: true })] });
      expect(actionsOf(await render())).toContain('upload');
    });
    it('is never offered for an EXTERNAL requirement (nothing to upload for a check made by another provider)', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            requirementCode: 'background_check',
            requirementType: 'BACKGROUND_CHECK',
            evidenceKind: 'EXTERNAL',
            status: 'NOT_STARTED',
            canAttachEvidence: true,
          }),
        ],
      });
      const html = await render();
      expect(actionsOf(html)).not.toContain('upload');
      expect(html).not.toContain('type="file"');
    });
    it('is offered once per requirement that can take evidence, each with its own code', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({ requirementCode: 'identity_verification' }),
          requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', status: 'PENDING', canAttachEvidence: false }),
          requirementDto({ requirementCode: 'liability_insurance', requirementType: 'INSURANCE', status: 'REJECTED' }),
        ],
      });
      const forms = formsFor(await render(), 'upload');
      expect(forms.map((f) => f.inputs.find((i) => i.type === 'hidden')!.value)).toEqual(['identity_verification', 'liability_insurance']);
    });
    it('is also offered before the case exists (the policy requires it; the first upload opens the case server-side) when the API says so', async () => {
      signedIn();
      set({});
      expect(actionsOf(await render())).toEqual(['open', 'upload']);
    });
    it('escapes a document type name and a requirement code is never echoed outside attributes', async () => {
      signedIn();
      open();
      stub.catalog = { 'en-US': { ...VERIFICATION_COPY['en-US']!, 'trust.document_type.passport.name': { value: '"><script>alert(1)</script>' } } };
      const html = await render();
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });
    it.each(['document_type_label', 'file_label', 'upload_action'])(
      'without only %s of the registry: no upload form at all (a form with a missing label or button would not be usable)',
      async (suffix) => {
        signedIn();
        open();
        const control = await render();
        expect(formsFor(control, 'upload')).toHaveLength(1);
        without(suffix);
        const html = await render();
        expect(formsFor(html, 'upload')).toEqual([]);
        expect(html).not.toContain('type="file"');
        expect(html).not.toContain('name="documentTypeCode"');
        expect(html).not.toContain('/auth/provider/verification/upload');
      },
    );
    it('without only file_help: the form stays, and the file input does not point at a help text that is not there', async () => {
      signedIn();
      open();
      const withHelp = formFor(await render(), 'upload')!;
      expect(withHelp.inputs.find((i) => i.type === 'file')!['aria-describedby']).toBe('file-help-identity_verification');
      without('file_help');
      const html = await render();
      const form = formFor(html, 'upload')!;
      expect(form).toBeDefined();
      const file = form.inputs.find((i) => i.type === 'file')!;
      expect(file).toBeDefined();
      expect(file['aria-describedby']).toBeUndefined();
      expect(html).not.toContain('file-help-');
      expect(form.buttons).toEqual([t('upload_action')]);
    });
    it('without the upload words of the registry: no button, no invented label, no help text, no heading', async () => {
      signedIn();
      open();
      without('upload_action', 'upload_heading', 'file_help', 'file_label', 'document_type_label');
      const html = await render();
      expect(html).not.toContain(t('upload_action'));
      expect(html).not.toContain('<h4');
      expect(html).not.toContain('<p id="file-help');
      expect(html).not.toMatch(/<label[^>]*>[^<]+<\/label>/);
      expect(textOf(html).includes('Choose')).toBe(false);
    });
  });

  describe('the documents', () => {
    it('lists each document with the registry word of its type, status and scan status, in the order of the API, under the documents heading', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            documents: [
              documentDto({ status: 'ATTACHED', scanStatus: 'CLEAN', documentTypeCode: 'drivers_license' }),
              documentDto({
                verificationDocumentId: '1c2d3e4f-0000-4000-8000-000000000002',
                status: 'UPLOAD_PENDING',
                scanStatus: 'PENDING',
                documentTypeCode: 'passport',
              }),
              documentDto({
                verificationDocumentId: '1c2d3e4f-0000-4000-8000-000000000003',
                status: 'SUBMITTED',
                scanStatus: 'CLEAN',
                documentTypeCode: 'state_id',
                round: 1,
              }),
            ],
          }),
        ],
      });
      const html = await render();
      expect(html).toContain(`<h4>${t('documents_heading')}</h4>`);
      const items = [...html.matchAll(/<li>(Registry paper [^<]*)/g)].map((m) => m[1]);
      expect(items).toEqual([
        'Registry paper drivers_license Registry paper state attached Registry scan state clean',
        'Registry paper passport Registry paper state upload_pending Registry scan state pending',
        'Registry paper state_id Registry paper state submitted Registry scan state clean',
      ]);
    });
    it('shows the scan status of an infected or unscanned document as the registry words it', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            documents: [
              documentDto({ status: 'ABANDONED', scanStatus: 'INFECTED' }),
              documentDto({ verificationDocumentId: '1c2d3e4f-0000-4000-8000-000000000004', status: 'UPLOAD_PENDING', scanStatus: 'ERROR' }),
            ],
          }),
        ],
      });
      const html = await render();
      expect(html).toContain('Registry scan state infected');
      expect(html).toContain('Registry scan state error');
    });
    it('no documents heading and no list without documents', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      const html = await render();
      expect(html).not.toContain(t('documents_heading'));
      expect(html).not.toContain('<h4>' + t('documents_heading'));
    });
    it.each(['ATTACHED', 'UPLOAD_PENDING'] as const)('a %s document has a withdraw form with its id as the only field', async (status) => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ documents: [documentDto({ status })] })] });
      const forms = formsFor(await render(), 'withdraw');
      expect(forms).toHaveLength(1);
      expect(forms[0]!.method).toBe('post');
      expect(forms[0]!.inputs).toEqual([{ type: 'hidden', name: 'documentId', value: VERIFICATION_DOCUMENT_ID }]);
      expect(forms[0]!.buttons).toEqual([t('withdraw_action')]);
    });
    it.each(['SUBMITTED', 'WITHDRAWN', 'ABANDONED'] as const)('a %s document has NO withdraw form (it is frozen or gone)', async (status) => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ documents: [documentDto({ status })] })] });
      const html = await render();
      expect(actionsOf(html)).not.toContain('withdraw');
      expect(html).not.toContain(t('withdraw_action'));
      expect(html).toContain(`Registry paper state ${status.toLowerCase()}`);
    });
    it('one withdraw form per withdrawable document, each with its own id', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            documents: [
              documentDto({ verificationDocumentId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
              documentDto({ verificationDocumentId: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'SUBMITTED' }),
              documentDto({ verificationDocumentId: 'aaaaaaaa-0000-4000-8000-000000000003', status: 'UPLOAD_PENDING' }),
            ],
          }),
        ],
      });
      expect(formsFor(await render(), 'withdraw').map((f) => f.inputs[0]!.value)).toEqual([
        'aaaaaaaa-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000003',
      ]);
    });
    it('without the withdraw word of the registry the withdraw form is omitted', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ documents: [documentDto()] })] });
      without('withdraw_action');
      expect(actionsOf(await render())).not.toContain('withdraw');
    });
  });

  describe('the reverify form', () => {
    it('is offered for a requirement the API says can be re-verified: the requirement code is its only field', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'EXPIRED' }),
        requirements: [
          requirementDto({ requirementCode: 'liability_insurance', requirementType: 'INSURANCE', status: 'EXPIRED', expiresAt: '2026-09-01T00:00:00.000Z' }),
        ],
      });
      const html = await render();
      const forms = formsFor(html, 'reverify');
      expect(forms).toHaveLength(1);
      expect(forms[0]!.method).toBe('post');
      expect(forms[0]!.inputs).toEqual([{ type: 'hidden', name: 'requirementCode', value: 'liability_insurance' }]);
      expect(forms[0]!.buttons).toEqual([t('reverify_action')]);
    });
    it('is offered per requirement and only where canReverify is true', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'EXPIRED' }),
        requirements: [
          requirementDto({ requirementCode: 'identity_verification', status: 'APPROVED', canAttachEvidence: false }),
          requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', status: 'EXPIRED' }),
          requirementDto({ requirementCode: 'liability_insurance', requirementType: 'INSURANCE', status: 'EXPIRED' }),
        ],
      });
      expect(formsFor(await render(), 'reverify').map((f) => f.inputs[0]!.value)).toEqual(['professional_license', 'liability_insurance']);
    });
    it('is decided by canReverify, not by the status word: an EXPIRED requirement the API does not allow gets none, an allowed one gets it', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'EXPIRED', canReverify: false, canAttachEvidence: false })] });
      expect(actionsOf(await render())).not.toContain('reverify');
      set({ case: caseDto(), requirements: [requirementDto({ status: 'APPROVED', canReverify: true, canAttachEvidence: false })] });
      expect(actionsOf(await render())).toContain('reverify');
    });
    it('without the reverify word of the registry it is omitted', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto({ status: 'EXPIRED' })] });
      without('reverify_action');
      expect(actionsOf(await render())).not.toContain('reverify');
    });
  });

  describe('the submit form', () => {
    const attached = (extra: Partial<Parameters<typeof requirementDto>[0]> = {}) =>
      requirementDto({ documents: [documentDto({ status: 'ATTACHED' })], ...extra });
    it('is offered when every requirement that can take evidence has an ATTACHED draft; its only field is the revision of the case', async () => {
      signedIn();
      set({ case: caseDto({ revision: 41 }), requirements: [attached()] });
      const html = await render();
      const form = formFor(html, 'submit')!;
      expect(form).toBeDefined();
      expect(form.method).toBe('post');
      expect(form.inputs).toEqual([{ type: 'hidden', name: 'expectedRevision', value: '41' }]);
      expect(form.buttons).toEqual([t('submit_action')]);
      expect(formsFor(html, 'submit')).toHaveLength(1);
    });
    it('the revision is the CASE revision (not a cycle, a round, a number or any other counter)', async () => {
      signedIn();
      set({ case: caseDto({ revision: 5, caseNumber: 99 }), requirements: [attached({ round: 77, cycle: 66 })] });
      expect(formFor(await render(), 'submit')!.inputs[0]!.value).toBe('5');
    });
    it('is NOT offered while one requirement that can take evidence has no ATTACHED draft: none, only pending, withdrawn, abandoned or submitted documents', async () => {
      signedIn();
      for (const documents of [
        [],
        [documentDto({ status: 'UPLOAD_PENDING', scanStatus: 'PENDING' })],
        [documentDto({ status: 'WITHDRAWN' })],
        [documentDto({ status: 'ABANDONED', scanStatus: 'INFECTED' })],
        [documentDto({ status: 'SUBMITTED', round: 1 })],
      ]) {
        set({
          case: caseDto(),
          requirements: [attached(), requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', documents })],
        });
        expect(actionsOf(await render()), JSON.stringify(documents.map((d) => d.status))).not.toContain('submit');
      }
    });
    it('is offered when ONE ATTACHED draft sits among other documents of the same requirement', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          requirementDto({
            documents: [
              documentDto({ status: 'WITHDRAWN' }),
              documentDto({ verificationDocumentId: 'aaaaaaaa-0000-4000-8000-000000000009', status: 'ATTACHED' }),
            ],
          }),
        ],
      });
      expect(actionsOf(await render())).toContain('submit');
    });
    it('requirements that cannot take evidence do not block it (approved, pending or external ones are not waiting for the provider)', async () => {
      signedIn();
      set({
        case: caseDto(),
        requirements: [
          attached(),
          requirementDto({ requirementCode: 'professional_license', requirementType: 'LICENSE', status: 'APPROVED', canAttachEvidence: false }),
          requirementDto({ requirementCode: 'liability_insurance', requirementType: 'INSURANCE', status: 'PENDING', canAttachEvidence: false }),
          requirementDto({ requirementCode: 'background_check', requirementType: 'BACKGROUND_CHECK', evidenceKind: 'EXTERNAL', status: 'IN_REVIEW' }),
        ],
      });
      expect(actionsOf(await render())).toContain('submit');
    });
    it('is NOT offered when nothing is waiting for the provider (everything submitted or decided)', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'IN_REVIEW', submittedAt: '2026-10-17T09:00:00.000Z' }),
        requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false, documents: [documentDto({ status: 'SUBMITTED', round: 1 })] })],
      });
      expect(actionsOf(await render())).not.toContain('submit');
    });
    it('is NOT offered without a case, even when a draft is shown', async () => {
      signedIn();
      set({ case: null, requirements: [attached({ caseRequirementId: null })] });
      expect(actionsOf(await render())).not.toContain('submit');
    });
    it('is offered again after a reviewer asked for more (ACTION_REQUIRED) once the new draft is ATTACHED, and carries the new revision', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'ACTION_REQUIRED', revision: 12, submittedAt: '2026-10-17T09:00:00.000Z' }),
        requirements: [attached({ status: 'ACTION_REQUIRED', reasonCode: 'DOCUMENT_UNREADABLE', round: 1 })],
      });
      expect(formFor(await render(), 'submit')!.inputs[0]!.value).toBe('12');
    });
    it('without the submit word of the registry it is omitted', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [attached()] });
      without('submit_action');
      expect(actionsOf(await render())).not.toContain('submit');
    });
  });

  describe('the cancel form', () => {
    it.each(['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED'] as const)('is offered for a %s case: a POST with no field but the button', async (status) => {
      signedIn();
      set({ case: caseDto({ status }), requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false })] });
      const forms = formsFor(await render(), 'cancel');
      expect(forms).toHaveLength(1);
      expect(forms[0]!.method).toBe('post');
      expect(forms[0]!.inputs).toEqual([]);
      expect(forms[0]!.buttons).toEqual([t('cancel_action')]);
    });
    it.each(['APPROVED', 'EXPIRED', 'CANCELLED'] as const)('is NOT offered for a %s case', async (status) => {
      signedIn();
      set({ case: caseDto({ status }), requirements: [requirementDto({ status: 'APPROVED', canAttachEvidence: false })] });
      const html = await render();
      expect(actionsOf(html)).not.toContain('cancel');
      expect(html).not.toContain(t('cancel_action'));
    });
    it('is NOT offered without a case', async () => {
      signedIn();
      set({});
      expect(actionsOf(await render())).not.toContain('cancel');
    });
    it('without the cancel word of the registry it is omitted', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      without('cancel_action');
      expect(actionsOf(await render())).not.toContain('cancel');
    });
    it('the forms of a rich page appear in a stable order: per requirement the documents, the upload and the reverify, then submit, then cancel', async () => {
      signedIn();
      api.verification = rich();
      const html = await render();
      expect(actionsOf(html)).toEqual(['withdraw', 'upload', 'reverify', 'submit', 'cancel']);
    });
  });

  describe('Approved is not live: the Go-Live note, and no control that decides or hands out evidence', () => {
    it('shows the Go-Live note for every loaded state: no case, an open case, a case in review, an approved case, nothing required', async () => {
      signedIn();
      for (const over of [
        {},
        { prerequisiteMet: false },
        { case: caseDto(), requirements: [requirementDto()] },
        { case: caseDto({ status: 'IN_REVIEW' }), requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false })] },
        { case: caseDto({ status: 'APPROVED' }), requirements: [requirementDto({ status: 'APPROVED', canAttachEvidence: false })] },
        { requirements: [] },
      ] as Array<Parameters<typeof verificationDto>[0]>) {
        set(over);
        expect(await render(), JSON.stringify(Object.keys(over ?? {}))).toContain(`<p>${t('golive_note')}</p>`);
      }
    });
    it('an approved case offers no form at all, no link, and still says it is not live', async () => {
      signedIn();
      set({
        case: caseDto({ status: 'APPROVED' }),
        requirements: [requirementDto({ status: 'APPROVED', canAttachEvidence: false, expiresAt: '2027-01-01T00:00:00.000Z' })],
      });
      const html = await render();
      expect(html).toContain('Registry overall approved');
      expect(html).toContain(t('golive_note'));
      expect(actionsOf(html)).toEqual([]);
      expect(html).not.toContain('<a ');
    });
    it('without the Go-Live word of the registry no note is shown (omitted, not replaced)', async () => {
      signedIn();
      set({});
      without('golive_note');
      const html = await render();
      expect(html).not.toContain('Registry trust not live');
      expect(textOf(html).toLowerCase()).not.toContain('live');
    });
    it('offers no download, no approve/reject control and no object URL, whatever the documents hold', async () => {
      signedIn();
      // the answer is the contract's, plus fields a careless server might add: they must never reach the page
      const dirty = JSON.parse(JSON.stringify(rich())) as ProviderVerificationDto & Record<string, unknown>;
      for (const r of dirty.requirements) {
        for (const d of r.documents)
          Object.assign(d, { objectKey: 'trust/evidence/secret-key', sha256: 'f'.repeat(64), downloadUrl: UPLOAD_URL, url: UPLOAD_URL });
      }
      api.rawBody['GET /provider/verification'] = dirty;
      const html = await render();
      expect(html).not.toContain('<a ');
      expect(html).not.toMatch(/href=/);
      expect(html).not.toMatch(/download/i);
      const names = [...html.matchAll(/(?:name|action|value|id)="([^"]*)"/g)].map((m) => m[1]);
      expect(names.filter((n) => /approve|reject|decision|review|download/i.test(n!))).toEqual([]);
      for (const leak of [
        UPLOAD_URL,
        'objects.example.test',
        'ONE-TIME-SIGNATURE',
        'secret-key',
        'trust/evidence',
        'ffffffff',
        'http://',
        'https://',
        'objectKey',
        'sha256',
      ])
        expect(html, leak).not.toContain(leak);
      expect(actionsOf(html).every((a) => ['open', 'upload', 'withdraw', 'submit', 'cancel', 'reverify'].includes(a))).toBe(true);
    });
    it('every form posts to a fixed /auth/provider/verification/ action and no hidden field carries an account id, a case id, a status, a decision or a completion flag', async () => {
      signedIn({ activeRole: 'PROVIDER' });
      api.verification = rich();
      const forms = formsOf(await render());
      for (const f of forms) {
        expect(f.action).toMatch(/^\/auth\/provider\/verification\/(open|upload|withdraw|submit|cancel|reverify)$/);
        expect(f.method).toBe('post');
      }
      const hidden = forms.flatMap((f) => f.inputs.filter((i) => i.type === 'hidden').map((i) => i.name));
      expect([...new Set(hidden)].sort()).toEqual(['documentId', 'expectedRevision', 'requirementCode']);
    });
    it('nothing is pre-ticked or auto-run: no script, no autofocus, no inline handler, no formaction, no checked or selected control', async () => {
      signedIn();
      api.verification = rich();
      const html = await render({ error: 'TRUST_STALE_CASE', notice: 'uploaded' });
      for (const forbidden of [
        '<script',
        'autofocus',
        'onload',
        'onclick',
        'onchange',
        'formaction',
        'http-equiv',
        'selected',
        'checked',
        'autocomplete',
        'target=',
      ])
        expect(html, forbidden).not.toContain(forbidden);
    });
  });

  describe('notices come from a closed list of words and only when the data proves them', () => {
    it('?notice=uploaded and ?notice=withdrawn show their registry message as a status', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      expect(await render({ notice: 'uploaded' })).toContain(`<p role="status">${t('uploaded_notice')}</p>`);
      expect(await render({ notice: 'withdrawn' })).toContain(`<p role="status">${t('withdrawn_notice')}</p>`);
      expect((await render({ notice: 'uploaded' })).match(/role="status"/g)).toHaveLength(1);
    });
    it('?notice=submitted is shown only when the case shows a submission time', async () => {
      signedIn();
      set({ case: caseDto({ submittedAt: null }), requirements: [requirementDto()] });
      expect(await render({ notice: 'submitted' })).not.toContain('role="status"');
      set({});
      expect(await render({ notice: 'submitted' })).not.toContain('role="status"');
      set({
        case: caseDto({ status: 'IN_REVIEW', submittedAt: '2026-10-17T09:00:00.000Z' }),
        requirements: [requirementDto({ status: 'PENDING', canAttachEvidence: false })],
      });
      expect(await render({ notice: 'submitted' })).toContain(`<p role="status">${t('submitted_notice')}</p>`);
    });
    it('?notice=cancelled is shown only when there is no case', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      expect(await render({ notice: 'cancelled' })).not.toContain('role="status"');
      set({ case: caseDto({ status: 'APPROVED' }), requirements: [requirementDto({ status: 'APPROVED', canAttachEvidence: false })] });
      expect(await render({ notice: 'cancelled' })).not.toContain('role="status"');
      set({});
      expect(await render({ notice: 'cancelled' })).toContain(`<p role="status">${t('cancelled_notice')}</p>`);
    });
    it('the notices do not cross over: submitted on a page without a submission and cancelled on a live case say nothing', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      const a = await render({ notice: 'submitted' });
      const b = await render({ notice: 'cancelled' });
      for (const html of [a, b]) {
        expect(html).not.toContain('role="status"');
        for (const word of ['submitted_notice', t('submitted_notice'), t('cancelled_notice'), t('uploaded_notice'), t('withdrawn_notice')])
          expect(html).not.toContain(word);
      }
    });
    it('the notice words opened, resumed and reverified carry no message of their own: the page state reflects them', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      for (const notice of ['opened', 'resumed', 'reverified']) {
        const html = await render({ notice });
        expect(html, notice).not.toContain('role="status"');
        expect(html).not.toContain(notice);
      }
    });
    it('ignores an unknown notice word, a repeated parameter and Object.prototype names, and never echoes them', async () => {
      signedIn();
      set({ case: caseDto({ submittedAt: '2026-10-17T09:00:00.000Z' }), requirements: [requirementDto()] });
      for (const notice of [
        'nope',
        '<script>alert(1)</script>',
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        'valueOf',
        ['uploaded', 'withdrawn'],
        '',
      ] as Array<string | string[]>) {
        const html = await render({ notice });
        expect(html, JSON.stringify(notice)).not.toContain('role="status"');
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
      }
    });
    it('shows no notice when the verification could not be read (nothing proves it)', async () => {
      signedIn();
      api.forced['GET /provider/verification'] = { status: 503, code: 'TRUST_UNAVAILABLE', category: 'DEPENDENCY' };
      expect(await render({ notice: 'uploaded' })).not.toContain('role="status"');
    });
    it('a notice without registry copy shows nothing, and a notice can sit beside an error', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      const both = await render({ notice: 'uploaded', error: 'TRUST_SCAN_INFECTED' });
      expect(both).toContain('role="alert"');
      expect(both).toContain('role="status"');
      without('uploaded_notice');
      expect(await render({ notice: 'uploaded' })).not.toContain('role="status"');
    });
  });

  describe('errors come from a closed list of words', () => {
    it.each(TRUST_ERROR_CODES)("?error=TRUST_%s shows that code's registry message in an alert", async (code) => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      const html = await render({ error: `TRUST_${code}` });
      expect(html).toContain(`<p id="${ERROR_ID}" role="alert">Registry trust error ${code.toLowerCase()}</p>`);
      expect(html.match(/role="alert"/g)).toHaveLength(1);
    });
    it('the codes without the TRUST_ prefix, unknown words and API_ERROR show the generic message and are never echoed', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      for (const error of [
        'API_ERROR',
        'STALE_CASE',
        'PROVIDER_CONFLICT',
        'TRUST_NOPE',
        'TRUST_',
        'trust_conflict',
        'TRUST_CONFLICT ',
        'nope',
        '"><script>alert(1)</script>',
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        '',
      ]) {
        const html = await render({ error });
        expect(html, JSON.stringify(error)).toContain(`<p id="${ERROR_ID}" role="alert">${VERIFICATION_TEXT['trust.verification.error.unavailable']}</p>`);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('nope');
        expect(html).not.toContain('NOPE');
        expect(html).not.toContain('STALE_CASE');
        expect(html).not.toContain('PROVIDER_CONFLICT');
      }
    });
    it('a repeated ?error= parameter is ignored (nothing is shown for it)', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      expect(await render({ error: ['TRUST_CONFLICT', 'x'] })).not.toContain('role="alert"');
    });
    it('every form is described by the error element when there is an error, and by nothing when there is none', async () => {
      signedIn();
      api.verification = rich();
      const withError = await render({ error: 'TRUST_STALE_CASE' });
      const forms = formsOf(withError);
      expect(forms.map((f) => f.action.replace(ACTION, ''))).toEqual(['withdraw', 'upload', 'reverify', 'submit', 'cancel']);
      for (const f of forms) expect(f.describedBy, f.action).toBe(ERROR_ID);
      expect(withError.match(new RegExp(`id="${ERROR_ID}"`, 'g'))).toHaveLength(1);
      const clean = await render();
      for (const f of formsOf(clean)) expect(f.describedBy, f.action).toBeUndefined();
      expect(clean).not.toContain(ERROR_ID);
    });
    it('the open form is described by the error as well', async () => {
      signedIn();
      set({});
      expect(formFor(await render({ error: 'TRUST_PREREQUISITE_NOT_MET' }), 'open')!.describedBy).toBe(ERROR_ID);
    });
    it('the file input keeps its own description (the help text) when there is an error', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      const file = formFor(await render({ error: 'TRUST_MIME_NOT_ALLOWED' }), 'upload')!.inputs.find((i) => i.type === 'file')!;
      expect(file['aria-describedby']).toBe('file-help-identity_verification');
    });
    it('with no copy for the message nothing is invented: no alert, and the forms are not described by a missing element', async () => {
      signedIn();
      set({ case: caseDto(), requirements: [requirementDto()] });
      withoutKeys('trust.verification.error.conflict', 'trust.verification.error.unavailable');
      const none = await render({ error: 'TRUST_CONFLICT' });
      expect(none).not.toContain('role="alert"');
      expect(none).not.toContain('CONFLICT');
      for (const f of formsOf(none)) expect(f.describedBy).toBeUndefined();
    });
  });

  describe('every string is registry copy', () => {
    it('with NO trust copy in the registry the page shows no text at all: no literal replaces a missing word', async () => {
      signedIn();
      api.verification = rich();
      stub.catalog = REGISTRY_COPY;
      const html = await render({ error: 'TRUST_STALE_CASE', notice: 'uploaded' });
      expect(textOf(html)).toBe('');
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('<h3');
      expect(html).not.toContain('<h4');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('role="note"');
      expect(html).not.toContain('<button'); // nothing to press without a label
    });
    it('no word of the page is a literal of the app: removing every registry word leaves nothing but punctuation', async () => {
      signedIn();
      api.verification = rich();
      let rest = textOf(await render({ error: 'TRUST_STALE_CASE', notice: 'uploaded' }));
      for (const value of Object.values(VERIFICATION_TEXT).sort((a, b) => b.length - a.length)) rest = rest.replaceAll(value, ' ');
      expect(rest.replace(/2026-12-31/g, '').replace(/[\s:()]/g, '')).toBe('');
    });
    it('no managed word is hardcoded: the usual English labels never appear', async () => {
      signedIn();
      api.verification = rich();
      const html = await render({ error: 'TRUST_STALE_CASE', notice: 'submitted' });
      const text = textOf(html);
      for (const literal of [
        'Verification',
        'Verify',
        'Upload',
        'Submit',
        'Cancel',
        'Withdraw',
        'Remove',
        'Download',
        'Approved',
        'Rejected',
        'Pending',
        'Document',
        'Identity',
        'Passport',
        'Licen',
        'Insurance',
        'Background',
        'Go live',
        'Go-Live',
        'Choose',
        'Select',
        'Valid until',
        'Expires',
      ])
        expect(text, literal).not.toContain(literal);
    });
    it.each([
      ['title', '<h1'],
      ['intro', 'trust intro'],
      ['status_label', 'trust standing'],
      ['requirements_heading', 'id="verification-requirements"'],
      ['documents_heading', '<h4>Registry trust papers'],
      ['upload_heading', 'add evidence heading'],
      ['file_help', 'id="file-help-'],
      ['golive_note', 'not live yet'],
    ])('without %s in the registry that element is omitted', async (suffix, marker) => {
      signedIn();
      api.verification = rich();
      const full = await render();
      expect(full, `${suffix} control`).toContain(marker);
      without(suffix!);
      expect(await render(), suffix).not.toContain(marker);
    });
  });
});
