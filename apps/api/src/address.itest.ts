// GEO-002 address model over HTTP with the REAL services wired exactly as apps/api/src/index.ts wires them (GeographyService, ContentService,
// AddressService with the countryNames port, the ADDRESS_FORMAT readiness check in a private registry) on one real, isolated PostgreSQL.
// Migration 0008 seeds the US format (v1), 51 areas and the label/message copy; every other country in this file is created by the test through the
// management API only, which is the proof that a new country needs data and no deployment.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { MemoryConfigCache } from '@bananagig/configuration';
import { ADDRESS_ISSUE_CODES, GEOGRAPHY_EVENTS, addressIssueMessageKey, type AddressFormatDto } from '@bananagig/contracts';
import { ContentService } from '@bananagig/content';
import {
  AddressService,
  GeographyService,
  ReadinessRegistry,
  createAddressFormatReadinessCheck,
  createGeographyScopeReferenceValidator,
  createMarketDefaultsProvider,
} from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
let geography: GeographyService;
let content: ContentService;
let staff: string; // geography-read + geography-write
let reader: string; // geography-read only
let writer: string; // geography-write only
let contentStaff: string; // content roles only
const A = 'author-a';
const B = 'approver-b';

const adminToken = (sub: string, roles: string[]) =>
  signToken(keys, {
    claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } } },
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
}
const api = async (method: 'GET' | 'POST', url: string, t?: string, payload?: unknown): Promise<Res> => {
  const r = await app.inject({
    method,
    url: `/api/v1/geography${url}`,
    headers: t ? { authorization: `Bearer ${t}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as Json, headers: r.headers, raw: r.body };
};
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addressCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM geography.addresses'))[0]!.n;
const outbox = (type: string, countryCode: string) =>
  q<{ payload_json: Record<string, unknown>; aggregate_type: string; aggregate_id: string; actor_id: string }>(
    `SELECT payload_json, aggregate_type, aggregate_id, actor_id FROM integration.outbox_events
      WHERE event_type = $1 AND payload_json->>'countryCode' = $2 ORDER BY created_at, outbox_event_id`,
    [type, countryCode],
  );
const formatAudit = (action: string, countryCode: string) =>
  q<{ actor: string; changes: unknown }>(
    `SELECT a.actor, a.changes FROM geography.audit_events a JOIN geography.address_formats f ON f.address_format_id = a.address_format_id
       JOIN geography.countries c ON c.country_id = f.country_id WHERE a.action = $1 AND c.iso_alpha2 = $2 ORDER BY a.occurred_at, a.audit_event_id`,
    [action, countryCode],
  );

/** Resolves a label or message content key the way a client would: through the content API with the country as context. */
const label = async (key: string, country: string, locale = 'en-US') => (await content.render(key, { locale, context: { country } })).value;

/** version -> submit -> (approve) -> publish. */
async function contentPublish(key: string, o: { locale: string; body: string; scopeType: 'PLATFORM' | 'COUNTRY'; scopeRef: string | null }) {
  const v = await content.createVersion(key, { ...o, reason: 'integration test' }, A);
  const submitted = await content.submit(v.versionId, A);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, B);
  return content.publish(v.versionId, A);
}

const countryReq = (code: string, numeric: string, over: Record<string, unknown> = {}) => ({
  code,
  alpha3: `${code}X`,
  numeric,
  displayNameContentKey: 'geography.country.us.name',
  dialingCode: '+999',
  defaultCurrencyCode: 'USD',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  timeZones: ['Pacific/Honolulu'],
  distanceUnit: 'KILOMETERS',
  firstDayOfWeek: 'MONDAY',
  dateFormat: 'DMY',
  timeFormat: '24_HOUR',
  reason: 'integration test',
  ...over,
});

/** The management view of a format turned back into a draft request (so a test can change one thing). */
const draftFrom = (f: AddressFormatDto, mutate: (fields: Json[]) => void = () => undefined) => {
  const fields = f.fields.map((x) => ({
    fieldType: x.fieldType,
    contentLabelKey: x.contentLabelKey,
    required: x.required,
    maxLength: x.maxLength,
    inputType: x.inputType,
    validationPattern: x.validationPattern,
    example: x.example,
    autocomplete: x.autocomplete,
    normalization: x.normalization,
  }));
  mutate(fields);
  return { displayTemplate: f.displayTemplate, fields, reason: 'integration test' };
};

/** A country format as a real operator would define one for a new country: province picker, postal code A1A 1A1 stored as A1A1A1. */
const canadianStyleDraft = {
  displayTemplate: '{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY} {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
  fields: [
    { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100, autocomplete: 'address-line1' },
    { fieldType: 'ADDRESS_LINE_2', contentLabelKey: 'address.field.line2', required: false, maxLength: 100, autocomplete: 'address-line2' },
    { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60, autocomplete: 'address-level2' },
    {
      fieldType: 'ADMINISTRATIVE_AREA',
      contentLabelKey: 'address.field.state',
      required: true,
      maxLength: 50,
      inputType: 'LOOKUP',
      autocomplete: 'address-level1',
    },
    {
      fieldType: 'POSTAL_CODE',
      contentLabelKey: 'address.field.postal_code',
      required: true,
      maxLength: 7,
      validationPattern: '^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$',
      example: 'K1A0B1',
      normalization: 'UPPERCASE_REMOVE_SPACES',
      autocomplete: 'postal-code',
    },
  ],
  reason: 'integration test',
};
const provinces = {
  areas: [
    { code: 'ON', name: 'Ontario', type: 'PROVINCE', displayOrder: 1 },
    { code: 'QC', name: 'Quebec', type: 'PROVINCE', displayOrder: 2 },
    { code: 'YT', name: 'Yukon', type: 'TERRITORY', displayOrder: 3 },
    { code: 'XX', name: 'Retired Province', type: 'PROVINCE', displayOrder: 4, active: false },
  ],
  reason: 'integration test',
};
const irvine = { countryCode: 'US', addressLine1: '123 Main St', locality: 'Irvine', administrativeArea: 'CA', postalCode: '92618' };

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  const readiness = new ReadinessRegistry();
  geography = new GeographyService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true, readiness });
  const scopeReferences = createGeographyScopeReferenceValidator(geography);
  content = new ContentService({ database: iso.database, env: 'test', allowTestKeys: true, scopeReferences, markets: createMarketDefaultsProvider(geography) });
  const address = new AddressService({
    database: iso.database,
    cache: new MemoryConfigCache(),
    env: 'test',
    countryNames: async (countryCode, locale) => {
      const country = await geography.getCountry(countryCode);
      return (await content.render(country.displayNameContentKey, { locale, context: { country: countryCode } })).value;
    },
  });
  readiness.register(createAddressFormatReadinessCheck(address));
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({
    cfg: loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } }),
    verifier,
    configuration: {} as never,
    content,
    geography,
    address,
    readiness: async () => ({}),
  });
  await app.ready();
  staff = await adminToken('staff-a', ['geography-read', 'geography-write']);
  reader = await adminToken('reader-r', ['geography-read']);
  writer = await adminToken('writer-w', ['geography-write']);
  contentStaff = await adminToken('content-c', ['content-read', 'content-write']);
});
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});
afterEach(() => vi.restoreAllMocks());

// ====================================================================== the seeded US definition
describe('address API: the US format and areas seeded by migration 0008 (HTTP, real database)', () => {
  it('serves the US form definition from data: field order, requirement, lengths, LOOKUP mode, label keys, public key set', async () => {
    const r = await api('GET', '/countries/US/address-format');
    expect(r.status, r.raw).toBe(200);
    expect(r.headers['vary']).toContain('Authorization');
    const data: AddressFormatDto = r.body.data;
    expect(data).toMatchObject({ countryCode: 'US', version: 1, administrativeAreaMode: 'LOOKUP', postalCodeExample: '12345' });
    expect(Object.keys(data).sort()).toEqual(['administrativeAreaMode', 'countryCode', 'fields', 'postalCodeExample', 'version']);
    expect(data.fields.map((f) => [f.fieldType, f.property, f.contentLabelKey, f.required, f.maxLength, f.inputType])).toEqual([
      ['ADDRESS_LINE_1', 'addressLine1', 'address.field.line1', true, 100, 'TEXT'],
      ['ADDRESS_LINE_2', 'addressLine2', 'address.field.line2', false, 100, 'TEXT'],
      ['LOCALITY', 'locality', 'address.field.city', true, 60, 'TEXT'],
      ['ADMINISTRATIVE_AREA', 'administrativeArea', 'address.field.state', true, 50, 'LOOKUP'],
      ['POSTAL_CODE', 'postalCode', 'address.field.postal_code', true, 10, 'TEXT'],
    ]);
    expect(data.fields.map((f) => f.displayOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(data.fields[4]).toMatchObject({ validationPattern: '^[0-9]{5}(-[0-9]{4})?$', example: '12345', autocomplete: 'postal-code' });
    // the public view has no internals
    for (const w of ['status', 'displayTemplate', 'effectiveFrom', 'addressFormatId', 'address_format_id']) expect(r.raw, w).not.toContain(`"${w}"`);
  });

  it('labels are content keys: the US copy says State and ZIP code, any other country context gets the platform wording', async () => {
    const f: AddressFormatDto = (await api('GET', '/countries/US/address-format')).body.data;
    const keyOf = (t: string) => f.fields.find((x) => x.fieldType === t)!.contentLabelKey;
    expect(await label(keyOf('ADMINISTRATIVE_AREA'), 'US')).toBe('State');
    expect(await label(keyOf('POSTAL_CODE'), 'US')).toBe('ZIP code');
    expect(await label(keyOf('ADMINISTRATIVE_AREA'), 'ZZ')).toBe('State or region');
    expect(await label(keyOf('POSTAL_CODE'), 'ZZ')).toBe('Postal code');
    expect(await label(keyOf('ADDRESS_LINE_1'), 'US')).toBe('Address line 1');
    expect(await label(keyOf('LOCALITY'), 'US')).toBe('City');
    // every label key of the format resolves (a form can always be rendered)
    for (const x of f.fields) expect(await label(x.contentLabelKey, 'US')).toEqual(expect.any(String));
  });

  it('lists the 51 US areas (50 states and DC) in picker order with mode LOOKUP and the public key set', async () => {
    const r = await api('GET', '/countries/US/administrative-areas');
    expect(r.status).toBe(200);
    expect(r.headers['vary']).toContain('Authorization');
    expect(r.body.data.countryCode).toBe('US');
    expect(r.body.data.mode).toBe('LOOKUP');
    expect(r.body.data.areas).toHaveLength(51);
    const codes = r.body.data.areas.map((a: { code: string }) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['CA', 'DC', 'NY', 'TX', 'AK', 'HI']));
    expect(new Set(codes).size).toBe(51);
    expect(r.body.data.areas.find((a: { code: string }) => a.code === 'CA')).toEqual({
      code: 'CA',
      name: 'California',
      type: 'STATE',
      parentCode: null,
      displayOrder: null, // seeded without an explicit order: picker order falls back to the name
    });
    const names: string[] = r.body.data.areas.map((a: { name: string }) => a.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, 'en')));
    expect(r.body.data.areas.find((a: { code: string }) => a.code === 'DC')).toMatchObject({ name: 'District of Columbia', type: 'DISTRICT' });
    expect(r.raw).not.toContain('administrativeAreaId');
    expect(r.raw).not.toContain('"status"');
    // management view adds the status
    const m = await api('GET', '/countries/US/administrative-areas', reader);
    expect(m.body.data.areas[0].status).toBe('ACTIVE');
  });

  it('validates and normalizes a US address (area by code or by name, ZIP+4) and rejects a bad ZIP as a normal result with a managed message', async () => {
    const ok = await api('POST', '/addresses/validate', undefined, { address: irvine });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['vary']).toContain('Authorization');
    expect(ok.body.data).toEqual({
      valid: true,
      address: {
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
      },
      issues: [],
      formatVersion: 1,
    });
    // an area typed as its name, extra whitespace and ZIP+4
    const byName = await api('POST', '/addresses/validate', undefined, {
      address: { ...irvine, addressLine1: '  123   Main  St ', administrativeArea: 'california', postalCode: '92618-1234' },
    });
    expect(byName.body.data).toMatchObject({
      valid: true,
      address: { addressLine1: '123 Main St', administrativeAreaCode: 'CA', administrativeAreaName: 'California', postalCode: '92618-1234' },
    });

    const bad = await api('POST', '/addresses/validate', undefined, { address: { ...irvine, postalCode: '9261' } });
    expect(bad.status).toBe(200);
    expect(bad.body.data).toEqual({
      valid: false,
      address: null,
      issues: [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }],
      formatVersion: 1,
    });
    // the rejected value is never echoed
    expect(bad.raw).not.toContain('9261');
    // form and server show the same managed text: the key exists in content and resolves
    expect(await label(bad.body.data.issues[0].messageKey, 'US')).toBe('This value is not in the expected format.');

    const multi = await api('POST', '/addresses/validate', undefined, { address: { countryCode: 'US', administrativeArea: 'Atlantis', postalCode: 'ABCDE' } });
    expect(multi.body.data.valid).toBe(false);
    expect(multi.body.data.issues.map((i: { field: string; code: string }) => [i.field, i.code]).sort()).toEqual(
      [
        ['addressLine1', 'REQUIRED'],
        ['locality', 'REQUIRED'],
        ['administrativeArea', 'UNKNOWN_AREA'],
        ['postalCode', 'INVALID_FORMAT'],
      ].sort(),
    );
    const unsupported = await api('POST', '/addresses/validate', undefined, { address: { ...irvine, sortingCode: 'CEDEX 9' } });
    expect(unsupported.body.data.issues).toEqual([{ field: 'sortingCode', code: 'UNSUPPORTED_FIELD', messageKey: 'address.error.unsupported_field' }]);
    const tooLong = await api('POST', '/addresses/validate', undefined, { address: { ...irvine, locality: 'L'.repeat(61) } });
    expect(tooLong.body.data.issues).toEqual([{ field: 'locality', code: 'TOO_LONG', messageKey: 'address.error.too_long' }]);
  });

  it('every address issue code has a message key that exists in content and resolves (one text for the form and the server)', async () => {
    for (const code of ADDRESS_ISSUE_CODES) {
      const key = addressIssueMessageKey(code);
      expect(await label(key, 'US'), key).toEqual(expect.any(String));
      expect(await label(key, 'US'), key).not.toBe('');
    }
    expect(await label(addressIssueMessageKey('REQUIRED'), 'US')).toBe('This field is required.');
  });

  it('formats an address with the central formatter; includeCountry appends the country name as the last line; an invalid address is 400 with the issues', async () => {
    const plain = await api('POST', '/addresses/format', undefined, { address: irvine });
    expect(plain.status, plain.raw).toBe(200);
    expect(plain.headers['cache-control']).toBe('no-store');
    expect(plain.body.data.address).toMatchObject({ countryCode: 'US', addressLine1: '123 Main St', administrativeAreaCode: 'CA', postalCode: '92618' });
    expect(plain.body.data.formatted).toEqual({
      lines: ['123 Main St', 'Irvine, CA 92618'],
      text: '123 Main St\nIrvine, CA 92618',
      singleLine: '123 Main St, Irvine, CA 92618',
      formatVersion: 1,
    });
    const withCountry = await api('POST', '/addresses/format', undefined, {
      address: { ...irvine, addressLine2: 'Suite 4' },
      includeCountry: true,
      locale: 'en-US',
    });
    expect(withCountry.status, withCountry.raw).toBe(200);
    expect(withCountry.body.data.formatted.lines).toEqual(['123 Main St', 'Suite 4', 'Irvine, CA 92618', 'United States']);
    expect(withCountry.body.data.formatted.lines.at(-1)).toBe('United States');
    expect(withCountry.body.data.formatted.singleLine).toBe('123 Main St, Suite 4, Irvine, CA 92618, United States');

    const invalid = await api('POST', '/addresses/format', undefined, { address: { ...irvine, postalCode: 'nope' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({ category: 'VALIDATION', code: 'GEOGRAPHY_VALIDATION_FAILED' });
    expect(invalid.body.error.details.issues).toEqual([{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }]);
    expect(invalid.raw).not.toContain('nope');
  });

  it('is stateless: validating and formatting wrote no address row, and no route can read or create one', async () => {
    expect(await addressCount()).toBe(0);
    for (const [m, u, body] of [
      ['POST', '/addresses', { address: irvine }],
      ['GET', '/addresses/11111111-1111-4111-8111-111111111111', undefined],
    ] as const) {
      const r = await api(m, u, staff, body);
      expect([r.status, r.body.error.code], `${m} ${u}`).toEqual([404, 'ROUTE_NOT_FOUND']);
    }
    expect(await addressCount()).toBe(0);
  });

  it('protects the privacy of the address in transit: no address value reaches a log line, an error body or a metric label', async () => {
    const secrets = ['742 Evergreen Terrace', 'Springfield', '90210', 'Apt 3B', 'ZZ-SECRET-ORG'];
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const person = {
      countryCode: 'US',
      organization: 'ZZ-SECRET-ORG',
      addressLine1: '742 Evergreen Terrace',
      addressLine2: 'Apt 3B',
      locality: 'Springfield',
      administrativeArea: 'OR',
      postalCode: '90210',
    };
    const bodies: string[] = [];
    for (const [u, p] of [
      ['/addresses/validate', { address: person }], // valid
      ['/addresses/validate', { address: { ...person, postalCode: '9021' } }], // invalid
      ['/addresses/validate', { address: { ...person, extra: 'Springfield' } }], // malformed (strict)
      ['/addresses/validate', { address: { ...person, postalCode: 90210 } }], // wrong type
      ['/addresses/format', { address: person, includeCountry: true }],
      ['/addresses/format', { address: { ...person, administrativeArea: 'Atlantis' } }], // 400 with issues
      ['/addresses/format', { address: person, includeCountry: 'true' }],
    ] as const) {
      const r = await api('POST', u, undefined, p);
      bodies.push(r.raw);
    }
    // a 401 for a presented but invalid credential on the same route
    bodies.push(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/geography/addresses/validate',
          headers: { authorization: 'Bearer not.a.token' },
          payload: { address: person },
        })
      ).body,
    );
    write.mockRestore();
    expect(lines.length).toBeGreaterThan(0); // the request log lines were captured, so the assertion below is meaningful
    const logged = lines.join('\n');
    for (const s of secrets) expect(logged, `log contains ${s}`).not.toContain(s);
    // error responses never echo the input either (the success responses return the normalized address by design)
    for (const b of [bodies[1], bodies[2], bodies[3], bodies[5], bodies[6], bodies[7]]) {
      for (const s of ['Springfield', '742 Evergreen Terrace', '90210', '9021', 'Atlantis']) expect(b, s).not.toContain(s);
    }
    expect(await addressCount()).toBe(0);
  });
});

// ====================================================================== management lifecycle (US)
describe('address API: draft, list, publish, supersede (HTTP, real database)', () => {
  let v2Start = '';
  it('creates a DRAFT version 2: visible only to geography-read, not public, not in force', async () => {
    const current = (await api('GET', '/countries/US/address-formats', reader)).body.data as AddressFormatDto[];
    expect(current.map((f) => [f.version, f.status])).toEqual([[1, 'PUBLISHED']]);
    expect(current[0]!.effectiveTo).toBeNull();
    // the public GET of v1 is cached now: publication must invalidate it later
    expect((await api('GET', '/countries/US/address-format')).body.data.version).toBe(1);

    const body = draftFrom(current[0]!, (fields) => {
      fields.find((f) => f.fieldType === 'LOCALITY')!.maxLength = 80;
    });
    // authorization comes first and read-only cannot write
    expect((await api('POST', '/countries/US/address-formats', undefined, body)).status).toBe(401);
    expect((await api('POST', '/countries/US/address-formats', reader, body)).status).toBe(403);
    expect((await api('POST', '/countries/US/address-formats', contentStaff, body)).status).toBe(403);
    const created = await api('POST', '/countries/US/address-formats', writer, body);
    expect(created.status, created.raw).toBe(201);
    expect(created.body.data).toMatchObject({ countryCode: 'US', version: 2, status: 'DRAFT', administrativeAreaMode: 'LOOKUP' });
    expect(created.body.data.displayTemplate).toBe(current[0]!.displayTemplate);

    // visible only with geography-read (write implies read)
    for (const t of [staff, reader, writer]) {
      const list = await api('GET', '/countries/US/address-formats', t);
      expect(list.body.data.map((f: AddressFormatDto) => [f.version, f.status])).toEqual([
        [2, 'DRAFT'],
        [1, 'PUBLISHED'],
      ]);
    }
    expect((await api('GET', '/countries/US/address-formats')).status).toBe(401);
    expect((await api('GET', '/countries/US/address-formats', contentStaff)).status).toBe(403);
    // the draft is not in force: public and management "format in effect" are still v1; validation still uses v1
    expect((await api('GET', '/countries/US/address-format')).body.data.version).toBe(1);
    expect((await api('GET', '/countries/US/address-format', staff)).body.data).toMatchObject({ version: 1, status: 'PUBLISHED' });
    expect((await api('POST', '/addresses/validate', undefined, { address: irvine })).body.data.formatVersion).toBe(1);
    // a draft cannot be published twice as different versions, and an unknown version is a typed 404
    expect((await api('POST', '/countries/US/address-formats/9/publication', writer, { reason: 'nope' })).body.error.code).toBe(
      'GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND',
    );
    expect(await outbox(GEOGRAPHY_EVENTS.addressFormatPublished, 'US')).toHaveLength(0);
    expect((await formatAudit('ADDRESS_FORMAT_DRAFTED', 'US')).map((a) => a.actor)).toEqual(['system:migration', 'writer-w']); // v1 was drafted by the seed
  });

  it('publishes the draft: public GET shows version 2, version 1 is closed at the new start, the event and audit rows exist, re-publication is idempotent', async () => {
    const pub = await api('POST', '/countries/US/address-formats/2/publication', writer, { reason: 'wider locality' });
    expect(pub.status, pub.raw).toBe(200);
    expect(pub.body.data).toMatchObject({ version: 2, status: 'PUBLISHED', effectiveTo: null });
    v2Start = pub.body.data.effectiveFrom;
    await sleep(25); // the new period starts at the database clock; make sure "now" in the API is past it

    const publicNow = await api('GET', '/countries/US/address-format');
    expect(publicNow.body.data.version).toBe(2); // the cached v1 was invalidated by the publication
    expect(publicNow.body.data.fields.find((f: { fieldType: string }) => f.fieldType === 'LOCALITY').maxLength).toBe(80);
    expect((await api('POST', '/addresses/validate', undefined, { address: irvine })).body.data.formatVersion).toBe(2);
    expect((await api('POST', '/addresses/format', undefined, { address: irvine })).body.data.formatted.formatVersion).toBe(2);
    // the new limit applies at once
    const longCity = await api('POST', '/addresses/validate', undefined, { address: { ...irvine, locality: 'L'.repeat(70) } });
    expect(longCity.body.data.valid).toBe(true);

    const list = (await api('GET', '/countries/US/address-formats', reader)).body.data as AddressFormatDto[];
    expect(list.map((f) => [f.version, f.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'PUBLISHED'],
    ]);
    expect(new Date(list[1]!.effectiveTo!).toISOString()).toBe(new Date(v2Start).toISOString()); // v1 closed exactly when v2 starts
    expect(list[0]!.effectiveTo).toBeNull();
    expect(new Date(list[1]!.effectiveFrom!).getTime()).toBeLessThan(new Date(v2Start).getTime());

    const events = await outbox(GEOGRAPHY_EVENTS.addressFormatPublished, 'US');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregate_type: 'geography_address_format', actor_id: 'writer-w' });
    expect(events[0]!.payload_json).toEqual({ countryCode: 'US', version: 2, effectiveFrom: new Date(v2Start).toISOString() });
    expect(JSON.stringify(events[0]!.payload_json)).not.toMatch(/Main St|Irvine|postal/i);
    expect((await formatAudit('ADDRESS_FORMAT_PUBLISHED', 'US')).map((a) => a.actor)).toEqual(['system:migration', 'writer-w']);

    // idempotent: the same version published again changes nothing and emits nothing
    const again = await api('POST', '/countries/US/address-formats/2/publication', staff, { reason: 'again' });
    expect(again.status, again.raw).toBe(200);
    expect(again.body.data.effectiveFrom).toBe(v2Start);
    expect(await outbox(GEOGRAPHY_EVENTS.addressFormatPublished, 'US')).toHaveLength(1);
    expect(await formatAudit('ADDRESS_FORMAT_PUBLISHED', 'US')).toHaveLength(2); // the seed and version 2
    // management reads still agree
    expect((await api('GET', '/countries/US/address-format', staff)).body.data).toMatchObject({ version: 2, status: 'PUBLISHED' });
  });

  it('a label changed through the content lifecycle changes what the form shows, with no change to the format (PRD acceptance)', async () => {
    const f: AddressFormatDto = (await api('GET', '/countries/US/address-format')).body.data;
    const key = f.fields.find((x) => x.fieldType === 'ADDRESS_LINE_1')!.contentLabelKey;
    expect(await label(key, 'US')).toBe('Address line 1');
    await contentPublish(key, { locale: 'en-US', body: 'Street address', scopeType: 'COUNTRY', scopeRef: 'US' });
    await sleep(25);
    expect(await label(key, 'US')).toBe('Street address');
    expect(await label(key, 'ZZ')).toBe('Address line 1'); // other countries keep the platform copy
    // the format response is unchanged: the key is what the client renders
    const after: AddressFormatDto = (await api('GET', '/countries/US/address-format')).body.data;
    expect(after.fields.find((x) => x.fieldType === 'ADDRESS_LINE_1')!.contentLabelKey).toBe(key);
    // a label that does not exist is refused at draft creation (the foreign key to content)
    const current = (await api('GET', '/countries/US/address-formats', staff)).body.data[0] as AddressFormatDto;
    const bad = await api(
      'POST',
      '/countries/US/address-formats',
      staff,
      draftFrom(current, (fields) => {
        fields[0]!.contentLabelKey = 'address.field.does_not_exist';
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('UNKNOWN_CONTENT_KEY');
    expect(bad.raw).not.toMatch(/fk_address|constraint|SELECT/i);
  });
});

// ====================================================================== a new country needs data, not a deployment
describe('address API: a new country is configured through the management API alone', () => {
  it('country ZZ: areas, a province-LOOKUP format with an A1A 1A1 postal pattern, then validation normalizes k1a0b1 to K1A0B1', async () => {
    await geography.createCountry(countryReq('ZZ', '999'), A);
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'Pacific/Honolulu'");

    // nothing configured yet: the country is PLANNED (public 404), the management view has no format and no areas
    expect((await api('GET', '/countries/ZZ/address-format')).body.error.code).toBe('GEOGRAPHY_COUNTRY_NOT_FOUND');
    expect((await api('GET', '/countries/ZZ/administrative-areas')).status).toBe(404);
    expect((await api('POST', '/addresses/validate', undefined, { address: { countryCode: 'ZZ' } })).status).toBe(404);
    expect((await api('GET', '/countries/ZZ/address-format', staff)).body.error.code).toBe('GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND');
    expect((await api('GET', '/countries/ZZ/administrative-areas', staff)).body.data).toEqual({ countryCode: 'ZZ', mode: 'NONE', areas: [] });

    // areas (batch upsert, audited, event emitted only when something changed)
    const up = await api('POST', '/countries/ZZ/administrative-areas', writer, provinces);
    expect(up.status, up.raw).toBe(200);
    expect(up.body.data).toEqual({ countryCode: 'ZZ', added: 4, updated: 0 });
    const upAgain = await api('POST', '/countries/ZZ/administrative-areas', writer, provinces);
    expect(upAgain.body.data).toEqual({ countryCode: 'ZZ', added: 0, updated: 0 });
    expect(await outbox(GEOGRAPHY_EVENTS.administrativeAreasUpdated, 'ZZ')).toHaveLength(1);
    expect((await api('POST', '/countries/ZZ/administrative-areas', reader, provinces)).status).toBe(403);
    const mgmtAreas = await api('GET', '/countries/ZZ/administrative-areas', reader);
    expect(mgmtAreas.body.data.areas.map((a: { code: string; status: string }) => [a.code, a.status])).toEqual([
      ['ON', 'ACTIVE'],
      ['QC', 'ACTIVE'],
      ['YT', 'ACTIVE'],
      ['XX', 'INACTIVE'],
    ]);

    // draft -> not usable until published; validation by a staff member with the management view is a 404 for the draft
    const draft = await api('POST', '/countries/ZZ/address-formats', writer, canadianStyleDraft);
    expect(draft.status, draft.raw).toBe(201);
    expect(draft.body.data).toMatchObject({ version: 1, status: 'DRAFT', administrativeAreaMode: 'LOOKUP', postalCodeExample: 'K1A0B1' });
    expect((await api('POST', '/addresses/validate', staff, { address: { countryCode: 'ZZ' } })).body.error.code).toBe('GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND');
    const pub = await api('POST', '/countries/ZZ/address-formats/1/publication', writer, { reason: 'launch ZZ' });
    expect(pub.status, pub.raw).toBe(200);
    await sleep(25);
    expect(pub.body.data.status).toBe('PUBLISHED');

    // still PLANNED: invisible to the public, previewable with geography-read
    expect((await api('GET', '/countries/ZZ/address-format')).status).toBe(404);
    expect((await api('GET', '/countries/ZZ/administrative-areas')).status).toBe(404);
    expect((await api('POST', '/addresses/validate', undefined, { address: { countryCode: 'ZZ' } })).status).toBe(404);
    expect((await api('POST', '/addresses/format', undefined, { address: { countryCode: 'ZZ' } })).status).toBe(404);
    const preview = await api('GET', '/countries/ZZ/address-format', reader);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ countryCode: 'ZZ', version: 1, status: 'PUBLISHED' });
    expect((await api('GET', '/countries/ZZ/administrative-areas', reader)).status).toBe(200);

    const ca = { countryCode: 'ZZ', addressLine1: '1 Rideau St', locality: 'Ottawa', administrativeArea: 'ON' };
    // the management view validates with the new format before the country is public
    for (const input of ['k1a0b1', 'k1a 0b1', ' K1A  0B1 ', 'K1a0B1']) {
      const r = await api('POST', '/addresses/validate', staff, { address: { ...ca, postalCode: input } });
      expect(r.status, r.raw).toBe(200);
      expect(r.body.data.valid, input).toBe(true);
      expect(r.body.data.address, input).toMatchObject({
        countryCode: 'ZZ',
        postalCode: 'K1A0B1',
        administrativeAreaCode: 'ON',
        administrativeAreaName: 'Ontario',
      });
    }
    const badPostal = await api('POST', '/addresses/validate', staff, { address: { ...ca, postalCode: '12345' } });
    expect(badPostal.body.data.issues).toEqual([{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }]);
    // retired areas are not selectable
    const retired = await api('POST', '/addresses/validate', staff, { address: { ...ca, administrativeArea: 'XX', postalCode: 'K1A0B1' } });
    expect(retired.body.data.issues).toEqual([{ field: 'administrativeArea', code: 'UNKNOWN_AREA', messageKey: 'address.error.unknown_area' }]);
    const formatted = await api('POST', '/addresses/format', staff, { address: { ...ca, postalCode: 'k1a 0b1' } });
    expect(formatted.status, formatted.raw).toBe(200);
    expect(formatted.body.data.formatted.lines).toEqual(['1 Rideau St', 'Ottawa ON K1A0B1']);
    // the US keeps working unchanged next to it
    expect((await api('POST', '/addresses/validate', undefined, { address: irvine })).body.data.valid).toBe(true);
    expect(await addressCount()).toBe(0);
  });

  it('refuses to activate a market in a country without an address format (NOT_READY, ADDRESS_FORMAT) and allows it after publication', async () => {
    await geography.createCountry(countryReq('MX', '484', { timeZones: ['America/Mexico_City'] }), A);
    // MX has no format: create its market's country dependencies, activate the country, then try the market
    await q("UPDATE geography.time_zones SET status = 'ACTIVE' WHERE iana_name = 'America/Mexico_City'");
    expect((await api('POST', '/countries/MX/activation', staff, { active: true, reason: 'launch' })).status).toBe(200);
    const mk = await api('POST', '/markets', staff, {
      code: 'devtest-addr-mx',
      name: 'Address Test Market',
      countryCode: 'MX',
      defaultLocale: 'en-US',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Mexico_City',
      reason: 'integration test',
    });
    expect(mk.status, mk.raw).toBe(201);

    const readiness = await api('GET', '/markets/devtest-addr-mx/readiness', reader);
    expect(readiness.body.data.ready).toBe(false);
    expect(readiness.body.data.checks.find((c: { code: string }) => c.code === 'ADDRESS_FORMAT')).toMatchObject({ passed: false });
    const refused = await api('POST', '/markets/devtest-addr-mx/activation', staff, { active: true, reason: 'launch' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('GEOGRAPHY_NOT_READY');
    expect(refused.body.error.details.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ADDRESS_FORMAT', detail: expect.stringContaining('no address format') })]),
    );
    expect((await q<{ status: string }>("SELECT status FROM geography.markets WHERE code = 'devtest-addr-mx'"))[0]!.status).toBe('PLANNED');

    // publish a format for MX through the API; the market can now be activated
    const draft = await api('POST', '/countries/MX/address-formats', staff, {
      displayTemplate: '{ADDRESS_LINE_1}\n{POSTAL_CODE} {LOCALITY}, {ADMINISTRATIVE_AREA}',
      fields: [
        { fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 },
        { fieldType: 'LOCALITY', contentLabelKey: 'address.field.city', required: true, maxLength: 60 },
        { fieldType: 'ADMINISTRATIVE_AREA', contentLabelKey: 'address.field.state', required: false, maxLength: 50 },
        {
          fieldType: 'POSTAL_CODE',
          contentLabelKey: 'address.field.postal_code',
          required: true,
          maxLength: 5,
          validationPattern: '^[0-9]{5}$',
          example: '01000',
        },
      ],
      reason: 'integration test',
    });
    expect(draft.status, draft.raw).toBe(201);
    expect(draft.body.data.administrativeAreaMode).toBe('FREE_TEXT');
    // a draft alone does not satisfy the check
    expect((await api('POST', '/markets/devtest-addr-mx/activation', staff, { active: true, reason: 'launch' })).status).toBe(409);
    expect((await api('POST', '/countries/MX/address-formats/1/publication', staff, { reason: 'launch MX' })).status).toBe(200);
    await sleep(25);
    const ready = await api('GET', '/markets/devtest-addr-mx/readiness', reader);
    expect(ready.body.data.ready).toBe(true);
    expect(ready.body.data.checks.find((c: { code: string }) => c.code === 'ADDRESS_FORMAT')).toMatchObject({ passed: true });
    const activated = await api('POST', '/markets/devtest-addr-mx/activation', staff, { active: true, reason: 'launch' });
    expect(activated.status, activated.raw).toBe(200);
    expect(activated.body.data.status).toBe('ACTIVE');

    // now public (country ACTIVE): the new format is served and a free-text area is kept as text
    expect((await api('GET', '/countries/MX/address-format')).body.data).toMatchObject({ countryCode: 'MX', administrativeAreaMode: 'FREE_TEXT' });
    const v = await api('POST', '/addresses/validate', undefined, {
      address: { countryCode: 'MX', addressLine1: 'Calle 1', locality: 'Oaxaca', administrativeArea: 'Oaxaca', postalCode: '68000' },
    });
    expect(v.body.data).toMatchObject({ valid: true, address: { administrativeAreaCode: null, administrativeAreaName: 'Oaxaca', postalCode: '68000' } });
    expect(await addressCount()).toBe(0);
  });

  it('the existing US markets stay activatable: the check passes where a format is in force', async () => {
    const r = await api('GET', '/markets/la-oc/readiness', reader);
    expect(r.body.data.checks.find((c: { code: string }) => c.code === 'ADDRESS_FORMAT')).toMatchObject({ passed: true });
  });
});
