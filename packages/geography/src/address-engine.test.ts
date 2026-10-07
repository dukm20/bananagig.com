// Unit tests of the pure address engine (no database, no clock, no I/O). Every format used here is DATA: the US format mirrors the seeded one, and the
// synthetic countries prove the engine has no country-specific branch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ADDRESS_FIELD_PROPERTIES, type AddressFieldType, type AddressInput, type NormalizedAddressDto } from '@bananagig/contracts';
import {
  MAX_PATTERN_LENGTH,
  administrativeAreaMode,
  applyNormalizationRule,
  codePointLength,
  formatAddressWithFormat,
  normalizeText,
  patternProblem,
  redactAddress,
  resolveAdministrativeArea,
  templateProblem,
  validateAddressAgainstFormat,
  validateFieldValue,
  type AddressFormatField,
  type AddressFormatModel,
  type AdministrativeAreaModel,
} from './address-engine';

// ---------------------------------------------------------------- fixtures
const field = (fieldType: AddressFieldType, over: Partial<AddressFormatField> = {}): AddressFormatField => ({
  fieldType,
  displayOrder: 1,
  contentLabelKey: `address.field.${fieldType.toLowerCase()}`,
  required: false,
  maxLength: 100,
  inputType: 'TEXT',
  validationPattern: null,
  example: null,
  autocomplete: null,
  normalization: null,
  ...over,
});
const format = (countryCode: string, displayTemplate: string, fields: AddressFormatField[], over: Partial<AddressFormatModel> = {}): AddressFormatModel => ({
  addressFormatId: `format-${countryCode}`,
  countryCode,
  version: 1,
  status: 'PUBLISHED',
  displayTemplate,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  fields: fields.map((f, i) => ({ ...f, displayOrder: i + 1 })),
  ...over,
});
const area = (code: string, name: string, over: Partial<AdministrativeAreaModel> = {}): AdministrativeAreaModel => ({
  administrativeAreaId: `area-${code}`,
  code,
  name,
  type: 'STATE',
  parentCode: null,
  displayOrder: null,
  status: 'ACTIVE',
  ...over,
});

const US_TEMPLATE = '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}';
const US_FIELDS = [
  field('ADDRESS_LINE_1', { required: true, maxLength: 100, autocomplete: 'address-line1' }),
  field('ADDRESS_LINE_2', { required: false, maxLength: 100 }),
  field('LOCALITY', { required: true, maxLength: 60 }),
  field('ADMINISTRATIVE_AREA', { required: true, maxLength: 50, inputType: 'LOOKUP' }),
  field('POSTAL_CODE', { required: true, maxLength: 10, validationPattern: '^[0-9]{5}(-[0-9]{4})?$', example: '12345' }),
];
const US = format('US', US_TEMPLATE, US_FIELDS);
const US_AREAS = [
  area('CA', 'California'),
  area('NY', 'New York'),
  area('DC', 'District of Columbia', { type: 'DISTRICT' }),
  area('PR', 'Puerto Rico', { status: 'INACTIVE' }),
];
const usInput = (over: Partial<AddressInput> = {}): AddressInput => ({
  countryCode: 'US',
  addressLine1: '1600 Amphitheatre Pkwy',
  locality: 'Mountain View',
  administrativeArea: 'CA',
  postalCode: '94043',
  ...over,
});
const issuesOf = (f: AddressFormatModel, areas: readonly AdministrativeAreaModel[], input: AddressInput) =>
  validateAddressAgainstFormat(f, areas, input).issues;

// A Canada-like country: letter-digit postal codes normalized to upper case without spaces, provinces looked up.
const CA_LIKE = format('QA', '{ADDRESS_LINE_1}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}', [
  field('ADDRESS_LINE_1', { required: true }),
  field('LOCALITY', { required: true, maxLength: 60 }),
  field('ADMINISTRATIVE_AREA', { required: true, maxLength: 50, inputType: 'LOOKUP' }),
  field('POSTAL_CODE', {
    required: true,
    maxLength: 7,
    validationPattern: '[A-Z][0-9][A-Z][0-9][A-Z][0-9]',
    example: 'K1A 0B1',
    normalization: 'UPPERCASE_REMOVE_SPACES',
  }),
]);
const CA_LIKE_AREAS = [area('ON', 'Ontario', { type: 'PROVINCE' }), area('QC', 'Québec', { type: 'PROVINCE' })];

// A France-like country in a deliberately different shape: reversed order, organization, dependent locality, sorting code, free-text area.
const FR_LIKE = format('QF', '{ORGANIZATION}\n{ADDRESS_LINE_1}\n{DEPENDENT_LOCALITY}\n{POSTAL_CODE} {LOCALITY} ({ADMINISTRATIVE_AREA})\nCEDEX {SORTING_CODE}', [
  field('POSTAL_CODE', { required: true, maxLength: 6, validationPattern: '[0-9]{5}', normalization: 'REMOVE_SPACES' }),
  field('LOCALITY', { required: true, maxLength: 40 }),
  field('DEPENDENT_LOCALITY'),
  field('ADDRESS_LINE_1', { required: true }),
  field('ORGANIZATION'),
  field('SORTING_CODE', { maxLength: 2, validationPattern: '[0-9]{2}' }),
  field('ADMINISTRATIVE_AREA', { maxLength: 30, inputType: 'TEXT', normalization: 'UPPERCASE' }),
]);

// ---------------------------------------------------------------- text normalization
describe('normalizeText', () => {
  it('trims and collapses every whitespace run to one space', () => {
    expect(normalizeText('  1600   Amphitheatre\t Pkwy \n')).toBe('1600 Amphitheatre Pkwy');
    expect(normalizeText('a  b c')).toBe('a b c'); // no-break and em spaces are whitespace
  });
  it('applies Unicode NFC so equal addresses compare equal', () => {
    expect(normalizeText('Café')).toBe('Café');
    expect(normalizeText('Café')).toBe(normalizeText('Café'));
  });
  it('removes invisible characters (zero-width space, word joiner, Mongolian vowel separator, BOM)', () => {
    expect(normalizeText('Spr​ing⁠fi᠎eld﻿')).toBe('Springfield');
    expect(normalizeText('​ ⁠')).toBe('');
  });
  it('keeps the content and its case', () => {
    expect(normalizeText('Mountain View')).toBe('Mountain View');
  });
});

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('😀')).toBe(1);
    expect('😀'.length).toBe(2);
    expect(codePointLength('a😀b')).toBe(3);
    expect(codePointLength('')).toBe(0);
  });
});

