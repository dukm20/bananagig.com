// Unit tests of the email contracts (ID-002): the vocabularies, THE canonicalization (every comparison, uniqueness check and delivery uses it), masking, the
// managed-content key helpers (checked against the keys migration 0010 seeds), the strict request bodies, the masked-only read models, the identity events
// and their payloads, and the error codes. Special characters are built with String.fromCodePoint / String.fromCharCode so no source line holds an irregular
// character and no test needs a unicode escape sequence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ContentKey } from './content';
import {
  AccountEmailDetailDto,
  AccountEmailResponse,
  AccountEmailSummaryDto,
  ConfirmEmailCodeRequest,
  ConfirmEmailLinkRequest,
  EMAIL_CODE_SHAPE,
  EMAIL_CONTACT_STATUSES,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_DISABLED_REASONS,
  EMAIL_ERROR_CODES,
  EMAIL_EVENTS,
  EMAIL_INVALIDATION_REASONS,
  EMAIL_ISSUE_CODES,
  EMAIL_LOCAL_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_OPEN_STATUSES,
  EMAIL_PURPOSES,
  EMAIL_SOURCES,
  EMAIL_TOKEN_LENGTH,
  EMAIL_TOKEN_SHAPE,
  EMAIL_VERIFICATION_METHODS,
  EMAIL_VERIFICATION_STATUSES,
  EmailChangeRequestedPayload,
  EmailContactAddedPayload,
  EmailContactStatus,
  EmailOpenStatus,
  EmailPurpose,
  EmailSource,
  EmailVerificationFailedPayload,
  EmailVerificationMethod,
  EmailVerificationSentDto,
  EmailVerificationSentPayload,
  EmailVerificationSentResponse,
  EmailVerificationStatus,
  EmailVerifiedDto,
  EmailVerifiedPayload,
  EmailVerifiedResponse,
  PendingEmailDto,
  PrimaryEmailDto,
  SendEmailVerificationRequest,
  SetEmailRequest,
  SetEmailResponse,
  SetEmailResultDto,
  canonicalizeEmail,
  emailErrorMessageKey,
  emailIssueMessageKey,
  emailStatusLabelKey,
  isCanonicalEmail,
  maskEmail,
  type EmailErrorCode,
  type EmailIssueCode,
} from './email';
import * as contracts from './index';
import { EVENT_TYPE_PATTERN, EventEnvelope } from './index';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const U_UMLAUT = cp(0xfc);
const U_UMLAUT_UPPER = cp(0xdc);
const E_ACUTE = cp(0xe9);
const NBSP = cp(0xa0);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const ZWSP = cp(0x200b);
const SOFT_HYPHEN = cp(0xad);
const RLO = cp(0x202e);
const LRE = cp(0x202a);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const GRIN = cp(0x1f600);
const KELVIN_SIGN = cp(0x212a);
const DOTTED_CAPITAL_I = cp(0x130);
const HAN_ZHONGWEN = cp(0x4e2d, 0x6587);
const HAN_ZHONGGUO = cp(0x4e2d, 0x56fd);
const FULLWIDTH_EXAMPLE = cp(0xff45, 0xff58, 0xff41, 0xff4d, 0xff50, 0xff4c, 0xff45);
const FULLWIDTH_EXAMPLE_UPPER = cp(0xff25, 0xff38, 0xff21, 0xff2d, 0xff30, 0xff2c, 0xff25);
const FULLWIDTH_DIGITS = cp(0xff11, 0xff12, 0xff13, 0xff14, 0xff15, 0xff16);
const ARABIC_INDIC_DIGITS = cp(0x660, 0x661, 0x662, 0x663, 0x664, 0x665);

/** A domain of exactly `length` characters (length >= 5) that ends in `.com` and has no label above 63 characters. */
function domainOfLength(length: number): string {
  const prefixLength = length - 4;
  const labels = Math.ceil((prefixLength + 1) / 64);
  const letters = prefixLength - (labels - 1);
  const base = Math.floor(letters / labels);
  const extra = letters % labels;
  const parts = Array.from({ length: labels }, (_, i) => 'a'.repeat(base + (i < extra ? 1 : 0)));
  const domain = `${parts.join('.')}.com`;
  expect(domain.length).toBe(length);
  return domain;
}

const ok = (value: string) => ({ ok: true, value });
const bad = (code: EmailIssueCode) => ({ ok: false, code });

// ====================================================================== vocabularies
describe('email vocabularies', () => {
  it('lists the contact statuses and the open subset', () => {
    expect([...EMAIL_CONTACT_STATUSES]).toEqual(['PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED']);
    expect(EmailContactStatus.options).toEqual([...EMAIL_CONTACT_STATUSES]);
    expect([...EMAIL_OPEN_STATUSES]).toEqual(['PENDING', 'REPLACEMENT_PENDING']);
    expect(EmailOpenStatus.options).toEqual([...EMAIL_OPEN_STATUSES]);
    for (const s of EMAIL_OPEN_STATUSES) expect(EMAIL_CONTACT_STATUSES).toContain(s);
  });
  it('lists the sources, purposes and verification methods the schema uses', () => {
    expect([...EMAIL_SOURCES]).toEqual(['USER_ENTERED', 'IDP_VERIFIED']);
    expect(EmailSource.options).toEqual([...EMAIL_SOURCES]);
    expect([...EMAIL_PURPOSES]).toEqual(['INITIAL_EMAIL', 'CHANGE_EMAIL']);
    expect(EmailPurpose.options).toEqual([...EMAIL_PURPOSES]);
    expect([...EMAIL_VERIFICATION_METHODS]).toEqual(['CODE', 'LINK']);
    expect(EmailVerificationMethod.options).toEqual([...EMAIL_VERIFICATION_METHODS]);
  });
  it('lists the account-level verification statuses', () => {
    expect([...EMAIL_VERIFICATION_STATUSES]).toEqual(['NONE', 'PENDING', 'VERIFIED']);
    expect(EmailVerificationStatus.options).toEqual([...EMAIL_VERIFICATION_STATUSES]);
  });
  it('lists the delivery statuses, invalidation reasons and disabled reasons the challenge and contact tables hold', () => {
    expect([...EMAIL_DELIVERY_STATUSES]).toEqual(['PENDING', 'SENT', 'FAILED']);
    expect([...EMAIL_INVALIDATION_REASONS]).toEqual(['SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED']);
    expect([...EMAIL_DISABLED_REASONS]).toEqual(['REPLACED', 'SUPERSEDED']);
  });
  it('lists the issue codes and the numeric limits', () => {
    expect([...EMAIL_ISSUE_CODES]).toEqual(['REQUIRED', 'TOO_LONG', 'INVALID_FORMAT', 'INVALID_CHARACTERS', 'UNSUPPORTED']);
    expect(EMAIL_MAX_LENGTH).toBe(254);
    expect(EMAIL_LOCAL_MAX_LENGTH).toBe(64);
    expect(EMAIL_TOKEN_LENGTH).toBe(43);
  });
  it.each([
    ['status', EmailContactStatus, ['pending', 'Verified', 'ACTIVE', '', null, 1, undefined]],
    ['open status', EmailOpenStatus, ['VERIFIED', 'DISABLED', 'pending', null, 0]],
    ['source', EmailSource, ['GOOGLE', 'user_entered', 'USER_ENTERED ', null, 1]],
    ['purpose', EmailPurpose, ['INITIAL', 'change_email', null, 1]],
    ['method', EmailVerificationMethod, ['IDP', 'SMS', 'code', null, 1]],
    ['verification status', EmailVerificationStatus, ['CONFIRMED', 'none', 'REPLACEMENT_PENDING', null, 1]],
  ] as const)('the %s enum refuses values outside its vocabulary', (_label, schema, values) => {
    for (const v of values) expect(schema.safeParse(v).success, String(v)).toBe(false);
  });
  it('is re-exported from the package index', () => {
    expect(contracts.canonicalizeEmail).toBe(canonicalizeEmail);
    expect(contracts.maskEmail).toBe(maskEmail);
    expect(contracts.EMAIL_EVENTS).toBe(EMAIL_EVENTS);
    expect(contracts.SetEmailRequest).toBe(SetEmailRequest);
  });
});

