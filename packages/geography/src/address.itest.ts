// Integration tests of the address service: real PostgreSQL (isolated, migrated database: migration 0008 seeds the US areas and US address format v1), an
// in-memory ConfigCache fake, the real outbox table, and the deterministic provider mocks. Countries other than the US are created through the service with
// real ISO codes (and ZZ through allowTestKeys), so these tests also prove that a new country is DATA only: formats, areas and a readiness check, no code.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryConfigCache, type ConfigCache } from '@bananagig/configuration';
import {
  AddressFormatPublishedPayload,
  AdministrativeAreasUpdatedPayload,
  GEOGRAPHY_EVENTS,
  type AddressInput,
  type NormalizedAddressDto,
} from '@bananagig/contracts';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  AddressService,
  GeographyError,
  GeographyService,
  MockAddressAutocompleteProvider,
  MockGeocoder,
  ReadinessRegistry,
  createAddressFormatReadinessCheck,
  toAddressFormatDto,
  toAdministrativeAreaDto,
  type AddressServiceDeps,
  type GeocoderProvider,
  type MockPlace,
} from './index';

let iso: IsolatedDatabase;
let geo: GeographyService;
let addr: AddressService;
let seq = 0;
const ACTOR = 'admin-a';
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);
const mkGeo = (over: Partial<ConstructorParameters<typeof GeographyService>[0]> = {}) =>
  new GeographyService({ database: db(), env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry(), ...over });
const mkAddr = (over: Partial<AddressServiceDeps> = {}) => new AddressService({ database: db(), env: 'test', ...over });
const err = async (p: Promise<unknown>) => (await rejection(p)) as GeographyError | undefined;
const code = async (p: Promise<unknown>) => (await err(p))?.code;
const reason = async (p: Promise<unknown>) => (await err(p))?.details.reason;
const settled = <T>(p: Promise<T>): Promise<T | GeographyError> =>
  p.then(
    (v) => v,
    (e: unknown) => e as GeographyError,
  );
const outcomeOf = (r: unknown): string => (r instanceof Error ? `${(r as GeographyError).code}/${(r as GeographyError).details?.reason ?? ''}` : 'ok');

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  geo = mkGeo();
  addr = mkAddr();
});
afterAll(async () => {
  await iso?.drop();
});

// ---------------------------------------------------------------- fixtures
// Real ISO region codes the geography service accepts (each test takes its own, nothing is shared between tests).
const COUNTRY_CODES = [
  'MX',
  'BR',
  'DE',
  'ES',
  'FR',
  'IT',
  'NL',
  'SE',
  'DK',
  'CZ',
  'HU',
  'BG',
  'JP',
  'KR',
  'SG',
  'TH',
  'VN',
  'MY',
  'ID',
  'PL',
  'PT',
  'AT',
  'BE',
  'CH',
  'NO',
  'FI',
  'IE',
  'NZ',
  'AU',
  'AR',
  'CA',
  'IN',
  'ZA',
  'EG',
  'NG',
  'KE',
  'TR',
  'GR',
  'HR',
  'RO',
  'SK',
  'SI',
  'LT',
  'LV',
  'EE',
  'IS',
  'LU',
  'MT',
  'CY',
  'IL',
  'SA',
  'AE',
  'QA',
  'PH',
  'PK',
  'BD',
  'LK',
  'CL',
  'CO',
  'PE',
  'UY',
];
let nextCode = 0;
const takeCode = (): string => {
  const c = COUNTRY_CODES[nextCode++];
  if (!c) throw new Error('out of test country codes');
  return c;
};
const countryReq = (alpha2: string) => ({
  code: alpha2,
  alpha3: `${alpha2}X`,
  numeric: String(900 + ++seq),
  displayNameContentKey: 'geography.country.us.name',
  dialingCode: '+999',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  timeZones: ['America/Denver'],
  distanceUnit: 'KILOMETERS',
  firstDayOfWeek: 'MONDAY',
  dateFormat: 'DMY',
  timeFormat: '24_HOUR',
  reason: 'integration test',
});
const marketReq = (countryCode: string) => ({
  code: `devtest-m${++seq}`,
  name: 'Test Market Name',
  countryCode,
  defaultLocale: 'en-US',
  currencyCode: 'USD',
  defaultTimeZone: 'America/Denver',
  reason: 'integration test',
});
/** A new country: PLANNED, or ACTIVE through the real activation path. `via` is the GeographyService to use (share its cache with an address service when it matters). */
async function newCountry(o: { code?: string; active?: boolean; via?: GeographyService } = {}): Promise<string> {
  const c = o.code ?? takeCode();
  const s = o.via ?? geo;
  await s.createCountry(countryReq(c), ACTOR);
  if (o.active) await s.setCountryActive(c, true, 'activate for test', ACTOR);
  return c;
}

const LINE1 = { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 };
const LINE2 = { fieldType: 'ADDRESS_LINE_2', contentLabelKey: 'address.field.line2', required: false, maxLength: 100 };
const CITY = { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60 };
const AREA_LOOKUP = { fieldType: 'ADMINISTRATIVE_AREA', contentLabelKey: 'address.field.state', required: true, maxLength: 50, inputType: 'LOOKUP' };
const ZIP5 = {
  fieldType: 'POSTAL_CODE',
  contentLabelKey: 'address.field.postal_code',
  required: true,
  maxLength: 10,
  validationPattern: '[0-9]{5}',
  example: '12345',
};
/** A text-only format (street, city, five digit postal code): the smallest format a country can publish. */
const textFormat = (over: Record<string, unknown> = {}) => ({
  displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE}',
  fields: [LINE1, CITY, ZIP5],
  reason: 'integration test',
  ...over,
});
const publishReq = (over: Record<string, unknown> = {}) => ({ reason: 'go live', ...over });
const pub = (a: AddressService, countryCode: string, version: number, over: Record<string, unknown> = {}) =>
  a.publishFormat(countryCode, version, publishReq(over), ACTOR);
/** Drafts and publishes a text-only format (immediately in force). */
async function publishedTextFormat(countryCode: string, a: AddressService = addr, over: Record<string, unknown> = {}) {
  const d = await a.createFormatDraft(countryCode, textFormat(over), ACTOR);
  return pub(a, countryCode, d.version);
}

const MAIN: AddressInput = { countryCode: 'US', addressLine1: '123 Main St', locality: 'Irvine', administrativeArea: 'CA', postalCode: '92618' };
const place = (id: string, address: AddressInput, extra: Partial<MockPlace> = {}): MockPlace => ({
  id,
  countryCode: address.countryCode,
  label: `${address.addressLine1}, ${address.locality}`,
  address,
  ...extra,
});
const PLACES: MockPlace[] = [
  place('p-main', MAIN, { latitude: 33.6846, longitude: -117.8265, timeZone: 'America/Los_Angeles' }),
  place(
    'p-nozone',
    { ...MAIN, addressLine1: '500 Ocean Blvd', locality: 'Long Beach', postalCode: '90802' },
    { latitude: 33.7701, longitude: -118.1937, timeZone: 'Mars/Phobos' },
  ),
  place(
    'p-planned-zone',
    { ...MAIN, addressLine1: '9 Pine Rd', locality: 'Denver', administrativeArea: 'CO', postalCode: '80202' },
    { latitude: 39.7392, longitude: -104.9903, timeZone: 'Europe/London' },
  ),
  place('p-lat95', { ...MAIN, addressLine1: '95 North Pole Rd' }, { latitude: 95, longitude: 10, timeZone: 'America/Los_Angeles' }),
  place('p-lng181', { ...MAIN, addressLine1: '181 Dateline Rd' }, { latitude: 10, longitude: 181 }),
  place('p-nan', { ...MAIN, addressLine1: '0 Nowhere Rd' }, { latitude: Number.NaN, longitude: 10 }),
  place('p-badzip', { ...MAIN, addressLine1: '1 Bad Zip St', postalCode: '9261' }),
  place('p-foreign', { ...MAIN, addressLine1: '1 Foreign St', countryCode: 'CA' }, { countryCode: 'US' }), // listed for the US, resolved by the provider to ANOTHER country
  place('p-unlocated', { ...MAIN, addressLine1: '2 Unlocated St' }), // a place the geocoder knows no coordinates for
];
const providersFor = (autocomplete?: MockAddressAutocompleteProvider, geocoder?: GeocoderProvider) => ({
  ...(autocomplete ? { autocomplete: () => autocomplete } : {}),
  ...(geocoder ? { geocoder: () => geocoder } : {}),
});

const events = (type: string, countryCode?: string) =>
  q<{ payload_json: Record<string, unknown>; aggregate_type: string; aggregate_id: string; actor_type: string; actor_id: string; correlation_id: string }>(
    `SELECT payload_json, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id FROM integration.outbox_events
      WHERE event_type = $1 AND ($2::text IS NULL OR payload_json->>'countryCode' = $2) ORDER BY created_at, outbox_event_id`,
    [type, countryCode ?? null],
  );
