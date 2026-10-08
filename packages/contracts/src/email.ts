// Public contracts of the account email contact and its verification (ID-002, docs/engineering/EMAIL_VERIFICATION.md): the vocabularies, the ONE
// canonicalization function, masking, the read models, the strict request bodies, the identity domain events and the error codes.
//
// Email is personal data. Nothing here carries a verification code, a magic token or a hash, and no read model returns a full address: the caller sees a
// MASKED form. The canonical address is the comparison and uniqueness key (identity.email_contacts.email_normalized) and is also where mail is sent.
import { z } from 'zod';
import { envelope } from './envelope';
import { containsForbiddenText } from './text';

// ---------------------------------------------------------------- vocabularies
/**
 * PENDING: a first (initial) address, not yet verified. VERIFIED: ownership proven. REPLACEMENT_PENDING: a new address that will replace the verified
 * primary once it verifies (the old address stays VERIFIED and primary until then). DISABLED: no longer in use (replaced or superseded); kept for history.
 */
export const EMAIL_CONTACT_STATUSES = ['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED'] as const;
export const EmailContactStatus = z.enum(EMAIL_CONTACT_STATUSES);
export type EmailContactStatus = z.infer<typeof EmailContactStatus>;
/** The statuses of an address that is still waiting for its verification (at most one such address per account). */
export const EMAIL_OPEN_STATUSES = ['PENDING', 'REPLACEMENT_PENDING'] as const;
export const EmailOpenStatus = z.enum(EMAIL_OPEN_STATUSES);
export type EmailOpenStatus = z.infer<typeof EmailOpenStatus>;
/**
 * Where an address came from. USER_ENTERED must be verified by code or link. IDP_VERIFIED was reported as verified by a TRUSTED identity provider
 * (see decideIdpEmail in @bananagig/accounts) and is born VERIFIED. A plain email claim is neither: it is never persisted.
 */
export const EMAIL_SOURCES = ['USER_ENTERED', 'IDP_VERIFIED'] as const;
export const EmailSource = z.enum(EMAIL_SOURCES);
export type EmailSource = z.infer<typeof EmailSource>;
/** INITIAL_EMAIL: the account had no verified address. CHANGE_EMAIL: it replaces a verified primary (the old one stays active until the new one verifies). */
export const EMAIL_PURPOSES = ['INITIAL_EMAIL', 'CHANGE_EMAIL'] as const;
export const EmailPurpose = z.enum(EMAIL_PURPOSES);
export type EmailPurpose = z.infer<typeof EmailPurpose>;
export const EMAIL_VERIFICATION_METHODS = ['CODE', 'LINK'] as const;
export const EmailVerificationMethod = z.enum(EMAIL_VERIFICATION_METHODS);
export type EmailVerificationMethod = z.infer<typeof EmailVerificationMethod>;
export const EMAIL_DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];
/** Why a challenge stopped being usable without being used. */
export const EMAIL_INVALIDATION_REASONS = ['SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED'] as const;
export type EmailInvalidationReason = (typeof EMAIL_INVALIDATION_REASONS)[number];
export const EMAIL_DISABLED_REASONS = ['REPLACED', 'SUPERSEDED'] as const;
export type EmailDisabledReason = (typeof EMAIL_DISABLED_REASONS)[number];

/**
 * The account-level verification state that application services (and later the booking gate, CU-03/CU-04) read: NONE (no address), PENDING (an address
 * was added and none is verified yet), VERIFIED (a verified primary address exists, even while a replacement is pending).
 */
export const EMAIL_VERIFICATION_STATUSES = ['NONE', 'PENDING', 'VERIFIED'] as const;
export const EmailVerificationStatus = z.enum(EMAIL_VERIFICATION_STATUSES);
export type EmailVerificationStatus = z.infer<typeof EmailVerificationStatus>;
/** Content key of the label of a verification status (managed copy, never a constant). */
export const emailStatusLabelKey = (status: EmailVerificationStatus): string => `account.email.status.${status.toLowerCase()}`;

