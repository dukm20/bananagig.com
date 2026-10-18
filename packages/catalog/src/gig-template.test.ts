// Unit tests of the Gig Templates (CAT-002) that need no database: the pure canonical form and its diff, the content-key derivation, the translation of the new database
// constraints, foreign keys and guards, the strict input validation that must happen BEFORE any statement is sent, the pure view mappers, the cache snapshot schema and the
// public reads over a cache. Behaviour that needs real constraints, triggers, locks and the outbox is covered in gig-template.itest.ts.
//
// Written by an author who did not write the service. The service is built over a `database` whose every entry point throws a sentinel: a test that expects "no database
// access" proves it by the absence of the sentinel, a test that expects to get PAST a gate proves it by the presence of the sentinel.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache, type ConfigCache } from '@bananagig/configuration';
import { AREA_MODES, PRICING_MODELS, ReplaceGigTemplateDraftRequest } from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { migrationsDir } from '@bananagig/testing';
import {
  CatalogError,
  GigTemplateService,
  GigTemplateSnapshotSchema,
  areaModesOf,
  canonFromRequest,
  contentKeysOf,
  diffCanon,
  fieldView,
  mapDbError,
  pricingModelsOf,
  versionSummaryView,
  type Canon,
  type CanonField,
  type MarketGate,
  type PublicMarket,
} from './index';

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
const asCatalog = (e: unknown): CatalogError => {
  expect(e).toBeInstanceOf(CatalogError);
  return e as CatalogError;
};
/** Everything a caller can observe of an error, as one string. */
const surface = (e: CatalogError): string => JSON.stringify({ name: e.name, code: e.code, message: e.message, details: e.details });
const keys = (o: object) => Object.keys(o).sort();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const GOOD = 'a valid reason';

// ====================================================================== definitions
const rawField = (over: Record<string, unknown> = {}) => ({ fieldKey: 'scope_notes', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED', ...over });
const replaceBody = (over: Record<string, unknown> = {}) => ({
  expectedRevision: 1,
  pricingModels: ['FIXED'],
  areaModes: ['RADIUS'],
  fields: [] as unknown[],
  requirements: [] as unknown[],
  reason: GOOD,
  ...over,
});
const parseReplace = (over: Record<string, unknown> = {}) => ReplaceGigTemplateDraftRequest.parse(replaceBody(over));

/** One field of each of the 11 types, valid on its own. */
const ALL_TYPE_FIELDS = (): Record<string, unknown>[] => [
  { fieldKey: 'f_text', fieldType: 'TEXT', behavior: 'PROVIDER_REQUIRED', section: 'SCOPE', minLength: 5, maxLength: 200, withHelp: true },
  { fieldKey: 'f_long', fieldType: 'LONG_TEXT', behavior: 'PLATFORM_FIXED', section: 'INCLUSIONS', withDefaultText: true, customerVisible: false },
  { fieldKey: 'f_int', fieldType: 'INTEGER', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 1, maxNumber: 10, defaultNumber: 2 },
  { fieldKey: 'f_dec', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0.5, maxNumber: 9.9999, defaultNumber: 1.25 },
  { fieldKey: 'f_bool', fieldType: 'BOOLEAN', behavior: 'PLATFORM_FIXED', defaultBoolean: false },
  {
    fieldKey: 'f_enum',
    fieldType: 'ENUM',
    behavior: 'PLATFORM_FIXED',
    section: 'EXCLUSIONS',
    options: [{ optionCode: 'opt_a', isDefault: true }, { optionCode: 'opt_b' }],
  },
  { fieldKey: 'f_dur', fieldType: 'DURATION', behavior: 'PROVIDER_REQUIRED', section: 'PREPARATION', minNumber: 30, maxNumber: 480, defaultNumber: 60 },
  { fieldKey: 'f_money', fieldType: 'MONEY', behavior: 'PROVIDER_REQUIRED' },
  { fieldKey: 'f_media', fieldType: 'MEDIA', behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 8 },
  { fieldKey: 'f_equip', fieldType: 'EQUIPMENT_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 3 },
  { fieldKey: 'f_skill', fieldType: 'SKILL_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', minItems: 1, maxItems: 5 },
];

// ====================================================================== canonFromRequest
describe('canonFromRequest', () => {
  it('an empty definition has the documented defaults: no duration rule, nothing else', () => {
    expect(canonFromRequest(parseReplace())).toEqual({
      duration: { min: null, max: null, suggested: null },
      pricing: ['FIXED'],
      area: ['RADIUS'],
      fields: [],
      requirements: [],
    });
  });

  it('the pricing models and the area modes come out in the canonical order, whatever order the request used', () => {
    const c = canonFromRequest(
      parseReplace({
        pricingModels: ['ADD_ONS', 'DROP_ELIGIBLE', 'BUNDLE_ELIGIBLE', 'FIXED_WITH_VARIANTS', 'FIXED'],
        areaModes: ['POLYGON', 'POSTAL_CODES', 'RADIUS'],
      }),
    );
    expect(c.pricing).toEqual([...PRICING_MODELS]);
    expect(c.area).toEqual([...AREA_MODES]);
    const d = canonFromRequest(parseReplace({ pricingModels: ['BUNDLE_ELIGIBLE', 'FIXED_WITH_VARIANTS'], areaModes: ['POLYGON', 'RADIUS'] }));
    expect(d.pricing).toEqual(['FIXED_WITH_VARIANTS', 'BUNDLE_ELIGIBLE']);
    expect(d.area).toEqual(['RADIUS', 'POLYGON']);
    expect(diffCanon(c, canonFromRequest(parseReplace({ pricingModels: [...PRICING_MODELS].reverse(), areaModes: [...AREA_MODES].reverse() })))).toEqual({});
  });

  it('the duration is carried as min / max / suggested, each independently null when absent', () => {
    expect(canonFromRequest(parseReplace({ duration: { minMinutes: 30, maxMinutes: 120, suggestedMinutes: 60 } })).duration).toEqual({
      min: 30,
      max: 120,
      suggested: 60,
    });
    expect(canonFromRequest(parseReplace({ duration: { maxMinutes: 120 } })).duration).toEqual({ min: null, max: 120, suggested: null });
    expect(canonFromRequest(parseReplace({ duration: {} })).duration).toEqual({ min: null, max: null, suggested: null });
    expect(canonFromRequest(parseReplace({ duration: { suggestedMinutes: 45 } })).duration).toEqual({ min: null, max: null, suggested: 45 });
  });

  it('every field property is carried; the defaults of the contract apply; an absent bound is null, a zero or false value is KEPT (0 photos allowed, a false default)', () => {
    const c = canonFromRequest(
      parseReplace({
        fields: [
          rawField({ fieldKey: 'plain', fieldType: 'MONEY', behavior: 'PROVIDER_CONFIGURABLE' }),
          rawField({ fieldKey: 'no_photos', fieldType: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 0 }),
          rawField({
            fieldKey: 'off_by_default',
            fieldType: 'BOOLEAN',
            behavior: 'PLATFORM_FIXED',
            defaultBoolean: false,
            section: 'EXCLUSIONS',
            customerVisible: false,
          }),
          rawField({ fieldKey: 'zero_default', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0, maxNumber: 5, defaultNumber: 0 }),
        ],
      }),
    );
    const [plain, noPhotos, off, zero] = c.fields as [CanonField, CanonField, CanonField, CanonField];
    expect(plain).toEqual({
      fieldKey: 'plain',
      fieldType: 'MONEY',
      section: 'DETAILS',
      behavior: 'PROVIDER_CONFIGURABLE',
      customerVisible: true,
      withHelp: false,
      withDefaultText: false,
      minLength: null,
      maxLength: null,
      minNumber: null,
      maxNumber: null,
      defaultNumber: null,
      defaultBoolean: null,
      minItems: null,
      maxItems: null,
      options: [],
    });
    expect([noPhotos.minItems, noPhotos.maxItems]).toEqual([0, 0]);
    expect([off.defaultBoolean, off.customerVisible, off.section]).toEqual([false, false, 'EXCLUSIONS']);
    expect([zero.minNumber, zero.maxNumber, zero.defaultNumber]).toEqual([0, 5, 0]);
  });

  it('numbers are normalised to the 4 decimals the database keeps, so float noise is not a difference (0.30000000000000004 is 0.3); whole numbers, zero and absent values are untouched', () => {
    const c = canonFromRequest(
      parseReplace({
        fields: [
          rawField({
            fieldKey: 'noisy',
            fieldType: 'DECIMAL',
            behavior: 'PROVIDER_CONFIGURABLE',
            minNumber: 0.1 + 0.2,
            maxNumber: 9.9999 + 1e-13,
            defaultNumber: 1 + 5e-14,
          }),
          rawField({ fieldKey: 'plain', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0, defaultNumber: 12 }),
          rawField({ fieldKey: 'negative', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: -0.30000000000000004 }),
        ],
      }),
    );
    expect([c.fields[0]!.minNumber, c.fields[0]!.maxNumber, c.fields[0]!.defaultNumber]).toEqual([0.3, 9.9999, 1]);
    expect([c.fields[1]!.minNumber, c.fields[1]!.maxNumber, c.fields[1]!.defaultNumber]).toEqual([0, null, 12]);
    expect(c.fields[2]!.minNumber).toBe(-0.3);
    const exact = canonFromRequest(
      parseReplace({
        fields: [rawField({ fieldKey: 'noisy', fieldType: 'DECIMAL', behavior: 'PROVIDER_CONFIGURABLE', minNumber: 0.3, maxNumber: 9.9999, defaultNumber: 1 })],
      }),
    );
    expect(diffCanon(exact, { ...c, fields: [c.fields[0]!] })).toEqual({});
  });

  it('the field order and the option order of the request are the display order and are kept; options carry only their code and default flag', () => {
    const c = canonFromRequest(
      parseReplace({
        fields: [
          rawField({ fieldKey: 'zz_last_alpha', fieldType: 'BOOLEAN', behavior: 'PROVIDER_CONFIGURABLE' }),
          rawField({
            fieldKey: 'aa_first_alpha',
            fieldType: 'ENUM',
            behavior: 'PROVIDER_CONFIGURABLE',
            options: [{ optionCode: 'opt_c' }, { optionCode: 'opt_a', isDefault: true }, { optionCode: 'opt_b' }],
          }),
        ],
      }),
    );
    expect(c.fields.map((f) => f.fieldKey)).toEqual(['zz_last_alpha', 'aa_first_alpha']);
    expect(c.fields[1]!.options).toEqual([
      { optionCode: 'opt_c', isDefault: false },
      { optionCode: 'opt_a', isDefault: true },
      { optionCode: 'opt_b', isDefault: false },
    ]);
  });

  it('requirements are ordered by identity (type, then reference with none first) and an absent reference is null: the request order does not matter', () => {
    const a = canonFromRequest(
      parseReplace({
        requirements: [
          { requirementType: 'SKILL', referenceCode: 'wax_application' },
          { requirementType: 'LICENSE' },
          { requirementType: 'SKILL' },
          { requirementType: 'BACKGROUND_CHECK' },
          { requirementType: 'INSURANCE', referenceCode: 'liability' },
          { requirementType: 'EQUIPMENT' },
        ],
      }),
    );
    expect(a.requirements).toEqual([
      { requirementType: 'BACKGROUND_CHECK', referenceCode: null },
      { requirementType: 'EQUIPMENT', referenceCode: null },
      { requirementType: 'INSURANCE', referenceCode: 'liability' },
      { requirementType: 'LICENSE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax_application' },
    ]);
    const reversed = canonFromRequest(
      parseReplace({
        requirements: [...a.requirements]
          .reverse()
          .map((r) => ({ requirementType: r.requirementType, ...(r.referenceCode ? { referenceCode: r.referenceCode } : {}) })),
      }),
    );
    expect(reversed).toEqual(a);
  });

  it('is pure: the (frozen) parsed request is not changed and two calls return equal but separate objects', () => {
    const body = parseReplace({ fields: ALL_TYPE_FIELDS(), requirements: [{ requirementType: 'SKILL', referenceCode: 'x1' }, { requirementType: 'LICENSE' }] });
    const deepFreeze = (v: unknown): void => {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v);
        Object.values(v).forEach(deepFreeze);
      }
    };
    deepFreeze(body);
    const before = JSON.stringify(body);
    const a = canonFromRequest(body);
    const b = canonFromRequest(body);
    expect(JSON.stringify(body)).toBe(before);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.fields[0]).not.toBe(b.fields[0]);
    expect(a.fields).toHaveLength(11);
  });
});

