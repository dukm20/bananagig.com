import { handleAccountForm } from '../../../../lib/auth/account-handlers';
import { authDeps } from '../../../../lib/auth/runtime';

export const dynamic = 'force-dynamic';
// POST /auth/account/language-region (ACC-001): the language and time zone form of /account/language-region. Any other method is answered by the handler with 405.
export const POST = (req: Request): Promise<Response> => handleAccountForm(req, authDeps(), 'language-region');
export const GET = (req: Request): Promise<Response> => handleAccountForm(req, authDeps(), 'language-region');
