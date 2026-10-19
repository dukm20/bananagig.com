// Provider public profile actions of the browser (PRO-002): the same-origin POST handlers behind the temporary /provider/profile page, written like the Gig handlers next to them
// (`gig-handlers.ts`, `gig-draft-handlers.ts`). They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin). A signed-in session is required. Every action is an explicit POST of the person.
//  - A form carries EXACTLY the fields of its action; an unknown, missing or repeated field, a file where text belongs or a malformed revision is a 400 and changes nothing. No account
//    id, public profile id, role, status, asset or object key exists in any form: the profile is the caller's, found by the verified token.
//  - The display name and the bio are the provider's own text. They go to the API in the request BODY and nowhere else: never into a redirect, a cookie, a header or a log line. A text
//    above the contract's raw ceiling is refused here as a named problem without being echoed; every other rule (the configured lengths, characters, markup) is the API's decision.
//  - THE UPLOAD happens server-side exactly like a Gig photo: the browser posts the file to THIS handler; it asks the API to authorize one upload, PUTs the bytes to the one-time URL
//    with `node:http(s)` (never `fetch`), then asks the API to finalize. The body is read as a bounded stream; a file above the profile's configured maximum but inside the structural
//    ceiling is read to its end and discarded, so the browser gets an ordinary 303 ("refused"). The one-time URL, the file name and the bytes never reach a redirect, a cookie, a header
//    of the answer or a log line.
//  - A result is a 303 back to /provider/profile with `?notice=<word>` or `?error=<code>`, a code from a CLOSED list of the API's profile codes (anything else is `API_ERROR`),
//    optionally naming the problem the person can fix with closed words (`&issue=<REASON>` repeated, `&reason=<refusal reason>`); the redirect ends in the fragment of the section the
//    action works on. A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import { createHash } from 'node:crypto';
import {
  GIG_MEDIA_FILE_CEILING,
  PROFILE_BIO_CEILING,
  PROFILE_DISPLAY_NAME_CEILING,
  RemoveProfilePhotoRequest,
  RequestProfilePhotoUploadRequest,
  SetProfileVisibilityRequest,
  UpdateProviderProfileRequest,
  type ProfileIssueReason,
} from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { PROFILE_API_ERROR_CODES, PROFILE_GENERIC_ERROR, isMediaRefusalReason, isProfileIssueReason, type ProfileNotice } from '../provider-profile';
import { UPLOAD_FRAMING_BYTES, putBytes, putHeaders, readForm, textFields, tooLarge } from './gig-draft-handlers';
import { NO_STORE, REVISION, badRequest, forbidden, location, methodNotAllowed, textOrNull } from './gig-handlers';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

export const PROFILE_ACTIONS = ['save', 'visibility', 'photo-upload', 'photo-remove'] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];
export const isProfileAction = (v: string): v is ProfileAction => (PROFILE_ACTIONS as readonly string[]).includes(v);

const PAGE = '/provider/profile';
/**
 * Where the redirect lands: the message itself, so a keyboard or screen-reader user starts reading at the outcome. A notice lands on the status line (`#profile-notice`), a refusal that
 * names problems on their list (`#profile-issues`), any other refusal on the alert (`#profile-error`). The page gives each of the three `tabIndex={-1}`.
 */
export const NOTICE_FRAGMENT = '#profile-notice';
export const ISSUES_FRAGMENT = '#profile-issues';
export const ERROR_FRAGMENT = '#profile-error';
export const fragmentOf = (query: string): string =>
  query.startsWith('?notice=') ? NOTICE_FRAGMENT : query.includes('&issue=') ? ISSUES_FRAGMENT : ERROR_FRAGMENT;
/** The bound of the save form: the contract's raw text ceilings at 4 bytes per character, urlencoded (three bytes per byte), with room for the other fields. */
const SAVE_FORM_MAX_BYTES = (PROFILE_DISPLAY_NAME_CEILING * 4 + PROFILE_BIO_CEILING * 4) * 4 * 3 + 4096;
/** The small forms (visibility, remove) carry a revision and one word. */
const SMALL_FORM_MAX_BYTES = 4096;
/** The error word of a failed hand-over of the file to the object store (the API never sees the bytes; the unfinished upload is replaced by the next one). */
const HAND_OVER_FAILED = 'PROFILE_UNAVAILABLE';
const VALIDATION_FAILED = 'PROFILE_VALIDATION_FAILED';
/** The file was missing, empty, too large or untyped, so the API was not even asked. */
const MEDIA_REFUSED = 'PROFILE_MEDIA_REFUSED';
/** The most issue reasons one redirect names. */
const MAX_ISSUES = 4;

/** The closed-list word of an error thrown by the API client, or the generic word. */
export const profileErrorWordOf = (err: unknown): string =>
  err instanceof ApiError && PROFILE_API_ERROR_CODES.includes(err.code) ? err.code : PROFILE_GENERIC_ERROR;
