// Public contracts of the account phone contact and its verification (ID-003, docs/engineering/PHONE_VERIFICATION.md): the vocabularies, the E.164 shape, masking,
// the read models, the strict request bodies, the identity domain events, the error codes and the derived contact-verification summary.
//
// A phone number is personal data. Nothing here carries a verification code or a hash, and no read model returns a full number: the caller sees a MASKED form.
// The canonical form is E.164 (`+` and 7 to 15 digits). The numbering rules themselves (what is a valid number in which country) are NOT here: they come from a
// proven library (libphonenumber-js) in @bananagig/accounts, so this package stays free of dependencies.
import { z } from 'zod';
import { envelope } from './envelope';
import { EMAIL_CODE_SHAPE, EmailVerificationStatus } from './email';

// ---------------------------------------------------------------- vocabularies
/** Same lifecycle as the email contact (ADR-0027): PENDING (first number), VERIFIED, REPLACEMENT_PENDING (replaces the verified primary once verified), DISABLED. */
export const PHONE_CONTACT_STATUSES = ['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED'] as const;
export const PhoneContactStatus = z.enum(PHONE_CONTACT_STATUSES);
export type PhoneContactStatus = z.infer<typeof PhoneContactStatus>;
export const PHONE_OPEN_STATUSES = ['PENDING', 'REPLACEMENT_PENDING'] as const;
export const PhoneOpenStatus = z.enum(PHONE_OPEN_STATUSES);
export type PhoneOpenStatus = z.infer<typeof PhoneOpenStatus>;
/** Where a number came from. USER_ENTERED must be verified by an SMS code. The column exists so a trusted source can be added by widening the CHECK. */
export const PHONE_SOURCES = ['USER_ENTERED'] as const;
export const PhoneSource = z.enum(PHONE_SOURCES);
export type PhoneSource = z.infer<typeof PhoneSource>;
export const PHONE_PURPOSES = ['INITIAL_PHONE', 'CHANGE_PHONE'] as const;
export const PhonePurpose = z.enum(PHONE_PURPOSES);
export type PhonePurpose = z.infer<typeof PhonePurpose>;
export const PHONE_DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type PhoneDeliveryStatus = (typeof PHONE_DELIVERY_STATUSES)[number];
export const PHONE_INVALIDATION_REASONS = ['SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED'] as const;
export type PhoneInvalidationReason = (typeof PHONE_INVALIDATION_REASONS)[number];
export const PHONE_DISABLED_REASONS = ['REPLACED', 'SUPERSEDED'] as const;
export type PhoneDisabledReason = (typeof PHONE_DISABLED_REASONS)[number];

/** What a phone-intelligence adapter reports about a number (provider-neutral). UNKNOWN means "could not be classified", not "refused". */
export const PHONE_LINE_TYPES = ['MOBILE', 'LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] as const;
export const PhoneLineType = z.enum(PHONE_LINE_TYPES);
export type PhoneLineType = z.infer<typeof PhoneLineType>;
/** The line types a market can block (MOBILE is never blockable: a policy that blocks every mobile number would block the product). */
export const PHONE_BLOCKABLE_LINE_TYPES = ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] as const;
export const PhoneBlockableLineType = z.enum(PHONE_BLOCKABLE_LINE_TYPES);
export type PhoneBlockableLineType = z.infer<typeof PhoneBlockableLineType>;

/** Account-level state application services read: NONE (no number), PENDING (a number was added, none verified), VERIFIED (a verified primary exists). */
export const PhoneVerificationStatus = EmailVerificationStatus;
export type PhoneVerificationStatus = z.infer<typeof PhoneVerificationStatus>;
export const phoneStatusLabelKey = (status: PhoneVerificationStatus): string => `account.phone.status.${status.toLowerCase()}`;

// ---------------------------------------------------------------- E.164 and masking
/** E.164: a plus sign, a non-zero first digit and up to 15 digits in all (here at least 7). The canonical stored form; no spaces, dashes or parentheses. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
export const isE164 = (v: unknown): v is string => typeof v === 'string' && E164_PATTERN.test(v);
export const PHONE_INPUT_MAX_LENGTH = 64;
export const PHONE_ISSUE_CODES = ['REQUIRED', 'TOO_LONG', 'INVALID_CHARACTERS', 'INVALID_NUMBER', 'COUNTRY_REQUIRED', 'COUNTRY_NOT_SUPPORTED'] as const;
export type PhoneIssueCode = (typeof PHONE_ISSUE_CODES)[number];
/** Content key of the message of a phone issue (managed copy). */
export const phoneIssueMessageKey = (code: PhoneIssueCode): string => `account.phone.error.${code.toLowerCase()}`;

