// Account API shaping and error mapping. The account read model carries the caller's OWN data only; it never holds a token, a Keycloak subject or an
// issuer, and the full name appears only in the caller's own profile (never in a public view).
import type { AccountDto } from '@bananagig/contracts';
import { AccountError, type AccountContext } from '@bananagig/accounts';
import { AppError } from '../../errors';

export const accountDto = (ctx: AccountContext): AccountDto => ({
  accountId: ctx.accountId,
  status: ctx.status,
  roles: ctx.roles.map((r) => ({ code: r.code, nameContentKey: r.nameContentKey })),
  primaryRole: ctx.primaryRole,
  activeRole: ctx.activeRole,
  profile: ctx.profile ? { ...ctx.profile } : null,
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
  }
}
