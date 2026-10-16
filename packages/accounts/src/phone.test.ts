// Unit tests of canonicalizePhone (ID-003): country-aware phone input in, E.164 out. The numbering rules come from libphonenumber-js; these tests pin the
// BananaGig policy around it: the allowed alphabet, NFKC normalization, the typed refusal codes (never the rejected value), the country resolved FROM THE
// NUMBER, idempotence on the output, and the absence of any hardcoded calling code or custom dialing table in the source. No database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { E164_PATTERN, PHONE_INPUT_MAX_LENGTH } from '@bananagig/contracts';
import { canonicalizePhone } from './phone';

const ok = (e164: string, countryCode: string, callingCode: string) => ({ ok: true as const, e164, countryCode, callingCode });
const fail = (code: string) => ({ ok: false as const, code });

// full-width and other compatibility forms, built from code points (never from escape sequences)
const fullWidthDigits = (s: string): string => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d)));
const FW_PLUS = String.fromCodePoint(0xff0b);
const FW_SPACE = String.fromCodePoint(0x3000);
const FW_LPAREN = String.fromCodePoint(0xff08);
const FW_RPAREN = String.fromCodePoint(0xff09);
const FW_DASH = String.fromCodePoint(0xff0d);
const FW_DOT = String.fromCodePoint(0xff0e);
const NBSP = String.fromCodePoint(0xa0);
const NUL = String.fromCodePoint(0);

