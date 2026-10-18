// Provider Gig actions of the browser (CAT-003): the same-origin POST handlers behind the temporary /provider/gigs pages, written as plain Request -> Response functions like the
// provider and verification handlers. They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin). A signed-in session is required. Every action is an explicit POST of the person.
//  - A form carries EXACTLY the fields of its action: an unknown, missing or repeated field, a file or a malformed identifier is a 400 and changes nothing. No account id, role,
//    status or currency exists in any form: the server decides all of them from the verified token and from its owners. The Gig id is a UUID the page rendered; the API checks that
//    the Gig is the caller's (anyone else's is a 404, never a 403).
//  - The editor form (`save`) carries the provider's own text. That text goes to the API in the request BODY and nowhere else: never into a redirect, a cookie or a log line. A value
//    that is not even well-formed for its field type (a number that is not a number) is refused here as `GIG_VALIDATION_FAILED` without being echoed; every other rule (lengths,
//    bounds, options, what the template allows) is the API's decision.
//  - A result is a 303 back to /provider/gigs[/<gigId>] with `?notice=<word>` or `?error=<code>`, a code from a CLOSED list of the API's Gig codes (anything else is `API_ERROR`).
//    The only value ever in a redirect path is a canonical UUID. A revoked session (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import {
  CatalogCode,
  FieldKey,
  GIG_ERROR_CODES,
  gigWireCode,
  GIG_FIELD_VALUES_MAX,
  OptionCode,
  PublishGigRequest,
  UpdateGigDraftRequest,
  type CreateGigRequest,
  type GigFieldValue,
} from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

/** The most a Gig form may declare (the editor form is well below this; 64 field values of 20000 characters at 4 bytes would be 5 MiB, which no real form reaches). */
export const GIG_FORM_MAX_BYTES = 1_048_576;
const NO_STORE = { 'cache-control': 'no-store' };
/** `create` (from a template), `save` (the draft), `publish`, `retire`, `draft` (start the next draft). */
export const GIG_ACTIONS = ['create', 'save', 'publish', 'retire', 'draft'] as const;
export type GigAction = (typeof GIG_ACTIONS)[number];
export const isGigAction = (v: string): v is GigAction => (GIG_ACTIONS as readonly string[]).includes(v);

/** The notice words of `/provider/gigs/<gigId>?notice=` (the page maps each to a registry key and shows it only when the data proves it). */
export const GIG_NOTICES = ['created', 'saved', 'published', 'draft_created', 'retired'] as const;
export const GIG_GENERIC_ERROR = 'API_ERROR';
/** The API error codes (`GIG_<code>`, so a few read `GIG_NOT_FOUND`) a redirect may carry in `?error=`: a closed list; every other failure is `API_ERROR`. */
export const GIG_API_ERROR_CODES: readonly string[] = GIG_ERROR_CODES.map((c) => gigWireCode(c));
/** The closed-list word of an error thrown by the API client, or the generic word. */
export const gigErrorWordOf = (err: unknown): string => (err instanceof ApiError && GIG_API_ERROR_CODES.includes(err.code) ? err.code : GIG_GENERIC_ERROR);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[1-9][0-9]{0,8}$/;
const MINOR_UNITS = /^[0-9]{1,15}$/;
const MINUTES = /^[0-9]{1,6}$/;
const INTEGER = /^-?[0-9]{1,15}$/;
const DECIMAL = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
/** `field.<kind>.<fieldKey>`: t text, n integer or duration, d decimal, b boolean, e option. The kind only says how to read the string; the API checks the value against the template. */
const FIELD_NAME = /^field\.([tndbe])\.([a-z][a-z0-9_]*)$/;

