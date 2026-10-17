// Unit tests of the catalogue contracts (CAT-001), written by an independent author: the code grammar (the SAME corpus the migration CHECK must accept and refuse), the icon
// key, the display order, the status machine (all 16 pairs, equal to the SQL function), the derived content keys (equal to the generated columns and the seed of migration
// 0015), every strict request (a reason is mandatory, nothing is coerced, nothing unknown is accepted), every read model (the public fields only, nothing provider-specific),
// the events (subjects, identifiers only) and the error codes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContentKey } from './content';
import { EVENT_TYPE_PATTERN, ErrorResponse } from './index';
import {
  CATALOG_CODE_MAX,
  CATALOG_CODE_MIN,
  CATALOG_CODE_PATTERN,
  CATALOG_DISPLAY_ORDER_MAX,
  CATALOG_DISPLAY_ORDER_MIN,
  CATALOG_ERROR_CODES,
  CATALOG_EVENTS,
  CATALOG_STATUSES,
  CATALOG_STATUS_TRANSITIONS,
  CATALOG_TARGET_STATUSES,
  CATALOG_TEST_CODE_PREFIX,
  CatalogAvailabilityEventPayload,
  CatalogCategoryDto,
  CatalogCategoryListResponse,
  CatalogCategoryResponse,
  CatalogCode,
  CatalogReadQuery,
  CatalogServiceTypeDto,
  CatalogServiceTypeListResponse,
  CatalogServiceTypeQuery,
  CatalogServiceTypeResponse,
  CatalogStatus,
  CatalogStatusRequest,
  CatalogTargetStatus,
  CategoryEventPayload,
  CreateCategoryRequest,
  CreateProhibitedServiceRequest,
  CreateServiceTypeRequest,
  DisplayOrder,
  ICON_KEY_PATTERN,
  IconKey,
  MarketAvailabilityDto,
  MarketAvailabilityResponse,
  ProhibitedServiceDto,
  ProhibitedServiceListResponse,
  ProhibitedServiceResponse,
  ServiceTypeEventPayload,
  SetMarketAvailabilityRequest,
  UpdateCategoryRequest,
  UpdateServiceTypeRequest,
  categoryDescriptionKey,
  categoryNameKey,
  isCatalogTransitionAllowed,
  prohibitedServiceDescriptionKey,
  prohibitedServiceNameKey,
  serviceTypeDescriptionKey,
  serviceTypeNameKey,
  type CatalogStatus as Status,
} from './catalog';

const migration = readFileSync(fileURLToPath(new URL('../../../db/migrations/0015_catalog.sql', import.meta.url)), 'utf8');

// ---------------------------------------------------------------- helpers (zod shape walker, same technique as consent.test.ts)
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
const ch = (...codes: number[]): string => String.fromCharCode(...codes);

const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const UUID_B = '9b2f6d0e-5c1a-4e0b-8a77-0d3c5f9a1e21';
const ISO = '2026-10-16T12:00:00.000Z';
const REASON = 'a documented reason';

