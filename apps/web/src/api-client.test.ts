// The address methods of the typed API client with an injected fetch: URLs, request bodies, contract validation and ApiError mapping.
import { describe, expect, it, vi } from 'vitest';
import { CORRELATION_HEADER, type AddressInput } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';

const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>, extra: { correlationId?: () => string; accessToken?: () => string } = {}) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: f as unknown as typeof fetch, ...extra });
const errorBody = (code: string, category: string, details?: Record<string, unknown>) => ({
  error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234', ...(details ? { details } : {}) },
});

const field = (fieldType: string, property: string, displayOrder: number, over: Record<string, unknown> = {}) => ({
  fieldType,
  property,
  displayOrder,
  contentLabelKey: `address.field.${property}`,
  required: true,
  maxLength: 100,
  inputType: 'TEXT',
  validationPattern: null,
  example: null,
  autocomplete: null,
  normalization: null,
  ...over,
});
const FORMAT = {
  countryCode: 'US',
  version: 1,
  fields: [field('ADDRESS_LINE_1', 'addressLine1', 1), field('ADMINISTRATIVE_AREA', 'administrativeArea', 2, { inputType: 'LOOKUP' })],
  administrativeAreaMode: 'LOOKUP',
  postalCodeExample: '12345',
};
const AREAS = { countryCode: 'US', mode: 'LOOKUP', areas: [{ code: 'CA', name: 'California', type: 'STATE', parentCode: null, displayOrder: null }] };
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
const address: AddressInput = { countryCode: 'US', addressLine1: '123 Main St', locality: 'Irvine', administrativeArea: 'CA', postalCode: '92618' };

