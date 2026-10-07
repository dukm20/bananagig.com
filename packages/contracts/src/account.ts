// Public contracts of the application account (ID-001, docs/engineering/ACCOUNTS.md): the account read model, role switching, the core profile,
// the name rules, the account status machine, and the identity domain events. Keycloak owns authentication; this is the BananaGig account that
// an authenticated Keycloak identity is mapped to. Nothing here carries a credential, a token, a Keycloak subject or a contact detail.
import { z } from 'zod';
import { Locale } from './content';
import { envelope } from './envelope';
import { IanaTimeZone } from './geography';
import { containsForbiddenText } from './text';

// ---------------------------------------------------------------- vocabularies
export const ACCOUNT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED'] as const;
export const AccountStatus = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatus>;
export const ACCOUNT_ROLE_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE'] as const;
export const AccountRoleStatus = z.enum(ACCOUNT_ROLE_STATUSES);
export type AccountRoleStatus = z.infer<typeof AccountRoleStatus>;
/** Where a role grant came from. BOOTSTRAP is the one-time seeding at account creation (see BOOTSTRAP_ROLE_BY_IDENTITY_ROLE). */
export const ROLE_GRANT_SOURCES = ['BOOTSTRAP', 'SIGNUP', 'ADMIN', 'SYSTEM'] as const;
export const RoleGrantSource = z.enum(ROLE_GRANT_SOURCES);
export type RoleGrantSource = z.infer<typeof RoleGrantSource>;
export const IDENTITY_PROVIDER_TYPES = ['KEYCLOAK'] as const;
export type IdentityProviderType = (typeof IDENTITY_PROVIDER_TYPES)[number];

/** Application role code (reference data in identity.roles). The format is checked here; which codes exist is data. */
export const RoleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/);
/** The two seeded application roles. Detailed admin or business roles do not exist yet; admin identities are separate logins. */
export const APPLICATION_ROLE_CODES = { customer: 'CUSTOMER', provider: 'PROVIDER' } as const;

/**
 * Account bootstrap policy (ADR-0025). When an account is created from the first verified identity, the initial application roles are seeded from the
 * Keycloak REALM roles of that token: `customer` gives CUSTOMER, `provider` gives PROVIDER (the PRD creates the account and role at sign-up, and a
 * provider-first sign-up must not also become a customer). This is a ONE-TIME hint: after the account exists the token's roles are never read again and
 * PostgreSQL is the only authority for application roles. A token with neither role creates an account with no role.
 */
export const BOOTSTRAP_ROLE_BY_IDENTITY_ROLE: Readonly<Record<string, string>> = {
  customer: APPLICATION_ROLE_CODES.customer,
  provider: APPLICATION_ROLE_CODES.provider,
};

/** The header a client (the web server) sends to name the active application role of ONE request. It is validated against the roles the account holds. */
export const ACTIVE_ROLE_HEADER = 'x-active-role';

/** Account status machine; the database trigger enforces the same table. CLOSED is terminal. */
export const ACCOUNT_STATUS_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  PENDING: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['SUSPENDED', 'CLOSURE_REQUESTED'],
  SUSPENDED: ['ACTIVE', 'CLOSURE_REQUESTED', 'CLOSED'],
  CLOSURE_REQUESTED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};
export const isAccountStatusTransitionAllowed = (from: AccountStatus, to: AccountStatus): boolean => ACCOUNT_STATUS_TRANSITIONS[from].includes(to);
/** Statuses in which the account can be used (read, switch role, edit the profile). SUSPENDED and CLOSED are refused by the API. */
export const isAccountUsable = (status: AccountStatus): boolean => status !== 'SUSPENDED' && status !== 'CLOSED';
/** Content key of the label of a status (managed copy, never a column or a constant). */
export const accountStatusLabelKey = (status: AccountStatus): string => `account.status.${status.toLowerCase()}`;

// ---------------------------------------------------------------- name rules (PRD CU-03: first and last name, required, 1 to 50 characters, trimmed)
/** Structural constraints, also CHECK constraints of identity.account_profiles; not configurable product policy. */
export const PROFILE_NAME_MIN = 1;
export const PROFILE_NAME_MAX = 50;
export const PROFILE_ISSUE_CODES = ['REQUIRED', 'TOO_LONG', 'INVALID_CHARACTERS'] as const;
export type ProfileIssueCode = (typeof PROFILE_ISSUE_CODES)[number];
/** Content key of the message of a name issue (managed copy). */
export const profileIssueMessageKey = (code: ProfileIssueCode): string => `account.error.name_${code.toLowerCase()}`;

const INVISIBLE = /[\u200B\u2060\u180E\uFEFF]/g;
/** Unicode NFC, tabs and line breaks as spaces, invisible characters removed, whitespace collapsed, trimmed. */
export function normalizeProfileName(raw: string): string {
  return raw
    .replace(/[\t\n\v\f\r]/g, ' ')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const codePoints = (s: string): number => [...s].length;
/** Validates and normalizes one name. The result carries a code only, never the rejected value. */
export function validateProfileName(raw: unknown): { ok: true; value: string } | { ok: false; code: ProfileIssueCode } {
  if (typeof raw !== 'string') return { ok: false, code: 'REQUIRED' };
  if (containsForbiddenText(raw.replace(/[\t\n\v\f\r]/g, ' '))) return { ok: false, code: 'INVALID_CHARACTERS' };
  const value = normalizeProfileName(raw);
  if (codePoints(value) < PROFILE_NAME_MIN) return { ok: false, code: 'REQUIRED' };
  if (codePoints(value) > PROFILE_NAME_MAX) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, value };
}

