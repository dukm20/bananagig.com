import { handleRevokedSession } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// GET: where a page sends the browser when the API said the session was revoked. The handler re-checks with the API and only then ends the session.
export const GET = (req: Request): Promise<Response> => handleRevokedSession(req, authDeps());
