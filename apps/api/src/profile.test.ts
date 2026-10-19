// Unit tests of the provider public profile API module (PRO-002) with a FAKE ProviderProfileService, a FAKE ProfilePhotoApi and a FAKE AccountService. The real rules are covered by
// packages/provider and profile.itest.ts; here: authentication and the identity context on every OWNER route (401 before 400, 403 for the admin context and for suspended or closed accounts,
// the active-role header is NOT honoured), that the services only ever receive the account of the VERIFIED TOKEN, that no account id / profile id / status / asset is accepted from a
// client, strict bodies, the cache policy (no-store on the owner side and on the public JSON, the photo's own revalidation policy), status codes, exact response key sets and the absence of
// hostile service properties, the PUBLIC routes (no authentication, Authorization ignored, ONE identical 404 for every refusal and for malformed ids, the photo headers and the 304), the
// error mapping for EVERY ProfileError code with its details allow-list (never provider text), the composition-root ports, the OpenAPI document and the committed specs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ErrorResponse,
  OwnerProfileStateResponse,
  PROFILE_ERROR_CODES,
  PROFILE_EVENTS,
  PROFILE_ISSUE_REASONS,
  PROVIDER_PROFILE_POLICY_KEYS,
  PreviewProviderProfileResponse,
  ProfileUpdatedPayload,
  ProfileVisibilityChangedPayload,
  PublicProviderProfileResponse,
  profileErrorKey,
  profileWireCode,
  type ProfileErrorCode,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService } from '@bananagig/accounts';
import { ProfileError, ProviderError, type ProfilePhotoApi, type ProviderProfileService } from '@bananagig/provider';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { previewProfileDto, publicProfileDto, safeDetails, toAppError } from './modules/provider/profile-dto';
import { PROFILE_BODY_LIMIT, PROFILE_SMALL_BODY_LIMIT } from './modules/provider/profile-routes';
import {
  createAccountNamePort,
  createGigServiceNamePort,
  createProfilePolicyProvider,
  createProfilePrerequisites,
  createTrustSummaryPort,
} from './modules/provider/profile-wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- fakes
const svc = {
  getOwnerProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  setVisibility: vi.fn(),
  getPreview: vi.fn(),
  getPublicProfile: vi.fn(),
};
const photos = { requestUpload: vi.fn(), finalize: vi.fn(), remove: vi.fn(), ownerPhoto: vi.fn(), publicPhoto: vi.fn() };
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn() };
const noServiceCalled = () => [...Object.values(svc), ...Object.values(photos)].every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-subject-marker-other-91d3';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const PROFILE_ID = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const GIG_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const ISO = '2026-10-16T12:00:00.000Z';
/** Provider text the fakes carry: it may appear in the owner's own responses and the public projection, and NEVER in an error. */
const TEXT_SENTINEL = 'Sentinel provider text: call me at 555-0100';
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };

const state = { memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }] as { code: string; status: 'PENDING' | 'ACTIVE' | 'INACTIVE' }[] };
const makeContext = (accountId: string): AccountContext =>
  ({
    accountId,
    status: 'ACTIVE',
    roles: state.memberships.filter((m) => m.status === 'ACTIVE').map((m) => (m.code === 'PROVIDER' ? PROVIDER : CUSTOMER)),
    memberships: state.memberships,
    primaryRole: 'CUSTOMER',
    activeRole: 'CUSTOMER',
    profile: { firstName: 'Sentinel-First-Name', lastName: 'Sentinel-Last-Name', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
    email: { emailVerificationStatus: 'VERIFIED', primary: { address: 'sentinel.mail@sentinel-contact.example' }, pending: null },
    phone: { phoneVerificationStatus: 'VERIFIED', primary: { number: '+15550001234' }, pending: null },
    contacts: { emailVerified: true, phoneVerified: true, contactsVerified: true },
    createdAt: T0,
    created: false,
  }) as unknown as AccountContext;

const ownerFixture = (over: Record<string, unknown> = {}) => ({
  exists: true,
  profile: {
    publicProfileId: PROFILE_ID,
    displayName: TEXT_SENTINEL,
    publicName: TEXT_SENTINEL,
    bio: 'A bio',
    photo: { mimeType: 'image/jpeg', width: 400, height: 300 },
    photoPending: false,
    visibility: 'PRIVATE',
    publishedAt: null,
    revision: 3,
    createdAt: ISO,
    updatedAt: ISO,
  },
  readiness: {
    displayNamePresent: true,
    publicNameAvailable: true,
    bioPresent: true,
    profilePhotoPresent: true,
    hasPublishedGig: true,
    trustSummaryAvailable: false,
    profileComplete: true,
    visibility: 'PRIVATE',
  },
  limits: {
    displayNameMaxLength: 60,
    bioMaxLength: 1000,
    bioRequired: false,
    photoRequired: false,
    photoMaxSizeBytes: 2_097_152,
    photoMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  ...over,
});
const publicFixture = () => ({
  publicProfileId: PROFILE_ID,
  displayName: TEXT_SENTINEL,
  bio: 'A bio',
  photo: { mimeType: 'image/jpeg', width: 400, height: 300 },
  badges: [{ type: 'IDENTITY' }],
  market: { code: 'us-sf' },
  gigs: [
    {
      gigId: GIG_ID,
      title: 'Deep clean',
      shortPitch: null,
      serviceTypeCode: 'regular_cleaning',
      serviceTypeNameContentKey: 'catalog.service_type.regular_cleaning.name',
      price: { amountMinor: 4500, currency: 'USD' },
      durationMinutes: 90,
      variantCount: 1,
      addOnCount: 0,
      photoCount: 2,
    },
  ],
  ratings: { available: false },
  drops: { available: false },
});
const previewFixture = () => ({ ...publicFixture(), visibility: 'PRIVATE', preview: true });
const uploadFixture = () => ({
  upload: { url: 'https://store.example/put?sig=abc', headers: { 'content-type': 'image/png', 'content-length': '1234' }, expiresAt: ISO },
  maxSizeBytes: 2_097_152,
  revision: 4,
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const CSP = "default-src 'none'; sandbox";
const ETAG = 'W/"opaque-validator-1"';

// ---------------------------------------------------------------- tokens and requests
const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims } });
const adminToken = () =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: ['customer'] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
    },
  });
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  rawPayload: Buffer;
  json: () => unknown;
}
const send = (
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  }) as unknown as Promise<Reply>;
const call = (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  send(method, `/api/v1/provider${url}`, token, payload, headers, target);
const rawBody = (method: Method, url: string, token: string | undefined, text: string): Promise<Reply> =>
  app.inject({
    method,
    url: `/api/v1/provider${url}`,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: text,
  }) as unknown as Promise<Reply>;
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');
const identityOf = (sub: string) => ({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: sub, identityRoles: ['customer'] });

// ---------------------------------------------------------------- the owner operations
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  body?: unknown;
  send?: unknown;
  okStatus: number;
  target: 'svc' | 'photos';
  fn: string;
}
const fnOf = (r: Route) => (r.target === 'svc' ? svc : photos)[r.fn as never] as ReturnType<typeof vi.fn>;
const UPDATE_BODY = { expectedRevision: 3, displayName: 'Jane the Cleaner', bio: 'I clean.' };
const VISIBILITY_BODY = { expectedRevision: 3, visibility: 'PUBLIC' };
const UPLOAD_BODY = { expectedRevision: 3, mimeType: 'image/png', sizeBytes: 1234 };
const FINALIZE_BODY = { expectedRevision: 4, sha256: 'a'.repeat(64) };
const REMOVE_BODY = { expectedRevision: 5 };
const ROUTES: Route[] = [
  { operationId: 'getProviderProfile', method: 'GET', url: '/profile', spec: '/api/v1/provider/profile', okStatus: 200, target: 'svc', fn: 'getOwnerProfile' },
  {
    operationId: 'createProviderProfile',
    method: 'POST',
    url: '/profile',
    spec: '/api/v1/provider/profile',
    send: {},
    okStatus: 201,
    target: 'svc',
    fn: 'createProfile',
  },
  {
    operationId: 'updateProviderProfile',
    method: 'PATCH',
    url: '/profile',
    spec: '/api/v1/provider/profile',
    body: UPDATE_BODY,
    okStatus: 200,
    target: 'svc',
    fn: 'updateProfile',
  },
  {
    operationId: 'setProviderProfileVisibility',
    method: 'POST',
    url: '/profile/visibility',
    spec: '/api/v1/provider/profile/visibility',
    body: VISIBILITY_BODY,
    okStatus: 200,
    target: 'svc',
    fn: 'setVisibility',
  },
  {
    operationId: 'requestProviderProfilePhotoUpload',
    method: 'POST',
    url: '/profile/photo/uploads',
    spec: '/api/v1/provider/profile/photo/uploads',
    body: UPLOAD_BODY,
    okStatus: 201,
    target: 'photos',
    fn: 'requestUpload',
  },
  {
    operationId: 'finalizeProviderProfilePhoto',
    method: 'POST',
    url: '/profile/photo/finalize',
    spec: '/api/v1/provider/profile/photo/finalize',
    body: FINALIZE_BODY,
    okStatus: 200,
    target: 'photos',
    fn: 'finalize',
  },
  {
    operationId: 'removeProviderProfilePhoto',
    method: 'DELETE',
    url: '/profile/photo',
    spec: '/api/v1/provider/profile/photo',
    body: REMOVE_BODY,
    okStatus: 200,
    target: 'photos',
    fn: 'remove',
  },
  {
    operationId: 'getProviderProfilePreview',
    method: 'GET',
    url: '/profile/preview',
    spec: '/api/v1/provider/profile/preview',
    okStatus: 200,
    target: 'svc',
    fn: 'getPreview',
  },
  {
    operationId: 'getProviderProfilePhoto',
    method: 'GET',
    url: '/profile/photo',
    spec: '/api/v1/provider/profile/photo',
    okStatus: 200,
    target: 'photos',
    fn: 'ownerPhoto',
  },
];
const BODY_ROUTES = ROUTES.filter((r) => r.body !== undefined);
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  call(r.method, r.url, token, r.body ?? r.send, headers, target);