// ====================================================================== message keys (managed content)
const seedMigration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0010_email_verification.sql', import.meta.url)), 'utf8');
const SEEDED_EMAIL_KEYS = [...seedMigration.matchAll(/^\s+\(\d+,\s+'[A-Z_]+',\s+'(account\.email\.[a-z0-9_.]+)'/gm)].map((m) => m[1]!);

describe('email content keys', () => {
  it('seeds 34 unique account.email.* entries in migration 0010 (the source the helpers are checked against)', () => {
    expect(SEEDED_EMAIL_KEYS).toHaveLength(34);
    expect(new Set(SEEDED_EMAIL_KEYS).size).toBe(34);
  });
  it.each([
    ['NONE', 'account.email.status.none'],
    ['PENDING', 'account.email.status.pending'],
    ['VERIFIED', 'account.email.status.verified'],
  ] as const)('emailStatusLabelKey(%s) is %s', (status, key) => {
    expect(emailStatusLabelKey(status)).toBe(key);
  });
  it.each([
    ['REQUIRED', 'account.email.error.required'],
    ['TOO_LONG', 'account.email.error.too_long'],
    ['INVALID_FORMAT', 'account.email.error.invalid_format'],
    ['INVALID_CHARACTERS', 'account.email.error.invalid_characters'],
    ['UNSUPPORTED', 'account.email.error.unsupported'],
  ] as const)('emailIssueMessageKey(%s) is %s', (code, key) => {
    expect(emailIssueMessageKey(code)).toBe(key);
  });
  it.each([
    ['EMAIL_NOT_PENDING', 'account.email.error.not_pending'],
    ['EMAIL_CODE_INVALID', 'account.email.error.code_invalid'],
    ['EMAIL_LINK_INVALID', 'account.email.error.link_invalid'],
    ['EMAIL_CODE_EXPIRED', 'account.email.error.code_expired'],
    ['EMAIL_CODE_USED', 'account.email.error.code_used'],
    ['EMAIL_VERIFICATION_LOCKED', 'account.email.error.verification_locked'],
    ['EMAIL_RESEND_TOO_SOON', 'account.email.error.resend_too_soon'],
    ['EMAIL_SEND_LIMIT', 'account.email.error.send_limit'],
    ['EMAIL_UNAVAILABLE', 'account.email.error.unavailable'],
    ['EMAIL_DELIVERY_FAILED', 'account.email.error.delivery_failed'],
    ['EMAIL_RATE_LIMITED', 'account.email.error.rate_limited'],
  ] as const)('emailErrorMessageKey(%s) is %s', (code, key) => {
    expect(emailErrorMessageKey(code)).toBe(key);
  });
  it('produces valid content keys that migration 0010 seeds, for every status', () => {
    for (const s of EMAIL_VERIFICATION_STATUSES) {
      const key = emailStatusLabelKey(s);
      expect(ContentKey.safeParse(key).success, key).toBe(true);
      expect(SEEDED_EMAIL_KEYS, key).toContain(key);
    }
  });
  it('produces valid content keys that migration 0010 seeds, for EVERY issue code', () => {
    for (const c of EMAIL_ISSUE_CODES) {
      const key = emailIssueMessageKey(c);
      expect(ContentKey.safeParse(key).success, key).toBe(true);
      expect(SEEDED_EMAIL_KEYS, key).toContain(key);
    }
  });
  it('produces valid content keys that migration 0010 seeds, for every error code except EMAIL_INVALID (which carries an issue code instead)', () => {
    const withMessage = EMAIL_ERROR_CODES.filter((c): c is Exclude<EmailErrorCode, 'EMAIL_INVALID'> => c !== 'EMAIL_INVALID');
    expect(withMessage).toHaveLength(EMAIL_ERROR_CODES.length - 1);
    for (const c of withMessage) {
      const key = emailErrorMessageKey(c);
      expect(ContentKey.safeParse(key).success, key).toBe(true);
      expect(SEEDED_EMAIL_KEYS, key).toContain(key);
    }
  });
  it('maps every issue code and error code to a different key', () => {
    const keys = [
      ...EMAIL_ISSUE_CODES.map(emailIssueMessageKey),
      ...EMAIL_ERROR_CODES.filter((c) => c !== 'EMAIL_INVALID').map((c) => emailErrorMessageKey(c as Exclude<EmailErrorCode, 'EMAIL_INVALID'>)),
    ];
    expect(keys).toHaveLength(5 + 11);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ====================================================================== canonicalizeEmail: accepted addresses
describe('canonicalizeEmail: accepted addresses', () => {
  it.each([
    ['a plain address', 'user@example.com', 'user@example.com'],
    ['surrounding spaces', '  user@example.com  ', 'user@example.com'],
    ['surrounding non-breaking spaces', `${NBSP}user@example.com${NBSP}`, 'user@example.com'],
    ['surrounding ideographic spaces', `${IDEOGRAPHIC_SPACE}user@example.com${IDEOGRAPHIC_SPACE}`, 'user@example.com'],
    ['a upper-case domain', 'user@EXAMPLE.COM', 'user@example.com'],
    ['an upper-case local part (folded: mailbox providers are case-insensitive)', 'USER@example.com', 'user@example.com'],
    ['mixed case everywhere', 'First.Last@Example.Com', 'first.last@example.com'],
    ['dots in the local part (kept, no Gmail folding)', 'f.i.r.s.t@gmail.com', 'f.i.r.s.t@gmail.com'],
    ['the same address without the dots (a different identity)', 'first@gmail.com', 'first@gmail.com'],
    ['a plus tag (kept)', 'user+tag@example.com', 'user+tag@example.com'],
    ['a plus tag with dots on a Gmail domain (both kept)', 'First.Last+News@GMAIL.com', 'first.last+news@gmail.com'],
    ['a googlemail.com domain (not rewritten to gmail.com)', 'user@googlemail.com', 'user@googlemail.com'],
    ['several plus signs', 'a+b+c@example.com', 'a+b+c@example.com'],
    ['a deep subdomain', 'user@mail.eu.example.co.uk', 'user@mail.eu.example.co.uk'],
    ['hyphens in the domain', 'user@my-host.example-site.org', 'user@my-host.example-site.org'],
    ['a numeric local part and a numeric label', '123@456.example', '123@456.example'],
    ['single-character labels', 'a@b.co', 'a@b.co'],
    ['a single-character top-level label', 'a@b.c', 'a@b.c'],
    ['a long top-level label', 'user@example.photography', 'user@example.photography'],
    ['an apostrophe in the local part', "o'brien@example.com", "o'brien@example.com"],
    ['underscores and hyphens in the local part', 'a_b-c@example.com', 'a_b-c@example.com'],
    ['every RFC 5322 atext symbol', "!#$%&'*+/=?^_`{|}~-@example.com", "!#$%&'*+/=?^_`{|}~-@example.com"],
    ['a leading digit in the local part', '1user@example.com', '1user@example.com'],
    ['the local development domain', 'customer.dev@bananagig.localhost', 'customer.dev@bananagig.localhost'],
    ['a mixed alphanumeric top-level label', 'user@example.c0m', 'user@example.c0m'],
    ['a double hyphen inside a label', 'user@ab--cd.com', 'user@ab--cd.com'],
  ])('accepts %s', (_label, input, expected) => {
    expect(canonicalizeEmail(input)).toEqual(ok(expected));
  });

  it('treats addresses that differ only in case or padding as the same identity', () => {
    const forms = ['ana@example.com', 'ANA@EXAMPLE.COM', 'Ana@Example.com', ' ana@example.com', 'ana@example.com ', `${NBSP}Ana@EXAMPLE.com${NBSP}`];
    for (const f of forms) expect(canonicalizeEmail(f), JSON.stringify(f)).toEqual(ok('ana@example.com'));
  });
  it('does NOT treat dots or plus tags as the same identity (no provider-specific folding is invented)', () => {
    const a = canonicalizeEmail('ana.maria@example.com');
    const b = canonicalizeEmail('anamaria@example.com');
    const c = canonicalizeEmail('anamaria+shop@example.com');
    expect(new Set([a, b, c].map((r) => (r.ok ? r.value : ''))).size).toBe(3);
  });
  it('keeps a mixed-case local part and domain separate from nothing: only case is folded', () => {
    expect(canonicalizeEmail('A.B+C@D.EX')).toEqual(ok('a.b+c@d.ex'));
  });
  it('returns exactly { ok: true, value } for an accepted address', () => {
    const r = canonicalizeEmail('Ana@Example.com');
    expect(Object.keys(r).sort()).toEqual(['ok', 'value']);
  });
});

// ====================================================================== canonicalizeEmail: internationalized domains
describe('canonicalizeEmail: internationalized domains', () => {
  it.each([
    ['a lower-case non-ASCII domain', `user@m${U_UMLAUT}nchen.de`, 'user@xn--mnchen-3ya.de'],
    ['an UPPER-CASE non-ASCII domain', `user@M${U_UMLAUT_UPPER}NCHEN.DE`, 'user@xn--mnchen-3ya.de'],
    ['a mixed-case non-ASCII subdomain', `User@Sub.M${U_UMLAUT}nchen.DE`, 'user@sub.xn--mnchen-3ya.de'],
    ['a non-ASCII domain with surrounding spaces', `  user@m${U_UMLAUT}nchen.de  `, 'user@xn--mnchen-3ya.de'],
    ['a domain already in punycode', 'user@xn--mnchen-3ya.de', 'user@xn--mnchen-3ya.de'],
    ['a domain in UPPER-CASE punycode', 'user@XN--MNCHEN-3YA.DE', 'user@xn--mnchen-3ya.de'],
    ['full-width Latin letters (compatibility mapping)', `user@${FULLWIDTH_EXAMPLE}.com`, 'user@example.com'],
    ['UPPER-CASE full-width Latin letters', `user@${FULLWIDTH_EXAMPLE_UPPER}.COM`, 'user@example.com'],
    ['Han labels', `user@${HAN_ZHONGWEN}.${HAN_ZHONGGUO}`, 'user@xn--fiq228c.xn--fiqs8s'],
    ['a Han top-level label under an ASCII name', `user@example.${HAN_ZHONGGUO}`, 'user@example.xn--fiqs8s'],
    ['an accented letter in a subdomain', `user@caf${E_ACUTE}.example.com`, 'user@xn--caf-dma.example.com'],
    ['the Kelvin sign, which IDNA maps to a plain k', `user@exa${KELVIN_SIGN}.com`, 'user@exak.com'],
  ])('maps %s', (_label, input, expected) => {
    expect(canonicalizeEmail(input)).toEqual(ok(expected));
  });
  it('gives the Unicode and the punycode spelling of a domain the same canonical form', () => {
    const unicode = canonicalizeEmail(`Ana@M${U_UMLAUT_UPPER}nchen.DE`);
    const ascii = canonicalizeEmail('ana@xn--mnchen-3ya.de');
    expect(unicode).toEqual(ascii);
    expect(unicode).toEqual(ok('ana@xn--mnchen-3ya.de'));
  });
  it('gives full-width and plain spellings of a domain the same canonical form', () => {
    expect(canonicalizeEmail(`ana@${FULLWIDTH_EXAMPLE}.com`)).toEqual(canonicalizeEmail('ana@example.com'));
  });
  it('refuses an internationalized label whose punycode form is longer than 63 characters', () => {
    expect(canonicalizeEmail(`u@${U_UMLAUT.repeat(60)}.com`)).toEqual(bad('INVALID_FORMAT'));
    expect(canonicalizeEmail(`u@${U_UMLAUT.repeat(10)}.com`)).toEqual(ok('u@xn--tdaaaaaaaaaa.com'));
  });
  it('refuses a full-width numeric top-level label (it maps to digits)', () => {
    expect(canonicalizeEmail(`u@example.${FULLWIDTH_DIGITS}`)).toEqual(bad('INVALID_FORMAT'));
  });
  it.each([
    ['an emoji label', `user@${GRIN}.com`],
    ['a zero-width space in a label', `user@exa${ZWSP}mple.com`],
    ['a soft hyphen in a label', `user@exa${SOFT_HYPHEN}mple.com`],
    ['a non-breaking space in a label', `user@exa${NBSP}mple.com`],
  ])('refuses %s in the domain', (_label, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('INVALID_FORMAT'));
  });
});

// ====================================================================== canonicalizeEmail: rejected addresses
describe('canonicalizeEmail: REQUIRED', () => {
  it.each([
    ['empty', ''],
    ['spaces', '    '],
    ['non-breaking spaces', `${NBSP}${NBSP}`],
    ['ideographic spaces', `${IDEOGRAPHIC_SPACE}${IDEOGRAPHIC_SPACE}`],
    ['1024 spaces (the input ceiling, still blank)', ' '.repeat(1024)],
  ])('rejects %s', (_label, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('REQUIRED'));
  });
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['a number', 5],
    ['true', true],
    ['false', false],
    ['an empty object', {}],
    ['an object holding an address', { email: 'a@example.com' }],
    ['an empty array', []],
    ['an array holding an address', ['a@example.com']],
    ['a function', () => 'a@example.com'],
    ['a symbol', Symbol('a@example.com')],
    ['a bigint', 10n],
    ['a String object', new String('a@example.com')],
  ])('rejects the non-string %s as REQUIRED (nothing is coerced)', (_label, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('REQUIRED'));
  });
});

