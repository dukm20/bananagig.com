// The address methods of the typed API client with an injected fetch: URLs, request bodies, contract validation and ApiError mapping.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER, type AddressInput } from '@bananagig/contracts';
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

// ---------------------------------------------------------------- ID-002: email verification calls
const MASKED = 'c***@b***.localhost';
const PENDING_SUMMARY = {
  emailVerificationStatus: 'PENDING',
  primary: null,
  pending: { maskedEmail: MASKED, purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: '2026-10-07T12:00:00.000Z', expiresAt: '2026-10-07T12:30:00.000Z' },
};
const VERIFIED_SUMMARY = {
  emailVerificationStatus: 'VERIFIED',
  primary: { maskedEmail: MASKED, verifiedAt: '2026-10-07T12:01:00.000Z', source: 'USER_ENTERED' },
  pending: null,
};
const EMAIL_DETAIL = { ...PENDING_SUMMARY, resendAvailableAt: '2026-10-07T12:00:30.000Z', attemptsRemaining: 5, codeLength: 6, validityMinutes: 30 };
const EMAIL_SENT = {
  sentAt: '2026-10-07T12:00:00.000Z',
  expiresAt: '2026-10-07T12:30:00.000Z',
  resendAvailableAt: '2026-10-07T12:00:30.000Z',
  codeLength: 6,
  validityMinutes: 30,
  email: PENDING_SUMMARY,
};
// distinctive values a person submits: they may appear in a request BODY and nowhere else
const CODE_MARKER = '8675309';
const TOKEN_MARKER = `lnk${'Q'.repeat(40)}`;
const EMAIL_MARKER = 'leak.marker+tag@example.test';
const requestHeaders = (f: ReturnType<typeof stubFetch>, call = 0) => f.mock.calls[call]![1]?.headers as Record<string, string>;
const EMAIL_PATH = '/api/v1/account/email';
const EMAIL_CALLS = {
  getAccountEmail: {
    method: 'GET',
    path: EMAIL_PATH,
    body: undefined,
    data: EMAIL_DETAIL,
    call: (c: ReturnType<typeof clientWith>, o?: { activeRole?: string; clientIp?: string }) => c.getAccountEmail(o),
  },
  setAccountEmail: {
    method: 'POST',
    path: EMAIL_PATH,
    body: { email: EMAIL_MARKER },
    data: { changed: true, email: PENDING_SUMMARY },
    call: (c: ReturnType<typeof clientWith>, o?: { activeRole?: string; clientIp?: string }) => c.setAccountEmail(EMAIL_MARKER, o),
  },
  sendEmailVerification: {
    method: 'POST',
    path: `${EMAIL_PATH}/verification/send`,
    body: {},
    data: EMAIL_SENT,
    call: (c: ReturnType<typeof clientWith>, o?: { activeRole?: string; clientIp?: string }) => c.sendEmailVerification(o),
  },
  confirmEmailCode: {
    method: 'POST',
    path: `${EMAIL_PATH}/verification/confirm-code`,
    body: { code: CODE_MARKER },
    data: { changed: true, email: VERIFIED_SUMMARY },
    call: (c: ReturnType<typeof clientWith>, o?: { activeRole?: string; clientIp?: string }) => c.confirmEmailCode(CODE_MARKER, o),
  },
  confirmEmailLink: {
    method: 'POST',
    path: `${EMAIL_PATH}/verification/confirm-link`,
    body: { token: TOKEN_MARKER },
    data: { changed: true, email: VERIFIED_SUMMARY },
    call: (c: ReturnType<typeof clientWith>, o?: { activeRole?: string; clientIp?: string }) => c.confirmEmailLink(TOKEN_MARKER, o),
  },
} as const;
type EmailCallName = keyof typeof EMAIL_CALLS;
const EMAIL_CALL_NAMES = Object.keys(EMAIL_CALLS) as EmailCallName[];

