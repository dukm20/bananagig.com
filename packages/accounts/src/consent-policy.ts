// Policy of the consent layer (ID-005): per purpose, who needs it (`consent.<purpose>.required_for`, a JSON array of role codes) and what a newer version does to an
// existing acceptance (`consent.<purpose>.reacceptance`, one of the three modes). A legal requirement has no code default: a missing or malformed value is an outage of the
// policy and the operation fails closed. The configuration-backed provider is composed in the API (like the phone and security policies); this file holds the keys and the
// strict parser; the static provider for tests is in consent-fakes.ts.
import { REACCEPTANCE_MODES, consentReacceptanceKey, consentRequiredForKey, type ReacceptanceMode } from '@bananagig/contracts';
import type { ConsentPolicy } from './consent-types';
import { AccountError } from './errors';

/** The shape of an application role code (identity.roles ck_roles__code_format). */
export const CONSENT_ROLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;
/** The most role codes a required_for list may hold (the same bound as the validation rules of the seeded parameters). */
export const CONSENT_REQUIRED_FOR_MAX = 10;

/** The configuration keys of one purpose's policy. */
export const consentPolicyKeys = (purposeCode: string): { requiredFor: string; reacceptance: string } => ({
  requiredFor: consentRequiredForKey(purposeCode),
  reacceptance: consentReacceptanceKey(purposeCode),
});

export type ConsentPolicyField = 'required_for' | 'reacceptance';

const invalid = (purposeCode: string, field: ConsentPolicyField): never => {
  throw new AccountError('UNAVAILABLE', 'the consent policy is not available', { reason: 'POLICY_INVALID', purposeCode, field });
};

/**
 * Validates the role list of a policy: an array of DISTINCT role codes (at most CONSENT_REQUIRED_FOR_MAX), each of the role code shape and, when `knownRoles` is given,
 * a role that exists. An empty list is valid (nobody is required to accept the purpose). Returns a copy.
 */
export function parseRequiredFor(purposeCode: string, value: unknown, knownRoles?: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value) || value.length > CONSENT_REQUIRED_FOR_MAX) return invalid(purposeCode, 'required_for');
  const seen = new Set<string>();
  for (const role of value as unknown[]) {
    if (typeof role !== 'string' || !CONSENT_ROLE_CODE_PATTERN.test(role) || seen.has(role)) return invalid(purposeCode, 'required_for');
    if (knownRoles && !knownRoles.has(role)) return invalid(purposeCode, 'required_for');
    seen.add(role);
  }
  return [...seen];
}

export function parseReacceptance(purposeCode: string, value: unknown): ReacceptanceMode {
  if (typeof value !== 'string' || !(REACCEPTANCE_MODES as readonly string[]).includes(value)) return invalid(purposeCode, 'reacceptance');
  return value as ReacceptanceMode;
}

/**
 * Builds the policy of a purpose from resolved configuration values (keyed by configuration key), validating every field. A missing or malformed value throws
 * UNAVAILABLE {reason: POLICY_INVALID} (never a default). `knownRoles` (the codes of identity.roles) makes an unknown role code invalid: a typo must not silently
 * require nothing.
 */
export function parseConsentPolicy(purposeCode: string, values: Readonly<Partial<Record<string, unknown>>>, knownRoles?: ReadonlySet<string>): ConsentPolicy {
  const keys = consentPolicyKeys(purposeCode);
  return {
    requiredForRoles: parseRequiredFor(purposeCode, values[keys.requiredFor], knownRoles),
    reacceptance: parseReacceptance(purposeCode, values[keys.reacceptance]),
  };
}

/** Validates a policy object that a provider built itself (the same rules as the parser) and returns a copy. */
export function assertConsentPolicy(purposeCode: string, policy: ConsentPolicy, knownRoles?: ReadonlySet<string>): ConsentPolicy {
  const keys = consentPolicyKeys(purposeCode);
  return parseConsentPolicy(purposeCode, { [keys.requiredFor]: policy?.requiredForRoles, [keys.reacceptance]: policy?.reacceptance }, knownRoles);
}
