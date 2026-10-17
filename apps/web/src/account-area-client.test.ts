// ACC-001 web side, part 3: the account area methods of the typed API client with an injected fetch: URLs, verbs, the bearer token and the role header, the request body,
// contract validation of the answer and ApiError mapping.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import { CUSTOMER_ROLE, PROVIDER_ROLE } from './testing/account-stub';
import { SEEDED_SECTIONS } from './testing/account-area-stub';

const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: f as unknown as typeof fetch, correlationId: () => 'web-corr-12345', accessToken: () => 'tok-1' });
const errorBody = (code: string, category: string, details?: Record<string, unknown>) => ({
  error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234', ...(details ? { details } : {}) },
});

const PROFILE = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'es-US', timeZone: null };
const EMAIL = { emailVerificationStatus: 'NONE', primary: null, pending: null };
const PHONE = { phoneVerificationStatus: 'NONE', primary: null, pending: null };
const CONTACTS = { emailVerified: false, phoneVerified: false, contactsVerified: false };
const CASES = [
  {
    name: 'getAccountNavigation',
    path: '/api/v1/account/navigation',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountNavigation(o),
    data: { activeRole: 'CUSTOMER', roles: [CUSTOMER_ROLE, PROVIDER_ROLE], sections: SEEDED_SECTIONS, contacts: CONTACTS },
    check: (out: unknown) => expect((out as { sections: { code: string }[] }).sections.map((s) => s.code)).toEqual(SEEDED_SECTIONS.map((s) => s.code)),
  },
  {
    name: 'getAccountProfile',
    path: '/api/v1/account/profile',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountProfile(o),
    data: { profile: { ...PROFILE, displayName: 'Ana M.' } },
    check: (out: unknown) => expect((out as { profile: { displayName: string } }).profile.displayName).toBe('Ana M.'),
  },
  {
    name: 'getAccountContactVerification',
    path: '/api/v1/account/contact-verification',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountContactVerification(o),
    data: { email: EMAIL, phone: PHONE, contacts: CONTACTS },
    check: (out: unknown) => expect((out as { contacts: unknown }).contacts).toEqual(CONTACTS),
  },
  {
    name: 'getAccountRolesSection',
    path: '/api/v1/account/roles',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountRolesSection(o),
    data: { roles: [CUSTOMER_ROLE, PROVIDER_ROLE], activeRole: 'CUSTOMER', primaryRole: 'CUSTOMER', switchableTo: ['PROVIDER'] },
    check: (out: unknown) => expect((out as { switchableTo: string[] }).switchableTo).toEqual(['PROVIDER']),
  },
  {
    name: 'getAccountSecuritySummary',
    path: '/api/v1/account/security-summary',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountSecuritySummary(o),
    data: { mfa: { available: true, enabled: false }, activeSessionCount: 2, currentBrowserTrusted: true },
    check: (out: unknown) => expect((out as { activeSessionCount: number }).activeSessionCount).toBe(2),
  },
  {
    name: 'getAccountPrivacySummary',
    path: '/api/v1/account/privacy',
    call: (c: ReturnType<typeof clientWith>, o: { activeRole?: string }) => c.getAccountPrivacySummary(o),
    data: { consents: { locale: 'en-US', satisfied: false, outstandingCount: 2 }, dataDownload: { available: false } },
    check: (out: unknown) => expect((out as { dataDownload: unknown }).dataDownload).toEqual({ available: false }),
  },
];

