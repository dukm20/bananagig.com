// CAT-003 web side, part 1: the provider Gig calls of the typed API client with an injected fetch: method, URL, headers, JSON body, the contract parse, the `created` flag of
// createGig (HTTP 201 vs 200) and the ApiError mapping. No call carries an account id, a role, a status or a currency; the account is the bearer token's.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import { GIG_ID, choicesDto, detailDto, menuDto, menuItemDto, publishedVersionDto, versionDto } from './testing/gig-stub';

const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>) =>
  createApiClient({ baseUrl: 'http://api.test/', fetch: f as unknown as typeof fetch, correlationId: () => 'web-corr-12345', accessToken: () => 'tok-P' });
const errorBody = (code: string, category: string) => ({ error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234' } });
const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

const DRAFT = versionDto({ revision: 5 });
const DETAIL = detailDto({ draft: DRAFT });
const VERSION = publishedVersionDto();
const BASE = 'http://api.test/api/v1/provider';

describe('api client: provider Gigs', () => {
  it('listGigTemplateChoices: GET /provider/gig-templates with the bearer token, correlation id and role header, no body', async () => {
    const f = stubFetch(() => json(200, { data: choicesDto(), meta }));
    const out = await clientWith(f).listGigTemplateChoices({ activeRole: 'PROVIDER' });
    expect(out.templates.map((t) => t.gigTemplateCode)).toEqual(['deep_clean']);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gig-templates`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init)).toMatchObject({ authorization: 'Bearer tok-P', [CORRELATION_HEADER]: 'web-corr-12345', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    expect(headersOf(init)['content-type']).toBeUndefined();
  });
  it('getGigMenu: GET /provider/gigs, parsed with the contract (Go-Live is never evaluated)', async () => {
    const f = stubFetch(() => json(200, { data: menuDto([menuItemDto(detailDto({ current: VERSION }))]), meta }));
    const out = await clientWith(f).getGigMenu();
    expect(out.gigs).toHaveLength(1);
    expect(out.readiness.goLive).toEqual({ evaluated: false, eligible: false });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs`);
    expect(init?.method).toBe('GET');
    expect(Object.keys(headersOf(init)).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
  });
  it('getGigMenu: a menu that claims Go-Live is evaluated or eligible is rejected by the contract', async () => {
    const lying = { ...menuDto(), readiness: { ...menuDto().readiness, goLive: { evaluated: true, eligible: true } } };
    const f = stubFetch(() => json(200, { data: lying, meta }));
    expect((await refusal(clientWith(f).getGigMenu())).code).toBe('UNEXPECTED_RESPONSE');
  });
  it('createGig: POST /provider/gigs with exactly the request; 201 means created: true, 200 an idempotent replay (created: false)', async () => {
    const f = stubFetch(() => json(201, { data: DETAIL, meta }));
    const out = await clientWith(f).createGig(
      { gigTemplateCode: 'deep_clean', clientRequestId: '0b5c7c40-2a6e-4f3b-8d1e-6a9f3c2b1d00' },
      { activeRole: 'PROVIDER' },
    );
    expect(out.created).toBe(true);
    expect(out.detail.gig.gigId).toBe(GIG_ID);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ gigTemplateCode: 'deep_clean', clientRequestId: '0b5c7c40-2a6e-4f3b-8d1e-6a9f3c2b1d00' });
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    for (const status of [200, 202]) {
      const g = stubFetch(() => json(status, { data: DETAIL, meta }));
      expect((await clientWith(g).createGig({ gigTemplateCode: 'deep_clean' })).created, String(status)).toBe(false);
    }
  });
  it('getGig: GET /provider/gigs/:gigId with the id encoded', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    const out = await clientWith(f).getGig(GIG_ID);
    expect(out.draftVersion?.revision).toBe(5);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/gigs/${GIG_ID}`);
    expect(f.mock.calls[0]![1]?.method).toBe('GET');
    await clientWith(f).getGig('a/../b?x=1');
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/gigs/a%2F..%2Fb%3Fx%3D1`);
  });
  it('createGigVersion: POST /provider/gigs/:gigId/versions with an empty JSON object (it takes no input)', async () => {
    const f = stubFetch(() => json(201, { data: DETAIL, meta }));
    await clientWith(f).createGigVersion(GIG_ID, { activeRole: 'PROVIDER' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs/${GIG_ID}/versions`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
  });
  it('getGigVersion: GET /provider/gigs/:gigId/versions/:version', async () => {
    const f = stubFetch(() => json(200, { data: VERSION, meta }));
    const out = await clientWith(f).getGigVersion(GIG_ID, 3);
    expect(out.status).toBe('PUBLISHED');
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/gigs/${GIG_ID}/versions/3`);
    expect(f.mock.calls[0]![1]?.method).toBe('GET');
  });
  it('updateGigDraft: PUT /provider/gigs/:gigId/draft with exactly the request body (no currency, no status)', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    const input = {
      expectedRevision: 5,
      title: 'T',
      shortPitch: null,
      description: 'D',
      priceAmountMinor: 1250,
      durationMinutes: 90,
      fieldValues: [{ fieldKey: 'rooms', value: 3 }],
    };
    await clientWith(f).updateGigDraft(GIG_ID, input, { activeRole: 'PROVIDER' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs/${GIG_ID}/draft`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual(input);
    expect(Object.keys(JSON.parse(init?.body as string) as object).sort()).toEqual([
      'description',
      'durationMinutes',
      'expectedRevision',
      'fieldValues',
      'priceAmountMinor',
      'shortPitch',
      'title',
    ]);
  });
  it('publishGig: POST /provider/gigs/:gigId/publish with the revision only', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).publishGig(GIG_ID, { expectedRevision: 5 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs/${GIG_ID}/publish`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 5 });
  });
  it('retireGig: POST /provider/gigs/:gigId/retire with an empty object only (free text would reach the immutable audit trail)', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).retireGig(GIG_ID);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/gigs/${GIG_ID}/retire`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
  });
  it('no Gig call puts an account id in a path, a query or a body', async () => {
    const f = stubFetch((url, init) =>
      url.endsWith('/gig-templates')
        ? json(200, { data: choicesDto(), meta })
        : url.endsWith('/gigs') && init.method === 'GET'
          ? json(200, { data: menuDto(), meta })
          : json(200, { data: DETAIL, meta }),
    );
    const c = clientWith(f);
    await c.listGigTemplateChoices();
    await c.getGigMenu();
    await c.createGig({ gigTemplateCode: 'deep_clean' });
    await c.getGig(GIG_ID);
    await c.createGigVersion(GIG_ID);
    await c.updateGigDraft(GIG_ID, {
      expectedRevision: 1,
      title: null,
      shortPitch: null,
      description: null,
      priceAmountMinor: null,
      durationMinutes: null,
      fieldValues: [],
    });
    await c.publishGig(GIG_ID, { expectedRevision: 1 });
    await c.retireGig(GIG_ID);
    expect(f.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      `GET ${BASE}/gig-templates`,
      `GET ${BASE}/gigs`,
      `POST ${BASE}/gigs`,
      `GET ${BASE}/gigs/${GIG_ID}`,
      `POST ${BASE}/gigs/${GIG_ID}/versions`,
      `PUT ${BASE}/gigs/${GIG_ID}/draft`,
      `POST ${BASE}/gigs/${GIG_ID}/publish`,
      `POST ${BASE}/gigs/${GIG_ID}/retire`,
    ]);
    for (const [u, i] of f.mock.calls) expect(`${u} ${String(i?.body ?? '')}`.toLowerCase()).not.toContain('account');
  });

  describe('errors', () => {
    const CALLS: Array<[string, (c: ReturnType<typeof clientWith>) => Promise<unknown>]> = [
      ['listGigTemplateChoices', (c) => c.listGigTemplateChoices()],
      ['getGigMenu', (c) => c.getGigMenu()],
      ['createGig', (c) => c.createGig({ gigTemplateCode: 'deep_clean' })],
      ['getGig', (c) => c.getGig(GIG_ID)],
      ['createGigVersion', (c) => c.createGigVersion(GIG_ID)],
      ['getGigVersion', (c) => c.getGigVersion(GIG_ID, 1)],
      [
        'updateGigDraft',
        (c) =>
          c.updateGigDraft(GIG_ID, {
            expectedRevision: 1,
            title: null,
            shortPitch: null,
            description: null,
            priceAmountMinor: null,
            durationMinutes: null,
            fieldValues: [],
          }),
      ],
      ['publishGig', (c) => c.publishGig(GIG_ID, { expectedRevision: 1 })],
      ['retireGig', (c) => c.retireGig(GIG_ID)],
    ];
    it.each(CALLS)('%s: the error envelope becomes an ApiError with status, code and category', async (_name, call) => {
      const f = stubFetch(() => json(409, errorBody('GIG_STALE_DRAFT', 'CONFLICT')));
      const err = await refusal(call(clientWith(f)));
      expect([err.status, err.code, err.category]).toEqual([409, 'GIG_STALE_DRAFT', 'CONFLICT']);
    });
    it.each(CALLS)('%s: a body that violates the contract is UNEXPECTED_RESPONSE, not a crash of the caller', async (_name, call) => {
      const f = stubFetch(() => json(200, { data: { nonsense: true }, meta }));
      expect((await refusal(call(clientWith(f)))).code).toBe('UNEXPECTED_RESPONSE');
    });
    it.each(CALLS)('%s: a 5xx without the envelope is UNEXPECTED_RESPONSE and an unreachable API is API_UNREACHABLE', async (_name, call) => {
      const bad = stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
      const err = await refusal(call(clientWith(bad)));
      expect([err.status, err.code]).toEqual([502, 'UNEXPECTED_RESPONSE']);
      const down = stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
      expect((await refusal(call(clientWith(down)))).code).toBe('API_UNREACHABLE');
    });
    it('404 GIG_NOT_FOUND and 401 SESSION_REVOKED keep their codes', async () => {
      const nf = stubFetch(() => json(404, errorBody('GIG_NOT_FOUND', 'NOT_FOUND')));
      expect([(await refusal(clientWith(nf).getGig(GIG_ID))).status, (await refusal(clientWith(nf).getGig(GIG_ID))).code]).toEqual([404, 'GIG_NOT_FOUND']);
      const revoked = stubFetch(() => json(401, errorBody('SESSION_REVOKED', 'AUTHENTICATION')));
      expect((await refusal(clientWith(revoked).getGigMenu())).code).toBe('SESSION_REVOKED');
    });
    it('a version with an unknown status is rejected by the contract', async () => {
      const f = stubFetch(() => json(200, { data: { ...VERSION, status: 'ACTIVE' }, meta }));
      expect((await refusal(clientWith(f).getGigVersion(GIG_ID, 1))).code).toBe('UNEXPECTED_RESPONSE');
    });
  });
});
