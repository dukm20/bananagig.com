// Email verification actions of the browser (ID-002): the same-origin POST handlers behind the /verify-email page, written as plain Request -> Response
// functions like the other auth handlers. They hold the session's access token server-side and call the API; the browser only submits forms.
//
//  - POST only, same-origin only (the Origin header must be the web origin): a cross-site form cannot drive them.
//  - Form fields are read as text and validated by the API's strict contracts; nothing is parsed or trusted here beyond "is it a string".
//  - The code and the magic token are request-body fields only: they are never put in a redirect URL, a cookie, a log line or an error query. A failure
//    redirects to /verify-email?error=<API error code> (a code, never a value); a success redirects to /verify-email?ok=<what happened>.
//  - The browser's address (the first entry of x-forwarded-for, set by the trusted proxy) is forwarded to the API so its abuse limits count real clients.
import { ApiError } from '../api-client';
import { getSession } from './handlers';
import type { AuthDeps } from './types';

const NO_STORE = { 'cache-control': 'no-store' };
export const EMAIL_ACTIONS = ['set', 'send', 'confirm-code', 'confirm-link'] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];
export const isEmailAction = (v: string): v is EmailAction => (EMAIL_ACTIONS as readonly string[]).includes(v);

const see = (d: AuthDeps, query: string): Response =>
  new Response(null, { status: 303, headers: { location: `${d.cfg.webPublicUrl}/verify-email${query}`, ...NO_STORE } });

/** The first address of a proxy's x-forwarded-for, or undefined. Only the trusted proxy in front of the web server may have set it. */
export function clientIpOf(req: Request): string | undefined {
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first && first.length <= 64 ? first : undefined;
}

async function field(req: Request, name: string): Promise<string | undefined> {
  try {
    const v = (await req.formData()).get(name);
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /auth/email/<action>: `set` (field `email`: sets the address and sends the verification email), `send` (resend), `confirm-code` (field `code`),
 * `confirm-link` (field `token`). The result is always a redirect back to /verify-email; the page renders the outcome from the registry's copy.
 */
export async function handleEmailAction(req: Request, d: AuthDeps, action: EmailAction): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST', ...NO_STORE } });
  if (req.headers.get('origin') !== d.cfg.webOrigin) return new Response('Forbidden', { status: 403, headers: NO_STORE });
  if (!d.api) throw new Error('AuthDeps.api is required for the email verification actions');
  const session = await getSession(req.headers.get('cookie'), d);
  if (!session) return see(d, ''); // signed out or expired: the page shows the sign-in control
  const client = d.api(session.record.accessToken);
  const { setAccountEmail, sendEmailVerification, confirmEmailCode, confirmEmailLink } = client;
  if (!setAccountEmail || !sendEmailVerification || !confirmEmailCode || !confirmEmailLink) throw new Error('AuthDeps.api lacks the email verification calls');
  const opts = { activeRole: session.record.activeRole, clientIp: clientIpOf(req) };
  try {
    switch (action) {
      case 'set': {
        const email = await field(req, 'email');
        if (email === undefined) return new Response('Bad request', { status: 400, headers: NO_STORE });
        await setAccountEmail(email, opts);
        await sendEmailVerification(opts);
        return see(d, '?ok=sent');
      }
      case 'send':
        await sendEmailVerification(opts);
        return see(d, '?ok=sent');
      case 'confirm-code': {
        const code = await field(req, 'code');
        if (code === undefined) return new Response('Bad request', { status: 400, headers: NO_STORE });
        await confirmEmailCode(code, opts);
        return see(d, '?ok=verified');
      }
      case 'confirm-link': {
        const token = await field(req, 'token');
        if (token === undefined) return new Response('Bad request', { status: 400, headers: NO_STORE });
        await confirmEmailLink(token, opts);
        return see(d, '?ok=verified');
      }
    }
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'API_ERROR';
    d.log?.('warn', 'email verification action refused', { action, code, status: err instanceof ApiError ? err.status : undefined });
    return see(d, `?error=${encodeURIComponent(code)}`);
  }
}
