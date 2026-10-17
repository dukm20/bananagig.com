// PRO-001 provider registration over HTTP, on the REAL stack wired the way apps/api/src/index.ts wires it: the real Fastify app (buildApp), the real AccountService, ConsentService (with
// the configuration-backed policy and the content-backed default locale), GeographyService, CatalogService, ContentService and ConfigurationService, the ProviderRegistrationService with
// the adapters of modules/provider/wiring.ts over them, the real auth plugin with forged-but-signed tokens, and one real, isolated PostgreSQL (migration 0018 seeds the five policy
// parameters; the legal documents are published through the REAL content workflow; the policy is changed through the REAL configuration change-request workflow). The unit layer
// (provider.test.ts) proves the HTTP edge with a fake service; this file proves the behaviour with the database.
//
// What it proves end to end for a customer-only account: GET (NONE) -> start (201, PENDING, the SAME account as /account/me, CUSTOMER kept) -> start again (200) -> the requirements by
// step -> the market refused until email and phone are verified -> the market (PLANNED and unknown refused, an ACTIVE one accepted, policy-driven changes) -> the service types (offered,
// not offered, duplicate, too many, none, bounds from configuration) -> submit refused while the agreements are outstanding -> consents accepted through the real consent service ->
// submit (ACTIVE, COMPLETED, idempotent, cancel refused) -> cancel and restart as a new attempt -> owner isolation -> audit rows and outbox events per step -> stale revisions ->
// races -> a secrecy scan over every response and log line -> a query-count budget of the two reads.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountService, ConsentService } from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ContentService, type CreateEntryInput } from '@bananagig/content';
import {
  CORRELATION_HEADER,
  ErrorResponse,
  ONBOARDING_STEPS,
  PROVIDER_EVENTS,
  PROVIDER_POLICY_KEYS,
  ProviderRegistrationStateResponse,
  ProviderRequirementsResponse,
  REGISTRATION_STEPS,
  categoryNameKey,
  providerErrorKey,
  serviceTypeNameKey,
} from '@bananagig/contracts';
import { CatalogService } from '@bananagig/catalog';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { ProviderRegistrationService, UnavailablePrerequisites } from '@bananagig/provider';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createMarketGate } from './modules/catalog/wiring';
import { createConsentPolicyProvider, createDefaultLocaleResolver } from './modules/consent/wiring';
import { createAccountPort, createCatalogPort, createConsentPort, createMarketPort, createProviderPolicyProvider } from './modules/provider/wiring';

// ---------------------------------------------------------------- the real stack
const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
const AUTHOR = 'author-a';
const APPROVER = 'approver-b';
const CFG_AUTHOR = 'cfg:author';
const CFG_APPROVER = 'cfg:approver';
const REASON = 'provider itest';
const TERMS = 'TERMS_OF_SERVICE';
const PRIVACY = 'PRIVACY_POLICY';
const LEGAL_MARK = 'ITESTLEGALBODY';

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let geography: GeographyService;
let catalog: CatalogService;
let consent: ConsentService;
/** Statements run by the database while this is set (the query-count budget). */
let capture: string[] | null = null;

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
/** Every response of the file, for the secrecy scan at the end. */
const transcript: Res[] = [];
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const keysOf = (o: object) => Object.keys(o).sort();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- actors and calls
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  email: string;
  phone: string;
  token: string;
}
const actors: Actor[] = [];
let phoneSeq = 0;
const tokenFor = (sub: string, claims: Record<string, unknown> = {}) =>
  signToken(keys, { claims: { sub, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...claims } });
const adminToken = () =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } },
    },
  });

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o: { as?: Actor | string | null; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const token = o.as === null || o.as === undefined ? undefined : typeof o.as === 'string' ? o.as : o.as.token;
  const cid = o.headers?.[CORRELATION_HEADER] ?? `itest-${randomUUID()}`;
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const r = await app.inject({
    method,
    url: url.startsWith('/api/') ? url : `/api/v1/provider${url}`,
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
  const res: Res = { method, url: url.startsWith('/api/') ? url : `/api/v1/provider${url}`, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}
const get = (a: Actor) => call('GET', '/registration', { as: a });
const reqs = (a: Actor, locale?: string) => call('GET', `/registration/requirements${locale === undefined ? '' : `?locale=${locale}`}`, { as: a });
const start = (a: Actor) => call('POST', '/registration', { as: a });
const putMarket = (a: Actor, marketCode: string, expectedRevision?: number) =>
  call('PUT', '/registration/market', { as: a, body: { marketCode, ...(expectedRevision === undefined ? {} : { expectedRevision }) } });
const putServices = (a: Actor, serviceTypeCodes: string[], expectedRevision?: number) =>
  call('PUT', '/registration/services', { as: a, body: { serviceTypeCodes, ...(expectedRevision === undefined ? {} : { expectedRevision }) } });
const submit = (a: Actor, expectedRevision: number) => call('POST', '/registration/submit', { as: a, body: { expectedRevision } });
const cancel = (a: Actor) => call('POST', '/registration/cancel', { as: a, body: {} });

/** A 2xx with the standard envelope; the data must equal its contract exactly (no field missing, none extra). */
const ok = (r: Res, status = 200, contract: 'state' | 'requirements' = 'state'): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(keysOf(r.body), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  const schema = contract === 'state' ? ProviderRegistrationStateResponse : ProviderRequirementsResponse;
  const parsed = schema.safeParse(r.body);
  expect(parsed.success, r.raw).toBe(true);
  if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), 'no field outside the contract').toEqual(r.body);
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, `${r.method} ${r.url}: ${r.raw}`).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  expect(r.headers['cache-control']).toBe('no-store');
  return r.body.error;
};
/** A provider failure: status, code, the fixed message key, and the details it may carry. */
const providerFail = (r: Res, status: number, code: string, details: Record<string, unknown> = {}): Json => {
  const e = fail(r, status, `PROVIDER_${code}`);
  expect(e.details, r.raw).toEqual({ ...details, messageKey: providerErrorKey(code as never) });
  return e;
};
const stepStatuses = (data: Json): Record<string, string> => Object.fromEntries(data.steps.map((s: Json) => [s.step, s.status]));
const stepOf = (data: Json, step: string): Json => data.steps.find((s: Json) => s.step === step);

async function newActor(label: string, o: { email?: boolean; phone?: boolean } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  const a: Actor = {
    label,
    sub,
    accountId: '',
    email: `sentinel.${label}.${randomUUID().slice(0, 8)}@sentinel-contact.example`,
    phone: `+1415555${String(1000 + ++phoneSeq)}`,
    token: await tokenFor(sub),
  };
  // the account is created by the first authenticated request, exactly as a real caller creates it
  const me = await call('GET', '/api/v1/account/me', { as: a });
  expect(me.status, me.raw).toBe(200);
  a.accountId = me.body.data.accountId;
  if (o.email) await verifyEmail(a);
  if (o.phone) await verifyPhone(a);
  actors.push(a);
  return a;
}
// the same SQL the account itests use to mark a contact verified (the verification services themselves are covered by ID-002/ID-003)
const verifyEmail = async (a: Actor) => {
  await q(`INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, 'PENDING', 'USER_ENTERED')`, [
    a.accountId,
    a.email,
  ]);
  await q(
    `UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
    [a.accountId],
  );
};
const verifyPhone = async (a: Actor) => {
  await q(`INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')`, [
    a.accountId,
    a.phone,
  ]);
  await q(
    `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
    [a.accountId],
  );
};
const verified = (label: string) => newActor(label, { email: true, phone: true });

// ---------------------------------------------------------------- the database views
const regRows = (accountId: string) =>
  q<{
    provider_registration_id: string;
    attempt_number: number;
    status: string;
    revision: number;
    market_code: string | null;
    completed_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `SELECT r.provider_registration_id, r.attempt_number, r.status, r.revision, m.code AS market_code, r.completed_at, r.cancelled_at
       FROM provider.registrations r LEFT JOIN geography.markets m ON m.market_id = r.market_id WHERE r.account_id = $1 ORDER BY r.attempt_number`,
    [accountId],
  );
const selectedCodes = async (registrationId: string): Promise<string[]> =>
  (
    await q<{ code: string }>(
      `SELECT st.code FROM provider.registration_service_types s JOIN catalog.service_types st ON st.service_type_id = s.service_type_id WHERE s.provider_registration_id = $1 ORDER BY st.code COLLATE "C"`,
      [registrationId],
    )
  ).map((r) => r.code);
const auditOf = (registrationId: string) =>
  q<{ action: string; actor: string; changes: Json; reason: string | null; correlation_id: string }>(
    `SELECT action, actor, changes, reason, correlation_id FROM provider.audit_events WHERE provider_registration_id = $1 ORDER BY occurred_at, audit_event_id`,
    [registrationId],
  );
const outboxOf = (registrationId: string) =>
  q<{ event_type: string; aggregate_type: string; actor_type: string; actor_id: string; payload_json: Json; correlation_id: string }>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, payload_json, correlation_id FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY created_at, outbox_event_id`,
    [registrationId],
  );
const rolesOf = (accountId: string) =>
  q<{ code: string; status: string }>(
    `SELECT r.code, m.status FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1 ORDER BY r.code`,
    [accountId],
  );
/** Counters of everything the provider domain writes, to prove a refused request changed nothing. */
const writes = async () => ({
  registrations: await count('SELECT 1 FROM provider.registrations'),
  selections: await count('SELECT 1 FROM provider.registration_service_types'),
  audit: await count('SELECT 1 FROM provider.audit_events'),
  outbox: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'`),
  roles: await count('SELECT 1 FROM identity.account_roles'),
  accounts: await count('SELECT 1 FROM identity.accounts'),
  revisions: (await q<{ s: string | null }>("SELECT string_agg(revision::text, ',' ORDER BY provider_registration_id) AS s FROM provider.registrations"))[0]!.s,
});

