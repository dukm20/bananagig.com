// Unit tests of the provider verification API module (TRUST-001) with a FAKE TrustService and a FAKE AccountService, written by an independent author. The real rules are covered by
// packages/trust and trust.itest.ts; here: authentication and the identity context on all 11 provider operations (401 before 400, 403 for the admin context and for suspended or closed
// accounts, a customer who is NOT a provider is allowed, the active-role header is NOT honoured), that the service only ever receives the account of the VERIFIED TOKEN, that no id of an
// account / case / requirement / decision is accepted from a client, strict bodies and queries, the cache policy (no-store everywhere on BOTH prefixes, router failures included), status
// codes, exact response key sets and the absence of object keys / hashes / urls / vendor ids, the error mapping for EVERY TrustError code with its details allow-list, the body size
// limit; the 10 administrator operations under /api/v1/admin/trust with a permission matrix over forged admin tokens (trust-read < trust-review, trust-admin separate) and the reviewer
// identity being the token subject; the OpenAPI document and the committed specs; and the three composition adapters of modules/trust/wiring.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfig } from '@bananagig/config';
import {
  ErrorResponse,
  TRUST_ERROR_CODES,
  TRUST_EVENTS,
  TRUST_POLICY_KEYS,
  trustDocumentStatusKey,
  trustDocumentTypeNameKey,
  trustErrorKey,
  trustReasonNameKey,
  trustRequirementInstructionsKey,
  trustRequirementNameKey,
  trustRequirementStatusKey,
  trustScanStatusKey,
  trustVerificationStatusKey,
  TrustCaseDetailResponse,
  TrustCaseListResponse,
  TrustDownloadResponse,
  TrustPolicyResponse,
  TrustRequirementDecisionResponse,
  DocumentUploadAuthorizationResponse,
  ProviderVerificationResponse,
  VerificationDocumentListResponse,
  VerificationDocumentResponse,
  ExternalVerificationResponse,
  type TrustErrorCode,
  type TrustOverallStatus,
} from '@bananagig/contracts';
import { AccountError, type AccountContext, type AccountService } from '@bananagig/accounts';
import { ProviderError, UnavailablePrerequisites, type AccountFacts, type PrerequisitePort } from '@bananagig/provider';
import { TrustError, type TrustService } from '@bananagig/trust';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { isNoStorePath } from './plugins/errors';
import { documentDto, policyDto, safeDetails, toAppError, uploadDto, verificationDto, caseDetailDto, caseSummaryDto, decisionDto } from './modules/trust/dto';
import { TRUST_BODY_LIMIT } from './modules/trust/routes';
import { createProviderContextPort, createTrustPolicyProvider, createTrustPrerequisites } from './modules/trust/wiring';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const root = path.resolve(__dirname, '../../..');
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- fakes
const svc = {
  getVerification: vi.fn(),
  openVerification: vi.fn(),
  listDocuments: vi.fn(),
  requestUpload: vi.fn(),
  finalizeDocument: vi.fn(),
  withdrawDocument: vi.fn(),
  submitVerification: vi.fn(),
  cancelVerification: vi.fn(),
  reverifyRequirement: vi.fn(),
  startExternalVerification: vi.fn(),
  refreshExternalVerification: vi.fn(),
  listCases: vi.fn(),
  getCase: vi.fn(),
  downloadDocument: vi.fn(),
  startReview: vi.fn(),
  approveRequirement: vi.fn(),
  rejectRequirement: vi.fn(),
  requestAction: vi.fn(),
  getPolicy: vi.fn(),
  setRequirementStatus: vi.fn(),
  setRequirementRule: vi.fn(),
};
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn() };
const noServiceCalled = () => Object.values(svc).every((f) => f.mock.calls.length === 0);

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const OTHER_SUB = 'kc-subject-marker-other-91d3';
const ADMIN_SUB = 'staff-reviewer-42';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const CASE_ID = '9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
const OTHER_CASE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const REQ_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const DOC_ID = '7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const ISO = '2026-10-16T12:00:00.000Z';
const FUTURE = '2027-06-01T00:00:00.000Z';
const OBJECT_KEY = `trust/evidence/${CASE_ID}/${DOC_ID}`;
const HASH = 'abcdef0123456789'.repeat(4);
const EXTERNAL_ID = 'ext-sentinel-0042';
const SECRET_LINK = 'https://object-store.sentinel.example/secret-link-0042';
/** Values the fakes carry: NONE of them may ever appear in a PROVIDER response. */
const PROVIDER_SENTINELS = [
  'sentinel.mail@sentinel-contact.example',
  's***l@sentinel-contact.example',
  '+15550001234',
  'Sentinel-First-Name',
  'Sentinel-Last-Name',
  OBJECT_KEY,
  'trust/evidence/',
  HASH,
  EXTERNAL_ID,
  SECRET_LINK,
  SUB,
  KEYCLOAK_SID,
];
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };

