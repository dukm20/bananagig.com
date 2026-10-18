import { handleGigAction, isGigAction } from '../../../../../lib/auth/gig-handlers';
import { authDeps } from '../../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/provider/gigs/<create|save|publish|retire|draft> (CAT-003). Any other method or action is refused; there is deliberately no GET that changes state.
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  if (!isGigAction(action)) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return handleGigAction(req, authDeps(), action);
}
export const GET = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