// ====================================================================== national formats of a US number, default country US
describe('canonicalizePhone: national formats read in the default country', () => {
  const US_OK = ok('+12025550142', 'US', '1');
  it.each([
    '(202) 555-0142',
    '(202)555-0142',
    '(202) 5550142',
    '202-555-0142',
    '202.555.0142',
    '202 555 0142',
    '202 555-0142',
    '202-555.0142',
    '2025550142',
    '12025550142',
    '1 202 555 0142',
    '1-202-555-0142',
    '1 (202) 555-0142',
    '1.202.555.0142',
    '1(202)555-0142',
    '  (202) 555-0142  ',
    '   2025550142',
    '2025550142   ',
    '(202)   555   0142',
    '202 - 555 - 0142',
  ])('reads %j in US as +12025550142', (raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(US_OK);
  });

  it('is the same result for every national spelling of the same number', () => {
    const spellings = ['(202) 555-0142', '202-555-0142', '202.555.0142', '2025550142', '1 202 555 0142'];
    const results = spellings.map((s) => canonicalizePhone(s, 'US'));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it.each([
    ['(202) 555-0100', '+12025550100'],
    ['(202) 555-0199', '+12025550199'],
    ['(202) 555-0901', '+12025550901'],
    ['(202) 555-0902', '+12025550902'],
    ['(202) 555-0903', '+12025550903'],
    ['(202) 555-0904', '+12025550904'],
    ['(202) 555-0905', '+12025550905'],
    ['(212) 555-0123', '+12125550123'],
    ['(310) 555-0123', '+13105550123'],
    ['(415) 555-0132', '+14155550132'],
    ['(800) 555-0199', '+18005550199'],
    ['(888) 555-0199', '+18885550199'],
  ])('reads the other US test number %s as %s', (raw, e164) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(ok(e164, 'US', '1'));
  });
});

// ====================================================================== international formats
describe('canonicalizePhone: international formats need no country', () => {
  it.each([
    '+1 202 555 0142',
    '+12025550142',
    '+1(202)555-0142',
    '+1 (202) 555-0142',
    '+1-202-555-0142',
    '+1.202.555.0142',
    '+1 202-555-0142',
    '  +1 202 555 0142  ',
    '+ 1 202 555 0142',
    '+1  202  555  0142',
    '+1 (202)-555-0142',
  ])('reads %j without a default country', (raw) => {
    expect(canonicalizePhone(raw)).toEqual(ok('+12025550142', 'US', '1'));
  });

  it.each([undefined, 'US', 'GB', 'CA', 'DE', 'XX', 'us', 'USA', ''])('ignores the default country %j for an international number', (country) => {
    expect(canonicalizePhone('+1 202 555 0142', country)).toEqual(ok('+12025550142', 'US', '1'));
    expect(canonicalizePhone('+44 20 7946 0958', country)).toEqual(ok('+442079460958', 'GB', '44'));
  });
});

// ====================================================================== Unicode and whitespace
describe('canonicalizePhone: NFKC normalization and trimming', () => {
  it.each([
    ['full-width digits', fullWidthDigits('2025550142')],
    ['full-width digits with a full-width space after the area code', `${fullWidthDigits('202')}${FW_SPACE}${fullWidthDigits('5550142')}`],
    ['full-width parentheses and dash', `${FW_LPAREN}${fullWidthDigits('202')}${FW_RPAREN}${fullWidthDigits('555')}${FW_DASH}${fullWidthDigits('0142')}`],
    ['full-width dots', `${fullWidthDigits('202')}${FW_DOT}${fullWidthDigits('555')}${FW_DOT}${fullWidthDigits('0142')}`],
    ['ideographic spaces around the digits', `${FW_SPACE}2025550142${FW_SPACE}`],
    ['no-break spaces inside', `202${NBSP}555${NBSP}0142`],
    ['a no-break space at both ends', `${NBSP}(202) 555-0142${NBSP}`],
    ['ASCII spaces at both ends', '   2025550142   '],
  ])('reads %s in US', (_label, raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(ok('+12025550142', 'US', '1'));
  });

  it.each([
    ['a full-width plus and full-width digits', `${FW_PLUS}${fullWidthDigits('12025550142')}`],
    ['a full-width plus and ASCII digits', `${FW_PLUS}12025550142`],
    [
      'a full-width plus with full-width spaces',
      `${FW_PLUS}${fullWidthDigits('1')}${FW_SPACE}${fullWidthDigits('202')}${FW_SPACE}${fullWidthDigits('5550142')}`,
    ],
    ['an ASCII plus and full-width digits', `+${fullWidthDigits('12025550142')}`],
  ])('reads %s as an international number', (_label, raw) => {
    expect(canonicalizePhone(raw)).toEqual(ok('+12025550142', 'US', '1'));
  });

  it('trims the surrounding whitespace of an international number that is padded with no-break spaces', () => {
    expect(canonicalizePhone(`${NBSP}+12025550142${NBSP}`)).toEqual(ok('+12025550142', 'US', '1'));
  });

  it('keeps the E.164 output free of every formatting character', () => {
    const inputs = [
      '(202) 555-0142',
      '+1 (202) 555-0142',
      fullWidthDigits('2025550142'),
      `${FW_LPAREN}202${FW_RPAREN}${FW_SPACE}555${FW_DASH}0142`,
      '202.555.0142',
    ];
    for (const raw of inputs) {
      const r = canonicalizePhone(raw, 'US');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.e164).toMatch(E164_PATTERN);
        expect(r.e164).toMatch(/^\+[0-9]+$/);
        expect(r.e164).not.toMatch(/[\s().-]/);
      }
    }
  });
});