const state = { memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }] as { code: string; status: 'PENDING' | 'ACTIVE' | 'INACTIVE' }[] };
const resetState = () => {
  state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
};
const makeContext = (accountId: string): AccountContext =>
  ({
    accountId,
    status: 'ACTIVE',
    roles: state.memberships.filter((m) => m.status === 'ACTIVE').map((m) => (m.code === 'PROVIDER' ? PROVIDER : CUSTOMER)),
    memberships: state.memberships,
    primaryRole: 'CUSTOMER',
    activeRole: 'CUSTOMER',
    profile: { firstName: 'Sentinel-First-Name', lastName: 'Sentinel-Last-Name', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' },
    email: { emailVerificationStatus: 'VERIFIED', primary: { address: 's***l@sentinel-contact.example' }, pending: null },
    phone: { phoneVerificationStatus: 'VERIFIED', primary: { number: '+15550001234' }, pending: null },
    contacts: { emailVerified: true, phoneVerified: true, contactsVerified: true },
    createdAt: T0,
    created: false,
  }) as unknown as AccountContext;

// ---- service results (the shapes of packages/trust/src/types.ts)
const docView = (over: Record<string, unknown> = {}) => ({
  verificationDocumentId: DOC_ID,
  caseRequirementId: REQ_ID,
  documentTypeCode: 'drivers_license',
  status: 'ATTACHED',
  scanStatus: 'CLEAN',
  mimeType: 'application/pdf',
  sizeBytes: 1234,
  round: null,
  createdAt: ISO,
  submittedAt: null,
  sha256: null,
  ...over,
});
const reqView = (over: Record<string, unknown> = {}) => ({
  caseRequirementId: REQ_ID,
  requirementCode: 'identity_verification',
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  status: 'ACTION_REQUIRED',
  cycle: 1,
  round: 1,
  expiresAt: null,
  reasonCode: 'DOCUMENT_UNREADABLE',
  canAttachEvidence: true,
  canReverify: false,
  documentTypes: ['drivers_license', 'passport', 'state_id'],
  documents: [docView()],
  ...over,
});
const verificationView = (over: Record<string, unknown> = {}) => ({
  prerequisiteMet: true,
  case: { verificationCaseId: CASE_ID, caseNumber: 1, status: 'ACTION_REQUIRED', revision: 3, openedAt: ISO, submittedAt: ISO },
  overall: {
    status: 'ACTION_REQUIRED',
    verificationComplete: false,
    requiredCount: 1,
    approvedCount: 0,
    missing: [],
    actionRequired: ['identity_verification'],
    expired: [],
  },
  requirements: [reqView()],
  ...over,
});
const uploadView = () => ({
  document: docView({ status: 'UPLOAD_PENDING', scanStatus: 'PENDING' }),
  upload: { url: 'memory://upload/one-time', headers: { 'content-type': 'application/pdf', 'content-length': '1234' }, expiresAt: ISO },
});
const externalView = () => ({ requirementCode: 'background_check', adapter: 'fake', status: 'PENDING', lastCheckedAt: null });
const reviewView = (over: Record<string, unknown> = {}) => ({
  reviewId: '11111111-2222-4333-8444-555555555555',
  caseRequirementId: REQ_ID,
  round: 1,
  decision: 'REJECTED',
  reasonCode: 'DOCUMENT_UNREADABLE',
  reviewer: 'admin:staff-1',
  expiresAt: null,
  reviewedAt: ISO,
  ...over,
});
const adminReq = (over: Record<string, unknown> = {}) => ({
  caseRequirementId: REQ_ID,
  requirementCode: 'identity_verification',
  requirementType: 'IDENTITY',
  evidenceKind: 'DOCUMENT',
  status: 'PENDING',
  cycle: 1,
  round: 1,
  approvedAt: null,
  expiresAt: null,
  superseded: false,
  reviews: [reviewView()],
  documents: [docView({ status: 'SUBMITTED', round: 1, submittedAt: ISO, sha256: HASH })],
  external: null,
  ...over,
});
const caseSummary = (over: Record<string, unknown> = {}) => ({
  verificationCaseId: CASE_ID,
  accountId: ACCOUNT_ID,
  caseNumber: 1,
  status: 'IN_REVIEW',
  submittedAt: ISO,
  updatedAt: ISO,
  requirementCount: 1,
  awaitingReviewCount: 1,
  ...over,
});
const caseDetail = () => ({ case: { ...caseSummary(), revision: 4, openedAt: ISO, decidedAt: null }, requirements: [adminReq()] });
const decisionView = () => ({ requirement: adminReq({ status: 'IN_REVIEW' }), caseStatus: 'IN_REVIEW', changed: true });
const policyView = () => ({
  requirements: [
    { code: 'identity_verification', requirementType: 'IDENTITY', evidenceKind: 'DOCUMENT', expiryRequired: false, status: 'ACTIVE' },
    { code: 'background_check', requirementType: 'BACKGROUND_CHECK', evidenceKind: 'EXTERNAL', expiryRequired: true, status: 'INACTIVE' },
  ],
  rules: [{ requirementCode: 'identity_verification', marketCode: null, serviceTypeCode: null, enabled: true }],
  documentTypes: [{ code: 'drivers_license', requirementType: 'IDENTITY' }],
});

// ---------------------------------------------------------------- tokens and requests
const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims } });
const adminToken = (roles: string[] = [], over: Record<string, unknown> = {}) =>
  signToken(keys, {
    claims: {
      sub: ADMIN_SUB,
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
      ...over,
    },
  });
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Reply {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}
const PROVIDER_PREFIX = '/api/v1/provider/verification';
const ADMIN_PREFIX = '/api/v1/admin/trust';
const send = (
  prefix: string,
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url: `${prefix}${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const call = (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  send(PROVIDER_PREFIX, method, url, token, payload, headers, target);
const acall = (method: Method, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  send(ADMIN_PREFIX, method, url, token, payload, headers, target);
const rawBody = (prefix: string, method: Method, url: string, token: string | undefined, text: string, contentType = 'application/json'): Promise<Reply> =>
  app.inject({
    method,
    url: `${prefix}${url}`,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: text,
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');
const keysOf = (o: object) => Object.keys(o).sort();
const dataOf = (r: Reply) => (r.json() as { data: Record<string, unknown> }).data;
const identityOf = (sub: string) => ({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: sub, identityRoles: ['customer'] });
const expectNoSentinel = (r: Reply) => {
  for (const s of PROVIDER_SENTINELS) expect(r.body, `leaked ${s}`).not.toContain(s);
};

// ---------------------------------------------------------------- the 11 provider operations
type Fn = keyof typeof svc;
interface Route {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  body?: unknown;
  /** a body sent when the route has no required one */
  send?: unknown;
  okStatus: number;
  fn: Fn;
}
const UPLOAD_BODY = { requirementCode: 'identity_verification', documentTypeCode: 'drivers_license', mimeType: 'application/pdf', sizeBytes: 1234 };
const SUBMIT_BODY = { expectedRevision: 3 };
const ROUTES: Route[] = [
  { operationId: 'getProviderVerification', method: 'GET', url: '', spec: `${PROVIDER_PREFIX}`, okStatus: 200, fn: 'getVerification' },
  { operationId: 'openProviderVerification', method: 'POST', url: '', spec: `${PROVIDER_PREFIX}`, send: {}, okStatus: 201, fn: 'openVerification' },
  {
    operationId: 'listProviderVerificationDocuments',
    method: 'GET',
    url: '/documents',
    spec: `${PROVIDER_PREFIX}/documents`,
    okStatus: 200,
    fn: 'listDocuments',
  },
  {
    operationId: 'requestProviderVerificationUpload',
    method: 'POST',
    url: '/documents/upload',
    spec: `${PROVIDER_PREFIX}/documents/upload`,
    body: UPLOAD_BODY,
    okStatus: 201,
    fn: 'requestUpload',
  },
  {
    operationId: 'finalizeProviderVerificationDocument',
    method: 'POST',
    url: `/documents/${DOC_ID}/finalize`,
    spec: `${PROVIDER_PREFIX}/documents/{id}/finalize`,
    send: {},
    okStatus: 200,
    fn: 'finalizeDocument',
  },
  {
    operationId: 'withdrawProviderVerificationDocument',
    method: 'POST',
    url: `/documents/${DOC_ID}/withdraw`,
    spec: `${PROVIDER_PREFIX}/documents/{id}/withdraw`,
    send: {},
    okStatus: 200,
    fn: 'withdrawDocument',
  },
  {
    operationId: 'submitProviderVerification',
    method: 'POST',
    url: '/submit',
    spec: `${PROVIDER_PREFIX}/submit`,
    body: SUBMIT_BODY,
    okStatus: 200,
    fn: 'submitVerification',
  },
  {
    operationId: 'cancelProviderVerification',
    method: 'POST',
    url: '/cancel',
    spec: `${PROVIDER_PREFIX}/cancel`,
    send: {},
    okStatus: 200,
    fn: 'cancelVerification',
  },
  {
    operationId: 'reverifyProviderRequirement',
    method: 'POST',
    url: '/requirements/identity_verification/reverify',
    spec: `${PROVIDER_PREFIX}/requirements/{code}/reverify`,
    send: {},
    okStatus: 200,
    fn: 'reverifyRequirement',
  },
  {
    operationId: 'startProviderExternalVerification',
    method: 'POST',
    url: '/requirements/background_check/external',
    spec: `${PROVIDER_PREFIX}/requirements/{code}/external`,
    send: {},
    okStatus: 200,
    fn: 'startExternalVerification',
  },
  {
    operationId: 'refreshProviderExternalVerification',
    method: 'POST',
    url: '/requirements/background_check/external/refresh',
    spec: `${PROVIDER_PREFIX}/requirements/{code}/external/refresh`,
    send: {},
    okStatus: 200,
    fn: 'refreshExternalVerification',
  },
];
const BODY_ROUTES = ROUTES.filter((r) => r.body !== undefined);
const WRITE_ROUTES = ROUTES.filter((r) => r.method !== 'GET');
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  call(r.method, r.url, token, r.body ?? r.send, headers, target);

// ---------------------------------------------------------------- the 10 administrator operations
type Perm = 'read' | 'review' | 'admin';
interface ARoute {
  operationId: string;
  method: Method;
  url: string;
  spec: string;
  perm: Perm;
  body?: unknown;
  fn: Fn;
}
const APPROVE_BODY = { round: 1, expiresAt: FUTURE };
const REASON_BODY = { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' };
const RULE_BODY = { requirementCode: 'identity_verification', marketCode: null, serviceTypeCode: null, enabled: true };
const AROUTES: ARoute[] = [
  { operationId: 'listTrustCases', method: 'GET', url: '/cases', spec: `${ADMIN_PREFIX}/cases`, perm: 'read', fn: 'listCases' },
  { operationId: 'getTrustCase', method: 'GET', url: `/cases/${CASE_ID}`, spec: `${ADMIN_PREFIX}/cases/{id}`, perm: 'read', fn: 'getCase' },
  {
    operationId: 'downloadTrustDocument',
    method: 'GET',
    url: `/documents/${DOC_ID}/download`,
    spec: `${ADMIN_PREFIX}/documents/{id}/download`,
    perm: 'review',
    fn: 'downloadDocument',
  },
  {
    operationId: 'startTrustReview',
    method: 'POST',
    url: `/requirements/${REQ_ID}/start-review`,
    spec: `${ADMIN_PREFIX}/requirements/{id}/start-review`,
    perm: 'review',
    body: { round: 1 },
    fn: 'startReview',
  },
  {
    operationId: 'approveTrustRequirement',
    method: 'POST',
    url: `/requirements/${REQ_ID}/approve`,
    spec: `${ADMIN_PREFIX}/requirements/{id}/approve`,
    perm: 'review',
    body: APPROVE_BODY,
    fn: 'approveRequirement',
  },
  {
    operationId: 'rejectTrustRequirement',
    method: 'POST',
    url: `/requirements/${REQ_ID}/reject`,
    spec: `${ADMIN_PREFIX}/requirements/{id}/reject`,
    perm: 'review',
    body: REASON_BODY,
    fn: 'rejectRequirement',
  },
  {
    operationId: 'requestTrustAction',
    method: 'POST',
    url: `/requirements/${REQ_ID}/request-action`,
    spec: `${ADMIN_PREFIX}/requirements/{id}/request-action`,
    perm: 'review',
    body: REASON_BODY,
    fn: 'requestAction',
  },
  { operationId: 'getTrustPolicy', method: 'GET', url: '/policy', spec: `${ADMIN_PREFIX}/policy`, perm: 'admin', fn: 'getPolicy' },
  {
    operationId: 'setTrustRequirementStatus',
    method: 'PUT',
    url: '/requirement-definitions/identity_verification/status',
    spec: `${ADMIN_PREFIX}/requirement-definitions/{code}/status`,
    perm: 'admin',
    body: { status: 'INACTIVE' },
    fn: 'setRequirementStatus',
  },
  {
    operationId: 'setTrustRequirementRule',
    method: 'PUT',
    url: '/requirement-rules',
    spec: `${ADMIN_PREFIX}/requirement-rules`,
    perm: 'admin',
    body: RULE_BODY,
    fn: 'setRequirementRule',
  },
];
const ABODY_ROUTES = AROUTES.filter((r) => r.body !== undefined);
const aCall = (r: ARoute, token?: string, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  acall(r.method, r.url, token, r.body, headers, target);

// ---------------------------------------------------------------- the apps
const baseDeps = (): AppDeps => ({
  cfg,
  verifier,
  configuration: {} as never,
  accounts: accountSvc as unknown as AccountService,
  trust: svc as unknown as TrustService,
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
  resetState();
  for (const f of [...Object.values(svc), ...Object.values(accountSvc)]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (identity: { subject: string }, o: { requestedRole?: string } = {}) => {
    if (o.requestedRole !== undefined) {
      const m = state.memberships.find((x) => x.code === o.requestedRole);
      if (!m) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold the role', { role: o.requestedRole });
      if (m.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: o.requestedRole });
    }
    return makeContext(identity.subject === OTHER_SUB ? OTHER_ACCOUNT_ID : ACCOUNT_ID);
  });
  svc.getVerification.mockImplementation(async () => verificationView());
  svc.openVerification.mockImplementation(async () => ({ created: true, view: verificationView() }));
  svc.listDocuments.mockImplementation(async () => [docView(), docView({ status: 'WITHDRAWN' })]);
  svc.requestUpload.mockImplementation(async () => uploadView());
  svc.finalizeDocument.mockImplementation(async () => docView());
  svc.withdrawDocument.mockImplementation(async () => docView({ status: 'WITHDRAWN' }));
  svc.submitVerification.mockImplementation(async () => ({ changed: true, view: verificationView() }));
  svc.cancelVerification.mockImplementation(async () => ({ changed: true, view: verificationView({ case: null }) }));
  svc.reverifyRequirement.mockImplementation(async () => verificationView());
  svc.startExternalVerification.mockImplementation(async () => externalView());
  svc.refreshExternalVerification.mockImplementation(async () => externalView());
  svc.listCases.mockImplementation(async () => [caseSummary()]);
  svc.getCase.mockImplementation(async () => caseDetail());
  svc.downloadDocument.mockImplementation(async () => ({ url: SECRET_LINK, expiresAt: ISO }));
  for (const f of ['startReview', 'approveRequirement', 'rejectRequirement', 'requestAction'] as const) svc[f].mockImplementation(async () => decisionView());
  svc.getPolicy.mockImplementation(async () => policyView());
  svc.setRequirementStatus.mockImplementation(async () => ({ code: 'identity_verification', status: 'INACTIVE', changed: true }));
  svc.setRequirementRule.mockImplementation(async () => ({ ...RULE_BODY, changed: true }));
});

const ADMIN_ALL = ['trust-read', 'trust-review', 'trust-admin'];
/** A token that passes every admin guard (all three roles). */
const superAdmin = () => adminToken(ADMIN_ALL);

// ====================================================================== provider: authentication and the account guard
describe('provider verification API authentication and the account guard', () => {
  it.each(ROUTES)('$method $url ($operationId) requires a token: 401, no-store, before any service or account call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$method $url ($operationId) rejects every kind of invalid token with 401 invalid_token', async (r) => {
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
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ROUTES)(
    '$method $url ($operationId) refuses the admin identity context (even with every trust role) and any other client with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED',
    async (r) => {
      for (const t of [await adminToken(), await superAdmin()]) {
        const admin = await routeCall(r, t);
        expect(admin.statusCode).toBe(403);
        expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
        expectNoStore(admin);
      }
      for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) {
        const res = await routeCall(r, await webToken({ azp }));
        expect(res.statusCode, azp).toBe(403);
        expect(errorOf(res).code).toBe('ACCOUNT_CONTEXT_NOT_SUPPORTED');
        expectNoStore(res);
      }
      expect(noServiceCalled()).toBe(true);
      expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('$method $url ($operationId) passes a suspended or closed account through as 403 and never calls the service', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 before 400 and 403 before 400: an invalid body or parameter without a token or with the admin token', async () => {
    for (const r of BODY_ROUTES)
      for (const body of [{ garbage: true }, [], 'text', 7, null]) {
        expect((await rawBody(PROVIDER_PREFIX, r.method, r.url, undefined, JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(PROVIDER_PREFIX, r.method, r.url, 'bad.token', JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(PROVIDER_PREFIX, r.method, r.url, await adminToken(), JSON.stringify(body))).statusCode, r.url).toBe(403);
      }
    for (const url of ['/documents/not-a-uuid/finalize', '/documents/not-a-uuid/withdraw', '/requirements/BAD/reverify', '/requirements/BAD/external']) {
      expect((await call('POST', url, undefined, {})).statusCode, url).toBe(401);
      expect((await call('POST', url, await adminToken(), {})).statusCode, url).toBe(403);
    }
    for (const url of ['?accountId=x', '/documents?caseId=x']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
      expect((await call('GET', url, await adminToken())).statusCode, url).toBe(403);
    }
    expect(noServiceCalled()).toBe(true);
  });

  it.each(ROUTES)(
    '$method $url ($operationId) is open to a web customer who is NOT a provider (the registration, not a role, is the prerequisite)',
    async (r) => {
      state.memberships = [{ code: 'CUSTOMER', status: 'ACTIVE' }];
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, res.body).toBe(r.okStatus);
      expect(svc[r.fn]).toHaveBeenCalledTimes(1);
      expectNoStore(res);
    },
  );

  it.each(ROUTES)(
    '$method $url ($operationId) does NOT honour x-active-role: a PENDING, INACTIVE or unheld PROVIDER role in the header is not a 403',
    async (r) => {
      for (const memberships of [
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'PENDING' },
        ],
        [
          { code: 'CUSTOMER', status: 'ACTIVE' },
          { code: 'PROVIDER', status: 'INACTIVE' },
        ],
        [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      ] as (typeof state.memberships)[]) {
        state.memberships = memberships;
        for (const header of ['PROVIDER', 'CUSTOMER', 'ADMIN', 'PROVIDER,CUSTOMER']) {
          svc[r.fn].mockClear();
          const res = await routeCall(r, await webToken(), { 'x-active-role': header });
          expect(res.statusCode, `${header} ${JSON.stringify(memberships)} ${res.body}`).toBeLessThan(300);
          expect(svc[r.fn]).toHaveBeenCalledTimes(1);
        }
      }
      for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].requestedRole).toBeUndefined();
    },
  );
});

// ====================================================================== provider: the account of the token, never of the client
describe('the service is called with the account of the verified token only', () => {
  it.each(ROUTES)('$method $url ($operationId): the first argument is the token account; the identity the guard saw is the token subject', async (r) => {
    await routeCall(r, await webToken());
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(identityOf(SUB));
    const other = await routeCall(r, await webToken({ sub: OTHER_SUB }));
    expect(other.statusCode).toBeLessThan(300);
    expect(svc[r.fn].mock.calls[1]![0]).toBe(OTHER_ACCOUNT_ID);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[1]![0]).toEqual(identityOf(OTHER_SUB));
  });

  it.each(ROUTES)('$method $url ($operationId): an account id, case id or role in a header, the query or the cookie changes nothing', async (r) => {
    const headers = {
      'x-account-id': OTHER_ACCOUNT_ID,
      'x-verification-case-id': OTHER_CASE_ID,
      'x-forwarded-user': OTHER_SUB,
      'x-reviewer': 'admin:someone',
      cookie: `accountId=${OTHER_ACCOUNT_ID}; verificationCaseId=${OTHER_CASE_ID}`,
    };
    const res = await call(r.method, r.url, await webToken(), r.body ?? r.send, headers);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_CASE_ID);
    expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain('someone');
    expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
  });

  it.each(ROUTES)(
    '$method $url ($operationId): an account id, case id, status or decision in the QUERY never reaches the service (the GET reads reject it with 400; the writes ignore it)',
    async (r) => {
      for (const q of [
        `accountId=${OTHER_ACCOUNT_ID}`,
        `verificationCaseId=${OTHER_CASE_ID}`,
        'status=APPROVED',
        'approved=true',
        'requirementCode=identity_verification',
        'sha256=abc',
      ]) {
        svc[r.fn].mockClear();
        const res = await call(r.method, `${r.url}?${q}`, await webToken(), r.body ?? r.send);
        expectNoStore(res);
        if (r.method === 'GET') {
          expect(res.statusCode, `${r.url}?${q}: ${res.body}`).toBe(400);
          expect(errorOf(res).code).toBe('VALIDATION_FAILED');
          expect(svc[r.fn]).not.toHaveBeenCalled();
        } else {
          expect(res.statusCode, `${r.url}?${q}: ${res.body}`).toBeLessThan(300);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_CASE_ID);
          expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain('APPROVED');
          expect(svc[r.fn].mock.calls[0]![0]).toBe(ACCOUNT_ID);
        }
      }
    },
  );

  it.each(WRITE_ROUTES)('$method $url ($operationId): an account, case, requirement, status or decision in the BODY is a 400', async (r) => {
    for (const extra of [
      { accountId: OTHER_ACCOUNT_ID },
      { account_id: OTHER_ACCOUNT_ID },
      { verificationCaseId: OTHER_CASE_ID },
      { caseRequirementId: REQ_ID },
      { requirementCode: 'background_check' },
      { status: 'APPROVED' },
      { approved: true },
      { verified: true },
      { goLive: true },
      { decision: 'APPROVED' },
      { reviewer: 'admin:me' },
      { scanStatus: 'CLEAN' },
      { objectKey: OBJECT_KEY },
      { round: 1 },
    ]) {
      // the upload body already names a requirementCode: replacing it by another code is still a valid body there
      if (r.fn === 'requestUpload' && 'requirementCode' in extra) continue;
      const res = await call(r.method, r.url, await webToken(), { ...((r.body as object | undefined) ?? {}), ...extra });
      expect(res.statusCode, `${JSON.stringify(extra)} ${res.body}`).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
      expectNoStore(res);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('the service receives the parsed contract and nothing else', async () => {
    await call('POST', '/documents/upload', await webToken(), UPLOAD_BODY);
    expect(svc.requestUpload.mock.calls[0]).toEqual([ACCOUNT_ID, UPLOAD_BODY]);
    await call('POST', `/documents/${DOC_ID}/finalize`, await webToken());
    await call('POST', `/documents/${DOC_ID}/finalize`, await webToken(), {});
    await rawBody(PROVIDER_PREFIX, 'POST', `/documents/${DOC_ID}/finalize`, await webToken(), 'null');
    await call('POST', `/documents/${DOC_ID}/finalize`, await webToken(), { sha256: HASH });
    expect(svc.finalizeDocument.mock.calls).toEqual([
      [ACCOUNT_ID, DOC_ID, {}],
      [ACCOUNT_ID, DOC_ID, {}],
      [ACCOUNT_ID, DOC_ID, {}],
      [ACCOUNT_ID, DOC_ID, { sha256: HASH }],
    ]);
    await call('POST', `/documents/${DOC_ID}/withdraw`, await webToken());
    expect(svc.withdrawDocument.mock.calls[0]).toEqual([ACCOUNT_ID, DOC_ID]);
    await call('POST', '/submit', await webToken(), SUBMIT_BODY);
    expect(svc.submitVerification.mock.calls[0]).toEqual([ACCOUNT_ID, SUBMIT_BODY]);
    await call('POST', '/cancel', await webToken());
    expect(svc.cancelVerification.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('POST', '/requirements/identity_verification/reverify', await webToken());
    expect(svc.reverifyRequirement.mock.calls[0]).toEqual([ACCOUNT_ID, 'identity_verification']);
    await call('POST', '/requirements/background_check/external', await webToken());
    expect(svc.startExternalVerification.mock.calls[0]).toEqual([ACCOUNT_ID, 'background_check']);
    await call('POST', '/requirements/background_check/external/refresh', await webToken());
    expect(svc.refreshExternalVerification.mock.calls[0]).toEqual([ACCOUNT_ID, 'background_check']);
    await call('GET', '', await webToken());
    expect(svc.getVerification.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('POST', '', await webToken());
    expect(svc.openVerification.mock.calls[0]).toEqual([ACCOUNT_ID]);
    await call('GET', '/documents', await webToken());
    expect(svc.listDocuments.mock.calls[0]).toEqual([ACCOUNT_ID]);
    for (const s of PROVIDER_SENTINELS.filter((x) => x !== HASH)) expect(JSON.stringify(Object.values(svc).flatMap((f) => f.mock.calls))).not.toContain(s);
    // the guard asked for no profile (verification does not need the name)
    for (const c of accountSvc.ensureAccountForIdentity.mock.calls) expect(c[1].includeProfile).toBeFalsy();
  });
});

// ====================================================================== cache policy
describe('Cache-Control: no-store on every response of both prefixes', () => {
  it.each(ROUTES)('provider $method $url ($operationId): success, every service error and an unexpected failure are all no-store', async (r) => {
    expectNoStore(await routeCall(r, await webToken()));
    for (const code of TRUST_ERROR_CODES) {
      svc[r.fn].mockRejectedValueOnce(new TrustError(code, 'x'));
      expectNoStore(await routeCall(r, await webToken()));
    }
    svc[r.fn].mockRejectedValueOnce(new Error('kaboom'));
    const boom = await routeCall(r, await webToken());
    expect(boom.statusCode).toBe(500);
    expectNoStore(boom);
  });

  it.each(AROUTES)('admin $method $url ($operationId): success, every service error and an unexpected failure are all no-store', async (r) => {
    const t = await superAdmin();
    expectNoStore(await aCall(r, t));
    for (const code of TRUST_ERROR_CODES) {
      svc[r.fn].mockRejectedValueOnce(new TrustError(code, 'x'));
      expectNoStore(await aCall(r, t));
    }
    svc[r.fn].mockRejectedValueOnce(new Error('kaboom'));
    const boom = await aCall(r, t);
    expect(boom.statusCode).toBe(500);
    expectNoStore(boom);
  });

  it('401, 403 and 400 are no-store on both prefixes', async () => {
    expectNoStore(await call('GET', ''));
    expectNoStore(await call('GET', '', 'bad.token'));
    expectNoStore(await call('GET', '', await adminToken()));
    expectNoStore(await call('POST', '/submit', await webToken(), {}));
    expectNoStore(await call('GET', '?x=1', await webToken()));
    expectNoStore(await acall('GET', '/cases'));
    expectNoStore(await acall('GET', '/cases', 'bad.token'));
    expectNoStore(await acall('GET', '/cases', await adminToken()));
    expectNoStore(await acall('GET', '/cases', await webToken()));
    expectNoStore(await acall('GET', '/cases?limit=0', await superAdmin()));
    expectNoStore(await acall('POST', `/requirements/${REQ_ID}/approve`, await superAdmin(), {}));
  });

  it('router-level failures under the provider prefix are no-store too: unknown paths, wrong methods, a trailing slash and an undecodable URL', async () => {
    for (const [m, u] of [
      ['GET', '/'],
      ['GET', '/nope'],
      ['GET', '/documents/nope'],
      ['GET', '/documents/upload'],
      ['POST', '/documents'],
      ['DELETE', ''],
      ['PUT', ''],
      ['PATCH', '/submit'],
      ['GET', '/submit'],
      ['GET', '/cancel'],
      ['PUT', '/submit'],
      ['GET', `/documents/${DOC_ID}/finalize`],
      ['GET', '/requirements/identity_verification/reverify'],
      ['POST', '/requirements/identity_verification'],
      ['POST', '/requirements/identity_verification/external/nope'],
    ] as const) {
      const anon = await call(m, u);
      expect(anon.statusCode, `${m} ${u}`).toBe(404);
      expect(errorOf(anon).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(anon);
      expectNoStore(await call(m, u, await webToken()));
      expectNoStore(await call(m, u, await adminToken()));
    }
    const bad = await app.inject({ method: 'GET', url: `${PROVIDER_PREFIX}/%E0%A4%A` });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('BAD_URL');
    expectNoStore(bad);
    const upper = await app.inject({ method: 'GET', url: '/API/V1/PROVIDER/VERIFICATION' });
    expect(upper.statusCode).toBe(404);
    expectNoStore(upper);
    expect(noServiceCalled()).toBe(true);
  });

  it('router-level failures under the admin prefix are no-store too: unknown paths, wrong methods and an undecodable URL', async () => {
    for (const [m, u] of [
      ['GET', ''],
      ['GET', '/'],
      ['GET', '/nope'],
      ['DELETE', '/cases'],
      ['POST', '/cases'],
      ['PUT', '/cases'],
      ['PATCH', `/cases/${CASE_ID}`],
      ['POST', `/cases/${CASE_ID}`],
      ['PUT', '/policy'],
      ['POST', '/policy'],
      ['GET', `/requirements/${REQ_ID}/approve`],
      ['PUT', `/requirements/${REQ_ID}/approve`],
      ['GET', '/requirement-rules'],
      ['POST', '/requirement-rules'],
      ['GET', '/requirement-definitions/identity_verification/status'],
      ['POST', '/requirement-definitions/identity_verification/status'],
      ['POST', `/documents/${DOC_ID}/download`],
      ['GET', `/documents/${DOC_ID}`],
    ] as const) {
      const anon = await acall(m, u);
      expect(anon.statusCode, `${m} ${u}`).toBe(404);
      expect(errorOf(anon).code).toBe('ROUTE_NOT_FOUND');
      expectNoStore(anon);
      expectNoStore(await acall(m, u, await superAdmin()));
      expectNoStore(await acall(m, u, await webToken()));
    }
    const bad = await app.inject({ method: 'GET', url: `${ADMIN_PREFIX}/cases/%E0%A4%A` });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('BAD_URL');
    expectNoStore(bad);
    const upper = await app.inject({ method: 'GET', url: '/API/V1/ADMIN/TRUST/cases' });
    expect(upper.statusCode).toBe(404);
    expectNoStore(upper);
    expect(noServiceCalled()).toBe(true);
  });

  it('isNoStorePath covers exactly the prefixes (and is case- and query-insensitive), not look-alikes', () => {
    for (const u of [
      '/api/v1/admin/trust',
      '/api/v1/admin/trust/',
      '/api/v1/admin/trust/cases?limit=1',
      '/API/V1/ADMIN/TRUST/cases',
      '/api/v1/admin/trust#x',
      '/api/v1/provider',
      '/api/v1/provider/verification',
      '/api/v1/provider/verification/documents',
      // PRO-002: the public profile routes are a prefix of their own (their errors are never stored; the photo sets its own policy on success)
      '/api/v1/providers',
      '/api/v1/providers/9b1f2c3d-4e5a-4b6c-8d7e-0f1a2b3c4d5e/photo',
      '/api/v1/account/me',
      '/api/v1/auth/x',
    ])
      expect(isNoStorePath(u), u).toBe(true);
    for (const u of [
      '/api/v1/admin/trustee',
      '/api/v1/admin/trust-x/cases',
      '/api/v1/admin',
      '/api/v1/admin/',
      '/api/v1/providersx',
      '/api/v1/provider-x',
      '/api/v1/catalog/categories',
    ])
      expect(isNoStorePath(u), u).toBe(false);
  });
});

// ====================================================================== provider: status codes and response shapes
describe('provider status codes and response shapes', () => {
  it('POST "" answers 201 when the case was opened and 200 when it already existed or policy requires nothing', async () => {
    const created = await call('POST', '', await webToken());
    expect(created.statusCode, created.body).toBe(201);
    svc.openVerification.mockResolvedValueOnce({ created: false, view: verificationView() });
    const resumed = await call('POST', '', await webToken());
    expect(resumed.statusCode, resumed.body).toBe(200);
    svc.openVerification.mockResolvedValueOnce({ created: false, view: verificationView({ case: null, requirements: [] }) });
    const nothing = await call('POST', '', await webToken(), {});
    expect(nothing.statusCode).toBe(200);
    expect(dataOf(nothing).case).toBeNull();
    for (const r of [created, resumed, nothing]) expect(ProviderVerificationResponse.safeParse(r.json()).success, r.body).toBe(true);
  });

  it('upload answers 201; every other operation answers 200', async () => {
    for (const r of ROUTES.filter((x) => x.fn !== 'openVerification')) {
      const want = r.fn === 'requestUpload' ? 201 : 200;
      expect((await routeCall(r, await webToken())).statusCode, r.operationId).toBe(want);
    }
  });

  const CASE_KEYS = ['caseNumber', 'openedAt', 'revision', 'status', 'statusKey', 'submittedAt', 'verificationCaseId'];
  const OVERALL_KEYS = ['actionRequired', 'approvedCount', 'expired', 'missing', 'requiredCount', 'status', 'statusKey', 'verificationComplete'];
  const REQ_KEYS = [
    'canAttachEvidence',
    'canReverify',
    'caseRequirementId',
    'cycle',
    'documentTypes',
    'documents',
    'evidenceKind',
    'expiresAt',
    'instructionsKey',
    'nameKey',
    'reasonCode',
    'reasonKey',
    'requirementCode',
    'requirementType',
    'round',
    'status',
    'statusKey',
  ];
  const DOC_KEYS = [
    'createdAt',
    'documentTypeCode',
    'documentTypeNameKey',
    'mimeType',
    'round',
    'scanStatus',
    'scanStatusKey',
    'sizeBytes',
    'status',
    'statusKey',
    'submittedAt',
    'verificationDocumentId',
  ];
  const VERIFICATION_ROUTES = ROUTES.filter((r) =>
    ['getVerification', 'openVerification', 'submitVerification', 'cancelVerification', 'reverifyRequirement'].includes(r.fn),
  );

  it.each(VERIFICATION_ROUTES)(
    '$operationId: exactly { data, meta: { correlationId } } with the five overview keys, the case, overall, requirement and document keys',
    async (r) => {
      const res = await routeCall(r, await webToken());
      const body = res.json() as { data: Record<string, unknown>; meta: object };
      expect(keysOf(body)).toEqual(['data', 'meta']);
      expect(keysOf(body.meta)).toEqual(['correlationId']);
      expect(keysOf(body.data)).toEqual(['case', 'goLive', 'overall', 'prerequisiteMet', 'requirements']);
      if (r.fn !== 'cancelVerification') expect(keysOf(body.data.case as object)).toEqual(CASE_KEYS);
      else expect(body.data.case).toBeNull();
      expect(keysOf(body.data.overall as object)).toEqual(OVERALL_KEYS);
      const reqs = body.data.requirements as Record<string, unknown>[];
      expect(reqs).toHaveLength(1);
      expect(keysOf(reqs[0]!)).toEqual(REQ_KEYS);
      expect(keysOf((reqs[0]!.documents as object[])[0]!)).toEqual(DOC_KEYS);
      expect(keysOf((reqs[0]!.documentTypes as object[])[0]!)).toEqual(['code', 'nameKey']);
      expect(body.data.goLive).toEqual({ evaluated: false, eligible: false });
      // the overall values are the service's, not constants
      expect(body.data.overall).toMatchObject({ verificationComplete: false, requiredCount: 1, approvedCount: 0, actionRequired: ['identity_verification'] });
      expect(ProviderVerificationResponse.safeParse(body).success).toBe(true);
      expectNoSentinel(res);
    },
  );

  it('the content keys of every status, document type, requirement and reason are derived by the contract helpers', async () => {
    const res = await call('GET', '', await webToken());
    const d = dataOf(res) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.case.statusKey).toBe(trustVerificationStatusKey('ACTION_REQUIRED'));
    expect(d.overall.statusKey).toBe(trustVerificationStatusKey('ACTION_REQUIRED'));
    const r = d.requirements[0];
    expect(r.nameKey).toBe(trustRequirementNameKey('identity_verification'));
    expect(r.instructionsKey).toBe(trustRequirementInstructionsKey('identity_verification'));
    expect(r.statusKey).toBe(trustRequirementStatusKey('ACTION_REQUIRED'));
    expect(r.reasonKey).toBe(trustReasonNameKey('DOCUMENT_UNREADABLE'));
    expect(r.documentTypes).toEqual(['drivers_license', 'passport', 'state_id'].map((code) => ({ code, nameKey: trustDocumentTypeNameKey(code) })));
    expect(r.documents[0].statusKey).toBe(trustDocumentStatusKey('ATTACHED'));
    expect(r.documents[0].scanStatusKey).toBe(trustScanStatusKey('CLEAN'));
    expect(r.documents[0].documentTypeNameKey).toBe(trustDocumentTypeNameKey('drivers_license'));
  });

  it('verificationComplete and the counts are what the service derived (an approved view reads complete)', async () => {
    svc.getVerification.mockResolvedValueOnce(
      verificationView({
        overall: { status: 'APPROVED', verificationComplete: true, requiredCount: 2, approvedCount: 2, missing: [], actionRequired: [], expired: [] },
      }),
    );
    expect(dataOf(await call('GET', '', await webToken())).overall).toMatchObject({
      status: 'APPROVED',
      verificationComplete: true,
      requiredCount: 2,
      approvedCount: 2,
    });
  });

  it('a requirement without a reason has a null reasonKey (never a key built from null)', async () => {
    svc.getVerification.mockResolvedValueOnce(verificationView({ requirements: [reqView({ reasonCode: null, status: 'PENDING' })] }));
    const d = dataOf(await call('GET', '', await webToken())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.requirements[0].reasonCode).toBeNull();
    expect(d.requirements[0].reasonKey).toBeNull();
  });

  it('a requirement the case does not hold yet keeps its null caseRequirementId', async () => {
    svc.getVerification.mockResolvedValueOnce(
      verificationView({
        case: null,
        requirements: [reqView({ caseRequirementId: null, status: 'NOT_STARTED', cycle: 0, round: 0, reasonCode: null, documents: [] })],
      }),
    );
    const d = dataOf(await call('GET', '', await webToken())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.requirements[0].caseRequirementId).toBeNull();
    expect(d.case).toBeNull();
  });

  it('documents list, finalize and withdraw: exactly the twelve document keys', async () => {
    const list = await call('GET', '/documents', await webToken());
    expect(keysOf(list.json() as object)).toEqual(['data', 'meta']);
    const items = dataOf(list) as unknown as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const i of items) expect(keysOf(i)).toEqual(DOC_KEYS);
    expect(VerificationDocumentListResponse.safeParse(list.json()).success).toBe(true);
    expectNoSentinel(list);
    for (const url of [`/documents/${DOC_ID}/finalize`, `/documents/${DOC_ID}/withdraw`]) {
      const res = await call('POST', url, await webToken());
      expect(keysOf(dataOf(res))).toEqual(DOC_KEYS);
      expect(VerificationDocumentResponse.safeParse(res.json()).success).toBe(true);
      expectNoSentinel(res);
    }
  });

  it('the upload authorization is the ONLY provider response with a url; it has exactly { document, upload: { method, url, headers, expiresAt } }', async () => {
    const res = await call('POST', '/documents/upload', await webToken(), UPLOAD_BODY);
    expect(res.statusCode).toBe(201);
    const d = dataOf(res) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(keysOf(d)).toEqual(['document', 'upload']);
    expect(keysOf(d.upload)).toEqual(['expiresAt', 'headers', 'method', 'url']);
    expect(d.upload.method).toBe('PUT');
    expect(d.upload.url).toBe('memory://upload/one-time');
    expect(d.upload.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': '1234' });
    expect(keysOf(d.document)).toEqual(DOC_KEYS);
    expect(d.document.status).toBe('UPLOAD_PENDING');
    expect(DocumentUploadAuthorizationResponse.safeParse(res.json()).success).toBe(true);
    // everything else of the 11 operations has no "url" anywhere
    for (const r of ROUTES.filter((x) => x.fn !== 'requestUpload')) {
      const other = await routeCall(r, await webToken());
      expect(other.body, r.operationId).not.toMatch(/"url"/);
      expect(other.body, r.operationId).not.toMatch(/https?:\/\//);
      expect(other.body, r.operationId).not.toContain('memory://');
    }
  });

  it('external start and refresh: exactly { requirementCode, adapter, status, lastCheckedAt }', async () => {
    for (const url of ['/requirements/background_check/external', '/requirements/background_check/external/refresh']) {
      const res = await call('POST', url, await webToken());
      expect(keysOf(dataOf(res))).toEqual(['adapter', 'lastCheckedAt', 'requirementCode', 'status']);
      expect(ExternalVerificationResponse.safeParse(res.json()).success).toBe(true);
    }
    svc.startExternalVerification.mockResolvedValueOnce({ ...externalView(), externalId: EXTERNAL_ID, payload: { x: 1 } });
    const hostile = await call('POST', '/requirements/background_check/external', await webToken());
    expect(hostile.body).not.toContain(EXTERNAL_ID);
    expect(keysOf(dataOf(hostile))).toEqual(['adapter', 'lastCheckedAt', 'requirementCode', 'status']);
  });

  it('a hostile service result (object keys, hashes, links, accounts, contacts, a go-live flag, a verified flag) never reaches a provider', async () => {
    const dirtyDoc = docView({
      objectKey: OBJECT_KEY,
      object_key: OBJECT_KEY,
      sha256: HASH,
      url: SECRET_LINK,
      uploadUrl: SECRET_LINK,
      accountId: ACCOUNT_ID,
      email: PROVIDER_SENTINELS[0],
      bytes: 'JVBERi0=',
      scanDetail: 'EICAR',
    });
    const dirtyReq = reqView({
      documents: [dirtyDoc],
      externalId: EXTERNAL_ID,
      accountId: ACCOUNT_ID,
      reviewer: 'admin:staff-1',
      reviews: [reviewView()],
      verified: true,
    });
    const dirty = verificationView({
      requirements: [dirtyReq],
      accountId: ACCOUNT_ID,
      email: PROVIDER_SENTINELS[0],
      verified: true,
      live: true,
      goLive: { evaluated: true, eligible: true },
      case: {
        verificationCaseId: CASE_ID,
        caseNumber: 1,
        status: 'APPROVED',
        revision: 3,
        openedAt: ISO,
        submittedAt: ISO,
        accountId: ACCOUNT_ID,
        decidedAt: ISO,
      },
      overall: {
        status: 'APPROVED',
        verificationComplete: true,
        requiredCount: 1,
        approvedCount: 1,
        missing: [],
        actionRequired: [],
        expired: [],
        verified: true,
        goLive: true,
      },
    });
    svc.getVerification.mockResolvedValueOnce(dirty);
    svc.openVerification.mockResolvedValueOnce({ created: true, view: dirty });
    svc.submitVerification.mockResolvedValueOnce({ changed: true, view: dirty });
    svc.cancelVerification.mockResolvedValueOnce({ changed: true, view: dirty });
    svc.reverifyRequirement.mockResolvedValueOnce(dirty);
    svc.listDocuments.mockResolvedValueOnce([dirtyDoc]);
    svc.finalizeDocument.mockResolvedValueOnce(dirtyDoc);
    svc.withdrawDocument.mockResolvedValueOnce(dirtyDoc);
    for (const r of ROUTES.filter((x) => !['requestUpload', 'startExternalVerification', 'refreshExternalVerification'].includes(x.fn))) {
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.operationId).toBeLessThan(300);
      expectNoSentinel(res);
      for (const word of ['objectKey', 'object_key', 'sha256', 'externalId', 'accountId', 'verified"', '"live"', 'reviewer', 'uploadUrl', 'decidedAt', 'bytes'])
        expect(res.body, `${r.operationId} ${word}`).not.toContain(word);
      expect(res.body).not.toContain(ACCOUNT_ID);
      if (r.fn !== 'listDocuments' && r.fn !== 'finalizeDocument' && r.fn !== 'withdrawDocument')
        expect((dataOf(res) as { goLive: unknown }).goLive, r.operationId).toEqual({ evaluated: false, eligible: false });
    }
    svc.requestUpload.mockResolvedValueOnce({ ...uploadView(), document: dirtyDoc, objectKey: OBJECT_KEY, sha256: HASH });
    const up = await call('POST', '/documents/upload', await webToken(), UPLOAD_BODY);
    expect(up.body).not.toContain(OBJECT_KEY);
    expect(up.body).not.toContain(HASH);
    expect(up.body).not.toContain('objectKey');
  });

  it('the response never carries the sentinels of the account for any operation', async () => {
    for (const r of ROUTES) expectNoSentinel(await routeCall(r, await webToken()));
  });

  it('the mappers build the DTO field by field: extras on the service view never survive the mapper itself, and the lists are copies', () => {
    const dirtyDoc = { ...docView(), objectKey: OBJECT_KEY, url: SECRET_LINK } as never;
    const dto = documentDto(dirtyDoc);
    expect(keysOf(dto)).toEqual(DOC_KEYS);
    expect(JSON.stringify(dto)).not.toContain(OBJECT_KEY);
    expect(JSON.stringify(dto)).not.toContain(HASH);
    // a sha256 on a view given to the PROVIDER mapper is never copied
    expect(JSON.stringify(documentDto(docView({ sha256: HASH }) as never))).not.toContain(HASH);
    const view = verificationView() as never as Parameters<typeof verificationDto>[0];
    const out = verificationDto(view);
    expect(out.overall.missing).not.toBe(view.overall.missing);
    expect(out.requirements[0]!.documentTypes).toHaveLength(3);
    expect(verificationDto({ ...view, goLive: { evaluated: true, eligible: true } } as never).goLive).toEqual({ evaluated: false, eligible: false });
    expect(keysOf(uploadDto({ ...uploadView(), objectKey: OBJECT_KEY } as never))).toEqual(['document', 'upload']);
  });
});

// ====================================================================== provider: strict bodies, params
describe('strict bodies and parameters', () => {
  it.each(BODY_ROUTES)('$method $url ($operationId): a body with an unknown key, a non-object body or no body is a 400', async (r) => {
    for (const body of [{ ...(r.body as object), unknown: 1 }, [], 'text', 7, true, {}]) {
      const res = await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), JSON.stringify(body));
      expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
    }
    const none = await call(r.method, r.url, await webToken());
    expect(none.statusCode).toBe(400);
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it.each(WRITE_ROUTES.filter((r) => r.body === undefined))(
    '$method $url ($operationId) takes NO input: no body, {} and null pass; any key, array, string or number is a 400',
    async (r) => {
      for (const ok of [undefined, '{}', 'null']) {
        const res = ok === undefined ? await call(r.method, r.url, await webToken()) : await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), ok);
        expect(res.statusCode, `${ok} ${res.body}`).toBeLessThan(300);
      }
      const calls = svc[r.fn].mock.calls.length;
      expect(calls).toBe(3);
      const bad =
        r.fn === 'finalizeDocument'
          ? ['[]', '"x"', '7', 'true', '{"a":1}', '{"sha256":"x"}', '{"sha256":null}']
          : ['[]', '"x"', '7', 'true', '{"a":1}', '{"reason":"x"}', '{"status":"APPROVED"}', JSON.stringify({ sha256: HASH })];
      for (const text of bad) {
        const res = await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), text);
        expect(res.statusCode, `${text}`).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(svc[r.fn]).toHaveBeenCalledTimes(3);
    },
  );

  it('rejected values are never echoed back in a validation error', async () => {
    const secret = 'Echo-Me-Not-4F7A9C'; // secret-scan:allow deliberate fake echo canary
    for (const [m, u, b] of [
      ['POST', '/documents/upload', { ...UPLOAD_BODY, mimeType: secret }],
      ['POST', '/documents/upload', { ...UPLOAD_BODY, requirementCode: secret }],
      ['POST', '/documents/upload', { ...UPLOAD_BODY, unknownkey: secret }],
      ['POST', '/submit', { expectedRevision: secret }],
      ['POST', `/documents/${DOC_ID}/finalize`, { sha256: secret }],
      ['POST', '/cancel', { reason: secret }],
      ['POST', '', { unknownkey: secret }],
    ] as const) {
      const res = await call(m, u, await webToken(), b);
      expect(res.statusCode, u).toBe(400);
      expect(res.body, u).not.toContain(secret);
      const issues = (errorOf(res).details as { issues: { path: string; message: string }[] }).issues;
      for (const issue of issues) expect(keysOf(issue)).toEqual(['message', 'path']);
    }
    for (const [m, u, b] of [
      ['POST', `/requirements/${REQ_ID}/approve`, { round: 1, expiresAt: secret }],
      ['POST', `/requirements/${REQ_ID}/reject`, { round: 1, reasonCode: secret }],
      ['POST', `/requirements/${REQ_ID}/start-review`, { round: secret }],
      ['PUT', '/requirement-rules', { ...RULE_BODY, marketCode: secret }],
    ] as const) {
      const res = await acall(m, u, await superAdmin(), b);
      expect(res.statusCode, u).toBe(400);
      expect(res.body, u).not.toContain(secret);
    }
  });

  it('does NOT coerce: strings for numbers, numbers for strings, truthy values and floats are 400 (the raw body is validated before Ajv can coerce it)', async () => {
    for (const [u, b] of [
      ['/documents/upload', { ...UPLOAD_BODY, sizeBytes: '1234' }],
      ['/documents/upload', { ...UPLOAD_BODY, sizeBytes: 1234.0000001 }],
      ['/documents/upload', { ...UPLOAD_BODY, sizeBytes: true }],
      ['/documents/upload', { ...UPLOAD_BODY, sizeBytes: null }],
      ['/documents/upload', { ...UPLOAD_BODY, mimeType: 7 }],
      ['/documents/upload', { ...UPLOAD_BODY, mimeType: ['application/pdf'] }],
      ['/documents/upload', { ...UPLOAD_BODY, requirementCode: 7 }],
      ['/documents/upload', { ...UPLOAD_BODY, documentTypeCode: true }],
      ['/submit', { expectedRevision: '3' }],
      ['/submit', { expectedRevision: true }],
      ['/submit', { expectedRevision: null }],
      ['/submit', { expectedRevision: 0 }],
      ['/submit', { expectedRevision: 3.5 }],
      ['/submit', { expectedRevision: 2_147_483_648 }],
      [`/documents/${DOC_ID}/finalize`, { sha256: 7 }],
      [`/documents/${DOC_ID}/finalize`, { sha256: true }],
    ] as const) {
      const res = await call('POST', u, await webToken(), b);
      expect(res.statusCode, `${u} ${JSON.stringify(b)} ${res.body}`).toBe(400);
    }
    for (const [u, b] of [
      [`/requirements/${REQ_ID}/start-review`, { round: '1' }],
      [`/requirements/${REQ_ID}/start-review`, { round: 1.5 }],
      [`/requirements/${REQ_ID}/start-review`, { round: true }],
      [`/requirements/${REQ_ID}/approve`, { round: '1' }],
      [`/requirements/${REQ_ID}/approve`, { round: 1, expiresAt: 1767225600 }],
      [`/requirements/${REQ_ID}/approve`, { round: 1, expiresAt: true }],
      [`/requirements/${REQ_ID}/reject`, { round: 1, reasonCode: 7 }],
      [`/requirements/${REQ_ID}/request-action`, { round: 1, reasonCode: ['DOCUMENT_UNREADABLE'] }],
    ] as const) {
      const res = await acall('POST', u, await superAdmin(), b);
      expect(res.statusCode, `${u} ${JSON.stringify(b)} ${res.body}`).toBe(400);
    }
    expect((await acall('PUT', '/requirement-rules', await superAdmin(), { ...RULE_BODY, enabled: 'true' })).statusCode).toBe(400);
    expect((await acall('PUT', '/requirement-rules', await superAdmin(), { ...RULE_BODY, enabled: 1 })).statusCode).toBe(400);
    expect(noServiceCalled()).toBe(true);
  });

  it('upload: size, MIME type and code bounds', async () => {
    for (const sizeBytes of [0, -1, 52_428_801])
      expect((await call('POST', '/documents/upload', await webToken(), { ...UPLOAD_BODY, sizeBytes })).statusCode, String(sizeBytes)).toBe(400);
    for (const mimeType of ['', 'pdf', 'Application/PDF', 'application/pdf; charset=utf-8', 'application/', `a/${'b'.repeat(99)}`, 'application/pdf\n'])
      expect((await call('POST', '/documents/upload', await webToken(), { ...UPLOAD_BODY, mimeType })).statusCode, JSON.stringify(mimeType)).toBe(400);
    for (const k of ['requirementCode', 'documentTypeCode'])
      for (const v of ['', 'a', 'Identity', 'identity-verification', `a${'b'.repeat(48)}`])
        expect((await call('POST', '/documents/upload', await webToken(), { ...UPLOAD_BODY, [k]: v })).statusCode, `${k} ${v}`).toBe(400);
    expect(svc.requestUpload).not.toHaveBeenCalled();
    // the boundaries pass through to the service (the POLICY decides the real maximum, not the edge)
    for (const sizeBytes of [1, 52_428_800])
      expect((await call('POST', '/documents/upload', await webToken(), { ...UPLOAD_BODY, sizeBytes })).statusCode, String(sizeBytes)).toBe(201);
    expect(svc.requestUpload.mock.calls.map((c) => c[1].sizeBytes)).toEqual([1, 52_428_800]);
  });

  it('finalize: the optional hash is a lower-case 64-digit SHA-256', async () => {
    for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`, '', `${HASH}\n`])
      expect((await call('POST', `/documents/${DOC_ID}/finalize`, await webToken(), { sha256 })).statusCode, sha256).toBe(400);
    expect(svc.finalizeDocument).not.toHaveBeenCalled();
    expect((await call('POST', `/documents/${DOC_ID}/finalize`, await webToken(), { sha256: HASH })).statusCode).toBe(200);
  });

  it('submit: expectedRevision is required', async () => {
    expect((await call('POST', '/submit', await webToken(), {})).statusCode).toBe(400);
    expect((await call('POST', '/submit', await webToken())).statusCode).toBe(400);
    expect((await call('POST', '/submit', await webToken(), { expectedRevision: 2_147_483_647 })).statusCode).toBe(200);
  });

  it.each(WRITE_ROUTES)('$method $url ($operationId): malformed JSON, a wrong content type and a form body are 4xx and never reach the service', async (r) => {
    for (const [text, type] of [
      ['{', 'application/json'],
      ['{"a":', 'application/json'],
      ['not json', 'application/json'],
      ['requirementCode=identity_verification', 'application/x-www-form-urlencoded'],
      ['requirementCode=identity_verification', 'text/plain'],
      ['<a/>', 'application/xml'],
    ] as const) {
      const res = await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), text, type);
      expect(res.statusCode, `${text} ${type}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${text} ${type}`).toBeLessThan(500);
      expectNoStore(res);
    }
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('prototype pollution keys in a body are rejected, not merged', async () => {
    for (const text of ['{"expectedRevision":3,"__proto__":{"admin":true}}', '{"expectedRevision":3,"constructor":{"prototype":{"x":1}}}']) {
      const res = await rawBody(PROVIDER_PREFIX, 'POST', '/submit', await webToken(), text);
      expect(res.statusCode, text).toBe(400);
    }
    expect(svc.submitVerification).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  describe('path parameters', () => {
    const ID_BAD = [
      'not-a-uuid',
      '123',
      DOC_ID.toUpperCase(),
      `${DOC_ID}0`,
      DOC_ID.slice(1),
      `${DOC_ID}%0A`,
      `x${DOC_ID}`,
      DOC_ID.replace(/-/g, ''),
      '00000000-0000-0000-0000-00000000000g',
      `${DOC_ID.slice(0, 35)}%27`,
      '..%2f..%2fx',
      '%00',
    ];
    it.each(['finalize', 'withdraw'])('POST /documents/:id/%s: only a lower-case UUID is accepted, otherwise 400 before the service', async (action) => {
      for (const id of ID_BAD) {
        const res = await call('POST', `/documents/${id}/${action}`, await webToken(), {});
        expect(res.statusCode, id).toBe(400);
        expect(errorOf(res).code, id).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(noServiceCalled()).toBe(true);
      expect((await call('POST', `/documents/${DOC_ID}/${action}`, await webToken(), {})).statusCode).toBe(200);
    });
    const CODE_BAD = [
      'a',
      'Identity',
      'IDENTITY_VERIFICATION',
      'identity-verification',
      'identity__verification',
      '_identity',
      'identity_',
      '1identity',
      `a${'b'.repeat(48)}`,
      'a b',
      '%20',
      'identity%0A',
      'identity.verification',
    ];
    it.each(['reverify', 'external', 'external/refresh'])(
      'POST /requirements/:code/%s: only a catalogue code is accepted, otherwise 400 before the service',
      async (action) => {
        for (const code of CODE_BAD) {
          const res = await call('POST', `/requirements/${code}/${action}`, await webToken(), {});
          expect(res.statusCode, code).toBe(400);
          expect(errorOf(res).code, code).toBe('VALIDATION_FAILED');
          expectNoStore(res);
        }
        expect(noServiceCalled()).toBe(true);
        for (const code of ['ab', 'identity_verification', `a${'b'.repeat(47)}`])
          expect((await call('POST', `/requirements/${code}/${action}`, await webToken(), {})).statusCode, code).toBe(200);
      },
    );
    it('the code reaches the service unchanged and the id is the path id, not an account', async () => {
      await call('POST', '/requirements/liability_insurance/reverify', await webToken());
      expect(svc.reverifyRequirement.mock.calls[0]).toEqual([ACCOUNT_ID, 'liability_insurance']);
      await call('POST', `/documents/${OTHER_CASE_ID}/withdraw`, await webToken());
      expect(svc.withdrawDocument.mock.calls[0]).toEqual([ACCOUNT_ID, OTHER_CASE_ID]);
    });
  });

  it('GET "" and GET /documents take no parameter at all', async () => {
    for (const url of ['?x=1', '?locale=en-US', '/documents?x=1', '/documents?status=ATTACHED'])
      expect((await call('GET', url, await webToken())).statusCode, url).toBe(400);
    expect(svc.getVerification).not.toHaveBeenCalled();
    expect(svc.listDocuments).not.toHaveBeenCalled();
  });
});

// ====================================================================== body size
describe('request body size limit', () => {
  it('the limit is far below the framework default and above the largest legitimate body', () => {
    expect(TRUST_BODY_LIMIT).toBeLessThanOrEqual(8192);
    const largest = JSON.stringify({
      requirementCode: 'a'.repeat(48),
      documentTypeCode: 'b'.repeat(48),
      mimeType: `a/${'b'.repeat(98)}`,
      sizeBytes: 52_428_800,
    });
    expect(largest.length).toBeLessThan(TRUST_BODY_LIMIT);
    expect(JSON.stringify({ round: 10_000, reasonCode: 'A'.repeat(48), expiresAt: '2027-12-31T23:59:59.999999+14:00' }).length).toBeLessThan(TRUST_BODY_LIMIT);
  });

  it.each(WRITE_ROUTES)('provider $method $url ($operationId): a body over the limit is refused with 413 before it is parsed', async (r) => {
    const huge = JSON.stringify({ ...(r.body as object | undefined), pad: 'x'.repeat(TRUST_BODY_LIMIT + 100) });
    const res = await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), huge);
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).category).toBe('VALIDATION');
    expectNoStore(res);
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it.each(ABODY_ROUTES)('admin $method $url ($operationId): a body over the limit is refused with 413 before it is parsed', async (r) => {
    const huge = JSON.stringify({ ...(r.body as object | undefined), pad: 'x'.repeat(TRUST_BODY_LIMIT + 100) });
    const res = await rawBody(ADMIN_PREFIX, r.method, r.url, await superAdmin(), huge);
    expect(res.statusCode).toBe(413);
    expectNoStore(res);
    expect(svc[r.fn]).not.toHaveBeenCalled();
  });

  it('a body of exactly the limit is not a 413 (it is a 400 by its content)', async () => {
    const pad = 'x'.repeat(TRUST_BODY_LIMIT - 20);
    const res = await rawBody(PROVIDER_PREFIX, 'POST', '/submit', await webToken(), JSON.stringify({ p: pad }).slice(0, TRUST_BODY_LIMIT));
    expect(res.statusCode).not.toBe(413);
  });

  it('a deeply nested body is a 4xx and never reaches the service', async () => {
    const nested = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    for (const r of WRITE_ROUTES)
      expect((await rawBody(PROVIDER_PREFIX, r.method, r.url, await webToken(), nested)).statusCode, r.url).toBeGreaterThanOrEqual(400);
    for (const r of ABODY_ROUTES)
      expect((await rawBody(ADMIN_PREFIX, r.method, r.url, await superAdmin(), nested)).statusCode, r.url).toBeGreaterThanOrEqual(400);
    expect(noServiceCalled()).toBe(true);
  });
});

