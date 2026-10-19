// Variants, add-ons and photos of a Gig DRAFT (CAT-004): the same-origin POST handlers behind the temporary draft editor, written like the Gig handlers next to them
// (`gig-handlers.ts`) and the evidence upload of TRUST-001 (`verification-handlers.ts`). They hold the session's access token server-side and call the API.
//
//  - POST only, same-origin only (the Origin header must be the web origin). A signed-in session is required. Every action is an explicit POST of the person.
//  - A form carries EXACTLY the fields of its action; an unknown, missing or repeated field, a file where text belongs, a malformed identifier or an index outside the rows is a
//    400 and changes nothing. No account id, role, status, currency, object key or version exists in any form. The dynamic option rows are `row.<i>.<name>`, at most
//    GIG_OPTIONS_CEILING of them, contiguous from 0. Provider text (names, descriptions, alt text) goes to the API in the request BODY and nowhere else: never into a redirect, a cookie
//    or a log line. A value that is not even well-formed for its kind (a number that is not a number) is refused here as `GIG_VALIDATION_FAILED` without being echoed.
//  - THE OPTION FORM is one whole-set form: the handler applies the submitted intent (`save`, `add`, `remove:<i>`, `up:<i>`, `down:<i>`) to the submitted rows, drops a row that is
//    entirely blank and has no key (the "new item" row of the page), and PUTs the whole list under the revision last read. The server decides everything else.
//  - THE UPLOAD happens server-side: the browser posts the file to THIS handler; the handler asks the API to authorize one upload, PUTs the bytes to the one-time URL with
//    `node:http(s)` (never `fetch`: Next.js traces fetch with its full URL, which carries the signature), then asks the API to finalize. The request body is read as a STREAM
//    and cancelled beyond the STRUCTURAL file ceiling (plus room for the other fields and the multipart framing): a file above the draft's configured maximum but inside that ceiling is
//    read to its end and discarded, so the browser gets an ordinary 303 ("refused") and not a reset connection. An empty file part (no file chosen) is "refused" too.
//    The one-time URL, the file name and the bytes never reach a redirect, a cookie, a header of the answer or a log line.
//  - Every redirect ends in the fragment of the section the action works on (#gig-variants, #gig-add-ons, #gig-photos). A problem the person can fix is NAMED by one closed
//    reason (`&issue=<GIG_ISSUE_REASONS word>&target=<contract target>[&item=<key or photo id>]`): from the API's `details.issues` of a 400 GIG_VALIDATION_FAILED or found here
//    (a number that is not a number); never typed text. The page maps the reason to its registry message.
//  - A result is a 303 back to /provider/gigs/<gigId> with `?notice=<word>` or `?error=<code>`, a code from a CLOSED list of the API's Gig codes (anything else is `API_ERROR`).
//    The only value ever in a redirect path is a canonical UUID. A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  FieldKey,
  GIG_ALT_TEXT_CEILING,
  GIG_DELTA_MINUTES_CEILING,
  GIG_MEDIA_FILE_CEILING,
  GIG_OPTIONS_CEILING,
  GIG_PRICE_MINOR_CEILING,
  DetachGigMediaRequest,
  FinalizeGigMediaRequest,
  GigItemKey,
  ReorderGigMediaRequest,
  ReplaceGigAddOnsRequest,
  ReplaceGigVariantsRequest,
  RequestGigMediaUploadRequest,
  UpdateGigMediaRequest,
  type GigOptionInput,
} from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import {
  GIG_FORM_MAX_BYTES,
  MINOR_UNITS,
  MINUTES,
  NO_STORE,
  REVISION,
  UUID,
  badRequest,
  boundedBody,
  forbidden,
  gigErrorWordOf,
  issueQuery,
  issueQueryOf,
  location,
  methodNotAllowed,
  textOrNull,
} from './gig-handlers';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

