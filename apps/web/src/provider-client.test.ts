// PRO-001 web side, part 2: the provider registration calls of the typed API client with an injected fetch: method, URL, headers, JSON body, the contract parse, the
// `created` flag of start (HTTP 201 vs 200) and the ApiError mapping. No call carries an account id; the account is the bearer token's.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER, type CancelProviderRegistrationRequest } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import { marketDto, registrationDto, requirementsDto, serviceTypeDto, stateDto, stepsDto } from './testing/provider-stub';

const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: f as unknown as typeof fetch, correlationId: () => 'web-corr-12345', accessToken: () => 'tok-P' });
const errorBody = (code: string, category: string) => ({ error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234' } });
const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;

const STATE = stateDto(registrationDto({ marketCode: 'us-orange-county', serviceTypeCodes: ['house_cleaning'], revision: 6 }));
const REQS = requirementsDto(STATE.registration, stepsDto({ SERVICES: 'IN_PROGRESS' }), { ready: false });
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

describe('api client: provider registration', () => {
  it('getProviderRegistration: GET /provider/registration with the bearer token, correlation id and role header, no body; parsed with the contract', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    const out = await clientWith(f).getProviderRegistration({ activeRole: 'PROVIDER' });
    expect(out).toEqual(STATE);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init)).toMatchObject({ authorization: 'Bearer tok-P', [CORRELATION_HEADER]: 'web-corr-12345', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    expect(headersOf(init)['content-type']).toBeUndefined();
  });
  it('getProviderRegistration: no role header without an active role; a null registration is a valid state', async () => {
    const f = stubFetch(() => json(200, { data: stateDto(null, 'NONE'), meta }));
    expect(await clientWith(f).getProviderRegistration()).toEqual({ providerRole: 'NONE', registration: null });
    expect(Object.keys(headersOf(f.mock.calls[0]![1])).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
  });
  it('startProviderRegistration: POST /provider/registration with an empty JSON object; 201 means created: true', async () => {
    const f = stubFetch(() => json(201, { data: STATE, meta }));
    const out = await clientWith(f).startProviderRegistration({ activeRole: 'CUSTOMER' });
    expect(out).toEqual({ created: true, state: STATE });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'CUSTOMER', authorization: 'Bearer tok-P' });
  });
  it('startProviderRegistration: 200 means the live attempt was resumed (created: false); only 201 is created', async () => {
    for (const status of [200, 202]) {
      const f = stubFetch(() => json(status, { data: STATE, meta }));
      expect((await clientWith(f).startProviderRegistration()).created, String(status)).toBe(false);
    }
    const f = stubFetch(() => json(201, { data: STATE, meta }));
    expect((await clientWith(f).startProviderRegistration()).created).toBe(true);
  });
  it('selectProviderMarket: PUT /provider/registration/market with exactly the request body', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    const out = await clientWith(f).selectProviderMarket({ marketCode: 'us-orange-county', expectedRevision: 5 }, { activeRole: 'PROVIDER' });
    expect(out).toEqual(STATE);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration/market');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ marketCode: 'us-orange-county', expectedRevision: 5 });
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
  });
  it('replaceProviderServices: PUT /provider/registration/services with the whole set, in order', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    await clientWith(f).replaceProviderServices({ serviceTypeCodes: ['lawn_care', 'house_cleaning'], expectedRevision: 6 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration/services');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ serviceTypeCodes: ['lawn_care', 'house_cleaning'], expectedRevision: 6 });
    await clientWith(f).replaceProviderServices({ serviceTypeCodes: [] });
    expect(JSON.parse(f.mock.calls[1]![1]?.body as string)).toEqual({ serviceTypeCodes: [] });
  });
  it('getProviderRequirements: GET /provider/registration/requirements, no query without a locale, an encoded one with', async () => {
    const f = stubFetch(() => json(200, { data: REQS, meta }));
    const out = await clientWith(f).getProviderRequirements({}, { activeRole: 'PROVIDER' });
    expect(out.steps.map((s) => s.step)).toEqual(['ACCOUNT', 'CONTACT', 'LEGAL', 'MARKET', 'SERVICES', 'VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']);
    expect(out.overall.goLive).toEqual({ evaluated: false, eligible: false });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration/requirements');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
    await clientWith(f).getProviderRequirements({ locale: 'fr-FR&x=1' });
    expect(f.mock.calls[1]![0]).toBe('http://api.test/api/v1/provider/registration/requirements?locale=fr-FR%26x%3D1');
    await clientWith(f).getProviderRequirements();
    expect(f.mock.calls[2]![0]).toBe('http://api.test/api/v1/provider/registration/requirements');
  });
  it('submitProviderRegistration: POST /provider/registration/submit with the revision; the answer is the requirements read model', async () => {
    const done = requirementsDto(
      registrationDto({ status: 'COMPLETED', completedAt: '2026-10-17T10:00:00.000Z', marketCode: 'us-orange-county' }),
      stepsDto(),
      {
        ready: true,
      },
    );
    const f = stubFetch(() => json(200, { data: done, meta }));
    const out = await clientWith(f).submitProviderRegistration({ expectedRevision: 6 }, { activeRole: 'PROVIDER' });
    expect(out.overall.registrationComplete).toBe(true);
    expect(out.registration?.status).toBe('COMPLETED');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration/submit');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 6 });
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
  });
  it('cancelProviderRegistration: POST /provider/registration/cancel with an empty object only: it takes no input, so no free text can reach the audit trail', async () => {
    const cancelled = stateDto(registrationDto({ status: 'CANCELLED', cancelledAt: '2026-10-17T10:00:00.000Z' }));
    const f = stubFetch(() => json(200, { data: cancelled, meta }));
    const out = await clientWith(f).cancelProviderRegistration(undefined, { activeRole: 'CUSTOMER' });
    expect(out.registration?.status).toBe('CANCELLED');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/registration/cancel');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('CUSTOMER');
    await clientWith(f).cancelProviderRegistration({}, { activeRole: 'CUSTOMER' });
    expect(f.mock.calls[1]![1]?.body).toBe('{}');
    expect(f.mock.calls).toHaveLength(2);
  });
  it('cancelProviderRegistration: the request type has no `reason` (a free-text reason would end up in the immutable audit trail)', () => {
    const noReason: CancelProviderRegistrationRequest = {};
    expect(noReason).toEqual({});
    // the directive makes the typecheck fail if the field ever comes back
    // @ts-expect-error a cancel request has no `reason`
    const withReason: CancelProviderRegistrationRequest = { reason: 'changed my mind' };
    expect(withReason).toBeDefined();
  });
  it('listGeographyMarkets: GET /geography/markets, parsed with the contract', async () => {
    const f = stubFetch(() => json(200, { data: [marketDto('us-orange-county', 'Orange County')], meta }));
    const out = await clientWith(f).listGeographyMarkets();
    expect(out.map((m) => [m.code, m.name])).toEqual([['us-orange-county', 'Orange County']]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/geography/markets');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });
  it('listMarketServiceTypes: GET /catalog/service-types?market=<code> with the code encoded, plus a locale only when given', async () => {
    const f = stubFetch(() => json(200, { data: [serviceTypeDto('house_cleaning', 'House cleaning')], meta }));
    const out = await clientWith(f).listMarketServiceTypes('us-orange-county');
    expect(out.map((s) => s.code)).toEqual(['house_cleaning']);
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/catalog/service-types?market=us-orange-county');
    expect(f.mock.calls[0]![1]?.method).toBe('GET');
    await clientWith(f).listMarketServiceTypes('us-orange-county', 'es-US');
    expect(f.mock.calls[1]![0]).toBe('http://api.test/api/v1/catalog/service-types?market=us-orange-county&locale=es-US');
    await clientWith(f).listMarketServiceTypes('a&b=c/../d');
    expect(f.mock.calls[2]![0]).toBe('http://api.test/api/v1/catalog/service-types?market=a%26b%3Dc%2F..%2Fd');
  });
  it('no provider call puts an account id in a path, a query or a body', async () => {
    const f = stubFetch((url) =>
      url.includes('/requirements') || url.endsWith('/submit') ? json(200, { data: REQS, meta }) : json(200, { data: STATE, meta }),
    );
    const c = clientWith(f);
    await c.getProviderRegistration();
    await c.startProviderRegistration();
    await c.selectProviderMarket({ marketCode: 'us-orange-county' });
    await c.replaceProviderServices({ serviceTypeCodes: ['house_cleaning'] });
    await c.getProviderRequirements();
    await c.submitProviderRegistration({ expectedRevision: 1 });
    await c.cancelProviderRegistration();
    expect(f.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      'GET http://api.test/api/v1/provider/registration',
      'POST http://api.test/api/v1/provider/registration',
      'PUT http://api.test/api/v1/provider/registration/market',
      'PUT http://api.test/api/v1/provider/registration/services',
      'GET http://api.test/api/v1/provider/registration/requirements',
      'POST http://api.test/api/v1/provider/registration/submit',
      'POST http://api.test/api/v1/provider/registration/cancel',
    ]);
    for (const [u, i] of f.mock.calls) expect(`${u} ${String(i?.body ?? '')}`.toLowerCase()).not.toContain('account');
  });

  describe('errors', () => {
    const CALLS: Array<[string, (c: ReturnType<typeof clientWith>) => Promise<unknown>]> = [
      ['getProviderRegistration', (c) => c.getProviderRegistration()],
      ['startProviderRegistration', (c) => c.startProviderRegistration()],
      ['selectProviderMarket', (c) => c.selectProviderMarket({ marketCode: 'us-orange-county' })],
      ['replaceProviderServices', (c) => c.replaceProviderServices({ serviceTypeCodes: [] })],
      ['getProviderRequirements', (c) => c.getProviderRequirements()],
      ['submitProviderRegistration', (c) => c.submitProviderRegistration({ expectedRevision: 1 })],
      ['cancelProviderRegistration', (c) => c.cancelProviderRegistration()],
      ['listGeographyMarkets', (c) => c.listGeographyMarkets()],
      ['listMarketServiceTypes', (c) => c.listMarketServiceTypes('us-orange-county')],
    ];
    it.each(CALLS)('%s: the error envelope becomes an ApiError with status, code and category', async (_name, call) => {
      const f = stubFetch(() => json(409, errorBody('PROVIDER_STALE_REGISTRATION', 'CONFLICT')));
      const err = await refusal(call(clientWith(f)));
      expect([err.status, err.code, err.category]).toEqual([409, 'PROVIDER_STALE_REGISTRATION', 'CONFLICT']);
    });
    it.each(CALLS)('%s: a body that violates the contract is UNEXPECTED_RESPONSE, not a crash of the caller', async (_name, call) => {
      const f = stubFetch(() => json(200, { data: { nonsense: true }, meta }));
      const err = await refusal(call(clientWith(f)));
      expect(err.code).toBe('UNEXPECTED_RESPONSE');
    });
    it.each(CALLS)('%s: a 5xx without the envelope is UNEXPECTED_RESPONSE and an unreachable API is API_UNREACHABLE', async (_name, call) => {
      const bad = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
      const err = await refusal(call(clientWith(bad)));
      expect([err.status, err.code]).toEqual([502, 'UNEXPECTED_RESPONSE']);
      const down = stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
      expect((await refusal(call(clientWith(down)))).code).toBe('API_UNREACHABLE');
    });
    it('a state with an unknown registration status or role is rejected by the contract', async () => {
      const f = stubFetch(() => json(200, { data: { providerRole: 'PENDING', registration: { ...STATE.registration, status: 'SUBMITTED' } }, meta }));
      expect((await refusal(clientWith(f).getProviderRegistration())).code).toBe('UNEXPECTED_RESPONSE');
      const g = stubFetch(() => json(200, { data: { ...STATE, providerRole: 'ADMIN' }, meta }));
      expect((await refusal(clientWith(g).getProviderRegistration())).code).toBe('UNEXPECTED_RESPONSE');
    });
    it('requirements that claim Go-Live is evaluated or eligible are rejected by the contract (it is never true here)', async () => {
      const lying = { ...REQS, overall: { ...REQS.overall, goLive: { evaluated: true, eligible: true } } };
      const f = stubFetch(() => json(200, { data: lying, meta }));
      expect((await refusal(clientWith(f).getProviderRequirements())).code).toBe('UNEXPECTED_RESPONSE');
    });
    it('401 SESSION_REVOKED keeps its code so the caller can end the local session', async () => {
      const f = stubFetch(() => json(401, errorBody('SESSION_REVOKED', 'AUTHENTICATION')));
      const err = await refusal(clientWith(f).getProviderRegistration());
      expect([err.status, err.code]).toEqual([401, 'SESSION_REVOKED']);
    });
  });
});
