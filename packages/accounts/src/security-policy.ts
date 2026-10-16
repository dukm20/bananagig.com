// Policy of the account security layer (ID-004): the six configuration-driven values (CFG-001, `session.*`, `security.*`, `reset_link.*`). A security limit has no
// code default: a missing or malformed value is an outage of the policy and the operation fails closed. The configuration-backed provider is composed in the API
// (like the phone policy); this file holds the keys and the strict parser; the static provider for tests is in security-fakes.ts.
import { AccountError } from './errors';
import type { SecurityPolicy } from './security-types';

export const SECURITY_POLICY_KEYS = {
  trustedBrowserDays: 'session.trusted_browser_days',
  keepSignedInDays: 'session.keep_signed_in_days',
  stepUpValidMinutes: 'security.step_up_valid_minutes',
  activityLogDays: 'security.activity_log_days',
  resetLinkValidityMinutes: 'reset_link.validity_minutes',
  resetMaxRequestsPerHour: 'reset_link.max_requests_per_hour',
} as const satisfies Record<keyof SecurityPolicy, string>;
export type SecurityPolicyField = keyof typeof SECURITY_POLICY_KEYS;
export const SECURITY_POLICY_PARAMETER_KEYS: readonly string[] = Object.values(SECURITY_POLICY_KEYS);

/** The hard bounds of every field: the same as the validation rules of the seeded parameters (the registry validates on write; the parser is the last line of defense). */
export const SECURITY_POLICY_BOUNDS: Record<SecurityPolicyField, readonly [number, number]> = {
  trustedBrowserDays: [1, 365],
  keepSignedInDays: [1, 90],
  stepUpValidMinutes: [1, 60],
  activityLogDays: [30, 730],
  resetLinkValidityMinutes: [5, 1440],
  resetMaxRequestsPerHour: [1, 20],
};

const invalid = (field: SecurityPolicyField): never => {
  throw new AccountError('UNAVAILABLE', 'the security policy is not available', { reason: 'POLICY_INVALID', field });
};

/** Builds the policy from resolved configuration values, validating every field. A missing or malformed value throws UNAVAILABLE (never a default). */
export function parseSecurityPolicy(values: Readonly<Partial<Record<string, unknown>>>): SecurityPolicy {
  const out = {} as Record<SecurityPolicyField, number>;
  for (const field of Object.keys(SECURITY_POLICY_BOUNDS) as SecurityPolicyField[]) {
    const v = values[SECURITY_POLICY_KEYS[field]];
    const [min, max] = SECURITY_POLICY_BOUNDS[field];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) invalid(field);
    out[field] = v as number;
  }
  return out;
}

/** Validates a policy object that a provider built itself (the same bounds as the parser) and returns a copy. */
export function assertSecurityPolicy(policy: SecurityPolicy): SecurityPolicy {
  return parseSecurityPolicy(Object.fromEntries((Object.keys(SECURITY_POLICY_KEYS) as SecurityPolicyField[]).map((f) => [SECURITY_POLICY_KEYS[f], policy[f]])));
}
