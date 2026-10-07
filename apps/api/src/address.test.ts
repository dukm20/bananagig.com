// Unit tests of the address API module with a fake AddressService (the real rules are covered by packages/geography and address.itest.ts):
// authentication and authorization, public versus management views, stateless validate/format semantics, strict raw-body validation, error mapping,
// and the privacy guarantees (no internal or raw field in a response, no route that creates or reads a persisted address).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ADDRESS_FORMAT_VERSION_BOUNDS, ErrorResponse, GEOGRAPHY_ERROR_CODES, decimalIntegerMessage, type GeographyErrorCode } from '@bananagig/contracts';
import { GeographyError, type AddressFormatModel, type AddressService, type AdministrativeAreaModel } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;

const svc = {
  getAddressFormat: vi.fn(),
  listAddressFormats: vi.fn(),
  listAdministrativeAreas: vi.fn(),
  validateAddress: vi.fn(),
  formatAddress: vi.fn(),
  createFormatDraft: vi.fn(),
  publishFormat: vi.fn(),
  upsertAdministrativeAreas: vi.fn(),
};

const READ = 'geography-read';
const WRITE = 'geography-write';
const adminToken = (roles: string[]) =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
    },
  });
type Method = 'GET' | 'POST' | 'PUT';
const call = async (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1/geography${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const keysOf = (o: object) => Object.keys(o).sort();
const noMocksCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);
const vary = (r: { headers: Record<string, unknown> }) =>
  String(r.headers['vary'] ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase());

// ---------------------------------------------------------------- fixtures
const T0 = new Date('2026-01-01T00:00:00.000Z');
const field = (
  fieldType: AddressFormatModel['fields'][number]['fieldType'],
  displayOrder: number,
  over: Partial<AddressFormatModel['fields'][number]> = {},
) => ({
  fieldType,
  displayOrder,
  contentLabelKey: `address.field.${fieldType.toLowerCase()}`,
  required: true,
  maxLength: 100,
  inputType: 'TEXT' as const,
  validationPattern: null,
  example: null,
  autocomplete: null,
  normalization: null,
  ...over,
});
const US_FORMAT: AddressFormatModel = {
  addressFormatId: 'format-id-secret',
  countryCode: 'US',
  version: 2,
  status: 'PUBLISHED',
  displayTemplate: '{ADDRESS_LINE_1}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}',
  effectiveFrom: T0,
  effectiveTo: null,
  fields: [
    field('ADDRESS_LINE_1', 1),
    field('LOCALITY', 2, { maxLength: 60 }),
    field('ADMINISTRATIVE_AREA', 3, { inputType: 'LOOKUP' }),
    field('POSTAL_CODE', 4, { maxLength: 10, validationPattern: '^[0-9]{5}$', example: '12345' }),
  ],
};
const CA_AREA: AdministrativeAreaModel = {
  administrativeAreaId: 'area-id-secret',
  code: 'CA',
  name: 'California',
  type: 'STATE',
  parentCode: null,
  displayOrder: 5,
  status: 'ACTIVE',
};
const OLD_AREA: AdministrativeAreaModel = { ...CA_AREA, code: 'XX', name: 'Retired', status: 'INACTIVE' };
const validAddress = { countryCode: 'US', addressLine1: '123 Main St', locality: 'Irvine', administrativeArea: 'CA', postalCode: '92618' };
const NORMALIZED = {
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
const FORMATTED = {
  lines: ['123 Main St', 'Irvine, CA 92618'],
  text: '123 Main St\nIrvine, CA 92618',
  singleLine: '123 Main St, Irvine, CA 92618',
  formatVersion: 2,
};
const draftBody = {
  displayTemplate: '{ADDRESS_LINE_1}',
  fields: [{ fieldType: 'ADDRESS_LINE_1', contentLabelKey: 'address.field.line1', required: true, maxLength: 100 }],
  reason: 'unit test',
};
const publishBody = { reason: 'unit test' };
const areasBody = { areas: [{ code: 'ON', name: 'Ontario', type: 'PROVINCE' }], reason: 'unit test' };
const geoError = (code: GeographyErrorCode, details: Record<string, unknown> = {}) => new GeographyError(code, `${code} happened`, details);

const PUBLIC_FORMAT_KEYS = ['administrativeAreaMode', 'countryCode', 'fields', 'postalCodeExample', 'version'];
const MGMT_FORMAT_KEYS = [...PUBLIC_FORMAT_KEYS, 'displayTemplate', 'effectiveFrom', 'effectiveTo', 'status'].sort();
const FIELD_KEYS = [
  'autocomplete',
  'contentLabelKey',
  'displayOrder',
  'example',
  'fieldType',
  'inputType',
  'maxLength',
  'normalization',
  'property',
  'required',
  'validationPattern',
];
const FORBIDDEN_WORDS = ['rawInput', 'raw_input', 'addressFormatId', 'administrativeAreaId', 'format-id-secret', 'area-id-secret', 'createdBy', 'actor'];

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, configuration: {} as never, address: svc as unknown as AddressService, readiness: async () => ({}) });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.getAddressFormat.mockImplementation(async (code: string, o: { management?: boolean } = {}) => {
    // PLANNED is the fake's non-public country
    if (code === 'CA' && !o.management) throw geoError('COUNTRY_NOT_FOUND', { code });
    if (code === 'FR') throw geoError('ADDRESS_FORMAT_NOT_FOUND', { code });
    return code === 'CA' ? { ...US_FORMAT, countryCode: 'CA' } : US_FORMAT;
  });
  svc.listAddressFormats.mockResolvedValue([{ ...US_FORMAT, version: 3, status: 'DRAFT' }, US_FORMAT]);
  svc.listAdministrativeAreas.mockImplementation(async (_code: string, o: { management?: boolean } = {}) => ({
    mode: 'LOOKUP',
    areas: o.management ? [CA_AREA, OLD_AREA] : [CA_AREA],
  }));
  svc.validateAddress.mockResolvedValue({
    outcome: { valid: true, address: NORMALIZED, administrativeAreaId: 'area-id-secret', issues: [], rawInput: { postalCode: '92618' } },
    format: US_FORMAT,
  });
  svc.formatAddress.mockResolvedValue({ address: NORMALIZED, formatted: FORMATTED });
  svc.createFormatDraft.mockResolvedValue({ ...US_FORMAT, version: 3, status: 'DRAFT' });
  svc.publishFormat.mockResolvedValue(US_FORMAT);
  svc.upsertAdministrativeAreas.mockResolvedValue({ countryCode: 'CA', added: 1, updated: 0 });
});

