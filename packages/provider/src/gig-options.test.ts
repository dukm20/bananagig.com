// Unit tests of the variants and add-ons of a Gig version (CAT-004): the pure validation of a whole-set replacement (permission, limits, names, keys, deltas, order), the
// re-validation of stored options at publish time and the semantic comparison that makes a repeated save a no-op. No database.
import { describe, expect, it } from 'vitest';
import { gigIssueKey, type GigOptionDto, type GigOptionInput } from '@bananagig/contracts';
import {
  DEFAULT_GIG_OPTIONS_POLICY,
  optionKindValid,
  optionsIssues,
  optionsPermitted,
  sameOptions,
  validateOptions,
  type GigTemplateStructure,
  type ValidatedOption,
} from './index';
import { DEFAULT_GIG_MEDIA_POLICY } from './gig-policy';
import { childSummary, menuChildSummary, partialStructure, publishIssues, type GigPolicies } from './gig-view';

const GIG_POLICY = { maxActive: 5, maxDrafts: 3, titleMaxLength: 20, shortPitchMaxLength: 40, descriptionMaxLength: 100 };
const POLICIES: GigPolicies = { gig: GIG_POLICY, options: DEFAULT_GIG_OPTIONS_POLICY, media: DEFAULT_GIG_MEDIA_POLICY };
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
  pricing: { fixed: true, fixedWithVariants: true },
  addOnsAllowed: true,
  fields: [],
  requirements: [],
  ...over,
});
const input = (over: Partial<GigOptionInput> = {}): GigOptionInput => ({
  name: 'Wax',
  description: null,
  priceDeltaMinor: 500,
  durationDeltaMinutes: 15,
  ...over,
});
let counter = 0;
const mint = () => `opt_${String(++counter).padStart(12, '0')}`;
const validate = (
  items: GigOptionInput[],
  over: { kind?: 'variants' | 'addOns'; existing?: string[]; structure?: GigTemplateStructure; policy?: Partial<typeof DEFAULT_GIG_OPTIONS_POLICY> } = {},
) =>
  validateOptions(
    over.kind ?? 'variants',
    items,
    new Set(over.existing ?? []),
    over.structure ?? structure(),
    { ...DEFAULT_GIG_OPTIONS_POLICY, ...over.policy },
    mint,
  );
const reasonsOf = (r: ReturnType<typeof validate>): string[] => (r.ok ? [] : r.issues.map((i) => `${i.target}:${i.reason}${i.itemKey ? `:${i.itemKey}` : ''}`));
const itemsOf = (r: ReturnType<typeof validate>): ValidatedOption[] => {
  if (!r.ok) throw new Error(`unexpected issues ${JSON.stringify(r.issues)}`);
  return r.items;
};

describe('optionsPermitted: the permission comes from the exact template version', () => {
  it('variants need FIXED_WITH_VARIANTS, add-ons need the explicit addOnsAllowed (independently)', () => {
    expect(optionsPermitted('variants', structure())).toBe(true);
    expect(optionsPermitted('addOns', structure())).toBe(true);
    expect(optionsPermitted('variants', structure({ pricing: { fixed: true, fixedWithVariants: false } }))).toBe(false);
    expect(optionsPermitted('addOns', structure({ pricing: { fixed: true, fixedWithVariants: false } }))).toBe(true);
    expect(optionsPermitted('addOns', structure({ addOnsAllowed: false }))).toBe(false);
    expect(optionsPermitted('variants', structure({ addOnsAllowed: false }))).toBe(true);
  });
});

