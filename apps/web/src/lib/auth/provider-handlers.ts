// Provider registration actions of the browser (PRO-001): the same-origin POST handlers behind the temporary /provider/registration page, written as plain
// Request -> Response functions like the consent and security handlers. They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin). A signed-in session is required. Starting, choosing, submitting and cancelling are ALWAYS
//    an explicit POST of the person: no GET changes state, nothing is pre-selected or auto-submitted.
//  - A form carries EXACTLY the fields of its action: an unknown field, a repeated single-value field, a file or a malformed value is a 400 and changes nothing. No
//    account id, role, status or completion flag exists in any form: the server decides all of them from the verified token (the account) and from its owners.
//  - Nothing a person submitted is put in a redirect, a cookie or a log line. A result is a 303 back to /provider/registration with `?notice=<word>` or
//    `?error=<code>`, where the code is one of a CLOSED list of the API's provider codes (anything else is `API_ERROR`); the target is fixed, so there is no open redirect.
//    A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import { PROVIDER_ERROR_CODES, ReplaceProviderServicesRequest, SelectProviderMarketRequest, SubmitProviderRegistrationRequest } from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const PROVIDER_ACTIONS = ['start', 'market', 'services', 'submit', 'cancel'] as const;
export type ProviderAction = (typeof PROVIDER_ACTIONS)[number];
export const isProviderAction = (v: string): v is ProviderAction => (PROVIDER_ACTIONS as readonly string[]).includes(v);

/** The notice words of `/provider/registration?notice=` (the page maps each to a registry key). */
export const PROVIDER_NOTICES = ['started', 'resumed', 'market_saved', 'services_saved', 'submitted', 'cancelled'] as const;
/** The API error codes (`PROVIDER_<code>`) a redirect may carry in `?error=`: a closed list; every other failure is `API_ERROR`. */
export const PROVIDER_API_ERROR_CODES: readonly string[] = PROVIDER_ERROR_CODES.map((c) => `PROVIDER_${c}`);
export const PROVIDER_GENERIC_ERROR = 'API_ERROR';

const REVISION = /^[1-9][0-9]{0,8}$/;
/** The most service types one form may carry (the contract's ceiling; the server applies the configured maximum). */
const MAX_SERVICES = 50;

const back = (d: AuthDeps, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/provider/registration${query}`, ...NO_STORE } });
const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });

interface ProviderForm {
  /** Single-value fields, each once. */
  single: Record<string, string>;
  /** The values of the repeated `serviceTypeCode` field (the checked boxes), at most MAX_SERVICES. */
  services: string[];
}

/** The fields of a submitted form when it holds EXACTLY the allowed names as text; `serviceTypeCode` alone may repeat. undefined for anything else. */
async function providerForm(req: Request, allowed: readonly string[], repeated: boolean): Promise<ProviderForm | undefined> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undefined;
  }
  const single: Record<string, string> = {};
  let services: string[] = [];
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    if (values.some((v) => typeof v !== 'string')) return undefined;
    if (repeated && name === 'serviceTypeCode') {
      if (values.length > MAX_SERVICES) return undefined;
      services = values as string[];
    } else if (allowed.includes(name) && values.length === 1) single[name] = values[0] as string;
    else return undefined;
  }
  return { single, services };
}

/**
 * POST /auth/provider/start (no fields), /market (`marketCode`, optional `expectedRevision`), /services (repeated `serviceTypeCode`, optional `expectedRevision`),
 * /submit (`expectedRevision`) and /cancel (no fields). The result is always a 303 back to /provider/registration (or, for a revoked session, to Keycloak's end-session endpoint).
 */
export async function handleProviderAction(req: Request, d: AuthDeps, action: ProviderAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the provider actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const allowed =
    action === 'market' ? ['marketCode', 'expectedRevision'] : action === 'services' ? ['expectedRevision'] : action === 'submit' ? ['expectedRevision'] : [];
  const form = await providerForm(req, allowed, action === 'services');
  if (!form) return badRequest();
  const revisionText = form.single.expectedRevision;
  if (revisionText !== undefined && !REVISION.test(revisionText)) return badRequest();
  const expectedRevision = revisionText === undefined ? undefined : Number(revisionText);

  let market: SelectProviderMarketRequest | undefined;
  let services: ReplaceProviderServicesRequest | undefined;
  let submit: SubmitProviderRegistrationRequest | undefined;
  if (action === 'market') {
    const body = SelectProviderMarketRequest.safeParse({ marketCode: form.single.marketCode, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
    if (!body.success) return badRequest();
    market = body.data;
  } else if (action === 'services') {
    const body = ReplaceProviderServicesRequest.safeParse({ serviceTypeCodes: form.services, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
    if (!body.success) return badRequest();
    services = body.data;
  } else if (action === 'submit') {
    const body = SubmitProviderRegistrationRequest.safeParse({ expectedRevision });
    if (!body.success) return badRequest();
    submit = body.data;
  }

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  if (
    !api.startProviderRegistration ||
    !api.selectProviderMarket ||
    !api.replaceProviderServices ||
    !api.submitProviderRegistration ||
    !api.cancelProviderRegistration
  )
    throw new Error('AuthDeps.api lacks the provider calls');
  try {
    if (action === 'start') {
      const r = await api.startProviderRegistration(opts);
      return back(d, r.created ? '?notice=started' : '?notice=resumed');
    }
    if (action === 'market') {
      await api.selectProviderMarket(market!, opts);
      return back(d, '?notice=market_saved');
    }
    if (action === 'services') {
      await api.replaceProviderServices(services!, opts);
      return back(d, '?notice=services_saved');
    }
    if (action === 'submit') {
      await api.submitProviderRegistration(submit!, opts);
      return back(d, '?notice=submitted');
    }
    await api.cancelProviderRegistration({}, opts);
    return back(d, '?notice=cancelled');
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const code = err instanceof ApiError && PROVIDER_API_ERROR_CODES.includes(err.code) ? err.code : PROVIDER_GENERIC_ERROR;
    d.log?.('warn', 'provider action refused', { action, code, status: err instanceof ApiError ? err.status : undefined });
    return back(d, `?error=${code}`);
  }
}