// ====================================================================== access control
type Route = { method: Method; url: string; permission: string; body?: unknown };
const managementRoutes: Route[] = [
  { method: 'GET', url: '/countries/US/address-formats', permission: READ },
  { method: 'POST', url: '/countries/US/address-formats', permission: WRITE, body: draftBody },
  { method: 'POST', url: '/countries/US/address-formats/2/publication', permission: WRITE, body: publishBody },
  { method: 'POST', url: '/countries/US/administrative-areas', permission: WRITE, body: areasBody },
];
const bodiless = (r: Route) => (r.method === 'GET' ? [undefined] : [undefined, {}, { garbage: true }]);

describe('address API access control (management routes)', () => {
  it('returns 401 before any validation on every management route, with an empty, invalid or missing body and malformed params', async () => {
    for (const r of managementRoutes) {
      for (const payload of bodiless(r)) {
        const res = await call(r.method, r.url, undefined, payload);
        expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(payload)}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
        expect(res.headers['www-authenticate']).toContain('Bearer');
      }
      expect((await call(r.method, r.url, 'not.a.token', r.method === 'GET' ? undefined : {})).statusCode).toBe(401);
    }
    for (const [m, u] of [
      ['GET', '/countries/us/address-formats'],
      ['POST', '/countries/USA/address-formats'],
      ['POST', '/countries/US/address-formats/0/publication'],
      ['POST', '/countries/US/address-formats/abc/publication'],
      ['POST', '/countries/us/administrative-areas'],
    ] as const)
      expect((await call(m, u, undefined, m === 'GET' ? undefined : {})).statusCode, `${m} ${u}`).toBe(401);
    expect(noMocksCalled()).toBe(true);
  });

  it('returns 403 (before validation) when an admin lacks the permission: geography-read cannot write, and no role at all cannot do anything', async () => {
    for (const r of managementRoutes) {
      const refused = r.permission === READ ? [[]] : [[READ], []];
      for (const roles of refused) {
        const res = await call(r.method, r.url, await adminToken(roles), r.method === 'GET' ? undefined : {});
        expect(res.statusCode, `${r.method} ${r.url} [${roles}]`).toBe(403);
        expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    }
    // content and configuration roles grant nothing, and neither does a web-client token that carries the role names
    const foreign = await adminToken(['content-read', 'content-write', 'configuration-read', 'configuration-write']);
    const spoofed = await signToken(keys, { claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [READ, WRITE] } } } });
    for (const t of [foreign, spoofed])
      for (const r of managementRoutes) expect((await call(r.method, r.url, t, r.method === 'GET' ? undefined : {})).statusCode).toBe(403);
    expect(noMocksCalled()).toBe(true);
  });

  it('geography-write implies read: a write-only token reads the management list and the management view of the public reads', async () => {
    const writeOnly = await adminToken([WRITE]);
    const list = await call('GET', '/countries/US/address-formats', writeOnly);
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((f: { version: number; status: string }) => [f.version, f.status])).toEqual([
      [3, 'DRAFT'],
      [2, 'PUBLISHED'],
    ]);
    expect(keysOf((await call('GET', '/countries/CA/address-format', writeOnly)).json().data)).toEqual(MGMT_FORMAT_KEYS);
    expect(svc.getAddressFormat).toHaveBeenLastCalledWith('CA', { management: true });
    expect((await call('GET', '/countries/US/administrative-areas', writeOnly)).json().data.areas).toHaveLength(2);
    expect(svc.listAdministrativeAreas).toHaveBeenLastCalledWith('US', { management: true });
  });

  it('with the right permission: validates the body (400), calls the service with the token subject as actor and returns the management view', async () => {
    const t = await adminToken([READ, WRITE]);
    for (const r of managementRoutes) {
      const ok = await call(r.method, r.url, t, r.body);
      expect(ok.statusCode, `${r.method} ${r.url}`).toBe(r.method === 'POST' && r.url.endsWith('/address-formats') ? 201 : 200);
      if (r.method !== 'GET') expect((await call(r.method, r.url, t, {})).statusCode, `${r.method} ${r.url} empty`).toBe(400);
    }
    expect(svc.createFormatDraft).toHaveBeenCalledWith('US', expect.objectContaining({ displayTemplate: '{ADDRESS_LINE_1}', reason: 'unit test' }), 'admin-a');
    expect(svc.publishFormat).toHaveBeenCalledWith('US', 2, { reason: 'unit test' }, 'admin-a');
    expect(svc.upsertAdministrativeAreas).toHaveBeenCalledWith('US', expect.objectContaining({ reason: 'unit test' }), 'admin-a');
    // mutations answer with the management view of the stored row
    const created = await call('POST', '/countries/US/address-formats', t, draftBody);
    expect(created.statusCode).toBe(201);
    expect(keysOf(created.json().data)).toEqual(MGMT_FORMAT_KEYS);
    expect(created.json().data.status).toBe('DRAFT');
    expect(keysOf((await call('POST', '/countries/US/address-formats/2/publication', t, publishBody)).json().data)).toEqual(MGMT_FORMAT_KEYS);
    expect(keysOf((await call('GET', '/countries/US/address-formats', t)).json().data[0])).toEqual(MGMT_FORMAT_KEYS);
    expect((await call('POST', '/countries/US/administrative-areas', t, areasBody)).json().data).toEqual({ countryCode: 'CA', added: 1, updated: 0 });
  });

  it('rejects unknown fields, wrong types and malformed bodies with the standard 400 and never calls the service', async () => {
    const t = await adminToken([READ, WRITE]);
    const field0 = draftBody.fields[0]!;
    const cases: [string, unknown][] = [
      ['/countries/US/address-formats', { ...draftBody, extra: 1 }],
      ['/countries/US/address-formats', { ...draftBody, reason: '' }],
      ['/countries/US/address-formats', { ...draftBody, reason: 123 }],
      ['/countries/US/address-formats', { ...draftBody, fields: [] }],
      ['/countries/US/address-formats', { ...draftBody, fields: [{ ...field0, extra: true }] }],
      ['/countries/US/address-formats', { ...draftBody, fields: [{ ...field0, required: 'true' }] }],
      ['/countries/US/address-formats', { ...draftBody, fields: [{ ...field0, maxLength: 0 }] }],
      ['/countries/US/address-formats', { ...draftBody, fields: [{ ...field0, fieldType: 'COUNTRY' }] }],
      ['/countries/US/address-formats', { ...draftBody, fields: [{ ...field0, contentLabelKey: 'Not A Key' }] }],
      ['/countries/US/address-formats', { ...draftBody, effectiveFrom: 'yesterday' }],
      ['/countries/US/address-formats/2/publication', {}],
      ['/countries/US/address-formats/2/publication', { reason: 'r', extra: 1 }],
      ['/countries/US/address-formats/2/publication', { reason: 7 }],
      ['/countries/US/administrative-areas', { ...areasBody, areas: [] }],
      ['/countries/US/administrative-areas', { ...areasBody, areas: [{ code: 'on', name: 'Ontario', type: 'PROVINCE' }] }],
      ['/countries/US/administrative-areas', { ...areasBody, areas: [{ code: 'ON', name: 'Ontario', type: 'GALAXY' }] }],
      ['/countries/US/administrative-areas', { ...areasBody, areas: [{ code: 'ON', name: 'Ontario', type: 'PROVINCE', active: 'yes' }] }],
      ['/countries/US/administrative-areas', { ...areasBody, extra: 1 }],
    ];
    for (const [u, body] of cases) {
      const res = await call('POST', u, t, body);
      expect(res.statusCode, `${u} ${JSON.stringify(body)}`).toBe(400);
      expect(errorOf(res).category).toBe('VALIDATION');
    }
    expect((await call('POST', '/countries/US/address-formats', t)).statusCode).toBe(400);
    expect(svc.createFormatDraft).not.toHaveBeenCalled();
    expect(svc.publishFormat).not.toHaveBeenCalled();
    expect(svc.upsertAdministrativeAreas).not.toHaveBeenCalled();
  });

  it('requires the version parameter to be a positive integer and the country code to be well formed', async () => {
    const t = await adminToken([WRITE]);
    for (const v of ['0', '-1', '1.5', 'abc', '100001']) {
      const res = await call('POST', `/countries/US/address-formats/${v}/publication`, t, publishBody);
      expect(res.statusCode, v).toBe(400);
      expect(errorOf(res).category).toBe('VALIDATION');
    }
    for (const c of ['us', 'USA', 'U', '1A']) {
      for (const [m, u, body] of [
        ['GET', `/countries/${c}/address-formats`, undefined],
        ['POST', `/countries/${c}/address-formats`, draftBody],
        ['POST', `/countries/${c}/address-formats/1/publication`, publishBody],
        ['POST', `/countries/${c}/administrative-areas`, areasBody],
        ['GET', `/countries/${c}/address-format`, undefined],
        ['GET', `/countries/${c}/administrative-areas`, undefined],
      ] as const) {
        expect((await call(m, u, t, body)).statusCode, `${m} ${u}`).toBe(400);
      }
    }
    expect(noMocksCalled()).toBe(true);
    expect((await call('POST', '/countries/US/address-formats/100000/publication', t, publishBody)).statusCode).toBe(200);
    expect(svc.publishFormat).toHaveBeenCalledWith('US', 100000, publishBody, 'admin-a');
  });
});

