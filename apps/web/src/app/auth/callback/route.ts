import { handleCallback } from '../../../lib/auth/handlers';
import { authDeps } from '../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
export const GET = (req: Request): Promise<Response> => handleCallback(req, authDeps());
