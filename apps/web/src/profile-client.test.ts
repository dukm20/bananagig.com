// PRO-002 web side, part 1: the provider profile calls of the typed API client with an injected fetch: method, URL, headers, JSON body, the contract parse, the `created` flag of create
// (HTTP 201 vs 200), the bounded photo read and the ApiError mapping. No call carries an account id; the account is the bearer token's, and the public call carries no token at all.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import { PUBLIC_PROFILE_ID, ownerProfileDto, ownerStateDto, photoUploadDto, previewDto, publicProfileDto } from './testing/profile-stub';

const meta = { correlationId: 'corr-1234567' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
const clientWith = (f: ReturnType<typeof stubFetch>, token: string | null = 'tok-P') =>
  createApiClient({
    baseUrl: 'http://api.test/',
    fetch: f as unknown as typeof fetch,
    correlationId: () => 'web-corr-12345',
    accessToken: () => token ?? undefined,
  });
const errorBody = (code: string, category: string, details?: Record<string, unknown>) => ({
  error: { code, category, message: `${code} happened`, correlationId: 'corr-err-1234', ...(details ? { details } : {}) },
});
const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};
const STATE = ownerStateDto(ownerProfileDto({ revision: 6 }));
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe('api client: provider profile (owner)', () => {
  it('getProviderProfile: GET /provider/profile with the bearer token, correlation id and role header, no body; parsed with the contract', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    const out = await clientWith(f).getProviderProfile({ activeRole: 'PROVIDER' });
    expect(out).toEqual(STATE);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init)).toMatchObject({ authorization: 'Bearer tok-P', [CORRELATION_HEADER]: 'web-corr-12345', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    expect(headersOf(init)['content-type']).toBeUndefined();
  });
  it('getProviderProfile: a state with no profile (exists: false) is valid; no role header without an active role', async () => {
    const f = stubFetch(() => json(200, { data: ownerStateDto(null), meta }));
    const out = await clientWith(f).getProviderProfile();
    expect([out.exists, out.profile]).toEqual([false, null]);
    expect(Object.keys(headersOf(f.mock.calls[0]![1])).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
  });
  it('createProviderProfile: POST /provider/profile with an empty JSON object; 201 means created: true, 200 the existing profile', async () => {
    const f = stubFetch(() => json(201, { data: STATE, meta }));
    const out = await clientWith(f).createProviderProfile({ activeRole: 'PROVIDER' });
    expect(out).toEqual({ created: true, state: STATE });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    for (const status of [200, 202])
      expect((await clientWith(stubFetch(() => json(status, { data: STATE, meta }))).createProviderProfile()).created, String(status)).toBe(false);
  });
  it('updateProviderProfile: PATCH /provider/profile with exactly the request body (null clears a field)', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    expect(await clientWith(f).updateProviderProfile({ expectedRevision: 5, displayName: null, bio: 'About me' }, { activeRole: 'PROVIDER' })).toEqual(STATE);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 5, displayName: null, bio: 'About me' });
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
  });
  it('setProviderProfileVisibility: POST /provider/profile/visibility with the revision and the visibility', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    await clientWith(f).setProviderProfileVisibility({ expectedRevision: 6, visibility: 'PUBLIC' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile/visibility');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 6, visibility: 'PUBLIC' });
  });
  it('requestProviderProfilePhotoUpload: POST /provider/profile/photo/uploads; the answer carries the one-time target and the revision after the reservation', async () => {
    const dto = photoUploadDto();
    const f = stubFetch(() => json(201, { data: dto, meta }));
    const input = { expectedRevision: 4, mimeType: 'image/png', sizeBytes: 1234, sha256: 'a'.repeat(64) };
    expect(await clientWith(f).requestProviderProfilePhotoUpload(input)).toEqual(dto);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile/photo/uploads');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(input);
  });
  it('finalizeProviderProfilePhoto and removeProviderProfilePhoto: POST .../photo/finalize and DELETE .../photo (the JSON body carries the revision)', async () => {
    const f = stubFetch(() => json(200, { data: STATE, meta }));
    const c = clientWith(f);
    expect(await c.finalizeProviderProfilePhoto({ expectedRevision: 5, sha256: 'b'.repeat(64) })).toEqual(STATE);
    expect(await c.removeProviderProfilePhoto({ expectedRevision: 6 })).toEqual(STATE);
    const [[u1, i1], [u2, i2]] = f.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([i1.method, u1]).toEqual(['POST', 'http://api.test/api/v1/provider/profile/photo/finalize']);
    expect(JSON.parse(i1.body as string)).toEqual({ expectedRevision: 5, sha256: 'b'.repeat(64) });
    expect([i2.method, u2]).toEqual(['DELETE', 'http://api.test/api/v1/provider/profile/photo']);
    expect(JSON.parse(i2.body as string)).toEqual({ expectedRevision: 6 });
    expect(headersOf(i2)['content-type']).toBe('application/json');
  });
  it('getProviderProfilePreview: GET /provider/profile/preview parsed with the preview contract (preview: true and the visibility)', async () => {
    const f = stubFetch(() => json(200, { data: previewDto({ visibility: 'PUBLIC' }), meta }));
    const out = await clientWith(f).getProviderProfilePreview({ activeRole: 'PROVIDER' });
    expect([out.preview, out.visibility]).toEqual([true, 'PUBLIC']);
    expect(f.mock.calls[0]![0]).toBe('http://api.test/api/v1/provider/profile/preview');
    expect(headersOf(f.mock.calls[0]![1])[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
  });
});

describe('api client: provider profile (public)', () => {
  it('getPublicProviderProfile: GET /providers/<id> with NO token and no role header; the id is encoded; parsed with the strict public contract', async () => {
    const f = stubFetch(() => json(200, { data: publicProfileDto(), meta }));
    const out = await clientWith(f, null).getPublicProviderProfile(PUBLIC_PROFILE_ID);
    expect(out.publicProfileId).toBe(PUBLIC_PROFILE_ID);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`http://api.test/api/v1/providers/${PUBLIC_PROFILE_ID}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(Object.keys(headersOf(init)).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(headersOf(init)).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
    await clientWith(f, null).getPublicProviderProfile('a/../b?x=1');
    expect(f.mock.calls[1]![0]).toBe('http://api.test/api/v1/providers/a%2F..%2Fb%3Fx%3D1');
  });
  it('a public body with a field the contract does not know (an account id, an email) is rejected, not rendered', async () => {
    for (const extra of [{ accountId: 'acc-1' }, { email: 'a@b.test' }, { phone: '+1555' }, { legalName: 'Jane Doe' }]) {
      const f = stubFetch(() => json(200, { data: { ...publicProfileDto(), ...extra }, meta }));
      expect((await refusal(clientWith(f, null).getPublicProviderProfile(PUBLIC_PROFILE_ID))).code).toBe('UNEXPECTED_RESPONSE');
    }
    const lying = { ...publicProfileDto(), ratings: { available: true, average: 4.9 } };
    expect(
      (
        await refusal(
          clientWith(
            stubFetch(() => json(200, { data: lying, meta })),
            undefined,
          ).getPublicProviderProfile(PUBLIC_PROFILE_ID),
        )
      ).code,
    ).toBe('UNEXPECTED_RESPONSE');
  });
  it("an unknown or private profile is the API's 404 (ApiError), the same for both", async () => {
    const f = stubFetch(() => json(404, errorBody('PROFILE_NOT_FOUND', 'NOT_FOUND')));
    const err = await refusal(clientWith(f, null).getPublicProviderProfile(PUBLIC_PROFILE_ID));
    expect([err.status, err.code]).toEqual([404, 'PROFILE_NOT_FOUND']);
  });
});

describe('api client: the owner photo (sanitised bytes)', () => {
  const bytesResponse = (over: { status?: number; type?: string | null; etag?: string | null; body?: Uint8Array | null; length?: string } = {}) =>
    new Response((over.body === undefined ? BYTES : over.body) as unknown as BodyInit | null, {
      status: over.status ?? 200,
      headers: {
        ...(over.type === null ? {} : { 'content-type': over.type ?? 'image/jpeg' }),
        ...(over.etag === null ? {} : { etag: over.etag ?? 'W/"abc123"' }),
        ...(over.length ? { 'content-length': over.length } : {}),
      },
    });
  it('GET /provider/profile/photo with the bearer token, the role and the correlation id; returns the bytes, the content type and the ETag', async () => {
    const f = stubFetch(() => bytesResponse());
    const out = await clientWith(f).getProviderProfilePhoto({ activeRole: 'PROVIDER' });
    expect(out.kind).toBe('bytes');
    if (out.kind !== 'bytes') throw new Error('unreachable');
    expect([...out.bytes]).toEqual([...BYTES]);
    expect([out.contentType, out.etag]).toEqual(['image/jpeg', 'W/"abc123"']);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/provider/profile/photo');
    expect(init?.method).toBe('GET');
    expect(headersOf(init)).toMatchObject({ authorization: 'Bearer tok-P', [ACTIVE_ROLE_HEADER]: 'PROVIDER', [CORRELATION_HEADER]: 'web-corr-12345' });
    expect(headersOf(init)['if-none-match']).toBeUndefined();
  });
  it('forwards If-None-Match and answers a 304 as "not modified"', async () => {
    const f = stubFetch(() => new Response(null, { status: 304, headers: { etag: 'W/"abc123"' } }));
    const out = await clientWith(f).getProviderProfilePhoto({}, { ifNoneMatch: 'W/"abc123"' });
    expect(out).toEqual({ kind: 'not-modified', etag: 'W/"abc123"' });
    expect(headersOf(f.mock.calls[0]![1])['if-none-match']).toBe('W/"abc123"');
  });
  it('accepts the three image types (with parameters) and refuses any other content type, including none', async () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'IMAGE/PNG; charset=binary'])
      expect((await clientWith(stubFetch(() => bytesResponse({ type }))).getProviderProfilePhoto()).kind, type).toBe('bytes');
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', 'image/gif', null])
      expect((await refusal(clientWith(stubFetch(() => bytesResponse({ type }))).getProviderProfilePhoto())).code, String(type)).toBe('UNEXPECTED_RESPONSE');
  });
  it('refuses a declared length above the ceiling and cancels a stream that grows beyond it without declaring', async () => {
    expect((await refusal(clientWith(stubFetch(() => bytesResponse({ length: '26214401' }))).getProviderProfilePhoto())).code).toBe('UNEXPECTED_RESPONSE');
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4_194_304));
        if (pulled > 50) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = stubFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }));
    expect((await refusal(clientWith(f).getProviderProfilePhoto())).code).toBe('UNEXPECTED_RESPONSE');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
  it("a missing photo is an ApiError with the API's code; a non-envelope failure is UNEXPECTED_RESPONSE; an unreachable API is API_UNREACHABLE", async () => {
    const e = await refusal(clientWith(stubFetch(() => json(404, errorBody('PROFILE_NOT_FOUND', 'NOT_FOUND')))).getProviderProfilePhoto());
    expect([e.status, e.code]).toEqual([404, 'PROFILE_NOT_FOUND']);
    const bad = await refusal(clientWith(stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }))).getProviderProfilePhoto());
    expect([bad.status, bad.code]).toEqual([502, 'UNEXPECTED_RESPONSE']);
    expect((await refusal(clientWith(stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))).getProviderProfilePhoto())).code).toBe('API_UNREACHABLE');
  });
});

describe('api client: provider profile calls overall', () => {
  it('no call puts an account id in a path, a query or a body', async () => {
    const f = stubFetch((url) =>
      url.endsWith('/preview')
        ? json(200, { data: previewDto(), meta })
        : url.endsWith('/uploads')
          ? json(201, { data: photoUploadDto(), meta })
          : url.includes('/providers/')
            ? json(200, { data: publicProfileDto(), meta })
            : json(200, { data: STATE, meta }),
    );
    const c = clientWith(f);
    await c.getProviderProfile();
    await c.createProviderProfile();
    await c.updateProviderProfile({ expectedRevision: 1, bio: 'x' });
    await c.setProviderProfileVisibility({ expectedRevision: 1, visibility: 'PRIVATE' });
    await c.requestProviderProfilePhotoUpload({ expectedRevision: 1, mimeType: 'image/png', sizeBytes: 10 });
    await c.finalizeProviderProfilePhoto({ expectedRevision: 2 });
    await c.removeProviderProfilePhoto({ expectedRevision: 3 });
    await c.getProviderProfilePreview();
    await c.getPublicProviderProfile(PUBLIC_PROFILE_ID);
    expect(f.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      'GET http://api.test/api/v1/provider/profile',
      'POST http://api.test/api/v1/provider/profile',
      'PATCH http://api.test/api/v1/provider/profile',
      'POST http://api.test/api/v1/provider/profile/visibility',
      'POST http://api.test/api/v1/provider/profile/photo/uploads',
      'POST http://api.test/api/v1/provider/profile/photo/finalize',
      'DELETE http://api.test/api/v1/provider/profile/photo',
      'GET http://api.test/api/v1/provider/profile/preview',
      `GET http://api.test/api/v1/providers/${PUBLIC_PROFILE_ID}`,
    ]);
    for (const [u, i] of f.mock.calls) expect(`${u} ${String(i?.body ?? '')}`.toLowerCase()).not.toContain('account');
  });

  const CALLS: Array<[string, (c: ReturnType<typeof clientWith>) => Promise<unknown>]> = [
    ['getProviderProfile', (c) => c.getProviderProfile()],
    ['createProviderProfile', (c) => c.createProviderProfile()],
    ['updateProviderProfile', (c) => c.updateProviderProfile({ expectedRevision: 1, bio: 'x' })],
    ['setProviderProfileVisibility', (c) => c.setProviderProfileVisibility({ expectedRevision: 1, visibility: 'PUBLIC' })],
    ['requestProviderProfilePhotoUpload', (c) => c.requestProviderProfilePhotoUpload({ expectedRevision: 1, mimeType: 'image/png', sizeBytes: 10 })],
    ['finalizeProviderProfilePhoto', (c) => c.finalizeProviderProfilePhoto({ expectedRevision: 1 })],
    ['removeProviderProfilePhoto', (c) => c.removeProviderProfilePhoto({ expectedRevision: 1 })],
    ['getProviderProfilePreview', (c) => c.getProviderProfilePreview()],
    ['getPublicProviderProfile', (c) => c.getPublicProviderProfile(PUBLIC_PROFILE_ID)],
  ];
  it.each(CALLS)('%s: the error envelope becomes an ApiError with status, code, category and details', async (_name, call) => {
    const f = stubFetch(() => json(409, errorBody('STALE_PROFILE', 'CONFLICT', { issues: [{ reason: 'BIO_REQUIRED' }] })));
    const err = await refusal(call(clientWith(f)));
    expect([err.status, err.code, err.category]).toEqual([409, 'STALE_PROFILE', 'CONFLICT']);
    expect(err.details).toEqual({ issues: [{ reason: 'BIO_REQUIRED' }] });
  });
  it.each(CALLS)('%s: a body that violates the contract is UNEXPECTED_RESPONSE, not a crash of the caller', async (_name, call) => {
    const f = stubFetch(() => json(200, { data: { nonsense: true }, meta }));
    expect((await refusal(call(clientWith(f)))).code).toBe('UNEXPECTED_RESPONSE');
  });
  it.each(CALLS)('%s: a 5xx without the envelope is UNEXPECTED_RESPONSE and an unreachable API is API_UNREACHABLE', async (_name, call) => {
    const err = await refusal(call(clientWith(stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 })))));
    expect([err.status, err.code]).toEqual([502, 'UNEXPECTED_RESPONSE']);
    expect((await refusal(call(clientWith(stubFetch(() => Promise.reject(new Error('ECONNREFUSED'))))))).code).toBe('API_UNREACHABLE');
  });
  it('401 SESSION_REVOKED keeps its code so the caller can end the local session', async () => {
    const f = stubFetch(() => json(401, errorBody('SESSION_REVOKED', 'AUTHENTICATION')));
    const err = await refusal(clientWith(f).getProviderProfile());
    expect([err.status, err.code]).toEqual([401, 'SESSION_REVOKED']);
  });
});