export const GIG_DRAFT_ACTIONS = ['variants', 'add-ons', 'photo-upload', 'photo-finish', 'photo-alt', 'photo-remove', 'photo-move'] as const;
export type GigDraftAction = (typeof GIG_DRAFT_ACTIONS)[number];
export const isGigDraftAction = (v: string): v is GigDraftAction => (GIG_DRAFT_ACTIONS as readonly string[]).includes(v);
/** The notice words these actions add to `/provider/gigs/<gigId>?notice=` (the page maps each to a registry key and shows it only when the data proves it). */
export const GIG_DRAFT_NOTICES = ['variants_saved', 'add_ons_saved', 'photo_added', 'photo_removed', 'photo_order_saved', 'photo_saved'] as const;
const NOTICE: Record<GigDraftAction, (typeof GIG_DRAFT_NOTICES)[number]> = {
  variants: 'variants_saved',
  'add-ons': 'add_ons_saved',
  'photo-upload': 'photo_added',
  'photo-finish': 'photo_added',
  'photo-alt': 'photo_saved',
  'photo-remove': 'photo_removed',
  'photo-move': 'photo_order_saved',
};

/** The error word of a failed hand-over of the file to the object store (the API never sees the bytes; the pending photo stays and can be finished or removed). */
const HAND_OVER_FAILED = 'GIG_UNAVAILABLE';
const VALIDATION_FAILED = 'GIG_VALIDATION_FAILED';
/** The file type was missing or absurd, so the API was not even asked. */
const MEDIA_REFUSED = 'GIG_MEDIA_REFUSED';
/** How long the hand-over of one file to the object store may take. */
const PUT_TIMEOUT_MS = 60_000;
/** Room for the other upload fields and the multipart framing around the file. */
export const UPLOAD_FRAMING_BYTES = 65_536;
const ROW_FIELD = /^row\.(0|[1-9][0-9]?)\.(key|name|description|price|duration)$/;
type RowPart = 'name' | 'description' | 'price' | 'duration';
const INTENT = /^(?:(save|add)|(remove|up|down):(0|[1-9][0-9]?))$/;
const MEDIA_ID_FIELD = 'mediaId';

// ---------------------------------------------------------------- the one-time upload: node:http(s), never fetch
/** Header names that never travel to the object store, whatever the API lists (the session, the framing and the host are not the store's business). */
const NEVER_FORWARDED = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
]);
/** The headers of the PUT: the content type, the length, and the other signed headers the API listed (plain names and values only). */
export function putHeaders(contentType: string, signed: Record<string, string>, length: number): Record<string, string> {
  const out: Record<string, string> = { 'content-type': contentType };
  for (const [name, value] of Object.entries(signed)) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(key) || NEVER_FORWARDED.has(key) || value.length > 1024 || /[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  out['content-length'] = String(length);
  return out;
}
/**
 * PUTs the bytes to the one-time upload URL and returns the HTTP status (0 when it could not be sent). It deliberately does NOT use the global `fetch` (Next.js wraps `fetch` in a
 * tracing span named after the full URL, and this URL carries its signature). No redirect is followed, only http(s) is spoken, and the request carries no cookie or token.
 */
export function putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<number> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(0);
      return;
    }
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : undefined;
    if (!client) {
      resolve(0);
      return;
    }
    const req = client.request(target, { method: 'PUT', headers, timeout: PUT_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', () => resolve(0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

// ---------------------------------------------------------------- form reading
export const tooLarge = (): Response => new Response('Payload too large', { status: 413, headers: NO_STORE });

/** The form of the request (urlencoded or multipart), read as a bounded stream; `too_large` once it exceeds `max`, undefined when it is not a form. */
export async function readForm(req: Request, max: number, multipart: boolean): Promise<FormData | 'too_large' | undefined> {
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!(multipart ? type.startsWith('multipart/form-data') : type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')))
    return undefined;
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= max)) return 'too_large';
  const bytes = await boundedBody(req, max);
  if (bytes === undefined) return 'too_large';
  try {
    return await new Request(req.url, {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
      body: bytes as unknown as BodyInit,
    }).formData();
  } catch {
    return undefined;
  }
}

/** The text fields of a form that holds each allowed name EXACTLY once as text (and every required one); undefined for a file, a repeat, an unknown name or a missing one. */
export function textFields(form: FormData, allowed: readonly string[], required: readonly string[], rows = false): Map<string, string> | undefined {
  const out = new Map<string, string>();
  let dynamic = 0;
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    if (values.length !== 1 || typeof values[0] !== 'string') return undefined;
    if (allowed.includes(name)) out.set(name, values[0]);
    else if (rows && ROW_FIELD.test(name) && ++dynamic <= GIG_OPTIONS_CEILING * 5) out.set(name, values[0]);
    else return undefined;
  }
  for (const name of required) if (!out.has(name)) return undefined;
  return out;
}