const formatAudit = (countryCode: string) =>
  q<{
    action: string;
    actor: string;
    version: number;
    changes: Record<string, unknown> | null;
    reason: string;
    correlation_id: string;
    country_id: string | null;
  }>(
    `SELECT a.action, a.actor, f.version, a.changes, a.reason, a.correlation_id, a.country_id FROM geography.audit_events a
       JOIN geography.address_formats f ON f.address_format_id = a.address_format_id JOIN geography.countries c ON c.country_id = f.country_id
      WHERE c.iso_alpha2 = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [countryCode],
  );
const areaAudit = (countryCode: string) =>
  q<{ actor: string; changes: { added: string[]; updated: string[] }; reason: string; correlation_id: string }>(
    `SELECT a.actor, a.changes, a.reason, a.correlation_id FROM geography.audit_events a JOIN geography.countries c ON c.country_id = a.country_id
      WHERE c.iso_alpha2 = $1 AND a.action = 'COUNTRY_ADMINISTRATIVE_AREAS_UPDATED' ORDER BY a.occurred_at, a.audit_event_id`,
    [countryCode],
  );
const countRows = async (table: string): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);
const addressCount = () => countRows('geography.addresses');
const formatRows = (countryCode: string) =>
  q<{ version: number; status: string; effective_from: Date; effective_to: Date | null }>(
    `SELECT f.version, f.status, f.effective_from, f.effective_to FROM geography.address_formats f JOIN geography.countries c ON c.country_id = f.country_id
      WHERE c.iso_alpha2 = $1 ORDER BY f.version`,
    [countryCode],
  );
/** The published periods of a country form a chain: sorted by start, each ends where the next begins, only the last is open. */
async function expectConsistentPeriods(countryCode: string, expectedPublished: number): Promise<void> {
  const rows = (await formatRows(countryCode)).filter((r) => r.status === 'PUBLISHED').sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime());
  expect(rows).toHaveLength(expectedPublished);
  expect(rows.filter((r) => r.effective_to === null)).toHaveLength(1);
  expect(rows[rows.length - 1]!.effective_to).toBeNull();
  for (let i = 0; i + 1 < rows.length; i++) expect(rows[i]!.effective_to!.getTime()).toBe(rows[i + 1]!.effective_from.getTime());
  const overlapping = await q(
    `SELECT 1 FROM geography.address_formats a JOIN geography.address_formats b ON a.country_id = b.country_id AND a.address_format_id < b.address_format_id
      JOIN geography.countries c ON c.country_id = a.country_id
      WHERE c.iso_alpha2 = $1 AND a.status = 'PUBLISHED' AND b.status = 'PUBLISHED' AND tstzrange(a.effective_from, a.effective_to, '[)') && tstzrange(b.effective_from, b.effective_to, '[)')`,
    [countryCode],
  );
  expect(overlapping).toEqual([]);
}
/** Waits until at least `atLeast` sessions of this database are blocked on a lock. */
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
const geoGen = (cache: MemoryConfigCache) => cache.data.get('bg:test:geo:gen');
const addressKeys = (cache: MemoryConfigCache, countryCode: string) =>
  [...cache.data.keys()].filter((k) => k.startsWith(`bg:test:geo:v1:address:${countryCode}:`));

// ====================================================================== the active US format
describe('the seeded US format and areas through the service', () => {
  it('resolves the ACTIVE US format v1: five ordered fields, LOOKUP mode, ZIP example; the public view hides management fields', async () => {
    const f = await addr.getAddressFormat('US');
    expect(f).toMatchObject({ countryCode: 'US', version: 1, status: 'PUBLISHED', effectiveTo: null });
    expect(f.fields.map((x) => x.fieldType)).toEqual(['ADDRESS_LINE_1', 'ADDRESS_LINE_2', 'LOCALITY', 'ADMINISTRATIVE_AREA', 'POSTAL_CODE']);
    expect(f.fields.map((x) => x.displayOrder)).toEqual([1, 2, 3, 4, 5]);
    const dto = toAddressFormatDto(f, false);
    expect(dto).toMatchObject({ countryCode: 'US', version: 1, administrativeAreaMode: 'LOOKUP', postalCodeExample: '12345' });
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('displayTemplate');
    expect(dto.fields[3]).toMatchObject({ property: 'administrativeArea', inputType: 'LOOKUP', required: true, maxLength: 50, validationPattern: null });
    expect(dto.fields[4]).toMatchObject({ property: 'postalCode', validationPattern: '^[0-9]{5}(-[0-9]{4})?$', example: '12345', autocomplete: 'postal-code' });
    const mgmt = toAddressFormatDto(await addr.getAddressFormat('US', { management: true }), true);
    expect(mgmt).toMatchObject({
      status: 'PUBLISHED',
      effectiveTo: null,
      displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
    });
    expect(typeof mgmt.effectiveFrom).toBe('string');
  });

  it('every label key of the format is a managed content entry (labels resolve through the content service, not here)', async () => {
    const f = await addr.getAddressFormat('US');
    const keys = f.fields.map((x) => x.contentLabelKey);
    const found = await q<{ key: string }>('SELECT key FROM content.entries WHERE key = ANY($1::text[])', [keys]);
    expect(found.map((r) => r.key).sort()).toEqual([...keys].sort());
  });

  it('non-canonical or unknown countries are COUNTRY_NOT_FOUND; before the format starts there is no format in effect', async () => {
    for (const bad of ['us', 'USA', 'U', '', 'QQ']) expect(await code(addr.getAddressFormat(bad)), bad).toBe('COUNTRY_NOT_FOUND');
    expect(await code(addr.getAddressFormat('US', { at: new Date('2000-01-01T00:00:00Z') }))).toBe('ADDRESS_FORMAT_NOT_FOUND');
    expect(await addr.hasEffectiveFormat('US')).toBe(true);
    expect(await addr.hasEffectiveFormat('US', new Date('2000-01-01T00:00:00Z'))).toBe(false);
    expect(await addr.hasEffectiveFormat('QQ')).toBe(false);
  });

  it('lists the 51 US areas in picker order (by name), without management fields in the public view', async () => {
    const { mode, areas } = await addr.listAdministrativeAreas('US');
    expect(mode).toBe('LOOKUP');
    expect(areas).toHaveLength(51);
    expect(areas[0]).toMatchObject({ code: 'AL', name: 'Alabama' });
    expect(areas.map((a) => a.name)).toEqual([...areas.map((a) => a.name)].sort((a, b) => a.localeCompare(b, 'en')));
    expect(areas.find((a) => a.code === 'DC')).toMatchObject({ name: 'District of Columbia', type: 'DISTRICT' });
    expect(toAdministrativeAreaDto(areas[0]!, false)).toEqual({ code: 'AL', name: 'Alabama', type: 'STATE', parentCode: null, displayOrder: null });
    expect(toAdministrativeAreaDto(areas[0]!, true)).toHaveProperty('status', 'ACTIVE');
    expect(await code(addr.listAdministrativeAreas('QQ'))).toBe('COUNTRY_NOT_FOUND');
  });
});

// ====================================================================== validation and formatting
describe('validating and formatting a structured address (stateless)', () => {
  it('validates and normalizes a US address (whitespace collapsed, the state resolved by code or by name, case-insensitively)', async () => {
    const expected: NormalizedAddressDto = {
      countryCode: 'US',
      organization: null,
      addressLine1: '123 Main St',
      addressLine2: null,
      dependentLocality: null,
      locality: 'Irvine',
      administrativeAreaCode: 'CA',
      administrativeAreaName: 'California',
      postalCode: '92618',
      sortingCode: null,
    };
    const r = await addr.validateAddress(MAIN);
    expect(r.outcome).toMatchObject({ valid: true, issues: [], address: expected });
    expect(r.outcome.administrativeAreaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.format.version).toBe(1);
    expect((await addr.validateAddress({ ...MAIN, addressLine1: '  123 \u00A0 Main   St  ', administrativeArea: ' california ' })).outcome.address).toEqual(
      expected,
    );
    expect((await addr.validateAddress({ ...MAIN, administrativeArea: 'ca' })).outcome.address).toEqual(expected);
    expect((await addr.validateAddress({ ...MAIN, postalCode: '92618-1234', addressLine2: 'Apt 4' })).outcome.address).toMatchObject({
      postalCode: '92618-1234',
      addressLine2: 'Apt 4',
    });
  });

  it('reports an invalid ZIP, a missing street, an unknown state, a too long value, an unsupported field and bad characters, all at once and in format order, with the shared message keys', async () => {
    const zip = (await addr.validateAddress({ ...MAIN, postalCode: '9261' })).outcome;
    expect(zip).toMatchObject({ valid: false, address: null, administrativeAreaId: null });
    expect(zip.issues).toEqual([{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }]);
    expect((await addr.validateAddress({ ...MAIN, postalCode: 'ABCDE' })).outcome.issues.map((i) => i.code)).toEqual(['INVALID_FORMAT']);
    expect((await addr.validateAddress({ ...MAIN, postalCode: '92618-12' })).outcome.issues.map((i) => i.code)).toEqual(['INVALID_FORMAT']);
    const many = (
      await addr.validateAddress({
        countryCode: 'US',
        addressLine1: '   ',
        locality: 'x'.repeat(61),
        administrativeArea: 'Narnia',
        postalCode: '1',
        sortingCode: 'S1',
        organization: 'Acme',
      })
    ).outcome.issues;
    expect(many.map((i) => [i.field, i.code, i.messageKey])).toEqual([
      ['organization', 'UNSUPPORTED_FIELD', 'address.error.unsupported_field'],
      ['sortingCode', 'UNSUPPORTED_FIELD', 'address.error.unsupported_field'],
      ['addressLine1', 'REQUIRED', 'address.error.required'],
      ['locality', 'TOO_LONG', 'address.error.too_long'],
      ['administrativeArea', 'UNKNOWN_AREA', 'address.error.unknown_area'],
      ['postalCode', 'INVALID_FORMAT', 'address.error.invalid_format'],
    ]);
    expect((await addr.validateAddress({ ...MAIN, addressLine1: 'bell\u0007' })).outcome.issues).toEqual([
      { field: 'addressLine1', code: 'INVALID_CHARACTERS', messageKey: 'address.error.invalid_characters' },
    ]);
    // every message key exists as managed content
    const keys = [...new Set(many.map((i) => i.messageKey))];
    expect((await q('SELECT 1 FROM content.entries WHERE key = ANY($1::text[])', [keys])).length).toBe(keys.length);
  });

  it('rejects a malformed request (unknown property, over-long value, bad country code) with property names only', async () => {
    const e1 = await err(addr.validateAddress({ ...MAIN, bogus: 'x' } as unknown as AddressInput));
    expect([e1?.code, e1?.details.issues]).toEqual(['VALIDATION_FAILED', [{ path: '' }]]);
    const e2 = await err(addr.validateAddress({ ...MAIN, addressLine1: 'x'.repeat(501) }));
    expect([e2?.code, e2?.details.issues]).toEqual(['VALIDATION_FAILED', [{ path: 'addressLine1' }]]);
    expect(await code(addr.validateAddress({ ...MAIN, countryCode: 'us' }))).toBe('VALIDATION_FAILED');
    expect(await code(addr.validateAddress({ ...MAIN, countryCode: 'QQ' }))).toBe('COUNTRY_NOT_FOUND');
  });

  it('formats with the central formatter (template of the format version); an invalid address is VALIDATION_FAILED with issues and nothing typed', async () => {
    const f = await addr.formatAddress({ ...MAIN, addressLine2: 'Suite 5' });
    expect(f.formatted).toEqual({
      lines: ['123 Main St', 'Suite 5', 'Irvine, CA 92618'],
      text: '123 Main St\nSuite 5\nIrvine, CA 92618',
      singleLine: '123 Main St, Suite 5, Irvine, CA 92618',
      formatVersion: 1,
    });
    expect((await addr.formatAddress(MAIN)).formatted.lines).toEqual(['123 Main St', 'Irvine, CA 92618']); // the empty line 2 is dropped
    expect(f.address.administrativeAreaCode).toBe('CA');
    const e = await err(addr.formatAddress({ ...MAIN, postalCode: '9261' }));
    expect([e?.code, e?.details.issues]).toEqual([
      'VALIDATION_FAILED',
      [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }],
    ]);
    // the country line comes from the display-name port, in the requested locale
    const names = vi.fn(async (c: string, locale: string) => (c === 'US' ? `United States (${locale})` : null));
    const withCountry = mkAddr({ countryNames: names });
    expect((await withCountry.formatAddress(MAIN, { includeCountry: true })).formatted.lines.at(-1)).toBe('United States (en-US)');
    expect((await withCountry.formatAddress(MAIN, { includeCountry: true, locale: 'es-MX' })).formatted.lines.at(-1)).toBe('United States (es-MX)');
    expect((await withCountry.formatAddress(MAIN)).formatted.lines).toHaveLength(2);
    const broken = mkAddr({
      countryNames: async () => {
        throw new Error('content down');
      },
    });
    expect((await broken.formatAddress(MAIN, { includeCountry: true })).formatted.lines).toEqual(['123 Main St', 'Irvine, CA 92618']);
  });

  it('validates a single postal code with the same rule as the form (service areas, zones and reports)', async () => {
    expect(await addr.validatePostalCode('US', '92618')).toEqual({ ok: true, value: '92618' });
    expect(await addr.validatePostalCode('US', ' 92618-1234 ')).toEqual({ ok: true, value: '92618-1234' });
    expect(await addr.validatePostalCode('US', '9261')).toEqual({ ok: false, code: 'INVALID_FORMAT' });
    expect(await addr.validatePostalCode('US', '   ')).toEqual({ ok: false, code: 'REQUIRED' });
    expect(await addr.validatePostalCode('US', '1'.repeat(11))).toEqual({ ok: false, code: 'TOO_LONG' });
    expect(await code(addr.validatePostalCode('QQ', '12345'))).toBe('COUNTRY_NOT_FOUND');
  });
});

// ====================================================================== manual entry
describe('manual entry (no provider needed)', () => {
  it('stores UNVERIFIED/MANUAL with the raw input preserved, no location, and reads it back in process', async () => {
    const raw = { addressLine1: '  123   Main St ', locality: 'irvine', administrativeArea: 'ca', postalCode: '92618', note: 'typed by hand' };
    const created = await addr.createManualAddress({ ...MAIN, addressLine1: '  123   Main St ', locality: 'Irvine' }, { rawInput: raw });
    expect(created).toMatchObject({ validationStatus: 'UNVERIFIED', validationSource: 'MANUAL', formatVersion: 1, located: false });
    const stored = (await addr.getAddress(created.addressId))!;
    expect(stored).toMatchObject({
      addressId: created.addressId,
      address: {
        countryCode: 'US',
        addressLine1: '123 Main St',
        locality: 'Irvine',
        administrativeAreaCode: 'CA',
        administrativeAreaName: 'California',
        postalCode: '92618',
      },
      latitude: null,
      longitude: null,
      timeZone: null,
      formattedAddress: '123 Main St\nIrvine, CA 92618',
      validationStatus: 'UNVERIFIED',
      validationSource: 'MANUAL',
      providerCode: null,
      providerReference: null,
      formatVersion: 1,
    });
    expect(stored).not.toHaveProperty('rawInput'); // never in an ordinary response
    expect((await addr.getAddress(created.addressId, { includeRawInput: true }))!.rawInput).toEqual(raw);
    const row = (
      await q<{ location: unknown; time_zone_id: string | null; administrative_area_id: string | null; raw_input: unknown }>(
        'SELECT location, time_zone_id, administrative_area_id, raw_input FROM geography.addresses WHERE address_id = $1',
        [created.addressId],
      )
    )[0]!;
    expect(row.location).toBeNull();
    expect(row.administrative_area_id).not.toBeNull();
    // by default the raw input is what was submitted
    const dflt = await addr.createManualAddress({ ...MAIN, addressLine1: ' 7  Oak Ave ' });
    expect((await addr.getAddress(dflt.addressId, { includeRawInput: true }))!.rawInput).toMatchObject({ addressLine1: ' 7  Oak Ave ', countryCode: 'US' });
  });

  it('works with NO providers configured and when every provider fails (providers are never consulted for manual entry)', async () => {
    const auto = new MockAddressAutocompleteProvider(PLACES);
    const coder = new MockGeocoder(PLACES);
    auto.failing = true;
    coder.failing = true;
    const withFailing = mkAddr({ providers: providersFor(auto, coder) });
    for (const s of [addr, withFailing]) {
      const r = await s.createManualAddress(MAIN);
      expect([r.validationStatus, r.validationSource, r.located]).toEqual(['UNVERIFIED', 'MANUAL', false]);
    }
    expect(auto.calls).toEqual([]);
    expect(coder.calls).toEqual([]);
  });

  it('an invalid address is VALIDATION_FAILED with issues and stores nothing; an oversized raw input is refused', async () => {
    const before = await addressCount();
    const e = await err(addr.createManualAddress({ ...MAIN, postalCode: 'nope', locality: '' }));
    expect(e?.code).toBe('VALIDATION_FAILED');
    expect((e?.details.issues as { field: string; code: string }[]).map((i) => [i.field, i.code])).toEqual([
      ['locality', 'REQUIRED'],
      ['postalCode', 'INVALID_FORMAT'],
    ]);
    expect(await reason(addr.createManualAddress(MAIN, { rawInput: { note: 'x'.repeat(4001) } }))).toBe('RAW_INPUT_TOO_LARGE');
    expect(await addressCount()).toBe(before);
    // the largest raw input the table accepts (jsonb text of exactly 4000 characters) is stored whole
    const ok = await addr.createManualAddress(MAIN, { rawInput: { k: 'x'.repeat(3991) } });
    expect(((await addr.getAddress(ok.addressId, { includeRawInput: true }))!.rawInput as { k: string }).k).toHaveLength(3991);
    // jsonb text is longer than JSON.stringify (a space after each colon): between the two lengths the TABLE (not the service pre-check) refuses, still as a typed error
    const edge = await err(addr.createManualAddress(MAIN, { rawInput: { k: 'x'.repeat(3992) } }));
    expect(edge?.code).toBe('VALIDATION_FAILED');
    expect(await addressCount()).toBe(before + 1);
  });

  it('getAddress answers null for an unknown id or anything that is not a uuid', async () => {
    expect(await addr.getAddress('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await addr.getAddress('not-a-uuid')).toBeNull();
    expect(await addr.getAddress("1'; DROP TABLE geography.addresses; --")).toBeNull();
    expect(await addr.formatStoredAddress('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

// ====================================================================== mock autocomplete
describe('autocomplete through a provider port (mock)', () => {
  it('suggests, then stores a selected suggestion as FORMAT_VALID/AUTOCOMPLETE with the provider reference, never located and never verified', async () => {
    const auto = new MockAddressAutocompleteProvider(PLACES);
    const s = mkAddr({ providers: providersFor(auto) });
    expect(await s.suggestAddresses('US', '123 main')).toEqual([{ suggestionId: 'p-main', label: '123 Main St, Irvine' }]);
    expect(await s.suggestAddresses('US', '', { limit: 2 })).toHaveLength(2);
    expect(await s.suggestAddresses('US', 'no such street')).toEqual([]);
    const created = await s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-main', query: '123 ma' });
    expect(created).toMatchObject({ validationStatus: 'FORMAT_VALID', validationSource: 'AUTOCOMPLETE', formatVersion: 1, located: false });
    const stored = (await s.getAddress(created.addressId, { includeRawInput: true }))!;
    expect(stored).toMatchObject({
      address: { addressLine1: '123 Main St', locality: 'Irvine', administrativeAreaCode: 'CA', postalCode: '92618' },
      latitude: null, // the place has coordinates but a selection is not a geocode
      longitude: null,
      providerCode: 'mock',
      providerReference: 'p-main',
      validationStatus: 'FORMAT_VALID',
      validationSource: 'AUTOCOMPLETE',
    });
    expect(stored.rawInput).toMatchObject({ provider: 'mock', suggestionId: 'p-main', query: '123 ma', fields: { addressLine1: '123 Main St' } });
  });

  it('is UNAVAILABLE (callers fall back to manual entry) with no provider, with a failing provider and with a provider that never answers', async () => {
    const before = await addressCount();
    expect([await code(addr.suggestAddresses('US', 'x')), await reason(addr.suggestAddresses('US', 'x'))]).toEqual(['UNAVAILABLE', 'NO_AUTOCOMPLETE_PROVIDER']);
    expect(await reason(addr.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-main' }))).toBe('NO_AUTOCOMPLETE_PROVIDER');
    const auto = new MockAddressAutocompleteProvider(PLACES);
    const s = mkAddr({ providers: providersFor(auto) });
    auto.failing = true;
    expect([await code(s.suggestAddresses('US', 'x')), await reason(s.suggestAddresses('US', 'x'))]).toEqual(['UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
    expect([
      await code(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-main' })),
      await reason(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-main' })),
    ]).toEqual(['UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
    // the person is never blocked: manual entry still works
    expect((await s.createManualAddress(MAIN)).validationSource).toBe('MANUAL');
    const hanging = {
      code: 'slow',
      suggest: () => new Promise<never>(() => undefined),
      resolve: () => new Promise<never>(() => undefined),
    };
    const slow = mkAddr({ providers: { autocomplete: () => hanging }, providerTimeoutMs: 60 });
    const t0 = Date.now();
    expect(await reason(slow.suggestAddresses('US', 'x'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await reason(slow.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-main' }))).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await addressCount()).toBe(before + 1);
    expect(await code(addr.suggestAddresses('us', 'x'))).toBe('COUNTRY_NOT_FOUND');
  });

  it('rejects a suggestion that resolves to another country and a suggestion that fails the country format; nothing is stored', async () => {
    const before = await addressCount();
    const s = mkAddr({ providers: providersFor(new MockAddressAutocompleteProvider(PLACES)) });
    expect([
      await code(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-foreign' })),
      await reason(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-foreign' })),
    ]).toEqual(['VALIDATION_FAILED', 'UNKNOWN_SUGGESTION']);
    const bad = await err(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'p-badzip' }));
    expect([bad?.code, bad?.details.issues]).toEqual([
      'VALIDATION_FAILED',
      [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }],
    ]);
    expect(await addressCount()).toBe(before);
  });

  // a provider that ANSWERS null for an unknown suggestion is a caller error, distinct from an outage (callProvider reports ok:false for failures)
  it('an unknown suggestion id (the provider answers null) is VALIDATION_FAILED/UNKNOWN_SUGGESTION, not a provider outage', async () => {
    const s = mkAddr({ providers: providersFor(new MockAddressAutocompleteProvider(PLACES)) });
    expect(await reason(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 'nope' }))).toBe('UNKNOWN_SUGGESTION');
  });
});

// ====================================================================== mock geocoder
describe('geocoding through a provider port (mock)', () => {
  const geocoderService = (coder: GeocoderProvider) => mkAddr({ providers: providersFor(undefined, coder) });

  it('stores GEOCODED/GEOCODER with one geography point and a time zone that is an ACTIVE registered zone; latitude and longitude read back', async () => {
    const created = await geocoderService(new MockGeocoder(PLACES)).geocodeAndCreateAddress(MAIN);
    expect(created).toMatchObject({ validationStatus: 'GEOCODED', validationSource: 'GEOCODER', formatVersion: 1, located: true });
    const stored = (await addr.getAddress(created.addressId))!;
    expect(stored.latitude).toBeCloseTo(33.6846, 9);
    expect(stored.longitude).toBeCloseTo(-117.8265, 9);
    expect(stored).toMatchObject({
      timeZone: 'America/Los_Angeles',
      providerCode: 'mock',
      providerReference: 'p-main',
      validationStatus: 'GEOCODED',
      validationSource: 'GEOCODER',
    });
    const row = (
      await q<{ status: string; iana_name: string; kind: string; srid: number }>(
        `SELECT t.status, t.iana_name, GeometryType(a.location::geometry) AS kind, ST_SRID(a.location::geometry) AS srid
           FROM geography.addresses a JOIN geography.time_zones t ON t.time_zone_id = a.time_zone_id WHERE a.address_id = $1`,
        [created.addressId],
      )
    )[0]!;
    expect(row).toEqual({ status: 'ACTIVE', iana_name: 'America/Los_Angeles', kind: 'POINT', srid: 4326 });
    // the same address geocoded twice makes two immutable rows (enrichment inserts a new row)
    const again = await geocoderService(new MockGeocoder(PLACES)).geocodeAndCreateAddress(MAIN);
    expect(again.addressId).not.toBe(created.addressId);
  });

  it('drops a time zone that is unknown or not ACTIVE but keeps the located address', async () => {
    const coder = new MockGeocoder(PLACES);
    const s = geocoderService(coder);
    await q("INSERT INTO geography.time_zones (iana_name) VALUES ('Europe/London') ON CONFLICT DO NOTHING"); // registered PLANNED, not ACTIVE
    for (const id of ['p-nozone', 'p-planned-zone']) {
      const p = PLACES.find((x) => x.id === id)!;
      const created = await s.geocodeAndCreateAddress(p.address);
      expect(created).toMatchObject({ validationStatus: 'GEOCODED', located: true });
      const stored = (await addr.getAddress(created.addressId))!;
      expect([id, stored.timeZone]).toEqual([id, null]);
      expect(stored.latitude).toBeCloseTo(p.latitude!, 9);
    }
  });

  it('falls back to MANUAL/UNVERIFIED (no location, no provider code) for invalid coordinates, a failing geocoder, an unknown address and no geocoder at all', async () => {
    const coder = new MockGeocoder(PLACES);
    const s = geocoderService(coder);
    const manualShape = async (r: { addressId: string; validationStatus: string; validationSource: string; located: boolean }) => {
      const stored = (await addr.getAddress(r.addressId))!;
      return [r.validationStatus, r.validationSource, r.located, stored.latitude, stored.longitude, stored.providerCode, stored.timeZone];
    };
    const fallback = ['UNVERIFIED', 'MANUAL', false, null, null, null, null];
    for (const id of ['p-lat95', 'p-lng181', 'p-nan'])
      expect(await manualShape(await s.geocodeAndCreateAddress(PLACES.find((p) => p.id === id)!.address)), `coordinates of ${id}`).toEqual(fallback);
    expect(coder.calls).toHaveLength(3); // the provider was asked, its answer was unusable
    expect(await manualShape(await s.geocodeAndCreateAddress(PLACES.find((p) => p.id === 'p-unlocated')!.address))).toEqual(fallback); // not found
    expect(await manualShape(await s.geocodeAndCreateAddress({ ...MAIN, addressLine1: '77 Unknown Way' }))).toEqual(fallback);
    coder.failing = true;
    expect(await manualShape(await s.geocodeAndCreateAddress(MAIN))).toEqual(fallback); // provider down
    expect(await manualShape(await addr.geocodeAndCreateAddress(MAIN))).toEqual(fallback); // no provider configured
    const nullGeocoder: GeocoderProvider = { code: 'nullish', geocode: async () => null };
    expect(await manualShape(await geocoderService(nullGeocoder).geocodeAndCreateAddress(MAIN))).toEqual(fallback);
    const mkSlow = mkAddr({ providers: { geocoder: () => ({ code: 'slow', geocode: () => new Promise<never>(() => undefined) }) }, providerTimeoutMs: 60 });
    expect(await manualShape(await mkSlow.geocodeAndCreateAddress(MAIN))).toEqual(fallback); // provider timeout
    const rows = await q<{ n: string }>("SELECT count(*) AS n FROM geography.addresses WHERE validation_source = 'GEOCODER' AND location IS NULL");
    expect(rows[0]).toEqual({ n: '0' });
  });

  it('an invalid address never reaches the geocoder and is VALIDATION_FAILED', async () => {
    const coder = new MockGeocoder(PLACES);
    expect(await code(geocoderService(coder).geocodeAndCreateAddress({ ...MAIN, postalCode: 'bad' }))).toBe('VALIDATION_FAILED');
    expect(coder.calls).toEqual([]);
  });
});

// ====================================================================== format drafts and publication
describe('format drafts: validation and visibility', () => {
  it('creates a DRAFT version (audit row, NO event), invisible to the public view and visible to management', async () => {
    const c = await newCountry({ active: true });
    const eventsBefore = (await events(GEOGRAPHY_EVENTS.addressFormatPublished)).length;
    const cid = 'corr-draft-1';
    const d = await runWithCorrelation(cid, () => addr.createFormatDraft(c, textFormat(), ACTOR));
    expect(d).toMatchObject({ countryCode: c, version: 1, status: 'DRAFT', displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE}', effectiveTo: null });
    expect(d.fields.map((f) => [f.fieldType, f.displayOrder])).toEqual([
      ['ADDRESS_LINE_1', 1],
      ['LOCALITY', 2],
      ['POSTAL_CODE', 3],
    ]);
    expect(d.fields[2]).toMatchObject({ validationPattern: '[0-9]{5}', example: '12345', inputType: 'TEXT', normalization: null, autocomplete: null });
    expect(await code(addr.getAddressFormat(c))).toBe('ADDRESS_FORMAT_NOT_FOUND'); // a draft is not in force
    expect(await code(addr.getAddressFormat(c, { management: true }))).toBe('ADDRESS_FORMAT_NOT_FOUND');
    expect((await addr.listAddressFormats(c)).map((f) => [f.version, f.status])).toEqual([[1, 'DRAFT']]);
    expect(await addr.hasEffectiveFormat(c)).toBe(false);
    expect(await formatAudit(c)).toEqual([
      expect.objectContaining({
        action: 'ADDRESS_FORMAT_DRAFTED',
        actor: ACTOR,
        version: 1,
        changes: { version: [null, 1] },
        reason: 'integration test',
        correlation_id: cid,
        country_id: null,
      }),
    ]);
    expect((await events(GEOGRAPHY_EVENTS.addressFormatPublished)).length).toBe(eventsBefore);
    const second = await addr.createFormatDraft(c, textFormat(), ACTOR);
    expect(second.version).toBe(2);
  });

  it('refuses a malformed draft with a typed reason and writes nothing: duplicate field, missing required line 1, bad template, bad lookup, unsafe pattern, example problems, unknown label key', async () => {
    const c = await newCountry();
    const auditBefore = await countRows('geography.audit_events');
    const formatsBefore = await countRows('geography.address_formats');
    const dupAndLine1 = [
      ['DUPLICATE_FIELD', textFormat({ fields: [LINE1, CITY, ZIP5, LINE1] })],
      ['ADDRESS_LINE_1_REQUIRED', textFormat({ fields: [{ ...LINE1, required: false }, CITY, ZIP5] })],
      ['ADDRESS_LINE_1_REQUIRED', textFormat({ fields: [CITY, ZIP5], displayTemplate: '{LOCALITY} {POSTAL_CODE}' })],
      ['INVALID_TEMPLATE', textFormat({ displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY}' })], // POSTAL_CODE missing
      ['INVALID_TEMPLATE', textFormat({ displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE} {FOO}' })],
      ['INVALID_TEMPLATE', textFormat({ displayTemplate: '{ADDRESS_LINE_1}{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE}' })],
      ['INVALID_TEMPLATE', textFormat({ displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {POSTAL_CODE} }' })],
      ['INVALID_LOOKUP_FIELD', textFormat({ fields: [LINE1, { ...CITY, inputType: 'LOOKUP' }, ZIP5] })],
      ['INVALID_LOOKUP_FIELD', textFormat({ fields: [LINE1, CITY, { ...ZIP5, inputType: 'LOOKUP' }] })],
      ['UNSAFE_PATTERN', textFormat({ fields: [LINE1, CITY, { ...ZIP5, validationPattern: '(a+)+$', example: 'a' }] })],
      ['UNSAFE_PATTERN', textFormat({ fields: [LINE1, CITY, { ...ZIP5, validationPattern: '(a)\\1', example: undefined }] })],
      ['UNSAFE_PATTERN', textFormat({ fields: [LINE1, CITY, { ...ZIP5, validationPattern: '[', example: undefined }] })],
      ['EXAMPLE_DOES_NOT_MATCH', textFormat({ fields: [LINE1, CITY, { ...ZIP5, example: 'abcde' }] })],
      ['EXAMPLE_TOO_LONG', textFormat({ fields: [LINE1, CITY, { ...ZIP5, maxLength: 3 }] })],
      ['UNKNOWN_CONTENT_KEY', textFormat({ fields: [{ ...LINE1, contentLabelKey: 'address.field.nope' }, CITY, ZIP5] })],
    ] as const;
    for (const [expectedReason, body] of dupAndLine1) {
      const e = await err(addr.createFormatDraft(c, body, ACTOR));
      expect([e?.code, e?.details.reason], expectedReason).toEqual(['VALIDATION_FAILED', expectedReason]);
    }
    for (const bad of [
      { ...textFormat(), extra: 1 },
      textFormat({ reason: '   ' }),
      textFormat({ fields: [] }),
      textFormat({ effectiveFrom: 'tomorrow' }),
      textFormat({ displayTemplate: '' }),
    ])
      expect(await code(addr.createFormatDraft(c, bad, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(addr.createFormatDraft('QQ', textFormat(), ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(addr.createFormatDraft('mx', textFormat(), ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await countRows('geography.address_formats')).toBe(formatsBefore);
    expect(await countRows('geography.audit_events')).toBe(auditBefore);
  });

  it('a version that cannot be published as defined (LOOKUP without ACTIVE areas) stays a DRAFT and writes no audit row or event', async () => {
    const c = await newCountry();
    const d = await addr.createFormatDraft(
      c,
      textFormat({ fields: [LINE1, AREA_LOOKUP, CITY, ZIP5], displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}' }),
      ACTOR,
    );
    const e = await err(pub(addr, c, d.version));
    expect([e?.code, e?.details.reason]).toEqual(['VALIDATION_FAILED', 'LOOKUP_WITHOUT_AREAS']);
    expect((await formatRows(c)).map((r) => r.status)).toEqual(['DRAFT']);
    expect((await formatAudit(c)).map((a) => a.action)).toEqual(['ADDRESS_FORMAT_DRAFTED']);
    expect(await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).toHaveLength(0);
    await addr.upsertAdministrativeAreas(c, { areas: [{ code: 'P1', name: 'Province One', type: 'PROVINCE' }], reason: 'areas first' }, ACTOR);
    expect((await pub(addr, c, d.version)).status).toBe('PUBLISHED');
  });

  it('publishing an unknown version or country is typed; a malformed publication request is VALIDATION_FAILED', async () => {
    const c = await newCountry();
    await addr.createFormatDraft(c, textFormat(), ACTOR);
    for (const v of [2, 99, 0, -1, 1.5]) expect(await code(pub(addr, c, v)), `version ${v}`).toBe('ADDRESS_FORMAT_NOT_FOUND');
    expect(await code(pub(addr, 'QQ', 1))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(addr.publishFormat(c, 1, { reason: '' }, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(addr.publishFormat(c, 1, { reason: 'x', effectiveFrom: 'soon' }, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(addr.publishFormat(c, 1, { reason: 'x', extra: true }, ACTOR))).toBe('VALIDATION_FAILED');
    expect((await formatRows(c))[0]!.status).toBe('DRAFT');
  });
});

describe('format publication: audit, event, cache and idempotency', () => {
  it('writes one audit row and exactly one outbox event with the right payload, and bumps the cache generation after commit', async () => {
    const cache = new MemoryConfigCache();
    const a = mkAddr({ cache });
    const c = await newCountry();
    const d = await a.createFormatDraft(c, textFormat(), ACTOR);
    expect(geoGen(cache)).toBeUndefined(); // a draft is not public: no invalidation
    const cid = 'corr-publish-1';
    const published = await runWithCorrelation(cid, () => a.publishFormat(c, d.version, publishReq({ reason: 'the new format' }), 'publisher-1'));
    expect(published).toMatchObject({ version: 1, status: 'PUBLISHED', effectiveTo: null });
    const audit = await formatAudit(c);
    expect(audit.map((x) => x.action)).toEqual(['ADDRESS_FORMAT_DRAFTED', 'ADDRESS_FORMAT_PUBLISHED']);
    expect(audit[1]).toMatchObject({ actor: 'publisher-1', version: 1, reason: 'the new format', correlation_id: cid, country_id: null });
    expect(audit[1]!.changes).toEqual({ status: ['DRAFT', 'PUBLISHED'], effectiveFrom: [expect.any(String), published.effectiveFrom.toISOString()] });
    const ev = await events(GEOGRAPHY_EVENTS.addressFormatPublished, c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      aggregate_type: 'geography_address_format',
      aggregate_id: published.addressFormatId,
      actor_type: 'user',
      actor_id: 'publisher-1',
      correlation_id: cid,
    });
    expect(AddressFormatPublishedPayload.parse(ev[0]!.payload_json)).toEqual({
      countryCode: c,
      version: 1,
      effectiveFrom: published.effectiveFrom.toISOString(),
    });
    expect(Object.keys(ev[0]!.payload_json).sort()).toEqual(['countryCode', 'effectiveFrom', 'version']); // identifiers only, no address data
    expect(geoGen(cache)).toBe('1');
  });

  it('publishing an already published version is idempotent: same result, no second audit row, no second event, no cache bump', async () => {
    const cache = new MemoryConfigCache();
    const a = mkAddr({ cache });
    const c = await newCountry();
    const d = await a.createFormatDraft(c, textFormat(), ACTOR);
    const first = await pub(a, c, d.version);
    const gen = geoGen(cache);
    const second = await pub(a, c, d.version, { effectiveFrom: '2099-01-01T00:00:00Z' }); // a different request changes nothing
    expect(second).toEqual(first);
    expect((await formatAudit(c)).filter((x) => x.action === 'ADDRESS_FORMAT_PUBLISHED')).toHaveLength(1);
    expect(await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).toHaveLength(1);
    expect(geoGen(cache)).toBe(gen);
    await expectConsistentPeriods(c, 1);
  });

  it('a successor closes the open predecessor in the same transaction (audit and event per version, one open format)', async () => {
    const c = await newCountry();
    const v1 = await publishedTextFormat(c);
    const d2 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{ADDRESS_LINE_1} / {LOCALITY} / {POSTAL_CODE}' }), ACTOR);
    const v2 = await pub(addr, c, d2.version);
    const rows = await formatRows(c);
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, 'PUBLISHED'],
      [2, 'PUBLISHED'],
    ]);
    expect(rows[0]!.effective_to!.getTime()).toBe(v2.effectiveFrom.getTime());
    expect(rows[1]!.effective_to).toBeNull();
    expect(v2.effectiveFrom.getTime()).toBeGreaterThan(v1.effectiveFrom.getTime());
    expect((await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).map((e) => e.payload_json.version)).toEqual([1, 2]);
    expect((await formatAudit(c)).filter((x) => x.action === 'ADDRESS_FORMAT_PUBLISHED').map((x) => x.version)).toEqual([1, 2]);
    await expectConsistentPeriods(c, 2);
    expect((await addr.getAddressFormat(c, { management: true })).version).toBe(2);
  });
});

// ====================================================================== effective dating
describe('effective dating', () => {
  it('a future effectiveFrom starts v2 at that instant and closes v1 exactly there (half-open): before = v1, the very instant = v2', async () => {
    const c = await newCountry({ active: true });
    const v1 = await publishedTextFormat(c);
    const start = new Date(Date.now() + 3_600_000);
    const d2 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{ADDRESS_LINE_1} / {LOCALITY} / {POSTAL_CODE}' }), ACTOR);
    const v2 = await pub(addr, c, d2.version, { effectiveFrom: start.toISOString() });
    expect(v2.effectiveFrom).toEqual(start);
    const list = await addr.listAddressFormats(c);
    expect(list.map((f) => [f.version, f.effectiveFrom.toISOString(), f.effectiveTo?.toISOString() ?? null])).toEqual([
      [2, start.toISOString(), null],
      [1, v1.effectiveFrom.toISOString(), start.toISOString()],
    ]);
    const at = (d: Date, management = false) => addr.getAddressFormat(c, { at: d, management });
    for (const management of [false, true]) {
      expect((await at(new Date(start.getTime() - 3_600_000), management)).version, 'long before').toBe(1);
      expect((await at(new Date(start.getTime() - 1), management)).version, '1 ms before').toBe(1);
      expect((await at(start, management)).version, 'the instant').toBe(2);
      expect((await at(new Date(start.getTime() + 1), management)).version, '1 ms after').toBe(2);
      expect((await at(new Date(start.getTime() + 86_400_000), management)).version, 'a day after').toBe(2);
      expect((await addr.getAddressFormat(c, { management })).version, 'now (v2 is still in the future)').toBe(1);
      expect(await code(at(new Date(v1.effectiveFrom.getTime() - 1), management)), 'before v1').toBe('ADDRESS_FORMAT_NOT_FOUND');
    }
    // the validators, the area list mode and the readiness read use the same window
    expect(
      (await addr.validateAddress({ countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' }, { at: start })).format.version,
    ).toBe(2);
    expect((await addr.validateAddress({ countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' })).format.version).toBe(1);
    expect((await addr.formatAddress({ countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' }, { at: start })).formatted.text).toBe(
      '1 Elm St / Town / 12345',
    );
    expect((await addr.formatAddress({ countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' })).formatted.text).toBe(
      '1 Elm St\nTown 12345',
    );
    expect((await addr.listAdministrativeAreas(c, { at: start })).mode).toBe('NONE');
    expect(await addr.hasEffectiveFormat(c, start)).toBe(true);
    expect(await addr.hasEffectiveFormat(c, new Date(start.getTime() - 1))).toBe(true);
    // a fixed clock: the service evaluates "now" through its injected clock
    const later = mkAddr({ now: () => new Date(start.getTime() + 5) });
    expect((await later.getAddressFormat(c)).version).toBe(2);
    await expectConsistentPeriods(c, 2);
  });

  it('a draft proposed for the future keeps its start at publication; a request in the past is raised to the publication instant', async () => {
    const c = await newCountry();
    const future = new Date(Date.now() + 2 * 3_600_000);
    const d = await addr.createFormatDraft(c, textFormat({ effectiveFrom: future.toISOString() }), ACTOR);
    expect(d.effectiveFrom).toEqual(future);
    expect((await pub(addr, c, d.version)).effectiveFrom).toEqual(future); // the draft's own start wins over "now"
    const c2 = await newCountry();
    const d2 = await addr.createFormatDraft(c2, textFormat(), ACTOR);
    const before = Date.now() - 1000; // the database clock may differ by clock rounding
    const p2 = await pub(addr, c2, d2.version, { effectiveFrom: '2001-01-01T00:00:00Z' });
    expect(p2.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before);
    expect(p2.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('START_NOT_AFTER_CURRENT: a successor must start strictly after the format in force (retryable conflict, nothing written); one millisecond later is fine', async () => {
    const c = await newCountry();
    const v1 = await pub(
      addr,
      c,
      (await addr.createFormatDraft(c, textFormat({ effectiveFrom: new Date(Date.now() + 2 * 3_600_000).toISOString() }), ACTOR)).version,
    );
    expect(await addr.hasEffectiveFormat(c)).toBe(false); // the only format starts in the future
    expect(await addr.hasEffectiveFormat(c, new Date(v1.effectiveFrom.getTime() + 1))).toBe(true);
    const d2 = await addr.createFormatDraft(c, textFormat(), ACTOR);
    const auditBefore = (await formatAudit(c)).length;
    const eventsBefore = (await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).length;
    for (const over of [{}, { effectiveFrom: v1.effectiveFrom.toISOString() }, { effectiveFrom: new Date(v1.effectiveFrom.getTime() - 1000).toISOString() }]) {
      const e = await err(pub(addr, c, d2.version, over));
      expect([e?.code, e?.details.reason, e?.details.retryable], JSON.stringify(over)).toEqual(['CONFLICT', 'START_NOT_AFTER_CURRENT', true]);
    }
    expect((await formatRows(c)).map((r) => [r.version, r.status, r.effective_to])).toEqual([
      [1, 'PUBLISHED', null],
      [2, 'DRAFT', null],
    ]);
    expect((await formatAudit(c)).length).toBe(auditBefore);
    expect((await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).length).toBe(eventsBefore);
    const v2 = await pub(addr, c, d2.version, { effectiveFrom: new Date(v1.effectiveFrom.getTime() + 1).toISOString() });
    expect(v2.effectiveFrom.getTime()).toBe(v1.effectiveFrom.getTime() + 1);
    expect((await formatRows(c))[0]!.effective_to!.getTime()).toBe(v1.effectiveFrom.getTime() + 1);
    await expectConsistentPeriods(c, 2);
  });
});

// ====================================================================== a persisted address keeps its format version
describe('a stored address keeps the format version it was validated with', () => {
  it('formatStoredAddress uses the OLD template after a newer format is published; the stored formatted_address never changes', async () => {
    const c = await newCountry({ active: true });
    const v1 = await publishedTextFormat(c);
    const input: AddressInput = { countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' };
    const old = await addr.createManualAddress(input);
    expect(old.formatVersion).toBe(1);
    const storedBefore = (
      await q<{ formatted_address: string; address_format_id: string }>(
        'SELECT formatted_address, address_format_id FROM geography.addresses WHERE address_id = $1',
        [old.addressId],
      )
    )[0]!;
    expect(storedBefore).toEqual({ formatted_address: '1 Elm St\nTown 12345', address_format_id: v1.addressFormatId });

    const d2 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{POSTAL_CODE} - {LOCALITY} - {ADDRESS_LINE_1}' }), ACTOR);
    const v2 = await pub(addr, c, d2.version);

    expect((await addr.getAddress(old.addressId))!.formatVersion).toBe(1);
    expect(await addr.formatStoredAddress(old.addressId)).toEqual({
      lines: ['1 Elm St', 'Town 12345'],
      text: '1 Elm St\nTown 12345',
      singleLine: '1 Elm St, Town 12345',
      formatVersion: 1,
    });
    expect(
      (
        await q<{ formatted_address: string; address_format_id: string }>(
          'SELECT formatted_address, address_format_id FROM geography.addresses WHERE address_id = $1',
          [old.addressId],
        )
      )[0],
    ).toEqual(storedBefore);
    // the old format row is closed but still the one the address points at
    expect((await formatRows(c))[0]!.effective_to).not.toBeNull();

    const fresh = await addr.createManualAddress(input);
    expect(fresh.formatVersion).toBe(2);
    expect((await addr.getAddress(fresh.addressId))!.formattedAddress).toBe('12345 - Town - 1 Elm St');
    expect((await addr.formatStoredAddress(fresh.addressId))!.formatVersion).toBe(2);
    expect(
      (await q<{ address_format_id: string }>('SELECT address_format_id FROM geography.addresses WHERE address_id = $1', [fresh.addressId]))[0]!
        .address_format_id,
    ).toBe(v2.addressFormatId);
    // the country line is added on request, in the requested locale
    const names = mkAddr({ countryNames: async (cc, locale) => `Country ${cc} ${locale}` });
    expect((await names.formatStoredAddress(old.addressId, { includeCountry: true, locale: 'fr-CA' }))!.lines).toEqual([
      '1 Elm St',
      'Town 12345',
      `Country ${c} fr-CA`,
    ]);
  });

  it('the stored administrative area keeps its code and the name it was accepted with when the area is renamed or retired later', async () => {
    const c = await newCountry({ active: true });
    await addr.upsertAdministrativeAreas(
      c,
      {
        areas: [
          { code: 'P1', name: 'Old Name', type: 'PROVINCE' },
          { code: 'P2', name: 'Second', type: 'PROVINCE' },
        ],
        reason: 'seed areas',
      },
      ACTOR,
    );
    await publishedTextFormat(c, addr, {
      fields: [LINE1, AREA_LOOKUP, CITY, ZIP5],
      displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
    });
    const input: AddressInput = { countryCode: c, addressLine1: '1 Elm St', locality: 'Town', administrativeArea: 'p1', postalCode: '12345' };
    const created = await addr.createManualAddress(input);
    await addr.upsertAdministrativeAreas(c, { areas: [{ code: 'P1', name: 'New Name', type: 'PROVINCE', active: false }], reason: 'rename and retire' }, ACTOR);
    expect((await addr.getAddress(created.addressId))!.address).toMatchObject({ administrativeAreaCode: 'P1', administrativeAreaName: 'Old Name' });
    // a retired area no longer validates (public read), a renamed one is found under its code
    expect((await addr.validateAddress(input)).outcome.issues.map((i) => i.code)).toEqual(['UNKNOWN_AREA']);
    expect((await addr.validateAddress({ ...input, administrativeArea: 'P2' })).outcome.address!.administrativeAreaName).toBe('Second');
  });
});

// ====================================================================== cache
describe('cache: hits, invalidation, degradation', () => {
  it('serves public reads from the cache (key under bg:test:geo:v1:address:<CC>), and a format publication or an area upsert shows new data on the next read', async () => {
    const cache = new MemoryConfigCache();
    const a = mkAddr({ cache });
    const c = await newCountry({ active: true, via: mkGeo({ cache }) });
    await publishedTextFormat(c, a);
    const gen0 = geoGen(cache);
    expect((await a.getAddressFormat(c)).version).toBe(1);
    expect(addressKeys(cache, c)).toHaveLength(1);
    expect(addressKeys(cache, c)[0]).toMatch(new RegExp(`^bg:test:geo:v1:address:${c}:${gen0}\\.0$`));
    // a change made behind the service's back is NOT seen (proves the second read came from the cache) ...
    await q(
      `INSERT INTO geography.administrative_areas (country_id, code, name, area_type) SELECT country_id, 'ZQ', 'Behind The Back', 'PROVINCE' FROM geography.countries WHERE iso_alpha2 = $1`,
      [c],
    );
    expect((await a.listAdministrativeAreas(c)).areas).toEqual([]);
    expect((await a.listAdministrativeAreas(c, { management: true })).areas.map((x) => x.code)).toEqual(['ZQ']); // management bypasses the cache
    // ... until a service write bumps the generation
    await a.upsertAdministrativeAreas(c, { areas: [{ code: 'ZR', name: 'Through The Service', type: 'PROVINCE' }], reason: 'visible' }, ACTOR);
    expect(geoGen(cache)).not.toBe(gen0);
    expect((await a.listAdministrativeAreas(c)).areas.map((x) => x.code)).toEqual(['ZQ', 'ZR']); // by name: Behind The Back, Through The Service
    // publication of v2: hit, publish, new read shows the new version
    expect((await a.getAddressFormat(c)).version).toBe(1);
    const gen1 = geoGen(cache);
    const d2 = await a.createFormatDraft(c, textFormat({ displayTemplate: '{ADDRESS_LINE_1} | {LOCALITY} | {POSTAL_CODE}' }), ACTOR);
    expect(geoGen(cache)).toBe(gen1); // drafts do not invalidate
    await pub(a, c, d2.version);
    expect(geoGen(cache)).not.toBe(gen1);
    const v = await a.getAddressFormat(c);
    expect([v.version, v.displayTemplate]).toEqual([2, '{ADDRESS_LINE_1} | {LOCALITY} | {POSTAL_CODE}']);
  });

  it('an idempotent area upsert does not bump the generation, a changing one does, and GeographyService country writes bump it too', async () => {
    const cache = new MemoryConfigCache();
    const a = mkAddr({ cache });
    const g = mkGeo({ cache });
    const c = await newCountry({ active: true, via: g });
    const body = { areas: [{ code: 'P1', name: 'One', type: 'PROVINCE' }], reason: 'x' };
    await a.upsertAdministrativeAreas(c, body, ACTOR);
    const gen = geoGen(cache);
    await a.upsertAdministrativeAreas(c, body, ACTOR);
    expect(geoGen(cache)).toBe(gen);
    await a.upsertAdministrativeAreas(c, { areas: [{ code: 'P1', name: 'Uno', type: 'PROVINCE' }], reason: 'rename' }, ACTOR);
    expect(geoGen(cache)).not.toBe(gen);
    const gen2 = geoGen(cache);
    await g.updateCountry(c, { dialingCode: '+777', reason: 'country change' }, ACTOR);
    expect(geoGen(cache)).not.toBe(gen2);
  });

  it('never caches a miss or a PLANNED country, and management reads do not touch the cache; a poisoned or malformed entry is a miss', async () => {
    const cache = new MemoryConfigCache();
    const a = mkAddr({ cache });
    const planned = await newCountry({ via: mkGeo({ cache }) });
    await publishedTextFormat(planned, a);
    expect(await code(a.getAddressFormat(planned))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.getAddressFormat('QQ'))).toBe('COUNTRY_NOT_FOUND');
    expect(addressKeys(cache, planned)).toEqual([]);
    expect([...cache.data.keys()].filter((k) => k.includes(':address:'))).toEqual([]);
    expect((await a.getAddressFormat(planned, { management: true })).version).toBe(1);
    await a.listAdministrativeAreas(planned, { management: true });
    await a.listAddressFormats(planned);
    expect([...cache.data.keys()].filter((k) => k.includes(':address:'))).toEqual([]);
    // a poisoned entry reaches the public view only
    await a.getAddressFormat('US');
    const key = addressKeys(cache, 'US')[0]!;
    const poisoned = JSON.parse(cache.data.get(key)!);
    poisoned.v.formats[0].displayTemplate = '{ADDRESS_LINE_1}';
    cache.data.set(key, JSON.stringify(poisoned));
    expect((await a.getAddressFormat('US')).displayTemplate).toBe('{ADDRESS_LINE_1}');
    expect((await a.getAddressFormat('US', { management: true })).displayTemplate).toContain('{LOCALITY}');
    cache.data.set(key, '{not json');
    expect((await a.getAddressFormat('US')).displayTemplate).toContain('{LOCALITY}');
    cache.data.set(key, JSON.stringify({ v: { code: 5 } }));
    expect((await a.getAddressFormat('US')).displayTemplate).toContain('{LOCALITY}');
  });

  it('cache failure degrades to the database for reads and writes and never changes a result; a hanging cache is bounded by the deadline', async () => {
    const memory = new MemoryConfigCache();
    const a = mkAddr({ cache: memory });
    const c = await newCountry({ active: true, via: mkGeo({ cache: memory }) });
    await publishedTextFormat(c, a);
    expect((await a.getAddressFormat(c)).version).toBe(1);
    memory.fail = true;
    expect((await a.getAddressFormat(c)).version).toBe(1);
    expect((await a.getAddressFormat('US')).version).toBe(1);
    const d2 = await a.createFormatDraft(c, textFormat({ displayTemplate: '{LOCALITY} {POSTAL_CODE} {ADDRESS_LINE_1}' }), ACTOR);
    expect((await pub(a, c, d2.version)).status).toBe('PUBLISHED'); // the lost bump does not fail the publication
    expect((await a.getAddressFormat(c)).version).toBe(2); // and the database answers
    expect((await a.upsertAdministrativeAreas(c, { areas: [{ code: 'P1', name: 'One', type: 'PROVINCE' }], reason: 'x' }, ACTOR)).added).toBe(1);
    expect((await a.listAdministrativeAreas(c)).areas.map((x) => x.code)).toEqual(['P1']);

    const never = () => new Promise<never>(() => undefined);
    const hang: ConfigCache = { get: never, mget: never, set: never, incr: never };
    const h = mkAddr({ cache: hang, cacheDeadlineMs: 100 });
    const t0 = Date.now();
    expect((await h.getAddressFormat(c)).version).toBe(2);
    expect((await h.listAdministrativeAreas(c)).areas).toHaveLength(1);
    expect((await h.validateAddress({ countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' })).outcome.valid).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500); // at most one deadline per read
    const t1 = Date.now();
    await h.upsertAdministrativeAreas(c, { areas: [{ code: 'P2', name: 'Two', type: 'PROVINCE' }], reason: 'while the cache hangs' }, ACTOR);
    expect(Date.now() - t1).toBeLessThan(2000);
  });

  it('entries are written with the configured TTL (a lost bump is bounded by it)', async () => {
    const ttls: number[] = [];
    class Spy extends MemoryConfigCache {
      override async set(key: string, value: string, ttl?: number): Promise<void> {
        ttls.push(ttl as number);
        await super.set(key, value);
      }
    }
    const a = mkAddr({ cache: new Spy() as unknown as ConfigCache, cacheTtlSeconds: 42 });
    await a.getAddressFormat('US');
    await a.listAdministrativeAreas('US'); // the same blob: one write
    expect(ttls).toEqual([42]);
  });
});

// ====================================================================== administrative areas management
describe('upsertAdministrativeAreas', () => {
  const area = (codeValue: string, over: Record<string, unknown> = {}) => ({ code: codeValue, name: `Area ${codeValue}`, type: 'PROVINCE', ...over });
  const areasOf = (c: string) =>
    q<{ code: string; name: string; area_type: string; status: string; parent: string | null; display_order: number | null }>(
      `SELECT a.code, a.name, a.area_type, a.status, p.code AS parent, a.display_order FROM geography.administrative_areas a
         JOIN geography.countries c ON c.country_id = a.country_id LEFT JOIN geography.administrative_areas p ON p.administrative_area_id = a.parent_area_id
        WHERE c.iso_alpha2 = $1 ORDER BY a.code`,
      [c],
    );

  it('creates areas (parents before children), writes one audit row and one counts-only event, and lists them in picker order', async () => {
    const c = await newCountry();
    const cid = 'corr-areas-1';
    const r = await runWithCorrelation(cid, () =>
      addr.upsertAdministrativeAreas(
        c,
        {
          areas: [area('ON', { displayOrder: 2 }), area('QC', { displayOrder: 1 }), area('TOR', { parentCode: 'ON', type: 'REGION' }), area('BC')],
          reason: 'seed provinces',
        },
        ACTOR,
      ),
    );
    expect(r).toEqual({ countryCode: c, added: 4, updated: 0 });
    expect((await areasOf(c)).map((a) => [a.code, a.parent, a.status])).toEqual([
      ['BC', null, 'ACTIVE'],
      ['ON', null, 'ACTIVE'],
      ['QC', null, 'ACTIVE'],
      ['TOR', 'ON', 'ACTIVE'],
    ]);
    const audit = await areaAudit(c);
    expect(audit).toEqual([{ actor: ACTOR, changes: { added: ['ON', 'QC', 'TOR', 'BC'], updated: [] }, reason: 'seed provinces', correlation_id: cid }]);
    const ev = await events(GEOGRAPHY_EVENTS.administrativeAreasUpdated, c);
    expect(ev).toHaveLength(1);
    const countryId = (await q<{ country_id: string }>('SELECT country_id FROM geography.countries WHERE iso_alpha2 = $1', [c]))[0]!.country_id;
    expect(ev[0]).toMatchObject({ aggregate_type: 'geography_country', aggregate_id: countryId, actor_type: 'user', actor_id: ACTOR, correlation_id: cid });
    expect(AdministrativeAreasUpdatedPayload.parse(ev[0]!.payload_json)).toEqual({ countryCode: c, added: 4, updated: 0 });
    expect(Object.keys(ev[0]!.payload_json).sort()).toEqual(['added', 'countryCode', 'updated']);
    const mgmt = await addr.listAdministrativeAreas(c, { management: true });
    expect(mgmt.mode).toBe('NONE'); // no format yet
    expect(mgmt.areas.map((a) => a.code)).toEqual(['QC', 'ON', 'BC', 'TOR']); // explicit order first (1, 2), then by name (Area BC, Area TOR)
    expect(mgmt.areas.find((a) => a.code === 'TOR')).toMatchObject({ parentCode: 'ON', type: 'REGION' });
  });

  it('updates name, type, display order and activity; an unchanged request is a no-op without audit row or event; omitted properties are kept', async () => {
    const c = await newCountry();
    await addr.upsertAdministrativeAreas(c, { areas: [area('ON', { displayOrder: 5 }), area('QC')], reason: 'seed' }, ACTOR);
    const noop = await addr.upsertAdministrativeAreas(c, { areas: [area('ON', { displayOrder: 5 }), area('QC')], reason: 'again' }, ACTOR);
    expect(noop).toEqual({ countryCode: c, added: 0, updated: 0 });
    expect(await areaAudit(c)).toHaveLength(1);
    expect(await events(GEOGRAPHY_EVENTS.administrativeAreasUpdated, c)).toHaveLength(1);
    // omitted active/displayOrder keep their values
    const r = await addr.upsertAdministrativeAreas(c, { areas: [{ code: 'ON', name: 'Ontario', type: 'REGION' }], reason: 'rename' }, ACTOR);
    expect(r).toEqual({ countryCode: c, added: 0, updated: 1 });
    expect((await areasOf(c)).find((a) => a.code === 'ON')).toMatchObject({ name: 'Ontario', area_type: 'REGION', status: 'ACTIVE', display_order: 5 });
    await addr.upsertAdministrativeAreas(
      c,
      { areas: [area('ON', { name: 'Ontario', type: 'REGION', displayOrder: null, active: false })], reason: 'retire' },
      ACTOR,
    );
    expect((await areasOf(c)).find((a) => a.code === 'ON')).toMatchObject({ status: 'INACTIVE', display_order: null });
    await addr.upsertAdministrativeAreas(c, { areas: [area('ON', { name: 'Ontario', type: 'REGION', active: true })], reason: 'reactivate' }, ACTOR);
    expect((await areasOf(c)).find((a) => a.code === 'ON')!.status).toBe('ACTIVE');
    const audit = await areaAudit(c);
    expect(audit.map((a) => a.changes)).toEqual([
      { added: ['ON', 'QC'], updated: [] },
      { added: [], updated: ['ON'] },
      { added: [], updated: ['ON'] },
      { added: [], updated: ['ON'] },
    ]);
    expect(await events(GEOGRAPHY_EVENTS.administrativeAreasUpdated, c)).toHaveLength(4);
  });

  it('the parent is set only at creation: an existing area cannot be re-parented, an unknown parent is refused, a no-change parent is fine', async () => {
    const c = await newCountry();
    await addr.upsertAdministrativeAreas(c, { areas: [area('ON'), area('QC'), area('TOR', { parentCode: 'ON' })], reason: 'seed' }, ACTOR);
    const e1 = await err(addr.upsertAdministrativeAreas(c, { areas: [area('TOR', { parentCode: 'QC' })], reason: 'move' }, ACTOR));
    expect([e1?.code, e1?.details.reason]).toEqual(['VALIDATION_FAILED', 'PARENT_IMMUTABLE']);
    const e2 = await err(addr.upsertAdministrativeAreas(c, { areas: [area('TOR', { parentCode: null })], reason: 'detach' }, ACTOR));
    expect(e2?.details.reason).toBe('PARENT_IMMUTABLE');
    const e3 = await err(addr.upsertAdministrativeAreas(c, { areas: [area('QC', { parentCode: 'ON' })], reason: 'attach' }, ACTOR));
    expect(e3?.details.reason).toBe('PARENT_IMMUTABLE');
    const e4 = await err(addr.upsertAdministrativeAreas(c, { areas: [area('NEW', { parentCode: 'MISSING' })], reason: 'x' }, ACTOR));
    expect([e4?.code, e4?.details.reason, e4?.details.field]).toEqual(['VALIDATION_FAILED', 'UNKNOWN_PARENT_AREA', 'parentCode']);
    const e5 = await err(addr.upsertAdministrativeAreas(c, { areas: [area('KID', { parentCode: 'LATER' }), area('LATER')], reason: 'order matters' }, ACTOR));
    expect(e5?.details.reason).toBe('UNKNOWN_PARENT_AREA');
    expect(
      (
        await addr.upsertAdministrativeAreas(
          c,
          { areas: [area('TOR', { parentCode: 'ON' }), area('KID', { parentCode: 'TOR' })], reason: 'same parent is no change' },
          ACTOR,
        )
      ).added,
    ).toBe(1);
    expect((await areasOf(c)).map((a) => [a.code, a.parent])).toEqual([
      ['KID', 'TOR'],
      ['ON', null],
      ['QC', null],
      ['TOR', 'ON'],
    ]);
  });

  it('is atomic: a failing item rolls back the whole batch (areas, audit, event)', async () => {
    const c = await newCountry();
    const auditBefore = await countRows('geography.audit_events');
    const eventsBefore = await countRows('integration.outbox_events');
    const e = await err(addr.upsertAdministrativeAreas(c, { areas: [area('OK1'), area('OK2'), area('BAD', { parentCode: 'NOPE' })], reason: 'x' }, ACTOR));
    expect(e?.details.reason).toBe('UNKNOWN_PARENT_AREA');
    expect(await areasOf(c)).toEqual([]);
    expect(await countRows('geography.audit_events')).toBe(auditBefore);
    expect(await countRows('integration.outbox_events')).toBe(eventsBefore);
  });

  it('refuses a malformed request: duplicate codes, bad code, blank reason, empty list, unknown property, too many areas; and an unknown country', async () => {
    const c = await newCountry();
    expect(await reason(addr.upsertAdministrativeAreas(c, { areas: [area('A1'), area('A1', { name: 'again' })], reason: 'x' }, ACTOR))).toBe(
      'DUPLICATE_AREA_CODE',
    );
    for (const body of [
      { areas: [area('lower')], reason: 'x' },
      { areas: [area('A1')], reason: ' ' },
      { areas: [], reason: 'x' },
      { areas: [{ ...area('A1'), extra: 1 }], reason: 'x' },
      { areas: [area('A1', { type: 'CITY' })], reason: 'x' },
      { areas: [area('A1', { name: '' })], reason: 'x' },
      { areas: Array.from({ length: 501 }, (_, i) => area(`A${i}`)), reason: 'x' },
    ])
      expect(await code(addr.upsertAdministrativeAreas(c, body, ACTOR))).toBe('VALIDATION_FAILED');
    expect(await code(addr.upsertAdministrativeAreas('QQ', { areas: [area('A1')], reason: 'x' }, ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(addr.upsertAdministrativeAreas('us', { areas: [area('A1')], reason: 'x' }, ACTOR))).toBe('COUNTRY_NOT_FOUND');
    expect(await areasOf(c)).toEqual([]);
    // 500 areas in one request are accepted
    const big = await addr.upsertAdministrativeAreas(c, { areas: Array.from({ length: 500 }, (_, i) => area(`B${i}`)), reason: 'bulk' }, ACTOR);
    expect(big.added).toBe(500);
  });

  it('the last ACTIVE area cannot be retired while a published format has a LOOKUP field (AREAS_IN_USE); others can, and a text-only country has no such rule', async () => {
    const c = await newCountry();
    await addr.upsertAdministrativeAreas(c, { areas: [area('P1'), area('P2')], reason: 'seed' }, ACTOR);
    await publishedTextFormat(c, addr, {
      fields: [LINE1, AREA_LOOKUP, CITY, ZIP5],
      displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
    });
    await addr.upsertAdministrativeAreas(c, { areas: [area('P1', { active: false })], reason: 'retire one' }, ACTOR);
    const auditBefore = (await areaAudit(c)).length;
    const e = await err(addr.upsertAdministrativeAreas(c, { areas: [area('P2', { active: false })], reason: 'retire the last' }, ACTOR));
    expect([e?.code, e?.details.reason]).toEqual(['INVALID_STATE', 'AREAS_IN_USE']);
    expect((await areasOf(c)).find((a) => a.code === 'P2')!.status).toBe('ACTIVE');
    expect((await areaAudit(c)).length).toBe(auditBefore);
    // retiring everything in one request is the same case; adding a replacement in the same request is fine
    expect(await reason(addr.upsertAdministrativeAreas(c, { areas: [area('P2', { active: false })], reason: 'x' }, ACTOR))).toBe('AREAS_IN_USE');
    expect((await addr.upsertAdministrativeAreas(c, { areas: [area('P2', { active: false }), area('P3')], reason: 'swap' }, ACTOR)).added).toBe(1);
    // a country whose format has no LOOKUP field may retire all of its areas
    const free = await newCountry();
    await addr.upsertAdministrativeAreas(free, { areas: [area('F1')], reason: 'seed' }, ACTOR);
    await publishedTextFormat(free);
    expect((await addr.upsertAdministrativeAreas(free, { areas: [area('F1', { active: false })], reason: 'retire' }, ACTOR)).updated).toBe(1);
  });

  it('two callers creating the same area at once: both succeed, exactly one audit row and one event (the second finds it created)', async () => {
    const c = await newCountry();
    const body = { areas: [area('RACE')], reason: 'race' };
    const [a, b] = await Promise.all([addr.upsertAdministrativeAreas(c, body, 'actor-a'), addr.upsertAdministrativeAreas(c, body, 'actor-b')]);
    expect([a.added + b.added, a.updated + b.updated]).toEqual([1, 0]);
    expect(await areaAudit(c)).toHaveLength(1);
    expect(await events(GEOGRAPHY_EVENTS.administrativeAreasUpdated, c)).toHaveLength(1);
    expect(await areasOf(c)).toHaveLength(1);
  });
});

// ====================================================================== concurrency
describe('concurrent format publication and drafts', () => {
  it('two drafts published at once (queued behind the country lock): both succeed in some order, periods chain without overlap, one open format, one event each', async () => {
    const c = await newCountry();
    await publishedTextFormat(c);
    const d2 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{ADDRESS_LINE_1} / {LOCALITY} / {POSTAL_CODE}' }), ACTOR);
    const d3 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{POSTAL_CODE} {LOCALITY} {ADDRESS_LINE_1}' }), ACTOR);
    const holder = await db().pool.connect();
    let results: unknown[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM geography.countries WHERE iso_alpha2 = $1 FOR UPDATE', [c]);
      const p2 = settled(pub(addr, c, d2.version));
      const p3 = settled(pub(addr, c, d3.version));
      await lockWaiters(2);
      await holder.query('COMMIT');
      results = await Promise.all([p2, p3]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(results.map(outcomeOf)).toEqual(['ok', 'ok']);
    await expectConsistentPeriods(c, 3);
    expect((await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).map((e) => e.payload_json.version).sort()).toEqual([1, 2, 3]);
    expect((await formatAudit(c)).filter((x) => x.action === 'ADDRESS_FORMAT_PUBLISHED')).toHaveLength(3);
  });

  it('the same requested start for two drafts: exactly one wins, the other is a retryable START_NOT_AFTER_CURRENT conflict and stays a DRAFT; the invariants hold', async () => {
    const c = await newCountry();
    await publishedTextFormat(c);
    const d2 = await addr.createFormatDraft(c, textFormat(), ACTOR);
    const d3 = await addr.createFormatDraft(c, textFormat(), ACTOR);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const results = await Promise.all([settled(pub(addr, c, d2.version, { effectiveFrom: at })), settled(pub(addr, c, d3.version, { effectiveFrom: at }))]);
    expect(results.map(outcomeOf).sort()).toEqual(['CONFLICT/START_NOT_AFTER_CURRENT', 'ok']);
    expect((results.find((r) => r instanceof Error) as GeographyError).details.retryable).toBe(true);
    await expectConsistentPeriods(c, 2);
    expect((await formatRows(c)).filter((r) => r.status === 'DRAFT')).toHaveLength(1);
    expect(await events(GEOGRAPHY_EVENTS.addressFormatPublished, c)).toHaveLength(2);
    // the loser is publishable later with a later start
    const loser = (await formatRows(c)).find((r) => r.status === 'DRAFT')!.version;
    expect((await pub(addr, c, loser, { effectiveFrom: new Date(Date.parse(at) + 1000).toISOString() })).status).toBe('PUBLISHED');
    await expectConsistentPeriods(c, 3);
  });

  it('the database alone refuses the race: two sessions publishing overlapping drafts without the service lock, the second fails with the exclusion constraint once the first commits', async () => {
    const c = await newCountry();
    const d1 = await addr.createFormatDraft(c, textFormat(), ACTOR);
    const d2 = await addr.createFormatDraft(c, textFormat(), ACTOR);
    const publishSql =
      "UPDATE geography.address_formats f SET status = 'PUBLISHED' FROM geography.countries c WHERE f.country_id = c.country_id AND c.iso_alpha2 = $1 AND f.version = $2";
    const a = await db().pool.connect();
    const b = await db().pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(publishSql, [c, d1.version]);
      await b.query('BEGIN');
      const second = rejection(b.query(publishSql, [c, d2.version]));
      await lockWaiters(1); // b waits for a's uncommitted index entry
      await a.query('COMMIT');
      const e = (await second) as { code?: string; constraint?: string };
      expect({ code: e?.code, constraint: e?.constraint }).toEqual({ code: '23P01', constraint: 'ex_address_formats__no_overlap' });
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    expect((await formatRows(c)).map((r) => [r.version, r.status])).toEqual([
      [1, 'PUBLISHED'],
      [2, 'DRAFT'],
    ]);
  });

  it('concurrent createFormatDraft calls allocate distinct, gapless versions (one audit row each)', async () => {
    const c = await newCountry();
    const drafts = await Promise.all(Array.from({ length: 6 }, () => addr.createFormatDraft(c, textFormat(), ACTOR)));
    expect(drafts.map((d) => d.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await formatRows(c)).map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await formatAudit(c)).filter((x) => x.action === 'ADDRESS_FORMAT_DRAFTED')).toHaveLength(6);
    expect(new Set(drafts.map((d) => d.addressFormatId)).size).toBe(6);
  });

  it('publishing while another session is creating addresses with the old format never loses an address (the address keeps its version)', async () => {
    const c = await newCountry({ active: true });
    await publishedTextFormat(c);
    const d2 = await addr.createFormatDraft(c, textFormat({ displayTemplate: '{POSTAL_CODE} {LOCALITY} {ADDRESS_LINE_1}' }), ACTOR);
    const input: AddressInput = { countryCode: c, addressLine1: '1 Elm St', locality: 'Town', postalCode: '12345' };
    const [, ...created] = await Promise.all([pub(addr, c, d2.version), ...Array.from({ length: 8 }, () => addr.createManualAddress(input))]);
    const versions = created.map((x) => x.formatVersion);
    expect(versions.every((v) => v === 1 || v === 2)).toBe(true);
    for (const a of created) {
      const row = (
        await q<{ version: number; formatted: string }>(
          'SELECT f.version, a.formatted_address AS formatted FROM geography.addresses a JOIN geography.address_formats f ON f.address_format_id = a.address_format_id WHERE a.address_id = $1',
          [a.addressId],
        )
      )[0]!;
      expect(row.version).toBe(a.formatVersion);
      expect(row.formatted).toBe(a.formatVersion === 1 ? '1 Elm St\nTown 12345' : '12345 Town 1 Elm St');
    }
    await expectConsistentPeriods(c, 2);
  });
});

// ====================================================================== another country is data only
describe('a second country with its own format and provinces (data only, no code change)', () => {
  const CA_POSTAL = {
    fieldType: 'POSTAL_CODE',
    contentLabelKey: 'address.field.postal_code',
    required: true,
    maxLength: 7,
    validationPattern: '[A-Z][0-9][A-Z][0-9][A-Z][0-9]',
    example: 'K1A0B1',
    normalization: 'UPPERCASE_REMOVE_SPACES',
    autocomplete: 'postal-code',
  };
  let zzReady = false;
  async function ensureZz(): Promise<void> {
    if (zzReady) return;
    await geo.createCountry(countryReq('ZZ'), ACTOR);
    await geo.setCountryActive('ZZ', true, 'activate for test', ACTOR);
    await addr.upsertAdministrativeAreas(
      'ZZ',
      {
        areas: [
          { code: 'ON', name: 'Ontario', type: 'PROVINCE' },
          { code: 'QC', name: 'Quebec', type: 'PROVINCE' },
          { code: 'BC', name: 'British Columbia', type: 'PROVINCE' },
          { code: 'YT', name: 'Yukon', type: 'TERRITORY' },
        ],
        reason: 'provinces',
      },
      ACTOR,
    );
    const d = await addr.createFormatDraft(
      'ZZ',
      {
        displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY} {ADMINISTRATIVE_AREA}  {POSTAL_CODE}',
        fields: [LINE1, LINE2, CITY, { ...AREA_LOOKUP, maxLength: 30 }, CA_POSTAL],
        reason: 'format for ZZ',
      },
      ACTOR,
    );
    await pub(addr, 'ZZ', d.version);
    zzReady = true;
  }
  const ZZ_INPUT: AddressInput = { countryCode: 'ZZ', addressLine1: '1 Elm St', locality: 'Ottawa', administrativeArea: 'on', postalCode: 'k1a 0b1' };

  it('validates an A1A 1A1 postal code with UPPERCASE_REMOVE_SPACES and a province LOOKUP, with the US format unchanged', async () => {
    await ensureZz();
    const f = await addr.getAddressFormat('ZZ');
    expect(toAddressFormatDto(f, false)).toMatchObject({ countryCode: 'ZZ', administrativeAreaMode: 'LOOKUP', postalCodeExample: 'K1A0B1' });
    const r = (await addr.validateAddress(ZZ_INPUT)).outcome;
    expect(r.valid).toBe(true);
    expect(r.address).toMatchObject({
      countryCode: 'ZZ',
      administrativeAreaCode: 'ON',
      administrativeAreaName: 'Ontario',
      postalCode: 'K1A0B1',
      locality: 'Ottawa',
    });
    expect(
      (await addr.validateAddress({ ...ZZ_INPUT, administrativeArea: 'British Columbia', postalCode: 'V6B-4Y8' })).outcome.issues.map((i) => i.code),
    ).toEqual(['INVALID_FORMAT']); // dash is not removed
    for (const bad of ['12345', 'K1A 0B', 'K1A0B1X', 'KIA 0B1'])
      expect(
        (await addr.validateAddress({ ...ZZ_INPUT, postalCode: bad })).outcome.issues.map((i) => i.code),
        bad,
      ).toEqual(['INVALID_FORMAT']);
    expect((await addr.validateAddress({ ...ZZ_INPUT, administrativeArea: 'Narnia' })).outcome.issues.map((i) => i.code)).toEqual(['UNKNOWN_AREA']);
    expect((await addr.validateAddress({ ...ZZ_INPUT, administrativeArea: 'Yukon' })).outcome.address!.administrativeAreaCode).toBe('YT');
    expect(await addr.validatePostalCode('ZZ', 'h2x 1y4')).toEqual({ ok: true, value: 'H2X1Y4' });
    // one country's rules never leak into another: a ZIP+4 is not valid in ZZ and a postal code like K1A0B1 is not valid in the US
    expect((await addr.validateAddress({ ...ZZ_INPUT, postalCode: '92618' })).outcome.valid).toBe(false);
    expect((await addr.validateAddress({ ...MAIN, postalCode: 'K1A 0B1' })).outcome.valid).toBe(false);
    expect((await addr.validateAddress(MAIN)).outcome.valid).toBe(true);
    expect((await addr.getAddressFormat('US')).version).toBe(1);
    expect((await addr.listAdministrativeAreas('ZZ')).areas.map((a) => a.code)).toEqual(['BC', 'ON', 'QC', 'YT']);
    expect((await addr.listAdministrativeAreas('US')).areas).toHaveLength(51);
  });

  it('formats and stores a ZZ address through the same code path; the stored area references the ZZ province', async () => {
    await ensureZz();
    const f = await addr.formatAddress(ZZ_INPUT);
    expect(f.formatted).toEqual({
      lines: ['1 Elm St', 'Ottawa ON  K1A0B1'],
      text: '1 Elm St\nOttawa ON  K1A0B1',
      singleLine: '1 Elm St, Ottawa ON  K1A0B1',
      formatVersion: 1,
    });
    const created = await addr.createManualAddress(ZZ_INPUT);
    const stored = (await addr.getAddress(created.addressId))!;
    expect(stored.address).toMatchObject({ countryCode: 'ZZ', administrativeAreaCode: 'ON', administrativeAreaName: 'Ontario', postalCode: 'K1A0B1' });
    const row = (
      await q<{ iso: string; area_country: string; fmt_country: string }>(
        `SELECT c.iso_alpha2 AS iso, ac.iso_alpha2 AS area_country, fc.iso_alpha2 AS fmt_country FROM geography.addresses a
           JOIN geography.countries c ON c.country_id = a.country_id
           JOIN geography.administrative_areas ar ON ar.administrative_area_id = a.administrative_area_id JOIN geography.countries ac ON ac.country_id = ar.country_id
           JOIN geography.address_formats f ON f.address_format_id = a.address_format_id JOIN geography.countries fc ON fc.country_id = f.country_id
          WHERE a.address_id = $1`,
        [created.addressId],
      )
    )[0]!;
    expect(row).toEqual({ iso: 'ZZ', area_country: 'ZZ', fmt_country: 'ZZ' });
    // geocoding and autocomplete follow the same per-country resolution (no provider for ZZ: manual fallback / UNAVAILABLE)
    const s = mkAddr({
      providers: {
        geocoder: (cc) => (cc === 'US' ? new MockGeocoder(PLACES) : undefined),
        autocomplete: (cc) => (cc === 'US' ? new MockAddressAutocompleteProvider(PLACES) : undefined),
      },
    });
    expect((await s.geocodeAndCreateAddress(ZZ_INPUT)).validationSource).toBe('MANUAL');
    expect(await reason(s.suggestAddresses('ZZ', 'x'))).toBe('NO_AUTOCOMPLETE_PROVIDER');
    expect((await s.geocodeAndCreateAddress(MAIN)).validationSource).toBe('GEOCODER');
  });

  it('the address engine and service contain no country-specific branch (no country code or postal-code rule literal in code)', () => {
    for (const file of ['address-engine.ts', 'address-service.ts']) {
      const code = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
        .join('\n');
      expect(code.match(/['"`](US|CA|ZZ|GB|MX|FR|DE|JP|IN)['"`]/g) ?? [], file).toEqual([]);
      expect(code.match(/countryCode\s*[=!]==\s*['"`]/g) ?? [], file).toEqual([]);
      expect(code.match(/\b(zip|zipcode)\b/gi) ?? [], file).toEqual([]);
    }
  });
});