// ====================================================================== other countries
describe('canonicalizePhone: other countries', () => {
  it.each([
    ['+44 20 7946 0958', undefined, '+442079460958', 'GB', '44'],
    ['+442079460958', undefined, '+442079460958', 'GB', '44'],
    ['020 7946 0958', 'GB', '+442079460958', 'GB', '44'],
    ['(020) 7946 0958', 'GB', '+442079460958', 'GB', '44'],
    ['02079460958', 'GB', '+442079460958', 'GB', '44'],
    ['+44 20 7946 0958', 'US', '+442079460958', 'GB', '44'],
    ['+49 30 901820', undefined, '+4930901820', 'DE', '49'],
    ['+33 1 23 45 67 89', undefined, '+33123456789', 'FR', '33'],
    ['01 23 45 67 89', 'FR', '+33123456789', 'FR', '33'],
    ['+61 2 9374 4000', undefined, '+61293744000', 'AU', '61'],
    ['(02) 9374 4000', 'AU', '+61293744000', 'AU', '61'],
    ['+81 3 1234 5678', undefined, '+81312345678', 'JP', '81'],
    ['+91 98765 43210', undefined, '+919876543210', 'IN', '91'],
    ['098765 43210', 'IN', '+919876543210', 'IN', '91'],
    ['+52 55 1234 5678', undefined, '+525512345678', 'MX', '52'],
    ['+7 495 123 45 67', undefined, '+74951234567', 'RU', '7'],
    ['+65 6123 4567', undefined, '+6561234567', 'SG', '65'],
    ['6123 4567', 'SG', '+6561234567', 'SG', '65'],
    ['+55 11 91234 5678', undefined, '+5511912345678', 'BR', '55'],
    ['+1 242 555 0123', undefined, '+12425550123', 'BS', '1'],
    ['+1 876 555 0123', undefined, '+18765550123', 'JM', '1'],
  ])('reads %j (default %j) as %s in %s with calling code %s', (raw, country, e164, countryCode, callingCode) => {
    expect(canonicalizePhone(raw, country)).toEqual(ok(e164, countryCode, callingCode));
  });

  it('reads the same national number in the country named, not in another one', () => {
    expect(canonicalizePhone('020 7946 0958', 'GB')).toEqual(ok('+442079460958', 'GB', '44'));
    expect(canonicalizePhone('020 7946 0958', 'US')).toEqual(fail('INVALID_NUMBER'));
  });
});

// ====================================================================== shared calling code: the country is resolved from the number
describe('canonicalizePhone: +1 numbers resolve their own country', () => {
  it.each([
    ['+1 416 555 0123', '+14165550123'],
    ['+1 416 555 0199', '+14165550199'],
    ['+1 604 555 0123', '+16045550123'],
    ['+1 514 555 0123', '+15145550123'],
    ['+1 416 234 5678', '+14162345678'],
  ])('resolves %s to CA although the default country is US', (raw, e164) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(ok(e164, 'CA', '1'));
    expect(canonicalizePhone(raw)).toEqual(ok(e164, 'CA', '1'));
  });

  it('resolves a Canadian number written nationally with the default country US to CA (the number decides)', () => {
    expect(canonicalizePhone('(416) 555-0123', 'US')).toEqual(ok('+14165550123', 'CA', '1'));
    expect(canonicalizePhone('416-555-0123', 'CA')).toEqual(ok('+14165550123', 'CA', '1'));
  });

  it('resolves the US number to US even when the default country is CA', () => {
    expect(canonicalizePhone('+1 202 555 0142', 'CA')).toEqual(ok('+12025550142', 'US', '1'));
    expect(canonicalizePhone('(202) 555-0142', 'CA')).toEqual(ok('+12025550142', 'US', '1'));
  });

  it('keeps the calling code of the number, which is the one geography must match', () => {
    const us = canonicalizePhone('+12025550142');
    const ca = canonicalizePhone('+14165550123');
    expect(us.ok && ca.ok && us.callingCode === ca.callingCode).toBe(true);
    expect(us.ok && ca.ok && us.countryCode !== ca.countryCode).toBe(true);
  });
});

// ====================================================================== idempotence
describe('canonicalizePhone: idempotent on its own output', () => {
  it.each([
    ['(202) 555-0142', 'US'],
    ['+1 202 555 0142', undefined],
    ['+44 20 7946 0958', undefined],
    ['020 7946 0958', 'GB'],
    ['+1 416 555 0123', undefined],
    ['+49 30 901820', undefined],
    ['+91 98765 43210', undefined],
    [fullWidthDigits('2025550142'), 'US'],
    ['+61 2 9374 4000', undefined],
    ['+55 11 91234 5678', undefined],
  ])('canonicalizing the result of %j again gives the same result', (raw, country) => {
    const first = canonicalizePhone(raw, country);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(canonicalizePhone(first.e164)).toEqual(first);
    expect(canonicalizePhone(first.e164, 'US')).toEqual(first);
    expect(canonicalizePhone(first.e164, 'GB')).toEqual(first);
    expect(canonicalizePhone(first.e164, 'XX')).toEqual(first);
  });
});