// ---------------------------------------------------------------- world: markets, catalogue, legal documents, configuration
const entryReq = (key: string, over: Partial<CreateEntryInput> = {}): CreateEntryInput => ({
  key,
  contentType: /\.name$/.test(key) ? 'UI_LABEL' : 'PLAIN_TEXT',
  ownerRole: 'CONTENT',
  description: 'provider itest entry',
  approvalPolicy: 'NONE',
  maxScopeType: 'MARKET',
  ...over,
});
async function publishText(key: string, body: string): Promise<void> {
  const v = await content.createVersion(key, { locale: 'en-US', scopeType: 'PLATFORM', scopeRef: null, body, reason: REASON }, AUTHOR);
  const submitted = await content.submit(v.versionId, AUTHOR);
  if (submitted.status === 'IN_REVIEW') await content.approve(v.versionId, APPROVER);
  await content.publish(v.versionId, AUTHOR);
}
async function copy(key: string, text: string): Promise<void> {
  await content.createEntry(entryReq(key), AUTHOR);
  await publishText(key, text);
}
let seq = 0;
const code = (prefix: string) => `devtest_${prefix}_${++seq}`;
async function market(name: string, state: 'PLANNED' | 'ACTIVE' | 'INACTIVE'): Promise<string> {
  const c = `devtest-pro-${name}`;
  await geography.createMarket(
    {
      code: c,
      name: 'Provider Test Market',
      countryCode: 'US',
      defaultLocale: 'en-US',
      currencyCode: 'USD',
      defaultTimeZone: 'America/Denver',
      reason: REASON,
    },
    AUTHOR,
  );
  if (state !== 'PLANNED') await geography.setMarketActive(c, true, 'activate for test', AUTHOR);
  if (state === 'INACTIVE') await geography.setMarketActive(c, false, 'retire for test', AUTHOR);
  return c;
}
async function category(status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): Promise<string> {
  const c = code('cat');
  await copy(categoryNameKey(c), `Category ${c}`);
  await catalog.createCategory({ code: c, withDescription: false, reason: REASON }, AUTHOR);
  if (status === 'ACTIVE') await catalog.setCategoryStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  return c;
}
async function serviceType(cat: string, status: 'ACTIVE' | 'DRAFT' | 'INACTIVE' = 'ACTIVE'): Promise<string> {
  const c = code('st');
  await copy(serviceTypeNameKey(c), `Service ${c}`);
  await catalog.createServiceType({ code: c, categoryCode: cat, reason: REASON }, AUTHOR);
  if (status !== 'DRAFT') await catalog.setServiceTypeStatus(c, { status: 'ACTIVE', reason: REASON }, AUTHOR);
  if (status === 'INACTIVE') await catalog.setServiceTypeStatus(c, { status: 'INACTIVE', reason: REASON }, AUTHOR);
  return c;
}
let order = 0;
const enableCategory = (m: string, c: string, enabled = true) =>
  catalog.setMarketCategoryAvailability(m, c, { enabled, displayOrder: ++order, reason: REASON }, AUTHOR);
const enableService = (m: string, c: string, enabled = true) =>
  catalog.setMarketServiceTypeAvailability(m, c, { enabled, displayOrder: ++order, reason: REASON }, AUTHOR);

// the world every scenario shares (built once)
const W = {} as {
  a: string; // ACTIVE market A
  b: string; // ACTIVE market B
  planned: string;
  inactive: string;
  stA: string; // offered in A and B
  stB: string; // offered in A only
  stC: string; // offered in B only
  stDraft: string; // DRAFT: never offered
  stInactive: string; // INACTIVE: never offered
  stDisabled: string; // ACTIVE but disabled in A
  stOffCat: string; // ACTIVE and enabled in A, but its CATEGORY is not enabled in A
  stOnly: string; // ACTIVE, offered nowhere
};

async function setConfig(key: string, value: unknown): Promise<void> {
  const cr = await configuration.createChangeRequest({ parameterKey: key, scopeType: 'PLATFORM', scopeRef: null, value, reason: 'itest change' }, CFG_AUTHOR);
  await configuration.submit(cr.changeRequestId, CFG_AUTHOR);
  await configuration.approve(cr.changeRequestId, CFG_APPROVER, 'ok');
  expect((await configuration.publish(cr.changeRequestId, CFG_AUTHOR)).state).toBe('ACTIVE');
}
const P = PROVIDER_POLICY_KEYS;
const DEFAULT_POLICY: Record<string, unknown> = {
  [P.requireVerifiedEmail]: true,
  [P.requireVerifiedPhone]: true,
  [P.marketStatusesAllowed]: ['ACTIVE'],
  [P.minServiceTypes]: 1,
  [P.maxServiceTypes]: 10,
};
const resetPolicy = async (only?: string[]) => {
  for (const [k, v] of Object.entries(DEFAULT_POLICY)) if (!only || only.includes(k)) await setConfig(k, v);
};

// legal documents through the REAL content workflow (a second approver publishes)
interface Doc {
  entryKey: string;
  versionId: string;
  locale: string;
  hash: string;
}
const published: Record<string, Doc> = {};
async function publishLegal(entryKey: string): Promise<void> {
  const created = await content.createVersion(
    entryKey,
    { locale: 'en-US', body: `${LEGAL_MARK} ${randomUUID()} body of ${entryKey}`, reason: REASON },
    'legal:author',
  );
  await content.submit(created.versionId, 'legal:author');
  await content.approve(created.versionId, 'legal:approver', 'ok');
  const v = await content.publish(created.versionId, 'legal:author');
  published[entryKey] = { entryKey, versionId: v.versionId, locale: v.locale, hash: v.bodySha256 };
}
/** Accepts the required agreements through the REAL consent service, with the version, locale and hash the requirements report. */
async function acceptAgreements(a: Actor, purposes: string[] = [TERMS, PRIVACY]): Promise<void> {
  const r = await consent.getRequirements(a.accountId, {});
  for (const p of purposes) {
    const row = r.requirements.find((x) => x.purposeCode === p)!;
    expect(row.document, `${p} has a published document`).not.toBeNull();
    await consent.accept(a.accountId, p, { versionId: row.document!.versionId, locale: row.document!.locale, bodySha256: row.document!.bodySha256 }, {});
  }
}

// ---------------------------------------------------------------- log capture
const logLines: string[] = [];
function captureLogs(): void {
  const grab = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab);
}