// ====================================================================== visibility of a PLANNED country
describe('public versus management visibility of a PLANNED country', () => {
  it('the public view answers COUNTRY_NOT_FOUND for every read; management previews drafts, inactive areas and the format; activation makes it public', async () => {
    const cache = new MemoryConfigCache();
    const g = mkGeo({ cache });
    const a = mkAddr({ cache });
    const c = await newCountry({ via: g });
    await a.upsertAdministrativeAreas(
      c,
      {
        areas: [
          { code: 'A1', name: 'Alpha', type: 'REGION' },
          { code: 'B1', name: 'Beta', type: 'REGION', active: false },
        ],
        reason: 'seed',
      },
      ACTOR,
    );
    const published = await a.createFormatDraft(
      c,
      textFormat({ fields: [LINE1, AREA_LOOKUP, CITY, ZIP5], displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}' }),
      ACTOR,
    );
    await pub(a, c, published.version);
    await a.createFormatDraft(c, textFormat(), ACTOR); // v2 stays a draft
    const input: AddressInput = { countryCode: c, addressLine1: '1 Elm St', locality: 'Town', administrativeArea: 'A1', postalCode: '12345' };
    expect(await code(a.getAddressFormat(c))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.listAdministrativeAreas(c))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.validateAddress(input))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.formatAddress(input))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.validatePostalCode(c, '12345'))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.createManualAddress(input))).toBe('COUNTRY_NOT_FOUND');
    expect(await code(a.geocodeAndCreateAddress(input))).toBe('COUNTRY_NOT_FOUND');
    // management sees it
    expect((await a.getAddressFormat(c, { management: true })).version).toBe(1);
    expect((await a.listAddressFormats(c)).map((f) => [f.version, f.status])).toEqual([
      [2, 'DRAFT'],
      [1, 'PUBLISHED'],
    ]);
    const mgmt = await a.listAdministrativeAreas(c, { management: true });
    expect(mgmt.mode).toBe('LOOKUP');
    expect(mgmt.areas.map((x) => [x.code, x.status])).toEqual([
      ['A1', 'ACTIVE'],
      ['B1', 'INACTIVE'],
    ]);
    expect((await a.validateAddress(input, { management: true })).outcome.valid).toBe(true);
    expect((await a.validateAddress({ ...input, administrativeArea: 'B1' }, { management: true })).outcome.issues.map((i) => i.code)).toEqual(['UNKNOWN_AREA']); // inactive areas never resolve
    expect((await a.formatAddress(input, { management: true })).formatted.text).toBe('1 Elm St\nTown A1 12345');
    // nothing about the PLANNED country was cached; activation (a GeographyService write) makes the public view work at once
    expect([...cache.data.keys()].filter((k) => k.includes(':address:'))).toEqual([]);
    await g.setCountryActive(c, true, 'go live', ACTOR);
    expect((await a.getAddressFormat(c)).version).toBe(1);
    const pubAreas = await a.listAdministrativeAreas(c);
    expect(pubAreas.areas.map((x) => x.code)).toEqual(['A1']); // the public view lists ACTIVE areas only
    expect((await a.listAddressFormats(c)).length).toBe(2); // management still sees the draft
    expect(addressKeys(cache, c)).toHaveLength(1);
    // deactivation hides it again
    await g.setCountryActive(c, false, 'pause', ACTOR);
    expect(await code(a.getAddressFormat(c))).toBe('COUNTRY_NOT_FOUND');
  });
});

