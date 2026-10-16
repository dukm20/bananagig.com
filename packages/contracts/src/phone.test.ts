// Unit tests of the phone contracts (ID-003): masking, the E.164 shape, the vocabularies, the message keys (every produced key must be a content key seeded by
// migration 0011), the strict request bodies, the read models (a full number, a code or a hash can never ride along), the identity events and the derived
// contact-verification summary.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EMAIL_VERIFICATION_STATUSES, EmailVerificationStatus } from './email';
import { EVENT_TYPE_PATTERN } from './index';
import {
  AccountPhoneDetailDto,
  AccountPhoneResponse,
  AccountPhoneSummaryDto,
  ConfirmPhoneCodeRequest,
  ContactsVerificationDto,
  E164_PATTERN,
  PHONE_BLOCKABLE_LINE_TYPES,
  PHONE_CODE_SHAPE,
  PHONE_CONTACT_STATUSES,
  PHONE_DELIVERY_STATUSES,
  PHONE_DISABLED_REASONS,
  PHONE_ERROR_CODES,
  PHONE_EVENTS,
  PHONE_INPUT_MAX_LENGTH,
  PHONE_INVALIDATION_REASONS,
  PHONE_ISSUE_CODES,
  PHONE_LINE_TYPES,
  PHONE_OPEN_STATUSES,
  PHONE_PURPOSES,
  PHONE_SOURCES,
  PendingPhoneDto,
  PhoneBlockableLineType,
  PhoneChangeRequestedPayload,
  PhoneContactAddedPayload,
  PhoneContactStatus,
  PhoneLineType,
  PhoneOpenStatus,
  PhonePurpose,
  PhoneSource,
  PhoneVerificationFailedPayload,
  PhoneVerificationSentDto,
  PhoneVerificationSentPayload,
  PhoneVerificationSentResponse,
  PhoneVerificationStatus,
  PhoneVerifiedDto,
  PhoneVerifiedPayload,
  PhoneVerifiedResponse,
  PrimaryPhoneDto,
  SendPhoneVerificationRequest,
  SetPhoneRequest,
  SetPhoneResponse,
  SetPhoneResultDto,
  deriveContactsVerification,
  isE164,
  maskPhone,
  phoneErrorMessageKey,
  phoneIssueMessageKey,
  phoneStatusLabelKey,
  type PhoneErrorCode,
  type PhoneIssueCode,
} from './phone';

const seedMigration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0011_phone_verification.sql', import.meta.url)), 'utf8');
const seededKeys = new Set([...seedMigration.matchAll(/'((?:sms|account)\.[a-z0-9_.]+)'/g)].map((m) => m[1] as string));

// ---------------------------------------------------------------- zod shape walker
type Entry = { path: string; key: string; type: string };
const defOf = (schema: unknown): { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown } =>
  (schema as { def: { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown } }).def;
function walk(schema: unknown, prefix = ''): Entry[] {
  const def = defOf(schema);
  if (def.type === 'object' && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const inner = unwrap(child);
      return [{ path, key, type: defOf(inner).type }, ...walk(inner, path)];
    });
  }
  if (def.type === 'array' && def.element) return walk(def.element, `${prefix}[]`);
  return [];
}
function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  if ((def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) return unwrap(def.innerType);
  return schema;
}
const keysOf = (schema: unknown): string[] => walk(schema).map((e) => e.key);
const FORBIDDEN_KEYS = ['number', 'e164', 'code', 'hash', 'codehash', 'secret', 'token', 'rawphone', 'phonenumber', 'digits', 'otp', 'verificationcode'];
// keys that contain "phone" and are allowed: identifiers, the masked form, the status, and the `phone` summary OBJECT of a result
const ALLOWED_PHONE_KEYS = new Set([
  'maskedPhone',
  'phoneVerificationStatus',
  'phoneContactId',
  'replacedPhoneContactId',
  'replacesPhoneContactId',
  'phoneVerified',
]);
function assertNoSecretKeys(schema: unknown): void {
  for (const e of walk(schema)) {
    expect(FORBIDDEN_KEYS, e.path).not.toContain(e.key.toLowerCase());
    if (/phone/i.test(e.key) && !ALLOWED_PHONE_KEYS.has(e.key)) {
      // the only other allowed key is `phone`, and only as an OBJECT (the masked summary), never as a string
      expect(e.key, e.path).toBe('phone');
      expect(e.type, e.path).toBe('object');
    }
  }
}