describe('validateOptions', () => {
  it('assigns display order 1..n from the array order and mints a key for every new item', () => {
    const r = itemsOf(validate([input({ name: 'B' }), input({ name: 'A' }), input({ name: 'C' })]));
    expect(r.map((i) => i.displayOrder)).toEqual([1, 2, 3]);
    expect(r.map((i) => i.name)).toEqual(['B', 'A', 'C']);
    expect(new Set(r.map((i) => i.key)).size).toBe(3);
    for (const i of r) expect(i.key).toMatch(/^opt_[0-9]{12}$/);
  });

  it('keeps an existing key (and its position follows the array), and a minted key never collides with a kept one', () => {
    const r = itemsOf(validate([input({ name: 'B', key: 'opt_keep' }), input({ name: 'New' })], { existing: ['opt_keep', 'opt_other'] }));
    expect(r[0]).toMatchObject({ key: 'opt_keep', displayOrder: 1 });
    expect(r[1]!.key).not.toBe('opt_keep');
    // a collision with the stored keys is retried (the mint returns a taken key twice, then a free one)
    const seq = ['opt_keep', 'opt_other', 'opt_free'];
    const retried = validateOptions('variants', [input()], new Set(['opt_keep', 'opt_other']), structure(), DEFAULT_GIG_OPTIONS_POLICY, () => seq.shift()!);
    expect(itemsOf(retried)[0]!.key).toBe('opt_free');
  });

  it('an unknown client-sent key is OPTION_KEY_INVALID; the key of another kind is unknown too; a repeated key is OPTION_KEY_DUPLICATE', () => {
    expect(reasonsOf(validate([input({ key: 'opt_ghost' })], { existing: ['opt_real'] }))).toEqual(['variants:OPTION_KEY_INVALID:opt_ghost']);
    expect(reasonsOf(validate([input({ key: 'opt_real' })], { kind: 'addOns', existing: [] }))).toEqual(['addOns:OPTION_KEY_INVALID:opt_real']);
    expect(reasonsOf(validate([input({ name: 'A', key: 'opt_real' }), input({ name: 'B', key: 'opt_real' })], { existing: ['opt_real'] }))).toEqual([
      'variants:OPTION_KEY_DUPLICATE:opt_real',
    ]);
  });

  it('the name is single-line plain text, required, bounded in code points, NFC-normalised', () => {
    expect(itemsOf(validate([input({ name: '  Deep \n  clean  ' })]))[0]!.name).toBe('Deep clean');
    expect(itemsOf(validate([input({ name: 'Café' })]))[0]!.name).toBe('Café');
    expect(reasonsOf(validate([input({ name: '   ' })]))).toEqual(['variants:OPTION_NAME_REQUIRED']);
    expect(reasonsOf(validate([input({ name: '' })]))).toEqual(['variants:OPTION_NAME_REQUIRED']);
    expect(reasonsOf(validate([input({ name: 'x'.repeat(6) })], { policy: { nameMaxLength: 5 } }))).toEqual(['variants:OPTION_NAME_TOO_LONG']);
    expect(validate([input({ name: '😀😀😀😀😀' })], { policy: { nameMaxLength: 5 } }).ok).toBe(true);
    expect(reasonsOf(validate([input({ name: '<b>x</b>' })]))).toEqual(['variants:HTML_NOT_ALLOWED']);
    expect(reasonsOf(validate([input({ name: 'a\u0000b' })]))).toEqual(['variants:FORBIDDEN_CHARACTER']);
    expect(reasonsOf(validate([input({ name: 'a‮b' })]))).toEqual(['variants:FORBIDDEN_CHARACTER']);
  });

  it('duplicate names are refused after normalisation, case-insensitively, per list', () => {
    expect(reasonsOf(validate([input({ name: 'Wax' }), input({ name: ' wAx ' })]))).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(reasonsOf(validate([input({ name: 'Café' }), input({ name: 'CAFÉ' })]))).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(reasonsOf(validate([input({ name: 'Wax', key: 'opt_a' }), input({ name: 'wax', key: 'opt_b' })], { existing: ['opt_a', 'opt_b'] }))).toEqual([
      'variants:OPTION_NAME_DUPLICATE:opt_b',
    ]);
    expect(validate([input({ name: 'Wax' }), input({ name: 'Wax 2' })]).ok).toBe(true);
  });

  it('duplicate names collide under a stronger fold: sharp s vs SS, fullwidth letters, ligatures, case', () => {
    const dup = (a: string, b: string) => reasonsOf(validate([input({ name: a }), input({ name: b })]));
    expect(dup('Stra\u00dfe', 'STRASSE')).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(dup('Stra\u00dfe', 'strasse')).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(dup('wax', '\uff37\uff21\uff38')).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(dup('\ufb01nish', 'FINISH')).toEqual(['variants:OPTION_NAME_DUPLICATE']);
    expect(dup('Wax 1', 'Wax 2')).toEqual([]);
    // the stored name keeps what the provider typed (NFC), only the comparison folds
    expect(itemsOf(validate([input({ name: 'Stra\u00dfe' })]))[0]!.name).toBe('Stra\u00dfe');
  });

  it('the description is optional multi-line plain text bounded in code points; blank becomes null', () => {
    expect(itemsOf(validate([input({ description: ' line 1\r\nline 2 ' })]))[0]!.description).toBe('line 1\nline 2');
    expect(itemsOf(validate([input({ description: '   ' })]))[0]!.description).toBeNull();
    expect(itemsOf(validate([input({ description: null })]))[0]!.description).toBeNull();
    expect(reasonsOf(validate([input({ description: 'x'.repeat(6) })], { policy: { descriptionMaxLength: 5 } }))).toEqual([
      'variants:OPTION_DESCRIPTION_TOO_LONG',
    ]);
    expect(reasonsOf(validate([input({ description: '<script>' })]))).toEqual(['variants:HTML_NOT_ALLOWED']);
  });

  it('the deltas are non-negative safe integers within the structural bounds (no absolute price, no negative delta, no float)', () => {
    expect(itemsOf(validate([input({ priceDeltaMinor: 0, durationDeltaMinutes: 0 })]))[0]).toMatchObject({ priceDeltaMinor: 0, durationDeltaMinutes: 0 });
    expect(validate([input({ priceDeltaMinor: 1_000_000_000_000, durationDeltaMinutes: 100_000 })]).ok).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, 1_000_000_000_001, Number.MAX_SAFE_INTEGER + 1])
      expect(reasonsOf(validate([input({ priceDeltaMinor: bad })]))).toEqual(['variants:OPTION_PRICE_DELTA_INVALID']);
    for (const bad of [-1, 0.5, Number.NaN, 100_001])
      expect(reasonsOf(validate([input({ durationDeltaMinutes: bad })]))).toEqual(['variants:OPTION_DURATION_DELTA_INVALID']);
  });

  it('the count is bounded by the policy (zero allowed); a kind the template does not permit takes none but may be emptied', () => {
    expect(validate([], { policy: { variantMaxCount: 0 } }).ok).toBe(true);
    expect(reasonsOf(validate([input()], { policy: { variantMaxCount: 0 } }))).toEqual(['variants:OPTIONS_COUNT_EXCEEDED']);
    const two = [input({ name: 'A' }), input({ name: 'B' })];
    expect(reasonsOf(validate(two, { policy: { variantMaxCount: 1 } }))).toEqual(['variants:OPTIONS_COUNT_EXCEEDED']);
    expect(reasonsOf(validate(two, { kind: 'addOns', policy: { addOnMaxCount: 1 } }))).toEqual(['addOns:OPTIONS_COUNT_EXCEEDED']);
    expect(validate(two, { kind: 'addOns', policy: { variantMaxCount: 0 } }).ok).toBe(true);

    const noVariants = structure({ pricing: { fixed: true, fixedWithVariants: false } });
    expect(reasonsOf(validate([input()], { structure: noVariants }))).toEqual(['variants:OPTIONS_NOT_PERMITTED']);
    expect(validate([], { structure: noVariants }).ok).toBe(true);
    expect(validate([input()], { kind: 'addOns', structure: noVariants }).ok).toBe(true);
    const noAddOns = structure({ addOnsAllowed: false });
    expect(reasonsOf(validate([input()], { kind: 'addOns', structure: noAddOns }))).toEqual(['addOns:OPTIONS_NOT_PERMITTED']);
    expect(validate([], { kind: 'addOns', structure: noAddOns }).ok).toBe(true);
  });

  it('reports every problem at once, as identifiers only: no provider text in any issue', () => {
    const r = validate([input({ name: '<b>SECRET-NAME</b>', description: 'SECRET-DESC', priceDeltaMinor: -1 }), input({ name: 'ok', key: 'opt_ghost' })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.reason).sort()).toEqual(['HTML_NOT_ALLOWED', 'OPTION_KEY_INVALID', 'OPTION_PRICE_DELTA_INVALID']);
    for (const i of r.issues) expect(i.messageKey).toBe(gigIssueKey(i.reason));
    expect(JSON.stringify(r.issues)).not.toContain('SECRET');
  });

  it('the same input twice yields the same items apart from the minted keys (deterministic order and text)', () => {
    const a = itemsOf(validate([input({ name: 'B' }), input({ name: 'A', description: 'd' })]));
    const b = itemsOf(validate([input({ name: 'B' }), input({ name: 'A', description: 'd' })]));
    expect(a.map(({ key: _k, ...rest }) => rest)).toEqual(b.map(({ key: _k, ...rest }) => rest));
  });
});

