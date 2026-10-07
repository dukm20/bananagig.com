// The address engine: pure functions (no database, no I/O, no clock) that validate a structured address against a country address format and
// render it with the format's display template. There is NO country-specific branch anywhere in this file: field order, requirement, length,
// input type, pattern, normalization and the template all come from the format records, so a new country is data only.
//
// Privacy: addresses are personal data. Issues carry the INPUT PROPERTY and a code, never the rejected value, and nothing here logs.
import {
  ADDRESS_FIELD_PROPERTIES,
  addressIssueMessageKey,
  containsForbiddenText,
  type AddressFieldType,
  type AddressInput,
  type AddressInputType,
  type AddressIssueCode,
  type AddressIssueDto,
  type AddressNormalizationRule,
  type AdministrativeAreaType,
  type FormattedAddressDto,
  type NormalizedAddressDto,
} from '@bananagig/contracts';

// ---------------------------------------------------------------- models (what the service loads from the database)
export interface AddressFormatField {
  fieldType: AddressFieldType;
  displayOrder: number;
  contentLabelKey: string;
  required: boolean;
  maxLength: number;
  inputType: AddressInputType;
  validationPattern: string | null;
  example: string | null;
  autocomplete: string | null;
  normalization: AddressNormalizationRule | null;
}
export interface AddressFormatModel {
  addressFormatId: string;
  countryCode: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED';
  displayTemplate: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Ordered by displayOrder. */
  fields: AddressFormatField[];
}
export interface AdministrativeAreaModel {
  administrativeAreaId: string;
  code: string;
  name: string;
  type: AdministrativeAreaType;
  parentCode: string | null;
  displayOrder: number | null;
  status: 'ACTIVE' | 'INACTIVE';
}

// ---------------------------------------------------------------- text normalization
/** Invisible characters that carry no meaning in an address and would make two equal addresses compare unequal. */
const INVISIBLE = /[\u200B\u2060\u180E\uFEFF]/g;
const WHITESPACE_RUN = /\s+/g;
/** A pasted value may carry tabs and line breaks; they are whitespace (collapsed by normalizeText), every other control character is rejected. */
const whitespaceControls = (s: string): string => s.replace(/[\t\n\v\f\r]/g, ' ');
export const codePointLength = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
/** Universal normalization applied to every value: Unicode NFC, invisible characters removed, whitespace collapsed to single spaces, trimmed. */
export function normalizeText(raw: string): string {
  return raw.normalize('NFC').replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim();
}
/** The format's own normalization rule (locale independent: `toUpperCase`, never `toLocaleUpperCase`, so the same input gives the same stored value everywhere). */
export function applyNormalizationRule(value: string, rule: AddressNormalizationRule | null): string {
  switch (rule) {
    case 'UPPERCASE':
      return value.toUpperCase();
    case 'REMOVE_SPACES':
      return value.replace(/ /g, '');
    case 'UPPERCASE_REMOVE_SPACES':
      return value.toUpperCase().replace(/ /g, '');
    default:
      return value;
  }
}

// ---------------------------------------------------------------- patterns (data-driven regular expressions)
export const MAX_PATTERN_LENGTH = 200;
const BACKREFERENCE = /\\[1-9]|\\k</;
const LOOKBEHIND = /\(\?<[=!]/;
// A group that contains a repeating quantifier and is itself repeated is the classic catastrophic-backtracking shape ((a+)+, (a|b*)*, (\d{1,3})+).
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d)/;
/**
 * Why a pattern cannot be used, or null when it can. The input a pattern sees is already bounded by the field's max_length (at most 200 characters),
 * and these rules remove the shapes that make a regular expression exponential. The pattern must fully match (the engine anchors it) and is
 * compiled with the `u` flag, exactly as clients must.
 */
export function patternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > MAX_PATTERN_LENGTH) return `must be 1 to ${MAX_PATTERN_LENGTH} characters`;
  if (BACKREFERENCE.test(pattern)) return 'must not use backreferences';
  if (LOOKBEHIND.test(pattern)) return 'must not use lookbehind';
  if (NESTED_QUANTIFIER.test(pattern)) return 'must not repeat a group that already repeats';
  try {
    new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return 'is not a valid regular expression';
  }
  return null;
}
const compiled = new Map<string, RegExp | null>();
function compile(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern)!;
  const re = patternProblem(pattern) === null ? new RegExp(`^(?:${pattern})$`, 'u') : null;
  if (compiled.size > 500) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

