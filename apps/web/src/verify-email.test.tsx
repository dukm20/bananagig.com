// ID-002 web side: the /verify-email server component. The API is the account + content stub (see testing/account-stub.ts): the page reads the email state
// with the session's token, every string comes from the registry copy (EMAIL_COPY, worded unlike the seeded copy), and no code, token or full address is
// ever rendered. The magic-link landing (a client component reading the URL fragment) is covered by link-confirm.test.tsx.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_ERROR_CODES, type AccountEmailDetailDto } from '@bananagig/contracts';
import VerifyEmailPage, { dynamic, metadata } from './app/verify-email/page';
import { LinkConfirm, type LinkConfirmCopy } from './app/verify-email/link-confirm';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import { CUSTOMER_ROLE, EMAIL_COPY, EMAIL_TEXT, PROVIDER_ROLE, accountDto, attachAccountApi, emailDetail, type AccountApiStub } from './testing/account-stub';
import { startContentStub, type ContentStub } from './testing/content-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US', ...(state.cookie ? { cookie: state.cookie } : {}) }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-3', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

// ---------------------------------------------------------------- content keys (literal on purpose: a renamed key must fail here, the registry seeds these names)
const K = {
  title: 'account.email.verify.title',
  intro: 'account.email.verify.intro',
  codeLabel: 'account.email.verify.code_label',
  submit: 'account.email.verify.submit',
  resend: 'account.email.verify.resend',
  resendWait: 'account.email.verify.resend_wait',
  change: 'account.email.verify.change',
  sent: 'account.email.verify.sent',
  success: 'account.email.verify.success',
  linkTitle: 'account.email.link.title',
  linkBody: 'account.email.link.body',
  linkConfirm: 'account.email.link.confirm',
  signInRequired: 'account.email.link.sign_in_required',
  signIn: 'common.action.sign_in',
  unavailable: 'session.account.unavailable',
  statusNone: 'account.email.status.none',
  statusPending: 'account.email.status.pending',
  statusVerified: 'account.email.status.verified',
} as const;
const LINK_KEYS = [K.linkTitle, K.linkBody, K.linkConfirm];
const ACCOUNT_TEXT: Record<string, string> = { [K.signIn]: 'Registry sign in', [K.unavailable]: 'Registry account unavailable' };
/** The registry wording of a key (see EMAIL_COPY and ACCOUNT_COPY); a key without copy would make every assertion on it fail loudly. */
const t = (key: string): string => EMAIL_TEXT[key] ?? ACCOUNT_TEXT[key] ?? `missing copy for ${key}`;

/** The API error code the action handler redirects with -> the content key the page must show. EMAIL_INVALID carries an issue code (invalid_format). */
const ERROR_COPY_CASES: [string, string][] = [
  ['ACCOUNT_EMAIL_INVALID', 'account.email.error.invalid_format'],
  ['ACCOUNT_EMAIL_NOT_PENDING', 'account.email.error.not_pending'],
  ['ACCOUNT_EMAIL_CODE_INVALID', 'account.email.error.code_invalid'],
  ['ACCOUNT_EMAIL_LINK_INVALID', 'account.email.error.link_invalid'],
  ['ACCOUNT_EMAIL_CODE_EXPIRED', 'account.email.error.code_expired'],
  ['ACCOUNT_EMAIL_CODE_USED', 'account.email.error.code_used'],
  ['ACCOUNT_EMAIL_VERIFICATION_LOCKED', 'account.email.error.verification_locked'],
  ['ACCOUNT_EMAIL_RESEND_TOO_SOON', 'account.email.error.resend_too_soon'],
  ['ACCOUNT_EMAIL_SEND_LIMIT', 'account.email.error.send_limit'],
  ['ACCOUNT_EMAIL_UNAVAILABLE', 'account.email.error.unavailable'],
  ['ACCOUNT_EMAIL_DELIVERY_FAILED', 'account.email.error.delivery_failed'],
  ['ACCOUNT_EMAIL_RATE_LIMITED', 'account.email.error.rate_limited'],
];

