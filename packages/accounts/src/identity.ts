// Pure helpers of the account model: the verified identity key, the one-time bootstrap roles and the active-role resolution. No I/O, no clock.
// Nothing here ever reads a client-supplied account id or role claim: the identity comes from a verified token and the requested role is checked
// against the memberships PostgreSQL holds.
import { BOOTSTRAP_ROLE_BY_IDENTITY_ROLE, IDENTITY_PROVIDER_TYPES, RoleCode, type AccountRoleStatus, type IdentityProviderType } from '@bananagig/contracts';
import { AccountError } from './errors';

/** What the API knows after verifying an access token. `identityRoles` are the Keycloak REALM roles of that token: used once, at account creation. */
export interface VerifiedIdentity {
  providerType: IdentityProviderType;
  issuer: string;
  subject: string;
  identityRoles: readonly string[];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;
export const MAX_ISSUER_LENGTH = 512;
export const MAX_SUBJECT_LENGTH = 255;

/**
 * Validates the external identity key (provider type, issuer, subject) exactly as the database constraints do. The key is the unique identity of a login:
 * one key links at most one account. Values are used verbatim (a token whose issuer or subject differs by one character is a different identity).
 */
export function parseVerifiedIdentity(input: VerifiedIdentity): VerifiedIdentity {
  const bad = (field: string): AccountError =>
    new AccountError('VALIDATION_FAILED', 'the verified identity is not usable', { reason: 'INVALID_IDENTITY', field });
  if (!(IDENTITY_PROVIDER_TYPES as readonly string[]).includes(input.providerType)) throw bad('providerType');
  if (typeof input.issuer !== 'string' || input.issuer.trim() === '' || input.issuer.length > MAX_ISSUER_LENGTH || CONTROL.test(input.issuer))
    throw bad('issuer');
  if (typeof input.subject !== 'string' || input.subject.trim() === '' || input.subject.length > MAX_SUBJECT_LENGTH || CONTROL.test(input.subject))
    throw bad('subject');
  return { providerType: input.providerType, issuer: input.issuer, subject: input.subject, identityRoles: [...input.identityRoles] };
}

/** A stable, non-secret key for in-process maps and tests. Never log it: the subject is a personal identifier. */
export const externalIdentityKey = (i: Pick<VerifiedIdentity, 'providerType' | 'issuer' | 'subject'>): string =>
  JSON.stringify([i.providerType, i.issuer, i.subject]);

/**
 * The application roles an account starts with: the roles mapped from the Keycloak realm roles of the first verified token (ADR-0025), in the order of
 * the mapping, without duplicates. Unknown identity roles map to nothing. After the account exists this is never consulted again.
 */
export function bootstrapRoleCodes(identityRoles: readonly string[]): string[] {
  const out: string[] = [];
  for (const [identityRole, appRole] of Object.entries(BOOTSTRAP_ROLE_BY_IDENTITY_ROLE)) {
    if (identityRoles.includes(identityRole) && !out.includes(appRole)) out.push(appRole);
  }
  return out;
}

export interface MembershipView {
  code: string;
  status: AccountRoleStatus;
}

/**
 * The role a request acts as. A requested role (the x-active-role header or the role switch endpoint) must be an ACTIVE membership of THIS account: a
 * role the account does not hold is ROLE_NOT_HELD, one it holds without being active is ROLE_NOT_ACTIVE. Without a request the primary role is used when
 * it is active, else the only active role, else none (the client must choose). Never trusts a role claim from the client.
 */
export function resolveActiveRole(args: { requested?: string | null; memberships: readonly MembershipView[]; primaryRole: string | null }): string | null {
  const active = args.memberships.filter((m) => m.status === 'ACTIVE').map((m) => m.code);
  if (args.requested !== undefined && args.requested !== null) {
    if (!RoleCode.safeParse(args.requested).success)
      throw new AccountError('ROLE_NOT_HELD', 'the account does not hold that role', { reason: 'INVALID_ROLE_CODE' });
    if (active.includes(args.requested)) return args.requested;
    if (args.memberships.some((m) => m.code === args.requested))
      throw new AccountError('ROLE_NOT_ACTIVE', 'that role is not active for the account', { role: args.requested });
    throw new AccountError('ROLE_NOT_HELD', 'the account does not hold that role', { role: args.requested });
  }
  if (args.primaryRole !== null && active.includes(args.primaryRole)) return args.primaryRole;
  return active.length === 1 ? active[0]! : null;
}
