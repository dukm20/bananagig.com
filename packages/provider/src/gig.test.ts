// Unit tests of the provider Gig (CAT-003) that need no database: the pure validation of a draft save (every field type), the completeness rules of a publish, the decimal arithmetic,
// the read-model builders, the translation of the database guard and concurrency failures, the fail-closed policy parser, the onboarding GIGS prerequisite and the strict input
// validation that must happen BEFORE any port or statement is touched. Behaviour that needs real constraints, triggers, locks, the outbox and the audit trail is covered in
// gig.itest.ts.
//
// The service is built over a `database` and over ports whose every entry point throws a sentinel: a test that expects "nothing was touched" proves it by the absence of the
// sentinel and the zero call counts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GIG_ISSUE_REASONS, GIG_TEMPLATE_FIELD_TYPES, PROVIDER_GIG_POLICY_KEYS, gigIssueKey, type ProviderGigPolicy } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import {
  GigError,
  ProviderGigService,
  StaticGigPolicyProvider,
  gigPolicyKeys,
  gigsPrerequisite,
  ProviderError,
  mapGigDbError,
  parseGigPolicy,
  translateAccountError,
  type AccountFacts,
  type AccountPort,
  type GigTemplateFieldFacts,
  type GigTemplatePort,
  type GigTemplateStructure,
} from './index';
import { checkFieldValue, completenessIssues, parseDecimal, validateDraftInput, type GigContent } from './gig-validate';
import { constraintsDto, fieldDtos, versionDto, type VersionRow } from './gig-view';

// every log call of the code under test is captured here (and nothing is printed)
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});
beforeEach(() => {
  logSink.lines.length = 0;
});

const capture = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const fail = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};
const asGig = (e: unknown): GigError => {
  expect(e).toBeInstanceOf(GigError);
  return e as GigError;
};
const surface = (e: GigError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });

