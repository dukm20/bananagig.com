// The controlled owner photo route of the provider profile (PRO-002): `GET /provider/profile/photo`. The browser cannot send the bearer token an image request would need, so this
// route reads the OWNER's own photo from the API with the session's token and answers the bytes itself. The API serves the SANITISED bytes (location, camera and text metadata are
// gone), and no storage URL, object key or hash exists anywhere on this path: there is nothing to redirect to and nothing to render.
//
//  - Only the owner gets it. A signed-out visitor, a revoked session, an account without a profile or a photo and a request with any query are all the SAME 404 with a fixed body.
//  - The answer carries the API's opaque weak ETag; `If-None-Match` is forwarded only when it has that shape, so a repeat view costs a 304. The content type is one of the allowed image
//    types (the API client refuses anything else), `nosniff` and `inline` are always set, and the answer is `private` (never stored by a shared cache).
//  - An API that is down or answers something unexpected is a 502 with a fixed body (not a 404, so a transient fault is not read as "removed").
import { ApiError, type AccountCallOptions } from '../api-client';
import { getSession } from './handlers';
import type { AuthDeps } from './types';

const HEADERS = { 'cache-control': 'private, no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const notFound = (): Response => new Response('Not found', { status: 404, headers: HEADERS });
/** An opaque (weak) validator: quoted token characters only. */
const ETAG = /^(?:W\/)?"[A-Za-z0-9_.+/=-]{1,128}"$/;

export async function handleProfilePhotoPreview(req: Request, d: AuthDeps): Promise<Response> {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', ...HEADERS } });
  if (!d.api) throw new Error('AuthDeps.api is required for the profile photo route');
  if ([...new URL(req.url).searchParams.keys()].length !== 0) return notFound();
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return notFound();
  const api = d.api(session.record.accessToken);
  if (!api.getProviderProfilePhoto) throw new Error('AuthDeps.api lacks the profile photo call');
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  const sent = req.headers.get('if-none-match');
  try {
    const photo = await api.getProviderProfilePhoto(opts, sent !== null && ETAG.test(sent) ? { ifNoneMatch: sent } : {});
    const etag: Record<string, string> = photo.etag !== undefined && ETAG.test(photo.etag) ? { etag: photo.etag } : {};
    if (photo.kind === 'not-modified') return new Response(null, { status: 304, headers: { ...HEADERS, ...etag } });
    return new Response(photo.bytes as unknown as BodyInit, {
      status: 200,
      headers: { ...HEADERS, ...etag, 'content-type': photo.contentType, 'content-length': String(photo.bytes.byteLength), 'content-disposition': 'inline' },
    });
  } catch (err) {
    // nothing here may carry bytes or a hash: only the status and the API's code
    if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) return notFound();
    d.log?.('warn', 'profile photo unavailable', {
      code: err instanceof ApiError ? err.code : 'ERROR',
      status: err instanceof ApiError ? err.status : undefined,
    });
    return new Response('Bad gateway', { status: 502, headers: HEADERS });
  }
}
