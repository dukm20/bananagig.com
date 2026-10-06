// Authorization Code + PKCE (S256) back end for the web client, written as plain Request -> Response functions.
// The browser only ever holds two opaque HttpOnly cookies (login transaction id, session id). Tokens stay server-side.
import { timingSafeEqual } from 'node:crypto';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  OidcError,
  randomToken,
  refreshTokenSet,
  safeReturnTo,
  type TokenSet,
} from '@bananagig/identity';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import type { AuthDeps, SessionRecord } from './types';

const TX_TTL_SECONDS = 600;
const REFRESH_SKEW_SECONDS = 30;
const nowSeconds = (d: AuthDeps): number => (d.now ?? (() => Math.floor(Date.now() / 1000)))();
const log = (d: AuthDeps, level: 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>): void => d.log?.(level, message, attrs);
const NO_STORE = { 'cache-control': 'no-store' };

const redirect = (location: string, status: 302 | 303, cookies: string[] = []): Response => {
  const h = new Headers({ location, ...NO_STORE });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
};
const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** GET /auth/login?returnTo=/path : starts the flow. */
export async function handleLogin(req: Request, d: AuthDeps): Promise<Response> {
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get('returnTo'));
  const txId = randomToken(24);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = generateCodeVerifier();
  await d.store.putTransaction(txId, { state, nonce, verifier, returnTo }, TX_TTL_SECONDS);
  const url = buildAuthorizeUrl({
    authorizationEndpoint: d.cfg.endpoints.authorization,
    clientId: d.cfg.clientId,
    redirectUri: d.cfg.redirectUri,
    state,
    nonce,
    codeChallenge: codeChallengeS256(verifier),
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
  try {
    if (!tokens.idToken) return failure(d, 'missing_id_token');
    await d.verifier.verifyIdToken(tokens.idToken, d.cfg.clientId, tx.nonce); // issuer, audience, signature, expiry, nonce
    const principal = await d.verifier.verifyAccessToken(tokens.accessToken);
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
  await d.store.putSession(sessionId, record, tokens.refreshExpiresIn);
  log(d, 'info', 'login succeeded', {});
  return redirect(`${d.cfg.webPublicUrl}${safeReturnTo(tx.returnTo)}`, 302, [
    serializeCookie(d.cfg.sessionCookie, sessionId, { maxAgeSeconds: tokens.refreshExpiresIn, path: '/', secure: d.cfg.cookieSecure }),
    clearCookie(d.cfg.txCookie, '/auth', d.cfg.cookieSecure),
  ]);
}

/**
 * Returns the live session for a cookie header, refreshing the access token when it is about to expire.
 * An unrefreshable or unknown session is deleted and reported as signed out (expired-session handling).
 */
export async function getSession(cookieHeader: string | null | undefined, d: AuthDeps): Promise<{ id: string; record: SessionRecord } | null> {
  const id = parseCookies(cookieHeader)[d.cfg.sessionCookie];
  if (!id) return null;
  const record = await d.store.getSession(id);
  if (!record) return null;
  if (nowSeconds(d) < record.accessExpiresAt - REFRESH_SKEW_SECONDS) return { id, record };
  try {
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
    return { id, record: next };
  } catch {
    await d.store.deleteSession(id);
    log(d, 'info', 'session expired', {});
    return null;
  }
}

/** GET /auth/session : minimal status for the UI. Never returns tokens. */
export async function handleSession(req: Request, d: AuthDeps): Promise<Response> {
  const s = await getSession(req.headers.get('cookie'), d);
  const body = s
    ? { authenticated: true, subject: s.record.subject, realmRoles: s.record.realmRoles, expiresAt: s.record.accessExpiresAt }
    : { authenticated: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...NO_STORE } });
}

/**
 * POST /auth/logout : ends the local session and the Keycloak SSO session. POST only, same-origin only (Origin header must match
 * WEB_PUBLIC_URL) on top of SameSite=Lax cookies, so a third-party page cannot sign a user out.
 */
export async function handleLogout(req: Request, d: AuthDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
  if (req.headers.get('origin') !== d.cfg.webOrigin) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  const id = parseCookies(req.headers.get('cookie'))[d.cfg.sessionCookie];
  const record = id ? await d.store.getSession(id) : null;
  if (id) await d.store.deleteSession(id);
  const clear = clearCookie(d.cfg.sessionCookie, '/', d.cfg.cookieSecure);
  if (!record) return redirect(`${d.cfg.webPublicUrl}/`, 303, [clear]);
  const endSession = buildLogoutUrl({
    endSessionEndpoint: d.cfg.endpoints.endSession,
    clientId: d.cfg.clientId,
    idTokenHint: record.idToken,
    postLogoutRedirectUri: d.cfg.postLogoutRedirectUri,
  });
  log(d, 'info', 'logout', {});
  return redirect(endSession, 303, [clear]);
}