// ====================================================================== REQUIRED
describe('canonicalizePhone: REQUIRED', () => {
  it.each([
    ['an empty string', ''],
    ['one space', ' '],
    ['several spaces', '     '],
    ['a no-break space', NBSP],
    ['an ideographic space', FW_SPACE],
    ['mixed Unicode spaces', ` ${NBSP}${FW_SPACE} `],
    ['undefined', undefined],
    ['null', null],
    ['a number', 2025550142],
    ['a bigint', BigInt(2025550142)],
    ['true', true],
    ['false', false],
    ['an object', {}],
    ['an object with a toString', { toString: () => '+12025550142' }],
    ['an array', ['+12025550142']],
    ['an empty array', []],
    ['a function', () => '+12025550142'],
    ['NaN', Number.NaN],
    ['a symbol', Symbol('phone')],
    ['a String object', Object('+12025550142')],
  ])('refuses %s with REQUIRED', (_label, raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(fail('REQUIRED'));
    expect(canonicalizePhone(raw)).toEqual(fail('REQUIRED'));
  });
});

// ====================================================================== TOO_LONG
describe('canonicalizePhone: TOO_LONG', () => {
  it('uses the length limit of the contract (64)', () => {
    expect(PHONE_INPUT_MAX_LENGTH).toBe(64);
  });
  it.each([
    ['65 digits', '1'.repeat(65)],
    ['65 spaces', ' '.repeat(65)],
    ['a valid number padded with spaces beyond the limit', `${' '.repeat(60)}+12025550142`],
    ['a long international number', `+${'1'.repeat(PHONE_INPUT_MAX_LENGTH)}`],
    ['65 letters (length wins over the alphabet)', 'a'.repeat(65)],
    ['1000 characters', '2'.repeat(1000)],
    ['100000 characters', '9'.repeat(100_000)],
  ])('refuses %s with TOO_LONG', (_label, raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(fail('TOO_LONG'));
    expect(canonicalizePhone(raw)).toEqual(fail('TOO_LONG'));
  });
  it('accepts a 64-character input that is otherwise valid', () => {
    const raw = `${' '.repeat(49)}+1 202 555 0142`;
    expect(raw).toHaveLength(PHONE_INPUT_MAX_LENGTH);
    expect(raw.length).toBeLessThanOrEqual(PHONE_INPUT_MAX_LENGTH);
    expect(canonicalizePhone(raw)).toEqual(ok('+12025550142', 'US', '1'));
    const exactly64 = `${' '.repeat(PHONE_INPUT_MAX_LENGTH - 12)}+12025550142`;
    expect(exactly64).toHaveLength(PHONE_INPUT_MAX_LENGTH);
    expect(canonicalizePhone(exactly64)).toEqual(ok('+12025550142', 'US', '1'));
  });
  it('refuses the 65th character', () => {
    expect(canonicalizePhone(`${' '.repeat(PHONE_INPUT_MAX_LENGTH - 11)}+12025550142`)).toEqual(fail('TOO_LONG'));
  });
});

