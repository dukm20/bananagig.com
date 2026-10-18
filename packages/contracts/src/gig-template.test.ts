// Unit tests of the Gig Template contracts (CAT-002), written by an independent author: the key grammar (the SAME corpus the migration CHECKs must accept), the version status machine
// (all 16 pairs, equal to the SQL function), every derived content key (equal to the generated columns and the seed of migration 0016), the per-type rules of a field for EVERY field type
// (what each type allows, forbids and requires), every strict request, the read models (nothing provider-specific), the events and the vocabularies shared with the migration.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogCode, CATALOG_ERROR_CODES, SetMarketAvailabilityRequest } from './catalog';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN } from './index';
import {
  AREA_MODES,
  AreaMode,
  FIELD_KEY_MAX,
  FIELD_KEY_MIN,
  FIXED_CAPABLE_FIELD_TYPES,
  FieldKey,
  GIG_TEMPLATE_EVENTS,
  GIG_TEMPLATE_FIELD_BEHAVIORS,
  GIG_TEMPLATE_FIELD_TYPES,
  GIG_TEMPLATE_MAX_FIELDS,
  GIG_TEMPLATE_MAX_REQUIREMENTS,
  GIG_TEMPLATE_REQUIREMENT_TYPES,
  GIG_TEMPLATE_SECTIONS,
  GIG_TEMPLATE_VERSION_STATUSES,
  GigTemplateAvailabilityEventPayload,
  GigTemplateCode,
  GigTemplateDetailDto,
  GigTemplateDurationDto,
  GigTemplateDurationInput,
  GigTemplateEventPayload,
  GigTemplateFieldDto,
  GigTemplateFieldInput,
  GigTemplateListItemDto,
  GigTemplateListQuery,
  GigTemplateListResponse,
  GigTemplateMarketAvailabilityDto,
  GigTemplateMarketAvailabilityResponse,
  GigTemplateOptionDto,
  GigTemplateOptionInput,
  GigTemplatePublishedPayload,
  GigTemplateRequirementDto,
  GigTemplateRequirementInput,
  GigTemplateResponse,
  GigTemplateVersionDto,
  GigTemplateVersionNumber,
  GigTemplateVersionResponse,
  GigTemplateVersionRetireRequest,
  GigTemplateVersionStatus,
  GigTemplateVersionSummaryDto,
  OptionCode,
  PRICING_MODELS,
  CreateGigTemplateRequest,
  CreateGigTemplateVersionRequest,
  PublishGigTemplateVersionRequest,
  GIG_TEMPLATE_MAX_OPTIONS,
  ReplaceGigTemplateDraftRequest,
  SetMarketGigTemplateAvailabilityRequest,
  UpdateGigTemplateRequest,
  fieldIssues,
  gigTemplateDescriptionKey,
  gigTemplateFieldDefaultKey,
  gigTemplateFieldHelpKey,
  gigTemplateFieldLabelKey,
  gigTemplateInstructionsKey,
  gigTemplateNameKey,
  gigTemplateOptionLabelKey,
  isGigTemplateVersionTransitionAllowed,
  type GigTemplateFieldType,
  type GigTemplateVersionStatus as VersionStatus,
} from './gig-template';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0016_gig_templates.sql', import.meta.url)), 'utf8');
/** CAT-004 adds the ADD_ONS permission column to the version row. */
const addOnsMigration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0021_gig_variants_addons_media.sql', import.meta.url)), 'utf8');

// ---------------------------------------------------------------- helpers (zod shape walker, same technique as catalog.test.ts)
type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; element?: unknown };
const defOf = (schema: unknown): Def => (schema as { def: Def }).def;
function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  if ((def.type === 'nullable' || def.type === 'optional' || def.type === 'default') && def.innerType) return unwrap(def.innerType);
  return schema;
}
function walkKeys(schema: unknown, prefix = ''): string[] {
  const def = defOf(unwrap(schema));
  if (def.type === 'object' && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...walkKeys(child, path)];
    });
  }
  if (def.type === 'array' && def.element) return walkKeys(def.element, `${prefix}[]`);
  return [];
}
const shapeKeys = (schema: unknown): string[] => Object.keys(defOf(schema).shape ?? {}).sort();
const ok = (schema: z.ZodType, v: unknown): boolean => schema.safeParse(v).success;
const without = (o: object, k: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...o };
  delete copy[k];
  return copy;
};
/** The path of the first issue of a failed parse, '' for the root. */
const issuePaths = (schema: z.ZodType, v: unknown): string[] => {
  const r = schema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};
const ch = (...codes: number[]): string => String.fromCharCode(...codes);

const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const ISO = '2026-10-16T12:00:00.000Z';
const REASON = 'a documented reason';