const location = (d: AuthDeps, path: string, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}${path}${query}`, ...NO_STORE } });
const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });

/** The body of the request as bytes, or undefined once it exceeds `max` (the stream is cancelled; nothing beyond the cap is buffered). */
async function boundedBody(req: Request, max: number): Promise<Uint8Array | undefined> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The fields of a form that holds each name once, as text; undefined for a file, a repeated name, an unknown name or a missing required one. */
async function strictForm(
  req: Request,
  fixed: readonly string[],
  required: readonly string[],
  allowFieldNames: boolean,
): Promise<Map<string, string> | undefined> {
  // bound the body while it is read (a declared length is only a hint: chunked bodies declare none), then parse the bounded bytes
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return undefined;
  const declared = req.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= GIG_FORM_MAX_BYTES)) return undefined;
  const bytes = await boundedBody(req, GIG_FORM_MAX_BYTES);
  if (bytes === undefined) return undefined;
  let form: FormData;
  try {
    form = await new Request(req.url, {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
      body: bytes as unknown as BodyInit,
    }).formData();
  } catch {
    return undefined;
  }
  const out = new Map<string, string>();
  let dynamic = 0;
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    if (values.length !== 1 || typeof values[0] !== 'string') return undefined;
    if (fixed.includes(name)) out.set(name, values[0]);
    else if (allowFieldNames && FIELD_NAME.test(name) && ++dynamic <= GIG_FIELD_VALUES_MAX) out.set(name, values[0]);
    else return undefined;
  }
  for (const name of required) if (!out.has(name)) return undefined;
  return out;
}

/** The text a person typed, or null when it is blank. */
const textOrNull = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v);

type Parsed<T> = { ok: true; value: T } | { ok: false };
const invalid: Parsed<never> = { ok: false };

/** The `fieldValues` of the draft from the `field.*` entries of the form; `ok: false` when a value is not well-formed for its kind. Blank entries are left out (an omitted value is cleared). */
function fieldValuesOf(form: Map<string, string>): Parsed<Array<{ fieldKey: string; value: GigFieldValue }>> {
  const out: Array<{ fieldKey: string; value: GigFieldValue }> = [];
  const seen = new Set<string>();
  for (const [name, raw] of form) {
    const m = FIELD_NAME.exec(name);
    if (!m) continue;
    const kind = m[1]!;
    const fieldKey = m[2]!;
    if (!FieldKey.safeParse(fieldKey).success || seen.has(fieldKey)) return invalid;
    seen.add(fieldKey);
    const v = raw.trim();
    if (v === '') continue;
    if (kind === 't') {
      out.push({ fieldKey, value: raw });
    } else if (kind === 'n') {
      if (!INTEGER.test(v)) return invalid;
      out.push({ fieldKey, value: Number(v) });
    } else if (kind === 'd') {
      if (!DECIMAL.test(v)) return invalid;
      out.push({ fieldKey, value: v });
    } else if (kind === 'b') {
      if (v !== 'true' && v !== 'false') return invalid;
      out.push({ fieldKey, value: v === 'true' });
    } else {
      if (!OptionCode.safeParse(v).success) return invalid;
      out.push({ fieldKey, value: v });
    }
  }
  return { ok: true, value: out };
}

const REQUIRED: Record<GigAction, readonly string[]> = {
  create: ['gigTemplateCode'],
  save: ['gigId', 'expectedRevision', 'title', 'shortPitch', 'description'],
  publish: ['gigId', 'expectedRevision'],
  retire: ['gigId'],
  draft: ['gigId'],
};
const OPTIONAL: Record<GigAction, readonly string[]> = {
  create: ['clientRequestId'],
  save: ['price', 'duration'],
  publish: [],
  retire: [],
  draft: [],
};
const NOTICE: Record<Exclude<GigAction, 'create'>, string> = { save: 'saved', publish: 'published', retire: 'retired', draft: 'draft_created' };

/**
 * POST /auth/provider/gigs/<action>: `create` (`gigTemplateCode`, optional `clientRequestId`), `save` (`gigId`, `expectedRevision`, `title`, `shortPitch`, `description`, optional `price` in
 * minor units and `duration` in minutes, and one `field.<kind>.<fieldKey>` per editable template field), `publish` (`gigId`, `expectedRevision`), `retire` (`gigId`) and `draft` (`gigId`).
 * The result is always a 303 back to /provider/gigs[/<gigId>] (or, for a revoked session, to Keycloak).
 */
export async function handleGigAction(req: Request, d: AuthDeps, action: GigAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the Gig actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  const form = await strictForm(req, [...REQUIRED[action], ...OPTIONAL[action]], REQUIRED[action], action === 'save');
  if (!form) return badRequest();

  const gigIdText = form.get('gigId');
  if (gigIdText !== undefined && !UUID.test(gigIdText)) return badRequest();
  const gigId = gigIdText?.toLowerCase();
  const revisionText = form.get('expectedRevision');
  if (revisionText !== undefined && !REVISION.test(revisionText)) return badRequest();
  const expectedRevision = revisionText === undefined ? undefined : Number(revisionText);

  let create: CreateGigRequest | undefined;
  if (action === 'create') {
    const clientRequestId = form.get('clientRequestId');
    if (clientRequestId !== undefined && !UUID.test(clientRequestId)) return badRequest();
    const code = CatalogCode.safeParse(form.get('gigTemplateCode'));
    if (!code.success) return badRequest();
    create = { gigTemplateCode: code.data, ...(clientRequestId !== undefined ? { clientRequestId: clientRequestId.toLowerCase() } : {}) };
  }
  const pathOf = (): string => (gigId ? `/provider/gigs/${gigId}` : '/provider/gigs');

  let draft: UpdateGigDraftRequest | undefined;
  let publish: PublishGigRequest | undefined;
  if (action === 'publish') {
    const body = PublishGigRequest.safeParse({ expectedRevision });
    if (!body.success) return badRequest();
    publish = body.data;
  }
  if (action === 'save') {
    // what the person typed: a value that is not well-formed for its kind is the person's slip, not a forged form, so it comes back as a closed error word and is never echoed
    const price = textOrNull(form.get('price'));
    const duration = textOrNull(form.get('duration'));
    const fields = fieldValuesOf(form);
    const priceOk = price === null || MINOR_UNITS.test(price.trim());
    const durationOk = duration === null || MINUTES.test(duration.trim());
    const body =
      fields.ok && priceOk && durationOk
        ? UpdateGigDraftRequest.safeParse({
            expectedRevision,
            title: textOrNull(form.get('title')),
            shortPitch: textOrNull(form.get('shortPitch')),
            description: textOrNull(form.get('description')),
            priceAmountMinor: price === null ? null : Number(price.trim()),
            durationMinutes: duration === null ? null : Number(duration.trim()),
            fieldValues: fields.value,
          })
        : undefined;
    if (!body || !body.success) return location(d, pathOf(), '?error=GIG_VALIDATION_FAILED');
    draft = body.data;
  }

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  if (!api.createGig || !api.updateGigDraft || !api.publishGig || !api.retireGig || !api.createGigVersion) throw new Error('AuthDeps.api lacks the Gig calls');
  try {
    if (action === 'create') {
      const r = await api.createGig(create!, opts);
      const id = r.detail.gig.gigId;
      return location(d, UUID.test(id) ? `/provider/gigs/${id.toLowerCase()}` : '/provider/gigs', '?notice=created');
    }
    if (action === 'save') await api.updateGigDraft(gigId!, draft!, opts);
    else if (action === 'publish') await api.publishGig(gigId!, publish!, opts);
    else if (action === 'retire') await api.retireGig(gigId!, opts);
    else await api.createGigVersion(gigId!, opts);
    return location(d, pathOf(), `?notice=${NOTICE[action]}`);
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const word = gigErrorWordOf(err);
    d.log?.('warn', 'gig action refused', { action, code: word, status: err instanceof ApiError ? err.status : undefined });
    return location(d, action === 'create' ? '/provider/gigs' : pathOf(), `?error=${word}`);
  }
}
