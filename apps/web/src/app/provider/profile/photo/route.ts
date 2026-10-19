import { handleProfilePhotoPreview } from '../../../../lib/auth/profile-photo-preview';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// GET /provider/profile/photo (PRO-002): the owner's own profile photo through the web server (see lib/auth/profile-photo-preview.ts). Read-only; every other method is refused.
export async function GET(req: Request): Promise<Response> {
  return handleProfilePhotoPreview(req, authDeps());
}
export const POST = (): Response => new Response('Method not allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