/**
 * The display form of a number for screens, admin views and audit: the plus sign, stars and the last four digits (`+*******0142`; the last two for a very
 * short number). The input must be E.164 (anything else is masked entirely). The length of the number is visible, its digits are not.
 */
export function maskPhone(e164: string): string {
  if (!isE164(e164)) return '***';
  const digits = e164.slice(1);
  const shown = digits.length >= 9 ? 4 : 2;
  return `+${'*'.repeat(digits.length - shown)}${digits.slice(-shown)}`;
}

// ---------------------------------------------------------------- read models (owner only; the number is always masked)
export const PrimaryPhoneDto = z.object({
  maskedPhone: z.string(),
  /** ISO 3166-1 alpha-2 country of the number. */
  countryCode: z.string(),
  verifiedAt: z.string(),
  source: PhoneSource,
});
export type PrimaryPhoneDto = z.infer<typeof PrimaryPhoneDto>;

export const PendingPhoneDto = z.object({
  maskedPhone: z.string(),
  countryCode: z.string(),
  purpose: PhonePurpose,
  status: PhoneOpenStatus,
  /** When the newest verification SMS was accepted by the sender, or null when none was sent yet. */
  lastSentAt: z.string().nullable(),
  /** When the newest usable code expires, or null when there is none. */
  expiresAt: z.string().nullable(),
});
export type PendingPhoneDto = z.infer<typeof PendingPhoneDto>;

/** The phone state carried by `GET /account/me`: cheap to compute (no configuration read) and safe (masked). */
export const AccountPhoneSummaryDto = z.object({
  phoneVerificationStatus: PhoneVerificationStatus,
  primary: PrimaryPhoneDto.nullable(),
  pending: PendingPhoneDto.nullable(),
});
export type AccountPhoneSummaryDto = z.infer<typeof AccountPhoneSummaryDto>;

export const AccountPhoneDetailDto = AccountPhoneSummaryDto.extend({
  /** Earliest time a new code may be requested, or null when one may be requested now (or there is no pending number). */
  resendAvailableAt: z.string().nullable(),
  /** Wrong-code attempts left on the newest usable challenge, or null. */
  attemptsRemaining: z.number().int().nullable(),
  codeLength: z.number().int(),
  validityMinutes: z.number().int(),
});
export type AccountPhoneDetailDto = z.infer<typeof AccountPhoneDetailDto>;
export const AccountPhoneResponse = envelope(AccountPhoneDetailDto);

export const PhoneVerificationSentDto = z.object({
  sentAt: z.string(),
  expiresAt: z.string(),
  resendAvailableAt: z.string(),
  codeLength: z.number().int(),
  validityMinutes: z.number().int(),
  phone: AccountPhoneSummaryDto,
});
export type PhoneVerificationSentDto = z.infer<typeof PhoneVerificationSentDto>;
export const PhoneVerificationSentResponse = envelope(PhoneVerificationSentDto);

export const SetPhoneResultDto = z.object({
  /** False when the call changed nothing (the number was already the pending or the primary one). */
  changed: z.boolean(),
  phone: AccountPhoneSummaryDto,
});
export type SetPhoneResultDto = z.infer<typeof SetPhoneResultDto>;
export const SetPhoneResponse = envelope(SetPhoneResultDto);

export const PhoneVerifiedDto = z.object({
  /** False when the number was already verified (a repeated confirmation is idempotent and has no side effects). */
  changed: z.boolean(),
  phone: AccountPhoneSummaryDto,
});
export type PhoneVerifiedDto = z.infer<typeof PhoneVerifiedDto>;
export const PhoneVerifiedResponse = envelope(PhoneVerifiedDto);

// ---------------------------------------------------------------- derived contact-verification summary (never stored)
/**
 * Whether the account's contacts are verified, DERIVED from the email and the phone state (no `contacts_verified` column exists). Future booking and provider
 * onboarding gates read this; ID-003 gates nothing.
 */
export const ContactsVerificationDto = z.object({
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  /** Both the email and the phone are verified. */
  contactsVerified: z.boolean(),
});
export type ContactsVerificationDto = z.infer<typeof ContactsVerificationDto>;
export function deriveContactsVerification(
  emailStatus: z.infer<typeof EmailVerificationStatus>,
  phoneStatus: PhoneVerificationStatus,
): ContactsVerificationDto {
  const emailVerified = emailStatus === 'VERIFIED';
  const phoneVerified = phoneStatus === 'VERIFIED';
  return { emailVerified, phoneVerified, contactsVerified: emailVerified && phoneVerified };
}