describe('canonicalizeEmail: INVALID_FORMAT', () => {
  it.each([
    ['no at sign', 'user'],
    ['a dotted name without an at sign', 'user.example.com'],
    ['only an at sign', '@'],
    ['two at signs in a row', '@@'],
    ['an empty domain', 'user@'],
    ['an empty local part', '@example.com'],
    ['two at signs', 'a@b@example.com'],
    ['adjacent at signs', 'a@@example.com'],
    ['a trailing at sign', 'user@example.com@'],
    ['a single-label domain', 'user@localhost'],
    ['an IPv4 domain', 'user@127.0.0.1'],
    ['an IPv4 literal', 'user@[127.0.0.1]'],
    ['an IPv6 literal', 'user@[IPv6:::1]'],
    ['a trailing dot', 'user@example.com.'],
    ['a leading dot in the domain', 'user@.example.com'],
    ['consecutive dots in the domain', 'user@exa..mple.com'],
    ['a leading hyphen in a label', 'user@-example.com'],
    ['a trailing hyphen in a label', 'user@example-.com'],
    ['a leading hyphen in the top-level label', 'user@example.-com'],
    ['an underscore in the domain', 'user@exa_mple.com'],
    ['an all-numeric top-level label', 'user@example.123'],
    ['a port', 'user@example.com:25'],
    ['a space in the domain', 'user@exa mple.com'],
    ['a path', 'user@example.com/path'],
    ['a percent escape in the domain', 'user@%65xample.com'],
    ['a query', 'user@example.com?x=1'],
    ['an empty punycode label', 'user@xn--.de'],
    ['a space in the local part', 'us er@example.com'],
    ['a leading dot in the local part', '.user@example.com'],
    ['a trailing dot in the local part', 'user.@example.com'],
    ['consecutive dots in the local part', 'us..er@example.com'],
    ['a comment', 'user(comment)@example.com'],
    ['angle brackets', '<user@example.com>'],
    ['a display name', 'Name <user@example.com>'],
    ['a comma', 'a,b@example.com'],
    ['a semicolon', 'a;b@example.com'],
    ['a backslash', 'a\\b@example.com'],
    ['a double quote inside the local part', 'a"b@example.com'],
    ['a less-than sign', 'a<b@example.com'],
    ['a colon', 'a:b@example.com'],
    ['square brackets', 'a[b]@example.com'],
    ['an unbalanced parenthesis', 'a(b@example.com'],
    ['a mailto scheme', 'mailto:user@example.com'],
    ['two addresses', 'a@example.com b@example.com'],
    ['a label of 64 characters', `user@${'a'.repeat(64)}.com`],
    ['a quoted local part holding an at sign (three parts once split)', '"a@b"@example.com'],
  ])('rejects %s', (_label, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('INVALID_FORMAT'));
  });
});

describe('canonicalizeEmail: UNSUPPORTED (internationalized and quoted local parts)', () => {
  it.each([
    ['a quoted local part (RFC-valid but not a dot-atom)', '"user"@example.com'],
    ['a quoted local part with a space', '"john doe"@example.com'],
    ['an accented letter', `${U_UMLAUT}ser@example.com`],
    ['an accented letter in the middle', `us${E_ACUTE}r@example.com`],
    ['Han characters', `${HAN_ZHONGWEN}@example.com`],
    ['an emoji', `${GRIN}@example.com`],
    ['the Kelvin sign (no case-folding trick into ASCII)', `${KELVIN_SIGN}@example.com`],
    ['a dotted capital I', `i${DOTTED_CAPITAL_I}@example.com`],
    ['a zero-width space', `us${ZWSP}er@example.com`],
    ['a non-breaking space inside', `us${NBSP}er@example.com`],
    ['a soft hyphen', `us${SOFT_HYPHEN}er@example.com`],
    ['full-width letters', `${FULLWIDTH_EXAMPLE}@example.com`],
    ['an internationalized local part with an internationalized domain', `${U_UMLAUT}ser@m${U_UMLAUT}nchen.de`],
  ])('reports %s as UNSUPPORTED, not as a generic format error', (_label, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('UNSUPPORTED'));
  });
  it('does not refuse an internationalized DOMAIN under an ASCII local part', () => {
    expect(canonicalizeEmail(`user@m${U_UMLAUT}nchen.de`).ok).toBe(true);
  });
});

describe('canonicalizeEmail: INVALID_CHARACTERS', () => {
  const forbidden: [string, string][] = [
    ['NUL', cp(0)],
    ['BEL', cp(7)],
    ['TAB', '\t'],
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['VT', cp(0x0b)],
    ['FF', cp(0x0c)],
    ['ESC', cp(0x1b)],
    ['DEL', cp(0x7f)],
    ['a C1 control (NEL)', cp(0x85)],
    ['another C1 control', cp(0x9f)],
    ['right-to-left override', RLO],
    ['left-to-right embedding', LRE],
    ['left-to-right isolate', LRI],
    ['pop directional isolate', PDI],
    ['a lone high surrogate', HIGH_SURROGATE],
    ['a lone low surrogate', LOW_SURROGATE],
  ];
  const positions: [string, (c: string) => string][] = [
    ['the start', (c) => `${c}ab@example.com`],
    ['the local part', (c) => `a${c}b@example.com`],
    ['the domain', (c) => `ab@exa${c}mple.com`],
    ['the end', (c) => `ab@example.com${c}`],
  ];
  const cases = forbidden.flatMap(([name, ch]) => positions.map(([where, build]) => [name, where, build(ch)] as const));
  it.each(cases)('rejects %s at %s', (_name, _where, input) => {
    expect(canonicalizeEmail(input)).toEqual(bad('INVALID_CHARACTERS'));
  });

  it('refuses a header-injection attempt (a second header after a line break)', () => {
    expect(canonicalizeEmail('victim@example.com\r\nBcc: attacker@example.com')).toEqual(bad('INVALID_CHARACTERS'));
    expect(canonicalizeEmail('victim@example.com\nBcc: attacker@example.com')).toEqual(bad('INVALID_CHARACTERS'));
    expect(canonicalizeEmail('victim@example.com%0d%0aBcc:attacker@example.com')).toEqual(bad('INVALID_FORMAT'));
  });
  it('refuses a control character even where trimming would have removed it (a trailing or leading line break is not whitespace to drop)', () => {
    expect(canonicalizeEmail('user@example.com\n')).toEqual(bad('INVALID_CHARACTERS'));
    expect(canonicalizeEmail('\nuser@example.com')).toEqual(bad('INVALID_CHARACTERS'));
    expect(canonicalizeEmail('\t')).toEqual(bad('INVALID_CHARACTERS'));
  });
  it('reports the forbidden character before the missing at sign', () => {
    expect(canonicalizeEmail(`no-at-sign${cp(0)}`)).toEqual(bad('INVALID_CHARACTERS'));
  });
  it('reports the forbidden character before a bad format elsewhere in the same address', () => {
    expect(canonicalizeEmail(`a b@exa${RLO}..mple`)).toEqual(bad('INVALID_CHARACTERS'));
  });
});