// ---------------------------------------------------------------- validation
export interface AddressValidationOutcome {
  valid: boolean;
  /** Present when valid. */
  address: NormalizedAddressDto | null;
  /** The canonical area row the value resolved to (lookup fields), for persistence. */
  administrativeAreaId: string | null;
  issues: AddressIssueDto[];
}

const PROPERTIES = Object.values(ADDRESS_FIELD_PROPERTIES);
const issue = (field: string, code: AddressIssueCode): AddressIssueDto => ({ field, code, messageKey: addressIssueMessageKey(code) });
const fold = (s: string): string => normalizeText(s).normalize('NFKC').toLowerCase();

/** Resolves a lookup value (the canonical code or the name, case-insensitively) to an ACTIVE area. */
export function resolveAdministrativeArea(value: string, areas: readonly AdministrativeAreaModel[]): AdministrativeAreaModel | null {
  const folded = fold(value);
  const active = areas.filter((a) => a.status === 'ACTIVE');
  return active.find((a) => a.code.toLowerCase() === folded) ?? active.find((a) => fold(a.name) === folded) ?? null;
}

/**
 * Validates `input` against `format` and normalizes it. `areas` are the ACTIVE and INACTIVE areas of the country (only ACTIVE ones resolve); pass
 * an empty list when the country has none. Every issue is reported (not just the first), in format display order, and carries the property and a
 * code only. The country code of `input` is NOT checked here: the caller resolved `format` for it.
 */
export function validateAddressAgainstFormat(
  format: AddressFormatModel,
  areas: readonly AdministrativeAreaModel[],
  input: AddressInput,
): AddressValidationOutcome {
  const issues: AddressIssueDto[] = [];
  const bag = input as Record<string, string | undefined>;
  const byType = new Map(format.fields.map((f) => [f.fieldType, f]));
  const usedProperties = new Set(format.fields.map((f) => ADDRESS_FIELD_PROPERTIES[f.fieldType]));

  for (const property of PROPERTIES) {
    const raw = bag[property];
    if (raw !== undefined && raw.trim() !== '' && !usedProperties.has(property)) issues.push(issue(property, 'UNSUPPORTED_FIELD'));
  }

  const values = new Map<AddressFieldType, string>();
  let areaId: string | null = null;
  let areaCode: string | null = null;
  let areaName: string | null = null;

  for (const field of format.fields) {
    const property = ADDRESS_FIELD_PROPERTIES[field.fieldType];
    const raw = bag[property];
    if (raw !== undefined && containsForbiddenText(whitespaceControls(raw))) {
      issues.push(issue(property, 'INVALID_CHARACTERS'));
      continue;
    }
    const text = raw === undefined ? '' : normalizeText(raw);
    if (text === '') {
      if (field.required) issues.push(issue(property, 'REQUIRED'));
      continue;
    }
    if (codePointLength(text) > field.maxLength) {
      issues.push(issue(property, 'TOO_LONG'));
      continue;
    }
    if (field.inputType === 'LOOKUP') {
      if (!areas.some((a) => a.status === 'ACTIVE')) {
        issues.push(issue(property, 'LOOKUP_UNAVAILABLE'));
        continue;
      }
      const area = resolveAdministrativeArea(text, areas);
      if (!area) {
        issues.push(issue(property, 'UNKNOWN_AREA'));
        continue;
      }
      areaId = area.administrativeAreaId;
      areaCode = area.code;
      areaName = area.name;
      values.set(field.fieldType, area.code);
      continue;
    }
    const value = applyNormalizationRule(text, field.normalization);
    if (field.validationPattern !== null) {
      const re = compile(field.validationPattern);
      if (re === null || !re.test(value)) {
        issues.push(issue(property, 'INVALID_FORMAT'));
        continue;
      }
    }
    values.set(field.fieldType, value);
  }

  if (issues.length > 0) return { valid: false, address: null, administrativeAreaId: null, issues };

  const get = (t: AddressFieldType): string | null => values.get(t) ?? null;
  const textArea = byType.get('ADMINISTRATIVE_AREA')?.inputType === 'TEXT' ? get('ADMINISTRATIVE_AREA') : null;
  const address: NormalizedAddressDto = {
    countryCode: format.countryCode,
    organization: get('ORGANIZATION'),
    addressLine1: get('ADDRESS_LINE_1') ?? '',
    addressLine2: get('ADDRESS_LINE_2'),
    dependentLocality: get('DEPENDENT_LOCALITY'),
    locality: get('LOCALITY'),
    administrativeAreaCode: areaCode,
    administrativeAreaName: areaName ?? textArea,
    postalCode: get('POSTAL_CODE'),
    sortingCode: get('SORTING_CODE'),
  };
  return { valid: true, address, administrativeAreaId: areaId, issues: [] };
}