beforeAll(async () => {
  iso = await createIsolatedDatabase({ database: { onQuery: (e) => capture?.push(e.sql), overrides: { poolMax: 30, connectionTimeoutMs: 30_000 } } });
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const database = iso.database;
  geography = new GeographyService({ database, env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });
  content = new ContentService({
    database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography, { ttlMs: 60_000 }),
  });
  configuration = new ConfigurationService({ database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  catalog = new CatalogService({ database, markets: createMarketGate(geography), cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database, lastSeenTouchSeconds: 0 });
  consent = new ConsentService({ database, policy: createConsentPolicyProvider(configuration), defaultLocale: createDefaultLocaleResolver(content) });
  const providerRegistrations = new ProviderRegistrationService({
    database,
    accounts: createAccountPort(accounts),
    consent: createConsentPort(consent),
    markets: createMarketPort(geography),
    catalog: createCatalogPort(catalog),
    policy: createProviderPolicyProvider(configuration),
    prerequisites: UnavailablePrerequisites,
  });
  captureLogs();
  app = await buildApp({ cfg, verifier, configuration, content, geography, catalog, accounts, consent, providerRegistrations, readiness: async () => ({}) });
  await app.ready();

  // markets
  W.a = await market('a', 'ACTIVE');
  W.b = await market('b', 'ACTIVE');
  W.planned = await market('p', 'PLANNED');
  W.inactive = await market('i', 'INACTIVE');
  // catalogue
  const cat = await category();
  const cat2 = await category();
  W.stA = await serviceType(cat);
  W.stB = await serviceType(cat);
  W.stC = await serviceType(cat);
  W.stDraft = await serviceType(cat, 'DRAFT');
  W.stInactive = await serviceType(cat, 'INACTIVE');
  W.stDisabled = await serviceType(cat);
  W.stOffCat = await serviceType(cat2);
  W.stOnly = await serviceType(cat);
  for (const m of [W.a, W.b, W.planned]) await enableCategory(m, cat);
  await enableService(W.a, W.stA);
  await enableService(W.a, W.stB);
  await enableService(W.a, W.stDisabled, false);
  // the service type is enabled while its category is, then the category is switched off in the market: the service type must no longer be offered
  await enableCategory(W.a, cat2);
  await enableService(W.a, W.stOffCat);
  await enableCategory(W.a, cat2, false);
  await enableService(W.b, W.stA);
  await enableService(W.b, W.stC);
  await enableService(W.planned, W.stA);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});

// ====================================================================== the seeded state
describe('the seeded policy and copy of migration 0018', () => {
  it('serves the five parameters through the real registry with the documented defaults, and no registration exists', async () => {
    const values = (await configuration.resolveMany(Object.values(P))).values;
    expect(Object.fromEntries([...values].map(([k, v]) => [k, v.value]))).toEqual(DEFAULT_POLICY);
    expect(await count('SELECT 1 FROM provider.registrations')).toBe(0);
    expect(await count('SELECT 1 FROM provider.audit_events')).toBe(0);
  });
  it('the catalogue world offers exactly what the scenarios rely on', async () => {
    expect(await catalog.offeredServiceTypeCodes(W.a)).toEqual([W.stA, W.stB].sort());
    expect(await catalog.offeredServiceTypeCodes(W.b)).toEqual([W.stA, W.stC].sort());
    expect(await catalog.offeredServiceTypeCodes(W.planned)).toEqual([W.stA]);
    expect(await catalog.offeredServiceTypeCodes(W.inactive)).toEqual([]);
  });
});

// ====================================================================== the story of one customer-only account
const S = {} as { alice: Actor; regId: string; revision: number };

describe('before the account starts a registration', () => {
  it('creates the account with the first request and reads { NONE, null }; no provider row, no PROVIDER membership', async () => {
    S.alice = await newActor('alice');
    const me = await call('GET', '/api/v1/account/me', { as: S.alice });
    expect(me.body.data.accountId).toBe(S.alice.accountId);
    const data = ok(await get(S.alice));
    expect(data).toEqual({ providerRole: 'NONE', registration: null });
    expect(await rolesOf(S.alice.accountId)).toEqual([{ code: 'CUSTOMER', status: 'ACTIVE' }]);
    expect(await regRows(S.alice.accountId)).toEqual([]);
  });

  it('GET requirements for an account that never started: every step is derived, nothing is stored', async () => {
    const before = await writes();
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(data.providerRole).toBe('NONE');
    expect(data.registration).toBeNull();
    expect(data.steps.map((s: Json) => s.step)).toEqual([...ONBOARDING_STEPS]);
    expect(stepStatuses(data)).toEqual({
      ACCOUNT: 'NOT_STARTED',
      CONTACT: 'NOT_STARTED',
      LEGAL: 'NOT_STARTED', // no PENDING or ACTIVE provider role yet: no provider purpose applies
      MARKET: 'NOT_STARTED',
      SERVICES: 'NOT_STARTED',
      VERIFICATION: 'NOT_AVAILABLE',
      SUBSCRIPTION: 'NOT_AVAILABLE',
      PROFILE: 'NOT_AVAILABLE',
      GIGS: 'NOT_AVAILABLE',
    });
    expect(stepOf(data, 'CONTACT').detail).toEqual({ email: 'NOT_VERIFIED', phone: 'NOT_VERIFIED' });
    expect(data.overall).toEqual({
      registrationComplete: false,
      registrationReady: false,
      blockedBy: [...REGISTRATION_STEPS],
      goLive: { evaluated: false, eligible: false },
    });
    expect(await writes()).toEqual(before);
  });

  it('every step carries the content keys of its label and status (the web resolves the words)', async () => {
    const data = ok(await reqs(S.alice), 200, 'requirements');
    for (const s of data.steps) {
      expect(s.labelKey).toBe(`provider.registration.step.${s.step.toLowerCase()}.label`);
      expect(s.statusKey).toBe(`provider.registration.step_status.${s.status.toLowerCase()}`);
      const rows = await q('SELECT 1 FROM content.entries WHERE key = ANY($1)', [[s.labelKey, s.statusKey]]);
      expect(rows.length, `${s.labelKey} and ${s.statusKey} are seeded content`).toBe(2);
    }
  });

  it('market, services and submit refuse an account that never started; cancel finds nothing to cancel (404); nothing is written', async () => {
    const v = await verified('dave');
    const before = await writes();
    providerFail(await putMarket(v, W.a), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    providerFail(await putServices(v, [W.stA]), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    providerFail(await submit(v, 1), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    providerFail(await cancel(v), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    // the unverified account is refused at the contact prerequisite first (the PRD order: contacts before any other step)
    providerFail(await putMarket(S.alice, W.a), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    providerFail(await putServices(S.alice, [W.stA]), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    expect(await writes()).toEqual(before);
  });
});

describe('start', () => {
  it('POST /registration creates the attempt (201): the SAME account, role PENDING, CUSTOMER kept, one audit row and one outbox event', async () => {
    const accountsBefore = await count('SELECT 1 FROM identity.accounts');
    const r = await start(S.alice);
    const data = ok(r, 201);
    expect(data.providerRole).toBe('PENDING');
    expect(data.registration).toMatchObject({
      attempt: 1,
      status: 'IN_PROGRESS',
      revision: 1,
      marketCode: null,
      serviceTypeCodes: [],
      completedAt: null,
      cancelledAt: null,
    });
    S.regId = data.registration.providerRegistrationId;
    S.revision = 1;
    // the provider registration belongs to the account /account/me reports; no second account exists
    expect((await call('GET', '/api/v1/account/me', { as: S.alice })).body.data.accountId).toBe(S.alice.accountId);
    expect(await count('SELECT 1 FROM identity.accounts')).toBe(accountsBefore);
    expect((await regRows(S.alice.accountId)).map((x) => [x.provider_registration_id, x.attempt_number, x.status, x.revision])).toEqual([
      [S.regId, 1, 'IN_PROGRESS', 1],
    ]);
    expect(await rolesOf(S.alice.accountId)).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'PENDING' },
    ]);
    const audit = await auditOf(S.regId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'PROVIDER_REGISTRATION_STARTED', actor: `account:${S.alice.accountId}`, reason: null, correlation_id: r.cid });
    expect(audit[0]!.changes).toEqual({ attempt: [null, 1], providerRole: ['NONE', 'PENDING'] });
    const events = await outboxOf(S.regId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: PROVIDER_EVENTS.registrationStarted,
      aggregate_type: 'provider_registration',
      actor_type: 'user',
      actor_id: `account:${S.alice.accountId}`,
      correlation_id: r.cid,
    });
    expect(events[0]!.payload_json).toEqual({ accountId: S.alice.accountId, providerRegistrationId: S.regId, attempt: 1 });
  });

  it('GET /registration now reads the same registration; the response matches the database', async () => {
    const data = ok(await get(S.alice));
    expect(data.providerRole).toBe('PENDING');
    expect(data.registration.providerRegistrationId).toBe(S.regId);
    const [row] = await regRows(S.alice.accountId);
    expect(new Date(data.registration.createdAt).getTime()).toBeGreaterThan(0);
    expect(row).toMatchObject({ status: 'IN_PROGRESS', revision: 1, market_code: null });
  });

  it('POST /registration again resumes (200): the same registration, nothing written', async () => {
    const before = await writes();
    for (let i = 0; i < 3; i++) {
      const data = ok(await start(S.alice), 200);
      expect(data.registration.providerRegistrationId).toBe(S.regId);
      expect(data.providerRole).toBe('PENDING');
    }
    expect(await writes()).toEqual(before);
    expect(await auditOf(S.regId)).toHaveLength(1);
    expect(await outboxOf(S.regId)).toHaveLength(1);
  });

  it('five simultaneous starts of a fresh account create exactly ONE attempt: one 201 and four 200s, one audit row and one event', async () => {
    const a = await newActor('racer');
    const rs = await Promise.all([start(a), start(a), start(a), start(a), start(a)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(rs.map((r) => r.body.data.registration.providerRegistrationId));
    expect(ids.size).toBe(1);
    const rows = await regRows(a.accountId);
    expect(rows).toHaveLength(1);
    expect(await auditOf(rows[0]!.provider_registration_id)).toHaveLength(1);
    expect(await outboxOf(rows[0]!.provider_registration_id)).toHaveLength(1);
    expect(await rolesOf(a.accountId)).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'PENDING' },
    ]);
  });

  it('a PENDING provider can still use every registration route with x-active-role: PROVIDER (the real guard would refuse the role elsewhere: it is not ACTIVE yet)', async () => {
    const a = await newActor('pendinghdr');
    ok(await start(a), 201);
    const header = { 'x-active-role': 'PROVIDER' };
    // the account guard proper honours the header and refuses a role that is not ACTIVE
    fail(await call('GET', '/api/v1/account/me', { as: a, headers: header }), 403, 'ACCOUNT_ROLE_NOT_ACTIVE');
    for (const [m, u, b] of [
      ['GET', '/registration', undefined],
      ['POST', '/registration', undefined],
      ['GET', '/registration/requirements', undefined],
      ['POST', '/registration/cancel', {}],
    ] as const) {
      const r = await call(m, u, { as: a, headers: header, ...(b === undefined ? {} : { body: b }) });
      expect(r.status, `${m} ${u}: ${r.raw}`).toBeLessThan(300);
    }
    // an unknown role in the header is ignored as well
    ok(await call('GET', '/registration', { as: a, headers: { 'x-active-role': 'ADMIN' } }));
  });

  it('a bootstrap provider (an ACTIVE PROVIDER membership without a registration) keeps its ACTIVE role when it starts', async () => {
    const h = await newActor('hank');
    await accounts.grantRole(h.accountId, 'PROVIDER', { actor: 'system:itest', source: 'SYSTEM', reason: 'itest' });
    const data = ok(await start(h), 201);
    expect(data.providerRole).toBe('ACTIVE');
    expect((await rolesOf(h.accountId)).find((r) => r.code === 'PROVIDER')!.status).toBe('ACTIVE');
    const audit = await auditOf(data.registration.providerRegistrationId);
    expect(audit[0]!.changes.providerRole).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('a deactivated provider role is not reactivated by a self-service start: 409 PROVIDER_ROLE_INACTIVE, nothing written', async () => {
    const g = await newActor('gina');
    await accounts.grantRole(g.accountId, 'PROVIDER', { actor: 'system:itest', source: 'SYSTEM', reason: 'itest' });
    await accounts.deactivateRole(g.accountId, 'PROVIDER', { actor: 'system:itest', reason: 'itest' });
    const before = await writes();
    providerFail(await start(g), 409, 'ROLE_INACTIVE', { reason: 'ROLE_INACTIVE' });
    expect(await writes()).toEqual(before);
    expect((await rolesOf(g.accountId)).find((r) => r.code === 'PROVIDER')!.status).toBe('INACTIVE');
    expect(ok(await get(g))).toEqual({ providerRole: 'INACTIVE', registration: null });
  });
});

describe('requirements of a started registration and the contact prerequisite', () => {
  it('ACCOUNT is complete, CONTACT not started, LEGAL blocked (the agreements are not published yet), MARKET and SERVICES not started; nothing is ready', async () => {
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepStatuses(data)).toEqual({
      ACCOUNT: 'COMPLETE',
      CONTACT: 'NOT_STARTED',
      LEGAL: 'BLOCKED',
      MARKET: 'NOT_STARTED',
      SERVICES: 'NOT_STARTED',
      VERIFICATION: 'NOT_AVAILABLE',
      SUBSCRIPTION: 'NOT_AVAILABLE',
      PROFILE: 'NOT_AVAILABLE',
      GIGS: 'NOT_AVAILABLE',
    });
    expect(stepOf(data, 'SERVICES').detail).toEqual({ selected: 0, min: 1, max: 10 });
    expect(stepOf(data, 'LEGAL').detail).toEqual({ outstandingPurposes: [PRIVACY, TERMS] });
    expect(data.overall).toEqual({
      registrationComplete: false,
      registrationReady: false,
      blockedBy: [...REGISTRATION_STEPS].filter((s) => s !== 'ACCOUNT'),
      goLive: { evaluated: false, eligible: false },
    });
    expect(data.providerRole).toBe('PENDING');
  });

  it('PUT market is refused 409 PROVIDER_PREREQUISITE_NOT_MET until BOTH email and phone are verified; nothing changes', async () => {
    const before = await writes();
    providerFail(await putMarket(S.alice, W.a), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    await verifyEmail(S.alice);
    let data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'CONTACT')).toMatchObject({ status: 'IN_PROGRESS', detail: { email: 'VERIFIED', phone: 'NOT_VERIFIED' } });
    providerFail(await putMarket(S.alice, W.a), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    providerFail(await putServices(S.alice, [W.stA]), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    expect(await writes()).toEqual(before);
    await verifyPhone(S.alice);
    data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'CONTACT')).toMatchObject({ status: 'COMPLETE', detail: { email: 'VERIFIED', phone: 'VERIFIED' } });
  });

  it('the contact requirement is configuration: with phone not required, an email alone passes (and the step says so); restored afterwards', async () => {
    const e = await newActor('emailonly', { email: true });
    ok(await start(e), 201);
    providerFail(await putMarket(e, W.a), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
    await setConfig(P.requireVerifiedPhone, false);
    try {
      const data = ok(await reqs(e), 200, 'requirements');
      expect(stepOf(data, 'CONTACT')).toMatchObject({ status: 'COMPLETE', detail: { email: 'VERIFIED', phone: 'NOT_REQUIRED' } });
      ok(await putMarket(e, W.a));
      await setConfig(P.requireVerifiedEmail, false);
      const none = await newActor('nocontact');
      ok(await start(none), 201);
      const d2 = ok(await reqs(none), 200, 'requirements');
      expect(stepOf(d2, 'CONTACT')).toMatchObject({ status: 'NOT_REQUIRED', detail: { email: 'NOT_REQUIRED', phone: 'NOT_REQUIRED' } });
      ok(await putMarket(none, W.a));
    } finally {
      await resetPolicy([P.requireVerifiedEmail, P.requireVerifiedPhone]);
    }
    providerFail(await putMarket(await newActor('strict'), W.b), 409, 'PREREQUISITE_NOT_MET', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
  });
});

describe('market', () => {
  it('a PLANNED market (la-oc and a devtest one), an INACTIVE one and an unknown one are refused 400 PROVIDER_MARKET_NOT_ELIGIBLE with no detail; nothing changes', async () => {
    const before = await writes();
    for (const m of ['la-oc', W.planned, W.inactive, 'zz-nowhere']) {
      const e = providerFail(await putMarket(S.alice, m), 400, 'MARKET_NOT_ELIGIBLE', { reason: 'MARKET_NOT_ELIGIBLE' });
      expect(e.category).toBe('VALIDATION');
      expect(JSON.stringify(e), 'the answer does not tell a missing market from a closed one').not.toContain(m);
    }
    expect(await writes()).toEqual(before);
  });

  it('an ACTIVE market in effect is accepted: revision 2, one MARKET_SELECTED audit row, no outbox event; the same market again changes nothing', async () => {
    const eventsBefore = await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'`);
    const r = await putMarket(S.alice, W.a);
    const data = ok(r);
    expect(data.registration).toMatchObject({ marketCode: W.a, revision: 2, status: 'IN_PROGRESS', serviceTypeCodes: [] });
    S.revision = 2;
    const audit = await auditOf(S.regId);
    expect(audit.map((x) => x.action)).toEqual(['PROVIDER_REGISTRATION_STARTED', 'PROVIDER_MARKET_SELECTED']);
    expect(audit[1]).toMatchObject({ actor: `account:${S.alice.accountId}`, correlation_id: r.cid });
    expect(audit[1]!.changes).toEqual({ market: [null, W.a], revision: [1, 2] });
    expect(await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'`)).toBe(eventsBefore);
    const before = await writes();
    expect(ok(await putMarket(S.alice, W.a)).registration.revision).toBe(2);
    expect(ok(await putMarket(S.alice, W.a, 2)).registration.revision).toBe(2);
    expect(await writes()).toEqual(before);
  });

  it('a stale expectedRevision is 409 PROVIDER_STALE_REGISTRATION and writes nothing; the current one is accepted', async () => {
    const before = await writes();
    for (const stale of [1, 3, 99]) providerFail(await putMarket(S.alice, W.b, stale), 409, 'STALE_REGISTRATION', { reason: 'STALE_REGISTRATION' });
    expect(await writes()).toEqual(before);
    const data = ok(await putMarket(S.alice, W.b, 2));
    expect(data.registration).toMatchObject({ marketCode: W.b, revision: 3 });
    ok(await putMarket(S.alice, W.a, 3));
    S.revision = 4;
    expect((await regRows(S.alice.accountId))[0]).toMatchObject({ market_code: W.a, revision: 4 });
  });

  it('the MARKET step is complete with the market code only', async () => {
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'MARKET')).toEqual({
      step: 'MARKET',
      status: 'COMPLETE',
      owner: 'PRO-001',
      labelKey: 'provider.registration.step.market.label',
      statusKey: 'provider.registration.step_status.complete',
      detail: { marketCode: W.a },
    });
  });

  it('the allowed statuses are configuration: with PLANNED allowed a planned market is accepted; when the policy is restored the stored choice becomes BLOCKED and services are refused', async () => {
    const p = await verified('planner');
    ok(await start(p), 201);
    providerFail(await putMarket(p, W.planned), 400, 'MARKET_NOT_ELIGIBLE', { reason: 'MARKET_NOT_ELIGIBLE' });
    await setConfig(P.marketStatusesAllowed, ['ACTIVE', 'PLANNED']);
    try {
      const data = ok(await putMarket(p, W.planned));
      expect(data.registration.marketCode).toBe(W.planned);
      ok(await putServices(p, [W.stA]));
      expect(stepOf(ok(await reqs(p), 200, 'requirements'), 'MARKET').status).toBe('COMPLETE');
    } finally {
      await resetPolicy([P.marketStatusesAllowed]);
    }
    const data = ok(await reqs(p), 200, 'requirements');
    expect(stepOf(data, 'MARKET')).toMatchObject({ status: 'BLOCKED', detail: { marketCode: W.planned } });
    expect(data.overall.registrationReady).toBe(false);
    providerFail(await putServices(p, [W.stA]), 400, 'MARKET_NOT_ELIGIBLE', { reason: 'MARKET_NOT_ELIGIBLE' });
    providerFail(await submit(p, data.registration.revision), 409, 'REGISTRATION_INCOMPLETE', {
      reason: 'REGISTRATION_INCOMPLETE',
      steps: expect.arrayContaining(['MARKET']),
    } as never);
    // the provider fixes it by choosing an ACTIVE market
    ok(await putMarket(p, W.a));
  });

  it('an ACTIVE market outside its effective window (already ended, or not started yet) is refused', async () => {
    const day = 24 * 3600 * 1000;
    const windowed = async (name: string, from: Date, to: Date | null): Promise<string> => {
      const c = `devtest-pro-${name}`;
      await geography.createMarket(
        {
          code: c,
          name: 'Windowed Test Market',
          countryCode: 'US',
          defaultLocale: 'en-US',
          currencyCode: 'USD',
          defaultTimeZone: 'America/Denver',
          effectiveFrom: from.toISOString(),
          ...(to ? { effectiveTo: to.toISOString() } : {}),
          reason: REASON,
        },
        AUTHOR,
      );
      await geography.setMarketActive(c, true, 'activate for test', AUTHOR);
      return c;
    };
    const ended = await windowed('ended', new Date(Date.now() - 2 * day), new Date(Date.now() - day));
    const future = await windowed('future', new Date(Date.now() + day), null);
    const current = await windowed('current', new Date(Date.now() - day), new Date(Date.now() + day));
    const p = await verified('window');
    ok(await start(p), 201);
    for (const m of [ended, future]) providerFail(await putMarket(p, m), 400, 'MARKET_NOT_ELIGIBLE', { reason: 'MARKET_NOT_ELIGIBLE' });
    expect(ok(await putMarket(p, current)).registration.marketCode).toBe(current);
  });
});

describe('service types', () => {
  it('MARKET_REQUIRED before a market is chosen (409), nothing written', async () => {
    const m = await verified('nomarket');
    ok(await start(m), 201);
    const before = await writes();
    providerFail(await putServices(m, [W.stA]), 409, 'MARKET_REQUIRED', { reason: 'MARKET_REQUIRED' });
    expect(await writes()).toEqual(before);
  });

  it('an offered set is saved sorted, bumps the revision once, writes ONE audit row with the added codes; the same set again (any order) writes nothing', async () => {
    const r = await putServices(S.alice, [W.stB, W.stA]);
    const data = ok(r);
    expect(data.registration.serviceTypeCodes).toEqual([W.stA, W.stB].sort());
    expect(data.registration.revision).toBe(5);
    S.revision = 5;
    expect(await selectedCodes(S.regId)).toEqual([W.stA, W.stB].sort());
    const audit = await auditOf(S.regId);
    const last = audit[audit.length - 1]!;
    expect(last).toMatchObject({ action: 'PROVIDER_SERVICES_UPDATED', correlation_id: r.cid, actor: `account:${S.alice.accountId}` });
    expect(last.changes).toEqual({ added: [W.stA, W.stB].sort(), removed: [], count: [0, 2], revision: [4, 5] });
    const before = await writes();
    expect(ok(await putServices(S.alice, [W.stA, W.stB])).registration.revision).toBe(5);
    expect(ok(await putServices(S.alice, [W.stB, W.stA], 5)).registration.revision).toBe(5);
    expect(await writes()).toEqual(before);
  });

  it('a replacement records exactly what was added and removed', async () => {
    const r = await putServices(S.alice, [W.stA]);
    expect(ok(r).registration).toMatchObject({ serviceTypeCodes: [W.stA], revision: 6 });
    const audit = await auditOf(S.regId);
    expect(audit[audit.length - 1]!.changes).toEqual({ added: [], removed: [W.stB], count: [2, 1], revision: [5, 6] });
    expect(await selectedCodes(S.regId)).toEqual([W.stA]);
    S.revision = 6;
  });

  it('a code the market does not offer is refused 400 PROVIDER_SERVICE_TYPE_NOT_ELIGIBLE naming the codes, whatever the reason; nothing changes', async () => {
    const before = await writes();
    for (const c of [W.stC, W.stDraft, W.stInactive, W.stDisabled, W.stOffCat, W.stOnly]) {
      const e = providerFail(await putServices(S.alice, [W.stA, c]), 400, 'SERVICE_TYPE_NOT_ELIGIBLE', { reason: 'SERVICE_TYPE_NOT_ELIGIBLE', codes: [c] });
      expect(e.category).toBe('VALIDATION');
    }
    providerFail(await putServices(S.alice, ['devtest_not_in_catalogue']), 400, 'SERVICE_TYPE_NOT_ELIGIBLE', {
      reason: 'SERVICE_TYPE_NOT_ELIGIBLE',
      codes: ['devtest_not_in_catalogue'],
    });
    // every ineligible code is listed (sorted), the eligible ones are not
    const many = providerFail(await putServices(S.alice, [W.stC, W.stA, W.stDraft]), 400, 'SERVICE_TYPE_NOT_ELIGIBLE', {
      reason: 'SERVICE_TYPE_NOT_ELIGIBLE',
      codes: [W.stC, W.stDraft].sort(),
    });
    expect(many.details.codes).not.toContain(W.stA);
    expect(await writes()).toEqual(before);
  });

  it('a duplicate code, more than 50 codes, a malformed code and a wrong type are 400 VALIDATION_FAILED before the service; nothing changes', async () => {
    const before = await writes();
    const codes51 = Array.from({ length: 51 }, (_, i) => `service_${String(i).padStart(2, '0')}`);
    for (const body of [
      { serviceTypeCodes: [W.stA, W.stA] },
      { serviceTypeCodes: codes51 },
      { serviceTypeCodes: ['Bad Code'] },
      { serviceTypeCodes: 'x' },
      {},
      { serviceTypeCodes: [W.stA], extra: 1 },
    ]) {
      const r = await call('PUT', '/registration/services', { as: S.alice, body });
      fail(r, 400, 'VALIDATION_FAILED');
    }
    expect(await writes()).toEqual(before);
  });

  it('none selected is 400 PROVIDER_SERVICE_COUNT_OUT_OF_RANGE carrying the configured bounds; so is more than the configured maximum', async () => {
    const before = await writes();
    providerFail(await putServices(S.alice, []), 400, 'SERVICE_COUNT_OUT_OF_RANGE', { reason: 'SERVICE_COUNT_OUT_OF_RANGE', min: 1, max: 10 });
    await setConfig(P.maxServiceTypes, 1);
    try {
      providerFail(await putServices(S.alice, [W.stA, W.stB]), 400, 'SERVICE_COUNT_OUT_OF_RANGE', { reason: 'SERVICE_COUNT_OUT_OF_RANGE', min: 1, max: 1 });
      // within the new maximum
      expect(ok(await putServices(S.alice, [W.stB])).registration.serviceTypeCodes).toEqual([W.stB]);
      ok(await putServices(S.alice, [W.stA]));
    } finally {
      await resetPolicy([P.maxServiceTypes]);
    }
    await setConfig(P.minServiceTypes, 2);
    try {
      providerFail(await putServices(S.alice, [W.stA]), 400, 'SERVICE_COUNT_OUT_OF_RANGE', { reason: 'SERVICE_COUNT_OUT_OF_RANGE', min: 2, max: 10 });
    } finally {
      await resetPolicy([P.minServiceTypes]);
    }
    // the revision grew only for the two accepted writes above (stB then stA)
    expect((await regRows(S.alice.accountId))[0]!.revision).toBe(S.revision + 2);
    S.revision += 2;
    expect(before.registrations).toBe(await count('SELECT 1 FROM provider.registrations'));
  });

  it('a minimum of 0 makes the step NOT_REQUIRED while nothing is selected, and an empty set is accepted', async () => {
    const z = await verified('zero');
    ok(await start(z), 201);
    ok(await putMarket(z, W.a));
    await setConfig(P.minServiceTypes, 0);
    try {
      const d = ok(await reqs(z), 200, 'requirements');
      expect(stepOf(d, 'SERVICES')).toMatchObject({ status: 'NOT_REQUIRED', detail: { selected: 0, min: 0, max: 10 } });
      const empty = ok(await putServices(z, []));
      expect(empty.registration.serviceTypeCodes).toEqual([]);
    } finally {
      await resetPolicy([P.minServiceTypes]);
    }
    expect(stepOf(ok(await reqs(z), 200, 'requirements'), 'SERVICES').status).toBe('NOT_STARTED');
  });

  it('a stale expectedRevision is 409 STALE_REGISTRATION and writes nothing', async () => {
    const before = await writes();
    providerFail(await putServices(S.alice, [W.stA, W.stB], S.revision - 1), 409, 'STALE_REGISTRATION', { reason: 'STALE_REGISTRATION' });
    expect(await writes()).toEqual(before);
    expect(ok(await putServices(S.alice, [W.stA, W.stB], S.revision)).registration.revision).toBe(S.revision + 1);
    S.revision += 1;
  });

  it('changing the market keeps the selection and the requirements report what the new market does not offer; the provider fixes it with a new set', async () => {
    const data = ok(await putMarket(S.alice, W.b));
    S.revision += 1;
    expect(data.registration).toMatchObject({ marketCode: W.b, serviceTypeCodes: [W.stA, W.stB].sort() });
    const r = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(r, 'SERVICES')).toMatchObject({ status: 'BLOCKED', detail: { selected: 2, min: 1, max: 10, notOffered: [W.stB] } });
    expect(stepOf(r, 'MARKET').status).toBe('COMPLETE');
    expect(r.overall.registrationReady).toBe(false);
    expect(r.overall.blockedBy).toContain('SERVICES');
    // SQL still holds the old selection (history of the draft is the audit trail)
    expect(await selectedCodes(S.regId)).toEqual([W.stA, W.stB].sort());
    ok(await putServices(S.alice, [W.stA, W.stC]));
    S.revision += 1;
    const fixed = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(fixed, 'SERVICES')).toMatchObject({ status: 'COMPLETE', detail: { selected: 2 } });
    expect(stepOf(fixed, 'SERVICES').detail.notOffered).toBeUndefined();
  });

  it('a service type deactivated after it was selected is reported BLOCKED and refuses a later submit', async () => {
    const v = await verified('retired');
    ok(await start(v), 201);
    ok(await putMarket(v, W.a));
    const cat = await category();
    const st = await serviceType(cat);
    await enableCategory(W.a, cat);
    await enableService(W.a, st);
    ok(await putServices(v, [st]));
    await catalog.setServiceTypeStatus(st, { status: 'INACTIVE', reason: REASON }, AUTHOR);
    const data = ok(await reqs(v), 200, 'requirements');
    expect(stepOf(data, 'SERVICES')).toMatchObject({ status: 'BLOCKED', detail: { notOffered: [st] } });
    providerFail(await putServices(v, [st]), 400, 'SERVICE_TYPE_NOT_ELIGIBLE', { reason: 'SERVICE_TYPE_NOT_ELIGIBLE', codes: [st] });
  });
});