// ---------------------------------------------------------------- fixtures
const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
const CODE_MARKER = '8675309';
const TOKEN_MARKER = `lnk${'Q'.repeat(40)}`;
const EMAIL_MARKER = 'leak.marker+tag@example.test';
const NOW_ISO = '2026-10-07T12:00:00.000Z';
const PRIMARY = { maskedEmail: 'o***@o***.test', verifiedAt: '2026-01-02T03:04:05.000Z', source: 'USER_ENTERED' as const };
const pendingOf = (over: Partial<NonNullable<AccountEmailDetailDto['pending']>> = {}): NonNullable<AccountEmailDetailDto['pending']> => ({
  maskedEmail: 'n***@n***.test',
  purpose: 'INITIAL_EMAIL',
  status: 'PENDING',
  lastSentAt: '2026-10-07T11:59:00.000Z',
  expiresAt: '2026-10-07T12:29:00.000Z',
  ...over,
});
const pendingState = (over: Partial<AccountEmailDetailDto> = {}): AccountEmailDetailDto =>
  emailDetail({ emailVerificationStatus: 'PENDING', pending: pendingOf(), attemptsRemaining: 5, ...over });
const replacementState = (over: Partial<AccountEmailDetailDto> = {}): AccountEmailDetailDto =>
  emailDetail({
    emailVerificationStatus: 'VERIFIED',
    primary: PRIMARY,
    pending: pendingOf({ maskedEmail: 'r***@r***.test', purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' }),
    attemptsRemaining: 5,
    ...over,
  });
const verifiedState = (): AccountEmailDetailDto => emailDetail({ emailVerificationStatus: 'VERIFIED', primary: PRIMARY });

// ---------------------------------------------------------------- reading the rendered HTML (the browser's view, without React's text separators)
type Attrs = Record<string, string>;
/** Attributes of one start tag, names lower-cased (HTML is case-insensitive: React prints inputMode, autoComplete and maxLength in camel case). */
const attrsOf = (tag: string): Attrs => {
  const out: Attrs = {};
  for (const m of tag.replace(/^<\w+/, '').matchAll(/([A-Za-z][\w-]*)(?:="([^"]*)")?/g)) out[m[1]!.toLowerCase()] = m[2] ?? '';
  return out;
};
const tagsOf = (html: string, name: string): Attrs[] => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrsOf(m[0]));
interface Form {
  attrs: Attrs;
  inner: string;
  inputs: Attrs[];
  buttons: { attrs: Attrs; text: string }[];
}
const formsOf = (html: string): Form[] =>
  [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
    attrs: attrsOf(m[0].slice(0, m[0].indexOf('>') + 1)),
    inner: m[1]!,
    inputs: tagsOf(m[1]!, 'input'),
    buttons: [...m[1]!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((b) => ({
      attrs: attrsOf(`<button${b[1]}>`),
      text: b[2]!.replace(/<[^>]*>/g, ''),
    })),
  }));
const formFor = (html: string, action: string): Form => {
  const form = formsOf(html).find((f) => f.attrs.action === action);
  if (!form) throw new Error(`no form with action ${action} in: ${html}`);
  return form;
};
/** The text a person reads: tags removed, whitespace collapsed. */
const visibleText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

/** Every ReactElement of the given component type in a (server component) element tree. */
const elementsOfType = (node: ReactNode, type: unknown): ReactElement<{ copy: LinkConfirmCopy }>[] => {
  if (Array.isArray(node)) return node.flatMap((n: ReactNode) => elementsOfType(n, type));
  if (!isValidElement(node)) return [];
  const own = node.type === type ? [node as ReactElement<{ copy: LinkConfirmCopy }>] : [];
  return [...own, ...elementsOfType((node.props as { children?: ReactNode }).children, type)];
};

describe('verify-email page', () => {
  let stub: ContentStub;
  let api: AccountApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(EMAIL_COPY);
    api = attachAccountApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = EMAIL_COPY;
    stub.calls.length = 0;
    stub.localeCalls = 0;
    api.reset();
    state.baseUrl = stub.baseUrl;
    state.cookie = undefined;
    store.sessions.clear();
  });
  afterEach(() => vi.useRealTimers());

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
  /** Freezes Date only (timers and sockets stay real): the countdown is then computed against a fixed instant. */
  const freezeClock = (iso = NOW_ISO) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  type Query = Record<string, string | undefined>;
  const page = async (query: Query = {}) => {
    const tree = await VerifyEmailPage({ searchParams: Promise.resolve(query as { ok?: string; error?: string }) });
    return { tree, html: renderToString(tree).replaceAll('<!-- -->', '') };
  };
  const render = async (query: Query = {}) => (await page(query)).html;
  const emailCalls = () => api.calls.filter((c) => c.path.startsWith('/api/v1/account/email'));
  const contentBody = (call = 0) => stub.calls[call]!.body as { keys: string[]; variables?: Record<string, Record<string, unknown>>; locale: string };
  const requestedKeys = (call = 0) => [...contentBody(call).keys].sort();
  const sorted = (keys: string[]) => [...keys].sort();

  // ------------------------------------------------------------ module contract
  it('is never cached and never leaks its address: no-referrer, noindex, force-dynamic', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.referrer).toBe('no-referrer');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  // ------------------------------------------------------------ signed out
  it('signed out: title, the sign-in-required status and a sign-in link back to this page, from the registry; no email API call', async () => {
    const { tree, html } = await page();
    expect(html).toContain(`<h1>${t(K.title)}</h1>`);
    expect(html).toContain(`<p role="status">${t(K.signInRequired)}</p>`);
    expect(html).toContain(`<a href="/auth/login?returnTo=/verify-email">${t(K.signIn)}</a>`);
    expect(formsOf(html)).toEqual([]);
    expect(html).not.toContain('role="alert"');
    // nothing was asked of the API but the copy
    expect(api.calls).toEqual([]);
    expect(emailCalls()).toEqual([]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.path).toBe('/api/v1/content/resolve-many');
    expect(requestedKeys()).toEqual(sorted([K.title, K.signInRequired, K.signIn]));
    // the magic-link landing needs a session: it is not even in the tree
    expect(elementsOfType(tree, LinkConfirm)).toEqual([]);
  });

  it('signed out: an unknown, expired or foreign session is the same as no session', async () => {
    for (const cookie of [undefined, 'bg_session=unknown', 'other=sid1', 'bg_session=']) {
      state.cookie = cookie;
      stub.calls.length = 0;
      const html = await render();
      expect(html, String(cookie)).toContain(`<a href="/auth/login?returnTo=/verify-email">${t(K.signIn)}</a>`);
      expect(formsOf(html)).toEqual([]);
    }
    expect(emailCalls()).toEqual([]);
  });

  it('signed out: the sign-in link is a fixed path and carries nothing from the URL (no token, code, address, ok or error)', async () => {
    const html = await render({ token: TOKEN_MARKER, code: CODE_MARKER, email: EMAIL_MARKER, ok: 'verified', error: 'ACCOUNT_EMAIL_CODE_INVALID' });
    expect(tagsOf(html, 'a')).toEqual([{ href: '/auth/login?returnTo=/verify-email' }]);
    for (const marker of [TOKEN_MARKER, CODE_MARKER, EMAIL_MARKER, 'example.test']) expect(html).not.toContain(marker);
    expect(JSON.stringify(stub.calls)).not.toMatch(/lnk|8675309|leak\.marker/);
    expect(html).not.toContain('role="alert"'); // a signed-out visitor is told to sign in, nothing else
    expect(emailCalls()).toEqual([]);
  });

  it('signed out, registry down: the title and status are omitted, only the bootstrap sign-in link remains', async () => {
    stub.mode = 'down';
    const html = await render();
    expect(visibleText(html)).toBe('Sign in');
    expect(html).toContain('<a href="/auth/login?returnTo=/verify-email">Sign in</a>');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(t(K.signInRequired));
    for (const english of ['Verify your email', 'Sign in to your account', 'Not signed in']) expect(html).not.toContain(english);
  });

  // ------------------------------------------------------------ signed in: states
  it('NONE: the status label and the set-address form only (no code form, no resend, no magic-link control)', async () => {
    signedIn();
    api.email = emailDetail();
    const { tree, html } = await page();
    expect(html).toContain(`<h1>${t(K.title)}</h1>`);
    expect(html).toContain(`<p role="status">${t(K.statusNone)}</p>`);
    expect(formsOf(html).map((f) => f.attrs.action)).toEqual(['/auth/email/set']);
    const set = formFor(html, '/auth/email/set');
    expect(set.attrs.method).toBe('post');
    expect(set.inputs).toHaveLength(1);
    expect(set.inputs[0]).toMatchObject({ name: 'email', type: 'email', autocomplete: 'email', maxlength: '254', required: '' });
    expect(set.inputs[0]!.value).toBeUndefined();
    expect(set.inner).toContain(t(K.change));
    expect(set.buttons).toHaveLength(1);
    expect(set.buttons[0]!.attrs.type).toBe('submit');
    for (const absent of ['/auth/email/confirm-code', '/auth/email/send', 'name="code"', t(K.intro), t(K.codeLabel), t(K.resend)])
      expect(html).not.toContain(absent);
    expect(html).not.toContain('role="alert"');
    expect(elementsOfType(tree, LinkConfirm)).toEqual([]); // the token landing is offered only while an address is pending
    expect(requestedKeys()).toEqual(sorted([K.title, K.change, K.submit, ...LINK_KEYS, K.statusNone]));
  });

  it('PENDING: intro with the MASKED address as a content variable, the code form, an enabled resend form and the change-address form', async () => {
    signedIn();
    api.email = pendingState();
    const html = await render();
    expect(html).toContain(`<p role="status">${t(K.statusPending)}</p>`);
    expect(html).toContain(`<p>${t(K.intro)}</p>`);
    expect(formsOf(html).map((f) => f.attrs.action)).toEqual(['/auth/email/confirm-code', '/auth/email/send', '/auth/email/set']);
    for (const form of formsOf(html)) expect(form.attrs.method).toBe('post');

    const code = formFor(html, '/auth/email/confirm-code');
    expect(code.inputs).toHaveLength(1);
    expect(code.inputs[0]).toMatchObject({
      name: 'code',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      maxlength: '6',
      pattern: '[0-9]{6}',
      required: '',
    });
    expect(code.inputs[0]!.type).not.toBe('password'); // a code is read, not hidden; and it is never prefilled
    expect(code.inputs[0]!.value).toBeUndefined();
    expect(code.inner).toContain(t(K.codeLabel));
    expect(code.buttons).toEqual([{ attrs: { type: 'submit' }, text: t(K.submit) }]);

    const resend = formFor(html, '/auth/email/send');
    expect(resend.inputs).toEqual([]); // nothing to submit but the intent
    expect(resend.buttons).toEqual([{ attrs: { type: 'submit' }, text: t(K.resend) }]);
    expect(resend.buttons[0]!.attrs.disabled).toBeUndefined();
    expect(html).not.toContain('role="timer"');

    expect(formFor(html, '/auth/email/set').inputs[0]).toMatchObject({ name: 'email', type: 'email', maxlength: '254' });

    // the address reaches the registry only masked, as the variable of the intro
    expect(stub.calls).toHaveLength(1);
    expect(contentBody().variables).toEqual({ [K.intro]: { masked_email: 'n***@n***.test' } });
    expect(requestedKeys()).toEqual(sorted([K.title, K.change, ...LINK_KEYS, K.statusPending, K.intro, K.codeLabel, K.submit, K.resend]));
  });

  it('PENDING: the code input takes its length from the API state (configuration), nowhere else', async () => {
    signedIn();
    for (const codeLength of [4, 6, 8, 10]) {
      api.email = pendingState({ codeLength });
      const input = formFor(await render(), '/auth/email/confirm-code').inputs[0]!;
      expect(input.maxlength, String(codeLength)).toBe(String(codeLength));
      expect(input.pattern).toBe(`[0-9]{${codeLength}}`);
    }
  });

  it('PENDING with a resend cooldown: the resend button is disabled and the countdown (seconds, rounded up) comes from the registry', async () => {
    freezeClock();
    signedIn();
    const cases: [string, number][] = [
      ['2026-10-07T12:00:42.100Z', 43],
      ['2026-10-07T12:00:30.000Z', 30],
      ['2026-10-07T12:00:00.001Z', 1],
      ['2026-10-07T12:05:00.000Z', 300],
    ];
    for (const [resendAvailableAt, seconds] of cases) {
      stub.calls.length = 0;
      api.email = pendingState({ resendAvailableAt });
      const html = await render();
      const resend = formFor(html, '/auth/email/send');
      expect(resend.buttons, resendAvailableAt).toEqual([{ attrs: { type: 'submit', disabled: '' }, text: t(K.resend) }]);
      expect(resend.inner).toContain(`<p role="timer">${t(K.resendWait)}</p>`);
      expect(contentBody().variables, resendAvailableAt).toEqual({ [K.intro]: { masked_email: 'n***@n***.test' }, [K.resendWait]: { seconds } });
      expect(typeof contentBody().variables![K.resendWait]!.seconds).toBe('number');
      expect(requestedKeys()).toContain(K.resendWait);
      // the code form is unaffected by the cooldown
      expect(formFor(html, '/auth/email/confirm-code').buttons[0]!.attrs.disabled).toBeUndefined();
    }
  });

  it('PENDING with the cooldown over (past, now or no timestamp): the resend button is enabled and no countdown is requested', async () => {
    freezeClock();
    signedIn();
    for (const resendAvailableAt of [null, '2026-10-07T11:59:59.000Z', NOW_ISO]) {
      stub.calls.length = 0;
      api.email = pendingState({ resendAvailableAt });
      const html = await render();
      expect(formFor(html, '/auth/email/send').buttons, String(resendAvailableAt)).toEqual([{ attrs: { type: 'submit' }, text: t(K.resend) }]);
      expect(html).not.toContain('role="timer"');
      expect(requestedKeys()).not.toContain(K.resendWait);
      expect(contentBody().variables).toEqual({ [K.intro]: { masked_email: 'n***@n***.test' } });
    }
  });

  it('REPLACEMENT_PENDING over a verified primary: shows the verified status with the masked primary AND the code form for the new address', async () => {
    signedIn();
    api.email = replacementState();
    const html = await render();
    expect(html).toContain(`<p role="status">${t(K.statusVerified)} o***@o***.test</p>`);
    expect(formsOf(html).map((f) => f.attrs.action)).toEqual(['/auth/email/confirm-code', '/auth/email/send', '/auth/email/set']);
    expect(formFor(html, '/auth/email/confirm-code').inputs[0]).toMatchObject({ name: 'code', maxlength: '6' });
    expect(html).toContain(`<p>${t(K.intro)}</p>`);
    // the intro names the NEW address (masked), not the verified one
    expect(contentBody().variables![K.intro]).toEqual({ masked_email: 'r***@r***.test' });
    expect(requestedKeys()).toEqual(expect.arrayContaining([K.title, K.statusVerified, K.intro, K.codeLabel, K.submit, K.resend, K.change, ...LINK_KEYS]));
    expect(html).not.toContain(t(K.statusPending));
  });

  it('VERIFIED without a pending change: the verified status with the masked address, and no form at all', async () => {
    signedIn();
    api.email = verifiedState();
    const { tree, html } = await page();
    expect(html).toContain(`<p role="status">${t(K.statusVerified)} o***@o***.test</p>`);
    expect(formsOf(html)).toEqual([]);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    for (const absent of [t(K.intro), t(K.codeLabel), t(K.resend), t(K.change), t(K.statusPending), t(K.statusNone)]) expect(html).not.toContain(absent);
    expect(elementsOfType(tree, LinkConfirm)).toEqual([]);
    expect(requestedKeys()).toEqual(expect.arrayContaining([K.title, K.statusVerified]));
    for (const unused of [K.intro, K.codeLabel, K.submit, K.resend, K.resendWait]) expect(requestedKeys()).not.toContain(unused);
    expect(contentBody().variables ?? {}).toEqual({});
  });

  // ------------------------------------------------------------ notices and errors
  it('?ok=sent and ?ok=verified show the registry notice; any other ok shows nothing', async () => {
    signedIn();
    api.email = pendingState();
    const sent = await render({ ok: 'sent' });
    expect(sent).toContain(`<p role="status">${t(K.sent)}</p>`);
    expect(sent).not.toContain(t(K.success));
    expect(requestedKeys()).toContain(K.sent);

    api.email = verifiedState();
    stub.calls.length = 0;
    const verified = await render({ ok: 'verified' });
    expect(verified).toContain(`<p role="status">${t(K.success)}</p>`);
    expect(verified).not.toContain(t(K.sent));
    expect(verified).toContain(`<p role="status">${t(K.statusVerified)} o***@o***.test</p>`);

    for (const other of ['', 'SENT', 'true', 'sent,verified', '<b>']) {
      const html = await render({ ok: other });
      expect(html, other).not.toContain(t(K.sent));
      expect(html, other).not.toContain(t(K.success));
    }
  });

  it('ERROR_COPY_CASES covers every email error code of the contract', () => {
    expect(ERROR_COPY_CASES.map(([code]) => code).sort()).toEqual(EMAIL_ERROR_CODES.map((c) => `ACCOUNT_${c}`).sort());
  });

  it.each(ERROR_COPY_CASES)('?error=%s shows the registry copy of %s in an alert and keeps the forms', async (code, key) => {
    signedIn();
    api.email = pendingState();
    const html = await render({ error: code });
    expect(html).toContain(`<p role="alert">${t(key)}</p>`);
    expect(countOf(html, 'role="alert"')).toBe(1);
    // no other error's copy and no "unavailable" fallback
    for (const [, other] of ERROR_COPY_CASES) if (other !== key) expect(html).not.toContain(t(other));
    expect(html).not.toContain(t(K.unavailable));
    expect(requestedKeys()).toContain(key);
    expect(formsOf(html).map((f) => f.attrs.action)).toEqual(['/auth/email/confirm-code', '/auth/email/send', '/auth/email/set']);
    expect(stub.calls).toHaveLength(1);
  });

  it('an error code the page does not know (another API error, a made-up value) shows the registry "unavailable" copy, never the value', async () => {
    signedIn();
    api.email = pendingState();
    for (const error of [
      'API_ERROR',
      'AUTHENTICATION_REQUIRED',
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_ROLE_NOT_HELD',
      'UNEXPECTED_RESPONSE',
      'account_email_code_invalid',
      'ACCOUNT_EMAIL_',
      '<script>alert(1)</script>',
    ]) {
      const html = await render({ error });
      expect(html, error).toContain(`<p role="alert">${t(K.unavailable)}</p>`);
      expect(countOf(html, 'role="alert"'), error).toBe(1);
      expect(html, error).not.toContain('<script');
      for (const [, key] of ERROR_COPY_CASES) expect(html, error).not.toContain(t(key));
    }
  });

  it('an error code that is the name of an Object.prototype member is just an unknown code: the page copy survives', async () => {
    signedIn();
    api.email = pendingState();
    for (const error of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', '__defineGetter__']) {
      stub.calls.length = 0;
      const html = await render({ error });
      expect(html, error).toContain(`<h1>${t(K.title)}</h1>`);
      expect(html, error).toContain(`<p role="alert">${t(K.unavailable)}</p>`);
      expect(stub.calls, error).toHaveLength(1);
      expect(
        contentBody().keys.every((k) => typeof k === 'string'),
        error,
      ).toBe(true);
    }
  });

  it('an error whose message the registry does not serve shows no alert at all (no hardcoded replacement)', async () => {
    signedIn();
    api.email = pendingState();
    const copy = structuredClone(EMAIL_COPY);
    delete copy['en-US']!['account.email.error.code_invalid'];
    stub.catalog = copy;
    const html = await render({ error: 'ACCOUNT_EMAIL_CODE_INVALID' });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(t(K.unavailable));
    expect(html).toContain(`<h1>${t(K.title)}</h1>`);
    expect(formFor(html, '/auth/email/confirm-code').inputs[0]).toMatchObject({ name: 'code' });
  });

  // ------------------------------------------------------------ failures of the API and of the registry
  it('API down, account suspended or a body that breaks the contract: the registry "unavailable" status, no forms and no stale data', async () => {
    signedIn();
    for (const mode of ['down', 'suspended'] as const) {
      api.reset();
      api.mode = mode;
      stub.calls.length = 0;
      const html = await render();
      expect(html, mode).toContain(`<h1>${t(K.title)}</h1>`);
      expect(html, mode).toContain(`<p role="status">${t(K.unavailable)}</p>`);
      expect(formsOf(html), mode).toEqual([]);
      for (const absent of [t(K.statusNone), t(K.statusPending), t(K.statusVerified), t(K.intro), t(K.change), 'o***@o***.test'])
        expect(html, mode).not.toContain(absent);
      expect(emailCalls(), mode).toHaveLength(1);
      expect(requestedKeys(), mode).toContain(K.unavailable);
    }
    api.reset();
    api.email = { ...pendingState(), codeLength: 'six' } as unknown as AccountEmailDetailDto;
    const broken = await render();
    expect(broken).toContain(`<p role="status">${t(K.unavailable)}</p>`);
    expect(formsOf(broken)).toEqual([]);
    api.email = { emailVerificationStatus: 'VERIFIED' } as unknown as AccountEmailDetailDto; // fields missing
    expect(formsOf(await render())).toEqual([]);
  });

  it('API down together with an error code: both the alert and the unavailable status are shown, still without forms', async () => {
    signedIn();
    api.mode = 'down';
    const html = await render({ error: 'ACCOUNT_EMAIL_CODE_INVALID' });
    expect(html).toContain(`<p role="alert">${t('account.email.error.code_invalid')}</p>`);
    expect(html).toContain(`<p role="status">${t(K.unavailable)}</p>`);
    expect(formsOf(html)).toEqual([]);
  });

  it('registry down: all copy is omitted, nothing is replaced by a hardcoded string (the page text is empty or only the masked address)', async () => {
    signedIn();
    stub.mode = 'down';
    const english = [
      'Verify your email',
      'Verification code',
      'Verify email',
      'Resend code',
      'Change email address',
      'A new code is on its way',
      'Your email address is verified',
      'Confirm your email address',
      'Select the button',
      'Not added',
      'Not verified',
      'Verified',
      'Enter a valid',
      'not correct',
      'expired',
      'unavailable',
      'Unavailable',
      'Please wait',
      'Sign in',
      'Try again',
      'Something went wrong',
      'Registry',
    ];
    const states: [string, AccountEmailDetailDto, string][] = [
      ['NONE', emailDetail(), ''],
      ['PENDING', pendingState({ resendAvailableAt: '2999-01-01T00:00:00.000Z' }), ''],
      ['REPLACEMENT_PENDING', replacementState(), 'o***@o***.test'],
      ['VERIFIED', verifiedState(), 'o***@o***.test'],
    ];
    for (const [name, email, text] of states) {
      api.email = email;
      for (const query of [{}, { ok: 'sent' }, { ok: 'verified' }, { error: 'ACCOUNT_EMAIL_CODE_INVALID' }, { error: 'API_ERROR' }]) {
        const html = await render(query);
        expect(visibleText(html), `${name} ${JSON.stringify(query)}`).toBe(text);
        expect(html).not.toContain('role="alert"');
        for (const phrase of english) expect(html, `${name}: ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it('registry down and API down: an empty page, no hardcoded "unavailable"', async () => {
    signedIn();
    stub.mode = 'down';
    api.mode = 'down';
    const html = await render({ error: 'ACCOUNT_EMAIL_CODE_INVALID' });
    expect(visibleText(html)).toBe('');
    expect(formsOf(html)).toEqual([]);
  });

  it('a key the registry does not serve omits only its own element', async () => {
    signedIn();
    api.email = pendingState({ resendAvailableAt: '2999-01-01T00:00:00.000Z' });
    const copy = structuredClone(EMAIL_COPY);
    for (const key of [K.intro, K.resendWait, K.codeLabel]) delete copy['en-US']![key];
    stub.catalog = copy;
    const html = await render();
    expect(html).toContain(`<h1>${t(K.title)}</h1>`);
    expect(html).not.toContain('<p>Registry email intro</p>');
    expect(html).not.toContain(t(K.resendWait));
    expect(html).not.toContain(t(K.codeLabel));
    // the forms keep working: the controls are structural, only their text is missing
    expect(formFor(html, '/auth/email/confirm-code').inputs[0]).toMatchObject({ name: 'code' });
    expect(formFor(html, '/auth/email/confirm-code').buttons[0]!.text).toBe(t(K.submit));
  });

  // ------------------------------------------------------------ privacy
  it('never renders a full email address, a code or a token, whatever the URL carries (all states, with extra query parameters)', async () => {
    signedIn();
    const noisy = {
      ok: 'sent',
      error: 'ACCOUNT_EMAIL_CODE_INVALID',
      code: CODE_MARKER,
      token: TOKEN_MARKER,
      email: EMAIL_MARKER,
      hash: `#token=${TOKEN_MARKER}`,
    };
    for (const email of [emailDetail(), pendingState(), pendingState({ resendAvailableAt: '2999-01-01T00:00:00.000Z' }), replacementState(), verifiedState()]) {
      api.email = email;
      stub.calls.length = 0;
      api.calls.length = 0;
      const { tree, html } = await page(noisy);
      for (const marker of [CODE_MARKER, TOKEN_MARKER, EMAIL_MARKER, 'leak.marker', 'example.test']) expect(html, marker).not.toContain(marker);
      // the only "@" in the page are masked addresses
      for (const m of html.matchAll(/[^\s<>"=]*@[^\s<>"=]*/g)) expect(m[0], 'an address in the page').toMatch(/^[a-z0-9]\*\*\*@[a-z0-9]\*\*\*\.[a-z]+$/);
      // no input is prefilled, no hidden input exists server-side (the token form is client-only), no script, no token in any link
      for (const form of formsOf(html)) for (const input of form.inputs) expect(input.value).toBeUndefined();
      expect(html).not.toContain('type="hidden"');
      expect(html).not.toContain('<script');
      expect(html).not.toMatch(/token/i);
      expect(tagsOf(html, 'a')).toEqual([]);
      // nothing from the URL went to the registry or the account API either
      expect(JSON.stringify(stub.calls)).not.toMatch(/lnk|8675309|leak\.marker/);
      expect(JSON.stringify(api.calls)).not.toMatch(/lnk|8675309|leak\.marker/);
      // the only variables ever sent are the masked address and the countdown seconds
      const variables = contentBody().variables ?? {};
      expect(JSON.stringify(variables)).not.toMatch(/example\.test|leak/);
      expect(elementsOfType(tree, LinkConfirm).every((e) => Object.keys(e.props).join() === 'copy')).toBe(true);
    }
  });

  // ------------------------------------------------------------ requests
  it('makes ONE batched content call (resolve-many) and ONE email-state call, in every state', async () => {
    signedIn();
    const scenarios: [AccountEmailDetailDto, Query][] = [
      [emailDetail(), {}],
      [pendingState(), { ok: 'sent' }],
      [pendingState({ resendAvailableAt: '2999-01-01T00:00:00.000Z' }), { error: 'ACCOUNT_EMAIL_RESEND_TOO_SOON' }],
      [replacementState(), {}],
      [verifiedState(), { ok: 'verified' }],
    ];
    for (const [email, query] of scenarios) {
      api.email = email;
      stub.calls.length = 0;
      api.calls.length = 0;
      await render(query);
      expect(stub.calls.map((c) => c.path)).toEqual(['/api/v1/content/resolve-many']);
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/account/email']);
    }
  });

  it('reads the email state with the access token of the session, the remembered active role, and nothing else (no refresh or id token)', async () => {
    signedIn({ activeRole: 'PROVIDER' });
    api.account = accountDto([CUSTOMER_ROLE, PROVIDER_ROLE]);
    api.email = pendingState();
    const html = await render();
    expect(formFor(html, '/auth/email/confirm-code').inputs).toHaveLength(1);
    expect(emailCalls()).toHaveLength(1);
    expect(emailCalls()[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/account/email',
      authorization: `Bearer ${TOKENS.access}`,
      activeRole: 'PROVIDER',
      body: undefined,
    });
    expect(JSON.stringify(api.calls)).not.toMatch(/refresh|tok-id/);
    for (const credential of Object.values(TOKENS)) expect(html).not.toContain(credential);

    // without a remembered role no role header is sent
    api.calls.length = 0;
    store.sessions.clear();
    signedIn();
    await render();
    expect(emailCalls()[0]!.activeRole).toBeUndefined();
  });

  it('asks the registry for the request locale and renders copy of the locale it answered', async () => {
    signedIn();
    api.email = emailDetail();
    await render();
    expect(contentBody().locale).toBe('en-US');
  });

  // ------------------------------------------------------------ the magic-link landing
  it('offers the magic-link landing (client component) with registry copy only while an address is pending', async () => {
    signedIn();
    for (const email of [pendingState(), replacementState()]) {
      api.email = email;
      const { tree } = await page();
      const landing = elementsOfType(tree, LinkConfirm);
      expect(landing).toHaveLength(1);
      expect(landing[0]!.props).toEqual({ copy: { title: t(K.linkTitle), body: t(K.linkBody), confirm: t(K.linkConfirm) } });
    }
    for (const email of [emailDetail(), verifiedState()]) {
      api.email = email;
      expect(elementsOfType((await page()).tree, LinkConfirm)).toEqual([]);
    }
  });

  it('omits the magic-link landing when any of its three strings is missing from the registry (never a partial or hardcoded form)', async () => {
    signedIn();
    api.email = pendingState();
    for (const missing of LINK_KEYS) {
      const copy = structuredClone(EMAIL_COPY);
      delete copy['en-US']![missing];
      stub.catalog = copy;
      expect(elementsOfType((await page()).tree, LinkConfirm), missing).toEqual([]);
    }
    stub.mode = 'down';
    expect(elementsOfType((await page()).tree, LinkConfirm)).toEqual([]);
  });
});
