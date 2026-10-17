// Account area forms of the browser (ACC-001): the same-origin POST handlers behind /account/profile and /account/language-region, written as plain Request -> Response
// functions like consent-handlers.ts. They hold the session's access token server-side and call PATCH /api/v1/account/profile; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin), a signed-in session is required (a signed-out browser is sent to the page, which sends it to sign in).
//  - The body must be application/x-www-form-urlencoded, at most ACCOUNT_FORM_MAX_BYTES, and carry EXACTLY the fields of its form, each once and within its length limit:
//    anything else (an unknown or repeated field, a missing field, another content type, a larger body) is a 400 and changes nothing.
//  - The SERVER (the API) validates every value and decides whether anything changed; the profile of the role's sections decides who may write which field.
//  - Nothing a person submitted is put in a redirect, a cookie or a log line. A result is a 303 back to the SAME page with a closed word: `?saved=1`, `?unchanged=1` or
//    `?error=<save|choice|first_name_<code>|last_name_<code>>` (a profile rejected for both names carries two words); the targets are fixed, so there is no open redirect.
//  - A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`). Every response is `Cache-Control: no-store`; the clickjacking
//    headers come from next.config.ts, which covers every route.
import { IanaTimeZone, Locale, PROFILE_ISSUE_CODES, PatchProfileRequest, type ProfileIssueCode } from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const ACCOUNT_FORM_ACTIONS = ['profile', 'language-region'] as const;
export type AccountFormAction = (typeof ACCOUNT_FORM_ACTIONS)[number];
/** Largest request body accepted (bytes of the encoded form): both forms are a few short fields. */
export const ACCOUNT_FORM_MAX_BYTES = 4096;
/** Largest length of one field (characters): the contract's limit of a name (500) and of a time zone / locale tag. */
const FIELD_MAX: Readonly<Record<string, number>> = { firstName: 500, lastName: 500, preferredLocale: 35, timeZone: 64 };
const FIELDS: Readonly<Record<AccountFormAction, readonly string[]>> = {
  profile: ['firstName', 'lastName'],
  'language-region': ['preferredLocale', 'timeZone'],
};
const PAGE: Readonly<Record<AccountFormAction, string>> = { profile: '/account/profile', 'language-region': '/account/language-region' };

/** The two name fields of the profile form and the word each contributes to a redirect (`first_name_required`, `last_name_too_long`, ...). */
export const PROFILE_NAME_FIELDS = [
  { field: 'firstName', word: 'first_name' },
  { field: 'lastName', word: 'last_name' },
] as const;
/** Every name error word -> the field it belongs to and the issue code: a closed list of 2 fields x 3 codes (the page ties the message to that field). */
export const NAME_ERROR_WORDS: Readonly<Record<string, { field: (typeof PROFILE_NAME_FIELDS)[number]['field']; code: ProfileIssueCode }>> = Object.fromEntries(
  PROFILE_NAME_FIELDS.flatMap((f) => PROFILE_ISSUE_CODES.map((code) => [`${f.word}_${code.toLowerCase()}`, { field: f.field, code }] as const)),
);
/**
 * The words a redirect may carry in `?error=`: a closed list the pages map to registry copy. A profile rejected for BOTH names carries two words (`?error=first_name_x&error=last_name_y`,
 * the first issue of each field), never more; every other failure carries exactly one word.
 */
export const ACCOUNT_FORM_ERRORS = ['save', 'choice', ...Object.keys(NAME_ERROR_WORDS)] as const;
export const isAccountFormAction = (v: string): v is AccountFormAction => (ACCOUNT_FORM_ACTIONS as readonly string[]).includes(v);

const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });
const back = (d: AuthDeps, action: AccountFormAction, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}${PAGE[action]}${query}`, ...NO_STORE } });

/** The fields of a urlencoded body, or undefined when the body is not exactly the form's fields (each once, none longer than its limit, no oversized body). */
async function strictUrlencoded(req: Request, allowed: readonly string[]): Promise<Record<string, string> | undefined> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return undefined;
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > ACCOUNT_FORM_MAX_BYTES) return undefined;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, 'utf8') > ACCOUNT_FORM_MAX_BYTES) return undefined;
  const pairs = [...new URLSearchParams(text)];
  const out: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (!allowed.includes(name) || Object.hasOwn(out, name) || value.length > (FIELD_MAX[name] ?? 0)) return undefined;
    out[name] = value;
  }
  return allowed.every((n) => Object.hasOwn(out, n)) ? out : undefined;
}

/**
 * The error words of a rejected save: the first issue of each name field (a closed list that carries the field), a rejected locale / time zone, else a plain failure.
 * Nothing but closed words: the API's issue messages and the values never reach the redirect.
 */
function errorWords(action: AccountFormAction, err: ApiError): string[] {
  if (err.status === 400) {
    const reason = err.details?.reason;
    if (action === 'language-region' && (reason === 'UNKNOWN_LOCALE' || reason === 'UNKNOWN_TIME_ZONE')) return ['choice'];
    const issues = err.details?.issues;
    if (action === 'profile' && Array.isArray(issues)) {
      const words = PROFILE_NAME_FIELDS.flatMap(({ field, word }) => {
        const issue = (issues as { field?: unknown; code?: unknown }[]).find(
          (i) => i?.field === field && (PROFILE_ISSUE_CODES as readonly unknown[]).includes(i.code),
        );
        return issue ? [`${word}_${(issue.code as ProfileIssueCode).toLowerCase()}`] : [];
      });
      if (words.length > 0) return words;
    }
  }
  return ['save'];
}

/**
 * POST /auth/account/profile (fields `firstName`, `lastName` -> PATCH {firstName, lastName}) and POST /auth/account/language-region (fields `preferredLocale`, `timeZone`; an
 * empty value is "use the default for my area" -> null). The result is always a 303 back to the page (or, for a revoked session, to Keycloak's end-session endpoint).
 */
export async function handleAccountForm(req: Request, d: AuthDeps, action: AccountFormAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the account forms');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return back(d, action, ''); // signed out: the page sends the browser to sign in and brings it back
  const fields = await strictUrlencoded(req, FIELDS[action]);
  if (!fields) return badRequest();

  let patch: PatchProfileRequest;
  if (action === 'profile') {
    patch = { firstName: fields.firstName!, lastName: fields.lastName! };
  } else {
    const locale = fields.preferredLocale!;
    const zone = fields.timeZone!;
    // a value that is not even well-formed is a rejected choice (the SERVER still decides which well-formed values are available); nothing is echoed
    if ((locale !== '' && !Locale.safeParse(locale).success) || (zone !== '' && !IanaTimeZone.safeParse(zone).success)) return back(d, action, '?error=choice');
    patch = { preferredLocale: locale === '' ? null : locale, timeZone: zone === '' ? null : zone };
  }
  if (!PatchProfileRequest.safeParse(patch).success) return back(d, action, action === 'profile' ? '?error=save' : '?error=choice');

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  const patchProfile = api.patchAccountProfile;
  if (!patchProfile) throw new Error('AuthDeps.api lacks the account area calls'); // a wiring error is a 500, not an API failure shown to the person
  try {
    const result = await patchProfile(patch, opts);
    return back(d, action, result.changed ? '?saved=1' : '?unchanged=1');
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const words = err instanceof ApiError ? errorWords(action, err) : ['save'];
    d.log?.('warn', 'account form refused', {
      action,
      code: err instanceof ApiError ? err.code : 'API_ERROR',
      status: err instanceof ApiError ? err.status : undefined,
    });
    return back(d, action, `?${words.map((w) => `error=${w}`).join('&')}`);
  }
}