describe('applyNormalizationRule', () => {
  it('applies each documented rule and leaves the value alone without one', () => {
    expect(applyNormalizationRule('k1a 0b1', 'UPPERCASE')).toBe('K1A 0B1');
    expect(applyNormalizationRule('k1a 0b1', 'REMOVE_SPACES')).toBe('k1a0b1');
    expect(applyNormalizationRule('k1a 0b1', 'UPPERCASE_REMOVE_SPACES')).toBe('K1A0B1');
    expect(applyNormalizationRule('k1a 0b1', null)).toBe('k1a 0b1');
  });
  it('is locale independent (toUpperCase, never toLocaleUpperCase)', () => {
    expect(applyNormalizationRule('straße', 'UPPERCASE')).toBe('STRASSE');
    expect(applyNormalizationRule('iı', 'UPPERCASE')).toBe('Iı'.toUpperCase());
  });
});

// ---------------------------------------------------------------- administrative areas
describe('resolveAdministrativeArea', () => {
  it('resolves by code and by name, case-insensitively and ignoring surrounding space', () => {
    expect(resolveAdministrativeArea('CA', US_AREAS)?.code).toBe('CA');
    expect(resolveAdministrativeArea('ca', US_AREAS)?.code).toBe('CA');
    expect(resolveAdministrativeArea('california', US_AREAS)?.code).toBe('CA');
    expect(resolveAdministrativeArea('  NEW   york ', US_AREAS)?.code).toBe('NY');
    expect(resolveAdministrativeArea('DISTRICT OF COLUMBIA', US_AREAS)?.code).toBe('DC');
  });
  it('folds compatibility characters and composed/decomposed accents', () => {
    expect(resolveAdministrativeArea('ＣＡ', US_AREAS)?.code).toBe('CA'); // full-width "CA"
    expect(resolveAdministrativeArea('Québec', CA_LIKE_AREAS)?.code).toBe('QC');
    expect(resolveAdministrativeArea('QUÉBEC', CA_LIKE_AREAS)?.code).toBe('QC');
  });
  it('prefers a code match over a name match', () => {
    const areas = [area('AL', 'xx'), area('XX', 'Alpha')];
    expect(resolveAdministrativeArea('xx', areas)?.code).toBe('XX');
  });
  it('never resolves an inactive area', () => {
    expect(resolveAdministrativeArea('PR', US_AREAS)).toBeNull();
    expect(resolveAdministrativeArea('puerto rico', US_AREAS)).toBeNull();
  });
  it('returns null for an unknown value', () => {
    expect(resolveAdministrativeArea('Atlantis', US_AREAS)).toBeNull();
    expect(resolveAdministrativeArea('C', US_AREAS)).toBeNull();
  });
});

describe('administrativeAreaMode', () => {
  it('is LOOKUP, FREE_TEXT or NONE depending on the format data', () => {
    expect(administrativeAreaMode(US)).toBe('LOOKUP');
    expect(administrativeAreaMode(FR_LIKE)).toBe('FREE_TEXT');
    expect(administrativeAreaMode(format('QN', '{ADDRESS_LINE_1}', [field('ADDRESS_LINE_1', { required: true })]))).toBe('NONE');
  });
});

// ---------------------------------------------------------------- validation: the US format
describe('validateAddressAgainstFormat: US format', () => {
  it('validates and normalizes a complete address', () => {
    const out = validateAddressAgainstFormat(
      US,
      US_AREAS,
      usInput({ addressLine1: '  1600   Amphitheatre  Pkwy ', administrativeArea: 'california', addressLine2: 'Suite 5' }),
    );
    expect(out.valid).toBe(true);
    expect(out.issues).toEqual([]);
    expect(out.administrativeAreaId).toBe('area-CA');
    expect(out.address).toEqual({
      countryCode: 'US',
      organization: null,
      addressLine1: '1600 Amphitheatre Pkwy',
      addressLine2: 'Suite 5',
      dependentLocality: null,
      locality: 'Mountain View',
      administrativeAreaCode: 'CA',
      administrativeAreaName: 'California',
      postalCode: '94043',
      sortingCode: null,
    });
  });
  it('treats line 2 as optional: absent, empty and whitespace-only all store null', () => {
    for (const addressLine2 of [undefined, '', '   ', '​']) {
      const out = validateAddressAgainstFormat(US, US_AREAS, usInput({ addressLine2 }));
      expect(out.valid, String(addressLine2)).toBe(true);
      expect(out.address!.addressLine2).toBeNull();
    }
  });
  it('reports every required field that is missing, in the format display order', () => {
    const out = validateAddressAgainstFormat(US, US_AREAS, { countryCode: 'US' });
    expect(out.valid).toBe(false);
    expect(out.address).toBeNull();
    expect(out.administrativeAreaId).toBeNull();
    expect(out.issues.map((i) => [i.field, i.code])).toEqual([
      ['addressLine1', 'REQUIRED'],
      ['locality', 'REQUIRED'],
      ['administrativeArea', 'REQUIRED'],
      ['postalCode', 'REQUIRED'],
    ]);
  });
  it('counts whitespace-only and invisible-only values as missing', () => {
    const issues = issuesOf(US, US_AREAS, usInput({ addressLine1: '   ', locality: '​⁠', administrativeArea: ' ' }));
    expect(issues.map((i) => [i.field, i.code])).toEqual([
      ['addressLine1', 'REQUIRED'],
      ['locality', 'REQUIRED'],
      ['administrativeArea', 'REQUIRED'],
    ]);
  });
  it('accepts a 5-digit ZIP and a ZIP+4', () => {
    expect(validateAddressAgainstFormat(US, US_AREAS, usInput({ postalCode: '94043' })).valid).toBe(true);
    const plus4 = validateAddressAgainstFormat(US, US_AREAS, usInput({ postalCode: ' 94043-1351 ' }));
    expect(plus4.valid).toBe(true);
    expect(plus4.address!.postalCode).toBe('94043-1351');
  });
  it.each(['1234', '123456', 'ABCDE', '94043-135', '94043 1351', '94043-', '9404a', '٩٤٠٤٣'])('rejects the bad ZIP %s as INVALID_FORMAT', (postalCode) => {
    const out = validateAddressAgainstFormat(US, US_AREAS, usInput({ postalCode }));
    expect(out.valid).toBe(false);
    expect(out.issues).toEqual([{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }]);
  });
  it('carries the property, the code and the message key only: never the rejected value', () => {
    const secret = 'Zq9-SECRET';
    const out = validateAddressAgainstFormat(
      US,
      US_AREAS,
      usInput({ postalCode: secret, locality: 'x'.repeat(61), addressLine1: `${secret} street\u0000`, administrativeArea: secret }),
    );
    expect(out.valid).toBe(false);
    expect(out.issues.length).toBeGreaterThanOrEqual(4);
    for (const i of out.issues) expect(Object.keys(i).sort()).toEqual(['code', 'field', 'messageKey']);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain('xxxxxxxx');
  });
  it('uses the shared address.error.<code> message key for each code', () => {
    const out = validateAddressAgainstFormat(US, US_AREAS, {
      countryCode: 'US',
      addressLine1: 'a\u0000',
      locality: 'x'.repeat(61),
      administrativeArea: 'Atlantis',
      postalCode: 'nope',
      organization: 'Acme',
    });
    expect(Object.fromEntries(out.issues.map((i) => [i.field, i.messageKey]))).toEqual({
      organization: 'address.error.unsupported_field',
      addressLine1: 'address.error.invalid_characters',
      locality: 'address.error.too_long',
      administrativeArea: 'address.error.unknown_area',
      postalCode: 'address.error.invalid_format',
    });
  });
  it('does not check the country of the input: the caller resolved the format for it', () => {
    expect(validateAddressAgainstFormat(US, US_AREAS, usInput({ countryCode: 'QQ' })).address!.countryCode).toBe('US');
  });
});