// ====================================================================== INVALID_CHARACTERS
describe('canonicalizePhone: INVALID_CHARACTERS', () => {
  it.each([
    ['letters', '202 555 CALL'],
    ['all letters', 'abcdefghij'],
    ['a vanity number', '1-800-FLOWERS'],
    ['the word ext', '+1 202 555 0142 ext 5'],
    ['ext with a dot', '202 555 0142 ext. 5'],
    ['an x extension', '+1 202 555 0142 x12'],
    ['an upper-case X extension', '+1 202 555 0142 X12'],
    ['a hash', '#2025550142'],
    ['a trailing hash', '2025550142#'],
    ['an asterisk', '*2025550142'],
    ['an asterisk inside', '202*555*0142'],
    ['an at sign', '2025550142@example.test'],
    ['an email address', 'ana@example.test'],
    ['a plus in the middle', '1+2025550142'],
    ['a plus at the end', '2025550142+'],
    ['a plus after a space', '+1 +2025550142'],
    ['a plus after the area code', '+1 202+5550142'],
    ['a double plus', '++12025550142'],
    ['a double plus with a space', '+ +12025550142'],
    ['a triple plus', '+++12025550142'],
    ['a comma', '202,555,0142'],
    ['a semicolon', '+12025550142;ext=5'],
    ['a pause character', '+1 202 555 0142,5'],
    ['a slash', '202/555/0142'],
    ['an underscore', '202_555_0142'],
    ['a colon', 'tel:+12025550142'],
    ['a tel URI', 'tel:2025550142'],
    ['a dollar sign', '$2025550142'],
    ['a percent sign', '202%20555%200142'],
    ['a question mark', '+1202555014?'],
    ['an apostrophe', "202'555'0142"],
    ['a quote', '"2025550142"'],
    ['a backslash', '202\\5550142'],
    ['square brackets', '[202] 555-0142'],
    ['curly brackets', '{202} 555-0142'],
    ['angle brackets', '<2025550142>'],
    ['a pipe', '202|555|0142'],
    ['an equals sign', '=2025550142'],
    ['a minus-sign character (U+2212)', `202${String.fromCodePoint(0x2212)}555${String.fromCodePoint(0x2212)}0142`],
    ['an en dash', `202${String.fromCodePoint(0x2013)}555${String.fromCodePoint(0x2013)}0142`],
    ['an em dash', `202${String.fromCodePoint(0x2014)}555${String.fromCodePoint(0x2014)}0142`],
    ['a zero-width space', `202${String.fromCodePoint(0x200b)}5550142`],
    ['a zero-width joiner', `202${String.fromCodePoint(0x200d)}5550142`],
    ['a word joiner', `202${String.fromCodePoint(0x2060)}5550142`],
    ['a byte order mark inside', `202${String.fromCodePoint(0xfeff)}5550142`],
    ['Arabic-Indic digits (NFKC keeps them non-ASCII)', String.fromCodePoint(0x0662, 0x0660, 0x0662, 0x0665, 0x0665, 0x0665, 0x0660, 0x0661, 0x0664, 0x0662)],
    ['Devanagari digits', String.fromCodePoint(0x0968, 0x0966, 0x0968, 0x096b, 0x096b, 0x096b, 0x0966, 0x0967, 0x096a, 0x0968)],
    ['an emoji', `2025550142${String.fromCodePoint(0x1f600)}`],
    ['an emoji keycap', `2${String.fromCodePoint(0xfe0f, 0x20e3)}025550142`],
    ['a Latin letter O instead of zero', '2O25550142'],
    ['a lower-case L instead of one', '+l2025550142'],
    ['a superscript-looking letter', 'x2025550142'],
  ])('refuses %s', (_label, raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(fail('INVALID_CHARACTERS'));
    expect(canonicalizePhone(raw)).toEqual(fail('INVALID_CHARACTERS'));
  });

  it.each([
    ['a line feed at the end', '+12025550142\n'],
    ['a line feed at the start', '\n+12025550142'],
    ['a carriage return', '+12025550142\r'],
    ['CR LF', '+12025550142\r\n'],
    ['a line feed inside', '+1202\n5550142'],
    ['a tab', '+1202\t5550142'],
    ['a leading tab', '\t2025550142'],
    ['a vertical tab', '2025550142\v'],
    ['a form feed', '2025550142\f'],
    ['a NUL at the end', `2025550142${NUL}`],
    ['a NUL at the start', `${NUL}2025550142`],
    ['a NUL inside', `202${NUL}5550142`],
    ['a bell character', '2025550142\x07'],
    ['an escape character', '\x1b2025550142'],
    ['a DEL character', '2025550142\x7f'],
    ['a C1 control character (U+0085)', `2025550142${String.fromCodePoint(0x85)}`],
    ['a C1 control character (U+009F)', `${String.fromCodePoint(0x9f)}2025550142`],
    ['a right-to-left override', `${String.fromCodePoint(0x202e)}2025550142`],
    ['a left-to-right override', `${String.fromCodePoint(0x202d)}2025550142`],
    ['a left-to-right embedding', `${String.fromCodePoint(0x202a)}2025550142`],
    ['a pop directional formatting', `2025550142${String.fromCodePoint(0x202c)}`],
    ['a right-to-left isolate', `${String.fromCodePoint(0x2067)}2025550142${String.fromCodePoint(0x2069)}`],
    ['a left-to-right isolate', `${String.fromCodePoint(0x2066)}2025550142`],
    ['a first-strong isolate', `${String.fromCodePoint(0x2068)}2025550142`],
    ['an unpaired high surrogate', `2025550142${String.fromCharCode(0xd83d)}`],
    ['an unpaired low surrogate', `${String.fromCharCode(0xde00)}2025550142`],
  ])('refuses %s as a control or bidirectional character', (_label, raw) => {
    expect(canonicalizePhone(raw, 'US')).toEqual(fail('INVALID_CHARACTERS'));
    expect(canonicalizePhone(raw)).toEqual(fail('INVALID_CHARACTERS'));
  });

  it('checks the alphabet before the country, so a letter in a national number is INVALID_CHARACTERS even without a default country', () => {
    expect(canonicalizePhone('202 555 CALL')).toEqual(fail('INVALID_CHARACTERS'));
  });
  it('does not let an extension marker through: the same number with and without x12', () => {
    expect(canonicalizePhone('+12025550142')).toEqual(ok('+12025550142', 'US', '1'));
    expect(canonicalizePhone('+12025550142 x12')).toEqual(fail('INVALID_CHARACTERS'));
    expect(canonicalizePhone('+12025550142x12')).toEqual(fail('INVALID_CHARACTERS'));
  });
});