// ====================================================================== readiness
describe('the ADDRESS_FORMAT readiness check', () => {
  it('blocks market activation (NOT_READY) in a country without a format in force and allows it once one is published', async () => {
    const registry = new ReadinessRegistry();
    const a = mkAddr();
    registry.register(createAddressFormatReadinessCheck(a));
    const g = mkGeo({ readiness: registry });
    const c = await newCountry({ active: true, via: g });
    const req = marketReq(c);
    await g.createMarket(req, ACTOR);
    const m = req.code;
    const report = await g.getMarketReadiness(m);
    expect(report.ready).toBe(false);
    expect(report.checks.find((x) => x.code === 'ADDRESS_FORMAT')).toMatchObject({
      passed: false,
      detail: `country ${c} has no address format in force`,
    });
    const e = await err(g.setMarketActive(m, true, 'try', ACTOR));
    expect([e?.code, e?.details.checks]).toEqual(['NOT_READY', [{ code: 'ADDRESS_FORMAT', detail: `country ${c} has no address format in force` }]]);
    expect((await q<{ status: string }>('SELECT status FROM geography.markets WHERE code = $1', [m]))[0]!.status).toBe('PLANNED');
    // a DRAFT does not count, and neither does a format that only starts in the future
    await a.createFormatDraft(c, textFormat(), ACTOR);
    expect(await code(g.setMarketActive(m, true, 'draft only', ACTOR))).toBe('NOT_READY');
    const future = await a.createFormatDraft(c, textFormat({ effectiveFrom: new Date(Date.now() + 2 * 3_600_000).toISOString() }), ACTOR);
    await pub(a, c, future.version);
    expect(await code(g.setMarketActive(m, true, 'future only', ACTOR))).toBe('NOT_READY');
    // a format in force makes the market ready: publish an immediate one (it must start after the future one, so close that path by using a fresh country)
    const c2 = await newCountry({ active: true, via: g });
    const req2 = marketReq(c2);
    await g.createMarket(req2, ACTOR);
    expect(await code(g.setMarketActive(req2.code, true, 'no format', ACTOR))).toBe('NOT_READY');
    await publishedTextFormat(c2, a);
    const ready = await g.getMarketReadiness(req2.code);
    expect(ready.ready).toBe(true);
    expect(ready.checks.find((x) => x.code === 'ADDRESS_FORMAT')).toMatchObject({ passed: true, detail: `country ${c2} has an address format in force` });
    expect((await g.setMarketActive(req2.code, true, 'now it works', ACTOR)).status).toBe('ACTIVE');
  });

  it('the seeded US market la-oc is ready (US has a format) while the check is registered', async () => {
    const registry = new ReadinessRegistry();
    registry.register(createAddressFormatReadinessCheck(mkAddr()));
    const report = await mkGeo({ readiness: registry }).getMarketReadiness('la-oc');
    expect(report.ready).toBe(true);
    expect(report.checks.find((x) => x.code === 'ADDRESS_FORMAT')).toMatchObject({ passed: true });
  });

  it('a check that cannot reach the database counts as failed and leaks nothing', async () => {
    const registry = new ReadinessRegistry();
    registry.register(
      createAddressFormatReadinessCheck({
        hasEffectiveFormat: async () => {
          throw new Error('postgres://u:secret@h/db');
        },
      } as unknown as AddressService),
    );
    const g = mkGeo({ readiness: registry });
    const c = await newCountry({ active: true, via: g });
    const req = marketReq(c);
    await g.createMarket(req, ACTOR);
    const e = await err(g.setMarketActive(req.code, true, 'try', ACTOR));
    expect(e?.code).toBe('NOT_READY');
    expect(JSON.stringify(e?.details)).not.toMatch(/secret|postgres/);
  });
});

