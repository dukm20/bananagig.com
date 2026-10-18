// The controlled thumbnail route of a Gig photo (CAT-004): `GET /provider/gigs/<gigId>/media/<mediaId>[?version=<n>]`. It asks the API for the short-lived one-object GET target of
// the OWNER's photo (the draft's, or the version's with `?version=`) and answers `303` to it with `no-store`. Photo bytes never stream through the web app or the API.
//
//  - The target is never rendered in HTML, never logged, never stored and never part of an error: it exists only in the `Location` header of this one answer, which also asks the
//    browser not to send this page's address as the referrer.
//  - Only the owner gets it. A signed-out visitor, a revoked session, someone else's Gig or photo, a malformed id or query and an unknown version are all the SAME 404 with a fixed
//    body (nothing says whether the photo exists). The route changes nothing, so a GET is fine; an image request cannot carry a form, a body or a token of its own.
//  - An API that is down or answers something unexpected is a 502 with a fixed body (not a 404, so a transient fault is not read as "removed").
import { ApiError, type AccountCallOptions } from '../api-client';
import { UUID } from './gig-handlers';
import { getSession } from './handlers';
import type { AuthDeps } from './types';

const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const notFound = (): Response => new Response('Not found', { status: 404, headers: HEADERS });
const VERSION = /^[1-9][0-9]{0,8}$/;

export async function handleGigMediaPreview(req: Request, d: AuthDeps, gigId: string, mediaId: string): Promise<Response> {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', ...HEADERS } });
  if (!d.api) throw new Error('AuthDeps.api is required for the Gig photo route');
  const query = new URL(req.url).searchParams;
  const keys = [...new Set(query.keys())];
  const versionText = query.get('version');
  if (!UUID.test(gigId.toLowerCase()) || !UUID.test(mediaId.toLowerCase())) return notFound();
  if (
    keys.length > 1 ||
    (keys.length === 1 && (keys[0] !== 'version' || query.getAll('version').length !== 1 || versionText === null || !VERSION.test(versionText)))
  )
    return notFound();
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return notFound();
  const api = d.api(session.record.accessToken);
  if (!api.getGigMediaPreview) throw new Error('AuthDeps.api lacks the Gig photo call');
  const opts: AccountCallOptions = { activeRole: session.record.activeRole };
  try {
    const target = (await api.getGigMediaPreview(gigId.toLowerCase(), mediaId.toLowerCase(), versionText === null ? undefined : Number(versionText), opts)).url;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('Bad gateway', { status: 502, headers: HEADERS });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return new Response('Bad gateway', { status: 502, headers: HEADERS });
    return new Response(null, { status: 303, headers: { location: parsed.toString(), ...HEADERS } });
  } catch (err) {
    // nothing here may carry the target: only the status and the API's code
    if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 403)) return notFound();
    d.log?.('warn', 'gig photo preview unavailable', {
      code: err instanceof ApiError ? err.code : 'ERROR',
      status: err instanceof ApiError ? err.status : undefined,
    });
    return new Response('Bad gateway', { status: 502, headers: HEADERS });
  }
}
