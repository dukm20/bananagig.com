// ID-004 integration tests against a REAL Keycloak and Mailpit (pnpm dev:deps starts keycloak-auth on 127.0.0.1:18081 and mailpit-email, API on 127.0.0.1:18025).
// They cover what the realm configuration (infra/keycloak/bananagig-realm.json) promises for sessions, MFA and recovery, and the Keycloak admin client the security
// layer uses: the web-client token claims, the OTP floor (a user with a second factor is challenged even when the request carries no acr_values), recovery codes
// (single use, in sequence), the service-account client (client credentials, manage-users), listing and ending protocol sessions, and the password-reset email.
//
// Realm: KEYCLOAK_ITEST_REALM (default `bananagig`, the realm imported from the repository file). Point it at a scratch realm built from the same file to run without
// touching the development realm. Every user created here is throwaway (removed in afterAll together with its sessions and its Mailpit messages).
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  KeycloakAdminClient,
  KeycloakAdminError,
  oidcEndpoints,
  randomToken,
  refreshTokenSet,
  type TokenSet,
} from './index';
import { DEV_USERS, TEST_PUBLIC_URL, WEB_REDIRECT_URI } from './testing';

const KC = (process.env.KEYCLOAK_ITEST_URL ?? 'http://127.0.0.1:18081').replace(/\/$/, '');
const REALM = process.env.KEYCLOAK_ITEST_REALM ?? 'bananagig';
const MAILPIT = (process.env.MAILPIT_API_URL ?? process.env.MAILPIT_URL ?? 'http://127.0.0.1:18025').replace(/\/$/, '');
/** Development value of KEYCLOAK_SECURITY_CLIENT_SECRET in packages/config (the realm file carries the same). */
const SECURITY_SECRET = process.env.KEYCLOAK_SECURITY_CLIENT_SECRET ?? 'bananagig_security_dev_only_secret_0001';
const SECURITY_CLIENT = process.env.KEYCLOAK_SECURITY_CLIENT_ID ?? 'bananagig-security';
const WEB = 'bananagig-web';
const RESET_RETURN_URI = 'http://app.localhost:8080/session';
const THROWAWAY_PASSWORD = 'dev_only_itest_password_0001';
const ACR_PASSWORD = 'bananagig:password';
const ACR_MFA = 'bananagig:mfa';

const ep = oidcEndpoints({ publicUrl: TEST_PUBLIC_URL, internalUrl: KC, realm: REALM });
/** Claims an access token may carry. Anything else (email, phone, name, preferred_username, amr...) violates claim minimization. */
const ALLOWED_ACCESS_CLAIMS = ['acr', 'aud', 'auth_time', 'azp', 'exp', 'iat', 'iss', 'jti', 'realm_access', 'resource_access', 'scope', 'sid', 'sub', 'typ'];
const PII_CLAIMS = ['email', 'email_verified', 'name', 'given_name', 'family_name', 'preferred_username', 'phone_number', 'address', 'amr'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rewrite = (url: string): string => url.replace(TEST_PUBLIC_URL, KC);
const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#61;/g, '=')
    .replace(/&quot;/g, '"');
const form = (o: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o),
});

