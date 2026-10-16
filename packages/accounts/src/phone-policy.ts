// Policy of the phone verification (ID-003): the configuration-driven limits (CFG-001, channel-specific `verification.phone.*` keys, never the email values), the
// country and market policy (accounts per number, blocked line types), and the ports the composition root supplies. Nothing here has a default value.
import { PHONE_BLOCKABLE_LINE_TYPES, type PhoneBlockableLineType, type PhoneLineType } from '@bananagig/contracts';
import { AccountError } from './errors';

// ---------------------------------------------------------------- limits (product configuration, never constants)
export const PHONE_POLICY_KEYS = {
  codeLength: 'verification.phone.code.length',
  validityMinutes: 'verification.phone.validity_minutes',
  resendSeconds: 'verification.phone.resend_seconds',
  maxPerHour: 'verification.phone.max_per_hour',
  maxPerDay: 'verification.phone.max_per_day',
  maxAttempts: 'verification.phone.max_attempts',
  maxAccountsPerNumber: 'verification.phone.max_accounts_per_number',
  blockedLineTypes: 'verification.phone.blocked_line_types',
  requestsPerHour: 'verification.phone.requests.max_per_hour',
  numberPerHour: 'verification.phone.number.max_per_hour',
} as const;
export type PhonePolicyField = keyof typeof PHONE_POLICY_KEYS;
export const PHONE_POLICY_PARAMETER_KEYS: readonly string[] = Object.values(PHONE_POLICY_KEYS);

export interface PhoneVerificationPolicy {
  /** Digits in an SMS code. */
  codeLength: number;
  /** Minutes a code stays valid. */
  validityMinutes: number;
  /** Minimum seconds between two verification SMS of one account. */
  resendSeconds: number;
  /** Verification SMS one account may request per rolling hour / day. */
  maxPerHour: number;
  maxPerDay: number;
  /** Wrong code attempts before the challenge locks. */
  maxAttempts: number;
  /** How many accounts may hold the same number verified (country and market policy). */
  maxAccountsPerNumber: number;
  /** Line types a number may not have to be accepted (country and market policy). */
  blockedLineTypes: readonly PhoneBlockableLineType[];
  /** Phone verification requests (set, send, confirm) per account and per source address per hour. */
  requestsPerHour: number;
  /** Verification SMS to one number per hour across all accounts (SMS pumping and flooding limit). */
  numberPerHour: number;
}

/**
 * Supplies the policy for a number's country (the country-scoped values resolve with that country; PLATFORM when `country` is omitted). A failure must propagate:
 * the service then fails closed.
 */
export interface PhonePolicyProvider {
  policy(country?: string): Promise<PhoneVerificationPolicy>;
}

/** What the composition root knows about countries (geography): which countries accept phone numbers and which one is the default for a national-format number. */
export interface PhoneCountryDirectory {
  /** The country when it is ACTIVE (the dialing code is the one configured in geography), otherwise null. */
  active(isoAlpha2: string): Promise<{ dialingCode: string } | null>;
  /** The country a national-format number is read in when the caller names none (launch: the only ACTIVE country), or undefined. */
  defaultCountry(): Promise<string | undefined>;
}

const INT_BOUNDS: Record<Exclude<PhonePolicyField, 'blockedLineTypes'>, readonly [number, number]> = {
  codeLength: [4, 10],
  validityMinutes: [1, 1440],
  resendSeconds: [0, 86400],
  maxPerHour: [1, 1000],
  maxPerDay: [1, 10000],
  maxAttempts: [1, 100],
  maxAccountsPerNumber: [1, 5],
  requestsPerHour: [1, 100000],
  numberPerHour: [1, 1000],
};

const invalid = (field: PhonePolicyField): never => {
  throw new AccountError('UNAVAILABLE', 'the phone verification policy is not available', { reason: 'POLICY_INVALID', field });
};

/**
 * Builds a policy from resolved configuration values, validating every field again (the registry validates on write; this is the last line of defense for a
 * security limit). A missing or malformed value is an outage of the policy, not a default: the caller fails closed.
 */
export function parsePhoneVerificationPolicy(values: Readonly<Partial<Record<string, unknown>>>): PhoneVerificationPolicy {
  const out: Partial<Record<PhonePolicyField, number>> = {};
  for (const field of Object.keys(INT_BOUNDS) as Exclude<PhonePolicyField, 'blockedLineTypes'>[]) {
    const v = values[PHONE_POLICY_KEYS[field]];
    const [min, max] = INT_BOUNDS[field];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) invalid(field);
    out[field] = v as number;
  }
  const blocked = values[PHONE_POLICY_KEYS.blockedLineTypes];
  const allowed: readonly string[] = PHONE_BLOCKABLE_LINE_TYPES;
  if (
    !Array.isArray(blocked) ||
    blocked.length > allowed.length ||
    new Set(blocked).size !== blocked.length ||
    !blocked.every((t) => typeof t === 'string' && allowed.includes(t))
  )
    invalid('blockedLineTypes');
  return { ...(out as Omit<PhoneVerificationPolicy, 'blockedLineTypes'>), blockedLineTypes: [...(blocked as PhoneBlockableLineType[])] };
}

/** Validates a policy object that a provider built itself (the same bounds as the parser). */
export function assertPhoneVerificationPolicy(policy: PhoneVerificationPolicy): PhoneVerificationPolicy {
  return parsePhoneVerificationPolicy(Object.fromEntries((Object.keys(PHONE_POLICY_KEYS) as PhonePolicyField[]).map((f) => [PHONE_POLICY_KEYS[f], policy[f]])));
}

/** Whether a line type is refused by the market's blocked list. MOBILE is never blockable; a null snapshot (no lookup was needed) is never blocked. */
export const isLineTypeBlocked = (lineType: PhoneLineType | null, blocked: readonly PhoneBlockableLineType[]): boolean =>
  lineType !== null && lineType !== 'MOBILE' && (blocked as readonly string[]).includes(lineType);
