// Authorization Code + PKCE (S256) back end for the web client, written as plain Request -> Response functions.
// The browser only ever holds two opaque HttpOnly cookies (login transaction id, session id). Tokens stay server-side.
import { timingSafeEqual } from 'node:crypto';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  kcActionStatusFromCallback,
  OidcError,
  randomToken,
  refreshTokenSet,
  safeReturnTo,
  type TokenSet,
} from '@bananagig/identity';
import { ACR_MFA, isMfaAcr, KEYCLOAK_ACTION_OF_METHOD, RoleCode } from '@bananagig/contracts';
import { ApiError } from '../api-client';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import { ensureDeviceSecret, mintDeviceSecret, userAgentOf } from './device';
import { KC_ACTION_NAMES, STEP_UP_LEVELS, type AuthDeps, type KcActionName, type SessionRecord, type StepUpLevel } from './types';

const TX_TTL_SECONDS = 600;
const REFRESH_SKEW_SECONDS = 30;
const nowSeconds = (d: AuthDeps): number => (d.now ?? (() => Math.floor(Date.now() / 1000)))();
const log = (d: AuthDeps, level: 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>): void => d.log?.(level, message, attrs);
const NO_STORE = { 'cache-control': 'no-store' };
/** How long the best-effort calls to the API at login and logout may take. They never block the person: a slow API is skipped and logged. */
const BEST_EFFORT_TIMEOUT_MS = 2000;
/** The step-up login must have authenticated at most this many seconds before it was started (clock difference between the web server and Keycloak). Not a business value. */
const STEP_UP_CLOCK_SKEW_SECONDS = 10;