// ====================================================================== error mapping
type Expect = { category: string; status: number; message: string };
const EXPECTED_ERRORS: Record<TrustErrorCode, Expect> = {
  NOT_FOUND: { category: 'NOT_FOUND', status: 404, message: 'Not found' },
  ACCOUNT_NOT_ACTIVE: { category: 'CONFLICT', status: 409, message: 'The account is not active' },
  PREREQUISITE_NOT_MET: { category: 'CONFLICT', status: 409, message: 'A prerequisite step is not complete' },
  REQUIREMENT_NOT_APPLICABLE: { category: 'CONFLICT', status: 409, message: 'That requirement does not apply' },
  DOCUMENT_TYPE_NOT_ACCEPTED: { category: 'VALIDATION', status: 400, message: 'That kind of document is not accepted for this requirement' },
  MIME_NOT_ALLOWED: { category: 'VALIDATION', status: 400, message: 'That file type is not allowed' },
  FILE_TOO_LARGE: { category: 'VALIDATION', status: 400, message: 'That file is too large' },
  TOO_MANY_DOCUMENTS: { category: 'CONFLICT', status: 409, message: 'The most documents allowed for this requirement are already added' },
  EVIDENCE_NOT_ACCEPTED: { category: 'CONFLICT', status: 409, message: 'This requirement does not take evidence right now' },
  UPLOAD_EXPIRED: { category: 'CONFLICT', status: 409, message: 'The upload authorization expired' },
  OBJECT_MISSING: { category: 'VALIDATION', status: 400, message: 'The file was not received' },
  OBJECT_MISMATCH: { category: 'VALIDATION', status: 400, message: 'The file did not match what was described' },
  SCAN_UNAVAILABLE: { category: 'DEPENDENCY', status: 503, message: 'The safety check is not available right now' },
  SCAN_INFECTED: { category: 'VALIDATION', status: 400, message: 'The file was rejected by the safety check' },
  INVALID_STATE: { category: 'CONFLICT', status: 409, message: 'That is not possible in the current state' },
  SUBMISSION_INCOMPLETE: { category: 'CONFLICT', status: 409, message: 'Some requirements still need a document' },
  STALE_CASE: { category: 'CONFLICT', status: 409, message: 'The verification changed since it was read' },
  STALE_ROUND: { category: 'CONFLICT', status: 409, message: 'The evidence changed since it was read' },
  ALREADY_DECIDED: { category: 'CONFLICT', status: 409, message: 'This evidence was already decided' },
  REASON_INVALID: { category: 'VALIDATION', status: 400, message: 'That reason cannot be used for this decision' },
  NOT_REVERIFIABLE: { category: 'CONFLICT', status: 409, message: 'This requirement cannot be verified again yet' },
  EXTERNAL_UNAVAILABLE: { category: 'DEPENDENCY', status: 503, message: 'The verification service is not available right now' },
  VALIDATION_FAILED: { category: 'VALIDATION', status: 400, message: 'The request is not valid' },
  CONFLICT: { category: 'CONFLICT', status: 409, message: 'The change conflicted with a concurrent update' },
  UNAVAILABLE: { category: 'DEPENDENCY', status: 503, message: 'Verification is temporarily unavailable' },
};
/** What a hostile or sloppy service might put in `details`: only the allow-listed tokens may come back. */
const HOSTILE_DETAILS = {
  reason: 'STALE_ROUND',
  field: 'expiresAt',
  retryable: true,
  codes: ['identity_verification', 'Bad Code', 'x', 'professional_license'],
  max: 10_485_760,
  min: 1,
  step: 'MARKET',
  steps: ['CONTACT'],
  sql: 'SELECT * FROM trust.documents WHERE secret_table = 1',
  cause: new Error('boom: password=hunter2'),
  constraint: 'uq_reviews__decision',
  detail: 'trust_rule:SECRET_RULE',
  email: 'victim@leak-check.example',
  objectKey: OBJECT_KEY,
  sha256: HASH,
  url: SECRET_LINK,
  nested: { deep: { token: 'nested-test-token-value' } },
  stack: 'Error: at /Users/dukm/secret.ts:1',
};
const LEAKS = [
  'secret_table',
  'hunter2',
  'uq_reviews__decision',
  'SECRET_RULE',
  'victim@leak-check.example',
  'nested-test-token-value',
  '/Users/dukm',
  'Bad Code',
  'boom',
  OBJECT_KEY,
  HASH,
  SECRET_LINK,
  'MARKET',
];

