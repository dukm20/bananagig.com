import { handleEmailAction, isEmailAction } from '../../../../lib/auth/email-handlers';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/email/<set|send|confirm-code|confirm-link> (ID-002). Any other method or action is refused.
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  if (!isEmailAction(action)) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return handleEmailAction(req, authDeps(), action);
}
export const GET = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
