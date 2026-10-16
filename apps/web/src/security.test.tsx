// ID-004 web side, part 2: the server components /security and /forgot-password and the additions to /session. The API is the account + content stub (see
// testing/account-stub.ts): the page reads the security state with the session's token, every string comes from the registry copy (SECURITY_COPY, worded unlike the
// seeded copy), and no token, secret or submitted value is ever rendered.
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_ACTIVITY_TYPES } from '@bananagig/contracts';
import ForgotPasswordPage, { dynamic as forgotDynamic, metadata as forgotMetadata } from './app/forgot-password/page';
import SecurityPage, { dynamic, metadata } from './app/security/page';
import SessionPage from './app/session/page';
import { MemorySessionStore } from './lib/auth/store';
import type { AuthDeps, SessionRecord } from './lib/auth/types';
import {
  DEVICE_ID,
  OTHER_DEVICE_ID,
  OTHER_SESSION_ID,
  SECURITY_COPY,
  SECURITY_TEXT,
  SESSION_ID,
  activityDto,
  attachAccountApi,
  devicesDto,
  overviewDto,
  sessionsDto,
  type AccountApiStub,
} from './testing/account-stub';
import { startContentStub, type ContentStub, type StubCatalog } from './testing/content-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', cookie: undefined as string | undefined, deps: undefined as unknown }));
// next/navigation: redirect() throws in Next; here the throw carries the target so a test can assert it
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
  return { serverApi: (accessToken?: string) => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-4', accessToken: () => accessToken }) };
});
vi.mock('./lib/auth/runtime', () => ({ authDeps: () => state.deps }));

const TOKENS = { access: 'tok-access-SECRET-1', refresh: 'tok-refresh-SECRET-2', id: 'tok-id-SECRET-3' };
/** The registry wording of a key. A key without copy would make every assertion on it fail loudly. */
const t = (key: string): string => SECURITY_TEXT[`account.security.${key}`] ?? `missing copy for ${key}`;