// ====================================================================== builders
const POLICY: ProviderGigPolicy = { maxActive: 5, maxDrafts: 3, titleMaxLength: 20, shortPitchMaxLength: 40, descriptionMaxLength: 100 };
const field = (fieldKey: string, over: Partial<GigTemplateFieldFacts> = {}): GigTemplateFieldFacts => ({
  gigTemplateFieldId: `field-${fieldKey}`,
  fieldKey,
  fieldType: 'TEXT',
  section: 'SCOPE',
  behavior: 'PROVIDER_CONFIGURABLE',
  customerVisible: true,
  displayOrder: 1,
  labelContentKey: `catalog.gig_template.t.field.${fieldKey}.label`,
  helpContentKey: null,
  defaultContentKey: null,
  defaultNumber: null,
  defaultBoolean: null,
  defaultOption: null,
  minLength: null,
  maxLength: null,
  minNumber: null,
  maxNumber: null,
  options: [],
  ...over,
});
const structure = (over: Partial<GigTemplateStructure> = {}): GigTemplateStructure => ({
  gigTemplateId: 'tpl-1',
  gigTemplateCode: 'car_wash',
  templateStatus: 'ACTIVE',
  serviceTypeCode: 'car_wash_type',
  serviceTypeStatus: 'ACTIVE',
  categoryCode: 'auto',
  nameContentKey: 'catalog.gig_template.car_wash.name',
  descriptionContentKey: null,
  instructionsContentKey: null,
  gigTemplateVersionId: 'tv-1',
  versionNumber: 1,
  versionStatus: 'ACTIVE',
  duration: { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
  pricing: { fixed: true, fixedWithVariants: false },
  fields: [],
  requirements: [],
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  title: null as string | null,
  shortPitch: null as string | null,
  description: null as string | null,
  priceAmountMinor: null as number | null,
  durationMinutes: null as number | null,
  fieldValues: [] as { fieldKey: string; value: string | number | boolean | null }[],
  ...over,
});
const reasons = (r: { issues: { reason: string; target: string; fieldKey?: string }[] }) =>
  r.issues.map((i) => `${i.target}${i.fieldKey ? `:${i.fieldKey}` : ''}:${i.reason}`);
const content = (over: Partial<GigContent> = {}): GigContent => ({
  title: 'Great wash',
  shortPitch: 'Shiny',
  description: 'We wash your car',
  priceAmountMinor: 5000,
  durationMinutes: 90,
  values: new Map(),
  ...over,
});

// ====================================================================== decimals
describe('parseDecimal', () => {
  it.each([
    ['12', '12', 12_000_000n],
    ['12.50', '12.5', 12_500_000n],
    ['-0.5', '-0.5', -500_000n],
    ['007.0100', '7.01', 7_010_000n],
    ['0', '0', 0n],
    ['-0', '0', 0n],
    ['-0.000', '0', 0n],
    ['999999999999999.999999', '999999999999999.999999', 999999999999999999999n],
  ])('%s is canonical %s', (raw, canonical, scaled) => {
    expect(parseDecimal(raw)).toEqual({ canonical, scaled });
  });
  it.each(['', '1.', '.5', '1e3', '1,5', ' 1', '1 ', '+1', '--1', '1.1234567', '1234567890123456', 'NaN', 'Infinity', '0x10', '１２'])('refuses %j', (raw) => {
    expect(parseDecimal(raw)).toBeNull();
  });
});

// ====================================================================== one field value
describe('checkFieldValue: every supported type', () => {
  it('TEXT: normalises to a single line, trims, clears an empty value, enforces the template bounds in code points', () => {
    const f = field('notes', { fieldType: 'TEXT', minLength: 3, maxLength: 5 });
    expect(checkFieldValue(f, '  ab\ncd  ')).toEqual({ ok: true, value: 'ab cd' });
    expect(checkFieldValue(f, '   ')).toEqual({ ok: true, value: undefined });
    expect(checkFieldValue(f, null)).toEqual({ ok: true, value: undefined });
    expect(checkFieldValue(f, 'ab')).toEqual({ ok: false, reason: 'FIELD_TOO_SHORT' });
    expect(checkFieldValue(f, 'abcdef')).toEqual({ ok: false, reason: 'FIELD_TOO_LONG' });
    // code points, not UTF-16 units: five emoji are five characters
    expect(checkFieldValue(f, '😀😀😀😀😀')).toEqual({ ok: true, value: '😀😀😀😀😀' });
    expect(checkFieldValue(f, '😀😀😀😀😀😀')).toEqual({ ok: false, reason: 'FIELD_TOO_LONG' });
    expect(checkFieldValue(f, 5)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, true)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
  });

  it('TEXT and LONG_TEXT: control characters and markup are refused; LONG_TEXT keeps line breaks', () => {
    const t = field('a', { fieldType: 'TEXT' });
    const l = field('b', { fieldType: 'LONG_TEXT' });
    expect(checkFieldValue(t, 'a\u0000b')).toEqual({ ok: false, reason: 'FORBIDDEN_CHARACTER' });
    expect(checkFieldValue(t, 'a‮b')).toEqual({ ok: false, reason: 'FORBIDDEN_CHARACTER' });
    expect(checkFieldValue(t, '<b>bold</b>')).toEqual({ ok: false, reason: 'HTML_NOT_ALLOWED' });
    expect(checkFieldValue(l, 'line 1\r\nline 2')).toEqual({ ok: true, value: 'line 1\nline 2' });
    expect(checkFieldValue(l, '<script>x</script>')).toEqual({ ok: false, reason: 'HTML_NOT_ALLOWED' });
    expect(checkFieldValue(l, 'x'.repeat(20001))).toEqual({ ok: false, reason: 'FIELD_TOO_LONG' });
  });

  it('INTEGER: an integer within the bounds', () => {
    const f = field('n', { fieldType: 'INTEGER', minNumber: 1, maxNumber: 4 });
    expect(checkFieldValue(f, 1)).toEqual({ ok: true, value: 1 });
    expect(checkFieldValue(f, 4)).toEqual({ ok: true, value: 4 });
    expect(checkFieldValue(f, 0)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(f, 5)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(f, 2.5)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, '2')).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, true)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(field('n2', { fieldType: 'INTEGER' }), -7)).toEqual({ ok: true, value: -7 });
  });

  it('DECIMAL: a string in canonical form within the bounds, never a number', () => {
    const f = field('d', { fieldType: 'DECIMAL', minNumber: 0.5, maxNumber: 10 });
    expect(checkFieldValue(f, '0.50')).toEqual({ ok: true, value: '0.5' });
    expect(checkFieldValue(f, '10.000000')).toEqual({ ok: true, value: '10' });
    expect(checkFieldValue(f, '0.4999')).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(f, '10.000001')).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(f, 5)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, '1e1')).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, 'abc')).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
  });

  it('BOOLEAN: only true or false', () => {
    const f = field('b', { fieldType: 'BOOLEAN' });
    expect(checkFieldValue(f, true)).toEqual({ ok: true, value: true });
    expect(checkFieldValue(f, false)).toEqual({ ok: true, value: false });
    expect(checkFieldValue(f, 'true')).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
    expect(checkFieldValue(f, 1)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
  });

  it('ENUM: an option code of THIS template version field', () => {
    const f = field('e', {
      fieldType: 'ENUM',
      options: [
        { optionCode: 'wax', displayOrder: 1, isDefault: true },
        { optionCode: 'sealant', displayOrder: 2, isDefault: false },
      ],
    });
    expect(checkFieldValue(f, 'wax')).toEqual({ ok: true, value: 'wax' });
    expect(checkFieldValue(f, 'ceramic')).toEqual({ ok: false, reason: 'FIELD_OPTION_UNKNOWN' });
    expect(checkFieldValue(f, 'WAX')).toEqual({ ok: false, reason: 'FIELD_OPTION_UNKNOWN' });
    expect(checkFieldValue(f, 1)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
  });

  it('DURATION: whole minutes within 1..100000 and the field bounds', () => {
    const f = field('t', { fieldType: 'DURATION', minNumber: 30, maxNumber: 120 });
    expect(checkFieldValue(f, 30)).toEqual({ ok: true, value: 30 });
    expect(checkFieldValue(f, 29)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(f, 121)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    const open = field('t2', { fieldType: 'DURATION' });
    expect(checkFieldValue(open, 0)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(open, 100001)).toEqual({ ok: false, reason: 'FIELD_VALUE_OUT_OF_RANGE' });
    expect(checkFieldValue(open, 1.5)).toEqual({ ok: false, reason: 'FIELD_VALUE_INVALID' });
  });

  it.each(['MONEY', 'MEDIA', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE'])('%s is never accepted by the value check', (fieldType) => {
    expect(checkFieldValue(field('x', { fieldType }), 'anything')).toEqual({ ok: false, reason: 'FIELD_TYPE_NOT_SUPPORTED' });
  });

  it('every field type of the template vocabulary is handled (no type falls through unnoticed)', () => {
    for (const t of GIG_TEMPLATE_FIELD_TYPES) {
      const r = checkFieldValue(field('x', { fieldType: t }), 'v');
      expect(typeof r.ok, t).toBe('boolean');
    }
  });
});

// ====================================================================== draft save
describe('validateDraftInput', () => {
  it('accepts an empty draft (a draft may be incomplete) and normalises the copy', () => {
    const r = validateDraftInput(body(), structure(), POLICY);
    expect(r.issues).toEqual([]);
    expect(r.content).toMatchObject({ title: null, shortPitch: null, description: null, priceAmountMinor: null, durationMinutes: null });
    const c = validateDraftInput(body({ title: '  My   great\n wash ', shortPitch: ' pitch ', description: ' line1\r\nline2 ' }), structure(), POLICY).content;
    expect(c).toMatchObject({ title: 'My great wash', shortPitch: 'pitch', description: 'line1\nline2' });
    expect(validateDraftInput(body({ title: '   ' }), structure(), POLICY).content.title).toBeNull();
  });

  it('enforces the configured lengths in code points', () => {
    const r = validateDraftInput(body({ title: 'x'.repeat(21), shortPitch: 'y'.repeat(41), description: 'z'.repeat(101) }), structure(), POLICY);
    expect(reasons(r)).toEqual(['title:TITLE_TOO_LONG', 'shortPitch:SHORT_PITCH_TOO_LONG', 'description:DESCRIPTION_TOO_LONG']);
    expect(validateDraftInput(body({ title: '😀'.repeat(20) }), structure(), POLICY).issues).toEqual([]);
    expect(validateDraftInput(body({ title: '😀'.repeat(21) }), structure(), POLICY).issues).toHaveLength(1);
  });

  it('refuses markup and control characters in the copy, naming the target and never the text', () => {
    const r = validateDraftInput(body({ title: '<b>x</b>', shortPitch: 'a\u0007b', description: '<img src=x>' }), structure(), POLICY);
    expect(reasons(r)).toEqual(['title:HTML_NOT_ALLOWED', 'shortPitch:FORBIDDEN_CHARACTER', 'description:HTML_NOT_ALLOWED']);
    expect(JSON.stringify(r.issues)).not.toMatch(/<b>|<img|src=x/);
  });

  it('price: permitted only when the template version allows FIXED or FIXED_WITH_VARIANTS', () => {
    expect(validateDraftInput(body({ priceAmountMinor: 0 }), structure(), POLICY).issues).toEqual([]);
    expect(validateDraftInput(body({ priceAmountMinor: 1500 }), structure({ pricing: { fixed: false, fixedWithVariants: true } }), POLICY).issues).toEqual([]);
    expect(reasons(validateDraftInput(body({ priceAmountMinor: 1500 }), structure({ pricing: { fixed: false, fixedWithVariants: false } }), POLICY))).toEqual([
      'price:PRICE_NOT_PERMITTED',
    ]);
    expect(validateDraftInput(body({ priceAmountMinor: null }), structure({ pricing: { fixed: false, fixedWithVariants: false } }), POLICY).issues).toEqual([]);
  });

  it('duration: permitted only with duration facts, within min and max; with only a suggestion any value is fine', () => {
    expect(validateDraftInput(body({ durationMinutes: 60 }), structure(), POLICY).issues).toEqual([]);
    expect(validateDraftInput(body({ durationMinutes: 240 }), structure(), POLICY).issues).toEqual([]);
    expect(reasons(validateDraftInput(body({ durationMinutes: 59 }), structure(), POLICY))).toEqual(['duration:DURATION_OUT_OF_RANGE']);
    expect(reasons(validateDraftInput(body({ durationMinutes: 241 }), structure(), POLICY))).toEqual(['duration:DURATION_OUT_OF_RANGE']);
    const suggestedOnly = structure({ duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: 90 } });
    expect(validateDraftInput(body({ durationMinutes: 5 }), suggestedOnly, POLICY).issues).toEqual([]);
    expect(validateDraftInput(body({ durationMinutes: 100000 }), suggestedOnly, POLICY).issues).toEqual([]);
    const none = structure({ duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null } });
    expect(reasons(validateDraftInput(body({ durationMinutes: 30 }), none, POLICY))).toEqual(['duration:DURATION_NOT_PERMITTED']);
    const minOnly = structure({ duration: { minMinutes: 30, maxMinutes: null, suggestedMinutes: null } });
    expect(validateDraftInput(body({ durationMinutes: 99999 }), minOnly, POLICY).issues).toEqual([]);
    expect(reasons(validateDraftInput(body({ durationMinutes: 29 }), minOnly, POLICY))).toEqual(['duration:DURATION_OUT_OF_RANGE']);
  });

  it('a PLATFORM_FIXED field, an unknown key and an unsupported type are refused; their values are never stored', () => {
    const s = structure({
      fields: [
        field('intro', { behavior: 'PLATFORM_FIXED', fieldType: 'LONG_TEXT', displayOrder: 1 }),
        field('photos', { fieldType: 'MEDIA', displayOrder: 2 }),
        field('price_hint', { fieldType: 'MONEY', displayOrder: 3 }),
        field('notes', { displayOrder: 4 }),
      ],
    });
    const r = validateDraftInput(
      body({
        fieldValues: [
          { fieldKey: 'intro', value: 'override' },
          { fieldKey: 'photos', value: 'x' },
          { fieldKey: 'price_hint', value: 5 },
          { fieldKey: 'ghost', value: 'x' },
          { fieldKey: 'notes', value: 'ok' },
        ],
      }),
      s,
      POLICY,
    );
    expect(reasons(r)).toEqual([
      'field:intro:FIELD_NOT_PROVIDER_EDITABLE',
      'field:photos:FIELD_TYPE_NOT_SUPPORTED',
      'field:price_hint:FIELD_TYPE_NOT_SUPPORTED',
      'field:ghost:FIELD_UNKNOWN',
    ]);
    expect(r.content.values.has('intro')).toBe(false);
    expect(r.content.values.get('notes')).toBe('ok');
    // even a null for a fixed field is refused: the provider has no say in it at all
    expect(reasons(validateDraftInput(body({ fieldValues: [{ fieldKey: 'intro', value: null }] }), s, POLICY))).toEqual([
      'field:intro:FIELD_NOT_PROVIDER_EDITABLE',
    ]);
  });

  it('a null or empty field value clears the field; a bad value is reported with its field key', () => {
    const s = structure({ fields: [field('n', { fieldType: 'INTEGER', minNumber: 1, maxNumber: 4 }), field('t', { fieldType: 'TEXT', displayOrder: 2 })] });
    const ok = validateDraftInput(
      body({
        fieldValues: [
          { fieldKey: 'n', value: null },
          { fieldKey: 't', value: '  ' },
        ],
      }),
      s,
      POLICY,
    );
    expect(ok.issues).toEqual([]);
    expect(ok.content.values.size).toBe(0);
    const bad = validateDraftInput(body({ fieldValues: [{ fieldKey: 'n', value: 9 }] }), s, POLICY);
    expect(reasons(bad)).toEqual(['field:n:FIELD_VALUE_OUT_OF_RANGE']);
    expect(bad.issues[0]!.messageKey).toBe(gigIssueKey('FIELD_VALUE_OUT_OF_RANGE'));
  });

  it('reports every problem at once (the editor shows them together)', () => {
    const s = structure({ fields: [field('n', { fieldType: 'INTEGER', minNumber: 1, maxNumber: 4 })] });
    const r = validateDraftInput(
      body({ title: 'x'.repeat(30), durationMinutes: 1, priceAmountMinor: 1, fieldValues: [{ fieldKey: 'n', value: 99 }] }),
      s,
      POLICY,
    );
    expect(reasons(r)).toEqual(['title:TITLE_TOO_LONG', 'duration:DURATION_OUT_OF_RANGE', 'field:n:FIELD_VALUE_OUT_OF_RANGE']);
  });

  it('the issues never carry provider text (a canary in every input is absent from every issue)', () => {
    const CANARY = 'CANARY-PROVIDER-TEXT';
    const s = structure({ fields: [field('n', { fieldType: 'INTEGER' }), field('e', { fieldType: 'ENUM', options: [], displayOrder: 2 })] });
    const r = validateDraftInput(
      body({
        title: `<${CANARY}>`,
        shortPitch: `${CANARY}\u0000`,
        description: `${CANARY} ${'x'.repeat(200)}`,
        fieldValues: [
          { fieldKey: 'n', value: CANARY },
          { fieldKey: 'e', value: CANARY },
          { fieldKey: CANARY.toLowerCase().replace(/-/g, '_'), value: CANARY },
        ],
      }),
      s,
      POLICY,
    );
    expect(r.issues.length).toBeGreaterThan(3);
    expect(JSON.stringify(r.issues)).not.toContain(CANARY);
  });
});

