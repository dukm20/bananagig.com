// CAT-004 web side, part 1: the variants, add-ons and photo calls of the typed API client with an injected fetch: method, URL, headers, JSON body, the contract parse and the ApiError
// mapping. No call carries an account id, an object key or a version in a body; the account is the bearer token's. The one-time upload target is only ever parsed, never requested here.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import { GIG_ID, MEDIA_ID, detailDto, uploadDto, versionDto } from './testing/gig-stub';

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

const DETAIL = detailDto({ draft: versionDto({ revision: 5 }) });
const BASE = `http://api.test/api/v1/provider/gigs/${GIG_ID}`;
const OPTION = { name: 'Large', description: null, priceDeltaMinor: 1500, durationDeltaMinutes: 45 };

describe('api client: variants, add-ons and photos of a Gig draft', () => {
  it('replaceGigVariants: PUT .../draft/variants with exactly the request, the bearer token, the correlation id and the role', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    const input = { expectedRevision: 5, variants: [{ key: 'opt_aaaaaaaaaaaa', ...OPTION }, OPTION] };
    const out = await clientWith(f).replaceGigVariants(GIG_ID, input, { activeRole: 'PROVIDER' });
    expect(out.draftVersion?.revision).toBe(5);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/variants`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual(input);
    expect(headersOf(init)).toMatchObject({
      authorization: 'Bearer tok-P',
      [CORRELATION_HEADER]: 'web-corr-12345',
      [ACTIVE_ROLE_HEADER]: 'PROVIDER',
      'content-type': 'application/json',
    });
  });
  it('replaceGigAddOns: PUT .../draft/add-ons', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    const input = { expectedRevision: 5, addOns: [OPTION] };
    await clientWith(f).replaceGigAddOns(GIG_ID, input);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/add-ons`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual(input);
    expect(Object.keys(headersOf(init)).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
  });
  it('requestGigMediaUpload: POST .../draft/media/uploads, parsed into the pending media, the one-time target and the revision after the reservation', async () => {
    const f = stubFetch(() => json(201, { data: uploadDto(), meta }));
    const input = { expectedRevision: 5, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64), altText: null };
    const out = await clientWith(f).requestGigMediaUpload(GIG_ID, input);
    expect(out.media.status).toBe('UPLOADING');
    expect(out.upload.headers).toEqual({ 'content-type': 'image/png' });
    expect(out.revision).toBe(4);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/media/uploads`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(input);
  });
  it('finalizeGigMedia: POST .../draft/media/:mediaId/finalize', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).finalizeGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 6, sha256: 'b'.repeat(64) });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/media/${MEDIA_ID}/finalize`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 6, sha256: 'b'.repeat(64) });
  });
  it('updateGigMedia: PUT .../draft/media/:mediaId with the alt text', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).updateGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 6, altText: 'A kitchen' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/media/${MEDIA_ID}`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 6, altText: 'A kitchen' });
  });
  it('detachGigMedia: DELETE .../draft/media/:mediaId carries the revision in a JSON body', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).detachGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 6 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/media/${MEDIA_ID}`);
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBe('{"expectedRevision":6}');
    expect(headersOf(init)['content-type']).toBe('application/json');
  });
  it('reorderGigMedia: PUT .../draft/media/order with the whole order', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    const ids = [MEDIA_ID, '7c2f9b44-1d7a-4e08-b3a5-7f0e8d1c2a56'];
    await clientWith(f).reorderGigMedia(GIG_ID, { expectedRevision: 6, mediaIds: ids });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/draft/media/order`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 6, mediaIds: ids });
  });
  it('getGigMediaPreview: GET the draft route without a version, the version route with one; no body; the short-lived target is parsed', async () => {
    const f = stubFetch(() => json(200, { data: { url: 'https://store.test/o?sig=1', expiresAt: '2026-10-17T10:00:00.000Z' }, meta }));
    const c = clientWith(f);
    expect((await c.getGigMediaPreview(GIG_ID, MEDIA_ID, undefined, { activeRole: 'PROVIDER' })).url).toBe('https://store.test/o?sig=1');
    await c.getGigMediaPreview(GIG_ID, MEDIA_ID, 3);
    const [draftUrl, draftInit] = f.mock.calls[0]!;
    expect(draftUrl).toBe(`${BASE}/draft/media/${MEDIA_ID}/preview`);
    expect(draftInit?.method).toBe('GET');
    expect(draftInit?.body).toBeUndefined();
    expect(headersOf(draftInit)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/versions/3/media/${MEDIA_ID}/preview`);
  });
  it('ids are encoded in the path', async () => {
    const f = stubFetch(() => json(200, { data: DETAIL, meta }));
    await clientWith(f).finalizeGigMedia('a/../b?x=1', 'm/1', { expectedRevision: 1 });
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/provider/gigs/a%2F..%2Fb%3Fx%3D1/draft/media/m%2F1/finalize');
  });
  it('no call puts an account id, an object key or a version in a body', async () => {
    const f = stubFetch((url) => (url.endsWith('/uploads') ? json(201, { data: uploadDto(), meta }) : json(200, { data: DETAIL, meta })));
    const c = clientWith(f);
    await c.replaceGigVariants(GIG_ID, { expectedRevision: 1, variants: [] });
    await c.replaceGigAddOns(GIG_ID, { expectedRevision: 1, addOns: [] });
    await c.requestGigMediaUpload(GIG_ID, { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1, altText: null });
    await c.finalizeGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 2 });
    await c.updateGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 2, altText: null });
    await c.detachGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 2 });
    await c.reorderGigMedia(GIG_ID, { expectedRevision: 2, mediaIds: [] });
    for (const [, i] of f.mock.calls) expect(String(i?.body ?? '').toLowerCase()).not.toMatch(/account|objectkey|object_key|version"/);
  });

  describe('errors', () => {
    const CALLS: Array<[string, (c: ReturnType<typeof clientWith>) => Promise<unknown>]> = [
      ['replaceGigVariants', (c) => c.replaceGigVariants(GIG_ID, { expectedRevision: 1, variants: [] })],
      ['replaceGigAddOns', (c) => c.replaceGigAddOns(GIG_ID, { expectedRevision: 1, addOns: [] })],
      [
        'requestGigMediaUpload',
        (c) => c.requestGigMediaUpload(GIG_ID, { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1, altText: null }),
      ],
      ['finalizeGigMedia', (c) => c.finalizeGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 1 })],
      ['updateGigMedia', (c) => c.updateGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 1, altText: null })],
      ['detachGigMedia', (c) => c.detachGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 1 })],
      ['reorderGigMedia', (c) => c.reorderGigMedia(GIG_ID, { expectedRevision: 1, mediaIds: [] })],
      ['getGigMediaPreview', (c) => c.getGigMediaPreview(GIG_ID, MEDIA_ID)],
      ['getGigMediaPreview (version)', (c) => c.getGigMediaPreview(GIG_ID, MEDIA_ID, 2)],
    ];
    it.each(CALLS)('%s: the error envelope becomes an ApiError with status, code and category', async (_name, call) => {
      const f = stubFetch(() => json(409, errorBody('GIG_MEDIA_EXPIRED', 'CONFLICT')));
      const err = await refusal(call(clientWith(f)));
      expect([err.status, err.code, err.category]).toEqual([409, 'GIG_MEDIA_EXPIRED', 'CONFLICT']);
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
    it('the four new codes keep their status and code', async () => {
      for (const [status, code, category] of [
        [404, 'GIG_MEDIA_NOT_FOUND', 'NOT_FOUND'],
        [400, 'GIG_MEDIA_REFUSED', 'VALIDATION'],
        [409, 'GIG_MEDIA_EXPIRED', 'CONFLICT'],
        [503, 'GIG_MEDIA_SCAN_UNAVAILABLE', 'DEPENDENCY'],
      ] as const) {
        const f = stubFetch(() => json(status, errorBody(code, category)));
        const err = await refusal(clientWith(f).finalizeGigMedia(GIG_ID, MEDIA_ID, { expectedRevision: 1 }));
        expect([err.status, err.code, err.category]).toEqual([status, code, category]);
      }
    });
    it('an upload answer whose media is not UPLOADING or READY is rejected by the contract', async () => {
      const lying = { ...uploadDto(), media: { ...uploadDto().media, status: 'DELETED' } };
      const f = stubFetch(() => json(201, { data: lying, meta }));
      expect(
        (
          await refusal(
            clientWith(f).requestGigMediaUpload(GIG_ID, { expectedRevision: 1, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1, altText: null }),
          )
        ).code,
      ).toBe('UNEXPECTED_RESPONSE');
    });
  });
});
