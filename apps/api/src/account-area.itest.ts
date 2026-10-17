// ACC-001 shared account area over HTTP, on the REAL stack of services: the real Fastify app (buildApp), the real AccountService, AccountAreaService, SecurityService (identity
// provider: FakeSecurityIdentityProvider), ConsentService, ContentService and ConfigurationService on one real, isolated PostgreSQL (migration 0014 seeds the registry, the
// section matrix and the account area copy), the real auth plugin and forged-but-signed tokens carrying `sid` and `auth_time`. The unit layer (`account-area.test.ts`) proves
// the HTTP edge with a fake registry; this file proves the behaviour with the database.
//
// What this file proves end to end: the first request of a person bootstraps the account and the navigation returns the six seeded sections in menu order with content keys
// the public content API resolves; the section set follows the ACTIVE role of the request (a section row enabled for one role only, switching the role in the header changes
// the result within the same token and the same application session); a section disabled in the matrix for one role is a uniform 404 on its endpoint for that role only, while
// the domain endpoints stay served; the field to section authorization of PATCH /account/profile; an account with no role has no sections; the partial profile update against
// PostgreSQL (names, locale, time zone, null clears, idempotence, PROFILE_REQUIRED, invalid values, audit rows naming fields only, concurrent patches of different fields);
// PUT as the full replace; the composed sections (contact, security, privacy) equal the domains they compose; the query budget of the navigation (exact, constant in the number
// of sections); and a secrecy and caching sweep over every response, header, audit row and captured log line.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  AccountAreaService,
  AccountService,
  ConsentService,
  FakeSecurityIdentityProvider,
  SecurityService,
  type ConsentPolicyProvider,
  type SecurityPolicyProvider,
} from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentService } from '@bananagig/content';
import {
  AccountNavigationResponse,
  AccountProfileViewResponse,
  AccountResponse,
  AccountRolesSectionResponse,
  ConsentRequirementsResponse,
  ContactVerificationSectionResponse,
  CORRELATION_HEADER,
  ErrorResponse,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  SecuritySummaryResponse,
  accountSectionDescriptionKey,
  accountSectionLabelKey,
  publicDisplayName,
} from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { MemoryRateLimiter } from '@bananagig/platform';
import { createDatabase, type Database } from '@bananagig/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createSecurityPolicyProvider } from './modules/security/wiring';

// ---------------------------------------------------------------- the real stack
const HASH_KEY = 'itest-account-area-hash-key-'.concat('k'.repeat(28));
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', VERIFICATION_HASH_SECRET: HASH_KEY } });
const AUTHOR = 'legal:author';
const APPROVER = 'legal:approver';
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const TERMS_KEY = 'legal.terms_of_service';
const PRIVACY_KEY = 'legal.privacy_policy';
const SEEDED_CODES = ['PROFILE', 'CONTACT_VERIFICATION', 'SECURITY', 'LANGUAGE_REGION', 'PRIVACY_DATA', 'ROLES'];
/** The statements of one steady-state GET /account/navigation (pinned; see the query budget describe). */
const EXPECTED_NAVIGATION_STATEMENTS = 8;
const SEEDED_ROUTES = ['/account/profile', '/account/contact', '/account/security', '/account/language-region', '/account/privacy', '/account/roles'];

let iso: IsolatedDatabase;
let bigDb: Database;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
const provider = new FakeSecurityIdentityProvider();
const limiter = new MemoryRateLimiter();
/** When non-null, every SQL statement the application's database runs is appended (the query budget test). */
let queryLog: string[] | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
  cid: string;
}
/** Every response of the file, so the last tests can prove the secrecy and caching rules over ALL of them. */
const transcript: Res[] = [];
const secrets = { tokens: [] as string[], sids: [] as string[], subjects: [] as string[], names: [] as string[], emails: [] as string[] };

interface Tok {
  token: string;
  sid: string;
}
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  t0: Tok;
}
interface CallOptions {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** The token to present (default: the actor's first session); null sends no Authorization header. */
  as?: Tok | string | null;
  cid?: string;
}
const appNow = (): number => Math.floor(Date.now() / 1000);

async function mint(sub: string, o: { roles?: string[]; claims?: Record<string, unknown> } = {}): Promise<Tok> {
  const sid = randomUUID();
  const token = await signToken(keys, {
    claims: { sub, azp: 'bananagig-web', realm_access: { roles: o.roles ?? ['customer'] }, ...o.claims },
    sid,
    authTime: appNow() - 5,
  });
  secrets.tokens.push(token);
  secrets.sids.push(sid);
  provider.addSession(sub, sid);
  return { token, sid };
}

async function call(actor: Actor | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: CallOptions = {}): Promise<Res> {
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const as = o.as === undefined ? actor?.t0 : o.as;
  const token = as === null || as === undefined ? undefined : typeof as === 'string' ? as : as.token;
  const cid = o.cid ?? randomUUID();
  const path = url.startsWith('/api/') ? url : `/api/v1${url}`;
  const r = await app.inject({
    method,
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      [CORRELATION_HEADER]: cid,
      ...o.headers,
    },
    ...(hasBody ? { payload: o.rawBody ?? JSON.stringify(o.body) } : {}),
  });
  let body: Json;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  const res: Res = { method, url: path, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}

// ---------------------------------------------------------------- contract shapes
const SHAPES: Record<string, z.ZodType> = {
  getAccountNavigation: AccountNavigationResponse,
  getAccountProfile: AccountProfileViewResponse,
  patchAccountProfile: ProfilePatchedResponse,
  getAccountContactVerification: ContactVerificationSectionResponse,
  getAccountRolesSection: AccountRolesSectionResponse,
  getAccountSecuritySummary: SecuritySummaryResponse,
  getAccountPrivacySummary: PrivacySummaryResponse,
  getAccountMe: AccountResponse,
  updateAccountProfile: AccountResponse,
  getAccountConsentRequirements: ConsentRequirementsResponse,
};
const OP = {
  nav: 'getAccountNavigation',
  profile: 'getAccountProfile',
  patch: 'patchAccountProfile',
  contact: 'getAccountContactVerification',
  roles: 'getAccountRolesSection',
  security: 'getAccountSecuritySummary',
  privacy: 'getAccountPrivacySummary',
  me: 'getAccountMe',
  put: 'updateAccountProfile',
  requirements: 'getAccountConsentRequirements',
} as const;

/** A 200 with the standard envelope, no-store and the correlation id; with an operation id the body must also equal its contract exactly (nothing missing, nothing extra). */
const ok = (r: Res, op?: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(200);
  expect(Object.keys(r.body).sort(), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.cid);
  expect(r.headers[CORRELATION_HEADER]).toBe(r.cid);
  expect(r.headers['cache-control'], `${r.method} ${r.url}`).toBe('no-store');
  if (op) {
    const parsed = SHAPES[op]!.safeParse(r.body);
    expect(parsed.success, `${op}: ${r.raw}`).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), `${op} carries no field outside its contract`).toEqual(r.body);
  }
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId, 'the error carries the correlation id of the request').toBe(r.cid);
  expect(r.headers['cache-control'], `${r.method} ${r.url} ${code}`).toBe('no-store');
  return r.body.error;
};
/** The error body without the per-request correlation id: two uniform answers must be identical. */
const bare = (r: Res): unknown => {
  const { correlationId: _c, ...rest } = r.body.error;
  return rest;
};
const notFound = (r: Res): Json => fail(r, 404, 'ACCOUNT_SECTION_NOT_FOUND');

// ---------------------------------------------------------------- routes
const AREA = '/account';
const nav = (a: Actor, role?: string, o: CallOptions = {}) =>
  call(a, 'GET', `${AREA}/navigation`, { ...o, headers: { ...(role ? { 'x-active-role': role } : {}), ...o.headers } });
