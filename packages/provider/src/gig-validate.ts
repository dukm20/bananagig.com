// Pure validation of the Gig content (CAT-003): the EAGER checks of a draft save, the COMPLETENESS checks of a publish and the decimal arithmetic they need. No database, no ports, no
// clock. Every result is an identifier (target, field key, reason); the provider's own text never appears in an issue.
import {
  gigIssueKey,
  isGigFieldTypeSupported,
  normalizeProviderText,
  textLength,
  type GigIssueDto,
  type GigIssueReason,
  type ProviderGigPolicy,
  type UpdateGigDraftRequest,
} from '@bananagig/contracts';
import type { GigTemplateFieldFacts, GigTemplateStructure } from './gig-types';

/** A stored or accepted value of one template field: text, an integer, a decimal as a canonical string, a boolean, an option code or a duration in minutes. */
export type FieldValue = string | number | boolean;

/** The editable content of a version, normalised. */
export interface GigContent {
  title: string | null;
  shortPitch: string | null;
  description: string | null;
  priceAmountMinor: number | null;
  /** The currency stored with the price (undefined / null when unknown or no price). */
  priceCurrency?: string | null;
  durationMinutes: number | null;
  /** By field key; only supported, provider-editable fields ever appear. */
  values: ReadonlyMap<string, FieldValue>;
}

/** The structural ceiling of a stored text value (the database CHECK repeats it). */
export const FIELD_TEXT_CEILING = 20000;
export const DURATION_FLOOR = 1;
export const DURATION_CEILING = 100000;

export function issue(target: GigIssueDto['target'], reason: GigIssueReason, fieldKey?: string): GigIssueDto {
  return fieldKey === undefined ? { target, reason, messageKey: gigIssueKey(reason) } : { target, fieldKey, reason, messageKey: gigIssueKey(reason) };
}

export const priceAllowed = (s: GigTemplateStructure): boolean => s.pricing.fixed || s.pricing.fixedWithVariants;
export const durationAllowed = (s: GigTemplateStructure): boolean =>
  s.duration.minMinutes !== null || s.duration.maxMinutes !== null || s.duration.suggestedMinutes !== null;
export const isSupported = (f: GigTemplateFieldFacts): boolean => isGigFieldTypeSupported(f.fieldType);
/** A field the provider may fill in: supported and not platform-fixed. */
export const isEditable = (f: GigTemplateFieldFacts): boolean => isSupported(f) && f.behavior !== 'PLATFORM_FIXED';
export const sortedFields = (s: GigTemplateStructure): GigTemplateFieldFacts[] => [...s.fields].sort((a, b) => a.displayOrder - b.displayOrder);