/**
 * Validates one value against the format field of a given type (for example the postal code of a service-area list) without a full address.
 * Returns the normalized value or the issue code. A format without that field means the country does not use it (UNSUPPORTED_FIELD).
 */
export function validateFieldValue(
  format: AddressFormatModel,
  fieldType: AddressFieldType,
  raw: string,
  areas: readonly AdministrativeAreaModel[] = [],
): { ok: true; value: string } | { ok: false; code: AddressIssueCode } {
  const field = format.fields.find((f) => f.fieldType === fieldType);
  if (!field) return { ok: false, code: 'UNSUPPORTED_FIELD' };
  if (containsForbiddenText(whitespaceControls(raw))) return { ok: false, code: 'INVALID_CHARACTERS' };
  const text = normalizeText(raw);
  if (text === '') return { ok: false, code: 'REQUIRED' };
  if (codePointLength(text) > field.maxLength) return { ok: false, code: 'TOO_LONG' };
  if (field.inputType === 'LOOKUP') {
    if (!areas.some((a) => a.status === 'ACTIVE')) return { ok: false, code: 'LOOKUP_UNAVAILABLE' };
    const area = resolveAdministrativeArea(text, areas);
    return area ? { ok: true, value: area.code } : { ok: false, code: 'UNKNOWN_AREA' };
  }
  const value = applyNormalizationRule(text, field.normalization);
  if (field.validationPattern !== null) {
    const re = compile(field.validationPattern);
    if (re === null || !re.test(value)) return { ok: false, code: 'INVALID_FORMAT' };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------- display template
const TOKEN = /\{([A-Z0-9_]+)\}/g;

/** The value that a template token shows for a normalized address (an area shows its canonical code when it has one, its text otherwise). */
function tokenValue(address: NormalizedAddressDto, type: string): string {
  switch (type) {
    case 'ORGANIZATION':
      return address.organization ?? '';
    case 'ADDRESS_LINE_1':
      return address.addressLine1 ?? '';
    case 'ADDRESS_LINE_2':
      return address.addressLine2 ?? '';
    case 'DEPENDENT_LOCALITY':
      return address.dependentLocality ?? '';
    case 'LOCALITY':
      return address.locality ?? '';
    case 'ADMINISTRATIVE_AREA':
      return address.administrativeAreaCode ?? address.administrativeAreaName ?? '';
    case 'POSTAL_CODE':
      return address.postalCode ?? '';
    case 'SORTING_CODE':
      return address.sortingCode ?? '';
    default:
      return '';
  }
}

// A template line is literal text and {FIELD} tokens. The grammar is deliberately tiny and NOT executable: no conditionals, expressions or escapes.
// One decoration exists: a token may be wrapped in round or square brackets written directly around it, `({FIELD})` or `[{FIELD}]`. The brackets belong to
// that field: they are written only together with it. Any other bracket in a template is plain text (templateProblem refuses it when a template is drafted).
const WRAPPED_TOKEN = /\(\{([A-Z0-9_]+)\}\)|\[\{([A-Z0-9_]+)\}\]|\{([A-Z0-9_]+)\}/g;
interface LineToken {
  type: string;
  wrap: '()' | '[]' | null;
}

/** Splits a template line into the literal text around its tokens: `literals[i]` is the text in front of `tokens[i]`, the last literal follows the last token. */
function parseLine(line: string): { literals: string[]; tokens: LineToken[] } {
  const literals: string[] = [];
  const tokens: LineToken[] = [];
  let last = 0;
  for (const m of line.matchAll(WRAPPED_TOKEN)) {
    literals.push(line.slice(last, m.index));
    tokens.push(m[1] !== undefined ? { type: m[1], wrap: '()' } : m[2] !== undefined ? { type: m[2], wrap: '[]' } : { type: m[3]!, wrap: null });
    last = m.index! + m[0].length;
  }
  literals.push(line.slice(last));
  return { literals, tokens };
}

/**
 * Renders one template line. Punctuation travels with the field it belongs to, so a missing field never leaves a dangling separator or bracket:
 *  - The literal text in front of a token belongs to that token: it is written only when the token is present AND an earlier token of the line is
 *    present (the first token of the line owns the text before it). The text after the last token belongs to the last token.
 *  - Brackets around a token belong to it and qualify what precedes it: they are written when the token is present and either it is the first token
 *    of the line or an earlier token is present. `{LOCALITY} ({ADMINISTRATIVE_AREA})` gives `Irvine (CA)`, `Irvine` and `CA`, never `Irvine (` or `CA)`.
 * Deterministic and country-neutral: the same line and the same field values always give the same text.
 */
function renderLine(line: string, address: NormalizedAddressDto): string {
  const { literals, tokens } = parseLine(line);
  if (tokens.length === 0) return line.trim();
  let out = '';
  let any = false;
  tokens.forEach((token, i) => {
    const value = tokenValue(address, token.type);
    if (value === '') return;
    const text = token.wrap !== null && (i === 0 || any) ? `${token.wrap[0]}${value}${token.wrap[1]}` : value;
    out += (i === 0 ? literals[0]! : any ? literals[i]! : '') + text;
    any = true;
  });
  if (any && tokenValue(address, tokens[tokens.length - 1]!.type) !== '') out += literals[tokens.length]!;
  return out.trim();
}

/** Why the brackets of a template cannot be used, or null. A bracket must wrap exactly one field, written `({FIELD})` or `[{FIELD}]`. */
function bracketProblem(template: string): string | null {
  return /[()[\]]/.test(template.replace(WRAPPED_TOKEN, '')) ? 'has a bracket that does not wrap exactly one field; write ({FIELD}) or [{FIELD}]' : null;
}

export interface FormatAddressOptions {
  /** The country name already resolved for the display locale; appended as the last line when given. */
  countryName?: string | null;
}
/**
 * The ONE formatter. Renders the stored structured address with the display template of the format version it was validated with. Clients never
 * build the string themselves. Empty lines are dropped.
 */
export function formatAddressWithFormat(format: AddressFormatModel, address: NormalizedAddressDto, options: FormatAddressOptions = {}): FormattedAddressDto {
  const lines = format.displayTemplate
    .split('\n')
    .map((line) => renderLine(line, address))
    .filter((line) => line !== '');
  if (options.countryName) lines.push(options.countryName);
  return { lines, text: lines.join('\n'), singleLine: lines.join(', '), formatVersion: format.version };
}

/** Template problems found at draft time (the database repeats the essential ones at publication). */
export function templateProblem(template: string, fieldTypes: readonly AddressFieldType[]): string | null {
  if (template.length < 1 || template.length > 500) return 'must be 1 to 500 characters';
  if (containsForbiddenTextExceptNewline(template)) return 'must not contain control characters';
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    if (!fieldTypes.includes(m[1] as AddressFieldType)) return `names a field the format does not define`;
    if (seen.has(m[1]!)) return 'names a field more than once';
    seen.add(m[1]!);
  }
  for (const t of fieldTypes) if (!seen.has(t)) return `must include every field of the format`;
  const stripped = template.replace(TOKEN, '');
  if (/[{}]/.test(stripped)) return 'contains a stray brace';
  return bracketProblem(template);
}
// eslint-disable-next-line no-control-regex
const containsForbiddenTextExceptNewline = (s: string): boolean => containsForbiddenText(s.replace(/\n/g, '')) || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(s);

/** The mode a client must use for the area field of a format. */
export function administrativeAreaMode(format: AddressFormatModel): 'LOOKUP' | 'FREE_TEXT' | 'NONE' {
  const f = format.fields.find((x) => x.fieldType === 'ADMINISTRATIVE_AREA');
  return f ? (f.inputType === 'LOOKUP' ? 'LOOKUP' : 'FREE_TEXT') : 'NONE';
}

// ---------------------------------------------------------------- privacy
const ADDRESS_KEYS = new Set([
  'address',
  'addressline1',
  'addressline2',
  'address_line_1',
  'address_line_2',
  'organization',
  'dependentlocality',
  'locality',
  'administrativearea',
  'administrativeareacode',
  'administrativeareaname',
  'postalcode',
  'postal_code',
  'sortingcode',
  'formattedaddress',
  'formatted_address',
  'rawinput',
  'raw_input',
  'latitude',
  'longitude',
  'location',
]);
/**
 * A copy of `value` that is safe to log or attach to a trace: every address key (at any depth) is replaced by `[REDACTED]`. Use it whenever a
 * structure that might contain an address has to be described. Never log an address, a postal code or coordinates directly.
 */
export function redactAddress(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  // fail closed: a structure nested deeper than we inspect is never passed through, it could hold an address
  if (depth > 6) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((v) => redactAddress(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, ADDRESS_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactAddress(v, depth + 1)]),
  );
}