// ====================================================================== maskPhone
describe('maskPhone', () => {
  it.each([
    ['+12025550142', '+*******0142'],
    ['+442071838750', '+********8750'],
    ['+4915112345678', '+*********5678'],
    ['+919876543210', '+********3210'],
    ['+61412345678', '+*******5678'],
    ['+123456789', '+*****6789'],
    ['+123456789012345', '+***********2345'],
  ])('masks %s as %s', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });
  it('shows the last four digits of a nine-digit number', () => {
    expect(maskPhone('+123456789')).toBe('+*****6789');
  });
  it('shows only the last two digits of a very short number (eight digits or fewer)', () => {
    expect(maskPhone('+12345678')).toBe('+******78');
    expect(maskPhone('+1234567')).toBe('+*****67');
  });
  it('keeps the length of the number visible: one star per hidden digit', () => {
    for (const digits of ['1234567', '12345678', '123456789', '1234567890', '123456789012345']) {
      const masked = maskPhone(`+${digits}`);
      expect(masked.length).toBe(digits.length + 1);
      expect(masked.startsWith('+')).toBe(true);
    }
  });
  it.each([
    '2025550142',
    '+0123456789',
    '+1 202 555 0142',
    '+1-202-555-0142',
    '(202) 555-0142',
    '+123456',
    '+1234567890123456',
    '',
    '+',
    'abc',
    '+1202555014a',
    ' +12025550142',
    '+12025550142 ',
    '+12025550142\n',
    '+１２０２５５５０１４２',
    '12025550142',
    '++12025550142',
  ])('masks non-E.164 input %j entirely', (input) => {
    expect(maskPhone(input)).toBe('***');
  });
  it('never shows more than the last four digits for any length from 7 to 15 digits', () => {
    for (let n = 7; n <= 15; n += 1) {
      const digits = '9'.repeat(n);
      const masked = maskPhone(`+${digits}`);
      expect((masked.match(/[0-9]/g) ?? []).length).toBeLessThanOrEqual(4);
      expect(masked).not.toContain('99999');
    }
  });
  it('never reveals a digit other than the trailing ones (distinct digits)', () => {
    const e164 = '+14155238886';
    const masked = maskPhone(e164);
    expect(masked).toBe('+*******8886');
    expect(masked).not.toContain('4155');
    expect(masked).not.toContain('1415');
    expect(masked).not.toContain(e164);
    expect(masked).not.toContain(e164.slice(1));
  });
  it('is deterministic and idempotent-safe: masking a masked value yields the fully masked form', () => {
    expect(maskPhone('+12025550142')).toBe(maskPhone('+12025550142'));
    expect(maskPhone(maskPhone('+12025550142'))).toBe('***');
  });
  it('has the documented example', () => {
    expect(maskPhone('+12025550142')).toBe('+*******0142');
  });
});

// ====================================================================== E.164
describe('E164_PATTERN and isE164', () => {
  it.each(['+1234567', '+12345678', '+12025550142', '+123456789012345', '+442071838750', '+919876543210'])('accepts %s', (v) => {
    expect(E164_PATTERN.test(v)).toBe(true);
    expect(isE164(v)).toBe(true);
  });
  it('accepts exactly 7 and exactly 15 digits', () => {
    expect(isE164(`+1${'0'.repeat(6)}`)).toBe(true);
    expect(isE164(`+1${'0'.repeat(14)}`)).toBe(true);
  });
  it('refuses 6 digits and 16 digits', () => {
    expect(isE164('+123456')).toBe(false);
    expect(isE164(`+1${'0'.repeat(15)}`)).toBe(false);
  });
  it.each([
    ['a leading zero after the plus', '+0123456789'],
    ['no plus', '12025550142'],
    ['a space inside', '+1 2025550142'],
    ['a leading space', ' +12025550142'],
    ['a trailing space', '+12025550142 '],
    ['a dash', '+1-2025550142'],
    ['parentheses', '+1(202)5550142'],
    ['a dot', '+1.2025550142'],
    ['a letter', '+1202555014a'],
    ['a trailing newline', '+12025550142\n'],
    ['two plus signs', '++12025550142'],
    ['a plus in the middle', '+1202+5550142'],
    ['an empty string', ''],
    ['only a plus', '+'],
    ['fullwidth digits', '+１２０２５５５０１４２'],
    ['an extension', '+12025550142x12'],
    ['a minus sign', '-12025550142'],
  ])('refuses %s', (_label, v) => {
    expect(isE164(v)).toBe(false);
  });
  it.each([undefined, null, 12025550142, true, {}, [], ['+12025550142'], Symbol.for('x'), 12n])('isE164 refuses the non-string %s', (v) => {
    expect(isE164(v)).toBe(false);
  });
  it('is anchored: embedded numbers do not match', () => {
    expect(E164_PATTERN.test('abc+12025550142')).toBe(false);
    expect(E164_PATTERN.test('+12025550142abc')).toBe(false);
    expect(E164_PATTERN.test('+12025550142\n+12025550143')).toBe(false);
  });
  it('is a type guard that does not mutate its input', () => {
    const v: unknown = '+12025550142';
    if (isE164(v)) expect(v.startsWith('+')).toBe(true);
    else throw new Error('expected E.164');
  });
});