// ------------------------------------------------------------------------------------------------------------------ admin REST (master realm, dev credentials)
let adminToken = '';
async function masterToken(): Promise<string> {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    ...form({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin_dev_only',
    }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`admin login failed (${res.status})`);
  return json.access_token;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function admin(path: string, o: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${KC}/admin/realms/${REALM}${path}`, {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${adminToken}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// ------------------------------------------------------------------------------------------------------------------ TOTP (RFC 6238, HmacSHA1)
// Keycloak uses the ASCII bytes of the stored secret string as the HMAC key. It accepts counters c-1..c+1 (look-ahead 1) and refuses a counter at or below the last accepted
// one, so the test remembers the last counter it used per secret and waits for the next 30 s window when the three codes of a window are spent.
const lastCounter = new Map<string, number>();
function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, '0');
}
async function nextTotp(secret: string): Promise<string> {
  for (;;) {
    const c = Math.floor(Date.now() / 30_000);
    const pick = Math.max(c - 1, (lastCounter.get(secret) ?? 0) + 1);
    if (pick <= c + 1) {
      lastCounter.set(secret, pick);
      return totpAt(secret, pick);
    }
    await sleep(1000);
  }
}

// ------------------------------------------------------------------------------------------------------------------ browser-flow driver (no browser: forms are parsed and posted)
class Jar {
  private c = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.c.delete(name);
      else this.c.set(name, value);
    }
  }
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
type PageKind =
  | 'login'
  | 'login-password-only'
  | 'select-credential'
  | 'otp'
  | 'recovery-code'
  | 'update-password'
  | 'configure-recovery'
  | 'action-proceed'
  | 'error'
  | 'other';
function pageKind(html: string): PageKind {
  const names = new Set([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!));
  if (names.has('password') && names.has('username')) return 'login';
  if (names.has('password') && !names.has('username')) return 'login-password-only';
  if (/id="kc-select-credential-form"/.test(html)) return 'select-credential';
  if (names.has('otp')) return 'otp';
  if (names.has('recoveryCodeInput')) return 'recovery-code';
  if (names.has('password-new')) return 'update-password';
  if (names.has('generatedRecoveryAuthnCodes')) return 'configure-recovery';
  if (/<a [^>]*href="[^"]*action-token\?key=/.test(html) && !/<form/.test(html)) return 'action-proceed';
  if (/<title>[^<]*error/i.test(html) || /kc-error-message/.test(html)) return 'error';
  return 'other';
}
interface Creds {
  user?: string;
  pw?: string;
  /** Answer for the OTP page. Without it the driver stops at that page. */
  otp?: () => Promise<string>;
  /** Use recovery codes instead of OTP: the numbered code to type for "Recovery code #n". */
  recovery?: (n: number) => string;
  newPw?: string;
  stopAt?: ReadonlySet<PageKind>;
}
interface DriveResult {
  done: boolean;
  /** The final redirect to the application (callback) when `done`. */
  location?: string;
  html?: string;
  kind?: PageKind;
  action?: string;
  /** The server re-rendered the page that was just answered (a refusal). */
  rejected?: boolean;
  jar: Jar;
}
async function drive(
  startUrl: string,
  creds: Creds,
  jar = new Jar(),
  isCallback: (loc: string) => boolean = (l) => l.startsWith(WEB_REDIRECT_URI),
): Promise<DriveResult> {
  let url = startUrl;
  let lastPosted: PageKind | undefined;
  let curExec: string | undefined;
  let pending: Response | undefined;
  const post = async (action: string, body: Record<string, string>): Promise<Response> => {
    const r = await fetch(rewrite(action), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams(body),
    });
    jar.absorb(r);
    return r;
  };
  for (let i = 0; i < 16; i++) {
    const r = pending ?? (await fetch(url, { redirect: 'manual', headers: { cookie: jar.header() } }));
    if (!pending) jar.absorb(r);
    pending = undefined;
    const loc = r.headers.get('location');
    if (loc) {
      if (isCallback(loc)) return { done: true, location: loc, jar };
      url = rewrite(new URL(loc, url).toString());
      continue;
    }
    const html = await r.text();
    const kind = pageKind(html);
    const action = decodeHtml(html.match(/<form[^>]*\baction="([^"]+)"/i)?.[1] ?? '');
    if (kind === 'action-proceed' && !creds.stopAt?.has(kind)) {
      url = rewrite(decodeHtml(html.match(/<a [^>]*href="([^"]*action-token\?key=[^"]*)"/)![1]!));
      continue;
    }
    if (creds.stopAt?.has(kind) || !action) return { done: false, html, kind, action, jar };
    if (kind === lastPosted) return { done: false, html, kind, action, rejected: true, jar }; // never hammer: brute-force protection counts every failure
    let body: Record<string, string>;
    if (kind === 'login') body = { username: creds.user ?? '', password: creds.pw ?? '', credentialId: '' };
    else if (kind === 'login-password-only') body = { password: creds.pw ?? '', credentialId: '' };
    else if (kind === 'otp' && creds.recovery) {
      // "Try another way" -> select the recovery-code alternative
      const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const tf = forms.find((f) => /name="tryAnotherWay"/.test(f));
      if (!tf) return { done: false, html, kind, action, jar };
      pending = await post(decodeHtml(tf.match(/action="([^"]+)"/)![1]!), { tryAnotherWay: 'on' });
      curExec = decodeHtml(action).match(/execution=([^&]+)/)?.[1];
      continue;
    } else if (kind === 'select-credential') {
      const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
      const pick = forms.map((f) => ({ id: f.match(/name="authenticationExecution" value="([^"]+)"/)?.[1] })).find((x) => x.id && x.id !== curExec);
      if (!pick?.id) return { done: false, html, kind, action, jar };
      pending = await post(action, { authenticationExecution: pick.id });
      continue;
    } else if (kind === 'otp') {
      if (!creds.otp) return { done: false, html, kind, action, jar };
      body = { otp: await creds.otp(), selectedCredentialId: html.match(/name="selectedCredentialId"[^>]*value="([^"]*)"/)?.[1] ?? '' };
    } else if (kind === 'recovery-code') {
      if (!creds.recovery) return { done: false, html, kind, action, jar };
      const n = Number(html.match(/Recovery code #(\d+)/)?.[1] ?? 0); // Keycloak asks for a specific NUMBERED code, in order
      body = { recoveryCodeInput: creds.recovery(n) };
    } else if (kind === 'update-password') {
      body = { 'password-new': creds.newPw ?? '', 'password-confirm': creds.newPw ?? '' };
    } else return { done: false, html, kind, action, jar };
    lastPosted = kind;
    pending = await post(action, body);
  }
  return { done: false, jar };
}

interface WebLogin {
  result: DriveResult;
  verifier: string;
  nonce: string;
}
/** Starts an Authorization Code + PKCE request for bananagig-web (the same URL builder the web server uses) and drives the login. */
async function webLogin(
  creds: Creds,
  o: { prompt?: 'login'; maxAge?: number; acrValues?: string; kcAction?: string; jar?: Jar; rawParams?: Record<string, string> } = {},
): Promise<WebLogin> {
  const verifier = generateCodeVerifier();
  const nonce = randomToken(16);
  const url = buildAuthorizeUrl({
    authorizationEndpoint: ep.authorization,
    clientId: WEB,
    redirectUri: WEB_REDIRECT_URI,
    state: randomToken(16),
    nonce,
    codeChallenge: codeChallengeS256(verifier),
    prompt: o.prompt,
    maxAge: o.maxAge,
    acrValues: o.acrValues,
    kcAction: o.kcAction,
  });
  // raw parameters bypass the whitelist of buildAuthorizeUrl: they model what a user can type into the address bar
  const full = new URL(url);
  for (const [k, v] of Object.entries(o.rawParams ?? {})) full.searchParams.set(k, v);
  return { result: await drive(rewrite(full.toString()), creds, o.jar ?? new Jar()), verifier, nonce };
}
async function tokensOf(l: WebLogin): Promise<TokenSet> {
  if (!l.result.done || !l.result.location) throw new Error(`login did not reach the callback (page ${l.result.kind ?? 'unknown'})`);
  const code = new URL(l.result.location).searchParams.get('code');
  if (!code) throw new Error('callback without a code');
  return exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId: WEB, redirectUri: WEB_REDIRECT_URI, code, codeVerifier: l.verifier });
}
const refresh = (refreshToken: string): Promise<TokenSet> => refreshTokenSet({ tokenEndpoint: ep.token, clientId: WEB, refreshToken });
const failure = <T>(p: Promise<T>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

// ------------------------------------------------------------------------------------------------------------------ Mailpit (minimal; the production adapter sent the mail)
async function mailpit<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MAILPIT}/api/v1${path}`, init);
  if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path.split('?')[0]} answered ${res.status}`);
  return (await res.json()) as T;
}
interface MailMessage {
  to: string[];
  from: string;
  subject: string;
  body: string;
}
async function waitForMail(to: string, timeoutMs = 15_000): Promise<MailMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await mailpit<{ messages: { ID: string }[] | null }>(`/search?query=${encodeURIComponent(`to:"${to}"`)}`).catch(() => ({ messages: null }));
    const first = found.messages?.[0];
    if (first) {
      const d = await mailpit<{ To: { Address: string }[]; From: { Address: string }; Subject: string; Text: string; HTML: string }>(`/message/${first.ID}`);
      return { to: d.To.map((t) => t.Address), from: d.From.Address, subject: d.Subject, body: decodeHtml(`${d.HTML}\n${d.Text}`) };
    }
    if (Date.now() > deadline) throw new Error('no message arrived in Mailpit');
    await sleep(250);
  }
}
const deleteMail = (to: string): Promise<unknown> =>
  fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`, { method: 'DELETE' }).catch(() => undefined);