// ====================================================================== canonicalizeEmail: length boundaries
describe('canonicalizeEmail: length boundaries', () => {
  it('accepts a label of 63 characters and rejects 64', () => {
    expect(canonicalizeEmail(`u@${'a'.repeat(63)}.com`)).toEqual(ok(`u@${'a'.repeat(63)}.com`));
    expect(canonicalizeEmail(`u@${'a'.repeat(64)}.com`)).toEqual(bad('INVALID_FORMAT'));
  });
  it('accepts a top-level label of 63 characters and rejects 64', () => {
    expect(canonicalizeEmail(`u@example.${'a'.repeat(63)}`).ok).toBe(true);
    expect(canonicalizeEmail(`u@example.${'a'.repeat(64)}`)).toEqual(bad('INVALID_FORMAT'));
  });
  it.each([
    [200, true],
    [251, true],
    [252, true],
    [253, false],
    [254, false],
    [255, false],
  ])('a domain of %s characters under a one-character local part (a 254-character address at most): accepted = %s', (domainLength, accepted) => {
    const domain = domainOfLength(domainLength);
    const result = canonicalizeEmail(`u@${domain}`);
    if (accepted) expect(result).toEqual(ok(`u@${domain}`));
    else expect(result).toEqual(bad('TOO_LONG'));
  });
  it('accepts a local part of 64 characters and rejects 65 with TOO_LONG', () => {
    expect(canonicalizeEmail(`${'a'.repeat(64)}@example.com`)).toEqual(ok(`${'a'.repeat(64)}@example.com`));
    expect(canonicalizeEmail(`${'a'.repeat(65)}@example.com`)).toEqual(bad('TOO_LONG'));
  });
  it('measures the local part AFTER case folding and trimming', () => {
    expect(canonicalizeEmail(`  ${'A'.repeat(64)}@EXAMPLE.com  `)).toEqual(ok(`${'a'.repeat(64)}@example.com`));
  });
  it.each([
    [64, 189, true],
    [64, 190, false],
    [63, 190, true],
    [63, 191, false],
    [1, 252, true],
    [1, 253, false],
  ])('a local part of %s and a domain of %s characters: accepted = %s (254 characters in all)', (localLength, domainLength, accepted) => {
    const address = `${'a'.repeat(localLength)}@${domainOfLength(domainLength)}`;
    expect(address.length).toBe(localLength + 1 + domainLength);
    const result = canonicalizeEmail(address);
    if (accepted) {
      expect(address.length).toBeLessThanOrEqual(EMAIL_MAX_LENGTH);
      expect(result).toEqual(ok(address));
    } else {
      expect(address.length).toBeGreaterThan(EMAIL_MAX_LENGTH);
      expect(result).toEqual(bad('TOO_LONG'));
    }
  });
  it('accepts an address of exactly 254 characters', () => {
    const address = `${'a'.repeat(64)}@${domainOfLength(189)}`;
    expect(address).toHaveLength(EMAIL_MAX_LENGTH);
    expect(canonicalizeEmail(address).ok).toBe(true);
  });
  it('rejects any input above 1024 characters as TOO_LONG, before looking at its content', () => {
    expect(canonicalizeEmail('a'.repeat(1025))).toEqual(bad('TOO_LONG'));
    expect(canonicalizeEmail(`${'a'.repeat(1025)}@example.com`)).toEqual(bad('TOO_LONG'));
    expect(canonicalizeEmail(' '.repeat(1025))).toEqual(bad('TOO_LONG'));
    expect(canonicalizeEmail(`${' '.repeat(1000)}user@example.com${' '.repeat(100)}`)).toEqual(bad('TOO_LONG'));
    expect(canonicalizeEmail(`${'a'.repeat(1025)}${cp(0)}`)).toEqual(bad('TOO_LONG'));
  });
  it('lets an input of exactly 1024 characters reach the format checks', () => {
    expect(canonicalizeEmail('a'.repeat(1024))).toEqual(bad('INVALID_FORMAT'));
    expect(canonicalizeEmail(`${' '.repeat(1008)}user@example.com`)).toEqual(ok('user@example.com'));
  });
});

// ====================================================================== canonicalizeEmail: result shape and properties
describe('canonicalizeEmail: results', () => {
  it.each([
    ['too long', 'SecretMailbox'.repeat(100)],
    ['no at sign', 'SecretMailbox'],
    ['a control character', `SecretMailbox${cp(0)}@example.com`],
    ['a header injection', 'SecretMailbox@example.com\r\nBcc: x@example.com'],
    ['an unsupported local part', `SecretMailbox${U_UMLAUT}@example.com`],
    ['a bad domain', 'SecretMailbox@localhost'],
    ['a bidi override', `SecretMailbox${RLO}@example.com`],
    ['a non-string', { secret: 'SecretMailbox' }],
  ])('a rejected input (%s) yields exactly { ok: false, code } and nothing derived from the input', (_label, input) => {
    const r = canonicalizeEmail(input);
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['code', 'ok']);
    expect(JSON.stringify(r)).not.toContain('Secret');
    expect(JSON.stringify(r).toLowerCase()).not.toContain('secretmailbox');
    expect(EMAIL_ISSUE_CODES).toContain((r as { code: EmailIssueCode }).code);
  });

  const LOCALS = [
    'user',
    'User.Name',
    'a',
    'A.B+Tag',
    'first.last+news',
    'UPPER',
    'x_y-z',
    '1234',
    'a'.repeat(64),
    "!#$%&'*+/=?^_`{|}~-",
    'a.b.c.d.e',
    'MiXeD+CaSe.Tag',
  ];
  const DOMAINS = [
    'example.com',
    'EXAMPLE.COM',
    'Sub.Example.Co.UK',
    'xn--mnchen-3ya.de',
    `m${U_UMLAUT}nchen.de`,
    `M${U_UMLAUT_UPPER}NCHEN.DE`,
    `${FULLWIDTH_EXAMPLE}.com`,
    `${HAN_ZHONGWEN}.${HAN_ZHONGGUO}`,
    'a.b',
    'a-b.c-d.org',
    '1.example.com',
    'bananagig.localhost',
    domainOfLength(120),
  ];
  const PADDINGS: [string, string][] = [
    ['', ''],
    [' ', ' '],
    [`${NBSP}`, `${IDEOGRAPHIC_SPACE}`],
  ];
  const corpus = LOCALS.flatMap((l) => DOMAINS.flatMap((d) => PADDINGS.map(([pre, post]) => `${pre}${l}@${d}${post}`)));

  it('is idempotent over a generated corpus of valid addresses (canonical form of a canonical form is itself)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(400);
    for (const input of corpus) {
      const first = canonicalizeEmail(input);
      expect(first.ok, JSON.stringify(input)).toBe(true);
      if (!first.ok) continue;
      expect(canonicalizeEmail(first.value), first.value).toEqual(ok(first.value));
      expect(isCanonicalEmail(first.value), first.value).toBe(true);
    }
  });
  it('folds case and padding the same way for every address of the corpus', () => {
    for (const input of corpus) {
      const base = canonicalizeEmail(input);
      expect(canonicalizeEmail(`  ${input.toUpperCase()}  `.replace(/\s+$/, ' ')), input).toEqual(base);
    }
  });
  it('is idempotent and well-formed over 3000 deterministic pseudo-random addresses, valid or damaged', () => {
    const localPieces = ['a', 'B', 'z9', 'user', 'First.Last', 'x_y', 'n+tag', 'UPPER', '1', 'a.b'];
    const domainPieces = [
      'example.com',
      'EXAMPLE.ORG',
      'Mail.Example.NET',
      'a.b',
      `m${U_UMLAUT}nchen.de`,
      'xn--mnchen-3ya.de',
      `${HAN_ZHONGWEN}.${HAN_ZHONGGUO}`,
      'x-y.example.io',
    ];
    const noise = ['', '', '', '@', '.', '..', '-', '_', ' ', '\t', RLO, '%', '"', '[', U_UMLAUT, HAN_ZHONGWEN, '(', ','];
    let state = 12345;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state >>> 8;
    };
    const pick = <T>(list: readonly T[]): T => list[next() % list.length]!;
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 3000; i++) {
      let s = `${pick(localPieces)}${pick(['', '', '.' + pick(localPieces)])}@${pick(domainPieces)}`;
      const at = next() % (s.length + 1);
      s = `${s.slice(0, at)}${pick(noise)}${s.slice(at)}`;
      const r = canonicalizeEmail(s);
      if (r.ok) {
        accepted++;
        expect(canonicalizeEmail(r.value), JSON.stringify(s)).toEqual(ok(r.value));
        expect(r.value).toBe(r.value.trim());
        expect(r.value.split('@')).toHaveLength(2);
        expect(r.value.length).toBeLessThanOrEqual(EMAIL_MAX_LENGTH);
        expect(/^[ -~]+$/.test(r.value), r.value).toBe(true);
        expect(r.value).toBe(r.value.toLowerCase());
      } else {
        rejected++;
        expect(Object.keys(r).sort()).toEqual(['code', 'ok']);
        expect(EMAIL_ISSUE_CODES).toContain(r.code);
      }
    }
    expect(accepted).toBeGreaterThan(800);
    expect(rejected).toBeGreaterThan(300);
  });
  it('accepts only printable ASCII, lower case, with exactly one at sign, whatever the input script', () => {
    for (const input of [`User@M${U_UMLAUT_UPPER}NCHEN.DE`, `ANA@${FULLWIDTH_EXAMPLE_UPPER}.COM`, `a@${HAN_ZHONGWEN}.${HAN_ZHONGGUO}`]) {
      const r = canonicalizeEmail(input);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(/^[ -~]+$/.test(r.value)).toBe(true);
        expect(r.value).toBe(r.value.toLowerCase());
      }
    }
  });
});