// ---------------------------------------------------------------- decimals (no floats)
const DECIMAL = /^(-?)([0-9]{1,15})(?:\.([0-9]{1,6}))?$/;
const SCALE = 6;
/** The canonical form of a decimal string (no leading zeros, no trailing fraction zeros, no negative zero) and its value scaled by 10^6, or null when it is not a decimal. */
export function parseDecimal(raw: string): { canonical: string; scaled: bigint } | null {
  const m = DECIMAL.exec(raw);
  if (!m) return null;
  const int = m[2]!.replace(/^0+(?=[0-9])/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const zero = int === '0' && frac === '';
  const neg = m[1] === '-' && !zero;
  const scaled = BigInt(int) * 10n ** BigInt(SCALE) + BigInt((m[3] ?? '').padEnd(SCALE, '0') || '0');
  return { canonical: `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`, scaled: neg ? -scaled : scaled };
}
/** A template bound (stored with four decimals) scaled by 10^6. */
const boundScaled = (n: number): bigint => BigInt(Math.round(n * 10_000)) * 100n;

// ---------------------------------------------------------------- one field value (eager)
type FieldCheck = { ok: true; value: FieldValue | undefined } | { ok: false; reason: GigIssueReason };

export function checkFieldValue(f: GigTemplateFieldFacts, raw: string | number | boolean | null): FieldCheck {
  if (raw === null) return { ok: true, value: undefined };
  switch (f.fieldType) {
    case 'TEXT':
    case 'LONG_TEXT': {
      if (typeof raw !== 'string') return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      const n = normalizeProviderText(raw, { multiline: f.fieldType === 'LONG_TEXT' });
      if (!n.ok) return { ok: false, reason: n.reason };
      if (n.value === '') return { ok: true, value: undefined };
      const len = textLength(n.value);
      if (f.minLength !== null && len < f.minLength) return { ok: false, reason: 'FIELD_TOO_SHORT' };
      if ((f.maxLength !== null && len > f.maxLength) || len > FIELD_TEXT_CEILING) return { ok: false, reason: 'FIELD_TOO_LONG' };
      return { ok: true, value: n.value };
    }
    case 'INTEGER': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      if ((f.minNumber !== null && raw < f.minNumber) || (f.maxNumber !== null && raw > f.maxNumber)) return { ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' };
      return { ok: true, value: raw };
    }
    case 'DECIMAL': {
      if (typeof raw !== 'string') return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      const d = parseDecimal(raw);
      if (!d) return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      if ((f.minNumber !== null && d.scaled < boundScaled(f.minNumber)) || (f.maxNumber !== null && d.scaled > boundScaled(f.maxNumber)))
        return { ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' };
      return { ok: true, value: d.canonical };
    }
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, reason: 'FIELD_VALUE_INVALID' };
    case 'ENUM': {
      if (typeof raw !== 'string') return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      return f.options.some((o) => o.optionCode === raw) ? { ok: true, value: raw } : { ok: false, reason: 'FIELD_OPTION_UNKNOWN' };
    }
    case 'DURATION': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { ok: false, reason: 'FIELD_VALUE_INVALID' };
      if (raw < DURATION_FLOOR || raw > DURATION_CEILING) return { ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' };
      if ((f.minNumber !== null && raw < f.minNumber) || (f.maxNumber !== null && raw > f.maxNumber)) return { ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, reason: 'FIELD_TYPE_NOT_SUPPORTED' };
  }
}

// ---------------------------------------------------------------- the draft save (eager)
function checkCopy(
  raw: string | null,
  target: 'title' | 'shortPitch' | 'description',
  multiline: boolean,
  max: number,
  tooLong: GigIssueReason,
  issues: GigIssueDto[],
): string | null {
  if (raw === null) return null;
  const n = normalizeProviderText(raw, { multiline });
  if (!n.ok) {
    issues.push(issue(target, n.reason));
    return null;
  }
  if (n.value === '') return null;
  if (textLength(n.value) > max) {
    issues.push(issue(target, tooLong));
    return null;
  }
  return n.value;
}

/**
 * Validates and normalises a draft save against the EXACT template version and the policy. A draft may be incomplete (null and empty are allowed); any value that is present must be
 * valid. Returns the normalised content, or every issue found (never provider text).
 */
export function validateDraftInput(
  body: Pick<UpdateGigDraftRequest, 'title' | 'shortPitch' | 'description' | 'priceAmountMinor' | 'durationMinutes' | 'fieldValues'>,
  structure: GigTemplateStructure,
  policy: ProviderGigPolicy,
): { content: GigContent; issues: GigIssueDto[] } {
  const issues: GigIssueDto[] = [];
  const title = checkCopy(body.title, 'title', false, policy.titleMaxLength, 'TITLE_TOO_LONG', issues);
  const shortPitch = checkCopy(body.shortPitch, 'shortPitch', false, policy.shortPitchMaxLength, 'SHORT_PITCH_TOO_LONG', issues);
  const description = checkCopy(body.description, 'description', true, policy.descriptionMaxLength, 'DESCRIPTION_TOO_LONG', issues);

  if (body.priceAmountMinor !== null && !priceAllowed(structure)) issues.push(issue('price', 'PRICE_NOT_PERMITTED'));
  if (body.durationMinutes !== null) {
    if (!durationAllowed(structure)) issues.push(issue('duration', 'DURATION_NOT_PERMITTED'));
    else if (
      (structure.duration.minMinutes !== null && body.durationMinutes < structure.duration.minMinutes) ||
      (structure.duration.maxMinutes !== null && body.durationMinutes > structure.duration.maxMinutes)
    )
      issues.push(issue('duration', 'DURATION_OUT_OF_RANGE'));
  }

  const byKey = new Map(structure.fields.map((f) => [f.fieldKey, f]));
  const values = new Map<string, FieldValue>();
  for (const entry of body.fieldValues) {
    const f = byKey.get(entry.fieldKey);
    if (!f) {
      issues.push(issue('field', 'FIELD_UNKNOWN', entry.fieldKey));
      continue;
    }
    if (f.behavior === 'PLATFORM_FIXED') {
      issues.push(issue('field', 'FIELD_NOT_PROVIDER_EDITABLE', f.fieldKey));
      continue;
    }
    if (!isSupported(f)) {
      issues.push(issue('field', 'FIELD_TYPE_NOT_SUPPORTED', f.fieldKey));
      continue;
    }
    const c = checkFieldValue(f, entry.value);
    if (!c.ok) issues.push(issue('field', c.reason, f.fieldKey));
    else if (c.value !== undefined) values.set(f.fieldKey, c.value);
  }
  return { content: { title, shortPitch, description, priceAmountMinor: body.priceAmountMinor, durationMinutes: body.durationMinutes, values }, issues };
}

// ---------------------------------------------------------------- the publish (completeness)
/** Whether the bound template version, its template or its service type has been withdrawn for good (a Gig built on it can be read, but no new version of it can be published). */
export const templateWithdrawn = (s: GigTemplateStructure): boolean =>
  s.versionStatus === 'RETIRED' || s.templateStatus === 'RETIRED' || s.serviceTypeStatus === 'RETIRED';

/** Everything that stands between a draft and PUBLISHED: complete copy, the price and duration the template asks for, every required field, nothing unsupported required. */
export function completenessIssues(
  content: GigContent,
  structure: GigTemplateStructure,
  policy: ProviderGigPolicy,
  marketCurrency: string | null = null,
): GigIssueDto[] {
  const issues: GigIssueDto[] = [];
  const copy = (value: string | null, target: 'title' | 'shortPitch' | 'description', max: number, required: GigIssueReason, tooLong: GigIssueReason) => {
    if (value === null || value === '') issues.push(issue(target, required));
    else if (textLength(value) > max) issues.push(issue(target, tooLong));
  };
  copy(content.title, 'title', policy.titleMaxLength, 'TITLE_REQUIRED', 'TITLE_TOO_LONG');
  copy(content.shortPitch, 'shortPitch', policy.shortPitchMaxLength, 'SHORT_PITCH_REQUIRED', 'SHORT_PITCH_TOO_LONG');
  copy(content.description, 'description', policy.descriptionMaxLength, 'DESCRIPTION_REQUIRED', 'DESCRIPTION_TOO_LONG');

  if (priceAllowed(structure)) {
    // a price in another currency than the provider's market is no price at all: it must be entered again (the currency is derived by the server, never kept stale)
    const staleCurrency =
      content.priceAmountMinor !== null && marketCurrency !== null && content.priceCurrency != null && content.priceCurrency !== marketCurrency;
    if (content.priceAmountMinor === null || staleCurrency) issues.push(issue('price', 'PRICE_REQUIRED'));
    else if (content.priceAmountMinor <= 0) issues.push(issue('price', 'PRICE_NOT_POSITIVE'));
  } else if (content.priceAmountMinor !== null) issues.push(issue('price', 'PRICE_NOT_PERMITTED'));

  if (durationAllowed(structure)) {
    const d = content.durationMinutes;
    if (d === null) issues.push(issue('duration', 'DURATION_REQUIRED'));
    else if (
      (structure.duration.minMinutes !== null && d < structure.duration.minMinutes) ||
      (structure.duration.maxMinutes !== null && d > structure.duration.maxMinutes)
    )
      issues.push(issue('duration', 'DURATION_OUT_OF_RANGE'));
  } else if (content.durationMinutes !== null) issues.push(issue('duration', 'DURATION_NOT_PERMITTED'));

  for (const f of sortedFields(structure)) {
    if (f.behavior !== 'PROVIDER_REQUIRED') continue;
    if (!isSupported(f)) issues.push(issue('field', 'FIELD_TYPE_NOT_SUPPORTED', f.fieldKey));
    else if (!content.values.has(f.fieldKey)) issues.push(issue('field', 'FIELD_REQUIRED', f.fieldKey));
  }
  if (templateWithdrawn(structure)) issues.push(issue('template', 'TEMPLATE_VERSION_RETIRED'));
  return issues;
}
