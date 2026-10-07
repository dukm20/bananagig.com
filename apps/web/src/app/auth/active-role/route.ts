import { handleActiveRole } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST switches the application role of the session. Any other method is answered by the handler with 405.
export const POST = (req: Request): Promise<Response> => handleActiveRole(req, authDeps());
export const GET = (req: Request): Promise<Response> => handleActiveRole(req, authDeps());
