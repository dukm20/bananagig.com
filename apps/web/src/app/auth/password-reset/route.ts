import { authDeps } from '../../../lib/auth/runtime';
import { handlePasswordReset } from '../../../lib/auth/security-handlers';

export const dynamic = 'force-dynamic';
// POST asks for a password-reset link (public, same-origin only). Any other method is answered by the handler with 405.
export const POST = (req: Request): Promise<Response> => handlePasswordReset(req, authDeps());
export const GET = (req: Request): Promise<Response> => handlePasswordReset(req, authDeps());