describe('trust error mapping', () => {
  it('the table in this test covers every code of the contract', () => {
    expect(Object.keys(EXPECTED_ERRORS).sort()).toEqual([...TRUST_ERROR_CODES].sort());
    expect(TRUST_ERROR_CODES).toHaveLength(25);
  });

  it.each(TRUST_ERROR_CODES)(
    '%s maps onto its category, HTTP status, TRUST_ code, fixed message and message key (on every operation of both prefixes)',
    async (code) => {
      const want = EXPECTED_ERRORS[code];
      const check = (res: Reply, where: string) => {
        expect(res.statusCode, `${where} ${res.body}`).toBe(want.status);
        const e = errorOf(res);
        expect(e).toMatchObject({ category: want.category, code: `TRUST_${code}`, message: want.message });
        expect(e.details, where).toEqual({ messageKey: trustErrorKey(code) });
        expect(res.body).not.toContain('SELECT 1');
        expect(res.body).not.toContain('service wording');
        expectNoStore(res);
      };
      for (const r of ROUTES) {
        svc[r.fn].mockRejectedValueOnce(new TrustError(code, `service wording that must not be passed on: ${code} SELECT 1`));
        check(await routeCall(r, await webToken()), r.operationId);
      }
      for (const r of AROUTES) {
        svc[r.fn].mockRejectedValueOnce(new TrustError(code, `service wording that must not be passed on: ${code} SELECT 1`));
        check(await aCall(r, await superAdmin()), r.operationId);
      }
    },
  );

  it('the categories follow the design: NOT_FOUND 404; validation 400 (8 codes); dependency 503 (3 codes); everything else conflict 409', () => {
    const by = (c: string) =>
      Object.entries(EXPECTED_ERRORS)
        .filter(([, v]) => v.category === c)
        .map(([k]) => k)
        .sort();
    expect(by('NOT_FOUND')).toEqual(['NOT_FOUND']);
    expect(by('VALIDATION')).toEqual(
      [
        'DOCUMENT_TYPE_NOT_ACCEPTED',
        'FILE_TOO_LARGE',
        'MIME_NOT_ALLOWED',
        'OBJECT_MISMATCH',
        'OBJECT_MISSING',
        'REASON_INVALID',
        'SCAN_INFECTED',
        'VALIDATION_FAILED',
      ].sort(),
    );
    expect(by('DEPENDENCY')).toEqual(['EXTERNAL_UNAVAILABLE', 'SCAN_UNAVAILABLE', 'UNAVAILABLE']);
    expect(by('CONFLICT')).toHaveLength(25 - 1 - 8 - 3);
  });

  it.each(TRUST_ERROR_CODES)('%s: hostile details never leak; only the allow-listed tokens come back (UNAVAILABLE has none)', async (code) => {
    svc.submitVerification.mockRejectedValueOnce(new TrustError(code, 'SELECT secret', HOSTILE_DETAILS));
    const res = await call('POST', '/submit', await webToken(), SUBMIT_BODY);
    expect(res.statusCode).toBe(EXPECTED_ERRORS[code].status);
    for (const leak of LEAKS) expect(res.body, leak).not.toContain(leak);
    const details = errorOf(res).details as Record<string, unknown>;
    if (code === 'UNAVAILABLE') {
      expect(details).toEqual({ messageKey: trustErrorKey(code) });
    } else {
      expect(details).toEqual({
        reason: 'STALE_ROUND',
        field: 'expiresAt',
        retryable: true,
        codes: ['identity_verification', 'professional_license'],
        max: 10_485_760,
        messageKey: trustErrorKey(code),
      });
    }
    svc.approveRequirement.mockRejectedValueOnce(new TrustError(code, 'SELECT secret', HOSTILE_DETAILS));
    const admin = await acall('POST', `/requirements/${REQ_ID}/approve`, await superAdmin(), APPROVE_BODY);
    for (const leak of LEAKS) expect(admin.body, leak).not.toContain(leak);
    expect(errorOf(admin).details).toEqual(details);
  });

  it('the message key cannot be overridden by a service detail', async () => {
    svc.getVerification.mockRejectedValueOnce(new TrustError('CONFLICT', 'x', { messageKey: 'evil.key', message: 'evil' }));
    const res = await call('GET', '', await webToken());
    expect(errorOf(res).details).toEqual({ messageKey: 'trust.verification.error.conflict' });
  });

  it('SUBMISSION_INCOMPLETE names the requirements that need a document and nothing else', async () => {
    svc.submitVerification.mockRejectedValueOnce(
      new TrustError('SUBMISSION_INCOMPLETE', 'x', {
        reason: 'SUBMISSION_INCOMPLETE',
        codes: ['identity_verification', 'professional_license'],
        documents: [DOC_ID],
      }),
    );
    const res = await call('POST', '/submit', await webToken(), SUBMIT_BODY);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toEqual({
      reason: 'SUBMISSION_INCOMPLETE',
      codes: ['identity_verification', 'professional_license'],
      messageKey: 'trust.verification.error.submission_incomplete',
    });
  });

  it('FILE_TOO_LARGE and TOO_MANY_DOCUMENTS carry the configured maximum', async () => {
    svc.requestUpload.mockRejectedValueOnce(new TrustError('FILE_TOO_LARGE', 'x', { reason: 'FILE_TOO_LARGE', max: 10_485_760 }));
    expect(errorOf(await call('POST', '/documents/upload', await webToken(), UPLOAD_BODY)).details).toMatchObject({
      reason: 'FILE_TOO_LARGE',
      max: 10_485_760,
    });
    svc.requestUpload.mockRejectedValueOnce(new TrustError('TOO_MANY_DOCUMENTS', 'x', { reason: 'TOO_MANY_DOCUMENTS', max: 5 }));
    expect(errorOf(await call('POST', '/documents/upload', await webToken(), UPLOAD_BODY)).details).toMatchObject({ reason: 'TOO_MANY_DOCUMENTS', max: 5 });
  });

  it('a retryable CONFLICT reaches the client as HTTP 409 TRUST_CONFLICT with details.retryable (not a 500)', async () => {
    svc.openVerification.mockRejectedValueOnce(new TrustError('CONFLICT', 'x', { reason: 'CONCURRENT_UPDATE', retryable: true }));
    const res = await call('POST', '', await webToken());
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'TRUST_CONFLICT', details: { reason: 'CONCURRENT_UPDATE', retryable: true } });
  });

  it('a non-typed failure of the service is a plain 500 INTERNAL_ERROR with no detail (provider and admin)', async () => {
    for (const err of [
      new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2'),
      new TypeError('x is undefined'),
      Object.assign(new Error('pg'), { code: '23505', detail: 'secret' }),
    ]) {
      svc.getVerification.mockRejectedValueOnce(err);
      const res = await call('GET', '', await webToken());
      expect(res.statusCode).toBe(500);
      expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
      for (const w of ['hunter2', 'ECONNREFUSED', 'secret']) expect(res.body).not.toContain(w);
      expectNoStore(res);
      svc.getCase.mockRejectedValueOnce(err);
      const admin = await acall('GET', `/cases/${CASE_ID}`, await superAdmin());
      expect(admin.statusCode).toBe(500);
      for (const w of ['hunter2', 'ECONNREFUSED', 'secret']) expect(admin.body).not.toContain(w);
      expectNoStore(admin);
    }
  });

  it('the account guard failing mid-request (an outage of the account registry) is not mistaken for a trust error', async () => {
    accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError('UNAVAILABLE', 'db down: host=10.1.1.1'));
    const res = await call('GET', '', await webToken());
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe('ACCOUNT_UNAVAILABLE');
    expect(res.body).not.toContain('10.1.1.1');
    expect(svc.getVerification).not.toHaveBeenCalled();
  });

  it('toAppError rethrows anything that is not a TrustError untouched', () => {
    const odd = new Error('boom');
    expect(() => toAppError(odd)).toThrow(odd);
    expect(() => toAppError('string')).toThrow('string');
  });

  describe('safeDetails (the allow-list itself)', () => {
    it('drops everything that is not a short machine token, a catalogue-shaped code or a small integer', () => {
      expect(safeDetails(HOSTILE_DETAILS)).toEqual({
        reason: 'STALE_ROUND',
        field: 'expiresAt',
        retryable: true,
        codes: ['identity_verification', 'professional_license'],
        max: 10_485_760,
      });
      expect(safeDetails({})).toEqual({});
    });
    it('tokens: letters, digits, underscore, dot and hyphen, at most 64 characters (longer is cut to 64 and only when the cut is still a token)', () => {
      expect(safeDetails({ reason: 'A.b-c_9' })).toEqual({ reason: 'A.b-c_9' });
      for (const v of ['has space', 'semi;colon', '', 7, null, {}, ['a']]) expect(safeDetails({ reason: v }), String(v)).toEqual({});
      expect(safeDetails({ reason: 'x'.repeat(64) })).toEqual({ reason: 'x'.repeat(64) });
      expect(safeDetails({ reason: 'x'.repeat(200) })).toEqual({ reason: 'x'.repeat(64) });
      expect(safeDetails({ field: 'a b' })).toEqual({});
      expect(safeDetails({ field: 'ok_field', reason: 'ok' })).toEqual({ reason: 'ok', field: 'ok_field' });
    });
    it('keys that are not on the list never come back: step, steps, min, locale, outstanding, message', () => {
      expect(safeDetails({ step: 'MARKET', steps: ['CONTACT'], min: 1, locale: 'en', outstanding: ['x'], message: 'm', messageKey: 'k' })).toEqual({});
    });
    it('retryable is only ever the literal true', () => {
      expect(safeDetails({ retryable: true })).toEqual({ retryable: true });
      for (const v of [false, 'true', 1, null, {}]) expect(safeDetails({ retryable: v })).toEqual({});
    });
    it('codes: lower snake codes of 2..48 characters only, at most 20; none left means no key', () => {
      const many = Array.from({ length: 25 }, (_, i) => `code_${String(i).padStart(2, '0')}`);
      expect(safeDetails({ codes: many }).codes).toEqual(many.slice(0, 20));
      expect(safeDetails({ codes: ['Aa', '1a', 'a-b', 'a', `a${'b'.repeat(48)}`, 'a b', 'ab\n', 7, null] })).toEqual({});
      expect(safeDetails({ codes: ['ab', `a${'b'.repeat(47)}`] })).toEqual({ codes: ['ab', `a${'b'.repeat(47)}`] });
      expect(safeDetails({ codes: 'ab' })).toEqual({});
      expect(safeDetails({ codes: [] })).toEqual({});
    });
    it('max: integers from 0 to 100000000 only', () => {
      for (const v of [0, 1, 10_485_760, 52_428_800, 100_000_000]) expect(safeDetails({ max: v }), String(v)).toEqual({ max: v });
      for (const v of [-1, 100_000_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, true])
        expect(safeDetails({ max: v }), String(v)).toEqual({});
    });
    it('does not copy or alias the input and ignores prototype keys', () => {
      const input = JSON.parse('{"reason":"ok","__proto__":{"polluted":true},"constructor":"x"}') as Record<string, unknown>;
      const out = safeDetails(input);
      expect(out).toEqual({ reason: 'ok' });
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
      const codes = ['ab', 'cd'];
      expect(safeDetails({ codes }).codes).not.toBe(codes);
    });
  });
});