/**
 * The public display of a person (PRD SV-11.02, CU-05): first name and last initial, for example `Ana M.`. The legal or full name is never part of a
 * public display. The initial is the first character (code point) of the last name, upper-cased; a letter whose upper-casing expands to several characters (the German sharp s) is kept as it is, so it is always ONE character.
 */
export function publicDisplayName(firstName: string, lastName: string): string {
  const first = normalizeProfileName(firstName);
  const initial = [...normalizeProfileName(lastName)][0];
  if (initial === undefined) return first;
  // one character: an upper-casing that expands (ss for the German sharp s) keeps the original letter
  const upper = initial.toUpperCase();
  const shown = [...upper].length === 1 ? upper : initial;
  return first === '' ? `${shown}.` : `${first} ${shown}.`;
}

// ---------------------------------------------------------------- read models
export const AccountRoleDto = z.object({
  code: z.string(),
  /** Content key of the role name; resolve it with the content API. */
  nameContentKey: z.string(),
});
export type AccountRoleDto = z.infer<typeof AccountRoleDto>;

/** The caller's OWN profile (never a public view: the full name appears only here). */
export const AccountProfileDto = z.object({
  firstName: z.string(),
  lastName: z.string(),
  preferredLocale: z.string().nullable(),
  /** IANA time zone override, or null to follow the market default. */
  timeZone: z.string().nullable(),
});
export type AccountProfileDto = z.infer<typeof AccountProfileDto>;

export const AccountDto = z.object({
  accountId: z.string().uuid(),
  status: AccountStatus,
  /** The ACTIVE application roles of the account. */
  roles: z.array(AccountRoleDto),
  /** The preferred role (persisted), or null. */
  primaryRole: z.string().nullable(),
  /** The role this request acts as: the one the request named (validated), else the primary role, else the only role, else null. */
  activeRole: z.string().nullable(),
  profile: AccountProfileDto.nullable(),
  createdAt: z.string(),
});
export type AccountDto = z.infer<typeof AccountDto>;
export const AccountResponse = envelope(AccountDto);

// ---------------------------------------------------------------- requests
/** Switching the active role changes the application context only; it never creates a new Keycloak login or session. */
export const SetActiveRoleRequest = z.object({ role: RoleCode }).strict();
export type SetActiveRoleRequest = z.infer<typeof SetActiveRoleRequest>;
/** Replaces the profile (names required, locale and time zone optional: omitted or null clears them). */
export const UpdateProfileRequest = z
  .object({
    firstName: z.string().max(500),
    lastName: z.string().max(500),
    preferredLocale: Locale.nullish(),
    timeZone: IanaTimeZone.nullish(),
  })
  .strict();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

// ---------------------------------------------------------------- events (published through the transactional outbox; identifiers only, never a name, subject or token)
export const IDENTITY_EVENTS = {
  accountCreated: 'bananagig.identity.account-created.v1',
  externalIdentityLinked: 'bananagig.identity.external-identity-linked.v1',
  accountRoleGranted: 'bananagig.identity.account-role-granted.v1',
  accountRoleDeactivated: 'bananagig.identity.account-role-deactivated.v1',
  accountStatusChanged: 'bananagig.identity.account-status-changed.v1',
} as const;
export const AccountCreatedPayload = z.object({ accountId: z.string(), status: AccountStatus });
export type AccountCreatedPayload = z.infer<typeof AccountCreatedPayload>;
export const ExternalIdentityLinkedPayload = z.object({ accountId: z.string(), providerType: z.enum(IDENTITY_PROVIDER_TYPES) });
export type ExternalIdentityLinkedPayload = z.infer<typeof ExternalIdentityLinkedPayload>;
export const AccountRolePayload = z.object({ accountId: z.string(), roleCode: z.string(), source: RoleGrantSource.optional() });
export type AccountRolePayload = z.infer<typeof AccountRolePayload>;
export const AccountStatusChangedPayload = z.object({ accountId: z.string(), fromStatus: AccountStatus.nullable(), toStatus: AccountStatus });
export type AccountStatusChangedPayload = z.infer<typeof AccountStatusChangedPayload>;

/** Typed account error codes (mapped to the standard API error model as `ACCOUNT_<code>` by the API layer). */
export const ACCOUNT_ERROR_CODES = [
  'NOT_FOUND',
  'SUSPENDED',
  'CLOSED',
  'ROLE_NOT_FOUND',
  'ROLE_NOT_HELD',
  'ROLE_NOT_ACTIVE',
  'VALIDATION_FAILED',
  'CONFLICT',
  'INVALID_STATE',
  'UNAVAILABLE',
] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];