// ====================================================================== the code grammar
describe('CatalogCode and CATALOG_CODE_PATTERN: one corpus for the contract AND the migration CHECK', () => {
  const GOOD: [string, string][] = [
    ['plain word', 'cleaning'],
    ['home_cleaning', 'home_cleaning'],
    ['digits after the first letter', 'a1'],
    ['digit segment', 'item_2'],
    ['segment starting with a digit', 'deep_3d_clean'],
    ['two letters (the minimum)', 'ab'],
    ['48 characters (the maximum)', 'a'.repeat(48)],
    ['48 characters with underscores', `${'ab_'.repeat(15)}abc`],
    ['devtest prefix', 'devtest_x1'],
  ];
  const BAD: [string, string][] = [
    ['empty', ''],
    ['one character', 'a'],
    ['49 characters', 'a'.repeat(49)],
    ['upper case', 'Home_cleaning'],
    ['all upper case', 'HOME_CLEANING'],
    ['hyphen', 'home-cleaning'],
    ['leading digit', '1abc'],
    ['leading underscore', '_abc'],
    ['trailing underscore', 'abc_'],
    ['double underscore', 'ab__cd'],
    ['only underscores', '__'],
    ['space inside', 'ab cd'],
    ['leading space', ' abc'],
    ['trailing space', 'abc '],
    ['trailing newline', 'abc\n'],
    ['leading newline', '\nabc'],
    ['tab', 'ab\tcd'],
    ['nul', 'ab\x00cd'],
    ['dot', 'ab.cd'],
    ['slash', 'ab/cd'],
    ['percent', 'ab%41'],
    ['unicode letter (e acute)', `caf${ch(0xe9)}`],
    ['full-width latin', ch(0xff41, 0xff42)],
    ['cyrillic a', `${ch(0x430)}bc`],
    ['zero-width space', `ab${ch(0x200b)}cd`],
    ['emoji', `ab${ch(0xd83c, 0xdf4c)}`],
    ['sql meta', "a'; drop"],
    ['__proto__', '__proto__'],
  ];
  it.each(GOOD)('accepts %s', (_n, v) => {
    expect(CatalogCode.safeParse(v).success).toBe(true);
    expect(CATALOG_CODE_PATTERN.test(v)).toBe(true);
  });
  it.each(BAD)('refuses %s', (_n, v) => {
    expect(CatalogCode.safeParse(v).success).toBe(false);
  });
  it('refuses every non-string without coercing it', () => {
    for (const v of [12, true, null, undefined, ['ab'], { a: 1 }, 1n]) expect(CatalogCode.safeParse(v).success).toBe(false);
  });
  it('the length bounds are exactly 2 and 48 and the pattern alone does not enforce them', () => {
    expect([CATALOG_CODE_MIN, CATALOG_CODE_MAX]).toEqual([2, 48]);
    expect(CATALOG_CODE_PATTERN.test('a')).toBe(true); // the length lives in min()/max() and in the SQL length() check
    expect(CatalogCode.safeParse('a').success).toBe(false);
    expect(CATALOG_CODE_PATTERN.test('a'.repeat(49))).toBe(true);
    expect(CatalogCode.safeParse('a'.repeat(49)).success).toBe(false);
    expect(CATALOG_TEST_CODE_PREFIX).toBe('devtest_');
  });
  it('the pattern is anchored, has no flags and is a pure function of the string (no lastIndex state)', () => {
    expect(CATALOG_CODE_PATTERN.flags).toBe('');
    expect(CATALOG_CODE_PATTERN.test('abc')).toBe(true);
    expect(CATALOG_CODE_PATTERN.test('abc')).toBe(true);
  });
  it('is the SAME grammar as the three code CHECK constraints of the migration (regex text and length bounds)', () => {
    const checks = [...migration.matchAll(/CONSTRAINT (ck_\w+__code) CHECK \(code ~ '([^']+)' AND length\(code\) BETWEEN (\d+) AND (\d+)\)/g)];
    expect(checks.map((m) => m[1])).toEqual(['ck_categories__code', 'ck_service_types__code', 'ck_prohibited_services__code']);
    for (const m of checks) {
      expect(m[2]!.replace(/\(\?:/g, '(')).toBe(CATALOG_CODE_PATTERN.source.replace(/\(\?:/g, '('));
      expect([Number(m[3]), Number(m[4])]).toEqual([CATALOG_CODE_MIN, CATALOG_CODE_MAX]);
    }
  });
  it('every content key built from the longest valid code is itself a valid content key', () => {
    const longest = 'a'.repeat(CATALOG_CODE_MAX);
    for (const k of [
      categoryNameKey(longest),
      categoryDescriptionKey(longest),
      serviceTypeNameKey(longest),
      serviceTypeDescriptionKey(longest),
      prohibitedServiceNameKey(longest),
      prohibitedServiceDescriptionKey(longest),
    ])
      expect(ContentKey.safeParse(k).success, k).toBe(true);
    for (const k of [categoryNameKey('home_cleaning'), serviceTypeNameKey('deep_3d_clean'), prohibitedServiceNameKey('devtest_x1')])
      expect(ContentKey.safeParse(k).success, k).toBe(true);
  });
});

describe('IconKey and DisplayOrder', () => {
  it.each(['star', 'car-wash', 'a1', 'home-2-icon'])('accepts the icon %s', (v) => expect(IconKey.safeParse(v).success).toBe(true));
  it.each([
    '',
    'Star',
    'car_wash',
    '-star',
    'star-',
    'car--wash',
    '1star',
    'car wash',
    'http://x/y.png',
    '/icons/a.svg',
    'a'.repeat(49),
    'star\n',
    `st${ch(0xe9)}`,
  ])('refuses the icon %j', (v) => expect(IconKey.safeParse(v).success).toBe(false));
  it('accepts 48 characters and refuses 49; matches the migration CHECK', () => {
    expect(IconKey.safeParse('a'.repeat(48)).success).toBe(true);
    expect(IconKey.safeParse('a'.repeat(49)).success).toBe(false);
    const m = /CONSTRAINT ck_categories__icon_key CHECK \(icon_key IS NULL OR \(icon_key ~ '([^']+)' AND length\(icon_key\) <= (\d+)\)\)/.exec(migration);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ICON_KEY_PATTERN.source.replace(/\(\?:/g, '('));
    expect(Number(m![2])).toBe(48);
  });
  it('display order: integers from 1 to 9999 only, matching the migration CHECKs', () => {
    expect([CATALOG_DISPLAY_ORDER_MIN, CATALOG_DISPLAY_ORDER_MAX]).toEqual([1, 9999]);
    for (const v of [1, 2, 10, 9998, 9999]) expect(DisplayOrder.safeParse(v).success, String(v)).toBe(true);
    for (const v of [0, -1, 10000, 1.5, Number.NaN, Infinity, -Infinity, '5', '', null, undefined, true, [5], 2 ** 53])
      expect(DisplayOrder.safeParse(v).success, String(v)).toBe(false);
    const checks = [...migration.matchAll(/CONSTRAINT ck_market_\w+__display_order CHECK \(display_order BETWEEN (\d+) AND (\d+)\)/g)];
    expect(checks).toHaveLength(2);
    for (const m of checks) expect([Number(m[1]), Number(m[2])]).toEqual([1, 9999]);
  });
});

// ====================================================================== the status machine
describe('status machine', () => {
  const EXPECTED: Record<Status, Status[]> = { DRAFT: ['ACTIVE', 'RETIRED'], ACTIVE: ['INACTIVE', 'RETIRED'], INACTIVE: ['ACTIVE', 'RETIRED'], RETIRED: [] };
  it('lists the four statuses in order and the three targets (DRAFT is never a target)', () => {
    expect([...CATALOG_STATUSES]).toEqual(['DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED']);
    expect([...CATALOG_TARGET_STATUSES]).toEqual(['ACTIVE', 'INACTIVE', 'RETIRED']);
    expect(CatalogStatus.safeParse('DRAFT').success).toBe(true);
    expect(CatalogTargetStatus.safeParse('DRAFT').success).toBe(false);
    for (const v of ['active', 'Active', 'PAUSED', '', null, 1]) expect(CatalogStatus.safeParse(v).success, String(v)).toBe(false);
  });
  it('isCatalogTransitionAllowed over all 16 pairs equals the table', () => {
    let allowed = 0;
    for (const from of CATALOG_STATUSES)
      for (const to of CATALOG_STATUSES) {
        const expected = EXPECTED[from].includes(to);
        expect(isCatalogTransitionAllowed(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) allowed += 1;
      }
    expect(allowed).toBe(6);
    expect(CATALOG_STATUS_TRANSITIONS).toEqual(EXPECTED);
  });
  it('DRAFT is never a target and RETIRED is terminal; a status never "transitions" to itself (the services treat that as idempotent instead)', () => {
    for (const from of CATALOG_STATUSES) {
      expect(isCatalogTransitionAllowed(from, 'DRAFT'), `${from} -> DRAFT`).toBe(false);
      expect(isCatalogTransitionAllowed(from, from), `${from} -> ${from}`).toBe(false);
    }
    expect(CATALOG_STATUS_TRANSITIONS.RETIRED).toHaveLength(0);
    for (const to of CATALOG_STATUSES) expect(isCatalogTransitionAllowed('RETIRED', to)).toBe(false);
    for (const targets of Object.values(CATALOG_STATUS_TRANSITIONS)) expect(targets).not.toContain('DRAFT');
  });
  it('every status reachable from outside is a valid request target and nothing else is', () => {
    const reachable = new Set<string>(Object.values(CATALOG_STATUS_TRANSITIONS).flat());
    expect([...reachable].sort()).toEqual([...CATALOG_TARGET_STATUSES].sort());
  });
  it('equals the SQL function assert_status_transition (same pairs, same words)', () => {
    const fn = /CREATE FUNCTION catalog\.assert_status_transition[\s\S]*?\$\$;/.exec(migration)?.[0] ?? '';
    expect(fn).not.toBe('');
    const clauses = [...fn.matchAll(/p_old = '(\w+)' AND p_new IN \(([^)]*)\)/g)].map((m) => [m[1], [...m[2]!.matchAll(/'(\w+)'/g)].map((x) => x[1])] as const);
    const fromSql: Record<string, string[]> = { RETIRED: [] };
    for (const [from, to] of clauses) fromSql[from!] = to as string[];
    expect(fromSql).toEqual(EXPECTED);
    expect(fn).toContain("IF p_new = 'DRAFT' THEN");
    const statusChecks = [...migration.matchAll(/CONSTRAINT ck_\w+__status CHECK \(status IN \(([^)]*)\)\)/g)];
    expect(statusChecks).toHaveLength(3);
    for (const m of statusChecks) expect([...m[1]!.matchAll(/'(\w+)'/g)].map((x) => x[1])).toEqual([...CATALOG_STATUSES]);
  });
});

// ====================================================================== content keys
describe('derived content keys', () => {
  it('have the exact shape', () => {
    expect(categoryNameKey('auto_services')).toBe('catalog.category.auto_services.name');
    expect(categoryDescriptionKey('auto_services')).toBe('catalog.category.auto_services.description');
    expect(serviceTypeNameKey('car_detailing')).toBe('catalog.service_type.car_detailing.name');
    expect(serviceTypeDescriptionKey('car_detailing')).toBe('catalog.service_type.car_detailing.description');
    expect(prohibitedServiceNameKey('x1')).toBe('catalog.prohibited_service.x1.name');
    expect(prohibitedServiceDescriptionKey('x1')).toBe('catalog.prohibited_service.x1.description');
  });
  it('equal the generated column and CHECK expressions of the migration for every table', () => {
    const generated = [...migration.matchAll(/name_content_key\s+text\s+GENERATED ALWAYS AS \('([^']+)' \|\| code \|\| '([^']+)'\) STORED NOT NULL/g)].map(
      (m) => `${m[1]}<code>${m[2]}`,
    );
    expect(generated).toEqual(['catalog.category.<code>.name', 'catalog.service_type.<code>.name', 'catalog.prohibited_service.<code>.name']);
    const descr = [
      ...migration.matchAll(
        /CONSTRAINT ck_\w+__description_content_key CHECK \(description_content_key IS NULL OR description_content_key = '([^']+)' \|\| code \|\| '([^']+)'\)/g,
      ),
    ].map((m) => `${m[1]}<code>${m[2]}`);
    expect(descr).toEqual(['catalog.category.<code>.description', 'catalog.service_type.<code>.description', 'catalog.prohibited_service.<code>.description']);
    const helpers = [categoryNameKey('<code>'), serviceTypeNameKey('<code>'), prohibitedServiceNameKey('<code>')];
    expect(helpers).toEqual(generated);
    expect([categoryDescriptionKey('<code>'), serviceTypeDescriptionKey('<code>'), prohibitedServiceDescriptionKey('<code>')]).toEqual(descr);
  });
  it('produce exactly the 12 content keys the migration seeds, for exactly the seeded codes', () => {
    const seededKeys = [...migration.matchAll(/\(\d+,\s+'(?:UI_LABEL|PLAIN_TEXT)',\s+'(catalog\.[a-z_.]+)'/g)].map((m) => m[1]!);
    expect(seededKeys).toHaveLength(12);
    const categories = ['home_cleaning', 'auto_services'];
    const serviceTypes = ['regular_cleaning', 'deep_cleaning', 'car_detailing', 'mobile_car_wash'];
    const derived = [
      ...categories.flatMap((c) => [categoryNameKey(c), categoryDescriptionKey(c)]),
      ...serviceTypes.flatMap((s) => [serviceTypeNameKey(s), serviceTypeDescriptionKey(s)]),
    ];
    expect([...derived].sort()).toEqual([...seededKeys].sort());
    for (const c of [...categories, ...serviceTypes]) expect(CatalogCode.safeParse(c).success, c).toBe(true);
    // the seeded rows are inserted DRAFT and name only these codes
    const seededCategories = /INSERT INTO catalog\.categories \(code, description_content_key, status\) VALUES([\s\S]*?);/.exec(migration)?.[1] ?? '';
    expect([...seededCategories.matchAll(/\('(\w+)', 'catalog\.category\.(\w+)\.description', 'DRAFT'\)/g)].map((m) => [m[1], m[2]])).toEqual(
      categories.map((c) => [c, c]),
    );
    const seededSt = /FROM \(VALUES([\s\S]*?)\) AS s \(category_code, code\)/.exec(migration)?.[1] ?? '';
    expect([...seededSt.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => [m[1], m[2]])).toEqual([
      ['home_cleaning', 'regular_cleaning'],
      ['home_cleaning', 'deep_cleaning'],
      ['auto_services', 'car_detailing'],
      ['auto_services', 'mobile_car_wash'],
    ]);
  });
  it('the seed and the audit action CHECK use only actions the contracts and the service know', () => {
    const actions = [...(/ck_audit_events__action CHECK \(action IN \(([\s\S]*?)\)\),/.exec(migration)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(actions).toEqual([
      'CATEGORY_CREATED',
      'CATEGORY_UPDATED',
      'CATEGORY_STATUS_CHANGED',
      'SERVICE_TYPE_CREATED',
      'SERVICE_TYPE_UPDATED',
      'SERVICE_TYPE_STATUS_CHANGED',
      'PROHIBITED_SERVICE_CREATED',
      'PROHIBITED_SERVICE_STATUS_CHANGED',
      'MARKET_CATALOG_AVAILABILITY_CHANGED',
    ]);
  });
});

// ====================================================================== requests
describe('request schemas: strict, with a mandatory reason, nothing coerced', () => {
  const create = { code: 'new_cat', reason: REASON };
  const createSt = { code: 'new_st', categoryCode: 'auto_services', reason: REASON };
  const status = { status: 'ACTIVE', reason: REASON };
  const avail = { enabled: true, displayOrder: 10, reason: REASON };
  const ALL: [string, z.ZodType, Record<string, unknown>][] = [
    ['CreateCategoryRequest', CreateCategoryRequest, create],
    ['UpdateCategoryRequest', UpdateCategoryRequest, { iconKey: 'star', reason: REASON }],
    ['CreateServiceTypeRequest', CreateServiceTypeRequest, createSt],
    ['UpdateServiceTypeRequest', UpdateServiceTypeRequest, { withDescription: true, reason: REASON }],
    ['CatalogStatusRequest', CatalogStatusRequest, status],
    ['CreateProhibitedServiceRequest', CreateProhibitedServiceRequest, create],
    ['SetMarketAvailabilityRequest', SetMarketAvailabilityRequest, avail],
  ];
  it.each(ALL)('%s accepts its minimal good body', (_n, schema, good) => {
    expect(schema.safeParse(good).success).toBe(true);
  });
  it.each(ALL)('%s refuses unknown fields, including status, ids, display text and prototype pollution', (_n, schema, good) => {
    for (const extra of [
      { extra: 1 },
      { status: 'ACTIVE' },
      { categoryId: UUID_A },
      { serviceTypeId: UUID_A },
      { displayText: 'Car Care' },
      { name: 'Car Care' },
      { nameContentKey: 'catalog.category.x.name' },
      { price: 10 },
      { durationMinutes: 60 },
      { radiusKm: 5 },
      { capacity: 3 },
      { id: UUID_A },
      JSON.parse('{"__proto__": {"admin": true}}'),
      JSON.parse('{"constructor": {"prototype": {}}}'),
    ]) {
      const body = { ...good, ...extra };
      if (Object.keys(extra)[0] === 'status' && 'status' in good) continue; // the status request already owns that field (covered below)
      expect(schema.safeParse(body).success, JSON.stringify(Object.keys(extra))).toBe(false);
    }
  });
  it.each(ALL)('%s refuses a missing, blank, over-long or control-character reason, and non-object bodies', (_n, schema, good) => {
    expect(schema.safeParse(without(good, 'reason')).success).toBe(false);
    for (const reason of [
      '',
      '   ',
      '\t\n ',
      ch(0x200b),
      ch(0x2060),
      ch(0x180e),
      'a'.repeat(1001),
      'bad\x00reason',
      'bad\x07reason',
      'line1\nline2',
      'tab\there',
      `del${ch(0x7f)}`,
      `c1${ch(0x85)}`,
      `bidi${ch(0x202e)}`,
      `iso${ch(0x2066)}`,
      `lone${ch(0xd800)}`,
      `lone${ch(0xdc00)}`,
      null,
      12,
      true,
      ['a'],
      { a: 1 },
    ])
      expect(schema.safeParse({ ...good, reason }).success, JSON.stringify(reason)).toBe(false);
    expect(schema.safeParse({ ...good, reason: 'a'.repeat(1000) }).success).toBe(true);
    expect(schema.safeParse({ ...good, reason: 'x' }).success).toBe(true);
    expect(schema.safeParse({ ...good, reason: `emoji ${ch(0xd83c, 0xdf4c)} fine` }).success).toBe(true);
    for (const body of [null, undefined, 'x', 1, true, [], [good], () => undefined]) expect(schema.safeParse(body).success).toBe(false);
  });
  it('CreateCategoryRequest: code is required and canonical, iconKey is nullable/optional, withDescription is a real boolean', () => {
    expect(ok(CreateCategoryRequest, without(create, 'code'))).toBe(false);
    for (const code of ['Bad', 'a', 'a'.repeat(49), 'ab__c', null, 5, ['ab'], undefined])
      expect(ok(CreateCategoryRequest, { ...create, code }), String(code)).toBe(false);
    expect(ok(CreateCategoryRequest, { ...create, iconKey: null })).toBe(true);
    expect(ok(CreateCategoryRequest, { ...create, iconKey: 'star' })).toBe(true);
    expect(ok(CreateCategoryRequest, { ...create, iconKey: undefined })).toBe(true);
    for (const iconKey of ['', 'Star', 5, true, ['star']]) expect(ok(CreateCategoryRequest, { ...create, iconKey }), String(iconKey)).toBe(false);
    expect(ok(CreateCategoryRequest, { ...create, withDescription: false })).toBe(true);
    for (const withDescription of ['true', 'false', 1, 0, null, 'yes', [], {}])
      expect(ok(CreateCategoryRequest, { ...create, withDescription }), String(withDescription)).toBe(false);
    expect(CreateCategoryRequest.parse({ ...create, iconKey: null })).toEqual({ ...create, iconKey: null });
  });
  it('UpdateCategoryRequest: at least one of iconKey and withDescription; null unlinks the icon; the code is not editable', () => {
    expect(ok(UpdateCategoryRequest, { reason: REASON })).toBe(false);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: undefined })).toBe(false);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: null })).toBe(true);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: 'star' })).toBe(true);
    expect(ok(UpdateCategoryRequest, { reason: REASON, withDescription: false })).toBe(true);
    expect(ok(UpdateCategoryRequest, { reason: REASON, withDescription: true, iconKey: 'star' })).toBe(true);
    expect(ok(UpdateCategoryRequest, { reason: REASON, withDescription: null })).toBe(false);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: 'star', code: 'other' })).toBe(false);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: 'star', status: 'ACTIVE' })).toBe(false);
    expect(ok(UpdateCategoryRequest, { reason: REASON, iconKey: 'Star' })).toBe(false);
  });
  it('CreateServiceTypeRequest: both codes required; the category is one code (no list, no id); withDescription strict boolean', () => {
    for (const k of ['code', 'categoryCode']) expect(ok(CreateServiceTypeRequest, without(createSt, k)), k).toBe(false);
    for (const categoryCode of [null, 'Bad', 'a', ['auto_services'], UUID_A, 5])
      expect(ok(CreateServiceTypeRequest, { ...createSt, categoryCode }), String(categoryCode)).toBe(false);
    expect(ok(CreateServiceTypeRequest, { ...createSt, categoryId: UUID_A })).toBe(false);
    expect(ok(CreateServiceTypeRequest, { ...createSt, categoryCodes: ['a', 'b'] })).toBe(false);
    expect(ok(CreateServiceTypeRequest, { ...createSt, withDescription: true })).toBe(true);
    expect(ok(CreateServiceTypeRequest, { ...createSt, withDescription: 'true' })).toBe(false);
  });
  it('UpdateServiceTypeRequest: withDescription is REQUIRED and the category cannot be moved', () => {
    expect(ok(UpdateServiceTypeRequest, { reason: REASON })).toBe(false);
    expect(ok(UpdateServiceTypeRequest, { reason: REASON, withDescription: false })).toBe(true);
    expect(ok(UpdateServiceTypeRequest, { reason: REASON, withDescription: null })).toBe(false);
    expect(ok(UpdateServiceTypeRequest, { reason: REASON, withDescription: 1 })).toBe(false);
    expect(ok(UpdateServiceTypeRequest, { reason: REASON, withDescription: true, categoryCode: 'home_cleaning' })).toBe(false);
  });
  it('CatalogStatusRequest: ACTIVE, INACTIVE or RETIRED only (case-sensitive); DRAFT and every other word is refused', () => {
    for (const s of ['ACTIVE', 'INACTIVE', 'RETIRED']) expect(ok(CatalogStatusRequest, { status: s, reason: REASON }), s).toBe(true);
    for (const s of ['DRAFT', 'active', 'Active', 'PLANNED', 'DELETED', '', ' ACTIVE', 'ACTIVE ', null, undefined, 1, true, ['ACTIVE']])
      expect(ok(CatalogStatusRequest, { status: s, reason: REASON }), String(s)).toBe(false);
    expect(ok(CatalogStatusRequest, { reason: REASON })).toBe(false);
    expect(ok(CatalogStatusRequest, { status: 'ACTIVE', reason: REASON, enabled: true })).toBe(false);
  });
  it('CreateProhibitedServiceRequest: categoryCode is optional and nullable; withDescription strict', () => {
    expect(ok(CreateProhibitedServiceRequest, { ...create, categoryCode: null })).toBe(true);
    expect(ok(CreateProhibitedServiceRequest, { ...create, categoryCode: 'auto_services' })).toBe(true);
    expect(ok(CreateProhibitedServiceRequest, { ...create, categoryCode: 'Bad' })).toBe(false);
    expect(ok(CreateProhibitedServiceRequest, { ...create, categoryCode: '' })).toBe(false);
    expect(ok(CreateProhibitedServiceRequest, { ...create, withDescription: 1 })).toBe(false);
    expect(ok(CreateProhibitedServiceRequest, { ...create, code: null })).toBe(false);
  });
  it('SetMarketAvailabilityRequest: enabled is a real boolean, displayOrder optional but never null/coerced/out of range', () => {
    expect(ok(SetMarketAvailabilityRequest, { enabled: false, reason: REASON })).toBe(true);
    expect(ok(SetMarketAvailabilityRequest, { reason: REASON, displayOrder: 5 })).toBe(false); // enabled is required
    for (const enabled of ['true', 'false', 1, 0, null, 'yes', undefined, [], {}])
      expect(ok(SetMarketAvailabilityRequest, { enabled, reason: REASON }), String(enabled)).toBe(false);
    for (const displayOrder of [0, -1, 10000, 1.5, '5', '', null, Number.NaN, Infinity, true, [5], 1e21])
      expect(ok(SetMarketAvailabilityRequest, { enabled: true, displayOrder, reason: REASON }), String(displayOrder)).toBe(false);
    for (const displayOrder of [1, 9999]) expect(ok(SetMarketAvailabilityRequest, { enabled: true, displayOrder, reason: REASON })).toBe(true);
    expect(ok(SetMarketAvailabilityRequest, { enabled: true, displayOrder: 5, reason: REASON, marketCode: 'us-sf' })).toBe(false);
    expect(ok(SetMarketAvailabilityRequest, { enabled: true, displayOrder: 5, reason: REASON, alsoDisabled: [] })).toBe(false);
  });
  it('the parsed value is a copy of exactly the contract (no extra property survives, nothing is added)', () => {
    expect(Object.keys(CreateCategoryRequest.parse({ ...create, iconKey: 'star', withDescription: true })).sort()).toEqual([
      'code',
      'iconKey',
      'reason',
      'withDescription',
    ]);
    expect(Object.keys(SetMarketAvailabilityRequest.parse(avail)).sort()).toEqual(['displayOrder', 'enabled', 'reason']);
    expect(Object.keys(CatalogStatusRequest.parse(status)).sort()).toEqual(['reason', 'status']);
  });
  it('request keys are exactly what the design allows (nothing provider-specific can be sent)', () => {
    expect(shapeKeys(CreateCategoryRequest)).toEqual(['code', 'iconKey', 'reason', 'withDescription']);
    expect(shapeKeys(UpdateCategoryRequest)).toEqual(['iconKey', 'reason', 'withDescription']);
    expect(shapeKeys(CreateServiceTypeRequest)).toEqual(['categoryCode', 'code', 'reason', 'withDescription']);
    expect(shapeKeys(UpdateServiceTypeRequest)).toEqual(['reason', 'withDescription']);
    expect(shapeKeys(CatalogStatusRequest)).toEqual(['reason', 'status']);
    expect(shapeKeys(CreateProhibitedServiceRequest)).toEqual(['categoryCode', 'code', 'reason', 'withDescription']);
    expect(shapeKeys(SetMarketAvailabilityRequest)).toEqual(['displayOrder', 'enabled', 'reason']);
  });
});