interface Row {
  key: string | undefined;
  name: string;
  description: string;
  price: string;
  duration: string;
}
/** The submitted rows in index order; undefined when the indexes are not exactly 0..n-1, a part is missing or a key is not a key. */
function rowsOf(fields: Map<string, string>): Row[] | undefined {
  const byIndex = new Map<number, Partial<Row>>();
  for (const [name, value] of fields) {
    const m = ROW_FIELD.exec(name);
    if (!m) continue;
    const i = Number(m[1]);
    if (i >= GIG_OPTIONS_CEILING) return undefined;
    const row = byIndex.get(i) ?? {};
    const part = m[2] as 'key' | RowPart;
    if (part === 'key') {
      if (value !== '' && !GigItemKey.safeParse(value).success) return undefined;
      row.key = value === '' ? undefined : value;
    } else row[part] = value;
    byIndex.set(i, row);
  }
  const out: Row[] = [];
  for (let i = 0; i < byIndex.size; i++) {
    const r = byIndex.get(i);
    if (!r || r.name === undefined || r.description === undefined || r.price === undefined || r.duration === undefined) return undefined;
    out.push({ key: r.key, name: r.name, description: r.description, price: r.price, duration: r.duration });
  }
  return out;
}
const isBlank = (r: Row): boolean =>
  r.key === undefined && r.name.trim() === '' && r.description.trim() === '' && r.price.trim() === '' && r.duration.trim() === '';

/** Applies `remove:<i>` / `up:<i>` / `down:<i>` to the submitted rows; undefined for an index outside them (or a move off either end). */
function applyIntent(rows: Row[], verb: string | undefined, index: number): Row[] | undefined {
  if (verb === undefined) return rows;
  if (index >= rows.length) return undefined;
  const out = [...rows];
  if (verb === 'remove') {
    out.splice(index, 1);
    return out;
  }
  const other = verb === 'up' ? index - 1 : index + 1;
  if (other < 0 || other >= out.length) return undefined;
  [out[index], out[other]] = [out[other]!, out[index]!];
  return out;
}

type OptionsResult = { ok: true; value: GigOptionInput[] } | { ok: false; reason: string; key: string | undefined };
/** The form's own ceilings (4 bytes per character of the contract's text ceilings): above them the person gets a named problem without the API being asked. */
const NAME_FORM_CEILING = 800;
const DESCRIPTION_FORM_CEILING = 8000;
/**
 * The options of the rows, or the first problem a number or a length has (a closed reason and the row's key, never the typed text). Blank price and duration mean 0 (no change to
 * the base); anything else must be a whole number of minor units / minutes within the contract's ceilings.
 */
function optionsOf(rows: Row[]): OptionsResult {
  const out: GigOptionInput[] = [];
  const bad = (reason: string, r: Row): OptionsResult => ({ ok: false, reason, key: r.key });
  for (const r of rows) {
    const price = r.price.trim();
    const duration = r.duration.trim();
    if (r.name.length > NAME_FORM_CEILING) return bad('OPTION_NAME_TOO_LONG', r);
    if (r.description.length > DESCRIPTION_FORM_CEILING) return bad('OPTION_DESCRIPTION_TOO_LONG', r);
    if (price !== '' && (!MINOR_UNITS.test(price) || Number(price) > GIG_PRICE_MINOR_CEILING)) return bad('OPTION_PRICE_DELTA_INVALID', r);
    if (duration !== '' && (!MINUTES.test(duration) || Number(duration) > GIG_DELTA_MINUTES_CEILING)) return bad('OPTION_DURATION_DELTA_INVALID', r);
    out.push({
      ...(r.key !== undefined ? { key: r.key } : {}),
      name: r.name,
      description: textOrNull(r.description),
      priceDeltaMinor: price === '' ? 0 : Number(price),
      durationDeltaMinutes: duration === '' ? 0 : Number(duration),
    });
  }
  return { ok: true, value: out };
}

const gigPath = (gigId: string): string => `/provider/gigs/${gigId}`;
/** The section of the editor each action works on: the redirect ends in it, so a keyboard user lands where they were (the notice or the alert is announced by its role). */
const FRAGMENT: Record<GigDraftAction, string> = {
  variants: '#gig-variants',
  'add-ons': '#gig-add-ons',
  'photo-upload': '#gig-photos',
  'photo-finish': '#gig-photos',
  'photo-alt': '#gig-photos',
  'photo-remove': '#gig-photos',
  'photo-move': '#gig-photos',
};