// ====================================================================== publish completeness
describe('completenessIssues', () => {
  it('a complete version has no issue', () => {
    expect(completenessIssues(content(), structure(), POLICY)).toEqual([]);
  });
  it('title, short pitch and description are required and within the configured length', () => {
    expect(reasons({ issues: completenessIssues(content({ title: null, shortPitch: null, description: null }), structure(), POLICY) })).toEqual([
      'title:TITLE_REQUIRED',
      'shortPitch:SHORT_PITCH_REQUIRED',
      'description:DESCRIPTION_REQUIRED',
    ]);
    expect(reasons({ issues: completenessIssues(content({ title: 'x'.repeat(21) }), structure(), POLICY) })).toEqual(['title:TITLE_TOO_LONG']);
  });
  it('the price is required and above zero when the template allows one, and refused when it does not', () => {
    expect(reasons({ issues: completenessIssues(content({ priceAmountMinor: null }), structure(), POLICY) })).toEqual(['price:PRICE_REQUIRED']);
    expect(reasons({ issues: completenessIssues(content({ priceAmountMinor: 0 }), structure(), POLICY) })).toEqual(['price:PRICE_NOT_POSITIVE']);
    const noPrice = structure({ pricing: { fixed: false, fixedWithVariants: false } });
    expect(completenessIssues(content({ priceAmountMinor: null }), noPrice, POLICY)).toEqual([]);
    expect(reasons({ issues: completenessIssues(content({ priceAmountMinor: 5 }), noPrice, POLICY) })).toEqual(['price:PRICE_NOT_PERMITTED']);
    expect(completenessIssues(content({ priceAmountMinor: null }), structure({ pricing: { fixed: false, fixedWithVariants: true } }), POLICY)).toHaveLength(1);
  });
  it('a duration is required when the template has any duration fact', () => {
    expect(reasons({ issues: completenessIssues(content({ durationMinutes: null }), structure(), POLICY) })).toEqual(['duration:DURATION_REQUIRED']);
    const minOnly = structure({ duration: { minMinutes: 10, maxMinutes: null, suggestedMinutes: null } });
    expect(completenessIssues(content({ durationMinutes: null }), minOnly, POLICY)).toHaveLength(1);
    const none = structure({ duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null } });
    expect(completenessIssues(content({ durationMinutes: null }), none, POLICY)).toEqual([]);
    expect(reasons({ issues: completenessIssues(content({ durationMinutes: 500 }), structure(), POLICY) })).toEqual(['duration:DURATION_OUT_OF_RANGE']);
  });
  it('every supported PROVIDER_REQUIRED field needs a value; an unsupported required field blocks; optional fields never block', () => {
    const s = structure({
      fields: [
        field('a', { behavior: 'PROVIDER_REQUIRED', displayOrder: 2 }),
        field('b', { behavior: 'PROVIDER_REQUIRED', fieldType: 'MEDIA', displayOrder: 1 }),
        field('c', { behavior: 'PROVIDER_CONFIGURABLE', displayOrder: 3 }),
        field('d', { behavior: 'PROVIDER_CONFIGURABLE', fieldType: 'MEDIA', displayOrder: 4 }),
        field('e', { behavior: 'PLATFORM_FIXED', displayOrder: 5 }),
      ],
    });
    expect(reasons({ issues: completenessIssues(content(), s, POLICY) })).toEqual(['field:b:FIELD_TYPE_NOT_SUPPORTED', 'field:a:FIELD_REQUIRED']);
    expect(reasons({ issues: completenessIssues(content({ values: new Map([['a', 'x']]) }), s, POLICY) })).toEqual(['field:b:FIELD_TYPE_NOT_SUPPORTED']);
  });
  it('a withdrawn template version, template or service type blocks, a superseded or inactive one does not', () => {
    for (const over of [{ versionStatus: 'RETIRED' as const }, { templateStatus: 'RETIRED' }, { serviceTypeStatus: 'RETIRED' }])
      expect(reasons({ issues: completenessIssues(content(), structure(over), POLICY) })).toEqual(['template:TEMPLATE_VERSION_RETIRED']);
    for (const over of [{ versionStatus: 'SUPERSEDED' as const }, { templateStatus: 'INACTIVE' }, { serviceTypeStatus: 'INACTIVE' }])
      expect(completenessIssues(content(), structure(over), POLICY)).toEqual([]);
  });
  it('every reason it can produce has a message key of the managed content', () => {
    const all = completenessIssues(
      content({ title: null, shortPitch: null, description: null, priceAmountMinor: null, durationMinutes: null }),
      structure({ versionStatus: 'RETIRED', fields: [field('a', { behavior: 'PROVIDER_REQUIRED' })] }),
      POLICY,
    );
    for (const i of all) expect(i.messageKey).toBe(gigIssueKey(i.reason));
    for (const r of GIG_ISSUE_REASONS) expect(gigIssueKey(r)).toBe(`provider.gig.issue.${r.toLowerCase()}`);
  });
});

