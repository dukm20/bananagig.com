import { handleAccountForm } from '../../../../lib/auth/account-handlers';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/account/profile (ACC-001): the names form of /account/profile. Any other method is answered by the handler with 405; no GET changes state.
export const POST = (req: Request): Promise<Response> => handleAccountForm(req, authDeps(), 'profile');
export const GET = (req: Request): Promise<Response> => handleAccountForm(req, authDeps(), 'profile');