const redirect = (location: string, status: 302 | 303, cookies: string[] = []): Response => {
  const h = new Headers({ location, ...NO_STORE });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
};
/** Resolves to the promise's value, or undefined when it fails or takes longer than `ms`. The caller decides what undefined means; nothing is thrown. */
async function bestEffort<T>(
  work: () => Promise<T>,
  ms = BEST_EFFORT_TIMEOUT_MS,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; code?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    const run = work();
    run.catch(() => undefined); // a late failure after the timeout is not an unhandled rejection
    const out = await Promise.race([run, timeout]);
    return out === 'timeout' ? { ok: false, reason: 'timeout' } : { ok: true, value: out };
  } catch (err) {
    return { ok: false, reason: 'error', code: err instanceof ApiError ? err.code : 'API_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}
const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The single value of a query parameter when it is exactly one of the allowed names (case-sensitive); anything else is ignored. */
function oneOf<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const all = params.getAll(name);
  const value = all.length === 1 ? all[0] : undefined;
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
/** What each step-up level asks of Keycloak: always a fresh authentication; `mfa` also asks for the second-factor level (`acr_values`). */
const STEP_UP_REQUEST: Record<StepUpLevel, { prompt: 'login'; acrValues?: string }> = {
  recent: { prompt: 'login' },
  mfa: { prompt: 'login', acrValues: ACR_MFA },
};
/** The Keycloak application-initiated action each name starts. */
const KC_ACTION_OF_NAME: Record<KcActionName, string> = { totp: KEYCLOAK_ACTION_OF_METHOD.TOTP, recovery: KEYCLOAK_ACTION_OF_METHOD.RECOVERY_CODES };

/**
 * GET /auth/login?returnTo=/path[&stepUp=recent|mfa][&kcAction=totp|recovery] : starts the flow. `returnTo` is a same-site path or `/`. `stepUp` asks Keycloak for a fresh
 * authentication (and, for `mfa`, the second-factor level) and `kcAction` for an application-initiated action (enrol an authenticator, generate recovery codes) that is honoured only with the one-shot enrollment marker of this browser session; a value
 * outside the lists is ignored, never forwarded. A step-up is ONE round trip: the transaction remembers it and the callback does not start another (see handleCallback).
 */
export async function handleLogin(req: Request, d: AuthDeps): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const returnTo = safeReturnTo(params.get('returnTo'));
  const stepUpParam = oneOf(params, 'stepUp', STEP_UP_LEVELS);
  const kcActionParam = oneOf(params, 'kcAction', KC_ACTION_NAMES);
  // A Keycloak credential setup is honoured ONLY for a browser session that holds the one-shot marker POST /auth/security/mfa-enroll stored after the API accepted the
  // request (the API's guard demands a recent authentication). No session, no marker, an expired or consumed one, or another method: the parameter is ignored and a
  // plain login starts. The marker is consumed here, atomically, whether or not it matches.
  let kcAction: KcActionName | undefined;
  if (kcActionParam) {
    const sessionId = parseCookies(req.headers.get('cookie'))[d.cfg.sessionCookie];
    const marker = sessionId ? await d.store.takeEnrollment(sessionId) : null;
    if (marker && marker.method === (kcActionParam === 'totp' ? 'TOTP' : 'RECOVERY_CODES')) kcAction = kcActionParam;
  }
  // a credential setup always re-authenticates, and the callback checks that it really happened (like a step-up)
  const stepUp: StepUpLevel | undefined = stepUpParam ?? (kcAction ? 'recent' : undefined);
  const txId = randomToken(24);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = generateCodeVerifier();
  await d.store.putTransaction(
    txId,
    { state, nonce, verifier, returnTo, ...(stepUp ? { stepUp: { level: stepUp, startedAt: nowSeconds(d) } } : {}) },
    TX_TTL_SECONDS,
  );
  const url = buildAuthorizeUrl({
    authorizationEndpoint: d.cfg.endpoints.authorization,
    clientId: d.cfg.clientId,
    redirectUri: d.cfg.redirectUri,
    state,
    nonce,
    codeChallenge: codeChallengeS256(verifier),
    ...(stepUp ? STEP_UP_REQUEST[stepUp] : {}),
    ...(kcAction ? { kcAction: KC_ACTION_OF_NAME[kcAction] } : {}),
  });
  // The tx cookie binds this browser to the login attempt (login-CSRF protection). Path-scoped to /auth.
  return redirect(url, 302, [serializeCookie(d.cfg.txCookie, txId, { maxAgeSeconds: TX_TTL_SECONDS, path: '/auth', secure: d.cfg.cookieSecure })]);
}

const failure = (d: AuthDeps, reason: string): Response => {
  log(d, 'warn', 'login failed', { reason });
  return redirect(`${d.cfg.webPublicUrl}/session?error=login_failed`, 302, [clearCookie(d.cfg.txCookie, '/auth', d.cfg.cookieSecure)]);
};

/** GET /auth/callback?code&state : validates state/nonce, exchanges the code with the PKCE verifier, creates the session. */
export async function handleCallback(req: Request, d: AuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const txId = parseCookies(req.headers.get('cookie'))[d.cfg.txCookie];
  const tx = txId ? await d.store.takeTransaction(txId) : null; // consumed once: replays fail
  if (!tx) return failure(d, 'no_transaction');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error')) return failure(d, 'provider_error_response');
  if (!state || !safeEqual(state, tx.state)) return failure(d, 'state_mismatch');
  if (!code) return failure(d, 'missing_code');
  let tokens: TokenSet;
  try {
    tokens = await exchangeAuthorizationCode({
      tokenEndpoint: d.cfg.endpoints.token,
      clientId: d.cfg.clientId,
      redirectUri: d.cfg.redirectUri,
      code,
      codeVerifier: tx.verifier,
      fetch: d.fetch,
    });
  } catch (err) {
    return failure(d, err instanceof OidcError ? err.category : 'token_exchange_failed');
  }
  let record: SessionRecord;
  let stepUpReached = true;
  try {
    if (!tokens.idToken) return failure(d, 'missing_id_token');
    await d.verifier.verifyIdToken(tokens.idToken, d.cfg.clientId, tx.nonce); // issuer, audience, signature, expiry, nonce
    const principal = await d.verifier.verifyAccessToken(tokens.accessToken);
    // A step-up counts only when the VERIFIED token shows it: authenticated after the step-up began and, for mfa, at the second-factor level. Keycloak ignoring
    // prompt / acr_values must not loop: this callback never starts another round trip, it returns with an error (the page shows the error key).
    if (tx.stepUp) {
      const fresh = principal.authTime !== undefined && principal.authTime >= tx.stepUp.startedAt - STEP_UP_CLOCK_SKEW_SECONDS;
      stepUpReached = fresh && (tx.stepUp.level !== 'mfa' || isMfaAcr(principal.acr));
    }
    record = {
      subject: principal.subject,
      realmRoles: principal.realmRoles,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accessExpiresAt: principal.expiresAt,
      createdAt: nowSeconds(d),
    };
  } catch {
    return failure(d, 'token_validation_failed');
  }
  const sessionId = randomToken(32);
  // a login replaces the session this browser held (a step-up login for instance): its record and refresh token must not outlive the cookie that pointed at it
  const previous = parseCookies(req.headers.get('cookie'))[d.cfg.sessionCookie];
  if (previous) await d.store.deleteSession(previous);
  await d.store.putSession(sessionId, record, tokens.refreshExpiresIn);
  let device = ensureDeviceSecret(req, d.cfg);
  const registered = await registerSession(d, record.accessToken, device.secret, req);
  // A browser whose secret belongs to a REMOVED device gets no device (deviceId null): rotate the cookie and register once more (never more than once). A secret that
  // was minted in this very request cannot belong to a removed device, so it is not retried.
  if (registered && registered.deviceId === null && !device.minted) {
    device = mintDeviceSecret(d.cfg);
    await registerSession(d, record.accessToken, device.secret, req);
  }
  log(d, 'info', 'login succeeded', {});
  // the outcome of an application-initiated action (kc_action_status) and of a step-up travel as query parameters of the return path: a whitelisted word, never a value
  const kcStatus = kcActionStatusFromCallback(url);
  let target = safeReturnTo(tx.returnTo);
  if (kcStatus) target = withQuery(target, 'kc_action_status', kcStatus);
  if (!stepUpReached) {
    log(d, 'warn', 'step-up not reached', { level: tx.stepUp?.level });
    target = withQuery(target, 'error', 'step_up_required');
  }
  return redirect(`${d.cfg.webPublicUrl}${target}`, 302, [
    serializeCookie(d.cfg.sessionCookie, sessionId, { maxAgeSeconds: tokens.refreshExpiresIn, path: '/', secure: d.cfg.cookieSecure }),
    device.setCookie,
    clearCookie(d.cfg.txCookie, '/auth', d.cfg.cookieSecure),
  ]);
}

/** Sets one query parameter on a validated same-site path (replacing an existing value) and keeps its fragment. */
function withQuery(path: string, name: string, value: string): string {
  const u = new URL(path, 'http://same-site.invalid');
  u.searchParams.set(name, value);
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * Tells the API which browser this login came from (the device secret travels in the request body only). A failure is logged and never fails the login; the result
 * is undefined then, otherwise what the API answered (its `deviceId` is null when the session got no device).
 */
async function registerSession(d: AuthDeps, accessToken: string, device: string, req: Request): Promise<{ deviceId: string | null } | undefined> {
  const register = d.api?.(accessToken).registerSession;
  if (!register) return undefined;
  const userAgent = userAgentOf(req);
  const result = await bestEffort(() => register({ device, ...(userAgent ? { userAgent } : {}) }));
  if (!result.ok) {
    log(d, 'warn', 'session registration failed', { reason: result.reason, code: result.code });
    return undefined;
  }
  return result.value;
}

/** In-flight token refreshes by session id, per store: concurrent callers in this process share one refresh (see getSession). */
const refreshFlights = new WeakMap<object, Map<string, Promise<SessionRecord | null>>>();

/**
 * The refresh itself: re-reads the session (a refresh that finished a moment ago is not repeated), asks the token endpoint ONCE and stores the result with the
 * refresh lifetime. An unrefreshable session is deleted and reported as null. Never rejects.
 */
async function refreshSession(id: string, d: AuthDeps): Promise<SessionRecord | null> {
  try {
    const record = await d.store.getSession(id);
    if (!record) return null;
    if (nowSeconds(d) < record.accessExpiresAt - REFRESH_SKEW_SECONDS) return record;
    const tokens = await refreshTokenSet({ tokenEndpoint: d.cfg.endpoints.token, clientId: d.cfg.clientId, refreshToken: record.refreshToken, fetch: d.fetch });
    const principal = await d.verifier.verifyAccessToken(tokens.accessToken);
    const next: SessionRecord = {
      ...record,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken ?? record.idToken,
      realmRoles: principal.realmRoles,
      accessExpiresAt: principal.expiresAt,
    };
    await d.store.putSession(id, next, tokens.refreshExpiresIn);
    return next;
  } catch {
    await d.store.deleteSession(id).catch(() => undefined);
    log(d, 'info', 'session expired', {});
    return null;
  }
}

/**
 * Returns the live session for a cookie header, refreshing the access token when it is about to expire.
 * An unrefreshable or unknown session is deleted and reported as signed out (expired-session handling).
 *
 * The refresh is SINGLE-FLIGHT per session id: the realm rotates refresh tokens and tolerates a reuse of only one, so concurrent requests of one browser (a page and
 * its parallel reads) must not each present the same refresh token. Callers in this process that arrive while a refresh is running share its promise (one token
 * request per expiry per process) and all receive the same refreshed record, or all see signed out when it failed. The entry is removed when the refresh settles,
 * success or failure, so the next expiry (or a retry) starts a new one.
 */
export async function getSession(cookieHeader: string | null | undefined, d: AuthDeps): Promise<{ id: string; record: SessionRecord } | null> {
  const id = parseCookies(cookieHeader)[d.cfg.sessionCookie];
  if (!id) return null;
  const record = await d.store.getSession(id);
  if (!record) return null;
  if (nowSeconds(d) < record.accessExpiresAt - REFRESH_SKEW_SECONDS) return { id, record };
  let flights = refreshFlights.get(d.store);
  if (!flights) refreshFlights.set(d.store, (flights = new Map()));
  let flight = flights.get(id);
  if (!flight) {
    const started = refreshSession(id, d);
    const registry = flights;
    flight = started.finally(() => registry.delete(id));
    flights.set(id, flight);
  }
  const next = await flight;
  return next ? { id, record: next } : null;
}

/** GET /auth/session : minimal status for the UI. Never returns tokens. */
export async function handleSession(req: Request, d: AuthDeps): Promise<Response> {
  const s = await getSession(req.headers.get('cookie'), d);
  const body = s
    ? { authenticated: true, subject: s.record.subject, realmRoles: s.record.realmRoles, expiresAt: s.record.accessExpiresAt }
    : { authenticated: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...NO_STORE } });
}