// ====================================================================== vocabularies
describe('vocabularies', () => {
  it('lists the contact statuses, with the open ones a subset', () => {
    expect([...PHONE_CONTACT_STATUSES]).toEqual(['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED']);
    expect([...PHONE_OPEN_STATUSES]).toEqual(['PENDING', 'REPLACEMENT_PENDING']);
    for (const s of PHONE_OPEN_STATUSES) expect(PHONE_CONTACT_STATUSES).toContain(s);
  });
  it('lists the sources (USER_ENTERED only), purposes, delivery statuses, invalidation and disabled reasons', () => {
    expect([...PHONE_SOURCES]).toEqual(['USER_ENTERED']);
    expect([...PHONE_PURPOSES]).toEqual(['INITIAL_PHONE', 'CHANGE_PHONE']);
    expect([...PHONE_DELIVERY_STATUSES]).toEqual(['PENDING', 'SENT', 'FAILED']);
    expect([...PHONE_INVALIDATION_REASONS]).toEqual(['SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED']);
    expect([...PHONE_DISABLED_REASONS]).toEqual(['REPLACED', 'SUPERSEDED']);
  });
  it('lists the issue codes', () => {
    expect([...PHONE_ISSUE_CODES]).toEqual(['REQUIRED', 'TOO_LONG', 'INVALID_CHARACTERS', 'INVALID_NUMBER', 'COUNTRY_REQUIRED', 'COUNTRY_NOT_SUPPORTED']);
  });
  it('limits the raw phone input to 64 characters', () => {
    expect(PHONE_INPUT_MAX_LENGTH).toBe(64);
  });
  it.each([...PHONE_CONTACT_STATUSES])('PhoneContactStatus accepts %s', (v) => {
    expect(PhoneContactStatus.parse(v)).toBe(v);
  });
  it.each(['pending', 'ACTIVE', '', null, 1])('PhoneContactStatus refuses %j', (v) => {
    expect(PhoneContactStatus.safeParse(v).success).toBe(false);
  });
  it.each([...PHONE_OPEN_STATUSES])('PhoneOpenStatus accepts %s', (v) => {
    expect(PhoneOpenStatus.parse(v)).toBe(v);
  });
  it.each(['VERIFIED', 'DISABLED'])('PhoneOpenStatus refuses %s', (v) => {
    expect(PhoneOpenStatus.safeParse(v).success).toBe(false);
  });
  it.each([...PHONE_PURPOSES])('PhonePurpose accepts %s', (v) => {
    expect(PhonePurpose.parse(v)).toBe(v);
  });
  it.each(['INITIAL_EMAIL', 'CHANGE_EMAIL', 'LOGIN'])('PhonePurpose refuses %s', (v) => {
    expect(PhonePurpose.safeParse(v).success).toBe(false);
  });
  it('PhoneSource accepts only USER_ENTERED (no IDP_VERIFIED: an identity provider never proves a phone)', () => {
    expect(PhoneSource.parse('USER_ENTERED')).toBe('USER_ENTERED');
    expect(PhoneSource.safeParse('IDP_VERIFIED').success).toBe(false);
  });
  it('PhoneVerificationStatus is the email account-level vocabulary: NONE, PENDING, VERIFIED', () => {
    expect([...PHONE_CONTACT_STATUSES].length).toBe(4);
    expect(PhoneVerificationStatus).toBe(EmailVerificationStatus);
    for (const s of EMAIL_VERIFICATION_STATUSES) expect(PhoneVerificationStatus.parse(s)).toBe(s);
    expect(PhoneVerificationStatus.safeParse('REPLACEMENT_PENDING').success).toBe(false);
  });
});

describe('line types', () => {
  it('lists the line types', () => {
    expect([...PHONE_LINE_TYPES]).toEqual(['MOBILE', 'LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK']);
  });
  it('lists the blockable line types: every line type except MOBILE', () => {
    expect([...PHONE_BLOCKABLE_LINE_TYPES]).toEqual(['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK']);
    expect(PHONE_BLOCKABLE_LINE_TYPES).not.toContain('MOBILE');
    expect([...PHONE_LINE_TYPES].filter((t) => !(PHONE_BLOCKABLE_LINE_TYPES as readonly string[]).includes(t))).toEqual(['MOBILE']);
  });
  it.each([...PHONE_LINE_TYPES])('PhoneLineType accepts %s', (v) => {
    expect(PhoneLineType.parse(v)).toBe(v);
  });
  it.each([...PHONE_BLOCKABLE_LINE_TYPES])('PhoneBlockableLineType accepts %s', (v) => {
    expect(PhoneBlockableLineType.parse(v)).toBe(v);
  });
  it('PhoneBlockableLineType refuses MOBILE and unknown values', () => {
    expect(PhoneBlockableLineType.safeParse('MOBILE').success).toBe(false);
    expect(PhoneBlockableLineType.safeParse('PAGER').success).toBe(false);
    expect(PhoneBlockableLineType.safeParse('mobile').success).toBe(false);
  });
  it('PhoneLineType refuses lower case and other values', () => {
    expect(PhoneLineType.safeParse('mobile').success).toBe(false);
    expect(PhoneLineType.safeParse('PAGER').success).toBe(false);
  });
});