// ====================================================================== diffCanon
const baseCanon = (): Canon =>
  canonFromRequest(
    parseReplace({
      duration: { minMinutes: 30, maxMinutes: 120, suggestedMinutes: 60 },
      pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
      areaModes: ['RADIUS'],
      fields: ALL_TYPE_FIELDS().slice(0, 6),
      requirements: [{ requirementType: 'LICENSE' }, { requirementType: 'SKILL', referenceCode: 'wax' }],
    }),
  );

describe('diffCanon', () => {
  it('two equal definitions have an empty diff (so a repeated replace writes nothing)', () => {
    expect(diffCanon(baseCanon(), baseCanon())).toEqual({});
    expect(diffCanon({ ...baseCanon(), fields: [], requirements: [] }, { ...baseCanon(), fields: [], requirements: [] })).toEqual({});
  });

  it('a change of the duration, the pricing models or the area modes is reported with the old and the new value', () => {
    const a = baseCanon();
    const b = clone(a);
    b.duration = { min: null, max: 240, suggested: 60 };
    b.pricing = ['FIXED', 'FIXED_WITH_VARIANTS', 'DROP_ELIGIBLE'];
    b.area = ['RADIUS', 'POLYGON'];
    expect(diffCanon(a, b)).toEqual({
      duration: [a.duration, b.duration],
      pricingModels: [a.pricing, b.pricing],
      areaModes: [a.area, b.area],
    });
    for (const [mutate, key] of [
      [(c: Canon) => (c.duration.min = 31), 'duration'],
      [(c: Canon) => (c.duration.max = 121), 'duration'],
      [(c: Canon) => (c.duration.suggested = 59), 'duration'],
      [(c: Canon) => c.pricing.pop(), 'pricingModels'],
      [(c: Canon) => c.area.push('POSTAL_CODES'), 'areaModes'],
    ] as const) {
      const m = clone(a);
      mutate(m);
      expect(keys(diffCanon(a, m)), key).toEqual([key]);
    }
  });

  it('added, removed and changed fields are listed by field key only (added and changed in the new order, removed in the old order)', () => {
    const a = baseCanon();
    const b = clone(a);
    b.fields = b.fields.filter((f) => f.fieldKey !== 'f_int'); // removed
    b.fields[b.fields.length - 1]!.minLength = 3; // f_enum is last: changed (a text bound on an enum is irrelevant to the diff)
    b.fields.push(clone(a.fields[0]!)); // a copy of an existing key is NOT an addition...
    b.fields.pop();
    b.fields.push({ ...clone(a.fields[0]!), fieldKey: 'brand_new' }); // ...a new key is
    const d = diffCanon(a, b) as { fields: { added: string[]; removed: string[]; changed: string[] } };
    expect(d.fields.added).toEqual(['brand_new']);
    expect(d.fields.removed).toEqual(['f_int']);
    // f_dec, f_bool and f_enum moved up one position when f_int went away, and f_enum also changed a bound
    expect(d.fields.changed).toEqual(['f_dec', 'f_bool', 'f_enum']);
    expect(keys(d)).toEqual(['fields']);
  });

  it('EVERY property of a field is part of the comparison: changing any single one marks the field as changed', () => {
    const a = baseCanon();
    const probe = a.fields[0]!;
    const flips: Partial<Record<keyof CanonField, unknown>> = {
      fieldKey: undefined, // the key is the identity, covered by added / removed
      fieldType: 'LONG_TEXT',
      section: 'EXCLUSIONS',
      behavior: 'PROVIDER_CONFIGURABLE',
      customerVisible: !probe.customerVisible,
      withHelp: !probe.withHelp,
      withDefaultText: !probe.withDefaultText,
      minLength: 99,
      maxLength: 98,
      minNumber: 1,
      maxNumber: 2,
      defaultNumber: 3,
      defaultBoolean: true,
      minItems: 4,
      maxItems: 5,
      options: [{ optionCode: 'x_y', isDefault: false }],
    };
    for (const prop of Object.keys(probe) as (keyof CanonField)[]) {
      if (prop === 'fieldKey') continue;
      expect(prop in flips, `the probe covers ${prop}`).toBe(true);
      const b = clone(a);
      (b.fields[0] as unknown as Record<string, unknown>)[prop] = flips[prop];
      expect(diffCanon(a, b), prop).toEqual({ fields: { added: [], removed: [], changed: [probe.fieldKey] } });
    }
  });

  it('options: a changed default flag, a reordered option, an added and a removed option all change the field', () => {
    const a = baseCanon();
    const enumIndex = a.fields.findIndex((f) => f.fieldKey === 'f_enum');
    const variants: ((o: CanonField['options']) => CanonField['options'])[] = [
      (o) => o.map((x) => ({ ...x, isDefault: !x.isDefault })),
      (o) => [...o].reverse(),
      (o) => [...o, { optionCode: 'opt_c', isDefault: false }],
      (o) => o.slice(1),
    ];
    for (const [i, v] of variants.entries()) {
      const b = clone(a);
      b.fields[enumIndex]!.options = v(b.fields[enumIndex]!.options);
      expect(diffCanon(a, b), `variant ${i}`).toEqual({ fields: { added: [], removed: [], changed: ['f_enum'] } });
    }
  });

  it('the position is part of the identity of a field: swapping two fields changes both, inserting one at the front changes all that follow (documented)', () => {
    const a = baseCanon();
    const swapped = clone(a);
    [swapped.fields[0], swapped.fields[1]] = [swapped.fields[1]!, swapped.fields[0]!];
    expect(diffCanon(a, swapped)).toEqual({ fields: { added: [], removed: [], changed: [a.fields[1]!.fieldKey, a.fields[0]!.fieldKey] } });
    const front = clone(a);
    front.fields.unshift({ ...clone(a.fields[0]!), fieldKey: 'at_front' });
    const d = diffCanon(a, front) as { fields: { added: string[]; removed: string[]; changed: string[] } };
    expect(d.fields.added).toEqual(['at_front']);
    expect(d.fields.changed).toEqual(a.fields.map((f) => f.fieldKey));
  });

  it('requirements are compared by identity: added and removed are `TYPE:reference` ids (an absent reference is the empty string), a repeat in another order is no change', () => {
    const a = baseCanon();
    const b = clone(a);
    b.requirements = [
      { requirementType: 'INSURANCE', referenceCode: null },
      { requirementType: 'SKILL', referenceCode: 'wax' },
    ];
    expect(diffCanon(a, b)).toEqual({ requirements: { added: ['INSURANCE:'], removed: ['LICENSE:'] } });
    const removedOnly = clone(a);
    removedOnly.requirements = [];
    expect(diffCanon(a, removedOnly)).toEqual({ requirements: { added: [], removed: ['LICENSE:', 'SKILL:wax'] } });
    expect(diffCanon(removedOnly, a)).toEqual({ requirements: { added: ['LICENSE:', 'SKILL:wax'], removed: [] } });
    const reordered = clone(a);
    reordered.requirements.reverse();
    expect(diffCanon(a, reordered)).toEqual({});
  });

  it('a diff holds identifiers and numbers only: no object of the definition, no label or key text, whatever changed', () => {
    const a = baseCanon();
    const b = clone(a);
    b.fields = b.fields.slice(1);
    b.requirements = [];
    b.duration.min = 5;
    const text = JSON.stringify(diffCanon(a, b));
    expect(text).not.toMatch(/catalog\.gig_template|label|"fieldType"|"behavior"|"options"|optionCode|isDefault/);
  });
});

// ====================================================================== contentKeysOf
describe('contentKeysOf', () => {
  it('derives the label, help, default text and option label keys from the template code and the field key, in field order', () => {
    const c = canonFromRequest(
      parseReplace({
        fields: [
          rawField({ fieldKey: 'scope_notes', withHelp: true }),
          rawField({ fieldKey: 'intro', fieldType: 'LONG_TEXT', behavior: 'PLATFORM_FIXED', withDefaultText: true, withHelp: true }),
          rawField({
            fieldKey: 'finish',
            fieldType: 'ENUM',
            behavior: 'PROVIDER_CONFIGURABLE',
            options: [{ optionCode: 'wax', isDefault: true }, { optionCode: 'ceramic' }],
          }),
          rawField({ fieldKey: 'extra_fee', fieldType: 'MONEY', behavior: 'PROVIDER_CONFIGURABLE' }),
        ],
      }),
    );
    expect(contentKeysOf('full_detail', c)).toEqual([
      'catalog.gig_template.full_detail.field.scope_notes.label',
      'catalog.gig_template.full_detail.field.scope_notes.help',
      'catalog.gig_template.full_detail.field.intro.label',
      'catalog.gig_template.full_detail.field.intro.help',
      'catalog.gig_template.full_detail.field.intro.default',
      'catalog.gig_template.full_detail.field.finish.label',
      'catalog.gig_template.full_detail.field.finish.option.wax.label',
      'catalog.gig_template.full_detail.field.finish.option.ceramic.label',
      'catalog.gig_template.full_detail.field.extra_fee.label',
    ]);
  });

  it('no fields means no keys; the keys of two templates never overlap; every key is a legal content-registry key of at most 160 characters even for the longest legal names', () => {
    expect(contentKeysOf('full_detail', baseCanon_empty())).toEqual([]);
    const c = baseCanon();
    const a = new Set(contentKeysOf('aa_one', c));
    expect(contentKeysOf('bb_two', c).filter((k) => a.has(k))).toEqual([]);
    const code = 'a'.repeat(48);
    const field = 'f'.repeat(32);
    const opt = 'o'.repeat(32);
    const longest = contentKeysOf(
      code,
      canonFromRequest(
        parseReplace({
          fields: [rawField({ fieldKey: field, fieldType: 'ENUM', behavior: 'PROVIDER_CONFIGURABLE', withHelp: true, options: [{ optionCode: opt }] })],
        }),
      ),
    );
    for (const k of longest) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$/);
      expect(k.length).toBeLessThanOrEqual(160);
    }
  });
});
function baseCanon_empty(): Canon {
  return canonFromRequest(parseReplace());
}

// ====================================================================== error translation: the new mappings
const NEW_GUARD_RULES = [
  'SERVICE_TYPE_RETIRED',
  'SERVICE_TYPE_NOT_ACTIVE',
  'GIG_TEMPLATE_RETIRED',
  'GIG_TEMPLATE_NOT_ACTIVE',
  'GIG_TEMPLATE_HAS_OPEN_DRAFT',
  'VERSION_NUMBER_SEQUENCE',
  'VERSION_FROZEN',
  'VERSION_NOT_DRAFT',
  'SUPERSEDED_IS_AUTOMATIC',
  'GIG_TEMPLATE_HAS_NO_FIELDS',
  'ENUM_FIELD_WITHOUT_OPTIONS',
  'FIXED_ENUM_WITHOUT_DEFAULT',
  'CONTENT_NOT_PUBLISHED',
  'CONTENT_KEY_MISMATCH',
  'OPTIONS_ONLY_FOR_ENUM',
];