/** Deletes the local session, clears its cookie and sends the browser through Keycloak's end-session endpoint (so the SSO cookie cannot silently sign it in again). */
export async function endSessionRedirect(id: string, record: SessionRecord, d: AuthDeps, postLogoutRedirectUri: string): Promise<Response> {
  await d.store.deleteSession(id);
  const clear = clearCookie(d.cfg.sessionCookie, '/', d.cfg.cookieSecure);
  const endSession = buildLogoutUrl({
    endSessionEndpoint: d.cfg.endpoints.endSession,
    clientId: d.cfg.clientId,
    idTokenHint: record.idToken,
    postLogoutRedirectUri,
  });
  return redirect(endSession, 303, [clear]);
}

/** True for the API's answer to a session it revoked (sign out everywhere, a removed browser, a sign-out from another session): 401 SESSION_REVOKED. */
export const isSessionRevokedError = (err: unknown): boolean => err instanceof ApiError && err.status === 401 && err.code === 'SESSION_REVOKED';

/**
 * The API revoked this session (401 SESSION_REVOKED): end the local session at once and send the browser through Keycloak's end-session endpoint, back to
 * `/session?error=session_revoked`. Without the end-session round trip the Keycloak SSO cookie (when it is still alive) would sign the browser in again silently.
 */