/**
 * The problem the API named, as redirect words: for a refused text or an incomplete profile the DISTINCT issue reasons on the closed list (`&issue=<REASON>`, at most four); for a
 * refused photo the `details.reason` when it is one of the contract's closed refusal reasons (`&reason=<reason>`). Anything else is dropped.
 */
export function profileIssueQueryOf(err: unknown): string {
  if (!(err instanceof ApiError)) return '';
  if (err.code === MEDIA_REFUSED) {
    const reason = err.details?.reason;
    return isMediaRefusalReason(reason) ? `&reason=${reason}` : '';
  }
  if (err.code !== VALIDATION_FAILED && err.code !== 'PROFILE_INCOMPLETE') return '';
  const issues = err.details?.issues;
  if (!Array.isArray(issues)) return '';
  const reasons: ProfileIssueReason[] = [];
  for (const raw of issues) {
    const reason = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).reason : undefined;
    if (isProfileIssueReason(reason) && !reasons.includes(reason) && reasons.length < MAX_ISSUES) reasons.push(reason);
  }
  return reasons.map((r) => `&issue=${r}`).join('');
}

/** The reasons a text above the contract's raw ceiling is refused for (named without echoing the text). */
function textIssueQuery(displayNameLength: number, bioLength: number): string {
  return [
    displayNameLength > PROFILE_DISPLAY_NAME_CEILING * 4 ? '&issue=DISPLAY_NAME_TOO_LONG' : '',
    bioLength > PROFILE_BIO_CEILING * 4 ? '&issue=BIO_TOO_LONG' : '',
  ].join('');
}

/**
 * POST /auth/provider/profile/<action>: `save` (`displayName`, `bio`, and `expectedRevision` once the profile exists; without it the profile is created first), `visibility`
 * (`expectedRevision`, `visibility`), `photo-upload` (multipart: `expectedRevision`, `file`) and `photo-remove` (`expectedRevision`). The result is always a 303 back to
 * /provider/profile (or, for a revoked session, to Keycloak).
 */
export async function handleProfileAction(req: Request, d: AuthDeps, action: ProfileAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the profile actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  if (
    !api.getProviderProfile ||
    !api.createProviderProfile ||
    !api.updateProviderProfile ||
    !api.setProviderProfileVisibility ||
    !api.requestProviderProfilePhotoUpload ||
    !api.finalizeProviderProfilePhoto ||
    !api.removeProviderProfilePhoto
  )
    throw new Error('AuthDeps.api lacks the profile calls');
  const calls = {
    getProviderProfile: api.getProviderProfile,
    createProviderProfile: api.createProviderProfile,
    updateProviderProfile: api.updateProviderProfile,
    setProviderProfileVisibility: api.setProviderProfileVisibility,
    requestProviderProfilePhotoUpload: api.requestProviderProfilePhotoUpload,
    finalizeProviderProfilePhoto: api.finalizeProviderProfilePhoto,
    removeProviderProfilePhoto: api.removeProviderProfilePhoto,
  };

  const go = (query: string): Response => location(d, PAGE, `${query}${fragmentOf(query)}`);
  const notice = (word: ProfileNotice): Response => go(`?notice=${word}`);
  /** A failure of the API: a revoked session ends the session; anything else is a closed error word (and a named problem when the API named one). */
  const fail = async (err: unknown): Promise<Response> => {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const word = profileErrorWordOf(err);
    d.log?.('warn', 'profile action refused', { action, code: word, status: err instanceof ApiError ? err.status : undefined });
    return go(`?error=${word}${profileIssueQueryOf(err)}`);
  };
  const guarded = async (work: () => Promise<ProfileNotice>): Promise<Response> => {
    try {
      return notice(await work());
    } catch (err) {
      return fail(err);
    }
  };

  if (action === 'photo-upload') return handleUpload(req, d, calls, opts, go, fail);

  const allowed =
    action === 'save' ? ['displayName', 'bio', 'expectedRevision'] : action === 'visibility' ? ['expectedRevision', 'visibility'] : ['expectedRevision'];
  const required = action === 'save' ? ['displayName', 'bio'] : allowed;
  const form = await readForm(req, action === 'save' ? SAVE_FORM_MAX_BYTES : SMALL_FORM_MAX_BYTES, false);
  if (form === 'too_large') return tooLarge();
  if (!form) return badRequest();
  const fields = textFields(form, allowed, required);
  if (!fields) return badRequest();
  const revisionText = fields.get('expectedRevision');
  if (revisionText !== undefined && !REVISION.test(revisionText)) return badRequest();
  const expectedRevision = revisionText === undefined ? undefined : Number(revisionText);

  if (action === 'save') {
    const rawName = fields.get('displayName')!;
    const rawBio = fields.get('bio')!;
    const displayName = textOrNull(rawName);
    const bio = textOrNull(rawBio);
    // what the person typed: a text beyond the raw ceiling is their slip, not a forged form, so it comes back as a NAMED closed reason and is never echoed
    const body = UpdateProviderProfileRequest.safeParse({ expectedRevision: expectedRevision ?? 1, displayName, bio });
    if (!body.success) return go(`?error=${VALIDATION_FAILED}${textIssueQuery(rawName.length, rawBio.length)}`);
    return guarded(async () => {
      if (expectedRevision !== undefined) {
        await calls.updateProviderProfile(body.data, opts);
        return 'saved';
      }
      // no profile yet: create it (idempotent), then save what was typed at the revision the API answered
      const made = await calls.createProviderProfile(opts);
      const revision = made.state.profile?.revision;
      if (revision === undefined) throw new ApiError(502, 'UNEXPECTED_RESPONSE', 'INTERNAL', 'no profile after create');
      if (!made.created || displayName !== null || bio !== null) await calls.updateProviderProfile({ ...body.data, expectedRevision: revision }, opts);
      return made.created ? 'created' : 'saved';
    });
  }

  if (expectedRevision === undefined) return badRequest();
  if (action === 'visibility') {
    const body = SetProfileVisibilityRequest.safeParse({ expectedRevision, visibility: fields.get('visibility') });
    if (!body.success) return badRequest();
    return guarded(async () => {
      await calls.setProviderProfileVisibility(body.data, opts);
      return body.data.visibility === 'PUBLIC' ? 'published' : 'unpublished';
    });
  }
  // photo-remove
  const body = RemoveProfilePhotoRequest.safeParse({ expectedRevision });
  if (!body.success) return badRequest();
  return guarded(async () => {
    await calls.removeProviderProfilePhoto(body.data, opts);
    return 'photo_removed';
  });
}