describe('api client: email verification', () => {
  const opts = { correlationId: () => 'web-corr-12345', accessToken: () => 'access-token-1' };

  it('getAccountEmail GETs /account/email with the bearer token and no body, and returns the validated state', async () => {
    const f = stubFetch(() => json(200, { data: EMAIL_DETAIL, meta }));
    const state = await clientWith(f, opts).getAccountEmail();
    expect(state).toEqual(EMAIL_DETAIL);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/email');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe('no-store');
    expect(requestHeaders(f)).toEqual({ accept: 'application/json', authorization: 'Bearer access-token-1', [CORRELATION_HEADER]: 'web-corr-12345' });
  });

  it('getAccountEmail parses every shape of the state: NONE, PENDING, REPLACEMENT_PENDING over a verified primary, VERIFIED', async () => {
    const states = [
      { emailVerificationStatus: 'NONE', primary: null, pending: null, resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 30 },
      EMAIL_DETAIL,
      {
        ...VERIFIED_SUMMARY,
        pending: { maskedEmail: 'n***@n***.test', purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING', lastSentAt: null, expiresAt: null },
        resendAvailableAt: null,
        attemptsRemaining: 5,
        codeLength: 8,
        validityMinutes: 15,
      },
      { ...VERIFIED_SUMMARY, resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 30 },
    ];
    for (const data of states) expect(await clientWith(stubFetch(() => json(200, { data, meta }))).getAccountEmail()).toEqual(data);
  });

  it('sends x-active-role and x-forwarded-for when given, each on its own, and neither when absent or empty', async () => {
    const f = stubFetch((url, init) => json(200, { data: init.method === 'GET' ? EMAIL_DETAIL : EMAIL_SENT, meta }));
    const client = clientWith(f, opts);
    await client.getAccountEmail({ activeRole: 'PROVIDER', clientIp: '203.0.113.7' });
    expect(requestHeaders(f, 0)).toMatchObject({ [ACTIVE_ROLE_HEADER]: 'PROVIDER', 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer access-token-1' });
    await client.getAccountEmail({ activeRole: 'PROVIDER' });
    expect(requestHeaders(f, 1)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
    expect('x-forwarded-for' in requestHeaders(f, 1)).toBe(false);
    await client.getAccountEmail({ clientIp: '2001:db8::1' });
    expect(requestHeaders(f, 2)['x-forwarded-for']).toBe('2001:db8::1');
    expect(ACTIVE_ROLE_HEADER in requestHeaders(f, 2)).toBe(false);
    for (const o of [undefined, {}, { activeRole: undefined, clientIp: undefined }, { activeRole: '', clientIp: '' }]) {
      await client.getAccountEmail(o);
      const headers = requestHeaders(f, f.mock.calls.length - 1);
      expect(ACTIVE_ROLE_HEADER in headers, JSON.stringify(o)).toBe(false);
      expect('x-forwarded-for' in headers, JSON.stringify(o)).toBe(false);
    }
    // the POST calls forward them the same way
    await client.sendEmailVerification({ activeRole: 'CUSTOMER', clientIp: '198.51.100.9' });
    expect(requestHeaders(f, f.mock.calls.length - 1)).toMatchObject({
      [ACTIVE_ROLE_HEADER]: 'CUSTOMER',
      'x-forwarded-for': '198.51.100.9',
      'content-type': 'application/json',
    });
  });

  it('getAccountEmail rejects a body that misses a field or has the wrong type with UNEXPECTED_RESPONSE (never a half-parsed state)', async () => {
    const without = (key: string) => Object.fromEntries(Object.entries(EMAIL_DETAIL).filter(([k]) => k !== key));
    const broken: Record<string, unknown> = {
      'no emailVerificationStatus': without('emailVerificationStatus'),
      'no primary': without('primary'),
      'no pending': without('pending'),
      'no resendAvailableAt': without('resendAvailableAt'),
      'no attemptsRemaining': without('attemptsRemaining'),
      'no codeLength': without('codeLength'),
      'no validityMinutes': without('validityMinutes'),
      'unknown status': { ...EMAIL_DETAIL, emailVerificationStatus: 'WEIRD' },
      'code length as text': { ...EMAIL_DETAIL, codeLength: '6' },
      'fractional validity': { ...EMAIL_DETAIL, validityMinutes: 30.5 },
      'attempts as text': { ...EMAIL_DETAIL, attemptsRemaining: 'five' },
      'unknown purpose': { ...EMAIL_DETAIL, pending: { ...PENDING_SUMMARY.pending, purpose: 'SOMETHING' } },
      'pending without a masked address': { ...EMAIL_DETAIL, pending: { ...PENDING_SUMMARY.pending, maskedEmail: undefined } },
      'primary with an unknown source': { ...EMAIL_DETAIL, primary: { ...VERIFIED_SUMMARY.primary, source: 'GUESSED' } },
      'not an object': 'oops',
      'an array': [],
      nothing: null,
    };
    for (const [what, data] of Object.entries(broken))
      await expect(clientWith(stubFetch(() => json(200, { data, meta }))).getAccountEmail(), what).rejects.toMatchObject({
        status: 200,
        code: 'UNEXPECTED_RESPONSE',
        category: 'INTERNAL',
      });
    await expect(clientWith(stubFetch(() => json(200, { data: EMAIL_DETAIL }))).getAccountEmail(), 'no meta').rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
    await expect(clientWith(stubFetch(() => new Response('<html>', { status: 200 }))).getAccountEmail(), 'not JSON').rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('getAccountEmail drops fields outside the contract: a full address a faulty server added never reaches the caller', async () => {
    const data = { ...EMAIL_DETAIL, email: EMAIL_MARKER, code: CODE_MARKER, pending: { ...PENDING_SUMMARY.pending, address: EMAIL_MARKER } };
    const state = await clientWith(stubFetch(() => json(200, { data, meta }))).getAccountEmail();
    expect(JSON.stringify(state)).not.toMatch(/leak|8675309|example\.test/);
    expect(state).toEqual(EMAIL_DETAIL);
  });

  it('setAccountEmail POSTs { email } as JSON to /account/email and returns the validated result', async () => {
    const result = { changed: true, email: PENDING_SUMMARY };
    const f = stubFetch(() => json(200, { data: result, meta }));
    expect(await clientWith(f, opts).setAccountEmail(EMAIL_MARKER, { activeRole: 'CUSTOMER', clientIp: '203.0.113.7' })).toEqual(result);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/email');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: EMAIL_MARKER }));
    expect(requestHeaders(f)).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer access-token-1',
      [ACTIVE_ROLE_HEADER]: 'CUSTOMER',
      'x-forwarded-for': '203.0.113.7',
    });
    // an unchanged call is a normal result
    const same = await clientWith(stubFetch(() => json(200, { data: { changed: false, email: PENDING_SUMMARY }, meta }))).setAccountEmail(EMAIL_MARKER);
    expect(same.changed).toBe(false);
    // the value is forwarded as typed: canonicalization and validation belong to the API
    await clientWith(f).setAccountEmail('  Mixed.Case@Example.TEST ');
    expect(JSON.parse(String(f.mock.calls[1]![1]?.body))).toEqual({ email: '  Mixed.Case@Example.TEST ' });
  });

  it('sendEmailVerification POSTs an empty JSON object to /account/email/verification/send and returns the validated result', async () => {
    const f = stubFetch(() => json(200, { data: EMAIL_SENT, meta }));
    expect(await clientWith(f, opts).sendEmailVerification()).toEqual(EMAIL_SENT);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/email/verification/send');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(requestHeaders(f)).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer access-token-1' });
  });

  it('confirmEmailCode POSTs { code } to /account/email/verification/confirm-code', async () => {
    const result = { changed: true, email: VERIFIED_SUMMARY };
    const f = stubFetch(() => json(200, { data: result, meta }));
    expect(await clientWith(f, opts).confirmEmailCode(CODE_MARKER, { clientIp: '203.0.113.7' })).toEqual(result);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/email/verification/confirm-code');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ code: CODE_MARKER }));
    expect(requestHeaders(f)).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer access-token-1', 'x-forwarded-for': '203.0.113.7' });
    // the code is forwarded as typed (the shape is the API's contract); a repeated confirmation is the idempotent result
    const again = await clientWith(stubFetch(() => json(200, { data: { ...result, changed: false }, meta }))).confirmEmailCode(' 12 34 ');
    expect(again.changed).toBe(false);
  });

  it('confirmEmailLink POSTs { token } to /account/email/verification/confirm-link', async () => {
    const result = { changed: true, email: VERIFIED_SUMMARY };
    const f = stubFetch(() => json(200, { data: result, meta }));
    expect(await clientWith(f, opts).confirmEmailLink(TOKEN_MARKER)).toEqual(result);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/email/verification/confirm-link');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ token: TOKEN_MARKER }));
    expect(requestHeaders(f)).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer access-token-1' });
  });

  it('every email call turns a response that breaks its contract into UNEXPECTED_RESPONSE', async () => {
    for (const name of EMAIL_CALL_NAMES) {
      const { data, call } = EMAIL_CALLS[name];
      const keys = Object.keys(data);
      for (const key of keys) {
        const reduced = Object.fromEntries(Object.entries(data).filter(([k]) => k !== key));
        await expect(call(clientWith(stubFetch(() => json(200, { data: reduced, meta })))), `${name} without ${key}`).rejects.toMatchObject({
          status: 200,
          code: 'UNEXPECTED_RESPONSE',
          category: 'INTERNAL',
        });
      }
      await expect(call(clientWith(stubFetch(() => json(200, { data: 'ok', meta })))), `${name}: text instead of an object`).rejects.toMatchObject({
        code: 'UNEXPECTED_RESPONSE',
      });
    }
  });

  it('puts the address, the code and the token in the request BODY only: the requested URL is exactly the path, and no header carries them', async () => {
    for (const name of EMAIL_CALL_NAMES) {
      const { path, data, call } = EMAIL_CALLS[name];
      const f = stubFetch(() => json(200, { data, meta }));
      await call(clientWith(f, opts), { activeRole: 'CUSTOMER', clientIp: '203.0.113.7' });
      const [url, init] = f.mock.calls[0]!;
      expect(url, name).toBe(`http://api.test${path}`);
      expect(new URL(String(url)).search, name).toBe('');
      expect(new URL(String(url)).hash, name).toBe('');
      expect(JSON.stringify(init?.headers), name).not.toMatch(/leak|8675309|lnk/);
      expect(JSON.stringify({ ...init, body: undefined }), name).not.toMatch(/leak|8675309|lnk/);
      // and only the calls that submit them have them in the body, exactly once
      const body = String(init?.body ?? '');
      const submitted = { setAccountEmail: EMAIL_MARKER, confirmEmailCode: CODE_MARKER, confirmEmailLink: TOKEN_MARKER }[name as string];
      if (submitted) expect(body.split(submitted).length - 1, name).toBe(1);
      else expect(body, name).not.toMatch(/leak|8675309|lnk/);
      // the access token is a header, never in the URL or the body
      expect(String(url) + body, name).not.toContain('access-token-1');
    }
  });

  it('maps API refusals to ApiError with status, code, category, correlation id and details (retry-after seconds and message keys included)', async () => {
    const cases: [EmailCallName, number, string, string, Record<string, unknown> | undefined][] = [
      [
        'sendEmailVerification',
        429,
        'ACCOUNT_EMAIL_RESEND_TOO_SOON',
        'RATE_LIMIT',
        { retryAfterSeconds: 42, messageKey: 'account.email.error.resend_too_soon' },
      ],
      ['sendEmailVerification', 429, 'ACCOUNT_EMAIL_SEND_LIMIT', 'RATE_LIMIT', { retryAfterSeconds: 3600, messageKey: 'account.email.error.send_limit' }],
      ['sendEmailVerification', 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED', 'DEPENDENCY', { messageKey: 'account.email.error.delivery_failed' }],
      ['sendEmailVerification', 409, 'ACCOUNT_EMAIL_NOT_PENDING', 'CONFLICT', { messageKey: 'account.email.error.not_pending' }],
      ['setAccountEmail', 400, 'ACCOUNT_EMAIL_INVALID', 'VALIDATION', { reason: 'INVALID_FORMAT', messageKey: 'account.email.error.invalid_format' }],
      ['setAccountEmail', 429, 'ACCOUNT_EMAIL_RATE_LIMITED', 'RATE_LIMIT', { retryAfterSeconds: 60 }],
      ['setAccountEmail', 503, 'ACCOUNT_UNAVAILABLE', 'DEPENDENCY', { reason: 'RATE_LIMITER_UNAVAILABLE' }],
      ['confirmEmailCode', 400, 'ACCOUNT_EMAIL_CODE_INVALID', 'VALIDATION', { attemptsRemaining: 3, messageKey: 'account.email.error.code_invalid' }],
      ['confirmEmailCode', 400, 'ACCOUNT_EMAIL_CODE_EXPIRED', 'VALIDATION', { messageKey: 'account.email.error.code_expired' }],
      ['confirmEmailCode', 400, 'ACCOUNT_EMAIL_CODE_USED', 'VALIDATION', { messageKey: 'account.email.error.code_used' }],
      [
        'confirmEmailCode',
        429,
        'ACCOUNT_EMAIL_VERIFICATION_LOCKED',
        'RATE_LIMIT',
        { retryAfterSeconds: 120, messageKey: 'account.email.error.verification_locked' },
      ],
      ['confirmEmailCode', 409, 'ACCOUNT_EMAIL_UNAVAILABLE', 'CONFLICT', { reason: 'ADDRESS_UNAVAILABLE' }],
      ['confirmEmailLink', 400, 'ACCOUNT_EMAIL_LINK_INVALID', 'VALIDATION', { messageKey: 'account.email.error.link_invalid' }],
      ['confirmEmailLink', 400, 'VALIDATION_FAILED', 'VALIDATION', { issues: [{ path: 'token', message: 'Invalid' }] }],
      ['getAccountEmail', 401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION', undefined],
      ['getAccountEmail', 403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: 'PROVIDER' }],
      ['getAccountEmail', 403, 'ACCOUNT_SUSPENDED', 'AUTHORIZATION', { status: 'SUSPENDED' }],
    ];
    for (const [name, status, code, category, details] of cases) {
      const err = await EMAIL_CALLS[name].call(clientWith(stubFetch(() => json(status, errorBody(code, category, details))))).catch((e: unknown) => e);
      expect(err, `${name} ${code}`).toBeInstanceOf(ApiError);
      expect(err, `${name} ${code}`).toMatchObject({ status, code, category, correlationId: 'corr-err-1234' });
      expect((err as ApiError).details, `${name} ${code}`).toEqual(details);
      // the message is the server's text about the failure; the submitted values are not part of it
      expect(JSON.stringify(err) + String((err as ApiError).message), `${name} ${code}`).not.toMatch(/leak|8675309|lnk/);
    }
  });

  it('a failure that is not the standard envelope is UNEXPECTED_RESPONSE with the response correlation id; an unreachable API is a DEPENDENCY error without the submitted values', async () => {
    for (const name of EMAIL_CALL_NAMES) {
      const html = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502, headers: { [CORRELATION_HEADER]: 'corr-from-header' } }));
      await expect(EMAIL_CALLS[name].call(clientWith(html)), name).rejects.toMatchObject({
        status: 502,
        code: 'UNEXPECTED_RESPONSE',
        category: 'INTERNAL',
        correlationId: 'corr-from-header',
      });
      const down = stubFetch(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      });
      const err = await EMAIL_CALLS[name].call(clientWith(down, opts)).catch((e: unknown) => e);
      expect(err, name).toMatchObject({ status: 0, code: 'API_UNREACHABLE', category: 'DEPENDENCY', correlationId: 'web-corr-12345' });
      expect(String((err as ApiError).message), name).not.toMatch(/leak|8675309|lnk|access-token-1/);
    }
  });

  it('propagates x-correlation-id on every email call (and sends none when the client has no correlation id)', async () => {
    for (const name of EMAIL_CALL_NAMES) {
      const { data, call } = EMAIL_CALLS[name];
      const f = stubFetch(() => json(200, { data, meta }));
      await call(clientWith(f, { correlationId: () => 'web-corr-12345' }));
      expect(requestHeaders(f)[CORRELATION_HEADER], name).toBe('web-corr-12345');
      await call(clientWith(f, { correlationId: () => 'another-corr-678' }));
      expect(requestHeaders(f, 1)[CORRELATION_HEADER], name).toBe('another-corr-678');
      await call(clientWith(f));
      expect(CORRELATION_HEADER in requestHeaders(f, 2), name).toBe(false);
    }
  });

  it('sends no Authorization header without an access token (the API answers 401; the client does not invent credentials)', async () => {
    const f = stubFetch(() => json(401, errorBody('AUTHENTICATION_REQUIRED', 'AUTHENTICATION')));
    await expect(clientWith(f).getAccountEmail()).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect('authorization' in requestHeaders(f)).toBe(false);
  });
});
