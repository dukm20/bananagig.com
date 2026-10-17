// Unit tests of the HTTP layer of the shared account area (ACC-001, docs/engineering/ACCOUNT_AREA.md) with a FAKE registry (FakeAccountArea), a fake AccountService, a fake
// SecurityOperations and a fake ConsentOperations (the registry query is covered against PostgreSQL by account-area.itest.ts): authentication and the identity context
// (401 before 400, 403 for the admin context, suspended or closed accounts and roles the account does not hold, all BEFORE the registry is asked), the uniform 404 of a section
// the ACTIVE role does not have (identical body for hidden, empty and role-less, never naming the section or the role), the validated active role being the only role the
// registry ever sees, one registry read per request, response shapes equal to the contracts, strict queries and bodies, the field to section authorization of the partial
// profile update, the error mapping, the routes that exist only when their service is wired, the composition-only privacy and contact sections, and the OpenAPI document.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { loadConfig } from '@bananagig/config';
import {
  ACCOUNT_SECTIONS,
  AccountNavigationResponse,
  AccountProfileViewResponse,
  AccountResponse,
  AccountRolesSectionResponse,
  ContactVerificationSectionResponse,
  CORRELATION_HEADER,
  ErrorResponse,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  SecuritySummaryResponse,
  accountSectionDescriptionKey,
  accountSectionLabelKey,
  publicDisplayName,
  type AccountSectionDto,
} from '@bananagig/contracts';
import {
  AccountError,
  AccountService,
  FakeAccountArea,
  type AccountAreaOperations,
  type AccountContext,
  type ConsentOperations,
  type SecurityOperations,
} from '@bananagig/accounts';
import type { Database } from '@bananagig/database';
import { createTokenVerifier, type TokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, TEST_ISSUER, unsignedToken, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, type AppDeps } from './app';
import { assertAccountSections, sectionsOfRequest } from './plugins/account-section';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let verifier: TokenVerifier;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

// ---------------------------------------------------------------- the fakes
const accountSvc = { ensureAccountForIdentity: vi.fn(), getAccountContext: vi.fn(), selectActiveRole: vi.fn(), upsertProfile: vi.fn(), patchProfile: vi.fn() };
const security = { observeSession: vi.fn(), getSummary: vi.fn() };
const consentSvc = {
  getConsents: vi.fn(),
  getRequirements: vi.fn(),
  accept: vi.fn(),
  withdraw: vi.fn(),
  listOutstandingConsents: vi.fn(),
  hasRequiredConsents: vi.fn(),
  requireConsents: vi.fn(),
};
/** The registry of the current test; the apps call it through `areaProxy`, so a test can replace it. */
let area: FakeAccountArea;
const areaProxy: AccountAreaOperations = {
  sectionsOf: (role) => area.sectionsOf(role),
  navigation: (input) => area.navigation(input),
  assertSection: (role, code) => area.assertSection(role, code),
};
/** Registry READS (one indexed query each in the real service): the navigation reads through `sectionsOf`, the guards read through `sectionsOf`. */
const reads = () => area.calls.filter((c) => c.method === 'sectionsOf');
const noRegistryCalls = () => area.calls.length === 0;
const noAccountServiceWrites = () => accountSvc.patchProfile.mock.calls.length === 0 && accountSvc.upsertProfile.mock.calls.length === 0;

// ---------------------------------------------------------------- fixtures
const SUB = 'kc-subject-marker-7a1c4e';
const ACCOUNT_ID = '5f0c1a52-3b7e-4c1d-9a64-2f8e6d0b7a11';
const OTHER_ACCOUNT_ID = 'c3a8e1f0-7b2d-4a6e-b9c1-0d5f4e3a2b19';
const KEYCLOAK_SID = 'kc-session-id-marker-5d2f81c0';
const REALM_ROLE_MARKER = 'zz-realm-role-marker';
const SERVICE_SECRET_MARKER = 'svc-detail-marker-9f31';
const VERSION_ID = 'b7e1c0a4-93d2-4f6a-8a15-2c4d6e8f0a1b';
const HASH = 'a3f1c9e7b5d2a4c6e8f0123456789abcdef0123456789abcdef0123456789abc';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const CUSTOMER = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
const PROVIDER = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };
const PROFILE = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
const S = ACCOUNT_SECTIONS;

const section = (code: string, slug: string): AccountSectionDto => ({
  code,
  route: `/account/${slug}`,
  labelContentKey: accountSectionLabelKey(code),
  descriptionContentKey: accountSectionDescriptionKey(code),
});
const SEEDED: AccountSectionDto[] = [
  section(S.profile, 'profile'),
  section(S.contactVerification, 'contact'),
  section(S.security, 'security'),
  section(S.languageRegion, 'language-region'),
  section(S.privacyData, 'privacy'),
  section(S.roles, 'roles'),
];
/** The seeded set without the given sections (a role that does not have them). */
const without = (...codes: string[]): AccountSectionDto[] => SEEDED.filter((s) => !codes.includes(s.code));
const PAYOUTS = section('PAYOUTS', 'payouts');

/** What the fake account guard knows about the caller (changed by single tests). */
const state = {
  roles: [CUSTOMER, PROVIDER] as { code: string; nameContentKey: string }[],
  inactive: [] as string[],
  primary: 'CUSTOMER' as string | null,
  email: { emailVerificationStatus: 'NONE', primary: null, pending: null } as AccountContext['email'],
  phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null } as AccountContext['phone'],
  contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false },
  profile: PROFILE as AccountContext['profile'],
  /** When set, the guard resolves this role whatever the request asked for (proves the registry gets the VALIDATED role). */
  forceActive: undefined as string | null | undefined,
};
const resetState = () => {
  state.roles = [CUSTOMER, PROVIDER];
  state.inactive = [];
  state.primary = 'CUSTOMER';
  state.email = { emailVerificationStatus: 'NONE', primary: null, pending: null };
  state.phone = { phoneVerificationStatus: 'NONE', primary: null, pending: null };
  state.contacts = { emailVerified: false, phoneVerified: false, contactsVerified: false };
  state.profile = PROFILE;
  state.forceActive = undefined;
};

const makeContext = (over: Partial<AccountContext> = {}): AccountContext => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles: state.roles,
  memberships: state.roles.map((r) => ({ code: r.code, status: 'ACTIVE' as const })),
  primaryRole: state.primary,
  activeRole: state.primary,
  profile: null,
  email: state.email,
  phone: state.phone,
  contacts: state.contacts,
  createdAt: T0,
  created: false,
  ...over,
});

/** The consent requirements the fake serves: full of everything the privacy section must NOT pass on. */
const REQUIREMENTS = {
  locale: 'en-US',
  requirements: [
    {
      purposeCode: 'TERMS_OF_SERVICE',
      labelContentKey: 'account.consent.purpose.terms_of_service',
      required: true,
      status: 'SATISFIED',
      acceptanceState: 'ACCEPTED',
      withdrawable: false,
      reacceptance: 'REACCEPT_REQUIRED',
      document: {
        entryKey: 'legal.terms_of_service',
        versionId: VERSION_ID,
        version: 3,
        locale: 'en-US',
        bodySha256: HASH,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      },
      accepted: {
        consentEventId: '3c9d2e1f-5a4b-4c7d-8e6f-1a2b3c4d5e6f',
        purposeCode: 'TERMS_OF_SERVICE',
        eventType: 'ACCEPTED',
        eventSeq: 1,
        document: { versionId: VERSION_ID, version: 3, locale: 'en-US', bodySha256: HASH },
        occurredAt: '2026-02-03T04:05:06.000Z',
        source: 'ACCOUNT_API',
      },
    },
  ],
  satisfied: false,
  outstanding: ['PRIVACY_POLICY', 'MARKETING_EMAIL'],
};
const SECURITY_SUMMARY = { mfa: { available: true, enabled: true }, activeSessionCount: 3, currentBrowserTrusted: false };

