// Consent actions of the browser (ID-005): the same-origin POST handlers behind the /consents page, written as plain Request -> Response functions like the other
// auth handlers (security-handlers.ts is the template). They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin): a cross-site form cannot drive them. A signed-in session is required. Accepting is ALWAYS
//    an explicit POST of the person (PRD R-13): nothing here, and nothing in the page, pre-ticks, defaults or auto-submits an acceptance, and no GET changes state.
//  - A form carries EXACTLY the fields of its action and nothing else: an unknown field, a repeated field, a file or a value that is not well-formed (purpose code,
//    uuid, locale tag, lower-case sha-256) is a 400 and changes nothing. The hidden fields are the version the person was SHOWN; the SERVER decides whether it is in
//    force and whether the locale and hash are those of the immutable version (a forged or stale form is refused there), and never repairs a mismatch.
//  - No step-up is required for consent.
//  - Nothing a person submitted is put in a redirect, a cookie or a log line. A result is a 303 back to /consents with `?notice=<accepted|withdrawn|already_accepted>`
//    or `?error=<code>`, where the code is one of a CLOSED list of the API's consent codes (anything else is `API_ERROR`); the targets are fixed, so there is no open
//    redirect. A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import { AcceptConsentRequest, CONSENT_ERROR_CODES, ConsentPurposeCode } from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import { strictForm } from './security-handlers';
import type { AuthDeps } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const CONSENT_ACTIONS = ['accept', 'withdraw'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export const isConsentAction = (v: string): v is ConsentAction => (CONSENT_ACTIONS as readonly string[]).includes(v);

/** The notice words of `/consents?notice=` (the page maps each to a registry key). */
export const CONSENT_NOTICES = ['accepted', 'withdrawn', 'already_accepted'] as const;
/** The API error codes (`ACCOUNT_<consent code>`) a redirect may carry in `?error=`: a closed list; every other failure is `API_ERROR`. */
export const CONSENT_API_ERROR_CODES: readonly string[] = CONSENT_ERROR_CODES.map((c) => `ACCOUNT_${c}`);
export const CONSENT_GENERIC_ERROR = 'API_ERROR';

/** A BCP 47 tag as stored in the registry (language, optional script/region/variants); the server validates it against the version again. */
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

const back = (d: AuthDeps, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/consents${query}`, ...NO_STORE } });
const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });

/**
 * POST /auth/consents/accept (fields `purpose`, `versionId`, `locale`, `bodySha256`) and POST /auth/consents/withdraw (field `purpose`). The result is always a 303
 * back to /consents (or, for a revoked session, to Keycloak's end-session endpoint).
 */
export async function handleConsentAction(req: Request, d: AuthDeps, action: ConsentAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the consent actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const fields = await strictForm(req, action === 'accept' ? ['purpose', 'versionId', 'locale', 'bodySha256'] : ['purpose']);
  if (!fields) return badRequest();
  const purpose = ConsentPurposeCode.safeParse(fields.purpose);
  if (!purpose.success) return badRequest();
  let accept: AcceptConsentRequest | undefined;
  if (action === 'accept') {
    const body = AcceptConsentRequest.safeParse({ versionId: fields.versionId, locale: fields.locale, bodySha256: fields.bodySha256 });
    if (!body.success || !LOCALE_TAG.test(body.data.locale)) return badRequest();
    accept = body.data;
  }

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  const acceptConsent = api.acceptConsent;
  const withdrawConsent = api.withdrawConsent;
  if (!acceptConsent || !withdrawConsent) throw new Error('AuthDeps.api lacks the consent calls');
  try {
    if (action === 'accept') {
      const result = await acceptConsent(purpose.data, accept!, opts);
      return back(d, result.changed ? '?notice=accepted' : '?notice=already_accepted');
    }
    await withdrawConsent(purpose.data, opts);
    return back(d, '?notice=withdrawn');
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const code = err instanceof ApiError && CONSENT_API_ERROR_CODES.includes(err.code) ? err.code : CONSENT_GENERIC_ERROR;
    d.log?.('warn', 'consent action refused', { action, code, status: err instanceof ApiError ? err.status : undefined });
    return back(d, `?error=${code}`);
  }
}
