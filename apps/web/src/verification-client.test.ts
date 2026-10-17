// TRUST-001 web side, part 2: the provider verification calls of the typed API client with an injected fetch: method, URL, headers, JSON body, the contract parse, the
// `created` flag of open (HTTP 201 vs 200), the path-segment encoding of ids and codes, and the ApiError mapping. No call carries an account id, a case id or a decision.
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_ROLE_HEADER, CORRELATION_HEADER } from '@bananagig/contracts';
import { ApiError, createApiClient } from './lib/api-client';
import {
  caseDto,
  documentDto,
  requirementDto,
  uploadAuthorizationDto,
  verificationDto,
  UPLOAD_URL,
  VERIFICATION_DOCUMENT_ID,
} from './testing/verification-stub';

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

const BASE = 'http://api.test/api/v1/provider/verification';
const OPEN_CASE = caseDto({ revision: 5 });
const VIEW = verificationDto({
  case: OPEN_CASE,
  requirements: [requirementDto({ status: 'NOT_STARTED', canAttachEvidence: true, documents: [documentDto()] })],
});
const DOC = documentDto({ status: 'WITHDRAWN' });
const AUTH = uploadAuthorizationDto();

describe('api client: provider verification', () => {
  it('getProviderVerification: GET /provider/verification with the bearer token, correlation id and role header, no body; parsed with the contract', async () => {
    const f = stubFetch(() => json(200, { data: VIEW, meta }));
    const out = await clientWith(f).getProviderVerification({ activeRole: 'PROVIDER' });
    expect(out).toEqual(VIEW);
    expect(out.goLive).toEqual({ evaluated: false, eligible: false });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(BASE);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(headersOf(init)).toMatchObject({ authorization: 'Bearer tok-P', [CORRELATION_HEADER]: 'web-corr-12345', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
    expect(headersOf(init)['content-type']).toBeUndefined();
  });
  it('getProviderVerification: no role header without an active role; a null case is a valid read model', async () => {
    const f = stubFetch(() => json(200, { data: verificationDto(), meta }));
    expect((await clientWith(f).getProviderVerification()).case).toBeNull();
    expect(Object.keys(headersOf(f.mock.calls[0]![1])).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
  });
  it('openProviderVerification: POST /provider/verification with an empty JSON object; 201 means created: true and the verification is returned', async () => {
    const f = stubFetch(() => json(201, { data: VIEW, meta }));
    const out = await clientWith(f).openProviderVerification({ activeRole: 'CUSTOMER' });
    expect(out).toEqual({ created: true, verification: VIEW });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(BASE);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'CUSTOMER', authorization: 'Bearer tok-P' });
  });
  it('openProviderVerification: 200 means the live case was resumed (created: false); only 201 is created', async () => {
    for (const status of [200, 202]) {
      const f = stubFetch(() => json(status, { data: VIEW, meta }));
      expect((await clientWith(f).openProviderVerification()).created, String(status)).toBe(false);
    }
    const f = stubFetch(() => json(201, { data: VIEW, meta }));
    expect((await clientWith(f).openProviderVerification()).created).toBe(true);
  });
  it('requestVerificationUpload: POST /provider/verification/documents/upload with exactly the request body; the answer is the authorization', async () => {
    const f = stubFetch(() => json(201, { data: AUTH, meta }));
    const input = { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 2048 };
    const out = await clientWith(f).requestVerificationUpload(input, { activeRole: 'PROVIDER' });
    expect(out).toEqual(AUTH);
    expect(out.upload.url).toBe(UPLOAD_URL);
    expect(out.upload.method).toBe('PUT');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/documents/upload`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(input);
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER', authorization: 'Bearer tok-P' });
  });
  it('finalizeVerificationDocument: POST /documents/<id>/finalize with the body (an empty object by default); the answer is the document', async () => {
    const f = stubFetch(() => json(200, { data: documentDto(), meta }));
    const out = await clientWith(f).finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID, {}, { activeRole: 'PROVIDER' });
    expect(out).toEqual(documentDto());
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/documents/${VERIFICATION_DOCUMENT_ID}/finalize`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
    await clientWith(f).finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID);
    expect(f.mock.calls[1]![1]?.body).toBe('{}');
    expect(Object.keys(headersOf(f.mock.calls[1]![1])).map((k) => k.toLowerCase())).not.toContain(ACTIVE_ROLE_HEADER.toLowerCase());
    await clientWith(f).finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID, { sha256: 'a'.repeat(64) });
    expect(JSON.parse(f.mock.calls[2]![1]?.body as string)).toEqual({ sha256: 'a'.repeat(64) });
  });
  it('withdrawVerificationDocument: POST /documents/<id>/withdraw with an empty object', async () => {
    const f = stubFetch(() => json(200, { data: DOC, meta }));
    const out = await clientWith(f).withdrawVerificationDocument(VERIFICATION_DOCUMENT_ID, { activeRole: 'CUSTOMER' });
    expect(out.status).toBe('WITHDRAWN');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/documents/${VERIFICATION_DOCUMENT_ID}/withdraw`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'CUSTOMER' });
  });
  it('submitProviderVerification: POST /provider/verification/submit with the revision; the answer is the verification', async () => {
    const f = stubFetch(() => json(200, { data: VIEW, meta }));
    const out = await clientWith(f).submitProviderVerification({ expectedRevision: 5 }, { activeRole: 'PROVIDER' });
    expect(out.case?.revision).toBe(5);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/submit`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 5 });
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('PROVIDER');
  });
  it('cancelProviderVerification: POST /provider/verification/cancel with an empty object only (no reason can reach the audit trail)', async () => {
    const f = stubFetch(() => json(200, { data: verificationDto(), meta }));
    const out = await clientWith(f).cancelProviderVerification({ activeRole: 'CUSTOMER' });
    expect(out.case).toBeNull();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cancel`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)[ACTIVE_ROLE_HEADER]).toBe('CUSTOMER');
  });
  it('reverifyProviderRequirement: POST /requirements/<code>/reverify with an empty object', async () => {
    const f = stubFetch(() => json(200, { data: VIEW, meta }));
    await clientWith(f).reverifyProviderRequirement('identity_verification', { activeRole: 'PROVIDER' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/requirements/identity_verification/reverify`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headersOf(init)).toMatchObject({ 'content-type': 'application/json', [ACTIVE_ROLE_HEADER]: 'PROVIDER' });
  });
  it('an id or a code is ONE encoded path segment: it cannot add a segment, a query or a traversal', async () => {
    const f = stubFetch(() => json(200, { data: VIEW, meta }));
    const c = clientWith(f);
    const evil = 'a/../b?x=1#y%2F';
    await c.reverifyProviderRequirement(evil);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/requirements/a%2F..%2Fb%3Fx%3D1%23y%252F/reverify`);
    const g = stubFetch(() => json(200, { data: DOC, meta }));
    await clientWith(g).finalizeVerificationDocument(evil);
    await clientWith(g).withdrawVerificationDocument(evil);
    expect(g.mock.calls[0]![0]).toBe(`${BASE}/documents/a%2F..%2Fb%3Fx%3D1%23y%252F/finalize`);
    expect(g.mock.calls[1]![0]).toBe(`${BASE}/documents/a%2F..%2Fb%3Fx%3D1%23y%252F/withdraw`);
    for (const [u] of [...f.mock.calls, ...g.mock.calls]) expect(new URL(String(u)).search).toBe('');
  });
  it('no verification call puts an account id, a case id or a decision in a path, a query or a body', async () => {
    const f = stubFetch((url) => {
      if (url.endsWith('/documents/upload')) return json(201, { data: AUTH, meta });
      if (url.includes('/documents/')) return json(200, { data: DOC, meta });
      return json(200, { data: VIEW, meta });
    });
    const c = clientWith(f);
    await c.getProviderVerification();
    await c.openProviderVerification();
    await c.requestVerificationUpload({ requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'image/png', sizeBytes: 10 });
    await c.finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID);
    await c.withdrawVerificationDocument(VERIFICATION_DOCUMENT_ID);
    await c.submitProviderVerification({ expectedRevision: 1 });
    await c.cancelProviderVerification();
    await c.reverifyProviderRequirement('identity_verification');
    expect(f.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      `GET ${BASE}`,
      `POST ${BASE}`,
      `POST ${BASE}/documents/upload`,
      `POST ${BASE}/documents/${VERIFICATION_DOCUMENT_ID}/finalize`,
      `POST ${BASE}/documents/${VERIFICATION_DOCUMENT_ID}/withdraw`,
      `POST ${BASE}/submit`,
      `POST ${BASE}/cancel`,
      `POST ${BASE}/requirements/identity_verification/reverify`,
    ]);
    for (const [u, i] of f.mock.calls) {
      const text = `${u} ${String(i?.body ?? '')}`.toLowerCase();
      expect(text).not.toContain('account');
      expect(text).not.toContain('verificationcase');
      expect(text).not.toContain('caserequirement');
      expect(text).not.toContain('decision');
    }
  });

  describe('contract', () => {
    it('a read model that claims Go-Live is evaluated or eligible is rejected (it is never true here)', async () => {
      for (const goLive of [
        { evaluated: true, eligible: false },
        { evaluated: false, eligible: true },
        { evaluated: true, eligible: true },
      ]) {
        const f = stubFetch(() => json(200, { data: { ...VIEW, goLive }, meta }));
        expect((await refusal(clientWith(f).getProviderVerification())).code).toBe('UNEXPECTED_RESPONSE');
      }
    });
    it('an unknown requirement, case, document or scan status is rejected', async () => {
      const bad = [
        { ...VIEW, requirements: [{ ...VIEW.requirements[0], status: 'VERIFIED' }] },
        { ...VIEW, case: { ...VIEW.case, status: 'REJECTED' } },
        { ...VIEW, overall: { ...VIEW.overall, status: 'VERIFIED' } },
      ];
      for (const data of bad) {
        const f = stubFetch(() => json(200, { data, meta }));
        expect((await refusal(clientWith(f).getProviderVerification())).code).toBe('UNEXPECTED_RESPONSE');
      }
      const g = stubFetch(() => json(200, { data: { ...DOC, status: 'DELETED' }, meta }));
      expect((await refusal(clientWith(g).withdrawVerificationDocument(VERIFICATION_DOCUMENT_ID))).code).toBe('UNEXPECTED_RESPONSE');
      const h = stubFetch(() => json(200, { data: { ...DOC, scanStatus: 'MAYBE' }, meta }));
      expect((await refusal(clientWith(h).finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID))).code).toBe('UNEXPECTED_RESPONSE');
    });
    it('an upload authorization whose method is not PUT, or without a url, is rejected', async () => {
      const f = stubFetch(() => json(201, { data: { ...AUTH, upload: { ...AUTH.upload, method: 'POST' } }, meta }));
      const input = { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 5 };
      expect((await refusal(clientWith(f).requestVerificationUpload(input))).code).toBe('UNEXPECTED_RESPONSE');
      const { url: _url, ...noUrl } = AUTH.upload;
      const g = stubFetch(() => json(201, { data: { ...AUTH, upload: noUrl }, meta }));
      expect((await refusal(clientWith(g).requestVerificationUpload(input))).code).toBe('UNEXPECTED_RESPONSE');
    });
    it('a response without the envelope data (a bare dto) is rejected', async () => {
      const f = stubFetch(() => json(200, VIEW));
      expect((await refusal(clientWith(f).getProviderVerification())).code).toBe('UNEXPECTED_RESPONSE');
    });
  });

  describe('errors', () => {
    const INPUT = { requirementCode: 'identity_verification', documentTypeCode: 'passport', mimeType: 'application/pdf', sizeBytes: 5 };
    const CALLS: Array<[string, (c: ReturnType<typeof clientWith>) => Promise<unknown>]> = [
      ['getProviderVerification', (c) => c.getProviderVerification()],
      ['openProviderVerification', (c) => c.openProviderVerification()],
      ['requestVerificationUpload', (c) => c.requestVerificationUpload(INPUT)],
      ['finalizeVerificationDocument', (c) => c.finalizeVerificationDocument(VERIFICATION_DOCUMENT_ID)],
      ['withdrawVerificationDocument', (c) => c.withdrawVerificationDocument(VERIFICATION_DOCUMENT_ID)],
      ['submitProviderVerification', (c) => c.submitProviderVerification({ expectedRevision: 1 })],
      ['cancelProviderVerification', (c) => c.cancelProviderVerification()],
      ['reverifyProviderRequirement', (c) => c.reverifyProviderRequirement('identity_verification')],
    ];
    it.each(CALLS)('%s: the error envelope becomes an ApiError with status, code and category', async (_name, call) => {
      const f = stubFetch(() => json(409, errorBody('TRUST_STALE_CASE', 'CONFLICT')));
      const err = await refusal(call(clientWith(f)));
      expect([err.status, err.code, err.category]).toEqual([409, 'TRUST_STALE_CASE', 'CONFLICT']);
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
    it.each(CALLS)('%s: 401 SESSION_REVOKED keeps its code so the caller can end the local session', async (_name, call) => {
      const f = stubFetch(() => json(401, errorBody('SESSION_REVOKED', 'AUTHENTICATION')));
      const err = await refusal(call(clientWith(f)));
      expect([err.status, err.code]).toEqual([401, 'SESSION_REVOKED']);
    });
  });
});