type Api = ReturnType<NonNullable<AuthDeps['api']>>;
type Calls = Required<Pick<Api, 'getProviderProfile' | 'requestProviderProfilePhotoUpload' | 'finalizeProviderProfilePhoto'>>;

/** The upload: read the limit, authorize, hand the bytes to the object store, finalize. */
async function handleUpload(
  req: Request,
  d: AuthDeps,
  api: Calls,
  opts: AccountCallOptions,
  go: (query: string) => Response,
  fail: (err: unknown) => Promise<Response>,
): Promise<Response> {
  const query = new URL(req.url).searchParams;
  if ([...query.keys()].length !== 0) return badRequest();
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= GIG_MEDIA_FILE_CEILING + UPLOAD_FRAMING_BYTES)) return tooLarge(); // refused before anything is asked or read

  // A file above the configured maximum but inside the structural ceiling is read to its end and DISCARDED, so the browser gets an ordinary answer ("refused") and not a reset
  // connection; only a body beyond the structural ceiling (plus framing) is cut off with a 413. The form is checked BEFORE the API is asked anything.
  const form = await readForm(req, GIG_MEDIA_FILE_CEILING + UPLOAD_FRAMING_BYTES, true);
  if (form === 'too_large') return tooLarge();
  if (!form) return badRequest();
  // exactly one of each: the revision as text and one file
  let revisionText: string | undefined;
  let upload: File | undefined;
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    const only = values[0];
    if (values.length !== 1 || only === undefined) return badRequest();
    if (name === 'file' && typeof only !== 'string') upload = only;
    else if (name === 'expectedRevision' && typeof only === 'string') revisionText = only;
    else return badRequest();
  }
  if (!upload || revisionText === undefined || !REVISION.test(revisionText)) return badRequest();

  // the bound is the configuration the API computed for the profile; without a profile there is nothing to attach a photo to
  let maxFileSize: number;
  try {
    const state = await api.getProviderProfile(opts);
    if (!state.exists) return go('?error=PROFILE_NOT_FOUND');
    maxFileSize = Math.min(state.limits.photoMaxSizeBytes, GIG_MEDIA_FILE_CEILING);
  } catch (err) {
    return fail(err);
  }
  // a browser that posts the form with no file chosen sends an empty file part: the person's slip, answered with the registry's "refused" message
  if (upload.size < 1 || upload.size > maxFileSize) return go(`?error=${MEDIA_REFUSED}`);
  // a file the browser could not type, or an absurd type, is the person's slip too
  if (upload.type === '' || upload.type.length > 100) return go(`?error=${MEDIA_REFUSED}`);
  const bytes = new Uint8Array(await upload.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const request = RequestProfilePhotoUploadRequest.safeParse({ expectedRevision: Number(revisionText), mimeType: upload.type, sizeBytes: upload.size, sha256 });
  if (!request.success) return go(`?error=${MEDIA_REFUSED}`);

  try {
    const authorization = await api.requestProviderProfilePhotoUpload(request.data, opts);
    // the one-time URL goes nowhere but this request
    const status = await putBytes(authorization.upload.url, putHeaders(request.data.mimeType, authorization.upload.headers, bytes.byteLength), bytes);
    if (status < 200 || status >= 300) {
      d.log?.('warn', 'profile photo hand-over refused', { action: 'photo-upload', status });
      return go(`?error=${HAND_OVER_FAILED}`);
    }
    await api.finalizeProviderProfilePhoto({ expectedRevision: authorization.revision, sha256 }, opts);
    return go('?notice=photo_added');
  } catch (err) {
    return fail(err);
  }
}