describe('api client: address format and administrative areas', () => {
  it('getAddressFormat GETs the country path, sends no body and validates the contract', async () => {
    const f = stubFetch(() => json(200, { data: FORMAT, meta }));
    const out = await clientWith(f, { correlationId: () => 'web-corr-12345', accessToken: () => 'tok' }).getAddressFormat('US');
    expect(out.fields.map((x) => x.fieldType)).toEqual(['ADDRESS_LINE_1', 'ADMINISTRATIVE_AREA']);
    expect(out.administrativeAreaMode).toBe('LOOKUP');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/geography/countries/US/address-format');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)[CORRELATION_HEADER]).toBe('web-corr-12345');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('listAdministrativeAreas GETs the areas path and validates the contract', async () => {
    const f = stubFetch(() => json(200, { data: AREAS, meta }));
    const out = await clientWith(f).listAdministrativeAreas('US');
    expect(out).toEqual(AREAS);
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/geography/countries/US/administrative-areas');
  });

  it('maps a 404 (country not public, or no format) to ApiError with the standard code and category', async () => {
    const f = stubFetch(() => json(404, errorBody('GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND', 'NOT_FOUND')));
    const err = await clientWith(f)
      .getAddressFormat('FR')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND', category: 'NOT_FOUND', correlationId: 'corr-err-1234' });
    await expect(
      clientWith(stubFetch(() => json(404, errorBody('GEOGRAPHY_COUNTRY_NOT_FOUND', 'NOT_FOUND')))).listAdministrativeAreas('CA'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'GEOGRAPHY_COUNTRY_NOT_FOUND',
    });
  });

  it('encodes the country code in the path', async () => {
    const f = stubFetch(() => json(200, { data: FORMAT, meta }));
    await clientWith(f).getAddressFormat('a/../b');
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/geography/countries/a%2F..%2Fb/address-format');
  });

  it('turns a body that violates the contract into UNEXPECTED_RESPONSE instead of crashing', async () => {
    const f = stubFetch(() => json(200, { data: { ...FORMAT, administrativeAreaMode: 'SOMETIMES' }, meta }));
    await expect(clientWith(f).getAddressFormat('US')).rejects.toMatchObject({ status: 200, code: 'UNEXPECTED_RESPONSE', category: 'INTERNAL' });
    await expect(clientWith(stubFetch(() => json(200, { data: { countryCode: 'US' }, meta }))).listAdministrativeAreas('US')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('reports an unreachable API as a DEPENDENCY error', async () => {
    const f = stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await clientWith(f)
      .getAddressFormat('US')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'API_UNREACHABLE', category: 'DEPENDENCY' });
  });
});

describe('api client: validate and format (stateless)', () => {
  it('validateAddress POSTs { address } to the validate path and returns the result as is', async () => {
    const result = { valid: true, address: NORMALIZED, issues: [], formatVersion: 1 };
    const f = stubFetch(() => json(200, { data: result, meta }));
    const out = await clientWith(f).validateAddress(address);
    expect(out).toEqual(result);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/geography/addresses/validate');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ address });
    expect(init?.cache).toBe('no-store');
  });

  it('validateAddress returns an invalid address as a normal result with message keys', async () => {
    const result = {
      valid: false,
      address: null,
      issues: [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }],
      formatVersion: 1,
    };
    const out = await clientWith(stubFetch(() => json(200, { data: result, meta }))).validateAddress({ ...address, postalCode: '9261' });
    expect(out.valid).toBe(false);
    expect(out.address).toBeNull();
    expect(out.issues).toEqual(result.issues);
  });

  it('validateAddress maps a malformed request (400) to ApiError and a country without a format (404)', async () => {
    const bad = await clientWith(
      stubFetch(() => json(400, errorBody('VALIDATION_FAILED', 'VALIDATION', { issues: [{ path: 'address.extra', message: 'Unrecognized key' }] }))),
    )
      .validateAddress(address)
      .catch((e) => e);
    expect(bad).toBeInstanceOf(ApiError);
    expect(bad).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', category: 'VALIDATION' });
    expect(bad.details).toEqual({ issues: [{ path: 'address.extra', message: 'Unrecognized key' }] });
    await expect(
      clientWith(stubFetch(() => json(404, errorBody('GEOGRAPHY_ADDRESS_FORMAT_NOT_FOUND', 'NOT_FOUND')))).validateAddress({ countryCode: 'FR' }),
    ).rejects.toMatchObject({
      status: 404,
      category: 'NOT_FOUND',
    });
  });

  it('formatAddress sends only the options that were given (no undefined keys) and validates the response', async () => {
    const result = {
      address: NORMALIZED,
      formatted: {
        lines: ['123 Main St', 'Irvine, CA 92618'],
        text: '123 Main St\nIrvine, CA 92618',
        singleLine: '123 Main St, Irvine, CA 92618',
        formatVersion: 1,
      },
    };
    const f = stubFetch(() => json(200, { data: result, meta }));
    const client = clientWith(f);
    expect(await client.formatAddress(address)).toEqual(result);
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/geography/addresses/format');
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ address });
    await client.formatAddress(address, { includeCountry: true, locale: 'en-US' });
    expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({ address, includeCountry: true, locale: 'en-US' });
    await client.formatAddress(address, { includeCountry: false });
    expect(JSON.parse(String(f.mock.calls[2]![1]?.body))).toEqual({ address, includeCountry: false });
  });

  it('formatAddress of an invalid address is an ApiError (400) that carries the issues (field, code, message key) and no values', async () => {
    const issues = [{ field: 'postalCode', code: 'INVALID_FORMAT', messageKey: 'address.error.invalid_format' }];
    const f = stubFetch(() => json(400, errorBody('GEOGRAPHY_VALIDATION_FAILED', 'VALIDATION', { issues })));
    const err = await clientWith(f)
      .formatAddress({ ...address, postalCode: '9261' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'GEOGRAPHY_VALIDATION_FAILED', category: 'VALIDATION' });
    expect(err.details).toEqual({ issues });
    expect(JSON.stringify(err)).not.toContain('9261');
    expect(String(err.message)).not.toContain('9261');
  });

  it('turns an unexpected non-JSON failure into UNEXPECTED_RESPONSE and a contract violation in a 200 likewise', async () => {
    const html = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(clientWith(html).validateAddress(address)).rejects.toMatchObject({ status: 502, code: 'UNEXPECTED_RESPONSE', category: 'INTERNAL' });
    const shape = stubFetch(() => json(200, { data: { valid: 'yes' }, meta }));
    await expect(clientWith(shape).validateAddress(address)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    await expect(clientWith(stubFetch(() => json(200, { data: { address: NORMALIZED }, meta }))).formatAddress(address)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('reports an unreachable API as a DEPENDENCY error for the POST methods too', async () => {
    const f = stubFetch(() => {
      throw new Error('socket hang up');
    });
    for (const call of [(c: ReturnType<typeof clientWith>) => c.validateAddress(address), (c: ReturnType<typeof clientWith>) => c.formatAddress(address)]) {
      const err = await call(clientWith(f)).catch((e) => e);
      expect(err).toMatchObject({ status: 0, code: 'API_UNREACHABLE', category: 'DEPENDENCY' });
      expect(String(err.message)).not.toContain('123 Main St');
    }
  });
});