describe('mapDbError: the Gig Template guards (SQLSTATE 23000)', () => {
  it.each(NEW_GUARD_RULES)('%s -> INVALID_STATE carrying the rule as the machine-readable reason and a fixed message', (rule) => {
    const e = asCatalog(capture(() => mapDbError({ code: '23000', detail: `catalog_rule:${rule}`, message: 'driver text LEAK', table: 'gig_templates' })));
    expect(e.code).toBe('INVALID_STATE');
    expect(e.details).toEqual({ reason: rule });
    expect(e.message.length).toBeGreaterThan(10);
    for (const needle of ['LEAK', 'gig_templates', 'catalog_rule', 'catalog.']) expect(surface(e)).not.toContain(needle);
  });

  it('the messages of the rules are distinct (a caller can tell the refusals apart even without the reason)', () => {
    const messages = NEW_GUARD_RULES.map((rule) => asCatalog(capture(() => mapDbError({ code: '23000', detail: `catalog_rule:${rule}` }))).message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('EVERY rule key the migrations 0015 and 0016 can raise is translated to a reason (a key missing from the table would be a silent generic answer)', () => {
    const text = ['0015_catalog.sql', '0016_gig_templates.sql'].map((f) => readFileSync(path.join(migrationsDir(), f), 'utf8')).join('\n');
    const rules = new Set([...text.matchAll(/catalog_rule:([A-Z][A-Z_]*)/g)].map((m) => m[1]!));
    expect(rules.size).toBeGreaterThan(25);
    for (const rule of NEW_GUARD_RULES) expect(rules.has(rule), `${rule} is raised by the migration`).toBe(true);
    const immutable = new Set(['NOT_DELETABLE', 'IMMUTABLE_IDENTITY', 'ROW_IMMUTABLE']);
    for (const rule of rules) {
      const e = asCatalog(capture(() => mapDbError({ code: '23000', detail: `catalog_rule:${rule}` })));
      expect(e.code, rule).toBe('INVALID_STATE');
      expect(e.details.reason, `${rule} has no specific reason`).toBe(immutable.has(rule) ? 'IMMUTABLE' : rule);
    }
  });
});

describe('mapDbError: the Gig Template constraints, keys and races', () => {
  it('the unique draft index is DRAFT_EXISTS (a plain conflict, not retryable); the number and the active-version indexes are a lost race: retryable CONCURRENT_UPDATE', () => {
    const draft = asCatalog(
      capture(() => mapDbError({ code: '23505', constraint: 'uq_gig_template_versions__draft', detail: 'Key (gig_template_id)=(LEAK) already exists.' })),
    );
    expect(draft.code).toBe('CONFLICT');
    expect(draft.details).toEqual({ reason: 'DRAFT_EXISTS' });
    expect(surface(draft)).not.toContain('LEAK');
    for (const constraint of ['uq_gig_template_versions__number', 'uq_gig_template_versions__active']) {
      const e = asCatalog(capture(() => mapDbError({ code: '23505', constraint, detail: 'Key (gig_template_id, version_number)=(LEAK, 2) already exists.' })));
      expect(e.code).toBe('CONFLICT');
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
      expect(surface(e)).not.toContain('LEAK');
    }
  });

  it('the other unique violations keep their answers: a template code is CODE_TAKEN, the market order is DISPLAY_ORDER_TAKEN, the availability primary key is a retryable lost race', () => {
    for (const constraint of ['uq_gig_templates__code', 'uq_gig_template_fields__key', 'uq_gig_template_requirements__requirement', undefined])
      expect(asCatalog(capture(() => mapDbError({ code: '23505', constraint }))).details).toEqual({ reason: 'CODE_TAKEN' });
    expect(asCatalog(capture(() => mapDbError({ code: '23505', constraint: 'uq_market_gig_templates__market_order' }))).details).toEqual({
      reason: 'DISPLAY_ORDER_TAKEN',
    });
    const pk = asCatalog(
      capture(() => mapDbError({ code: '23505', constraint: 'pk_market_gig_templates', detail: 'Key (market_id, gig_template_id)=(LEAK, x) already exists.' })),
    );
    expect(pk.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(surface(pk)).not.toContain('LEAK');
  });

  it('a version-level constraint is only recognised by its exact name (a longer or shorter name is a taken code, never a silent retry)', () => {
    for (const constraint of [
      'uq_gig_template_versions__draft_x',
      'x_uq_gig_template_versions__draft',
      'uq_gig_template_versions__',
      'uq_gig_template_versions__numbers',
    ])
      expect(asCatalog(capture(() => mapDbError({ code: '23505', constraint }))).details.reason, constraint).toBe('CODE_TAKEN');
  });

  it('23503 on the name, description and instructions keys of a template have their own reasons', () => {
    expect(asCatalog(capture(() => mapDbError({ code: '23503', constraint: 'fk_gig_templates__name_content_key' }))).details).toEqual({
      reason: 'NAME_CONTENT_MISSING',
    });
    expect(asCatalog(capture(() => mapDbError({ code: '23503', constraint: 'fk_gig_templates__description_content_key' }))).details).toEqual({
      reason: 'DESCRIPTION_CONTENT_MISSING',
    });
    const instr = asCatalog(
      capture(() => mapDbError({ code: '23503', constraint: 'fk_gig_templates__instructions_content_key', detail: 'Key (x)=(LEAK) is not present.' })),
    );
    expect(instr.code).toBe('VALIDATION_FAILED');
    expect(instr.details).toEqual({ reason: 'INSTRUCTIONS_CONTENT_MISSING' });
    expect(surface(instr)).not.toMatch(/LEAK|catalog\.|content\./);
  });

  it('23503 on a content key of a field or an option (label, help, default, option label) is CONTENT_ENTRY_MISSING', () => {
    for (const constraint of [
      'fk_gig_template_fields__label_content_key',
      'fk_gig_template_fields__help_content_key',
      'fk_gig_template_fields__default_content_key',
      'fk_gig_template_field_options__label_content_key',
    ]) {
      const e = asCatalog(
        capture(() =>
          mapDbError({
            code: '23503',
            constraint,
            detail: 'Key (label_content_key)=(catalog.gig_template.LEAK.field.x.label) is not present in table "entries".',
          }),
        ),
      );
      expect(e.code, constraint).toBe('VALIDATION_FAILED');
      expect(e.details, constraint).toEqual({ reason: 'CONTENT_ENTRY_MISSING' });
      expect(surface(e)).not.toMatch(/LEAK|catalog\.|entries/);
    }
  });

  it('every other reference stays a generic VALIDATION_FAILED without a reason and without the driver detail', () => {
    for (const constraint of [
      'fk_gig_templates__service_type_id',
      'fk_gig_template_versions__gig_template_id',
      'fk_gig_template_fields__version_id',
      'fk_gig_template_field_options__field_id',
      'fk_gig_template_requirements__version_id',
      'fk_market_gig_templates__market_id',
      'fk_market_gig_templates__gig_template_id',
      'fk_audit_events__gig_template_id',
    ]) {
      const e = asCatalog(capture(() => mapDbError({ code: '23503', constraint, detail: 'Key (x)=(LEAK) is not present in table "markets".' })));
      expect(e.code, constraint).toBe('VALIDATION_FAILED');
      expect(e.details.reason, constraint).toBeUndefined();
      expect(e.message).not.toMatch(/LEAK|markets/);
    }
  });

  it('a check violation of the new tables is a VALIDATION_FAILED with fixed text; a deadlock, a serialization failure and a lock timeout are one retryable CONFLICT', () => {
    const c = asCatalog(capture(() => mapDbError({ code: '23514', constraint: 'ck_gig_template_fields__number_order', message: 'new row violates LEAK' })));
    expect(c.code).toBe('VALIDATION_FAILED');
    expect(c.message).not.toContain('LEAK');
    for (const code of ['40P01', '40001', '55P03']) {
      const e = asCatalog(capture(() => mapDbError({ code, constraint: 'uq_gig_template_versions__draft', message: 'LEAK' })));
      expect(e.details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    }
  });
});

// ====================================================================== service over a database that must not be reached
const SENTINEL = 'sentinel-database-reached';
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
  return { database, touched };
}
function gate(publicMarkets: Record<string, PublicMarket> = {}) {
  const asked: unknown[] = [];
  const g: MarketGate = {
    publicMarket: async (code) => {
      asked.push(code);
      return publicMarkets[code] ?? null;
    },
  };
  return { gate: g, asked };
}
const LAOC: PublicMarket = { code: 'la-oc', defaultLocale: 'en-US' };
class Spy extends MemoryConfigCache {
  readonly gets: string[] = [];
  readonly sets: string[] = [];
  override async get(key: string): Promise<string | null> {
    this.gets.push(key);
    return super.get(key);
  }
  override async set(key: string, value: string): Promise<void> {
    this.sets.push(key);
    await super.set(key, value);
  }
}
function build(over: { allowTestKeys?: boolean; cache?: ConfigCache; markets?: Record<string, PublicMarket> } = {}) {
  const db = untouchable();
  const g = gate(over.markets);
  const service = new GigTemplateService({
    database: db.database,
    markets: g.gate,
    env: 'test',
    allowTestKeys: over.allowTestKeys,
    cache: over.cache,
    cacheDeadlineMs: 30,
  });
  return { service, ...db, ...g };
}

type Call = (s: GigTemplateService, input: unknown) => Promise<unknown>;
const MUTATIONS: Record<string, Call> = {
  createGigTemplate: (s, i) => s.createGigTemplate(i, 'admin'),
  updateGigTemplate: (s, i) => s.updateGigTemplate('full_detail', i, 'admin'),
  setGigTemplateStatus: (s, i) => s.setGigTemplateStatus('full_detail', i, 'admin'),
  createGigTemplateVersion: (s, i) => s.createGigTemplateVersion('full_detail', i, 'admin'),
  replaceGigTemplateDraft: (s, i) => s.replaceGigTemplateDraft('full_detail', 1, i, 'admin'),
  publishGigTemplateVersion: (s, i) => s.publishGigTemplateVersion('full_detail', 1, i, 'admin'),
  retireGigTemplateVersion: (s, i) => s.retireGigTemplateVersion('full_detail', 1, i, 'admin'),
  setMarketGigTemplateAvailability: (s, i) => s.setMarketGigTemplateAvailability('la-oc', 'full_detail', i, 'admin'),
};
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  createGigTemplate: { code: 'window_tint', serviceTypeCode: 'car_detailing', reason: GOOD },
  updateGigTemplate: { withDescription: true, reason: GOOD },
  setGigTemplateStatus: { status: 'ACTIVE', reason: GOOD },
  createGigTemplateVersion: { copyFromVersion: 1, reason: GOOD },
  replaceGigTemplateDraft: replaceBody({ fields: ALL_TYPE_FIELDS() }),
  publishGigTemplateVersion: { expectedRevision: 2, reason: GOOD },
  retireGigTemplateVersion: { status: 'RETIRED', reason: GOOD },
  setMarketGigTemplateAvailability: { enabled: true, displayOrder: 10, reason: GOOD },
};

describe('management input is validated before the database is touched', () => {
  const names = Object.keys(MUTATIONS);

  it.each(names)('%s: a valid input reaches the database (the control that makes every refusal below meaningful)', async (name) => {
    const b = build();
    const e = await fail(MUTATIONS[name]!(b.service, VALID_INPUT[name]));
    expect((e as Error).message).toBe(SENTINEL);
    expect(b.touched.length).toBeGreaterThan(0);
  });

  it.each(names)(
    '%s: non-object inputs, unknown fields, a missing or blank reason and a wrong-type reason are VALIDATION_FAILED and never reach the database',
    async (name) => {
      const b = build();
      const good = VALID_INPUT[name]!;
      const without = (k: string) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== k));
      const cases: [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['string', 'status'],
        ['number', 7],
        ['array', [good]],
        ['empty object', {}],
        ['unknown field', { ...good, extra: 1 }],
        ['unknown field __proto__', JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(good).slice(1)}`)],
        ['missing reason', without('reason')],
        ['empty reason', { ...good, reason: '' }],
        ['blank reason', { ...good, reason: '   ' }],
        ['tab/newline reason', { ...good, reason: '\t\n' }],
        ['control character in the reason', { ...good, reason: 'bad\u0007reason' }],
        ['bidi override in the reason', { ...good, reason: 'bad‮reason' }],
        ['lone surrogate in the reason', { ...good, reason: 'bad\uD800reason' }],
        ['reason of 1001 characters', { ...good, reason: 'x'.repeat(1001) }],
        ['numeric reason', { ...good, reason: 5 }],
        ['null reason', { ...good, reason: null }],
        ['object reason', { ...good, reason: { text: 'x' } }],
      ];
      for (const [label, input] of cases) {
        const e = asCatalog(await fail(MUTATIONS[name]!(b.service, input)));
        expect(e.code, `${name} / ${label}`).toBe('VALIDATION_FAILED');
        expect(e.details.reason, `${name} / ${label}`).toBe('INVALID_FIELD');
        expect(e.message).toBe('the request is not valid');
      }
      expect(b.touched).toEqual([]);
    },
  );

  it('a reason of exactly 1000 characters is accepted (the boundary) and reaches the database', async () => {
    const b = build();
    const e = await fail(b.service.setGigTemplateStatus('full_detail', { status: 'ACTIVE', reason: 'x'.repeat(1000) }, 'admin'));
    expect((e as Error).message).toBe(SENTINEL);
  });

  it('the error names the failing field and never echoes the value that was sent', async () => {
    const b = build();
    const secret = 'ZZ-secret-scan:allow-ZZ'; // secret-scan:allow
    const e = asCatalog(await fail(b.service.createGigTemplate({ code: secret, serviceTypeCode: 'car_detailing', reason: GOOD }, 'admin')));
    expect(e.details).toEqual({ reason: 'INVALID_FIELD', field: 'code' });
    expect(surface(e)).not.toContain('ZZ');
    const e2 = asCatalog(await fail(b.service.createGigTemplate({ code: 'window_tint', serviceTypeCode: secret, reason: GOOD }, 'admin')));
    expect(e2.details).toEqual({ reason: 'INVALID_FIELD', field: 'serviceTypeCode' });
    expect(surface(e2)).not.toContain('ZZ');
    const e3 = asCatalog(
      await fail(b.service.createGigTemplate({ code: 'window_tint', serviceTypeCode: 'car_detailing', reason: GOOD, [secret]: 1 }, 'admin')),
    );
    expect(surface(e3)).not.toContain('ZZ');
    const e4 = asCatalog(await fail(b.service.replaceGigTemplateDraft('full_detail', 1, replaceBody({ fields: [rawField({ fieldKey: secret })] }), 'admin')));
    expect(e4.details).toEqual({ reason: 'INVALID_FIELD', field: 'fields.0.fieldKey' });
    expect(surface(e4)).not.toContain('ZZ');
    const e5 = asCatalog(
      await fail(b.service.setMarketGigTemplateAvailability('la-oc', 'full_detail', { enabled: true, displayOrder: 123456, reason: GOOD }, 'admin')),
    );
    expect(e5.details).toEqual({ reason: 'INVALID_FIELD', field: 'displayOrder' });
    expect(surface(e5)).not.toContain('123456');
    expect(b.touched).toEqual([]);
  });

  const BAD_CODES: [string, unknown][] = [
    ['upper case', 'Window_Tint'],
    ['too short', 'a'],
    ['too long', 'a'.repeat(49)],
    ['space', 'window tint'],
    ['kebab', 'window-tint'],
    ['trailing underscore', 'window_'],
    ['leading underscore', '_window'],
    ['double underscore', 'window__tint'],
    ['leading digit', '1window'],
    ['unicode letter', 'färg'],
    ['fullwidth', 'ｗindow'],
    ['traversal', '../window'],
    ['sql', "window'; DROP TABLE catalog.gig_templates;--"],
    ['newline', 'window\n'],
    ['nul', 'window\u0000'],
    ['empty', ''],
    ['number', 7],
    ['null', null],
    ['array', ['window']],
    ['object', { toString: () => 'window' }],
  ];
  it('createGigTemplate rejects every malformed code and service type code with the right field before the database', async () => {
    const b = build({ allowTestKeys: true });
    for (const [label, bad] of BAD_CODES) {
      const e1 = asCatalog(await fail(b.service.createGigTemplate({ code: bad, serviceTypeCode: 'car_detailing', reason: GOOD }, 'admin')));
      expect(e1.details, `code / ${label}`).toEqual({ reason: 'INVALID_FIELD', field: 'code' });
      const e2 = asCatalog(await fail(b.service.createGigTemplate({ code: 'window_tint', serviceTypeCode: bad, reason: GOOD }, 'admin')));
      expect(e2.details, `serviceTypeCode / ${label}`).toEqual({ reason: 'INVALID_FIELD', field: 'serviceTypeCode' });
    }
    expect(b.touched).toEqual([]);
  });

  it('a code of 2 and of 48 valid characters is accepted (the boundary); the optional links must be real booleans', async () => {
    const b = build();
    for (const code of ['ab', 'a'.repeat(48), 'a1_b2', 'a_1']) {
      const e = await fail(b.service.createGigTemplate({ code, serviceTypeCode: 'car_detailing', reason: GOOD }, 'admin'));
      expect((e as Error).message, code).toBe(SENTINEL);
    }
    for (const field of ['withDescription', 'withInstructions'])
      for (const bad of ['true', 1, 0, null, {}, []])
        expect(
          asCatalog(await fail(b.service.createGigTemplate({ code: 'window_tint', serviceTypeCode: 'car_detailing', reason: GOOD, [field]: bad }, 'admin')))
            .details.field,
          `${field}/${String(bad)}`,
        ).toBe(field);
    for (const ok of [true, false, undefined])
      expect(
        (
          (await fail(
            b.service.createGigTemplate(
              { code: 'window_tint', serviceTypeCode: 'car_detailing', reason: GOOD, withDescription: ok, withInstructions: ok },
              'admin',
            ),
          )) as Error
        ).message,
      ).toBe(SENTINEL);
  });

  it('updateGigTemplate needs at least one of the two links, each a real boolean', async () => {
    const b = build();
    expect(asCatalog(await fail(b.service.updateGigTemplate('full_detail', { reason: GOOD }, 'admin'))).code).toBe('VALIDATION_FAILED');
    for (const field of ['withDescription', 'withInstructions']) {
      for (const bad of ['true', 1, null, {}])
        expect(
          asCatalog(await fail(b.service.updateGigTemplate('full_detail', { [field]: bad, reason: GOOD }, 'admin'))).details.field,
          `${field}/${String(bad)}`,
        ).toBe(field);
      for (const ok of [true, false])
        expect(((await fail(b.service.updateGigTemplate('full_detail', { [field]: ok, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
    }
  });

  it('a status request accepts ACTIVE, INACTIVE and RETIRED only: DRAFT, a wrong case, padding, a number or a missing status are refused', async () => {
    const b = build();
    for (const status of ['DRAFT', 'active', 'Active', 'ACTIVE ', ' ACTIVE', 'SUPERSEDED', 'DELETED', '', 1, true, null, undefined]) {
      const e = asCatalog(await fail(b.service.setGigTemplateStatus('full_detail', { status, reason: GOOD }, 'admin')));
      expect(e.details, String(status)).toEqual({ reason: 'INVALID_FIELD', field: 'status' });
    }
    for (const status of ['ACTIVE', 'INACTIVE', 'RETIRED'])
      expect(((await fail(b.service.setGigTemplateStatus('full_detail', { status, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
  });

  it('a version can only be discarded: the request status must be exactly RETIRED', async () => {
    const b = build();
    for (const status of ['ACTIVE', 'DRAFT', 'SUPERSEDED', 'retired', 'RETIRED ', '', null, undefined, 1]) {
      const e = asCatalog(await fail(b.service.retireGigTemplateVersion('full_detail', 1, { status, reason: GOOD }, 'admin')));
      expect(e.details, String(status)).toEqual({ reason: 'INVALID_FIELD', field: 'status' });
    }
    expect(b.touched).toEqual([]);
  });

  it('createGigTemplateVersion: copyFromVersion is a positive integer or absent', async () => {
    const b = build();
    for (const bad of [0, -1, 1.5, '1', null, NaN, Infinity, {}, 2_147_483_648, 2 ** 40, Number.MAX_SAFE_INTEGER])
      expect(
        asCatalog(await fail(b.service.createGigTemplateVersion('full_detail', { copyFromVersion: bad, reason: GOOD }, 'admin'))).details.field,
        String(bad),
      ).toBe('copyFromVersion');
    for (const ok of [undefined, 1, 2, 2_147_483_647])
      expect(((await fail(b.service.createGigTemplateVersion('full_detail', { copyFromVersion: ok, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
  });

  it('publish: expectedRevision is a positive integer', async () => {
    const b = build();
    for (const bad of [0, -1, 1.5, '1', null, undefined, NaN])
      expect(
        asCatalog(await fail(b.service.publishGigTemplateVersion('full_detail', 1, { expectedRevision: bad, reason: GOOD }, 'admin'))).details.field,
        String(bad),
      ).toBe('expectedRevision');
    expect(b.touched).toEqual([]);
  });

  it('availability: enabled must be a real boolean, displayOrder an integer 1..9999 (or absent)', async () => {
    const b = build();
    const call = (i: unknown) => b.service.setMarketGigTemplateAvailability('la-oc', 'full_detail', i, 'admin');
    for (const enabled of ['true', 'false', 1, 0, null, undefined, []])
      expect(asCatalog(await fail(call({ enabled, displayOrder: 10, reason: GOOD }))).details.field, String(enabled)).toBe('enabled');
    for (const displayOrder of [0, -1, 10000, 1.5, '10', '1e1', NaN, Infinity, null, true, []])
      expect(asCatalog(await fail(call({ enabled: true, displayOrder, reason: GOOD }))).details.field, String(displayOrder)).toBe('displayOrder');
    for (const displayOrder of [1, 9999, undefined])
      expect(((await fail(call({ enabled: true, displayOrder, reason: GOOD }))) as Error).message).toBe(SENTINEL);
  });
});

describe('the version number of a path is validated before anything else', () => {
  const BAD_NUMBERS: unknown[] = [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '1',
    null,
    undefined,
    {},
    [],
    true,
    2_147_483_648,
    2 ** 40,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    1e21,
  ];
  const calls: [string, (s: GigTemplateService, n: unknown, body: unknown) => Promise<unknown>][] = [
    ['getGigTemplateVersion', (s, n) => s.getGigTemplateVersion('full_detail', n as number)],
    ['replaceGigTemplateDraft', (s, n, body) => s.replaceGigTemplateDraft('full_detail', n as number, body, 'admin')],
    ['publishGigTemplateVersion', (s, n, body) => s.publishGigTemplateVersion('full_detail', n as number, body, 'admin')],
    ['retireGigTemplateVersion', (s, n, body) => s.retireGigTemplateVersion('full_detail', n as number, body, 'admin')],
  ];
  const bodies: Record<string, unknown> = {
    getGigTemplateVersion: undefined,
    replaceGigTemplateDraft: replaceBody(),
    publishGigTemplateVersion: { expectedRevision: 1, reason: GOOD },
    retireGigTemplateVersion: { status: 'RETIRED', reason: GOOD },
  };

  it.each(calls.map(([n]) => n))(
    '%s: a version number that is not a positive 32-bit integer is GIG_TEMPLATE_VERSION_NOT_FOUND and the database is not reached',
    async (name) => {
      const b = build();
      const call = calls.find(([n]) => n === name)![1];
      for (const bad of BAD_NUMBERS) {
        const e = asCatalog(await fail(call(b.service, bad, bodies[name])));
        expect(e.code, String(bad)).toBe('GIG_TEMPLATE_VERSION_NOT_FOUND');
        expect(String(e.details.code).length).toBeLessThanOrEqual(16);
      }
      expect(b.touched).toEqual([]);
    },
  );

  it.each(calls.map(([n]) => n))(
    '%s: the version number is checked BEFORE the body (a bad number with a bad body is a not-found, not a validation failure)',
    async (name) => {
      const b = build();
      const call = calls.find(([n]) => n === name)![1];
      expect(asCatalog(await fail(call(b.service, 0, { nonsense: true }))).code).toBe('GIG_TEMPLATE_VERSION_NOT_FOUND');
    },
  );

  it.each(calls.map(([n]) => n))('%s: 1, 2 and 2147483647 are accepted and reach the database', async (name) => {
    const b = build();
    const call = calls.find(([n]) => n === name)![1];
    for (const ok of [1, 2, 2_147_483_647]) expect(((await fail(call(b.service, ok, bodies[name]))) as Error).message, `${ok}`).toBe(SENTINEL);
  });
});

describe('replaceGigTemplateDraft: the definition is validated strictly and the first issue names its path', () => {
  const replace = (over: Record<string, unknown>) => {
    const b = build();
    return fail(b.service.replaceGigTemplateDraft('full_detail', 1, replaceBody(over), 'admin')).then((e) => ({ e, b }));
  };

  it('a definition with one field of every type, every section and every behaviour that is allowed is accepted (the control)', async () => {
    const { e, b } = await replace({
      fields: ALL_TYPE_FIELDS(),
      duration: { minMinutes: 30, maxMinutes: 240, suggestedMinutes: 60 },
      pricingModels: [...PRICING_MODELS],
      areaModes: [...AREA_MODES],
      requirements: [{ requirementType: 'SKILL', referenceCode: 'wax' }, { requirementType: 'LICENSE' }],
    });
    expect((e as Error).message).toBe(SENTINEL);
    expect(b.touched.length).toBeGreaterThan(0);
  });

  const INVALID: [string, Record<string, unknown>, string][] = [
    ['TEXT with a numeric bound', { fields: [rawField({ minNumber: 1 })] }, 'fields.0.minNumber'],
    ['INTEGER with a length bound', { fields: [rawField({ fieldType: 'INTEGER', minLength: 1 })] }, 'fields.0.minLength'],
    ['TEXT with a boolean default', { fields: [rawField({ defaultBoolean: true })] }, 'fields.0.defaultBoolean'],
    ['TEXT with item counts', { fields: [rawField({ maxItems: 2 })] }, 'fields.0.minItems'],
    ['TEXT with options', { fields: [rawField({ options: [{ optionCode: 'opt_a' }] })] }, 'fields.0.options'],
    ['a default text on an INTEGER', { fields: [rawField({ fieldType: 'INTEGER', withDefaultText: true })] }, 'fields.0.withDefaultText'],
    ['minLength above maxLength', { fields: [rawField({ minLength: 10, maxLength: 5 })] }, 'fields.0.maxLength'],
    ['a zero length', { fields: [rawField({ minLength: 0 })] }, 'fields.0.minLength'],
    ['a fractional INTEGER default', { fields: [rawField({ fieldType: 'INTEGER', defaultNumber: 1.5 })] }, 'fields.0.defaultNumber'],
    ['a fractional DURATION bound', { fields: [rawField({ fieldType: 'DURATION', minNumber: 1.5 })] }, 'fields.0.minNumber'],
    ['a DURATION below one minute', { fields: [rawField({ fieldType: 'DURATION', minNumber: 0 })] }, 'fields.0.minNumber'],
    ['a DECIMAL default below its minimum', { fields: [rawField({ fieldType: 'DECIMAL', minNumber: 5, defaultNumber: 4 })] }, 'fields.0.defaultNumber'],
    ['a DECIMAL default above its maximum', { fields: [rawField({ fieldType: 'DECIMAL', maxNumber: 5, defaultNumber: 6 })] }, 'fields.0.defaultNumber'],
    ['maxNumber below minNumber', { fields: [rawField({ fieldType: 'DECIMAL', minNumber: 5, maxNumber: 4 })] }, 'fields.0.maxNumber'],
    ['five decimal places', { fields: [rawField({ fieldType: 'DECIMAL', defaultNumber: 1.00001 })] }, 'fields.0.defaultNumber'],
    ['a bound beyond a trillion', { fields: [rawField({ fieldType: 'DECIMAL', maxNumber: 1e13 })] }, 'fields.0.maxNumber'],
    ['MEDIA required without a minimum', { fields: [rawField({ fieldType: 'MEDIA' })] }, 'fields.0.minItems'],
    ['MEDIA required with maxItems 0 and minItems 0', { fields: [rawField({ fieldType: 'MEDIA', minItems: 0, maxItems: 0 })] }, 'fields.0.minItems'],
    ['MEDIA required with minItems above maxItems 0', { fields: [rawField({ fieldType: 'MEDIA', minItems: 1, maxItems: 0 })] }, 'fields.0.maxItems'],
    [
      'minItems above maxItems',
      { fields: [rawField({ fieldType: 'SKILL_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', minItems: 3, maxItems: 2 })] },
      'fields.0.maxItems',
    ],
    [
      'a reference field that allows no selection',
      { fields: [rawField({ fieldType: 'EQUIPMENT_REFERENCE', behavior: 'PROVIDER_CONFIGURABLE', maxItems: 0 })] },
      'fields.0.maxItems',
    ],
    ['more than 1000 items', { fields: [rawField({ fieldType: 'MEDIA', behavior: 'PROVIDER_CONFIGURABLE', maxItems: 1001 })] }, 'fields.0.maxItems'],
    ['PLATFORM_FIXED money', { fields: [rawField({ fieldType: 'MONEY', behavior: 'PLATFORM_FIXED' })] }, 'fields.0.behavior'],
    ['PLATFORM_FIXED media', { fields: [rawField({ fieldType: 'MEDIA', behavior: 'PLATFORM_FIXED' })] }, 'fields.0.behavior'],
    ['PLATFORM_FIXED text without its default text', { fields: [rawField({ behavior: 'PLATFORM_FIXED' })] }, 'fields.0.behavior'],
    ['PLATFORM_FIXED integer without a default', { fields: [rawField({ fieldType: 'INTEGER', behavior: 'PLATFORM_FIXED' })] }, 'fields.0.behavior'],
    ['PLATFORM_FIXED boolean without a default', { fields: [rawField({ fieldType: 'BOOLEAN', behavior: 'PLATFORM_FIXED' })] }, 'fields.0.behavior'],
    [
      'PLATFORM_FIXED enum without a default option',
      { fields: [rawField({ fieldType: 'ENUM', behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'opt_a' }] })] },
      'fields.0.behavior',
    ],
    ['duplicate option codes', { fields: [rawField({ fieldType: 'ENUM', options: [{ optionCode: 'opt_a' }, { optionCode: 'opt_a' }] })] }, 'fields.0.options'],
    [
      'two default options',
      {
        fields: [
          rawField({
            fieldType: 'ENUM',
            options: [
              { optionCode: 'opt_a', isDefault: true },
              { optionCode: 'opt_b', isDefault: true },
            ],
          }),
        ],
      },
      'fields.0.options',
    ],
    [
      '31 options',
      { fields: [rawField({ fieldType: 'ENUM', options: Array.from({ length: 31 }, (_, i) => ({ optionCode: `opt_${i}x` })) })] },
      'fields.0.options',
    ],
    ['a bad option code', { fields: [rawField({ fieldType: 'ENUM', options: [{ optionCode: 'Opt A' }] })] }, 'fields.0.options.0.optionCode'],
    ['a bad field key', { fields: [rawField({ fieldKey: 'Bad Key' })] }, 'fields.0.fieldKey'],
    ['a one character field key', { fields: [rawField({ fieldKey: 'a' })] }, 'fields.0.fieldKey'],
    ['a 33 character field key', { fields: [rawField({ fieldKey: 'a'.repeat(33) })] }, 'fields.0.fieldKey'],
    ['an unknown type', { fields: [rawField({ fieldType: 'JSON' })] }, 'fields.0.fieldType'],
    ['an unknown section', { fields: [rawField({ section: 'FOOTER' })] }, 'fields.0.section'],
    ['an unknown behaviour', { fields: [rawField({ behavior: 'OPTIONAL' })] }, 'fields.0.behavior'],
    ['a second field that is wrong', { fields: [rawField(), rawField({ fieldKey: 'second_field', minNumber: 1 })] }, 'fields.1.minNumber'],
    ['duplicate field keys', { fields: [rawField(), rawField()] }, 'fields'],
    ['61 fields', { fields: Array.from({ length: 61 }, (_, i) => rawField({ fieldKey: `field_${i}x` })) }, 'fields'],
    ['an unknown key on a field', { fields: [rawField({ price: 5 })] }, 'fields.0'],
    ['an empty pricing list', { pricingModels: [] }, 'pricingModels'],
    ['pricing without a base price', { pricingModels: ['BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE'] }, 'pricingModels'],
    ['add-ons alone (a permission, not a base price)', { pricingModels: ['ADD_ONS'] }, 'pricingModels'],
    ['a repeated pricing model', { pricingModels: ['FIXED', 'FIXED'] }, 'pricingModels'],
    ['an unknown pricing model', { pricingModels: ['FIXED', 'FREE'] }, 'pricingModels.1'],
    ['no area mode', { areaModes: [] }, 'areaModes'],
    ['a repeated area mode', { areaModes: ['RADIUS', 'RADIUS'] }, 'areaModes'],
    ['an unknown area mode', { areaModes: ['CIRCLE'] }, 'areaModes.0'],
    ['a duplicate requirement', { requirements: [{ requirementType: 'LICENSE' }, { requirementType: 'LICENSE' }] }, 'requirements'],
    ['an unknown requirement type', { requirements: [{ requirementType: 'SPELL' }] }, 'requirements.0.requirementType'],
    ['a bad requirement reference', { requirements: [{ requirementType: 'SKILL', referenceCode: 'Bad Code' }] }, 'requirements.0.referenceCode'],
    ['an unknown key on a requirement', { requirements: [{ requirementType: 'SKILL', extra: 1 }] }, 'requirements.0'],
    ['31 requirements', { requirements: Array.from({ length: 31 }, (_, i) => ({ requirementType: 'SKILL', referenceCode: `skill_${i}x` })) }, 'requirements'],
    ['a zero minimum duration', { duration: { minMinutes: 0 } }, 'duration.minMinutes'],
    ['a duration above a million minutes', { duration: { maxMinutes: 1_000_001 } }, 'duration.maxMinutes'],
    ['a fractional duration', { duration: { minMinutes: 1.5 } }, 'duration.minMinutes'],
    ['minMinutes above maxMinutes', { duration: { minMinutes: 10, maxMinutes: 5 } }, 'duration.maxMinutes'],
    ['a suggestion below the minimum', { duration: { minMinutes: 10, suggestedMinutes: 5 } }, 'duration.suggestedMinutes'],
    ['a suggestion above the maximum', { duration: { maxMinutes: 10, suggestedMinutes: 11 } }, 'duration.suggestedMinutes'],
    ['an unknown key in the duration', { duration: { minMinutes: 5, hours: 1 } }, 'duration'],
    ['a null duration', { duration: null }, 'duration'],
    ['revision 0', { expectedRevision: 0 }, 'expectedRevision'],
    ['a fractional revision', { expectedRevision: 1.5 }, 'expectedRevision'],
    ['a text revision', { expectedRevision: '1' }, 'expectedRevision'],
    ['a missing revision', { expectedRevision: undefined }, 'expectedRevision'],
    ['a missing field list', { fields: undefined }, 'fields'],
    ['a missing pricing list', { pricingModels: undefined }, 'pricingModels'],
    ['a missing area list', { areaModes: undefined }, 'areaModes'],
  ];
  it.each(INVALID)('%s -> VALIDATION_FAILED INVALID_FIELD on %s and the database is not reached', async (_label, over, field) => {
    const { e, b } = await replace(over);
    const err = asCatalog(e);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details.reason).toBe('INVALID_FIELD');
    expect(err.details.field).toBe(field);
    expect(err.message).toBe('the request is not valid');
    expect(b.touched).toEqual([]);
  });

  it('a requirement list is optional (empty by default); a list of the maximal sizes is accepted', async () => {
    const { e: a } = await replace({ requirements: undefined });
    expect((a as Error).message).toBe(SENTINEL);
    const { e: b } = await replace({
      fields: Array.from({ length: 60 }, (_, i) => rawField({ fieldKey: `field_${i}x` })),
      requirements: Array.from({ length: 30 }, (_, i) => ({ requirementType: 'SKILL', referenceCode: `skill_${i}x` })),
    });
    expect((b as Error).message).toBe(SENTINEL);
    const { e: c } = await replace({ fields: [] });
    expect((c as Error).message).toBe(SENTINEL);
  });
});

describe('devtest_ codes are gated by allowTestKeys', () => {
  const create = (s: GigTemplateService, code: string) => s.createGigTemplate({ code, serviceTypeCode: 'car_detailing', reason: GOOD }, 'admin');

  it('without allowTestKeys a devtest_ template code is refused (TEST_KEY_NOT_ALLOWED on field code) before the database', async () => {
    for (const allow of [undefined, false]) {
      const b = build({ allowTestKeys: allow });
      const e = asCatalog(await fail(create(b.service, 'devtest_tint')));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'TEST_KEY_NOT_ALLOWED', field: 'code' });
      expect(b.touched).toEqual([]);
    }
  });

  it('with allowTestKeys the same code reaches the database; allowTestKeys has to be exactly true', async () => {
    expect(((await fail(create(build({ allowTestKeys: true }).service, 'devtest_tint'))) as Error).message).toBe(SENTINEL);
    const b = build({ allowTestKeys: 'yes' as unknown as boolean });
    expect(asCatalog(await fail(create(b.service, 'devtest_tint'))).details.reason).toBe('TEST_KEY_NOT_ALLOWED');
  });

  it('only the exact prefix devtest_ is gated; a malformed code is an INVALID_FIELD before the gate is looked at', async () => {
    const b = build();
    for (const code of ['devtest', 'devtestx_a', 'x_devtest_a', 'devtest1_a'])
      expect(((await fail(create(b.service, code))) as Error).message, code).toBe(SENTINEL);
    expect(asCatalog(await fail(create(b.service, 'Devtest_a'))).details.reason).toBe('INVALID_FIELD');
  });

  it('only creation is gated: the other operations accept a devtest_ code (a test row that already exists can still be managed)', async () => {
    const b = build();
    expect(((await fail(b.service.setGigTemplateStatus('devtest_tint', { status: 'ACTIVE', reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
    expect(((await fail(b.service.updateGigTemplate('devtest_tint', { withDescription: true, reason: GOOD }, 'admin'))) as Error).message).toBe(SENTINEL);
  });
});

// ====================================================================== view mappers
const NOW = new Date('2026-03-04T05:06:07.890Z');
const LATER = new Date('2026-03-05T06:07:08.901Z');
const versionRow = (over: Record<string, unknown> = {}) => ({
  gig_template_version_id: '33333333-3333-4333-8333-333333333333',
  gig_template_id: '11111111-1111-4111-8111-111111111111',
  version_number: 3,
  status: 'ACTIVE',
  revision: 4,
  min_duration_minutes: 30,
  max_duration_minutes: 120,
  suggested_duration_minutes: 60,
  pricing_fixed: true,
  pricing_fixed_with_variants: false,
  pricing_bundle_eligible: true,
  pricing_drop_eligible: false,
  pricing_add_ons: false,
  area_radius: true,
  area_postal_codes: true,
  area_polygon: false,
  created_at: NOW,
  updated_at: NOW,
  published_at: LATER,
  closed_at: null,
  ...over,
});
const PUBLIC_VERSION_KEYS = ['areaModes', 'duration', 'fieldCount', 'gigTemplateVersionId', 'pricingModels', 'versionNumber'];

describe('versionSummaryView', () => {
  it('the public view has exactly the public key set, whatever the row holds (no status, revision, timestamps, nothing provider-specific)', () => {
    const v = versionSummaryView(versionRow({ price: 5, provider_id: 'p', radius_km: 3, capacity: 2, secret: 'x', floor_price: 1 }), 7, false);
    expect(keys(v)).toEqual(PUBLIC_VERSION_KEYS);
    expect(v).toEqual({
      gigTemplateVersionId: '33333333-3333-4333-8333-333333333333',
      versionNumber: 3,
      duration: { minMinutes: 30, maxMinutes: 120, suggestedMinutes: 60 },
      pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
      areaModes: ['RADIUS', 'POSTAL_CODES'],
      fieldCount: 7,
    });
  });

  it('reports ADD_ONS (last in the canonical order) in both views when the permission is on, and not when it is off', () => {
    const on = versionRow({ pricing_add_ons: true });
    expect(versionSummaryView(on, 7, false).pricingModels).toEqual(['FIXED', 'BUNDLE_ELIGIBLE', 'ADD_ONS']);
    expect(versionSummaryView(on, 7, true).pricingModels).toEqual(['FIXED', 'BUNDLE_ELIGIBLE', 'ADD_ONS']);
    expect(versionSummaryView(versionRow(), 7, true).pricingModels).toEqual(['FIXED', 'BUNDLE_ELIGIBLE']);
  });

  it('the management view adds status, revision and the three timestamps (ISO text, null when absent)', () => {
    const v = versionSummaryView(versionRow(), 7, true);
    expect(keys(v)).toEqual([...PUBLIC_VERSION_KEYS, 'closedAt', 'createdAt', 'publishedAt', 'revision', 'status'].sort());
    expect(v.status).toBe('ACTIVE');
    expect(v.revision).toBe(4);
    expect(v.createdAt).toBe('2026-03-04T05:06:07.890Z');
    expect(v.publishedAt).toBe('2026-03-05T06:07:08.901Z');
    expect(v.closedAt).toBeNull();
    const closed = versionSummaryView(versionRow({ status: 'SUPERSEDED', closed_at: LATER }), 1, true);
    expect(closed.closedAt).toBe('2026-03-05T06:07:08.901Z');
    const draft = versionSummaryView(versionRow({ status: 'DRAFT', published_at: undefined, closed_at: undefined }), 0, true);
    expect([draft.publishedAt, draft.closedAt]).toEqual([null, null]);
    expect(versionSummaryView(versionRow({ created_at: '2026-01-01T00:00:00.000Z' }), 0, true).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('every status is carried verbatim in the management view', () => {
    for (const status of ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED'] as const) expect(versionSummaryView(versionRow({ status }), 0, true).status).toBe(status);
  });

  it('numbers: a numeric string (a driver may return one) becomes a number; no duration rule is three nulls; a zero field count stays 0', () => {
    const v = versionSummaryView(versionRow({ version_number: '12', revision: '5', min_duration_minutes: '45' }), 0, true);
    expect([v.versionNumber, v.revision, v.duration.minMinutes, v.fieldCount]).toEqual([12, 5, 45, 0]);
    const none = versionSummaryView(versionRow({ min_duration_minutes: null, max_duration_minutes: undefined, suggested_duration_minutes: null }), 1, false);
    expect(none.duration).toEqual({ minMinutes: null, maxMinutes: null, suggestedMinutes: null });
  });
});

describe('pricingModelsOf and areaModesOf', () => {
  const pricingRow = (flags: boolean[]) => ({
    pricing_fixed: flags[0],
    pricing_fixed_with_variants: flags[1],
    pricing_bundle_eligible: flags[2],
    pricing_drop_eligible: flags[3],
    pricing_add_ons: flags[4],
  });
  const areaRow = (flags: boolean[]) => ({ area_radius: flags[0], area_postal_codes: flags[1], area_polygon: flags[2] });

  it('lists the allowed models in the canonical order, one per true flag, whatever the order of the columns', () => {
    expect(pricingModelsOf(pricingRow([true, true, true, true, true]))).toEqual([
      'FIXED',
      'FIXED_WITH_VARIANTS',
      'BUNDLE_ELIGIBLE',
      'DROP_ELIGIBLE',
      'ADD_ONS',
    ]);
    expect(pricingModelsOf({ pricing_add_ons: true, pricing_drop_eligible: true, pricing_bundle_eligible: true, pricing_fixed: true })).toEqual([
      'FIXED',
      'BUNDLE_ELIGIBLE',
      'DROP_ELIGIBLE',
      'ADD_ONS',
    ]);
    // a row from before CAT-004 (no pricing_add_ons column value) or with the permission off never reports ADD_ONS
    expect(pricingModelsOf({ pricing_fixed: true, pricing_add_ons: false })).toEqual(['FIXED']);
    expect(pricingModelsOf({ pricing_fixed: true })).toEqual(['FIXED']);
    expect(areaModesOf(areaRow([true, true, true]))).toEqual(['RADIUS', 'POSTAL_CODES', 'POLYGON']);
    expect(areaModesOf({ area_polygon: true, area_radius: true })).toEqual(['RADIUS', 'POLYGON']);
  });

  it('each flag alone yields exactly its model (the mapping of the five pricing and three area columns is one to one)', () => {
    PRICING_MODELS.forEach((m, i) => {
      const flags = [false, false, false, false, false];
      flags[i] = true;
      expect(pricingModelsOf(pricingRow(flags)), m).toEqual([m]);
    });
    AREA_MODES.forEach((m, i) => {
      const flags = [false, false, false];
      flags[i] = true;
      expect(areaModesOf(areaRow(flags)), m).toEqual([m]);
    });
  });

  it('no true flag, an absent column and a value that is not exactly true (1, "t", "true", null) are not models', () => {
    expect(pricingModelsOf(pricingRow([false, false, false, false, false]))).toEqual([]);
    expect(areaModesOf(areaRow([false, false, false]))).toEqual([]);
    expect(pricingModelsOf({})).toEqual([]);
    expect(areaModesOf({})).toEqual([]);
    expect(
      pricingModelsOf({ pricing_fixed: 1, pricing_fixed_with_variants: 't', pricing_bundle_eligible: 'true', pricing_drop_eligible: null, pricing_add_ons: 1 }),
    ).toEqual([]);
    expect(areaModesOf({ area_radius: 1, area_postal_codes: 't', area_polygon: 'true' })).toEqual([]);
  });
});

describe('fieldView', () => {
  const fieldRow = (over: Record<string, unknown> = {}) => ({
    gig_template_field_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    gig_template_version_id: '33333333-3333-4333-8333-333333333333',
    field_key: 'scope_notes',
    field_type: 'TEXT',
    section: 'SCOPE',
    behavior: 'PROVIDER_REQUIRED',
    customer_visible: true,
    display_order: 2,
    label_content_key: 'catalog.gig_template.full_detail.field.scope_notes.label',
    help_content_key: null,
    default_content_key: null,
    min_length: null,
    max_length: null,
    min_number: null,
    max_number: null,
    default_number: null,
    default_boolean: null,
    min_items: null,
    max_items: null,
    ...over,
  });
  const FIELD_KEYS = [
    'behavior',
    'customerVisible',
    'defaultBoolean',
    'defaultContentKey',
    'defaultNumber',
    'displayOrder',
    'fieldKey',
    'fieldType',
    'helpContentKey',
    'labelContentKey',
    'maxItems',
    'maxLength',
    'maxNumber',
    'minItems',
    'minLength',
    'minNumber',
    'options',
    'section',
  ];

  it('has exactly the field key set (no row ids, nothing a provider would enter) and carries the content KEYS, never text', () => {
    const v = fieldView(fieldRow({ price: 5, provider_id: 'p', secret: 'x' }), []);
    expect(keys(v)).toEqual(FIELD_KEYS);
    expect(v).toMatchObject({
      fieldKey: 'scope_notes',
      fieldType: 'TEXT',
      section: 'SCOPE',
      behavior: 'PROVIDER_REQUIRED',
      customerVisible: true,
      displayOrder: 2,
      labelContentKey: 'catalog.gig_template.full_detail.field.scope_notes.label',
      helpContentKey: null,
      defaultContentKey: null,
      options: [],
    });
    expect(JSON.stringify(v)).not.toMatch(/ffffffff|33333333/);
  });

  it('numeric(18,4) text becomes a number, a zero stays 0 and a false default stays false (never turned into null)', () => {
    const v = fieldView(
      fieldRow({
        field_type: 'DECIMAL',
        min_number: '0.0000',
        max_number: '9.9999',
        default_number: '1.2500',
        default_boolean: false,
        min_items: 0,
        max_items: 0,
        min_length: 0,
        customer_visible: false,
      }),
      [],
    );
    expect([v.minNumber, v.maxNumber, v.defaultNumber]).toEqual([0, 9.9999, 1.25]);
    expect(v.defaultBoolean).toBe(false);
    expect([v.minItems, v.maxItems, v.minLength]).toEqual([0, 0, 0]);
    expect(v.customerVisible).toBe(false);
    expect(fieldView(fieldRow({ default_boolean: true }), []).defaultBoolean).toBe(true);
  });

  it('an absent or null column is null; a visibility that is not exactly true is false; the options are passed through in the given order', () => {
    const v = fieldView(fieldRow({ min_number: undefined, default_boolean: undefined, help_content_key: undefined, customer_visible: null }), []);
    expect([v.minNumber, v.defaultBoolean, v.helpContentKey, v.customerVisible]).toEqual([null, null, null, false]);
    const options = [
      { optionCode: 'opt_b', labelContentKey: 'k_b', isDefault: false, displayOrder: 1 },
      { optionCode: 'opt_a', labelContentKey: 'k_a', isDefault: true, displayOrder: 2 },
    ];
    expect(fieldView(fieldRow({ field_type: 'ENUM' }), options).options).toEqual(options);
    expect(fieldView(fieldRow({ help_content_key: 'h', default_content_key: 'd' }), []).helpContentKey).toBe('h');
    expect(fieldView(fieldRow({ help_content_key: 'h', default_content_key: 'd' }), []).defaultContentKey).toBe('d');
  });
});

// ====================================================================== the cache snapshot schema
const SAMPLE_OPTION = {
  optionCode: 'wax',
  labelContentKey: 'catalog.gig_template.full_detail.field.finish.option.wax.label',
  isDefault: true,
  displayOrder: 1,
};
const SAMPLE_FIELD = {
  fieldKey: 'finish',
  fieldType: 'ENUM',
  section: 'INCLUSIONS',
  behavior: 'PROVIDER_CONFIGURABLE',
  customerVisible: true,
  displayOrder: 1,
  labelContentKey: 'catalog.gig_template.full_detail.field.finish.label',
  helpContentKey: null,
  defaultContentKey: null,
  minLength: null,
  maxLength: null,
  minNumber: null,
  maxNumber: null,
  defaultNumber: null,
  defaultBoolean: null,
  minItems: null,
  maxItems: null,
  options: [SAMPLE_OPTION],
};
const SAMPLE_VERSION = {
  gigTemplateVersionId: '33333333-3333-4333-8333-333333333333',
  versionNumber: 2,
  duration: { minMinutes: 30, maxMinutes: 120, suggestedMinutes: null },
  pricingModels: ['FIXED', 'BUNDLE_ELIGIBLE'],
  areaModes: ['RADIUS'],
  fieldCount: 1,
  fields: [SAMPLE_FIELD],
  requirements: [{ requirementType: 'SKILL', referenceCode: 'wax' }],
};
const SAMPLE_TEMPLATE = {
  gigTemplateId: '11111111-1111-4111-8111-111111111111',
  code: 'full_detail',
  serviceTypeCode: 'car_detailing',
  categoryCode: 'auto_services',
  nameContentKey: 'catalog.gig_template.full_detail.name',
  descriptionContentKey: 'catalog.gig_template.full_detail.description',
  instructionsContentKey: null,
  displayOrder: 10,
  activeVersion: SAMPLE_VERSION,
};
const SAMPLE = { templates: [SAMPLE_TEMPLATE] };
const PUBLIC_TEMPLATE_KEYS = [
  'activeVersion',
  'categoryCode',
  'code',
  'descriptionContentKey',
  'displayOrder',
  'gigTemplateId',
  'instructionsContentKey',
  'nameContentKey',
  'serviceTypeCode',
];

describe('the cache snapshot schema', () => {
  it('accepts a complete snapshot, an empty one and a template without an active version', () => {
    expect(GigTemplateSnapshotSchema.safeParse(SAMPLE).success).toBe(true);
    expect(GigTemplateSnapshotSchema.safeParse({ templates: [] }).success).toBe(true);
    expect(GigTemplateSnapshotSchema.safeParse({ templates: [{ ...SAMPLE_TEMPLATE, activeVersion: null }] }).success).toBe(true);
    expect(GigTemplateSnapshotSchema.parse(SAMPLE)).toEqual(SAMPLE);
  });

  it('rejects anything that is not a snapshot', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      7,
      [],
      {},
      { templates: null },
      { templates: 'x' },
      { templates: {} },
      { templates: [null] },
      { templates: [{}] },
      { templates: [[]] },
    ])
      expect(GigTemplateSnapshotSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  const withTemplate = (f: (t: Record<string, unknown>) => void) => {
    const s = clone(SAMPLE) as { templates: Record<string, unknown>[] };
    f(s.templates[0]!);
    return s;
  };
  const version = (t: Record<string, unknown>) =>
    t.activeVersion as Record<string, unknown> & { fields: Record<string, unknown>[]; requirements: Record<string, unknown>[] };

  it('rejects a snapshot in which any required property of a template, a version, a field, an option or a requirement is missing', () => {
    const cases: [string, (t: Record<string, unknown>) => void][] = [];
    for (const k of Object.keys(SAMPLE_TEMPLATE)) cases.push([`template.${k}`, (t) => delete t[k]]);
    for (const k of Object.keys(SAMPLE_VERSION)) cases.push([`version.${k}`, (t) => delete version(t)[k]]);
    for (const k of ['minMinutes', 'maxMinutes', 'suggestedMinutes'])
      cases.push([`duration.${k}`, (t) => delete (version(t).duration as Record<string, unknown>)[k]]);
    for (const k of Object.keys(SAMPLE_FIELD)) cases.push([`field.${k}`, (t) => delete version(t).fields[0]![k]]);
    for (const k of Object.keys(SAMPLE_OPTION)) cases.push([`option.${k}`, (t) => delete (version(t).fields[0]!.options as Record<string, unknown>[])[0]![k]]);
    for (const k of ['requirementType', 'referenceCode']) cases.push([`requirement.${k}`, (t) => delete version(t).requirements[0]![k]]);
    expect(cases.length).toBeGreaterThan(40);
    for (const [label, mutate] of cases) expect(GigTemplateSnapshotSchema.safeParse(withTemplate(mutate)).success, label).toBe(false);
  });

  it('accepts ADD_ONS as a pricing model of the cached version (and an older snapshot without it)', () => {
    expect(GigTemplateSnapshotSchema.safeParse(withTemplate((t) => (version(t).pricingModels = ['FIXED', 'ADD_ONS']))).success).toBe(true);
    expect(GigTemplateSnapshotSchema.safeParse(withTemplate((t) => (version(t).pricingModels = ['FIXED']))).success).toBe(true);
  });

  it('rejects a value of the wrong type or outside its vocabulary', () => {
    const cases: [string, (t: Record<string, unknown>) => void][] = [
      ['template order is a fraction', (t) => (t.displayOrder = 1.5)],
      ['template order is text', (t) => (t.displayOrder = '10')],
      ['code is a number', (t) => (t.code = 7)],
      ['active version is an array', (t) => (t.activeVersion = [])],
      ['unknown status', (t) => (t.status = 'WEIRD')],
      ['version number is a fraction', (t) => (version(t).versionNumber = 2.5)],
      ['field count is text', (t) => (version(t).fieldCount = '1')],
      ['unknown pricing model', (t) => (version(t).pricingModels = ['FREE'])],
      ['unknown area mode', (t) => (version(t).areaModes = ['CIRCLE'])],
      ['pricing models are not a list', (t) => (version(t).pricingModels = 'FIXED')],
      ['duration is not an object', (t) => (version(t).duration = 60)],
      ['duration minutes are text', (t) => ((version(t).duration as Record<string, unknown>).minMinutes = '30')],
      ['unknown field type', (t) => (version(t).fields[0]!.fieldType = 'JSON')],
      ['unknown section', (t) => (version(t).fields[0]!.section = 'FOOTER')],
      ['unknown behaviour', (t) => (version(t).fields[0]!.behavior = 'OPTIONAL')],
      ['customerVisible is text', (t) => (version(t).fields[0]!.customerVisible = 'yes')],
      ['field order is a fraction', (t) => (version(t).fields[0]!.displayOrder = 0.5)],
      ['a bound is text', (t) => (version(t).fields[0]!.minNumber = '1')],
      ['min length is a fraction', (t) => (version(t).fields[0]!.minLength = 1.5)],
      ['default boolean is text', (t) => (version(t).fields[0]!.defaultBoolean = 'false')],
      ['options are not a list', (t) => (version(t).fields[0]!.options = {})],
      ['an option default is text', (t) => ((version(t).fields[0]!.options as Record<string, unknown>[])[0]!.isDefault = 'yes')],
      ['an option order is a fraction', (t) => ((version(t).fields[0]!.options as Record<string, unknown>[])[0]!.displayOrder = 1.5)],
      ['unknown requirement type', (t) => (version(t).requirements[0]!.requirementType = 'SPELL')],
      ['requirement reference is a number', (t) => (version(t).requirements[0]!.referenceCode = 5)],
    ];
    for (const [label, mutate] of cases) expect(GigTemplateSnapshotSchema.safeParse(withTemplate(mutate)).success, label).toBe(false);
  });

  it('a text-free snapshot: the content KEYS are in it, a name or a label text is not part of the schema', () => {
    const parsed = GigTemplateSnapshotSchema.parse({ templates: [{ ...SAMPLE_TEMPLATE, name: 'Full Detail', description: 'text' }] });
    expect(parsed.templates[0]).not.toHaveProperty('name');
    expect(parsed.templates[0]).not.toHaveProperty('description');
    expect(keys(parsed.templates[0]!)).toEqual(PUBLIC_TEMPLATE_KEYS);
  });
});

// ====================================================================== public reads over a cache
describe('public reads: the market gate comes first, then the cache; the database is only the fallback', () => {
  const ENTRY = 'bg:test:cat:v1:gt:market:la-oc:0';
  const second = {
    ...SAMPLE_TEMPLATE,
    gigTemplateId: '22222222-2222-4222-8222-222222222222',
    code: 'standard_clean',
    serviceTypeCode: 'regular_cleaning',
    categoryCode: 'home_cleaning',
    displayOrder: 20,
  };
  const snapshot = { templates: [SAMPLE_TEMPLATE, second] };
  const seeded = (value: unknown = snapshot) => {
    const cache = new Spy();
    cache.data.set(ENTRY, JSON.stringify({ v: value }));
    return { cache, ...build({ cache, markets: { 'la-oc': LAOC } }) };
  };

  it('serves a cached snapshot without a single statement, in the stored order, marked source cache; the cache key is gt:market:<code> under the catalogue generation', async () => {
    const { service, touched, cache } = seeded();
    const r = await service.getMarketGigTemplates('la-oc');
    expect(r.source).toBe('cache');
    expect(r.market).toEqual(LAOC);
    expect(r.templates.map((t) => t.code)).toEqual(['full_detail', 'standard_clean']);
    expect(touched).toEqual([]);
    expect(cache.gets).toEqual(['bg:test:cat:gen', ENTRY]);
  });

  it('the catalogue snapshot of the same market is a different entry: it is never served as the Gig Templates', async () => {
    const cache = new Spy();
    cache.data.set('bg:test:cat:v1:market:la-oc:0', JSON.stringify({ v: snapshot }));
    const b = build({ cache, markets: { 'la-oc': LAOC } });
    expect(((await fail(b.service.getMarketGigTemplates('la-oc'))) as Error).message).toBe(SENTINEL);
  });

  it('the market gate is asked exactly once per read, for every read', async () => {
    const { service, asked } = seeded();
    await service.getMarketGigTemplates('la-oc');
    await service.listGigTemplatesForMarket('la-oc');
    await service.listGigTemplatesForMarket('la-oc', { serviceTypeCode: 'car_detailing' });
    await service.getGigTemplateForMarket('la-oc', 'full_detail');
    expect(asked).toEqual(['la-oc', 'la-oc', 'la-oc', 'la-oc']);
  });

  it('a market that is not public is MARKET_NOT_FOUND for every read, and neither the cache nor the database is ever asked', async () => {
    const cache = new Spy();
    const b = build({ cache, markets: { 'la-oc': LAOC } });
    const calls: [string, () => Promise<unknown>][] = [
      ['getMarketGigTemplates', () => b.service.getMarketGigTemplates('planned-market')],
      ['listGigTemplatesForMarket', () => b.service.listGigTemplatesForMarket('planned-market')],
      ['getGigTemplateForMarket', () => b.service.getGigTemplateForMarket('planned-market', 'full_detail')],
    ];
    for (const [name, call] of calls) {
      const e = asCatalog(await fail(call()));
      expect(e.code, name).toBe('MARKET_NOT_FOUND');
      expect(e.message, name).toBe('the market is not available');
      expect(e.details, name).toEqual({ code: 'planned-market' });
    }
    expect(cache.gets).toEqual([]);
    expect(cache.sets).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  it('a malformed market code is MARKET_NOT_FOUND without even asking the gate, and an echoed code is cut at 64 characters', async () => {
    const b = build({ cache: new Spy(), markets: { 'la-oc': LAOC } });
    for (const bad of ['LA-OC', 'la_oc', '', ' la-oc', 'la-oc ', '-la', 'la-', 'la--oc', '../x', "x'--", 'a'.repeat(61), null, undefined, 5, {}]) {
      const e = asCatalog(await fail(b.service.getMarketGigTemplates(bad as string)));
      expect(e.code, String(bad)).toBe('MARKET_NOT_FOUND');
      expect(String(e.details.code).length).toBeLessThanOrEqual(64);
    }
    expect((asCatalog(await fail(b.service.getMarketGigTemplates('x'.repeat(5000)))).details.code as string).length).toBe(64);
    expect(b.asked).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  it('a gate that fails fails the read (an outage of the registry is not an empty list)', async () => {
    const boom = new CatalogError('UNAVAILABLE', 'the market registry is unavailable');
    const service = new GigTemplateService({
      database: untouchable().database,
      markets: { publicMarket: () => Promise.reject(boom) },
      env: 'test',
      cache: new Spy(),
    });
    expect(await fail(service.getMarketGigTemplates('la-oc'))).toBe(boom);
  });

  it('list filters by service type over the one cached snapshot; an unknown or malformed filter lists nothing; the single read finds a template or fails with a typed, cut error', async () => {
    const { service, touched } = seeded();
    expect((await service.listGigTemplatesForMarket('la-oc', { serviceTypeCode: 'car_detailing' })).templates.map((t) => t.code)).toEqual(['full_detail']);
    expect((await service.listGigTemplatesForMarket('la-oc', { serviceTypeCode: 'regular_cleaning' })).templates.map((t) => t.code)).toEqual([
      'standard_clean',
    ]);
    for (const unknown of ['no_such', '', 'Car_Detailing', 'x'.repeat(500)])
      expect((await service.listGigTemplatesForMarket('la-oc', { serviceTypeCode: unknown })).templates).toEqual([]);
    expect((await service.listGigTemplatesForMarket('la-oc', {})).templates).toHaveLength(2);
    expect((await service.getGigTemplateForMarket('la-oc', 'standard_clean')).template).toMatchObject({ code: 'standard_clean', displayOrder: 20 });
    const e = asCatalog(await fail(service.getGigTemplateForMarket('la-oc', 'x'.repeat(500))));
    expect(e.code).toBe('GIG_TEMPLATE_NOT_FOUND');
    expect(e.message).toBe('the Gig Template is not available');
    expect((e.details.code as string).length).toBe(64);
    // a service type or a category code is not a template
    expect(asCatalog(await fail(service.getGigTemplateForMarket('la-oc', 'car_detailing'))).code).toBe('GIG_TEMPLATE_NOT_FOUND');
    expect(touched).toEqual([]);
  });

  it('an invalid snapshot is a miss: the database is consulted (the sentinel proves it) and the bad entry is not served', async () => {
    const mutate = (f: (t: Record<string, unknown>) => void) => {
      const s = clone(snapshot) as { templates: Record<string, unknown>[] };
      f(s.templates[0]!);
      return s;
    };
    for (const bad of [
      {},
      null,
      'x',
      { templates: 'x' },
      { templates: [{ code: 'x' }] },
      mutate((t) => (t.displayOrder = 1.5)),
      mutate((t) => delete t.activeVersion),
      mutate((t) => ((t.activeVersion as Record<string, unknown>).pricingModels = ['FREE'])),
      mutate((t) => ((t.activeVersion as { fields: Record<string, unknown>[] }).fields[0]!.fieldType = 'JSON')),
    ]) {
      const { service, touched } = seeded(bad);
      const e = await fail(service.getMarketGigTemplates('la-oc'));
      expect((e as Error).message, JSON.stringify(bad)).toBe(SENTINEL);
      expect(touched.length).toBeGreaterThan(0);
    }
  });

  it('an empty snapshot is a valid snapshot (a market with nothing offered is cached, not reloaded)', async () => {
    const { service, touched } = seeded({ templates: [] });
    const r = await service.getMarketGigTemplates('la-oc');
    expect(r.source).toBe('cache');
    expect(r.templates).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('an entry cached for one market is never served for another, and a bumped generation makes the cached snapshot unreachable', async () => {
    const cache = new Spy();
    cache.data.set(ENTRY, JSON.stringify({ v: snapshot }));
    const b = build({ cache, markets: { 'la-oc': LAOC, sf: { code: 'sf', defaultLocale: 'en-US' } } });
    expect(((await fail(b.service.getMarketGigTemplates('sf'))) as Error).message).toBe(SENTINEL);
    expect((await b.service.getMarketGigTemplates('la-oc')).source).toBe('cache');
    await cache.incr('bg:test:cat:gen');
    expect(((await fail(b.service.getMarketGigTemplates('la-oc'))) as Error).message).toBe(SENTINEL);
  });

  it('the public views carry exactly the public key set when the cached snapshot is well formed', async () => {
    const { service } = seeded();
    const t = (await service.getMarketGigTemplates('la-oc')).templates[0]!;
    expect(keys(t)).toEqual(PUBLIC_TEMPLATE_KEYS);
    expect(keys(t.activeVersion!)).toEqual([...PUBLIC_VERSION_KEYS, 'fields', 'requirements'].sort());
  });

  // The catalogue views are built field by field; the Gig Template snapshot is rebuilt into its public shape on every cache read, so a poisoned entry cannot add a management field.
  it('a poisoned snapshot cannot add management-only fields (status, enabled, revision, timestamps, every version) to a public view', async () => {
    const poisoned = {
      templates: [
        {
          ...SAMPLE_TEMPLATE,
          status: 'DRAFT',
          enabled: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          versions: [{ ...SAMPLE_VERSION, fields: undefined, requirements: undefined }],
          activeVersion: {
            ...SAMPLE_VERSION,
            status: 'DRAFT',
            revision: 9,
            publishedAt: '2026-01-01T00:00:00.000Z',
            closedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    };
    const { service } = seeded(poisoned);
    const t = (await service.getMarketGigTemplates('la-oc')).templates[0]!;
    expect(keys(t)).toEqual(PUBLIC_TEMPLATE_KEYS);
    expect(keys(t.activeVersion!)).toEqual([...PUBLIC_VERSION_KEYS, 'fields', 'requirements'].sort());
  });
});

describe('management reads validate their input before the database is touched', () => {
  it('a version read with a bad number never reaches the database; a valid one does', async () => {
    const b = build();
    expect(asCatalog(await fail(b.service.getGigTemplateVersion('full_detail', 0))).code).toBe('GIG_TEMPLATE_VERSION_NOT_FOUND');
    expect(b.touched).toEqual([]);
    expect(((await fail(b.service.getGigTemplateVersion('full_detail', 1))) as Error).message).toBe(SENTINEL);
  });

  it('the exact-version read by id (CAT-003) rejects a malformed id before the database is touched; a well-formed one reaches it', async () => {
    const b = build();
    for (const bad of ['', 'x', "1' OR '1'='1", '00000000-0000-4000-8000-00000000000g', undefined, 7, null])
      expect(asCatalog(await fail(b.service.getGigTemplateVersionById(bad as unknown as string))).code).toBe('GIG_TEMPLATE_VERSION_NOT_FOUND');
    expect(b.touched).toEqual([]);
    expect(((await fail(b.service.getGigTemplateVersionById('00000000-0000-4000-8000-000000000000'))) as Error).message).toBe(SENTINEL);
  });

  it('the market-availability read of a Gig Template (CAT-003) answers false, without a statement, for a malformed market code or template id', async () => {
    const b = build();
    expect(await b.service.isGigTemplateEnabledInMarket('NOT A MARKET', '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(await b.service.isGigTemplateEnabledInMarket('la-oc', 'not-a-uuid')).toBe(false);
    expect(b.touched).toEqual([]);
  });

  it('every database failure that is a connectivity problem on a read is UNAVAILABLE with fixed text and the driver text only in the log', async () => {
    const dead = { transaction: () => Promise.reject(Object.assign(new Error('LEAK connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) };
    const database = {
      ...dead,
      get db() {
        return {};
      },
    } as unknown as Database;
    const service = new GigTemplateService({ database, markets: gate().gate, env: 'test', allowTestKeys: true });
    const e = asCatalog(await fail(service.createGigTemplate({ code: 'window_tint', serviceTypeCode: 'car_detailing', reason: GOOD }, 'admin')));
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe('the catalogue database is unavailable');
    expect(surface(e)).not.toContain('LEAK');
    expect(logSink.lines).toHaveLength(1);
  });
});
