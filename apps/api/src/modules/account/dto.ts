// Account API shaping and error mapping. The account read model carries the caller's OWN data only; it never holds a token, a Keycloak subject or an
// issuer, and the full name appears only in the caller's own profile (never in a public view).
import { emailErrorMessageKey, type AccountDto, type EmailErrorCode } from '@bananagig/contracts';
import { AccountError, type AccountContext } from '@bananagig/accounts';
import { AppError } from '../../errors';

export const accountDto = (ctx: AccountContext): AccountDto => ({
  accountId: ctx.accountId,
  status: ctx.status,
  roles: ctx.roles.map((r) => ({ code: r.code, nameContentKey: r.nameContentKey })),
  primaryRole: ctx.primaryRole,
  activeRole: ctx.activeRole,
  profile: ctx.profile ? { ...ctx.profile } : null,
  email: ctx.email,
  createdAt: ctx.createdAt.toISOString(),
});

/**
 * Maps typed account failures onto the standard API error model. The AppError code is `ACCOUNT_<AccountError code>`. Details hold identifiers and
 * machine-readable reasons only; the constraint name and any cause are dropped here as well (defense in depth), and database outages are generic.
 */
export function toAppError(err: unknown): never {
  if (!(err instanceof AccountError)) throw err;
  const { cause: _cause, constraint: _constraint, ...details } = err.details;
  const code = `ACCOUNT_${err.code}`;
  switch (err.code) {
    case 'NOT_FOUND':
    case 'ROLE_NOT_FOUND':
      throw new AppError('NOT_FOUND', code, err.message, details);
    case 'SUSPENDED':
    case 'CLOSED':
    case 'ROLE_NOT_HELD':
    case 'ROLE_NOT_ACTIVE':
      throw new AppError('AUTHORIZATION', code, err.message, details);
    case 'VALIDATION_FAILED':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'CONFLICT':
    case 'INVALID_STATE':
      throw new AppError('CONFLICT', code, err.message, details);
    case 'UNAVAILABLE':
      throw new AppError('DEPENDENCY', code, 'The account service is temporarily unavailable');
    case 'EMAIL_INVALID':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'EMAIL_NOT_PENDING':
    case 'EMAIL_UNAVAILABLE':
      throw new AppError('CONFLICT', code, err.message, { ...details, messageKey: emailErrorMessageKey(err.code) });
    case 'EMAIL_CODE_INVALID':
    case 'EMAIL_LINK_INVALID':
    case 'EMAIL_CODE_EXPIRED':
    case 'EMAIL_CODE_USED':
      throw new AppError('VALIDATION', code, err.message, { ...details, messageKey: emailErrorMessageKey(err.code) });
    case 'EMAIL_VERIFICATION_LOCKED':
    case 'EMAIL_RESEND_TOO_SOON':
    case 'EMAIL_SEND_LIMIT':
    case 'EMAIL_RATE_LIMITED': {
      // 429 with Retry-After where the wait is known. The refusing dimension (account, address, source) is never named.
      const wait = typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds : undefined;
      throw new AppError(
        'RATE_LIMIT',
        code,
        err.message,
        { ...details, messageKey: emailErrorMessageKey(err.code as Exclude<EmailErrorCode, 'EMAIL_INVALID'>) },
        wait === undefined ? undefined : { 'retry-after': String(wait) },
      );
    }
    case 'EMAIL_DELIVERY_FAILED':
      throw new AppError('DEPENDENCY', code, 'The verification email could not be sent', {
        retryable: details.retryable === true,
        messageKey: emailErrorMessageKey(err.code),
      });
  }
}
