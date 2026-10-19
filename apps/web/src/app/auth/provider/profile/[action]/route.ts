import { handleProfileAction, isProfileAction } from '../../../../../lib/auth/profile-handlers';
import { authDeps } from '../../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/provider/profile/<save|visibility|photo-upload|photo-remove> (PRO-002). Any other method or action is refused; there is deliberately no GET that changes state.
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  if (isProfileAction(action)) return handleProfileAction(req, authDeps(), action);
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}
export const GET = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