// ====================================================================== COUNTRY_REQUIRED / COUNTRY_NOT_SUPPORTED
describe('canonicalizePhone: COUNTRY_REQUIRED', () => {
  it.each(['2025550142', '(202) 555-0142', '202-555-0142', '12025550142', '1 202 555 0142', '020 7946 0958', fullWidthDigits('2025550142'), '0'])(
    'refuses the national number %j without a default country',
    (raw) => {
      expect(canonicalizePhone(raw)).toEqual(fail('COUNTRY_REQUIRED'));
      expect(canonicalizePhone(raw, undefined)).toEqual(fail('COUNTRY_REQUIRED'));
    },
  );
});

describe('canonicalizePhone: COUNTRY_NOT_SUPPORTED', () => {
  it.each([
    ['a lower-case code', 'us'],
    ['a mixed-case code', 'Us'],
    ['an alpha-3 code', 'USA'],
    ['a numeric code', '840'],
    ['an empty string', ''],
    ['a space', ' '],
    ['one letter', 'U'],
    ['a code with a space', 'U S'],
    ['a code with a trailing space', 'US '],
    ['digits', '12'],
    ['a long name', 'United States'],
  ])('refuses %s as the default country of a national number', (_label, country) => {
    expect(canonicalizePhone('2025550142', country)).toEqual(fail('COUNTRY_NOT_SUPPORTED'));
  });

  it('refuses a shape-valid ISO code that no numbering plan knows (XX)', () => {
    // contract: unknown/invalid default country => COUNTRY_NOT_SUPPORTED
    expect(canonicalizePhone('2025550142', 'XX')).toEqual(fail('COUNTRY_NOT_SUPPORTED'));
  });
  it.each(['ZZ', 'QQ'])('refuses the shape-valid but unassigned code %s (a typed COUNTRY_NOT_SUPPORTED, not INVALID_NUMBER)', (country) => {
    expect(canonicalizePhone('2025550142', country)).toEqual(fail('COUNTRY_NOT_SUPPORTED'));
  });

  it.each([['+800 1234 5678'], ['+800 1234 5679'], ['+800 0000 0000'], ['+800 1111 1111'], ['+882 1234 5678'], ['+883 5100 0000 00'], ['+979 1234 5678']])(
    'refuses the non-geographic number %s',
    (raw) => {
      const result = canonicalizePhone(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['COUNTRY_NOT_SUPPORTED', 'INVALID_NUMBER']).toContain(result.code);
    },
  );
  it('answers COUNTRY_NOT_SUPPORTED for a valid non-geographic +800 number', () => {
    expect(canonicalizePhone('+800 1234 5678')).toEqual(fail('COUNTRY_NOT_SUPPORTED'));
    expect(canonicalizePhone('+800 1234 5678', 'US')).toEqual(fail('COUNTRY_NOT_SUPPORTED'));
  });
});