// ---------------------------------------------------------------- canonicalization (ONE function; docs/engineering/EMAIL_VERIFICATION.md section "Canonical form")
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_LOCAL_MAX_LENGTH = 64;
const EMAIL_INPUT_MAX_LENGTH = 1024;
export const EMAIL_ISSUE_CODES = ['REQUIRED', 'TOO_LONG', 'INVALID_FORMAT', 'INVALID_CHARACTERS', 'UNSUPPORTED'] as const;
export type EmailIssueCode = (typeof EMAIL_ISSUE_CODES)[number];
/** Content key of the message of an email issue (managed copy). */
export const emailIssueMessageKey = (code: EmailIssueCode): string => `account.email.error.${code.toLowerCase()}`;

// dot-atom local part (RFC 5322 atext), ASCII only, applied to the LOWER-CASED local part
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// what may appear in a domain before IDNA mapping: letters, numbers and combining marks of any script, hyphen, dot
const DOMAIN_INPUT = /^[\p{L}\p{N}\p{M}.-]+$/u;
// anything outside printable ASCII (control characters were refused before this is used)
const NON_ASCII = /[^ -~]/;

export type CanonicalEmailResult = { ok: true; value: string } | { ok: false; code: EmailIssueCode };

/**
 * THE canonicalization of an email address; every comparison, uniqueness check, lookup key and delivery uses its result.
 *
 * Policy (documented in docs/engineering/EMAIL_VERIFICATION.md):
 *  - outer whitespace is trimmed; the address must hold exactly ONE `@`; control, bidirectional-override and unpaired-surrogate characters are refused;
 *  - the DOMAIN is case-insensitive: it is mapped through IDNA to its lower-case ASCII (punycode) form, must have at least two labels (no bare host, no IP
 *    literal, no all-numeric top-level label), labels of 1 to 63 LDH characters, at most 253 characters in total;
 *  - the LOCAL PART is a plain dot-atom (no quoted strings, no comments, no internationalized local parts, at most 64 characters). BananaGig treats it as
 *    CASE-INSENSITIVE and folds it to lower case: mailbox providers do, and a case-sensitive reading would let `Ana@x.com` and `ana@x.com` be two verified
 *    identities. Nothing else is folded: dots and `+tags` are KEPT (no Gmail-style normalization is invented, `a.b+c@x.com` stays `a.b+c@x.com`);
 *  - the whole address is at most 254 characters.
 * The result carries a code only, never the rejected value. Idempotent: canonicalizeEmail(canonical) === canonical.
 */
export function canonicalizeEmail(raw: unknown): CanonicalEmailResult {
  if (typeof raw !== 'string') return { ok: false, code: 'REQUIRED' };
  if (raw.length > EMAIL_INPUT_MAX_LENGTH) return { ok: false, code: 'TOO_LONG' };
  if (containsForbiddenText(raw)) return { ok: false, code: 'INVALID_CHARACTERS' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, code: 'REQUIRED' };
  const parts = trimmed.split('@');
  if (parts.length !== 2) return { ok: false, code: 'INVALID_FORMAT' };
  const [localRaw, domainRaw] = parts as [string, string];
  if (localRaw === '' || domainRaw === '') return { ok: false, code: 'INVALID_FORMAT' };

  // internationalized (non-ASCII) and quoted local parts are valid addresses that BananaGig does not support
  if (NON_ASCII.test(localRaw) || localRaw.startsWith('"')) return { ok: false, code: 'UNSUPPORTED' };
  const local = localRaw.toLowerCase();
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) return { ok: false, code: 'TOO_LONG' };
  if (!LOCAL_PART.test(local)) return { ok: false, code: 'INVALID_FORMAT' };

  if (!DOMAIN_INPUT.test(domainRaw)) return { ok: false, code: 'INVALID_FORMAT' };
  let domain = domainRaw.toLowerCase();
  if (NON_ASCII.test(domain)) {
    try {
      domain = new URL(`http://${domainRaw}/`).hostname;
    } catch {
      return { ok: false, code: 'INVALID_FORMAT' };
    }
  }
  if (domain.length > 253) return { ok: false, code: 'TOO_LONG' };
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return { ok: false, code: 'INVALID_FORMAT' };
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return { ok: false, code: 'INVALID_FORMAT' };

  const value = `${local}@${domain}`;
  if (value.length > EMAIL_MAX_LENGTH) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, value };
}

/** Whether a string is exactly the canonical form of an address. */
export const isCanonicalEmail = (v: unknown): v is string => {
  const r = canonicalizeEmail(v);
  return r.ok && r.value === v;
};

