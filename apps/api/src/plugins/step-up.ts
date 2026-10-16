// Step-up guards (ID-004, RFC 9470 "OAuth 2.0 Step Up Authentication Challenge Protocol"). A sensitive route asks for a RECENT authentication (and, for the
// strongest actions, one that included a second factor); when the verified access token does not show it, the answer is 401 STEP_UP_REQUIRED and the client
// sends the person back to the identity provider with `max_age` (and `acr_values`) to authenticate again.
//
// What the guards trust: ONLY the claims of the verified token (`auth_time`, `acr`), never a header, a body or a cookie. A trusted browser (devices) never
// satisfies a guard: only the identity provider's own authentication does. Freshness comes from the configuration (`security.step_up_valid_minutes`), read per
// request through the security service, so a change of the setting applies at once and nothing is hardcoded here.
//
// List them AFTER requireAccount() in `preValidation` (requireAccount authenticates, so 401 and 403 win), before the body check.
//
//   requireRecentAuthentication()  authenticated within the configured window                          -> 401 STEP_UP_REQUIRED (RECENT_AUTHENTICATION)
//   requireMfa()                   a second factor was part of that authentication, within the window  -> 401 STEP_UP_REQUIRED (MFA, acr_values)
//                                  the person has no second factor yet                                 -> 403 MFA_ENROLLMENT_REQUIRED
//                                  the identity provider cannot be asked                               -> 503 ACCOUNT_SECURITY_UNAVAILABLE (fail closed)
import type { preHandlerAsyncHookHandler } from 'fastify';
import { ACR_MFA, authSecurityErrorMessageKey, isMfaAcr, type StepUpDetails, type StepUpRequirement } from '@bananagig/contracts';
import { AccountError, type SecurityOperations } from '@bananagig/accounts';
import { AppError } from '../errors';
import { toAppError } from '../modules/account/dto';
import { requireAuthenticated } from './auth';

/** A token whose `auth_time` is this far (seconds) in the future is treated as having no usable authentication time: it is clock skew at best and forgery at worst. */
const FUTURE_SKEW_SECONDS = 60;

/** RFC 9470 section 3: `WWW-Authenticate: Bearer error="insufficient_user_authentication", error_description="...", max_age="...", acr_values="..."`. */
const stepUpChallenge = (realm: string, details: StepUpDetails): Record<string, string> => {
  const parts = [
    `realm="${realm}"`,
    'error="insufficient_user_authentication"',
    'error_description="A more recent or stronger authentication is required"',
    `max_age="${details.maxAgeSeconds}"`,
  ];
  if (details.acrValues !== undefined) parts.push(`acr_values="${details.acrValues}"`);
  return { 'www-authenticate': `Bearer ${parts.join(', ')}` };
};

export const stepUpRequired = (realm: string, details: StepUpDetails): AppError =>
  new AppError(
    'AUTHENTICATION',
    'STEP_UP_REQUIRED',
    'A more recent or stronger authentication is required',
    { ...details, messageKey: authSecurityErrorMessageKey('STEP_UP_REQUIRED') },
    stepUpChallenge(realm, details),
  );

/** The guards authenticate AND require the normal web context themselves, so they stay safe if listed without requireAccount (same 403 as requireAccount). */
const authenticateWeb = async (
  authenticate: ReturnType<typeof requireAuthenticated>,
  request: Parameters<ReturnType<typeof requireAuthenticated>>[0],
  reply: Parameters<ReturnType<typeof requireAuthenticated>>[1],
): Promise<void> => {
  await authenticate.call(request.server, request, reply);
  if (request.principal!.authContext !== 'web')
    throw new AppError('AUTHORIZATION', 'ACCOUNT_CONTEXT_NOT_SUPPORTED', 'This identity context has no application account');
};

const security = (request: { server: { security?: SecurityOperations } }): SecurityOperations => {
  // a programming error (a guarded route registered without the security service), never a client error: it surfaces as a generic 500
  if (!request.server.security) throw new Error('step-up guard used without the security service');
  return request.server.security;
};

/** The configured window in seconds; an unreadable configuration is a 503 (a security limit has no code default: the guard fails closed). */
const windowSeconds = async (svc: SecurityOperations): Promise<number> => {
  const policy = await svc.getPolicy().catch((err: unknown) => toAppError(err));
  return policy.stepUpValidMinutes * 60;
};

const isRecent = (authTime: number | undefined, maxAgeSeconds: number, nowSeconds: number): boolean =>
  typeof authTime === 'number' && Number.isFinite(authTime) && authTime <= nowSeconds + FUTURE_SKEW_SECONDS && nowSeconds - authTime <= maxAgeSeconds;

/** The caller authenticated at the identity provider within `security.step_up_valid_minutes`. */
export function requireRecentAuthentication(): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function recentAuthentication(request, reply) {
    await authenticateWeb(authenticate, request, reply);
    const maxAgeSeconds = await windowSeconds(security(request));
    if (isRecent(request.principal!.authTime, maxAgeSeconds, Math.floor(Date.now() / 1000))) return;
    const realm = (request.server as unknown as { authRealm: string }).authRealm;
    throw stepUpRequired(realm, { requirement: 'RECENT_AUTHENTICATION', maxAgeSeconds });
  };
}

/** The caller authenticated recently WITH a second factor (`acr` of the verified token), and has one enrolled. */
export function requireMfa(): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function mfa(request, reply) {
    await authenticateWeb(authenticate, request, reply);
    const svc = security(request);
    const p = request.principal!;
    const maxAgeSeconds = await windowSeconds(svc);
    if (isMfaAcr(p.acr) && isRecent(p.authTime, maxAgeSeconds, Math.floor(Date.now() / 1000))) return;
    const realm = (request.server as unknown as { authRealm: string }).authRealm;
    if (!isMfaAcr(p.acr)) {
      // asking the person to authenticate with a second factor they do not have would loop forever: say so instead (needs the account, so after requireAccount)
      const accountId = request.account?.accountId;
      if (!accountId) throw new Error('requireMfa must be listed after requireAccount');
      const enrolled = await svc.hasMfaEnrolled(accountId).catch((err: unknown) => toAppError(err));
      if (enrolled === null) {
        // the identity provider could not be asked: neither allow nor send the person to a second factor that may not exist
        return toAppError(new AccountError('SECURITY_UNAVAILABLE', 'the identity provider could not be asked'));
      }
      if (!enrolled)
        throw new AppError('AUTHORIZATION', 'MFA_ENROLLMENT_REQUIRED', 'A second factor must be set up first', {
          messageKey: authSecurityErrorMessageKey('MFA_ENROLLMENT_REQUIRED'),
        });
    }
    throw stepUpRequired(realm, { requirement: 'MFA', maxAgeSeconds, acrValues: ACR_MFA });
  };
}

/** Dispatch by requirement, for routes that choose it from a table. */
export const requireStepUp = (requirement: StepUpRequirement): preHandlerAsyncHookHandler =>
  requirement === 'MFA' ? requireMfa() : requireRecentAuthentication();