// ---------------------------------------------------------------- requests (strict: unknown fields are refused; nothing is coerced)
/** Sets the number to verify. `country` (ISO 3166-1 alpha-2) is the country a NATIONAL-format number is read in; an international (`+...`) number ignores it. */
export const SetPhoneRequest = z
  .object({
    phone: z.string().max(PHONE_INPUT_MAX_LENGTH),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();
export type SetPhoneRequest = z.infer<typeof SetPhoneRequest>;
export const SendPhoneVerificationRequest = z.object({}).strict();
export type SendPhoneVerificationRequest = z.infer<typeof SendPhoneVerificationRequest>;
/** The shape of an SMS code (digits); the exact length is a configuration value checked by the service. A malformed code is a 400, not an attempt. */
export const PHONE_CODE_SHAPE = EMAIL_CODE_SHAPE;
export const ConfirmPhoneCodeRequest = z.object({ code: z.string().regex(PHONE_CODE_SHAPE) }).strict();
export type ConfirmPhoneCodeRequest = z.infer<typeof ConfirmPhoneCodeRequest>;

// ---------------------------------------------------------------- events (transactional outbox; identifiers only, never a number or a code)
export const PHONE_EVENTS = {
  contactAdded: 'bananagig.identity.phone-contact-added.v1',
  verificationSent: 'bananagig.identity.phone-verification-sent.v1',
  verified: 'bananagig.identity.phone-verified.v1',
  verificationFailed: 'bananagig.identity.phone-verification-failed.v1',
  changeRequested: 'bananagig.identity.phone-change-requested.v1',
} as const;
export const PhoneContactAddedPayload = z.object({
  accountId: z.string(),
  phoneContactId: z.string(),
  purpose: PhonePurpose,
  source: PhoneSource,
  status: PhoneContactStatus,
});
export type PhoneContactAddedPayload = z.infer<typeof PhoneContactAddedPayload>;
export const PhoneVerificationSentPayload = z.object({
  accountId: z.string(),
  phoneContactId: z.string(),
  challengeId: z.string(),
  purpose: PhonePurpose,
  expiresAt: z.string(),
});
export type PhoneVerificationSentPayload = z.infer<typeof PhoneVerificationSentPayload>;
export const PhoneVerifiedPayload = z.object({
  accountId: z.string(),
  phoneContactId: z.string(),
  purpose: PhonePurpose,
  /** The verified primary number this one replaced, or null. */
  replacedPhoneContactId: z.string().nullable(),
});
export type PhoneVerifiedPayload = z.infer<typeof PhoneVerifiedPayload>;
export const PhoneVerificationFailedPayload = z.object({
  accountId: z.string(),
  phoneContactId: z.string(),
  challengeId: z.string(),
  attemptCount: z.number().int(),
  /** True when this attempt used the last allowed one and the challenge is now locked. */
  locked: z.boolean(),
});
export type PhoneVerificationFailedPayload = z.infer<typeof PhoneVerificationFailedPayload>;
export const PhoneChangeRequestedPayload = z.object({
  accountId: z.string(),
  /** The new (pending) number. */
  phoneContactId: z.string(),
  /** The verified primary number that stays active until the new one verifies. */
  replacesPhoneContactId: z.string(),
});
export type PhoneChangeRequestedPayload = z.infer<typeof PhoneChangeRequestedPayload>;

// ---------------------------------------------------------------- error codes (mapped to `ACCOUNT_<code>` by the API layer)
export const PHONE_ERROR_CODES = [
  'PHONE_INVALID',
  'PHONE_NOT_PENDING',
  'PHONE_CODE_INVALID',
  'PHONE_CODE_EXPIRED',
  'PHONE_CODE_USED',
  'PHONE_VERIFICATION_LOCKED',
  'PHONE_RESEND_TOO_SOON',
  'PHONE_SEND_LIMIT',
  'PHONE_UNAVAILABLE',
  'PHONE_NOT_ACCEPTED',
  'PHONE_RISK_UNAVAILABLE',
  'PHONE_DELIVERY_FAILED',
  'PHONE_RATE_LIMITED',
] as const;
export type PhoneErrorCode = (typeof PHONE_ERROR_CODES)[number];
/** Content key of the message of a phone error code (managed copy). PHONE_INVALID carries an issue code instead: use phoneIssueMessageKey. */
export const phoneErrorMessageKey = (code: Exclude<PhoneErrorCode, 'PHONE_INVALID'>): string =>
  `account.phone.error.${code.replace(/^PHONE_/, '').toLowerCase()}`;
