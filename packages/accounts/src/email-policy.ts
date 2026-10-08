// Policy of the email verification (ID-002): the configuration-driven limits (CFG-001) and the explicit trust boundary for emails that an identity
// provider reports (docs/engineering/EMAIL_VERIFICATION.md, ADR-0027).
import { canonicalizeEmail } from '@bananagig/contracts';
import { AccountError } from './errors';

// ---------------------------------------------------------------- limits (product configuration, never constants)
/** The configuration keys of the policy. The seeded values and their rules are in migration 0010; nothing here is a default. */
export const EMAIL_POLICY_KEYS = {
  codeLength: 'verification.email.code.length',
  validityMinutes: 'verification.email.validity_minutes',
  resendSeconds: 'verification.email.resend_seconds',
  maxPerHour: 'verification.email.max_per_hour',
  maxPerDay: 'verification.email.max_per_day',
  maxAttempts: 'verification.email.max_attempts',
  requestsPerHour: 'verification.email.requests.max_per_hour',
  addressPerHour: 'verification.email.address.max_per_hour',
} as const;
export type EmailPolicyField = keyof typeof EMAIL_POLICY_KEYS;
export const EMAIL_POLICY_PARAMETER_KEYS: readonly string[] = Object.values(EMAIL_POLICY_KEYS);

export interface EmailVerificationPolicy {
  /** Digits in a code. */
  codeLength: number;
  /** Minutes a code and a magic link stay valid. */
  validityMinutes: number;
  /** Minimum seconds between two verification emails of one account. */
  resendSeconds: number;
  /** Verification emails one account may request per rolling hour. */
  maxPerHour: number;
  /** ... and per rolling day. */
  maxPerDay: number;
  /** Wrong code attempts before the challenge locks. */
  maxAttempts: number;
  /** Verification requests (set, send, confirm) per account and per source address per hour. */
  requestsPerHour: number;
  /** Verification emails to one address per hour across all accounts. */
  addressPerHour: number;
}

/** Supplies the current policy. The composition root implements it over the configuration registry; a failure must propagate (the service then fails closed). */
export interface VerificationPolicyProvider {
  policy(): Promise<EmailVerificationPolicy>;
}

const BOUNDS: Record<EmailPolicyField, readonly [number, number]> = {
  codeLength: [4, 10],
  validityMinutes: [1, 1440],
  resendSeconds: [0, 86400],
  maxPerHour: [1, 1000],
  maxPerDay: [1, 10000],
  maxAttempts: [1, 100],
  requestsPerHour: [1, 100000],
  addressPerHour: [1, 1000],
};

/**
 * Builds a policy from resolved configuration values, validating every field again (the registry validates on write; this is the last line of defense for a
 * security limit). A missing or malformed value is an outage of the policy, not a default: the caller fails closed.
 */
export function parseEmailVerificationPolicy(values: Readonly<Partial<Record<string, unknown>>>): EmailVerificationPolicy {
  const out = {} as Record<EmailPolicyField, number>;
  for (const field of Object.keys(EMAIL_POLICY_KEYS) as EmailPolicyField[]) {
    const v = values[EMAIL_POLICY_KEYS[field]];
    const [min, max] = BOUNDS[field];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
      throw new AccountError('UNAVAILABLE', 'the email verification policy is not available', { reason: 'POLICY_INVALID', field });
  }
  for (const field of Object.keys(EMAIL_POLICY_KEYS) as EmailPolicyField[]) out[field] = values[EMAIL_POLICY_KEYS[field]] as number;
  return out;
}

/** Validates a policy object that a provider built itself (the same bounds as the parser): an out-of-range value is a policy outage, never a raw error later. */
export function assertEmailVerificationPolicy(policy: EmailVerificationPolicy): EmailVerificationPolicy {
  return parseEmailVerificationPolicy(Object.fromEntries((Object.keys(EMAIL_POLICY_KEYS) as EmailPolicyField[]).map((f) => [EMAIL_POLICY_KEYS[f], policy[f]])));
}

// ---------------------------------------------------------------- trust boundary: emails reported by an identity provider
/**
 * What an identity provider says about an email, as the typed result of verifying a token or reading a userinfo response. BananaGig NEVER reads raw claims
 * in business code: a caller maps the provider response to this shape, so the rule below is the only place the trust decision is made.
 */
export interface IdpEmailAssertion {
  /** The email claim, as the provider sent it. */
  email: unknown;
  /** The `email_verified` claim, as the provider sent it. Only the boolean `true` counts. */
  emailVerified: unknown;
  /**
   * The Keycloak identity-provider alias the login was brokered through (`google`, `apple`), or null for a user of the Keycloak realm itself. Keycloak's own
   * `email_verified` flag is NOT evidence of anything BananaGig can rely on (an administrator or an import can set it), so a realm user never counts as trusted.
   */
  identityProvider: string | null;
}

export type IdpEmailDecision =
  /** The provider is trusted and says the address is verified: it may bootstrap a VERIFIED contact with source IDP_VERIFIED. */
  | { kind: 'VERIFIED'; email: string }
  /** The address may be offered as a prefilled suggestion; it is NEVER persisted as a contact and never counts as verified. */
  | { kind: 'SUGGESTION'; email: string; reason: 'NOT_VERIFIED' | 'UNTRUSTED_SOURCE' }
  /** Nothing usable (no claim, or not a valid address). */
  | { kind: 'IGNORE'; reason: 'NO_EMAIL' | 'INVALID_EMAIL' };

/**
 * THE explicit policy for an email an identity provider reports (ADR-0027). An address is bootstrapped as VERIFIED if and only if:
 *  1. the claim is a valid address (it is canonicalized with the same function as every other address);
 *  2. `email_verified` is exactly the boolean `true` (the string "true", 1, "yes" and a missing flag are NOT verified);
 *  3. the login was brokered through an identity provider that BananaGig explicitly trusts to verify email addresses (Google, Apple: `trustedProviders`,
 *     decided by the caller from deployment configuration, empty by default).
 * Anything else is at most a SUGGESTION. This function is pure: it persists nothing and calls nothing.
 */
export function decideIdpEmail(assertion: IdpEmailAssertion, trustedProviders: ReadonlySet<string>): IdpEmailDecision {
  if (assertion.email === undefined || assertion.email === null || assertion.email === '') return { kind: 'IGNORE', reason: 'NO_EMAIL' };
  const canonical = canonicalizeEmail(assertion.email);
  if (!canonical.ok) return { kind: 'IGNORE', reason: 'INVALID_EMAIL' };
  if (assertion.emailVerified !== true) return { kind: 'SUGGESTION', email: canonical.value, reason: 'NOT_VERIFIED' };
  const provider = assertion.identityProvider;
  if (typeof provider !== 'string' || provider === '' || !trustedProviders.has(provider))
    return { kind: 'SUGGESTION', email: canonical.value, reason: 'UNTRUSTED_SOURCE' };
  return { kind: 'VERIFIED', email: canonical.value };
}
