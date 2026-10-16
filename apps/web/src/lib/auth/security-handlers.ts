// Account security actions of the browser (ID-004): the same-origin POST handlers behind the /security and /forgot-password pages, written as plain
// Request -> Response functions like the other auth handlers. They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin): a cross-site form cannot drive them. Every one needs a signed-in session, except the
//    public password-reset request.
//  - A form carries exactly the fields of its action and nothing else: an unknown field, a repeated field, a file or a value outside its closed set is a 400 and
//    changes nothing. Ids are uuids, the MFA method is one of two words.
//  - Nothing a person submitted is put in a redirect, a cookie or a log line. A result is a 303 back to the page with `?notice=<key>`, `?error=<API error code>`
//    or (password reset) `?status=<word>`; the page renders the registry's copy for a key it knows and ignores everything else.
//  - A step-up the API asks for (401 STEP_UP_REQUIRED) becomes ONE login round trip (`/auth/login?...&stepUp=`); coming back does not repeat the action, the person
//    submits it again. A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import { KEYCLOAK_ACTION_OF_METHOD, MFA_METHODS, PASSWORD_RESET_EMAIL_MAX_LENGTH, type MfaMethod } from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { clientIpOf } from './email-handlers';
import { clearDeviceCookie } from './device';
import { endRevokedSession, endSessionRedirect, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps, KcActionName } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const SECURITY_ACTIONS = ['revoke-session', 'revoke-all', 'trust-device', 'untrust-device', 'remove-device', 'mfa-enroll'] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];
export const isSecurityAction = (v: string): v is SecurityAction => (SECURITY_ACTIONS as readonly string[]).includes(v);

/** The notice words of `/security?notice=` (the page maps each to a registry key). */
export const SECURITY_NOTICES = ['session_revoked', 'signed_out_elsewhere', 'device_trusted', 'device_untrusted', 'device_removed'] as const;
/** The status words of `/forgot-password?status=`. */
export const PASSWORD_RESET_STATUSES = ['accepted', 'invalid', 'rate_limited', 'unavailable'] as const;
export type PasswordResetStatus = (typeof PASSWORD_RESET_STATUSES)[number];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const KC_ACTION_NAME_OF_METHOD: Record<MfaMethod, KcActionName> = { TOTP: 'totp', RECOVERY_CODES: 'recovery' };
/** How long the login that starts the Keycloak action may follow the accepted enrollment request. */
const ENROLLMENT_MARKER_TTL_SECONDS = 300;
const API_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const back = (d: AuthDeps, query: string, cookies: string[] = []): Response => {
  const headers = new Headers({ location: `${d.cfg.webPublicUrl}/security${query}`, ...NO_STORE });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
};
const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });

/**
 * The fields of a submitted form when it holds EXACTLY the allowed names, each once, each as text. undefined for anything else (not a form, an extra or repeated
 * field, a file part), so an unexpected shape is refused instead of half-read.
 */
export async function strictForm(req: Request, allowed: readonly string[]): Promise<Record<string, string> | undefined> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    const only = values[0];
    if (!allowed.includes(name) || values.length !== 1 || typeof only !== 'string') return undefined;
    out[name] = only;
  }
  return out;
}

/**
 * POST /auth/security/<action>: `revoke-session` (field `sessionId`), `revoke-all` (signs out every OTHER session), `trust-device`, `untrust-device` (this browser),
 * `remove-device` (field `deviceId`), `mfa-enroll` (field `method` TOTP | RECOVERY_CODES). The result is always a redirect back to /security (or to Keycloak).
 */