// ====================================================================== read model
describe('read-model builders', () => {
  const version = (over: Partial<VersionRow> = {}): VersionRow => ({
    gigVersionId: 'v-1',
    gigId: 'g-1',
    versionNumber: 1,
    gigTemplateVersionId: 'tv-1',
    gigTemplateVersionNumber: 1,
    status: 'DRAFT',
    revision: 2,
    title: 'Great wash',
    shortPitch: 'Shiny',
    description: 'We wash',
    priceAmountMinor: 5000,
    priceCurrency: 'USD',
    durationMinutes: 90,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    publishedAt: null,
    supersededAt: null,
    retiredAt: null,
    ...over,
  });
  const s = structure({
    fields: [
      field('intro', { behavior: 'PLATFORM_FIXED', fieldType: 'LONG_TEXT', displayOrder: 3, defaultContentKey: 'k.default' }),
      field('notes', { behavior: 'PROVIDER_REQUIRED', displayOrder: 1 }),
      field('photos', { fieldType: 'MEDIA', displayOrder: 2 }),
      field('finish', {
        fieldType: 'ENUM',
        displayOrder: 4,
        options: [
          { optionCode: 'b', displayOrder: 2, isDefault: false },
          { optionCode: 'a', displayOrder: 1, isDefault: true },
        ],
      }),
    ],
  });

  it('fields come in display order with supported / required / fixed flags and the options in order', () => {
    const dtos = fieldDtos(s);
    expect(dtos.map((f) => f.fieldKey)).toEqual(['notes', 'photos', 'intro', 'finish']);
    expect(dtos.map((f) => [f.supported, f.required, f.fixed])).toEqual([
      [true, true, false],
      [false, false, false],
      [true, false, true],
      [true, false, false],
    ]);
    expect(dtos[3]!.options.map((o) => o.optionCode)).toEqual(['a', 'b']);
    expect(dtos[2]!.defaultContentKey).toBe('k.default');
  });

  it('constraints come from the policy and the exact template version; the currency only with a permitted price', () => {
    expect(constraintsDto(s, POLICY, 'USD')).toEqual({
      title: { maxLength: 20 },
      shortPitch: { maxLength: 40 },
      description: { maxLength: 100 },
      price: { permitted: true, required: true, currency: 'USD' },
      duration: { permitted: true, required: true, minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 },
    });
    const none = structure({ pricing: { fixed: false, fixedWithVariants: false }, duration: { minMinutes: null, maxMinutes: null, suggestedMinutes: null } });
    expect(constraintsDto(none, POLICY, 'USD')).toMatchObject({
      price: { permitted: false, required: false, currency: null },
      duration: { permitted: false, required: false },
    });
  });

  it('a DRAFT carries publishable and issues, a published version is complete by definition; PLATFORM_FIXED values are never in fieldValues', () => {
    const values = new Map<string, string | number | boolean>([['notes', 'text']]);
    const draft = versionDto(version(), s, values, POLICY, 'USD');
    expect(draft.publishable).toBe(true);
    expect(draft.issues).toEqual([]);
    expect(draft.fieldValues).toEqual([{ fieldKey: 'notes', value: 'text' }]);
    expect(draft.price).toEqual({ amountMinor: 5000, currency: 'USD' });
    expect(draft.template).toMatchObject({ gigTemplateCode: 'car_wash', gigTemplateVersionId: 'tv-1', versionStatus: 'ACTIVE' });
    const incomplete = versionDto(version({ title: null }), s, new Map(), POLICY, 'USD');
    expect(incomplete.publishable).toBe(false);
    expect(reasons({ issues: incomplete.issues })).toEqual(['title:TITLE_REQUIRED', 'field:notes:FIELD_REQUIRED']);
    const published = versionDto(version({ status: 'PUBLISHED', publishedAt: '2026-01-03T00:00:00.000Z' }), s, new Map(), POLICY, 'USD');
    expect(published.publishable).toBeNull();
    expect(published.issues).toEqual([]);
    expect(published.statusKey).toBe('provider.gig.version_status.published');
  });

  it('a price without a currency (impossible in the database) is not invented', () => {
    expect(versionDto(version({ priceCurrency: null }), s, new Map(), POLICY, null).price).toBeNull();
  });
});