// ---------------------------------------------------------------- validation: administrative areas
describe('validateAddressAgainstFormat: administrative area lookup', () => {
  it('resolves by code, and by name case-insensitively, to the canonical code and name', () => {
    for (const administrativeArea of ['NY', 'ny', 'New York', 'new york', 'NEW YORK', ' New   York ']) {
      const out = validateAddressAgainstFormat(US, US_AREAS, usInput({ administrativeArea }));
      expect(out.valid, administrativeArea).toBe(true);
      expect(out.address).toMatchObject({ administrativeAreaCode: 'NY', administrativeAreaName: 'New York' });
      expect(out.administrativeAreaId).toBe('area-NY');
    }
  });
  it('reports UNKNOWN_AREA for a value that matches no area', () => {
    expect(issuesOf(US, US_AREAS, usInput({ administrativeArea: 'Atlantis' }))).toEqual([
      { field: 'administrativeArea', code: 'UNKNOWN_AREA', messageKey: 'address.error.unknown_area' },
    ]);
  });
  it('does not resolve an inactive area while other areas are active (UNKNOWN_AREA)', () => {
    expect(issuesOf(US, US_AREAS, usInput({ administrativeArea: 'PR' })).map((i) => i.code)).toEqual(['UNKNOWN_AREA']);
    expect(issuesOf(US, US_AREAS, usInput({ administrativeArea: 'Puerto Rico' })).map((i) => i.code)).toEqual(['UNKNOWN_AREA']);
  });
  it('reports LOOKUP_UNAVAILABLE when the country has no ACTIVE area (none at all, or all inactive)', () => {
    const expected = [{ field: 'administrativeArea', code: 'LOOKUP_UNAVAILABLE', messageKey: 'address.error.lookup_unavailable' }];
    expect(issuesOf(US, [], usInput())).toEqual(expected);
    expect(issuesOf(US, [area('PR', 'Puerto Rico', { status: 'INACTIVE' })], usInput({ administrativeArea: 'PR' }))).toEqual(expected);
  });
  it('limits the length of the lookup value before resolving it (TOO_LONG, not UNKNOWN_AREA)', () => {
    expect(issuesOf(US, US_AREAS, usInput({ administrativeArea: 'x'.repeat(51) })).map((i) => i.code)).toEqual(['TOO_LONG']);
  });
  it('ignores pattern and normalization of a lookup field: the area comes from the data', () => {
    const odd = format('QL', '{ADDRESS_LINE_1}\n{ADMINISTRATIVE_AREA}', [
      field('ADDRESS_LINE_1', { required: true }),
      field('ADMINISTRATIVE_AREA', { required: true, inputType: 'LOOKUP', validationPattern: '[0-9]+', normalization: 'REMOVE_SPACES' }),
    ]);
    const out = validateAddressAgainstFormat(odd, US_AREAS, { countryCode: 'QL', addressLine1: 'x', administrativeArea: 'New York' });
    expect(out.valid).toBe(true);
    expect(out.address!.administrativeAreaCode).toBe('NY');
  });
  it('supports a free-text area: the text (normalized) is stored as the name, no code, no area id', () => {
    const out = validateAddressAgainstFormat(FR_LIKE, [], {
      countryCode: 'QF',
      addressLine1: '12 rue X',
      postalCode: '75001',
      locality: 'Paris',
      administrativeArea: ' île  de france ',
    });
    expect(out.valid).toBe(true);
    expect(out.administrativeAreaId).toBeNull();
    expect(out.address).toMatchObject({ administrativeAreaCode: null, administrativeAreaName: 'ÎLE DE FRANCE' });
  });
  it('stores no area when the free-text area is optional and absent, and when the format has no area field', () => {
    const free = validateAddressAgainstFormat(FR_LIKE, [], { countryCode: 'QF', addressLine1: 'x', postalCode: '75001', locality: 'Paris' });
    expect(free.address).toMatchObject({ administrativeAreaCode: null, administrativeAreaName: null });
    const none = format('QN', '{ADDRESS_LINE_1}', [field('ADDRESS_LINE_1', { required: true })]);
    expect(validateAddressAgainstFormat(none, [], { countryCode: 'QN', addressLine1: 'x' }).address).toMatchObject({
      administrativeAreaCode: null,
      administrativeAreaName: null,
    });
  });
});