// ---------------------------------------------------------------- the apps
const baseDeps = (): AppDeps => ({
  cfg,
  verifier,
  configuration: {} as never,
  accounts: accountSvc as unknown as AccountService,
  providerProfiles: svc as unknown as ProviderProfileService,
  profilePhotos: photos as unknown as ProfilePhotoApi,
  readiness: async () => ({}),
});
async function makeApp(over: Partial<AppDeps>): Promise<FastifyInstance> {
  const instance = await buildApp({ ...baseDeps(), ...over });
  await instance.ready();
  extraApps.push(instance);
  return instance;
}

beforeAll(async () => {
  keys = await createTestKeys('k1');
  verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await makeApp({});
});
afterAll(async () => {
  for (const a of extraApps) await a.close();
});

beforeEach(() => {
  state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
  for (const f of [...Object.values(svc), ...Object.values(photos), ...Object.values(accountSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }, o: { requestedRole?: string } = {}) => {
    if (o.requestedRole !== undefined) {
      const m = state.memberships.find((x) => x.code === o.requestedRole);
      if (!m) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold the role', { role: o.requestedRole });
      if (m.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: o.requestedRole });
    }
    return makeContext(identity.subject === OTHER_SUB ? OTHER_ACCOUNT_ID : ACCOUNT_ID);
  });
  svc.getOwnerProfile.mockImplementation(async () => ownerFixture());
  svc.createProfile.mockImplementation(async () => ({ created: true, state: ownerFixture() }));
  svc.updateProfile.mockImplementation(async () => ownerFixture());
  svc.setVisibility.mockImplementation(async () => ownerFixture());
  svc.getPreview.mockImplementation(async () => previewFixture());
  svc.getPublicProfile.mockImplementation(async () => publicFixture());
  photos.requestUpload.mockImplementation(async () => uploadFixture());
  photos.finalize.mockImplementation(async () => ownerFixture());
  photos.remove.mockImplementation(async () => ownerFixture());
  photos.ownerPhoto.mockImplementation(async () => ({ kind: 'bytes', bytes: JPEG, contentType: 'image/jpeg', etag: ETAG }));
  photos.publicPhoto.mockImplementation(async () => ({ kind: 'bytes', bytes: JPEG, contentType: 'image/jpeg', etag: ETAG }));
});

// ====================================================================== authentication and the identity context (owner)
describe('provider profile API authentication and the account guard', () => {
  it.each(ROUTES)('$method $spec ($operationId) requires a token: 401, no-store, before any service or account call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $spec ($operationId) rejects every kind of invalid token with 401', async (r) => {
    const invalid = [
      'not.a.token',
      await signToken(keys, { expiresInSec: -3600 }),
      await signToken(keys, { claims: { aud: 'someone-else' } }),
      await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } }),
      unsignedToken(),
      await hmacToken(),
    ];
    for (const token of invalid) {
      const res = await routeCall(r, token);
      expect(res.statusCode, token.slice(0, 20)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'INVALID_TOKEN' });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$method $spec ($operationId) refuses the admin identity context and any other client with 403', async (r) => {
    const admin = await routeCall(r, await adminToken());
    expect(admin.statusCode).toBe(403);
    expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) expect((await routeCall(r, await webToken({ azp }))).statusCode, azp).toBe(403);
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$method $spec ($operationId) passes a suspended or closed account through as 403 and never calls the service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 before 400 and 403 before 400 for invalid bodies and queries', async () => {
    for (const r of BODY_ROUTES)
      for (const body of [{ garbage: true }, [], 'text', 7, null]) {
        expect((await rawBody(r.method, r.url, undefined, JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(r.method, r.url, await adminToken(), JSON.stringify(body))).statusCode, r.url).toBe(403);
      }
    for (const url of ['/profile?accountId=x', '/profile/preview?x=1', '/profile/photo?x=1']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
      expect((await call('GET', url, await adminToken())).statusCode, url).toBe(403);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)(
    "$method $spec ($operationId) does NOT honour x-active-role: an unheld or inactive PROVIDER role in the header is not a 403 (eligibility is the service's decision)",
    async (r) => {
      for (const memberships of [
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'PENDING' },
        ],
        [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      ] as (typeof state.memberships)[]) {
        state.memberships = memberships;
        for (const header of ['PROVIDER', 'CUSTOMER', 'ADMIN']) {
          fnOf(r).mockClear();
          const res = await routeCall(r, await webToken(), { 'x-active-role': header });
          expect(res.statusCode, `${header} ${res.body}`).toBeLessThan(300);
          expect(fnOf(r)).toHaveBeenCalledTimes(1);
        }
      }
      for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].requestedRole).toBeUndefined();
    },
  );
});