describe('submit', () => {
  it('is refused 409 PROVIDER_REGISTRATION_INCOMPLETE while the agreements are not published (LEGAL blocked); nothing changes', async () => {
    const before = await writes();
    const rev = S.revision;
    providerFail(await submit(S.alice, rev), 409, 'REGISTRATION_INCOMPLETE', { reason: 'REGISTRATION_INCOMPLETE', steps: ['LEGAL'] });
    expect(await writes()).toEqual(before);
    expect((await regRows(S.alice.accountId))[0]).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
    expect((await rolesOf(S.alice.accountId)).find((r) => r.code === 'PROVIDER')!.status).toBe('PENDING');
  });

  it('once Legal publishes, the agreements are NOT_STARTED with the outstanding purposes; submit still names only LEGAL', async () => {
    await publishLegal('legal.terms_of_service');
    await publishLegal('legal.privacy_policy');
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'LEGAL')).toMatchObject({ status: 'NOT_STARTED', detail: { outstandingPurposes: [PRIVACY, TERMS] } });
    providerFail(await submit(S.alice, S.revision), 409, 'REGISTRATION_INCOMPLETE', { reason: 'REGISTRATION_INCOMPLETE', steps: ['LEGAL'] });
  });

  it('one of two agreements accepted is IN_PROGRESS with only the missing purpose outstanding', async () => {
    await acceptAgreements(S.alice, [TERMS]);
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'LEGAL')).toMatchObject({ status: 'IN_PROGRESS', detail: { outstandingPurposes: [PRIVACY] } });
    providerFail(await submit(S.alice, S.revision), 409, 'REGISTRATION_INCOMPLETE', { reason: 'REGISTRATION_INCOMPLETE', steps: ['LEGAL'] });
  });

  it('a stale revision is refused 409 STALE_REGISTRATION before anything else; a missing or malformed revision is a 400', async () => {
    const before = await writes();
    providerFail(await submit(S.alice, S.revision - 1), 409, 'STALE_REGISTRATION', { reason: 'STALE_REGISTRATION' });
    fail(await call('POST', '/registration/submit', { as: S.alice, body: {} }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', '/registration/submit', { as: S.alice }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', '/registration/submit', { as: S.alice, body: { expectedRevision: '1' } }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', '/registration/submit', { as: S.alice, body: { expectedRevision: S.revision, completed: true } }), 400, 'VALIDATION_FAILED');
    expect(await writes()).toEqual(before);
  });

  it('with every agreement accepted through the consent service the registration is ready; the requirements say so and Go-Live is still not evaluated', async () => {
    await acceptAgreements(S.alice, [PRIVACY]);
    const data = ok(await reqs(S.alice), 200, 'requirements');
    expect(stepOf(data, 'LEGAL').status).toBe('COMPLETE');
    expect(stepStatuses(data)).toMatchObject({ ACCOUNT: 'COMPLETE', CONTACT: 'COMPLETE', LEGAL: 'COMPLETE', MARKET: 'COMPLETE', SERVICES: 'COMPLETE' });
    expect(data.overall).toEqual({ registrationComplete: false, registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
    for (const s of ['VERIFICATION', 'SUBSCRIPTION', 'PROFILE', 'GIGS']) expect(stepOf(data, s).status).toBe('NOT_AVAILABLE');
  });

  it('a withdrawn-then-missing agreement after it was ready blocks the submit again (the evaluation is fresh, not cached)', async () => {
    // a NEW legal version under REACCEPT_REQUIRED makes the account outstanding again
    await publishLegal('legal.privacy_policy');
    providerFail(await submit(S.alice, S.revision), 409, 'REGISTRATION_INCOMPLETE', { reason: 'REGISTRATION_INCOMPLETE', steps: ['LEGAL'] });
    await acceptAgreements(S.alice, [PRIVACY]);
    expect(ok(await reqs(S.alice), 200, 'requirements').overall.registrationReady).toBe(true);
  });

  it('submit completes it: 200, COMPLETED, role ACTIVE, CUSTOMER kept, one audit row, one event with the market and the codes; Go-Live is not claimed', async () => {
    const r = await submit(S.alice, S.revision);
    const data = ok(r, 200, 'requirements');
    expect(data.providerRole).toBe('ACTIVE');
    expect(data.registration).toMatchObject({
      providerRegistrationId: S.regId,
      status: 'COMPLETED',
      marketCode: W.b,
      serviceTypeCodes: [W.stA, W.stC].sort(),
      revision: S.revision,
    });
    expect(data.registration.completedAt).not.toBeNull();
    expect(data.overall).toEqual({ registrationComplete: true, registrationReady: true, blockedBy: [], goLive: { evaluated: false, eligible: false } });
    const rows = await regRows(S.alice.accountId);
    expect(rows[0]).toMatchObject({ status: 'COMPLETED', market_code: W.b, revision: S.revision });
    expect(rows[0]!.completed_at).toBeInstanceOf(Date);
    expect(rows[0]!.cancelled_at).toBeNull();
    expect(await rolesOf(S.alice.accountId)).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'ACTIVE' },
    ]);
    const audit = await auditOf(S.regId);
    const last = audit[audit.length - 1]!;
    expect(last).toMatchObject({ action: 'PROVIDER_REGISTRATION_COMPLETED', actor: `account:${S.alice.accountId}`, correlation_id: r.cid });
    expect(last.changes).toEqual({ status: ['IN_PROGRESS', 'COMPLETED'], providerRole: ['PENDING', 'ACTIVE'], market: W.b, serviceTypes: 2 });
    const events = await outboxOf(S.regId);
    expect(events.map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted, PROVIDER_EVENTS.registrationCompleted]);
    expect(events[1]!.payload_json).toEqual({
      accountId: S.alice.accountId,
      providerRegistrationId: S.regId,
      attempt: 1,
      marketCode: W.b,
      serviceTypeCodes: [W.stA, W.stC].sort(),
    });
    expect(events[1]).toMatchObject({ aggregate_type: 'provider_registration', actor_id: `account:${S.alice.accountId}`, correlation_id: r.cid });
    // the role change is the identity domain's own audit trail, written in the same transaction
    expect(
      await count(`SELECT 1 FROM identity.account_audit_events WHERE account_id = $1 AND correlation_id = $2`, [S.alice.accountId, r.cid]),
    ).toBeGreaterThan(0);
  });

  it('a second submit is idempotent (200): the same completion, nothing written; even a stale revision reads the completed registration', async () => {
    const before = await writes();
    const auditBefore = (await auditOf(S.regId)).length;
    const first = (await regRows(S.alice.accountId))[0]!;
    for (const rev of [S.revision, S.revision, 1]) {
      const data = ok(await submit(S.alice, rev), 200, 'requirements');
      expect(data.registration.status).toBe('COMPLETED');
      expect(data.providerRole).toBe('ACTIVE');
      expect(data.overall.registrationComplete).toBe(true);
    }
    expect(await writes()).toEqual(before);
    expect((await regRows(S.alice.accountId))[0]!.completed_at).toEqual(first.completed_at);
    expect(await auditOf(S.regId)).toHaveLength(auditBefore);
  });

  it('after completion the registration is frozen: market, services and cancel are 409 PROVIDER_REGISTRATION_NOT_IN_PROGRESS; start returns it unchanged (200)', async () => {
    const before = await writes();
    providerFail(await putMarket(S.alice, W.a), 409, 'REGISTRATION_NOT_IN_PROGRESS', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
    providerFail(await putServices(S.alice, [W.stA]), 409, 'REGISTRATION_NOT_IN_PROGRESS', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
    providerFail(await cancel(S.alice), 409, 'REGISTRATION_NOT_IN_PROGRESS', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
    const again = ok(await start(S.alice), 200);
    expect(again.registration).toMatchObject({ providerRegistrationId: S.regId, status: 'COMPLETED', attempt: 1 });
    expect(again.providerRole).toBe('ACTIVE');
    expect(await writes()).toEqual(before);
    expect(ok(await get(S.alice))).toMatchObject({ providerRole: 'ACTIVE', registration: { status: 'COMPLETED' } });
  });

  it('after completion the account may act as a provider (x-active-role: PROVIDER is accepted by the account guard) and the registration routes still ignore the header', async () => {
    const me = await call('GET', '/api/v1/account/me', { as: S.alice, headers: { 'x-active-role': 'PROVIDER' } });
    expect(me.status, me.raw).toBe(200);
    expect(me.body.data.activeRole ?? 'PROVIDER').toBe('PROVIDER');
    ok(await call('GET', '/registration', { as: S.alice, headers: { 'x-active-role': 'PROVIDER' } }));
  });
});

describe('the agreements are configuration: nothing required means nothing to accept', () => {
  it('with no role requiring any agreement the LEGAL step is NOT_REQUIRED, the registration is ready and a submit passes without any acceptance; restored afterwards', async () => {
    const n = await verified('nolegal');
    ok(await start(n), 201);
    ok(await putMarket(n, W.a));
    const s = ok(await putServices(n, [W.stA]));
    const requiredFor = (p: string) => `consent.${p.toLowerCase()}.required_for`;
    providerFail(await submit(n, s.registration.revision), 409, 'REGISTRATION_INCOMPLETE', { reason: 'REGISTRATION_INCOMPLETE', steps: ['LEGAL'] });
    await setConfig(requiredFor(TERMS), []);
    await setConfig(requiredFor(PRIVACY), []);
    try {
      const data = ok(await reqs(n), 200, 'requirements');
      expect(stepOf(data, 'LEGAL').status).toBe('NOT_REQUIRED');
      expect(data.overall).toMatchObject({ registrationReady: true, blockedBy: [] });
      const done = ok(await submit(n, s.registration.revision), 200, 'requirements');
      expect(done.registration.status).toBe('COMPLETED');
      expect(done.providerRole).toBe('ACTIVE');
    } finally {
      await setConfig(requiredFor(TERMS), ['CUSTOMER', 'PROVIDER']);
      await setConfig(requiredFor(PRIVACY), ['CUSTOMER', 'PROVIDER']);
    }
  });
});

describe('cancel and restart', () => {
  const T = {} as { bob: Actor; first: string; second: string };

  it('cancels an IN_PROGRESS registration: 200 CANCELLED, the account, CUSTOMER role and PENDING PROVIDER role untouched, one audit row WITHOUT a reason, one event', async () => {
    T.bob = await verified('bob');
    T.first = ok(await start(T.bob), 201).registration.providerRegistrationId;
    ok(await putMarket(T.bob, W.a));
    ok(await putServices(T.bob, [W.stA]));
    const r = await cancel(T.bob);
    const data = ok(r);
    expect(data.providerRole).toBe('PENDING');
    expect(data.registration).toMatchObject({ providerRegistrationId: T.first, status: 'CANCELLED', marketCode: W.a, serviceTypeCodes: [W.stA], attempt: 1 });
    expect(data.registration.cancelledAt).not.toBeNull();
    expect(data.registration.completedAt).toBeNull();
    expect(await rolesOf(T.bob.accountId)).toEqual([
      { code: 'CUSTOMER', status: 'ACTIVE' },
      { code: 'PROVIDER', status: 'PENDING' },
    ]);
    const audit = await auditOf(T.first);
    expect(audit[audit.length - 1]).toMatchObject({
      action: 'PROVIDER_REGISTRATION_CANCELLED',
      reason: null,
      actor: `account:${T.bob.accountId}`,
      correlation_id: r.cid,
    });
    expect(audit[audit.length - 1]!.changes).toEqual({ status: ['IN_PROGRESS', 'CANCELLED'] });
    const events = await outboxOf(T.first);
    expect(events.map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted, PROVIDER_EVENTS.registrationCancelled]);
    expect(events[1]!.payload_json).toEqual({ accountId: T.bob.accountId, providerRegistrationId: T.first, attempt: 1 });
  });

  it('cancelling again is idempotent (200, nothing written); a reason, blank or not, is a 400', async () => {
    const before = await writes();
    const data = ok(await cancel(T.bob));
    expect(data.registration).toMatchObject({ providerRegistrationId: T.first, status: 'CANCELLED' });
    expect(await writes()).toEqual(before);
    fail(await call('POST', '/registration/cancel', { as: T.bob, body: { reason: '   ' } }), 400, 'VALIDATION_FAILED');
    fail(await call('POST', '/registration/cancel', { as: T.bob, body: { accountId: T.bob.accountId } }), 400, 'VALIDATION_FAILED');
  });

  it('after a cancellation: GET shows the cancelled attempt, the steps read as not started, market, services and submit find no live registration (404)', async () => {
    const g = ok(await get(T.bob));
    expect(g.registration).toMatchObject({ providerRegistrationId: T.first, status: 'CANCELLED' });
    const data = ok(await reqs(T.bob), 200, 'requirements');
    expect(stepStatuses(data)).toMatchObject({ ACCOUNT: 'NOT_STARTED', MARKET: 'NOT_STARTED', SERVICES: 'NOT_STARTED' });
    expect(data.overall.registrationComplete).toBe(false);
    const before = await writes();
    providerFail(await putMarket(T.bob, W.a), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    providerFail(await putServices(T.bob, [W.stA]), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    providerFail(await submit(T.bob, 3), 404, 'REGISTRATION_NOT_FOUND', { reason: 'REGISTRATION_NOT_FOUND' });
    expect(await writes()).toEqual(before);
  });

  it('a restart is a NEW attempt (201, attempt 2, revision 1, nothing carried over); the cancelled attempt and its selection stay as history; the PENDING role is not re-requested', async () => {
    const r = await start(T.bob);
    const data = ok(r, 201);
    T.second = data.registration.providerRegistrationId;
    expect(T.second).not.toBe(T.first);
    expect(data.registration).toMatchObject({ attempt: 2, status: 'IN_PROGRESS', revision: 1, marketCode: null, serviceTypeCodes: [] });
    expect(data.providerRole).toBe('PENDING');
    const rows = await regRows(T.bob.accountId);
    expect(rows.map((x) => [x.attempt_number, x.status])).toEqual([
      [1, 'CANCELLED'],
      [2, 'IN_PROGRESS'],
    ]);
    expect(await selectedCodes(T.first)).toEqual([W.stA]);
    expect(await selectedCodes(T.second)).toEqual([]);
    expect(await count('SELECT 1 FROM identity.account_roles WHERE account_id = $1', [T.bob.accountId])).toBe(2);
    const audit = await auditOf(T.second);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toEqual({ attempt: [null, 2], providerRole: ['PENDING', 'PENDING'] });
    expect(ok(await get(T.bob)).registration.providerRegistrationId).toBe(T.second);
  });

  it('the restarted attempt completes like any other (agreements accepted once are reused: nothing is entered twice), with its own audit trail', async () => {
    await acceptAgreements(T.bob);
    ok(await putMarket(T.bob, W.a));
    const s = ok(await putServices(T.bob, [W.stA, W.stB]));
    const data = ok(await submit(T.bob, s.registration.revision), 200, 'requirements');
    expect(data.registration).toMatchObject({ providerRegistrationId: T.second, status: 'COMPLETED', attempt: 2 });
    expect(data.providerRole).toBe('ACTIVE');
    expect((await outboxOf(T.second)).map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted, PROVIDER_EVENTS.registrationCompleted]);
    expect((await outboxOf(T.first)).map((e) => e.event_type)).toEqual([PROVIDER_EVENTS.registrationStarted, PROVIDER_EVENTS.registrationCancelled]);
    // a completed account cannot cancel, and a restart is the same completed registration
    providerFail(await cancel(T.bob), 409, 'REGISTRATION_NOT_IN_PROGRESS', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
    expect(ok(await start(T.bob), 200).registration.providerRegistrationId).toBe(T.second);
  });
});

describe('cancel takes no input', () => {
  it('a free-text reason is a 400 VALIDATION_FAILED, never echoed and never stored (the audit trail is immutable): the registration stays IN_PROGRESS and nothing is written', async () => {
    const carol = await verified('cancel-reason');
    const id = ok(await start(carol), 201).registration.providerRegistrationId;
    const before = await writes();
    for (const body of [{ reason: 'Moving to Canberra-Secret-9X' }, { reason: '' }, { reason: null }, { reason: 7 }, { note: 'Canberra-Secret-9X' }]) {
      const r = await call('POST', '/registration/cancel', { as: carol, body });
      fail(r, 400, 'VALIDATION_FAILED');
      expect(r.raw).not.toContain('Canberra-Secret-9X');
    }
    const raw = await call('POST', '/registration/cancel', { as: carol, rawBody: '{"reason":"Canberra-Secret-9X"}' });
    fail(raw, 400, 'VALIDATION_FAILED');
    expect(raw.raw).not.toContain('Canberra-Secret-9X');
    expect(await writes()).toEqual(before);
    expect((await regRows(carol.accountId))[0]!.status).toBe('IN_PROGRESS');
    // the real cancel stores no reason at all, and the refused text is nowhere in the database
    ok(await cancel(carol));
    expect((await auditOf(id)).map((a) => [a.action, a.reason])).toEqual([
      ['PROVIDER_REGISTRATION_STARTED', null],
      ['PROVIDER_REGISTRATION_CANCELLED', null],
    ]);
    expect(await count('SELECT 1 FROM provider.audit_events WHERE reason IS NOT NULL')).toBe(0);
    expect(await count(`SELECT 1 FROM provider.audit_events a WHERE a::text LIKE '%Canberra-Secret%'`)).toBe(0);
    expect(await count(`SELECT 1 FROM integration.outbox_events e WHERE e::text LIKE '%Canberra-Secret%'`)).toBe(0);
  });

  it.each([
    ['no body at all (no content type either)', undefined],
    ['a JSON null body', 'null'],
    ['an empty JSON object', '{}'],
  ] as const)('%s cancels like any other: 200 CANCELLED, one audit row without a reason', async (label, rawBody) => {
    const a = await verified(
      `cancel-${label
        .replace(/[^a-z]+/gi, '')
        .toLowerCase()
        .slice(0, 12)}`,
    );
    const id = ok(await start(a), 201).registration.providerRegistrationId;
    const r = await call('POST', '/registration/cancel', { as: a, ...(rawBody === undefined ? {} : { rawBody }) });
    const data = ok(r);
    expect(data.registration).toMatchObject({ providerRegistrationId: id, status: 'CANCELLED' });
    expect((await auditOf(id)).at(-1)).toMatchObject({ action: 'PROVIDER_REGISTRATION_CANCELLED', reason: null, correlation_id: r.cid });
    // and the repeat is the idempotent answer for every variant
    expect(ok(await call('POST', '/registration/cancel', { as: a, ...(rawBody === undefined ? {} : { rawBody }) })).registration.status).toBe('CANCELLED');
  });
});

describe('owner isolation', () => {
  it('two accounts never see or touch each other: every read and write is about the account of the token', async () => {
    const x = await verified('iso-x');
    const y = await verified('iso-y');
    const xr = ok(await start(x), 201).registration.providerRegistrationId;
    const yr = ok(await start(y), 201).registration.providerRegistrationId;
    expect(xr).not.toBe(yr);
    ok(await putMarket(x, W.a));
    ok(await putServices(x, [W.stA]));
    // y's view does not contain x's registration, market or codes
    const yGet = await get(y);
    const yReq = await reqs(y);
    for (const r of [yGet, yReq]) {
      expect(r.raw).not.toContain(xr);
      expect(r.raw).not.toContain(x.accountId);
    }
    expect(ok(yGet).registration).toMatchObject({ providerRegistrationId: yr, marketCode: null, serviceTypeCodes: [] });
    // y cannot change x: even naming x's ids everywhere a client could
    const hostile = await call('PUT', '/registration/market', {
      as: y,
      body: { marketCode: W.b, expectedRevision: 1 },
      headers: { 'x-account-id': x.accountId, 'x-provider-registration-id': xr },
    });
    ok(hostile);
    expect((await regRows(x.accountId))[0]).toMatchObject({ market_code: W.a });
    expect((await regRows(y.accountId))[0]).toMatchObject({ market_code: W.b });
    fail(await call('PUT', '/registration/market', { as: y, body: { marketCode: W.b, accountId: x.accountId } }), 400, 'VALIDATION_FAILED');
    // a cancel by y cancels y's attempt only
    ok(await cancel(y));
    expect((await regRows(x.accountId))[0]!.status).toBe('IN_PROGRESS');
    expect((await regRows(y.accountId))[0]!.status).toBe('CANCELLED');
    // an account that never started sees nothing of anyone
    const z = await newActor('iso-z');
    expect(ok(await get(z))).toEqual({ providerRole: 'NONE', registration: null });
  });

  it('the admin identity context has no application account: 403 on every operation, and nothing is written', async () => {
    const before = await writes();
    const t = await adminToken();
    for (const [m, u, b] of [
      ['GET', '/registration', undefined],
      ['POST', '/registration', undefined],
      ['PUT', '/registration/market', { marketCode: W.a }],
      ['PUT', '/registration/services', { serviceTypeCodes: [W.stA] }],
      ['GET', '/registration/requirements', undefined],
      ['POST', '/registration/submit', { expectedRevision: 1 }],
      ['POST', '/registration/cancel', {}],
    ] as const) {
      const r = await call(m, u, { as: t, ...(b === undefined ? {} : { body: b }) });
      expect(fail(r, 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED').category).toBe('AUTHORIZATION');
    }
    expect(await writes()).toEqual(before);
    const anon = await call('GET', '/registration');
    expect(anon.status).toBe(401);
  });

  it('a suspended account is refused 403 ACCOUNT_SUSPENDED on every operation by the account guard, and a closed one 403 ACCOUNT_CLOSED; nothing is written', async () => {
    const s = await verified('suspended');
    ok(await start(s), 201);
    await accounts.changeStatus(s.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    const before = await writes();
    for (const [m, u, b] of [
      ['GET', '/registration', undefined],
      ['POST', '/registration', undefined],
      ['PUT', '/registration/market', { marketCode: W.a }],
      ['PUT', '/registration/services', { serviceTypeCodes: [W.stA] }],
      ['GET', '/registration/requirements', undefined],
      ['POST', '/registration/submit', { expectedRevision: 1 }],
      ['POST', '/registration/cancel', {}],
    ] as const)
      fail(await call(m, u, { as: s, ...(b === undefined ? {} : { body: b }) }), 403, 'ACCOUNT_SUSPENDED');
    expect(await writes()).toEqual(before);
    await accounts.changeStatus(s.accountId, 'ACTIVE', { actor: 'system:itest', reason: 'itest' });
    ok(await get(s));
    await accounts.changeStatus(s.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'itest' });
    await accounts.changeStatus(s.accountId, 'CLOSED', { actor: 'system:itest', reason: 'itest' });
    fail(await get(s), 403, 'ACCOUNT_CLOSED');
    fail(await start(s), 403, 'ACCOUNT_CLOSED');
  });
});

describe('races', () => {
  it('two simultaneous submits of a ready registration complete it ONCE: both 200, one audit row, one event', async () => {
    const r = await verified('submitrace');
    ok(await start(r), 201);
    ok(await putMarket(r, W.a));
    const s = ok(await putServices(r, [W.stA]));
    await acceptAgreements(r);
    const rs = await Promise.all([submit(r, s.registration.revision), submit(r, s.registration.revision), submit(r, s.registration.revision)]);
    expect(
      rs.map((x) => x.status),
      rs.map((x) => x.raw).join('\n'),
    ).toEqual([200, 200, 200]);
    const id = (await regRows(r.accountId))[0]!.provider_registration_id;
    expect((await auditOf(id)).filter((a) => a.action === 'PROVIDER_REGISTRATION_COMPLETED')).toHaveLength(1);
    expect((await outboxOf(id)).filter((e) => e.event_type === PROVIDER_EVENTS.registrationCompleted)).toHaveLength(1);
    expect((await rolesOf(r.accountId)).find((x) => x.code === 'PROVIDER')!.status).toBe('ACTIVE');
  });

  it('a submit racing a cancel: exactly one wins and the loser is a clean refusal (never a 500, never a half-written state)', async () => {
    const r = await verified('cancelrace');
    ok(await start(r), 201);
    ok(await putMarket(r, W.a));
    const s = ok(await putServices(r, [W.stA]));
    await acceptAgreements(r);
    const [sub, can] = await Promise.all([submit(r, s.registration.revision), cancel(r)]);
    const row = (await regRows(r.accountId))[0]!;
    expect([sub.status, can.status], `${sub.raw} ${can.raw}`).not.toContain(500);
    if (row.status === 'COMPLETED') {
      expect(sub.status).toBe(200);
      expect(can.status).toBe(409);
      expect(row.cancelled_at).toBeNull();
    } else {
      expect(row.status).toBe('CANCELLED');
      expect(can.status).toBe(200);
      expect(sub.status).toBe(404);
      expect(row.completed_at).toBeNull();
      expect((await rolesOf(r.accountId)).find((x) => x.code === 'PROVIDER')!.status).toBe('PENDING');
    }
  });

  it('simultaneous market changes with the same expectedRevision: exactly one wins, the others are 409 STALE_REGISTRATION', async () => {
    const r = await verified('marketrace');
    const rev = ok(await start(r), 201).registration.revision;
    const rs = await Promise.all([putMarket(r, W.a, rev), putMarket(r, W.b, rev), putMarket(r, W.a, rev), putMarket(r, W.b, rev)]);
    const statuses = rs.map((x) => x.status).sort();
    expect(statuses.filter((x) => x === 200).length, rs.map((x) => x.raw).join('\n')).toBeGreaterThanOrEqual(1);
    for (const x of rs.filter((y) => y.status !== 200)) providerFail(x, 409, 'STALE_REGISTRATION', { reason: 'STALE_REGISTRATION' });
    const row = (await regRows(r.accountId))[0]!;
    // the winners that chose the SAME market as the first are idempotent repeats; revisions never skip
    expect(row.revision).toBe(rev + 1);
    expect(
      await count(`SELECT 1 FROM provider.audit_events WHERE provider_registration_id = $1 AND action = 'PROVIDER_MARKET_SELECTED'`, [
        row.provider_registration_id,
      ]),
    ).toBe(1);
  });
});

// ====================================================================== audit and events as a whole
describe('audit and outbox as a whole', () => {
  it("Alice's trail reads as the story: started, market x3, services x6.., completed, in order, every row by her account with the request correlation id", async () => {
    const audit = await auditOf(S.regId);
    expect(audit[0]!.action).toBe('PROVIDER_REGISTRATION_STARTED');
    expect(audit[audit.length - 1]!.action).toBe('PROVIDER_REGISTRATION_COMPLETED');
    for (const a of audit) {
      expect(a.actor).toBe(`account:${S.alice.accountId}`);
      expect(a.correlation_id).toMatch(/^itest-/);
      expect(['PROVIDER_REGISTRATION_STARTED', 'PROVIDER_MARKET_SELECTED', 'PROVIDER_SERVICES_UPDATED', 'PROVIDER_REGISTRATION_COMPLETED']).toContain(a.action);
    }
    // no contact, name or document appears in a change set
    const blob = JSON.stringify(audit.map((a) => a.changes));
    expect(blob).not.toContain(S.alice.email);
    expect(blob).not.toContain(S.alice.phone);
    expect(blob).not.toContain(LEGAL_MARK);
  });

  it('every provider event of the file carries identifiers and codes only', async () => {
    const rows = await q<{ event_type: string; payload_json: Json }>(
      `SELECT event_type, payload_json FROM integration.outbox_events WHERE event_type LIKE 'bananagig.provider.%'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      const allowed =
        r.event_type === PROVIDER_EVENTS.registrationCompleted
          ? ['accountId', 'attempt', 'marketCode', 'providerRegistrationId', 'serviceTypeCodes']
          : ['accountId', 'attempt', 'providerRegistrationId'];
      expect(keysOf(r.payload_json), r.event_type).toEqual(allowed);
    }
    expect(Object.values(PROVIDER_EVENTS)).toEqual(expect.arrayContaining([...new Set(rows.map((r) => r.event_type))]));
  });

  it('a read or a refused call never writes an audit row or an event', async () => {
    const before = await writes();
    for (const a of actors.slice(0, 5)) {
      await get(a);
      await reqs(a);
      await putMarket(a, 'zz-nowhere');
    }
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== secrecy
describe('secrecy: no contact, legal text or token in any response, log line or provider row', () => {
  it('no provider response ever contains an email, a phone number, a legal text or a subject', () => {
    const mine = transcript.filter((t) => t.url.includes('/api/v1/provider'));
    expect(mine.length).toBeGreaterThan(150);
    for (const t of mine) {
      for (const a of actors) {
        expect(t.raw, `${t.method} ${t.url}`).not.toContain(a.email);
        expect(t.raw).not.toContain(a.email.split('@')[0]);
        expect(t.raw).not.toContain(a.phone);
        expect(t.raw).not.toContain(a.phone.slice(1));
        expect(t.raw).not.toContain(a.sub);
      }
      expect(t.raw).not.toContain(LEGAL_MARK);
      expect(t.raw).not.toMatch(/Bearer |eyJ[A-Za-z0-9_-]{10}/);
    }
  });

  it('every error answer is the standard envelope with a fixed message and no stack, SQL or table name', () => {
    const errors = transcript.filter((t) => t.url.includes('/api/v1/provider') && t.status >= 400);
    expect(errors.length).toBeGreaterThan(40);
    for (const t of errors) {
      expect(ErrorResponse.safeParse(t.body).success, t.raw).toBe(true);
      expect(t.raw).not.toMatch(/SELECT |INSERT |UPDATE |provider\.registrations|provider_rule|23000|at \S+\.ts:\d+|node_modules/);
    }
  });

  it('every provider response is Cache-Control: no-store', () => {
    for (const t of transcript.filter((x) => x.url.includes('/api/v1/provider'))) expect(t.headers['cache-control'], `${t.method} ${t.url}`).toBe('no-store');
  });

  it('no log line contains a contact, a legal text or a token', () => {
    const text = logLines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const a of actors) {
      expect(text).not.toContain(a.email);
      expect(text).not.toContain(a.phone);
    }
    expect(text).not.toContain(LEGAL_MARK);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10}/);
  });

  it('no provider table holds a contact or a document: the full dump of the four tables carries none of the sentinels', async () => {
    const dump = (
      await q<{ t: string }>(
        `SELECT to_jsonb(x)::text AS t FROM provider.registrations x UNION ALL SELECT to_jsonb(x)::text FROM provider.registration_service_types x UNION ALL SELECT to_jsonb(x)::text FROM provider.audit_events x`,
      )
    )
      .map((r) => r.t)
      .join('\n');
    for (const a of actors) {
      expect(dump).not.toContain(a.email);
      expect(dump).not.toContain(a.phone);
    }
    expect(dump).not.toContain(LEGAL_MARK);
    const columns = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'provider'`);
    expect(columns.map((c) => c.column_name).filter((c) => /email|phone|name|address|body|token|subject|document/i.test(c))).toEqual([]);
  });
});

// ====================================================================== query budget
describe('query-count budget of the two reads', () => {
  /** Statements the database ran for ONE request (the account guard included). */
  async function statementsOf(fn: () => Promise<Res>): Promise<number> {
    capture = [];
    try {
      const r = await fn();
      expect(r.status, r.raw).toBe(200);
      return capture.length;
    } finally {
      capture = null;
    }
  }
  async function shaped(label: string, codes: string[]): Promise<Actor> {
    const a = await verified(label);
    ok(await start(a), 201);
    ok(await putMarket(a, W.a));
    if (codes.length) ok(await putServices(a, codes));
    await acceptAgreements(a);
    return a;
  }
  // CEILINGS. Measured on this stack at the time of writing: GET /registration runs 7 statements (the request guard's account read plus the latest-registration read) and
  // GET /registration/requirements runs 20 (the same guard, then ONE read each for the registration with its selection, the batched policy, the consent evaluation, the
  // market and the offered service types). The ceilings (9 and 26) leave about 30% so a harmless refactor does not trip them, while one statement PER STEP (nine) or PER SERVICE
  // TYPE (up to ten) would. The equality assertions are the sharper guard: the count must not depend on how many service types are selected.
  const GET_REGISTRATION_CEILING = 9;
  const GET_REQUIREMENTS_CEILING = 26;

  it('GET /registration stays within its ceiling and does not depend on the number of selected service types', async () => {
    const one = await shaped('budget-one', [W.stA]);
    const two = await shaped('budget-two', [W.stA, W.stB]);
    const none = await shaped('budget-none', []);
    const counts = [await statementsOf(() => get(one)), await statementsOf(() => get(two)), await statementsOf(() => get(none))];
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(GET_REGISTRATION_CEILING);
  });

  it('GET /registration/requirements stays within its ceiling and does not depend on the number of selected service types or on the step', async () => {
    const one = await shaped('budget-r1', [W.stA]);
    const two = await shaped('budget-r2', [W.stA, W.stB]);
    const counts = [await statementsOf(() => reqs(one)), await statementsOf(() => reqs(two)), await statementsOf(() => reqs(one, 'en-US'))];
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(GET_REQUIREMENTS_CEILING);
  });

  it('a read of the requirements is a constant number of statements even for a never-started account', async () => {
    const n = await newActor('budget-new');
    const c = await statementsOf(() => reqs(n));
    expect(c).toBeLessThanOrEqual(GET_REQUIREMENTS_CEILING);
  });
});

describe('the clock-free sanity of the file', () => {
  it('leaves no registration of the file in a state the schema forbids', async () => {
    expect(await count(`SELECT 1 FROM provider.registrations WHERE status = 'COMPLETED' AND market_id IS NULL`)).toBe(0);
    expect(await count(`SELECT account_id FROM provider.registrations WHERE status <> 'CANCELLED' GROUP BY account_id HAVING count(*) > 1`)).toBe(0);
    expect(await count(`SELECT account_id FROM provider.registrations GROUP BY account_id HAVING max(attempt_number) <> count(*)`)).toBe(0);
    await sleep(0);
  });
});