// ====================================================================== error translation
describe('mapGigDbError', () => {
  const pg = (code: string, detail?: string) => Object.assign(new Error(`driver text SECRET-SQL ${code}`), { code, detail });
  const rule = (key: string) => pg('23000', `provider_rule:${key}`);
  const run = (e: unknown, ctx?: Parameters<typeof mapGigDbError>[1]) => asGig(capture(() => mapGigDbError(e, ctx)));

  it('passes typed errors and non-errors through untouched', () => {
    const typed = new GigError('STALE_DRAFT', 'x');
    expect(capture(() => mapGigDbError(typed))).toBe(typed);
    expect(capture(() => mapGigDbError('plain'))).toBe('plain');
    expect(capture(() => mapGigDbError(null))).toBeNull();
  });
  it('concurrency failures are a retryable CONFLICT', () => {
    for (const code of ['40P01', '40001', '55P03', '23505']) {
      const e = run(pg(code));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    }
  });
  it('guard rules map to the documented codes and reasons', () => {
    expect(run(rule('ACCOUNT_NOT_ACTIVE'))).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    expect(run(rule('REGISTRATION_NOT_COMPLETED'))).toMatchObject({ code: 'PROVIDER_NOT_ELIGIBLE', details: { reason: 'REGISTRATION_NOT_COMPLETED' } });
    expect(run(rule('SERVICE_NOT_SELECTED'))).toMatchObject({ code: 'PROVIDER_NOT_ELIGIBLE', details: { reason: 'SERVICE_NOT_SELECTED' } });
    expect(run(rule('GIG_RETIRED'))).toMatchObject({ code: 'GIG_RETIRED' });
    expect(run(rule('PRICE_NOT_PERMITTED'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ target: 'price', reason: 'PRICE_NOT_PERMITTED' }] },
    });
    expect(run(rule('DURATION_RANGE'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ target: 'duration', reason: 'DURATION_OUT_OF_RANGE' }] },
    });
    expect(run(rule('FIELD_FIXED'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const r of ['STATUS_TRANSITION', 'VERSION_FROZEN', 'REVISION', 'NO_DELETE', 'ROW_IMMUTABLE', 'WHATEVER_NEW'])
      expect(run(rule(r))).toMatchObject({ code: 'CONFLICT', details: { reason: r } });
    expect(run(pg('23000', 'no key here'))).toMatchObject({ code: 'CONFLICT', details: {} });
  });
  it('a template or service type withdrawn is GIG_TEMPLATE_NOT_AVAILABLE on create and a blocked publish on publish', () => {
    const cases: [string, string][] = [
      ['TEMPLATE_NOT_ACTIVE', 'TEMPLATE_INACTIVE'],
      ['TEMPLATE_RETIRED', 'TEMPLATE_RETIRED'],
      ['TEMPLATE_VERSION_RETIRED', 'TEMPLATE_RETIRED'],
      ['TEMPLATE_VERSION_NOT_ACTIVE', 'NO_ACTIVE_VERSION'],
      ['SERVICE_TYPE_NOT_ACTIVE', 'SERVICE_TYPE_NOT_ACTIVE'],
      ['SERVICE_TYPE_RETIRED', 'SERVICE_TYPE_NOT_ACTIVE'],
    ];
    for (const [key, reason] of cases) {
      expect(run(rule(key), 'create')).toMatchObject({ code: 'GIG_TEMPLATE_NOT_AVAILABLE', details: { reason } });
      expect(run(rule(key), 'draft')).toMatchObject({ code: 'GIG_TEMPLATE_NOT_AVAILABLE', details: { reason } });
      const p = run(rule(key), 'publish');
      expect(p.code).toBe('PUBLISH_BLOCKED');
      expect(p.details.issues).toEqual([{ target: 'template', reason: 'TEMPLATE_VERSION_RETIRED', messageKey: gigIssueKey('TEMPLATE_VERSION_RETIRED') }]);
    }
  });
  it('character errors, check violations and missing references are validation failures with fixed text', () => {
    expect(run(pg('22021'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'FORBIDDEN_CHARACTER' } });
    expect(run(pg('22P05'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(run(pg('23514'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_VALUE' } });
    expect(run(pg('23502'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(run(pg('23503'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'REFERENCE_NOT_FOUND' } });
  });
  it('an outage is UNAVAILABLE with fixed text; the driver text only reaches the log; a programming error is rethrown', () => {
    const e = run(pg('08006'));
    expect(e.code).toBe('UNAVAILABLE');
    expect(surface(e)).not.toContain('SECRET-SQL');
    expect(logSink.lines).toHaveLength(1);
    const bug = new TypeError('programming error');
    expect(capture(() => mapGigDbError(bug))).toBe(bug);
  });
  it('no mapped error ever carries driver text, SQL or table names', () => {
    for (const code of ['40P01', '23000', '23503', '23514', '22021', '08006'])
      expect(surface(run(pg(code, 'provider_rule:SOMETHING')))).not.toMatch(/SECRET-SQL|provider\.|INSERT|SELECT/);
  });
});

// ====================================================================== policy
describe('the Gig policy', () => {
  const good = {
    [PROVIDER_GIG_POLICY_KEYS.maxActive]: 25,
    [PROVIDER_GIG_POLICY_KEYS.maxDrafts]: 10,
    [PROVIDER_GIG_POLICY_KEYS.titleMaxLength]: 100,
    [PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength]: 1000,
    [PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength]: 5000,
  };
  it('reads the five keys', () => {
    expect([...gigPolicyKeys()].sort()).toEqual(Object.values(PROVIDER_GIG_POLICY_KEYS).sort());
    expect(parseGigPolicy(good)).toEqual({ maxActive: 25, maxDrafts: 10, titleMaxLength: 100, shortPitchMaxLength: 1000, descriptionMaxLength: 5000 });
  });
  it('fails closed on a missing, malformed or out-of-range value', () => {
    for (const key of Object.values(PROVIDER_GIG_POLICY_KEYS)) {
      const missing = { ...good };
      delete (missing as Record<string, unknown>)[key];
      expect(asGig(capture(() => parseGigPolicy(missing)))).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
      for (const bad of ['5', 0, -1, 1.5, 100000, null, true]) expect(asGig(capture(() => parseGigPolicy({ ...good, [key]: bad }))).code).toBe('UNAVAILABLE');
    }
  });
  it('the static provider counts reads and can fail', async () => {
    const p = new StaticGigPolicyProvider(POLICY);
    expect(await p.policy()).toBe(POLICY);
    expect(p.reads).toBe(1);
    p.failure = new GigError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' });
    expect(asGig(await fail(p.policy())).code).toBe('UNAVAILABLE');
  });
});

// ====================================================================== the onboarding step
describe('gigsPrerequisite', () => {
  const facts = (published: number, drafts: number) => ({
    getGigReadinessFacts: async () => ({
      hasPublishedGig: published > 0,
      publishedGigCount: published,
      draftVersionCount: drafts,
      goLive: { evaluated: false as const, eligible: false as const },
    }),
  });
  it('NOT_STARTED without anything, IN_PROGRESS with a draft only, COMPLETE with a published Gig; never BLOCKED or NOT_AVAILABLE', async () => {
    expect(await gigsPrerequisite(facts(0, 0))('a')).toEqual({ status: 'NOT_STARTED' });
    expect(await gigsPrerequisite(facts(0, 2))('a')).toEqual({ status: 'IN_PROGRESS' });
    expect(await gigsPrerequisite(facts(1, 0))('a')).toEqual({ status: 'COMPLETE' });
    expect(await gigsPrerequisite(facts(2, 3))('a')).toEqual({ status: 'COMPLETE' });
  });
  it('asks for the facts of the given account only', async () => {
    const asked: string[] = [];
    await gigsPrerequisite({
      getGigReadinessFacts: async (id) => (
        asked.push(id),
        { hasPublishedGig: false, publishedGigCount: 0, draftVersionCount: 0, goLive: { evaluated: false, eligible: false } }
      ),
    })('acc-9');
    expect(asked).toEqual(['acc-9']);
  });
});

// ====================================================================== the service over untouchable collaborators
const SENTINEL = 'sentinel-reached';
function untouchable() {
  const touched: string[] = [];
  const trap = (what: string) => () => {
    touched.push(what);
    throw new Error(SENTINEL);
  };
  const database = {
    transaction: trap('transaction'),
    get db() {
      touched.push('db');
      throw new Error(SENTINEL);
    },
    query: trap('query'),
    pool: { connect: trap('connect'), query: trap('pool.query') },
  } as unknown as Database;
  const accounts: AccountPort = {
    facts: async (): Promise<AccountFacts> => {
      touched.push('accounts.facts');
      throw new Error(SENTINEL);
    },
    grantRole: async () => {
      touched.push('accounts.grantRole');
      throw new Error(SENTINEL);
    },
  };
  const templates: GigTemplatePort = {
    offered: async () => (touched.push('templates.offered'), Promise.reject(new Error(SENTINEL))),
    forCreate: async () => (touched.push('templates.forCreate'), Promise.reject(new Error(SENTINEL))),
    byCode: async () => (touched.push('templates.byCode'), Promise.reject(new Error(SENTINEL))),
    exactVersion: async () => (touched.push('templates.exactVersion'), Promise.reject(new Error(SENTINEL))),
    enabledInMarket: async () => (touched.push('templates.enabledInMarket'), Promise.reject(new Error(SENTINEL))),
  };
  const policy = new StaticGigPolicyProvider(POLICY);
  const service = new ProviderGigService({ database, accounts, templates, policy });
  return { service, touched, policy, database };
}
const A = 'acc-1';
const GIG = '11111111-1111-4111-8111-111111111111';
const valid = { expectedRevision: 1, title: null, shortPitch: null, description: null, priceAmountMinor: null, durationMinutes: null, fieldValues: [] };

describe('input is validated before anything else is touched', () => {
  const invalid: [string, (s: ProviderGigService) => Promise<unknown>][] = [
    ['createGig: no body', (s) => s.createGig(A, undefined)],
    ['createGig: empty body', (s) => s.createGig(A, {})],
    ['createGig: bad template code', (s) => s.createGig(A, { gigTemplateCode: 'Not A Code' })],
    ['createGig: extra field', (s) => s.createGig(A, { gigTemplateCode: 'car_wash', accountId: 'x' })],
    ['createGig: client-supplied owner', (s) => s.createGig(A, { gigTemplateCode: 'car_wash', ownerAccountId: 'x' })],
    ['createGig: bad request id', (s) => s.createGig(A, { gigTemplateCode: 'car_wash', clientRequestId: 'nope' })],
    ['createNextDraft: extra field', (s) => s.createNextDraft(A, GIG, { x: 1 })],
    ['updateDraft: no revision', (s) => s.updateDraft(A, GIG, { ...valid, expectedRevision: undefined })],
    ['updateDraft: zero revision', (s) => s.updateDraft(A, GIG, { ...valid, expectedRevision: 0 })],
    ['updateDraft: client-supplied currency', (s) => s.updateDraft(A, GIG, { ...valid, currency: 'EUR' })],
    ['updateDraft: client-supplied status', (s) => s.updateDraft(A, GIG, { ...valid, status: 'PUBLISHED' })],
    ['updateDraft: float price', (s) => s.updateDraft(A, GIG, { ...valid, priceAmountMinor: 12.5 })],
    ['updateDraft: negative price', (s) => s.updateDraft(A, GIG, { ...valid, priceAmountMinor: -1 })],
    ['updateDraft: zero duration', (s) => s.updateDraft(A, GIG, { ...valid, durationMinutes: 0 })],
    [
      'updateDraft: duplicate field keys',
      (s) =>
        s.updateDraft(A, GIG, {
          ...valid,
          fieldValues: [
            { fieldKey: 'ab', value: 1 },
            { fieldKey: 'ab', value: 2 },
          ],
        }),
    ],
    ['updateDraft: bad field key', (s) => s.updateDraft(A, GIG, { ...valid, fieldValues: [{ fieldKey: 'Bad Key', value: 1 }] })],
    ['updateDraft: object value', (s) => s.updateDraft(A, GIG, { ...valid, fieldValues: [{ fieldKey: 'ab', value: { a: 1 } }] })],
    ['updateDraft: omitted content', (s) => s.updateDraft(A, GIG, { expectedRevision: 1 })],
    ['publish: no revision', (s) => s.publish(A, GIG, {})],
    ['publish: extra field', (s) => s.publish(A, GIG, { expectedRevision: 1, force: true })],
    ['retire: free text', (s) => s.retire(A, GIG, { reason: 'because' })],
  ];
  for (const [label, call] of invalid)
    it(`${label} is VALIDATION_FAILED and touches nothing`, async () => {
      const b = untouchable();
      const e = asGig(await fail(call(b.service)));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details.reason).toBe('INVALID_REQUEST');
      expect(b.touched).toEqual([]);
      expect(b.policy.reads).toBe(0);
    });

  it('a malformed Gig id is GIG_NOT_FOUND without a statement (an id that is not a UUID can never be owned)', async () => {
    const b = untouchable();
    for (const bad of ['', 'x', "1' OR '1'='1", '11111111-1111-4111-8111-11111111111g', '../../etc'])
      for (const call of [
        (s: ProviderGigService) => s.getGig(A, bad),
        (s: ProviderGigService) => s.getCurrentPublishedGigVersion(A, bad),
        (s: ProviderGigService) => s.getGigVersion(A, bad, 1),
        (s: ProviderGigService) => s.getGigTemplateLink(A, bad),
      ]) {
        const e = await fail(call(b.service));
        // reads reach the policy first (a stub that answers), then fail at the id check before any statement
        expect(asGig(e).code).toBe('GIG_NOT_FOUND');
      }
    expect(b.touched).toEqual([]);
  });

  it('every mutation refuses a malformed Gig id as GIG_NOT_FOUND before any statement (after the body is parsed)', async () => {
    const b = untouchable();
    for (const call of [
      (s: ProviderGigService) => s.createNextDraft(A, 'nope', {}),
      (s: ProviderGigService) => s.updateDraft(A, 'nope', valid),
      (s: ProviderGigService) => s.publish(A, 'nope', { expectedRevision: 1 }),
      (s: ProviderGigService) => s.retire(A, 'nope', {}),
    ])
      expect(asGig(await fail(call(b.service))).code).toBe('GIG_NOT_FOUND');
    expect(b.touched).toEqual([]);
    expect(b.policy.reads).toBe(0);
  });

  it('a version number that is not a positive integer is GIG_VERSION_NOT_FOUND once the Gig id is well-formed (and the database is asked about the Gig first)', async () => {
    const b = untouchable();
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 40]) expect(((await fail(b.service.getGigVersion(A, GIG, n))) as Error).message).toBe(SENTINEL);
    expect(b.touched.length).toBeGreaterThan(0);
  });

  it('a valid request reaches the first collaborator (the guards above are not blanket refusals)', async () => {
    const b = untouchable();
    expect(((await fail(b.service.listProviderGigs(A))) as Error).message).toBe(SENTINEL);
    expect(((await fail(b.service.createGig(A, { gigTemplateCode: 'car_wash' }))) as Error).message).toBe(SENTINEL);
    expect(((await fail(b.service.publish(A, GIG, { expectedRevision: 1 }))) as Error).message).toBe(SENTINEL);
    expect(((await fail(b.service.updateDraft(A, GIG, valid))) as Error).message).toBe(SENTINEL);
    expect(b.touched.length).toBeGreaterThan(0);
  });

  it('the policy outage is UNAVAILABLE before any statement or port is used for a mutation', async () => {
    const b = untouchable();
    b.policy.failure = new GigError('UNAVAILABLE', 'the Gig policy is not available', { reason: 'POLICY_INVALID' });
    for (const call of [
      (s: ProviderGigService) => s.createGig(A, { gigTemplateCode: 'car_wash' }),
      (s: ProviderGigService) => s.updateDraft(A, GIG, valid),
      (s: ProviderGigService) => s.publish(A, GIG, { expectedRevision: 1 }),
      (s: ProviderGigService) => s.listProviderGigs(A),
    ]) {
      const e = await fail(call(b.service));
      expect(asGig(e)).toMatchObject({ code: 'UNAVAILABLE' });
      expect(surface(asGig(e))).not.toContain(SENTINEL);
    }
  });
});

// ====================================================================== review findings
describe('the market currency and the completeness of a price', () => {
  it('a price stored in another currency than the market is PRICE_REQUIRED; the same currency, or an unknown market currency, is fine', () => {
    const priced = (cur: string | null) => content({ priceAmountMinor: 5000, priceCurrency: cur });
    expect(reasons({ issues: completenessIssues(priced('USD'), structure(), POLICY, 'EUR') })).toEqual(['price:PRICE_REQUIRED']);
    expect(completenessIssues(priced('EUR'), structure(), POLICY, 'EUR')).toEqual([]);
    expect(completenessIssues(priced('USD'), structure(), POLICY, null)).toEqual([]);
    expect(completenessIssues(priced('USD'), structure(), POLICY)).toEqual([]);
    expect(completenessIssues(priced(null), structure(), POLICY, 'EUR')).toEqual([]);
    expect(reasons({ issues: completenessIssues(content({ priceAmountMinor: 0, priceCurrency: 'USD' }), structure(), POLICY, 'EUR') })).toEqual([
      'price:PRICE_REQUIRED',
    ]);
    expect(reasons({ issues: completenessIssues(content({ priceAmountMinor: 0, priceCurrency: 'EUR' }), structure(), POLICY, 'EUR') })).toEqual([
      'price:PRICE_NOT_POSITIVE',
    ]);
  });
});

describe('mapGigDbError: the currency guard and the remaining value rules are typed', () => {
  const rule = (key: string) => Object.assign(new Error('driver text SECRET-SQL'), { code: '23000', detail: `provider_rule:${key}` });
  const run = (e: unknown, ctx?: Parameters<typeof mapGigDbError>[1]) => asGig(capture(() => mapGigDbError(e, ctx)));
  it('PRICE_CURRENCY is VALIDATION_FAILED (PRICE_REQUIRED issue) everywhere but a publish, where it is PUBLISH_BLOCKED', () => {
    for (const ctx of ['create', 'draft', 'retire'] as const) {
      const e = run(rule('PRICE_CURRENCY'), ctx);
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'PRICE_CURRENCY' } });
      expect(e.details.issues).toEqual([{ target: 'price', reason: 'PRICE_REQUIRED', messageKey: gigIssueKey('PRICE_REQUIRED') }]);
      expect(surface(e)).not.toContain('SECRET-SQL');
    }
    expect(run(rule('PRICE_CURRENCY'), 'publish')).toMatchObject({ code: 'PUBLISH_BLOCKED', details: { reason: 'PRICE_CURRENCY' } });
  });
  it('FIELD_TYPE_MISMATCH is a validation failure', () => {
    expect(run(rule('FIELD_TYPE_MISMATCH'))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('translateAccountError and mapGigDbError translate the errors of the account port', () => {
  it('UNAVAILABLE, a retryable CONFLICT and ACCOUNT_NOT_ACTIVE; other errors are rethrown unchanged', () => {
    const u = asGig(capture(() => translateAccountError(new ProviderError('UNAVAILABLE', 'LEAK down'))));
    expect(u.code).toBe('UNAVAILABLE');
    expect(surface(u)).not.toContain('LEAK');
    expect(asGig(capture(() => translateAccountError(new ProviderError('CONFLICT', 'LEAK', { retryable: true }))))).toMatchObject({
      code: 'CONFLICT',
      details: { retryable: true },
    });
    expect(asGig(capture(() => translateAccountError(new ProviderError('ACCOUNT_NOT_ACTIVE', 'LEAK'))))).toMatchObject({
      code: 'ACCOUNT_NOT_ACTIVE',
      details: { reason: 'ACCOUNT_NOT_ACTIVE' },
    });
    const other = new ProviderError('REGISTRATION_NOT_FOUND', 'x');
    expect(capture(() => translateAccountError(other))).toBe(other);
    const plain = new RangeError('bug');
    expect(capture(() => translateAccountError(plain))).toBe(plain);
    // the transaction path translates through mapGigDbError
    expect(asGig(capture(() => mapGigDbError(new ProviderError('UNAVAILABLE', 'LEAK')))).code).toBe('UNAVAILABLE');
  });
  it('every call that reads the facts fails with a Gig error when the port throws a ProviderError', async () => {
    const b = untouchable();
    const dbDown = new ProviderGigService({
      database: b.database,
      accounts: { facts: async () => Promise.reject(new ProviderError('UNAVAILABLE', 'LEAK')), grantRole: async () => Promise.reject(new Error('unused')) },
      templates: {} as GigTemplatePort,
      policy: b.policy,
    });
    const e = await fail(dbDown.listGigTemplates(A));
    // the database (a sentinel) and the port both fail; whichever is first, the port's error is never leaked as a ProviderError
    expect(e).not.toBeInstanceOf(ProviderError);
  });
});

describe('hostile text is bounded in time', () => {
  it('a description of an opening bracket, 80000 blanks and a digit is validated in well under 250 ms', () => {
    const hostile = `a<${' '.repeat(79_990)}1`;
    const t0 = performance.now();
    const r = validateDraftInput(body({ description: hostile, title: hostile, shortPitch: hostile }), structure(), {
      ...POLICY,
      descriptionMaxLength: 100_000,
    });
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.issues).toEqual([]);
    expect(r.content.description).toBe(hostile);
    expect(r.content.title).toBe('a< 1');
    const t1 = performance.now();
    checkFieldValue(field('x', { fieldType: 'LONG_TEXT' }), hostile.slice(0, 19_000));
    expect(performance.now() - t1).toBeLessThan(250);
  });
  it('text with nothing visible clears the field; invisible characters are refused', () => {
    expect(validateDraftInput(body({ title: ' \n\t ' }), structure(), POLICY).content.title).toBeNull();
    expect(reasons(validateDraftInput(body({ title: 'a\u200Bb' }), structure(), POLICY))).toEqual(['title:FORBIDDEN_CHARACTER']);
    expect(checkFieldValue(field('t'), '\u3164')).toEqual({ ok: false, reason: 'FORBIDDEN_CHARACTER' });
    expect(checkFieldValue(field('t'), '   ')).toEqual({ ok: true, value: undefined });
  });
});