// ------------------------------------------------------------------------------------------------------------------ throwaway users
interface Throwaway {
  id: string;
  username: string;
  email: string;
  otpSecret?: string;
}
const created: Throwaway[] = [];
const runId = randomBytes(4).toString('hex');
async function createUser(label: string, o: { withOtp?: boolean } = {}): Promise<Throwaway> {
  const username = `itest-sec-${label}-${runId}`;
  const email = `${username}@bananagig.localhost`;
  const otpSecret = o.withOtp ? `ItestSecret${randomBytes(8).toString('hex')}` : undefined;
  const credentials: unknown[] = [{ type: 'password', value: THROWAWAY_PASSWORD, temporary: false }];
  if (otpSecret)
    credentials.push({
      type: 'otp',
      userLabel: 'itest-authenticator',
      secretData: JSON.stringify({ value: otpSecret }),
      credentialData: JSON.stringify({ subType: 'totp', digits: 6, period: 30, algorithm: 'HmacSHA1', counter: 0 }),
    });
  const res = await admin('/users', {
    method: 'POST',
    body: { username, email, firstName: 'Itest', lastName: 'Throwaway', enabled: true, emailVerified: true, credentials },
  });
  if (res.status !== 201) throw new Error(`creating the throwaway user failed (${res.status})`);
  const found = await admin(`/users?username=${encodeURIComponent(username)}&exact=true`);
  const id = found.json?.[0]?.id as string | undefined;
  if (!id) throw new Error('throwaway user not found after creation');
  const u: Throwaway = { id, username, email, otpSecret };
  created.push(u);
  return u;
}
const creds = (u: Throwaway, extra: Partial<Creds> = {}): Creds => ({ user: u.username, pw: THROWAWAY_PASSWORD, ...extra });
const sidOf = (t: TokenSet): string => decodeJwt(t.accessToken).sid as string;