describe('isCanonicalEmail', () => {
  it.each([
    'user@example.com',
    'first.last+tag@example.com',
    'a@b.co',
    'user@xn--mnchen-3ya.de',
    "!#$%&'*+/=?^_`{|}~-@example.com",
    `${'a'.repeat(64)}@example.com`,
    'customer.dev@bananagig.localhost',
  ])('is true for the canonical form %s', (v) => {
    expect(isCanonicalEmail(v)).toBe(true);
  });
  it.each([
    ['upper case', 'User@example.com'],
    ['upper-case domain', 'user@EXAMPLE.com'],
    ['padded', ' user@example.com'],
    ['padded at the end', 'user@example.com '],
    ['a Unicode domain', `user@m${U_UMLAUT}nchen.de`],
    ['a full-width domain', `user@${FULLWIDTH_EXAMPLE}.com`],
    ['invalid', 'not-an-email'],
    ['a trailing dot', 'user@example.com.'],
    ['empty', ''],
    ['a header injection', 'user@example.com\r\nBcc: a@b.co'],
    ['an unsupported local part', `${U_UMLAUT}@example.com`],
  ])('is false for a %s form', (_label, v) => {
    expect(isCanonicalEmail(v)).toBe(false);
  });
  it.each([undefined, null, 5, true, {}, [], ['user@example.com'], () => 'user@example.com'])('is false for the non-string %s', (v) => {
    expect(isCanonicalEmail(v)).toBe(false);
  });
  it('narrows the type to string', () => {
    const v: unknown = 'user@example.com';
    if (isCanonicalEmail(v)) expect(v.toUpperCase()).toBe('USER@EXAMPLE.COM');
    else throw new Error('expected a canonical address');
  });
});