// ---------------------------------------------------------------- validation: characters, length, unsupported fields
describe('validateAddressAgainstFormat: text hygiene', () => {
  it('normalizes whitespace, Unicode (NFC) and invisible characters before storing', () => {
    const out = validateAddressAgainstFormat(US, US_AREAS, usInput({ addressLine1: '   12​  Rue de   Café ', locality: 'Spring⁠field' }));
    expect(out.valid).toBe(true);
    expect(out.address).toMatchObject({ addressLine1: '12 Rue de Café', locality: 'Springfield' });
  });
  it.each([
    ['a control character', 'Main\u0000St'],
    ['DEL', 'Main\u007fSt'],
    ['a C1 control', 'Main\u0085St'],
    ['a bidirectional override', 'Main‮St'],
    ['a bidirectional isolate', 'Main⁦St'],
    ['a lone high surrogate', 'Main\ud800St'],
    ['a lone low surrogate', 'Main\udc00St'],
  ])('rejects %s as INVALID_CHARACTERS', (_name, addressLine1) => {
    expect(issuesOf(US, US_AREAS, usInput({ addressLine1 }))).toEqual([
      { field: 'addressLine1', code: 'INVALID_CHARACTERS', messageKey: 'address.error.invalid_characters' },
    ]);
  });
  it('treats tabs and line breaks of a pasted value as whitespace', () => {
    const r = validateAddressAgainstFormat(US, US_AREAS, usInput({ addressLine1: '123\tMain\r\nSt ' }));
    expect(r.valid).toBe(true);
    expect(r.address?.addressLine1).toBe('123 Main St');
  });
  it('reports INVALID_CHARACTERS for an optional field and for a value that would otherwise be blank', () => {
    expect(issuesOf(US, US_AREAS, usInput({ addressLine2: 'Apt\u0000 4' })).map((i) => [i.field, i.code])).toEqual([['addressLine2', 'INVALID_CHARACTERS']]);
    expect(issuesOf(US, US_AREAS, usInput({ addressLine1: '\u0000' })).map((i) => i.code)).toEqual(['INVALID_CHARACTERS']);
  });
  it('accepts well-formed surrogate pairs (emoji, supplementary letters)', () => {
    expect(validateAddressAgainstFormat(US, US_AREAS, usInput({ addressLine1: 'Home 🏠 \u{20bb7}' })).valid).toBe(true);
  });
  it('counts TOO_LONG in code points of the normalized value', () => {
    const small = format('QS', '{ADDRESS_LINE_1}', [field('ADDRESS_LINE_1', { required: true, maxLength: 5 })]);
    const run = (addressLine1: string) => validateAddressAgainstFormat(small, [], { countryCode: 'QS', addressLine1 });
    expect(run('abcde').valid).toBe(true);
    expect(run('abcdef').issues).toEqual([{ field: 'addressLine1', code: 'TOO_LONG', messageKey: 'address.error.too_long' }]);
    expect(run('😀😀😀😀😀').valid).toBe(true); // 5 code points, 10 UTF-16 units
    expect(run('😀😀😀😀😀😀').issues[0]!.code).toBe('TOO_LONG');
    expect(run('ééééé').valid).toBe(true); // NFC first: 5 characters
    expect(run('  abcde  ').valid).toBe(true); // surrounding space is not counted
    expect(run('ab    cde').valid).toBe(false); // a collapsed run counts as one space: a b ' ' c d e = 6
  });
  it('reports UNSUPPORTED_FIELD for a property the format does not use, but not for a blank one', () => {
    const issues = issuesOf(US, US_AREAS, usInput({ organization: 'Acme', dependentLocality: 'Downtown', sortingCode: '   ', locality: 'Springfield' }));
    expect(issues).toEqual([
      { field: 'organization', code: 'UNSUPPORTED_FIELD', messageKey: 'address.error.unsupported_field' },
      { field: 'dependentLocality', code: 'UNSUPPORTED_FIELD', messageKey: 'address.error.unsupported_field' },
    ]);
  });
  it('reports an unsupported administrative area on a format without one', () => {
    const none = format('QN', '{ADDRESS_LINE_1}', [field('ADDRESS_LINE_1', { required: true })]);
    expect(issuesOf(none, [], { countryCode: 'QN', addressLine1: 'x', administrativeArea: 'CA', postalCode: '1' }).map((i) => [i.field, i.code])).toEqual([
      ['administrativeArea', 'UNSUPPORTED_FIELD'],
      ['postalCode', 'UNSUPPORTED_FIELD'],
    ]);
  });
  it('reports all problems at once (unsupported first, then the fields in format order)', () => {
    const out = validateAddressAgainstFormat(US, US_AREAS, { countryCode: 'US', sortingCode: 'x', locality: 'y'.repeat(61), postalCode: 'bad' });
    expect(out.issues.map((i) => [i.field, i.code])).toEqual([
      ['sortingCode', 'UNSUPPORTED_FIELD'],
      ['addressLine1', 'REQUIRED'],
      ['locality', 'TOO_LONG'],
      ['administrativeArea', 'REQUIRED'],
      ['postalCode', 'INVALID_FORMAT'],
    ]);
  });
});

// ---------------------------------------------------------------- validation: postal normalization (synthetic, non-US)
describe('postal code normalization (synthetic formats)', () => {
  const postal = (normalization: AddressFormatField['normalization'], validationPattern: string) =>
    format('QP', '{ADDRESS_LINE_1}\n{POSTAL_CODE}', [
      field('ADDRESS_LINE_1', { required: true }),
      field('POSTAL_CODE', { required: true, maxLength: 12, validationPattern, normalization }),
    ]);
  const run = (f: AddressFormatModel, postalCode: string) => validateAddressAgainstFormat(f, [], { countryCode: 'QP', addressLine1: 'x', postalCode });

  it('REMOVE_SPACES removes the spaces before the pattern is applied', () => {
    const f = postal('REMOVE_SPACES', '[0-9]{5}');
    expect(run(f, '123 45').address!.postalCode).toBe('12345');
    expect(run(f, ' 1 2 3 4 5 ').address!.postalCode).toBe('12345');
    expect(run(f, '123 4').valid).toBe(false);
  });
  it('UPPERCASE upper-cases but keeps spaces', () => {
    const f = postal('UPPERCASE', '[A-Z]{2}[0-9]');
    expect(run(f, 'ab1').address!.postalCode).toBe('AB1');
    expect(run(f, 'ab 1').issues.map((i) => i.code)).toEqual(['INVALID_FORMAT']);
  });
  it('UPPERCASE_REMOVE_SPACES does both (Canada-like A1A 1A1)', () => {
    expect(
      validateAddressAgainstFormat(CA_LIKE, CA_LIKE_AREAS, {
        countryCode: 'QA',
        addressLine1: 'x',
        locality: 'Ottawa',
        administrativeArea: 'on',
        postalCode: 'k1a 0b1',
      }).address!.postalCode,
    ).toBe('K1A0B1');
  });
  it('applies the pattern to the normalized value, not to what was typed', () => {
    const f = postal('UPPERCASE_REMOVE_SPACES', '[A-Z][0-9][A-Z][0-9][A-Z][0-9]');
    expect(run(f, 'k1a0b1').valid).toBe(true);
    expect(run(f, 'k1a 0b').valid).toBe(false);
  });
  it('without a rule keeps the typed case, and without a pattern accepts any value within the length', () => {
    const f = postal(null, '[A-Z]{3}');
    expect(run(f, 'abc').issues.map((i) => i.code)).toEqual(['INVALID_FORMAT']);
    const any = format('QP', '{ADDRESS_LINE_1}\n{POSTAL_CODE}', [field('ADDRESS_LINE_1', { required: true }), field('POSTAL_CODE', { maxLength: 4 })]);
    expect(run(any, 'a b').address!.postalCode).toBe('a b');
    expect(run(any, 'abcde').issues.map((i) => i.code)).toEqual(['TOO_LONG']);
  });
  it('measures the length after whitespace normalization but before the rule removes spaces', () => {
    const f = postal('REMOVE_SPACES', '[0-9]{8}');
    expect(run(f, '1234 5678    ').valid).toBe(true); // surrounding and repeated spaces are collapsed and trimmed first (9 characters)
    expect(run(f, '1 2 3 4 5 6 7 8').issues.map((i) => i.code)).toEqual(['TOO_LONG']); // 15 characters > 12, although only 8 remain after the rule
  });
});