// ====================================================================== privacy
describe('privacy: no address value is ever logged and errors never echo input', () => {
  const STREET = 'Zebraquartz Lane 7731';
  const CITY_NAME = 'Quuxville';
  const ZIP = '90277-4321';
  const LAT = 33.123456;
  const LNG = -117.654321;
  const NEEDLES = [STREET, 'Zebraquartz', '7731', CITY_NAME, ZIP, '33.123456', '117.654321'];
  const SECRET: AddressInput = {
    countryCode: 'US',
    addressLine1: STREET,
    addressLine2: 'Apt 9',
    locality: CITY_NAME,
    administrativeArea: 'CA',
    postalCode: ZIP,
  };
  const secretPlaces: MockPlace[] = [
    place('s-ok', SECRET, { latitude: LAT, longitude: LNG, timeZone: 'Mars/Phobos' }), // unknown zone: a warning is logged
    place('s-bad', { ...SECRET, postalCode: '9' }),
    place('s-foreign', { ...SECRET, countryCode: 'CA' }, { countryCode: 'US' }),
    place('s-lat', { ...SECRET, addressLine1: `${STREET} B` }, { latitude: 123.456, longitude: LNG }),
  ];

  function captureOutput() {
    const lines: string[] = [];
    const take = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(take));
    const sink = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never;
    spies.push(vi.spyOn(process.stdout, 'write').mockImplementation(sink) as never, vi.spyOn(process.stderr, 'write').mockImplementation(sink) as never);
    return { lines, stop: () => spies.forEach((s) => s.mockRestore()) };
  }
  const noAddressText = (blob: string) => {
    for (const needle of NEEDLES) expect(blob.includes(needle), `"${needle}" must not appear`).toBe(false);
  };

  it('validate, format, create, geocode and read never put an address, a postal code or coordinates in a log line; provider failures log provider and operation only', async () => {
    const auto = new MockAddressAutocompleteProvider(secretPlaces);
    const coder = new MockGeocoder(secretPlaces);
    const s = mkAddr({ providers: providersFor(auto, coder) });
    const out = captureOutput();
    const errors: unknown[] = [];
    try {
      await s.validateAddress(SECRET);
      await s.validateAddress({ ...SECRET, postalCode: '1' });
      await s.formatAddress(SECRET);
      errors.push(await rejection(s.formatAddress({ ...SECRET, postalCode: '1' })));
      const manual = await s.createManualAddress(SECRET, { rawInput: { addressLine1: STREET, postalCode: ZIP } });
      errors.push(await rejection(s.createManualAddress({ ...SECRET, locality: '' })));
      await s.suggestAddresses('US', 'Zebra');
      const picked = await s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 's-ok', query: STREET });
      errors.push(await rejection(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 's-bad', query: STREET })));
      errors.push(await rejection(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 's-foreign' })));
      errors.push(await rejection(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: STREET })));
      const geocoded = await s.geocodeAndCreateAddress(SECRET); // time zone Mars/Phobos is unknown: warn log
      expect(geocoded.validationStatus).toBe('GEOCODED');
      await s.geocodeAndCreateAddress({ ...SECRET, addressLine1: `${STREET} B` }); // invalid coordinates: manual fallback
      errors.push(await rejection(s.geocodeAndCreateAddress({ ...SECRET, postalCode: '12' })));
      auto.failing = true;
      coder.failing = true;
      errors.push(await rejection(s.suggestAddresses('US', STREET)));
      errors.push(await rejection(s.createAddressFromAutocomplete({ countryCode: 'US', suggestionId: 's-ok', query: STREET })));
      await s.geocodeAndCreateAddress(SECRET);
      await s.getAddress(manual.addressId, { includeRawInput: true });
      await s.getAddress(picked.addressId);
      await s.getAddress(geocoded.addressId);
      await s.formatStoredAddress(manual.addressId, { includeCountry: true });
      errors.push(await rejection(s.validateAddress({ ...SECRET, addressLine1: STREET.repeat(30) })));
      errors.push(await rejection(s.validateAddress({ ...SECRET, [`${STREET}`]: STREET } as unknown as AddressInput)));
      errors.push(await rejection(s.validateAddress({ ...SECRET, countryCode: 'QQ' })));
    } finally {
      out.stop();
    }
    const captured = out.lines.join('\n');
    noAddressText(captured);
    // the capture works: the provider warnings were written, and carry only the provider and operation
    const warnings = out.lines.filter((l) => l.includes('address provider unavailable')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(warnings).toHaveLength(3); // suggest, resolve and geocode, each while its provider was failing
    for (const w of warnings) {
      expect(w.level).toBe('warn');
      const extra = Object.keys(w).filter(
        (k) => !['timestamp', 'level', 'service', 'environment', 'message', 'correlationId', 'traceId', 'spanId'].includes(k),
      );
      expect(extra.sort()).toEqual(['operation', 'provider']);
      expect(w.provider).toBe('mock');
    }
    expect(warnings.map((w) => w.operation).sort()).toEqual(expect.arrayContaining(['geocode', 'resolve', 'suggest']));
    expect(out.lines.some((l) => l.includes('not registered and ACTIVE') && !NEEDLES.some((n) => l.includes(n)))).toBe(true);
    // every error thrown for invalid input is typed, and has no address text in message, details or stack
    expect(errors.length).toBeGreaterThan(10);
    for (const e of errors) {
      expect(e).toBeInstanceOf(GeographyError);
      const g = e as GeographyError;
      noAddressText(JSON.stringify({ name: g.name, message: g.message, details: g.details, stack: g.stack, text: String(g) }));
    }
    const codes = errors.map((e) => (e as GeographyError).code);
    // invalid input is VALIDATION_FAILED, a failing provider UNAVAILABLE, an unknown country COUNTRY_NOT_FOUND
    expect(codes.filter((c) => c === 'VALIDATION_FAILED').length).toBeGreaterThanOrEqual(7);
    expect(codes.filter((c) => c === 'UNAVAILABLE').length).toBeGreaterThanOrEqual(2);
    expect(codes.at(-1)).toBe('COUNTRY_NOT_FOUND');
  });

  it('errors raised by the database layer for an address (check, foreign key) are fixed messages without values', async () => {
    // an address that passes validation but breaks a table rule is mapped to a typed error with no echo of the value
    const e = await err(addr.createManualAddress({ ...SECRET, addressLine2: undefined }, { rawInput: { dump: STREET.repeat(200) } }));
    expect(e).toBeInstanceOf(GeographyError);
    noAddressText(JSON.stringify({ message: e!.message, details: e!.details }));
    // and the format-management errors never carry what an administrator typed beyond identifiers
    const t = await err(addr.createFormatDraft('QQ', textFormat({ displayTemplate: `${STREET} {FOO}` }), ACTOR));
    expect(t?.details.reason).toBe('INVALID_TEMPLATE');
    noAddressText(JSON.stringify({ message: t!.message, details: t!.details }));
  });
});