describe('sameOptions: the semantic comparison behind a no-op save', () => {
  const stored = (over: Partial<GigOptionDto> = {}): GigOptionDto => ({
    key: 'opt_a',
    name: 'Wax',
    description: null,
    priceDeltaMinor: 500,
    durationDeltaMinutes: 15,
    displayOrder: 1,
    ...over,
  });
  const next = (over: Partial<ValidatedOption> = {}): ValidatedOption => ({
    key: 'opt_a',
    name: 'Wax',
    description: null,
    priceDeltaMinor: 500,
    durationDeltaMinutes: 15,
    displayOrder: 1,
    ...over,
  });
  it('equal lists are the same; any difference in key, text, delta, order or length is a change', () => {
    expect(sameOptions([], [])).toBe(true);
    expect(sameOptions([stored()], [next()])).toBe(true);
    for (const over of [{ key: 'opt_b' }, { name: 'Wax 2' }, { description: 'd' }, { priceDeltaMinor: 501 }, { durationDeltaMinutes: 16 }, { displayOrder: 2 }])
      expect(sameOptions([stored()], [next(over)])).toBe(false);
    expect(sameOptions([stored()], [])).toBe(false);
    expect(sameOptions([], [next()])).toBe(false);
    expect(
      sameOptions(
        [stored(), stored({ key: 'opt_b', name: 'B', displayOrder: 2 })],
        [next({ key: 'opt_b', name: 'B', displayOrder: 1 }), next({ displayOrder: 2 })],
      ),
    ).toBe(false);
  });
});

