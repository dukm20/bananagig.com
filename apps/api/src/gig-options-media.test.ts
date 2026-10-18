// Unit tests of the CAT-004 operations of the provider Gig API (variants, add-ons and photos of the DRAFT) with a FAKE ProviderGigService and a FAKE AccountService. The real rules are
// covered by packages/provider and gig-options-media.itest.ts; here: authentication and the identity context on the nine new operations (401 before 400, 403 for the admin context),
// that the service only ever receives the account of the VERIFIED TOKEN and the PARSED body (LRN-0058: Ajv coerces, the handler never reads the coerced copy), strict bodies and path
// parameters, the cache policy, status codes (201 for an upload authorization), exact response key sets with no asset id, object key, hash or URL in any default payload, the error
// mapping of the four new codes with their allow-listed details, the policy and scanner wiring, the OpenAPI document and the committed specs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ErrorResponse,
  GIG_ERROR_CODES,
  GIG_ISSUE_REASONS,
  GigDetailResponse,
  GigMediaPreviewResponse,
  GigMediaUploadResponse,
  GigVersionPublishedPayload,
  PROVIDER_GIG_MEDIA_POLICY_KEYS,
  PROVIDER_GIG_OPTIONS_POLICY_KEYS,
  PROVIDER_GIG_POLICY_KEYS,
  gigErrorKey,
  gigIssueKey,
  gigStatusKey,
  gigVersionStatusKey,
  type GigDetailDto,
  type GigErrorCode,
  type GigMediaDto,
  type GigMediaUploadDto,
  type GigVersionDto,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService } from '@bananagig/accounts';
import { GigError, type ProviderGigService } from '@bananagig/provider';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { MEDIA_REFUSAL_REASONS, gigApiErrorCode, safeDetails } from './modules/provider/gig-dto';
import { GIG_BODY_LIMIT, GIG_MEDIA_BODY_LIMIT } from './modules/provider/gig-routes';
import { createGigMediaScanner, createGigPolicyProvider } from './modules/provider/gig-wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- fakes
const svc = {
  replaceVariants: vi.fn(),
  replaceAddOns: vi.fn(),
  requestMediaUpload: vi.fn(),
  finalizeMedia: vi.fn(),
  updateMedia: vi.fn(),
  reorderMedia: vi.fn(),
  detachMedia: vi.fn(),
  previewMedia: vi.fn(),
};
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn() };
const noServiceCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const GIG_ID = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const VERSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const MEDIA_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const MEDIA_ID_2 = '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f70';
const TEMPLATE_VERSION_ID = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const ISO = '2026-10-16T12:00:00.000Z';
const NAME_SENTINEL = 'Sentinel option name: deep clean';
const ALT_SENTINEL = 'Sentinel alt text: a sunny kitchen';
/** The things that must NEVER be in a default payload or any error: the asset id, the object key, the hash, a URL. */
const ASSET_ID = 'a55e7000-0000-4000-8000-0000000000aa';
const OBJECT_KEY = 'provider/gig-media/a55e7000-0000-4000-8000-0000000000aa';
const SHA = 'ab'.repeat(32);
const SIGNED_URL = 'https://s3.example.invalid/bucket/provider/gig-media/x.upload?X-Amz-Signature=deadbeef';
const SECRETS = [ASSET_ID, OBJECT_KEY, SHA, 'X-Amz-Signature', 'objectKey', 'assetId', 'sha256'];
const CHILDREN = { variantCount: 1, addOnCount: 1, mediaCount: 1, variantsValid: true, addOnsValid: true, mediaRequirementSatisfied: true };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    created: false,
  }) as unknown as AccountContext;