function securityClient(secret = SECURITY_SECRET): KeycloakAdminClient {
  return new KeycloakAdminClient({
    baseUrl: KC,
    realm: REALM,
    clientId: SECURITY_CLIENT,
    clientSecret: secret,
    resetEmail: { clientId: WEB, redirectUri: RESET_RETURN_URI },
  });
}

beforeAll(async () => {
  adminToken = await masterToken();
  expect(adminToken).toBeTruthy();
  // the realm under test must be the ID-004 one (a stale realm needs `pnpm identity:sync`)
  const r = (await admin('')).json;
  expect(r?.realm, `realm ${REALM} not found`).toBe(REALM);
  expect(r.rememberMe, 'stale realm: run pnpm identity:sync').toBe(true);
});

afterAll(async () => {
  adminToken = await masterToken().catch(() => adminToken);
  for (const u of created) {
    await admin(`/users/${u.id}`, { method: 'DELETE' }).catch(() => undefined); // removes its sessions with it
    await deleteMail(u.email);
  }
});

// ================================================================================================================== claims
describe('web client token claims (live)', () => {
  it('carries sid, auth_time and acr bananagig:password for a user without OTP; no amr and no personal data', async () => {
    const u = await createUser('claims');
    const t0 = Math.floor(Date.now() / 1000);
    const l = await webLogin(creds(u));
    expect(l.result.done).toBe(true); // password only: no second factor, no forced enrolment
    const tokens = await tokensOf(l);
    const a = decodeJwt(tokens.accessToken);
    expect(typeof a.sid).toBe('string');
    expect((a.sid as string).length).toBeGreaterThan(10);
    expect(a.acr).toBe(ACR_PASSWORD);
    expect(typeof a.auth_time).toBe('number');
    expect(Math.abs((a.auth_time as number) - t0)).toBeLessThanOrEqual(30);
    expect(a.azp).toBe(WEB);
    expect(Object.keys(a).filter((k) => !ALLOWED_ACCESS_CLAIMS.includes(k))).toEqual([]);
    for (const k of PII_CLAIMS) expect(a, k).not.toHaveProperty(k);
    const id = decodeJwt(tokens.idToken!);
    expect(id.sid).toBe(a.sid);
    expect(id.acr).toBe(ACR_PASSWORD);
    for (const k of PII_CLAIMS) expect(id, k).not.toHaveProperty(k);
    expect(JSON.stringify(a)).not.toContain(u.username);
    expect(JSON.stringify(a)).not.toContain(u.email);
  });

  it('a request for the password level (acr_values=bananagig:password) cannot lower the OTP floor', async () => {
    const u = await createUser('floor-low', { withOtp: true });
    const l = await webLogin(creds(u, { stopAt: new Set<PageKind>(['otp']) }), { acrValues: ACR_PASSWORD });
    expect(l.result.kind).toBe('otp');
  }, 60_000);

  it('the post-logout redirect URI used for a revoked session (with its query string) is accepted, a different query string is not', async () => {
    const u = await createUser('postlogout');
    const tokens = await tokensOf(await webLogin(creds(u)));
    const logout = (uri: string): Promise<Response> => {
      const url = new URL(`${KC}/realms/${REALM}/protocol/openid-connect/logout`);
      url.searchParams.set('id_token_hint', tokens.idToken!);
      url.searchParams.set('post_logout_redirect_uri', uri);
      return fetch(url, { redirect: 'manual' });
    };
    const bad = await logout('http://app.localhost:8080/session?error=other');
    expect(bad.status).toBe(400);
    const ok = await logout('http://app.localhost:8080/session?error=session_revoked');
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('http://app.localhost:8080/session?error=session_revoked');
  });
});