describe('query schemas', () => {
  it('CatalogReadQuery: market (a market code) and locale (a canonical locale), both optional, nothing else', () => {
    expect(ok(CatalogReadQuery, {})).toBe(true);
    expect(ok(CatalogReadQuery, { market: 'us-sf', locale: 'en-US' })).toBe(true);
    expect(ok(CatalogReadQuery, { market: 'us-sf', locale: 'es-419' })).toBe(true);
    for (const q of [
      { market: 'US-SF' },
      { market: 'us_sf' },
      { market: '' },
      { market: 'a'.repeat(61) },
      { market: 5 },
      { locale: 'en_US' },
      { locale: 'EN-us' },
      { locale: '' },
      { locale: 'en-US-x-extra-long-tag' },
      { bogus: 1 },
      { category: 'auto_services' },
      { status: 'ACTIVE' },
      { enabled: true },
    ])
      expect(ok(CatalogReadQuery, q), JSON.stringify(q)).toBe(false);
  });
  it('CatalogServiceTypeQuery adds `category` as a catalogue code', () => {
    expect(ok(CatalogServiceTypeQuery, { category: 'auto_services', market: 'us-sf' })).toBe(true);
    for (const q of [{ category: 'Auto' }, { category: '' }, { category: 'a' }, { category: ['a_b'] }, { bogus: 1 }])
      expect(ok(CatalogServiceTypeQuery, q), JSON.stringify(q)).toBe(false);
  });
});