const webToken = (claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub: SUB, sid: KEYCLOAK_SID, azp: 'bananagig-web', realm_access: { roles: ['customer', REALM_ROLE_MARKER] }, ...claims } });
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
  json: () => unknown;
}
const call = (
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  target: FastifyInstance = app,
): Promise<Reply> =>
  target.inject({
    method,
    url: `/api/v1/account${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
/** Sends the exact text as a body with the given content type. */
const rawBody = (method: Method, url: string, token: string | undefined, text: string, contentType = 'application/json'): Promise<Reply> =>
  app.inject({
    method,
    url: `/api/v1/account${url}`,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: text,
  });
const sendJson = (method: Method, url: string, token: string | undefined, value: unknown) => rawBody(method, url, token, JSON.stringify(value));
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;
const raw = (v: unknown): string => JSON.stringify(v);
const roleHeader = (role: string) => ({ 'x-active-role': role });
const expectNoStore = (r: Reply) => expect(r.headers['cache-control'], r.body).toBe('no-store');
/** Every string value inside a JSON value: none of them may come back in an error body. */
const leafStrings = (v: unknown): string[] => {
  if (typeof v === 'string') return v.length > 3 ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(leafStrings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(leafStrings);
  return [];
};
const expectValidation = (r: Reply, rejected: unknown = undefined) => {
  expect(r.statusCode, r.body).toBe(400);
  expect(errorOf(r)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
  const details = errorOf(r).details as { issues: { path: string; message: string }[] };
  expect(Array.isArray(details.issues)).toBe(true);
  for (const issue of details.issues) expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
  for (const value of leafStrings(rejected)) expect(r.body, 'a rejected value was echoed').not.toContain(value);
  expectNoStore(r);
};
/** The error body without the per-request correlation id: two uniform answers must be identical. */
const bare = (r: Reply): unknown => {
  const { correlationId: _c, ...rest } = errorOf(r);
  return rest;
};
const expectSectionNotFound = (r: Reply) => {
  expect(r.statusCode, r.body).toBe(404);
  expect(errorOf(r)).toMatchObject({ category: 'NOT_FOUND', code: 'ACCOUNT_SECTION_NOT_FOUND' });
  expectNoStore(r);
};
/** The 404 must not teach a client anything: no section code, no route, no role name. */
const SECRET_WORDS =
  /PROFILE|CUSTOMER|PROVIDER|LANGUAGE_REGION|PRIVACY_DATA|CONTACT_VERIFICATION|NOTIFICATIONS|CLOSE_ACCOUNT|\bROLES\b|\bSECURITY\b|PAYOUTS|\/account\/|language|privacy|contact|payout/;

interface Route {
  id: string;
  method: Method;
  url: string;
  body?: unknown;
  /** The sections the route needs: ALL of `all`, or at least one of `any`. */
  all?: string[];
  any?: string[];
  response: ZodType;
}
const PATCH_BODY = { firstName: 'Ana' };
const PUT_BODY = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
const NEW_ROUTES: Route[] = [
  { id: 'getAccountNavigation', method: 'GET', url: '/navigation', response: AccountNavigationResponse },
  { id: 'getAccountProfile', method: 'GET', url: '/profile', any: [S.profile, S.languageRegion], response: AccountProfileViewResponse },
  { id: 'patchAccountProfile', method: 'PATCH', url: '/profile', body: PATCH_BODY, all: [S.profile], response: ProfilePatchedResponse },
  {
    id: 'getAccountContactVerification',
    method: 'GET',
    url: '/contact-verification',
    all: [S.contactVerification],
    response: ContactVerificationSectionResponse,
  },
  { id: 'getAccountRolesSection', method: 'GET', url: '/roles', all: [S.roles], response: AccountRolesSectionResponse },
  { id: 'getAccountSecuritySummary', method: 'GET', url: '/security-summary', all: [S.security], response: SecuritySummaryResponse },
  { id: 'getAccountPrivacySummary', method: 'GET', url: '/privacy', all: [S.privacyData], response: PrivacySummaryResponse },
];
const PUT_ROUTE: Route = {
  id: 'updateAccountProfile',
  method: 'PUT',
  url: '/profile',
  body: PUT_BODY,
  all: [S.profile, S.languageRegion],
  response: AccountResponse,
};
const ALL_ROUTES = [...NEW_ROUTES, PUT_ROUTE];
const GUARDED = ALL_ROUTES.filter((r) => r.all || r.any);
const GET_ROUTES = NEW_ROUTES.filter((r) => r.method === 'GET');
const routeCall = (r: Route, token?: string, headers: Record<string, string> = {}, target?: FastifyInstance) =>
  call(r.method, r.url, token, r.body, headers, target);
/** A registry in which the role does NOT have what the route needs (all of it is removed). */
const hiddenFor = (r: Route): AccountSectionDto[] => without(...(r.all ?? []), ...(r.any ?? []));

const noDownstreamCalls = () =>
  noRegistryCalls() &&
  noAccountServiceWrites() &&
  security.getSummary.mock.calls.length === 0 &&
  Object.values(consentSvc).every((f) => f.mock.calls.length === 0);

const tokenIdentity = () => ({ providerType: 'KEYCLOAK', issuer: TEST_ISSUER, subject: SUB, identityRoles: ['customer', REALM_ROLE_MARKER] });

// ---------------------------------------------------------------- the apps
const baseDeps = (): AppDeps => ({
  cfg,
  verifier,
  configuration: {} as never,
  accounts: accountSvc as unknown as AccountService,
  readiness: async () => ({}),
});
const securityFake = security as unknown as SecurityOperations;
const consentFake = consentSvc as unknown as ConsentOperations;
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
  app = await makeApp({ security: securityFake, consent: consentFake, accountArea: areaProxy });
});
afterAll(async () => {
  for (const a of extraApps) await a.close();
});

beforeEach(() => {
  vi.restoreAllMocks();
  resetState();
  area = new FakeAccountArea({ CUSTOMER: SEEDED, PROVIDER: SEEDED });
  for (const f of [...Object.values(accountSvc), ...Object.values(consentSvc), security.observeSession, security.getSummary]) f.mockReset();
  accountSvc.ensureAccountForIdentity.mockImplementation(async (_identity: unknown, o: { requestedRole?: string; includeProfile?: boolean } = {}) => {
    let active: string | null = state.primary;
    if (o.requestedRole !== undefined) {
      if (state.inactive.includes(o.requestedRole)) throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: o.requestedRole });
      if (!state.roles.some((r) => r.code === o.requestedRole))
        throw new AccountError('ROLE_NOT_HELD', 'the account does not hold the role', { role: o.requestedRole });
      active = o.requestedRole;
    }
    if (state.forceActive !== undefined) active = state.forceActive;
    return makeContext({ activeRole: active, profile: o.includeProfile ? state.profile : null });
  });
  accountSvc.getAccountContext.mockImplementation(async (_id: string, o: { requestedRole?: string; includeProfile?: boolean } = {}) =>
    makeContext({ activeRole: o.requestedRole ?? state.primary, profile: o.includeProfile ? state.profile : null }),
  );
  accountSvc.upsertProfile.mockImplementation(async (_id: string, input: typeof PROFILE) => ({ changed: true, profile: input }));
  accountSvc.patchProfile.mockImplementation(async (_id: string, patch: Partial<typeof PROFILE>) => ({ changed: true, profile: { ...PROFILE, ...patch } }));
  security.observeSession.mockImplementation(async () => ({
    applicationSessionId: '0d9b1c52-8a4f-4e63-b7a1-3c2d5e6f7a80',
    accountDeviceId: null,
    created: false,
  }));
  security.getSummary.mockImplementation(async () => SECURITY_SUMMARY);
  consentSvc.getRequirements.mockImplementation(async () => REQUIREMENTS);
});

// ====================================================================== authentication and identity context
describe('account area authentication and the account guard', () => {
  it.each(ALL_ROUTES)('$method $url ($id) requires a token: 401, no-store, before any service or registry call', async (r) => {
    const res = await routeCall(r);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="bananagig"');
    expectNoStore(res);
    expect(noDownstreamCalls()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it.each(ALL_ROUTES)('$method $url ($id) rejects every kind of invalid token with 401 invalid_token', async (r) => {
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
    expect(noDownstreamCalls()).toBe(true);
  });

  it.each(ALL_ROUTES)('$method $url ($id) refuses the admin identity context and any other client with 403 and asks nothing', async (r) => {
    const admin = await routeCall(r, await adminToken());
    expect(admin.statusCode).toBe(403);
    expect(errorOf(admin)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_CONTEXT_NOT_SUPPORTED' });
    expectNoStore(admin);
    for (const azp of ['other', 'bananagig-api', 'BANANAGIG-WEB']) {
      const res = await routeCall(r, await webToken({ azp }));
      expect(res.statusCode, azp).toBe(403);
      expect(errorOf(res).code).toBe('ACCOUNT_CONTEXT_NOT_SUPPORTED');
    }
    expect(noDownstreamCalls()).toBe(true);
    expect(accountSvc.ensureAccountForIdentity).not.toHaveBeenCalled();
  });

  it('answers 401 before 400 and 403 before 400 on the PATCH: an invalid body without a token or with the admin token', async () => {
    for (const body of [{ firstName: 1, extra: true }, [], 'text', 7, null, {}]) {
      expect((await sendJson('PATCH', '/profile', undefined, body)).statusCode, raw(body)).toBe(401);
      expect((await sendJson('PATCH', '/profile', 'bad.token', body)).statusCode, raw(body)).toBe(401);
      expect((await sendJson('PATCH', '/profile', await adminToken(), body)).statusCode, raw(body)).toBe(403);
    }
    expect(noDownstreamCalls()).toBe(true);
  });

  it('answers 401 before 400 on a GET with a query: a garbage query without a token is 401', async () => {
    for (const r of GET_ROUTES) expect((await call('GET', `${r.url}?accountId=x&role=PROVIDER`)).statusCode, r.url).toBe(401);
    expect(noDownstreamCalls()).toBe(true);
  });

  it.each(ALL_ROUTES)('$method $url ($id) passes a suspended or closed account through as 403 and never asks the registry', async (r) => {
    for (const code of ['SUSPENDED', 'CLOSED'] as const) {
      accountSvc.ensureAccountForIdentity.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: `ACCOUNT_${code}` });
      expectNoStore(res);
    }
    expect(noDownstreamCalls()).toBe(true);
  });

  it.each(ALL_ROUTES)('$method $url ($id) refuses a role the account does not hold (x-active-role) with 403 before the registry is asked', async (r) => {
    state.roles = [CUSTOMER];
    const res = await routeCall(r, await webToken(), roleHeader('PROVIDER'));
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_ROLE_NOT_HELD' });
    expectNoStore(res);
    const unknown = await routeCall(r, await webToken(), roleHeader('ADMIN'));
    expect(unknown.statusCode).toBe(403);
    expect(noDownstreamCalls()).toBe(true);
  });

  it.each(ALL_ROUTES)('$method $url ($id): an INACTIVE role cannot select sections: 403 from the account guard and the registry was NOT called', async (r) => {
    state.inactive = ['PROVIDER'];
    const res = await routeCall(r, await webToken(), roleHeader('PROVIDER'));
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'ACCOUNT_ROLE_NOT_ACTIVE' });
    expectNoStore(res);
    expect(noDownstreamCalls()).toBe(true);
  });

  it.each(NEW_ROUTES.filter((r) => r.id !== 'patchAccountProfile'))(
    '$method $url ($id): a revoked session is 401 SESSION_REVOKED before the registry is asked',
    async (r) => {
      security.observeSession.mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'));
      const res = await routeCall(r, await webToken());
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('SESSION_REVOKED');
      expectNoStore(res);
      expect(noDownstreamCalls()).toBe(true);
    },
  );

  it('resolves the account from the verified token only: the identity handed to the guard is the token, whatever headers or query a client adds', async () => {
    const res = await call('GET', '/navigation', await webToken(), undefined, {
      'x-account-id': OTHER_ACCOUNT_ID,
      'x-user-id': OTHER_ACCOUNT_ID,
      'x-forwarded-user': 'someone-else',
      'x-section': 'PROFILE',
      'x-sections': 'PROFILE,SECURITY',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![0]).toEqual(tokenIdentity());
    expect(raw(accountSvc.ensureAccountForIdentity.mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(raw(area.calls)).not.toContain(OTHER_ACCOUNT_ID);
    expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
  });
});

// ====================================================================== the uniform 404 of a section the active role does not have
describe('a section the active role does not have is a uniform 404', () => {
  it.each(GUARDED)(
    '$method $url ($id): 404 ACCOUNT_SECTION_NOT_FOUND when the active role lacks the section, with no-store and the correlation id, and nothing is done',
    async (r) => {
      area = new FakeAccountArea({ CUSTOMER: hiddenFor(r), PROVIDER: SEEDED });
      const cid = 'cid-hidden-section-1';
      const res = await call(r.method, r.url, await webToken(), r.body, { [CORRELATION_HEADER]: cid });
      expectSectionNotFound(res);
      expect(errorOf(res).correlationId).toBe(cid);
      expect(res.headers[CORRELATION_HEADER]).toBe(cid);
      expect(res.body).not.toMatch(SECRET_WORDS);
      expect(errorOf(res).details ?? {}).toEqual({});
      expect(accountSvc.patchProfile).not.toHaveBeenCalled();
      expect(accountSvc.upsertProfile).not.toHaveBeenCalled();
      expect(accountSvc.getAccountContext).not.toHaveBeenCalled();
      expect(security.getSummary).not.toHaveBeenCalled();
      expect(consentSvc.getRequirements).not.toHaveBeenCalled();
    },
  );

  it('is the SAME answer for a section the role lacks, a registry that returns nothing, an account with no usable role, and for every route', async () => {
    const answers: unknown[] = [];
    for (const r of GUARDED) {
      area = new FakeAccountArea({ CUSTOMER: hiddenFor(r) });
      answers.push(bare(await routeCall(r, await webToken())));
      area = new FakeAccountArea({ CUSTOMER: [] });
      answers.push(bare(await routeCall(r, await webToken())));
      // an unknown role code in the registry (no row at all) and a role with a different set
      area = new FakeAccountArea({ OTHER_ROLE: SEEDED, PROVIDER: SEEDED });
      answers.push(bare(await routeCall(r, await webToken())));
      state.roles = [];
      state.primary = null;
      area = new FakeAccountArea({ CUSTOMER: SEEDED, PROVIDER: SEEDED });
      const roleless = await routeCall(r, await webToken());
      expectSectionNotFound(roleless);
      answers.push(bare(roleless));
      resetState();
    }
    expect(answers.length).toBe(GUARDED.length * 4);
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ code: 'ACCOUNT_SECTION_NOT_FOUND', category: 'NOT_FOUND', message: 'the account section was not found' });
    expect((answers[0] as { details?: object }).details ?? {}).toEqual({});
  });

  it('never calls the registry for a role-less account with anything but null (the validated role), and gets no section', async () => {
    state.roles = [];
    state.primary = null;
    const res = await call('GET', '/navigation', await webToken());
    expect(res.statusCode).toBe(200);
    expect(AccountNavigationResponse.parse(res.json()).data).toEqual({ activeRole: null, roles: [], sections: [], contacts: state.contacts });
    expect(area.calls.every((c) => c.role === null)).toBe(true);
    expect((await call('GET', '/profile', await webToken())).statusCode).toBe(404);
  });

  it('a hidden section does not hide ANOTHER section: only the lacking section is refused', async () => {
    area = new FakeAccountArea({ CUSTOMER: without(S.privacyData), PROVIDER: SEEDED });
    expectSectionNotFound(await call('GET', '/privacy', await webToken()));
    for (const r of GUARDED.filter((x) => x.id !== 'getAccountPrivacySummary')) expect((await routeCall(r, await webToken())).statusCode, r.id).toBe(200);
  });

  it('a section hidden for the active role is served when the SAME token acts as the other role (no new login)', async () => {
    area = new FakeAccountArea({ CUSTOMER: without(S.privacyData), PROVIDER: SEEDED });
    const token = await webToken();
    expectSectionNotFound(await call('GET', '/privacy', token, undefined, roleHeader('CUSTOMER')));
    expect((await call('GET', '/privacy', token, undefined, roleHeader('PROVIDER'))).statusCode).toBe(200);
    expectSectionNotFound(await call('GET', '/privacy', token));
  });

  it('a registry outage is a generic 503 (no detail) and the handler never runs', async () => {
    vi.spyOn(area, 'sectionsOf').mockRejectedValue(
      new AccountError('UNAVAILABLE', `db down ${SERVICE_SECRET_MARKER}`, { reason: 'REGISTRY_INVALID', cause: 'ECONNREFUSED 10.0.0.5:5432' }),
    );
    for (const r of ALL_ROUTES) {
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.id).toBe(503);
      expect(errorOf(res)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
      expect(errorOf(res).details).toBeUndefined();
      expect(res.body).not.toContain(SERVICE_SECRET_MARKER);
      expect(res.body).not.toContain('ECONNREFUSED');
      expectNoStore(res);
    }
    expect(noAccountServiceWrites()).toBe(true);
    expect(security.getSummary).not.toHaveBeenCalled();
    expect(consentSvc.getRequirements).not.toHaveBeenCalled();
  });

  it('an unexpected registry failure is a generic 500 with no leak', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(area, 'sectionsOf').mockRejectedValue(new Error(`boom ${SERVICE_SECRET_MARKER}`));
    for (const r of [NEW_ROUTES[0]!, NEW_ROUTES[4]!, PUT_ROUTE]) {
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, r.id).toBe(500);
      expect(errorOf(res)).toMatchObject({ category: 'INTERNAL', code: 'INTERNAL_ERROR' });
      expect(res.body).not.toContain(SERVICE_SECRET_MARKER);
      expectNoStore(res);
    }
  });
});

// ====================================================================== success shapes, caching, correlation, query
describe('account area success responses', () => {
  it.each(NEW_ROUTES)('$method $url ($id): 200 with the standard envelope equal to its contract, no-store and the correlation id of the request', async (r) => {
    const cid = 'cid-success-1';
    const res = await call(r.method, r.url, await webToken(), r.body, { [CORRELATION_HEADER]: cid });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = r.response.safeParse(res.json());
    expect(parsed.success, res.body).toBe(true);
    expect(JSON.parse(JSON.stringify((parsed as { data: unknown }).data)), `${r.id} carries nothing outside its contract`).toEqual(res.json());
    expect(Object.keys(res.json() as object).sort()).toEqual(['data', 'meta']);
    expect((res.json() as { meta: unknown }).meta).toEqual({ correlationId: cid });
    expect(res.headers[CORRELATION_HEADER]).toBe(cid);
    expectNoStore(res);
  });

  it.each(GET_ROUTES)(
    '$method $url ($id): ANY query parameter is a 400 that does not echo it (strict query), including accountId, role and sections',
    async (r) => {
      for (const qs of [
        '?accountId=' + OTHER_ACCOUNT_ID,
        '?role=PROVIDER',
        '?sections=SECURITY',
        '?section=PROFILE',
        '?locale=en-US',
        '?x=1',
        '?a=1&b=2',
        '?limit=10',
      ]) {
        const res = await call('GET', `${r.url}${qs}`, await webToken());
        expectValidation(res, { qs: qs.slice(1).split('=')[1] });
        expect(res.body).not.toContain(OTHER_ACCOUNT_ID);
      }
      expect(security.getSummary).not.toHaveBeenCalled();
      expect(consentSvc.getRequirements).not.toHaveBeenCalled();
    },
  );

  it('ignores a query on the PATCH: the account is the token account', async () => {
    const res = await call('PATCH', `/profile?accountId=${OTHER_ACCOUNT_ID}`, await webToken(), PATCH_BODY);
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.patchProfile.mock.calls[0]![0]).toBe(ACCOUNT_ID);
    expect(raw(accountSvc.patchProfile.mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
  });

  it('every guarded route reads the registry exactly ONCE per request (the navigation reads once as well)', async () => {
    for (const r of ALL_ROUTES) {
      area.calls.length = 0;
      const res = await routeCall(r, await webToken());
      expect(res.statusCode, `${r.id}: ${res.body}`).toBe(200);
      expect(reads(), r.id).toHaveLength(1);
      expect(
        area.calls.filter((c) => c.method === 'assertSection'),
        `${r.id} uses sectionsOf, not a query per section`,
      ).toHaveLength(0);
    }
  });

  it('a request that needs TWO sections (PATCH of mixed fields, PUT) still reads the registry once, even when it ends in a 404', async () => {
    const mixed = await call('PATCH', '/profile', await webToken(), { firstName: 'Ana', timeZone: 'UTC' });
    expect(mixed.statusCode).toBe(200);
    expect(reads()).toHaveLength(1);
    area.calls.length = 0;
    area = new FakeAccountArea({ CUSTOMER: without(S.languageRegion), PROVIDER: SEEDED });
    expectSectionNotFound(await call('PATCH', '/profile', await webToken(), { firstName: 'Ana', timeZone: 'UTC' }));
    expect(reads()).toHaveLength(1);
    area.calls.length = 0;
    expectSectionNotFound(await call('PUT', '/profile', await webToken(), PUT_BODY));
    expect(reads()).toHaveLength(1);
  });
});

// ====================================================================== GET /account/navigation
describe('GET /account/navigation', () => {
  it('hands the registry the VALIDATED active role, and returns exactly what it returned, in that order', async () => {
    const reversed = [...SEEDED].reverse();
    area = new FakeAccountArea({ CUSTOMER: reversed, PROVIDER: SEEDED });
    const res = await call('GET', '/navigation', await webToken());
    expect(res.statusCode).toBe(200);
    const data = AccountNavigationResponse.parse(res.json()).data;
    expect(data.sections).toEqual(reversed);
    expect(data.sections.map((s) => s.code)).toEqual(['ROLES', 'PRIVACY_DATA', 'LANGUAGE_REGION', 'SECURITY', 'CONTACT_VERIFICATION', 'PROFILE']);
    expect(data.activeRole).toBe('CUSTOMER');
    expect(data.roles).toEqual([CUSTOMER, PROVIDER]);
    expect(data.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    expect(area.calls.map((c) => c.method)).toEqual(['navigation', 'sectionsOf']);
    expect(area.calls.every((c) => c.role === 'CUSTOMER')).toBe(true);
  });

  it('passes the role the GUARD validated, never the header the client sent', async () => {
    state.forceActive = 'CUSTOMER';
    const res = await call('GET', '/navigation', await webToken(), undefined, roleHeader('PROVIDER'));
    expect(res.statusCode).toBe(200);
    // the guard was asked for PROVIDER (the header) and resolved CUSTOMER: the registry must see CUSTOMER
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ requestedRole: 'PROVIDER' });
    expect(area.calls.length).toBeGreaterThan(0);
    expect(area.calls.every((c) => c.role === 'CUSTOMER')).toBe(true);
    expect(AccountNavigationResponse.parse(res.json()).data.activeRole).toBe('CUSTOMER');
    // and the guarded routes use the validated role too
    area = new FakeAccountArea({ CUSTOMER: without(S.privacyData), PROVIDER: SEEDED });
    expectSectionNotFound(await call('GET', '/privacy', await webToken(), undefined, roleHeader('PROVIDER')));
    expect(area.calls.every((c) => c.role === 'CUSTOMER')).toBe(true);
  });

  it('a dual-role account: the header selects the role and the registry receives CUSTOMER then PROVIDER with the SAME token (no new login)', async () => {
    area = new FakeAccountArea({ CUSTOMER: SEEDED, PROVIDER: [...SEEDED, PAYOUTS] });
    const token = await webToken();
    const asCustomer = AccountNavigationResponse.parse((await call('GET', '/navigation', token, undefined, roleHeader('CUSTOMER'))).json()).data;
    const asProvider = AccountNavigationResponse.parse((await call('GET', '/navigation', token, undefined, roleHeader('PROVIDER'))).json()).data;
    const primary = AccountNavigationResponse.parse((await call('GET', '/navigation', token)).json()).data;
    expect(area.calls.filter((c) => c.method === 'navigation').map((c) => c.role)).toEqual(['CUSTOMER', 'PROVIDER', 'CUSTOMER']);
    expect(asCustomer.activeRole).toBe('CUSTOMER');
    expect(asProvider.activeRole).toBe('PROVIDER');
    expect(primary.activeRole).toBe('CUSTOMER');
    expect(asCustomer.sections.map((s) => s.code)).not.toContain('PAYOUTS');
    expect(asProvider.sections.map((s) => s.code)).toEqual([...SEEDED.map((s) => s.code), 'PAYOUTS']);
    // the role list (the switcher) is the same for both
    expect(asProvider.roles).toEqual(asCustomer.roles);
    expect(accountSvc.ensureAccountForIdentity.mock.calls.map((c) => c[1].requestedRole)).toEqual(['CUSTOMER', 'PROVIDER', undefined]);
  });

  it('with the session registry wired the three role switches are one application session (the same Keycloak sid), not three logins', async () => {
    area = new FakeAccountArea({ CUSTOMER: SEEDED, PROVIDER: [...SEEDED, PAYOUTS] });
    const token = await webToken();
    for (const role of ['CUSTOMER', 'PROVIDER', 'CUSTOMER'])
      expect((await call('GET', '/navigation', token, undefined, roleHeader(role))).statusCode).toBe(200);
    expect(security.observeSession.mock.calls.map((c) => c[0].keycloakSessionId)).toEqual([KEYCLOAK_SID, KEYCLOAK_SID, KEYCLOAK_SID]);
    expect(accountSvc.selectActiveRole).not.toHaveBeenCalled();
  });

  it('passes the contacts summary the guard derived, and the roles in the order the guard returned them', async () => {
    state.contacts = { emailVerified: true, phoneVerified: false, contactsVerified: false };
    state.roles = [PROVIDER, CUSTOMER];
    state.primary = 'PROVIDER';
    const data = AccountNavigationResponse.parse((await call('GET', '/navigation', await webToken())).json()).data;
    expect(data.contacts).toEqual({ emailVerified: true, phoneVerified: false, contactsVerified: false });
    expect(data.roles.map((r) => r.code)).toEqual(['PROVIDER', 'CUSTOMER']);
    expect(data.activeRole).toBe('PROVIDER');
  });

  it('carries no contact detail, token, subject, session id or account id', async () => {
    state.email = {
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: 'a***@example.test', verifiedAt: T0.toISOString(), source: 'USER_ENTERED' },
      pending: null,
    };
    const res = await call('GET', '/navigation', await webToken());
    const text = res.body;
    for (const secret of [SUB, KEYCLOAK_SID, ACCOUNT_ID, REALM_ROLE_MARKER, 'a***@example.test', 'maskedEmail', 'Bearer'])
      expect(text, secret).not.toContain(secret);
    expect(Object.keys((res.json() as { data: object }).data).sort()).toEqual(['activeRole', 'contacts', 'roles', 'sections']);
  });
});

// ====================================================================== GET /account/profile
describe('GET /account/profile', () => {
  it('derives the display name on read (first name and last initial) and returns the stored fields; the guard is asked for the profile', async () => {
    const res = await call('GET', '/profile', await webToken());
    expect(res.statusCode).toBe(200);
    expect(AccountProfileViewResponse.parse(res.json()).data).toEqual({ profile: { ...PROFILE, displayName: 'Ana M.' } });
    expect(accountSvc.ensureAccountForIdentity.mock.calls[0]![1]).toMatchObject({ includeProfile: true });
  });
  it('is { profile: null } before the person gave a name', async () => {
    state.profile = null;
    const res = await call('GET', '/profile', await webToken());
    expect(AccountProfileViewResponse.parse(res.json()).data).toEqual({ profile: null });
  });
  it('the display name follows publicDisplayName for a unicode and multi-word name', async () => {
    state.profile = { firstName: 'Zoë', lastName: 'élodie de la Cruz', preferredLocale: null, timeZone: null };
    const data = AccountProfileViewResponse.parse((await call('GET', '/profile', await webToken())).json()).data;
    expect(data.profile!.displayName).toBe(publicDisplayName(state.profile.firstName, state.profile.lastName));
    expect(data.profile!.displayName).not.toContain('Cruz');
  });
  it('needs ANY of PROFILE and LANGUAGE_REGION: one of them is enough, neither is a 404', async () => {
    for (const set of [without(S.profile), without(S.languageRegion)]) {
      area = new FakeAccountArea({ CUSTOMER: set });
      expect((await call('GET', '/profile', await webToken())).statusCode).toBe(200);
    }
    area = new FakeAccountArea({ CUSTOMER: without(S.profile, S.languageRegion) });
    expectSectionNotFound(await call('GET', '/profile', await webToken()));
  });
});

// ====================================================================== PATCH /account/profile
describe('PATCH /account/profile', () => {
  describe('strict body (a rejected body never reaches the registry or the service, and no value is echoed)', () => {
    const MARK = 'ZZ-typed-marker';
    const bad: [string, unknown][] = [
      ['an unknown property', { nickname: MARK }],
      ['an account id', { firstName: 'Ana', accountId: OTHER_ACCOUNT_ID }],
      ['an account id alone', { accountId: OTHER_ACCOUNT_ID }],
      ['a role', { firstName: 'Ana', role: 'PROVIDER' }],
      ['a section list', { firstName: 'Ana', sections: ['PROFILE'] }],
      ['a numeric first name', { firstName: 123456 }],
      ['a numeric last name', { lastName: 7 }],
      ['a boolean first name', { firstName: true }],
      ['an array first name', { firstName: [`${MARK}-array`] }],
      ['an object first name', { firstName: { value: `${MARK}-object` } }],
      ['a null first name', { firstName: null }],
      ['a null last name', { lastName: null }],
      ['the empty object', {}],
      ['a huge first name', { firstName: `${MARK}${'a'.repeat(600)}` }],
      ['a huge last name', { lastName: `${MARK}${'a'.repeat(600)}` }],
      ['a malformed locale', { preferredLocale: `${MARK}_en` }],
      ['a numeric locale', { preferredLocale: 5 }],
      ['an unknown-format time zone', { timeZone: `${MARK} zone` }],
      ['a numeric time zone', { timeZone: 5 }],
      ['an array body', [{ firstName: MARK }]],
      ['a null body', null],
      ['a string body', MARK],
      ['a number body', 7],
      ['a boolean body', true],
    ];
    it.each(bad)('rejects %s with 400 VALIDATION_FAILED', async (_label, body) => {
      const res = await sendJson('PATCH', '/profile', await webToken(), body);
      expectValidation(res, body);
      expect(noRegistryCalls(), 'the body is validated before the section is looked at').toBe(true);
      expect(noAccountServiceWrites()).toBe(true);
    });

    it('rejects a body that is not JSON, empty, or sent with the wrong content type', async () => {
      const token = await webToken();
      const broken = await rawBody('PATCH', '/profile', token, '{"firstName":');
      expect(broken.statusCode, broken.body).toBe(400);
      expect(errorOf(broken)).toMatchObject({ category: 'VALIDATION', code: 'BAD_REQUEST' });
      expectNoStore(broken);
      expectValidation(await rawBody('PATCH', '/profile', token, `{"firstName":"${MARK}"}`, 'text/plain'), { v: MARK });
      const missing = await call('PATCH', '/profile', token);
      expect(missing.statusCode, missing.body).toBe(400);
      const form = await rawBody('PATCH', '/profile', token, `firstName=${MARK}`, 'application/x-www-form-urlencoded');
      expect(form.statusCode, form.body).toBe(415);
      expect(ErrorResponse.safeParse(form.json()).success).toBe(true);
      expect(form.body).not.toContain(MARK);
      expectNoStore(form);
      expect(noRegistryCalls()).toBe(true);
      expect(noAccountServiceWrites()).toBe(true);
    });

    it('rejects a body over the size limit with a standard error and never reads the registry', async () => {
      const res = await sendJson('PATCH', '/profile', await webToken(), { firstName: 'a'.repeat(2 * 1024 * 1024) });
      expect([400, 413]).toContain(res.statusCode);
      expect(ErrorResponse.safeParse(res.json()).success).toBe(true);
      expect(res.body.length).toBeLessThan(2000);
      expectNoStore(res);
      expect(noRegistryCalls()).toBe(true);
      expect(noAccountServiceWrites()).toBe(true);
    });

    it('rejects the 400 body before the 404 of a hidden section (a strict-body 400 comes before the section check)', async () => {
      area = new FakeAccountArea({ CUSTOMER: [], PROVIDER: [] });
      expectValidation(await sendJson('PATCH', '/profile', await webToken(), { accountId: OTHER_ACCOUNT_ID }), { v: OTHER_ACCOUNT_ID });
      expect(noRegistryCalls()).toBe(true);
    });

    it('coerces nothing: numbers, booleans and null for the names are refused, never turned into strings', async () => {
      for (const v of [1, 0, 1e3, true, false, null]) {
        expect((await sendJson('PATCH', '/profile', await webToken(), { firstName: v })).statusCode, String(v)).toBe(400);
        expect((await sendJson('PATCH', '/profile', await webToken(), { lastName: v })).statusCode, String(v)).toBe(400);
      }
      expect(noAccountServiceWrites()).toBe(true);
    });
  });

  describe('the service receives exactly the present fields, the token account and the actor', () => {
    it.each<[string, Record<string, unknown>]>([
      ['a first name', { firstName: 'Ana' }],
      ['both names', { firstName: 'Ana', lastName: 'Martinez' }],
      ['a locale', { preferredLocale: 'es-US' }],
      ['a time zone', { timeZone: 'Europe/Paris' }],
      ['null clears the locale', { preferredLocale: null }],
      ['null clears the time zone', { timeZone: null }],
      ['all four', { firstName: 'Ana', lastName: 'M', preferredLocale: 'en-US', timeZone: 'UTC' }],
    ])('%s', async (_label, body) => {
      const res = await call('PATCH', '/profile', await webToken(), body);
      expect(res.statusCode, res.body).toBe(200);
      expect(accountSvc.patchProfile).toHaveBeenCalledTimes(1);
      expect(accountSvc.patchProfile.mock.calls[0]).toEqual([ACCOUNT_ID, body, { actor: `account:${ACCOUNT_ID}` }]);
      // an absent field stays absent (not turned into null or undefined keys)
      expect(Object.keys(accountSvc.patchProfile.mock.calls[0]![1] as object).sort()).toEqual(Object.keys(body).sort());
      expect(accountSvc.upsertProfile).not.toHaveBeenCalled();
    });

    it('answers { changed, profile + derived displayName } from the SERVICE result, not from the request', async () => {
      accountSvc.patchProfile.mockResolvedValueOnce({ changed: false, profile: { ...PROFILE, firstName: 'Bob' } });
      const res = await call('PATCH', '/profile', await webToken(), { firstName: '  bob  ' });
      expect(ProfilePatchedResponse.parse(res.json()).data).toEqual({ changed: false, profile: { ...PROFILE, firstName: 'Bob', displayName: 'Bob M.' } });
      expect(res.body).not.toContain('  bob  ');
    });
  });

  describe('field to section authorization (names need PROFILE, locale and time zone need LANGUAGE_REGION)', () => {
    const cases: { label: string; body: Record<string, unknown>; needs: string[] }[] = [
      { label: 'a first name', body: { firstName: 'Ana' }, needs: [S.profile] },
      { label: 'a last name', body: { lastName: 'Martinez' }, needs: [S.profile] },
      { label: 'both names', body: { firstName: 'Ana', lastName: 'M' }, needs: [S.profile] },
      { label: 'a locale', body: { preferredLocale: 'es-US' }, needs: [S.languageRegion] },
      { label: 'a null locale', body: { preferredLocale: null }, needs: [S.languageRegion] },
      { label: 'a time zone', body: { timeZone: 'UTC' }, needs: [S.languageRegion] },
      { label: 'a null time zone', body: { timeZone: null }, needs: [S.languageRegion] },
      { label: 'locale and time zone', body: { preferredLocale: 'en-US', timeZone: 'UTC' }, needs: [S.languageRegion] },
      { label: 'a name and a time zone', body: { firstName: 'Ana', timeZone: 'UTC' }, needs: [S.profile, S.languageRegion] },
      { label: 'a name and a locale', body: { lastName: 'M', preferredLocale: 'en-US' }, needs: [S.profile, S.languageRegion] },
      { label: 'a name and a null locale', body: { firstName: 'Ana', preferredLocale: null }, needs: [S.profile, S.languageRegion] },
      { label: 'all four', body: { firstName: 'Ana', lastName: 'M', preferredLocale: 'en-US', timeZone: 'UTC' }, needs: [S.profile, S.languageRegion] },
    ];
    it.each(cases)('$label needs exactly $needs: served with them, a 404 without any one of them, the service not called', async ({ body, needs }) => {
      area = new FakeAccountArea({ CUSTOMER: SEEDED });
      expect((await call('PATCH', '/profile', await webToken(), body)).statusCode, 'with everything').toBe(200);
      accountSvc.patchProfile.mockClear();
      for (const missing of needs) {
        area = new FakeAccountArea({ CUSTOMER: without(missing) });
        expectSectionNotFound(await call('PATCH', '/profile', await webToken(), body));
        expect(accountSvc.patchProfile, `without ${missing}`).not.toHaveBeenCalled();
      }
      // a section it does NOT need may be missing
      for (const other of Object.values(S).filter((c) => !needs.includes(c))) {
        area = new FakeAccountArea({ CUSTOMER: without(other) });
        expect((await call('PATCH', '/profile', await webToken(), body)).statusCode, `without ${other}`).toBe(200);
      }
    });

    it('a role with PROFILE but not LANGUAGE_REGION patches the names, and a time zone patch is a 404 with the service NOT called', async () => {
      area = new FakeAccountArea({ CUSTOMER: without(S.languageRegion), PROVIDER: SEEDED });
      const token = await webToken();
      expect((await call('PATCH', '/profile', token, { firstName: 'Ana', lastName: 'M' })).statusCode).toBe(200);
      expect(accountSvc.patchProfile).toHaveBeenCalledTimes(1);
      expectSectionNotFound(await call('PATCH', '/profile', token, { timeZone: 'UTC' }));
      expectSectionNotFound(await call('PATCH', '/profile', token, { firstName: 'Ana', timeZone: 'UTC' }));
      expectSectionNotFound(await call('PATCH', '/profile', token, { preferredLocale: null }));
      expect(accountSvc.patchProfile).toHaveBeenCalledTimes(1);
    });

    it('a role with LANGUAGE_REGION but not PROFILE patches the locale and time zone, never a name', async () => {
      area = new FakeAccountArea({ CUSTOMER: without(S.profile) });
      const token = await webToken();
      expect((await call('PATCH', '/profile', token, { preferredLocale: 'es-US', timeZone: 'UTC' })).statusCode).toBe(200);
      expectSectionNotFound(await call('PATCH', '/profile', token, { lastName: 'Z' }));
      expect(accountSvc.patchProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe('service errors', () => {
    const sendValid = async () => call('PATCH', '/profile', await webToken(), { firstName: 'ZZ-typed-name-marker' });
    it('INVALID_PROFILE issues are a 400 ACCOUNT_VALIDATION_FAILED with field, code and content key, and not the typed value', async () => {
      accountSvc.patchProfile.mockRejectedValueOnce(
        new AccountError('VALIDATION_FAILED', 'the profile is not valid', {
          reason: 'INVALID_PROFILE',
          issues: [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }],
        }),
      );
      const res = await sendValid();
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'ACCOUNT_VALIDATION_FAILED' });
      expect(errorOf(res).details).toEqual({
        reason: 'INVALID_PROFILE',
        issues: [{ field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }],
      });
      expect(res.body).not.toContain('ZZ-typed-name-marker');
      expectNoStore(res);
    });
    it('the REAL service validation (never reaching its database) gives the same issues as for PUT, and does not echo the typed name', async () => {
      const real = new AccountService({
        database: new Proxy(
          {},
          {
            get: () => {
              throw new Error('the database was touched');
            },
          },
        ) as unknown as Database,
      });
      accountSvc.patchProfile.mockImplementation((...args: Parameters<AccountService['patchProfile']>) => real.patchProfile(...args));
      const res = await call('PATCH', '/profile', await webToken(), { firstName: `ZZ-typed-name-marker${'a'.repeat(60)}`, lastName: '   ' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toEqual({
        reason: 'INVALID_PROFILE',
        issues: [
          { field: 'firstName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' },
          { field: 'lastName', code: 'REQUIRED', messageKey: 'account.error.name_required' },
        ],
      });
      expect(res.body).not.toContain('ZZ-typed-name-marker');
    });
    it.each([
      ['UNKNOWN_LOCALE', { reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' }],
      ['UNKNOWN_TIME_ZONE', { reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' }],
      ['PROFILE_REQUIRED', { reason: 'PROFILE_REQUIRED' }],
    ])('%s is a 400 ACCOUNT_VALIDATION_FAILED carrying the reason (and the field) only', async (_reason, details) => {
      accountSvc.patchProfile.mockRejectedValueOnce(
        new AccountError('VALIDATION_FAILED', `${SERVICE_SECRET_MARKER} message`, { ...details, cause: 'pg: relation x', constraint: 'ck_x' }),
      );
      const res = await call('PATCH', '/profile', await webToken(), { preferredLocale: 'en-US' });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'ACCOUNT_VALIDATION_FAILED' });
      expect(errorOf(res).details).toEqual(details);
      expect(res.body).not.toContain('pg: relation');
      expect(res.body).not.toContain('ck_x');
      expectNoStore(res);
    });
    it('CONFLICT is a 409 and UNAVAILABLE a generic 503 without the service detail', async () => {
      accountSvc.patchProfile.mockRejectedValueOnce(new AccountError('CONFLICT', 'concurrent', { reason: 'CONCURRENT_UPDATE', retryable: true }));
      const conflict = await sendValid();
      expect(conflict.statusCode).toBe(409);
      expect(errorOf(conflict)).toMatchObject({ category: 'CONFLICT', code: 'ACCOUNT_CONFLICT' });
      accountSvc.patchProfile.mockRejectedValueOnce(
        new AccountError('UNAVAILABLE', `db down ${SERVICE_SECRET_MARKER}`, { cause: 'ECONNREFUSED 10.0.0.5:5432' }),
      );
      const down = await sendValid();
      expect(down.statusCode).toBe(503);
      expect(errorOf(down)).toMatchObject({ category: 'DEPENDENCY', code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is temporarily unavailable' });
      expect(errorOf(down).details).toBeUndefined();
      expect(down.body).not.toContain(SERVICE_SECRET_MARKER);
      expect(down.body).not.toContain('ECONNREFUSED');
      expectNoStore(down);
    });
    it('suspended and closed accounts are refused by the service too (a status change between the guard and the write)', async () => {
      for (const code of ['SUSPENDED', 'CLOSED'] as const) {
        accountSvc.patchProfile.mockRejectedValueOnce(new AccountError(code, 'refused', { status: code }));
        const res = await sendValid();
        expect(res.statusCode).toBe(403);
        expect(errorOf(res).code).toBe(`ACCOUNT_${code}`);
      }
    });
  });
});

// ====================================================================== PUT /account/profile (existing contract, new guard)
describe('PUT /account/profile with the account area', () => {
  it('works as before when both sections are available: the service gets the body and the token account, and the account is read back with the profile', async () => {
    const res = await call('PUT', '/profile', await webToken(), PUT_BODY, roleHeader('PROVIDER'));
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.upsertProfile.mock.calls[0]).toEqual([ACCOUNT_ID, PUT_BODY, { actor: `account:${ACCOUNT_ID}` }]);
    expect(accountSvc.getAccountContext.mock.calls[0]).toEqual([ACCOUNT_ID, { includeProfile: true, requestedRole: 'PROVIDER' }]);
    expect(AccountResponse.safeParse(res.json()).success).toBe(true);
    expectNoStore(res);
    expect(accountSvc.patchProfile).not.toHaveBeenCalled();
  });
  it.each([S.profile, S.languageRegion])('needs BOTH sections: without %s it is a 404 and nothing is written', async (missing) => {
    area = new FakeAccountArea({ CUSTOMER: without(missing) });
    expectSectionNotFound(await call('PUT', '/profile', await webToken(), PUT_BODY));
    expect(accountSvc.upsertProfile).not.toHaveBeenCalled();
    expect(accountSvc.getAccountContext).not.toHaveBeenCalled();
  });
  it('keeps answering a strict-body 400 for a visible section (the body table of the existing contract)', async () => {
    expectValidation(await sendJson('PUT', '/profile', await webToken(), { ...PUT_BODY, accountId: OTHER_ACCOUNT_ID }), { v: OTHER_ACCOUNT_ID });
    expectValidation(await sendJson('PUT', '/profile', await webToken(), { firstName: 1, lastName: 2 }));
    expect(accountSvc.upsertProfile).not.toHaveBeenCalled();
  });
  it('documents the order of its guards: the section check runs BEFORE the body validation (404 for a hidden section even with an invalid body)', async () => {
    area = new FakeAccountArea({ CUSTOMER: without(S.profile) });
    const res = await sendJson('PUT', '/profile', await webToken(), { firstName: 1 });
    expect(res.statusCode).toBe(404);
    expect(accountSvc.upsertProfile).not.toHaveBeenCalled();
  });
});

describe('the app built WITHOUT the account area (the older dependencies)', () => {
  let legacy: FastifyInstance;
  beforeAll(async () => {
    legacy = await makeApp({ security: securityFake, consent: consentFake });
  });

  it('PUT /account/profile still works unchanged, with no section check at all', async () => {
    area = new FakeAccountArea({});
    const res = await call('PUT', '/profile', await webToken(), PUT_BODY, {}, legacy);
    expect(res.statusCode, res.body).toBe(200);
    expect(accountSvc.upsertProfile).toHaveBeenCalledTimes(1);
    expect(noRegistryCalls()).toBe(true);
  });
  it('GET /account/me still works', async () => {
    expect((await call('GET', '/me', await webToken(), undefined, {}, legacy)).statusCode).toBe(200);
  });
  it('none of the account area routes exists: 404 ROUTE_NOT_FOUND (and PATCH too)', async () => {
    for (const r of NEW_ROUTES) {
      const res = await routeCall(r, await webToken(), {}, legacy);
      if (r.id === 'getAccountProfile' || r.id === 'patchAccountProfile') {
        // /profile exists for PUT: a GET or PATCH there is a method that is not routed
        expect([404, 405], r.id).toContain(res.statusCode);
      } else {
        expect(res.statusCode, r.id).toBe(404);
        expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
      }
      expectNoStore(res);
    }
    expect(accountSvc.patchProfile).not.toHaveBeenCalled();
    expect(security.getSummary).not.toHaveBeenCalled();
    expect(consentSvc.getRequirements).not.toHaveBeenCalled();
  });
  it('the OpenAPI document of the older app has none of the new operations', () => {
    const ids = Object.values((legacy.swagger() as { paths: Record<string, Record<string, { operationId?: string }>> }).paths)
      .flatMap((m) => Object.values(m))
      .map((o) => o.operationId);
    for (const r of NEW_ROUTES) expect(ids).not.toContain(r.id);
    expect(ids).toContain('updateAccountProfile');
  });
});

describe('the summaries exist only when the service they compose is wired', () => {
  it('without security the security summary is not a route; privacy and the other sections still are', async () => {
    const consentOnly = await makeApp({ consent: consentFake, accountArea: areaProxy });
    const missing = await call('GET', '/security-summary', await webToken(), undefined, {}, consentOnly);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('ROUTE_NOT_FOUND');
    expect((await call('GET', '/privacy', await webToken(), undefined, {}, consentOnly)).statusCode).toBe(200);
    expect((await call('GET', '/navigation', await webToken(), undefined, {}, consentOnly)).statusCode).toBe(200);
    expect(security.getSummary).not.toHaveBeenCalled();
  });
  it('without consent the privacy summary is not a route; the security summary and the other sections still are', async () => {
    const securityOnly = await makeApp({ security: securityFake, accountArea: areaProxy });
    const missing = await call('GET', '/privacy', await webToken(), undefined, {}, securityOnly);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('ROUTE_NOT_FOUND');
    expect((await call('GET', '/security-summary', await webToken(), undefined, {}, securityOnly)).statusCode).toBe(200);
    expect(consentSvc.getRequirements).not.toHaveBeenCalled();
  });
  it('with neither, the contact, roles, profile, navigation and PATCH routes work', async () => {
    const plain = await makeApp({ accountArea: areaProxy });
    for (const r of NEW_ROUTES.filter((x) => !['getAccountSecuritySummary', 'getAccountPrivacySummary'].includes(x.id))) {
      expect((await routeCall(r, await webToken(), {}, plain)).statusCode, r.id).toBe(200);
    }
    for (const url of ['/security-summary', '/privacy']) expect((await call('GET', url, await webToken(), undefined, {}, plain)).statusCode, url).toBe(404);
  });
});

// ====================================================================== the composed sections
describe('GET /account/contact-verification', () => {
  const masked = {
    email: {
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: 'a***@example.test', verifiedAt: T0.toISOString(), source: 'USER_ENTERED' },
      pending: null,
    },
    phone: {
      phoneVerificationStatus: 'NONE',
      primary: null,
      pending: { maskedPhone: '+1 *** *** 0123', countryCode: 'US', purpose: 'INITIAL_PHONE', status: 'PENDING', lastSentAt: null, expiresAt: null },
    },
    contacts: { emailVerified: true, phoneVerified: false, contactsVerified: false },
  };
  it('returns exactly the masked email, phone and derived contacts of the guard, in the section shape', async () => {
    state.email = masked.email as AccountContext['email'];
    state.phone = masked.phone as AccountContext['phone'];
    state.contacts = masked.contacts;
    const res = await call('GET', '/contact-verification', await webToken());
    expect(res.statusCode).toBe(200);
    expect(ContactVerificationSectionResponse.parse(res.json()).data).toEqual(masked);
    expect(Object.keys((res.json() as { data: object }).data).sort()).toEqual(['contacts', 'email', 'phone']);
  });
  it('is the same values as GET /account/me for the same state', async () => {
    state.email = masked.email as AccountContext['email'];
    state.phone = masked.phone as AccountContext['phone'];
    state.contacts = masked.contacts;
    const section = (await call('GET', '/contact-verification', await webToken())).json() as { data: Record<string, unknown> };
    const me = (await call('GET', '/me', await webToken())).json() as { data: Record<string, unknown> };
    expect(section.data).toEqual({ email: me.data.email, phone: me.data.phone, contacts: me.data.contacts });
  });
  it('never carries an unmasked address or number, even if the guard object held one next to the masked state', async () => {
    state.email = { ...masked.email, address: 'ana.martinez@example.test', normalizedEmail: 'ana.martinez@example.test' } as unknown as AccountContext['email'];
    state.phone = { ...masked.phone, e164: '+12025550123', phone: '+12025550123' } as unknown as AccountContext['phone'];
    const res = await call('GET', '/contact-verification', await webToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('ana.martinez@example.test');
    expect(res.body).not.toContain('2025550123');
    expect(res.body).toContain('a***@example.test');
  });
  it('fails closed (a generic 500, no value) when a nested masked object carries an extra property instead of serializing it', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    state.email = {
      ...masked.email,
      primary: { ...masked.email.primary, email: 'ana.martinez@example.test' },
    } as unknown as AccountContext['email'];
    const res = await call('GET', '/contact-verification', await webToken());
    expect(res.statusCode).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('ana.martinez@example.test');
  });
});

describe('GET /account/roles', () => {
  it('switchableTo is every held role except the ACTIVE one', async () => {
    const token = await webToken();
    const asCustomer = AccountRolesSectionResponse.parse((await call('GET', '/roles', token, undefined, roleHeader('CUSTOMER'))).json()).data;
    expect(asCustomer).toEqual({ roles: [CUSTOMER, PROVIDER], activeRole: 'CUSTOMER', primaryRole: 'CUSTOMER', switchableTo: ['PROVIDER'] });
    const asProvider = AccountRolesSectionResponse.parse((await call('GET', '/roles', token, undefined, roleHeader('PROVIDER'))).json()).data;
    expect(asProvider).toEqual({ roles: [CUSTOMER, PROVIDER], activeRole: 'PROVIDER', primaryRole: 'CUSTOMER', switchableTo: ['CUSTOMER'] });
    expect(asProvider.switchableTo).not.toContain(asProvider.activeRole);
  });
  it('a single-role account has nothing to switch to', async () => {
    state.roles = [PROVIDER];
    state.primary = 'PROVIDER';
    const data = AccountRolesSectionResponse.parse((await call('GET', '/roles', await webToken())).json()).data;
    expect(data).toEqual({ roles: [PROVIDER], activeRole: 'PROVIDER', primaryRole: 'PROVIDER', switchableTo: [] });
  });
  it('a preferred role that differs from the active one is reported as it is', async () => {
    state.primary = 'PROVIDER';
    const data = AccountRolesSectionResponse.parse((await call('GET', '/roles', await webToken(), undefined, roleHeader('CUSTOMER'))).json()).data;
    expect(data.primaryRole).toBe('PROVIDER');
    expect(data.activeRole).toBe('CUSTOMER');
    expect(data.switchableTo).toEqual(['PROVIDER']);
  });
  it('lists only role code and name key, and has no way to grant a role', async () => {
    const res = await call('GET', '/roles', await webToken());
    expect(Object.keys((res.json() as { data: { roles: object[] } }).data.roles[0]!).sort()).toEqual(['code', 'nameContentKey']);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const r = await call(method, '/roles', await webToken(), { role: 'PROVIDER' });
      expect([404, 405], method).toContain(r.statusCode);
    }
    expect(accountSvc.selectActiveRole).not.toHaveBeenCalled();
  });
});

describe('GET /account/security-summary', () => {
  it('composes the security layer for the session of the verified token and returns its summary unchanged', async () => {
    const res = await call('GET', '/security-summary', await webToken({ auth_time: 1_700_000_000, acr: '2' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(SecuritySummaryResponse.parse(res.json()).data).toEqual(SECURITY_SUMMARY);
    expect(security.getSummary).toHaveBeenCalledTimes(1);
    const [current, facts] = security.getSummary.mock.calls[0]!;
    expect(current).toEqual({ accountId: ACCOUNT_ID, keycloakSessionId: KEYCLOAK_SID });
    expect(Object.keys(facts).sort()).toEqual(['acr', 'authTime']);
    expect(res.body).not.toContain(KEYCLOAK_SID);
  });
  it('passes a provider outage on as available:false (not an error)', async () => {
    security.getSummary.mockResolvedValueOnce({ mfa: { available: false, enabled: false }, activeSessionCount: 1, currentBrowserTrusted: false });
    const res = await call('GET', '/security-summary', await webToken());
    expect(SecuritySummaryResponse.parse(res.json()).data.mfa).toEqual({ available: false, enabled: false });
  });
  it('maps a security failure to its fixed answer and a revoked session to 401', async () => {
    security.getSummary.mockRejectedValueOnce(new AccountError('SECURITY_UNAVAILABLE', `down ${SERVICE_SECRET_MARKER}`, { cause: 'ECONNREFUSED' }));
    const down = await call('GET', '/security-summary', await webToken());
    expect(down.statusCode).toBe(503);
    expect(errorOf(down).code).toBe('ACCOUNT_SECURITY_UNAVAILABLE');
    expect(down.body).not.toContain(SERVICE_SECRET_MARKER);
    security.getSummary.mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'));
    const revoked = await call('GET', '/security-summary', await webToken());
    expect(revoked.statusCode).toBe(401);
    expect(errorOf(revoked).code).toBe('SESSION_REVOKED');
    expectNoStore(down);
    expectNoStore(revoked);
  });
  it('needs SECURITY: a role without it gets the uniform 404 and the security layer is not asked', async () => {
    area = new FakeAccountArea({ CUSTOMER: without(S.security) });
    expectSectionNotFound(await call('GET', '/security-summary', await webToken()));
    expect(security.getSummary).not.toHaveBeenCalled();
  });
});

describe('GET /account/privacy (counts only)', () => {
  it('returns the number of outstanding agreements and whether they are satisfied, evaluated for the token account, and dataDownload.available false', async () => {
    const res = await call('GET', '/privacy', await webToken());
    expect(res.statusCode, res.body).toBe(200);
    expect(PrivacySummaryResponse.parse(res.json()).data).toEqual({
      consents: { locale: 'en-US', satisfied: false, outstandingCount: 2 },
      dataDownload: { available: false },
    });
    expect(consentSvc.getRequirements.mock.calls).toEqual([[ACCOUNT_ID, {}]]);
  });
  it('has no purpose code, document, hash, version, event or label even though the consent service returned them', async () => {
    const res = await call('GET', '/privacy', await webToken());
    for (const word of [
      'purposeCode',
      'TERMS_OF_SERVICE',
      'PRIVACY_POLICY',
      'MARKETING_EMAIL',
      'document',
      'bodySha256',
      HASH,
      'versionId',
      VERSION_ID,
      'version',
      'eventType',
      'consentEvent',
      'legal.',
      'outstanding"',
      'requirements',
      'labelContentKey',
      'history',
    ])
      expect(res.body, word).not.toContain(word);
    expect(Object.keys((res.json() as { data: { consents: object } }).data.consents).sort()).toEqual(['locale', 'outstandingCount', 'satisfied']);
  });
  it('outstandingCount is the length of the outstanding list, satisfied is passed through, and 0 outstanding is satisfied', async () => {
    consentSvc.getRequirements.mockResolvedValueOnce({ ...REQUIREMENTS, satisfied: true, outstanding: [] });
    const done = PrivacySummaryResponse.parse((await call('GET', '/privacy', await webToken())).json()).data;
    expect(done.consents).toEqual({ locale: 'en-US', satisfied: true, outstandingCount: 0 });
    consentSvc.getRequirements.mockResolvedValueOnce({ ...REQUIREMENTS, locale: 'es-US', outstanding: ['A', 'B', 'C'] });
    const three = PrivacySummaryResponse.parse((await call('GET', '/privacy', await webToken())).json()).data;
    expect(three.consents).toEqual({ locale: 'es-US', satisfied: false, outstandingCount: 3 });
  });
  it('maps a consent failure to a generic 503 without the service detail', async () => {
    consentSvc.getRequirements.mockRejectedValueOnce(new AccountError('UNAVAILABLE', `down ${SERVICE_SECRET_MARKER}`, { cause: 'ECONNREFUSED' }));
    const res = await call('GET', '/privacy', await webToken());
    expect(res.statusCode).toBe(503);
    expect(errorOf(res).code).toBe('ACCOUNT_UNAVAILABLE');
    expect(res.body).not.toContain(SERVICE_SECRET_MARKER);
    expectNoStore(res);
  });
  it('needs PRIVACY_DATA: a role without it gets the uniform 404 and the consent layer is not asked, while /account/consents (a domain endpoint) is not gated', async () => {
    area = new FakeAccountArea({ CUSTOMER: without(S.privacyData) });
    expectSectionNotFound(await call('GET', '/privacy', await webToken()));
    expect(consentSvc.getRequirements).not.toHaveBeenCalled();
    consentSvc.getConsents.mockResolvedValueOnce({ current: [], history: [] });
    expect((await call('GET', '/consents', await webToken())).statusCode).toBe(200);
    expect(noRegistryCalls() || reads().length === 1).toBe(true);
    expect(area.calls.filter((c) => c.method === 'sectionsOf')).toHaveLength(1); // only the /privacy call above read the registry
  });
});

describe('domain endpoints are not gated by sections', () => {
  it('GET /account/me and the consent routes do not read the registry', async () => {
    consentSvc.getConsents.mockResolvedValueOnce({ current: [], history: [] });
    expect((await call('GET', '/me', await webToken())).statusCode).toBe(200);
    expect((await call('GET', '/consents', await webToken())).statusCode).toBe(200);
    expect((await call('GET', '/consents/requirements', await webToken())).statusCode).toBe(200);
    expect(noRegistryCalls()).toBe(true);
  });
});

// ====================================================================== the guard reads the registry once per request
describe('the section guard reads the registry ONCE per request', () => {
  const requestOf = (activeRole: string | null) =>
    ({ server: { accountArea: area }, account: { activeRole } }) as unknown as Parameters<typeof sectionsOfRequest>[0];
  it('several checks on one request (all, any, a second all) cost a single registry read', async () => {
    const req = requestOf('CUSTOMER');
    await assertAccountSections(req, ['PROFILE', 'ROLES'], 'all');
    await assertAccountSections(req, ['NOTIFICATIONS', 'SECURITY'], 'any');
    await assertAccountSections(req, ['PROFILE'], 'all');
    expect(area.calls.filter((c) => c.method === 'sectionsOf')).toEqual([{ method: 'sectionsOf', role: 'CUSTOMER' }]);
  });
  it('a second request reads the registry again (the cache belongs to the request, not to the process)', async () => {
    await assertAccountSections(requestOf('CUSTOMER'), ['PROFILE'], 'all');
    await assertAccountSections(requestOf('CUSTOMER'), ['PROFILE'], 'all');
    expect(area.calls.filter((c) => c.method === 'sectionsOf')).toHaveLength(2);
  });
  it('a refusal is the uniform 404 and is also read once', async () => {
    const req = requestOf('CUSTOMER');
    for (const codes of [['NOTIFICATIONS'], ['CLOSE_ACCOUNT']])
      await expect(assertAccountSections(req, codes, 'all')).rejects.toMatchObject({ code: 'ACCOUNT_SECTION_NOT_FOUND', category: 'NOT_FOUND' });
    expect(area.calls.filter((c) => c.method === 'sectionsOf')).toHaveLength(1);
  });
});

// ====================================================================== OpenAPI
describe('account area OpenAPI document', () => {
  type Operation = {
    operationId?: string;
    security?: unknown[];
    tags?: string[];
    parameters?: { name: string; in: string }[];
    requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown>; additionalProperties?: unknown } }> };
  };
  const doc = () => app.swagger() as unknown as { paths: Record<string, Record<string, Operation>>; tags?: { name: string }[] };
  const operations = () =>
    Object.entries(doc().paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
  const EXPECTED: [string, string, string][] = [
    ['getAccountNavigation', 'GET', '/api/v1/account/navigation'],
    ['getAccountProfile', 'GET', '/api/v1/account/profile'],
    ['patchAccountProfile', 'PATCH', '/api/v1/account/profile'],
    ['getAccountContactVerification', 'GET', '/api/v1/account/contact-verification'],
    ['getAccountRolesSection', 'GET', '/api/v1/account/roles'],
    ['getAccountSecuritySummary', 'GET', '/api/v1/account/security-summary'],
    ['getAccountPrivacySummary', 'GET', '/api/v1/account/privacy'],
  ];

  it('contains exactly the SEVEN new operations (tag account-area) with the right methods and paths, and updateAccountProfile still exists', () => {
    const area7 = operations().filter((o) => o.op.tags?.includes('account-area'));
    expect(area7.map((o) => [o.op.operationId, o.method, o.path]).sort()).toEqual([...EXPECTED].sort());
    expect(area7).toHaveLength(7);
    const put = operations().find((o) => o.op.operationId === 'updateAccountProfile');
    expect(put).toMatchObject({ method: 'PUT', path: '/api/v1/account/profile' });
    expect(put!.op.tags).toEqual(['account']);
    expect(doc().tags?.map((t) => t.name)).toContain('account-area');
  });
  it('every new operation is Bearer-protected and tagged only account-area', () => {
    for (const [id] of EXPECTED) {
      const op = operations().find((o) => o.op.operationId === id)!.op;
      expect(op.security, id).toEqual([{ bearerAuth: [] }]);
      expect(op.tags, id).toEqual(['account-area']);
    }
  });
  it('no new path accepts an account id, a role or a section list as a path parameter, query parameter or body property', () => {
    for (const [id, , path] of EXPECTED) {
      const op = operations().find((o) => o.op.operationId === id)!.op;
      expect(path, id).not.toContain('{');
      expect(
        (op.parameters ?? []).filter((p) => p.in !== 'header'),
        `${id} documents no path or query parameter`,
      ).toEqual([]);
      const request = raw({ parameters: op.parameters ?? [], requestBody: op.requestBody });
      for (const word of ['accountId', 'account_id', 'subject', 'issuer', 'userId', 'role', 'section', 'sections'])
        expect(request, `${id} ${word}`).not.toContain(`"${word}"`);
    }
  });
  it('the PATCH body documents exactly the four optional profile fields and refuses additional properties', () => {
    const op = operations().find((o) => o.op.operationId === 'patchAccountProfile')!.op;
    const schema = op.requestBody!.content!['application/json']!.schema!;
    expect(Object.keys(schema.properties!).sort()).toEqual(['firstName', 'lastName', 'preferredLocale', 'timeZone']);
    expect(schema.additionalProperties).toBe(false);
  });
  it('documents no path with an account id, and the privacy and security summaries are read-only (GET)', () => {
    const paths = Object.keys(doc().paths).filter((p) => p.startsWith('/api/v1/account'));
    expect(paths.filter((p) => /\{/.test(p) && !/consents|security|email|phone/.test(p))).toEqual([]);
    for (const p of [
      '/api/v1/account/privacy',
      '/api/v1/account/security-summary',
      '/api/v1/account/navigation',
      '/api/v1/account/roles',
      '/api/v1/account/contact-verification',
    ])
      expect(Object.keys(doc().paths[p]!), p).toEqual(['get']);
    expect(Object.keys(doc().paths['/api/v1/account/profile']!).sort()).toEqual(['get', 'patch', 'put']);
  });
});