const mediaFixture = (over: Partial<GigMediaDto> = {}): GigMediaDto => ({
  mediaId: MEDIA_ID,
  fieldKey: 'photos',
  displayOrder: 1,
  status: 'READY',
  mimeType: 'image/png',
  sizeBytes: 1234,
  width: 800,
  height: 600,
  altText: ALT_SENTINEL,
  ...over,
});
const optionFixture = (over: Record<string, unknown> = {}) => ({
  key: 'opt_0123456789ab',
  name: NAME_SENTINEL,
  description: null,
  priceDeltaMinor: 500,
  durationDeltaMinutes: 30,
  displayOrder: 1,
  ...over,
});
const optionsConstraints = { permitted: true, maxCount: 10, nameMaxLength: 80, descriptionMaxLength: 500 };
const versionFixture = (): GigVersionDto => ({
  gigVersionId: VERSION_ID,
  versionNumber: 1,
  status: 'DRAFT',
  statusKey: gigVersionStatusKey('DRAFT'),
  revision: 4,
  gigTemplateVersionNumber: 2,
  title: 'A title',
  createdAt: ISO,
  updatedAt: ISO,
  publishedAt: null,
  supersededAt: null,
  retiredAt: null,
  shortPitch: 'A pitch',
  description: 'A description',
  price: { amountMinor: 4500, currency: 'USD' },
  durationMinutes: 90,
  fieldValues: [],
  template: {
    gigTemplateCode: 'regular_cleaning_basic',
    gigTemplateVersionId: TEMPLATE_VERSION_ID,
    gigTemplateVersionNumber: 2,
    versionStatus: 'ACTIVE',
    templateStatus: 'ACTIVE',
    serviceTypeCode: 'regular_cleaning',
    categoryCode: 'home_cleaning',
    nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
    descriptionContentKey: null,
    instructionsContentKey: null,
    requirements: [],
  },
  fields: [
    {
      fieldKey: 'photos',
      fieldType: 'MEDIA',
      section: 'DETAILS',
      behavior: 'PROVIDER_REQUIRED',
      displayOrder: 1,
      customerVisible: true,
      supported: true,
      required: true,
      fixed: false,
      labelContentKey: 'catalog.field.photos.label',
      helpContentKey: null,
      defaultContentKey: null,
      defaultNumber: null,
      defaultBoolean: null,
      defaultOption: null,
      minLength: null,
      maxLength: null,
      minNumber: null,
      maxNumber: null,
      minItems: 1,
      maxItems: 3,
      options: [],
    },
  ],
  constraints: {
    title: { maxLength: 100 },
    shortPitch: { maxLength: 1000 },
    description: { maxLength: 5000 },
    price: { permitted: true, required: true, currency: 'USD' },
    duration: { permitted: true, required: true, minMinutes: 30, maxMinutes: 480, suggestedMinutes: 90 },
    variants: optionsConstraints,
    addOns: optionsConstraints,
    media: {
      permitted: true,
      maxItems: 50,
      maxFileSizeBytes: 10_485_760,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      minEdgePixels: 200,
      maxEdgePixels: 12_000,
      altTextMaxLength: 200,
    },
  },
  variants: [optionFixture()],
  addOns: [optionFixture({ key: 'opt_ba9876543210', name: 'Sentinel add-on', displayOrder: 1 })],
  media: [mediaFixture()],
  children: CHILDREN,
  publishable: true,
  issues: [],
});
const detailFixture = (): GigDetailDto => {
  const draft = versionFixture();
  const {
    shortPitch,
    description,
    price,
    durationMinutes,
    fieldValues,
    template,
    fields,
    constraints,
    variants,
    addOns,
    media,
    children,
    publishable,
    issues,
    ...summary
  } = draft;
  void [shortPitch, description, price, durationMinutes, fieldValues, template, fields, constraints, variants, addOns, media, children, publishable, issues];
  return {
    gig: {
      gigId: GIG_ID,
      status: 'DRAFT',
      statusKey: gigStatusKey('DRAFT'),
      gigTemplateCode: 'regular_cleaning_basic',
      serviceTypeCode: 'regular_cleaning',
      categoryCode: 'home_cleaning',
      nameContentKey: 'catalog.gig_template.regular_cleaning_basic.name',
      createdAt: ISO,
      updatedAt: ISO,
      retiredAt: null,
    },
    currentVersion: null,
    draftVersion: draft,
    versions: [summary],
  };
};
const uploadFixture = (): GigMediaUploadDto => ({
  media: mediaFixture({ status: 'UPLOADING', sizeBytes: 1234, width: null, height: null }),
  upload: { url: SIGNED_URL, headers: { 'content-type': 'image/png', 'content-length': '1234' }, expiresAt: ISO },
  maxSizeBytes: 10_485_760,
  revision: 5,
});

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
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const call = (method: Method, url: string, token?: string, payload?: unknown, target: FastifyInstance = app): Promise<Reply> =>
  target.inject({
    method,
    url: `/api/v1/provider${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const rawBody = (method: Method, url: string, token: string | undefined, text: string, contentType = 'application/json'): Promise<Reply> =>
  app.inject({
    method,
    url: `/api/v1/provider${url}`,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: text,
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');
const keysOf = (o: object) => Object.keys(o).sort();
const dataOf = (r: Reply) => (r.json() as { data: Record<string, unknown> }).data;

// ---------------------------------------------------------------- the nine operations
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  /** Present for the routes that read a body. */
  body?: unknown;
  okStatus: number;
  fn: keyof typeof svc;
}
const VARIANTS_BODY = {
  expectedRevision: 4,
  variants: [
    { key: 'opt_0123456789ab', name: 'Deep clean', description: 'All rooms', priceDeltaMinor: 2500, durationDeltaMinutes: 60 },
    { name: 'Windows', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 },
  ],
};
const ADD_ONS_BODY = { expectedRevision: 4, addOns: [{ name: 'Oven', description: null, priceDeltaMinor: 1500, durationDeltaMinutes: 20 }] };
const UPLOAD_BODY = { expectedRevision: 4, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 1234, sha256: SHA, altText: 'A kitchen' };
const FINALIZE_BODY = { expectedRevision: 5, sha256: SHA };
const ALT_BODY = { expectedRevision: 5, altText: 'A new alt text' };
const DETACH_BODY = { expectedRevision: 5 };
const ORDER_BODY = { expectedRevision: 5, mediaIds: [MEDIA_ID_2, MEDIA_ID] };
const ROUTES: Route[] = [
  {
    operationId: 'replaceProviderGigDraftVariants',
    method: 'PUT',
    url: `/gigs/${GIG_ID}/draft/variants`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/variants',
    body: VARIANTS_BODY,
    okStatus: 200,
    fn: 'replaceVariants',
  },
  {
    operationId: 'replaceProviderGigDraftAddOns',
    method: 'PUT',
    url: `/gigs/${GIG_ID}/draft/add-ons`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/add-ons',
    body: ADD_ONS_BODY,
    okStatus: 200,
    fn: 'replaceAddOns',
  },
  {
    operationId: 'requestProviderGigMediaUpload',
    method: 'POST',
    url: `/gigs/${GIG_ID}/draft/media/uploads`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/uploads',
    body: UPLOAD_BODY,
    okStatus: 201,
    fn: 'requestMediaUpload',
  },
  {
    operationId: 'finalizeProviderGigMedia',
    method: 'POST',
    url: `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/{mediaId}/finalize',
    body: FINALIZE_BODY,
    okStatus: 200,
    fn: 'finalizeMedia',
  },
  {
    operationId: 'updateProviderGigDraftMedia',
    method: 'PUT',
    url: `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/{mediaId}',
    body: ALT_BODY,
    okStatus: 200,
    fn: 'updateMedia',
  },
  {
    operationId: 'detachProviderGigDraftMedia',
    method: 'DELETE',
    url: `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/{mediaId}',
    body: DETACH_BODY,
    okStatus: 200,
    fn: 'detachMedia',
  },
  {
    operationId: 'reorderProviderGigDraftMedia',
    method: 'PUT',
    url: `/gigs/${GIG_ID}/draft/media/order`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/order',
    body: ORDER_BODY,
    okStatus: 200,
    fn: 'reorderMedia',
  },
  {
    operationId: 'getProviderGigDraftMediaPreview',
    method: 'GET',
    url: `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`,
    spec: '/api/v1/provider/gigs/{gigId}/draft/media/{mediaId}/preview',
    okStatus: 200,
    fn: 'previewMedia',
  },
  {
    operationId: 'getProviderGigVersionMediaPreview',
    method: 'GET',
    url: `/gigs/${GIG_ID}/versions/2/media/${MEDIA_ID}/preview`,
    spec: '/api/v1/provider/gigs/{gigId}/versions/{version}/media/{mediaId}/preview',
    okStatus: 200,
    fn: 'previewMedia',
  },
];
const BODY_ROUTES = ROUTES.filter((r) => r.body !== undefined);
const routeCall = (r: Route, token?: string, target?: FastifyInstance) => call(r.method, r.url, token, r.body, target);