// ====================================================================== admin: authentication and permissions
describe('administrator API authentication', () => {
  it.each(AROUTES)('$method $url ($operationId) requires a token: 401 before anything else, no-store', async (r) => {
    const res = await aCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expectNoStore(res);
    expect(noServiceCalled()).toBe(true);
  });

  it.each(AROUTES)('$method $url ($operationId) rejects every kind of invalid token with 401', async (r) => {
    const expired = await signToken(keys, {
      claims: { sub: 'x', azp: 'bananagig-admin', resource_access: { 'bananagig-admin': { roles: ADMIN_ALL } } },
      expiresInSec: -60,
    });
    for (const t of [
      'not.a.token',
      expired,
      unsignedToken({ azp: 'bananagig-admin' }),
      await hmacToken(),
      await signToken(keys, { claims: { aud: 'someone-else', azp: 'bananagig-admin' } }),
    ]) {
      const res = await aCall(r, t);
      expect(res.statusCode, t.slice(0, 20)).toBe(401);
      expect(errorOf(res).code).toBe('INVALID_TOKEN');
    }
    expect(noServiceCalled()).toBe(true);
  });

  it('answers 401 and 403 before 400 and before 404-style lookups: invalid ids, queries and bodies change nothing', async () => {
    for (const url of [
      '/cases/not-a-uuid',
      '/cases?limit=0',
      '/cases?status=NOPE',
      '/documents/bad/download',
      '/requirements/bad/approve',
      '/requirement-definitions/BAD/status',
    ]) {
      const method: Method = url.includes('/approve') ? 'POST' : url.includes('/status') ? 'PUT' : 'GET';
      expect((await acall(method, url, undefined, {})).statusCode, url).toBe(401);
      expect((await acall(method, url, await webToken(), {})).statusCode, url).toBe(403);
      expect((await acall(method, url, await adminToken([]), {})).statusCode, url).toBe(403);
    }
    for (const r of ABODY_ROUTES)
      for (const body of [{ garbage: true }, [], 'text', 7, null]) {
        expect((await rawBody(ADMIN_PREFIX, r.method, r.url, undefined, JSON.stringify(body))).statusCode, r.url).toBe(401);
        expect((await rawBody(ADMIN_PREFIX, r.method, r.url, await adminToken([]), JSON.stringify(body))).statusCode, r.url).toBe(403);
        expect((await rawBody(ADMIN_PREFIX, r.method, r.url, await webToken(), JSON.stringify(body))).statusCode, r.url).toBe(403);
      }
    expect(noServiceCalled()).toBe(true);
  });
});

describe('administrator permission matrix (forged admin tokens)', () => {
  const MATRIX: [string[], Record<Perm, boolean>][] = [
    [[], { read: false, review: false, admin: false }],
    [['trust-read'], { read: true, review: false, admin: false }],
    [['trust-review'], { read: true, review: true, admin: false }],
    [['trust-admin'], { read: false, review: false, admin: true }],
    [['trust-read', 'trust-review'], { read: true, review: true, admin: false }],
    [['trust-read', 'trust-admin'], { read: true, review: false, admin: true }],
    [['trust-review', 'trust-admin'], { read: true, review: true, admin: true }],
    [ADMIN_ALL, { read: true, review: true, admin: true }],
  ];
  it.each(MATRIX)('roles %j', async (roles, want) => {
    const t = await adminToken(roles);
    for (const r of AROUTES) {
      svc[r.fn].mockClear();
      const res = await aCall(r, t);
      if (want[r.perm]) {
        expect(res.statusCode, `${r.operationId} ${res.body}`).toBe(200);
        expect(svc[r.fn]).toHaveBeenCalledTimes(1);
      } else {
        expect(res.statusCode, `${r.operationId} ${res.body}`).toBe(403);
        expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
        expect(svc[r.fn]).not.toHaveBeenCalled();
      }
      expectNoStore(res);
    }
  });

  it('trust-read cannot decide or download; trust-review implies read; trust-admin sees the policy only: no case, no evidence, no decision', async () => {
    const read = await adminToken(['trust-read']);
    for (const r of AROUTES.filter((x) => x.perm === 'review')) expect((await aCall(r, read)).statusCode, r.operationId).toBe(403);
    expect(svc.downloadDocument).not.toHaveBeenCalled();
    for (const f of ['startReview', 'approveRequirement', 'rejectRequirement', 'requestAction'] as const) expect(svc[f]).not.toHaveBeenCalled();
    const admin = await adminToken(['trust-admin']);
    for (const r of AROUTES.filter((x) => x.perm !== 'admin')) expect((await aCall(r, admin)).statusCode, r.operationId).toBe(403);
    expect(svc.listCases).not.toHaveBeenCalled();
    expect(svc.getCase).not.toHaveBeenCalled();
    expect(svc.downloadDocument).not.toHaveBeenCalled();
    expect((await acall('GET', '/policy', admin)).statusCode).toBe(200);
  });

  it('403 comes before the body is looked at: a read-only or admin-only token cannot probe decision validation', async () => {
    for (const t of [await adminToken(['trust-read']), await adminToken(['trust-admin'])])
      for (const r of AROUTES.filter((x) => x.perm === 'review' && x.method === 'POST'))
        for (const body of [{}, { round: 'x' }, [], 'x'])
          expect((await rawBody(ADMIN_PREFIX, 'POST', r.url, t, JSON.stringify(body))).statusCode, r.url).toBe(403);
    for (const t of [await adminToken(['trust-read']), await adminToken(['trust-review'])])
      for (const body of [{}, { status: 'NOPE' }, []])
        expect((await acall('PUT', '/requirement-definitions/identity_verification/status', t, body)).statusCode).toBe(403);
    expect(noServiceCalled()).toBe(true);
  });

  it('the configuration-*, content-*, geography-*, catalog-* roles (and look-alikes of the trust roles) grant nothing', async () => {
    const foreign = await adminToken([
      'configuration-read',
      'configuration-write',
      'configuration-approve',
      'content-read',
      'content-write',
      'content-approve',
      'content-legal',
      'geography-read',
      'geography-write',
      'catalog-read',
      'catalog-write',
      'admin-console-access',
      'trust',
      'trusts-read',
      'trust-reader',
      'trust-reviewer',
      'trust-write',
      'trust-approve',
      'trust_read',
      'Trust-Read',
      'TRUST-REVIEW',
      'trust-admin ',
      ' trust-read',
      'trust-read\n',
    ]);
    for (const r of AROUTES) expect((await aCall(r, foreign)).statusCode, r.operationId).toBe(403);
    expect(noServiceCalled()).toBe(true);
  });

  it('keeps provider, customer and web-client tokens out even when they carry the role names (on every admin route)', async () => {
    const providerToken = await webToken({ realm_access: { roles: ['customer', 'provider'] } });
    const customer = await webToken();
    const spoofedOnWebClient = await webToken({ resource_access: { 'bananagig-web': { roles: ADMIN_ALL } } });
    const webWithAdminResource = await webToken({ resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...ADMIN_ALL] } } });
    const realmRoles = await webToken({ realm_access: { roles: [...ADMIN_ALL, 'admin-console-access', 'customer'] } });
    const otherClient = await signToken(keys, { claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: ADMIN_ALL } } } });
    const apiClient = await signToken(keys, { claims: { azp: 'bananagig-api', resource_access: { 'bananagig-admin': { roles: ADMIN_ALL } } } });
    for (const t of [providerToken, customer, spoofedOnWebClient, webWithAdminResource, realmRoles, otherClient, apiClient])
      for (const r of AROUTES) {
        const res = await aCall(r, t);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
        expect(errorOf(res).code).toBe('INSUFFICIENT_PERMISSIONS');
      }
    expect(noServiceCalled()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it('an admin identity has no account: the admin routes never consult the account registry', async () => {
    for (const r of AROUTES) await aCall(r, await superAdmin());
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
    expect(accountSvc.getAccountContext).not.toHaveBeenCalled();
  });
});