const withRole = (role?: string, o: CallOptions = {}): CallOptions => ({ ...o, headers: { ...(role ? { 'x-active-role': role } : {}), ...o.headers } });
const getProfile = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/profile`, withRole(role));
const patch = (a: Actor, body: unknown, role?: string, o: CallOptions = {}) => call(a, 'PATCH', `${AREA}/profile`, withRole(role, { ...o, body }));
const put = (a: Actor, body: unknown, role?: string) => call(a, 'PUT', `${AREA}/profile`, withRole(role, { body }));
const me = (a: Actor, role?: string, o: CallOptions = {}) => call(a, 'GET', `${AREA}/me`, withRole(role, o));
const contact = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/contact-verification`, withRole(role));
const rolesSection = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/roles`, withRole(role));
const securitySummary = (a: Actor, role?: string, o: CallOptions = {}) => call(a, 'GET', `${AREA}/security-summary`, withRole(role, o));
const privacy = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/privacy`, withRole(role));
const consents = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/consents`, withRole(role));
const requirements = (a: Actor, role?: string) => call(a, 'GET', `${AREA}/consents/requirements`, withRole(role));
const GUARDED_GETS = [
  ['profile', getProfile],
  ['contact-verification', contact],
  ['roles', rolesSection],
  ['security-summary', securitySummary],
  ['privacy', privacy],
] as const;

// ---------------------------------------------------------------- the database
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
interface AuditRow {
  action: string;
  actor: string;
  changes: Json;
  correlation_id: string;
}
const profileAudit = (accountId: string) =>
  q<AuditRow>(
    `SELECT action, actor, changes, correlation_id FROM identity.account_audit_events WHERE account_id = $1 AND action = 'PROFILE_UPDATED' ORDER BY occurred_at, audit_event_id`,
    [accountId],
  );
const profileRow = async (accountId: string) =>
  (
    await q<{ first_name: string; last_name: string; preferred_locale: string | null; iana_name: string | null; updated_at: Date }>(
      `SELECT p.first_name, p.last_name, p.preferred_locale, z.iana_name, p.updated_at FROM identity.account_profiles p LEFT JOIN geography.time_zones z ON z.time_zone_id = p.time_zone_id WHERE p.account_id = $1`,
      [accountId],
    )
  )[0];
const sessionCount = (accountId: string) => count('SELECT 1 FROM identity.application_sessions WHERE account_id = $1', [accountId]);
/** Everything a refused request must leave untouched. */
const writes = async (accountId: string) => ({
  profile: await profileRow(accountId),
  audit: (await q('SELECT action FROM identity.account_audit_events WHERE account_id = $1 ORDER BY audit_event_id', [accountId])).length,
  outbox: await count('SELECT 1 FROM integration.outbox_events WHERE aggregate_id = $1', [accountId]),
});

// ---------------------------------------------------------------- the registry (data) as the tests change it
const roleId = (role: string) => `(SELECT role_id FROM identity.roles WHERE code = '${role}')`;
const setEnabled = (section: string, role: string, enabled: boolean) =>
  q(`UPDATE identity.account_section_roles SET enabled = $2 WHERE section_code = $1 AND role_id = ${roleId(role)}`, [section, enabled]);
/** Adds an ACTIVE section (its content entry is created through the real content service) and its matrix rows. */
async function addSection(
  code: string,
  slug: string,
  rows: { role: string; order: number; enabled: boolean }[],
  keySuffix = code.toLowerCase(),
): Promise<void> {
  const labelKey = `account.area.section.itest_${keySuffix}.label`;
  await content.createEntry(
    { key: labelKey, contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: `itest section ${code}`, variables: [], maxScopeType: 'PLATFORM' },
    AUTHOR,
  );
  await q(
    `INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES ($1, $2, $3, NULL, 'ACTIVE')`,
    [code, `/account/${slug}`, labelKey],
  );
  for (const r of rows)
    await q(`INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, ${roleId(r.role)}, $2, $3)`, [
      code,
      r.enabled,
      r.order,
    ]);
}
/** Switches off every section that is not one of the seeded eight and re-applies the seeded enabled flags, so a test never leaks registry changes into the next. */
async function resetRegistry(): Promise<void> {
  await q(`UPDATE identity.account_section_roles SET enabled = false WHERE section_code <> ALL ($1::text[])`, [
    [...SEEDED_CODES, 'NOTIFICATIONS', 'CLOSE_ACCOUNT'],
  ]);
  await q(
    `UPDATE identity.account_section_roles SET enabled = (section_code = ANY ($1::text[])) WHERE section_code = ANY ($2::text[]) AND role_id IN (SELECT role_id FROM identity.roles WHERE code IN ('CUSTOMER', 'PROVIDER'))`,
    [SEEDED_CODES, [...SEEDED_CODES, 'NOTIFICATIONS', 'CLOSE_ACCOUNT']],
  );
}

// ---------------------------------------------------------------- actors
async function newActor(label: string, o: { roles?: string[]; first?: 'me' | 'navigation' } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  secrets.subjects.push(sub);
  const a: Actor = { label, sub, accountId: '', t0: undefined as unknown as Tok };
  provider.setUser(sub);
  a.t0 = await mint(sub, { roles: o.roles ?? ['customer'] });
  // the account and its first session are created by the first authenticated request
  const first = o.first === 'navigation' ? await nav(a) : await me(a);
  expect(first.status, first.raw).toBe(200);
  a.accountId = (
    await q<{ account_id: string }>('SELECT e.account_id FROM identity.external_identities e WHERE e.provider_subject = $1', [sub])
  )[0]!.account_id;
  return a;
}
const grant = (a: Actor, role: 'CUSTOMER' | 'PROVIDER') => accounts.grantRole(a.accountId, role, { actor: 'system:itest', source: 'SYSTEM', reason: 'itest' });
const codesOf = (data: Json): string[] => data.sections.map((s: { code: string }) => s.code);

// ---------------------------------------------------------------- legal documents through the REAL content workflow (as consent.itest.ts does)
interface Pub {
  versionId: string;
  locale: string;
  hash: string;
}
async function publishLegal(entryKey: string): Promise<Pub> {
  const created = await content.createVersion(entryKey, { locale: 'en-US', body: `ITESTLEGALBODY ${randomUUID()} ${entryKey}`, reason: 'itest' }, AUTHOR);
  await content.submit(created.versionId, AUTHOR);
  await content.approve(created.versionId, APPROVER, 'ok');
  const published = await content.publish(created.versionId, AUTHOR);
  return { versionId: published.versionId, locale: published.locale, hash: published.bodySha256 };
}
const acceptDoc = (a: Actor, purpose: string, p: Pub) =>
  call(a, 'POST', `${AREA}/consents/${purpose}/accept`, { body: { versionId: p.versionId, locale: p.locale, bodySha256: p.hash } });

// ---------------------------------------------------------------- log capture (for the whole file)
const logLines: string[] = [];
function captureLogs(): void {
  const capture = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
}

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  bigDb = createDatabase(iso.url, {
    role: 'tests',
    overrides: { poolMax: 50, connectionTimeoutMs: 30_000 },
    onQuery: (e) => {
      queryLog?.push(e.sql);
    },
  });
  keys = await createTestKeys('k1');
  configuration = new ConfigurationService({ database: bigDb, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  content = new ContentService({ database: bigDb, env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database: bigDb, lastSeenTouchSeconds: 0 });
  const securityPolicy: SecurityPolicyProvider = createSecurityPolicyProvider(configuration);
  const consentPolicy: ConsentPolicyProvider = createConsentPolicyProvider(configuration);
  captureLogs();
  app = await buildApp({
    cfg,
    verifier: createTokenVerifier({
      issuer: TEST_ISSUER,
      apiAudience: 'bananagig-api',
      jwks: keys.getKey,
      webClientId: 'bananagig-web',
      adminClientId: 'bananagig-admin',
    }),
    configuration,
    content,
    accounts,
    security: new SecurityService({ database: bigDb, policy: securityPolicy, identityProvider: provider, rateLimiter: limiter, hashSecret: HASH_KEY }),
    consent: new ConsentService({ database: bigDb, policy: consentPolicy, defaultLocale: createDefaultLocaleResolver(content) }),
    accountArea: new AccountAreaService({ database: bigDb }),
    readiness: async () => ({}),
  });
  await app.ready();
  // a second active locale for the language tests (the fresh database only has en-US)
  await q(`INSERT INTO content.locales (locale, is_active) VALUES ('es-US', true)`);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await bigDb?.close();
  await iso?.drop();
});

// ====================================================================== the seeded registry
describe('the registry seeded by migration 0014', () => {
  it('has the eight sections and the sixteen matrix rows: six ACTIVE sections enabled in order 10..60 for both roles, two PLANNED sections switched off at 70 and 80', async () => {
    const sections = await q<{ section_code: string; route_path: string; status: string; label_content_key: string; description_content_key: string }>(
      'SELECT section_code, route_path, status, label_content_key, description_content_key FROM identity.account_sections ORDER BY route_path',
    );
    expect(sections.map((s) => s.section_code).sort()).toEqual([...SEEDED_CODES, 'NOTIFICATIONS', 'CLOSE_ACCOUNT'].sort());
    for (const s of sections) {
      expect(s.label_content_key).toBe(accountSectionLabelKey(s.section_code));
      expect(s.description_content_key).toBe(accountSectionDescriptionKey(s.section_code));
      expect(s.status).toBe(['NOTIFICATIONS', 'CLOSE_ACCOUNT'].includes(s.section_code) ? 'PLANNED' : 'ACTIVE');
    }
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      const rows = await q<{ section_code: string; enabled: boolean; display_order: number }>(
        `SELECT section_code, enabled, display_order FROM identity.account_section_roles WHERE role_id = ${roleId(role)} ORDER BY display_order`,
      );
      expect(
        rows.map((r) => [r.section_code, r.enabled, r.display_order]),
        role,
      ).toEqual([
        ['PROFILE', true, 10],
        ['CONTACT_VERIFICATION', true, 20],
        ['SECURITY', true, 30],
        ['LANGUAGE_REGION', true, 40],
        ['PRIVACY_DATA', true, 50],
        ['ROLES', true, 60],
        ['NOTIFICATIONS', false, 70],
        ['CLOSE_ACCOUNT', false, 80],
      ]);
    }
    expect(await count('SELECT 1 FROM identity.account_section_roles')).toBe(16);
  });
});

// ====================================================================== the first request, the navigation
describe('GET /account/navigation', () => {
  it('as the FIRST request of a person bootstraps the account and returns the six seeded sections in menu order with real content keys', async () => {
    const before = await count('SELECT 1 FROM identity.accounts');
    const a = await newActor('first-nav', { first: 'navigation' });
    expect(await count('SELECT 1 FROM identity.accounts')).toBe(before + 1);
    expect(await count('SELECT 1 FROM identity.account_roles WHERE account_id = $1', [a.accountId])).toBe(1);
    const data = ok(await nav(a), OP.nav);
    expect(data.activeRole).toBe('CUSTOMER');
    expect(data.roles).toEqual([{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }]);
    expect(data.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    expect(data.sections).toEqual(
      SEEDED_CODES.map((code, i) => ({
        code,
        route: SEEDED_ROUTES[i],
        labelContentKey: accountSectionLabelKey(code),
        descriptionContentKey: accountSectionDescriptionKey(code),
      })),
    );
    // NOTIFICATIONS and CLOSE_ACCOUNT are PLANNED and switched off: they are never offered
    expect(codesOf(data)).not.toContain('NOTIFICATIONS');
    expect(codesOf(data)).not.toContain('CLOSE_ACCOUNT');
  });

  it('every label and description key it returns resolves through the PUBLIC content API (no token) to the seeded text', async () => {
    const a = await newActor('nav-content');
    const data = ok(await nav(a), OP.nav);
    const expected: Record<string, string> = {
      PROFILE: 'Profile',
      CONTACT_VERIFICATION: 'Contact details',
      SECURITY: 'Security',
      LANGUAGE_REGION: 'Language and region',
      PRIVACY_DATA: 'Privacy and data',
      ROLES: 'Roles',
    };
    for (const s of data.sections) {
      const label = await call(undefined, 'POST', '/content/resolve', { body: { key: s.labelContentKey, locale: 'en-US' }, as: null });
      expect(label.status, label.raw).toBe(200);
      expect(label.body.data.value).toBe(expected[s.code]);
      const description = await call(undefined, 'POST', '/content/resolve', { body: { key: s.descriptionContentKey, locale: 'en-US' }, as: null });
      expect(description.status, description.raw).toBe(200);
      expect(description.body.data.value.length).toBeGreaterThan(5);
    }
    // the shell keys the page itself reads exist as well
    for (const key of ['account.area.title', 'account.area.overview.empty', 'account.area.roles.single']) {
      expect((await call(undefined, 'POST', '/content/resolve', { body: { key, locale: 'en-US' }, as: null })).status, key).toBe(200);
    }
  });

  it('rejects every kind of bad caller before the registry: 401 without a token, 403 for the admin context', async () => {
    fail(await call(undefined, 'GET', `${AREA}/navigation`, { as: null }), 401, 'AUTHENTICATION_REQUIRED');
    fail(await call(undefined, 'GET', `${AREA}/navigation`, { as: 'not.a.token' }), 401, 'INVALID_TOKEN');
    const admin = await signToken(keys, {
      claims: {
        sub: 'admin-a',
        azp: 'bananagig-admin',
        sid: randomUUID(),
        realm_access: { roles: [] },
        resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
      },
    });
    secrets.tokens.push(admin);
    fail(await call(undefined, 'GET', `${AREA}/navigation`, { as: admin }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
  });

  it('a strict query: any parameter is a 400', async () => {
    const a = await newActor('nav-query');
    for (const qs of ['?accountId=' + randomUUID(), '?role=PROVIDER', '?x=1']) fail(await call(a, 'GET', `${AREA}/navigation${qs}`), 400, 'VALIDATION_FAILED');
  });
});

// ====================================================================== the section set follows the ACTIVE role
describe('the section set belongs to the ACTIVE role of the request', () => {
  it('a dual-role account: the x-active-role header selects the role, within the same token and the same application session (no new login)', async () => {
    const a = await newActor('dual');
    await grant(a, 'PROVIDER');
    const sessions = await sessionCount(a.accountId);
    expect(sessions).toBe(1);
    const asCustomer = ok(await nav(a, 'CUSTOMER'), OP.nav);
    const asProvider = ok(await nav(a, 'PROVIDER'), OP.nav);
    const primary = ok(await nav(a), OP.nav);
    expect(asCustomer.activeRole).toBe('CUSTOMER');
    expect(asProvider.activeRole).toBe('PROVIDER');
    expect(primary.activeRole).toBe('CUSTOMER');
    expect(asCustomer.roles.map((r: Json) => r.code).sort()).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(asProvider.roles).toEqual(asCustomer.roles);
    // today the two roles see the same six sections (no role-specific capability exists yet)
    expect(codesOf(asCustomer)).toEqual(SEEDED_CODES);
    expect(codesOf(asProvider)).toEqual(SEEDED_CODES);
    expect(await sessionCount(a.accountId), 'role switching created no session').toBe(sessions);
  });

  it('PROVES the set follows the active role: a section enabled only for PROVIDER (in menu position 5, before the seeded ones) is returned to PROVIDER and never to CUSTOMER', async () => {
    const a = await newActor('role-set');
    await grant(a, 'PROVIDER');
    try {
      await addSection('PAYOUTS_ITEST', 'payouts-itest', [
        { role: 'PROVIDER', order: 5, enabled: true },
        { role: 'CUSTOMER', order: 5, enabled: false },
      ]);
      await addSection('AFTER_ITEST', 'after-itest', [{ role: 'PROVIDER', order: 90, enabled: true }]);
      const token = a.t0;
      const asCustomer = ok(await nav(a, 'CUSTOMER', { as: token }), OP.nav);
      const asProvider = ok(await nav(a, 'PROVIDER', { as: token }), OP.nav);
      expect(codesOf(asCustomer)).toEqual(SEEDED_CODES);
      // menu order comes from display_order, not from insertion order or the code
      expect(codesOf(asProvider)).toEqual(['PAYOUTS_ITEST', ...SEEDED_CODES, 'AFTER_ITEST']);
      expect(asProvider.sections[0]).toMatchObject({
        route: '/account/payouts-itest',
        labelContentKey: 'account.area.section.itest_payouts_itest.label',
        descriptionContentKey: null,
      });
      // switching back and forth with the same token: the set follows the header every time
      for (const role of ['CUSTOMER', 'PROVIDER', 'CUSTOMER', 'PROVIDER']) {
        const d = ok(await nav(a, role), OP.nav);
        expect(codesOf(d).includes('PAYOUTS_ITEST'), role).toBe(role === 'PROVIDER');
        expect(d.activeRole).toBe(role);
      }
      // no header: the preferred (primary) role decides
      expect(codesOf(ok(await nav(a), OP.nav))).toEqual(SEEDED_CODES);
      expect(await sessionCount(a.accountId)).toBe(1);
      // a role the account does not hold selects nothing
      fail(await nav(a, 'ADMIN'), 403, 'ACCOUNT_ROLE_NOT_HELD');
      // a customer-only account never gets the provider-only section even when it asks for it
      const customerOnly = await newActor('customer-only');
      fail(await nav(customerOnly, 'PROVIDER'), 403, 'ACCOUNT_ROLE_NOT_HELD');
      expect(codesOf(ok(await nav(customerOnly), OP.nav))).toEqual(SEEDED_CODES);
    } finally {
      await resetRegistry();
    }
    const after = ok(await nav(a, 'PROVIDER'), OP.nav);
    expect(codesOf(after), 'a switched-off row disappears at once').toEqual(SEEDED_CODES);
  });

  it('a deactivated role cannot select sections: 403 from the account guard on every area route', async () => {
    const a = await newActor('deactivated');
    await grant(a, 'PROVIDER');
    await accounts.deactivateRole(a.accountId, 'PROVIDER', { actor: 'system:itest', reason: 'itest' });
    fail(await nav(a, 'PROVIDER'), 403, 'ACCOUNT_ROLE_NOT_ACTIVE');
    for (const [, fn] of GUARDED_GETS) expect((await fn(a, 'PROVIDER')).status).toBe(403);
    expect(ok(await nav(a, 'CUSTOMER'), OP.nav).roles.map((r: Json) => r.code)).toEqual(['CUSTOMER']);
  });

  it('an account with NO role gets sections [] and a 404 on every guarded route (with one identical body), while the domain endpoints still answer', async () => {
    const a = await newActor('norole', { roles: [] });
    const data = ok(await nav(a), OP.nav);
    expect(data).toEqual({ activeRole: null, roles: [], sections: [], contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false } });
    const bodies: unknown[] = [];
    for (const [, fn] of GUARDED_GETS) {
      const r = await fn(a);
      notFound(r);
      bodies.push(bare(r));
    }
    const before = await writes(a.accountId);
    const patched = await patch(a, { firstName: 'Ana', lastName: 'Martinez' });
    notFound(patched);
    bodies.push(bare(patched));
    const replaced = await put(a, { firstName: 'Ana', lastName: 'Martinez' });
    notFound(replaced);
    bodies.push(bare(replaced));
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'ACCOUNT_SECTION_NOT_FOUND', category: 'NOT_FOUND', message: 'the account section was not found' });
    expect(await writes(a.accountId), 'a refused request wrote nothing: no profile, audit row or event').toEqual(before);
    expect(before.profile).toBeUndefined();
    // the domain endpoints are not gated by sections
    ok(await me(a), OP.me);
    expect((await consents(a)).status).toBe(200);
    expect((await requirements(a)).status).toBe(200);
  });
});

// ====================================================================== hidden-section enforcement
describe('a section disabled in the matrix for one role is a 404 on its endpoint for that role only', () => {
  it('PRIVACY_DATA disabled for PROVIDER: /account/privacy is 200 for CUSTOMER and the uniform 404 for PROVIDER, /account/consents stays 200 for PROVIDER, and the menu agrees', async () => {
    const a = await newActor('hidden-privacy');
    await grant(a, 'PROVIDER');
    const reference = await newActor('hidden-reference', { roles: [] });
    const refusal = await privacy(reference);
    notFound(refusal);
    const uniform = bare(refusal);
    try {
      expect(ok(await privacy(a, 'CUSTOMER'), OP.privacy).dataDownload).toEqual({ available: false });
      expect(ok(await privacy(a, 'PROVIDER'), OP.privacy).dataDownload).toEqual({ available: false });
      await setEnabled('PRIVACY_DATA', 'PROVIDER', false);
      ok(await privacy(a, 'CUSTOMER'), OP.privacy);
      const hidden = await privacy(a, 'PROVIDER');
      notFound(hidden);
      expect(bare(hidden), 'identical to the answer for an account with no section at all').toEqual(uniform);
      expect(hidden.raw).not.toMatch(/PRIVACY|PROVIDER|CUSTOMER|privacy|provider/);
      // the domain endpoint is not gated
      expect((await consents(a, 'PROVIDER')).status).toBe(200);
      expect((await requirements(a, 'PROVIDER')).status).toBe(200);
      // the menu agrees with the guard
      expect(codesOf(ok(await nav(a, 'PROVIDER'), OP.nav))).toEqual(SEEDED_CODES.filter((c) => c !== 'PRIVACY_DATA'));
      expect(codesOf(ok(await nav(a, 'CUSTOMER'), OP.nav))).toEqual(SEEDED_CODES);
      // every OTHER section is still served to PROVIDER
      for (const [name, fn] of GUARDED_GETS.filter(([n]) => n !== 'privacy')) expect((await fn(a, 'PROVIDER')).status, name).toBe(200);
    } finally {
      await resetRegistry();
    }
    ok(await privacy(a, 'PROVIDER'), OP.privacy);
  });

  it('every guarded route follows its own section: disabling one section for PROVIDER hides exactly its endpoints', async () => {
    const a = await newActor('hidden-each');
    await grant(a, 'PROVIDER');
    const cases: [string, (a: Actor, role?: string) => Promise<Res>][] = [
      ['CONTACT_VERIFICATION', contact],
      ['ROLES', rolesSection],
      ['SECURITY', securitySummary],
      ['PRIVACY_DATA', privacy],
    ];
    try {
      for (const [section, fn] of cases) {
        await setEnabled(section, 'PROVIDER', false);
        notFound(await fn(a, 'PROVIDER'));
        expect((await fn(a, 'CUSTOMER')).status, `${section} for CUSTOMER`).toBe(200);
        for (const [other, otherFn] of cases.filter(([c]) => c !== section))
          expect((await otherFn(a, 'PROVIDER')).status, `${other} while ${section} is off`).toBe(200);
        await resetRegistry();
        expect((await fn(a, 'PROVIDER')).status, `${section} back on`).toBe(200);
      }
      // GET /account/profile needs ANY of PROFILE and LANGUAGE_REGION
      await setEnabled('PROFILE', 'PROVIDER', false);
      ok(await getProfile(a, 'PROVIDER'), OP.profile);
      await setEnabled('LANGUAGE_REGION', 'PROVIDER', false);
      notFound(await getProfile(a, 'PROVIDER'));
      ok(await getProfile(a, 'CUSTOMER'), OP.profile);
    } finally {
      await resetRegistry();
    }
  });

  it('a PLANNED section cannot be switched on by mistake (the matrix guard), so it is never offered', async () => {
    await expect(setEnabled('NOTIFICATIONS', 'CUSTOMER', true)).rejects.toMatchObject({ detail: 'identity_rule:SECTION_NOT_ACTIVE' });
    const a = await newActor('planned');
    expect(codesOf(ok(await nav(a), OP.nav))).not.toContain('NOTIFICATIONS');
  });
});

// ====================================================================== the registry's own filters
describe('the registry query filters on its own, even past the guard triggers (defense in depth)', () => {
  /** Runs `fn` with a trigger of the registry disabled by the table owner, and puts it back whatever happens. */
  async function withTriggerOff(table: string, trigger: string, fn: () => Promise<void>): Promise<void> {
    await q(`ALTER TABLE identity.${table} DISABLE TRIGGER ${trigger}`);
    try {
      await fn();
    } finally {
      await q(`ALTER TABLE identity.${table} ENABLE TRIGGER ${trigger}`);
    }
  }

  it('a section that is not ACTIVE is not offered and its endpoint is a 404, although a matrix row still enables it (crafted by disabling the guard trigger)', async () => {
    const a = await newActor('inactive-section');
    try {
      await withTriggerOff('account_sections', 'trg_account_sections__guard', async () => {
        await q(`UPDATE identity.account_sections SET status = 'INACTIVE' WHERE section_code = 'SECURITY'`);
      });
      expect(
        (
          await q<{ enabled: boolean }>(
            `SELECT enabled FROM identity.account_section_roles WHERE section_code = 'SECURITY' AND role_id = ${roleId('CUSTOMER')}`,
          )
        )[0]!.enabled,
      ).toBe(true);
      expect(codesOf(ok(await nav(a), OP.nav))).toEqual(SEEDED_CODES.filter((c) => c !== 'SECURITY'));
      notFound(await securitySummary(a));
    } finally {
      await withTriggerOff('account_sections', 'trg_account_sections__guard', async () => {
        await q(`UPDATE identity.account_sections SET status = 'ACTIVE' WHERE section_code = 'SECURITY'`);
      });
    }
    expect(codesOf(ok(await nav(a), OP.nav))).toEqual(SEEDED_CODES);
    ok(await securitySummary(a), OP.security);
  });

  it('an INACTIVE role has no sections even with enabled matrix rows; the same rows are served once the role is ACTIVE', async () => {
    await q(`INSERT INTO identity.roles (code, name_content_key, status) VALUES ('ITEST_INACTIVE', 'identity.role.customer.name', 'INACTIVE')`);
    await withTriggerOff('account_section_roles', 'trg_account_section_roles__guard', async () => {
      await q(
        `INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ('PROFILE', ${roleId('ITEST_INACTIVE')}, true, 10)`,
      );
    });
    const registry = new AccountAreaService({ database: bigDb });
    expect(await registry.sectionsOf('ITEST_INACTIVE')).toEqual([]);
    await q(`UPDATE identity.roles SET status = 'ACTIVE' WHERE code = 'ITEST_INACTIVE'`);
    expect((await registry.sectionsOf('ITEST_INACTIVE')).map((x) => x.code)).toEqual(['PROFILE']);
    // an unknown role, and no role, have none
    expect(await registry.sectionsOf('NO_SUCH_ROLE')).toEqual([]);
    expect(await registry.sectionsOf(null)).toEqual([]);
    // retiring the role again while the row is enabled is exactly what the role trigger refuses (ROLE_HAS_SECTIONS): craft the state with that one trigger off
    await withTriggerOff('roles', 'trg_roles__account_sections', async () => {
      await q(`UPDATE identity.roles SET status = 'INACTIVE' WHERE code = 'ITEST_INACTIVE'`);
    });
    expect(await registry.sectionsOf('ITEST_INACTIVE')).toEqual([]);
  });
});

// ====================================================================== PATCH field to section authorization
describe('PATCH /account/profile authorizes each field with its section', () => {
  it('LANGUAGE_REGION disabled for PROVIDER: the names can be patched as PROVIDER, the locale and time zone cannot (404, nothing written), while CUSTOMER patches everything with the same token', async () => {
    const a = await newActor('patch-auth');
    await grant(a, 'PROVIDER');
    ok(await put(a, { firstName: 'Ana', lastName: 'Martinez' }), OP.put);
    try {
      await setEnabled('LANGUAGE_REGION', 'PROVIDER', false);
      const before = await writes(a.accountId);
      expect(ok(await patch(a, { firstName: 'Bea' }, 'PROVIDER'), OP.patch).profile.firstName).toBe('Bea');
      const afterNames = await writes(a.accountId);
      expect(afterNames.audit).toBe(before.audit + 1);
      for (const body of [
        { timeZone: 'America/Chicago' },
        { preferredLocale: 'en-US' },
        { preferredLocale: null },
        { firstName: 'Cy', timeZone: 'America/Chicago' },
      ]) {
        notFound(await patch(a, body, 'PROVIDER'));
      }
      expect(await writes(a.accountId), 'a refused patch wrote nothing').toEqual(afterNames);
      expect((await profileRow(a.accountId))!.first_name).toBe('Bea');
      // PUT writes the locale and time zone too, so it needs both sections
      notFound(await put(a, { firstName: 'Dee', lastName: 'Martinez' }, 'PROVIDER'));
      expect(await writes(a.accountId)).toEqual(afterNames);
      // the same token acting as CUSTOMER may patch the time zone and replace the profile
      expect(ok(await patch(a, { timeZone: 'America/Chicago' }, 'CUSTOMER'), OP.patch)).toMatchObject({
        changed: true,
        profile: { timeZone: 'America/Chicago' },
      });
      ok(await put(a, { firstName: 'Dee', lastName: 'Martinez' }, 'CUSTOMER'), OP.put);
      // PROFILE disabled for PROVIDER (LANGUAGE_REGION back on): the other way round
      await resetRegistry();
      await setEnabled('PROFILE', 'PROVIDER', false);
      notFound(await patch(a, { lastName: 'Z' }, 'PROVIDER'));
      notFound(await patch(a, { firstName: 'Ann', timeZone: 'America/Denver' }, 'PROVIDER'));
      expect(ok(await patch(a, { timeZone: 'America/Denver' }, 'PROVIDER'), OP.patch).profile.timeZone).toBe('America/Denver');
      expect((await profileRow(a.accountId))!.last_name).toBe('Martinez');
    } finally {
      await resetRegistry();
    }
  });

  it('a strict body is a 400 BEFORE the section check, even for a role that would get a 404', async () => {
    const a = await newActor('patch-order');
    try {
      await setEnabled('PROFILE', 'CUSTOMER', false);
      await setEnabled('LANGUAGE_REGION', 'CUSTOMER', false);
      const before = await writes(a.accountId);
      fail(await patch(a, { accountId: randomUUID() }), 400, 'VALIDATION_FAILED');
      fail(await patch(a, {}), 400, 'VALIDATION_FAILED');
      notFound(await patch(a, { firstName: 'Ana' }));
      expect(await writes(a.accountId)).toEqual(before);
    } finally {
      await resetRegistry();
    }
  });
});

// ====================================================================== the partial profile update against PostgreSQL
describe('PATCH /account/profile writes', () => {
  it('creates the profile only from both names (PROFILE_REQUIRED otherwise), then changes only the present fields', async () => {
    const a = await newActor('patch-writes');
    const typed = 'Zq9Typed';
    secrets.names.push(typed);
    // nothing to change yet: a single name cannot create the row
    for (const body of [
      { firstName: typed },
      { lastName: typed },
      { timeZone: 'America/Chicago' },
      { preferredLocale: 'en-US' },
      { firstName: typed, timeZone: 'America/Chicago' },
    ]) {
      const r = await patch(a, body);
      const e = fail(r, 400, 'ACCOUNT_VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'PROFILE_REQUIRED' });
      expect(r.raw).not.toContain(typed);
    }
    expect(await profileRow(a.accountId)).toBeUndefined();
    expect(ok(await getProfile(a), OP.profile)).toEqual({ profile: null });

    // both names create it, with the locale and the zone when given
    const created = ok(await patch(a, { firstName: ` ${typed} `, lastName: 'martinez', timeZone: 'America/Chicago' }), OP.patch);
    expect(created).toEqual({
      changed: true,
      profile: {
        firstName: typed,
        lastName: 'martinez',
        preferredLocale: null,
        timeZone: 'America/Chicago',
        displayName: publicDisplayName(typed, 'martinez'),
      },
    });
    expect(created.profile.displayName).toBe(`${typed} M.`);
    expect(await profileAudit(a.accountId)).toHaveLength(1);

    // the locale only: names and zone stay
    expect(ok(await patch(a, { preferredLocale: 'es-US' }), OP.patch)).toMatchObject({
      changed: true,
      profile: { firstName: typed, lastName: 'martinez', preferredLocale: 'es-US', timeZone: 'America/Chicago' },
    });
    // a last name only
    expect(ok(await patch(a, { lastName: 'Garcia' }), OP.patch).profile).toMatchObject({
      firstName: typed,
      lastName: 'Garcia',
      preferredLocale: 'es-US',
      timeZone: 'America/Chicago',
    });
    // an idempotent repeat writes nothing
    const rowBefore = await profileRow(a.accountId);
    const auditBefore = (await profileAudit(a.accountId)).length;
    const repeat = ok(await patch(a, { lastName: 'Garcia', preferredLocale: 'es-US', timeZone: 'America/Chicago' }), OP.patch);
    expect(repeat.changed).toBe(false);
    expect((await profileRow(a.accountId))!.updated_at).toEqual(rowBefore!.updated_at);
    expect(await profileAudit(a.accountId)).toHaveLength(auditBefore);
    // a repeat whose raw text differs but normalizes to the stored value is unchanged too
    expect(ok(await patch(a, { firstName: `  ${typed}  ` }), OP.patch).changed).toBe(false);
    // null clears the optional values, one at a time
    expect(ok(await patch(a, { preferredLocale: null }), OP.patch).profile).toMatchObject({
      preferredLocale: null,
      timeZone: 'America/Chicago',
      firstName: typed,
    });
    expect(ok(await patch(a, { timeZone: null }), OP.patch).profile).toMatchObject({ preferredLocale: null, timeZone: null, lastName: 'Garcia' });
    expect(ok(await patch(a, { timeZone: null, preferredLocale: null }), OP.patch).changed, 'clearing what is already clear').toBe(false);
    expect(await profileRow(a.accountId)).toMatchObject({ first_name: typed, last_name: 'Garcia', preferred_locale: null, iana_name: null });

    // the audit rows name the changed FIELDS and never a value
    const audit = await profileAudit(a.accountId);
    expect(audit.map((r) => r.changes)).toEqual([
      { fields: ['firstName', 'lastName', 'timeZone'] },
      { fields: ['preferredLocale'] },
      { fields: ['lastName'] },
      { fields: ['preferredLocale'] },
      { fields: ['timeZone'] },
    ]);
    for (const r of audit) {
      expect(r.actor).toBe(`account:${a.accountId}`);
      expect(JSON.stringify(r)).not.toMatch(/Zq9|martinez|Garcia|es-US|Chicago/i);
    }
    expect(
      await count(`SELECT 1 FROM integration.outbox_events WHERE aggregate_id = $1 AND event_type LIKE '%profile%'`, [a.accountId]),
      'no event is published for a profile change',
    ).toBe(0);
  });

  it('GET /account/profile derives the display name on read and equals the profile of /account/me', async () => {
    const a = await newActor('profile-view');
    const accent = String.fromCodePoint(0xe9); // e with an acute accent
    ok(
      await patch(a, { firstName: 'Jos' + accent, lastName: accent + 'lodie de la Cruz', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' }),
      OP.patch,
    );
    const view = ok(await getProfile(a), OP.profile);
    expect(view.profile.displayName).toBe(`Jos${accent} ${accent.toUpperCase()}.`);
    expect(view.profile.displayName).not.toContain('Cruz');
    const { displayName: _d, ...stored } = view.profile;
    expect(ok(await me(a), OP.me).profile).toEqual(stored);
    expect(stored).toEqual({ firstName: `Jos${accent}`, lastName: `${accent}lodie de la Cruz`, preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' });
  });

  it('refuses invalid values with 400 and writes nothing: bad names, an unknown locale, an unknown time zone; the typed value is never echoed', async () => {
    const a = await newActor('patch-invalid');
    ok(await patch(a, { firstName: 'Ana', lastName: 'Martinez' }), OP.patch);
    const before = await writes(a.accountId);
    const typed = 'Zq9InvalidTyped';
    secrets.names.push(typed);
    const issue = async (body: unknown, issues: unknown[]) => {
      const r = await patch(a, body);
      const e = fail(r, 400, 'ACCOUNT_VALIDATION_FAILED');
      expect(e.details).toEqual({ reason: 'INVALID_PROFILE', issues });
      expect(r.raw).not.toContain(typed);
    };
    await issue({ firstName: '   ' }, [{ field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' }]);
    await issue({ lastName: typed + 'a'.repeat(60) }, [{ field: 'lastName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' }]);
    await issue({ firstName: typed + String.fromCharCode(7) }, [
      { field: 'firstName', code: 'INVALID_CHARACTERS', messageKey: 'account.error.name_invalid_characters' },
    ]);
    await issue({ firstName: '', lastName: typed + 'b'.repeat(60) }, [
      { field: 'firstName', code: 'REQUIRED', messageKey: 'account.error.name_required' },
      { field: 'lastName', code: 'TOO_LONG', messageKey: 'account.error.name_too_long' },
    ]);
    const locale = fail(await patch(a, { preferredLocale: 'fr-FR' }), 400, 'ACCOUNT_VALIDATION_FAILED');
    expect(locale.details).toEqual({ reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' });
    const zone = fail(await patch(a, { timeZone: 'Mars/Olympus_Mons' }), 400, 'ACCOUNT_VALIDATION_FAILED');
    expect(zone.details).toEqual({ reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
    // a valid change next to an invalid one writes neither
    fail(await patch(a, { firstName: 'Changed', timeZone: 'Mars/Olympus_Mons' }), 400, 'ACCOUNT_VALIDATION_FAILED');
    // shape errors are the standard validation envelope, with no value echoed
    for (const body of [
      {},
      { firstName: 1 },
      { firstName: null },
      { lastName: typed, accountId: randomUUID() },
      { preferredLocale: 'en_US' },
      { timeZone: typed + ' zone' },
      [],
      'text',
    ]) {
      const r = await patch(a, body);
      fail(r, 400, 'VALIDATION_FAILED');
      expect(r.raw).not.toContain(typed);
    }
    expect(await writes(a.accountId)).toEqual(before);
  });

  it('two concurrent patches of DIFFERENT fields both apply (the stored row is read FOR UPDATE), repeated with fresh accounts', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newActor(`patch-race-${round}`);
      ok(await patch(a, { firstName: 'Ana', lastName: 'Martinez' }), OP.patch);
      const results = await Promise.all([
        patch(a, { firstName: `Name${round}` }),
        patch(a, { lastName: `Last${round}` }),
        patch(a, { timeZone: 'America/Denver' }),
        patch(a, { preferredLocale: 'es-US' }),
      ]);
      for (const r of results) expect(ok(r, OP.patch).changed, `round ${round}`).toBe(true);
      expect(await profileRow(a.accountId), `round ${round}`).toMatchObject({
        first_name: `Name${round}`,
        last_name: `Last${round}`,
        iana_name: 'America/Denver',
        preferred_locale: 'es-US',
      });
      expect(await profileAudit(a.accountId)).toHaveLength(5);
    }
  });

  it('20 identical concurrent patches change the profile ONCE (one audit row), the rest are unchanged', async () => {
    const a = await newActor('patch-identical');
    ok(await patch(a, { firstName: 'Ana', lastName: 'Martinez' }), OP.patch);
    const results = await Promise.all(Array.from({ length: 20 }, () => patch(a, { timeZone: 'America/New_York', lastName: 'Perez' })));
    const changed = results.map((r) => ok(r, OP.patch).changed);
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await profileAudit(a.accountId)).toHaveLength(2);
  });

  it('PUT /account/profile still replaces the whole profile (omitted or null clears the locale and time zone) and PATCH leaves it consistent', async () => {
    const a = await newActor('put-still');
    const full = { firstName: 'Ana', lastName: 'Martinez', preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
    expect(ok(await put(a, full), OP.put).profile).toEqual(full);
    ok(await patch(a, { firstName: 'Bea' }), OP.patch);
    expect(ok(await put(a, { firstName: 'Cy', lastName: 'Lopez' }), OP.put).profile).toEqual({
      firstName: 'Cy',
      lastName: 'Lopez',
      preferredLocale: null,
      timeZone: null,
    });
    expect(ok(await put(a, { ...full, preferredLocale: null }), OP.put).profile).toEqual({ ...full, preferredLocale: null });
    const audit = await profileAudit(a.accountId);
    expect(audit.length).toBeGreaterThanOrEqual(4);
    fail(await put(a, { ...full, accountId: randomUUID() }), 400, 'VALIDATION_FAILED');
    fail(await put(a, { firstName: 'Only' }), 400, 'VALIDATION_FAILED');
  });
});

// ====================================================================== the composed sections
describe('contact verification, security summary, roles', () => {
  it('GET /account/contact-verification equals the email, phone and contacts of /account/me', async () => {
    const a = await newActor('contact');
    const section = ok(await contact(a), OP.contact);
    const account = ok(await me(a), OP.me);
    expect(section).toEqual({ email: account.email, phone: account.phone, contacts: account.contacts });
    expect(section.email).toEqual({ emailVerificationStatus: 'NONE', primary: null, pending: null });
    expect(section.phone).toEqual({ phoneVerificationStatus: 'NONE', primary: null, pending: null });
    expect(section.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    // the navigation carries the same derived summary
    expect(ok(await nav(a), OP.nav).contacts).toEqual(section.contacts);
  });

  it('GET /account/roles: switchableTo excludes the active role and follows the header', async () => {
    const a = await newActor('roles-section');
    expect(ok(await rolesSection(a), OP.roles)).toEqual({
      roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
      activeRole: 'CUSTOMER',
      primaryRole: 'CUSTOMER',
      switchableTo: [],
    });
    await grant(a, 'PROVIDER');
    const asCustomer = ok(await rolesSection(a, 'CUSTOMER'), OP.roles);
    expect(asCustomer.switchableTo).toEqual(['PROVIDER']);
    expect(asCustomer.roles.map((r: Json) => r.code).sort()).toEqual(['CUSTOMER', 'PROVIDER']);
    const asProvider = ok(await rolesSection(a, 'PROVIDER'), OP.roles);
    expect(asProvider).toMatchObject({ activeRole: 'PROVIDER', primaryRole: 'CUSTOMER', switchableTo: ['CUSTOMER'] });
    fail(await rolesSection(a, 'ADMIN'), 403, 'ACCOUNT_ROLE_NOT_HELD');
  });

  it('GET /account/security-summary: the real session count, the second factor from the identity provider, and the provider outage as available:false', async () => {
    const a = await newActor('security-summary');
    const second = await mint(a.sub);
    ok(await me(a, undefined, { as: second }), OP.me); // the second login registers its session on first sight
    const live = await count('SELECT 1 FROM identity.application_sessions WHERE account_id = $1 AND revoked_at IS NULL', [a.accountId]);
    expect(live).toBe(2);
    const summary = ok(await securitySummary(a), OP.security);
    expect(summary).toEqual({ mfa: { available: true, enabled: false }, activeSessionCount: 2, currentBrowserTrusted: false });
    expect(ok(await securitySummary(a, undefined, { as: second }), OP.security).activeSessionCount).toBe(2);
    provider.setUser(a.sub, { otpConfigured: true });
    expect(ok(await securitySummary(a), OP.security).mfa).toEqual({ available: true, enabled: true });
    provider.available = false;
    try {
      expect(ok(await securitySummary(a), OP.security).mfa).toEqual({ available: false, enabled: false });
    } finally {
      provider.available = true;
    }
    // a third session raises the count
    ok(await me(a, undefined, { as: await mint(a.sub) }), OP.me);
    expect(ok(await securitySummary(a), OP.security).activeSessionCount).toBe(3);
    // another person's sessions are never counted
    const other = await newActor('security-other');
    expect(ok(await securitySummary(other), OP.security).activeSessionCount).toBe(1);
    // no session id or secret in the body
    expect(Object.keys(summary).sort()).toEqual(['activeSessionCount', 'currentBrowserTrusted', 'mfa']);
  });
});

// ====================================================================== privacy summary
describe('GET /account/privacy matches the consent requirements', () => {
  it('counts outstanding agreements exactly as /account/consents/requirements does, through publication and acceptance, and carries no purpose, document or history', async () => {
    const a = await newActor('privacy');
    const agree = (req: Json) => ({
      locale: req.locale,
      satisfied: req.satisfied,
      outstandingCount: req.outstanding.length,
    });
    // nothing is published yet: both required purposes are outstanding (DOCUMENT_UNAVAILABLE)
    let req = ok(await requirements(a), OP.requirements);
    let summary = ok(await privacy(a), OP.privacy);
    expect(summary).toEqual({ consents: agree(req), dataDownload: { available: false } });
    expect(summary.consents).toEqual({ locale: 'en-US', satisfied: false, outstandingCount: 2 });

    const terms = await publishLegal(TERMS_KEY);
    const policy = await publishLegal(PRIVACY_KEY);
    req = ok(await requirements(a), OP.requirements);
    summary = ok(await privacy(a), OP.privacy);
    expect(summary.consents).toEqual(agree(req));
    expect(summary.consents.outstandingCount).toBe(2);

    expect(ok(await acceptDoc(a, TERMS, terms)).changed).toBe(true);
    req = ok(await requirements(a), OP.requirements);
    const raw = await privacy(a);
    summary = ok(raw, OP.privacy);
    expect(summary.consents).toEqual(agree(req));
    expect(summary.consents).toEqual({ locale: 'en-US', satisfied: false, outstandingCount: 1 });
    expect(req.outstanding).toEqual([PRIVACY]);

    expect(ok(await acceptDoc(a, PRIVACY, policy)).changed).toBe(true);
    req = ok(await requirements(a), OP.requirements);
    summary = ok(await privacy(a), OP.privacy);
    expect(summary.consents).toEqual(agree(req));
    expect(summary).toEqual({ consents: { locale: 'en-US', satisfied: true, outstandingCount: 0 }, dataDownload: { available: false } });

    // a NEW version of the terms makes the account outstanding again (REACCEPT_REQUIRED), and the summary follows
    await publishLegal(TERMS_KEY);
    req = ok(await requirements(a), OP.requirements);
    summary = ok(await privacy(a), OP.privacy);
    expect(summary.consents).toEqual(agree(req));
    expect(summary.consents).toEqual({ locale: 'en-US', satisfied: false, outstandingCount: 1 });

    // counts only: not a purpose code, a document, a hash, a version or an event, although the requirements response has them
    const text = (await privacy(a)).raw;
    for (const word of [
      TERMS,
      PRIVACY,
      'purposeCode',
      'document',
      'bodySha256',
      terms.hash,
      terms.versionId,
      policy.versionId,
      'versionId',
      'eventType',
      'outstanding"',
      'history',
      'legal.',
      'ITESTLEGALBODY',
    ])
      expect(text, word).not.toContain(word);
    expect(Object.keys(JSON.parse(text).data.consents).sort()).toEqual(['locale', 'outstandingCount', 'satisfied']);
  });
});

// ====================================================================== query budget
describe('the query budget of the navigation', () => {
  /** The SQL text of every statement a call runs, in order (the hook is on the application database; the test helpers use another pool). */
  async function statements(fn: () => Promise<Res>): Promise<{ res: Res; sql: string[] }> {
    queryLog = [];
    try {
      const res = await fn();
      await new Promise((r) => setTimeout(r, 25)); // a detached statement (last-seen touch) would show up here
      return { res, sql: queryLog.slice() };
    } finally {
      queryLog = null;
    }
  }
  const isRegistry = (s: string) => /account_section_roles|account_sections/.test(s);
  const isProfile = (s: string) => /account_profiles/.test(s);

  it('GET /account/navigation costs the account guard plus exactly ONE registry statement, and the count does not depend on the number of sections (no N+1)', async () => {
    const a = await newActor('budget');
    await grant(a, 'PROVIDER');
    // warm up: the first calls of a session may write (a first-seen session); the budget is the steady state
    for (let i = 0; i < 3; i++) await nav(a, 'CUSTOMER');
    const base = await statements(() => nav(a, 'CUSTOMER'));
    const again = await statements(() => nav(a, 'CUSTOMER'));
    expect(ok(base.res, OP.nav).sections).toHaveLength(6);
    expect(again.sql).toEqual(base.sql);
    expect(base.sql.filter(isRegistry), 'one registry read').toHaveLength(1);
    expect(base.sql.length, `the statements: ${JSON.stringify(base.sql)}`).toBe(EXPECTED_NAVIGATION_STATEMENTS);

    // the same request against /account/me (which reads the profile instead of the registry): the navigation adds exactly the ONE registry statement over the guard's reads
    const meCall = await statements(() => me(a, 'CUSTOMER'));
    ok(meCall.res, OP.me);
    expect(meCall.sql.filter(isProfile)).toHaveLength(1);
    expect(meCall.sql.filter(isRegistry)).toHaveLength(0);
    expect(base.sql.filter((s) => !isRegistry(s))).toEqual(meCall.sql.filter((s) => !isProfile(s)));
    expect(base.sql.length - meCall.sql.length, 'registry statement in, profile statement out').toBe(0);

    // 40 more sections for the role: the same number of statements and the same SQL text
    try {
      for (let i = 0; i < 40; i++) {
        const code = `EXTRA_${String(i).padStart(2, '0')}`;
        await q(
          `INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES ($1, $2, $3, $4, 'ACTIVE')`,
          [code, `/account/extra-${String(i).padStart(2, '0')}`, accountSectionLabelKey('PROFILE'), accountSectionDescriptionKey('PROFILE')],
        );
        await q(`INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order) VALUES ($1, ${roleId('CUSTOMER')}, true, $2)`, [
          code,
          100 + i,
        ]);
      }
      const big = await statements(() => nav(a, 'CUSTOMER'));
      const data = ok(big.res, OP.nav);
      expect(data.sections).toHaveLength(46);
      expect(codesOf(data).slice(0, 6)).toEqual(SEEDED_CODES);
      expect(big.sql, 'the registry grows, the statements do not').toEqual(base.sql);
      expect(big.sql.length).toBe(EXPECTED_NAVIGATION_STATEMENTS);
      // the guards cost the same too (one registry read per request, whatever the number of sections)
      const guarded = await statements(() => rolesSection(a, 'CUSTOMER'));
      ok(guarded.res, OP.roles);
      expect(guarded.sql.filter(isRegistry)).toHaveLength(1);
      expect(guarded.sql.length).toBe(EXPECTED_NAVIGATION_STATEMENTS);
      const patched = await statements(() => patch(a, { firstName: 'Ana', lastName: 'Martinez', timeZone: 'America/Chicago' }, 'CUSTOMER'));
      ok(patched.res, OP.patch);
      expect(patched.sql.filter(isRegistry), 'a PATCH that needs two sections still reads the registry once').toHaveLength(1);
      // PROVIDER sees none of the extras: its navigation is the six sections at the same cost
      const asProvider = await statements(() => nav(a, 'PROVIDER'));
      expect(codesOf(ok(asProvider.res, OP.nav))).toEqual(SEEDED_CODES);
      expect(asProvider.sql).toEqual(base.sql);
    } finally {
      await q(`UPDATE identity.account_section_roles SET enabled = false WHERE section_code LIKE 'EXTRA\\_%'`);
    }
    expect(codesOf(ok(await nav(a, 'CUSTOMER'), OP.nav))).toEqual(SEEDED_CODES);
  });

  it('a role-less account asks the registry nothing (no usable role)', async () => {
    const a = await newActor('budget-norole', { roles: [] });
    await nav(a);
    const s = await statements(() => nav(a));
    expect(ok(s.res, OP.nav).sections).toEqual([]);
    expect(s.sql.filter(isRegistry)).toHaveLength(0);
  });

  it('a refused section costs the guard and one registry read, and runs no handler statement', async () => {
    const a = await newActor('budget-refused');
    try {
      await setEnabled('PRIVACY_DATA', 'CUSTOMER', false);
      await privacy(a);
      const s = await statements(() => privacy(a));
      notFound(s.res);
      expect(s.sql.filter(isRegistry)).toHaveLength(1);
      expect(
        s.sql.filter((q2) => /consent/.test(q2)),
        'the consent layer was not asked',
      ).toHaveLength(0);
    } finally {
      await resetRegistry();
    }
  });
});

// ====================================================================== concurrency and caching
describe('20 parallel navigation calls', () => {
  it('are identical (same sections in the same order, same roles) and each carries its own correlation id', async () => {
    const a = await newActor('parallel');
    await grant(a, 'PROVIDER');
    for (const role of ['CUSTOMER', 'PROVIDER']) {
      const results = await Promise.all(Array.from({ length: 20 }, () => nav(a, role)));
      const bodies = results.map((r) => ok(r, OP.nav));
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      expect(new Set(results.map((r) => r.cid)).size).toBe(20);
      expect(codesOf(bodies[0])).toEqual(SEEDED_CODES);
    }
    // 20 callers of 20 different accounts do not see each other
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => newActor(`parallel-${i}`)));
    const answers = await Promise.all(people.map((p) => nav(p)));
    for (const r of answers) expect(ok(r, OP.nav).roles).toEqual([{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }]);
    expect(people.map((p) => p.accountId).length).toBe(new Set(people.map((p) => p.accountId)).size);
  });
});

// ====================================================================== secrecy and caching
describe('secrecy and caching over everything the file did', () => {
  it("privacy: no name, locale, email, phone, token or session id appears in a navigation or section response (only the profile responses carry the person's own names)", async () => {
    const a = await newActor('secrecy');
    const NAME = 'Zq9SecretFirst';
    const LAST = 'Zq9SecretLast';
    const EMAIL = 'zq9.secret@example.test';
    secrets.names.push(NAME, LAST);
    secrets.emails.push(EMAIL);
    provider.setUser(a.sub, { email: EMAIL, otpConfigured: true });
    ok(await patch(a, { firstName: NAME, lastName: LAST, preferredLocale: 'es-US', timeZone: 'America/Denver' }), OP.patch);
    const responses = [await nav(a), await contact(a), await rolesSection(a), await securitySummary(a), await privacy(a)];
    for (const r of responses) {
      ok(r);
      for (const word of [NAME, LAST, EMAIL, 'America/Denver', a.t0.token, a.t0.sid, a.sub, a.accountId, 'Bearer'])
        expect(r.raw, `${r.url} must not contain ${word}`).not.toContain(word);
      // the privacy summary names the locale the agreements were evaluated in (documented in its contract: the preferred locale when the person has one); no other response does
      if (!r.url.endsWith('/privacy')) expect(r.raw, r.url).not.toContain('es-US');
    }
    expect(responses[4]!.body.data.consents.locale).toBe('es-US');
    // the profile responses are the only place the person's own names are served
    expect(ok(await getProfile(a), OP.profile).profile.firstName).toBe(NAME);
  });

  it('every response of the file is no-store and carries a standard envelope; no token, session id or subject is in any body or header', () => {
    expect(transcript.length).toBeGreaterThan(200);
    for (const r of transcript.filter((t) => /\/api\/v1\/account\//.test(t.url))) {
      expect(r.headers['cache-control'], `${r.method} ${r.url} ${r.status}`).toBe('no-store');
    }
    const everything = transcript.map((r) => `${r.raw} ${JSON.stringify(r.headers)}`).join('\n');
    for (const token of secrets.tokens) expect(everything.includes(token), 'a token appeared in a response').toBe(false);
    for (const sid of secrets.sids) expect(everything.includes(sid), 'a session id appeared in a response').toBe(false);
    for (const sub of secrets.subjects) expect(everything.includes(sub), 'a subject appeared in a response').toBe(false);
  });

  it('captured logs hold no token, session id, subject, name, locale value or email', () => {
    expect(logLines.length, 'the log capture saw the requests (the request log line)').toBeGreaterThan(50);
    const logs = logLines.join('\n');
    for (const token of secrets.tokens) expect(logs.includes(token), 'a token was logged').toBe(false);
    for (const sid of secrets.sids) expect(logs.includes(sid), 'a session id was logged').toBe(false);
    for (const sub of secrets.subjects) expect(logs.includes(sub), 'a subject was logged').toBe(false);
    for (const name of secrets.names) expect(logs.includes(name), 'a typed name was logged').toBe(false);
    for (const email of secrets.emails) expect(logs.includes(email), 'an email was logged').toBe(false);
    for (const value of ['es-US', 'America/Denver', 'America/Chicago', 'Zq9']) expect(logs.includes(value), `${value} was logged`).toBe(false);
  });

  it('no audit row, outbox payload or table the file touched holds a typed name', async () => {
    const dump = JSON.stringify([
      await q('SELECT changes, reason, actor FROM identity.account_audit_events'),
      await q('SELECT payload_json FROM integration.outbox_events'),
    ]);
    for (const name of secrets.names) expect(dump.includes(name), name).toBe(false);
    for (const email of secrets.emails) expect(dump.includes(email), email).toBe(false);
  });
});