// ====================================================================== the key grammar
describe('FieldKey / OptionCode: lower-case snake_case, 2..32 characters (one corpus for the contract AND the migration CHECKs)', () => {
  const GOOD = ['ab', 'a1', 'price_basis', 'a_b_c', 'item_2', 'deep_3d_clean', 'x'.repeat(32), `${'ab_'.repeat(10)}abc`.slice(0, 32).replace(/_$/, 'c')];
  const BAD: [string, unknown][] = [
    ['empty', ''],
    ['one character', 'a'],
    ['33 characters', 'x'.repeat(33)],
    ['upper case', 'Ab_c'],
    ['hyphen', 'ab-cd'],
    ['leading digit', '1ab'],
    ['leading underscore', '_ab'],
    ['trailing underscore', 'ab_'],
    ['double underscore', 'ab__cd'],
    ['space', 'ab cd'],
    ['trailing space', 'ab '],
    ['trailing newline', 'abc\n'],
    ['dot', 'ab.cd'],
    ['slash', 'ab/cd'],
    ['e acute', `caf${ch(0xe9)}`],
    ['cyrillic a', `${ch(0x430)}bc`],
    ['zero-width space', `ab${ch(0x200b)}cd`],
    ['emoji', `ab${ch(0xd83c, 0xdf4c)}`],
    ['__proto__', '__proto__'],
    ['number', 12],
    ['null', null],
    ['undefined', undefined],
    ['array', ['ab']],
  ];
  it.each(GOOD)('accepts %s', (v) => {
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(FieldKey.safeParse(v).success, v).toBe(true);
    expect(OptionCode.safeParse(v).success, v).toBe(true);
  });
  it.each(BAD)('refuses %s', (_n, v) => {
    expect(FieldKey.safeParse(v).success).toBe(false);
    expect(OptionCode.safeParse(v).success).toBe(false);
  });
  it('the bounds are exactly 2 and 32 and an option code is the same schema as a field key', () => {
    expect([FIELD_KEY_MIN, FIELD_KEY_MAX]).toEqual([2, 32]);
    expect(OptionCode).toBe(FieldKey);
  });
  it('the template code is the catalogue code (2..48)', () => {
    expect(GigTemplateCode).toBe(CatalogCode);
    expect(ok(GigTemplateCode, 'a'.repeat(48))).toBe(true);
    expect(ok(GigTemplateCode, 'a'.repeat(49))).toBe(false);
  });
  it('is the SAME grammar as the migration CHECKs of the field key, the option code and the template code (regex text and bounds)', () => {
    const sqlRegex = (constraint: string, column: string): [string, number, number] => {
      const m = new RegExp(`CONSTRAINT ${constraint} CHECK \\(${column} ~ '([^']+)' AND length\\(${column}\\) BETWEEN (\\d+) AND (\\d+)\\)`).exec(migration);
      expect(m, constraint).not.toBeNull();
      return [m![1]!, Number(m![2]), Number(m![3])];
    };
    const norm = (s: string) => s.replace(/\(\?:/g, '(');
    const field = sqlRegex('ck_gig_template_fields__key', 'field_key');
    const option = sqlRegex('ck_gig_template_field_options__code', 'option_code');
    const template = sqlRegex('ck_gig_templates__code', 'code');
    const fieldSource = norm(z.toJSONSchema(FieldKey).pattern as string);
    expect(norm(field[0])).toBe(fieldSource);
    expect(norm(option[0])).toBe(fieldSource);
    expect([field[1], field[2]]).toEqual([FIELD_KEY_MIN, FIELD_KEY_MAX]);
    expect([option[1], option[2]]).toEqual([FIELD_KEY_MIN, FIELD_KEY_MAX]);
    expect(norm(template[0])).toBe(norm(z.toJSONSchema(GigTemplateCode).pattern as string));
    expect([template[1], template[2]]).toEqual([2, 48]);
  });
});

describe('vocabularies equal the migration CHECK lists', () => {
  const listOf = (constraint: string): string[] => {
    const m = new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(migration);
    expect(m, constraint).not.toBeNull();
    return [...m![1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!);
  };
  it('field types, sections, behaviours, requirement types and version statuses', () => {
    expect([...GIG_TEMPLATE_FIELD_TYPES]).toEqual(listOf('ck_gig_template_fields__type'));
    expect([...GIG_TEMPLATE_SECTIONS]).toEqual(listOf('ck_gig_template_fields__section'));
    expect([...GIG_TEMPLATE_FIELD_BEHAVIORS]).toEqual(listOf('ck_gig_template_fields__behavior'));
    expect([...GIG_TEMPLATE_REQUIREMENT_TYPES]).toEqual(listOf('ck_gig_template_requirements__type'));
    expect([...GIG_TEMPLATE_VERSION_STATUSES]).toEqual(listOf('ck_gig_template_versions__status'));
  });
  it('the types that can be fixed equal the fixed CHECK of the migration', () => {
    const m = /ck_gig_template_fields__fixed CHECK \([\s\S]*?field_type IN \(([^)]*)\)/.exec(migration);
    expect([...m![1]!.matchAll(/'(\w+)'/g)].map((x) => x[1])).toEqual([...FIXED_CAPABLE_FIELD_TYPES]);
    // MONEY, MEDIA and the references are the provider's, always
    for (const t of ['MONEY', 'MEDIA', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE'])
      expect((FIXED_CAPABLE_FIELD_TYPES as readonly string[]).includes(t), t).toBe(false);
  });
  it('the pricing models and area modes are the flag columns of the version row', () => {
    expect([...PRICING_MODELS]).toEqual(['FIXED', 'FIXED_WITH_VARIANTS', 'BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE', 'ADD_ONS']);
    expect([...AREA_MODES]).toEqual(['RADIUS', 'POSTAL_CODES', 'POLYGON']);
    for (const c of [
      'pricing_fixed',
      'pricing_fixed_with_variants',
      'pricing_bundle_eligible',
      'pricing_drop_eligible',
      'area_radius',
      'area_postal_codes',
      'area_polygon',
    ])
      expect(migration, c).toMatch(new RegExp(`\\n  ${c}\\s+boolean`));
  });
  it('ADD_ONS is the pricing_add_ons column added by CAT-004 (boolean, default false: existing versions do not carry the permission)', () => {
    expect(addOnsMigration).toMatch(/ALTER TABLE catalog\.gig_template_versions\s+ADD COLUMN pricing_add_ons\s+boolean\s+NOT NULL\s+DEFAULT false/i);
  });
  it('the audit actions of the migration are the ones the service writes', () => {
    for (const a of [
      'GIG_TEMPLATE_CREATED',
      'GIG_TEMPLATE_UPDATED',
      'GIG_TEMPLATE_STATUS_CHANGED',
      'GIG_TEMPLATE_VERSION_CREATED',
      'GIG_TEMPLATE_VERSION_CHANGED',
      'GIG_TEMPLATE_VERSION_PUBLISHED',
      'GIG_TEMPLATE_VERSION_RETIRED',
      'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED',
    ])
      expect(migration, a).toContain(`'${a}'`);
  });
});

// ====================================================================== the version status machine
describe('version status machine (all 16 pairs, equal to catalog.assert_version_transition)', () => {
  const ALLOWED = new Set(['DRAFT>ACTIVE', 'DRAFT>RETIRED', 'ACTIVE>SUPERSEDED', 'ACTIVE>RETIRED']);
  const all = [...GIG_TEMPLATE_VERSION_STATUSES];
  it('has the four statuses in lifecycle order', () => {
    expect(all).toEqual(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED']);
    expect(GigTemplateVersionStatus.options).toEqual(all);
  });
  it.each(all.flatMap((from) => all.map((to) => [from, to] as [VersionStatus, VersionStatus])))('%s -> %s', (from, to) => {
    expect(isGigTemplateVersionTransitionAllowed(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
  });
  it('no status moves to itself, nothing moves back to DRAFT, SUPERSEDED and RETIRED are terminal', () => {
    for (const s of all) expect(isGigTemplateVersionTransitionAllowed(s, s), s).toBe(false);
    for (const s of all) expect(isGigTemplateVersionTransitionAllowed(s, 'DRAFT'), s).toBe(false);
    for (const t of all) {
      expect(isGigTemplateVersionTransitionAllowed('SUPERSEDED', t)).toBe(false);
      expect(isGigTemplateVersionTransitionAllowed('RETIRED', t)).toBe(false);
    }
  });
  it('mentions exactly the same pairs as the SQL function', () => {
    const fn = /CREATE FUNCTION catalog\.assert_version_transition[\s\S]*?\$\$;/.exec(migration)![0];
    expect(fn).toContain("(p_old = 'DRAFT' AND p_new IN ('ACTIVE', 'RETIRED'))");
    expect(fn).toContain("(p_old = 'ACTIVE' AND p_new IN ('SUPERSEDED', 'RETIRED'))");
    expect(fn).toContain("IF p_new = 'DRAFT' THEN");
  });
  it('the only request target of a version is RETIRED', () => {
    expect(GigTemplateVersionRetireRequest.parse({ status: 'RETIRED', reason: REASON })).toEqual({ status: 'RETIRED', reason: REASON });
    for (const status of ['ACTIVE', 'DRAFT', 'SUPERSEDED', 'INACTIVE', 'retired', 'Retired', '', null, 1, ['RETIRED'], undefined])
      expect(ok(GigTemplateVersionRetireRequest, { status, reason: REASON }), String(status)).toBe(false);
    expect(ok(GigTemplateVersionRetireRequest, { reason: REASON })).toBe(false);
    expect(ok(GigTemplateVersionRetireRequest, { status: 'RETIRED' })).toBe(false);
    expect(ok(GigTemplateVersionRetireRequest, { status: 'RETIRED', reason: REASON, extra: 1 })).toBe(false);
  });
});

// ====================================================================== content keys
describe('derived content keys', () => {
  it('have the exact shape', () => {
    expect(gigTemplateNameKey('full_detail')).toBe('catalog.gig_template.full_detail.name');
    expect(gigTemplateDescriptionKey('full_detail')).toBe('catalog.gig_template.full_detail.description');
    expect(gigTemplateInstructionsKey('full_detail')).toBe('catalog.gig_template.full_detail.instructions');
    expect(gigTemplateFieldLabelKey('full_detail', 'wax_type')).toBe('catalog.gig_template.full_detail.field.wax_type.label');
    expect(gigTemplateFieldHelpKey('full_detail', 'wax_type')).toBe('catalog.gig_template.full_detail.field.wax_type.help');
    expect(gigTemplateFieldDefaultKey('full_detail', 'wax_type')).toBe('catalog.gig_template.full_detail.field.wax_type.default');
    expect(gigTemplateOptionLabelKey('full_detail', 'wax_type', 'carnauba')).toBe('catalog.gig_template.full_detail.field.wax_type.option.carnauba.label');
  });
  it('equal the generated column, the CHECK expressions and the derivation of the field and option guards in the migration', () => {
    expect(migration).toContain("name_content_key         text        GENERATED ALWAYS AS ('catalog.gig_template.' || code || '.name') STORED NOT NULL");
    expect(gigTemplateNameKey('<code>')).toBe('catalog.gig_template.<code>.name');
    expect(migration).toContain("description_content_key = 'catalog.gig_template.' || code || '.description'");
    expect(gigTemplateDescriptionKey('<code>')).toBe('catalog.gig_template.<code>.description');
    expect(migration).toContain("instructions_content_key = 'catalog.gig_template.' || code || '.instructions'");
    expect(gigTemplateInstructionsKey('<code>')).toBe('catalog.gig_template.<code>.instructions');
    expect(migration).toContain("stem := 'catalog.gig_template.' || t_code || '.field.' || NEW.field_key;");
    expect(migration).toContain("NEW.label_content_key <> stem || '.label'");
    expect(migration).toContain("COALESCE(NEW.help_content_key, stem || '.help') <> stem || '.help'");
    expect(migration).toContain("COALESCE(NEW.default_content_key, stem || '.default') <> stem || '.default'");
    expect(gigTemplateFieldLabelKey('<code>', '<f>')).toBe('catalog.gig_template.<code>.field.<f>.label');
    expect(gigTemplateFieldHelpKey('<code>', '<f>')).toBe('catalog.gig_template.<code>.field.<f>.help');
    expect(gigTemplateFieldDefaultKey('<code>', '<f>')).toBe('catalog.gig_template.<code>.field.<f>.default');
    expect(migration).toContain("'catalog.gig_template.' || t_code || '.field.' || f_key || '.option.' || NEW.option_code || '.label'");
    expect(gigTemplateOptionLabelKey('<code>', '<f>', '<o>')).toBe('catalog.gig_template.<code>.field.<f>.option.<o>.label');
  });
  it('produce exactly the six content keys the migration seeds for the two seeded templates', () => {
    const seeded = [...migration.matchAll(/\(\d+,\s+'(?:UI_LABEL|PLAIN_TEXT)',\s+'(catalog\.gig_template\.[a-z_.]+)'/g)].map((m) => m[1]!);
    expect(seeded).toHaveLength(6);
    const derived = ['full_detail', 'standard_clean'].flatMap((c) => [gigTemplateNameKey(c), gigTemplateDescriptionKey(c), gigTemplateInstructionsKey(c)]);
    expect([...derived].sort()).toEqual([...seeded].sort());
  });
  it('the longest key (longest code, field key and option code) is 154 characters: within the 160 of the registry and a valid content key', () => {
    const code = 'a'.repeat(48);
    const field = 'b'.repeat(32);
    const option = 'c'.repeat(32);
    const keys = [
      gigTemplateNameKey(code),
      gigTemplateDescriptionKey(code),
      gigTemplateInstructionsKey(code),
      gigTemplateFieldLabelKey(code, field),
      gigTemplateFieldHelpKey(code, field),
      gigTemplateFieldDefaultKey(code, field),
      gigTemplateOptionLabelKey(code, field, option),
    ];
    const longest = Math.max(...keys.map((k) => k.length));
    expect(gigTemplateOptionLabelKey(code, field, option).length).toBe(longest);
    expect(longest).toBe(154);
    expect(longest).toBeLessThanOrEqual(160);
    for (const k of keys) expect(ContentKey.safeParse(k).success, k).toBe(true);
    // the same with digits and underscores in every position that allows them
    const code2 = `a${'1_'.repeat(23)}z`;
    expect(GigTemplateCode.safeParse(code2).success).toBe(true);
    expect(ContentKey.safeParse(gigTemplateOptionLabelKey(code2, 'd1_e2_f3', 'g_9')).success).toBe(true);
  });
  it('every key is one more segment than its stem: no two different (code, field, option) triples ever derive the same key', () => {
    const codes = ['ab', 'name', 'field', 'option', 'a_name', 'field_x'];
    const fields = ['ab', 'label', 'help', 'default', 'option', 'name', 'x_label'];
    const options = ['ab', 'label', 'x_y'];
    const seen = new Map<string, string>();
    const add = (k: string, who: string) => {
      expect(seen.get(k), `${k} for ${who} collides with ${seen.get(k)}`).toBeUndefined();
      seen.set(k, who);
      expect(ContentKey.safeParse(k).success, k).toBe(true);
    };
    for (const c of codes) {
      add(gigTemplateNameKey(c), `${c}/name`);
      add(gigTemplateDescriptionKey(c), `${c}/description`);
      add(gigTemplateInstructionsKey(c), `${c}/instructions`);
      for (const f of fields) {
        add(gigTemplateFieldLabelKey(c, f), `${c}/${f}/label`);
        add(gigTemplateFieldHelpKey(c, f), `${c}/${f}/help`);
        add(gigTemplateFieldDefaultKey(c, f), `${c}/${f}/default`);
        for (const o of options) add(gigTemplateOptionLabelKey(c, f, o), `${c}/${f}/${o}/option`);
      }
    }
  });
});

// ====================================================================== field definitions: every type
type Meta =
  'minLength' | 'maxLength' | 'withDefaultText' | 'minNumber' | 'maxNumber' | 'defaultNumber' | 'defaultBoolean' | 'minItems' | 'maxItems' | 'options';
/** a VALID sample of each metadata property (valid for every type that allows it, with PROVIDER_CONFIGURABLE) */
const SAMPLE: Record<Meta, unknown> = {
  minLength: 1,
  maxLength: 10,
  withDefaultText: true,
  minNumber: 1,
  maxNumber: 5,
  defaultNumber: 2,
  defaultBoolean: true,
  minItems: 1,
  maxItems: 3,
  options: [{ optionCode: 'opt_a' }],
};
/** the path the schema attaches to the first metadata property that does not belong */
const GROUP_PATH: Record<Meta, string> = {
  minLength: 'minLength',
  maxLength: 'minLength',
  withDefaultText: 'withDefaultText',
  minNumber: 'minNumber',
  maxNumber: 'minNumber',
  defaultNumber: 'minNumber',
  defaultBoolean: 'defaultBoolean',
  minItems: 'minItems',
  maxItems: 'minItems',
  options: 'options',
};
const ALLOWED: Record<GigTemplateFieldType, Meta[]> = {
  TEXT: ['minLength', 'maxLength', 'withDefaultText'],
  LONG_TEXT: ['minLength', 'maxLength', 'withDefaultText'],
  INTEGER: ['minNumber', 'maxNumber', 'defaultNumber'],
  DECIMAL: ['minNumber', 'maxNumber', 'defaultNumber'],
  BOOLEAN: ['defaultBoolean'],
  ENUM: ['options'],
  DURATION: ['minNumber', 'maxNumber', 'defaultNumber'],
  MONEY: [],
  MEDIA: ['minItems', 'maxItems'],
  EQUIPMENT_REFERENCE: ['minItems', 'maxItems'],
  SKILL_REFERENCE: ['minItems', 'maxItems'],
};
const field = (fieldType: string, over: Record<string, unknown> = {}) => ({ fieldKey: 'field_one', fieldType, behavior: 'PROVIDER_CONFIGURABLE', ...over });
const parsed = (fieldType: string, over: Record<string, unknown> = {}) => GigTemplateFieldInput.safeParse(field(fieldType, over));
const good = (fieldType: string, over: Record<string, unknown> = {}) => {
  const r = parsed(fieldType, over);
  expect(r.success, `${fieldType} ${JSON.stringify(over)} ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
};
const bad = (fieldType: string, over: Record<string, unknown>, path?: string) => {
  const r = parsed(fieldType, over);
  expect(r.success, `${fieldType} ${JSON.stringify(over)} should be refused`).toBe(false);
  if (path !== undefined && !r.success)
    expect(
      r.error.issues.map((i) => i.path.join('.')),
      `${fieldType} ${JSON.stringify(over)}`,
    ).toContain(path);
};

describe('GigTemplateFieldInput: strict shape and defaults', () => {
  it('applies the documented defaults: section DETAILS, customerVisible true, withHelp false, withDefaultText false, options []', () => {
    expect(GigTemplateFieldInput.parse(field('BOOLEAN'))).toEqual({
      fieldKey: 'field_one',
      fieldType: 'BOOLEAN',
      behavior: 'PROVIDER_CONFIGURABLE',
      section: 'DETAILS',
      customerVisible: true,
      withHelp: false,
      withDefaultText: false,
      options: [],
    });
  });
  it('keeps an explicit section, visibility and help flag, and leaves the optional metadata undefined (never null)', () => {
    const p = GigTemplateFieldInput.parse(field('TEXT', { section: 'INCLUSIONS', customerVisible: false, withHelp: true }));
    expect(p).toMatchObject({ section: 'INCLUSIONS', customerVisible: false, withHelp: true, withDefaultText: false });
    for (const k of ['minLength', 'maxLength', 'minNumber', 'maxNumber', 'defaultNumber', 'defaultBoolean', 'minItems', 'maxItems'])
      expect(p, k).not.toHaveProperty(k);
  });
  it('accepts every section, every behaviour for a type that allows it, and every field type', () => {
    for (const section of GIG_TEMPLATE_SECTIONS) good('TEXT', { section });
    for (const t of GIG_TEMPLATE_FIELD_TYPES) good(t, t === 'MEDIA' ? { behavior: 'PROVIDER_CONFIGURABLE' } : {});
  });
  it('refuses unknown keys (including the provider-specific ones), missing required keys and invalid vocabulary', () => {
    for (const extra of [
      { price: 5 },
      { actor: 'x' },
      { displayOrder: 1 },
      { labelContentKey: 'x.y' },
      { status: 'ACTIVE' },
      { default: 'x' },
      { constructor: 1 },
    ])
      bad('TEXT', extra);
    for (const k of ['fieldKey', 'fieldType', 'behavior']) expect(ok(GigTemplateFieldInput, without(field('TEXT'), k)), k).toBe(false);
    bad('TEXT', { section: 'details' });
    bad('TEXT', { section: 'OTHER' });
    bad('TEXT', { section: null });
    bad('TEXT', { behavior: 'FIXED' });
    bad('TEXT', { behavior: 'platform_fixed' });
    bad('text', {});
    bad('NUMBER', {});
    bad('TEXT', { fieldKey: 'Bad' });
    bad('TEXT', { fieldKey: 'a' });
    for (const k of ['customerVisible', 'withHelp', 'withDefaultText']) for (const v of ['true', 1, 0, null, 'false']) bad('TEXT', { [k]: v });
  });
  it('coerces nothing: numeric strings and null metadata are refused', () => {
    bad('TEXT', { minLength: '5' });
    bad('TEXT', { minLength: null });
    bad('INTEGER', { minNumber: '5' });
    bad('INTEGER', { defaultNumber: null });
    bad('BOOLEAN', { defaultBoolean: 'true' });
    bad('BOOLEAN', { defaultBoolean: null });
    bad('MEDIA', { minItems: '1' });
    bad('MEDIA', { maxItems: null });
    bad('ENUM', { options: null });
    bad('ENUM', { options: 'opt_a' });
  });
  it('a non-object is refused', () => {
    for (const v of [null, undefined, 'TEXT', 5, [], [field('TEXT')]]) expect(ok(GigTemplateFieldInput, v)).toBe(false);
  });
});

describe('GigTemplateFieldInput: what each of the eleven types allows and forbids (metadata matrix)', () => {
  const METAS = Object.keys(SAMPLE) as Meta[];
  for (const t of GIG_TEMPLATE_FIELD_TYPES) {
    it(`${t}: allows exactly [${ALLOWED[t].join(', ') || 'nothing'}]`, () => {
      for (const m of METAS) {
        const over = { [m]: SAMPLE[m] };
        if (ALLOWED[t].includes(m)) good(t, over);
        else bad(t, over, GROUP_PATH[m]);
      }
      // everything the type allows, at once
      good(t, Object.fromEntries(ALLOWED[t].map((m) => [m, SAMPLE[m]])));
      // a forbidden property is still refused next to the allowed ones
      const forbidden = METAS.filter((m) => !ALLOWED[t].includes(m));
      for (const m of forbidden) bad(t, { ...Object.fromEntries(ALLOWED[t].map((a) => [a, SAMPLE[a]])), [m]: SAMPLE[m] }, GROUP_PATH[m]);
    });
  }
  it('a forbidden property is refused even with a "neutral" value (0, false, empty)', () => {
    bad('TEXT', { minNumber: 0 }, 'minNumber');
    bad('TEXT', { defaultBoolean: false }, 'defaultBoolean');
    bad('TEXT', { minItems: 0 }, 'minItems');
    bad('INTEGER', { minLength: 1 }, 'minLength');
    bad('INTEGER', { withDefaultText: true }, 'withDefaultText');
    bad('MONEY', { minNumber: 0 }, 'minNumber');
    bad('MONEY', { defaultNumber: 0 }, 'minNumber');
    bad('MONEY', { maxItems: 0 }, 'minItems');
    bad('BOOLEAN', { defaultNumber: 0 }, 'minNumber');
    bad('ENUM', { options: [{ optionCode: 'xx' }], minItems: 0 }, 'minItems');
    good('TEXT', { options: [] }); // an empty list is the default and is not "options"
  });
  it('fieldIssues reports exactly the offending property and a message, and nothing for a valid field', () => {
    const base = { section: 'DETAILS' as const, customerVisible: true, withHelp: false, withDefaultText: false, options: [] };
    const f = (over: Record<string, unknown>) => ({ ...base, ...field('TEXT'), ...over }) as never;
    expect(fieldIssues(f({}))).toEqual([]);
    const issues = fieldIssues(f({ minNumber: 1 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ path: 'minNumber', message: expect.stringContaining('INTEGER, DECIMAL and DURATION') });
    expect(fieldIssues(f({ fieldType: 'MONEY', behavior: 'PLATFORM_FIXED' })).map((i) => i.path)).toEqual(['behavior']);
    expect(fieldIssues(f({ fieldType: 'MONEY', behavior: 'PLATFORM_FIXED' }))[0]!.message).toContain("always the provider's");
    expect(fieldIssues(f({ fieldType: 'TEXT', behavior: 'PLATFORM_FIXED' }))[0]!.message).toContain('needs its default value');
    expect(fieldIssues(f({ fieldType: 'BOOLEAN', defaultBoolean: true, minLength: 3, minItems: 1 })).map((i) => i.path)).toEqual(['minLength', 'minItems']);
  });
});

describe('GigTemplateFieldInput: TEXT and LONG_TEXT', () => {
  for (const t of ['TEXT', 'LONG_TEXT']) {
    it(`${t}: length bounds are positive integers up to 100000 and ordered`, () => {
      good(t, { minLength: 1 });
      good(t, { maxLength: 100_000 });
      good(t, { minLength: 5, maxLength: 5 });
      good(t, { minLength: 1, maxLength: 100_000 });
      bad(t, { minLength: 0 });
      bad(t, { maxLength: 0 });
      bad(t, { minLength: -1 });
      bad(t, { maxLength: 100_001 });
      bad(t, { minLength: 1.5 });
      bad(t, { maxLength: 2.5 });
      bad(t, { minLength: Number.NaN });
      bad(t, { maxLength: Number.POSITIVE_INFINITY });
      bad(t, { minLength: 6, maxLength: 5 }, 'maxLength');
    });
    it(`${t}: PLATFORM_FIXED needs its default text and nothing else can stand in for it`, () => {
      bad(t, { behavior: 'PLATFORM_FIXED' }, 'behavior');
      bad(t, { behavior: 'PLATFORM_FIXED', minLength: 1, maxLength: 5 }, 'behavior');
      bad(t, { behavior: 'PLATFORM_FIXED', withDefaultText: false }, 'behavior');
      bad(t, { behavior: 'PLATFORM_FIXED', withHelp: true }, 'behavior');
      good(t, { behavior: 'PLATFORM_FIXED', withDefaultText: true });
      good(t, { behavior: 'PROVIDER_CONFIGURABLE', withDefaultText: true });
      good(t, { behavior: 'PROVIDER_REQUIRED' });
    });
  }
});

describe('GigTemplateFieldInput: INTEGER, DECIMAL and DURATION', () => {
  it('INTEGER: whole numbers only (each of min, max and default is checked on its own), negatives allowed', () => {
    good('INTEGER', { minNumber: -5, maxNumber: 5, defaultNumber: 0 });
    good('INTEGER', { minNumber: 3, maxNumber: 3, defaultNumber: 3 });
    for (const k of ['minNumber', 'maxNumber', 'defaultNumber']) {
      bad('INTEGER', { [k]: 1.5 }, k);
      bad('INTEGER', { [k]: 0.1 }, k);
      bad('INTEGER', { [k]: '1' });
      bad('INTEGER', { [k]: Number.NaN });
      bad('INTEGER', { [k]: Number.POSITIVE_INFINITY });
      bad('INTEGER', { [k]: 1_000_000_001 });
      bad('INTEGER', { [k]: -1_000_000_001 });
      good('INTEGER', { [k]: 1_000_000_000 });
      good('INTEGER', { [k]: -1_000_000_000 });
    }
  });
  it('DECIMAL: up to four decimal places, the default inside the bounds, bounds ordered', () => {
    good('DECIMAL', { minNumber: 0.5, maxNumber: 9.75, defaultNumber: 1.5 });
    good('DECIMAL', { minNumber: 0.0001 });
    good('DECIMAL', { defaultNumber: 0 });
    good('DECIMAL', { minNumber: -1.2345, maxNumber: 1.2345 });
    good('DECIMAL', { defaultNumber: 0.1 + 0.2 }); // binary noise is not "more decimals"
    // the tolerance follows the size of the scaled value: large four-decimal values are accepted whatever their binary noise, extra decimals never are
    for (let i = 0; i < 2000; i++) {
      const v = Math.round((i * 7919 * 104_729 + i) % 999_999_999_9999) / 10_000;
      good('DECIMAL', { maxNumber: v });
    }
    good('DECIMAL', { maxNumber: 12345678.1234 });
    good('DECIMAL', { maxNumber: 999999999.9999 });
    bad('DECIMAL', { maxNumber: 5e-11 });
    bad('DECIMAL', { maxNumber: 12345678.12345 });
    bad('DECIMAL', { maxNumber: 1_000_000_000.0001 });
    for (const k of ['minNumber', 'maxNumber', 'defaultNumber']) {
      bad('DECIMAL', { [k]: 0.00001 }, k);
      bad('DECIMAL', { [k]: 1.23456 }, k);
      bad('DECIMAL', { [k]: 2e12 });
    }
    bad('DECIMAL', { minNumber: 5, maxNumber: 4 }, 'maxNumber');
    good('DECIMAL', { minNumber: 4, maxNumber: 4 });
    bad('DECIMAL', { minNumber: 5, defaultNumber: 4.9999 }, 'defaultNumber');
    bad('DECIMAL', { maxNumber: 5, defaultNumber: 5.0001 }, 'defaultNumber');
    good('DECIMAL', { minNumber: 5, defaultNumber: 5 });
    good('DECIMAL', { maxNumber: 5, defaultNumber: 5 });
    bad('DECIMAL', { minNumber: 1, maxNumber: 3, defaultNumber: 0 }, 'defaultNumber');
    bad('DECIMAL', { minNumber: 1, maxNumber: 3, defaultNumber: 4 }, 'defaultNumber');
  });
  it('INTEGER: the default must lie within the bounds', () => {
    bad('INTEGER', { minNumber: 2, maxNumber: 8, defaultNumber: 1 }, 'defaultNumber');
    bad('INTEGER', { minNumber: 2, maxNumber: 8, defaultNumber: 9 }, 'defaultNumber');
    bad('INTEGER', { minNumber: 9, maxNumber: 8 }, 'maxNumber');
    good('INTEGER', { minNumber: 2, maxNumber: 8, defaultNumber: 2 });
    good('INTEGER', { minNumber: 2, maxNumber: 8, defaultNumber: 8 });
  });
  it('DURATION: whole minutes, at least 1 (each of min, max and default)', () => {
    good('DURATION', { minNumber: 1, maxNumber: 480, defaultNumber: 60 });
    for (const k of ['minNumber', 'maxNumber', 'defaultNumber']) {
      bad('DURATION', { [k]: 0 }, k);
      bad('DURATION', { [k]: -5 }, k);
      bad('DURATION', { [k]: 0.5 }, k);
      bad('DURATION', { [k]: 60.5 }, k);
      good('DURATION', { [k]: 1 });
    }
    bad('DURATION', { minNumber: 120, maxNumber: 60 }, 'maxNumber');
    bad('DURATION', { minNumber: 30, maxNumber: 60, defaultNumber: 20 }, 'defaultNumber');
    bad('DURATION', { minNumber: 30, maxNumber: 60, defaultNumber: 90 }, 'defaultNumber');
  });
  it('PLATFORM_FIXED needs a defaultNumber (zero counts as a value for INTEGER and DECIMAL, DURATION still needs >= 1)', () => {
    for (const t of ['INTEGER', 'DECIMAL', 'DURATION']) {
      bad(t, { behavior: 'PLATFORM_FIXED' }, 'behavior');
      bad(t, { behavior: 'PLATFORM_FIXED', minNumber: 1, maxNumber: 9 }, 'behavior');
      good(t, { behavior: 'PLATFORM_FIXED', defaultNumber: 5 });
    }
    good('INTEGER', { behavior: 'PLATFORM_FIXED', defaultNumber: 0 });
    good('DECIMAL', { behavior: 'PLATFORM_FIXED', defaultNumber: 0 });
    bad('DURATION', { behavior: 'PLATFORM_FIXED', defaultNumber: 0 }, 'defaultNumber');
    good('INTEGER', { behavior: 'PROVIDER_REQUIRED' });
  });
});

describe('GigTemplateFieldInput: BOOLEAN', () => {
  it('PLATFORM_FIXED needs a defaultBoolean (false is a value)', () => {
    bad('BOOLEAN', { behavior: 'PLATFORM_FIXED' }, 'behavior');
    good('BOOLEAN', { behavior: 'PLATFORM_FIXED', defaultBoolean: true });
    good('BOOLEAN', { behavior: 'PLATFORM_FIXED', defaultBoolean: false });
    good('BOOLEAN', { behavior: 'PROVIDER_CONFIGURABLE', defaultBoolean: false });
    good('BOOLEAN', { behavior: 'PROVIDER_REQUIRED' });
  });
});

describe('GigTemplateFieldInput: ENUM', () => {
  const opts = (...c: string[]) => c.map((optionCode) => ({ optionCode }));
  it('options are optional at definition time (publication requires them) but must be well formed', () => {
    good('ENUM', {});
    good('ENUM', { options: [] });
    good('ENUM', { options: opts('ab', 'cd', 'ef') });
    bad('ENUM', { options: [{ optionCode: 'Bad' }] });
    bad('ENUM', { options: [{ optionCode: 'a' }] });
    bad('ENUM', { options: [{}] });
    bad('ENUM', { options: [{ optionCode: 'ab', label: 'x' }] });
    bad('ENUM', { options: [{ optionCode: 'ab', isDefault: 'yes' }] });
    bad('ENUM', { options: [{ optionCode: 'ab', isDefault: 1 }] });
    bad('ENUM', { options: ['ab'] });
    bad('ENUM', { options: [null] });
  });
  it('an option defaults to isDefault false and its schema is strict', () => {
    expect(GigTemplateOptionInput.parse({ optionCode: 'ab' })).toEqual({ optionCode: 'ab', isDefault: false });
    expect(GigTemplateOptionInput.parse({ optionCode: 'ab', isDefault: true })).toEqual({ optionCode: 'ab', isDefault: true });
    expect(ok(GigTemplateOptionInput, { optionCode: 'ab', extra: 1 })).toBe(false);
    expect(ok(GigTemplateOptionInput, { isDefault: true })).toBe(false);
  });
  it('option codes are unique and at most one option is the default', () => {
    bad('ENUM', { options: opts('ab', 'cd', 'ab') }, 'options');
    bad(
      'ENUM',
      {
        options: [
          { optionCode: 'ab', isDefault: true },
          { optionCode: 'cd', isDefault: true },
        ],
      },
      'options',
    );
    good('ENUM', {
      options: [
        { optionCode: 'ab', isDefault: true },
        { optionCode: 'cd', isDefault: false },
      ],
    });
    good('ENUM', { options: [{ optionCode: 'ab' }, { optionCode: 'cd', isDefault: true }] });
  });
  it('holds at most 30 options', () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => ({ optionCode: `opt_${i}` }));
    good('ENUM', { options: n(30) });
    bad('ENUM', { options: n(31) });
  });
  it('PLATFORM_FIXED needs a DEFAULT OPTION (a defaultNumber or a default text cannot stand in for it)', () => {
    bad('ENUM', { behavior: 'PLATFORM_FIXED' }, 'behavior');
    bad('ENUM', { behavior: 'PLATFORM_FIXED', options: opts('ab', 'cd') }, 'behavior');
    bad('ENUM', { behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'ab', isDefault: false }] }, 'behavior');
    good('ENUM', { behavior: 'PLATFORM_FIXED', options: [{ optionCode: 'ab', isDefault: true }, { optionCode: 'cd' }] });
    good('ENUM', { behavior: 'PROVIDER_REQUIRED', options: opts('ab', 'cd') });
  });
});

describe('GigTemplateFieldInput: MONEY', () => {
  it("carries no metadata at all (amount limits are configuration) and is always the provider's", () => {
    good('MONEY', {});
    good('MONEY', { behavior: 'PROVIDER_REQUIRED' });
    good('MONEY', { withHelp: true, customerVisible: false, section: 'DETAILS' });
    bad('MONEY', { behavior: 'PLATFORM_FIXED' }, 'behavior');
    bad('MONEY', { behavior: 'PLATFORM_FIXED', defaultNumber: 100 });
    for (const m of Object.keys(SAMPLE) as Meta[]) bad('MONEY', { [m]: SAMPLE[m] });
  });
});

describe('GigTemplateFieldInput: MEDIA', () => {
  it('item counts are integers 0..1000 and ordered; maxItems 0 means "no photos allowed"', () => {
    good('MEDIA', {});
    good('MEDIA', { minItems: 0, maxItems: 0 });
    good('MEDIA', { maxItems: 0 });
    good('MEDIA', { minItems: 1, maxItems: 1 });
    good('MEDIA', { minItems: 0, maxItems: 1000 });
    bad('MEDIA', { maxItems: 1001 });
    bad('MEDIA', { minItems: -1 });
    bad('MEDIA', { minItems: 1.5 });
    bad('MEDIA', { maxItems: 2.5 });
    bad('MEDIA', { minItems: 3, maxItems: 2 }, 'maxItems');
    bad('MEDIA', { minItems: 1, maxItems: 0 }, 'maxItems');
  });
  it('PROVIDER_REQUIRED needs at least one photo (minItems >= 1) and cannot be "no photos"', () => {
    bad('MEDIA', { behavior: 'PROVIDER_REQUIRED' }, 'minItems');
    bad('MEDIA', { behavior: 'PROVIDER_REQUIRED', minItems: 0 }, 'minItems');
    bad('MEDIA', { behavior: 'PROVIDER_REQUIRED', maxItems: 5 }, 'minItems');
    bad('MEDIA', { behavior: 'PROVIDER_REQUIRED', minItems: 0, maxItems: 0 }, 'minItems');
    bad('MEDIA', { behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 0 }, 'minItems'); // the media rule AND the order rule both report it
    good('MEDIA', { behavior: 'PROVIDER_REQUIRED', minItems: 1 });
    good('MEDIA', { behavior: 'PROVIDER_REQUIRED', minItems: 1, maxItems: 8 });
    good('MEDIA', { behavior: 'PROVIDER_CONFIGURABLE', minItems: 0, maxItems: 8 });
  });
  it('is never PLATFORM_FIXED', () => {
    bad('MEDIA', { behavior: 'PLATFORM_FIXED' }, 'behavior');
    bad('MEDIA', { behavior: 'PLATFORM_FIXED', minItems: 1, maxItems: 3 }, 'behavior');
  });
});

describe('GigTemplateFieldInput: EQUIPMENT_REFERENCE and SKILL_REFERENCE', () => {
  for (const t of ['EQUIPMENT_REFERENCE', 'SKILL_REFERENCE']) {
    it(`${t}: item counts ordered, at least one selection allowed (maxItems 0 is refused), never PLATFORM_FIXED`, () => {
      good(t, {});
      good(t, { minItems: 0 });
      good(t, { minItems: 0, maxItems: 1 });
      good(t, { minItems: 2, maxItems: 5 });
      good(t, { behavior: 'PROVIDER_REQUIRED' });
      good(t, { behavior: 'PROVIDER_REQUIRED', minItems: 1 });
      bad(t, { maxItems: 0 }, 'maxItems');
      bad(t, { minItems: 0, maxItems: 0 }, 'maxItems');
      bad(t, { minItems: 5, maxItems: 2 }, 'maxItems');
      bad(t, { maxItems: 1001 });
      bad(t, { behavior: 'PLATFORM_FIXED' }, 'behavior');
      bad(t, { behavior: 'PLATFORM_FIXED', minItems: 1, maxItems: 3 }, 'behavior');
    });
  }
  it('only PLATFORM_FIXED is gated by the type: every other behaviour is allowed for every type', () => {
    for (const t of GIG_TEMPLATE_FIELD_TYPES) good(t, { behavior: 'PROVIDER_CONFIGURABLE' });
    for (const t of GIG_TEMPLATE_FIELD_TYPES) {
      const fixedOk = (FIXED_CAPABLE_FIELD_TYPES as readonly string[]).includes(t);
      const withDefault: Record<string, unknown> = {
        TEXT: { withDefaultText: true },
        LONG_TEXT: { withDefaultText: true },
        INTEGER: { defaultNumber: 1 },
        DECIMAL: { defaultNumber: 1 },
        DURATION: { defaultNumber: 1 },
        BOOLEAN: { defaultBoolean: true },
        ENUM: { options: [{ optionCode: 'ab', isDefault: true }] },
      };
      const r = parsed(t, { behavior: 'PLATFORM_FIXED', ...(withDefault[t] ?? {}) });
      expect(r.success, `${t} PLATFORM_FIXED`).toBe(fixedOk);
    }
  });
});

// ====================================================================== duration, requirements
describe('GigTemplateDurationInput', () => {
  it('every bound is optional, a whole number of minutes in 1..1000000, and the order min <= suggested <= max holds', () => {
    for (const d of [
      {},
      { minMinutes: 1 },
      { maxMinutes: 1_000_000 },
      { suggestedMinutes: 60 },
      { minMinutes: 30, maxMinutes: 30, suggestedMinutes: 30 },
      { minMinutes: 30, suggestedMinutes: 45, maxMinutes: 90 },
    ])
      expect(ok(GigTemplateDurationInput, d), JSON.stringify(d)).toBe(true);
    for (const k of ['minMinutes', 'maxMinutes', 'suggestedMinutes'])
      for (const v of [0, -1, 1.5, 1_000_001, '30', null, Number.NaN]) expect(ok(GigTemplateDurationInput, { [k]: v }), `${k}=${String(v)}`).toBe(false);
    expect(issuePaths(GigTemplateDurationInput, { minMinutes: 60, maxMinutes: 30 })).toEqual(['maxMinutes']);
    expect(issuePaths(GigTemplateDurationInput, { minMinutes: 60, suggestedMinutes: 30 })).toEqual(['suggestedMinutes']);
    expect(issuePaths(GigTemplateDurationInput, { maxMinutes: 60, suggestedMinutes: 90 })).toEqual(['suggestedMinutes']);
    expect(issuePaths(GigTemplateDurationInput, { minMinutes: 60, maxMinutes: 30, suggestedMinutes: 10 }).sort()).toEqual(['maxMinutes', 'suggestedMinutes']);
    expect(ok(GigTemplateDurationInput, { minMinutes: 30, extra: 1 })).toBe(false);
    expect(ok(GigTemplateDurationInput, { minutes: 30 })).toBe(false);
    expect(ok(GigTemplateDurationInput, null)).toBe(false);
  });
});

describe('GigTemplateRequirementInput', () => {
  it('has a type from the vocabulary and an optional opaque reference code', () => {
    for (const t of GIG_TEMPLATE_REQUIREMENT_TYPES) expect(ok(GigTemplateRequirementInput, { requirementType: t }), t).toBe(true);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: 'detailing_basic' })).toBe(true);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'skill' })).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'CERTIFICATE' })).toBe(false);
    expect(ok(GigTemplateRequirementInput, {})).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: 'Bad' })).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: null })).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: 'a' })).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: 'a'.repeat(49) })).toBe(false);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', referenceCode: 'a'.repeat(48) })).toBe(true);
    expect(ok(GigTemplateRequirementInput, { requirementType: 'SKILL', extra: 1 })).toBe(false);
  });
});

// ====================================================================== requests
describe('request schemas: strict, with a mandatory reason, nothing coerced', () => {
  const REASONS_BAD: [string, unknown][] = [
    ['empty', ''],
    ['spaces', '   '],
    ['tab and newline', ' \t\n '],
    ['zero-width space only', ch(0x200b)],
    ['word joiner only', ch(0x2060, 0x2060)],
    ['mongolian vowel separator only', ch(0x180e)],
    ['bell control character', `bad${ch(7)}`],
    ['nul', `bad${ch(0)}x`],
    ['c1 control', `bad${ch(0x85)}x`],
    ['bidi override (RLO)', `bad${ch(0x202e)}x`],
    ['bidi isolate', `bad${ch(0x2066)}x`],
    ['lone high surrogate', `bad${ch(0xd83c)}x`],
    ['lone low surrogate', `bad${ch(0xdf4c)}x`],
    ['1001 characters', 'x'.repeat(1001)],
    ['number', 12],
    ['null', null],
    ['array', [REASON]],
    ['object', { v: REASON }],
  ];
  /** every request with a valid body */
  const REQUESTS: [string, z.ZodType, Record<string, unknown>][] = [
    ['CreateGigTemplateRequest', CreateGigTemplateRequest, { code: 'full_detail', serviceTypeCode: 'car_detailing', reason: REASON }],
    ['UpdateGigTemplateRequest', UpdateGigTemplateRequest, { withDescription: true, reason: REASON }],
    ['CreateGigTemplateVersionRequest', CreateGigTemplateVersionRequest, { reason: REASON }],
    [
      'ReplaceGigTemplateDraftRequest',
      ReplaceGigTemplateDraftRequest,
      { expectedRevision: 1, pricingModels: ['FIXED'], areaModes: ['RADIUS'], fields: [field('BOOLEAN')], reason: REASON },
    ],
    ['PublishGigTemplateVersionRequest', PublishGigTemplateVersionRequest, { expectedRevision: 1, reason: REASON }],
    ['GigTemplateVersionRetireRequest', GigTemplateVersionRetireRequest, { status: 'RETIRED', reason: REASON }],
    ['SetMarketGigTemplateAvailabilityRequest', SetMarketGigTemplateAvailabilityRequest, { enabled: true, displayOrder: 10, reason: REASON }],
  ];
  it.each(REQUESTS)('%s: accepts the minimal valid body and nothing else is added to it', (_n, schema, body) => {
    expect(ok(schema, body)).toBe(true);
  });
  it.each(REQUESTS)(
    '%s: a reason is mandatory and must be real text (blank, control, bidi, surrogate, overlong, non-string are refused)',
    (_n, schema, body) => {
      expect(ok(schema, without(body, 'reason'))).toBe(false);
      expect(ok(schema, { ...body, reason: 'x'.repeat(1000) })).toBe(true);
      expect(ok(schema, { ...body, reason: 'a  réason with ünïcode and emoji \u{1F34C}' })).toBe(true);
      for (const [name, reason] of REASONS_BAD) expect(ok(schema, { ...body, reason }), name).toBe(false);
    },
  );
  it.each(REQUESTS)('%s: unknown keys are refused (strict), whatever they are', (_n, schema, body) => {
    for (const extra of [
      { extra: 1 },
      { actor: 'x' },
      { price: 5 },
      { status: 'ACTIVE' },
      { gigTemplateId: UUID_A },
      { name: 'Full Detail' },
      { createdAt: ISO },
    ])
      expect(ok(schema, { ...body, ...extra }), JSON.stringify(extra)).toBe(false);
  });
  it.each(REQUESTS)('%s: a non-object body is refused', (_n, schema) => {
    for (const v of [null, undefined, 'x', 5, true, [], [1]]) expect(ok(schema, v)).toBe(false);
  });

  describe('CreateGigTemplateRequest', () => {
    const body = REQUESTS[0]![2];
    it('code and service type code follow the catalogue grammar, the flags are booleans', () => {
      for (const k of ['code', 'serviceTypeCode']) {
        expect(ok(CreateGigTemplateRequest, without(body, k)), k).toBe(false);
        for (const v of ['Bad', 'a', 'a'.repeat(49), 'ab__cd', 'ab-cd', '', 12, null, UUID_A])
          expect(ok(CreateGigTemplateRequest, { ...body, [k]: v }), `${k}=${String(v)}`).toBe(false);
      }
      for (const k of ['withDescription', 'withInstructions']) {
        expect(ok(CreateGigTemplateRequest, { ...body, [k]: true })).toBe(true);
        expect(ok(CreateGigTemplateRequest, { ...body, [k]: false })).toBe(true);
        for (const v of ['true', 1, 0, null]) expect(ok(CreateGigTemplateRequest, { ...body, [k]: v }), `${k}=${String(v)}`).toBe(false);
      }
    });
  });
  describe('UpdateGigTemplateRequest', () => {
    it('needs at least one of withDescription and withInstructions (false counts)', () => {
      expect(ok(UpdateGigTemplateRequest, { reason: REASON })).toBe(false);
      expect(ok(UpdateGigTemplateRequest, { withDescription: false, reason: REASON })).toBe(true);
      expect(ok(UpdateGigTemplateRequest, { withInstructions: false, reason: REASON })).toBe(true);
      expect(ok(UpdateGigTemplateRequest, { withDescription: true, withInstructions: true, reason: REASON })).toBe(true);
      expect(ok(UpdateGigTemplateRequest, { withDescription: undefined, reason: REASON })).toBe(false);
      expect(ok(UpdateGigTemplateRequest, { withDescription: null, reason: REASON })).toBe(false);
      expect(ok(UpdateGigTemplateRequest, { withDescription: 'true', reason: REASON })).toBe(false);
    });
  });
  describe('CreateGigTemplateVersionRequest', () => {
    it('copyFromVersion is optional and a positive integer', () => {
      expect(ok(CreateGigTemplateVersionRequest, { copyFromVersion: 1, reason: REASON })).toBe(true);
      expect(ok(CreateGigTemplateVersionRequest, { copyFromVersion: 2_147_483_647, reason: REASON })).toBe(true);
      for (const v of [0, -1, 1.5, '1', null, Number.NaN, true])
        expect(ok(CreateGigTemplateVersionRequest, { copyFromVersion: v, reason: REASON }), String(v)).toBe(false);
    });
  });
  describe('PublishGigTemplateVersionRequest', () => {
    it('expectedRevision is a positive integer and mandatory', () => {
      expect(ok(PublishGigTemplateVersionRequest, { reason: REASON })).toBe(false);
      for (const v of [0, -1, 1.5, '1', null, Number.NaN, true])
        expect(ok(PublishGigTemplateVersionRequest, { expectedRevision: v, reason: REASON }), String(v)).toBe(false);
      expect(ok(PublishGigTemplateVersionRequest, { expectedRevision: 7, reason: REASON })).toBe(true);
    });
  });
  describe('SetMarketGigTemplateAvailabilityRequest', () => {
    it('is the catalogue availability request (same schema object), displayOrder 1..9999 optional', () => {
      expect(SetMarketGigTemplateAvailabilityRequest).toBe(SetMarketAvailabilityRequest);
      expect(ok(SetMarketGigTemplateAvailabilityRequest, { enabled: false, reason: REASON })).toBe(true);
      expect(ok(SetMarketGigTemplateAvailabilityRequest, { reason: REASON })).toBe(false);
      for (const v of [0, 10_000, 1.5, '5', null, -1])
        expect(ok(SetMarketGigTemplateAvailabilityRequest, { enabled: true, displayOrder: v, reason: REASON }), String(v)).toBe(false);
    });
  });

  describe('ReplaceGigTemplateDraftRequest', () => {
    const base = { expectedRevision: 1, pricingModels: ['FIXED'], areaModes: ['RADIUS'], fields: [field('BOOLEAN')], reason: REASON };
    const r = (over: Record<string, unknown>) => ({ ...base, ...over });
    it('defaults the requirements to [] and the field defaults, and keeps the duration absent', () => {
      const p = ReplaceGigTemplateDraftRequest.parse(base);
      expect(p.requirements).toEqual([]);
      expect(p.duration).toBeUndefined();
      expect(p.fields[0]).toMatchObject({ section: 'DETAILS', customerVisible: true, withHelp: false, withDefaultText: false, options: [] });
    });
    it('a version has at most 200 options in total, however they are spread over the fields', () => {
      const enumField = (key: string, n: number) => ({
        fieldKey: key,
        fieldType: 'ENUM',
        behavior: 'PROVIDER_CONFIGURABLE',
        options: Array.from({ length: n }, (_, i) => ({ optionCode: `option_${i}` })),
      });
      const spread = (counts: number[]) => r({ fields: counts.map((n, i) => enumField(`field_${i}`, n)) });
      expect(ReplaceGigTemplateDraftRequest.safeParse(spread([30, 30, 30, 30, 30, 30, 20])).success).toBe(true); // 200
      const over = ReplaceGigTemplateDraftRequest.safeParse(spread([30, 30, 30, 30, 30, 30, 21])); // 201
      expect(over.success).toBe(false);
      expect(over.error?.issues.some((i) => i.path.join('.') === 'fields' && /200 options/.test(i.message))).toBe(true);
      expect(GIG_TEMPLATE_MAX_OPTIONS).toBe(200);
    });
    it('the whole definition is required: revision, pricing models, area modes, fields, reason', () => {
      for (const k of ['expectedRevision', 'pricingModels', 'areaModes', 'fields', 'reason'])
        expect(ok(ReplaceGigTemplateDraftRequest, without(base, k)), k).toBe(false);
    });
    it('expectedRevision is a positive integer', () => {
      for (const v of [0, -1, 1.5, '1', null, Number.NaN]) expect(ok(ReplaceGigTemplateDraftRequest, r({ expectedRevision: v })), String(v)).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ expectedRevision: 2_147_483_647 }))).toBe(true);
    });
    it('pricing needs FIXED or FIXED_WITH_VARIANTS (a Gig always has a base price); unique; known', () => {
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED'] }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED_WITH_VARIANTS'] }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE', 'FIXED_WITH_VARIANTS', 'FIXED'] }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['DROP_ELIGIBLE', 'FIXED'] }))).toBe(true);
      // ADD_ONS is a permission on top of a base model, never a base model itself
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED', 'ADD_ONS'] }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['ADD_ONS', 'FIXED_WITH_VARIANTS'] }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: [...PRICING_MODELS] }))).toBe(true);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['ADD_ONS'] }))).toEqual(['pricingModels']);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['ADD_ONS', 'DROP_ELIGIBLE', 'BUNDLE_ELIGIBLE'] }))).toEqual(['pricingModels']);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED', 'ADD_ONS', 'ADD_ONS'] }))).toEqual(['pricingModels']);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['BUNDLE_ELIGIBLE'] }))).toEqual(['pricingModels']);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['DROP_ELIGIBLE', 'BUNDLE_ELIGIBLE'] }))).toEqual(['pricingModels']);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: [] }))).toBe(false);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED', 'FIXED'] }))).toEqual(['pricingModels']);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['HOURLY'] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['fixed'] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: 'FIXED' }))).toBe(false);
      expect(
        ok(ReplaceGigTemplateDraftRequest, r({ pricingModels: ['FIXED', 'FIXED_WITH_VARIANTS', 'BUNDLE_ELIGIBLE', 'DROP_ELIGIBLE', 'ADD_ONS', 'FIXED'] })),
      ).toBe(false);
    });
    it('the area needs at least one mode; unique; known', () => {
      for (const m of [['RADIUS'], ['POSTAL_CODES'], ['POLYGON'], ['RADIUS', 'POSTAL_CODES', 'POLYGON']])
        expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: m })), m.join()).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: [] }))).toBe(false);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ areaModes: ['RADIUS', 'RADIUS'] }))).toEqual(['areaModes']);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: ['RADIUS', 'POSTAL_CODES', 'POLYGON', 'RADIUS'] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: ['CIRCLE'] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: 'RADIUS' }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ areaModes: null }))).toBe(false);
    });
    it('fields: at most 60, unique keys, each field validated with its own path', () => {
      const n = (count: number) => Array.from({ length: count }, (_, i) => field('BOOLEAN', { fieldKey: `field_${i}` }));
      expect(GIG_TEMPLATE_MAX_FIELDS).toBe(60);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: [] }))).toBe(true); // an empty draft is a draft; publication refuses it (GIG_TEMPLATE_HAS_NO_FIELDS)
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: n(60) }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: n(61) }))).toBe(false);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ fields: [field('BOOLEAN'), field('TEXT')] }))).toEqual(['fields']);
      expect(
        issuePaths(
          ReplaceGigTemplateDraftRequest,
          r({ fields: [field('BOOLEAN', { fieldKey: 'aa_bb' }), field('MONEY', { behavior: 'PLATFORM_FIXED', fieldKey: 'cc_dd' })] }),
        ),
      ).toEqual(['fields.1.behavior']);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ fields: [field('TEXT', { minNumber: 1 })] }))).toEqual(['fields.0.minNumber']);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: [{ ...field('BOOLEAN'), extra: 1 }] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: 'x' }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ fields: null }))).toBe(false);
    });
    it('the field order of the request is kept (it is the display order)', () => {
      const p = ReplaceGigTemplateDraftRequest.parse(r({ fields: [field('BOOLEAN', { fieldKey: 'zz_last' }), field('TEXT', { fieldKey: 'aa_first' })] }));
      expect(p.fields.map((f) => f.fieldKey)).toEqual(['zz_last', 'aa_first']);
    });
    it('requirements: at most 30, unique by (type, reference), the same type with different references is fine', () => {
      const n = (count: number) => Array.from({ length: count }, (_, i) => ({ requirementType: 'SKILL', referenceCode: `skill_${i}` }));
      expect(GIG_TEMPLATE_MAX_REQUIREMENTS).toBe(30);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ requirements: n(30) }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ requirements: n(31) }))).toBe(false);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ requirements: [{ requirementType: 'LICENSE' }, { requirementType: 'LICENSE' }] }))).toEqual([
        'requirements',
      ]);
      expect(
        issuePaths(
          ReplaceGigTemplateDraftRequest,
          r({
            requirements: [
              { requirementType: 'SKILL', referenceCode: 'ab' },
              { requirementType: 'SKILL', referenceCode: 'ab' },
            ],
          }),
        ),
      ).toEqual(['requirements']);
      expect(
        ok(
          ReplaceGigTemplateDraftRequest,
          r({
            requirements: [{ requirementType: 'SKILL' }, { requirementType: 'SKILL', referenceCode: 'ab' }, { requirementType: 'SKILL', referenceCode: 'cd' }],
          }),
        ),
      ).toBe(true);
      expect(
        ok(
          ReplaceGigTemplateDraftRequest,
          r({
            requirements: [
              { requirementType: 'SKILL', referenceCode: 'ab' },
              { requirementType: 'EQUIPMENT', referenceCode: 'ab' },
            ],
          }),
        ),
      ).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ requirements: [{ requirementType: 'X' }] }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ requirements: null }))).toBe(false);
    });
    it('the duration is optional and validated with its own path', () => {
      expect(ok(ReplaceGigTemplateDraftRequest, r({ duration: { minMinutes: 30, suggestedMinutes: 60, maxMinutes: 120 } }))).toBe(true);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ duration: {} }))).toBe(true);
      expect(issuePaths(ReplaceGigTemplateDraftRequest, r({ duration: { minMinutes: 60, maxMinutes: 30 } }))).toEqual(['duration.maxMinutes']);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ duration: { minMinutes: 0 } }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ duration: null }))).toBe(false);
      expect(ok(ReplaceGigTemplateDraftRequest, r({ duration: { minMinutes: 30, price: 5 } }))).toBe(false);
    });
    it('refuses every provider-specific top-level property', () => {
      for (const k of [
        'price',
        'floorPrice',
        'radius',
        'serviceArea',
        'pitch',
        'photos',
        'capacity',
        'variants',
        'addOns',
        'bookingMode',
        'durationMinutes',
        'serviceTypeCode',
        'status',
      ])
        expect(ok(ReplaceGigTemplateDraftRequest, r({ [k]: 1 })), k).toBe(false);
    });
  });
});

// ====================================================================== queries and path numbers
describe('GigTemplateListQuery and GigTemplateVersionNumber', () => {
  it('accepts market, locale and serviceType, all optional, strict', () => {
    expect(ok(GigTemplateListQuery, {})).toBe(true);
    expect(ok(GigTemplateListQuery, { market: 'us-sf', locale: 'en-US', serviceType: 'car_detailing' })).toBe(true);
    expect(ok(GigTemplateListQuery, { serviceType: 'car_detailing' })).toBe(true);
    for (const q of [
      { bogus: 1 },
      { serviceType: 'Car' },
      { serviceType: 'a' },
      { serviceType: '' },
      { serviceType: ['car_detailing'] },
      { serviceType: 12 },
      { market: 'US-SF' },
      { market: '' },
      { locale: 'en_US' },
      { locale: '' },
      { category: 'auto_services' },
      { status: 'ACTIVE' },
      { code: 'full_detail' },
    ])
      expect(ok(GigTemplateListQuery, q), JSON.stringify(q)).toBe(false);
  });
  it('a version number is an integer 1..2147483647', () => {
    for (const v of [1, 2, 99, 2_147_483_647]) expect(ok(GigTemplateVersionNumber, v), String(v)).toBe(true);
    for (const v of [0, -1, 1.5, 2_147_483_648, 99_999_999_999, '1', null, Number.NaN, Number.POSITIVE_INFINITY])
      expect(ok(GigTemplateVersionNumber, v), String(v)).toBe(false);
  });
});

// ====================================================================== read models
describe('read models', () => {
  const meta = { correlationId: 'corr-1' };
  const FORBIDDEN_KEYS =
    /^(price|floorPrice|fee|amount|currency|radius|radiusKm|serviceArea|postalCodes|polygon|capacity|pitch|photos?|bookingMode|variants|addOns|durationMinutes|actor|createdBy|updatedBy|auditEvents|reason|correlationId)$/;

  const option = { optionCode: 'carnauba', label: 'Carnauba wax', isDefault: true, displayOrder: 1 };
  const mgmtOption = { ...option, labelContentKey: 'catalog.gig_template.full_detail.field.wax.option.carnauba.label' };
  const fieldPublic = {
    fieldKey: 'wax',
    fieldType: 'ENUM',
    section: 'DETAILS',
    behavior: 'PROVIDER_CONFIGURABLE',
    customerVisible: true,
    displayOrder: 1,
    label: 'Wax',
    help: null,
    defaultText: null,
    minLength: null,
    maxLength: null,
    minNumber: null,
    maxNumber: null,
    defaultNumber: null,
    defaultBoolean: null,
    minItems: null,
    maxItems: null,
    mediaRule: null,
    options: [option],
  };
  const fieldMgmt = {
    ...fieldPublic,
    options: [mgmtOption],
    labelContentKey: 'catalog.gig_template.full_detail.field.wax.label',
    helpContentKey: null,
    defaultContentKey: null,
  };
  const duration = { minMinutes: 60, maxMinutes: 240, suggestedMinutes: 120 };
  const summaryPublic = {
    gigTemplateVersionId: UUID_A,
    versionNumber: 2,
    duration,
    pricingModels: ['FIXED', 'DROP_ELIGIBLE'],
    areaModes: ['RADIUS'],
    fieldCount: 1,
  };
  const summaryMgmt = { ...summaryPublic, status: 'ACTIVE', revision: 3, publishedAt: ISO, closedAt: null, createdAt: ISO };
  const versionPublic = { ...summaryPublic, fields: [fieldPublic], requirements: [{ requirementType: 'SKILL', referenceCode: null }] };
  const versionMgmt = { ...summaryMgmt, fields: [fieldMgmt], requirements: [{ requirementType: 'SKILL', referenceCode: 'detailing_basic' }] };
  const tplPublic = {
    gigTemplateId: UUID_A,
    code: 'full_detail',
    serviceTypeCode: 'car_detailing',
    categoryCode: 'auto_services',
    name: 'Full Detail',
    description: 'A complete detail.',
    displayOrder: 10,
  };
  const tplMgmt = {
    ...tplPublic,
    status: 'ACTIVE',
    enabled: true,
    nameContentKey: 'catalog.gig_template.full_detail.name',
    descriptionContentKey: 'catalog.gig_template.full_detail.description',
    instructionsContentKey: 'catalog.gig_template.full_detail.instructions',
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('the option, field, requirement, duration and summary DTOs accept the public and the management shape', () => {
    expect(ok(GigTemplateOptionDto, option)).toBe(true);
    expect(ok(GigTemplateOptionDto, mgmtOption)).toBe(true);
    expect(ok(GigTemplateFieldDto, fieldPublic)).toBe(true);
    expect(ok(GigTemplateFieldDto, fieldMgmt)).toBe(true);
    expect(ok(GigTemplateRequirementDto, { requirementType: 'LICENSE', referenceCode: null })).toBe(true);
    expect(ok(GigTemplateDurationDto, { minMinutes: null, maxMinutes: null, suggestedMinutes: null })).toBe(true);
    expect(ok(GigTemplateVersionSummaryDto, summaryPublic)).toBe(true);
    expect(ok(GigTemplateVersionSummaryDto, summaryMgmt)).toBe(true);
    expect(ok(GigTemplateVersionSummaryDto, { ...summaryMgmt, status: 'SUPERSEDED', closedAt: ISO })).toBe(true);
    expect(ok(GigTemplateVersionDto, versionPublic)).toBe(true);
    expect(ok(GigTemplateVersionDto, versionMgmt)).toBe(true);
  });
  it('the template DTOs accept public and management shapes, a null active version and the version list (management)', () => {
    expect(ok(GigTemplateListItemDto, { ...tplPublic, activeVersion: summaryPublic })).toBe(true);
    expect(ok(GigTemplateListItemDto, { ...tplPublic, activeVersion: null })).toBe(true);
    expect(ok(GigTemplateListItemDto, { ...tplMgmt, displayOrder: null, activeVersion: summaryMgmt })).toBe(true);
    expect(ok(GigTemplateDetailDto, { ...tplPublic, instructions: 'Describe your work.', activeVersion: versionPublic })).toBe(true);
    expect(ok(GigTemplateDetailDto, { ...tplPublic, instructions: null, activeVersion: null })).toBe(true);
    expect(
      ok(GigTemplateDetailDto, {
        ...tplMgmt,
        instructions: 'x',
        activeVersion: versionMgmt,
        versions: [summaryMgmt, { ...summaryMgmt, versionNumber: 1, status: 'SUPERSEDED' }],
      }),
    ).toBe(true);
    // the management statuses are the catalogue statuses of the template identity
    for (const s of ['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'])
      expect(ok(GigTemplateListItemDto, { ...tplMgmt, status: s, activeVersion: null }), s).toBe(true);
    expect(ok(GigTemplateListItemDto, { ...tplMgmt, status: 'SUPERSEDED', activeVersion: null })).toBe(false);
  });
  it('the envelopes require meta.correlationId and wrap exactly the DTOs', () => {
    expect(ok(GigTemplateListResponse, { data: [{ ...tplPublic, activeVersion: null }], meta })).toBe(true);
    expect(ok(GigTemplateListResponse, { data: [], meta })).toBe(true);
    expect(ok(GigTemplateListResponse, { data: [] })).toBe(false);
    expect(ok(GigTemplateResponse, { data: { ...tplPublic, activeVersion: null }, meta })).toBe(true);
    expect(ok(GigTemplateResponse, { data: [], meta })).toBe(false);
    expect(ok(GigTemplateVersionResponse, { data: versionMgmt, meta })).toBe(true);
    expect(ok(GigTemplateVersionResponse, { data: versionMgmt })).toBe(false);
    expect(ok(GigTemplateMarketAvailabilityResponse, { data: { marketCode: 'us-sf', code: 'full_detail', enabled: true, displayOrder: 5 }, meta })).toBe(true);
  });
  it('the required keys cannot be dropped (every non-optional key of every DTO), nullable keys are not optional', () => {
    const cases: [string, z.ZodType, Record<string, unknown>, string[]][] = [
      ['option', GigTemplateOptionDto, mgmtOption, ['labelContentKey']],
      ['field', GigTemplateFieldDto, fieldMgmt, ['labelContentKey', 'helpContentKey', 'defaultContentKey']],
      ['requirement', GigTemplateRequirementDto, { requirementType: 'LICENSE', referenceCode: null }, []],
      ['duration', GigTemplateDurationDto, { minMinutes: null, maxMinutes: null, suggestedMinutes: null }, []],
      ['summary', GigTemplateVersionSummaryDto, summaryMgmt, ['status', 'revision', 'publishedAt', 'closedAt', 'createdAt']],
      ['version', GigTemplateVersionDto, versionMgmt, ['status', 'revision', 'publishedAt', 'closedAt', 'createdAt']],
      [
        'list item',
        GigTemplateListItemDto,
        { ...tplMgmt, activeVersion: null },
        ['status', 'enabled', 'nameContentKey', 'descriptionContentKey', 'instructionsContentKey', 'createdAt', 'updatedAt'],
      ],
      [
        'detail',
        GigTemplateDetailDto,
        { ...tplMgmt, instructions: null, activeVersion: null, versions: [] },
        ['instructions', 'status', 'enabled', 'nameContentKey', 'descriptionContentKey', 'instructionsContentKey', 'createdAt', 'updatedAt', 'versions'],
      ],
      ['availability', GigTemplateMarketAvailabilityDto, { marketCode: 'us-sf', code: 'full_detail', enabled: true, displayOrder: 5 }, []],
    ];
    for (const [name, schema, sample, optionalKeys] of cases) {
      expect(ok(schema, sample), name).toBe(true);
      for (const k of Object.keys(sample)) {
        const dropped = ok(schema, without(sample, k));
        expect(dropped, `${name}.${k} ${optionalKeys.includes(k) ? 'is optional' : 'is required'}`).toBe(optionalKeys.includes(k));
      }
    }
  });
  it('wrong types are refused (strings for numbers, numbers for strings, unknown enum values)', () => {
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, fieldType: 'NUMBER' })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, section: 'OTHER' })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, behavior: 'FIXED' })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, mediaRule: 'MAYBE' })).toBe(false);
    for (const m of ['OPTIONAL', 'REQUIRED', 'PROHIBITED', null]) expect(ok(GigTemplateFieldDto, { ...fieldPublic, mediaRule: m }), String(m)).toBe(true);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, mediaRule: undefined })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, displayOrder: '1' })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, minLength: '5' })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, minNumber: 1.5 })).toBe(true); // a DECIMAL bound is not an integer
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, minLength: 1.5 })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, label: null })).toBe(false);
    expect(ok(GigTemplateFieldDto, { ...fieldPublic, customerVisible: 'yes' })).toBe(false);
    expect(ok(GigTemplateVersionSummaryDto, { ...summaryPublic, pricingModels: ['HOURLY'] })).toBe(false);
    expect(ok(GigTemplateVersionSummaryDto, { ...summaryPublic, areaModes: ['CIRCLE'] })).toBe(false);
    expect(ok(GigTemplateVersionSummaryDto, { ...summaryPublic, versionNumber: 1.5 })).toBe(false);
    expect(ok(GigTemplateVersionSummaryDto, { ...summaryMgmt, status: 'INACTIVE' })).toBe(false);
    expect(ok(GigTemplateRequirementDto, { requirementType: 'OTHER', referenceCode: null })).toBe(false);
    expect(ok(GigTemplateRequirementDto, { requirementType: 'SKILL' })).toBe(false);
    expect(ok(GigTemplateMarketAvailabilityDto, { marketCode: 'us-sf', code: 'x', enabled: true, displayOrder: 0 })).toBe(false);
    expect(ok(GigTemplateMarketAvailabilityDto, { marketCode: 'us-sf', code: 'x', enabled: 'true', displayOrder: 5 })).toBe(false);
  });
  it('an unknown property never survives parsing (the serializer built from these schemas cannot leak what is not declared)', () => {
    const dirty = { price: 5, actor: 'staff-1', auditEvents: [{ actor: 'x' }], radius: 3, capacity: 2 };
    for (const [schema, sample] of [
      [GigTemplateOptionDto, mgmtOption],
      [GigTemplateFieldDto, fieldMgmt],
      [GigTemplateVersionSummaryDto, summaryMgmt],
      [GigTemplateVersionDto, versionMgmt],
      [GigTemplateListItemDto, { ...tplMgmt, activeVersion: summaryMgmt }],
      [GigTemplateDetailDto, { ...tplMgmt, instructions: null, activeVersion: versionMgmt }],
      [GigTemplateMarketAvailabilityDto, { marketCode: 'us-sf', code: 'x', enabled: true, displayOrder: 5 }],
    ] as [z.ZodType, Record<string, unknown>][]) {
      const out = schema.parse({ ...sample, ...dirty });
      for (const k of Object.keys(dirty)) expect(out, k).not.toHaveProperty(k);
      expect(JSON.stringify(out)).not.toContain('staff-1');
    }
  });
  it('declares exactly the documented keys (public and management-only) of every DTO', () => {
    expect(shapeKeys(GigTemplateOptionDto)).toEqual(['displayOrder', 'isDefault', 'label', 'labelContentKey', 'optionCode']);
    expect(shapeKeys(GigTemplateFieldDto)).toEqual(
      [
        'behavior',
        'customerVisible',
        'defaultBoolean',
        'defaultContentKey',
        'defaultNumber',
        'defaultText',
        'displayOrder',
        'fieldKey',
        'fieldType',
        'help',
        'helpContentKey',
        'label',
        'labelContentKey',
        'maxItems',
        'maxLength',
        'maxNumber',
        'mediaRule',
        'minItems',
        'minLength',
        'minNumber',
        'options',
        'section',
      ].sort(),
    );
    expect(shapeKeys(GigTemplateVersionSummaryDto)).toEqual(
      [
        'areaModes',
        'closedAt',
        'createdAt',
        'duration',
        'fieldCount',
        'gigTemplateVersionId',
        'pricingModels',
        'publishedAt',
        'revision',
        'status',
        'versionNumber',
      ].sort(),
    );
    expect(shapeKeys(GigTemplateVersionDto)).toEqual([...shapeKeys(GigTemplateVersionSummaryDto), 'fields', 'requirements'].sort());
    expect(shapeKeys(GigTemplateListItemDto)).toEqual(
      [
        'activeVersion',
        'categoryCode',
        'code',
        'createdAt',
        'description',
        'descriptionContentKey',
        'displayOrder',
        'enabled',
        'gigTemplateId',
        'instructions',
        'instructionsContentKey',
        'name',
        'nameContentKey',
        'serviceTypeCode',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(shapeKeys(GigTemplateDetailDto)).toEqual([...shapeKeys(GigTemplateListItemDto), 'versions'].sort());
    expect(shapeKeys(GigTemplateMarketAvailabilityDto)).toEqual(['code', 'displayOrder', 'enabled', 'marketCode']);
  });
  it('nothing provider-specific can be declared by any request, DTO or event: no price, floor price, radius, area, pitch, photo, capacity, variant, booking', () => {
    for (const [name, schema] of [
      ['ReplaceGigTemplateDraftRequest', ReplaceGigTemplateDraftRequest],
      ['CreateGigTemplateRequest', CreateGigTemplateRequest],
      ['UpdateGigTemplateRequest', UpdateGigTemplateRequest],
      ['GigTemplateFieldInput', GigTemplateFieldInput],
      ['GigTemplateDurationInput', GigTemplateDurationInput],
      ['GigTemplateRequirementInput', GigTemplateRequirementInput],
      ['GigTemplateVersionDto', GigTemplateVersionDto],
      ['GigTemplateDetailDto', GigTemplateDetailDto],
      ['GigTemplateListItemDto', GigTemplateListItemDto],
      ['GigTemplatePublishedPayload', GigTemplatePublishedPayload],
      ['GigTemplateAvailabilityEventPayload', GigTemplateAvailabilityEventPayload],
    ] as [string, z.ZodType][]) {
      const keys = walkKeys(schema).map((p) => p.split('.').pop()!.replace('[]', ''));
      expect(keys.length, name).toBeGreaterThanOrEqual(2);
      for (const k of keys) expect(FORBIDDEN_KEYS.test(k) && !(name.endsWith('Request') && k === 'reason'), `${name}.${k}`).toBe(false);
    }
    // the only column of the migration that could be money is NOT there: no price-like column in the 0016 tables
    const ddl = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT'))
      .join('\n');
    const columns = [...ddl.matchAll(/^\s{2}(\w+)\s+(?:uuid|text|boolean|integer|numeric\(\d+, \d+\)|timestamptz|jsonb)\b/gm)].map((m) => m[1]!);
    expect(columns.length).toBeGreaterThan(60);
    for (const c of columns)
      expect(c, `column ${c}`).not.toMatch(
        /^(price|\w*_price|fee|\w*_fee|amount|\w*_amount|currency|radius_km|radius|polygon|capacity|pitch|photos?|booking_mode|variants?|add_ons?)$/,
      );
  });
  it('the unused-here GigTemplateMarketAvailabilityDto is the catalogue DisplayOrder bounded row', () => {
    for (const d of [1, 9999]) expect(ok(GigTemplateMarketAvailabilityDto, { marketCode: 'm', code: 'c', enabled: false, displayOrder: d })).toBe(true);
    expect(ok(GigTemplateMarketAvailabilityDto, { marketCode: 'm', code: 'c', enabled: false, displayOrder: 10_000 })).toBe(false);
  });
  it('AreaMode and the field type vocabularies are z.enum schemas of the exported constants', () => {
    expect(AreaMode.options).toEqual([...AREA_MODES]);
  });
});

// ====================================================================== events
describe('events', () => {
  it('has exactly the five documented subjects, each bananagig.catalog.<event>.v1', () => {
    expect(GIG_TEMPLATE_EVENTS).toEqual({
      activated: 'bananagig.catalog.gig-template-activated.v1',
      deactivated: 'bananagig.catalog.gig-template-deactivated.v1',
      retired: 'bananagig.catalog.gig-template-retired.v1',
      published: 'bananagig.catalog.gig-template-published.v1',
      availabilityChanged: 'bananagig.catalog.gig-template-availability-changed.v1',
    });
    const subjects = Object.values(GIG_TEMPLATE_EVENTS);
    expect(new Set(subjects).size).toBe(subjects.length);
    for (const s of subjects) {
      expect(s, s).toMatch(EVENT_TYPE_PATTERN);
      expect(s.split('.').slice(0, 2)).toEqual(['bananagig', 'catalog']);
      expect(s).toMatch(/\.v[1-9][0-9]*$/);
      expect(s).toContain('gig-template');
    }
  });
  it('GigTemplateEventPayload carries the template code and the service type code only', () => {
    const p = { gigTemplateCode: 'full_detail', serviceTypeCode: 'car_detailing' };
    expect(GigTemplateEventPayload.parse(p)).toEqual(p);
    expect(shapeKeys(GigTemplateEventPayload)).toEqual(['gigTemplateCode', 'serviceTypeCode']);
    for (const k of Object.keys(p)) expect(ok(GigTemplateEventPayload, without(p, k)), k).toBe(false);
    expect(ok(GigTemplateEventPayload, { ...p, gigTemplateCode: 'Bad' })).toBe(false);
    expect(ok(GigTemplateEventPayload, { ...p, serviceTypeCode: 5 })).toBe(false);
    expect(GigTemplateEventPayload.parse({ ...p, name: 'Full Detail', actor: 'x' })).toEqual(p);
  });
  it('GigTemplatePublishedPayload adds the version number and the exact version id', () => {
    const p = { gigTemplateCode: 'full_detail', serviceTypeCode: 'car_detailing', versionNumber: 2, gigTemplateVersionId: UUID_A };
    expect(GigTemplatePublishedPayload.parse(p)).toEqual(p);
    expect(shapeKeys(GigTemplatePublishedPayload)).toEqual(['gigTemplateCode', 'gigTemplateVersionId', 'serviceTypeCode', 'versionNumber']);
    for (const k of Object.keys(p)) expect(ok(GigTemplatePublishedPayload, without(p, k)), k).toBe(false);
    for (const v of [0, -1, 1.5, '2', null]) expect(ok(GigTemplatePublishedPayload, { ...p, versionNumber: v }), String(v)).toBe(false);
    expect(ok(GigTemplatePublishedPayload, { ...p, gigTemplateVersionId: 5 })).toBe(false);
  });
  it('GigTemplateAvailabilityEventPayload carries market, template and the new state only', () => {
    const p = { marketCode: 'us-sf', gigTemplateCode: 'full_detail', enabled: true };
    expect(GigTemplateAvailabilityEventPayload.parse(p)).toEqual(p);
    expect(shapeKeys(GigTemplateAvailabilityEventPayload)).toEqual(['enabled', 'gigTemplateCode', 'marketCode']);
    for (const k of Object.keys(p)) expect(ok(GigTemplateAvailabilityEventPayload, without(p, k)), k).toBe(false);
    expect(ok(GigTemplateAvailabilityEventPayload, { ...p, enabled: 'true' })).toBe(false);
    expect(ok(GigTemplateAvailabilityEventPayload, { ...p, gigTemplateCode: 'Bad' })).toBe(false);
    expect(ok(GigTemplateAvailabilityEventPayload, { ...p, enabled: 1 })).toBe(false);
  });
  it('payloads never grow display text or personal data (key allow-list)', () => {
    const allowed = new Set(['gigTemplateCode', 'serviceTypeCode', 'versionNumber', 'gigTemplateVersionId', 'marketCode', 'enabled']);
    for (const s of [GigTemplateEventPayload, GigTemplatePublishedPayload, GigTemplateAvailabilityEventPayload])
      for (const k of shapeKeys(s)) expect(allowed.has(k), k).toBe(true);
  });
});

// ====================================================================== errors
describe('the CAT-002 catalogue error codes', () => {
  it('the contract names the two Gig Template not-found codes, each a valid suffix of CATALOG_<code>', () => {
    expect(CATALOG_ERROR_CODES).toContain('GIG_TEMPLATE_NOT_FOUND');
    expect(CATALOG_ERROR_CODES).toContain('GIG_TEMPLATE_VERSION_NOT_FOUND');
    for (const c of ['GIG_TEMPLATE_NOT_FOUND', 'GIG_TEMPLATE_VERSION_NOT_FOUND']) expect(`CATALOG_${c}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