export async function endRevokedSession(id: string, record: SessionRecord, d: AuthDeps): Promise<Response> {
  log(d, 'info', 'session revoked by the api, local session ended', {});
  return endSessionRedirect(id, record, d, d.cfg.revokedRedirectUri);
}

/**
 * GET /auth/revoked : where a PAGE sends the browser when the API said 401 SESSION_REVOKED (a page cannot clear a cookie while it renders). It does nothing on a
 * request's word: it asks the API again with the session's own token and ends the session only when the API confirms the revocation, so a link or an image
 * cannot sign anyone out. Otherwise (still valid, API down, signed out) it just goes back to /session.
 */
export async function handleRevokedSession(req: Request, d: AuthDeps): Promise<Response> {
  const session = await getSession(req.headers.get('cookie'), d);
  const getAccount = session ? d.api?.(session.record.accessToken).getAccount : undefined;
  if (!session || !getAccount) return redirect(`${d.cfg.webPublicUrl}/session`, 303);
  const result = await bestEffort(() => getAccount({ activeRole: session.record.activeRole }), 5000);
  if (!result.ok && result.code === 'SESSION_REVOKED') return endRevokedSession(session.id, session.record, d);
  return redirect(`${d.cfg.webPublicUrl}/session`, 303);
}

/**
 * POST /auth/logout : ends the local session and the Keycloak SSO session. POST only, same-origin only (Origin header must match
 * WEB_PUBLIC_URL) on top of SameSite=Lax cookies, so a third-party page cannot sign a user out. Before the local delete the application session is
 * ended at the API too (best effort, 2 s, with a fresh token): a failure never keeps the person signed in.
 */