// ---------------------------------------------------------------- patterns
describe('patternProblem', () => {
  it('accepts the seeded US postal pattern and ordinary safe patterns', () => {
    expect(patternProblem('^[0-9]{5}(-[0-9]{4})?$')).toBeNull();
    expect(patternProblem('[A-Z][0-9][A-Z][0-9][A-Z][0-9]')).toBeNull();
    expect(patternProblem('[0-9]{4}')).toBeNull();
    expect(patternProblem('[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}')).toBeNull();
    expect(patternProblem('(?<area>[A-Z]{2})-[0-9]+')).toBeNull(); // a named group is not a backreference
    expect(patternProblem('\\p{L}+')).toBeNull(); // valid with the u flag
    expect(patternProblem('\\(a+\\)+')).toBeNull(); // escaped parentheses are literals, not a repeated group
  });
  it.each([
    ['a numbered backreference', '(a)\\1'],
    ['a named backreference', '(?<x>a)\\k<x>'],
  ])('rejects %s', (_n, p) => {
    expect(patternProblem(p)).toBe('must not use backreferences');
  });
  it.each([
    ['positive lookbehind', '(?<=a)b'],
    ['negative lookbehind', '(?<!a)b'],
  ])('rejects %s', (_n, p) => {
    expect(patternProblem(p)).toBe('must not use lookbehind');
  });
  it.each(['(a+)+', '(a*)*', '(a|b*)*', '(\\d{1,3})+', '(a+){2}', '(?:a+)+', '([a-z]+)*', '(a{1,})+', '^(\\w+\\s?)*$'])(
    'rejects the nested quantifier %s',
    (p) => {
      expect(patternProblem(p)).toBe('must not repeat a group that already repeats');
    },
  );
  it('accepts a repeated group that does not itself repeat, and a repeating group that is not repeated', () => {
    expect(patternProblem('(ab){2}')).toBeNull();
    expect(patternProblem('(ab)+')).toBeNull();
    expect(patternProblem('(a+)b')).toBeNull();
    expect(patternProblem('(a+)?')).toBeNull();
  });
  it('rejects an empty pattern and one longer than 200 characters (200 is accepted)', () => {
    expect(MAX_PATTERN_LENGTH).toBe(200);
    expect(patternProblem('')).toBe('must be 1 to 200 characters');
    expect(patternProblem('a'.repeat(201))).toBe('must be 1 to 200 characters');
    expect(patternProblem('a'.repeat(200))).toBeNull();
    expect(patternProblem(undefined as unknown as string)).toBe('must be 1 to 200 characters');
    expect(patternProblem(42 as unknown as string)).toBe('must be 1 to 200 characters');
  });
  it('rejects text that is not a valid regular expression under the u flag', () => {
    for (const p of ['([a-z', '[z-a]', '*a', 'a**', '\\', '(?<n>a)(?<n>b)', '\\q', '{1}'])
      expect(patternProblem(p), p).toBe('is not a valid regular expression');
  });
});