// ====================================================================== the account of the token, never of the client
describe('the services are called with the account of the verified token only', () => {
  it.each(ROUTES)('$method $spec ($operationId): the first argument is the token account', async (r) => {
    await routeCall(r, await webToken());
    expect(fnOf(r).mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(identityOf(SUB));
    const other = await routeCall(r, await webToken({ sub: OTHER_SUB }));
    expect(other.statusCode).toBeLessThan(300);
    expect(fnOf(r).mock.calls[1]![0]).toBe(OTHER_ACCOUNT_ID);
  });

  it.each(ROUTES)('$method $spec ($operationId): an account or profile id in a header or cookie changes nothing', async (r) => {
    const headers = { 'x-account-id': OTHER_ACCOUNT_ID, 'x-profile-id': PROFILE_ID, 'x-forwarded-user': OTHER_SUB, cookie: `accountId=${OTHER_ACCOUNT_ID}` };
    const res = await routeCall(r, await webToken(), headers);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(JSON.stringify(fnOf(r).mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(JSON.stringify(fnOf(r).mock.calls)).not.toContain(PROFILE_ID);
  });

  it.each(ROUTES.filter((r) => r.method === 'GET'))(
    '$method $spec ($operationId): an account id, profile id, status or visibility in the QUERY is a 400 and never reaches a service',
    async (r) => {
      for (const q of [`accountId=${OTHER_ACCOUNT_ID}`, `publicProfileId=${PROFILE_ID}`, 'status=ACTIVE', 'visibility=PUBLIC', 'locale=en']) {
        const res = await call(r.method, `${r.url}?${q}`, await webToken());
        expect(res.statusCode, `${q}: ${res.body}`).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(fnOf(r)).not.toHaveBeenCalled();
    },
  );

  it.each(BODY_ROUTES)('$method $spec ($operationId): an owner, profile, asset, status, bucket or key in the BODY is a 400', async (r) => {
    for (const extra of [
      { accountId: OTHER_ACCOUNT_ID },
      { account_id: OTHER_ACCOUNT_ID },
      { publicProfileId: PROFILE_ID },
      { photoAssetId: PROFILE_ID },
      { mediaAssetId: PROFILE_ID },
      { objectKey: 'provider/profile-media/x' },
      { purpose: 'GIG_PHOTO' },
      { status: 'ACTIVE' },
      { role: 'PROVIDER' },
      { revision: 9 },
      { goLive: true },
      { verified: true },
    ]) {
      const res = await call(r.method, r.url, await webToken(), { ...(r.body as object), ...extra });
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
      expectNoStore(res);
    }
    expect(fnOf(r)).not.toHaveBeenCalled();
  });

  it('POST /profile (body optional): any property in the body is a 400', async () => {
    for (const extra of [{ accountId: OTHER_ACCOUNT_ID }, { displayName: TEXT_SENTINEL }, { visibility: 'PUBLIC' }]) {
      const res = await call('POST', '/profile', await webToken(), extra);
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(res.body).not.toContain(TEXT_SENTINEL);
    }
    expect(svc.createProfile).not.toHaveBeenCalled();
  });

  it('the services receive the parsed contract and nothing else', async () => {
    const token = await webToken();
    await call('PATCH', '/profile', token, UPDATE_BODY);
    expect(svc.updateProfile.mock.calls[0]).toEqual([ACCOUNT_ID, UPDATE_BODY]);
    await call('PATCH', '/profile', token, { expectedRevision: 3, bio: null });
    expect(svc.updateProfile.mock.calls[1]).toEqual([ACCOUNT_ID, { expectedRevision: 3, bio: null }]);
    await call('POST', '/profile/visibility', token, VISIBILITY_BODY);
    expect(svc.setVisibility.mock.calls[0]).toEqual([ACCOUNT_ID, VISIBILITY_BODY]);
    await call('POST', '/profile/photo/uploads', token, UPLOAD_BODY);
    expect(photos.requestUpload.mock.calls[0]).toEqual([ACCOUNT_ID, UPLOAD_BODY]);
    await call('POST', '/profile/photo/finalize', token, FINALIZE_BODY);
    expect(photos.finalize.mock.calls[0]).toEqual([ACCOUNT_ID, FINALIZE_BODY]);
    await call('DELETE', '/profile/photo', token, REMOVE_BODY);
    expect(photos.remove.mock.calls[0]).toEqual([ACCOUNT_ID, REMOVE_BODY]);
    await call('POST', '/profile', token, {});
    await call('POST', '/profile', token);
    await rawBody('POST', '/profile', token, 'null');
    expect(svc.createProfile.mock.calls).toEqual([[ACCOUNT_ID], [ACCOUNT_ID], [ACCOUNT_ID]]);
    await call('GET', '/profile', token);
    expect(svc.getOwnerProfile.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('GET', '/profile/preview', token);
    expect(svc.getPreview.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('GET', '/profile/photo', token);
    expect(photos.ownerPhoto.mock.calls[0]).toEqual([ACCOUNT_ID, {}]);
  });
});

// ====================================================================== strict bodies
describe('the DTO mappers rebuild the projection field by field', () => {
  it('a hostile service result with extra properties keeps only the allow-listed keys, and the preview marker is true', () => {
    const hostile = { ...publicFixture(), accountId: ACCOUNT_ID, email: 'a@b.c' } as never;
    expect(Object.keys(publicProfileDto(hostile)).sort()).toEqual(Object.keys(publicFixture()).sort());
    const preview = previewProfileDto({ ...previewFixture(), accountId: ACCOUNT_ID } as never);
    expect(Object.keys(preview).sort()).toEqual(Object.keys(previewFixture()).sort());
    expect(preview.preview).toBe(true);
  });
});

describe('strict bodies', () => {
  const bad = (r: Route, mutate: (b: Record<string, unknown>) => unknown, label: string) =>
    it(`${r.operationId}: ${label} is a 400 and the service is not called`, async () => {
      const res = await call(r.method, r.url, await webToken(), mutate(structuredClone(r.body as Record<string, unknown>)));
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
      expect(fnOf(r)).not.toHaveBeenCalled();
    });
  const route = (fn: string) => ROUTES.find((r) => r.fn === fn)!;
  const update = route('updateProfile');
  const visibility = route('setVisibility');
  const upload = route('requestUpload');
  const finalize = route('finalize');
  const remove = route('remove');
  bad(update, (b) => ({ ...b, expectedRevision: '3' }), 'a string revision (no coercion)');
  bad(update, (b) => ({ ...b, expectedRevision: 0 }), 'revision 0');
  bad(update, (b) => ({ ...b, expectedRevision: 1.5 }), 'a fractional revision');
  bad(update, (b) => ({ ...b, expectedRevision: 2_147_483_648 }), 'a revision above the integer ceiling');
  bad(update, (b) => ({ expectedRevision: b.expectedRevision }), 'no field to change');
  bad(update, (b) => ({ ...b, displayName: 12 }), 'a numeric display name');
  bad(update, (b) => ({ ...b, bio: true }), 'a boolean bio');
  bad(update, (b) => ({ ...b, displayName: 'x'.repeat(401) }), 'a display name above four times the ceiling');
  bad(update, (b) => ({ ...b, bio: 'x'.repeat(20_001) }), 'a bio above four times the ceiling');
  bad(visibility, (b) => ({ ...b, visibility: 'SUSPENDED' }), 'a visibility the contract does not have');
  bad(visibility, (b) => ({ ...b, visibility: 'public' }), 'a lower-case visibility');
  bad(visibility, (b) => ({ expectedRevision: b.expectedRevision }), 'a missing visibility');
  bad(upload, (b) => ({ ...b, sizeBytes: 0 }), 'size 0');
  bad(upload, (b) => ({ ...b, sizeBytes: 12.5 }), 'a fractional size');
  bad(upload, (b) => ({ ...b, sizeBytes: '1234' }), 'a string size (no coercion)');
  bad(upload, (b) => ({ ...b, sizeBytes: 26_214_401 }), 'a size above the structural ceiling');
  bad(upload, (b) => ({ ...b, mimeType: '' }), 'an empty content type');
  bad(upload, (b) => ({ ...b, sha256: 'ABC' }), 'a malformed hash');
  bad(finalize, (b) => ({ ...b, sha256: 'A'.repeat(64) }), 'an upper-case hash');
  bad(finalize, () => ({}), 'a missing revision');
  bad(remove, (b) => ({ ...b, expectedRevision: -1 }), 'a negative revision');

  it('DELETE without a body is a 400 (the body carries the revision) and nothing changes', async () => {
    const res = await call('DELETE', '/profile/photo', await webToken());
    expect(res.statusCode, res.body).toBe(400);
    expect(photos.remove).not.toHaveBeenCalled();
  });

  it('numeric strings, scientific notation and nulls are never coerced into a revision', async () => {
    for (const text of ['{"expectedRevision":"3","bio":"x"}', '{"expectedRevision":null,"bio":"x"}', '{"expectedRevision":true,"bio":"x"}'])
      expect((await rawBody('PATCH', '/profile', await webToken(), text)).statusCode, text).toBe(400);
    expect(svc.updateProfile).not.toHaveBeenCalled();
  });

  it('a body above the limit is 413 and the service is not called', async () => {
    const big = JSON.stringify({ expectedRevision: 3, bio: 'x'.repeat(PROFILE_BODY_LIMIT) });
    expect((await rawBody('PATCH', '/profile', await webToken(), big)).statusCode).toBe(413);
    const small = JSON.stringify({ expectedRevision: 3, visibility: 'PUBLIC', pad: 'x'.repeat(PROFILE_SMALL_BODY_LIMIT) });
    expect((await rawBody('POST', '/profile/visibility', await webToken(), small)).statusCode).toBe(413);
    expect(noServiceCalled()).toBe(true);
  });

  it('provider text in a rejected body is never echoed', async () => {
    const res = await call('PATCH', '/profile', await webToken(), {
      expectedRevision: 'x',
      displayName: TEXT_SENTINEL,
      bio: TEXT_SENTINEL,
      extra: TEXT_SENTINEL,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(TEXT_SENTINEL);
  });

  it('a bio of exactly the accepted size is passed to the service (the configured limit is the service decision)', async () => {
    const bio = 'x'.repeat(20_000);
    const res = await call('PATCH', '/profile', await webToken(), { expectedRevision: 3, bio });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(svc.updateProfile.mock.calls[0]![1]).toEqual({ expectedRevision: 3, bio });
  });
});

// ====================================================================== cache policy
describe('Cache-Control on every response', () => {
  it.each(ROUTES.filter((r) => r.fn !== 'ownerPhoto'))(
    '$method $spec ($operationId): success, every service error and an unexpected failure are no-store',
    async (r) => {
      expectNoStore(await routeCall(r, await webToken()));
      for (const code of PROFILE_ERROR_CODES) {
        fnOf(r).mockRejectedValueOnce(new ProfileError(code, 'x'));
        expectNoStore(await routeCall(r, await webToken()));
      }
      fnOf(r).mockRejectedValueOnce(new Error('kaboom'));
      const boom = await routeCall(r, await webToken());
      expect(boom.statusCode).toBe(500);
      expectNoStore(boom);
    },
  );

  it('router-level failures under both prefixes are no-store: unknown paths and wrong methods', async () => {
    for (const [m, u] of [
      ['GET', '/api/v1/provider/profile/nope'],
      ['DELETE', '/api/v1/provider/profile'],
      ['PUT', '/api/v1/provider/profile'],
      ['GET', '/api/v1/provider/profile/visibility'],
      ['POST', '/api/v1/provider/profile/preview'],
      ['GET', '/api/v1/providers'],
      ['POST', `/api/v1/providers/${PROFILE_ID}`],
      ['DELETE', `/api/v1/providers/${PROFILE_ID}/photo`],
      ['GET', `/api/v1/providers/${PROFILE_ID}/nope`],
    ] as const) {
      const res = await send(m, u);
      expect(res.statusCode, `${m} ${u}`).toBe(404);
      expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== owner status codes and shapes
describe('owner status codes and response shapes', () => {
  it('POST /profile answers 201 when the profile was created and 200 on an idempotent replay', async () => {
    const created = await call('POST', '/profile', await webToken(), {});
    expect(created.statusCode, created.body).toBe(201);
    svc.createProfile.mockResolvedValueOnce({ created: false, state: ownerFixture() });
    const replay = await call('POST', '/profile', await webToken());
    expect(replay.statusCode, replay.body).toBe(200);
    expect(OwnerProfileStateResponse.safeParse(created.json()).success).toBe(true);
    expect(OwnerProfileStateResponse.safeParse(replay.json()).success).toBe(true);
  });

  it('every operation answers its documented success status', async () => {
    for (const r of ROUTES) expect((await routeCall(r, await webToken())).statusCode, r.operationId).toBe(r.okStatus);
  });

  it('the owner state, the preview and the upload authorization parse as their contracts and round-trip unchanged', async () => {
    const token = await webToken();
    const own = await call('GET', '/profile', token);
    expect(OwnerProfileStateResponse.parse(own.json()).data).toEqual(ownerFixture());
    expect(JSON.parse(own.body).data).toEqual(ownerFixture());
    const prev = await call('GET', '/profile/preview', token);
    expect(PreviewProviderProfileResponse.parse(prev.json()).data).toEqual(previewFixture());
    expect(JSON.parse(prev.body).data).toEqual(previewFixture());
    const up = await call('POST', '/profile/photo/uploads', token, UPLOAD_BODY);
    expect(JSON.parse(up.body).data).toEqual(uploadFixture());
  });

  it('a profile that does not exist yet is exists:false with the readiness facts and the limits', async () => {
    svc.getOwnerProfile.mockResolvedValueOnce(ownerFixture({ exists: false, profile: null, readiness: { ...ownerFixture().readiness, visibility: null } }));
    const res = await call('GET', '/profile', await webToken());
    expect(res.statusCode).toBe(200);
    const data = OwnerProfileStateResponse.parse(res.json()).data;
    expect(data.exists).toBe(false);
    expect(data.profile).toBeNull();
  });

  it('a hostile service result (extra properties, ids, contacts, asset references) never reaches the client', async () => {
    const hostile = ownerFixture();
    Object.assign(hostile, { accountId: ACCOUNT_ID, email: 'sentinel.mail@sentinel-contact.example' });
    Object.assign(hostile.profile, {
      accountId: ACCOUNT_ID,
      photoAssetId: PROFILE_ID,
      objectKey: 'provider/profile-media/secret',
      sha256: 'f'.repeat(64),
      phone: '+15550001234',
    });
    Object.assign(hostile.profile.photo, { assetId: PROFILE_ID, objectKey: 'provider/profile-media/secret', sha256: 'f'.repeat(64) });
    Object.assign(hostile.readiness, { accountId: ACCOUNT_ID, goLive: true });
    Object.assign(hostile.limits, { bucket: 'private-bucket' });
    svc.getOwnerProfile.mockResolvedValueOnce(hostile);
    const res = await call('GET', '/profile', await webToken());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual(ownerFixture());
    for (const secret of [ACCOUNT_ID, 'sentinel.mail', 'secret', 'private-bucket', '5550001234', 'f'.repeat(64), 'assetId'] as const)
      expect(res.body).not.toContain(secret);
    // the same for the upload authorization and the preview
    const up = uploadFixture();
    Object.assign(up, { assetId: PROFILE_ID, objectKey: 'provider/profile-media/secret', bucket: 'private-bucket' });
    photos.requestUpload.mockResolvedValueOnce(up);
    const upRes = await call('POST', '/profile/photo/uploads', await webToken(), UPLOAD_BODY);
    expect(JSON.parse(upRes.body).data).toEqual(uploadFixture());
    const prev = previewFixture();
    Object.assign(prev, { accountId: ACCOUNT_ID, email: 'sentinel.mail@sentinel-contact.example' });
    Object.assign(prev.gigs[0]!, { gigVersionId: PROFILE_ID, bananaDrop: { tier: 3 } });
    svc.getPreview.mockResolvedValueOnce(prev);
    const prevRes = await call('GET', '/profile/preview', await webToken());
    expect(JSON.parse(prevRes.body).data).toEqual(previewFixture());
  });
});

// ====================================================================== the owner photo
describe('the owner photo', () => {
  it('serves the sanitised bytes with the forced headers and a revalidation policy (private, no-cache) and an opaque ETag', async () => {
    const res = await call('GET', '/profile/photo', await webToken());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toBe(ETAG);
  });

  it('passes If-None-Match to the service and answers 304 without a body', async () => {
    photos.ownerPhoto.mockResolvedValueOnce({ kind: 'not-modified', etag: ETAG });
    const res = await call('GET', '/profile/photo', await webToken(), undefined, { 'if-none-match': ETAG });
    expect(photos.ownerPhoto.mock.calls[0]).toEqual([ACCOUNT_ID, { ifNoneMatch: ETAG }]);
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(ETAG);
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('an absent photo is a 404 PROFILE_MEDIA_NOT_FOUND, no-store, with no detail', async () => {
    photos.ownerPhoto.mockResolvedValueOnce(null);
    const res = await call('GET', '/profile/photo', await webToken());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toMatchObject({ code: 'PROFILE_MEDIA_NOT_FOUND', details: { messageKey: profileErrorKey('MEDIA_NOT_FOUND') } });
    expectNoStore(res);
  });

  it('a content type outside the allow-list is never sent (503, no bytes)', async () => {
    photos.ownerPhoto.mockResolvedValueOnce({ kind: 'bytes', bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml', etag: ETAG });
    const res = await call('GET', '/profile/photo', await webToken());
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('svg');
    expect(res.headers.etag).toBeUndefined();
  });
});

// ====================================================================== the PUBLIC routes
describe('the public profile', () => {
  const pub = (id = PROFILE_ID, headers: Record<string, string> = {}, token?: string) => send('GET', `/api/v1/providers/${id}`, token, undefined, headers);
  const photo = (id = PROFILE_ID, headers: Record<string, string> = {}, token?: string) =>
    send('GET', `/api/v1/providers/${id}/photo`, token, undefined, headers);

  it('answers without authentication, no-store, and the data is exactly the public contract', async () => {
    const res = await pub();
    expect(res.statusCode, res.body).toBe(200);
    expectNoStore(res);
    expect(PublicProviderProfileResponse.parse(res.json()).data).toEqual(publicFixture());
    expect(JSON.parse(res.body).data).toEqual(publicFixture());
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(['data', 'meta']);
    expect(svc.getPublicProfile.mock.calls).toEqual([[PROFILE_ID]]);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it('ignores the Authorization header entirely: none, garbage, an expired token, a valid token and the admin token all get the same answer, and no account is resolved', async () => {
    const baseline = JSON.parse((await pub()).body).data;
    for (const token of ['not.a.token', await signToken(keys, { expiresInSec: -3600 }), await webToken(), await adminToken(), await hmacToken()]) {
      const res = await pub(PROFILE_ID, {}, token);
      expect(res.statusCode, token.slice(0, 20)).toBe(200);
      expect(JSON.parse(res.body).data).toEqual(baseline);
      const ph = await photo(PROFILE_ID, {}, token);
      expect(ph.statusCode, token.slice(0, 20)).toBe(200);
    }
    const weird = await pub(PROFILE_ID, { authorization: 'Basic Zm9vOmJhcg==' });
    expect(weird.statusCode).toBe(200);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
    // and a token never changes WHICH profile is served
    for (const c of svc.getPublicProfile.mock.calls) expect(c).toEqual([PROFILE_ID]);
  });

  it('a hostile service result never reaches the client: only the public contract is serialised', async () => {
    const hostile = publicFixture();
    Object.assign(hostile, {
      accountId: ACCOUNT_ID,
      email: 'sentinel.mail@sentinel-contact.example',
      phone: '+15550001234',
      legalName: 'Sentinel-First-Name Sentinel-Last-Name',
      visibility: 'PUBLIC',
      verified: true,
    });
    Object.assign(hostile.photo, { assetId: PROFILE_ID, objectKey: 'provider/profile-media/secret', sha256: 'f'.repeat(64) });
    Object.assign(hostile.badges[0]!, { expiresAt: ISO, documentType: 'PASSPORT', requirementId: PROFILE_ID, count: 2 });
    Object.assign(hostile.market, { address: '1 Main St' });
    Object.assign(hostile.gigs[0]!, { gigVersionId: PROFILE_ID, accountId: ACCOUNT_ID, bananaDrop: { tier: 2 }, rating: 4.9 });
    Object.assign(hostile.ratings, { average: 4.9 });
    Object.assign(hostile.drops, { offers: [1] });
    svc.getPublicProfile.mockResolvedValueOnce(hostile);
    const res = await pub();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual(publicFixture());
    for (const secret of [
      ACCOUNT_ID,
      'sentinel.mail',
      '5550001234',
      'Sentinel-Last-Name',
      'secret',
      'PASSPORT',
      'f'.repeat(64),
      '1 Main St',
      'bananaDrop',
      '4.9',
    ])
      expect(res.body).not.toContain(secret);
  });

  it('unknown, private, ineligible and disabled profiles are ONE identical 404 (null from the service)', async () => {
    svc.getPublicProfile.mockResolvedValue(null);
    const a = await pub(PROFILE_ID);
    const b = await pub('11111111-2222-4333-8444-555555555555');
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(404);
      expectNoStore(r);
    }
    const strip = (r: Reply) => {
      const e = errorOf(r);
      return { ...e, correlationId: undefined };
    };
    expect(strip(a)).toEqual(strip(b));
    expect(errorOf(a)).toMatchObject({ category: 'NOT_FOUND', code: 'PROFILE_NOT_FOUND', details: { messageKey: profileErrorKey('PROFILE_NOT_FOUND') } });
    expect(Object.keys(errorOf(a).details ?? {})).toEqual(['messageKey']);
  });

  it('a service refusal that depends on the profile is the SAME 404 (never a 403/409, never a detail)', async () => {
    const baseline = await (async () => {
      svc.getPublicProfile.mockResolvedValueOnce(null);
      return errorOf(await pub());
    })();
    for (const err of [
      new ProfileError('PROFILE_NOT_FOUND', 'x', { reason: 'PRIVATE' }),
      new ProfileError('PROVIDER_NOT_ELIGIBLE', 'x', { reason: 'ROLE_INACTIVE' }),
      new ProfileError('ACCOUNT_NOT_ACTIVE', 'x'),
      new ProfileError('VALIDATION_FAILED', 'x'),
      new ProviderError('ACCOUNT_NOT_ACTIVE', 'x', { reason: 'ACCOUNT_NOT_FOUND' }),
    ]) {
      svc.getPublicProfile.mockRejectedValueOnce(err);
      const r = await pub();
      expect(r.statusCode, String((err as Error).message)).toBe(404);
      expect({ ...errorOf(r), correlationId: undefined }).toEqual({ ...baseline, correlationId: undefined });
    }
  });

  it('a dependency outage is a 503 with a message key only (it does not depend on the id)', async () => {
    svc.getPublicProfile.mockRejectedValueOnce(new ProfileError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID', cause: 'select * from secrets' }));
    const r = await pub();
    expect(r.statusCode).toBe(503);
    expect(errorOf(r)).toMatchObject({ category: 'DEPENDENCY', code: 'PROFILE_UNAVAILABLE', details: { messageKey: profileErrorKey('UNAVAILABLE') } });
    expect(r.body).not.toContain('secrets');
    expectNoStore(r);
    svc.getPublicProfile.mockRejectedValueOnce(new ProviderError('UNAVAILABLE', 'the account registry is unavailable'));
    expect((await pub()).statusCode).toBe(503);
  });

  it('an unexpected failure is a generic 500 that leaks nothing', async () => {
    svc.getPublicProfile.mockRejectedValueOnce(new Error('connection to db.internal:5432 refused'));
    const r = await pub();
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('db.internal');
  });

  it('a malformed id is the SAME 404 as an unknown one and never reaches a service (the router does not 400)', async () => {
    svc.getPublicProfile.mockResolvedValue(null);
    const unknown = errorOf(await pub('11111111-2222-4333-8444-555555555555'));
    svc.getPublicProfile.mockClear();
    const malformed = [
      'not-a-uuid',
      '123',
      PROFILE_ID.replace(/-/g, ''),
      `${PROFILE_ID}x`,
      `${PROFILE_ID}%20`,
      '..%2f..%2fprovider%2fprofile',
      '%00',
      `{${PROFILE_ID}}`,
      'x'.repeat(100),
      'x'.repeat(500),
      '%ZZ',
      '%',
      ACCOUNT_ID.toUpperCase() + '%0a',
    ];
    for (const id of malformed) {
      for (const suffix of ['', '/photo']) {
        const r = await send('GET', `/api/v1/providers/${id}${suffix}`);
        expect(r.statusCode, `${id}${suffix}`).toBe(404);
        expect({ ...errorOf(r), correlationId: undefined }, `${id}${suffix}`).toEqual({ ...unknown, correlationId: undefined });
        expect(r.headers['cache-control'], id).toBe('no-store');
      }
    }
    expect(svc.getPublicProfile).not.toHaveBeenCalled();
    expect(photos.publicPhoto).not.toHaveBeenCalled();
  });

  it('an upper-case id is accepted and the service receives it lower-cased', async () => {
    const r = await pub(PROFILE_ID.toUpperCase());
    expect(r.statusCode).toBe(200);
    expect(svc.getPublicProfile.mock.calls).toEqual([[PROFILE_ID]]);
  });

  it('a query string is a 400 on the public routes (no cache-busting or filter parameters exist)', async () => {
    for (const q of ['x=1', 'accountId=' + ACCOUNT_ID, 'preview=1']) {
      expect((await send('GET', `/api/v1/providers/${PROFILE_ID}?${q}`)).statusCode, q).toBe(400);
      expect((await send('GET', `/api/v1/providers/${PROFILE_ID}/photo?${q}`)).statusCode, q).toBe(400);
    }
    expect(noServiceCalled()).toBe(true);
  });

  describe('the public photo', () => {
    it('serves the sanitised bytes with the forced content type, nosniff, inline, cross-origin and a no-cache policy with an opaque ETag', async () => {
      const r = await photo();
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.equals(JPEG)).toBe(true);
      expect(r.headers['content-type']).toBe('image/jpeg');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBe(CSP);
      expect(r.headers['content-disposition']).toBe('inline');
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers.etag).toBe(ETAG);
      expect(photos.publicPhoto.mock.calls).toEqual([[PROFILE_ID, {}]]);
      expect(svc.getPublicProfile).not.toHaveBeenCalled();
    });

    it('forces the content type from the asset: every allowed type is served as itself, nothing else', async () => {
      for (const contentType of ['image/png', 'image/webp']) {
        photos.publicPhoto.mockResolvedValueOnce({ kind: 'bytes', bytes: JPEG, contentType, etag: ETAG });
        expect((await photo()).headers['content-type']).toBe(contentType);
      }
      for (const contentType of ['text/html', 'image/svg+xml', 'application/octet-stream', 'image/jpeg; charset=utf-8', 'IMAGE/PNG']) {
        photos.publicPhoto.mockResolvedValueOnce({ kind: 'bytes', bytes: Buffer.from('<script>alert(1)</script>'), contentType, etag: ETAG });
        const r = await photo();
        expect(r.statusCode, contentType).toBe(503);
        expect(r.body).not.toContain('script');
      }
    });

    it('passes If-None-Match to the service and answers 304 with the validator and the same protective headers, no body', async () => {
      photos.publicPhoto.mockResolvedValueOnce({ kind: 'not-modified', etag: ETAG });
      const r = await photo(PROFILE_ID, { 'if-none-match': ETAG });
      expect(photos.publicPhoto.mock.calls[0]).toEqual([PROFILE_ID, { ifNoneMatch: ETAG }]);
      expect(r.statusCode).toBe(304);
      expect(r.body).toBe('');
      expect(r.headers.etag).toBe(ETAG);
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBe(CSP);
    });

    it('does not pass an absurdly long validator on', async () => {
      await photo(PROFILE_ID, { 'if-none-match': 'W/"' + 'a'.repeat(2000) + '"' });
      expect(photos.publicPhoto.mock.calls[0]).toEqual([PROFILE_ID, {}]);
    });

    it('no photo, a private or unknown profile and any refusal are the same 404 as the JSON route', async () => {
      photos.publicPhoto.mockResolvedValueOnce(null);
      const none = await photo();
      svc.getPublicProfile.mockResolvedValueOnce(null);
      const json = await pub();
      expect(none.statusCode).toBe(404);
      expect({ ...errorOf(none), correlationId: undefined }).toEqual({ ...errorOf(json), correlationId: undefined });
      expectNoStore(none);
      expect(none.headers.etag).toBeUndefined();
      for (const err of [
        new ProfileError('MEDIA_NOT_FOUND', 'x'),
        new ProfileError('MEDIA_REFUSED', 'x', { reason: 'IMAGE_INVALID' }),
        new ProfileError('PROFILE_NOT_FOUND', 'x'),
      ]) {
        photos.publicPhoto.mockRejectedValueOnce(err);
        const r = await photo();
        expect(r.statusCode).toBe(404);
        expect({ ...errorOf(r), correlationId: undefined }).toEqual({ ...errorOf(json), correlationId: undefined });
      }
    });

    it('a scan or storage outage on the public photo is a 503 without detail', async () => {
      photos.publicPhoto.mockRejectedValueOnce(
        new ProfileError('UNAVAILABLE', 'store down', { reason: 'STORE_UNAVAILABLE', objectKey: 'provider/profile-media/secret' }),
      );
      const r = await photo();
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('secret');
    });
  });
});

// ====================================================================== error mapping
describe('typed profile failures become the standard error envelope', () => {
  const EXPECTED: Record<ProfileErrorCode, [number, string]> = {
    PROFILE_NOT_FOUND: [404, 'NOT_FOUND'],
    PROVIDER_NOT_ELIGIBLE: [403, 'AUTHORIZATION'],
    ACCOUNT_NOT_ACTIVE: [403, 'AUTHORIZATION'],
    STALE_PROFILE: [409, 'CONFLICT'],
    PROFILE_INCOMPLETE: [409, 'CONFLICT'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
    MEDIA_NOT_FOUND: [404, 'NOT_FOUND'],
    MEDIA_REFUSED: [400, 'VALIDATION'],
    MEDIA_EXPIRED: [409, 'CONFLICT'],
    MEDIA_SCAN_UNAVAILABLE: [503, 'DEPENDENCY'],
  };
  const err = (code: ProfileErrorCode, details: Record<string, unknown> = {}) => new ProfileError(code, `internal ${TEXT_SENTINEL}`, details);

  it('covers every contract error code', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PROFILE_ERROR_CODES].sort());
  });

  it.each(PROFILE_ERROR_CODES)('%s: status, category, wire code, message key, and the provider text of the internal message is never sent', async (code) => {
    svc.updateProfile.mockRejectedValueOnce(err(code, { reason: 'SOME_REASON', field: 'bio' }));
    const res = await call('PATCH', '/profile', await webToken(), UPDATE_BODY);
    const [status, category] = EXPECTED[code];
    expect(res.statusCode, res.body).toBe(status);
    const e = errorOf(res);
    expect(e.category).toBe(category);
    expect(e.code).toBe(profileWireCode(code));
    expect(e.details?.messageKey).toBe(profileErrorKey(code));
    expect(res.body).not.toContain(TEXT_SENTINEL);
    expectNoStore(res);
  });

  it('wire codes: PROFILE_NOT_FOUND, PROFILE_INCOMPLETE and STALE_PROFILE as they are, the others prefixed', () => {
    expect(PROFILE_ERROR_CODES.map(profileWireCode)).toEqual([
      'PROFILE_NOT_FOUND',
      'PROFILE_PROVIDER_NOT_ELIGIBLE',
      'PROFILE_ACCOUNT_NOT_ACTIVE',
      'STALE_PROFILE',
      'PROFILE_INCOMPLETE',
      'PROFILE_VALIDATION_FAILED',
      'PROFILE_CONFLICT',
      'PROFILE_UNAVAILABLE',
      'PROFILE_MEDIA_NOT_FOUND',
      'PROFILE_MEDIA_REFUSED',
      'PROFILE_MEDIA_EXPIRED',
      'PROFILE_MEDIA_SCAN_UNAVAILABLE',
    ]);
  });

  it('UNAVAILABLE, MEDIA_NOT_FOUND and PROFILE_NOT_FOUND carry only the message key; a scan outage adds retryable', () => {
    for (const code of ['UNAVAILABLE', 'MEDIA_NOT_FOUND', 'PROFILE_NOT_FOUND'] as const)
      try {
        toAppError(err(code, { reason: 'LEAK', field: 'bio', cause: 'sql' }));
      } catch (e) {
        expect((e as { details: unknown }).details).toEqual({ messageKey: profileErrorKey(code) });
      }
    try {
      toAppError(err('MEDIA_SCAN_UNAVAILABLE', { reason: 'LEAK' }));
    } catch (e) {
      expect((e as { details: unknown }).details).toEqual({ retryable: true, messageKey: profileErrorKey('MEDIA_SCAN_UNAVAILABLE') });
    }
  });

  it('PROFILE_INCOMPLETE and VALIDATION_FAILED list identifier-only issues (reason code and field name) and drop everything else', async () => {
    svc.setVisibility.mockRejectedValueOnce(
      err('PROFILE_INCOMPLETE', {
        issues: [
          { reason: 'BIO_REQUIRED', field: 'bio', value: TEXT_SENTINEL },
          { reason: 'PHOTO_REQUIRED', field: 'photo' },
          { reason: 'NOT_A_REASON', field: 'bio' },
          { reason: 'DISPLAY_NAME_TOO_LONG', field: 'password' },
          'junk',
          null,
        ],
        value: TEXT_SENTINEL,
      }),
    );
    const res = await call('POST', '/profile/visibility', await webToken(), VISIBILITY_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({
      issues: [{ reason: 'BIO_REQUIRED', field: 'bio' }, { reason: 'PHOTO_REQUIRED', field: 'photo' }, { reason: 'DISPLAY_NAME_TOO_LONG' }],
      messageKey: profileErrorKey('PROFILE_INCOMPLETE'),
    });
    expect(res.body).not.toContain(TEXT_SENTINEL);
  });

  it('every issue reason survives the allow-list', () => {
    const out = safeDetails({ issues: PROFILE_ISSUE_REASONS.map((reason) => ({ reason, field: 'bio' })) });
    expect((out.issues as unknown[]).length).toBe(PROFILE_ISSUE_REASONS.length);
  });

  it('the details allow-list keeps short tokens, small integer bounds and the retryable flag only', () => {
    expect(
      safeDetails({
        reason: 'DISPLAY_NAME_TOO_LONG',
        field: 'displayName',
        code: 'X-1',
        retryable: true,
        limit: 60,
        max: 1000,
        count: 3,
        sql: 'select 1',
        cause: new Error('x'),
        value: TEXT_SENTINEL,
        objectKey: 'provider/profile-media/x',
      }),
    ).toEqual({ reason: 'DISPLAY_NAME_TOO_LONG', field: 'displayName', code: 'X-1', retryable: true, limit: 60, max: 1000, count: 3 });
    expect(safeDetails({ reason: 'has spaces and is a sentence', field: 'x'.repeat(65), limit: -1, max: 1.5, count: 1_000_000, retryable: 'yes' })).toEqual({});
  });

  it('a refused photo names why from a closed list of reason codes and drops any other reason', async () => {
    photos.finalize.mockRejectedValueOnce(err('MEDIA_REFUSED', { reason: 'IMAGE_TOO_LARGE' }));
    expect(errorOf(await call('POST', '/profile/photo/finalize', await webToken(), FINALIZE_BODY)).details).toEqual({
      reason: 'IMAGE_TOO_LARGE',
      messageKey: profileErrorKey('MEDIA_REFUSED'),
    });
    photos.finalize.mockRejectedValueOnce(err('MEDIA_REFUSED', { reason: 'SOME_FREE_TEXT_REASON' }));
    expect(errorOf(await call('POST', '/profile/photo/finalize', await webToken(), FINALIZE_BODY)).details).toEqual({
      messageKey: profileErrorKey('MEDIA_REFUSED'),
    });
  });

  it('a stale revision is a 409 STALE_PROFILE with no detail but the message key', async () => {
    svc.updateProfile.mockRejectedValueOnce(err('STALE_PROFILE', { reason: 'STALE', expectedRevision: 3, actualRevision: 9 }));
    const res = await call('PATCH', '/profile', await webToken(), UPDATE_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'STALE_PROFILE', category: 'CONFLICT' });
    expect(res.body).not.toContain('actualRevision');
  });

  it('the account port errors (ProviderError) are translated: never a 500', async () => {
    svc.getOwnerProfile.mockRejectedValueOnce(new ProviderError('ACCOUNT_NOT_ACTIVE', 'x'));
    expect((await call('GET', '/profile', await webToken())).statusCode).toBe(403);
    svc.getOwnerProfile.mockRejectedValueOnce(new ProviderError('CONFLICT', 'x'));
    const conflict = await call('GET', '/profile', await webToken());
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict).details).toMatchObject({ retryable: true });
    svc.getOwnerProfile.mockRejectedValueOnce(new ProviderError('UNAVAILABLE', 'x'));
    expect((await call('GET', '/profile', await webToken())).statusCode).toBe(503);
  });

  it('an unexpected (non-profile) failure stays a generic 500 and leaks nothing', async () => {
    svc.getOwnerProfile.mockRejectedValueOnce(new Error(`kaboom ${TEXT_SENTINEL}`));
    const res = await call('GET', '/profile', await webToken());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(TEXT_SENTINEL);
    expect(() => toAppError(new Error('x'))).toThrow('x');
  });
});

// ====================================================================== composition-root ports
describe('the policy provider reads the configuration registry with no code default', () => {
  const k = PROVIDER_PROFILE_POLICY_KEYS;
  const VALUES: Record<string, unknown> = {
    [k.displayNameMaxLength]: 60,
    [k.bioMaxLength]: 1000,
    [k.bioRequired]: false,
    [k.photoRequired]: true,
    [k.photoMaxFileSizeBytes]: 2_097_152,
    [k.publicBadgeTypes]: ['IDENTITY', 'INSURANCE'],
    [k.publicRequiresMarketplaceEligibility]: false,
  };
  const resolver = (values: Record<string, unknown>) =>
    vi.fn(async (keys: string[]) => ({ values: new Map(keys.filter((x) => x in values).map((x) => [x, { value: values[x] }])) }));
  const provider = (fn: ReturnType<typeof resolver>) => createProfilePolicyProvider({ resolveMany: fn } as never);

  it('returns the typed policy and asks for exactly the seven keys', async () => {
    const fn = resolver(VALUES);
    expect(await provider(fn).policy()).toEqual({
      displayNameMaxLength: 60,
      bioMaxLength: 1000,
      bioRequired: false,
      photoRequired: true,
      photoMaxFileSizeBytes: 2_097_152,
      publicBadgeTypes: ['IDENTITY', 'INSURANCE'],
      publicRequiresMarketplaceEligibility: false,
    });
    expect([...fn.mock.calls[0]![0]].sort()).toEqual(Object.values(k).sort());
    expect(Object.values(k)).toHaveLength(7);
  });

  it.each(Object.values(k))('a missing %s fails closed with UNAVAILABLE (POLICY_INVALID)', async (key) => {
    const { [key]: _gone, ...rest } = VALUES;
    await expect(provider(resolver(rest)).policy()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
  });

  it('malformed or out-of-range values fail closed', async () => {
    for (const bad of [
      { [k.displayNameMaxLength]: 0 },
      { [k.displayNameMaxLength]: 101 },
      { [k.displayNameMaxLength]: '60' },
      { [k.bioMaxLength]: 5001 },
      { [k.bioRequired]: 'false' },
      { [k.photoMaxFileSizeBytes]: 26_214_401 },
      { [k.photoMaxFileSizeBytes]: 1.5 },
      { [k.publicBadgeTypes]: ['IDENTITY', 'IDENTITY'] },
      { [k.publicBadgeTypes]: ['VERIFIED'] },
      { [k.publicBadgeTypes]: 'IDENTITY' },
      { [k.publicRequiresMarketplaceEligibility]: 1 },
    ])
      await expect(provider(resolver({ ...VALUES, ...bad })).policy(), JSON.stringify(bad)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('an unreadable registry fails closed with UNAVAILABLE (POLICY_UNREADABLE) and never leaks the cause', async () => {
    const fn = vi.fn(async () => {
      throw new Error('valkey down at 10.0.0.9');
    });
    const err = await provider(fn as never)
      .policy()
      .catch((e: ProfileError) => e);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
    expect(JSON.stringify(err)).not.toContain('10.0.0.9');
  });
});

describe('the account name port', () => {
  it('returns the first and last name from the identity service and nothing else', async () => {
    const getAccountContext = vi.fn(async () => ({
      profile: { firstName: 'Jane', lastName: 'Doe', preferredLocale: 'en-US', timeZone: 'UTC' },
      email: 'x@y.example',
    }));
    const names = await createAccountNamePort({ getAccountContext } as never).names(ACCOUNT_ID);
    expect(names).toEqual({ firstName: 'Jane', lastName: 'Doe' });
    expect(getAccountContext).toHaveBeenCalledWith(ACCOUNT_ID, { allowUnusable: true, includeProfile: true });
  });
  it('no profile row is null; an unknown account is null; any other failure is UNAVAILABLE', async () => {
    expect(await createAccountNamePort({ getAccountContext: async () => ({ profile: null }) } as never).names(ACCOUNT_ID)).toBeNull();
    expect(
      await createAccountNamePort({ getAccountContext: async () => Promise.reject(new AccountError('NOT_FOUND', 'x')) } as never).names(ACCOUNT_ID),
    ).toBeNull();
    await expect(createAccountNamePort({ getAccountContext: async () => Promise.reject(new Error('db')) } as never).names(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});

describe('the trust summary port', () => {
  it('asks the verification domain for the allowed types and returns type codes once each, narrowed to the allowed set', async () => {
    const publicBadgeTypes = vi.fn(async () => ['IDENTITY', 'IDENTITY', 'LICENSE', 'INSURANCE'] as never);
    const port = createTrustSummaryPort({ publicBadgeTypes });
    expect(await port.publicBadgeTypes(ACCOUNT_ID, ['IDENTITY', 'INSURANCE'])).toEqual(['IDENTITY', 'INSURANCE']);
    expect(publicBadgeTypes.mock.calls[0]!.slice(0, 2)).toEqual([ACCOUNT_ID, ['IDENTITY', 'INSURANCE']]);
  });
  it('an outage of the verification domain is UNAVAILABLE and never leaks the cause', async () => {
    const port = createTrustSummaryPort({ publicBadgeTypes: async () => Promise.reject(new Error('trust db secret')) });
    const err = await port.publicBadgeTypes(ACCOUNT_ID, ['IDENTITY']).catch((e: ProfileError) => e);
    expect(err).toMatchObject({ code: 'UNAVAILABLE' });
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain('secret');
  });
});

describe('the Gig service name port', () => {
  const V1 = '11111111-1111-4111-8111-111111111111';
  const V2 = '22222222-2222-4222-8222-222222222222';
  it('answers a batch in ONE statement, deduplicated, and only for well-formed ids', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [
      { gig_template_version_id: V1, service_type_code: 'regular_cleaning', name_content_key: 'catalog.service_type.regular_cleaning.name' },
      { gig_template_version_id: V2, service_type_code: 'pest_control', name_content_key: 'catalog.service_type.pest_control.name' },
    ]);
    const port = createGigServiceNamePort({ query } as never);
    const m = await port.forTemplateVersions([V1, V2, V1, 'not-a-uuid', "'; drop table x; --"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([[V1, V2]]);
    expect(m.get(V1)).toEqual({ serviceTypeCode: 'regular_cleaning', nameContentKey: 'catalog.service_type.regular_cleaning.name' });
    expect(m.get(V2)).toEqual({ serviceTypeCode: 'pest_control', nameContentKey: 'catalog.service_type.pest_control.name' });
    const sql = query.mock.calls[0]![0];
    expect(sql).not.toMatch(/\$\d.*\$\d/s); // one parameter: the ids are never concatenated into the statement
  });
  it('an empty batch runs no statement; a database failure is UNAVAILABLE without the cause', async () => {
    const query = vi.fn(async () => []);
    expect((await createGigServiceNamePort({ query } as never).forTemplateVersions([])).size).toBe(0);
    expect((await createGigServiceNamePort({ query } as never).forTemplateVersions(['x'])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    const failing = createGigServiceNamePort({ query: async () => Promise.reject(new Error('relation catalog.x does not exist')) } as never);
    const err = await failing.forTemplateVersions([V1]).catch((e: ProfileError) => e);
    expect(err).toMatchObject({ code: 'UNAVAILABLE' });
    expect(String((err as Error).message)).not.toContain('relation');
  });
});

describe('the onboarding PROFILE step is answered by the profile domain', () => {
  const facts = (over: Record<string, unknown>) => ({ profileComplete: false, visibility: null, ...over });
  const stepOf = (f: () => Promise<unknown>) => createProfilePrerequisites({ getReadinessFacts: f } as never);

  it('a failure of the profile domain reports NOT_AVAILABLE and never breaks the registration read; the other steps stay as they were', async () => {
    const p = stepOf(async () => Promise.reject(new Error('down')));
    expect(await p.profile(ACCOUNT_ID)).toEqual({ status: 'NOT_AVAILABLE' });
    for (const step of ['verification', 'subscription', 'gigs'] as const) expect(await p[step](ACCOUNT_ID), step).toEqual({ status: 'NOT_AVAILABLE' });
    const withRest = createProfilePrerequisites({ getReadinessFacts: async () => facts({}) } as never, {
      verification: async () => ({ status: 'COMPLETE' }),
      subscription: async () => ({ status: 'NOT_AVAILABLE' }),
      profile: async () => ({ status: 'NOT_AVAILABLE' }),
      gigs: async () => ({ status: 'COMPLETE' }),
    });
    expect(await withRest.verification(ACCOUNT_ID)).toEqual({ status: 'COMPLETE' });
    expect(await withRest.gigs(ACCOUNT_ID)).toEqual({ status: 'COMPLETE' });
  });
});

// ====================================================================== OpenAPI and the committed specs
describe('OpenAPI and the committed specs', () => {
  const swagger = () =>
    app.swagger() as unknown as {
      tags?: { name: string }[];
      paths: Record<
        string,
        Record<
          string,
          { operationId: string; tags: string[]; security?: unknown[]; responses: Record<string, unknown>; parameters?: { name: string; in: string }[] }
        >
      >;
    };
  const PUBLIC_OPS = [
    { operationId: 'getPublicProviderProfile', path: '/api/v1/providers/{publicProfileId}' },
    { operationId: 'getPublicProviderProfilePhoto', path: '/api/v1/providers/{publicProfileId}/photo' },
  ];

  it('documents exactly the 9 owner operations with the right method, path, tag and bearer security', () => {
    const doc = swagger();
    const found: { operationId: string; method: string; path: string; tags: string[]; security: unknown }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith('/api/v1/provider/profile'))
        for (const [method, op] of Object.entries(item))
          found.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, tags: op.tags, security: op.security });
    expect(found).toHaveLength(ROUTES.length);
    expect(found.map((f) => f.operationId).sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
    for (const r of ROUTES) {
      const f = found.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.tags, r.operationId).toEqual(['provider-profile']);
      expect(f.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    expect((doc.tags ?? []).map((t) => t.name)).toEqual(expect.arrayContaining(['provider-profile', 'providers']));
  });

  it('documents the two public operations under the `providers` tag with `security: []` (no authentication) and an id path parameter only', () => {
    const doc = swagger();
    for (const o of PUBLIC_OPS) {
      const op = doc.paths[o.path]!.get!;
      expect(op.operationId).toBe(o.operationId);
      expect(op.tags).toEqual(['providers']);
      expect(op.security).toEqual([]);
      expect((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name)).toEqual(['publicProfileId']);
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '404']));
    }
    expect(Object.keys(doc.paths['/api/v1/providers/{publicProfileId}/photo']!.get!.responses)).toEqual(expect.arrayContaining(['304']));
    // the public surface is these two paths and nothing else under /providers
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1/providers'))).toEqual(PUBLIC_OPS.map((o) => o.path));
  });

  it('documents the failure responses of the owner operations and no account id, profile id or asset parameter anywhere on the owner side', () => {
    const doc = swagger();
    for (const r of ROUTES) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      expect(Object.keys(op.responses), r.operationId).toEqual(expect.arrayContaining([String(r.okStatus), '400', '401', '403', '404', '409', '503']));
      expect(
        (op.parameters ?? []).filter((p) => p.in === 'path'),
        r.operationId,
      ).toEqual([]);
      for (const prm of op.parameters ?? []) expect(['accountId', 'owner', 'publicProfileId', 'status', 'assetId']).not.toContain(prm.name);
    }
    expect(Object.keys(doc.paths['/api/v1/provider/profile']!.post!.responses)).toEqual(expect.arrayContaining(['200', '201']));
  });

  it('is not registered without the services (the owner routes also need the account service; the public routes do not)', async () => {
    const withoutProfiles = await makeApp({ providerProfiles: undefined });
    const withoutPhotos = await makeApp({ profilePhotos: undefined });
    const withoutAccounts = await makeApp({ accounts: undefined });
    for (const target of [withoutProfiles, withoutPhotos])
      for (const r of ROUTES) expect((await routeCall(r, await webToken(), {}, target)).statusCode, r.operationId).toBe(404);
    for (const r of ROUTES) expect((await routeCall(r, await webToken(), {}, withoutAccounts)).statusCode, r.operationId).toBe(404);
    for (const target of [withoutProfiles, withoutPhotos])
      expect((await send('GET', `/api/v1/providers/${PROFILE_ID}`, undefined, undefined, {}, target)).statusCode).toBe(404);
    // the public routes work without the account service
    expect((await send('GET', `/api/v1/providers/${PROFILE_ID}`, undefined, undefined, {}, withoutAccounts)).statusCode).toBe(200);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it('the committed OpenAPI document contains every profile operation and the committed AsyncAPI the two profile events', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    for (const r of ROUTES) expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
    for (const o of PUBLIC_OPS) expect(openapi, o.operationId).toContain(`operationId: ${o.operationId}`);
    const asyncapi = readFileSync(path.join(root, 'docs/events/asyncapi.yaml'), 'utf8');
    for (const type of Object.values(PROFILE_EVENTS)) expect(asyncapi, type).toContain(type);
  });

  it('the profile event payloads carry identifiers and field NAMES only: no name, bio, photo reference or text property', () => {
    for (const payload of [ProfileUpdatedPayload, ProfileVisibilityChangedPayload])
      for (const key of Object.keys(payload.shape)) expect(key, key).toMatch(/^(accountId|publicProfileId|revision|changedFields|visibility)$/);
  });
});