export async function handleSecurityAction(req: Request, d: AuthDeps, action: SecurityAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the security actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const fields = await strictForm(
    req,
    action === 'revoke-session' ? ['sessionId'] : action === 'remove-device' ? ['deviceId'] : action === 'mfa-enroll' ? ['method'] : [],
  );
  if (!fields) return badRequest();
  const sessionId = fields.sessionId;
  const deviceId = fields.deviceId;
  const method = fields.method;
  if (action === 'revoke-session' && !(sessionId !== undefined && UUID.test(sessionId))) return badRequest();
  if (action === 'remove-device' && !(deviceId !== undefined && UUID.test(deviceId))) return badRequest();
  if (action === 'mfa-enroll' && !(method !== undefined && (MFA_METHODS as readonly string[]).includes(method))) return badRequest();

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  try {
    switch (action) {
      case 'revoke-session': {
        if (!api.revokeSecuritySession) throw new Error('AuthDeps.api lacks the security calls');
        const result = await api.revokeSecuritySession(sessionId!, opts);
        // the session signed out was this very one: nothing local is left to use, end it the way a logout does
        if (result.current) return await endSessionRedirect(session.id, session.record, d, d.cfg.postLogoutRedirectUri);
        return back(d, '?notice=session_revoked');
      }
      case 'revoke-all':
        if (!api.revokeAllSecuritySessions) throw new Error('AuthDeps.api lacks the security calls');
        await api.revokeAllSecuritySessions({ includeCurrent: false }, opts);
        return back(d, '?notice=signed_out_elsewhere');
      case 'trust-device':
        if (!api.trustCurrentDevice) throw new Error('AuthDeps.api lacks the security calls');
        await api.trustCurrentDevice(opts);
        return back(d, '?notice=device_trusted');
      case 'untrust-device':
        if (!api.untrustCurrentDevice) throw new Error('AuthDeps.api lacks the security calls');
        await api.untrustCurrentDevice(opts);
        return back(d, '?notice=device_untrusted');
      case 'remove-device': {
        if (!api.removeSecurityDevice) throw new Error('AuthDeps.api lacks the security calls');
        // is it THIS browser's device? (the API marks it in the list). When it is, the secret in the device cookie now belongs to a removed device: clear the cookie so
        // the next login mints a fresh one. A list that cannot be read leaves the cookie; the next login then rotates it itself (handleCallback).
        const wasCurrent = await api
          .listSecurityDevices?.(opts)
          .then((l) => l.devices.some((x) => x.current && x.deviceId.toLowerCase() === deviceId!.toLowerCase()))
          .catch(() => false);
        await api.removeSecurityDevice(deviceId!, opts);
        // when it was this browser's, the next API call says SESSION_REVOKED and the page ends the session
        return back(d, '?notice=device_removed', wasCurrent ? [clearDeviceCookie(d.cfg)] : []);
      }
      case 'mfa-enroll': {
        if (!api.startMfaEnrollment) throw new Error('AuthDeps.api lacks the security calls');
        const chosen = method as MfaMethod;
        const started = await api.startMfaEnrollment(chosen, opts);
        // the Keycloak action is derived from the method the person chose and cross-checked against the API's answer; nothing the API returns is forwarded
        if (started.method !== chosen || started.keycloakAction !== KEYCLOAK_ACTION_OF_METHOD[chosen]) return back(d, '?error=API_ERROR');
        // the API accepted (so the authentication is recent): leave the one-shot permission /auth/login needs to start the Keycloak action for THIS browser session
        await d.store.putEnrollment(session.id, { method: chosen }, ENROLLMENT_MARKER_TTL_SECONDS);
        return new Response(null, {
          status: 303,
          headers: { location: `${d.cfg.webPublicUrl}/auth/login?returnTo=/security&kcAction=${KC_ACTION_NAME_OF_METHOD[chosen]}`, ...NO_STORE },
        });
      }
    }
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    if (err instanceof ApiError && err.status === 401 && err.code === 'STEP_UP_REQUIRED') {
      const level = err.details?.requirement === 'MFA' ? 'mfa' : 'recent';
      return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/auth/login?returnTo=/security&stepUp=${level}`, ...NO_STORE } });
    }
    const code = err instanceof ApiError && API_CODE.test(err.code) ? err.code : 'API_ERROR';
    d.log?.('warn', 'security action refused', { action, code, status: err instanceof ApiError ? err.status : undefined });
    return back(d, `?error=${code}`);
  }
}

const forgot = (d: AuthDeps, status: PasswordResetStatus): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/forgot-password?status=${status}`, ...NO_STORE } });

/**
 * POST /auth/password-reset (field `email`): asks the API to send a password-reset link. PUBLIC (no session), same-origin only. The answer never depends on whether
 * the address belongs to an account: the API always answers the same 202, and this handler always redirects to `?status=accepted` for it. The address travels in the
 * request body only (never in the redirect, a cookie or a log line); the browser's address (the last x-forwarded-for entry, written by the trusted proxy) is forwarded
 * so the API's abuse limits count real clients.
 */
export async function handlePasswordReset(req: Request, d: AuthDeps): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.publicApi) throw new Error('AuthDeps.publicApi is required for the password reset request');
  const fields = await strictForm(req, ['email']);
  if (!fields || fields.email === undefined) return badRequest();
  const email = fields.email;
  if (email.trim().length === 0 || email.length > PASSWORD_RESET_EMAIL_MAX_LENGTH) return forgot(d, 'invalid');
  const request = d.publicApi().requestPasswordReset;
  if (!request) throw new Error('AuthDeps.publicApi lacks the password reset call');
  try {
    await request(email, { clientIp: clientIpOf(req) });
    return forgot(d, 'accepted');
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    d.log?.('warn', 'password reset request refused', { code: err instanceof ApiError && API_CODE.test(err.code) ? err.code : 'API_ERROR', status });
    return forgot(d, status === 429 ? 'rate_limited' : status === 400 ? 'invalid' : 'unavailable');
  }
}