describe('api client: account area reads', () => {
  it.each(CASES)('$name GETs $path with the token, the correlation id and the active role, no body, and validates the contract', async (c) => {
    const f = stubFetch(() => json(200, { data: c.data, meta }));
    const out = await c.call(clientWith(f), { activeRole: 'PROVIDER' });
    c.check(out);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`http://api.test${c.path}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe('no-store');
    const h = init?.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok-1');
    expect(h[CORRELATION_HEADER]).toBe('web-corr-12345');
    expect(h[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
  });
  it.each(CASES)('$name sends no role header when the session remembers none', async (c) => {
    const f = stubFetch(() => json(200, { data: c.data, meta }));
    await c.call(clientWith(f), {});
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>)[ACTIVE_ROLE_HEADER]).toBeUndefined();
  });
  it.each(CASES)('$name maps 404 ACCOUNT_SECTION_NOT_FOUND, 401 and 403 to the typed ApiError with the correlation id', async (c) => {
    for (const [status, code, category] of [
      [404, 'ACCOUNT_SECTION_NOT_FOUND', 'NOT_FOUND'],
      [401, 'SESSION_REVOKED', 'AUTHENTICATION'],
      [403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION'],
    ] as const) {
      const f = stubFetch(() => json(status, errorBody(code, category)));
      const err = await c.call(clientWith(f), {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status, code, category, correlationId: 'corr-err-1234' });
    }
  });
  it.each(CASES)('$name turns an answer that breaks the contract into UNEXPECTED_RESPONSE (an API fault, not a crash)', async (c) => {
    const f = stubFetch(() => json(200, { data: { unexpected: true }, meta }));
    await expect(c.call(clientWith(f), {})).rejects.toMatchObject({ status: 200, code: 'UNEXPECTED_RESPONSE', category: 'INTERNAL' });
  });
  it('an unreachable API is API_UNREACHABLE', async () => {
    const f = stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(clientWith(f).getAccountNavigation()).rejects.toMatchObject({ status: 0, code: 'API_UNREACHABLE' });
  });
});

describe('api client: patchAccountProfile', () => {
  const patched = { changed: true, profile: { ...PROFILE, displayName: 'Ana M.' } };
  it('PATCHes /account/profile with the JSON body, the token and the role, and returns the validated result', async () => {
    const f = stubFetch(() => json(200, { data: patched, meta }));
    const out = await clientWith(f).patchAccountProfile({ preferredLocale: null, timeZone: 'America/New_York' }, { activeRole: 'CUSTOMER' });
    expect(out).toEqual(patched);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/account/profile');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ preferredLocale: null, timeZone: 'America/New_York' });
    const h = init?.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok-1');
    expect(h['content-type']).toBe('application/json');
    expect(h[ACTIVE_ROLE_HEADER]).toBe('CUSTOMER');
  });
  it('a rejected value is the ApiError of the envelope with its details (the reason and issue codes, never the value)', async () => {
    const details = { reason: 'INVALID_PROFILE', issues: [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }] };
    const f = stubFetch(() => json(400, errorBody('ACCOUNT_VALIDATION_FAILED', 'VALIDATION', details)));
    const err = await clientWith(f)
      .patchAccountProfile({ firstName: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'ACCOUNT_VALIDATION_FAILED', details });
  });
  it('a 404 for a field of a section the role does not have is ACCOUNT_SECTION_NOT_FOUND', async () => {
    const f = stubFetch(() => json(404, errorBody('ACCOUNT_SECTION_NOT_FOUND', 'NOT_FOUND')));
    await expect(clientWith(f).patchAccountProfile({ timeZone: null })).rejects.toMatchObject({ status: 404, code: 'ACCOUNT_SECTION_NOT_FOUND' });
  });
});

describe('api client: listGeographyTimeZones', () => {
  it('GETs the public list, validates it and sends the token only when the client has one', async () => {
    const f = stubFetch(() => json(200, { data: [{ ianaName: 'America/Los_Angeles' }, { ianaName: 'Pacific/Honolulu', status: 'ACTIVE' }], meta }));
    const publicClient = createApiClient({ baseUrl: 'http://api.test', fetch: f as unknown as typeof fetch });
    expect(await publicClient.listGeographyTimeZones()).toEqual([{ ianaName: 'America/Los_Angeles' }, { ianaName: 'Pacific/Honolulu', status: 'ACTIVE' }]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/geography/time-zones');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });
  it('rejects a list that breaks the contract', async () => {
    const f = stubFetch(() => json(200, { data: [{ name: 'America/Los_Angeles' }], meta }));
    await expect(clientWith(f).listGeographyTimeZones()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});