/**
 * POST /auth/provider/gigs/<action>: `variants` and `add-ons` (`gigId`, `expectedRevision`, `intent`, and `row.<i>.<key|name|description|price|duration>`), `photo-upload`
 * (multipart: `expectedRevision`, `fieldKey`, `altText`, `file`, with the Gig in the query as `gigId`), `photo-finish` and `photo-remove` (`gigId`, `expectedRevision`, `mediaId`),
 * `photo-alt` (those and `altText`) and `photo-move` (those and `direction` up or down). The result is always a 303 back to /provider/gigs/<gigId> (or, for a revoked session, to Keycloak).
 */
export async function handleGigDraftAction(req: Request, d: AuthDeps, action: GigDraftAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the Gig draft actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  if (
    !api.getGig ||
    !api.replaceGigVariants ||
    !api.replaceGigAddOns ||
    !api.requestGigMediaUpload ||
    !api.finalizeGigMedia ||
    !api.updateGigMedia ||
    !api.detachGigMedia ||
    !api.reorderGigMedia
  )
    throw new Error('AuthDeps.api lacks the Gig draft calls');

  /** Runs the API work; a refusal becomes the 303 with a closed error word (and a revoked session ends the session). */
  const go = (gigId: string, query: string): Response => location(d, gigPath(gigId), `${query}${FRAGMENT[action]}`);
  /** A notice of `NOTICE[action]` unless the action changed nothing the person asked for (`quiet`). */
  const guarded = async (gigId: string, work: () => Promise<void>, quiet = false): Promise<Response> => {
    try {
      await work();
      return go(gigId, quiet ? '' : `?notice=${NOTICE[action]}`);
    } catch (err) {
      if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
      const word = gigErrorWordOf(err);
      d.log?.('warn', 'gig draft action refused', { action, code: word, status: err instanceof ApiError ? err.status : undefined });
      return go(gigId, `?error=${word}${issueQueryOf(err)}`);
    }
  };
  /** A refusal made here, with the problem named when it is one the person can fix (a closed reason; never the typed text). */
  const refuse = (gigId: string, word: string, issue = ''): Response => go(gigId, `?error=${word}${issue}`);

  if (action === 'photo-upload') return handleUpload(req, d, session, api as UploadApi, opts, go);

  // ---- the urlencoded forms
  const rowsAction = action === 'variants' || action === 'add-ons';
  const allowed: string[] = ['gigId', 'expectedRevision'];
  if (rowsAction) allowed.push('intent');
  else {
    allowed.push(MEDIA_ID_FIELD);
    if (action === 'photo-alt') allowed.push('altText');
    if (action === 'photo-move') allowed.push('direction');
  }
  const form = await readForm(req, GIG_FORM_MAX_BYTES, false);
  if (form === 'too_large') return tooLarge();
  if (!form) return badRequest();
  const fields = textFields(form, allowed, allowed, rowsAction);
  if (!fields) return badRequest();
  const gigIdText = fields.get('gigId')!;
  const revisionText = fields.get('expectedRevision')!;
  if (!UUID.test(gigIdText) || !REVISION.test(revisionText)) return badRequest();
  const gigId = gigIdText.toLowerCase();
  const expectedRevision = Number(revisionText);

  if (rowsAction) {
    const intent = INTENT.exec(fields.get('intent')!);
    const submitted = rowsOf(fields);
    if (!intent || !submitted) return badRequest();
    const moved = applyIntent(submitted, intent[2], intent[3] === undefined ? 0 : Number(intent[3]));
    if (!moved) return badRequest();
    const kept = moved.filter((r) => !isBlank(r));
    const options = optionsOf(kept);
    const target = action === 'variants' ? 'variants' : 'addOns';
    // what the person typed: a number that is not a number is their slip, not a forged form, so it comes back as a NAMED closed reason and is never echoed
    if (!options.ok) return refuse(gigId, VALIDATION_FAILED, issueQuery(options.reason, target, options.key));
    // "Add" with nothing typed in the new row adds nothing: whatever else was typed is still saved, but no notice claims that something was added
    const quiet = intent[1] === 'add' && !kept.some((r) => r.key === undefined);
    if (action === 'variants') {
      const body = ReplaceGigVariantsRequest.safeParse({ expectedRevision, variants: options.value });
      if (!body.success) return refuse(gigId, VALIDATION_FAILED);
      return guarded(gigId, async () => void (await api.replaceGigVariants!(gigId, body.data, opts)), quiet);
    }
    const body = ReplaceGigAddOnsRequest.safeParse({ expectedRevision, addOns: options.value });
    if (!body.success) return refuse(gigId, VALIDATION_FAILED);
    return guarded(gigId, async () => void (await api.replaceGigAddOns!(gigId, body.data, opts)), quiet);
  }

  const mediaIdText = fields.get(MEDIA_ID_FIELD)!;
  if (!UUID.test(mediaIdText)) return badRequest();
  const mediaId = mediaIdText.toLowerCase();
  if (action === 'photo-finish') {
    const body = FinalizeGigMediaRequest.safeParse({ expectedRevision });
    if (!body.success) return badRequest();
    return guarded(gigId, async () => void (await api.finalizeGigMedia!(gigId, mediaId, body.data, opts)));
  }
  if (action === 'photo-remove') {
    const body = DetachGigMediaRequest.safeParse({ expectedRevision });
    if (!body.success) return badRequest();
    return guarded(gigId, async () => void (await api.detachGigMedia!(gigId, mediaId, body.data, opts)));
  }
  if (action === 'photo-alt') {
    const body = UpdateGigMediaRequest.safeParse({ expectedRevision, altText: textOrNull(fields.get('altText')) });
    if (!body.success) return refuse(gigId, VALIDATION_FAILED, issueQuery('MEDIA_ALT_TOO_LONG', 'media', mediaId));
    return guarded(gigId, async () => void (await api.updateGigMedia!(gigId, mediaId, body.data, opts)));
  }
  // photo-move: the whole new order is computed from the server's own list of the draft at the revision the person saw, never from the form
  const direction = fields.get('direction');
  if (direction !== 'up' && direction !== 'down') return badRequest();
  return guarded(gigId, async () => {
    const detail = await api.getGig!(gigId, opts);
    const draft = detail.draftVersion;
    if (!draft || draft.status !== 'DRAFT') throw new ApiError(409, 'GIG_NO_DRAFT', 'CONFLICT', 'no draft');
    if (draft.revision !== expectedRevision) throw new ApiError(409, 'GIG_STALE_DRAFT', 'CONFLICT', 'stale draft');
    const ordered = [...draft.media].sort((a, b) => a.displayOrder - b.displayOrder).map((m) => ({ id: m.mediaId.toLowerCase(), fieldKey: m.fieldKey }));
    const at = ordered.findIndex((m) => m.id === mediaId);
    if (at < 0) throw new ApiError(404, 'GIG_MEDIA_NOT_FOUND', 'NOT_FOUND', 'no such photo');
    // the photo swaps places with its neighbour in the SAME template field (the page lists the photos of each field on their own)
    const step = direction === 'up' ? -1 : 1;
    let other = at + step;
    while (other >= 0 && other < ordered.length && ordered[other]!.fieldKey !== ordered[at]!.fieldKey) other += step;
    if (other < 0 || other >= ordered.length) throw new ApiError(409, 'GIG_MEDIA_REFUSED', 'CONFLICT', 'cannot move'); // the page offers no such button
    [ordered[at], ordered[other]] = [ordered[other]!, ordered[at]!];
    const ids = ordered.map((m) => m.id);
    const body = ReorderGigMediaRequest.parse({ expectedRevision, mediaIds: ids });
    await api.reorderGigMedia!(gigId, body, opts);
  });
}

