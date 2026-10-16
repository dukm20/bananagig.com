// Account API shaping and error mapping. The account read model carries the caller's OWN data only; it never holds a token, a Keycloak subject or an
// issuer, and the full name appears only in the caller's own profile (never in a public view).
import {
  authSecurityErrorMessageKey,
  emailErrorMessageKey,
  phoneErrorMessageKey,
  securityErrorMessageKey,
  type AccountDto,
  type EmailErrorCode,
  type PhoneErrorCode,
  type SecurityErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext } from '@bananagig/accounts';
import { AppError } from '../../errors';
import { challenge } from '../../plugins/auth';

export const accountDto = (ctx: AccountContext): AccountDto => ({
  accountId: ctx.accountId,
  status: ctx.status,
  roles: ctx.roles.map((r) => ({ code: r.code, nameContentKey: r.nameContentKey })),
  primaryRole: ctx.primaryRole,
  activeRole: ctx.activeRole,
  profile: ctx.profile ? { ...ctx.profile } : null,
  email: ctx.email,
  phone: ctx.phone,
  contacts: ctx.contacts,
  createdAt: ctx.createdAt.toISOString(),
});

/**
 * Maps typed account failures onto the standard API error model. The AppError code is `ACCOUNT_<AccountError code>`. Details hold identifiers and
 * machine-readable reasons only; the constraint name and any cause are dropped here as well (defense in depth), and database outages are generic.
 *
 * The security codes (ID-004) carry NOTHING from the service details except a wait in seconds: no session or device id, no account id (the message key is
 * enough for the client). SESSION_REVOKED is an authentication failure, not an ACCOUNT_ code: 401 with the Bearer `invalid_token` challenge (`realm` is the API
 * realm when the caller knows it).
 */
export function toAppError(err: unknown, realm?: string): never {
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
    case 'PHONE_INVALID':
      throw new AppError('VALIDATION', code, err.message, details);
    case 'PHONE_NOT_PENDING':
    case 'PHONE_UNAVAILABLE':
      throw new AppError('CONFLICT', code, err.message, { ...details, messageKey: phoneErrorMessageKey(err.code) });
    case 'PHONE_NOT_ACCEPTED':
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EXPIRED':
    case 'PHONE_CODE_USED':
      throw new AppError('VALIDATION', code, err.message, { ...details, messageKey: phoneErrorMessageKey(err.code) });
    case 'PHONE_VERIFICATION_LOCKED':
    case 'PHONE_RESEND_TOO_SOON':
    case 'PHONE_SEND_LIMIT':
    case 'PHONE_RATE_LIMITED': {
      // 429 with Retry-After where the wait is known. The refusing dimension (account, number, source) is never named.
      const wait = typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds : undefined;
      throw new AppError(
        'RATE_LIMIT',
        code,
        err.message,
        { ...details, messageKey: phoneErrorMessageKey(err.code as Exclude<PhoneErrorCode, 'PHONE_INVALID'>) },
        wait === undefined ? undefined : { 'retry-after': String(wait) },
      );
    }
    case 'PHONE_RISK_UNAVAILABLE':
    case 'PHONE_DELIVERY_FAILED':
      throw new AppError(
        'DEPENDENCY',
        code,
        err.code === 'PHONE_RISK_UNAVAILABLE' ? 'The phone number could not be checked right now' : 'The verification text could not be sent',
        {
          retryable: err.code === 'PHONE_RISK_UNAVAILABLE' ? true : details.retryable === true,
          messageKey: phoneErrorMessageKey(err.code),
        },
      );
    case 'SESSION_REVOKED':
      throw new AppError(
        'AUTHENTICATION',
        'SESSION_REVOKED',
        'The session was revoked',
        { messageKey: authSecurityErrorMessageKey('SESSION_REVOKED') },
        realm === undefined ? { 'www-authenticate': 'Bearer error="invalid_token"' } : challenge(realm, 'invalid_token'),
      );
    case 'SESSION_NOT_FOUND':
      throw new AppError('NOT_FOUND', code, 'The session was not found', { messageKey: securityErrorMessageKey(err.code) });
    case 'DEVICE_NOT_FOUND':
      throw new AppError('NOT_FOUND', code, 'The browser was not found', { messageKey: securityErrorMessageKey(err.code) });
    case 'DEVICE_REQUIRED':
      throw new AppError('CONFLICT', code, 'This session has no registered browser', { messageKey: securityErrorMessageKey(err.code) });
    case 'SECURITY_UNAVAILABLE':
      throw new AppError('DEPENDENCY', code, 'The security service is temporarily unavailable', {
        retryable: true,
        messageKey: securityErrorMessageKey(err.code),
      });
    case 'PASSWORD_RESET_RATE_LIMITED': {
      // 429 with Retry-After where the wait is known; the refusing dimension (address or source) is never named.
      const wait =
        Number.isInteger(details.retryAfterSeconds) && (details.retryAfterSeconds as number) >= 0 ? (details.retryAfterSeconds as number) : undefined;
      throw new AppError(
        'RATE_LIMIT',
        code,
        'Too many password reset requests',
        { ...(wait === undefined ? {} : { retryAfterSeconds: wait }), messageKey: securityErrorMessageKey(err.code satisfies SecurityErrorCode) },
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