describe('optionsIssues: the stored options re-validated at publish time', () => {
  const dto = (over: Partial<GigOptionDto> = {}): GigOptionDto => ({
    key: 'opt_a',
    name: 'Wax',
    description: null,
    priceDeltaMinor: 500,
    durationDeltaMinutes: 15,
    displayOrder: 1,
    ...over,
  });
  const issues = (v: GigOptionDto[], a: GigOptionDto[], s = structure(), p: Partial<typeof DEFAULT_GIG_OPTIONS_POLICY> = {}) =>
    optionsIssues(v, a, s, { ...DEFAULT_GIG_OPTIONS_POLICY, ...p }, GIG_POLICY).map((i) => `${i.target}:${i.reason}${i.itemKey ? `:${i.itemKey}` : ''}`);
  it('nothing stored, nothing to say (also when the template permits neither)', () => {
    expect(issues([], [], structure({ pricing: { fixed: true, fixedWithVariants: false }, addOnsAllowed: false }))).toEqual([]);
  });
  it('stored options are fine within the permission and the limits', () => {
    expect(issues([dto()], [dto({ key: 'opt_b' })])).toEqual([]);
  });
  it('a permission the template does not give blocks, per kind', () => {
    expect(issues([dto()], [], structure({ pricing: { fixed: true, fixedWithVariants: false } }))).toEqual(['variants:OPTIONS_NOT_PERMITTED']);
    expect(issues([], [dto()], structure({ addOnsAllowed: false }))).toEqual(['addOns:OPTIONS_NOT_PERMITTED']);
  });
  it('limits that shrank since the save block (count, name and description lengths)', () => {
    expect(issues([dto(), dto({ key: 'opt_b', displayOrder: 2 })], [], structure(), { variantMaxCount: 1 })).toEqual(['variants:OPTIONS_COUNT_EXCEEDED']);
    expect(issues([], [dto({ name: 'x'.repeat(6) })], structure(), { nameMaxLength: 5 })).toEqual(['addOns:OPTION_NAME_TOO_LONG:opt_a']);
    expect(issues([dto({ description: 'x'.repeat(6) })], [], structure(), { descriptionMaxLength: 5 })).toEqual(['variants:OPTION_DESCRIPTION_TOO_LONG:opt_a']);
  });
});