type Api = ReturnType<NonNullable<AuthDeps['api']>>;
type UploadApi = Required<Pick<Api, 'getGig' | 'requestGigMediaUpload' | 'finalizeGigMedia'>>;

/** The upload: authorize, hand the bytes to the object store, finalize. The Gig is named in the QUERY (`?gigId=`) so the size bound can be read before the body is. */
async function handleUpload(
  req: Request,
  d: AuthDeps,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  api: UploadApi,
  opts: AccountCallOptions,
  go: (gigId: string, query: string) => Response,
): Promise<Response> {
  const query = new URL(req.url).searchParams;
  const gigIdText = query.get('gigId');
  if ([...new Set(query.keys())].length !== 1 || query.getAll('gigId').length !== 1 || gigIdText === null || !UUID.test(gigIdText)) return badRequest();
  const gigId = gigIdText.toLowerCase();
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= GIG_MEDIA_FILE_CEILING + UPLOAD_FRAMING_BYTES)) return tooLarge(); // refused before anything is asked or read
  const fail = async (err: unknown, kind: string): Promise<Response> => {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const word = gigErrorWordOf(err);
    d.log?.('warn', kind, { action: 'photo-upload', code: word, status: err instanceof ApiError ? err.status : undefined });
    return go(gigId, `?error=${word}${issueQueryOf(err)}`);
  };

  // the bound is the configuration the API computed for THIS draft; without a draft there is nothing to upload to
  let maxFileSize: number;
  try {
    const draft = (await api.getGig(gigId, opts)).draftVersion;
    if (!draft || draft.status !== 'DRAFT') return go(gigId, '?error=GIG_NO_DRAFT');
    maxFileSize = Math.min(draft.constraints.media.maxFileSizeBytes, GIG_MEDIA_FILE_CEILING);
  } catch (err) {
    return fail(err, 'gig draft action refused');
  }
  // A file above THIS draft's maximum but inside the structural ceiling is read to its end and DISCARDED, so the browser gets an ordinary answer ("refused") and not a reset
  // connection; only a body beyond the structural ceiling (plus framing) is cut off with a 413.
  const form = await readForm(req, GIG_MEDIA_FILE_CEILING + UPLOAD_FRAMING_BYTES, true);
  if (form === 'too_large') return tooLarge();
  if (!form) return badRequest();
  // exactly one of each: three text fields and one file
  const texts = new Map<string, string>();
  let upload: File | undefined;
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    const only = values[0];
    if (values.length !== 1 || only === undefined) return badRequest();
    if (name === 'file' && typeof only !== 'string') upload = only;
    else if (typeof only === 'string' && (name === 'altText' || name === 'expectedRevision' || name === 'fieldKey')) texts.set(name, only);
    else return badRequest();
  }
  if (!upload || texts.size !== 3) return badRequest();
  // a browser that posts the form with no file chosen sends an empty file part: the person's slip, answered with the registry's "refused" message
  if (upload.size < 1 || upload.size > maxFileSize) return go(gigId, `?error=${MEDIA_REFUSED}`);
  const revisionText = texts.get('expectedRevision')!;
  const fieldKey = FieldKey.safeParse(texts.get('fieldKey'));
  if (!REVISION.test(revisionText) || !fieldKey.success) return badRequest();
  const expectedRevision = Number(revisionText);
  // a file the browser could not type, or an absurd type, is the person's slip: say "refused" without asking the API
  if (upload.type === '' || upload.type.length > 100) return go(gigId, `?error=${MEDIA_REFUSED}`);
  const bytes = new Uint8Array(await upload.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const request = RequestGigMediaUploadRequest.safeParse({
    expectedRevision,
    fieldKey: fieldKey.data,
    mimeType: upload.type,
    sizeBytes: upload.size,
    sha256,
    altText: textOrNull(texts.get('altText')),
  });
  if (!request.success) {
    const altTooLong = (texts.get('altText') ?? '').length > GIG_ALT_TEXT_CEILING * 4;
    return go(gigId, `?error=${VALIDATION_FAILED}${altTooLong ? issueQuery('MEDIA_ALT_TOO_LONG', 'media') : ''}`);
  }

  try {
    const authorization = await api.requestGigMediaUpload(gigId, request.data, opts);
    // the one-time URL goes nowhere but this request
    const status = await putBytes(authorization.upload.url, putHeaders(request.data.mimeType, authorization.upload.headers, bytes.byteLength), bytes);
    if (status < 200 || status >= 300) {
      d.log?.('warn', 'gig media hand-over refused', { action: 'photo-upload', status });
      return go(gigId, `?error=${HAND_OVER_FAILED}`);
    }
    await api.finalizeGigMedia(gigId, authorization.media.mediaId, { expectedRevision: authorization.revision, sha256 }, opts);
    return go(gigId, `?notice=${NOTICE['photo-upload']}`);
  } catch (err) {
    return fail(err, 'gig draft action refused');
  }
}