export async function handleLogout(req: Request, d: AuthDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
  if (req.headers.get('origin') !== d.cfg.webOrigin) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  const cookie = req.headers.get('cookie');
  const id = parseCookies(cookie)[d.cfg.sessionCookie];
  const stored = id ? await d.store.getSession(id) : null;
  let record = stored;
  if (id && stored && d.api) {
    // a fresh token (refreshed when about to expire); null means the refresh failed and the session is already gone: nothing to tell the API with
    const live = await bestEffort(() => getSession(cookie, d));
    record = live.ok ? (live.value?.record ?? stored) : stored;
    const token = live.ok ? live.value?.record.accessToken : stored.accessToken;
    const signOut = token ? d.api(token).signOutCurrentSession : undefined;
    if (signOut) {
      const result = await bestEffort(() => signOut({ activeRole: record?.activeRole }));
      if (!result.ok) log(d, 'warn', 'application sign-out failed', { reason: result.reason, code: result.code });
    }
  }
  if (id) await d.store.deleteSession(id);
  const clear = clearCookie(d.cfg.sessionCookie, '/', d.cfg.cookieSecure);
  if (!record) return redirect(`${d.cfg.webPublicUrl}/`, 303, [clear]);
  log(d, 'info', 'logout', {});
  return endSessionRedirect(id!, record, d, d.cfg.postLogoutRedirectUri);
}

/** Where the role switch may send the browser back to (account area): EXACTLY these paths. Anything else is the default /session; a path is never built from input. */
export const ACTIVE_ROLE_NEXT_ALLOWLIST: readonly string[] = ['/account/roles', '/account'];

/**
 * The fields of the switch form: `role` (undefined when the body is not a form or the value is not a well-formed role code, which the UI never produces) and the optional
 * hidden `next`, honoured only when it is EXACTLY one of ACTIVE_ROLE_NEXT_ALLOWLIST (compared as a string, never parsed or joined, so `//evil`, an absolute URL or a
 * lookalike cannot pass). A missing, repeated or other `next` is ignored: the redirect stays /session.
 */
async function switchFields(req: Request): Promise<{ role: string | undefined; next: string | undefined }> {
  try {
    const form = await req.formData();
    const role = form.get('role');
    const nexts = form.getAll('next');
    const next = nexts.length === 1 && typeof nexts[0] === 'string' && ACTIVE_ROLE_NEXT_ALLOWLIST.includes(nexts[0]) ? nexts[0] : undefined;
    return { role: typeof role === 'string' && RoleCode.safeParse(role).success ? role : undefined, next };
  } catch {
    return { role: undefined, next: undefined };
  }
}

/**
 * POST /auth/active-role (form field `role`, optional hidden field `next`): switches the application role this browser session acts as (ID-001). The API confirms the
 * account holds the role as an ACTIVE role; only then is the role stored in the SERVER session record (the remaining session lifetime is kept) and the
 * browser redirected back to /session (or to `next` when it is on the ACTIVE_ROLE_NEXT_ALLOWLIST, the account area). Nothing else changes: no Keycloak login, no new
 * token, no refresh, no cookie (the role never reaches the browser). POST only and same-origin only, like logout. A refused switch (the API answers 403, or fails)
 * changes nothing and redirects to the same page with ?error=role.
 */
export async function handleActiveRole(req: Request, d: AuthDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
  if (req.headers.get('origin') !== d.cfg.webOrigin) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  if (!d.api) throw new Error('AuthDeps.api is required for the role switch');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return redirect(`${d.cfg.webPublicUrl}/session`, 303); // signed out or expired: the page shows the sign-in control
  const { role, next } = await switchFields(req);
  if (!role) return new Response('Bad request', { status: 400, headers: NO_STORE });
  const target = next ?? '/session';
  const refused = (code: string, status?: number): Response => {
    log(d, 'warn', 'active role switch refused', { code, status });
    return redirect(`${d.cfg.webPublicUrl}${target}?error=role`, 303);
  };
  try {
    const account = await d.api(session.record.accessToken).setActiveRole(role);
    if (account.activeRole !== role) return refused('ACTIVE_ROLE_MISMATCH'); // the API always answers with the role it validated
  } catch (err) {
    return err instanceof ApiError ? refused(err.code, err.status) : refused('API_ERROR');
  }
  // re-read just before writing so a token refresh that happened during the API call is not overwritten with the older record
  const latest = await d.store.getSession(session.id);
  if (latest) await d.store.updateSession(session.id, { ...latest, activeRole: role });
  log(d, 'info', 'active role switched', {});
  return redirect(`${d.cfg.webPublicUrl}${target}`, 303);
}

/** Forgets the active role stored in a session (it is no longer an active role of the account). The session itself and its tokens are untouched. */
export async function forgetActiveRole(id: string, d: AuthDeps): Promise<void> {
  const record = await d.store.getSession(id);
  if (!record || record.activeRole === undefined) return;
  const { activeRole: _forgotten, ...rest } = record;
  await d.store.updateSession(id, rest);
}
