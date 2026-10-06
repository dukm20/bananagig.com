import { handleLogout } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST ends the session. Any other method is answered by the handler with 405.
export const POST = (req: Request): Promise<Response> => handleLogout(req, authDeps());
export const GET = (req: Request): Promise<Response> => handleLogout(req, authDeps());
