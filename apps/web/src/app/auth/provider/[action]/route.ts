import { handleProviderAction, isProviderAction } from '../../../../lib/auth/provider-handlers';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/provider/<start|market|services|submit|cancel> (PRO-001). Any other method or action is refused; there is deliberately no GET that changes state.
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  if (!isProviderAction(action)) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return handleProviderAction(req, authDeps(), action);
}
export const GET = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