// ====================================================================== message keys
describe('message keys', () => {
  it('has a seeded key set to compare against', () => {
    expect(seededKeys.size).toBeGreaterThanOrEqual(33);
    expect(seededKeys.has('sms.verification.phone.body')).toBe(true);
  });
  it.each([...EMAIL_VERIFICATION_STATUSES])('phoneStatusLabelKey(%s) is a seeded content key', (status) => {
    const key = phoneStatusLabelKey(status);
    expect(key).toBe(`account.phone.status.${status.toLowerCase()}`);
    expect(seededKeys.has(key), key).toBe(true);
  });
  it.each([...PHONE_ISSUE_CODES])('phoneIssueMessageKey(%s) is a seeded content key', (code) => {
    const key = phoneIssueMessageKey(code);
    expect(key).toBe(`account.phone.error.${code.toLowerCase()}`);
    expect(seededKeys.has(key), key).toBe(true);
  });
  it.each(PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID'))('phoneErrorMessageKey(%s) is a seeded content key', (code) => {
    const key = phoneErrorMessageKey(code as Exclude<PhoneErrorCode, 'PHONE_INVALID'>);
    expect(key).toBe(`account.phone.error.${code.replace(/^PHONE_/, '').toLowerCase()}`);
    expect(seededKeys.has(key), key).toBe(true);
    expect(key).not.toContain('phone_');
  });
  it('produces distinct keys: no two issue codes, error codes or statuses share a key', () => {
    const keys = [
      ...EMAIL_VERIFICATION_STATUSES.map(phoneStatusLabelKey),
      ...PHONE_ISSUE_CODES.map(phoneIssueMessageKey),
      ...PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID').map((c) => phoneErrorMessageKey(c as Exclude<PhoneErrorCode, 'PHONE_INVALID'>)),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('every seeded account.phone.error.* key is produced by one of the helpers (no orphan copy)', () => {
    const produced = new Set([
      ...PHONE_ISSUE_CODES.map(phoneIssueMessageKey),
      ...PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID').map((c) => phoneErrorMessageKey(c as Exclude<PhoneErrorCode, 'PHONE_INVALID'>)),
    ]);
    const seededErrors = [...seededKeys].filter((k) => k.startsWith('account.phone.error.'));
    expect(seededErrors.sort()).toEqual([...produced].sort());
  });
  it('every produced key is a lower-case dotted content key', () => {
    const issue: PhoneIssueCode = 'COUNTRY_NOT_SUPPORTED';
    expect(phoneIssueMessageKey(issue)).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
  it('the SMS body key is seeded with the sensitive code variable', () => {
    expect(seedMigration).toContain("'sms.verification.phone.body'");
    expect(seedMigration).toMatch(/verification_code/);
    expect(seedMigration).toMatch(/SENSITIVE_PERSONAL/);
    expect(seedMigration).toMatch(/expiry_minutes/);
  });
});

// ====================================================================== requests
describe('SetPhoneRequest', () => {
  it('accepts a phone alone', () => {
    expect(SetPhoneRequest.parse({ phone: '+12025550142' })).toEqual({ phone: '+12025550142' });
  });
  it('accepts a phone with a country', () => {
    expect(SetPhoneRequest.parse({ phone: '(202) 555-0142', country: 'US' })).toEqual({ phone: '(202) 555-0142', country: 'US' });
  });
  it('keeps exactly the documented shape', () => {
    expect(Object.keys(SetPhoneRequest.shape).sort()).toEqual(['country', 'phone']);
  });
  it('refuses an unknown field (strict)', () => {
    expect(SetPhoneRequest.safeParse({ phone: '+12025550142', extra: 1 }).success).toBe(false);
    expect(SetPhoneRequest.safeParse({ phone: '+12025550142', accountId: 'x' }).success).toBe(false);
    expect(SetPhoneRequest.safeParse({ phone: '+12025550142', e164: '+12025550142' }).success).toBe(false);
  });
  it.each([
    ['a number', 12025550142],
    ['a boolean', true],
    ['null', null],
    ['an array', ['+12025550142']],
    ['an object', { value: '+12025550142' }],
    ['undefined', undefined],
  ])('refuses %s as the phone (nothing is coerced)', (_label, phone) => {
    expect(SetPhoneRequest.safeParse({ phone }).success).toBe(false);
  });
  it('refuses a missing phone', () => {
    expect(SetPhoneRequest.safeParse({}).success).toBe(false);
    expect(SetPhoneRequest.safeParse({ country: 'US' }).success).toBe(false);
  });
  it('accepts a 64 character phone and refuses a 65 character one', () => {
    expect(SetPhoneRequest.safeParse({ phone: '1'.repeat(64) }).success).toBe(true);
    expect(SetPhoneRequest.safeParse({ phone: '1'.repeat(65) }).success).toBe(false);
  });
  it('lets an empty phone through the shape (the canonicalizer reports REQUIRED)', () => {
    expect(SetPhoneRequest.safeParse({ phone: '' }).success).toBe(true);
  });
  it.each(['US', 'CA', 'GB', 'DE', 'ZZ'])('accepts the country %s', (country) => {
    expect(SetPhoneRequest.safeParse({ phone: '1', country }).success).toBe(true);
  });
  it.each(['us', 'Us', 'USA', 'U', '', ' US', 'US ', 'U1', '12', 'U-', 'US\n'])('refuses the country %j', (country) => {
    expect(SetPhoneRequest.safeParse({ phone: '1', country }).success).toBe(false);
  });
  it.each([null, 1, true, ['US']])('refuses the non-string country %j', (country) => {
    expect(SetPhoneRequest.safeParse({ phone: '1', country }).success).toBe(false);
  });
  it('allows the country to be omitted or undefined', () => {
    expect(SetPhoneRequest.safeParse({ phone: '1', country: undefined }).success).toBe(true);
  });
  it('refuses non-object bodies', () => {
    for (const body of [null, undefined, 'x', 1, [], [{ phone: '1' }]]) expect(SetPhoneRequest.safeParse(body).success).toBe(false);
  });
});

describe('SendPhoneVerificationRequest', () => {
  it('accepts an empty object only', () => {
    expect(SendPhoneVerificationRequest.parse({})).toEqual({});
  });
  it('refuses any field', () => {
    expect(SendPhoneVerificationRequest.safeParse({ phone: '+12025550142' }).success).toBe(false);
    expect(SendPhoneVerificationRequest.safeParse({ resend: true }).success).toBe(false);
  });
  it('refuses non-object bodies', () => {
    for (const body of [null, undefined, 'x', 1, [], true]) expect(SendPhoneVerificationRequest.safeParse(body).success).toBe(false);
  });
});

describe('ConfirmPhoneCodeRequest', () => {
  it('shares the email code shape: four to ten digits', () => {
    expect(PHONE_CODE_SHAPE.source).toBe('^[0-9]{4,10}$');
  });
  it.each(['1234', '123456', '0000', '000000', '1234567890'])('accepts the code %s', (code) => {
    expect(ConfirmPhoneCodeRequest.parse({ code })).toEqual({ code });
  });
  it.each(['123', '12345678901', '', ' 123456', '123456 ', '12 3456', '12-3456', 'abcdef', '12345a', '１２３４５６', '123456\n', '+123456', '1.23456'])(
    'refuses the code %j',
    (code) => {
      expect(ConfirmPhoneCodeRequest.safeParse({ code }).success).toBe(false);
    },
  );
  it.each([123456, 0, true, null, undefined, ['123456'], { code: '123456' }])('refuses the non-string code %j (no coercion)', (code) => {
    expect(ConfirmPhoneCodeRequest.safeParse({ code }).success).toBe(false);
  });
  it('refuses a missing code and unknown fields', () => {
    expect(ConfirmPhoneCodeRequest.safeParse({}).success).toBe(false);
    expect(ConfirmPhoneCodeRequest.safeParse({ code: '123456', phone: '+12025550142' }).success).toBe(false);
    expect(ConfirmPhoneCodeRequest.safeParse({ code: '123456', extra: 1 }).success).toBe(false);
  });
  it('keeps exactly the documented shape', () => {
    expect(Object.keys(ConfirmPhoneCodeRequest.shape)).toEqual(['code']);
  });
});

// ====================================================================== read models
const primary = { maskedPhone: '+*******0142', countryCode: 'US', verifiedAt: '2026-01-02T00:00:00.000Z', source: 'USER_ENTERED' };
const pending = {
  maskedPhone: '+*******0142',
  countryCode: 'US',
  purpose: 'INITIAL_PHONE',
  status: 'PENDING',
  lastSentAt: '2026-01-02T00:00:00.000Z',
  expiresAt: '2026-01-02T00:10:00.000Z',
};
const noneSummary = { phoneVerificationStatus: 'NONE', primary: null, pending: null };
const pendingSummary = { phoneVerificationStatus: 'PENDING', primary: null, pending };
const verifiedSummary = { phoneVerificationStatus: 'VERIFIED', primary, pending: null };
const replacingSummary = { phoneVerificationStatus: 'VERIFIED', primary, pending: { ...pending, purpose: 'CHANGE_PHONE', status: 'REPLACEMENT_PENDING' } };
const detail = { ...pendingSummary, resendAvailableAt: null, attemptsRemaining: 5, codeLength: 6, validityMinutes: 10 };
const meta = { correlationId: 'c-1' };

describe('PrimaryPhoneDto and PendingPhoneDto', () => {
  it('parses a valid primary and pending number', () => {
    expect(PrimaryPhoneDto.parse(primary)).toEqual(primary);
    expect(PendingPhoneDto.parse(pending)).toEqual(pending);
  });
  it('accepts null lastSentAt and expiresAt', () => {
    expect(PendingPhoneDto.parse({ ...pending, lastSentAt: null, expiresAt: null }).lastSentAt).toBeNull();
  });
  it('refuses a primary with a missing or foreign source', () => {
    const { source: _s, ...noSource } = primary;
    expect(PrimaryPhoneDto.safeParse(noSource).success).toBe(false);
    expect(PrimaryPhoneDto.safeParse({ ...primary, source: 'IDP_VERIFIED' }).success).toBe(false);
  });
  it.each([
    ['an unknown purpose', { purpose: 'INITIAL_EMAIL' }],
    ['a VERIFIED status (a pending number is open)', { status: 'VERIFIED' }],
    ['a DISABLED status', { status: 'DISABLED' }],
    ['a missing lastSentAt', { lastSentAt: undefined }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['a numeric masked phone', { maskedPhone: 12025550142 }],
  ])('refuses a pending number with %s', (_label, over) => {
    expect(PendingPhoneDto.safeParse({ ...pending, ...over }).success).toBe(false);
  });
  it('strips unknown fields so a full number cannot ride along', () => {
    const parsed = PrimaryPhoneDto.parse({ ...primary, phone: '+12025550142', e164: '+12025550142' });
    expect(parsed).toEqual(primary);
    expect(JSON.stringify(parsed)).not.toContain('2025550142');
  });
  it('keeps exactly the documented keys', () => {
    expect(Object.keys(PrimaryPhoneDto.shape).sort()).toEqual(['countryCode', 'maskedPhone', 'source', 'verifiedAt']);
    expect(Object.keys(PendingPhoneDto.shape).sort()).toEqual(['countryCode', 'expiresAt', 'lastSentAt', 'maskedPhone', 'purpose', 'status']);
  });
});

describe('AccountPhoneSummaryDto', () => {
  it.each([
    ['none', noneSummary],
    ['pending', pendingSummary],
    ['verified', verifiedSummary],
    ['verified with a replacement pending', replacingSummary],
  ])('parses %s unchanged', (_label, summary) => {
    expect(AccountPhoneSummaryDto.parse(summary)).toEqual(summary);
  });
  it.each([
    ['an unknown status', { phoneVerificationStatus: 'CONFIRMED' }],
    ['REPLACEMENT_PENDING as the account status', { phoneVerificationStatus: 'REPLACEMENT_PENDING' }],
    ['a missing primary', { primary: undefined }],
    ['a missing pending', { pending: undefined }],
    ['a string primary', { primary: '+12025550142' }],
  ])('refuses a summary with %s', (_label, over) => {
    expect(AccountPhoneSummaryDto.safeParse({ ...noneSummary, ...over }).success).toBe(false);
  });
  it('keeps exactly status, primary and pending', () => {
    expect(Object.keys(AccountPhoneSummaryDto.shape).sort()).toEqual(['pending', 'phoneVerificationStatus', 'primary']);
  });
});

describe('AccountPhoneDetailDto and AccountPhoneResponse', () => {
  it('parses a detail and extends the summary', () => {
    expect(AccountPhoneDetailDto.parse(detail)).toEqual(detail);
    expect(Object.keys(AccountPhoneDetailDto.shape).sort()).toEqual([
      'attemptsRemaining',
      'codeLength',
      'pending',
      'phoneVerificationStatus',
      'primary',
      'resendAvailableAt',
      'validityMinutes',
    ]);
  });
  it('accepts null attemptsRemaining and a resendAvailableAt time', () => {
    expect(AccountPhoneDetailDto.safeParse({ ...detail, attemptsRemaining: null, resendAvailableAt: '2026-01-02T00:00:30.000Z' }).success).toBe(true);
  });
  it.each([
    ['a fractional attemptsRemaining', { attemptsRemaining: 1.5 }],
    ['a string codeLength', { codeLength: '6' }],
    ['a fractional validityMinutes', { validityMinutes: 10.5 }],
    ['a missing codeLength', { codeLength: undefined }],
    ['a missing resendAvailableAt', { resendAvailableAt: undefined }],
  ])('refuses a detail with %s', (_label, over) => {
    expect(AccountPhoneDetailDto.safeParse({ ...detail, ...over }).success).toBe(false);
  });
  it('wraps the detail in the data and meta envelope', () => {
    expect(AccountPhoneResponse.parse({ data: detail, meta })).toEqual({ data: detail, meta });
    expect(AccountPhoneResponse.safeParse({ data: detail }).success).toBe(false);
  });
});

describe('result DTOs', () => {
  const sent = {
    sentAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2026-01-02T00:10:00.000Z',
    resendAvailableAt: '2026-01-02T00:00:30.000Z',
    codeLength: 6,
    validityMinutes: 10,
    phone: pendingSummary,
  };
  it('PhoneVerificationSentDto parses and carries the masked summary', () => {
    expect(PhoneVerificationSentDto.parse(sent)).toEqual(sent);
    expect(PhoneVerificationSentResponse.parse({ data: sent, meta }).data).toEqual(sent);
    expect(Object.keys(PhoneVerificationSentDto.shape).sort()).toEqual(['codeLength', 'expiresAt', 'phone', 'resendAvailableAt', 'sentAt', 'validityMinutes']);
  });
  it.each([
    ['a missing sentAt', { sentAt: undefined }],
    ['a missing phone summary', { phone: undefined }],
    ['a string phone', { phone: '+12025550142' }],
    ['a fractional codeLength', { codeLength: 6.5 }],
  ])('PhoneVerificationSentDto refuses %s', (_label, over) => {
    expect(PhoneVerificationSentDto.safeParse({ ...sent, ...over }).success).toBe(false);
  });
  it.each([
    ['SetPhoneResultDto', SetPhoneResultDto, SetPhoneResponse],
    ['PhoneVerifiedDto', PhoneVerifiedDto, PhoneVerifiedResponse],
  ] as const)('%s parses changed true and false with a summary', (_name, dto, response) => {
    for (const changed of [true, false]) {
      const value = { changed, phone: verifiedSummary };
      expect(dto.parse(value)).toEqual(value);
      expect(response.parse({ data: value, meta }).data).toEqual(value);
    }
  });
  it.each([
    ['SetPhoneResultDto', SetPhoneResultDto],
    ['PhoneVerifiedDto', PhoneVerifiedDto],
  ] as const)('%s refuses a non-boolean changed and a missing summary', (_name, dto) => {
    expect(dto.safeParse({ changed: 'yes', phone: noneSummary }).success).toBe(false);
    expect(dto.safeParse({ changed: 1, phone: noneSummary }).success).toBe(false);
    expect(dto.safeParse({ phone: noneSummary }).success).toBe(false);
    expect(dto.safeParse({ changed: true }).success).toBe(false);
  });
  it('strips a full number smuggled into a result', () => {
    const parsed = SetPhoneResultDto.parse({ changed: true, phone: verifiedSummary, number: '+12025550142', e164: '+12025550142' });
    expect(JSON.stringify(parsed)).not.toContain('2025550142');
    expect(Object.keys(parsed).sort()).toEqual(['changed', 'phone']);
  });
});

describe('no read model or payload can carry a full number, a code or a hash', () => {
  const schemas: Array<[string, unknown]> = [
    ['PrimaryPhoneDto', PrimaryPhoneDto],
    ['PendingPhoneDto', PendingPhoneDto],
    ['AccountPhoneSummaryDto', AccountPhoneSummaryDto],
    ['AccountPhoneDetailDto', AccountPhoneDetailDto],
    ['AccountPhoneResponse', AccountPhoneResponse],
    ['PhoneVerificationSentDto', PhoneVerificationSentDto],
    ['PhoneVerificationSentResponse', PhoneVerificationSentResponse],
    ['SetPhoneResultDto', SetPhoneResultDto],
    ['SetPhoneResponse', SetPhoneResponse],
    ['PhoneVerifiedDto', PhoneVerifiedDto],
    ['PhoneVerifiedResponse', PhoneVerifiedResponse],
    ['ContactsVerificationDto', ContactsVerificationDto],
    ['PhoneContactAddedPayload', PhoneContactAddedPayload],
    ['PhoneVerificationSentPayload', PhoneVerificationSentPayload],
    ['PhoneVerifiedPayload', PhoneVerifiedPayload],
    ['PhoneVerificationFailedPayload', PhoneVerificationFailedPayload],
    ['PhoneChangeRequestedPayload', PhoneChangeRequestedPayload],
  ];
  it.each(schemas)('%s has no key that can hold a number, a code, a token or a hash', (_name, schema) => {
    assertNoSecretKeys(schema);
  });
  it('the walker finds nested keys (sanity check of the test itself)', () => {
    expect(keysOf(AccountPhoneDetailDto)).toEqual(expect.arrayContaining(['maskedPhone', 'verifiedAt', 'purpose', 'codeLength']));
    expect(keysOf(PhoneVerificationSentDto)).toEqual(expect.arrayContaining(['phone', 'phoneVerificationStatus', 'maskedPhone']));
    expect(walk(PhoneVerificationSentDto).find((e) => e.key === 'phone')?.type).toBe('object');
  });
  it('the walker would flag a forbidden key', () => {
    const bad = z.object({ inner: z.object({ code: z.string() }) });
    expect(() => assertNoSecretKeys(bad)).toThrow();
    const badPhone = z.object({ phone: z.string() });
    expect(() => assertNoSecretKeys(badPhone)).toThrow();
  });
  it('the only string fields that hold a number are the masked ones', () => {
    const stringKeys = new Set(
      schemas.flatMap(([, s]) =>
        walk(s)
          .filter((e) => e.type === 'string')
          .map((e) => e.key),
      ),
    );
    for (const key of stringKeys) {
      if (/phone/i.test(key)) expect(key).toMatch(/^(maskedPhone|phoneContactId|replacedPhoneContactId|replacesPhoneContactId)$/);
    }
    expect(stringKeys.has('maskedPhone')).toBe(true);
  });
});

// ====================================================================== events
describe('PHONE_EVENTS', () => {
  const names = Object.values(PHONE_EVENTS);
  it('lists the five events', () => {
    expect(Object.keys(PHONE_EVENTS).sort()).toEqual(['changeRequested', 'contactAdded', 'verificationFailed', 'verificationSent', 'verified']);
  });
  it.each(names)('%s matches the event type pattern', (name) => {
    expect(name).toMatch(EVENT_TYPE_PATTERN);
    expect(name.startsWith('bananagig.identity.phone-')).toBe(true);
    expect(name.endsWith('.v1')).toBe(true);
  });
  it('has unique names', () => {
    expect(new Set(names).size).toBe(names.length);
  });
  it('names the documented events', () => {
    expect(PHONE_EVENTS.contactAdded).toBe('bananagig.identity.phone-contact-added.v1');
    expect(PHONE_EVENTS.verificationSent).toBe('bananagig.identity.phone-verification-sent.v1');
    expect(PHONE_EVENTS.verified).toBe('bananagig.identity.phone-verified.v1');
    expect(PHONE_EVENTS.verificationFailed).toBe('bananagig.identity.phone-verification-failed.v1');
    expect(PHONE_EVENTS.changeRequested).toBe('bananagig.identity.phone-change-requested.v1');
  });
});

describe('phone event payloads', () => {
  const id = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
  const valid = {
    added: { accountId: id, phoneContactId: id, purpose: 'INITIAL_PHONE', source: 'USER_ENTERED', status: 'PENDING' },
    sent: { accountId: id, phoneContactId: id, challengeId: id, purpose: 'CHANGE_PHONE', expiresAt: '2026-01-02T00:10:00.000Z' },
    verified: { accountId: id, phoneContactId: id, purpose: 'CHANGE_PHONE', replacedPhoneContactId: id },
    failed: { accountId: id, phoneContactId: id, challengeId: id, attemptCount: 3, locked: false },
    change: { accountId: id, phoneContactId: id, replacesPhoneContactId: id },
  };
  it('accept valid payloads', () => {
    expect(PhoneContactAddedPayload.parse(valid.added)).toEqual(valid.added);
    expect(PhoneVerificationSentPayload.parse(valid.sent)).toEqual(valid.sent);
    expect(PhoneVerifiedPayload.parse(valid.verified)).toEqual(valid.verified);
    expect(PhoneVerificationFailedPayload.parse(valid.failed)).toEqual(valid.failed);
    expect(PhoneChangeRequestedPayload.parse(valid.change)).toEqual(valid.change);
  });
  it('PhoneVerifiedPayload accepts a null replacedPhoneContactId (the first verified number)', () => {
    expect(PhoneVerifiedPayload.parse({ ...valid.verified, purpose: 'INITIAL_PHONE', replacedPhoneContactId: null }).replacedPhoneContactId).toBeNull();
  });
  it('PhoneVerificationFailedPayload accepts a locked attempt', () => {
    expect(PhoneVerificationFailedPayload.parse({ ...valid.failed, attemptCount: 5, locked: true }).locked).toBe(true);
  });
  it.each([
    ['PhoneContactAddedPayload', PhoneContactAddedPayload, valid.added],
    ['PhoneVerificationSentPayload', PhoneVerificationSentPayload, valid.sent],
    ['PhoneVerifiedPayload', PhoneVerifiedPayload, valid.verified],
    ['PhoneVerificationFailedPayload', PhoneVerificationFailedPayload, valid.failed],
    ['PhoneChangeRequestedPayload', PhoneChangeRequestedPayload, valid.change],
  ] as const)('%s refuses a payload with a missing field', (_name, schema, payload) => {
    for (const key of Object.keys(payload)) {
      const copy: Record<string, unknown> = { ...payload };
      delete copy[key];
      expect(schema.safeParse(copy).success, key).toBe(false);
    }
  });
  it.each([
    ['PhoneContactAddedPayload', PhoneContactAddedPayload, valid.added],
    ['PhoneVerificationSentPayload', PhoneVerificationSentPayload, valid.sent],
    ['PhoneVerifiedPayload', PhoneVerifiedPayload, valid.verified],
    ['PhoneVerificationFailedPayload', PhoneVerificationFailedPayload, valid.failed],
    ['PhoneChangeRequestedPayload', PhoneChangeRequestedPayload, valid.change],
  ] as const)('%s never carries a phone, number, code or hash key and strips them if sent', (_name, schema, payload) => {
    const keys = Object.keys(schema.shape).map((k) => k.toLowerCase());
    for (const word of ['phone', 'number', 'code', 'hash', 'e164', 'token', 'secret']) {
      expect(
        keys.filter((k) => k === word),
        word,
      ).toEqual([]);
    }
    const parsed = schema.parse({ ...payload, phone: '+12025550142', number: '+12025550142', code: '123456', hash: 'abc', codeHash: 'abc' });
    expect(JSON.stringify(parsed)).not.toContain('2025550142');
    expect(JSON.stringify(parsed)).not.toContain('123456');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(payload).sort());
  });
  it('refuses wrong value types', () => {
    expect(PhoneContactAddedPayload.safeParse({ ...valid.added, status: 'ACTIVE' }).success).toBe(false);
    expect(PhoneContactAddedPayload.safeParse({ ...valid.added, source: 'IDP_VERIFIED' }).success).toBe(false);
    expect(PhoneContactAddedPayload.safeParse({ ...valid.added, purpose: 'INITIAL_EMAIL' }).success).toBe(false);
    expect(PhoneVerificationFailedPayload.safeParse({ ...valid.failed, attemptCount: 1.5 }).success).toBe(false);
    expect(PhoneVerificationFailedPayload.safeParse({ ...valid.failed, locked: 'no' }).success).toBe(false);
    expect(PhoneVerifiedPayload.safeParse({ ...valid.verified, replacedPhoneContactId: undefined }).success).toBe(false);
  });
  it('uses identifier-typed fields only (strings, one integer, one boolean, enums)', () => {
    const types = new Set(
      [PhoneContactAddedPayload, PhoneVerificationSentPayload, PhoneVerifiedPayload, PhoneVerificationFailedPayload, PhoneChangeRequestedPayload].flatMap((s) =>
        walk(s).map((e) => e.type),
      ),
    );
    expect([...types].sort()).toEqual(['boolean', 'enum', 'number', 'string']);
  });
});

// ====================================================================== PHONE_ERROR_CODES
describe('PHONE_ERROR_CODES', () => {
  it('lists the 13 codes in order', () => {
    expect([...PHONE_ERROR_CODES]).toEqual([
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
    ]);
  });
  it('has unique codes that all start with PHONE_ and are usable as ACCOUNT_<code>', () => {
    expect(new Set(PHONE_ERROR_CODES).size).toBe(PHONE_ERROR_CODES.length);
    for (const c of PHONE_ERROR_CODES) {
      expect(c).toMatch(/^PHONE_[A-Z][A-Z_]*$/);
      expect(`ACCOUNT_${c}`).toMatch(/^ACCOUNT_[A-Z][A-Z_]*$/);
    }
  });
});

// ====================================================================== deriveContactsVerification
describe('deriveContactsVerification', () => {
  const statuses = ['NONE', 'PENDING', 'VERIFIED'] as const;
  const table = statuses.flatMap((email) => statuses.map((phone) => [email, phone] as const));
  it('covers all nine pairs', () => {
    expect(table).toHaveLength(9);
  });
  it.each(table)('email %s and phone %s', (email, phone) => {
    const emailVerified = email === 'VERIFIED';
    const phoneVerified = phone === 'VERIFIED';
    expect(deriveContactsVerification(email, phone)).toEqual({ emailVerified, phoneVerified, contactsVerified: emailVerified && phoneVerified });
  });
  it('is contactsVerified only when both are VERIFIED', () => {
    const verifiedPairs = table.filter(([e, p]) => deriveContactsVerification(e, p).contactsVerified);
    expect(verifiedPairs).toEqual([['VERIFIED', 'VERIFIED']]);
  });
  it('never counts PENDING as verified', () => {
    for (const other of statuses) {
      expect(deriveContactsVerification('PENDING', other).emailVerified).toBe(false);
      expect(deriveContactsVerification(other, 'PENDING').phoneVerified).toBe(false);
      expect(deriveContactsVerification('PENDING', other).contactsVerified).toBe(false);
      expect(deriveContactsVerification(other, 'PENDING').contactsVerified).toBe(false);
    }
  });
  it('never counts NONE as verified', () => {
    for (const other of statuses) {
      expect(deriveContactsVerification('NONE', other).contactsVerified).toBe(false);
      expect(deriveContactsVerification(other, 'NONE').contactsVerified).toBe(false);
    }
  });
  it('returns a value the ContactsVerificationDto accepts, with exactly three keys', () => {
    for (const [e, p] of table) {
      const value = deriveContactsVerification(e, p);
      expect(ContactsVerificationDto.parse(value)).toEqual(value);
      expect(Object.keys(value).sort()).toEqual(['contactsVerified', 'emailVerified', 'phoneVerified']);
    }
  });
  it('returns a fresh object on each call', () => {
    expect(deriveContactsVerification('NONE', 'NONE')).not.toBe(deriveContactsVerification('NONE', 'NONE'));
  });
});

describe('ContactsVerificationDto', () => {
  it('requires three booleans', () => {
    expect(ContactsVerificationDto.safeParse({ emailVerified: true, phoneVerified: true, contactsVerified: true }).success).toBe(true);
    expect(ContactsVerificationDto.safeParse({ emailVerified: true, phoneVerified: true }).success).toBe(false);
    expect(ContactsVerificationDto.safeParse({ emailVerified: 1, phoneVerified: true, contactsVerified: true }).success).toBe(false);
    expect(ContactsVerificationDto.safeParse({ emailVerified: 'true', phoneVerified: true, contactsVerified: true }).success).toBe(false);
  });
  it('keeps exactly the documented keys', () => {
    expect(Object.keys(ContactsVerificationDto.shape).sort()).toEqual(['contactsVerified', 'emailVerified', 'phoneVerified']);
  });
});