// ====================================================================== read models
describe('read models', () => {
  const publicCategory = { categoryId: UUID_A, code: 'auto_services', name: 'Auto Services', description: 'Car care.', iconKey: 'car', displayOrder: 10 };
  const mgmtCategory = {
    ...publicCategory,
    status: 'ACTIVE',
    enabled: true,
    nameContentKey: 'catalog.category.auto_services.name',
    descriptionContentKey: 'catalog.category.auto_services.description',
    createdAt: ISO,
    updatedAt: ISO,
  };
  const publicSt = { serviceTypeId: UUID_B, code: 'car_detailing', categoryCode: 'auto_services', name: 'Car Detailing', description: null, displayOrder: 20 };
  const mgmtSt = {
    ...publicSt,
    status: 'DRAFT',
    enabled: false,
    nameContentKey: 'catalog.service_type.car_detailing.name',
    descriptionContentKey: null,
    createdAt: ISO,
    updatedAt: ISO,
  };
  const prohibited = {
    prohibitedServiceId: UUID_A,
    code: 'illegal_thing',
    categoryCode: null,
    name: null,
    description: null,
    status: 'ACTIVE',
    nameContentKey: 'catalog.prohibited_service.illegal_thing.name',
    descriptionContentKey: null,
    createdAt: ISO,
    updatedAt: ISO,
  };
  const availability = { marketCode: 'us-sf', code: 'auto_services', kind: 'CATEGORY', enabled: false, displayOrder: 10, alsoDisabled: ['car_detailing'] };
  const meta = { correlationId: 'corr-1' };

  it('CatalogCategoryDto parses the public and the management payloads and keeps exactly those keys', () => {
    expect(CatalogCategoryDto.parse(publicCategory)).toEqual(publicCategory);
    expect(CatalogCategoryDto.parse(mgmtCategory)).toEqual(mgmtCategory);
    expect(shapeKeys(CatalogCategoryDto)).toEqual(
      [
        'categoryId',
        'code',
        'name',
        'description',
        'iconKey',
        'displayOrder',
        'status',
        'enabled',
        'nameContentKey',
        'descriptionContentKey',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(CatalogCategoryDto.parse({ ...publicCategory, description: null, iconKey: null, displayOrder: null })).toMatchObject({
      description: null,
      iconKey: null,
      displayOrder: null,
    });
  });
  it('CatalogServiceTypeDto parses both payloads and keeps exactly those keys', () => {
    expect(CatalogServiceTypeDto.parse(publicSt)).toEqual(publicSt);
    expect(CatalogServiceTypeDto.parse(mgmtSt)).toEqual(mgmtSt);
    expect(shapeKeys(CatalogServiceTypeDto)).toEqual(
      [
        'serviceTypeId',
        'code',
        'categoryCode',
        'name',
        'description',
        'displayOrder',
        'status',
        'enabled',
        'nameContentKey',
        'descriptionContentKey',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
  it('ProhibitedServiceDto, MarketAvailabilityDto parse good payloads and keep exactly their keys', () => {
    expect(ProhibitedServiceDto.parse(prohibited)).toEqual(prohibited);
    expect(shapeKeys(ProhibitedServiceDto)).toEqual(
      [
        'prohibitedServiceId',
        'code',
        'categoryCode',
        'name',
        'description',
        'status',
        'nameContentKey',
        'descriptionContentKey',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(MarketAvailabilityDto.parse(availability)).toEqual(availability);
    expect(shapeKeys(MarketAvailabilityDto)).toEqual(['alsoDisabled', 'code', 'displayOrder', 'enabled', 'kind', 'marketCode']);
  });
  it('every required field is required (missing -> refused), wrong types are refused, nothing is coerced', () => {
    const required: [string, z.ZodType, Record<string, unknown>, string[]][] = [
      ['category', CatalogCategoryDto, publicCategory, ['categoryId', 'code', 'name', 'description', 'iconKey', 'displayOrder']],
      ['service type', CatalogServiceTypeDto, publicSt, ['serviceTypeId', 'code', 'categoryCode', 'name', 'description', 'displayOrder']],
      ['prohibited', ProhibitedServiceDto, prohibited, Object.keys(prohibited)],
      ['availability', MarketAvailabilityDto, availability, Object.keys(availability)],
    ];
    for (const [name, schema, good, keys] of required)
      for (const k of keys) {
        expect(ok(schema, without(good, k)), `${name} without ${k}`).toBe(false);
      }
    expect(ok(CatalogCategoryDto, { ...publicCategory, displayOrder: '10' })).toBe(false);
    expect(ok(CatalogCategoryDto, { ...publicCategory, displayOrder: 1.5 })).toBe(false);
    expect(ok(CatalogCategoryDto, { ...publicCategory, code: 'Bad Code' })).toBe(false);
    expect(ok(CatalogCategoryDto, { ...publicCategory, status: 'DELETED' })).toBe(false);
    expect(ok(CatalogCategoryDto, { ...publicCategory, enabled: 'true' })).toBe(false);
    expect(ok(CatalogServiceTypeDto, { ...publicSt, categoryCode: 'Auto' })).toBe(false);
    expect(ok(ProhibitedServiceDto, { ...prohibited, status: 'DRAFTED' })).toBe(false);
    expect(ok(MarketAvailabilityDto, { ...availability, kind: 'PROHIBITED' })).toBe(false);
    expect(ok(MarketAvailabilityDto, { ...availability, alsoDisabled: ['Bad'] })).toBe(false);
    expect(ok(MarketAvailabilityDto, { ...availability, enabled: 1 })).toBe(false);
    expect(ok(MarketAvailabilityDto, { ...availability, displayOrder: null })).toBe(false);
  });
  it('extra properties never survive parsing and the JSON Schema of every DTO forbids additional properties (the HTTP serializer drops them)', () => {
    for (const [name, schema, good] of [
      ['category', CatalogCategoryDto, publicCategory],
      ['service type', CatalogServiceTypeDto, publicSt],
      ['prohibited', ProhibitedServiceDto, prohibited],
      ['availability', MarketAvailabilityDto, availability],
    ] as const) {
      const dirty = { ...good, actor: 'staff-1', createdBy: 'staff-1', auditEvents: [{ a: 1 }], price: 5, durationMinutes: 30 };
      const parsed = schema.parse(dirty) as Record<string, unknown>;
      for (const k of ['actor', 'createdBy', 'auditEvents', 'price', 'durationMinutes']) expect(parsed, `${name} ${k}`).not.toHaveProperty(k);
      const json = z.toJSONSchema(schema, { target: 'draft-7' }) as { additionalProperties?: unknown };
      expect(json.additionalProperties, name).toBe(false);
    }
  });
  it('the envelope wrappers carry data and meta.correlationId', () => {
    expect(CatalogCategoryResponse.safeParse({ data: publicCategory, meta }).success).toBe(true);
    expect(CatalogCategoryResponse.safeParse({ data: publicCategory }).success).toBe(false);
    expect(CatalogCategoryListResponse.safeParse({ data: [publicCategory, mgmtCategory], meta }).success).toBe(true);
    expect(CatalogCategoryListResponse.safeParse({ data: publicCategory, meta }).success).toBe(false);
    expect(CatalogServiceTypeResponse.safeParse({ data: mgmtSt, meta }).success).toBe(true);
    expect(CatalogServiceTypeListResponse.safeParse({ data: [], meta }).success).toBe(true);
    expect(ProhibitedServiceResponse.safeParse({ data: prohibited, meta }).success).toBe(true);
    expect(ProhibitedServiceListResponse.safeParse({ data: [prohibited], meta }).success).toBe(true);
    expect(MarketAvailabilityResponse.safeParse({ data: availability, meta }).success).toBe(true);
    expect(MarketAvailabilityResponse.safeParse({ data: availability, meta: {} }).success).toBe(false);
  });
  it('NO schema of the module can carry a price, duration, radius, capacity, availability window or any provider-owned field', () => {
    const FORBIDDEN =
      /price|amount|fee|cost|rate|currency|duration|minutes|hours|radius|distance|capacity|seats|slots|schedule|calendar|availabilityWindow|openingHours|provider|gig|variant|addon|add_on|booking|tax|discount|commission/i;
    const schemas: [string, unknown][] = [
      ['CatalogCategoryDto', CatalogCategoryDto],
      ['CatalogServiceTypeDto', CatalogServiceTypeDto],
      ['ProhibitedServiceDto', ProhibitedServiceDto],
      ['MarketAvailabilityDto', MarketAvailabilityDto],
      ['CreateCategoryRequest', CreateCategoryRequest],
      ['UpdateCategoryRequest', UpdateCategoryRequest],
      ['CreateServiceTypeRequest', CreateServiceTypeRequest],
      ['UpdateServiceTypeRequest', UpdateServiceTypeRequest],
      ['CatalogStatusRequest', CatalogStatusRequest],
      ['CreateProhibitedServiceRequest', CreateProhibitedServiceRequest],
      ['SetMarketAvailabilityRequest', SetMarketAvailabilityRequest],
      ['CatalogReadQuery', CatalogReadQuery],
      ['CatalogServiceTypeQuery', CatalogServiceTypeQuery],
      ['CategoryEventPayload', CategoryEventPayload],
      ['ServiceTypeEventPayload', ServiceTypeEventPayload],
      ['CatalogAvailabilityEventPayload', CatalogAvailabilityEventPayload],
    ];
    for (const [name, schema] of schemas) for (const path of walkKeys(schema)) expect(path, `${name}.${path}`).not.toMatch(FORBIDDEN);
    // the migration's own columns carry none either (comments excluded: they describe what is NOT stored)
    const ddl = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.startsWith('COMMENT'))
      .join('\n');
    const columns = [...ddl.matchAll(/^\s{2}(\w+)\s+(?:uuid|text|boolean|integer|timestamptz|jsonb)\b/gm)].map((m) => m[1]!);
    expect(columns.length).toBeGreaterThan(30);
    for (const c of columns) expect(c, `column ${c}`).not.toMatch(FORBIDDEN);
  });
});

// ====================================================================== events
describe('events', () => {
  it('has exactly the five documented subjects, each bananagig.catalog.<event>.v1', () => {
    expect(CATALOG_EVENTS).toEqual({
      categoryActivated: 'bananagig.catalog.category-activated.v1',
      categoryDeactivated: 'bananagig.catalog.category-deactivated.v1',
      serviceTypeActivated: 'bananagig.catalog.service-type-activated.v1',
      serviceTypeDeactivated: 'bananagig.catalog.service-type-deactivated.v1',
      availabilityChanged: 'bananagig.catalog.availability-changed.v1',
    });
    const subjects = Object.values(CATALOG_EVENTS);
    expect(new Set(subjects).size).toBe(subjects.length);
    for (const s of subjects) {
      expect(s, s).toMatch(EVENT_TYPE_PATTERN);
      expect(s.split('.').slice(0, 2)).toEqual(['bananagig', 'catalog']);
      expect(s).toMatch(/\.v[1-9][0-9]*$/);
    }
  });
  it('CategoryEventPayload carries the category code only', () => {
    expect(CategoryEventPayload.parse({ categoryCode: 'auto_services' })).toEqual({ categoryCode: 'auto_services' });
    expect(ok(CategoryEventPayload, {})).toBe(false);
    expect(ok(CategoryEventPayload, { categoryCode: 'Bad' })).toBe(false);
    expect(ok(CategoryEventPayload, { categoryCode: 5 })).toBe(false);
    expect(CategoryEventPayload.parse({ categoryCode: 'auto_services', name: 'Auto Services', actor: 'x' })).toEqual({ categoryCode: 'auto_services' });
    expect(shapeKeys(CategoryEventPayload)).toEqual(['categoryCode']);
  });
  it('ServiceTypeEventPayload carries the two codes only', () => {
    const p = { serviceTypeCode: 'car_detailing', categoryCode: 'auto_services' };
    expect(ServiceTypeEventPayload.parse(p)).toEqual(p);
    expect(ok(ServiceTypeEventPayload, { serviceTypeCode: 'car_detailing' })).toBe(false);
    expect(ok(ServiceTypeEventPayload, { categoryCode: 'auto_services' })).toBe(false);
    expect(ok(ServiceTypeEventPayload, { serviceTypeCode: 'Car', categoryCode: 'auto_services' })).toBe(false);
    expect(shapeKeys(ServiceTypeEventPayload)).toEqual(['categoryCode', 'serviceTypeCode']);
  });
  it('CatalogAvailabilityEventPayload carries market, kind, code and the new state only', () => {
    const p = { marketCode: 'us-sf', kind: 'CATEGORY', code: 'auto_services', enabled: true };
    expect(CatalogAvailabilityEventPayload.parse(p)).toEqual(p);
    for (const k of Object.keys(p)) expect(ok(CatalogAvailabilityEventPayload, without(p, k)), k).toBe(false);
    expect(ok(CatalogAvailabilityEventPayload, { ...p, kind: 'PROHIBITED_SERVICE' })).toBe(false);
    expect(ok(CatalogAvailabilityEventPayload, { ...p, enabled: 'true' })).toBe(false);
    expect(ok(CatalogAvailabilityEventPayload, { ...p, code: 'Bad' })).toBe(false);
    expect(shapeKeys(CatalogAvailabilityEventPayload)).toEqual(['code', 'enabled', 'kind', 'marketCode']);
  });
  it('payloads never grow display text or personal data (key allow-list)', () => {
    const allowed = new Set(['categoryCode', 'serviceTypeCode', 'marketCode', 'kind', 'code', 'enabled']);
    for (const s of [CategoryEventPayload, ServiceTypeEventPayload, CatalogAvailabilityEventPayload])
      for (const k of shapeKeys(s)) expect(allowed.has(k), k).toBe(true);
  });
});

// ====================================================================== errors
describe('CATALOG_ERROR_CODES', () => {
  it('is exactly the documented list, without duplicates', () => {
    expect([...CATALOG_ERROR_CODES]).toEqual([
      'CATEGORY_NOT_FOUND',
      'SERVICE_TYPE_NOT_FOUND',
      'PROHIBITED_SERVICE_NOT_FOUND',
      'GIG_TEMPLATE_NOT_FOUND',
      'GIG_TEMPLATE_VERSION_NOT_FOUND',
      'MARKET_NOT_FOUND',
      'VALIDATION_FAILED',
      'CONFLICT',
      'INVALID_STATE',
      'UNAVAILABLE',
    ]);
    expect(new Set(CATALOG_ERROR_CODES).size).toBe(CATALOG_ERROR_CODES.length);
  });
  it('every API error code CATALOG_<code> is a valid error code of the standard envelope', () => {
    for (const c of CATALOG_ERROR_CODES) {
      const body = { error: { code: `CATALOG_${c}`, category: 'NOT_FOUND', message: 'm', correlationId: 'c' } };
      expect(ErrorResponse.safeParse(body).success, c).toBe(true);
      expect(`CATALOG_${c}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