describe('security pages', () => {
  let stub: ContentStub;
  let api: AccountApiStub;
  const store = new MemorySessionStore();
  beforeAll(async () => {
    stub = await startContentStub(SECURITY_COPY);
    api = attachAccountApi(stub);
    state.deps = { cfg: { sessionCookie: 'bg_session' }, store } as unknown as AuthDeps;
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.catalog = SECURITY_COPY;
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
    renderToString(await SecurityPage({ searchParams: Promise.resolve(q) }))
      .replaceAll('<!-- -->', '')
      .replace(/<form action="([^"]*)" method="post">/g, '<form method="post" action="$1">');
  const security = (path = '') => api.calls.filter((c) => c.path.startsWith(`/api/v1/account/security${path}`));
  const catalogWithout = (...keys: string[]): StubCatalog => ({
    'en-US': Object.fromEntries(Object.entries(SECURITY_COPY['en-US']!).filter(([k]) => !keys.includes(k))),
  });
  const resolvedKeys = (): string[] => stub.calls.flatMap((c) => (c.body as { keys?: string[] }).keys ?? []);

  describe('/security: page metadata', () => {
    it('is dynamic and not indexed', () => {
      expect(dynamic).toBe('force-dynamic');
      expect(metadata).toMatchObject({ robots: { index: false, follow: false } });
    });
  });

  describe('signed out', () => {
    it('shows the registry title and the sign-in control that returns to /security; no security call is made', async () => {
      const html = await render();
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      expect(html).toContain('<a href="/auth/login?returnTo=/security">Registry sign in</a>');
      expect(security()).toEqual([]);
      expect(html).not.toContain('<form');
    });
    it('with the registry down the sign-in control still works (the bootstrap label) and nothing else is shown', async () => {
      stub.mode = 'down';
      const html = await render();
      expect(html).toContain('<a href="/auth/login?returnTo=/security">Sign in</a>');
      expect(html).not.toContain('<h1');
    });
    it('an unknown session cookie is signed out', async () => {
      state.cookie = 'bg_session=nope';
      expect(await render()).toContain('/auth/login?returnTo=/security');
    });
  });

  describe('signed in: everything comes from the registry', () => {
    it('reads the four resources with the session token (and its role) and renders the title, sections and controls with registry copy', async () => {
      signedIn({ activeRole: 'CUSTOMER' });
      const html = await render();
      for (const path of ['', '/sessions', '/devices', '/activity']) {
        const calls = api.calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === `/api/v1/account/security${path}`);
        expect(calls, path).toHaveLength(1);
        expect(calls[0]).toMatchObject({ authorization: `Bearer ${TOKENS.access}`, activeRole: 'CUSTOMER' });
      }
      expect(html).toContain(`<h1>${t('title')}</h1>`);
      for (const heading of ['mfa.title', 'sessions.title', 'devices.title', 'activity.title']) expect(html).toContain(`>${t(heading)}</h2>`);
      // the sign-out control is registry copy and posts to the logout handler
      expect(html).toContain('<form method="post" action="/auth/logout"><button type="submit">Registry sign out</button></form>');
      // one registry batch for the static copy
      expect(stub.calls.length).toBeGreaterThanOrEqual(1);
    });
    it('shows no literal English of the seeded copy and no managed word that did not come from the registry', async () => {
      signedIn();
      const html = await render();
      const text = html.replace(/<[^>]*>/g, ' ');
      for (const literal of [
        'Two-step',
        'Authenticator',
        'Recovery codes',
        'Sign out everywhere',
        'Trusted until',
        'This session',
        'Signed in',
        'Trust this browser',
      ]) {
        expect(text, literal).not.toContain(literal);
      }
    });
    it('omits every element whose copy the registry cannot serve (no literal replacement), keeping the sign-out control', async () => {
      stub.catalog = { 'en-US': { 'common.action.sign_out': { value: 'Registry sign out' } } };
      signedIn();
      const html = await render();
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('<section');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('/auth/security/');
      expect(html).toContain('>Registry sign out</button>');
    });
    it('registry down: only the bootstrap sign-out control remains and nothing crashes', async () => {
      stub.mode = 'down';
      signedIn();
      const html = await render();
      expect(html).toContain('<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>');
      expect(html).not.toContain('<h2');
      expect(html).not.toContain('/auth/security/');
    });
    it('omits one control when only its key is missing', async () => {
      stub.catalog = catalogWithout('account.security.sessions.sign_out', 'account.security.devices.remove');
      signedIn();
      const html = await render();
      expect(html).not.toContain('/auth/security/revoke-session');
      expect(html).not.toContain('/auth/security/remove-device');
      expect(html).toContain('/auth/security/revoke-all');
      expect(html).toContain('/auth/security/trust-device');
    });
  });

  describe('second factor', () => {
    it('enabled authenticator, no recovery codes: offers recovery codes (with their warning) but not a second authenticator', async () => {
      signedIn();
      const html = await render();
      expect(html).toContain(`<dt>${t('mfa.totp.label')}</dt><dd>${t('mfa.status.enabled')}</dd>`);
      expect(html).toContain(`<dt>${t('mfa.recovery.label')}</dt><dd>${t('mfa.status.disabled')}</dd>`);
      expect(html).not.toContain(t('mfa.totp.enable'));
      expect(html).toContain('<form method="post" action="/auth/security/mfa-enroll"><input type="hidden" name="method" value="RECOVERY_CODES"/>');
      expect(html).toContain(`>${t('mfa.recovery.generate')}</button>`);
      expect(html).toContain(`<p>${t('mfa.recovery.warning')}</p>`);
      expect(html).toContain(`<p>${t('mfa.stepup_note')}</p>`);
    });
    it('no authenticator yet: offers to enable it', async () => {
      api.security.overview = overviewDto({ mfa: { available: true, totpConfigured: false, recoveryCodesConfigured: false } });
      signedIn();
      const html = await render();
      expect(html).toContain(`<dt>${t('mfa.totp.label')}</dt><dd>${t('mfa.status.disabled')}</dd>`);
      expect(html).toContain('<input type="hidden" name="method" value="TOTP"/>');
      expect(html).toContain(`>${t('mfa.totp.enable')}</button>`);
    });
    it('both configured', async () => {
      api.security.overview = overviewDto({ mfa: { available: true, totpConfigured: true, recoveryCodesConfigured: true } });
      signedIn();
      const html = await render();
      expect(html).toContain(`<dt>${t('mfa.recovery.label')}</dt><dd>${t('mfa.status.enabled')}</dd>`);
    });
    it('identity provider unavailable: says "unknown" for both and offers no enrolment', async () => {
      api.security.overview = overviewDto({ mfa: { available: false, totpConfigured: false, recoveryCodesConfigured: false } });
      signedIn();
      const html = await render();
      expect(html).toContain(`<dt>${t('mfa.totp.label')}</dt><dd>${t('mfa.status.unknown')}</dd>`);
      expect(html).toContain(`<dt>${t('mfa.recovery.label')}</dt><dd>${t('mfa.status.unknown')}</dd>`);
      expect(html).not.toContain('/auth/security/mfa-enroll');
      expect(html).not.toContain(t('mfa.status.enabled'));
      expect(html).not.toContain(t('mfa.status.disabled'));
    });
    it('the overview unavailable: the section is left out, the others stay', async () => {
      api.forced['GET /account/security'] = { status: 503, code: 'ACCOUNT_SECURITY_UNAVAILABLE', category: 'DEPENDENCY' };
      signedIn();
      const html = await render();
      expect(html).not.toContain(`>${t('mfa.title')}<`);
      expect(html).toContain(`>${t('sessions.title')}</h2>`);
      expect(html).not.toContain('role="alert"');
    });
  });

  describe('sessions', () => {
    it('lists the sessions with the coarse device labels from the registry, marks the current one and lets the person sign the others out', async () => {
      signedIn();
      const html = await render();
      expect(html).toContain('Registry browser firefox · Registry os linux · Registry class desktop');
      expect(html).toContain('Registry browser safari · Registry os ios · Registry class mobile');
      expect(html).toContain(`<strong> ${t('sessions.current')}</strong>`);
      // the sign-out control of a session is a POST form with the opaque id only, and not offered for the current one
      expect(html).toContain(
        `<form method="post" action="/auth/security/revoke-session"><input type="hidden" name="sessionId" value="${OTHER_SESSION_ID}"/><button type="submit">${t('sessions.sign_out')}</button></form>`,
      );
      expect(html).not.toContain(`value="${SESSION_ID}"`);
      expect(html.match(/action="\/auth\/security\/revoke-session"/g)).toHaveLength(1);
      expect(html).toContain(
        `<form method="post" action="/auth/security/revoke-all"><button type="submit">${t('sessions.sign_out_everywhere')}</button></form>`,
      );
    });
    it('resolves the last-seen copy once per distinct instant, with the instant as the `when` variable', async () => {
      signedIn();
      await render();
      const lastSeen = stub.calls.filter((c) => (c.body as { key?: string }).key === 'account.security.sessions.last_seen');
      expect(lastSeen.map((c) => (c.body as { variables?: unknown }).variables)).toEqual(
        expect.arrayContaining([{ when: '2026-10-16 10:05Z' }, { when: '2026-10-15 18:30Z' }]),
      );
      expect(lastSeen).toHaveLength(2);
    });
    it('ALWAYS offers "sign out everywhere", even with a single session or an empty or unreadable list (it also ends sessions the API has not seen)', async () => {
      const revokeAll = `<form method="post" action="/auth/security/revoke-all"><button type="submit">${t('sessions.sign_out_everywhere')}</button></form>`;
      api.security.sessions = sessionsDto({ sessions: sessionsDto().sessions.slice(0, 1) });
      signedIn();
      let html = await render();
      expect(html).toContain(revokeAll);
      expect(html).not.toContain('/auth/security/revoke-session');
      api.security.sessions = sessionsDto({ sessions: [] });
      expect(await render()).toContain(revokeAll);
      api.forced['GET /account/security/sessions'] = { status: 503, code: 'ACCOUNT_SECURITY_UNAVAILABLE', category: 'DEPENDENCY' };
      html = await render();
      expect(html).not.toContain(`>${t('sessions.title')}<`);
      expect(html).toContain(revokeAll);
    });
    it('shows only ACTIVE sessions', async () => {
      const [current, other] = sessionsDto().sessions;
      api.security.sessions = sessionsDto({ sessions: [current!, { ...other!, status: 'REVOKED' }] });
      signedIn();
      const html = await render();
      expect(html).not.toContain(OTHER_SESSION_ID);
    });
    it('says there are none when the list is empty', async () => {
      api.security.sessions = sessionsDto({ sessions: [] });
      signedIn();
      expect(await render()).toContain(`<p>${t('sessions.empty')}</p>`);
    });
    it('says plainly when the list could not be compared with the sign-in service', async () => {
      api.security.sessions = sessionsDto({ reconciled: false });
      signedIn();
      expect(await render()).toContain(`<p role="status">${t('sessions.unreconciled')}</p>`);
      api.security.sessions = sessionsDto({ reconciled: true });
      expect(await render()).not.toContain(t('sessions.unreconciled'));
    });
    it('a session without a known device renders without device words and without a crash', async () => {
      const [current, other] = sessionsDto().sessions;
      api.security.sessions = sessionsDto({ sessions: [{ ...current!, device: null, deviceId: null }, other!] });
      signedIn();
      const html = await render();
      expect(html).toContain(`<strong> ${t('sessions.current')}</strong>`);
    });
  });

  describe('browsers (devices)', () => {
    it('the current untrusted browser can be trusted; the trusted one shows until when; each can be removed; the honest note is shown', async () => {
      signedIn();
      const html = await render();
      expect(html).toContain(`<form method="post" action="/auth/security/trust-device"><button type="submit">${t('devices.trust')}</button></form>`);
      expect(html).not.toContain('/auth/security/untrust-device'); // only the current browser can be (un)trusted, and it is not trusted
      expect(html).toContain(`<input type="hidden" name="deviceId" value="${DEVICE_ID}"/>`);
      expect(html).toContain(`<input type="hidden" name="deviceId" value="${OTHER_DEVICE_ID}"/>`);
      expect(html.match(/action="\/auth\/security\/remove-device"/g)).toHaveLength(2);
      expect(html).toContain(`<p>${t('devices.trust_note')}</p>`);
      const until = stub.calls.filter((c) => (c.body as { key?: string }).key === 'account.security.devices.trusted_until');
      expect(until.map((c) => (c.body as { variables?: unknown }).variables)).toEqual([{ date: '2026-11-14 09:00Z' }]);
      expect(html).toContain(t('devices.trusted_until'));
    });
    it('the current trusted browser can be untrusted instead', async () => {
      const d = devicesDto();
      api.security.devices = devicesDto({ devices: [{ ...d.devices[0]!, trusted: true, trustedUntil: '2026-11-01T00:00:00.000Z' }, d.devices[1]!] });
      signedIn();
      const html = await render();
      expect(html).toContain(`<form method="post" action="/auth/security/untrust-device"><button type="submit">${t('devices.untrust')}</button></form>`);
      expect(html).not.toContain('/auth/security/trust-device');
    });
    it('says there are none for an empty list', async () => {
      api.security.devices = devicesDto({ devices: [] });
      signedIn();
      const html = await render();
      expect(html).toContain(`<p>${t('devices.none')}</p>`);
      expect(html).not.toContain(t('devices.trust_note'));
    });
  });

  describe('activity', () => {
    it('shows each entry with its registry label, instant and coarse device', async () => {
      signedIn();
      const html = await render();
      expect(html).toContain('<span>Registry activity session_created</span> <time dateTime="2026-10-16T09:00:00.000Z">2026-10-16 09:00Z</time>');
      expect(html).toContain('<span>Registry activity password_changed</span> <time dateTime="2026-10-14T08:00:00.000Z">2026-10-14 08:00Z</time>');
      expect(html).toContain('Registry browser firefox · Registry os linux · Registry class desktop</span></li>');
    });
    it('requests a label for EVERY activity type the contracts define', async () => {
      const entries = SECURITY_ACTIVITY_TYPES.map((type, i) => ({
        id: `e${i}`,
        type,
        occurredAt: '2026-10-01T00:00:00.000Z',
        outcome: 'SUCCESS' as const,
        labelContentKey: 'x',
        sessionId: null,
        device: null,
      }));
      api.security.activity = activityDto({ entries });
      signedIn();
      const html = await render();
      for (const type of SECURITY_ACTIVITY_TYPES) expect(html, type).toContain(`Registry activity ${type.toLowerCase()}`);
    });
    it('uses the label key of the TYPE, never a key the API sent', async () => {
      const [first] = activityDto().entries;
      api.security.activity = activityDto({ entries: [{ ...first!, labelContentKey: 'identity.role.admin.name' }] });
      signedIn();
      await render();
      expect(resolvedKeys()).not.toContain('identity.role.admin.name');
      expect(resolvedKeys()).toContain('account.security.activity.session_created');
    });
    it('says there is none for an empty list', async () => {
      api.security.activity = activityDto({ entries: [] });
      signedIn();
      expect(await render()).toContain(`<p>${t('activity.empty')}</p>`);
    });
  });

  describe('notices and errors come from closed lists of words', () => {
    const NOTICES = [
      'session_revoked',
      'signed_out_elsewhere',
      'device_trusted',
      'device_untrusted',
      'device_removed',
      'mfa_return_success',
      'mfa_return_cancelled',
    ];
    it.each(NOTICES)('?notice=%s shows its registry message as a status', async (word) => {
      signedIn();
      expect(await render({ notice: word })).toContain(`<p role="status">Registry notice ${word}</p>`);
    });
    it('"two-factor set up" is claimed only when the overview says a factor is configured (a typed ?kc_action_status=success or ?notice= proves nothing)', async () => {
      const success = 'Registry notice mfa_return_success';
      signedIn();
      for (const q of [{ kc_action_status: 'success' }, { notice: 'mfa_return_success' }]) {
        expect(await render(q), JSON.stringify(q)).toContain(success); // default overview: authenticator configured
        for (const mfa of [
          { available: true, totpConfigured: false, recoveryCodesConfigured: false },
          { available: false, totpConfigured: true, recoveryCodesConfigured: true }, // provider down: the flags mean "unknown"
        ]) {
          api.security.overview = overviewDto({ mfa });
          const html = await render(q);
          expect(html, JSON.stringify([q, mfa])).not.toContain(success);
          expect(html).not.toContain('role="status"');
        }
        api.security.overview = overviewDto({ mfa: { available: true, totpConfigured: false, recoveryCodesConfigured: true } });
        expect(await render(q)).toContain(success); // recovery codes alone count
        api.forced['GET /account/security'] = { status: 503, code: 'ACCOUNT_SECURITY_UNAVAILABLE', category: 'DEPENDENCY' };
        expect(await render(q)).not.toContain(success); // overview unreadable
        api.forced = {};
        api.security.overview = overviewDto();
      }
      // the cancelled notice claims nothing and needs no proof
      api.security.overview = overviewDto({ mfa: { available: true, totpConfigured: false, recoveryCodesConfigured: false } });
      expect(await render({ kc_action_status: 'cancelled' })).toContain('Registry notice mfa_return_cancelled');
    });
    it('kc_action_status from the callback becomes the MFA notice; error is the generic unavailable message; anything else shows nothing', async () => {
      signedIn();
      expect(await render({ kc_action_status: 'success' })).toContain('Registry notice mfa_return_success');
      expect(await render({ kc_action_status: 'cancelled' })).toContain('Registry notice mfa_return_cancelled');
      expect(await render({ kc_action_status: 'error' })).toContain(`<p role="alert">${t('error.security_unavailable')}</p>`);
      for (const v of ['SUCCESS', 'ok', '', 'constructor', '<script>']) {
        const html = await render({ kc_action_status: v });
        expect(html, v).not.toContain('role="status"');
        expect(html, v).not.toContain('role="alert"');
      }
    });
    it.each([
      ['step_up_required', 'step_up_required'],
      ['session_revoked', 'session_revoked'],
      ['STEP_UP_REQUIRED', 'step_up_required'],
      ['SESSION_REVOKED', 'session_revoked'],
      ['MFA_ENROLLMENT_REQUIRED', 'mfa_enrollment_required'],
      ['ACCOUNT_SESSION_NOT_FOUND', 'session_not_found'],
      ['ACCOUNT_DEVICE_NOT_FOUND', 'device_not_found'],
      ['ACCOUNT_DEVICE_REQUIRED', 'device_required'],
      ['ACCOUNT_SECURITY_UNAVAILABLE', 'security_unavailable'],
    ])('?error=%s shows the registry message %s as an alert', async (word, key) => {
      signedIn();
      expect(await render({ error: word })).toContain(`<p role="alert">Registry error ${key}</p>`);
    });
    it('an unknown error word is the generic unavailable message and is never echoed (no HTML injection, no prototype names)', async () => {
      signedIn();
      for (const word of [
        'API_ERROR',
        'ACCOUNT_SUSPENDED',
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
        'a'.repeat(1000),
      ]) {
        const html = await render({ error: word });
        expect(html, word).toContain(`<p role="alert">${t('error.security_unavailable')}</p>`);
        expect(html, word).not.toContain(word);
      }
    });
    it('an unknown notice word shows nothing and is not echoed; repeated parameters are ignored', async () => {
      signedIn();
      for (const word of ['<script>', 'constructor', '__proto__', 'device_trusted ', 'DEVICE_TRUSTED', '']) {
        const html = await render({ notice: word });
        expect(html, word).not.toContain('role="status"');
        if (word) expect(html, word).not.toContain(word);
      }
      const html = await render({ notice: ['device_trusted', 'device_removed'], error: ['STEP_UP_REQUIRED', 'x'] });
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('role="alert"');
    });
    it('an error wins over a notice', async () => {
      signedIn();
      const html = await render({ error: 'STEP_UP_REQUIRED', notice: 'device_trusted' });
      expect(html).toContain('role="alert"');
      expect(html).toContain('Registry notice device_trusted'); // both can show; the alert comes first
      expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('role="status"'));
    });
  });

  describe('API failures', () => {
    it('one resource failing leaves that section out, the rest stays, and no raw error is shown', async () => {
      api.forced['GET /account/security/devices'] = { status: 503, code: 'ACCOUNT_SECURITY_UNAVAILABLE', category: 'DEPENDENCY' };
      signedIn();
      const html = await render();
      expect(html).not.toContain(`>${t('devices.title')}<`);
      expect(html).toContain(`>${t('sessions.title')}</h2>`);
      expect(html).not.toContain('ACCOUNT_SECURITY_UNAVAILABLE');
    });
    it('everything failing shows the generic unavailable message and still the sign-out control', async () => {
      api.mode = 'down';
      signedIn();
      const html = await render();
      expect(html).toContain(`<p role="alert">${t('error.security_unavailable')}</p>`);
      expect(html).toContain('action="/auth/logout"');
      expect(html).not.toContain('<section');
    });
    it('a response that violates the contract is treated as unavailable, not as a crash', async () => {
      api.security.devices = { devices: [{ nonsense: true }] } as never;
      signedIn();
      const html = await render();
      expect(html).not.toContain(`>${t('devices.title')}<`);
      expect(html).toContain(`>${t('sessions.title')}</h2>`);
    });
    it('a revoked session redirects to /auth/revoked (a page cannot clear a cookie), from any of the four reads', async () => {
      api.revoked = true;
      signedIn();
      await expect(render()).rejects.toMatchObject({ target: '/auth/revoked' });
      expect(store.sessions.has('sid1')).toBe(true); // the page itself deletes nothing: /auth/revoked re-checks first
      api.revoked = false;
      for (const route of ['GET /account/security', 'GET /account/security/sessions', 'GET /account/security/devices', 'GET /account/security/activity']) {
        api.forced = { [route]: { status: 401, code: 'SESSION_REVOKED', category: 'AUTHENTICATION' } };
        await expect(render(), route).rejects.toMatchObject({ target: '/auth/revoked' });
      }
    });
    it('another 401 is just an unavailable section', async () => {
      api.forced['GET /account/security/sessions'] = { status: 401, code: 'STEP_UP_REQUIRED', category: 'AUTHENTICATION' };
      signedIn();
      const html = await render();
      expect(html).not.toContain(`>${t('sessions.title')}<`);
    });
  });

  describe('secrets', () => {
    it('no token, refresh token, id token, session id or cookie value appears in the HTML; only opaque ids in hidden fields', async () => {
      signedIn();
      const html = await render({ notice: 'device_trusted' });
      for (const secret of [TOKENS.access, TOKENS.refresh, TOKENS.id, 'sid1', 'bg_session', 'bg_device', 'user-1']) expect(html, secret).not.toContain(secret);
      const hidden = [...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)"\/>/g)].map((m) => `${m[1]}=${m[2]}`).sort();
      expect(hidden).toEqual([`deviceId=${DEVICE_ID}`, `deviceId=${OTHER_DEVICE_ID}`, `method=RECOVERY_CODES`, `sessionId=${OTHER_SESSION_ID}`].sort());
    });
    it('every form is a POST to a same-origin BFF path and there is no GET link that changes state', async () => {
      signedIn();
      const html = await render();
      const forms = [...html.matchAll(/<form ([^>]*)>/g)].map((m) => m[1]);
      expect(forms.length).toBeGreaterThan(5);
      for (const f of forms) expect(f).toMatch(/^method="post" action="\/auth\/(security\/[a-z-]+|logout)"$/);
      expect(html).not.toMatch(/<a /);
      expect(html).not.toContain('javascript:');
    });
  });

  describe('/forgot-password', () => {
    const renderForgot = async (q: Record<string, string | string[] | undefined> = {}) =>
      renderToString(await ForgotPasswordPage({ searchParams: Promise.resolve(q) }))
        .replaceAll('<!-- -->', '')
        .replace(/<form action="([^"]*)" method="post">/g, '<form method="post" action="$1">');
    const text = (key: string) => SECURITY_TEXT[`account.password_reset.${key}`] ?? `missing copy for ${key}`;

    it('is dynamic, not indexed, and sends no referrer', () => {
      expect(forgotDynamic).toBe('force-dynamic');
      expect(forgotMetadata).toMatchObject({ referrer: 'no-referrer', robots: { index: false, follow: false } });
    });
    it('shows the registry title, intro, a POST form with only an email field, and the way back to sign-in; needs no session and makes no API call but content', async () => {
      const html = await renderForgot();
      expect(html).toContain(`<h1>${text('title')}</h1>`);
      expect(html).toContain(`<p>${text('intro')}</p>`);
      expect(html).toContain('<form method="post" action="/auth/password-reset">');
      expect(html).toContain(`<label>${text('email_label')}<input type="email" autoComplete="email" maxLength="320" required="" name="email"/></label>`);
      expect(html).toContain(`<button type="submit">${text('submit')}</button>`);
      expect(html).toContain(`<a href="/auth/login?returnTo=/session">${text('back_to_sign_in')}</a>`);
      expect(html.match(/<input /g)).toHaveLength(1);
      expect(html).not.toContain('role="alert"');
      expect(api.calls).toEqual([]);
    });
    it.each([
      ['accepted', 'status', 'accepted'],
      ['invalid', 'alert', 'error.invalid_email'],
      ['rate_limited', 'alert', 'error.rate_limited'],
    ])('?status=%s shows the registry message as a %s', async (word, role, key) => {
      expect(await renderForgot({ status: word })).toContain(`<p role="${role}">${text(key)}</p>`);
    });
    it('?status=unavailable shows the generic unavailable message of the security copy', async () => {
      expect(await renderForgot({ status: 'unavailable' })).toContain(`<p role="alert">${t('error.security_unavailable')}</p>`);
    });
    it('unknown status words, prototype names, repeats and an email in the query show nothing and are never echoed', async () => {
      for (const q of [
        { status: 'nope' },
        { status: 'constructor' },
        { status: '__proto__' },
        { status: ['accepted', 'invalid'] },
        { status: '<script>' },
        { status: 'ACCEPTED' },
        { email: 'leak.marker@example.test' },
        {},
      ]) {
        const html = await renderForgot(q as Record<string, string>);
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('role="status"');
        expect(html).not.toContain('leak.marker');
        expect(html).not.toContain('<script>');
      }
    });
    it('registry down: the form fields and the bootstrap sign-in link remain, no managed copy', async () => {
      stub.mode = 'down';
      const html = await renderForgot({ status: 'accepted' });
      expect(html).toContain('name="email"');
      expect(html).toContain('<a href="/auth/login?returnTo=/session">Sign in</a>');
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('<button');
    });
  });

  describe('/session: the additions of ID-004', () => {
    const renderSession = async (error?: string) =>
      renderToString(await SessionPage({ searchParams: Promise.resolve({ error }) }))
        .replaceAll('<!-- -->', '')
        .replace(/<form action="([^"]*)" method="post">/g, '<form method="post" action="$1">');

    it('signed out: links to /forgot-password with registry copy', async () => {
      const html = await renderSession();
      expect(html).toContain(`<a href="/forgot-password">${SECURITY_TEXT['account.password_reset.title']}</a>`);
    });
    it('signed out after a revoked session: the registry message is an alert', async () => {
      const html = await renderSession('session_revoked');
      expect(html).toContain(`<p role="alert">${t('error.session_revoked')}</p>`);
    });
    it('an unknown error word shows no alert and is not echoed', async () => {
      for (const word of ['constructor', '<script>', 'role', 'x']) {
        const html = await renderSession(word);
        expect(html, word).not.toContain('role="alert"');
        expect(html, word).not.toContain(word === 'x' || word === 'role' ? 'zzz' : word);
      }
    });
    it('signed in: links to /security with registry copy', async () => {
      signedIn();
      const html = await renderSession();
      expect(html).toContain(`<a href="/security">${t('title')}</a>`);
      expect(html).not.toContain('/forgot-password');
    });
    it('signed in with the registry down: no /security link (managed copy is omitted)', async () => {
      stub.mode = 'down';
      signedIn();
      expect(await renderSession()).not.toContain('/security');
    });
    it('signed in but revoked: redirects to /auth/revoked', async () => {
      api.revoked = true;
      signedIn();
      await expect(renderSession()).rejects.toMatchObject({ target: '/auth/revoked' });
    });
  });
});