/**
 * The display form of an address for screens, admin views and audit: the first character of the local part and of the first domain label, the last domain
 * label (`c***@b***.localhost`). The input must be canonical (a non-canonical value is masked entirely).
 */
export function maskEmail(canonical: string): string {
  const r = canonicalizeEmail(canonical);
  if (!r.ok || r.value !== canonical) return '***';
  const [local, domain] = canonical.split('@') as [string, string];
  const labels = domain.split('.');
  return `${local[0]}***@${labels[0]![0]}***.${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------- read models (owner only; the address is always masked)
export const PrimaryEmailDto = z.object({
  maskedEmail: z.string(),
  verifiedAt: z.string(),
  source: EmailSource,
});
export type PrimaryEmailDto = z.infer<typeof PrimaryEmailDto>;

export const PendingEmailDto = z.object({
  maskedEmail: z.string(),
  purpose: EmailPurpose,
  status: EmailOpenStatus,
  /** When the newest verification message was sent, or null when none has been sent yet. */
  lastSentAt: z.string().nullable(),
  /** When the newest usable verification expires, or null when there is none. */
  expiresAt: z.string().nullable(),
});
export type PendingEmailDto = z.infer<typeof PendingEmailDto>;

/** The email state carried by `GET /account/me`: cheap to compute (no configuration read) and safe (masked). */
export const AccountEmailSummaryDto = z.object({
  emailVerificationStatus: EmailVerificationStatus,
  primary: PrimaryEmailDto.nullable(),
  pending: PendingEmailDto.nullable(),
});
export type AccountEmailSummaryDto = z.infer<typeof AccountEmailSummaryDto>;

/** The detailed state for the verification screen: the summary plus what the screen needs to render its countdown and its input. */
export const AccountEmailDetailDto = AccountEmailSummaryDto.extend({
  /** Earliest time a new code may be requested, or null when one may be requested now (or there is no pending address). */
  resendAvailableAt: z.string().nullable(),
  /** Wrong-code attempts left on the newest usable challenge, or null. */
  attemptsRemaining: z.number().int().nullable(),
  /** Digits in a code (configuration). */
  codeLength: z.number().int(),
  validityMinutes: z.number().int(),
});
export type AccountEmailDetailDto = z.infer<typeof AccountEmailDetailDto>;
export const AccountEmailResponse = envelope(AccountEmailDetailDto);

export const EmailVerificationSentDto = z.object({
  /** The send was accepted by the delivery provider. */
  sentAt: z.string(),
  expiresAt: z.string(),
  resendAvailableAt: z.string(),
  codeLength: z.number().int(),
  validityMinutes: z.number().int(),
  /** The state after the send. */
  email: AccountEmailSummaryDto,
});
export type EmailVerificationSentDto = z.infer<typeof EmailVerificationSentDto>;
export const EmailVerificationSentResponse = envelope(EmailVerificationSentDto);

/** The result of setting the address: false `changed` means the call changed nothing. */
export const SetEmailResultDto = z.object({
  changed: z.boolean(),
  email: AccountEmailSummaryDto,
});
export type SetEmailResultDto = z.infer<typeof SetEmailResultDto>;
export const SetEmailResponse = envelope(SetEmailResultDto);

export const EmailVerifiedDto = z.object({
  /** False when the address was already verified (a repeated confirmation is idempotent and has no side effects). */
  changed: z.boolean(),
  email: AccountEmailSummaryDto,
});
export type EmailVerifiedDto = z.infer<typeof EmailVerifiedDto>;
export const EmailVerifiedResponse = envelope(EmailVerifiedDto);

// ---------------------------------------------------------------- requests (strict: unknown fields are refused; nothing is coerced)
/** Sets the address to verify: the first address (INITIAL_EMAIL) or a replacement for the verified primary (CHANGE_EMAIL). */
export const SetEmailRequest = z.object({ email: z.string().max(EMAIL_INPUT_MAX_LENGTH) }).strict();
export type SetEmailRequest = z.infer<typeof SetEmailRequest>;
/** Asks for a (new) verification message for the pending address. There is nothing to choose: the address is the account's own pending address. */
export const SendEmailVerificationRequest = z.object({}).strict();
export type SendEmailVerificationRequest = z.infer<typeof SendEmailVerificationRequest>;
/** The shape of a code (digits); the exact length is a configuration value checked by the service. A malformed code is a 400, not an attempt. */
export const EMAIL_CODE_SHAPE = /^[0-9]{4,10}$/;
export const ConfirmEmailCodeRequest = z.object({ code: z.string().regex(EMAIL_CODE_SHAPE) }).strict();
export type ConfirmEmailCodeRequest = z.infer<typeof ConfirmEmailCodeRequest>;
/** A magic token: 32 random bytes as unpadded base64url. It travels in a POST body, never in a URL the API sees. */
export const EMAIL_TOKEN_LENGTH = 43;
export const EMAIL_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const ConfirmEmailLinkRequest = z.object({ token: z.string().regex(EMAIL_TOKEN_SHAPE) }).strict();
export type ConfirmEmailLinkRequest = z.infer<typeof ConfirmEmailLinkRequest>;

// ---------------------------------------------------------------- events (transactional outbox; identifiers only, never an address, a code or a token)
export const EMAIL_EVENTS = {
  contactAdded: 'bananagig.identity.email-contact-added.v1',
  verificationSent: 'bananagig.identity.email-verification-sent.v1',
  verified: 'bananagig.identity.email-verified.v1',
  verificationFailed: 'bananagig.identity.email-verification-failed.v1',
  changeRequested: 'bananagig.identity.email-change-requested.v1',
} as const;
export const EmailContactAddedPayload = z.object({
  accountId: z.string(),
  emailContactId: z.string(),
  purpose: EmailPurpose,
  source: EmailSource,
  status: EmailContactStatus,
});
export type EmailContactAddedPayload = z.infer<typeof EmailContactAddedPayload>;
export const EmailVerificationSentPayload = z.object({
  accountId: z.string(),
  emailContactId: z.string(),
  challengeId: z.string(),
  purpose: EmailPurpose,
  expiresAt: z.string(),
});
export type EmailVerificationSentPayload = z.infer<typeof EmailVerificationSentPayload>;
export const EmailVerifiedPayload = z.object({
  accountId: z.string(),
  emailContactId: z.string(),
  purpose: EmailPurpose,
  source: EmailSource,
  /** How it was verified; IDP when a trusted identity provider reported it verified. */
  method: z.enum(['CODE', 'LINK', 'IDP']),
  /** The verified primary address this one replaced, or null. */
  replacedEmailContactId: z.string().nullable(),
});
export type EmailVerifiedPayload = z.infer<typeof EmailVerifiedPayload>;
export const EmailVerificationFailedPayload = z.object({
  accountId: z.string(),
  emailContactId: z.string(),
  challengeId: z.string(),
  attemptCount: z.number().int(),
  /** True when this attempt used the last allowed one and the challenge is now locked. */
  locked: z.boolean(),
});
export type EmailVerificationFailedPayload = z.infer<typeof EmailVerificationFailedPayload>;
export const EmailChangeRequestedPayload = z.object({
  accountId: z.string(),
  /** The new (pending) address. */
  emailContactId: z.string(),
  /** The verified primary address that stays active until the new one verifies. */
  replacesEmailContactId: z.string(),
});
export type EmailChangeRequestedPayload = z.infer<typeof EmailChangeRequestedPayload>;

// ---------------------------------------------------------------- error codes (mapped to `ACCOUNT_<code>` by the API layer)
export const EMAIL_ERROR_CODES = [
  'EMAIL_INVALID',
  'EMAIL_NOT_PENDING',
  'EMAIL_CODE_INVALID',
  'EMAIL_LINK_INVALID',
  'EMAIL_CODE_EXPIRED',
  'EMAIL_CODE_USED',
  'EMAIL_VERIFICATION_LOCKED',
  'EMAIL_RESEND_TOO_SOON',
  'EMAIL_SEND_LIMIT',
  'EMAIL_UNAVAILABLE',
  'EMAIL_DELIVERY_FAILED',
  'EMAIL_RATE_LIMITED',
] as const;
export type EmailErrorCode = (typeof EMAIL_ERROR_CODES)[number];
/** Content key of the message of an email error code (managed copy). EMAIL_INVALID carries an issue code instead: use emailIssueMessageKey. */
export const emailErrorMessageKey = (code: Exclude<EmailErrorCode, 'EMAIL_INVALID'>): string =>
  `account.email.error.${code.replace(/^EMAIL_/, '').toLowerCase()}`;