describe('the children facts of a version', () => {
  const dto = (key: string, order = 1): GigOptionDto => ({
    key,
    name: `n ${key}`,
    description: null,
    priceDeltaMinor: 1,
    durationDeltaMinutes: 0,
    displayOrder: order,
  });
  it('counts and validity per part; a template without MEDIA fields has its media requirement satisfied', () => {
    expect(childSummary(structure(), POLICIES, { variants: [dto('opt_a'), dto('opt_b', 2)], addOns: [dto('opt_c')], media: [] })).toEqual({
      variantCount: 2,
      addOnCount: 1,
      mediaCount: 0,
      variantsValid: true,
      addOnsValid: true,
      mediaRequirementSatisfied: true,
    });
  });
  it('variants stored while the template does not permit them are counted but not valid; add-ons are judged on their own', () => {
    const s = structure({ pricing: { fixed: true, fixedWithVariants: false } });
    expect(childSummary(s, POLICIES, { variants: [dto('opt_a')], addOns: [dto('opt_c')], media: [] })).toMatchObject({
      variantCount: 1,
      variantsValid: false,
      addOnsValid: true,
    });
  });
  it('mediaCount counts the READY photos only: an unfinished upload is in the list but not in the count (mutation-testing additions)', () => {
    const photo = (id: string, status: 'READY' | 'UPLOAD_PENDING') => ({
      mediaId: id,
      gigVersionId: 'v1',
      assetId: `a-${id}`,
      gigTemplateFieldId: 'f1',
      fieldKey: 'photos',
      displayOrder: 1,
      altText: null,
      assetStatus: status,
      scanStatus: status === 'READY' ? ('CLEAN' as const) : ('PENDING' as const),
      mimeType: 'image/png',
      sizeBytes: 10,
      width: status === 'READY' ? 800 : null,
      height: status === 'READY' ? 600 : null,
    });
    const s = partialStructure({
      fixedWithVariants: true,
      addOnsAllowed: true,
      mediaFields: [{ gigTemplateFieldId: 'f1', fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 3 }],
    });
    const media = [photo('m1', 'READY'), photo('m2', 'UPLOAD_PENDING'), photo('m3', 'READY')];
    expect(childSummary(s, POLICIES, { variants: [], addOns: [], media })).toMatchObject({ mediaCount: 2, mediaRequirementSatisfied: true });
    expect(menuChildSummary(s, POLICIES, undefined, media)).toMatchObject({ mediaCount: 2, mediaRequirementSatisfied: true });
    expect(childSummary(s, POLICIES, { variants: [], addOns: [], media: [photo('m2', 'UPLOAD_PENDING')] })).toMatchObject({
      mediaCount: 0,
      mediaRequirementSatisfied: false,
    });
  });
  it('publishIssues adds the options issues to the content issues', () => {
    const content = { title: 'Great wash', shortPitch: 'Shiny', description: 'We wash', priceAmountMinor: 5000, durationMinutes: 90, values: new Map() };
    const s = structure({ addOnsAllowed: false });
    expect(publishIssues(content, s, POLICIES, null, { variants: [], addOns: [], media: [] })).toEqual([]);
    expect(publishIssues(content, s, POLICIES, null, { variants: [], addOns: [dto('opt_a')], media: [] }).map((i) => `${i.target}:${i.reason}`)).toEqual([
      'addOns:OPTIONS_NOT_PERMITTED',
    ]);
  });
});