// ---------------------------------------------------------------- the apps
const baseDeps = (): AppDeps => ({
  cfg,
  verifier,
  configuration: {} as never,
  accounts: accountSvc as unknown as AccountService,
  providerGigs: svc as unknown as ProviderGigService,
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
  for (const f of [...Object.values(svc), ...Object.values(accountSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async () => makeContext(ACCOUNT_ID));
  svc.replaceVariants.mockImplementation(async () => detailFixture());
  svc.replaceAddOns.mockImplementation(async () => detailFixture());
  svc.requestMediaUpload.mockImplementation(async () => ({ upload: uploadFixture(), detail: detailFixture() }));
  svc.finalizeMedia.mockImplementation(async () => detailFixture());
  svc.updateMedia.mockImplementation(async () => detailFixture());
  svc.reorderMedia.mockImplementation(async () => detailFixture());
  svc.detachMedia.mockImplementation(async () => detailFixture());
  svc.previewMedia.mockImplementation(async () => ({ url: SIGNED_URL, expiresAt: ISO }));
});

// ====================================================================== authentication and the identity context
describe('CAT-004 operations: authentication and the account guard', () => {
  it.each(ROUTES)('$operationId: 401 without a token and with a malformed one', async (r) => {
    for (const token of [undefined, 'not-a-jwt']) {
      const res = await routeCall(r, token);
      expect(res.statusCode, r.operationId).toBe(401);
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$operationId: 403 for the admin context', async (r) => {
    const res = await routeCall(r, await adminToken());
    expect(res.statusCode, r.operationId).toBe(403);
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 before 400: an invalid body or parameter without a token never reaches validation', async () => {
    for (const r of BODY_ROUTES) {
      const res = await call(r.method, r.url, undefined, { garbage: true });
      expect(res.statusCode, r.operationId).toBe(401);
    }
    expect((await call('GET', `/gigs/not-a-uuid/draft/media/${MEDIA_ID}/preview`)).statusCode).toBe(401);
    expect((await call('GET', `/gigs/${GIG_ID}/versions/01/media/${MEDIA_ID}/preview`)).statusCode).toBe(401);
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)('$operationId: a suspended or closed account is 403 and the service is never called', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('a role problem of the identity layer is mapped, never a 500', async () => {
    accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError('ROLE_NOT_HELD', 'no', { role: 'PROVIDER' }));
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), VARIANTS_BODY);
    expect(res.statusCode).toBeLessThan(500);
  });
});

// ====================================================================== the service sees the verified account and the PARSED body only
describe('the service is called with the account of the verified token and the parsed contract', () => {
  it.each(ROUTES)('$operationId: calls the service once with the token account, the path ids and the body', async (r) => {
    const res = await routeCall(r, await webToken());
    expect(res.statusCode, res.body).toBe(r.okStatus);
    const fn = svc[r.fn]!;
    expect(fn).toHaveBeenCalledTimes(1);
    const args = fn.mock.calls[0]!;
    expect(args[0]).toBe(ACCOUNT_ID);
    expect(args[1]).toBe(GIG_ID);
    expect(noServiceCalled()).toBe(false);
  });

  it('passes the parsed bodies unchanged', async () => {
    const token = await webToken();
    await call('PUT', `/gigs/${GIG_ID}/draft/variants`, token, VARIANTS_BODY);
    expect(svc.replaceVariants).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, VARIANTS_BODY);
    await call('PUT', `/gigs/${GIG_ID}/draft/add-ons`, token, ADD_ONS_BODY);
    expect(svc.replaceAddOns).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, ADD_ONS_BODY);
    await call('POST', `/gigs/${GIG_ID}/draft/media/uploads`, token, UPLOAD_BODY);
    expect(svc.requestMediaUpload).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, UPLOAD_BODY);
    await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, token, FINALIZE_BODY);
    expect(svc.finalizeMedia).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, MEDIA_ID, FINALIZE_BODY);
    await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, ALT_BODY);
    expect(svc.updateMedia).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, MEDIA_ID, ALT_BODY);
    await call('DELETE', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, DETACH_BODY);
    expect(svc.detachMedia).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, MEDIA_ID, DETACH_BODY);
    await call('PUT', `/gigs/${GIG_ID}/draft/media/order`, token, ORDER_BODY);
    expect(svc.reorderMedia).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, ORDER_BODY);
  });

  it('keeps the optional fields absent when the client omitted them (no sha256, no key, no null filled in)', async () => {
    const token = await webToken();
    await call('POST', `/gigs/${GIG_ID}/draft/media/uploads`, token, {
      expectedRevision: 4,
      fieldKey: 'photos',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      altText: null,
    });
    expect(svc.requestMediaUpload.mock.calls[0]![2]).toEqual({ expectedRevision: 4, fieldKey: 'photos', mimeType: 'image/jpeg', sizeBytes: 10, altText: null });
    await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, token, { expectedRevision: 5 });
    expect(svc.finalizeMedia.mock.calls[0]![3]).toEqual({ expectedRevision: 5 });
    await call('PUT', `/gigs/${GIG_ID}/draft/variants`, token, {
      expectedRevision: 4,
      variants: [{ name: 'A', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 }],
    });
    expect(svc.replaceVariants.mock.calls[0]![2]).toEqual({
      expectedRevision: 4,
      variants: [{ name: 'A', description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 }],
    });
  });

  it('the draft preview asks for the draft (version null); the version preview for that version number', async () => {
    const token = await webToken();
    await call('GET', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, token);
    expect(svc.previewMedia).toHaveBeenLastCalledWith(ACCOUNT_ID, GIG_ID, null, MEDIA_ID);
    await call('GET', `/gigs/${GIG_ID}/versions/7/media/${MEDIA_ID}/preview`, token);
    expect(svc.previewMedia).toHaveBeenLastCalledWith(ACCOUNT_ID, GIG_ID, 7, MEDIA_ID);
  });

  it('never accepts an owner, an account, a status, a currency, an asset, a key, a hash for a stored object or a template version from the client', async () => {
    const token = await webToken();
    const extras: Record<string, unknown>[] = [
      { accountId: ACCOUNT_ID },
      { ownerId: ACCOUNT_ID },
      { status: 'READY' },
      { currency: 'EUR' },
      { assetId: ASSET_ID },
      { objectKey: OBJECT_KEY },
      { gigTemplateVersionId: TEMPLATE_VERSION_ID },
    ];
    for (const extra of extras)
      for (const r of BODY_ROUTES) {
        const res = await call(r.method, r.url, token, { ...(r.body as object), ...extra });
        expect(res.statusCode, `${r.operationId} ${Object.keys(extra)[0]}`).toBe(400);
      }
    const item = (extra: object) => ({ ...VARIANTS_BODY, variants: [{ ...VARIANTS_BODY.variants[0], ...extra }] });
    for (const extra of [{ currency: 'USD' }, { displayOrder: 1 }, { id: ASSET_ID }, { priceMinor: 1 }])
      expect((await call('PUT', `/gigs/${GIG_ID}/draft/variants`, token, item(extra))).statusCode).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== strict bodies (LRN-0058: Ajv coerces, the handler reads the parsed copy)
describe('strict bodies', () => {
  const v = (over: Record<string, unknown>) => ({ ...VARIANTS_BODY.variants[0], ...over });
  const withVariant = (over: Record<string, unknown>) => ({ expectedRevision: 4, variants: [v(over)] });

  it.each([
    ['a numeric name (Ajv would coerce it to "5")', withVariant({ name: 5 })],
    ['a boolean name (Ajv would coerce it to "true")', withVariant({ name: true })],
    ['a numeric description', withVariant({ description: 7 })],
    ['a string price delta (Ajv would coerce it to a number)', withVariant({ priceDeltaMinor: '500' })],
    ['a string duration delta', withVariant({ durationDeltaMinutes: '30' })],
    ['a fractional price delta', withVariant({ priceDeltaMinor: 5.5 })],
    ['a negative price delta', withVariant({ priceDeltaMinor: -1 })],
    ['a negative duration delta', withVariant({ durationDeltaMinutes: -1 })],
    ['a price delta above the structural ceiling', withVariant({ priceDeltaMinor: 10 ** 12 + 1 })],
    ['a duration delta above the ceiling', withVariant({ durationDeltaMinutes: 100_001 })],
    ['a numeric key', withVariant({ key: 5 })],
    ['a malformed key', withVariant({ key: 'Not A Key!' })],
    ['an absent price delta (Ajv would default it)', { expectedRevision: 4, variants: [{ name: 'A', description: null, durationDeltaMinutes: 0 }] }],
    ['an absent description', { expectedRevision: 4, variants: [{ name: 'A', priceDeltaMinor: 0, durationDeltaMinutes: 0 }] }],
    ['a string revision', { ...VARIANTS_BODY, expectedRevision: '4' }],
    ['a null revision', { ...VARIANTS_BODY, expectedRevision: null }],
    ['a zero revision', { ...VARIANTS_BODY, expectedRevision: 0 }],
    ['a fractional revision', { ...VARIANTS_BODY, expectedRevision: 4.5 }],
    ['variants that are not an array', { expectedRevision: 4, variants: {} }],
    ['a null list', { expectedRevision: 4, variants: null }],
    ['an array body', []],
    ['a missing list', { expectedRevision: 4 }],
    ['duplicate keys', { expectedRevision: 4, variants: [v({ key: 'opt_0123456789ab' }), v({ key: 'opt_0123456789ab', name: 'B' })] }],
    [
      'more than the structural ceiling of items',
      { expectedRevision: 4, variants: Array.from({ length: 101 }, (_, i) => v({ key: undefined, name: `n${i}` })) },
    ],
    ['an unknown property', { ...VARIANTS_BODY, extra: 1 }],
  ])('variants: %s is 400 and the service is not called', async (_n, body) => {
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), body);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
  });

  it.each([
    ['a numeric file size as text', { ...UPLOAD_BODY, sizeBytes: '1234' }],
    ['a fractional size', { ...UPLOAD_BODY, sizeBytes: 12.5 }],
    ['a zero size', { ...UPLOAD_BODY, sizeBytes: 0 }],
    ['a size above the structural ceiling', { ...UPLOAD_BODY, sizeBytes: 26_214_401 }],
    ['a numeric MIME type', { ...UPLOAD_BODY, mimeType: 5 }],
    ['an empty MIME type', { ...UPLOAD_BODY, mimeType: '' }],
    ['a numeric field key', { ...UPLOAD_BODY, fieldKey: 5 }],
    ['an upper-case hash', { ...UPLOAD_BODY, sha256: SHA.toUpperCase() }],
    ['a short hash', { ...UPLOAD_BODY, sha256: 'abcd' }],
    ['a numeric alt text', { ...UPLOAD_BODY, altText: 5 }],
    ['an absent alt text', { expectedRevision: 4, fieldKey: 'photos', mimeType: 'image/png', sizeBytes: 5 }],
    ['an absent field key', { expectedRevision: 4, mimeType: 'image/png', sizeBytes: 5, altText: null }],
    ['an unknown property (a URL of the client)', { ...UPLOAD_BODY, url: SIGNED_URL }],
  ])('upload: %s is 400', async (_n, body) => {
    const res = await call('POST', `/gigs/${GIG_ID}/draft/media/uploads`, await webToken(), body);
    expect(res.statusCode, res.body).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it.each([
    ['finalize: a string revision', 'POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, { expectedRevision: '5' }],
    ['finalize: an absent revision', 'POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, {}],
    ['finalize: an unknown property', 'POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, { expectedRevision: 5, size: 1 }],
    ['finalize: a bad hash', 'POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, { expectedRevision: 5, sha256: 'xyz' }],
    ['alt text: a numeric alt text', 'PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, { expectedRevision: 5, altText: 1 }],
    ['alt text: an absent alt text (null is the only way to clear)', 'PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, { expectedRevision: 5 }],
    ['alt text: an unknown property', 'PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, { expectedRevision: 5, altText: null, order: 1 }],
    ['detach: an absent revision', 'DELETE', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, {}],
    ['detach: a string revision', 'DELETE', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, { expectedRevision: '5' }],
    ['detach: an unknown property', 'DELETE', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, { expectedRevision: 5, force: true }],
    ['order: duplicate media ids', 'PUT', `/gigs/${GIG_ID}/draft/media/order`, { expectedRevision: 5, mediaIds: [MEDIA_ID, MEDIA_ID] }],
    ['order: a malformed media id', 'PUT', `/gigs/${GIG_ID}/draft/media/order`, { expectedRevision: 5, mediaIds: ['nope'] }],
    ['order: a numeric media id', 'PUT', `/gigs/${GIG_ID}/draft/media/order`, { expectedRevision: 5, mediaIds: [1] }],
    ['order: a missing list', 'PUT', `/gigs/${GIG_ID}/draft/media/order`, { expectedRevision: 5 }],
    [
      'order: too many ids',
      'PUT',
      `/gigs/${GIG_ID}/draft/media/order`,
      { expectedRevision: 5, mediaIds: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`) },
    ],
    [
      'add-ons: a string price delta',
      'PUT',
      `/gigs/${GIG_ID}/draft/add-ons`,
      { expectedRevision: 4, addOns: [{ name: 'A', description: null, priceDeltaMinor: '1', durationDeltaMinutes: 0 }] },
    ],
    ['add-ons: the variants property', 'PUT', `/gigs/${GIG_ID}/draft/add-ons`, { expectedRevision: 4, variants: [] }],
  ] as [string, Method, string, unknown][])('%s is 400', async (_n, method, url, body) => {
    const res = await call(method, url, await webToken(), body);
    expect(res.statusCode, res.body).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it.each(BODY_ROUTES.map((r) => [r.operationId, r] as const))('%s: a missing body, a null body and malformed JSON are 400', async (_n, r) => {
    const token = await webToken();
    expect((await call(r.method, r.url, token)).statusCode, 'no body').toBe(400);
    expect((await rawBody(r.method, r.url, token, 'null')).statusCode, 'null').toBe(400);
    expect((await rawBody(r.method, r.url, token, '{"expectedRevision":')).statusCode, 'malformed').toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it('the legitimate empty list is accepted: an empty variants list or add-ons list clears them', async () => {
    const token = await webToken();
    expect((await call('PUT', `/gigs/${GIG_ID}/draft/variants`, token, { expectedRevision: 4, variants: [] })).statusCode).toBe(200);
    expect((await call('PUT', `/gigs/${GIG_ID}/draft/add-ons`, token, { expectedRevision: 4, addOns: [] })).statusCode).toBe(200);
    expect((await call('PUT', `/gigs/${GIG_ID}/draft/media/order`, token, { expectedRevision: 5, mediaIds: [] })).statusCode).toBe(200);
    expect(svc.replaceVariants.mock.calls[0]![2]).toEqual({ expectedRevision: 4, variants: [] });
  });

  it('keeps provider-written text exactly as sent (no coercion, no trimming here): the service normalises', async () => {
    const body = { expectedRevision: 4, variants: [{ name: '  Deep clean  ', description: 'Line 1\nLine 2', priceDeltaMinor: 1, durationDeltaMinutes: 2 }] };
    expect((await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), body)).statusCode).toBe(200);
    expect(svc.replaceVariants.mock.calls[0]![2]).toEqual(body);
  });

  it('a body above its limit is 413 and the service is not called', async () => {
    const token = await webToken();
    const bigAlt = 'x'.repeat(GIG_MEDIA_BODY_LIMIT + 10);
    expect((await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, { expectedRevision: 5, altText: bigAlt })).statusCode).toBe(413);
    expect(
      (
        await call('PUT', `/gigs/${GIG_ID}/draft/variants`, token, {
          expectedRevision: 4,
          variants: [{ name: 'x'.repeat(GIG_BODY_LIMIT), description: null, priceDeltaMinor: 0, durationDeltaMinutes: 0 }],
        })
      ).statusCode,
    ).toBe(413);
    expect(noServiceCalled()).toBe(true);
  });

  it('provider text in a rejected body is never echoed', async () => {
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), withVariant({ name: NAME_SENTINEL, priceDeltaMinor: 'bad' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(NAME_SENTINEL);
    const alt = await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, await webToken(), { expectedRevision: 'x', altText: ALT_SENTINEL });
    expect(alt.statusCode).toBe(400);
    expect(alt.body).not.toContain(ALT_SENTINEL);
  });
});

// ====================================================================== strict path parameters
describe('strict path parameters', () => {
  it.each([
    ['a Gig id that is not a UUID', `/gigs/not-a-uuid/draft/media/${MEDIA_ID}/preview`],
    ['an upper-case Gig id', `/gigs/${GIG_ID.toUpperCase()}/draft/media/${MEDIA_ID}/preview`],
    ['a media id that is not a UUID', `/gigs/${GIG_ID}/draft/media/not-a-uuid/preview`],
    ['a media id with a path trick', `/gigs/${GIG_ID}/draft/media/..%2F..%2Fx/preview`],
    ['a version with a leading zero', `/gigs/${GIG_ID}/versions/01/media/${MEDIA_ID}/preview`],
    ['a version in exponent form', `/gigs/${GIG_ID}/versions/1e3/media/${MEDIA_ID}/preview`],
    ['a fractional version', `/gigs/${GIG_ID}/versions/1.0/media/${MEDIA_ID}/preview`],
    ['a zero version', `/gigs/${GIG_ID}/versions/0/media/${MEDIA_ID}/preview`],
    ['a version above the maximum', `/gigs/${GIG_ID}/versions/1000000000/media/${MEDIA_ID}/preview`],
    ['a signed version', `/gigs/${GIG_ID}/versions/+1/media/${MEDIA_ID}/preview`],
    ['a query string on a preview', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview?x=1`],
  ])('%s is 400', async (_n, url) => {
    const res = await call('GET', url, await webToken());
    expect(res.statusCode, res.body).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it.each(BODY_ROUTES.filter((r) => r.spec.includes('{mediaId}') && !r.operationId.includes('Preview')))('$operationId: a bad media id is 400', async (r) => {
    const res = await call(r.method, r.url.replace(MEDIA_ID, 'nope'), await webToken(), r.body);
    expect(res.statusCode, res.body).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it('the static segment `order` is the reorder route, a UUID is the alt-text route, and `order` is not a media id', async () => {
    const token = await webToken();
    await call('PUT', `/gigs/${GIG_ID}/draft/media/order`, token, ORDER_BODY);
    expect(svc.reorderMedia).toHaveBeenCalledTimes(1);
    expect(svc.updateMedia).not.toHaveBeenCalled();
    await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, ALT_BODY);
    expect(svc.updateMedia).toHaveBeenCalledTimes(1);
    expect((await call('DELETE', `/gigs/${GIG_ID}/draft/media/order`, token, DETACH_BODY)).statusCode).toBeGreaterThanOrEqual(400);
    expect(svc.detachMedia).not.toHaveBeenCalled();
  });

  it('the largest accepted version is 999999999', async () => {
    const res = await call('GET', `/gigs/${GIG_ID}/versions/999999999/media/${MEDIA_ID}/preview`, await webToken());
    expect(res.statusCode).toBe(200);
    expect(svc.previewMedia).toHaveBeenCalledWith(ACCOUNT_ID, GIG_ID, 999_999_999, MEDIA_ID);
  });
});

// ====================================================================== cache policy, status codes and shapes
describe('Cache-Control: no-store, status codes and response shapes', () => {
  it.each(ROUTES)('$operationId: success and failure are no-store and the success status is documented', async (r) => {
    const ok = await routeCall(r, await webToken());
    expect(ok.statusCode, ok.body).toBe(r.okStatus);
    expectNoStore(ok);
    const bad = await routeCall(r);
    expectNoStore(bad);
    svc[r.fn]!.mockRejectedValueOnce(new GigError('GIG_NOT_FOUND' as never, 'x'));
    const failed = await routeCall(r, await webToken());
    expectNoStore(failed);
  });

  it('only the upload authorization answers 201', () => {
    expect(ROUTES.filter((r) => r.okStatus === 201).map((r) => r.operationId)).toEqual(['requestProviderGigMediaUpload']);
  });

  it('the detail answers parse as GigDetailResponse and round-trip unchanged', async () => {
    const token = await webToken();
    for (const r of ROUTES.filter((x) => x.okStatus === 200 && !x.operationId.includes('Preview'))) {
      const res = await routeCall(r, token);
      expect(res.statusCode, r.operationId).toBe(200);
      const parsed = GigDetailResponse.parse(res.json());
      expect(parsed.data).toEqual(detailFixture());
      expect(Object.keys(res.json() as object).sort()).toEqual(['data', 'meta']);
    }
  });

  it('the upload answer carries the media, the one-object PUT target, the limit and the next revision', async () => {
    const res = await call('POST', `/gigs/${GIG_ID}/draft/media/uploads`, await webToken(), UPLOAD_BODY);
    expect(res.statusCode).toBe(201);
    const data = GigMediaUploadResponse.parse(res.json()).data;
    expect(keysOf(data)).toEqual(['maxSizeBytes', 'media', 'revision', 'upload']);
    expect(keysOf(data.upload)).toEqual(['expiresAt', 'headers', 'url']);
    expect(data.revision).toBe(5);
    expect(data.media.status).toBe('UPLOADING');
    expect(data.upload.url).toBe(SIGNED_URL);
    expect(data.upload.headers).toEqual({ 'content-type': 'image/png', 'content-length': '1234' });
    expectNoStore(res);
    // the service result's detail is not part of this answer
    expect(res.body).not.toContain('"gig"');
  });

  it('the preview answer is { url, expiresAt } and nothing else', async () => {
    for (const url of [`/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, `/gigs/${GIG_ID}/versions/1/media/${MEDIA_ID}/preview`]) {
      const res = await call('GET', url, await webToken());
      expect(res.statusCode).toBe(200);
      expect(keysOf(dataOf(res))).toEqual(['expiresAt', 'url']);
      expect(GigMediaPreviewResponse.safeParse(res.json()).success).toBe(true);
      expectNoStore(res);
    }
  });

  it('a hostile service result (an asset id, an object key, a hash, a URL on the media, the options, the upload) never reaches the client', async () => {
    const hostileMedia = {
      ...mediaFixture(),
      assetId: ASSET_ID,
      objectKey: OBJECT_KEY,
      sha256: SHA,
      url: SIGNED_URL,
      scanStatus: 'CLEAN',
      accountId: ACCOUNT_ID,
    };
    const hostileOption = { ...optionFixture(), assetId: ASSET_ID, accountId: ACCOUNT_ID, currency: 'USD', gigVersionId: VERSION_ID };
    const detail = detailFixture();
    const hostile = {
      ...detail,
      draftVersion: {
        ...detail.draftVersion!,
        media: [hostileMedia],
        variants: [hostileOption],
        addOns: [{ ...detail.draftVersion!.addOns[0]!, assetId: ASSET_ID, accountId: ACCOUNT_ID, currency: 'USD' }],
        children: { ...CHILDREN, objectKeys: [OBJECT_KEY] },
        constraints: { ...detail.draftVersion!.constraints, media: { ...detail.draftVersion!.constraints.media, bucket: 'private', publicUrl: SIGNED_URL } },
        fields: detail.draftVersion!.fields.map((f) => ({ ...f, objectKey: OBJECT_KEY })),
      },
    };
    const token = await webToken();
    for (const r of ROUTES.filter((x) => x.okStatus === 200 && !x.operationId.includes('Preview'))) {
      svc[r.fn]!.mockResolvedValueOnce(hostile);
      const res = await routeCall(r, token);
      expect(res.statusCode, r.operationId).toBe(200);
      for (const secret of [...SECRETS, SIGNED_URL, 'private', 'scanStatus', 'publicUrl']) expect(res.body, `${r.operationId} ${secret}`).not.toContain(secret);
      expect(GigDetailResponse.parse(res.json()).data).toEqual(detail);
    }
    svc.requestMediaUpload.mockResolvedValueOnce({
      upload: {
        ...uploadFixture(),
        media: { ...uploadFixture().media, assetId: ASSET_ID, objectKey: OBJECT_KEY, sha256: SHA },
        objectKey: OBJECT_KEY,
        assetId: ASSET_ID,
        upload: { ...uploadFixture().upload, key: OBJECT_KEY, sha256: SHA },
      },
      detail,
    });
    const up = await call('POST', `/gigs/${GIG_ID}/draft/media/uploads`, token, UPLOAD_BODY);
    expect(up.statusCode).toBe(201);
    // the one place a URL legitimately travels is the upload target itself (it contains the signature marker)
    for (const secret of SECRETS.filter((x) => x !== 'X-Amz-Signature')) expect(up.body, secret).not.toContain(secret);
    expect(GigMediaUploadResponse.parse(up.json()).data).toEqual(uploadFixture());
    svc.previewMedia.mockResolvedValueOnce({ url: SIGNED_URL, expiresAt: ISO, objectKey: OBJECT_KEY });
    const pv = await call('GET', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, token);
    expect(pv.body).not.toContain(OBJECT_KEY);
  });

  it('the default detail payload (no upload, no preview) holds no URL at all', async () => {
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), VARIANTS_BODY);
    expect(res.body).not.toMatch(/https?:/);
    for (const secret of SECRETS) expect(res.body, secret).not.toContain(secret);
  });

  it("provider text appears only in the caller's own detail answer: names, descriptions and alt text", async () => {
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), VARIANTS_BODY);
    expect(res.body).toContain(NAME_SENTINEL);
    expect(res.body).toContain(ALT_SENTINEL);
    const fin = await call('GET', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, await webToken());
    expect(fin.body).not.toContain(ALT_SENTINEL);
  });

  it('router-level failures under the prefix are no-store', async () => {
    const r = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, await webToken(), {});
    expect(r.statusCode).toBe(404);
    expectNoStore(r);
  });
});

// ====================================================================== error mapping
describe('typed Gig failures of the CAT-004 operations', () => {
  const NEW: Record<string, [number, string]> = {
    MEDIA_NOT_FOUND: [404, 'NOT_FOUND'],
    MEDIA_REFUSED: [400, 'VALIDATION'],
    MEDIA_EXPIRED: [409, 'CONFLICT'],
    MEDIA_SCAN_UNAVAILABLE: [503, 'DEPENDENCY'],
  };

  it('the four new codes are in the contract list', () => {
    for (const code of Object.keys(NEW)) expect(GIG_ERROR_CODES as readonly string[]).toContain(code);
  });

  it.each(Object.entries(NEW))('%s: status, category, GIG_ code, message key and no provider text, on every route', async (code, [status, category]) => {
    for (const r of ROUTES) {
      svc[r.fn]!.mockRejectedValueOnce(new GigError(code as GigErrorCode, NAME_SENTINEL, { reason: 'SIGNATURE_MISMATCH', cause: SIGNED_URL }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, `${r.operationId} ${res.body}`).toBe(status);
      const e = errorOf(res);
      expect(e.category).toBe(category);
      expect(e.code).toBe(`GIG_${code}`);
      expect(e.code).toBe(gigApiErrorCode(code as GigErrorCode));
      expect((e.details as Record<string, unknown>).messageKey).toBe(gigErrorKey(code as GigErrorCode));
      for (const leak of [NAME_SENTINEL, SIGNED_URL, OBJECT_KEY]) expect(res.body).not.toContain(leak);
      expectNoStore(res);
    }
  });

  it("a missing photo carries nothing but the message key (unknown and someone else's are the same answer)", async () => {
    svc.finalizeMedia.mockRejectedValueOnce(new GigError('MEDIA_NOT_FOUND', 'x', { reason: 'ASSET_OWNER', field: 'mediaId', count: 3 }));
    const a = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
    svc.finalizeMedia.mockRejectedValueOnce(new GigError('MEDIA_NOT_FOUND', 'y'));
    const b = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
    expect({ ...errorOf(a), correlationId: undefined }).toEqual({ ...errorOf(b), correlationId: undefined });
    expect(errorOf(a).details).toEqual({ messageKey: gigErrorKey('MEDIA_NOT_FOUND') });
  });

  it('a refused photo keeps a reason code from the closed list and drops anything else', async () => {
    for (const reason of MEDIA_REFUSAL_REASONS) {
      svc.finalizeMedia.mockRejectedValueOnce(new GigError('MEDIA_REFUSED', 'x', { reason }));
      const res = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
      expect(errorOf(res).details).toEqual({ reason, messageKey: gigErrorKey('MEDIA_REFUSED') });
    }
    for (const reason of ['SOME_FREE_TEXT', 'ab/cd', 'the stored content type was image/gif', OBJECT_KEY, SHA]) {
      svc.finalizeMedia.mockRejectedValueOnce(new GigError('MEDIA_REFUSED', 'x', { reason }));
      const res = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
      expect(errorOf(res).details).toEqual({ messageKey: gigErrorKey('MEDIA_REFUSED') });
    }
  });

  it('a refused photo drops sizes, hashes, keys, URLs and causes from its details', async () => {
    svc.finalizeMedia.mockRejectedValueOnce(
      new GigError('MEDIA_REFUSED', 'x', {
        reason: 'FILE_TOO_LARGE',
        size: 99_999_999,
        limit: 10_485_760,
        sha256: SHA,
        objectKey: OBJECT_KEY,
        url: SIGNED_URL,
        cause: 'ECONNREFUSED 10.0.0.1',
      }), // limit > 100000 is not a small bound: dropped too
    );
    const res = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
    expect(errorOf(res).details).toEqual({ reason: 'FILE_TOO_LARGE', messageKey: gigErrorKey('MEDIA_REFUSED') });
    for (const leak of [SHA, OBJECT_KEY, SIGNED_URL, '10.0.0.1', '99999999']) expect(res.body).not.toContain(leak);
  });

  it('an unavailable scanner is retryable and carries no reason or cause', async () => {
    svc.finalizeMedia.mockRejectedValueOnce(
      new GigError('MEDIA_SCAN_UNAVAILABLE', 'scanner down at 10.0.0.9', { reason: 'SCAN_ERROR', cause: 'ECONNREFUSED' }),
    );
    const res = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).details).toEqual({ retryable: true, messageKey: gigErrorKey('MEDIA_SCAN_UNAVAILABLE') });
    expect(res.body).not.toContain('10.0.0.9');
  });

  it('an expired upload is a conflict with its message key', async () => {
    svc.finalizeMedia.mockRejectedValueOnce(new GigError('MEDIA_EXPIRED', 'x', { reason: 'UPLOAD_EXPIRED' }));
    const res = await call('POST', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/finalize`, await webToken(), FINALIZE_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('GIG_MEDIA_EXPIRED');
  });

  it('issues of a refused variant list: target, field key, item key, reason, derived message key only', async () => {
    svc.replaceVariants.mockRejectedValueOnce(
      new GigError('VALIDATION_FAILED', 'x', {
        issues: [
          { target: 'variants', itemKey: 'opt_0123456789ab', reason: 'OPTION_NAME_DUPLICATE', messageKey: 'evil', name: NAME_SENTINEL },
          { target: 'variants', itemKey: NAME_SENTINEL, reason: 'OPTION_NAME_DUPLICATE' },
          { target: 'addOns', reason: 'OPTIONS_NOT_PERMITTED' },
          { target: 'media', itemKey: MEDIA_ID, fieldKey: 'photos', reason: 'MEDIA_REQUIRED' },
          { target: 'media', itemKey: ASSET_ID.toUpperCase(), reason: 'MEDIA_NOT_READY' },
          { target: 'bogus', reason: 'OPTION_KEY_INVALID' },
          { target: 'variants', reason: 'NOT_A_REASON' },
        ],
      }),
    );
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/variants`, await webToken(), VARIANTS_BODY);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual({
      issues: [
        { target: 'variants', itemKey: 'opt_0123456789ab', reason: 'OPTION_NAME_DUPLICATE', messageKey: gigIssueKey('OPTION_NAME_DUPLICATE') },
        { target: 'variants', reason: 'OPTION_NAME_DUPLICATE', messageKey: gigIssueKey('OPTION_NAME_DUPLICATE') },
        { target: 'addOns', reason: 'OPTIONS_NOT_PERMITTED', messageKey: gigIssueKey('OPTIONS_NOT_PERMITTED') },
        { target: 'media', itemKey: MEDIA_ID, fieldKey: 'photos', reason: 'MEDIA_REQUIRED', messageKey: gigIssueKey('MEDIA_REQUIRED') },
        { target: 'media', reason: 'MEDIA_NOT_READY', messageKey: gigIssueKey('MEDIA_NOT_READY') },
      ],
      messageKey: gigErrorKey('VALIDATION_FAILED'),
    });
    expect(res.body).not.toContain(NAME_SENTINEL);
  });

  it('a publish blocked by photos and options lists identifier-only issues with the new reasons', async () => {
    svc.replaceAddOns.mockRejectedValueOnce(
      new GigError('PUBLISH_BLOCKED', 'x', {
        issues: [
          { target: 'media', fieldKey: 'photos', reason: 'MEDIA_REQUIRED' },
          { target: 'addOns', itemKey: 'opt_ba9876543210', reason: 'OPTIONS_COUNT_EXCEEDED' },
        ],
      }),
    );
    const res = await call('PUT', `/gigs/${GIG_ID}/draft/add-ons`, await webToken(), ADD_ONS_BODY);
    expect(res.statusCode).toBe(409);
    expect((errorOf(res).details as { issues: unknown[] }).issues).toHaveLength(2);
  });

  it('every new issue reason has a derived message key and survives the allow-list', () => {
    for (const reason of GIG_ISSUE_REASONS) {
      expect(gigIssueKey(reason)).toBe(`provider.gig.issue.${reason.toLowerCase()}`);
      const out = safeDetails({ issues: [{ target: 'variants', itemKey: 'opt_0123456789ab', reason }] });
      expect(out.issues, reason).toEqual([{ target: 'variants', itemKey: 'opt_0123456789ab', reason, messageKey: gigIssueKey(reason) }]);
    }
  });

  it('the existing codes keep working on the new routes (stale draft, wrong state, limits, outage)', async () => {
    const cases: [GigErrorCode, number][] = [
      ['STALE_DRAFT', 409],
      ['NO_DRAFT', 409],
      ['GIG_RETIRED', 409],
      ['GIG_NOT_FOUND', 404],
      ['VALIDATION_FAILED', 400],
      ['LIMIT_REACHED', 409],
      ['ACCOUNT_NOT_ACTIVE', 403],
      ['UNAVAILABLE', 503],
    ];
    for (const [code, status] of cases)
      for (const r of ROUTES) {
        svc[r.fn]!.mockRejectedValueOnce(new GigError(code, 'x', { reason: 'WHY' }));
        const res = await routeCall(r, await webToken());
        expect(res.statusCode, `${r.operationId} ${code}`).toBe(status);
      }
  });

  it('an unexpected failure stays a generic 500 and leaks nothing', async () => {
    svc.previewMedia.mockRejectedValueOnce(new Error(`boom ${SIGNED_URL} ${OBJECT_KEY}`));
    const res = await call('GET', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}/preview`, await webToken());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SIGNED_URL);
    expect(res.body).not.toContain(OBJECT_KEY);
  });
});

// ====================================================================== wiring: the policy provider and the scanner adapter
describe('the options and media policy read the configuration registry with no code default', () => {
  const O = PROVIDER_GIG_OPTIONS_POLICY_KEYS;
  const M = PROVIDER_GIG_MEDIA_POLICY_KEYS;
  const optionValues = (over: Record<string, unknown> = {}) =>
    ({
      [O.variantMaxCount]: 10,
      [O.addOnMaxCount]: 20,
      [O.nameMaxLength]: 80,
      [O.descriptionMaxLength]: 500,
      ...over,
    }) as Record<string, unknown>;
  const mediaValues = (over: Record<string, unknown> = {}) =>
    ({
      [M.maxFileSizeBytes]: 10_485_760,
      [M.maxItems]: 50,
      [M.allowedMimeTypes]: ['image/jpeg', 'image/png', 'image/webp'],
      [M.uploadTtlSeconds]: 900,
      [M.requireCleanScan]: true,
      [M.minEdgePixels]: 200,
      [M.maxEdgePixels]: 12_000,
      [M.maxPixels]: 50_000_000,
      [M.downloadTtlSeconds]: 60,
      [M.orphanGraceSeconds]: 86_400,
      [M.altTextMaxLength]: 200,
      ...over,
    }) as Record<string, unknown>;
  const registry = (all: Record<string, unknown>) => {
    const resolveMany = vi.fn(async (wanted: string[]) => ({ values: new Map(wanted.filter((k) => k in all).map((k) => [k, { value: all[k] }])) }));
    return { resolveMany };
  };
  const everything = (over: Record<string, unknown> = {}) => ({
    [PROVIDER_GIG_POLICY_KEYS.maxActive]: 25,
    [PROVIDER_GIG_POLICY_KEYS.maxDrafts]: 10,
    [PROVIDER_GIG_POLICY_KEYS.titleMaxLength]: 100,
    [PROVIDER_GIG_POLICY_KEYS.shortPitchMaxLength]: 1000,
    [PROVIDER_GIG_POLICY_KEYS.descriptionMaxLength]: 5000,
    ...optionValues(),
    ...mediaValues(),
    ...over,
  });

  it('options(): the typed limits, asking for exactly the four option keys', async () => {
    const reg = registry(everything());
    const policy = await createGigPolicyProvider(reg as never).options();
    expect(policy).toEqual({ variantMaxCount: 10, addOnMaxCount: 20, nameMaxLength: 80, descriptionMaxLength: 500 });
    expect([...reg.resolveMany.mock.calls[0]![0]].sort()).toEqual(Object.values(O).sort());
  });

  it('media(): the typed limits, asking for exactly the eleven media keys', async () => {
    const reg = registry(everything());
    const policy = await createGigPolicyProvider(reg as never).media();
    expect(policy).toEqual({
      maxFileSizeBytes: 10_485_760,
      maxItems: 50,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      uploadTtlSeconds: 900,
      requireCleanScan: true,
      minEdgePixels: 200,
      maxEdgePixels: 12_000,
      maxPixels: 50_000_000,
      downloadTtlSeconds: 60,
      orphanGraceSeconds: 86_400,
      altTextMaxLength: 200,
    });
    expect([...reg.resolveMany.mock.calls[0]![0]].sort()).toEqual(Object.values(M).sort());
    expect(Object.keys(M)).toHaveLength(11);
  });

  it('the three policies are independent reads: a broken media value does not break the base or option policy', async () => {
    const provider = createGigPolicyProvider(registry(everything({ [M.maxFileSizeBytes]: 'big' })) as never);
    await expect(provider.media()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
    await expect(provider.options()).resolves.toBeDefined();
    await expect(provider.policy()).resolves.toBeDefined();
  });

  it.each([
    ['options: a missing value', 'options', () => registry(Object.fromEntries(Object.entries(everything()).filter(([k]) => k !== O.variantMaxCount)))],
    ['options: a string where a number is required', 'options', () => registry(everything({ [O.addOnMaxCount]: '20' }))],
    ['options: a count above the ceiling', 'options', () => registry(everything({ [O.variantMaxCount]: 101 }))],
    ['options: a name length of zero', 'options', () => registry(everything({ [O.nameMaxLength]: 0 }))],
    ['options: a description length above the ceiling', 'options', () => registry(everything({ [O.descriptionMaxLength]: 2001 }))],
    ['media: a missing value', 'media', () => registry(Object.fromEntries(Object.entries(everything()).filter(([k]) => k !== M.uploadTtlSeconds)))],
    ['media: a MIME type this build cannot verify (HEIC)', 'media', () => registry(everything({ [M.allowedMimeTypes]: ['image/heic'] }))],
    ['media: SVG', 'media', () => registry(everything({ [M.allowedMimeTypes]: ['image/svg+xml'] }))],
    ['media: an empty MIME list', 'media', () => registry(everything({ [M.allowedMimeTypes]: [] }))],
    ['media: duplicate MIME types', 'media', () => registry(everything({ [M.allowedMimeTypes]: ['image/png', 'image/png'] }))],
    ['media: a clean-scan flag that is text', 'media', () => registry(everything({ [M.requireCleanScan]: 'true' }))],
    ['media: a file size above the structural ceiling', 'media', () => registry(everything({ [M.maxFileSizeBytes]: 26_214_401 }))],
    ['media: a minimum edge above the maximum edge', 'media', () => registry(everything({ [M.minEdgePixels]: 13_000 }))],
    ['media: pixels above the structural ceiling', 'media', () => registry(everything({ [M.maxPixels]: 400_000_001 }))],
    ['media: an upload TTL below the floor', 'media', () => registry(everything({ [M.uploadTtlSeconds]: 5 }))],
    ['media: a download TTL above the ceiling', 'media', () => registry(everything({ [M.downloadTtlSeconds]: 601 }))],
    ['media: a grace period below the floor', 'media', () => registry(everything({ [M.orphanGraceSeconds]: 30 }))],
  ] as [string, 'options' | 'media', () => ReturnType<typeof registry>][])('%s fails closed with UNAVAILABLE (POLICY_INVALID)', async (_n, which, make) => {
    const provider = createGigPolicyProvider(make() as never);
    await expect(provider[which]()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
  });

  it.each(['policy', 'options', 'media'] as const)('%s(): an unreadable registry fails closed with UNAVAILABLE (POLICY_UNREADABLE)', async (which) => {
    const provider = createGigPolicyProvider({ resolveMany: async () => Promise.reject(new Error('redis down')) } as never);
    await expect(provider[which]()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
  });
});

describe('the photo scanner adapter', () => {
  const input = { key: OBJECT_KEY, size: 3, bytes: Buffer.from('abc') };

  it('passes CLEAN and INFECTED through, and everything else is ERROR', async () => {
    for (const status of ['CLEAN', 'INFECTED']) expect(await createGigMediaScanner({ scan: async () => ({ status }) }).scan(input)).toEqual({ status });
    for (const status of ['ERROR', 'PENDING', 'clean', '', 'OK'])
      expect(await createGigMediaScanner({ scan: async () => ({ status }) }).scan(input)).toEqual({ status: 'ERROR' });
  });

  it('a scanner that throws, or none at all, is ERROR (fail closed)', async () => {
    expect(await createGigMediaScanner({ scan: async () => Promise.reject(new Error('down')) }).scan(input)).toEqual({ status: 'ERROR' });
    expect(await createGigMediaScanner(undefined).scan(input)).toEqual({ status: 'ERROR' });
  });

  it('hands the scanner the bytes and the key only', async () => {
    const scan = vi.fn(async () => ({ status: 'CLEAN' }));
    await createGigMediaScanner({ scan }).scan(input);
    expect(scan).toHaveBeenCalledWith(input);
  });
});

// ====================================================================== OpenAPI and the committed specs
describe('OpenAPI and the committed specs of the CAT-004 operations', () => {
  interface Op {
    operationId: string;
    tags: string[];
    security?: unknown[];
    responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    parameters?: { name: string; in: string }[];
    requestBody?: { content?: Record<string, unknown> };
  }
  const swagger = () => app.swagger() as unknown as { paths: Record<string, Record<string, Op>> };
  const ids = new Set(ROUTES.map((r) => r.operationId));

  it('documents exactly the nine operations with the right method, path, tag and bearer security', () => {
    const doc = swagger();
    const found: { operationId: string; method: string; path: string; op: Op }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        if (ids.has(op.operationId)) found.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, op });
    expect(found).toHaveLength(9);
    for (const r of ROUTES) {
      const f = found.find((x) => x.operationId === r.operationId)!;
      expect([f.method, f.path], r.operationId).toEqual([r.method, r.spec]);
      expect(f.op.tags, r.operationId).toEqual(['gigs']);
      expect(f.op.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('documents the success status, the failure responses and exactly the path parameters of each route', () => {
    const doc = swagger();
    for (const r of ROUTES) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      expect(Object.keys(op.responses), r.operationId).toEqual(expect.arrayContaining([String(r.okStatus), '400', '401', '403', '404', '409', '503']));
      const want = [...r.spec.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(
        (op.parameters ?? [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name)
          .sort(),
        r.operationId,
      ).toEqual(want);
      expect(op.requestBody !== undefined, r.operationId).toBe(r.body !== undefined);
    }
  });

  it('the upload documents the media upload response and the previews the preview response, as application/json', () => {
    const doc = swagger();
    const upload = doc.paths['/api/v1/provider/gigs/{gigId}/draft/media/uploads']!.post!;
    const schema = JSON.stringify(upload.responses['201']!.content!['application/json']!.schema);
    expect(schema).toContain('maxSizeBytes');
    expect(schema).toContain('expiresAt');
    for (const spec of [
      '/api/v1/provider/gigs/{gigId}/draft/media/{mediaId}/preview',
      '/api/v1/provider/gigs/{gigId}/versions/{version}/media/{mediaId}/preview',
    ]) {
      const s = JSON.stringify(doc.paths[spec]!.get!.responses['200']!.content!['application/json']!.schema);
      expect(s).toContain('expiresAt');
      expect(s).not.toContain('maxSizeBytes');
    }
    // a default detail response documents no URL, object key or hash property
    const detail = JSON.stringify(doc.paths['/api/v1/provider/gigs/{gigId}/draft/variants']!.put!.responses['200']);
    for (const bad of ['objectKey', 'sha256', 'assetId', '"url"']) expect(detail).not.toContain(bad);
    expect(detail).toContain('mediaRequirementSatisfied');
  });

  it('declares no account id, owner, market, asset or object key anywhere in the documented parameters', () => {
    const doc = swagger();
    for (const r of ROUTES)
      for (const prm of doc.paths[r.spec]![r.method.toLowerCase()]!.parameters ?? [])
        expect(['accountId', 'owner', 'market', 'marketCode', 'status', 'assetId', 'objectKey', 'key']).not.toContain(prm.name);
  });

  it('is not registered without the service, nor without the account service', async () => {
    const withoutService = await makeApp({ providerGigs: undefined });
    const withoutAccounts = await makeApp({ accounts: undefined });
    for (const target of [withoutService, withoutAccounts])
      for (const r of ROUTES) expect((await routeCall(r, await webToken(), target)).statusCode, r.operationId).toBe(404);
    expect(noServiceCalled()).toBe(true);
  });

  it('the committed OpenAPI document contains every operation and the committed AsyncAPI the publish counts', () => {
    const openapi = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8');
    for (const r of ROUTES) expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
    const asyncapi = readFileSync(path.join(root, 'docs/events/asyncapi.yaml'), 'utf8');
    for (const key of ['variantCount', 'addOnCount', 'mediaCount']) expect(asyncapi, key).toContain(key);
  });

  it('the publish event payload gained three counts and nothing that could carry text', () => {
    const k = Object.keys(GigVersionPublishedPayload.shape).sort();
    expect(k).toEqual([
      'accountId',
      'addOnCount',
      'gigId',
      'gigTemplateVersionId',
      'gigVersionId',
      'mediaCount',
      'supersededGigVersionId',
      'variantCount',
      'versionNumber',
    ]);
  });
});

// ---- mutation-testing additions (CAT-004 API): absolute pins that a relative test (limit + 10) cannot give, and the shape rules of the error details
describe('absolute body limits and the shape of error details', () => {
  it('the photo requests are bounded at 16 KiB in absolute terms: a body a little over it is 413, one inside it reaches the service', async () => {
    expect(GIG_MEDIA_BODY_LIMIT).toBe(16_384);
    const token = await webToken();
    const over = await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, { expectedRevision: 5, altText: 'x'.repeat(16_500) });
    expect(over.statusCode).toBe(413);
    expect(svc.updateMedia).not.toHaveBeenCalled();
    const inside = await call('PUT', `/gigs/${GIG_ID}/draft/media/${MEDIA_ID}`, token, { expectedRevision: 5, altText: 'x'.repeat(200) });
    expect(inside.statusCode, inside.body).toBe(200);
    expect(svc.updateMedia).toHaveBeenCalledTimes(1);
  });

  it('safeDetails keeps only short machine tokens: a reason, field or code with spaces, markup or more than 64 characters is dropped', () => {
    expect(safeDetails({ reason: 'ok_TOKEN-1.2', field: 'fieldKey', code: 'X' })).toEqual({ reason: 'ok_TOKEN-1.2', field: 'fieldKey', code: 'X' });
    expect(safeDetails({ reason: 'has a space', field: '<b>x</b>', code: 'a'.repeat(65) })).toEqual({});
    expect(safeDetails({ reason: 'a'.repeat(64) })).toEqual({ reason: 'a'.repeat(64) });
    expect(safeDetails({ reason: '' })).toEqual({});
    expect(safeDetails({ reason: 'secret\nline' })).toEqual({});
  });

  it('safeDetails carries at most 64 issues, however many the service reports', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ target: 'media', reason: 'MEDIA_REQUIRED', itemKey: `m${i}` }));
    const out = safeDetails({ issues: many }) as { issues: { itemKey?: string }[] };
    expect(out.issues).toHaveLength(64);
    expect(out.issues[0]!.itemKey).toBe('m0');
    expect(out.issues[63]!.itemKey).toBe('m63');
  });
});
