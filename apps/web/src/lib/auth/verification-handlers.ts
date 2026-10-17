// Provider verification actions of the browser (TRUST-001): the same-origin POST handlers behind the temporary /provider/verification page, written as plain Request -> Response
// functions like the consent and provider handlers. They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin). A signed-in session is required. Every action is an explicit POST of the person.
//  - A form carries EXACTLY the fields of its action; an unknown or repeated field, an extra file, a value that is not well-formed is a 400 and changes nothing. No account id,
//    case id, requirement id, status or decision exists in any form: the server decides all of them from the verified token.
//  - THE UPLOAD happens server-side: the browser posts the file to THIS handler; the handler asks the API to authorize one upload, PUTs the bytes to the one-time URL from the
//    server (the browser never touches the object store and no CORS is needed), then asks the API to finalize. The one-time URL is never stored, logged, redirected or rendered.
//    The handler refuses a body above the structural ceiling before reading it; the API applies the configured limit and checks the file again after it is stored.
//  - Nothing a person submitted (file name, bytes, type) is put in a redirect, a cookie or a log line. A result is a 303 back to /provider/verification with `?notice=<word>` or
//    `?error=<code>`, a code from a CLOSED list of the API's trust codes (anything else is `API_ERROR`); the target is fixed, so there is no open redirect. A revoked session
//    (401 SESSION_REVOKED) ends the local session through Keycloak (`endRevokedSession`).
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { RequestDocumentUploadRequest, SubmitVerificationRequest, TRUST_DOCUMENT_SIZE_CEILING, TRUST_ERROR_CODES } from '@bananagig/contracts';
import { ApiError, type AccountCallOptions } from '../api-client';
import { endRevokedSession, getSession, isSessionRevokedError } from './handlers';
import type { AuthDeps } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const VERIFICATION_ACTIONS = ['open', 'upload', 'withdraw', 'submit', 'cancel', 'reverify'] as const;
export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number];
export const isVerificationAction = (v: string): v is VerificationAction => (VERIFICATION_ACTIONS as readonly string[]).includes(v);

/** The notice words of `/provider/verification?notice=` (the page maps each to a registry key). */
export const VERIFICATION_NOTICES = ['opened', 'resumed', 'uploaded', 'withdrawn', 'submitted', 'cancelled', 'reverified'] as const;
/** The API error codes (`TRUST_<code>`) a redirect may carry in `?error=`: a closed list; every other failure is `API_ERROR`. */
export const VERIFICATION_API_ERROR_CODES: readonly string[] = TRUST_ERROR_CODES.map((c) => `TRUST_${c}`);
export const VERIFICATION_GENERIC_ERROR = 'API_ERROR';
/** Error code for a failed hand-over of the file to the object store (the API never saw a file: it reports OBJECT_MISSING when it finalizes). */
const UPLOAD_FAILED = 'TRUST_OBJECT_MISSING';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** The contract's bounds for a requirement or document type code. */
const codeOk = (v: string): boolean => CODE.test(v) && v.length >= 2 && v.length <= 48;
const REVISION = /^[1-9][0-9]{0,8}$/;
/** How long the hand-over of one file to the object store may take. */
const PUT_TIMEOUT_MS = 60_000;
/**
 * PUTs the file to the one-time upload URL and returns the HTTP status (0 when it could not be sent). It deliberately does NOT use the global `fetch`: Next.js wraps `fetch` in a
 * tracing span named after the full URL, and this URL carries its signature; a plain `node:http(s)` request is not traced that way. No redirect is followed, only http(s) is spoken,
 * the file is streamed from the parsed upload (no further copy), and only the content type and the length are sent.
 */
function putFile(url: string, contentType: string, file: File): Promise<number> {
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
    const req = client.request(
      target,
      { method: 'PUT', headers: { 'content-type': contentType, 'content-length': String(file.size) }, timeout: PUT_TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(0));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    Readable.fromWeb(file.stream() as import('node:stream/web').ReadableStream)
      .on('error', () => req.destroy())
      .pipe(req);
  });
}
/** Largest request body read for an upload: the structural file ceiling plus room for the other two fields and the multipart framing. */
const MAX_REQUEST_BYTES = TRUST_DOCUMENT_SIZE_CEILING + 65_536;

