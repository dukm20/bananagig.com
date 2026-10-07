// Unit tests of the pure parts of the address service: DTO mappers, the format effective window, the readiness check, the database error mapping for
// the address guards, and the request rejections that happen BEFORE any database access (proved with a Database that throws when touched).
// Behavior that needs real constraints, triggers and locks lives in geography.itest.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@bananagig/database';
import { GeographyError } from './errors';
import { AddressService, createAddressFormatReadinessCheck, formatInEffect, toAddressFormatDto, toAdministrativeAreaDto } from './address-service';
import type { AddressFormatField, AddressFormatModel, AdministrativeAreaModel } from './address-engine';
import type { ReadinessContext } from './readiness';
import { mapDbError } from './service';

// ---------------------------------------------------------------- fixtures
const field = (fieldType: AddressFormatField['fieldType'], over: Partial<AddressFormatField> = {}): AddressFormatField => ({
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
const US_FIELDS: AddressFormatField[] = [
  field('ADDRESS_LINE_1', { displayOrder: 1, required: true, autocomplete: 'address-line1' }),
  field('ADDRESS_LINE_2', { displayOrder: 2 }),
  field('LOCALITY', { displayOrder: 3, required: true, maxLength: 60 }),
  field('ADMINISTRATIVE_AREA', { displayOrder: 4, required: true, maxLength: 50, inputType: 'LOOKUP' }),
  field('POSTAL_CODE', { displayOrder: 5, required: true, maxLength: 10, validationPattern: '^[0-9]{5}(-[0-9]{4})?$', example: '12345', normalization: null }),
];
const T = (iso: string) => new Date(iso);
const makeFormat = (over: Partial<AddressFormatModel> = {}): AddressFormatModel => ({
  addressFormatId: 'fmt-1',
  countryCode: 'US',
  version: 1,
  status: 'PUBLISHED',
  displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
  effectiveFrom: T('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  fields: US_FIELDS,
  ...over,
});
const makeArea = (over: Partial<AdministrativeAreaModel> = {}): AdministrativeAreaModel => ({
  administrativeAreaId: 'area-1',
  code: 'CA',
  name: 'California',
  type: 'STATE',
  parentCode: null,
  displayOrder: 5,
  status: 'ACTIVE',
  ...over,
});

/** A Database that fails the test loudly if anything touches it: the code under test must reject before reading or writing. */
const untouchable = (): Database =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the database was touched (${String(prop)})`);
      },
    },
  ) as unknown as Database;
const service = (extra: Partial<ConstructorParameters<typeof AddressService>[0]> = {}) =>
  new AddressService({ database: untouchable(), env: 'test', ...extra });

// ---------------------------------------------------------------- mappers
describe('toAddressFormatDto', () => {
  it('maps the public read model: fields with their input property, mode and postal example, no management fields', () => {
    const dto = toAddressFormatDto(makeFormat(), false);
    expect(dto.countryCode).toBe('US');
    expect(dto.version).toBe(1);
    expect(dto.administrativeAreaMode).toBe('LOOKUP');
    expect(dto.postalCodeExample).toBe('12345');
    expect(dto.fields.map((f) => [f.fieldType, f.property, f.displayOrder])).toEqual([
      ['ADDRESS_LINE_1', 'addressLine1', 1],
      ['ADDRESS_LINE_2', 'addressLine2', 2],
      ['LOCALITY', 'locality', 3],
      ['ADMINISTRATIVE_AREA', 'administrativeArea', 4],
      ['POSTAL_CODE', 'postalCode', 5],
    ]);
    expect(dto.fields[4]).toEqual({
      fieldType: 'POSTAL_CODE',
      property: 'postalCode',
      displayOrder: 5,
      contentLabelKey: 'address.field.postal_code',
      required: true,
      maxLength: 10,
      inputType: 'TEXT',
      validationPattern: '^[0-9]{5}(-[0-9]{4})?$',
      example: '12345',
      autocomplete: null,
      normalization: null,
    });
    for (const key of ['status', 'displayTemplate', 'effectiveFrom', 'effectiveTo']) expect(dto).not.toHaveProperty(key);
  });
  it('adds status, template and the period (ISO strings, open end null) for management', () => {
    const open = toAddressFormatDto(makeFormat(), true);
    expect(open).toMatchObject({
      status: 'PUBLISHED',
      displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    });
    const closed = toAddressFormatDto(makeFormat({ status: 'DRAFT', effectiveTo: T('2027-01-01T00:00:00Z') }), true);
    expect(closed).toMatchObject({ status: 'DRAFT', effectiveTo: '2027-01-01T00:00:00.000Z' });
  });
  it('reports FREE_TEXT / NONE modes and a null postal example when the format has no such data', () => {
    const free = toAddressFormatDto(makeFormat({ fields: [field('ADDRESS_LINE_1', { required: true }), field('ADMINISTRATIVE_AREA')] }), false);
    expect(free.administrativeAreaMode).toBe('FREE_TEXT');
    expect(free.postalCodeExample).toBeNull();
    expect(toAddressFormatDto(makeFormat({ fields: [field('ADDRESS_LINE_1', { required: true })] }), false).administrativeAreaMode).toBe('NONE');
    expect(toAddressFormatDto(makeFormat({ fields: [field('POSTAL_CODE')] }), false).postalCodeExample).toBeNull();
  });
});

describe('toAdministrativeAreaDto', () => {
  it('maps the public view without status and the management view with it', () => {
    expect(toAdministrativeAreaDto(makeArea(), false)).toEqual({ code: 'CA', name: 'California', type: 'STATE', parentCode: null, displayOrder: 5 });
    expect(toAdministrativeAreaDto(makeArea({ status: 'INACTIVE', parentCode: 'US', displayOrder: null }), true)).toEqual({
      code: 'CA',
      name: 'California',
      type: 'STATE',
      parentCode: 'US',
      displayOrder: null,
      status: 'INACTIVE',
    });
  });
  it('never exposes the internal area id', () => {
    expect(JSON.stringify(toAdministrativeAreaDto(makeArea(), true))).not.toContain('area-1');
  });
});

// ---------------------------------------------------------------- effective window
describe('formatInEffect', () => {
  const v1 = makeFormat({ version: 1, effectiveFrom: T('2026-01-01T00:00:00Z'), effectiveTo: T('2026-06-01T00:00:00Z') });
  const v2 = makeFormat({ version: 2, effectiveFrom: T('2026-06-01T00:00:00Z'), effectiveTo: null });

  it('includes the start instant and excludes the end instant (half-open window)', () => {
    expect(formatInEffect([v1], T('2026-01-01T00:00:00Z'))).toBe(v1);
    expect(formatInEffect([v1], T('2026-05-31T23:59:59.999Z'))).toBe(v1);
    expect(formatInEffect([v1], T('2026-06-01T00:00:00Z'))).toBeNull();
    expect(formatInEffect([v1], T('2025-12-31T23:59:59.999Z'))).toBeNull();
  });
  it('at the instant a successor starts, the successor is in effect and the predecessor is not', () => {
    expect(formatInEffect([v2, v1], T('2026-06-01T00:00:00Z'))).toBe(v2);
    expect(formatInEffect([v2, v1], T('2026-05-31T23:59:59.999Z'))).toBe(v1);
    expect(formatInEffect([v1, v2], T('2026-06-01T00:00:00.001Z'))).toBe(v2);
  });
  it('treats a null end as open-ended', () => {
    expect(formatInEffect([v2], T('2099-01-01T00:00:00Z'))).toBe(v2);
  });
  it('ignores drafts, whatever their window', () => {
    const draft = makeFormat({ version: 3, status: 'DRAFT', effectiveFrom: T('2000-01-01T00:00:00Z'), effectiveTo: null });
    expect(formatInEffect([draft], T('2026-07-01T00:00:00Z'))).toBeNull();
    expect(formatInEffect([draft, v2], T('2026-07-01T00:00:00Z'))).toBe(v2);
  });
  it('is null for no formats', () => {
    expect(formatInEffect([], T('2026-07-01T00:00:00Z'))).toBeNull();
  });
});

// ---------------------------------------------------------------- readiness
describe('createAddressFormatReadinessCheck', () => {
  const ctx = (code: string, at = T('2026-07-01T00:00:00Z')) => ({ country: { code, status: 'ACTIVE' }, at }) as unknown as ReadinessContext;
  const fake = (result: boolean) => {
    const hasEffectiveFormat = vi.fn(async (_country: string, _at?: Date) => result);
    return { svc: { hasEffectiveFormat } as unknown as AddressService, hasEffectiveFormat };
  };

  it('is the required ADDRESS_FORMAT check', () => {
    const check = createAddressFormatReadinessCheck(fake(true).svc);
    expect(check.code).toBe('ADDRESS_FORMAT');
    expect(check.required).not.toBe(false);
    expect(check.description).toMatch(/address format/i);
  });
  it('passes when the country has a format in force at the evaluation instant', async () => {
    const { svc, hasEffectiveFormat } = fake(true);
    const at = T('2026-07-01T12:00:00Z');
    const out = await createAddressFormatReadinessCheck(svc).evaluate(ctx('FR', at));
    expect(out).toEqual({ passed: true, detail: 'country FR has an address format in force' });
    expect(hasEffectiveFormat).toHaveBeenCalledWith('FR', at);
  });
  it('fails, with a detail that names only the country, when there is none', async () => {
    const out = await createAddressFormatReadinessCheck(fake(false).svc).evaluate(ctx('MX'));
    expect(out).toEqual({ passed: false, detail: 'country MX has no address format in force' });
  });
  it('contains no country-specific logic: the same check serves any country code', async () => {
    const { svc, hasEffectiveFormat } = fake(true);
    const check = createAddressFormatReadinessCheck(svc);
    for (const code of ['US', 'CA', 'ZZ']) expect((await check.evaluate(ctx(code))).passed).toBe(true);
    expect(hasEffectiveFormat.mock.calls.map((c) => c[0])).toEqual(['US', 'CA', 'ZZ']);
  });
  it('lets a failing read surface (the registry decides what an error means)', async () => {
    const svc = {
      hasEffectiveFormat: async () => {
        throw new Error('boom');
      },
    } as unknown as AddressService;
    await expect(createAddressFormatReadinessCheck(svc).evaluate(ctx('US'))).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------- mapDbError: address guards and constraints
describe('mapDbError: address model failures become typed errors without internals', () => {
  const map = (e: unknown): GeographyError => {
    try {
      mapDbError(e);
    } catch (err) {
      return err as GeographyError;
    }
    throw new Error('mapDbError did not throw');
  };
  const guard = (key: string, message = 'a message that names geography.address_formats and user text Secret-123') => ({
    code: '23000',
    message,
    detail: `geography_rule:${key}`,
  });

  it('maps the exclusion constraint on overlapping published periods to CONFLICT FORMAT_PERIOD_OVERLAP', () => {
    const e = map({
      code: '23P01',
      constraint: 'ex_address_formats__no_overlap',
      detail: 'Key (country_id, tstzrange)=(...) conflicts with existing key',
      message: 'conflicting key value violates exclusion constraint',
    });
    expect(e).toBeInstanceOf(GeographyError);
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ reason: 'FORMAT_PERIOD_OVERLAP' });
    expect(e.message).toBe('another address format of the country is in force during that period');
  });
  it('maps any other exclusion constraint to a generic CONFLICT carrying the constraint name', () => {
    const e = map({ code: '23P01', constraint: 'ex_something_else' });
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toEqual({ constraint: 'ex_something_else' });
    expect(map({ code: '23P01' }).code).toBe('CONFLICT');
  });
  it('maps the label foreign key to VALIDATION_FAILED UNKNOWN_CONTENT_KEY, without driver text', () => {
    const e = map({
      code: '23503',
      constraint: 'fk_address_format_fields__label_key',
      detail: 'Key (content_label_key)=(address.field.secret) is not present in table "entries".',
    });
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details).toEqual({ reason: 'UNKNOWN_CONTENT_KEY' });
    expect(JSON.stringify([e.message, e.details])).not.toContain('address.field.secret');
  });
  it('maps an unrelated foreign key to the generic message, naming the constraint only', () => {
    expect(map({ code: '23503', constraint: 'fk_addresses__format' })).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { constraint: 'fk_addresses__format' },
    });
  });
  it('maps a published, immutable format or address row to INVALID_STATE with the single FORMAT_IMMUTABLE reason', () => {
    for (const key of ['FORMAT_NOT_DRAFT', 'FORMAT_MUST_START_AS_DRAFT', 'FORMAT_STATUS_TRANSITION', 'FORMAT_IMMUTABLE']) {
      const e = map(guard(key));
      expect(e, key).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'FORMAT_IMMUTABLE' } });
      expect(e.message).toBe('a published address format is immutable; create a new version');
    }
  });
  it('maps an unpublished format reference to INVALID_STATE FORMAT_NOT_PUBLISHED', () => {
    expect(map(guard('FORMAT_NOT_PUBLISHED'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'FORMAT_NOT_PUBLISHED' } });
  });
  it('maps an unpublishable format definition to VALIDATION_FAILED with the key as reason', () => {
    for (const key of ['FORMAT_INCOMPLETE', 'FORMAT_TEMPLATE_MISMATCH', 'LOOKUP_WITHOUT_AREAS']) {
      expect(map(guard(key)), key).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: key } });
    }
  });
  it('maps an inactive area to VALIDATION_FAILED AREA_NOT_ACTIVE', () => {
    expect(map(guard('AREA_NOT_ACTIVE'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'AREA_NOT_ACTIVE' } });
  });
  it('maps immutable and undeletable address-model rows to the IMMUTABLE reason', () => {
    for (const key of ['IMMUTABLE_IDENTITY', 'NOT_DELETABLE', 'ROW_IMMUTABLE'])
      expect(map(guard(key)), key).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'IMMUTABLE' } });
  });
  it('keeps the existing TIME_ZONE_NOT_ACTIVE key (an address time zone must be ACTIVE) as an INVALID_STATE reason', () => {
    expect(map(guard('TIME_ZONE_NOT_ACTIVE'))).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'TIME_ZONE_NOT_ACTIVE' } });
  });
  it('never echoes the driver message, table names or user text, whatever the key', () => {
    for (const key of ['FORMAT_NOT_PUBLISHED', 'FORMAT_IMMUTABLE', 'FORMAT_INCOMPLETE', 'AREA_NOT_ACTIVE', 'ROW_IMMUTABLE', 'NOT_A_KNOWN_KEY']) {
      const e = map(guard(key));
      expect(`${e.message} ${JSON.stringify(e.details)}`, key).not.toMatch(/Secret-123|geography\.address_formats/);
    }
  });
  it('classifies by the exact detail only: an unknown key or decorated detail becomes the generic INVALID_STATE', () => {
    expect(map(guard('NOT_A_KNOWN_KEY'))).toMatchObject({ code: 'INVALID_STATE', message: 'the operation violates a geography integrity rule' });
    expect(map({ code: '23000', message: 'x', detail: 'geography_rule:FORMAT_IMMUTABLE and more' }).details).toEqual({});
    expect(map({ code: '23000', message: 'x', detail: 'geography_rule:format_immutable' }).details).toEqual({});
    expect(map({ code: '23000', message: 'x' }).details).toEqual({});
  });
  it('passes an already typed GeographyError through unchanged', () => {
    const typed = new GeographyError('ADDRESS_FORMAT_NOT_FOUND', 'no format', { code: 'US' });
    expect(map(typed)).toBe(typed);
  });
});

// ---------------------------------------------------------------- requests rejected before the database is touched
describe('AddressService: rejections that never reach the database', () => {
  const reject = async (p: Promise<unknown>): Promise<GeographyError> => {
    try {
      await p;
    } catch (err) {
      return err as GeographyError;
    }
    throw new Error('expected a rejection');
  };
  const draft = (over: Record<string, unknown> = {}) => ({
    displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY}',
    fields: [
      { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 },
      { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60 },
    ],
    reason: 'add a format',
    ...over,
  });
  const fieldsOf = (...fields: Record<string, unknown>[]) => draft({ fields });
  const line1 = { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 };
  const withTemplate = (displayTemplate: string, ...fields: Record<string, unknown>[]) => draft({ displayTemplate, fields });

  describe('createFormatDraft', () => {
    const create = (request: unknown) => service().createFormatDraft('US', request, 'actor-1');
    const reasonOf = async (request: unknown) => (await reject(create(request))).details;

    it('rejects a malformed request with VALIDATION_FAILED and the paths of the problems only', async () => {
      const e = await reject(create({ displayTemplate: '', fields: [], reason: '' }));
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', message: 'the address format request is not well formed' });
      const issues = e.details.issues as { path: string; message: string }[];
      expect([...new Set(issues.map((i) => i.path))].sort()).toEqual(['displayTemplate', 'fields', 'reason']);
    });
    it('rejects non-object requests and unknown keys', async () => {
      for (const bad of [null, undefined, 'x', 7, [], draft({ extra: true })]) expect((await reject(create(bad))).code, String(bad)).toBe('VALIDATION_FAILED');
    });
    it('rejects a duplicated field type', async () => {
      expect(await reasonOf(fieldsOf(line1, line1))).toEqual({ reason: 'DUPLICATE_FIELD', field: 'fields' });
    });
    it('rejects a format without a required ADDRESS_LINE_1', async () => {
      expect(
        await reasonOf(withTemplate('{LOCALITY}', { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60 })),
      ).toEqual({ reason: 'ADDRESS_LINE_1_REQUIRED', field: 'fields' });
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1}', { ...line1, required: false }))).toEqual({ reason: 'ADDRESS_LINE_1_REQUIRED', field: 'fields' });
    });
    it('rejects a template that does not match the fields', async () => {
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1}\n{LOCALITY}', line1))).toMatchObject({ reason: 'INVALID_TEMPLATE', field: 'displayTemplate' });
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1} {ADDRESS_LINE_1}', line1))).toMatchObject({ reason: 'INVALID_TEMPLATE' });
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1} }', line1))).toMatchObject({ reason: 'INVALID_TEMPLATE' });
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1}\t', line1))).toMatchObject({ reason: 'INVALID_TEMPLATE' });
    });
    it('rejects a LOOKUP on any field but ADMINISTRATIVE_AREA, and a lookup with a pattern or normalization', async () => {
      expect((await reasonOf(withTemplate('{ADDRESS_LINE_1}', { ...line1, inputType: 'LOOKUP' }))).reason).toBe('INVALID_LOOKUP_FIELD');
      const area = { fieldType: 'ADMINISTRATIVE_AREA', contentLabelKey: 'address.field.state', required: false, maxLength: 50, inputType: 'LOOKUP' };
      const t = '{ADDRESS_LINE_1} {ADMINISTRATIVE_AREA}';
      expect(await reasonOf(withTemplate(t, line1, { ...area, validationPattern: '[A-Z]+' }))).toEqual({ reason: 'INVALID_LOOKUP_FIELD', field: 'fields.1' });
      expect((await reasonOf(withTemplate(t, line1, { ...area, normalization: 'UPPERCASE' }))).reason).toBe('INVALID_LOOKUP_FIELD');
    });
    it('rejects an unsafe or invalid validation pattern, naming the field', async () => {
      for (const validationPattern of ['(a+)+$', '(a)\\1', '(?<=a)b', '([a-z']) {
        const d = await reasonOf(withTemplate('{ADDRESS_LINE_1}', { ...line1, validationPattern }));
        expect(d, validationPattern).toEqual({ reason: 'UNSAFE_PATTERN', field: 'fields.0.validationPattern' });
      }
    });
    it('rejects an example that does not match its pattern, and one longer than the maximum', async () => {
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1}', { ...line1, validationPattern: '[0-9]{5}', example: 'abc' }))).toEqual({
        reason: 'EXAMPLE_DOES_NOT_MATCH',
        field: 'fields.0.example',
      });
      expect(await reasonOf(withTemplate('{ADDRESS_LINE_1}', { ...line1, maxLength: 3, example: 'abcd' }))).toEqual({
        reason: 'EXAMPLE_TOO_LONG',
        field: 'fields.0.example',
      });
    });
    it('counts the example length in code points', async () => {
      const d = withTemplate('{ADDRESS_LINE_1}', { ...line1, maxLength: 3, example: '😀😀😀' });
      await expect(create(d)).rejects.toThrow('the database was touched'); // accepted by every check, then reached the database
    });
    it('never echoes the rejected pattern or example in the error', async () => {
      const e = await reject(create(withTemplate('{ADDRESS_LINE_1}', { ...line1, validationPattern: '(secret+)+', example: 'secret' })));
      expect(JSON.stringify([e.message, e.details])).not.toContain('secret');
    });
    it('reaches the database only for a request that passed every check', async () => {
      await expect(create(draft())).rejects.toThrow('the database was touched');
      const lookup = { fieldType: 'ADMINISTRATIVE_AREA', contentLabelKey: 'address.field.state', required: true, maxLength: 50, inputType: 'LOOKUP' };
      await expect(create(withTemplate('{ADDRESS_LINE_1} {ADMINISTRATIVE_AREA}', line1, lookup))).rejects.toThrow('the database was touched');
      await expect(create(withTemplate('{ADDRESS_LINE_1}', { ...line1, validationPattern: '[0-9]{5}(-[0-9]{4})?', example: '12345' }))).rejects.toThrow(
        'the database was touched',
      );
    });
  });

  describe('publishFormat', () => {
    const publish = (version: number, request: unknown) => service().publishFormat('US', version, request, 'actor-1');

    it('rejects a malformed request before looking at the version', async () => {
      for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x', effectiveFrom: 'tomorrow' }, { reason: 'x', extra: 1 }, null]) {
        expect(await reject(publish(1, bad)), JSON.stringify(bad)).toMatchObject({
          code: 'VALIDATION_FAILED',
          message: 'the publication request is not well formed',
        });
      }
    });
    it('rejects an impossible version as ADDRESS_FORMAT_NOT_FOUND', async () => {
      for (const version of [0, -1, 1.5, Number.NaN, Infinity]) {
        expect(await reject(publish(version, { reason: 'go live' })), String(version)).toMatchObject({
          code: 'ADDRESS_FORMAT_NOT_FOUND',
          details: { version },
        });
      }
    });
    it('reaches the database for a valid version and request', async () => {
      await expect(publish(1, { reason: 'go live', effectiveFrom: '2026-07-01T00:00:00Z' })).rejects.toThrow('the database was touched');
    });
  });

  describe('upsertAdministrativeAreas', () => {
    const upsert = (request: unknown) => service().upsertAdministrativeAreas('US', request, 'actor-1');
    const area = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Area ${code}`, type: 'STATE', ...over });

    it('rejects a malformed request with the paths of the problems', async () => {
      const e = await reject(upsert({ areas: [{ code: 'ca', name: '', type: 'PLANET' }], reason: '' }));
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', message: 'the administrative areas request is not well formed' });
      const paths = (e.details.issues as { path: string }[]).map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['areas.0.code', 'areas.0.name', 'areas.0.type', 'reason']));
    });
    it('rejects an empty batch and one over 500 areas', async () => {
      expect((await reject(upsert({ areas: [], reason: 'seed' }))).code).toBe('VALIDATION_FAILED');
      const many = Array.from({ length: 501 }, (_, i) => area(`A${i}`));
      expect((await reject(upsert({ areas: many, reason: 'seed' }))).code).toBe('VALIDATION_FAILED');
    });
    it('rejects a repeated area code', async () => {
      const e = await reject(upsert({ areas: [area('CA'), area('NY'), area('CA', { name: 'Again' })], reason: 'seed' }));
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_AREA_CODE' } });
    });
    it('reaches the database for a valid batch of up to 500 areas', async () => {
      await expect(upsert({ areas: [area('CA'), area('NY', { parentCode: 'CA', displayOrder: 2, active: false })], reason: 'seed' })).rejects.toThrow(
        'the database was touched',
      );
      const many = Array.from({ length: 500 }, (_, i) => area(`A${i}`));
      await expect(upsert({ areas: many, reason: 'seed' })).rejects.toThrow('the database was touched');
    });
  });

  describe('country codes and inputs are checked before any read', () => {
    it('answers COUNTRY_NOT_FOUND for a malformed country code without reading (public and management)', async () => {
      for (const code of ['us', 'USA', '', 'U1', '  ']) {
        expect((await reject(service().getAddressFormat(code))).code, code).toBe('COUNTRY_NOT_FOUND');
        expect((await reject(service().getAddressFormat(code, { management: true }))).code, code).toBe('COUNTRY_NOT_FOUND');
        expect((await reject(service().listAdministrativeAreas(code))).code, code).toBe('COUNTRY_NOT_FOUND');
        expect((await reject(service().listAddressFormats(code))).code, code).toBe('COUNTRY_NOT_FOUND');
        expect((await reject(service().validatePostalCode(code, '12345'))).code, code).toBe('COUNTRY_NOT_FOUND');
      }
    });
    it('truncates a hostile country code in the error details', async () => {
      const e = await reject(service().getAddressFormat('x'.repeat(500)));
      expect(String(e.details.code).length).toBeLessThanOrEqual(8);
    });
    it('rejects a malformed address input as VALIDATION_FAILED with paths only, never the values', async () => {
      const marker = 'Zq9-MARKER-street';
      for (const bad of [
        null,
        'x',
        { countryCode: 'us' },
        { countryCode: 'US', addressLine1: 5 },
        { countryCode: 'US', addressLine3: marker },
        { countryCode: 'US', postalCode: marker.repeat(40) },
      ]) {
        const e = await reject(service().validateAddress(bad as never));
        expect(e).toMatchObject({ code: 'VALIDATION_FAILED', message: 'the address request is not well formed' });
        expect(JSON.stringify([e.message, e.details])).not.toContain('MARKER');
      }
      expect((await reject(service().formatAddress({ countryCode: 'us' } as never))).code).toBe('VALIDATION_FAILED');
    });
    it('reads for a well-formed input (any two upper-case letters pass the parse step)', async () => {
      // A syntactically valid code reaches the cache/database layer; the stub proves the read is attempted (and nothing is invented).
      await expect(service().validateAddress({ countryCode: 'US' })).rejects.toThrow('the database was touched');
    });
  });

  describe('suggestAddresses', () => {
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => spy.mockRestore());
    const provider = (impl: () => Promise<{ suggestionId: string; label: string }[]>) => ({ code: 'mock', suggest: impl, resolve: async () => null });

    it('rejects a malformed country code', async () => {
      expect((await reject(service().suggestAddresses('us', 'main'))).code).toBe('COUNTRY_NOT_FOUND');
    });
    it('is UNAVAILABLE (callers fall back to manual entry) when no provider is configured for the country', async () => {
      expect(await reject(service().suggestAddresses('US', 'main'))).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'NO_AUTOCOMPLETE_PROVIDER' } });
      const none = service({ providers: { autocomplete: () => undefined } });
      expect(await reject(none.suggestAddresses('US', 'main'))).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'NO_AUTOCOMPLETE_PROVIDER' } });
    });
    it('chooses the provider per country and returns its suggestions', async () => {
      const seen: string[] = [];
      const svc = service({
        providers: {
          autocomplete: (country) => {
            seen.push(country);
            return country === 'US' ? provider(async () => [{ suggestionId: 'p1', label: '1 Main St' }]) : undefined;
          },
        },
      });
      expect(await svc.suggestAddresses('US', 'main', { limit: 3, locale: 'en-US' })).toEqual([{ suggestionId: 'p1', label: '1 Main St' }]);
      await expect(svc.suggestAddresses('GB', 'main')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(seen).toEqual(['US', 'GB']);
    });
    it('passes the query to the provider as given', async () => {
      const received: unknown[] = [];
      const svc = service({ providers: { autocomplete: () => ({ code: 'mock', suggest: async (q) => (received.push(q), []), resolve: async () => null }) } });
      await svc.suggestAddresses('US', 'main st', { limit: 2, locale: 'es-US' });
      expect(received).toEqual([{ countryCode: 'US', text: 'main st', locale: 'es-US', limit: 2 }]);
    });
    it('turns a provider failure into UNAVAILABLE PROVIDER_UNAVAILABLE and logs no address text or error text', async () => {
      const svc = service({
        providers: {
          autocomplete: () =>
            provider(async () => {
              throw new Error('upstream said: 1600 Secret Street rejected');
            }),
        },
      });
      expect(await reject(svc.suggestAddresses('US', '1600 Secret Street'))).toMatchObject({
        code: 'UNAVAILABLE',
        details: { reason: 'PROVIDER_UNAVAILABLE' },
      });
      const logged = spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(logged).toContain('address provider unavailable');
      expect(logged).not.toMatch(/Secret|1600|upstream/);
    });
    it('turns a provider that never answers into PROVIDER_UNAVAILABLE after the configured deadline', async () => {
      const svc = service({ providerTimeoutMs: 20, providers: { autocomplete: () => provider(() => new Promise(() => undefined)) } });
      const started = Date.now();
      expect(await reject(svc.suggestAddresses('US', 'main'))).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'PROVIDER_UNAVAILABLE' } });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