// ====================================================================== admin: the reviewer is the token subject, strict inputs, shapes
describe('administrator calls: reviewer identity, parameters and bodies', () => {
  it('the reviewer passed to the service is the verified token subject, for every reviewer and administrator operation', async () => {
    const sub = 'staff-Reviewer.7:x@y';
    const t = await adminToken(ADMIN_ALL, { sub });
    await acall('GET', `/documents/${DOC_ID}/download`, t);
    expect(svc.downloadDocument.mock.calls[0]).toEqual([sub, DOC_ID]);
    await acall('POST', `/requirements/${REQ_ID}/start-review`, t, { round: 1 });
    expect(svc.startReview.mock.calls[0]).toEqual([sub, REQ_ID, { round: 1 }]);
    await acall('POST', `/requirements/${REQ_ID}/approve`, t, APPROVE_BODY);
    expect(svc.approveRequirement.mock.calls[0]).toEqual([sub, REQ_ID, APPROVE_BODY]);
    await acall('POST', `/requirements/${REQ_ID}/approve`, t, { round: 2 });
    expect(svc.approveRequirement.mock.calls[1]).toEqual([sub, REQ_ID, { round: 2 }]);
    await acall('POST', `/requirements/${REQ_ID}/reject`, t, REASON_BODY);
    expect(svc.rejectRequirement.mock.calls[0]).toEqual([sub, REQ_ID, REASON_BODY]);
    await acall('POST', `/requirements/${REQ_ID}/request-action`, t, { round: 3, reasonCode: 'REQUIRES_RESUBMISSION' });
    expect(svc.requestAction.mock.calls[0]).toEqual([sub, REQ_ID, { round: 3, reasonCode: 'REQUIRES_RESUBMISSION' }]);
    await acall('PUT', '/requirement-definitions/professional_license/status', t, { status: 'ACTIVE' });
    expect(svc.setRequirementStatus.mock.calls[0]).toEqual([sub, 'professional_license', { status: 'ACTIVE' }]);
    await acall('PUT', '/requirement-rules', t, {
      requirementCode: 'professional_license',
      marketCode: 'us-sf',
      serviceTypeCode: 'car_detailing',
      enabled: false,
    });
    expect(svc.setRequirementRule.mock.calls[0]).toEqual([
      sub,
      { requirementCode: 'professional_license', marketCode: 'us-sf', serviceTypeCode: 'car_detailing', enabled: false },
    ]);
  });

  it('the read operations receive no reviewer and no account: only their parameters', async () => {
    const t = await superAdmin();
    await acall('GET', `/cases/${CASE_ID}`, t);
    expect(svc.getCase.mock.calls[0]).toEqual([CASE_ID]);
    await acall('GET', '/policy', t);
    expect(svc.getPolicy.mock.calls[0]).toEqual([]);
    await acall('GET', '/cases', t);
    expect(svc.listCases.mock.calls[0]).toEqual([{ status: undefined, limit: undefined }]);
  });

  it('a reviewer, an account or a decision named by the client in a header, the query, the cookie or the body changes nothing / is refused', async () => {
    const t = await adminToken(ADMIN_ALL, { sub: ADMIN_SUB });
    const headers = { 'x-reviewer': 'admin:impostor', 'x-user': 'impostor', 'x-account-id': OTHER_ACCOUNT_ID, cookie: 'reviewer=impostor' };
    for (const r of AROUTES) {
      svc[r.fn].mockClear();
      const res = await acall(r.method, r.url, t, r.body, headers);
      expect(res.statusCode, r.operationId).toBe(200);
      expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain('impostor');
      expect(JSON.stringify(svc[r.fn].mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    }
    for (const r of ABODY_ROUTES)
      for (const extra of [
        { reviewer: 'admin:impostor' },
        { reviewedBy: 'x' },
        { accountId: OTHER_ACCOUNT_ID },
        { decision: 'APPROVED' },
        { status: 'APPROVED' },
        { note: 'x' },
        { comment: 'x' },
      ]) {
        if (r.fn === 'setRequirementStatus' && 'status' in extra) continue;
        svc[r.fn].mockClear();
        const res = await acall(r.method, r.url, t, { ...(r.body as object), ...extra });
        expect(res.statusCode, `${r.operationId} ${JSON.stringify(extra)}`).toBe(400);
        expect(svc[r.fn]).not.toHaveBeenCalled();
      }
  });

  describe('decision bodies', () => {
    const t = () => superAdmin();
    it.each(['start-review', 'approve', 'reject', 'request-action'])('%s requires the evidence round (1..10000)', async (action) => {
      const base = action === 'reject' || action === 'request-action' ? { reasonCode: 'DOCUMENT_UNREADABLE' } : {};
      for (const round of [undefined, 0, -1, 10_001, 1.5, '1', null, true, [1]])
        expect(
          (await acall('POST', `/requirements/${REQ_ID}/${action}`, await t(), { ...base, ...(round === undefined ? {} : { round }) })).statusCode,
          `${action} ${String(round)}`,
        ).toBe(400);
      for (const round of [1, 10_000]) expect((await acall('POST', `/requirements/${REQ_ID}/${action}`, await t(), { ...base, round })).statusCode).toBe(200);
    });
    it.each(['reject', 'request-action'])('%s requires a structured reason code (UPPER_SNAKE 3..48) and nothing free-form', async (action) => {
      for (const reasonCode of [
        undefined,
        '',
        'AB',
        'document_unreadable',
        'Document_Unreadable',
        'DOCUMENT-UNREADABLE',
        `A${'B'.repeat(48)}`,
        'DOC UNREADABLE',
        7,
        null,
      ])
        expect(
          (await acall('POST', `/requirements/${REQ_ID}/${action}`, await t(), { round: 1, ...(reasonCode === undefined ? {} : { reasonCode }) })).statusCode,
          `${action} ${String(reasonCode)}`,
        ).toBe(400);
      expect((await acall('POST', `/requirements/${REQ_ID}/${action}`, await t(), { round: 1, reasonCode: 'ANY_NEW_REASON' })).statusCode).toBe(200);
      // the reason must be a known one: THE SERVICE decides (REASON_INVALID); the edge only checks the shape
      expect(svc[action === 'reject' ? 'rejectRequirement' : 'requestAction'].mock.calls.at(-1)![2]).toEqual({ round: 1, reasonCode: 'ANY_NEW_REASON' });
      for (const extra of [{ note: 'free text' }, { reason: 'free text' }, { comment: 'x' }, { expiresAt: FUTURE }])
        expect(
          (await acall('POST', `/requirements/${REQ_ID}/${action}`, await t(), { round: 1, reasonCode: 'DOCUMENT_UNREADABLE', ...extra })).statusCode,
          JSON.stringify(extra),
        ).toBe(400);
    });
    it('approve: expiresAt is an optional ISO-8601 date-time with a zone', async () => {
      for (const expiresAt of ['2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000Z', '2027-01-01T12:30:00+02:00'])
        expect((await acall('POST', `/requirements/${REQ_ID}/approve`, await t(), { round: 1, expiresAt })).statusCode, expiresAt).toBe(200);
      for (const expiresAt of ['2027-01-01', '2027-01-01T00:00:00', 'tomorrow', '2027-13-01T00:00:00Z', '', null, 1767225600])
        expect((await acall('POST', `/requirements/${REQ_ID}/approve`, await t(), { round: 1, expiresAt })).statusCode, String(expiresAt)).toBe(400);
      expect((await acall('POST', `/requirements/${REQ_ID}/approve`, await t(), { round: 1 })).statusCode).toBe(200);
      expect(svc.approveRequirement.mock.calls.at(-1)![2]).toEqual({ round: 1 });
    });
    it('start-review, reject and request-action refuse expiresAt; approve refuses a reason code', async () => {
      expect((await acall('POST', `/requirements/${REQ_ID}/start-review`, await t(), { round: 1, expiresAt: FUTURE })).statusCode).toBe(400);
      expect((await acall('POST', `/requirements/${REQ_ID}/approve`, await t(), { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' })).statusCode).toBe(400);
      expect((await acall('POST', `/requirements/${REQ_ID}/start-review`, await t(), { round: 1, reasonCode: 'DOCUMENT_UNREADABLE' })).statusCode).toBe(400);
    });
    it.each(ABODY_ROUTES)('$method $url ($operationId): no body, an array, a string or an unknown key is a 400', async (r) => {
      for (const body of [undefined, [], 'text', 7, true, null, { ...(r.body as object), unknown: 1 }]) {
        const res =
          body === undefined ? await acall(r.method, r.url, await t()) : await rawBody(ADMIN_PREFIX, r.method, r.url, await t(), JSON.stringify(body));
        expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(svc[r.fn]).not.toHaveBeenCalled();
    });
    it('malformed JSON and wrong content types are 4xx', async () => {
      for (const r of ABODY_ROUTES)
        for (const [text, type] of [
          ['{', 'application/json'],
          ['not json', 'application/json'],
          ['round=1', 'application/x-www-form-urlencoded'],
          ['round=1', 'text/plain'],
        ] as const) {
          const res = await rawBody(ADMIN_PREFIX, r.method, r.url, await t(), text, type);
          expect(res.statusCode, `${r.url} ${text} ${type}`).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
        }
      expect(noServiceCalled()).toBe(true);
    });
    it('rule and status bodies', async () => {
      const bad: [string, string, unknown][] = [
        ['PUT', '/requirement-definitions/identity_verification/status', { status: 'active' }],
        ['PUT', '/requirement-definitions/identity_verification/status', { status: 'DELETED' }],
        ['PUT', '/requirement-definitions/identity_verification/status', { status: 'NOT_REQUIRED' }],
        ['PUT', '/requirement-definitions/identity_verification/status', {}],
        ['PUT', '/requirement-definitions/identity_verification/status', { status: 'ACTIVE', reason: 'why' }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, requirementCode: 'Identity' }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, marketCode: 'US-SF' }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, marketCode: '' }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, serviceTypeCode: 'Car-Detailing' }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, enabled: undefined }],
        ['PUT', '/requirement-rules', { requirementCode: 'identity_verification', enabled: true }],
        ['PUT', '/requirement-rules', { requirementCode: 'identity_verification', marketCode: null, enabled: true }],
        ['PUT', '/requirement-rules', { ...RULE_BODY, reason: 'x' }],
      ];
      for (const [m, u, b] of bad) expect((await acall(m as Method, u, await t(), b)).statusCode, `${u} ${JSON.stringify(b)}`).toBe(400);
      expect(noServiceCalled()).toBe(true);
      for (const status of ['ACTIVE', 'INACTIVE', 'RETIRED'])
        expect((await acall('PUT', '/requirement-definitions/identity_verification/status', await t(), { status })).statusCode, status).toBe(200);
      for (const body of [RULE_BODY, { ...RULE_BODY, marketCode: 'us-sf' }, { ...RULE_BODY, serviceTypeCode: 'car_detailing', enabled: false }])
        expect((await acall('PUT', '/requirement-rules', await t(), body)).statusCode).toBe(200);
      expect(svc.setRequirementRule.mock.calls.map((c) => c[1])).toEqual([
        RULE_BODY,
        { ...RULE_BODY, marketCode: 'us-sf' },
        { ...RULE_BODY, serviceTypeCode: 'car_detailing', enabled: false },
      ]);
    });
  });

  describe('path parameters', () => {
    const IDS_BAD = [
      'not-a-uuid',
      '123',
      REQ_ID.toUpperCase(),
      `${REQ_ID}0`,
      REQ_ID.slice(1),
      REQ_ID.replace(/-/g, ''),
      `x${REQ_ID}`,
      `${REQ_ID}%0A`,
      '..%2fx',
      '%00',
    ];
    it.each([
      ['GET', '/cases/ID'],
      ['GET', '/documents/ID/download'],
      ['POST', '/requirements/ID/start-review'],
      ['POST', '/requirements/ID/approve'],
      ['POST', '/requirements/ID/reject'],
      ['POST', '/requirements/ID/request-action'],
    ] as const)('%s %s: only a lower-case UUID is accepted, otherwise 400 before the service', async (method, tpl) => {
      for (const id of IDS_BAD) {
        const res = await acall(
          method,
          tpl.replace('ID', id),
          await superAdmin(),
          method === 'POST' ? { round: 1, reasonCode: 'DOCUMENT_UNREADABLE', ...(tpl.includes('start') ? {} : {}) } : undefined,
        );
        expect(res.statusCode, id).toBe(400);
        expect(errorOf(res).code, id).toBe('VALIDATION_FAILED');
        expectNoStore(res);
      }
      expect(noServiceCalled()).toBe(true);
    });
    it('PUT /requirement-definitions/:code/status: only a catalogue code is accepted', async () => {
      for (const code of ['a', 'Identity', 'identity-verification', 'identity__verification', '_x', `a${'b'.repeat(48)}`, '%20'])
        expect((await acall('PUT', `/requirement-definitions/${code}/status`, await superAdmin(), { status: 'ACTIVE' })).statusCode, code).toBe(400);
      expect(svc.setRequirementStatus).not.toHaveBeenCalled();
      expect((await acall('PUT', '/requirement-definitions/ab/status', await superAdmin(), { status: 'ACTIVE' })).statusCode).toBe(200);
    });
    it('an id of any account or case is a path parameter only; GET routes take no query besides the documented ones', async () => {
      for (const u of [`/cases/${CASE_ID}?accountId=${ACCOUNT_ID}`, `/cases/${CASE_ID}?x=1`, `/documents/${DOC_ID}/download?url=x`, '/policy?x=1']) {
        const res = await acall('GET', u, await superAdmin());
        expect(res.statusCode, u).toBe(400);
      }
      expect(noServiceCalled()).toBe(true);
    });
  });

  describe('GET /cases?status&limit', () => {
    it('defaults: nothing is passed on when nothing is asked', async () => {
      await acall('GET', '/cases', await superAdmin());
      expect(svc.listCases.mock.calls[0]).toEqual([{ status: undefined, limit: undefined }]);
    });
    it.each(['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED', 'CANCELLED'])('accepts the case status %s', async (status) => {
      expect((await acall('GET', `/cases?status=${status}`, await superAdmin())).statusCode).toBe(200);
      expect(svc.listCases.mock.calls.at(-1)![0]).toEqual({ status, limit: undefined });
    });
    it.each(['1', '2', '50', '99', '100'])('accepts the canonical integer limit %s and hands the NUMBER to the service', async (limit) => {
      expect((await acall('GET', `/cases?limit=${limit}`, await superAdmin())).statusCode).toBe(200);
      expect(svc.listCases.mock.calls.at(-1)![0]).toEqual({ status: undefined, limit: Number(limit) });
    });
    it.each([
      ['zero', 'limit=0'],
      ['101', 'limit=101'],
      ['negative', 'limit=-1'],
      ['empty', 'limit='],
      ['decimal', 'limit=1.5'],
      ['1.0', 'limit=1.0'],
      ['leading zero', 'limit=01'],
      ['plus sign', 'limit=%2B1'],
      ['exponent', 'limit=1e1'],
      ['hex', 'limit=0x10'],
      ['leading space', 'limit=%201'],
      ['trailing space', 'limit=1%20'],
      ['text', 'limit=ten'],
      ['a list', 'limit=1,2'],
      ['repeated', 'limit=1&limit=2'],
      ['a bracket array', 'limit[]=1'],
      ['huge', 'limit=99999999999999999999'],
      ['NaN', 'limit=NaN'],
      ['Infinity', 'limit=Infinity'],
      ['unknown status', 'status=REJECTED'],
      ['lower-case status', 'status=approved'],
      ['an overall-only status', 'status=NOT_STARTED'],
      ['an empty status', 'status='],
      ['an unknown parameter', 'accountId=x'],
      ['an offset', 'offset=1'],
      ['a name filter', 'name=x'],
      ['an email filter', 'email=a%40example.test'],
    ])('rejects %s with 400 before the service', async (_n, q) => {
      const res = await acall('GET', `/cases?${q}`, await superAdmin());
      expect(res.statusCode, `${q}: ${res.body}`).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expectNoStore(res);
      expect(svc.listCases).not.toHaveBeenCalled();
    });
    it('both filters together', async () => {
      await acall('GET', '/cases?status=IN_REVIEW&limit=25', await superAdmin());
      expect(svc.listCases.mock.calls[0]).toEqual([{ status: 'IN_REVIEW', limit: 25 }]);
    });
  });

  describe('response shapes', () => {
    const DOC_ADMIN_KEYS = [
      ...[
        'createdAt',
        'documentTypeCode',
        'documentTypeNameKey',
        'mimeType',
        'round',
        'scanStatus',
        'scanStatusKey',
        'sizeBytes',
        'status',
        'statusKey',
        'submittedAt',
        'verificationDocumentId',
      ],
      'sha256',
    ].sort();
    const ADMIN_REQ_KEYS = [
      'approvedAt',
      'caseRequirementId',
      'cycle',
      'documents',
      'evidenceKind',
      'expiresAt',
      'external',
      'nameKey',
      'requirementCode',
      'requirementType',
      'reviews',
      'round',
      'status',
      'statusKey',
      'superseded',
    ];
    const SUMMARY_KEYS = [
      'accountId',
      'awaitingReviewCount',
      'caseNumber',
      'requirementCount',
      'status',
      'statusKey',
      'submittedAt',
      'updatedAt',
      'verificationCaseId',
    ];
    const REVIEW_KEYS = ['decision', 'expiresAt', 'reasonCode', 'reasonKey', 'reviewId', 'reviewedAt', 'reviewer', 'round'];

    it('the case list is exactly the summaries: an internal account id and counters, no name, no contact', async () => {
      const res = await acall('GET', '/cases', await superAdmin());
      expect(keysOf(res.json() as object)).toEqual(['data', 'meta']);
      const items = dataOf(res) as unknown as Record<string, unknown>[];
      expect(keysOf(items[0]!)).toEqual(SUMMARY_KEYS);
      expect(items[0]!.accountId).toBe(ACCOUNT_ID);
      expect(items[0]!.statusKey).toBe(trustVerificationStatusKey('IN_REVIEW'));
      expect(TrustCaseListResponse.safeParse(res.json()).success).toBe(true);
      for (const s of PROVIDER_SENTINELS.filter((x) => ![OBJECT_KEY, 'trust/evidence/', HASH, SUB, KEYCLOAK_SID, SECRET_LINK].includes(x)))
        expect(res.body).not.toContain(s);
    });
    it('the case detail shows the document METADATA with the hash and the reviews, and no object key, no link, no external id', async () => {
      const res = await acall('GET', `/cases/${CASE_ID}`, await adminToken(['trust-read']));
      const d = dataOf(res) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(keysOf(d)).toEqual(['case', 'requirements']);
      expect(keysOf(d.case)).toEqual([...SUMMARY_KEYS, 'decidedAt', 'openedAt', 'revision'].sort());
      expect(keysOf(d.requirements[0])).toEqual(ADMIN_REQ_KEYS);
      expect(keysOf(d.requirements[0].documents[0])).toEqual(DOC_ADMIN_KEYS);
      expect(d.requirements[0].documents[0].sha256).toBe(HASH);
      expect(keysOf(d.requirements[0].reviews[0])).toEqual(REVIEW_KEYS);
      expect(d.requirements[0].reviews[0].reasonKey).toBe(trustReasonNameKey('DOCUMENT_UNREADABLE'));
      expect(d.requirements[0].nameKey).toBe(trustRequirementNameKey('identity_verification'));
      expect(TrustCaseDetailResponse.safeParse(res.json()).success).toBe(true);
      for (const w of [OBJECT_KEY, 'trust/evidence/', SECRET_LINK, EXTERNAL_ID, 'objectKey', 'url']) expect(res.body, w).not.toContain(w);
    });
    it('the case detail never trusts its input: extra fields, a link and an external id on the view are dropped', async () => {
      const dirty = caseDetail() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      dirty.accountEmail = 'victim@leak-check.example';
      dirty.requirements[0].documents[0].objectKey = OBJECT_KEY;
      dirty.requirements[0].documents[0].url = SECRET_LINK;
      dirty.requirements[0].external = { adapter: 'fake', status: 'PENDING', lastCheckedAt: null, externalId: EXTERNAL_ID, payload: { x: 1 } };
      dirty.requirements[0].reviews[0].correlationId = 'c-1';
      svc.getCase.mockResolvedValueOnce(dirty);
      const res = await acall('GET', `/cases/${CASE_ID}`, await adminToken(['trust-read']));
      for (const w of [OBJECT_KEY, SECRET_LINK, EXTERNAL_ID, 'victim@leak-check.example', 'c-1', 'payload']) expect(res.body, w).not.toContain(w);
      const ext = (dataOf(res) as Record<string, any>).requirements[0].external as object; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(keysOf(ext)).toEqual(['adapter', 'lastCheckedAt', 'requirementCode', 'status']);
      expect(ext).toMatchObject({ requirementCode: 'identity_verification', adapter: 'fake' });
    });
    it.each(['start-review', 'approve', 'reject', 'request-action'])('%s answers 200 with { requirement, caseStatus, changed }', async (action) => {
      const body = action === 'start-review' ? { round: 1 } : action === 'approve' ? APPROVE_BODY : REASON_BODY;
      const res = await acall('POST', `/requirements/${REQ_ID}/${action}`, await adminToken(['trust-review']), body);
      expect(res.statusCode, res.body).toBe(200);
      const d = dataOf(res) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(keysOf(d)).toEqual(['caseStatus', 'changed', 'requirement']);
      expect(keysOf(d.requirement)).toEqual(ADMIN_REQ_KEYS);
      expect(d.changed).toBe(true);
      expect(TrustRequirementDecisionResponse.safeParse(res.json()).success).toBe(true);
      // a repeated decision is a 200 with changed:false, never a created/204
      svc.startReview.mockResolvedValueOnce({ ...decisionView(), changed: false });
      svc.approveRequirement.mockResolvedValueOnce({ ...decisionView(), changed: false });
      svc.rejectRequirement.mockResolvedValueOnce({ ...decisionView(), changed: false });
      svc.requestAction.mockResolvedValueOnce({ ...decisionView(), changed: false });
      const again = await acall('POST', `/requirements/${REQ_ID}/${action}`, await adminToken(['trust-review']), body);
      expect(again.statusCode).toBe(200);
      expect((dataOf(again) as { changed: boolean }).changed).toBe(false);
    });
    it('the download answers exactly { url, expiresAt } (the one admin response with a link) and only to trust-review', async () => {
      const res = await acall('GET', `/documents/${DOC_ID}/download`, await adminToken(['trust-review']));
      expect(dataOf(res)).toEqual({ url: SECRET_LINK, expiresAt: ISO });
      expect(TrustDownloadResponse.safeParse(res.json()).success).toBe(true);
      svc.downloadDocument.mockResolvedValueOnce({ url: SECRET_LINK, expiresAt: ISO, objectKey: OBJECT_KEY, sha256: HASH });
      const hostile = await acall('GET', `/documents/${DOC_ID}/download`, await adminToken(['trust-review']));
      expect(keysOf(dataOf(hostile))).toEqual(['expiresAt', 'url']);
      expect(hostile.body).not.toContain(OBJECT_KEY);
      expect(hostile.body).not.toContain(HASH);
      expectNoStore(hostile);
    });
    it('the policy answers definitions, rules and document types with name keys; the status and rule results carry a changed flag', async () => {
      const res = await acall('GET', '/policy', await adminToken(['trust-admin']));
      const d = dataOf(res) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(keysOf(d)).toEqual(['documentTypes', 'requirements', 'rules']);
      expect(keysOf(d.requirements[0])).toEqual(['code', 'evidenceKind', 'expiryRequired', 'nameKey', 'requirementType', 'status']);
      expect(d.requirements[1].nameKey).toBe(trustRequirementNameKey('background_check'));
      expect(keysOf(d.rules[0])).toEqual(['enabled', 'marketCode', 'requirementCode', 'serviceTypeCode']);
      expect(keysOf(d.documentTypes[0])).toEqual(['code', 'nameKey', 'requirementType']);
      expect(d.documentTypes[0].nameKey).toBe(trustDocumentTypeNameKey('drivers_license'));
      expect(TrustPolicyResponse.safeParse(res.json()).success).toBe(true);
      const status = await acall('PUT', '/requirement-definitions/identity_verification/status', await adminToken(['trust-admin']), { status: 'INACTIVE' });
      expect(dataOf(status)).toEqual({ code: 'identity_verification', status: 'INACTIVE', changed: true });
      const rule = await acall('PUT', '/requirement-rules', await adminToken(['trust-admin']), RULE_BODY);
      expect(dataOf(rule)).toEqual({ ...RULE_BODY, changed: true });
    });
    it('the admin mappers are field-by-field (a unit check of the DTO functions)', () => {
      const dirty = { ...caseDetail(), accountEmail: 'x' } as never;
      expect(keysOf(caseDetailDto(dirty))).toEqual(['case', 'requirements']);
      expect(keysOf(caseSummaryDto({ ...caseSummary(), email: 'x' } as never))).toEqual(SUMMARY_KEYS);
      expect(keysOf(decisionDto({ ...decisionView(), secret: 1 } as never))).toEqual(['caseStatus', 'changed', 'requirement']);
      expect(keysOf(policyDto({ ...policyView(), secret: 1 } as never))).toEqual(['documentTypes', 'requirements', 'rules']);
    });
  });
});

// ====================================================================== OpenAPI inventory and the committed specs
describe('OpenAPI inventory and the committed documents', () => {
  type Op = {
    operationId: string;
    tags: string[];
    security?: unknown[];
    responses: Record<string, unknown>;
    parameters?: { name: string; in: string; required?: boolean }[];
    summary?: string;
  };
  const swagger = () => app.swagger() as unknown as { tags?: { name: string }[]; paths: Record<string, Record<string, Op>> };
  const found = () => {
    const doc = swagger();
    const out: { operationId: string; method: string; path: string; op: Op }[] = [];
    for (const [p, item] of Object.entries(doc.paths))
      if (p.startsWith(PROVIDER_PREFIX) || p.startsWith(ADMIN_PREFIX))
        for (const [method, op] of Object.entries(item)) out.push({ operationId: op.operationId, method: method.toUpperCase(), path: p, op });
    return out;
  };

  it('documents exactly the 11 provider and 10 administrator operations with the right method, path, tag and bearer security', () => {
    const f = found();
    expect(f).toHaveLength(21);
    expect(f.map((x) => x.operationId).sort()).toEqual([...ROUTES.map((r) => r.operationId), ...AROUTES.map((r) => r.operationId)].sort());
    for (const r of [...ROUTES, ...AROUTES]) {
      const x = f.find((y) => y.operationId === r.operationId)!;
      expect([x.method, x.path], r.operationId).toEqual([r.method, r.spec]);
      expect(x.op.tags, r.operationId).toEqual(['trust']);
      expect(x.op.security, r.operationId).toEqual([{ bearerAuth: [] }]);
    }
    expect((swagger().tags ?? []).map((t) => t.name)).toContain('trust');
  });

  it('documents the failure responses of every operation (and 201 for open and upload)', () => {
    const doc = swagger();
    for (const r of [...ROUTES, ...AROUTES]) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      const ok = 'okStatus' in r && r.okStatus === 201 ? ['201'] : ['200'];
      expect(Object.keys(op.responses), r.operationId).toEqual(expect.arrayContaining([...ok, '400', '401', '403', '404', '409', '503']));
    }
    expect(Object.keys(doc.paths[PROVIDER_PREFIX]!.post!.responses)).toEqual(expect.arrayContaining(['200', '201']));
  });

  it('path parameters are only a document id, a requirement id or a requirement code: never an account', () => {
    const doc = swagger();
    for (const r of [...ROUTES, ...AROUTES]) {
      const op = doc.paths[r.spec]![r.method.toLowerCase()]!;
      const names = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      expect(names, r.operationId).toEqual([...r.spec.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      for (const n of names) expect(['id', 'code']).toContain(n);
    }
    for (const p of Object.keys(doc.paths).filter((x) => x.startsWith(PROVIDER_PREFIX))) expect(p).not.toMatch(/account/i);
  });

  it('documents the query of the case list (status, limit) and no query on any other operation', () => {
    const doc = swagger();
    const q = (r: { spec: string; method: string }) =>
      (doc.paths[r.spec]![r.method.toLowerCase()]!.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => p.name)
        .sort();
    expect(q(AROUTES[0]!)).toEqual(['limit', 'status']);
    for (const r of [...ROUTES, ...AROUTES.slice(1)]) expect(q(r), r.operationId).toEqual([]);
  });

  it('is not registered without the service (both prefixes), nor without the account service (provider prefix only)', async () => {
    const withoutService = await makeApp({ trust: undefined });
    const withoutAccounts = await makeApp({ accounts: undefined });
    for (const r of ROUTES)
      for (const target of [withoutService, withoutAccounts]) {
        const res = await routeCall(r, await webToken(), {}, target);
        expect(res.statusCode, r.operationId).toBe(404);
        expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
        expectNoStore(res);
      }
    for (const r of AROUTES) {
      const res = await aCall(r, await superAdmin(), {}, withoutService);
      expect(res.statusCode, r.operationId).toBe(404);
      expectNoStore(res);
      // the administrator routes need no account service
      expect((await aCall(r, await superAdmin(), {}, withoutAccounts)).statusCode, r.operationId).toBe(200);
    }
    expect(Object.values(svc).filter((f) => f.mock.calls.length > 0).length).toBe(AROUTES.length);
  });

  const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

  it('the committed OpenAPI document lists every operation id and path, and no other trust path', () => {
    const openapi = read('docs/api/openapi.yaml');
    for (const r of [...ROUTES, ...AROUTES]) {
      expect(openapi, r.operationId).toContain(`operationId: ${r.operationId}`);
      expect(openapi, r.spec).toMatch(new RegExp(`^ {2}${r.spec.replace(/[{}]/g, '\\$&')}:`, 'm'));
    }
    const committed = [...openapi.matchAll(/^ {2}(\/api\/v1\/(?:provider\/verification|admin\/trust)[^:]*):/gm)].map((m) => m[1]).sort();
    expect(committed).toEqual([...new Set([...ROUTES, ...AROUTES].map((r) => r.spec))].sort());
  });

  it('the committed OpenAPI paths of both prefixes are EXACTLY what the app generates (no hand edit, no stale file)', () => {
    const committed = parseYaml(read('docs/api/openapi.yaml')) as { paths: Record<string, unknown>; tags?: { name: string; description: string }[] };
    const doc = JSON.parse(JSON.stringify(swagger())) as { paths: Record<string, unknown>; tags?: { name: string; description: string }[] };
    const pick = (paths: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(paths)
          .filter(([p]) => p.startsWith(PROVIDER_PREFIX) || p.startsWith(ADMIN_PREFIX))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    expect(Object.keys(pick(committed.paths))).toHaveLength(Object.keys(pick(doc.paths)).length);
    expect(pick(committed.paths)).toEqual(pick(doc.paths));
    expect(committed.tags?.find((t) => t.name === 'trust')).toEqual(doc.tags?.find((t) => t.name === 'trust'));
    // and the YAML text of the whole document is the generator's output for the same app (what `pnpm specs:check` compares)
    expect(stringifyYaml(JSON.parse(JSON.stringify(committed.paths[ROUTES[0]!.spec])), { lineWidth: 0 })).toBe(
      stringifyYaml(doc.paths[ROUTES[0]!.spec], { lineWidth: 0 }),
    );
  });

  it('the committed AsyncAPI document lists the seven trust events: channels, send operations, addresses and payload fields', () => {
    const spec = parseYaml(read('docs/events/asyncapi.yaml')) as {
      channels: Record<string, { address: string; messages: Record<string, unknown> }>;
      operations: Record<string, { action: string; channel: { $ref: string } }>;
      components: {
        schemas: Record<
          string,
          { properties: { eventType: { const: string }; payload: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } } }
        >;
      };
    };
    const expected: [string, string, string, string[]][] = [
      ['caseOpened', 'ProviderVerificationCaseOpened', TRUST_EVENTS.caseOpened, ['accountId', 'caseNumber', 'status', 'verificationCaseId']],
      ['submitted', 'ProviderVerificationSubmitted', TRUST_EVENTS.submitted, ['accountId', 'caseNumber', 'status', 'verificationCaseId']],
      ['requirementApproved', 'ProviderVerificationRequirementApproved', TRUST_EVENTS.requirementApproved, REQ_PAYLOAD()],
      ['requirementRejected', 'ProviderVerificationRequirementRejected', TRUST_EVENTS.requirementRejected, REQ_PAYLOAD()],
      ['actionRequired', 'ProviderVerificationActionRequired', TRUST_EVENTS.actionRequired, REQ_PAYLOAD()],
      ['expired', 'ProviderVerificationExpired', TRUST_EVENTS.expired, REQ_PAYLOAD()],
      ['completed', 'ProviderVerificationCompleted', TRUST_EVENTS.completed, ['accountId', 'caseNumber', 'status', 'verificationCaseId']],
    ];
    const trustChannels = Object.keys(spec.channels).filter((k) => k.startsWith('trust_'));
    expect(trustChannels.sort()).toEqual(expected.map((e) => `trust_${e[0]}`).sort());
    for (const [key, name, type, payloadKeys] of expected) {
      expect(spec.channels[`trust_${key}`]!.address).toBe(type);
      expect(Object.keys(spec.channels[`trust_${key}`]!.messages)).toEqual([name]);
      expect(spec.operations[`send${name}`]).toMatchObject({ action: 'send', channel: { $ref: `#/channels/trust_${key}` } });
      const schema = spec.components.schemas[name]!;
      expect(schema.properties.eventType.const).toBe(type);
      expect(Object.keys(schema.properties.payload.properties).sort(), name).toEqual(payloadKeys);
      expect([...schema.properties.payload.required].sort(), name).toEqual(payloadKeys);
      expect(schema.properties.payload.additionalProperties).toBe(false);
    }
    // identifiers and codes only: no payload field is a hash, a key, a link, a contact, a name or text
    for (const [, name] of expected)
      for (const k of Object.keys(spec.components.schemas[name]!.properties.payload.properties))
        expect(k).not.toMatch(/sha|hash|key$|url|email|phone|name$|text|body|content/i);
  });
});
function REQ_PAYLOAD(): string[] {
  return [
    'accountId',
    'caseNumber',
    'caseRequirementId',
    'reasonCode',
    'requirementCode',
    'requirementStatus',
    'requirementType',
    'status',
    'verificationCaseId',
  ];
}

// ====================================================================== the adapters of the composition root (modules/trust/wiring.ts)
describe('the ports over the owning services', () => {
  const refused = async (p: Promise<unknown>) =>
    (await p.then(
      () => null,
      (e: unknown) => e,
    )) as TrustError | null;

  describe('createProviderContextPort', () => {
    const facts = (over: Partial<AccountFacts> = {}): AccountFacts => ({
      accountId: ACCOUNT_ID,
      status: 'ACTIVE',
      memberships: [{ code: 'CUSTOMER', status: 'ACTIVE' }],
      emailVerified: true,
      phoneVerified: true,
      ...over,
    });
    const policy = (over: Record<string, unknown> = {}) => ({
      requireVerifiedEmail: true,
      requireVerifiedPhone: true,
      marketStatusesAllowed: ['ACTIVE'],
      minServiceTypes: 1,
      maxServiceTypes: 10,
      ...over,
    });
    const registration = (over: Record<string, unknown> = {}) => ({
      providerRegistrationId: CASE_ID,
      attempt: 1,
      status: 'IN_PROGRESS',
      revision: 2,
      marketCode: 'us-sf',
      serviceTypeCodes: ['car_detailing', 'regular_cleaning'],
      createdAt: ISO,
      completedAt: null,
      cancelledAt: null,
      ...over,
    });
    const make = (o: { facts?: unknown; policy?: unknown; state?: unknown } = {}) => {
      const factsFn = vi.fn(async () => {
        if (o.facts instanceof Error) throw o.facts;
        return (o.facts ?? facts()) as AccountFacts;
      });
      const policyFn = vi.fn(async () => {
        if (o.policy instanceof Error) throw o.policy;
        return o.policy ?? policy();
      });
      const getRegistration = vi.fn(async () => {
        if (o.state instanceof Error) throw o.state;
        return o.state === undefined ? { providerRole: 'PENDING', registration: registration() } : o.state;
      });
      const getter = vi.fn(() => ({ getRegistration }));
      const port = createProviderContextPort({
        accounts: { facts: factsFn, grantRole: vi.fn() },
        policy: { policy: policyFn } as never,
        registrations: getter as never,
      });
      return { port, factsFn, policyFn, getRegistration, getter };
    };

    it('reads the facts ONCE and hands the same facts to the registration read (no second account read), and reports the live registration', async () => {
      const m = make();
      const ctx = await m.port.context(ACCOUNT_ID);
      expect(ctx).toEqual({
        accountActive: true,
        contactsVerified: true,
        registrationLive: true,
        marketCode: 'us-sf',
        serviceTypeCodes: ['car_detailing', 'regular_cleaning'],
      });
      expect(m.factsFn).toHaveBeenCalledTimes(1);
      expect(m.factsFn).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(m.policyFn).toHaveBeenCalledTimes(1);
      expect(m.getRegistration).toHaveBeenCalledTimes(1);
      const [id, opts] = m.getRegistration.mock.calls[0] as unknown as [string, { facts: AccountFacts }];
      expect(id).toBe(ACCOUNT_ID);
      expect(opts.facts).toEqual(facts());
    });
    it('returns exactly the five documented keys (nothing personal)', async () => {
      expect(Object.keys((await make().port.context(ACCOUNT_ID))!).sort()).toEqual([
        'accountActive',
        'contactsVerified',
        'marketCode',
        'registrationLive',
        'serviceTypeCodes',
      ]);
    });
    it('the registrations getter is lazy: it is called per context() and never at construction', async () => {
      const m = make();
      expect(m.getter).not.toHaveBeenCalled();
      await m.port.context(ACCOUNT_ID);
      await m.port.context(ACCOUNT_ID);
      expect(m.getter).toHaveBeenCalledTimes(2);
    });
    it('an unknown or not-active account (ProviderError ACCOUNT_NOT_ACTIVE from the account port) is null', async () => {
      const m = make({ facts: new ProviderError('ACCOUNT_NOT_ACTIVE', 'gone', { reason: 'ACCOUNT_NOT_FOUND' }) });
      expect(await m.port.context(ACCOUNT_ID)).toBeNull();
      expect(m.policyFn).not.toHaveBeenCalled();
      expect(m.getRegistration).not.toHaveBeenCalled();
    });
    it.each([
      ['a ProviderError UNAVAILABLE', new ProviderError('UNAVAILABLE', 'db down')],
      ['a ProviderError CONFLICT', new ProviderError('CONFLICT', 'x', { retryable: true })],
      ['a ProviderError PREREQUISITE_NOT_MET', new ProviderError('PREREQUISITE_NOT_MET', 'x')],
      ['an AccountError', new AccountError('UNAVAILABLE', 'host=10.1.1.1')],
      ['a plain Error', new Error('boom: password=hunter2')],
      ['a TypeError', new TypeError('x is undefined')],
    ])('%s from the account port is UNAVAILABLE (fail closed, nothing leaked)', async (_n, err) => {
      const e = await refused(make({ facts: err }).port.context(ACCOUNT_ID));
      expect(e).toBeInstanceOf(TrustError);
      expect(e).toMatchObject({ code: 'UNAVAILABLE' });
      expect(JSON.stringify([e!.message, e!.details])).not.toMatch(/hunter2|10\.1\.1\.1|boom|db down/);
    });
    it.each([
      ['the policy read failing', { policy: new Error('cfg down: password=x') }],
      ['the registration read failing', { state: new Error('db down') }],
      ['the registration read failing with ACCOUNT_NOT_ACTIVE (not a "no account" answer here)', { state: new ProviderError('ACCOUNT_NOT_ACTIVE', 'x') }],
      ['an invalid policy object', { policy: undefined, state: new TypeError('policy.requireVerifiedEmail') }],
    ])('%s is UNAVAILABLE', async (_n, o) => {
      const e = await refused(make(o as never).port.context(ACCOUNT_ID));
      expect(e).toMatchObject({ code: 'UNAVAILABLE' });
      expect(JSON.stringify([e!.message, e!.details])).not.toMatch(/password|db down|cfg down/);
    });
    it('accountActive is the account status: SUSPENDED and CLOSED are reported (not hidden as null)', async () => {
      for (const status of ['SUSPENDED', 'CLOSED', 'PENDING_DELETION']) {
        const ctx = await make({ facts: facts({ status }) }).port.context(ACCOUNT_ID);
        expect(ctx, status).not.toBeNull();
        expect(ctx!.accountActive, status).toBe(false);
      }
      expect((await make({ facts: facts({ status: 'ACTIVE' }) }).port.context(ACCOUNT_ID))!.accountActive).toBe(true);
    });
    it('contactsVerified follows the REGISTRATION POLICY: required contacts must be verified, a contact the policy does not require does not count', async () => {
      const rows: [Record<string, boolean>, Record<string, boolean>, boolean][] = [
        // policy {email, phone}, facts {email, phone}, expected
        [{ e: true, p: true }, { e: true, p: true }, true],
        [{ e: true, p: true }, { e: true, p: false }, false],
        [{ e: true, p: true }, { e: false, p: true }, false],
        [{ e: true, p: true }, { e: false, p: false }, false],
        [{ e: true, p: false }, { e: true, p: false }, true],
        [{ e: true, p: false }, { e: false, p: true }, false],
        [{ e: false, p: true }, { e: false, p: true }, true],
        [{ e: false, p: true }, { e: true, p: false }, false],
        [{ e: false, p: false }, { e: false, p: false }, true],
        [{ e: false, p: false }, { e: true, p: true }, true],
      ];
      for (const [pol, f, want] of rows) {
        const ctx = await make({
          policy: policy({ requireVerifiedEmail: pol.e, requireVerifiedPhone: pol.p }),
          facts: facts({ emailVerified: f.e, phoneVerified: f.p }),
        }).port.context(ACCOUNT_ID);
        expect(ctx!.contactsVerified, `policy ${JSON.stringify(pol)} facts ${JSON.stringify(f)}`).toBe(want);
      }
    });
    it('only a LIVE registration counts: none, or a CANCELLED one, is not live and leaks no market or service types; IN_PROGRESS and COMPLETED are live', async () => {
      const none = await make({ state: { providerRole: 'NONE', registration: null } }).port.context(ACCOUNT_ID);
      expect(none).toMatchObject({ registrationLive: false, marketCode: null, serviceTypeCodes: [] });
      const cancelled = await make({
        state: { providerRole: 'PENDING', registration: registration({ status: 'CANCELLED', cancelledAt: ISO }) },
      }).port.context(ACCOUNT_ID);
      expect(cancelled).toMatchObject({ registrationLive: false, marketCode: null, serviceTypeCodes: [] });
      for (const status of ['IN_PROGRESS', 'COMPLETED']) {
        const live = await make({ state: { providerRole: 'PENDING', registration: registration({ status }) } }).port.context(ACCOUNT_ID);
        expect(live, status).toMatchObject({ registrationLive: true, marketCode: 'us-sf', serviceTypeCodes: ['car_detailing', 'regular_cleaning'] });
      }
    });
    it('a live registration without a market yet reports a null market and the selected types as given', async () => {
      const ctx = await make({ state: { providerRole: 'PENDING', registration: registration({ marketCode: null, serviceTypeCodes: [] }) } }).port.context(
        ACCOUNT_ID,
      );
      expect(ctx).toMatchObject({ registrationLive: true, marketCode: null, serviceTypeCodes: [] });
    });
    it('the service type list is a copy (a later change by the caller cannot alter the registration view)', async () => {
      const reg = registration();
      const ctx = await make({ state: { providerRole: 'PENDING', registration: reg } }).port.context(ACCOUNT_ID);
      expect(ctx!.serviceTypeCodes).toEqual(reg.serviceTypeCodes);
      expect(ctx!.serviceTypeCodes).not.toBe(reg.serviceTypeCodes);
    });
  });

  describe('createTrustPolicyProvider', () => {
    const K = TRUST_POLICY_KEYS;
    const resolved = (over: Record<string, unknown> = {}) =>
      new Map(
        Object.entries({
          [K.maxSizeBytes]: 10_485_760,
          [K.allowedMimeTypes]: ['application/pdf', 'image/jpeg', 'image/png'],
          [K.maxDocumentsPerRequirement]: 5,
          [K.uploadUrlTtlSeconds]: 300,
          [K.downloadUrlTtlSeconds]: 60,
          [K.requireCleanScan]: true,
          ...over,
        }).map(([k, v]) => [k, { value: v }]),
      );
    const provider = (values: unknown, spy = vi.fn()) => ({ spy, p: createTrustPolicyProvider({ resolveMany: spy.mockResolvedValue({ values }) } as never) });
    it('reads exactly the six keys, in one batched read, and returns the typed policy', async () => {
      const { spy, p } = provider(resolved());
      expect(await p.documents()).toEqual({
        maxSizeBytes: 10_485_760,
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        maxDocumentsPerRequirement: 5,
        uploadUrlTtlSeconds: 300,
        downloadUrlTtlSeconds: 60,
        requireCleanScan: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect([...spy.mock.calls[0]![0]].sort()).toEqual(Object.values(K).sort());
    });
    it('maps every key to its own field (no two swapped)', async () => {
      const { p } = provider(
        resolved({
          [K.maxSizeBytes]: 2048,
          [K.allowedMimeTypes]: ['image/png'],
          [K.maxDocumentsPerRequirement]: 7,
          [K.uploadUrlTtlSeconds]: 61,
          [K.downloadUrlTtlSeconds]: 17,
          [K.requireCleanScan]: false,
        }),
      );
      expect(await p.documents()).toEqual({
        maxSizeBytes: 2048,
        allowedMimeTypes: ['image/png'],
        maxDocumentsPerRequirement: 7,
        uploadUrlTtlSeconds: 61,
        downloadUrlTtlSeconds: 17,
        requireCleanScan: false,
      });
    });
    it('reads fresh every time (nothing is cached by the provider)', async () => {
      const { spy, p } = provider(resolved());
      await p.documents();
      await p.documents();
      expect(spy).toHaveBeenCalledTimes(2);
    });
    it('an unreadable registry is UNAVAILABLE POLICY_UNREADABLE and leaks nothing', async () => {
      const failing = createTrustPolicyProvider({ resolveMany: vi.fn().mockRejectedValue(new Error('cfg down: password=x')) } as never);
      const e = await refused(failing.documents());
      expect(e).toBeInstanceOf(TrustError);
      expect(e).toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
      expect(JSON.stringify([e!.message, e!.details])).not.toContain('password');
    });
    it('a missing, mistyped, out-of-range or contradictory value is UNAVAILABLE POLICY_INVALID (no code default, fail closed)', async () => {
      const missing = (k: string) => {
        const m = resolved();
        m.delete(k);
        return m;
      };
      for (const values of [
        new Map(),
        ...Object.values(K).map(missing),
        resolved({ [K.maxSizeBytes]: '10485760' }),
        resolved({ [K.maxSizeBytes]: 100 }),
        resolved({ [K.maxSizeBytes]: 52_428_801 }),
        resolved({ [K.allowedMimeTypes]: [] }),
        resolved({ [K.allowedMimeTypes]: ['application/pdf', 'application/pdf'] }),
        resolved({ [K.allowedMimeTypes]: 'application/pdf' }),
        resolved({ [K.maxDocumentsPerRequirement]: 0 }),
        resolved({ [K.maxDocumentsPerRequirement]: 21 }),
        resolved({ [K.uploadUrlTtlSeconds]: 5 }),
        resolved({ [K.downloadUrlTtlSeconds]: 5000 }),
        resolved({ [K.requireCleanScan]: 'yes' }),
        resolved({ [K.requireCleanScan]: 1 }),
      ])
        expect(await refused(provider(values).p.documents()), JSON.stringify([...values.keys()].length)).toMatchObject({
          code: 'UNAVAILABLE',
          details: { reason: 'POLICY_INVALID' },
        });
    });
    it('a policy outage reaches a client as 503 TRUST_UNAVAILABLE with only the message key', () => {
      try {
        toAppError(new TrustError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID' }));
        expect.unreachable();
      } catch (e) {
        expect(e).toMatchObject({ category: 'DEPENDENCY', code: 'TRUST_UNAVAILABLE', details: { messageKey: 'trust.verification.error.unavailable' } });
      }
    });
  });

  describe('createTrustPrerequisites (PRO-001 asks the verification domain for its onboarding step)', () => {
    const view = (status: TrustOverallStatus) => ({ overall: { status } });
    const prereq = (impl: (id: string) => Promise<unknown>, rest?: PrerequisitePort) =>
      createTrustPrerequisites({ getVerification: vi.fn(impl) } as never, rest);
    it.each<[TrustOverallStatus, string]>([
      ['NOT_REQUIRED', 'NOT_REQUIRED'],
      ['NOT_STARTED', 'NOT_STARTED'],
      ['OPEN', 'IN_PROGRESS'],
      ['IN_REVIEW', 'IN_PROGRESS'],
      ['ACTION_REQUIRED', 'BLOCKED'],
      ['EXPIRED', 'BLOCKED'],
      ['APPROVED', 'COMPLETE'],
    ])('overall %s is the onboarding step status %s', async (overall, step) => {
      expect(await prereq(async () => view(overall)).verification(ACCOUNT_ID)).toEqual({ status: step });
    });
    it('the mapping covers every overall status of the contract', async () => {
      for (const s of ['NOT_REQUIRED', 'NOT_STARTED', 'OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED'] as TrustOverallStatus[])
        expect(['NOT_REQUIRED', 'NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE']).toContain(
          (await prereq(async () => view(s)).verification(ACCOUNT_ID)).status,
        );
    });
    it('asks for the overview of THE account', async () => {
      const getVerification = vi.fn(async () => view('OPEN'));
      await createTrustPrerequisites({ getVerification } as never).verification(OTHER_ACCOUNT_ID);
      expect(getVerification).toHaveBeenCalledTimes(1);
      expect(getVerification).toHaveBeenCalledWith(OTHER_ACCOUNT_ID);
    });
    it.each([
      ['a TrustError UNAVAILABLE', new TrustError('UNAVAILABLE', 'x')],
      ['a TrustError ACCOUNT_NOT_ACTIVE', new TrustError('ACCOUNT_NOT_ACTIVE', 'x')],
      ['a plain Error', new Error('db down')],
      ['a TypeError', new TypeError('x')],
    ])('%s is NOT_AVAILABLE (a failure of verification never breaks or blocks the registration read)', async (_n, err) => {
      expect(await prereq(async () => Promise.reject(err)).verification(ACCOUNT_ID)).toEqual({ status: 'NOT_AVAILABLE' });
    });
    it('a missing overview is NOT_AVAILABLE, never a crash', async () => {
      expect(await prereq(async () => undefined).verification(ACCOUNT_ID)).toEqual({ status: 'NOT_AVAILABLE' });
    });
    it('the other future steps stay as they were: the default is NOT_AVAILABLE for subscription, profile and Gigs', async () => {
      const p = prereq(async () => view('APPROVED'));
      for (const step of ['subscription', 'profile', 'gigs'] as const) expect(await p[step](ACCOUNT_ID), step).toEqual({ status: 'NOT_AVAILABLE' });
      expect(Object.keys(p).sort()).toEqual(['gigs', 'profile', 'subscription', 'verification']);
    });
    it('a given `rest` port keeps answering subscription, profile and Gigs (called with the account), and its own verification is replaced', async () => {
      const rest: PrerequisitePort = {
        verification: vi.fn(async () => ({ status: 'COMPLETE' as const })),
        subscription: vi.fn(async () => ({ status: 'IN_PROGRESS' as const })),
        profile: vi.fn(async () => ({ status: 'BLOCKED' as const })),
        gigs: vi.fn(async () => ({ status: 'NOT_REQUIRED' as const })),
      };
      const p = prereq(async () => view('NOT_STARTED'), rest);
      expect(await p.verification(ACCOUNT_ID)).toEqual({ status: 'NOT_STARTED' });
      expect(await p.subscription(ACCOUNT_ID)).toEqual({ status: 'IN_PROGRESS' });
      expect(await p.profile(ACCOUNT_ID)).toEqual({ status: 'BLOCKED' });
      expect(await p.gigs(ACCOUNT_ID)).toEqual({ status: 'NOT_REQUIRED' });
      expect(rest.verification).not.toHaveBeenCalled();
      expect(rest.subscription).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(rest.profile).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(rest.gigs).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(UnavailablePrerequisites.verification).toBeDefined();
    });
  });
});
