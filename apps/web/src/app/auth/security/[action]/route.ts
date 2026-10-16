import { handleSecurityAction, isSecurityAction } from '../../../../lib/auth/security-handlers';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/security/<revoke-session|revoke-all|trust-device|untrust-device|remove-device|mfa-enroll> (ID-004). Any other method or action is refused.
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  if (!isSecurityAction(action)) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return handleSecurityAction(req, authDeps(), action);
}
export const GET = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