const back = (d: AuthDeps, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/provider/verification${query}`, ...NO_STORE } });
const badRequest = (): Response => new Response('Bad request', { status: 400, headers: NO_STORE });
const tooLarge = (): Response => new Response('Payload too large', { status: 413, headers: NO_STORE });
const methodNotAllowed = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
const forbidden = (): Response => new Response('Forbidden', { status: 403, headers: NO_STORE });

/** The text fields of a form that holds EXACTLY the allowed names once each as text, plus the files it holds under the allowed file names. undefined for anything else. */
async function strictParts(
  req: Request,
  textFields: readonly string[],
  fileFields: readonly string[],
): Promise<{ text: Record<string, string>; files: Record<string, File> } | undefined> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undefined;
  }
  const text: Record<string, string> = {};
  const files: Record<string, File> = {};
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    if (values.length !== 1) return undefined;
    const only = values[0];
    if (textFields.includes(name) && typeof only === 'string') text[name] = only;
    else if (fileFields.includes(name) && typeof only !== 'string') files[name] = only as File;
    else return undefined;
  }
  return { text, files };
}

/**
 * POST /auth/provider/verification/<action>: `open` (no fields), `upload` (fields `requirementCode`, `documentTypeCode`, file `file`), `withdraw` (`documentId`), `submit`
 * (`expectedRevision`), `cancel` (no fields), `reverify` (`requirementCode`). The result is always a 303 back to /provider/verification (or, for a revoked session, to Keycloak).
 */
export async function handleVerificationAction(req: Request, d: AuthDeps, action: VerificationAction): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (req.headers.get('origin') !== d.cfg.webOrigin) return forbidden();
  if (!d.api) throw new Error('AuthDeps.api is required for the verification actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/session`, ...NO_STORE } }); // signed out: the page shows the sign-in control
  if (action === 'upload') {
    const declared = Number(req.headers.get('content-length'));
    if (!Number.isFinite(declared) || declared < 1 || declared > MAX_REQUEST_BYTES) return declared > MAX_REQUEST_BYTES ? tooLarge() : badRequest();
  }
  const fields =
    action === 'upload'
      ? ['requirementCode', 'documentTypeCode']
      : action === 'withdraw'
        ? ['documentId']
        : action === 'submit'
          ? ['expectedRevision']
          : action === 'reverify'
            ? ['requirementCode']
            : [];
  const parts = await strictParts(req, fields, action === 'upload' ? ['file'] : []);
  if (!parts) return badRequest();
  const { text, files } = parts;
  for (const name of fields) if (text[name] === undefined) return badRequest();
  if ((action === 'upload' || action === 'reverify') && !codeOk(text.requirementCode!)) return badRequest();
  if (action === 'upload' && !codeOk(text.documentTypeCode!)) return badRequest();
  if (action === 'withdraw' && !UUID.test(text.documentId!)) return badRequest();
  if (action === 'submit' && !REVISION.test(text.expectedRevision!)) return badRequest();
  let uploadRequest: RequestDocumentUploadRequest | undefined;
  let uploadFile: File | undefined;
  if (action === 'upload') {
    const file = files.file;
    if (!file || file.size < 1) return badRequest();
    const body = RequestDocumentUploadRequest.safeParse({
      requirementCode: text.requirementCode,
      documentTypeCode: text.documentTypeCode,
      mimeType: file.type,
      sizeBytes: file.size,
    });
    if (!body.success) return badRequest();
    uploadRequest = body.data;
    uploadFile = file;
  }
  const submit = action === 'submit' ? SubmitVerificationRequest.safeParse({ expectedRevision: Number(text.expectedRevision) }) : undefined;
  if (submit && !submit.success) return badRequest();

  const api = d.api(session.record.accessToken);
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  // a wiring error is thrown (a 500), not reported to the person as an API failure
  if (
    !api.openProviderVerification ||
    !api.requestVerificationUpload ||
    !api.finalizeVerificationDocument ||
    !api.withdrawVerificationDocument ||
    !api.submitProviderVerification ||
    !api.cancelProviderVerification ||
    !api.reverifyProviderRequirement
  )
    throw new Error('AuthDeps.api lacks the verification calls');
  try {
    if (action === 'open') {
      const r = await api.openProviderVerification(opts);
      return back(d, r.created ? '?notice=opened' : '?notice=resumed');
    }
    if (action === 'upload') {
      const authorization = await api.requestVerificationUpload(uploadRequest!, opts);
      // the one-time URL goes nowhere but this request
      const status = await putFile(authorization.upload.url, uploadRequest!.mimeType, uploadFile!);
      if (status < 200 || status >= 300) {
        d.log?.('warn', 'verification upload hand-over refused', { action, status });
        return back(d, `?error=${UPLOAD_FAILED}`);
      }
      await api.finalizeVerificationDocument(authorization.document.verificationDocumentId, {}, opts);
      return back(d, '?notice=uploaded');
    }
    if (action === 'withdraw') {
      await api.withdrawVerificationDocument(text.documentId!, opts);
      return back(d, '?notice=withdrawn');
    }
    if (action === 'submit') {
      await api.submitProviderVerification(submit!.data!, opts);
      return back(d, '?notice=submitted');
    }
    if (action === 'reverify') {
      await api.reverifyProviderRequirement(text.requirementCode!, opts);
      return back(d, '?notice=reverified');
    }
    await api.cancelProviderVerification(opts);
    return back(d, '?notice=cancelled');
  } catch (err) {
    if (isSessionRevokedError(err)) return endRevokedSession(session.id, session.record, d);
    const code = err instanceof ApiError && VERIFICATION_API_ERROR_CODES.includes(err.code) ? err.code : VERIFICATION_GENERIC_ERROR;
    d.log?.('warn', 'verification action refused', { action, code, status: err instanceof ApiError ? err.status : undefined });
    return back(d, `?error=${code}`);
  }
}