// ================================================================================================================== the admin client
describe('KeycloakAdminClient against the real server (client credentials, manage-users)', () => {
  it('getUserSecurity: customer.dev has no OTP and no recovery codes, an email and a password date', async () => {
    const found = await admin(`/users?username=${DEV_USERS.customer.username}&exact=true`);
    const sub = found.json?.[0]?.id as string;
    expect(sub).toBeTruthy();
    const s = await securityClient().getUserSecurity(sub);
    expect(s.otpConfigured).toBe(false);
    expect(s.recoveryCodesConfigured).toBe(false);
    expect(s.email).toBe('customer.dev@bananagig.localhost');
    expect(s.passwordChangedAt).toBeInstanceOf(Date);
  });

  it('refuses a wrong client secret with TOKEN_REJECTED and does not leak the secret', async () => {
    const wrong = 'not-the-secret-not-the-secret-not-the-secret';
    const err = await failure(securityClient(wrong).getUserSecurity('00000000-0000-0000-0000-000000000000'));
    expect(err).toBeInstanceOf(KeycloakAdminError);
    expect((err as KeycloakAdminError).code).toBe('TOKEN_REJECTED');
    expect(String(err)).not.toContain(wrong);
  });

  it('the service account is confidential with client credentials only: no password grant, no browser flow, no refresh token', async () => {
    const pw = await fetch(
      ep.token,
      form({
        grant_type: 'password',
        client_id: SECURITY_CLIENT,
        client_secret: SECURITY_SECRET,
        username: 'customer.dev',
        password: 'dev_only_customer_password',
      }),
    );
    expect([400, 401]).toContain(pw.status);
    expect(((await pw.json()) as { access_token?: string }).access_token).toBeUndefined();
    const cc = await fetch(ep.token, form({ grant_type: 'client_credentials', client_id: SECURITY_CLIENT, client_secret: SECURITY_SECRET }));
    expect(cc.status).toBe(200);
    const body = (await cc.json()) as { access_token: string; refresh_token?: string };
    expect(body.refresh_token).toBeUndefined();
    const roles = (decodeJwt(body.access_token).resource_access as Record<string, { roles: string[] }>)['realm-management']?.roles;
    expect(roles).toEqual(['manage-users']);
    const anon = await fetch(ep.token, form({ grant_type: 'client_credentials', client_id: SECURITY_CLIENT }));
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });

  it('listSessions sees two independent logins; endSession ends exactly one; endAllSessions ends the rest', async () => {
    const u = await createUser('sessions');
    const kc = securityClient();
    const a = await tokensOf(await webLogin(creds(u))); // independent browsers: two cookie jars
    const b = await tokensOf(await webLogin(creds(u)));
    const sidA = sidOf(a);
    const sidB = sidOf(b);
    expect(sidA).not.toBe(sidB);
    const listed = await kc.listSessions(u.id);
    expect(listed.map((s) => s.id).sort()).toEqual([sidA, sidB].sort());
    for (const s of listed) {
      expect(s.startedAt).toBeInstanceOf(Date);
      expect(s.lastAccessAt.getTime()).toBeGreaterThanOrEqual(s.startedAt.getTime());
    }

    await kc.endSession(sidA);
    expect(await failure(refresh(a.refreshToken))).toMatchObject({ category: 'invalid_grant' });
    const b2 = await refresh(b.refreshToken); // the other session still refreshes
    expect(sidOf(b2)).toBe(sidB);
    expect((await kc.listSessions(u.id)).map((s) => s.id)).toEqual([sidB]);
    await kc.endSession(sidA); // already gone: success (404 is the desired state)
    await kc.endSession('00000000-0000-0000-0000-000000000000');

    await kc.endAllSessions(u.id);
    expect(await failure(refresh(b2.refreshToken))).toMatchObject({ category: 'invalid_grant' });
    expect(await kc.listSessions(u.id)).toEqual([]);
  }, 60_000);

  it('sendPasswordResetEmail: the message reaches Mailpit, the link expires after the lifespan and works exactly once', async () => {
    const u = await createUser('reset');
    await deleteMail(u.email);
    const kc = securityClient();
    const sentAt = Math.floor(Date.now() / 1000);
    await kc.sendPasswordResetEmail(u.id, { lifespanSeconds: 3600 });

    const mail = await waitForMail(u.email);
    expect(mail.to).toEqual([u.email]);
    expect(mail.from).toBe('no-reply@bananagig.localhost');
    const link = /https?:\/\/[^\s"'<>]+\/login-actions\/action-token\?[^\s"'<>]+/.exec(mail.body)?.[0];
    expect(link).toBeTruthy();
    expect(link).toContain(`${TEST_PUBLIC_URL}/realms/${REALM}/login-actions/action-token`);
    const key = new URL(link!).searchParams.get('key')!;
    const payload = JSON.parse(Buffer.from(key.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number; typ: string };
    expect(payload.typ).toBe('execute-actions');
    expect(Math.abs(payload.exp - sentAt - 3600)).toBeLessThanOrEqual(30);

    // the first click leads to the UPDATE_PASSWORD form; completing it changes the password
    const newPassword = 'Brand-new-itest-pw-0001';
    const first = await drive(rewrite(link!), { newPw: newPassword });
    expect(first.done).toBe(false); // the user is NOT logged in afterwards
    expect(first.kind).not.toBe('update-password'); // the form was answered and accepted
    const loggedIn = await webLogin({ user: u.username, pw: newPassword });
    expect(loggedIn.result.done).toBe(true);
    expect(await failure(webLoginDone(u, THROWAWAY_PASSWORD))).toBeDefined(); // the old password no longer works

    // the SAME link is dead now
    const second = await drive(rewrite(link!), { newPw: 'Another-itest-pw-0002' });
    expect(second.done).toBe(false);
    expect(second.kind).not.toBe('update-password');
    const stillFirst = await webLogin({ user: u.username, pw: newPassword });
    expect(stillFirst.result.done).toBe(true); // the second attempt changed nothing
  }, 60_000);

  it('sendPasswordResetEmail honours a shorter lifespan and refuses an invalid one without sending', async () => {
    const u = await createUser('reset-short');
    await deleteMail(u.email);
    const kc = securityClient();
    const sentAt = Math.floor(Date.now() / 1000);
    await kc.sendPasswordResetEmail(u.id, { lifespanSeconds: 600 });
    const mail = await waitForMail(u.email);
    const link = /https?:\/\/[^\s"'<>]+\/login-actions\/action-token\?[^\s"'<>]+/.exec(mail.body)![0];
    const exp = (JSON.parse(Buffer.from(new URL(link).searchParams.get('key')!.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number }).exp;
    expect(Math.abs(exp - sentAt - 600)).toBeLessThanOrEqual(30);
    expect(await failure(kc.sendPasswordResetEmail(u.id, { lifespanSeconds: 0 }))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sendPasswordResetEmail for a user without an email is BAD_REQUEST and sends nothing', async () => {
    const u = await createUser('reset-noemail');
    await admin(`/users/${u.id}`, { method: 'PUT', body: { email: '' } });
    expect(await failure(securityClient().sendPasswordResetEmail(u.id, { lifespanSeconds: 3600 }))).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/** Password login that must reach the callback; rejects otherwise. */
async function webLoginDone(u: Throwaway, password: string): Promise<void> {
  const l = await webLogin({ user: u.username, pw: password });
  if (!l.result.done) throw new Error('login refused');
}

// ================================================================================================================== second factor and recovery codes
describe('second factor floor and recovery codes (live)', () => {
  it('a user WITH OTP is challenged at login although the request carries NO acr_values; afterwards acr is bananagig:mfa', async () => {
    const u = await createUser('otp', { withOtp: true });
    const secret = u.otpSecret!;
    // probe: no acr_values, no prompt, no max_age -> the OTP page is shown (nothing is consumed)
    const probe = await webLogin(creds(u, { stopAt: new Set<PageKind>(['otp']) }));
    expect(probe.result.done).toBe(false);
    expect(probe.result.kind).toBe('otp');

    const l = await webLogin(creds(u, { otp: () => nextTotp(secret) }));
    expect(l.result.done).toBe(true);
    const tokens = await tokensOf(l);
    const claims = decodeJwt(tokens.accessToken);
    expect(claims.acr).toBe(ACR_MFA);
    expect(claims).not.toHaveProperty('amr');

    // the SSO cookie of that browser keeps the level: a second request in the same browser needs no new OTP and is still mfa
    const sso = await webLogin(creds(u), { jar: l.result.jar });
    expect(sso.result.done).toBe(true);
    expect(decodeJwt((await tokensOf(sso)).accessToken).acr).toBe(ACR_MFA);

    // the factor is visible to the admin client
    const s = await securityClient().getUserSecurity(u.id);
    expect(s).toMatchObject({ otpConfigured: true, recoveryCodesConfigured: false, email: u.email });
  }, 90_000);

  it('a wrong code is refused; prompt=login re-asks password and OTP for the same session and moves auth_time forward', async () => {
    const u = await createUser('otp-prompt', { withOtp: true });
    const secret = u.otpSecret!;
    const wrong = await webLogin(creds(u, { otp: async () => '000000' }));
    expect(wrong.result.done).toBe(false);
    expect(wrong.result.rejected).toBe(true);

    const first = await webLogin(creds(u, { otp: () => nextTotp(secret) }));
    const t1 = await tokensOf(first);
    await sleep(2100); // auth_time has one-second resolution
    const again = await webLogin(creds(u, { otp: () => nextTotp(secret) }), { prompt: 'login', jar: first.result.jar });
    expect(again.result.done).toBe(true);
    const t2 = await tokensOf(again);
    expect(sidOf(t2)).toBe(sidOf(t1));
    expect(decodeJwt(t2.accessToken).auth_time as number).toBeGreaterThan(decodeJwt(t1.accessToken).auth_time as number);
    expect(decodeJwt(t2.accessToken).acr).toBe(ACR_MFA);
  }, 120_000);

  it('recovery codes: enrol through kc_action, log in with one code instead of OTP, the used code is refused, the next one in sequence works', async () => {
    const u = await createUser('recovery', { withOtp: true });
    const secret = u.otpSecret!;
    // enrol: the application-initiated action needs the user's own session (password + OTP)
    const enrol = await webLogin(creds(u, { otp: () => nextTotp(secret) }), { kcAction: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    expect(enrol.result.kind).toBe('configure-recovery');
    const html = enrol.result.html!;
    const field = (n: string): string => html.match(new RegExp(`name="${n}"[^>]*value="([^"]*)"`))?.[1] ?? '';
    const generated = field('generatedRecoveryAuthnCodes');
    const codes = generated.split(',');
    expect(codes).toHaveLength(12);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{12}$/);
    const confirm = await fetch(rewrite(enrol.result.action!), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: enrol.result.jar.header() },
      body: new URLSearchParams({
        generatedRecoveryAuthnCodes: generated,
        generatedAt: field('generatedAt'),
        userLabel: 'Recovery codes',
        kcRecoveryCodesConfirmationCheck: 'on',
      }),
    });
    expect(confirm.status).toBe(302);
    expect(await securityClient().getUserSecurity(u.id)).toMatchObject({ otpConfigured: true, recoveryCodesConfigured: true });

    // login with code #1 (Keycloak asks for the numbered code in sequence)
    await sleep(1200);
    const asked: number[] = [];
    const l1 = await webLogin(creds(u, { recovery: (n) => (asked.push(n), codes[n - 1]!) }));
    expect(l1.result.done).toBe(true);
    expect(asked).toEqual([1]);
    expect(decodeJwt((await tokensOf(l1)).accessToken).acr).toBe(ACR_MFA);

    // the SAME code again is refused: the form now asks for #2 and a replay of #1 is invalid (single use)
    await sleep(1200);
    const replay = await webLogin(creds(u, { recovery: () => codes[0]! }));
    expect(replay.result.done).toBe(false);
    expect(replay.result.rejected).toBe(true);
    expect(Number(replay.result.html?.match(/Recovery code #(\d+)/)?.[1])).toBe(2);

    // the next code in sequence works
    await sleep(1200);
    const l2 = await webLogin(creds(u, { recovery: (n) => codes[n - 1]! }));
    expect(l2.result.done).toBe(true);

    // the count is visible without any secret
    const credentials = (await admin(`/users/${u.id}/credentials`)).json as { type: string; credentialData?: string; secretData?: string }[];
    const rec = credentials.find((c) => c.type === 'recovery-authn-codes')!;
    expect(JSON.parse(rec.credentialData ?? '{}')).toMatchObject({ totalCodes: 12, remainingCodes: 10 });
    expect(rec.secretData).toBeUndefined();
  }, 150_000);
});

// ================================================================================================================== the built-in account surface
// Keycloak adds an account console, a self-service REST API and application-initiated actions (kc_action) to every realm. Left alone they let a signed-in user remove
// the second factor, change the password or end sessions OUTSIDE BananaGig (step-up, audit, session registry). The realm file closes what BananaGig does not use.
describe('built-in account surface is closed (live)', () => {
  it('the account console and its client are disabled: no page, no login', async () => {
    for (const path of ['/account', '/account/', '/account/credentials']) {
      const res = await fetch(`${KC}/realms/${REALM}${path}`, { redirect: 'manual' });
      expect(res.status, path).toBe(404);
    }
    for (const clientId of ['account', 'account-console']) {
      const c = (await admin(`/clients?clientId=${clientId}`)).json?.[0];
      expect(c, clientId).toMatchObject({ enabled: false, standardFlowEnabled: false, directAccessGrantsEnabled: false });
    }
    const url = new URL(`${KC}/realms/${REALM}/protocol/openid-connect/auth`);
    for (const [k, v] of Object.entries({
      client_id: 'account-console',
      redirect_uri: `${TEST_PUBLIC_URL}/realms/${REALM}/account/`,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      code_challenge: codeChallengeS256(generateCodeVerifier()),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(k, v);
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Client disabled');
  });

  it('the default role carries no account-management role, so no token can use the account REST API', async () => {
    const roles = (await admin(`/roles/default-roles-${REALM}/composites`)).json as { name: string }[];
    expect(roles.map((r) => r.name).sort()).toEqual(['offline_access', 'uma_authorization']);
  });

  it('a signed-in user cannot delete the OTP credential through kc_action=delete_credential (the action is disabled)', async () => {
    const u = await createUser('del-cred', { withOtp: true });
    const secret = u.otpSecret!;
    const otpId = ((await admin(`/users/${u.id}/credentials`)).json as { id: string; type: string }[]).find((c) => c.type === 'otp')!.id;
    const l = await webLogin(creds(u, { otp: () => nextTotp(secret) }), { rawParams: { kc_action: `delete_credential:${otpId}` } });
    expect(l.result.done).toBe(true);
    const callback = new URL(l.result.location!);
    expect(callback.searchParams.get('kc_action_status')).toBe('error');
    expect(((await admin(`/users/${u.id}/credentials`)).json as { type: string }[]).map((c) => c.type).sort()).toEqual(['otp', 'password']);
  }, 60_000);

  it('the self-service reset-credentials flow is refused while resetPasswordAllowed is false (BananaGig starts resets)', async () => {
    const jar = new Jar();
    const verifier = generateCodeVerifier();
    const start = await fetch(
      rewrite(
        buildAuthorizeUrl({
          authorizationEndpoint: ep.authorization,
          clientId: WEB,
          redirectUri: WEB_REDIRECT_URI,
          state: randomToken(16),
          nonce: randomToken(16),
          codeChallenge: codeChallengeS256(verifier),
        }),
      ),
    );
    jar.absorb(start);
    const page = await start.text();
    expect(page).not.toMatch(/reset-credentials/i); // no "Forgot password?" link
    const q = new URL(decodeHtml(page.match(/<form[^>]*\baction="([^"]+)"/i)![1]!)).searchParams;
    const direct = new URL(`${KC}/realms/${REALM}/login-actions/reset-credentials`);
    direct.searchParams.set('client_id', WEB);
    for (const k of ['tab_id', 'session_code', 'client_data']) direct.searchParams.set(k, q.get(k) ?? '');
    const res = await fetch(direct, { redirect: 'manual', headers: { cookie: jar.header() } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Reset Credential not allowed');
  });
});