describe('a pattern that patternProblem rejects is never compiled or run', () => {
  const catastrophic = '(a+)+$';
  const evil = `${'a'.repeat(40)}!`;
  const withPattern = (validationPattern: string) =>
    format('QR', '{ADDRESS_LINE_1}\n{POSTAL_CODE}', [
      field('ADDRESS_LINE_1', { required: true }),
      field('POSTAL_CODE', { required: true, maxLength: 60, validationPattern }),
    ]);

  it('fails closed: every value is INVALID_FORMAT, immediately', () => {
    expect(patternProblem(catastrophic)).not.toBeNull();
    const f = withPattern(catastrophic);
    const started = Date.now();
    expect(validateAddressAgainstFormat(f, [], { countryCode: 'QR', addressLine1: 'x', postalCode: evil }).issues.map((i) => i.code)).toEqual([
      'INVALID_FORMAT',
    ]);
    expect(validateAddressAgainstFormat(f, [], { countryCode: 'QR', addressLine1: 'x', postalCode: 'a' }).issues.map((i) => i.code)).toEqual([
      'INVALID_FORMAT',
    ]); // even a harmless value
    expect(validateFieldValue(f, 'POSTAL_CODE', evil)).toEqual({ ok: false, code: 'INVALID_FORMAT' });
    expect(Date.now() - started).toBeLessThan(1000); // an exponential match of 40 characters would take far longer
  });
  it('never constructs a RegExp from the rejected pattern', () => {
    const Real = RegExp;
    const sources: string[] = [];
    vi.stubGlobal(
      'RegExp',
      new Proxy(Real, {
        construct(target, args: [string | RegExp, string?]) {
          sources.push(String(args[0]));
          return Reflect.construct(target, args);
        },
      }),
    );
    try {
      const unique = '(b+)+$';
      validateFieldValue(withPattern(unique), 'POSTAL_CODE', 'bbb');
      validateAddressAgainstFormat(withPattern(unique), [], { countryCode: 'QR', addressLine1: 'x', postalCode: 'bbb' });
      expect(sources.filter((s) => s.includes(unique))).toEqual([]);
      // control: a safe pattern IS compiled (proves the spy sees constructions)
      validateFieldValue(withPattern('[0-9]{7}'), 'POSTAL_CODE', '1234567');
      expect(sources.some((s) => s.includes('[0-9]{7}'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------- validateFieldValue
describe('validateFieldValue', () => {
  it('validates a postal code with the format rule (service-area lists use the same rule as forms)', () => {
    expect(validateFieldValue(US, 'POSTAL_CODE', '94043')).toEqual({ ok: true, value: '94043' });
    expect(validateFieldValue(US, 'POSTAL_CODE', ' 94043-1351 ')).toEqual({ ok: true, value: '94043-1351' });
    expect(validateFieldValue(US, 'POSTAL_CODE', '9404')).toEqual({ ok: false, code: 'INVALID_FORMAT' });
    expect(validateFieldValue(CA_LIKE, 'POSTAL_CODE', 'k1a 0b1')).toEqual({ ok: true, value: 'K1A0B1' });
  });
  it('is UNSUPPORTED_FIELD when the format lacks the field', () => {
    const none = format('QN', '{ADDRESS_LINE_1}', [field('ADDRESS_LINE_1', { required: true })]);
    expect(validateFieldValue(none, 'POSTAL_CODE', '12345')).toEqual({ ok: false, code: 'UNSUPPORTED_FIELD' });
    expect(validateFieldValue(US, 'SORTING_CODE', 'x')).toEqual({ ok: false, code: 'UNSUPPORTED_FIELD' });
  });
  it('reports REQUIRED, TOO_LONG and INVALID_CHARACTERS (checked in that precedence: characters first)', () => {
    expect(validateFieldValue(US, 'POSTAL_CODE', '   ')).toEqual({ ok: false, code: 'REQUIRED' });
    expect(validateFieldValue(US, 'POSTAL_CODE', '​')).toEqual({ ok: false, code: 'REQUIRED' });
    expect(validateFieldValue(US, 'POSTAL_CODE', '12345678901')).toEqual({ ok: false, code: 'TOO_LONG' });
    expect(validateFieldValue(US, 'POSTAL_CODE', '123\u00004')).toEqual({ ok: false, code: 'INVALID_CHARACTERS' });
  });
  it('resolves a lookup field to the canonical code and reports LOOKUP_UNAVAILABLE / UNKNOWN_AREA', () => {
    expect(validateFieldValue(US, 'ADMINISTRATIVE_AREA', 'california', US_AREAS)).toEqual({ ok: true, value: 'CA' });
    expect(validateFieldValue(US, 'ADMINISTRATIVE_AREA', 'Atlantis', US_AREAS)).toEqual({ ok: false, code: 'UNKNOWN_AREA' });
    expect(validateFieldValue(US, 'ADMINISTRATIVE_AREA', 'CA')).toEqual({ ok: false, code: 'LOOKUP_UNAVAILABLE' }); // areas default to none
    expect(validateFieldValue(US, 'ADMINISTRATIVE_AREA', 'PR', US_AREAS)).toEqual({ ok: false, code: 'UNKNOWN_AREA' });
  });
  it('returns the normalized value of a plain text field', () => {
    expect(validateFieldValue(US, 'LOCALITY', '  Mountain   View ')).toEqual({ ok: true, value: 'Mountain View' });
  });
});

// ---------------------------------------------------------------- formatting
const normalized = (over: Partial<NormalizedAddressDto> = {}): NormalizedAddressDto => ({
  countryCode: 'US',
  organization: null,
  addressLine1: '1600 Amphitheatre Pkwy',
  addressLine2: null,
  dependentLocality: null,
  locality: 'Mountain View',
  administrativeAreaCode: 'CA',
  administrativeAreaName: 'California',
  postalCode: '94043',
  sortingCode: null,
  ...over,
});

describe('formatAddressWithFormat: US', () => {
  it('renders three lines in the template order from the stored address', () => {
    const f = formatAddressWithFormat(US, normalized({ addressLine2: 'Suite 5' }));
    expect(f.lines).toEqual(['1600 Amphitheatre Pkwy', 'Suite 5', 'Mountain View, CA 94043']);
    expect(f.text).toBe('1600 Amphitheatre Pkwy\nSuite 5\nMountain View, CA 94043');
    expect(f.singleLine).toBe('1600 Amphitheatre Pkwy, Suite 5, Mountain View, CA 94043');
    expect(f.formatVersion).toBe(1);
  });
  it('drops an empty line 2 (no blank line)', () => {
    const f = formatAddressWithFormat(US, normalized());
    expect(f.lines).toEqual(['1600 Amphitheatre Pkwy', 'Mountain View, CA 94043']);
    expect(f.text).not.toMatch(/\n\n/);
  });
  it('shows the version of the format it was given', () => {
    expect(formatAddressWithFormat({ ...US, version: 7 }, normalized()).formatVersion).toBe(7);
  });
  it('appends the country line only when a country name is given', () => {
    expect(formatAddressWithFormat(US, normalized(), { countryName: 'United States' }).lines.at(-1)).toBe('United States');
    expect(formatAddressWithFormat(US, normalized(), { countryName: 'United States' }).singleLine).toBe(
      '1600 Amphitheatre Pkwy, Mountain View, CA 94043, United States',
    );
    for (const countryName of [undefined, null, '']) expect(formatAddressWithFormat(US, normalized(), { countryName }).lines).toHaveLength(2);
    expect(formatAddressWithFormat(US, normalized()).lines).toHaveLength(2);
  });
  it('a missing state leaves no ", " and no double space', () => {
    const f = formatAddressWithFormat(US, normalized({ administrativeAreaCode: null, administrativeAreaName: null }));
    expect(f.lines).toEqual(['1600 Amphitheatre Pkwy', 'Mountain View 94043']);
    expect(f.text).not.toMatch(/,\s*,|, $| {2}| $/m);
  });
  it('a missing locality removes its own text and the separator after it, a missing postal code its leading space', () => {
    expect(formatAddressWithFormat(US, normalized({ locality: null })).lines[1]).toBe('CA 94043');
    expect(formatAddressWithFormat(US, normalized({ postalCode: null })).lines[1]).toBe('Mountain View, CA');
    expect(formatAddressWithFormat(US, normalized({ locality: null, postalCode: null })).lines[1]).toBe('CA');
    expect(formatAddressWithFormat(US, normalized({ locality: null, administrativeAreaCode: null, administrativeAreaName: null })).lines[1]).toBe('94043');
  });
  it('drops a line whose tokens are all empty', () => {
    const f = formatAddressWithFormat(US, normalized({ locality: null, administrativeAreaCode: null, administrativeAreaName: null, postalCode: null }));
    expect(f.lines).toEqual(['1600 Amphitheatre Pkwy']);
  });
  it('shows the area name when the address has no area code (free text)', () => {
    expect(formatAddressWithFormat(US, normalized({ administrativeAreaCode: null, administrativeAreaName: 'Somewhere' })).lines[1]).toBe(
      'Mountain View, Somewhere 94043',
    );
  });
  it('is the product of validation: a validated lowercase input renders canonical codes', () => {
    const out = validateAddressAgainstFormat(US, US_AREAS, usInput({ administrativeArea: 'new york', addressLine2: '  ' }));
    expect(formatAddressWithFormat(US, out.address!).text).toBe('1600 Amphitheatre Pkwy\nMountain View, NY 94043');
  });
});

describe('formatAddressWithFormat: literal text around tokens', () => {
  const one = (template: string, fields: AddressFieldType[]) =>
    format(
      'QT',
      template,
      fields.map((t) => field(t)),
    );
  it('writes the text before a token only when that token is present', () => {
    const f = one('{ADDRESS_LINE_1}\nAttn: {ORGANIZATION}', ['ADDRESS_LINE_1', 'ORGANIZATION']);
    expect(formatAddressWithFormat(f, normalized({ organization: 'Acme' })).lines).toEqual(['1600 Amphitheatre Pkwy', 'Attn: Acme']);
    expect(formatAddressWithFormat(f, normalized()).lines).toEqual(['1600 Amphitheatre Pkwy']);
  });
  it('writes the text after the last token only when that token is present, and brackets travel with their token', () => {
    const f = one('{LOCALITY} ({ADMINISTRATIVE_AREA})', ['LOCALITY', 'ADMINISTRATIVE_AREA']);
    expect(formatAddressWithFormat(f, normalized()).lines).toEqual(['Mountain View (CA)']);
    expect(formatAddressWithFormat(f, normalized({ administrativeAreaCode: null, administrativeAreaName: null })).lines).toEqual(['Mountain View']);
  });
  it('a literal after a trailing token is dropped with it', () => {
    const f = one('{LOCALITY}, {POSTAL_CODE}.', ['LOCALITY', 'POSTAL_CODE']);
    expect(formatAddressWithFormat(f, normalized()).lines).toEqual(['Mountain View, 94043.']);
    expect(formatAddressWithFormat(f, normalized({ postalCode: null })).lines).toEqual(['Mountain View']);
  });
  it('keeps a line that has literal text and no token, trimmed, and trims every rendered line', () => {
    const f = one('  ---  \n  {ADDRESS_LINE_1}  ', ['ADDRESS_LINE_1']);
    expect(formatAddressWithFormat(f, normalized()).lines).toEqual(['---', '1600 Amphitheatre Pkwy']);
  });
  it('ignores a token that names no known address part', () => {
    const f = format('QT', '{ADDRESS_LINE_1}\n{UNKNOWN_PART}', [field('ADDRESS_LINE_1')]);
    expect(formatAddressWithFormat(f, normalized()).lines).toEqual(['1600 Amphitheatre Pkwy']);
  });
});

describe('formatAddressWithFormat: the formatter is generic', () => {
  it('renders a reversed-order format with organization, dependent locality, sorting code and a free-text area', () => {
    const out = validateAddressAgainstFormat(FR_LIKE, [], {
      countryCode: 'QF',
      organization: 'Acme SA',
      addressLine1: '12 rue de la Paix',
      dependentLocality: 'Quartier Opéra',
      postalCode: '75 002',
      locality: 'Paris',
      administrativeArea: 'idf',
      sortingCode: '07',
    });
    expect(out.valid).toBe(true);
    const f = formatAddressWithFormat(FR_LIKE, out.address!, { countryName: 'France' });
    expect(f.lines).toEqual(['Acme SA', '12 rue de la Paix', 'Quartier Opéra', '75002 Paris (IDF)', 'CEDEX 07', 'France']);
    expect(f.singleLine).toBe('Acme SA, 12 rue de la Paix, Quartier Opéra, 75002 Paris (IDF), CEDEX 07, France');
  });
  it('drops the optional parts of that format cleanly', () => {
    const out = validateAddressAgainstFormat(FR_LIKE, [], { countryCode: 'QF', addressLine1: '12 rue de la Paix', postalCode: '75002', locality: 'Paris' });
    expect(formatAddressWithFormat(FR_LIKE, out.address!).lines).toEqual(['12 rue de la Paix', '75002 Paris']);
  });
  it('lists the issues of the reversed format in ITS field order', () => {
    const out = validateAddressAgainstFormat(FR_LIKE, [], { countryCode: 'QF' });
    expect(out.issues.map((i) => i.field)).toEqual(['postalCode', 'locality', 'addressLine1']);
  });
  it('formats a Canada-like address with the same function', () => {
    const out = validateAddressAgainstFormat(CA_LIKE, CA_LIKE_AREAS, {
      countryCode: 'QA',
      addressLine1: '111 Wellington St',
      locality: 'Ottawa',
      administrativeArea: 'ontario',
      postalCode: 'k1a 0a9',
    });
    expect(formatAddressWithFormat(CA_LIKE, out.address!).lines).toEqual(['111 Wellington St', 'Ottawa ON K1A0A9']);
  });
});

// ---------------------------------------------------------------- templateProblem
describe('templateProblem', () => {
  const types = US.fields.map((f) => f.fieldType);
  it('accepts the seeded US template and templates in any order', () => {
    expect(templateProblem(US_TEMPLATE, types)).toBeNull();
    expect(templateProblem('{POSTAL_CODE} {LOCALITY}\n{ADMINISTRATIVE_AREA}\n{ADDRESS_LINE_2}\n{ADDRESS_LINE_1}', types)).toBeNull();
  });
  it('rejects an empty template and one over 500 characters', () => {
    expect(templateProblem('', types)).toBe('must be 1 to 500 characters');
    expect(templateProblem(`${US_TEMPLATE}${' '.repeat(500)}`, types)).toBe('must be 1 to 500 characters');
    expect(templateProblem(`${US_TEMPLATE}${' '.repeat(500 - US_TEMPLATE.length)}`, types)).toBeNull();
  });
  it('allows newlines but rejects other control characters, DEL and bidi overrides', () => {
    expect(templateProblem(US_TEMPLATE, types)).toBeNull();
    for (const c of ['\t', '\r', '\u0000', '\u001f', '\u007f', '‮', '⁦'])
      expect(templateProblem(`${US_TEMPLATE}${c}`, types), JSON.stringify(c)).toBe('must not contain control characters');
  });
  it('rejects a token the format does not define', () => {
    expect(templateProblem(`${US_TEMPLATE}\n{ORGANIZATION}`, types)).toBe('names a field the format does not define');
    expect(templateProblem(`${US_TEMPLATE}\n{NOT_A_FIELD}`, types)).toBe('names a field the format does not define');
  });
  it('rejects a field named more than once', () => {
    expect(templateProblem(`${US_TEMPLATE}\n{LOCALITY}`, types)).toBe('names a field more than once');
  });
  it('rejects a template that leaves a field of the format out', () => {
    expect(templateProblem('{ADDRESS_LINE_1}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}', types)).toBe('must include every field of the format');
    expect(templateProblem('{address_line_1}', ['ADDRESS_LINE_1'])).toBe('must include every field of the format'); // lower case is not a token
  });
  it('rejects stray braces', () => {
    expect(templateProblem(`${US_TEMPLATE}}`, types)).toBe('contains a stray brace');
    expect(templateProblem(`{${US_TEMPLATE}`, types)).toBe('contains a stray brace');
    expect(templateProblem(`${US_TEMPLATE} {}`, types)).toBe('contains a stray brace');
    expect(templateProblem(`${US_TEMPLATE} {lower}`, types)).toBe('contains a stray brace');
  });
  it('accepts a template with literal text', () => {
    expect(templateProblem('Attn {ADDRESS_LINE_1} - ({LOCALITY})', ['ADDRESS_LINE_1', 'LOCALITY'])).toBeNull();
  });
});

// ---------------------------------------------------------------- privacy
describe('redactAddress', () => {
  it('replaces every address key, whatever its case, and keeps the others', () => {
    const r = redactAddress({
      address: { addressLine1: '1 Main St' },
      POSTALCODE: '90210',
      postal_code: '90210',
      latitude: 1,
      longitude: 2,
      rawInput: { a: 1 },
      raw_input: {},
      formattedAddress: 'x',
      country: 'US',
      countryCode: 'US',
      count: 3,
    });
    expect(r).toEqual({
      address: '[REDACTED]',
      POSTALCODE: '[REDACTED]',
      postal_code: '[REDACTED]',
      latitude: '[REDACTED]',
      longitude: '[REDACTED]',
      rawInput: '[REDACTED]',
      raw_input: '[REDACTED]',
      formattedAddress: '[REDACTED]',
      country: 'US',
      countryCode: 'US',
      count: 3,
    });
  });
  it('redacts every property of the canonical address input and every normalized address key', () => {
    for (const property of Object.values(ADDRESS_FIELD_PROPERTIES))
      expect(redactAddress({ [property]: 'secret' }), property).toEqual({ [property]: '[REDACTED]' });
    for (const key of Object.keys(normalized())) {
      if (key === 'countryCode') continue;
      expect(redactAddress({ [key]: 'secret' }), key).toEqual({ [key]: '[REDACTED]' });
    }
    expect(redactAddress({ countryCode: 'US' })).toEqual({ countryCode: 'US' });
  });
  it('reaches nested objects and arrays', () => {
    const r = redactAddress({ request: { body: { items: [{ postalCode: '1', ok: 1 }, [{ locality: 'Springfield' }]] } } });
    expect(r).toEqual({ request: { body: { items: [{ postalCode: '[REDACTED]', ok: 1 }, [{ locality: '[REDACTED]' }]] } } });
  });
  it('redacts down to depth 6 and does not mutate its input', () => {
    const input = { a: { b: { c: { d: { e: { f: { address: 'deep secret' } } } } } } };
    const copy = JSON.parse(JSON.stringify(input));
    expect(JSON.stringify(redactAddress(input))).not.toContain('deep secret');
    expect(input).toEqual(copy);
  });
  it('returns primitives and null unchanged', () => {
    expect(redactAddress('x')).toBe('x');
    expect(redactAddress(5)).toBe(5);
    expect(redactAddress(null)).toBeNull();
    expect(redactAddress(undefined)).toBeUndefined();
    expect(redactAddress([1, 'a', null])).toEqual([1, 'a', null]);
  });
});

// ---------------------------------------------------------------- no country-specific behavior
/** Source text with comments removed (string, template and regex contents are kept): a small scanner so `//` inside a string is not a comment. */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
      i++;
    }
  }
  return out;
}
const sourceOf = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

describe('no country-specific branch', () => {
  // The only quoted two-letter upper-case literals allowed in production code of the address model. None were found when this test was written:
  // area codes, ISO country codes and states come from data, never from code. Add an entry here (with a justification) rather than a branch.
  const ALLOWED_LITERALS: string[] = [];
  const TWO_LETTER_LITERAL = /['"`]([A-Z]{2})['"`]/g;
  const literalsIn = (text: string): string[] =>
    [...withoutComments(text).matchAll(TWO_LETTER_LITERAL)].map((m) => m[1]!).filter((l) => !ALLOWED_LITERALS.includes(l));

  it('the comment stripper keeps code and drops comments (self-check)', () => {
    const sample = "const a = 'US'; // 'GB' in a comment\n/* 'FR' */ const url = 'http://x'; const b = `CA`;";
    expect(literalsIn(sample)).toEqual(['US', 'CA']); // only the two comments are dropped
    expect(literalsIn('const c = "CA"; const d = `MX`;')).toEqual(['CA', 'MX']);
    expect(literalsIn('// \'DE\'\n/* "JP" */')).toEqual([]);
  });
  it.each(['address-engine.ts', 'address-service.ts', 'address-providers.ts'])('%s contains no quoted two-letter country literal outside comments', (file) => {
    expect(literalsIn(sourceOf(file))).toEqual([]);
  });
  it.each(['address-engine.ts', 'address-service.ts'])('%s never branches on a country name or code field', (file) => {
    const code = withoutComments(sourceOf(file));
    expect(code).not.toMatch(/United States|Canada|Mexico|Kingdom/);
    expect(code).not.toMatch(/countryCode\s*[!=]==?\s*['"`]/);
    expect(code).not.toMatch(/case\s+['"`][A-Z]{2}['"`]\s*:/);
  });
  it('the same engine validates two synthetic countries that differ only in data', () => {
    // Same function, same code path, different formats: no difference in code, only in the records passed in.
    const usOut = validateAddressAgainstFormat(US, US_AREAS, usInput({ postalCode: '94043-1351', administrativeArea: 'california' }));
    const caOut = validateAddressAgainstFormat(CA_LIKE, CA_LIKE_AREAS, {
      countryCode: 'QA',
      addressLine1: '111 Wellington St',
      locality: 'Ottawa',
      administrativeArea: 'ontario',
      postalCode: 'k1a 0a9',
    });
    expect(usOut.valid).toBe(true);
    expect(caOut.valid).toBe(true);
    expect(usOut.address).toMatchObject({ countryCode: 'US', administrativeAreaCode: 'CA', postalCode: '94043-1351' });
    expect(caOut.address).toMatchObject({ countryCode: 'QA', administrativeAreaCode: 'ON', postalCode: 'K1A0A9' });
    // Each country's postal rule rejects the other's value (rules come from the format, not from the code).
    expect(issuesOf(US, US_AREAS, usInput({ postalCode: 'K1A 0A9' })).map((i) => i.code)).toEqual(['INVALID_FORMAT']);
    expect(
      issuesOf(CA_LIKE, CA_LIKE_AREAS, { countryCode: 'QA', addressLine1: 'x', locality: 'y', administrativeArea: 'ON', postalCode: '94043' }).map(
        (i) => i.code,
      ),
    ).toEqual(['INVALID_FORMAT']);
    // Swapping the data swaps the behavior: the US format with Canada's postal field accepts a Canadian code.
    const swapped = { ...US, fields: US.fields.map((f) => (f.fieldType === 'POSTAL_CODE' ? CA_LIKE.fields.find((x) => x.fieldType === 'POSTAL_CODE')! : f)) };
    expect(validateAddressAgainstFormat(swapped, US_AREAS, usInput({ postalCode: 'k1a 0a9' })).address!.postalCode).toBe('K1A0A9');
    expect(validateAddressAgainstFormat(swapped, US_AREAS, usInput({ postalCode: '94043' })).valid).toBe(false);
  });
});

describe('redactAddress fails closed', () => {
  it('never passes a structure nested deeper than it inspects, and keeps dates intact', () => {
    const deep = { a: { a: { a: { a: { a: { a: { a: { a: { address: 'secret street' } } } } } } } } };
    expect(JSON.stringify(redactAddress(deep))).not.toContain('secret street');
    const when = new Date(0);
    expect((redactAddress({ at: when }) as { at: Date }).at).toBe(when);
  });
});