describe('partialStructure: only what the options and media rules read', () => {
  it('carries the permissions and the MEDIA fields (as MEDIA, in order) and nothing a provider could mistake for the template', () => {
    const s = partialStructure({
      fixedWithVariants: true,
      addOnsAllowed: false,
      mediaFields: [
        { gigTemplateFieldId: 'f1', fieldKey: 'photos', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 3 },
        { gigTemplateFieldId: 'f2', fieldKey: 'extra', behavior: 'PROVIDER_CONFIGURABLE', minItems: null, maxItems: 0 },
      ],
    });
    expect(optionsPermitted('variants', s)).toBe(true);
    expect(optionsPermitted('addOns', s)).toBe(false);
    expect(s.fields.map((f) => [f.fieldKey, f.fieldType, f.behavior, f.minItems, f.maxItems])).toEqual([
      ['photos', 'MEDIA', 'PROVIDER_REQUIRED', 1, 3],
      ['extra', 'MEDIA', 'PROVIDER_CONFIGURABLE', null, 0],
    ]);
  });
});

describe('menu aggregates: the same validity as the full rows, without names or descriptions', () => {
  const stats = (count: number, maxNameLength = 3, maxDescriptionLength = 0) => ({ count, maxNameLength, maxDescriptionLength });
  it('empty is valid whatever the template says; otherwise permission, count and text lengths decide', () => {
    const noVariants = structure({ pricing: { fixed: true, fixedWithVariants: false } });
    expect(optionKindValid('variants', stats(0, 0), noVariants, DEFAULT_GIG_OPTIONS_POLICY)).toBe(true);
    expect(optionKindValid('variants', stats(1), noVariants, DEFAULT_GIG_OPTIONS_POLICY)).toBe(false);
    expect(optionKindValid('addOns', stats(1), noVariants, DEFAULT_GIG_OPTIONS_POLICY)).toBe(true);
    expect(optionKindValid('addOns', stats(21), structure(), DEFAULT_GIG_OPTIONS_POLICY)).toBe(false);
    expect(optionKindValid('addOns', stats(20), structure(), DEFAULT_GIG_OPTIONS_POLICY)).toBe(true);
    expect(optionKindValid('variants', stats(1, 81), structure(), DEFAULT_GIG_OPTIONS_POLICY)).toBe(false);
    expect(optionKindValid('variants', stats(1, 80, 501), structure(), DEFAULT_GIG_OPTIONS_POLICY)).toBe(false);
    expect(optionKindValid('variants', stats(1, 80, 500), structure(), DEFAULT_GIG_OPTIONS_POLICY)).toBe(true);
  });
  it('menuChildSummary agrees with childSummary on the same data', () => {
    const dto = (key: string, name: string, order = 1): GigOptionDto => ({
      key,
      name,
      description: null,
      priceDeltaMinor: 1,
      durationDeltaMinutes: 0,
      displayOrder: order,
    });
    for (const [s, v, a] of [
      [structure(), [dto('opt_a', 'x')], [dto('opt_b', 'y'), dto('opt_c', 'z', 2)]],
      [structure({ pricing: { fixed: true, fixedWithVariants: false } }), [dto('opt_a', 'x')], []],
      [structure(), [dto('opt_a', 'x'.repeat(81))], []],
    ] as const) {
      const full = childSummary(s, POLICIES, { variants: v, addOns: a, media: [] });
      const agg = menuChildSummary(
        s,
        POLICIES,
        {
          variants: { count: v.length, maxNameLength: Math.max(0, ...v.map((x) => x.name.length)), maxDescriptionLength: 0 },
          addOns: { count: a.length, maxNameLength: Math.max(0, ...a.map((x) => x.name.length)), maxDescriptionLength: 0 },
        },
        [],
      );
      expect(agg).toEqual(full);
    }
  });
});