// ====================================================================== public reads
describe('address API public reads', () => {
  it('serves the format and the areas anonymously with the exact public key sets, ordered fields and the public service flag', async () => {
    const format = await call('GET', '/countries/US/address-format');
    expect(format.statusCode).toBe(200);
    const data = format.json().data;
    expect(keysOf(data)).toEqual(PUBLIC_FORMAT_KEYS);
    expect(data).toMatchObject({ countryCode: 'US', version: 2, administrativeAreaMode: 'LOOKUP', postalCodeExample: '12345' });
    expect(data.fields.map((f: { fieldType: string }) => f.fieldType)).toEqual(['ADDRESS_LINE_1', 'LOCALITY', 'ADMINISTRATIVE_AREA', 'POSTAL_CODE']);
    expect(data.fields.map((f: { property: string }) => f.property)).toEqual(['addressLine1', 'locality', 'administrativeArea', 'postalCode']);
    for (const f of data.fields) expect(keysOf(f)).toEqual(FIELD_KEYS);
    expect(keysOf(format.json().meta)).toEqual(['correlationId']);
    expect(svc.getAddressFormat).toHaveBeenCalledWith('US', { management: false });

    const areas = await call('GET', '/countries/US/administrative-areas');
    expect(areas.statusCode).toBe(200);
    expect(areas.json().data).toEqual({
      countryCode: 'US',
      mode: 'LOOKUP',
      areas: [{ code: 'CA', name: 'California', type: 'STATE', parentCode: null, displayOrder: 5 }],
    });
    expect(svc.listAdministrativeAreas).toHaveBeenCalledWith('US', { management: false });
    for (const r of [format, areas])
      for (const w of [...FORBIDDEN_WORDS, 'status', 'displayTemplate', 'effectiveFrom']) expect(r.body, w).not.toContain(`"${w}"`);
    expect(format.body).not.toContain('format-id-secret');
    expect(areas.body).not.toContain('area-id-secret');
  });

  it('treats a non-public country as not found for every non-privileged caller and previews it for geography-read', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const noGeo = await adminToken(['content-read']);
    for (const t of [undefined, customer, noGeo]) {
      const res = await call('GET', '/countries/CA/address-format', t);
      expect(res.statusCode).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'GEOGRAPHY_COUNTRY_NOT_FOUND' });
    }
    const t = await adminToken([READ]);
    const preview = await call('GET', '/countries/CA/address-format', t);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ countryCode: 'CA', status: 'PUBLISHED', displayTemplate: US_FORMAT.displayTemplate });
    expect(preview.json().data.effectiveFrom).toBe(T0.toISOString());
    expect(preview.json().data.effectiveTo).toBeNull();
    // inactive areas and their status only for the management view
    const mgmtAreas = (await call('GET', '/countries/US/administrative-areas', t)).json().data.areas;
    expect(mgmtAreas.map((a: { code: string; status: string }) => [a.code, a.status])).toEqual([
      ['CA', 'ACTIVE'],
      ['XX', 'INACTIVE'],
    ]);
    expect(mgmtAreas[0]).not.toHaveProperty('administrativeAreaId');
  });

  it('answers 404 ADDRESS_FORMAT_NOT_FOUND for a country without a format in effect', async () => {
    const res = await call('GET', '/countries/FR/address-format');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND' });
  });

  it('answers 401 for a credential that is presented but invalid, on every public route (never silently downgraded to anonymous)', async () => {
    const expired = await signToken(keys, { claims: { sub: 'x', azp: 'bananagig-admin' }, expiresInSec: -60 });
    for (const bad of ['not.a.token', expired]) {
      for (const [m, u, body] of [
        ['GET', '/countries/US/address-format', undefined],
        ['GET', '/countries/US/administrative-areas', undefined],
        ['POST', '/addresses/validate', { address: validAddress }],
        ['POST', '/addresses/format', { address: validAddress }],
      ] as const) {
        const res = await call(m, u, bad, body);
        expect(res.statusCode, `${m} ${u}`).toBe(401);
        expect(vary(res)).toContain('authorization');
      }
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('sends Vary: Authorization on every public route (successes, 404s and 400s), once, for anonymous and authenticated callers', async () => {
    const tokens = [undefined, await adminToken([READ]), await adminToken(['content-read'])];
    for (const t of tokens) {
      for (const [m, u, body] of [
        ['GET', '/countries/US/address-format', undefined],
        ['GET', '/countries/CA/address-format', undefined],
        ['GET', '/countries/FR/address-format', undefined],
        ['GET', '/countries/US/administrative-areas', undefined],
        ['GET', '/countries/us/administrative-areas', undefined],
        ['POST', '/addresses/validate', { address: validAddress }],
        ['POST', '/addresses/validate', { address: validAddress, extra: 1 }],
        ['POST', '/addresses/format', { address: validAddress }],
      ] as const) {
        const r = await call(m, u, t, body);
        expect(vary(r), `${m} ${u} ${r.statusCode} ${t ? 'token' : 'anonymous'}`).toContain('authorization');
        expect(
          String(r.headers['vary'])
            .toLowerCase()
            .match(/authorization/g),
        ).toHaveLength(1);
      }
    }
  });

  it('management routes are not public reads and carry no Vary of their own making', async () => {
    const r = await call('GET', '/countries/US/address-formats', await adminToken([READ]));
    expect(r.statusCode).toBe(200);
    expect(vary(r)).not.toContain('authorization');
  });

  it('hides the management-only fields and areas from the public even if the service returned them (defense in depth)', async () => {
    svc.getAddressFormat.mockResolvedValue({
      ...US_FORMAT,
      createdBy: 'staff-1',
      actor: 'staff-1',
      fields: US_FORMAT.fields.map((f) => ({ ...f, secret: 'x' })),
    });
    svc.listAdministrativeAreas.mockResolvedValue({ mode: 'LOOKUP', areas: [{ ...CA_AREA, status: 'INACTIVE', createdBy: 'staff-1' }] });
    const f = await call('GET', '/countries/US/address-format');
    const a = await call('GET', '/countries/US/administrative-areas');
    expect(keysOf(f.json().data)).toEqual(PUBLIC_FORMAT_KEYS);
    expect(keysOf(f.json().data.fields[0])).toEqual(FIELD_KEYS);
    expect(keysOf(a.json().data.areas[0])).toEqual(['code', 'displayOrder', 'name', 'parentCode', 'type']);
    for (const r of [f, a]) for (const w of ['staff-1', 'secret', 'area-id-secret', 'format-id-secret']) expect(r.body, w).not.toContain(w);
  });
});

// ====================================================================== stateless validate and format
describe('address API validate and format (stateless)', () => {
  it('validate: 200 with the normalized address, the format version and no-store; the public flag is passed to the service', async () => {
    const res = await call('POST', '/addresses/validate', undefined, { address: validAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().data).toEqual({ valid: true, address: NORMALIZED, issues: [], formatVersion: 2 });
    expect(keysOf(res.json().data)).toEqual(['address', 'formatVersion', 'issues', 'valid']);
    expect(svc.validateAddress).toHaveBeenCalledWith(validAddress, { management: false });
  });

  it('validate: an invalid address is a normal 200 result (valid=false) whose issues carry only field, code and messageKey', async () => {
    svc.validateAddress.mockResolvedValue({
      outcome: {
        valid: false,
        address: null,
        administrativeAreaId: null,
        issues: [
          { field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format', value: '9261', rawInput: '9261' },
          { field: 'locality', code: 'REQUIRED', messageKey: 'address.error.required' },
        ],
      },
      format: US_FORMAT,
    });
    const res = await call('POST', '/addresses/validate', undefined, { address: { ...validAddress, postalCode: '9261' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      valid: false,
      address: null,
      issues: [
        { field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' },
        { field: 'locality', code: 'REQUIRED', messageKey: 'address.error.required' },
      ],
      formatVersion: 2,
    });
    expect(res.body).not.toContain('9261');
    expect(res.body).not.toContain('rawInput');
  });

  it('validate: 400 only for malformed requests (never reaching the service), 404 for a country without a format', async () => {
    const bad: unknown[] = [
      undefined,
      {},
      { address: {} },
      { address: { addressLine1: 'x' } },
      { address: { countryCode: 'us' } },
      { address: { countryCode: 'USA' } },
      { address: { ...validAddress, extra: 'x' } }, // .strict() AddressInput
      { address: { ...validAddress, rawInput: 'x' } },
      { address: { ...validAddress, postalCode: 92618 } },
      { address: { ...validAddress, addressLine1: null } },
      { address: { ...validAddress, locality: ['Irvine'] } },
      { address: { ...validAddress, addressLine1: 'x'.repeat(501) } },
      { address: validAddress, includeCountry: true },
      { address: validAddress, extra: 1 },
      { address: 'US' },
      [validAddress],
    ];
    for (const body of bad) {
      const res = await call('POST', '/addresses/validate', undefined, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
    }
    expect(svc.validateAddress).not.toHaveBeenCalled();
    svc.validateAddress.mockRejectedValueOnce(geoError('ADDRESS_FORMAT_NOT_FOUND', { code: 'FR' }));
    const none = await call('POST', '/addresses/validate', undefined, { address: { countryCode: 'FR' } });
    expect(none.statusCode).toBe(404);
    expect(errorOf(none).code).toBe('GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND');
  });

  it('the validation 400 never echoes a rejected value', async () => {
    const res = await call('POST', '/addresses/validate', undefined, {
      address: { ...validAddress, addressLine1: 'SECRET-STREET-77', extra: 'SECRET-EXTRA-88', postalCode: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SECRET-STREET-77');
    expect(res.body).not.toContain('SECRET-EXTRA-88');
    expect(res.body).not.toContain('12345');
  });

  it('format: 200 with the address and the formatted lines, no-store, and locale/includeCountry passed through', async () => {
    const res = await call('POST', '/addresses/format', undefined, { address: validAddress });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().data).toEqual({ address: NORMALIZED, formatted: FORMATTED });
    expect(svc.formatAddress).toHaveBeenLastCalledWith(validAddress, { management: false, locale: undefined, includeCountry: undefined });
    await call('POST', '/addresses/format', undefined, { address: validAddress, locale: 'en-US', includeCountry: true });
    expect(svc.formatAddress).toHaveBeenLastCalledWith(validAddress, { management: false, locale: 'en-US', includeCountry: true });
  });

  it('format: an invalid address is 400 with the issues (field, code, messageKey only); other service errors map as usual', async () => {
    svc.formatAddress.mockRejectedValueOnce(
      geoError('VALIDATION_FAILED', {
        issues: [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format', value: '9261' }],
        constraint: 'ck_secret',
        cause: 'password=hunter2',
      }),
    );
    const res = await call('POST', '/addresses/format', undefined, { address: { ...validAddress, postalCode: '9261' } });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'GEOGRAPHY_VALIDATION_FAILED' });
    expect(errorOf(res).details).toEqual({
      issues: [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format', value: '9261' }],
    });
    for (const leak of ['hunter2', 'ck_secret', 'cause', 'constraint']) expect(res.body, leak).not.toContain(leak);
  });

  it('format: strict body, includeCountry must be a real boolean, locale must be a locale tag, and nothing reaches the service when it is not', async () => {
    const bad: unknown[] = [
      undefined,
      {},
      { address: validAddress, includeCountry: 'true' },
      { address: validAddress, includeCountry: 1 },
      { address: validAddress, includeCountry: null },
      { address: validAddress, locale: 5 },
      { address: validAddress, locale: 'not a locale' },
      { address: validAddress, extra: true },
      { address: { ...validAddress, extra: 1 } },
      { address: { ...validAddress, postalCode: 92618 } },
    ];
    for (const body of bad) {
      const res = await call('POST', '/addresses/format', undefined, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
    }
    expect(svc.formatAddress).not.toHaveBeenCalled();
  });

  it('rejects a body larger than 16 KiB on validate and format (and a body just under the limit is read)', async () => {
    const huge = { address: { ...validAddress, organization: 'x'.repeat(500) }, filler: 'y'.repeat(17 * 1024) };
    for (const u of ['/addresses/validate', '/addresses/format']) {
      const res = await call('POST', u, undefined, huge);
      expect(res.statusCode, u).toBe(413);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
    }
    expect(svc.validateAddress).not.toHaveBeenCalled();
    expect(svc.formatAddress).not.toHaveBeenCalled();
    // under the limit the body is parsed (here it fails the strict schema, not the size limit)
    const under = await call('POST', '/addresses/validate', undefined, { address: validAddress, filler: 'y'.repeat(15 * 1024) });
    expect(under.statusCode).toBe(400);
    expect(errorOf(under).code).toBe('VALIDATION_FAILED');
  });

  it('privileged callers (geography-read) get the management view of the service: the flag is true only with the role', async () => {
    const t = await adminToken([READ]);
    await call('POST', '/addresses/validate', t, { address: validAddress });
    expect(svc.validateAddress).toHaveBeenLastCalledWith(validAddress, { management: true });
    await call('POST', '/addresses/format', t, { address: validAddress });
    expect(svc.formatAddress).toHaveBeenLastCalledWith(validAddress, expect.objectContaining({ management: true }));
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    for (const token of [undefined, customer, await adminToken(['content-read'])]) {
      await call('POST', '/addresses/validate', token, { address: validAddress });
      expect(svc.validateAddress).toHaveBeenLastCalledWith(validAddress, { management: false });
    }
  });

  it('never returns an internal or raw field from validate or format, even when the service returns them', async () => {
    svc.formatAddress.mockResolvedValue({
      address: { ...NORMALIZED, rawInput: { addressLine1: 'raw' }, addressId: 'address-id-secret' },
      formatted: { ...FORMATTED, status: 'PUBLISHED', displayTemplate: 'tpl' },
    });
    const v = await call('POST', '/addresses/validate', undefined, { address: validAddress });
    const f = await call('POST', '/addresses/format', undefined, { address: validAddress });
    for (const r of [v, f]) {
      for (const w of [
        ...FORBIDDEN_WORDS,
        'addressId',
        'address-id-secret',
        'displayTemplate',
        'status',
        'validationStatus',
        'validationSource',
        'latitude',
        'longitude',
      ]) {
        expect(r.body, w).not.toContain(w);
      }
    }
    expect(keysOf(v.json().data.address)).toEqual(keysOf(NORMALIZED));
    expect(keysOf(f.json().data.address)).toEqual(keysOf(NORMALIZED));
    expect(keysOf(f.json().data.formatted)).toEqual(['formatVersion', 'lines', 'singleLine', 'text']);
  });

  it('is stateless: nothing but the validate/format service operations is ever called by those routes', async () => {
    await call('POST', '/addresses/validate', undefined, { address: validAddress });
    await call('POST', '/addresses/format', undefined, { address: validAddress });
    const called = Object.entries(svc)
      .filter(([, f]) => f.mock.calls.length > 0)
      .map(([name]) => name)
      .sort();
    expect(called).toEqual(['formatAddress', 'validateAddress']);
  });
});

// ====================================================================== privacy by design: no persisted address API
describe('address API has no route that creates or reads a persisted address', () => {
  it.each([
    ['POST', '/addresses', { address: validAddress }],
    ['POST', '/addresses', validAddress],
    ['GET', '/addresses', undefined],
    ['GET', '/addresses/11111111-1111-4111-8111-111111111111', undefined],
    ['GET', '/addresses/abc', undefined],
    ['PUT', '/addresses/abc', validAddress],
    ['POST', '/addresses/abc/format', undefined],
    ['GET', '/addresses/abc/raw-input', undefined],
  ] as const)('%s %s is 404 ROUTE_NOT_FOUND, anonymous and with geography-write', async (method, url, body) => {
    for (const t of [undefined, await adminToken([READ, WRITE])]) {
      const res = await call(method as Method, url, t, body);
      expect(res.statusCode).toBe(404);
      expect(errorOf(res)).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    }
    expect(noMocksCalled()).toBe(true);
  });

  it('the OpenAPI document lists exactly the eight address operations and none that persists or returns a stored address', () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, { operationId?: string; security?: unknown[] }>> };
    const ops = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith('/api/v1/geography/'))
      .flatMap(([path, methods]) => Object.entries(methods).map(([m, o]) => ({ path, m, id: o.operationId ?? '', security: o.security })));
    expect(ops.map((o) => o.id).sort()).toEqual(
      [
        'createGeographyAddressFormat',
        'formatGeographyAddress',
        'getGeographyAddressFormat',
        'listGeographyAddressFormats',
        'listGeographyAdministrativeAreas',
        'publishGeographyAddressFormat',
        'upsertGeographyAdministrativeAreas',
        'validateGeographyAddress',
      ].sort(),
    );
    expect(
      Object.keys(doc.paths)
        .filter((p) => /\/addresses(\/|$)/.test(p))
        .sort(),
    ).toEqual(['/api/v1/geography/addresses/format', '/api/v1/geography/addresses/validate']);
    const publicOps = ['getGeographyAddressFormat', 'listGeographyAdministrativeAreas', 'validateGeographyAddress', 'formatGeographyAddress'];
    for (const o of ops) expect(o.security, o.id).toEqual(publicOps.includes(o.id) ? [] : [{ bearerAuth: [] }]);
  });

  it('is not registered when the app is built without an address service', async () => {
    const verifier = createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    });
    const bare = await buildApp({ cfg, verifier, configuration: {} as never, readiness: async () => ({}) });
    await bare.ready();
    expect((await bare.inject({ method: 'GET', url: '/api/v1/geography/countries/US/address-format' })).statusCode).toBe(404);
    expect((await bare.inject({ method: 'POST', url: '/api/v1/geography/addresses/validate', payload: { address: validAddress } })).statusCode).toBe(404);
    await bare.close();
  });
});

// ====================================================================== error mapping
describe('address API error mapping', () => {
  const expected: Record<GeographyErrorCode, [number, string]> = {
    COUNTRY_NOT_FOUND: [404, 'NOT_FOUND'],
    ADDRESS_FORMAT_NOT_FOUND: [404, 'NOT_FOUND'],
    MARKET_NOT_FOUND: [404, 'NOT_FOUND'],
    CURRENCY_NOT_FOUND: [404, 'NOT_FOUND'],
    TIME_ZONE_NOT_FOUND: [404, 'NOT_FOUND'],
    LOCALE_NOT_FOUND: [404, 'NOT_FOUND'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    INVALID_STATE: [409, 'CONFLICT'],
    NOT_READY: [409, 'CONFLICT'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
  };
  it('covers every GeographyError code', () => {
    expect(Object.keys(expected).sort()).toEqual([...GEOGRAPHY_ERROR_CODES].sort());
  });

  it.each(GEOGRAPHY_ERROR_CODES)('maps %s on public and management address routes without leaking internals', async (code) => {
    const [status, category] = expected[code];
    const error = () =>
      new GeographyError(code, `${code} happened`, {
        reason: 'SOME_REASON',
        constraint: 'ex_address_formats__no_overlap',
        cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM geography.address_formats password=hunter2',
      });
    const check = (r: { statusCode: number; body: string; json: () => unknown }) => {
      expect(r.statusCode).toBe(status);
      expect(errorOf(r)).toMatchObject({ category, code: `GEOGRAPHY_${code}` });
      for (const leak of ['ECONNREFUSED', 'SELECT', 'hunter2', 'cause', 'constraint', 'ex_address_formats', 'geography.address_formats'])
        expect(r.body, leak).not.toContain(leak);
      if (code === 'UNAVAILABLE') expect(errorOf(r).details).toBeUndefined();
      else expect(errorOf(r).details).toMatchObject({ reason: 'SOME_REASON' });
    };
    const t = await adminToken([READ, WRITE]);
    svc.getAddressFormat.mockRejectedValueOnce(error());
    check(await call('GET', '/countries/US/address-format'));
    svc.listAdministrativeAreas.mockRejectedValueOnce(error());
    check(await call('GET', '/countries/US/administrative-areas'));
    svc.validateAddress.mockRejectedValueOnce(error());
    check(await call('POST', '/addresses/validate', undefined, { address: validAddress }));
    svc.formatAddress.mockRejectedValueOnce(error());
    check(await call('POST', '/addresses/format', undefined, { address: validAddress }));
    svc.listAddressFormats.mockRejectedValueOnce(error());
    check(await call('GET', '/countries/US/address-formats', t));
    svc.createFormatDraft.mockRejectedValueOnce(error());
    check(await call('POST', '/countries/US/address-formats', t, draftBody));
    svc.publishFormat.mockRejectedValueOnce(error());
    check(await call('POST', '/countries/US/address-formats/2/publication', t, publishBody));
    svc.upsertAdministrativeAreas.mockRejectedValueOnce(error());
    check(await call('POST', '/countries/US/administrative-areas', t, areasBody));
  });

  it('VALIDATION_FAILED passes details.issues through with exactly field, code and messageKey as given by the service', async () => {
    const issues = [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }];
    svc.formatAddress.mockRejectedValueOnce(geoError('VALIDATION_FAILED', { issues }));
    const res = await call('POST', '/addresses/format', undefined, { address: validAddress });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual({ issues });
  });

  it('CONFLICT and INVALID_STATE are 409 with the reason (publication races, period overlap, areas in use)', async () => {
    const t = await adminToken([WRITE]);
    svc.publishFormat.mockRejectedValueOnce(geoError('CONFLICT', { reason: 'FORMAT_PERIOD_OVERLAP' }));
    const overlap = await call('POST', '/countries/US/address-formats/3/publication', t, publishBody);
    expect(overlap.statusCode).toBe(409);
    expect(errorOf(overlap)).toMatchObject({ category: 'CONFLICT', code: 'GEOGRAPHY_CONFLICT', details: { reason: 'FORMAT_PERIOD_OVERLAP' } });
    svc.upsertAdministrativeAreas.mockRejectedValueOnce(geoError('INVALID_STATE', { reason: 'AREAS_IN_USE' }));
    const inUse = await call('POST', '/countries/US/administrative-areas', t, areasBody);
    expect(inUse.statusCode).toBe(409);
    expect(errorOf(inUse)).toMatchObject({ code: 'GEOGRAPHY_INVALID_STATE', details: { reason: 'AREAS_IN_USE' } });
  });

  it('reports unexpected (non-geography) failures as a generic 500 without the cause', async () => {
    svc.getAddressFormat.mockRejectedValueOnce(new Error('boom: password=hunter2'));
    const r = await call('GET', '/countries/US/address-format');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('hunter2');
    svc.validateAddress.mockRejectedValueOnce(new Error('boom: 123 Main St'));
    const v = await call('POST', '/addresses/validate', undefined, { address: validAddress });
    expect(v.statusCode).toBe(500);
    expect(v.body).not.toContain('123 Main St');
  });

  it('echoes the correlation id in the header and the response meta, for successes and errors', async () => {
    const ok = await call('GET', '/countries/US/address-format', undefined, undefined, { 'x-correlation-id': 'corr-addr-1' });
    expect(ok.json().meta.correlationId).toBe('corr-addr-1');
    expect(ok.headers['x-correlation-id']).toBe('corr-addr-1');
    const missing = await call('GET', '/countries/FR/address-format', undefined, undefined, { 'x-correlation-id': 'corr-addr-2' });
    expect(errorOf(missing).correlationId).toBe('corr-addr-2');
    const posted = await call('POST', '/addresses/validate', undefined, { address: validAddress }, { 'x-correlation-id': 'corr-addr-3' });
    expect(posted.json().meta.correlationId).toBe('corr-addr-3');
  });
});

// ====================================================================== strict integer version parameter (GEO-002A)
// Fastify's Ajv coercion read `1e3` as 1000, `1.0`, `+1` and `01` as 1, `0x10` as 16 and ` 1` as 1. The version is parsed by the one strict parser
// (parseDecimalInteger) in a preValidation hook, so only canonical base-10 text reaches the service.
describe('address API strict version path parameter', () => {
  const publish = (version: string, token?: string) => call('POST', `/countries/US/address-formats/${version}/publication`, token, publishBody);

  it.each([
    ['1', 1],
    ['2', 2],
    ['10', 10],
    ['1000', 1000],
    ['100000', 100000],
  ])('accepts the canonical version %s and hands the service the number %i', async (version, expected) => {
    svc.publishFormat.mockResolvedValue(US_FORMAT);
    const res = await publish(version, await adminToken([WRITE]));
    expect(res.statusCode).toBe(200);
    expect(svc.publishFormat).toHaveBeenCalledWith('US', expected, publishBody, 'admin-a');
    expect(typeof svc.publishFormat.mock.calls[0]![1]).toBe('number');
  });

  it.each([
    ['1e3', 'exponent'],
    ['1E3', 'exponent'],
    ['1e2', 'exponent'],
    ['1e999', 'exponent overflow'],
    ['1.0', 'decimal point'],
    ['1.', 'trailing decimal point'],
    ['.5', 'leading decimal point'],
    ['+1', 'plus sign'],
    ['-1', 'negative'],
    ['-0', 'negative zero'],
    ['0', 'zero (below the minimum)'],
    ['00', 'leading zeros'],
    ['01', 'leading zero'],
    ['007', 'leading zeros'],
    ['%201', 'leading space'],
    ['1%20', 'trailing space'],
    ['%091', 'leading tab'],
    ['1%0A', 'trailing line feed'],
    ['%C2%A01', 'leading non-breaking space'],
    ['0x10', 'hex'],
    ['0X1F', 'hex'],
    ['0b1', 'binary'],
    ['0o7', 'octal'],
    ['Infinity', 'Infinity'],
    ['-Infinity', 'negative Infinity'],
    ['NaN', 'NaN'],
    ['1_000', 'separator'],
    ['1,000', 'separator'],
    ['%D9%A1', 'Arabic-Indic digit'],
    ['%EF%BC%91', 'full-width digit'],
    ['9007199254740993', 'beyond the safe integer range'],
    ['100001', 'above the maximum'],
    ['abc', 'letters'],
  ])('rejects %s (%s) with the standard validation envelope and never calls the service', async (version) => {
    const res = await publish(version, await adminToken([WRITE]));
    expect(res.statusCode).toBe(400);
    const error = errorOf(res);
    expect(error.category).toBe('VALIDATION');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('Request validation failed');
    expect(typeof error.correlationId).toBe('string');
    const issues = (error.details as { issues: { path: string; message: string }[] }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('params.version');
    // the message is the fixed text of the bounds: nothing the client sent is interpolated into it
    expect(issues[0]!.message).toBe(decimalIntegerMessage(ADDRESS_FORMAT_VERSION_BOUNDS));
    expect(noMocksCalled()).toBe(true);
  });

  it('keeps 401 before 400 and 403 before 400: authorization still wins over parameter validation', async () => {
    expect((await publish('1e3')).statusCode).toBe(401);
    expect((await publish('1e3', await adminToken([READ]))).statusCode).toBe(403);
    expect((await publish('1e3', await adminToken([]))).statusCode).toBe(403);
    expect(noMocksCalled()).toBe(true);
  });

  it('validates the version before the body, and still rejects a bad body for a good version', async () => {
    const t = await adminToken([WRITE]);
    const badBoth = await call('POST', '/countries/US/address-formats/1e3/publication', t, { reason: 7 });
    expect((errorOf(badBoth).details as { issues: { path: string }[] }).issues[0]!.path).toBe('params.version');
    const badBody = await call('POST', '/countries/US/address-formats/1/publication', t, { reason: 7 });
    expect(badBody.statusCode).toBe(400);
    expect((errorOf(badBody).details as { issues: { path: string }[] }).issues[0]!.path).toBe('reason');
    expect(noMocksCalled()).toBe(true);
  });
});