// ====================================================================== maskEmail
describe('maskEmail', () => {
  it.each([
    ['customer.dev@bananagig.localhost', 'c***@b***.localhost'],
    ['user@example.com', 'u***@e***.com'],
    ['a@b.co', 'a***@b***.co'],
    ['a@b.c', 'a***@b***.c'],
    ['x@y.z', 'x***@y***.z'],
    ['ab@cd.ef', 'a***@c***.ef'],
    ['user@mail.example.com', 'u***@m***.com'],
    ['user@a.b.c.d.example.org', 'u***@a***.org'],
    ['first.last+tag@example.co.uk', 'f***@e***.uk'],
    ['user@xn--mnchen-3ya.de', 'u***@x***.de'],
    ['1234@5678.example', '1***@5***.example'],
    ["'quote@example.com", "'***@e***.com"],
    ['!bang@example.com', '!***@e***.com'],
  ])('masks %s as %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
  it('shows the first character of the local part, of the first domain label and the last domain label only', () => {
    const masked = maskEmail('ana.martinez@sales.northwind.example');
    expect(masked).toBe('a***@s***.example');
    expect(masked).not.toContain('martinez');
    expect(masked).not.toContain('northwind');
    expect(masked).not.toContain('sales');
  });
  it.each([
    'Customer@Example.com',
    ' user@example.com',
    'user@example.com ',
    'USER@EXAMPLE.COM',
    `user@m${U_UMLAUT}nchen.de`,
    'not-an-email',
    'user@localhost',
    'user@example.com.',
    'user@@example.com',
    'a@b@example.com',
    '',
    '@',
    '   ',
    '***',
    'u***@e***.com ',
    `${U_UMLAUT}ser@example.com`,
    'user@example.com\r\nBcc: a@b.co',
    `${'a'.repeat(65)}@example.com`,
  ])('masks the non-canonical value %j entirely', (input) => {
    expect(maskEmail(input)).toBe('***');
  });
  it.each([undefined, null, 5, {}, []] as unknown as string[])('masks the non-string %j entirely instead of throwing', (input) => {
    expect(maskEmail(input)).toBe('***');
  });
  it('never reveals the full local part of a multi-character address', () => {
    const locals = ['ana', 'ana.martinez', 'first.last+tag', 'support', 'x1', 'abcdefgh', 'a'.repeat(64), 'billing_team', 'o.brien', 'jo-ann'];
    const domains = ['example.org', 'mail.example.net', 'north.sales.example.io', 'bananagig.localhost', 'xn--mnchen-3ya.de'];
    for (const local of locals) {
      for (const domain of domains) {
        const masked = maskEmail(`${local}@${domain}`);
        expect(masked, `${local}@${domain}`).not.toContain(local);
        expect(masked, `${local}@${domain}`).not.toContain('@' + domain);
        expect(masked, `${local}@${domain}`).toMatch(/^.\*\*\*@.\*\*\*\.[a-z0-9-]+$/);
      }
    }
  });
  it('never reveals a middle label of the domain or the whole first label (longer than one character)', () => {
    const masked = maskEmail('user@middle.hidden.example.org');
    expect(masked).not.toContain('middle');
    expect(masked).not.toContain('hidden');
    expect(masked).toBe('u***@m***.org');
  });
  it('is stable: masking the same canonical address twice gives the same text', () => {
    expect(maskEmail('user@example.com')).toBe(maskEmail('user@example.com'));
  });
  it('is not itself an address: the masked text is never a canonical address', () => {
    for (const a of ['user@example.com', 'a@b.c', 'customer.dev@bananagig.localhost']) {
      expect(isCanonicalEmail(maskEmail(a)), a).toBe(false);
      expect(canonicalizeEmail(maskEmail(a)).ok, a).toBe(false);
    }
  });
  it('masks every address of two canonical corpora to the same three-star pattern', () => {
    const addresses = ['ana@example.com', 'bob.smith+news@mail.example.co.uk', 'x@y.zz', 'q1@a1.b2c3'];
    for (const a of addresses) expect(maskEmail(a)).toMatch(/^[^*]\*\*\*@[^*]\*\*\*\.[a-z0-9]+$/);
  });
});

// ====================================================================== request bodies
const TOKEN_43 = 'A'.repeat(21) + '-_' + 'z'.repeat(20);

describe('SetEmailRequest', () => {
  it.each(['a@example.com', 'User@Example.COM', '', '   ', 'not an address', 'x'.repeat(1024), `${U_UMLAUT}@example.com`])(
    'accepts { email: %j } (the service decides validity and returns the issue code)',
    (email) => {
      expect(SetEmailRequest.parse({ email })).toEqual({ email });
    },
  );
  it('keeps the exact input: the contract neither trims nor canonicalizes', () => {
    expect(SetEmailRequest.parse({ email: '  Ana@Example.COM ' })).toEqual({ email: '  Ana@Example.COM ' });
  });
  it.each([
    ['an empty object', {}],
    ['a missing email', { email: undefined }],
    ['a number', { email: 123 }],
    ['a boolean', { email: true }],
    ['null', { email: null }],
    ['an array', { email: ['a@example.com'] }],
    ['an object', { email: { address: 'a@example.com' } }],
    ['a bigint-like string array', { email: ['1'] }],
    ['an over-long email (1025)', { email: 'x'.repeat(1025) }],
    ['an unknown extra key', { email: 'a@example.com', extra: 1 }],
    ['an account id', { email: 'a@example.com', accountId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11' }],
    ['a verified flag', { email: 'a@example.com', verified: true }],
    ['a second address', { email: 'a@example.com', emailNormalized: 'a@example.com' }],
    ['a misspelt key', { Email: 'a@example.com' }],
    ['the address under another key only', { address: 'a@example.com' }],
  ])('rejects %s', (_label, body) => {
    expect(SetEmailRequest.safeParse(body).success).toBe(false);
  });
  it.each([null, undefined, 'a@example.com', 5, true, ['a@example.com']])('rejects the non-object body %j', (body) => {
    expect(SetEmailRequest.safeParse(body).success).toBe(false);
  });
  it('names an unknown key in the issue and nothing of its value', () => {
    const r = SetEmailRequest.safeParse({ email: 'a@example.com', extra: 'leaked-extra-value' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
    expect(JSON.stringify(r.error.issues)).not.toContain('leaked-extra-value');
  });
});

describe('SendEmailVerificationRequest', () => {
  it('accepts exactly an empty object', () => {
    expect(SendEmailVerificationRequest.parse({})).toEqual({});
  });
  it.each([
    ['an address', { email: 'a@example.com' }],
    ['a locale', { locale: 'en-US' }],
    ['an account id', { accountId: 'x' }],
    ['an unknown key', { extra: 1 }],
    ['undefined under a key', { extra: undefined }],
  ])("rejects a body with %s (there is nothing to choose: the address is the account's own pending address)", (_label, body) => {
    expect(SendEmailVerificationRequest.safeParse(body).success).toBe(false);
  });
  it.each([null, undefined, '', 'x', 0, true, []])('rejects the non-object body %j', (body) => {
    expect(SendEmailVerificationRequest.safeParse(body).success).toBe(false);
  });
});

describe('ConfirmEmailCodeRequest', () => {
  it('has the documented code shape: 4 to 10 digits', () => {
    expect(EMAIL_CODE_SHAPE.source).toBe('^[0-9]{4,10}$');
  });
  it.each(['1234', '123456', '000000', '0000', '9999999999', '0000000000', '12345678', '007312'])('accepts the code %s and keeps leading zeros', (code) => {
    expect(ConfirmEmailCodeRequest.parse({ code })).toEqual({ code });
  });
  it.each([
    ['3 digits', '123'],
    ['11 digits', '12345678901'],
    ['a letter', '12345a'],
    ['only letters', 'abcdef'],
    ['a space inside', '123 456'],
    ['a leading space', ' 123456'],
    ['a trailing space', '123456 '],
    ['a trailing newline', '123456\n'],
    ['a hyphen', '123-456'],
    ['a plus sign', '+123456'],
    ['a minus sign', '-123456'],
    ['a decimal point', '123.456'],
    ['an exponent', '1e5000'],
    ['hex', '0x1234'],
    ['full-width digits', FULLWIDTH_DIGITS],
    ['Arabic-Indic digits', ARABIC_INDIC_DIGITS],
    ['an empty string', ''],
    ['whitespace only', '      '],
    ['SQL text', '1; DROP TABLE x'],
  ])('rejects a code with %s', (_label, code) => {
    expect(ConfirmEmailCodeRequest.safeParse({ code }).success).toBe(false);
  });
  it.each([
    ['a number (never coerced to a string)', { code: 123456 }],
    ['a number with leading zeros lost', { code: 12345 }],
    ['a boolean', { code: true }],
    ['null', { code: null }],
    ['an array', { code: ['123456'] }],
    ['an object', { code: { value: '123456' } }],
    ['a missing code', {}],
    ['an undefined code', { code: undefined }],
    ['an unknown extra key', { code: '123456', extra: 1 }],
    ['a token next to the code', { code: '123456', token: TOKEN_43 }],
    ['an account id', { code: '123456', accountId: 'x' }],
    ['a misspelt key', { Code: '123456' }],
  ])('rejects %s', (_label, body) => {
    expect(ConfirmEmailCodeRequest.safeParse(body).success).toBe(false);
  });
  it.each([null, undefined, '123456', 123456, ['123456']])('rejects the non-object body %j', (body) => {
    expect(ConfirmEmailCodeRequest.safeParse(body).success).toBe(false);
  });
});

describe('ConfirmEmailLinkRequest', () => {
  it('has the documented token shape: exactly 43 base64url characters', () => {
    expect(EMAIL_TOKEN_SHAPE.source).toBe('^[A-Za-z0-9_-]{43}$');
    expect(TOKEN_43).toHaveLength(EMAIL_TOKEN_LENGTH);
  });
  it.each([
    ['letters', 'A'.repeat(43)],
    ['lower-case letters', 'b'.repeat(43)],
    ['digits', '7'.repeat(43)],
    ['hyphens and underscores', '-'.repeat(20) + '_'.repeat(23)],
    ['a mix', TOKEN_43],
    ['the base64url of 32 bytes', Buffer.alloc(32, 251).toString('base64url')],
    ['the base64url of 32 zero bytes', Buffer.alloc(32).toString('base64url')],
  ])('accepts %s', (_label, token) => {
    expect(token).toHaveLength(43);
    expect(ConfirmEmailLinkRequest.parse({ token })).toEqual({ token });
  });
  it.each([
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['an empty string', ''],
    ['the base64 padding character', 'A'.repeat(42) + '='],
    ['a standard-base64 plus sign', 'A'.repeat(42) + '+'],
    ['a standard-base64 slash', 'A'.repeat(42) + '/'],
    ['a space', 'A'.repeat(42) + ' '],
    ['a leading space', ' ' + 'A'.repeat(43)],
    ['a trailing newline', 'A'.repeat(43) + '\n'],
    ['a non-ASCII letter', 'A'.repeat(42) + U_UMLAUT],
    ['full-width letters', FULLWIDTH_EXAMPLE.repeat(7)],
    ['a percent escape', 'A'.repeat(40) + '%2B'],
    ['a dot', 'A'.repeat(42) + '.'],
    ['a six-digit code', '123456'],
  ])('rejects a token with %s', (_label, token) => {
    expect(ConfirmEmailLinkRequest.safeParse({ token }).success).toBe(false);
  });
  it.each([
    ['a number', { token: 4.2e42 }],
    ['a boolean', { token: true }],
    ['null', { token: null }],
    ['an array holding a token', { token: [TOKEN_43] }],
    ['a missing token', {}],
    ['an unknown extra key', { token: TOKEN_43, extra: 1 }],
    ['a code next to the token', { token: TOKEN_43, code: '123456' }],
    ['a misspelt key', { Token: TOKEN_43 }],
  ])('rejects %s', (_label, body) => {
    expect(ConfirmEmailLinkRequest.safeParse(body).success).toBe(false);
  });
  it.each([null, undefined, TOKEN_43, 5, [TOKEN_43]])('rejects the non-object body %j', (body) => {
    expect(ConfirmEmailLinkRequest.safeParse(body).success).toBe(false);
  });
});

// ====================================================================== read models
const ISO = '2026-01-01T00:00:00.000Z';
const ISO_LATER = '2026-01-01T00:10:00.000Z';
const summaryNone = { emailVerificationStatus: 'NONE', primary: null, pending: null };
const primaryDto = { maskedEmail: 'u***@e***.com', verifiedAt: ISO, source: 'USER_ENTERED' };
const pendingInitial = { maskedEmail: 'u***@e***.com', purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null };
const pendingChange = { maskedEmail: 'n***@e***.org', purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING', lastSentAt: ISO, expiresAt: ISO_LATER };
const summaryPending = { emailVerificationStatus: 'PENDING', primary: null, pending: pendingInitial };
const summaryVerified = { emailVerificationStatus: 'VERIFIED', primary: primaryDto, pending: null };
const summaryChange = { emailVerificationStatus: 'VERIFIED', primary: primaryDto, pending: pendingChange };
const SUMMARIES: [string, unknown][] = [
  ['no address', summaryNone],
  ['a pending first address', summaryPending],
  ['a verified primary address', summaryVerified],
  ['a verified primary with a pending replacement', summaryChange],
];
const detail = { ...summaryChange, resendAvailableAt: ISO_LATER, attemptsRemaining: 4, codeLength: 6, validityMinutes: 10 };
const sentDto = { sentAt: ISO, expiresAt: ISO_LATER, resendAvailableAt: ISO_LATER, codeLength: 6, validityMinutes: 10, email: summaryPending };
const meta = { correlationId: 'c-1' };

describe('AccountEmailSummaryDto', () => {
  it.each(SUMMARIES)('parses a summary with %s unchanged', (_label, summary) => {
    expect(AccountEmailSummaryDto.parse(summary)).toEqual(summary);
  });
  it.each([
    ['an unknown verification status', { ...summaryNone, emailVerificationStatus: 'CONFIRMED' }],
    ['a lower-case status', { ...summaryNone, emailVerificationStatus: 'none' }],
    ['a missing status', { primary: null, pending: null }],
    ['a missing primary', { emailVerificationStatus: 'NONE', pending: null }],
    ['a missing pending', { emailVerificationStatus: 'NONE', primary: null }],
    ['an undefined primary', { ...summaryNone, primary: undefined }],
    ['a primary without its source', { ...summaryVerified, primary: { maskedEmail: 'u***@e***.com', verifiedAt: ISO } }],
    ['a primary with an unknown source', { ...summaryVerified, primary: { ...primaryDto, source: 'GOOGLE' } }],
    ['a primary without verifiedAt', { ...summaryVerified, primary: { maskedEmail: 'u***@e***.com', source: 'USER_ENTERED' } }],
    ['a primary with a null verifiedAt', { ...summaryVerified, primary: { ...primaryDto, verifiedAt: null } }],
    ['a numeric maskedEmail', { ...summaryVerified, primary: { ...primaryDto, maskedEmail: 5 } }],
    ['a pending address with an unknown purpose', { ...summaryPending, pending: { ...pendingInitial, purpose: 'OTHER' } }],
    ['a pending address that is VERIFIED (not an open status)', { ...summaryPending, pending: { ...pendingInitial, status: 'VERIFIED' } }],
    ['a pending address that is DISABLED (not an open status)', { ...summaryPending, pending: { ...pendingInitial, status: 'DISABLED' } }],
    [
      'a pending address without lastSentAt',
      { ...summaryPending, pending: { maskedEmail: 'u***@e***.com', purpose: 'INITIAL_EMAIL', status: 'PENDING', expiresAt: null } },
    ],
    [
      'a pending address without expiresAt',
      { ...summaryPending, pending: { maskedEmail: 'u***@e***.com', purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null } },
    ],
    ['a numeric lastSentAt', { ...summaryPending, pending: { ...pendingInitial, lastSentAt: 5 } }],
    ['a plain string instead of the primary object', { ...summaryNone, primary: 'u***@e***.com' }],
    ['an array of pending addresses', { ...summaryNone, pending: [pendingInitial] }],
  ])('rejects a summary with %s', (_label, summary) => {
    expect(AccountEmailSummaryDto.safeParse(summary).success).toBe(false);
  });
  it.each([null, undefined, 'NONE', 5, []])('rejects the non-object summary %j', (summary) => {
    expect(AccountEmailSummaryDto.safeParse(summary).success).toBe(false);
  });
  it('carries exactly the masked fields: status, primary and pending', () => {
    expect(Object.keys(AccountEmailSummaryDto.shape).sort()).toEqual(['emailVerificationStatus', 'pending', 'primary']);
    expect(Object.keys(PrimaryEmailDto.shape).sort()).toEqual(['maskedEmail', 'source', 'verifiedAt']);
    expect(Object.keys(PendingEmailDto.shape).sort()).toEqual(['expiresAt', 'lastSentAt', 'maskedEmail', 'purpose', 'status']);
  });
  it('drops an unknown field that carries a full address, a code or a token instead of passing it on', () => {
    const smuggled = {
      emailVerificationStatus: 'VERIFIED',
      email: 'ana.martinez@example.test',
      primary: { ...primaryDto, address: 'ana.martinez@example.test', emailNormalized: 'ana.martinez@example.test', codeHash: 'abc' },
      pending: null,
      code: '123456',
      token: TOKEN_43,
    };
    const parsed = AccountEmailSummaryDto.parse(smuggled);
    expect(parsed).toEqual(summaryVerified);
    expect(JSON.stringify(parsed)).not.toContain('ana.martinez');
    expect(JSON.stringify(parsed)).not.toContain('123456');
    expect(JSON.stringify(parsed)).not.toContain(TOKEN_43);
  });
});

describe('AccountEmailDetailDto', () => {
  it('parses the detail and returns it unchanged', () => {
    expect(AccountEmailDetailDto.parse(detail)).toEqual(detail);
  });
  it('accepts the cooldown and the attempts as null', () => {
    const idle = { ...summaryNone, resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 10 };
    expect(AccountEmailDetailDto.parse(idle)).toEqual(idle);
  });
  it('extends the summary with the countdown and input fields only', () => {
    expect(Object.keys(AccountEmailDetailDto.shape).sort()).toEqual([
      'attemptsRemaining',
      'codeLength',
      'emailVerificationStatus',
      'pending',
      'primary',
      'resendAvailableAt',
      'validityMinutes',
    ]);
  });
  it.each([
    ['a fractional attemptsRemaining', { attemptsRemaining: 2.5 }],
    ['a string codeLength', { codeLength: '6' }],
    ['a fractional codeLength', { codeLength: 6.5 }],
    ['a null codeLength', { codeLength: null }],
    ['a null validityMinutes', { validityMinutes: null }],
    ['a missing codeLength', { codeLength: undefined }],
    ['a missing validityMinutes', { validityMinutes: undefined }],
    ['a missing resendAvailableAt', { resendAvailableAt: undefined }],
    ['a missing attemptsRemaining', { attemptsRemaining: undefined }],
    ['a numeric resendAvailableAt', { resendAvailableAt: 5 }],
    ['an unknown status', { emailVerificationStatus: 'BOGUS' }],
  ])('rejects a detail with %s', (_label, over) => {
    expect(AccountEmailDetailDto.safeParse({ ...detail, ...over }).success).toBe(false);
  });
  it('is wrapped in the standard data and meta envelope', () => {
    expect(AccountEmailResponse.parse({ data: detail, meta })).toEqual({ data: detail, meta });
    expect(AccountEmailResponse.safeParse({ data: detail }).success).toBe(false);
    expect(AccountEmailResponse.safeParse({ meta }).success).toBe(false);
    expect(AccountEmailResponse.safeParse({ data: { ...detail, codeLength: 'six' }, meta }).success).toBe(false);
  });
});

describe('EmailVerificationSentDto', () => {
  it('parses the result of a send', () => {
    expect(EmailVerificationSentDto.parse(sentDto)).toEqual(sentDto);
  });
  it.each([
    ['a missing sentAt', { sentAt: undefined }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['a missing resendAvailableAt', { resendAvailableAt: undefined }],
    ['a null resendAvailableAt (a send always starts a cooldown)', { resendAvailableAt: null }],
    ['a null sentAt', { sentAt: null }],
    ['a fractional codeLength', { codeLength: 6.2 }],
    ['a string validityMinutes', { validityMinutes: '10' }],
    ['a missing email summary', { email: undefined }],
    ['an address string instead of the summary', { email: 'u***@e***.com' }],
    ['a summary with an unknown status', { email: { ...summaryPending, emailVerificationStatus: 'SENT' } }],
  ])('rejects a send result with %s', (_label, over) => {
    expect(EmailVerificationSentDto.safeParse({ ...sentDto, ...over }).success).toBe(false);
  });
  it('is wrapped in the standard envelope', () => {
    expect(EmailVerificationSentResponse.parse({ data: sentDto, meta })).toEqual({ data: sentDto, meta });
    expect(EmailVerificationSentResponse.safeParse({ data: sentDto }).success).toBe(false);
  });
});

describe('SetEmailResultDto and EmailVerifiedDto', () => {
  it.each(SUMMARIES)('SetEmailResultDto parses changed true and false with %s', (_label, email) => {
    expect(SetEmailResultDto.parse({ changed: true, email })).toEqual({ changed: true, email });
    expect(SetEmailResultDto.parse({ changed: false, email })).toEqual({ changed: false, email });
  });
  it.each(SUMMARIES)('EmailVerifiedDto parses changed true and false with %s', (_label, email) => {
    expect(EmailVerifiedDto.parse({ changed: true, email })).toEqual({ changed: true, email });
    expect(EmailVerifiedDto.parse({ changed: false, email })).toEqual({ changed: false, email });
  });
  it.each([
    ['a missing changed flag', { email: summaryNone }],
    ['a string changed flag', { changed: 'true', email: summaryNone }],
    ['a numeric changed flag', { changed: 1, email: summaryNone }],
    ['a null changed flag', { changed: null, email: summaryNone }],
    ['a missing email summary', { changed: true }],
    ['a null email summary', { changed: true, email: null }],
    ['a bare address instead of the summary', { changed: true, email: 'a@example.com' }],
    ['a summary with an unknown status', { changed: true, email: { ...summaryNone, emailVerificationStatus: 'X' } }],
  ])('both reject %s', (_label, body) => {
    expect(SetEmailResultDto.safeParse(body).success).toBe(false);
    expect(EmailVerifiedDto.safeParse(body).success).toBe(false);
  });
  it('are wrapped in the standard envelope', () => {
    expect(SetEmailResponse.parse({ data: { changed: true, email: summaryPending }, meta }).data.changed).toBe(true);
    expect(EmailVerifiedResponse.parse({ data: { changed: false, email: summaryVerified }, meta }).data.changed).toBe(false);
    expect(SetEmailResponse.safeParse({ data: { changed: true, email: summaryPending } }).success).toBe(false);
    expect(EmailVerifiedResponse.safeParse({ data: { changed: true, email: summaryPending } }).success).toBe(false);
  });
  it('drops fields smuggled next to the result instead of passing them on', () => {
    const parsed = EmailVerifiedDto.parse({ changed: true, email: summaryVerified, code: '123456', token: TOKEN_43, codeHash: 'x', address: 'a@example.com' });
    expect(Object.keys(parsed).sort()).toEqual(['changed', 'email']);
  });
});

// ====================================================================== response DTOs carry nothing sensitive
type SchemaDef = { type: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType; element?: z.ZodType };
const defOf = (schema: z.ZodType): SchemaDef => (schema as unknown as { def: SchemaDef }).def;
/** Every object key reachable from a schema (through nullable, optional, array and nested objects), with the type of the schema under the key. */
function collectKeys(schema: z.ZodType, path: string[] = [], out: { path: string[]; type: string }[] = []): { path: string[]; type: string }[] {
  const def = defOf(schema);
  if (def.type === 'object' && def.shape) {
    for (const [key, child] of Object.entries(def.shape)) {
      out.push({ path: [...path, key], type: defOf(child).type });
      collectKeys(child, [...path, key], out);
    }
  } else if (def.innerType) collectKeys(def.innerType, path, out);
  else if (def.element) collectKeys(def.element, path, out);
  return out;
}

const RESPONSE_SCHEMAS: [string, z.ZodType][] = [
  ['AccountEmailSummaryDto', AccountEmailSummaryDto],
  ['AccountEmailDetailDto', AccountEmailDetailDto],
  ['EmailVerificationSentDto', EmailVerificationSentDto],
  ['EmailVerifiedDto', EmailVerifiedDto],
  ['SetEmailResultDto', SetEmailResultDto],
  ['AccountEmailResponse', AccountEmailResponse],
  ['EmailVerificationSentResponse', EmailVerificationSentResponse],
  ['SetEmailResponse', SetEmailResponse],
  ['EmailVerifiedResponse', EmailVerifiedResponse],
];
const SENSITIVE_KEY =
  /hash|secret|token|digest|hmac|password|otp|normalized|^code$|verificationcode|^address$|emailaddress|^link$|^url$|verificationurl|magic/i;

describe('response DTOs carry nothing that could hold a full address, a code, a token or a hash', () => {
  it.each(RESPONSE_SCHEMAS)('%s has no sensitive key at any depth', (_name, schema) => {
    const keys = collectKeys(schema);
    expect(keys.length).toBeGreaterThan(0);
    for (const { path } of keys) expect(path[path.length - 1], path.join('.')).not.toMatch(SENSITIVE_KEY);
  });
  it.each(RESPONSE_SCHEMAS)('%s uses the key "email" only for the masked summary object, never for a string', (_name, schema) => {
    for (const { path, type } of collectKeys(schema)) {
      if (path[path.length - 1] === 'email') expect(type, path.join('.')).toBe('object');
    }
  });
  it.each(RESPONSE_SCHEMAS)('%s has no string field other than the masked address, timestamps and enumerations', (_name, schema) => {
    const allowedStrings = new Set(['maskedEmail', 'verifiedAt', 'lastSentAt', 'expiresAt', 'sentAt', 'resendAvailableAt', 'correlationId']);
    for (const { path, type } of collectKeys(schema)) {
      if (type === 'string') expect(allowedStrings, path.join('.')).toContain(path[path.length - 1]);
    }
  });
  it('lists every key of the detail view (so a new field must be reviewed here)', () => {
    const names = [...new Set(collectKeys(AccountEmailResponse).map((k) => k.path[k.path.length - 1]))].sort();
    expect(names).toEqual([
      'attemptsRemaining',
      'codeLength',
      'correlationId',
      'data',
      'emailVerificationStatus',
      'expiresAt',
      'lastSentAt',
      'maskedEmail',
      'meta',
      'pending',
      'primary',
      'purpose',
      'resendAvailableAt',
      'source',
      'status',
      'validityMinutes',
      'verifiedAt',
    ]);
  });
  it('lists every key of the send, set and verified views (so a new field must be reviewed here)', () => {
    const names = [
      ...new Set([EmailVerificationSentDto, SetEmailResultDto, EmailVerifiedDto].flatMap((s) => collectKeys(s).map((k) => k.path[k.path.length - 1]!))),
    ].sort();
    expect(names).toEqual([
      'changed',
      'codeLength',
      'email',
      'emailVerificationStatus',
      'expiresAt',
      'lastSentAt',
      'maskedEmail',
      'pending',
      'primary',
      'purpose',
      'resendAvailableAt',
      'sentAt',
      'source',
      'status',
      'validityMinutes',
      'verifiedAt',
    ]);
  });
  it('the key walker finds a nested sensitive key (guards the guard)', () => {
    const probe = collectKeys(AccountEmailSummaryDto.extend({ nested: AccountEmailSummaryDto.extend({ codeHash: AccountEmailSummaryDto }).nullable() }));
    expect(probe.map((k) => k.path.join('.'))).toContain('nested.codeHash');
    expect(probe.some((k) => SENSITIVE_KEY.test(k.path[k.path.length - 1]!))).toBe(true);
  });
});

// ====================================================================== events
describe('EMAIL_EVENTS', () => {
  it('defines exactly the five email events', () => {
    expect(EMAIL_EVENTS).toEqual({
      contactAdded: 'bananagig.identity.email-contact-added.v1',
      verificationSent: 'bananagig.identity.email-verification-sent.v1',
      verified: 'bananagig.identity.email-verified.v1',
      verificationFailed: 'bananagig.identity.email-verification-failed.v1',
      changeRequested: 'bananagig.identity.email-change-requested.v1',
    });
  });
  it('uses event types that match the shared pattern, are unique and live in the identity domain', () => {
    const types = Object.values(EMAIL_EVENTS);
    expect(types).toHaveLength(5);
    expect(new Set(types).size).toBe(5);
    for (const t of types) {
      expect(t, t).toMatch(EVENT_TYPE_PATTERN);
      expect(t.startsWith('bananagig.identity.email-'), t).toBe(true);
      expect(t.endsWith('.v1'), t).toBe(true);
    }
  });
  it('names no address, code or token', () => {
    for (const t of Object.values(EMAIL_EVENTS)) expect(t).not.toMatch(/@|token|secret|hash/);
  });
  it('fits the event envelope with an email payload', () => {
    const envelope = {
      eventId: '0b9d0e2a-6d0b-4b8c-8f5e-0f6f3f2f9c11',
      eventType: EMAIL_EVENTS.verified,
      eventVersion: 1,
      occurredAt: ISO,
      correlationId: 'c-1',
      causationId: null,
      actor: { type: 'system' as const, id: 'system:email-verification' },
      aggregateType: 'identity_account',
      aggregateId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11',
      payload: { accountId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11' },
    };
    for (const eventType of Object.values(EMAIL_EVENTS)) expect(EventEnvelope.safeParse({ ...envelope, eventType }).success, eventType).toBe(true);
  });
});

const IDS = { accountId: '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11', emailContactId: 'b1d4c8d2-0a77-4e61-9a3e-6d1f9b0f4c22' };
const CHALLENGE = 'c7a8e3f1-5b2d-4d10-8e41-3a9b6c0d1e55';
const PAYLOADS: { name: string; schema: z.ZodObject; valid: Record<string, unknown>; enums: Record<string, unknown> }[] = [
  {
    name: 'EmailContactAddedPayload',
    schema: EmailContactAddedPayload,
    valid: { ...IDS, purpose: 'INITIAL_EMAIL', source: 'USER_ENTERED', status: 'PENDING' },
    enums: { purpose: 'OTHER', source: 'GOOGLE', status: 'ACTIVE' },
  },
  {
    name: 'EmailVerificationSentPayload',
    schema: EmailVerificationSentPayload,
    valid: { ...IDS, challengeId: CHALLENGE, purpose: 'CHANGE_EMAIL', expiresAt: ISO_LATER },
    enums: { purpose: 'OTHER' },
  },
  {
    name: 'EmailVerifiedPayload',
    schema: EmailVerifiedPayload,
    valid: { ...IDS, purpose: 'CHANGE_EMAIL', source: 'IDP_VERIFIED', method: 'IDP', replacedEmailContactId: 'd0e1f2a3-b4c5-4d6e-8f70-819293a4b5c6' },
    enums: { purpose: 'OTHER', source: 'GOOGLE', method: 'SMS' },
  },
  {
    name: 'EmailVerificationFailedPayload',
    schema: EmailVerificationFailedPayload,
    valid: { ...IDS, challengeId: CHALLENGE, attemptCount: 3, locked: false },
    enums: {},
  },
  {
    name: 'EmailChangeRequestedPayload',
    schema: EmailChangeRequestedPayload,
    valid: { accountId: IDS.accountId, emailContactId: IDS.emailContactId, replacesEmailContactId: 'd0e1f2a3-b4c5-4d6e-8f70-819293a4b5c6' },
    enums: {},
  },
];

describe('email event payloads', () => {
  it.each(PAYLOADS)('$name accepts a valid payload unchanged', ({ schema, valid }) => {
    expect(schema.parse(valid)).toEqual(valid);
  });
  it('EmailVerifiedPayload accepts every method, a null replaced contact and both sources', () => {
    const base = PAYLOADS[2]!.valid;
    for (const method of ['CODE', 'LINK', 'IDP']) expect(EmailVerifiedPayload.safeParse({ ...base, method }).success, method).toBe(true);
    expect(EmailVerifiedPayload.safeParse({ ...base, replacedEmailContactId: null }).success).toBe(true);
    for (const source of EMAIL_SOURCES) expect(EmailVerifiedPayload.safeParse({ ...base, source }).success, source).toBe(true);
  });
  it('EmailVerificationFailedPayload accepts a locked attempt', () => {
    expect(EmailVerificationFailedPayload.safeParse({ ...PAYLOADS[3]!.valid, attemptCount: 5, locked: true }).success).toBe(true);
  });
  const missing = PAYLOADS.flatMap(({ name, schema, valid }) => Object.keys(valid).map((key) => [name, key, schema, valid] as const));
  it.each(missing)('%s requires %s', (_name, key, schema, valid) => {
    const { [key]: _dropped, ...rest } = valid;
    expect(schema.safeParse(rest).success).toBe(false);
  });
  const wrongEnums = PAYLOADS.flatMap(({ name, schema, valid, enums }) =>
    Object.entries(enums).map(([key, value]) => [name, key, value, schema, valid] as const),
  );
  it.each(wrongEnums)('%s refuses %s = %j', (_name, key, value, schema, valid) => {
    expect(schema.safeParse({ ...valid, [key]: value }).success).toBe(false);
  });
  it('rejects a numeric id, a string attempt count and a non-boolean locked flag', () => {
    expect(EmailContactAddedPayload.safeParse({ ...PAYLOADS[0]!.valid, accountId: 5 }).success).toBe(false);
    expect(EmailVerificationFailedPayload.safeParse({ ...PAYLOADS[3]!.valid, attemptCount: '3' }).success).toBe(false);
    expect(EmailVerificationFailedPayload.safeParse({ ...PAYLOADS[3]!.valid, attemptCount: 1.5 }).success).toBe(false);
    expect(EmailVerificationFailedPayload.safeParse({ ...PAYLOADS[3]!.valid, locked: 'yes' }).success).toBe(false);
    expect(EmailVerifiedPayload.safeParse({ ...PAYLOADS[2]!.valid, replacedEmailContactId: undefined }).success).toBe(false);
  });
  it.each(PAYLOADS)('$name drops a smuggled address, code, token or hash instead of carrying it', ({ schema, valid }) => {
    const parsed = schema.parse({
      ...valid,
      email: 'ana@example.com',
      maskedEmail: 'a***@e***.com',
      code: '123456',
      token: TOKEN_43,
      hash: 'abc',
      codeHash: 'abc',
    });
    expect(parsed).toEqual(valid);
  });
  it.each(PAYLOADS)('$name has identifier keys only: no key names an address, a code, a token or a hash', ({ schema }) => {
    for (const key of Object.keys(schema.shape)) {
      expect(key, key).not.toMatch(/hash|secret|token|digest|password|otp|normalized|masked/i);
      expect(key, key).not.toMatch(/^(email|address|emailAddress|code|verificationCode)$/);
    }
  });
  it('carries the identifiers and the small facts the consumers need, nothing more', () => {
    const keys = [...new Set(PAYLOADS.flatMap((p) => Object.keys(p.schema.shape)))].sort();
    expect(keys).toEqual([
      'accountId',
      'attemptCount',
      'challengeId',
      'emailContactId',
      'expiresAt',
      'locked',
      'method',
      'purpose',
      'replacedEmailContactId',
      'replacesEmailContactId',
      'source',
      'status',
    ]);
  });
});

// ====================================================================== error codes
describe('EMAIL_ERROR_CODES', () => {
  it('lists the twelve email error codes', () => {
    expect([...EMAIL_ERROR_CODES]).toEqual([
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
    ]);
  });
  it('has unique EMAIL_ prefixed upper-case codes usable as the ACCOUNT_<code> API error code suffix', () => {
    expect(new Set(EMAIL_ERROR_CODES).size).toBe(EMAIL_ERROR_CODES.length);
    for (const c of EMAIL_ERROR_CODES) {
      expect(c, c).toMatch(/^EMAIL_[A-Z]+(_[A-Z]+)*$/);
      expect(`ACCOUNT_${c}`, c).toMatch(/^ACCOUNT_[A-Z][A-Z_]*$/);
    }
  });
  it('names no address, code or token', () => {
    for (const c of EMAIL_ERROR_CODES) expect(c).not.toMatch(/@|HASH|SECRET/);
  });
});