// ---- mutation-testing additions (CAT-004): exact boundaries of the text limits, on the save path and on the publish re-validation
describe('exact boundaries of the option text limits', () => {
  const dtoOf = (over: Partial<GigOptionDto> = {}): GigOptionDto => ({
    key: 'opt_a',
    name: 'Wax',
    description: null,
    priceDeltaMinor: 500,
    durationDeltaMinutes: 15,
    displayOrder: 1,
    ...over,
  });
  const publishIssuesOf = (v: GigOptionDto[], a: GigOptionDto[], p: Partial<typeof DEFAULT_GIG_OPTIONS_POLICY>) =>
    optionsIssues(v, a, structure(), { ...DEFAULT_GIG_OPTIONS_POLICY, ...p }, GIG_POLICY).map(
      (i) => `${i.target}:${i.reason}${i.itemKey ? `:${i.itemKey}` : ''}`,
    );

  it('save: a description of exactly the maximum (in code points) is accepted, one more is refused', () => {
    expect(itemsOf(validate([input({ description: 'x'.repeat(5) })], { policy: { descriptionMaxLength: 5 } }))[0]!.description).toBe('x'.repeat(5));
    expect(itemsOf(validate([input({ description: '😀'.repeat(5) })], { policy: { descriptionMaxLength: 5 } }))[0]!.description).toBe('😀'.repeat(5));
    expect(reasonsOf(validate([input({ description: 'x'.repeat(6) })], { policy: { descriptionMaxLength: 5 } }))).toEqual([
      'variants:OPTION_DESCRIPTION_TOO_LONG',
    ]);
  });
  it('save: a name of exactly the maximum and a list of exactly the maximum count are accepted', () => {
    expect(itemsOf(validate([input({ name: 'x'.repeat(5) })], { policy: { nameMaxLength: 5 } }))).toHaveLength(1);
    expect(itemsOf(validate([input({ name: 'A' }), input({ name: 'B' })], { policy: { variantMaxCount: 2 } }))).toHaveLength(2);
    expect(reasonsOf(validate([input({ name: 'A' }), input({ name: 'B' }), input({ name: 'C' })], { policy: { variantMaxCount: 2 } }))).toEqual([
      'variants:OPTIONS_COUNT_EXCEEDED',
    ]);
  });
  it('publish: stored options AT the limits are fine (count, name length, description length); one over each blocks', () => {
    expect(
      publishIssuesOf([dtoOf({ name: 'x'.repeat(5), description: 'y'.repeat(7) }), dtoOf({ key: 'opt_b', displayOrder: 2 })], [], {
        variantMaxCount: 2,
        nameMaxLength: 5,
        descriptionMaxLength: 7,
      }),
    ).toEqual([]);
    expect(publishIssuesOf([dtoOf({ description: 'y'.repeat(8) })], [], { descriptionMaxLength: 7 })).toEqual(['variants:OPTION_DESCRIPTION_TOO_LONG:opt_a']);
    expect(publishIssuesOf([], [dtoOf({ name: 'x'.repeat(6) })], { nameMaxLength: 5 })).toEqual(['addOns:OPTION_NAME_TOO_LONG:opt_a']);
  });
});