// ====================================================================== INVALID_NUMBER
describe('canonicalizePhone: INVALID_NUMBER', () => {
  it.each([
    ['+1 202 555', 'too short'],
    ['+1 2', 'a single digit after the calling code'],
    ['+12', 'a calling code alone'],
    ['+1', 'a plus and one digit'],
    ['+0', 'a plus and zero'],
    ['+1 202 555 0142 123', 'too long'],
    ['+1 202 555 0142 1234 5678', 'much too long'],
    ['+1 555 555 0100', 'valid shape but an area code that does not exist in the plan'],
    ['+1 111 555 0100', 'an impossible area code'],
    ['+1 000 555 0100', 'a zero area code'],
    ['+1 202 055 0142', 'an exchange that cannot start with zero'],
    ['+1 202 155 0142', 'an exchange that cannot start with one'],
    ['+1 911 555 0142', 'an area code that is a service code'],
    ['+99 123 456 789', 'an unassigned calling code'],
    ['+999 123 456 7890', 'an unassigned three-digit calling code'],
    ['+44 20 7946', 'a UK number that is too short'],
    ['+44 99 7946 0958', 'a UK number with an unassigned area code'],
    ['+49 1', 'a German number with no subscriber digits'],
    ['0000000000', 'only zeros (read in US)'],
    ['(000) 000-0000', 'only zeros with formatting'],
    ['1111111111', 'only ones (read in US)'],
    ['12', 'two digits (read in US)'],
    ['0', 'one zero (read in US)'],
    ['-', 'only a dash'],
    ['()', 'only parentheses'],
    ['...', 'only dots'],
    ['- - -', 'dashes and spaces'],
    ['+ - ( )', 'a plus and punctuation'],
  ])('refuses %j (%s)', (raw) => {
    const result = canonicalizePhone(raw, 'US');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['INVALID_NUMBER']).toContain(result.code);
  });

  it('refuses a lone plus sign as INVALID_CHARACTERS (no digit at all)', () => {
    expect(canonicalizePhone('+', 'US')).toEqual(fail('INVALID_CHARACTERS'));
    expect(canonicalizePhone('+')).toEqual(fail('INVALID_CHARACTERS'));
  });
  it('trims a leading or trailing byte order mark as whitespace (String.prototype.trim) and still returns the canonical number only', () => {
    expect(canonicalizePhone(`${String.fromCodePoint(0xfeff)}2025550142`, 'US')).toEqual(ok('+12025550142', 'US', '1'));
  });
  it('refuses a number that is valid in its country but has an extension, as INVALID_CHARACTERS before it can reach the parser', () => {
    expect(canonicalizePhone('+12025550142 ext 99')).toEqual(fail('INVALID_CHARACTERS'));
  });
  it('reads a national number in the wrong country as INVALID_NUMBER', () => {
    expect(canonicalizePhone('020 7946 0958', 'US')).toEqual(fail('INVALID_NUMBER'));
    expect(canonicalizePhone('2025550142', 'GB')).toEqual(fail('INVALID_NUMBER'));
  });
  it('refuses a dash-only or punctuation-only input with a typed code and no throw', () => {
    for (const raw of ['-', '.', '()', '+-', '+()', ' - ']) expect(() => canonicalizePhone(raw, 'US')).not.toThrow();
  });
});

