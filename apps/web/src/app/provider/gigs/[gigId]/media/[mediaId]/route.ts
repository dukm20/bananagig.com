import { handleGigMediaPreview } from '../../../../../../lib/auth/gig-media-preview';
import { authDeps } from '../../../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// GET /provider/gigs/<gigId>/media/<mediaId>[?version=<n>] (CAT-004): the owner's photo through a 303 to a short-lived target (see lib/auth/gig-media-preview.ts). Read-only; every other
// method is refused.
export async function GET(req: Request, ctx: { params: Promise<{ gigId: string; mediaId: string }> }): Promise<Response> {
  const { gigId, mediaId } = await ctx.params;
  return handleGigMediaPreview(req, authDeps(), gigId, mediaId);
}
export const POST = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