// ====================================================================== the result never echoes the input
describe('canonicalizePhone: results carry codes and canonical values only', () => {
  const refused: [string, string | undefined][] = [
    ['555123 abc', 'US'],
    ['+1 555 555 0100', undefined],
    ['+1 202 555', undefined],
    ['2025550142', undefined],
    ['9876 5432 1098', 'US'],
    ['+1 202 555 0142 x12', undefined],
    ['+1 202 555 0142 ext 5', undefined],
    ['+++123456789', undefined],
    [`${'7'.repeat(70)}`, 'US'],
    ['2025550142\n', 'US'],
  ];
  it.each(refused)('a refusal of %j contains the code only', (raw, country) => {
    const result = canonicalizePhone(raw, country);
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
    const text = JSON.stringify(result);
    const digitRun = raw.replace(/[^0-9]/g, '').slice(0, 7);
    expect(text).not.toContain(digitRun);
    expect(text).not.toContain(raw);
  });

  it.each([
    ['(202) 555-0142', 'US'],
    ['+44 20 7946 0958', undefined],
    ['+1 416 555 0123', undefined],
  ])('a success for %j has exactly the four canonical fields', (raw, country) => {
    const result = canonicalizePhone(raw, country);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['callingCode', 'countryCode', 'e164', 'ok']);
    if (result.ok) {
      expect(result.e164).toMatch(E164_PATTERN);
      expect(result.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(result.callingCode).toMatch(/^[0-9]{1,3}$/);
      expect(result.e164.startsWith(`+${result.callingCode}`)).toBe(true);
    }
  });

  it('does not throw for any of the strange inputs, and always returns an ok flag', () => {
    const strange: unknown[] = ['', ' ', '+', '0', 'a', NUL, '\n', '+1', '+1 2', 'x'.repeat(200), undefined, null, 1, {}, [], Symbol('s')];
    for (const raw of strange) {
      for (const country of [undefined, 'US', 'XX', '', 'us']) {
        const result = canonicalizePhone(raw, country);
        expect(typeof result.ok).toBe('boolean');
      }
    }
  });
});

// ====================================================================== no hardcoded dialing knowledge
describe('phone.ts source: no hardcoded calling code and no custom dialing table', () => {
  const source = readFileSync(fileURLToPath(new URL('./phone.ts', import.meta.url)), 'utf8');
  // comments describe the policy and may mention +1 as an example; only code counts
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');

  it('keeps comments out of the analysed text', () => {
    expect(code).toContain('canonicalizePhone');
    expect(code).not.toContain('Policy:');
  });
  it('contains no "+1" literal in code', () => {
    expect(code).not.toMatch(/\+\s*1(?![0-9])/);
    expect(code).not.toContain("'+1'");
    expect(code).not.toContain('"+1"');
    expect(code).not.toContain('`+1`');
  });
  it('contains no quoted calling-code digits', () => {
    expect(code).not.toMatch(/["'`]1["'`]/);
    expect(code).not.toMatch(/["'`]\+?[0-9]{1,3}["'`]/);
  });
  it('compares nothing against a numeric calling code', () => {
    expect(code).not.toMatch(/callingCode\s*[!=]==?\s*["'`0-9]/i);
    expect(code).not.toMatch(/startsWith\(\s*["'`]\+?[0-9]/);
    expect(code).not.toMatch(/slice\(\s*[0-9]+\s*(,\s*[0-9]+\s*)?\)/);
  });
  it('has no object literal or array mapping ISO countries to dialing digits', () => {
    expect(code).not.toMatch(/\b[A-Z]{2}\s*:\s*["'`]?\+?[0-9]+/);
    expect(code).not.toMatch(/\[\s*["'][A-Z]{2}["']\s*,\s*["']\+?[0-9]+["']\s*\]/);
    expect(code).not.toMatch(/new Map\(/);
    expect(code).not.toMatch(/Record<\s*string\s*,\s*string\s*>\s*=\s*\{/);
  });
  it('delegates the numbering rules to libphonenumber-js and the E.164 shape to the contracts', () => {
    expect(code).toContain("from 'libphonenumber-js/min'");
    expect(code).toContain('parsePhoneNumberFromString');
    expect(code).toContain('isValid()');
    expect(code).toContain('isE164');
  });
  it('contains no regular expression that spells an E.164 country-specific plan', () => {
    const regexes = code.match(/\/\^[^/\n]+\$\//g) ?? [];
    for (const re of regexes) expect(re, re).not.toMatch(/\\\+1|\+1/);
  });
});
