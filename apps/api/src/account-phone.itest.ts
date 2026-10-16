// ID-003 phone contact and verification over HTTP, with the REAL services on one real, isolated PostgreSQL (migration 0011 seeds the ten
// verification.phone.* parameters and the 33 phone content entries), the real configuration registry (CRITICAL limits, country-scoped policy, read fresh), the real
// content registry and SMS renderer, the production RenderingSmsSender over the Valkey fake sink on a real Valkey, the production Valkey rate limiter, the real
// geography directory, the real auth plugin and forged-but-signed tokens. The account comes from the verified token only. This file proves the checkpoint's
// integration list end to end: add and change a number, the SMS in the sink, the code, wrong, expired and repeated codes, cooldown and caps, a number verified on
// another account (no enumeration), the country and market policy (accounts per number, blocked line types), abuse limits, fail-closed behavior, delivery
// failures, secrecy of the audit trail, the events, the logs and Valkey, and the client address behind the proxy (DEBT-0055).
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AccountService,
  EmailVerificationService,
  PHONE_POLICY_PARAMETER_KEYS,
  PhoneVerificationService,
  hashDimension,
  hashPhoneCode,
  parsePhoneVerificationPolicy,
  type PhoneCountryDirectory,
  type PhonePolicyProvider,
  type PhoneVerificationPolicy,
} from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import {
  CORRELATION_HEADER,
  ErrorResponse,
  PHONE_ERROR_CODES,
  PHONE_EVENTS,
  PHONE_ISSUE_CODES,
  PhoneChangeRequestedPayload,
  PhoneContactAddedPayload,
  PhoneVerificationFailedPayload,
  PhoneVerificationSentPayload,
  PhoneVerifiedPayload,
  maskPhone,
  phoneErrorMessageKey,
  phoneIssueMessageKey,
  phoneStatusLabelKey,
} from '@bananagig/contracts';
import { ContentService } from '@bananagig/content';
import { sql } from '@bananagig/database';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import {
  DisabledSmsTransport,
  FakePhoneIntelligence,
  RecordingEmailSender,
  RenderingSmsSender,
  SmsDeliveryError,
  ValkeyFakeSmsTransport,
  ValkeyRateLimiter,
  closeValkey,
  createValkey,
  type PhoneIntelligence,
  type RateLimiter,
  type SmsTransport,
} from '@bananagig/platform';
import { createIsolatedDatabase, extractSmsCode, openFakeSmsInbox, rejection, type FakeSmsInbox, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createVerificationLinkBuilder, createVerificationPolicyProvider } from './modules/account/email-wiring';
import { createContentSmsRenderer, createPhoneCountryDirectory, createPhonePolicyProvider } from './modules/account/phone-wiring';

// ---------------------------------------------------------------- the real stack
const HASH_KEY = 'itest-phone-hash-key-'.concat('k'.repeat(28));
const envFor = (hops?: number) => ({
  NODE_ENV: 'test',
  VERIFICATION_HASH_SECRET: HASH_KEY,
  ...(process.env.VALKEY_URL ? { VALKEY_URL: process.env.VALKEY_URL } : {}),
  ...(hops === undefined ? {} : { TRUSTED_PROXY_HOPS: String(hops) }),
});
const cfg = loadConfig({ service: 'bananagig-api', env: envFor() });
const SMS_PREFIX = 'BananaGig:';

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let geographyService: GeographyService;
let realPolicy: PhonePolicyProvider;
let directory: PhoneCountryDirectory;
let mainLimiter: RateLimiter;
let inbox: FakeSmsInbox;
let closeInbox: () => Promise<void>;
let goodTransport: SmsTransport;
const emailSender = new RecordingEmailSender();
const valkey = createValkey(cfg);
const deadValkey = createValkey({ ...cfg, valkeyUrl: 'redis://127.0.0.1:1' });
deadValkey.on('error', () => undefined);
const extraApps: FastifyInstance[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
  /** The correlation id the request carried. */
  cid: string;
}
/** Every response of the file, so the last tests can prove the secrecy and caching rules over ALL of them. */
const transcript: Res[] = [];
const numbers: string[] = [];
/** Every code that was delivered by SMS, so the secrecy checks know what must never show up anywhere else. */
const delivered = new Set<string>();

interface Actor {
  label: string;
  sub: string;
  token: string;
  accountId: string;
  ip: string;
}
interface CallOptions {
  body?: unknown;
  /** Sent verbatim with a JSON content type. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Another app instance over the same database (a different policy, sender or limiter). */
  app?: FastifyInstance;
  /** The forwarded client address; null sends no x-forwarded-for header. Default: the actor's own unique address. */
  ip?: string | null;
  /** Overrides the actor's token; null sends no Authorization header. */
  token?: string | null;
}

let ipCounter = 0;
const nextIp = (): string => {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.9`;
};

const AREAS = ['202', '212', '303', '404', '505', '606', '707', '808', '313', '414'];
/** A fresh, valid US number. The last three digits select the fake line type (901 VOIP, 902 VIRTUAL, 903 LANDLINE, 904 HIGH_RISK, 905 lookup fails); default: MOBILE. */
function newNumber(suffix?: string): string {
  for (;;) {
    const area = AREAS[randomInt(AREAS.length)]!;
    const last3 = suffix ?? String(randomInt(0, 900)).padStart(3, '0');
    const n = `+1${area}555${randomInt(10)}${last3}`;
    if (numbers.includes(n)) continue;
    numbers.push(n);
    return n;
  }
}
const national = (e164: string): string => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

async function call(actor: Actor | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: CallOptions = {}): Promise<Res> {
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const token = o.token === undefined ? actor?.token : (o.token ?? undefined);
  const ip = o.ip === undefined ? actor?.ip : (o.ip ?? undefined);
  const cid = o.headers?.[CORRELATION_HEADER] ?? randomUUID();
  const r = await (o.app ?? app).inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
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
  const res: Res = { method, url: `/api/v1${url}`, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}

const PHONE = '/account/phone';
const me = (a: Actor, o?: CallOptions) => call(a, 'GET', '/account/me', o);
const detail = (a: Actor, o?: CallOptions) => call(a, 'GET', PHONE, o);
const setPhone = (a: Actor, phone: unknown, o?: CallOptions & { country?: unknown }) => {
  const { country, ...rest } = o ?? {};
  return call(a, 'POST', PHONE, { ...rest, body: { phone, ...(country === undefined ? {} : { country }) } });
};
const send = (a: Actor, o?: CallOptions) => call(a, 'POST', `${PHONE}/verification/send`, { ...o, body: {} });
const confirmCode = (a: Actor, code: unknown, o?: CallOptions) => call(a, 'POST', `${PHONE}/verification/confirm-code`, { ...o, body: { code } });
const ROUTES_OF_PHONE: [string, 'GET' | 'POST', string, unknown][] = [
  ['getAccountPhone', 'GET', PHONE, undefined],
  ['setAccountPhone', 'POST', PHONE, { phone: '+12025550142' }],
  ['sendAccountPhoneVerification', 'POST', `${PHONE}/verification/send`, {}],
  ['confirmAccountPhoneCode', 'POST', `${PHONE}/verification/confirm-code`, { code: '123456' }],
];

async function newActor(label: string, o: { token?: Promise<string> } = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  const token = await (o.token ?? signToken(keys, { claims: { sub, azp: 'bananagig-web', sid: randomUUID(), realm_access: { roles: ['customer'] } } }));
  const actor: Actor = { label, sub, token, accountId: '', ip: nextIp() };
  const created = await me(actor); // the account is created at the first authenticated request
  expect(created.status, created.raw).toBe(200);
  actor.accountId = created.body.data.accountId;
  return actor;
}
const adminToken = () =>
  signToken(keys, {
    claims: {
      sub: `itest-admin-${randomUUID()}`,
      azp: 'bananagig-admin',
      sid: randomUUID(),
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', 'content-read', 'geography-read'] } },
    },
  });

const ok = (r: Res): Json => {
  expect(r.status, r.raw).toBe(200);
  expect(Object.keys(r.body).sort(), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, r.raw).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId, 'the error carries the correlation id of the request').toBe(r.headers[CORRELATION_HEADER]);
  return r.body.error;
};
const wrongCode = (code: string): string => (code === '000000' ? '111111' : '000000');
/** The shape of a JSON value with every scalar replaced by its type: two answers with the same shape differ in values only. */
const shape = (v: unknown): unknown =>
  v === null ? null : Array.isArray(v) ? v.map(shape) : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

// ---------------------------------------------------------------- the phone (the fake SMS sink)
const PRD_POLICY: PhoneVerificationPolicy = {
  codeLength: 6,
  validityMinutes: 10,
  resendSeconds: 30,
  maxPerHour: 5,
  maxPerDay: 10,
  maxAttempts: 5,
  maxAccountsPerNumber: 1,
  blockedLineTypes: ['VIRTUAL', 'HIGH_RISK'],
  requestsPerHour: 30,
  numberPerHour: 5,
};
const smsCount = async (e164: string): Promise<number> => (await inbox.messages(e164)).length;

/** Sets the number (national format with the country, or international) and sends the verification; returns what the sink received. */
async function addAndSend(a: Actor, o: { number?: string; app?: FastifyInstance; sms?: number } = {}) {
  const number = o.number ?? newNumber();
  ok(await setPhone(a, number, { app: o.app }));
  return { number, ...(await sendAgain(a, number, { app: o.app, sms: o.sms ?? 1 })) };
}
async function sendAgain(a: Actor, number: string, o: { app?: FastifyInstance; sms: number }) {
  const r = await send(a, { app: o.app });
  const data = ok(r);
  const messages = await inbox.wait(number, o.sms);
  const message = messages[messages.length - 1]!;
  const code = extractSmsCode(message.body)!;
  expect(code, 'the SMS carries a code').toMatch(/^[0-9]{6}$/);
  delivered.add(code);
  return { data, message, code, cid: r.cid };
}
/** Adds a number, sends, enters the code: a VERIFIED primary number. */
async function verified(a: Actor, o: { number?: string } = {}) {
  const sent = await addAndSend(a, o);
  expect(ok(await confirmCode(a, sent.code)).changed).toBe(true);
  return sent;
}

// ---------------------------------------------------------------- the database
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const contactsOf = (accountId: string) =>
  q<{
    phone_contact_id: string;
    phone_e164: string;
    country_code: string;
    status: string;
    is_primary: boolean;
    source: string;
    line_type: string | null;
    line_type_checked_at: Date | null;
    verified_at: Date | null;
    disabled_reason: string | null;
  }>(
    `SELECT phone_contact_id, phone_e164, country_code, status, is_primary, source, line_type, line_type_checked_at, verified_at, disabled_reason
       FROM identity.phone_contacts WHERE account_id = $1 ORDER BY created_at, phone_contact_id`,
    [accountId],
  );
const challengesOf = (accountId: string) =>
  q<{
    challenge_id: string;
    phone_contact_id: string;
    purpose: string;
    code_hash: string;
    expires_at: Date;
    used_at: Date | null;
    attempt_count: number;
    invalidated_at: Date | null;
    invalidation_reason: string | null;
    delivery_status: string;
    last_sent_at: Date | null;
    created_at: Date;
    correlation_id: string;
  }>(
    `SELECT c.* FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k ON k.phone_contact_id = c.phone_contact_id
      WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
    [accountId],
  );
const auditOf = (accountId: string) =>
  q<{ action: string; actor: string; changes: Json; correlation_id: string; phone_contact_id: string }>(
    `SELECT action, actor, changes, correlation_id, phone_contact_id FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'PHONE%' ORDER BY occurred_at, audit_event_id`,
    [accountId],
  );
const eventsOf = (accountId: string) =>
  q<{ event_type: string; aggregate_type: string; actor_type: string; actor_id: string; correlation_id: string; payload_json: Json }>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.phone-%' ORDER BY created_at, event_type`,
    [accountId],
  );
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const phoneRowCounts = async () => ({
  contacts: await count('SELECT 1 FROM identity.phone_contacts'),
  challenges: await count('SELECT 1 FROM identity.phone_verification_challenges'),
  audit: await count(`SELECT 1 FROM identity.account_audit_events WHERE action LIKE 'PHONE%'`),
  events: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.phone-%'`),
});

/**
 * An EXPIRED challenge for the account's pending number. Time belongs to the database and the guard triggers make created_at and expires_at immutable, so the row is
 * inserted with explicit past timestamps and a hash computed with the same key the service uses. The contact must have no open challenge.
 */
async function insertExpiredChallenge(accountId: string, code: string): Promise<string> {
  const contact = (await contactsOf(accountId)).find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING')!;
  const challengeId = randomUUID();
  await q(
    `INSERT INTO identity.phone_verification_challenges (challenge_id, phone_contact_id, purpose, code_hash, expires_at, created_at, correlation_id)
     VALUES ($1, $2, $3, $4, now() - interval '5 minutes', now() - interval '15 minutes', 'itest-expired')`,
    [challengeId, contact.phone_contact_id, contact.status === 'PENDING' ? 'INITIAL_PHONE' : 'CHANGE_PHONE', hashPhoneCode(HASH_KEY, challengeId, code)],
  );
  await q(`UPDATE identity.phone_verification_challenges SET delivery_status = 'SENT', last_sent_at = now() - interval '14 minutes' WHERE challenge_id = $1`, [
    challengeId,
  ]);
  return challengeId;
}

// ---------------------------------------------------------------- variants of the app over the same database
const limiterPrefix = (): string => `itest:${randomUUID()}:`;
const newLimiter = (prefix = limiterPrefix()): ValkeyRateLimiter => new ValkeyRateLimiter(valkey, { prefix, commandTimeoutMs: 1000 });
const policyWith = (over: Partial<PhoneVerificationPolicy>): PhonePolicyProvider => ({
  policy: async (country) => ({ ...(await realPolicy.policy(country)), ...over }),
});

/** Counts the vendor lookups and answers like the fake classifier. */
class CountingIntelligence implements PhoneIntelligence {
  readonly calls: string[] = [];
  private readonly inner = new FakePhoneIntelligence();
  lookup(e164: string) {
    this.calls.push(e164);
    return this.inner.lookup(e164);
  }
}

interface Variant {
  policy?: Partial<PhoneVerificationPolicy>;
  transport?: SmsTransport;
  intelligence?: PhoneIntelligence;
  countries?: PhoneCountryDirectory;
  /** undefined: the shared limiter; null: no limiter at all. */
  limiter?: RateLimiter | null;
  /** The number of trusted reverse proxy hops (default: the configuration default, 1). */
  hops?: number;
}
const verifierFor = () =>
  createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: keys.getKey, webClientId: 'bananagig-web', adminClientId: 'bananagig-admin' });
async function makeApp(v: Variant = {}): Promise<FastifyInstance> {
  const appCfg = loadConfig({ service: 'bananagig-api', env: envFor(v.hops) });
  const phoneVerification = new PhoneVerificationService({
    database: iso.database,
    policy: v.policy ? policyWith(v.policy) : realPolicy,
    sender: new RenderingSmsSender(createContentSmsRenderer(content), v.transport ?? goodTransport),
    intelligence: v.intelligence ?? new FakePhoneIntelligence(),
    countries: v.countries ?? directory,
    hashSecret: HASH_KEY,
    ...(v.limiter === null ? {} : { rateLimiter: v.limiter ?? mainLimiter }),
  });
  const emailVerification = new EmailVerificationService({
    database: iso.database,
    policy: createVerificationPolicyProvider(configuration),
    sender: emailSender,
    linkFor: createVerificationLinkBuilder(appCfg.identity.webPublicUrl),
    hashSecret: HASH_KEY,
    rateLimiter: mainLimiter,
  });
  const instance = await buildApp({
    cfg: appCfg,
    verifier: verifierFor(),
    configuration,
    content,
    geography: geographyService,
    accounts,
    emailVerification,
    phoneVerification,
    readiness: async () => ({}),
  });
  await instance.ready();
  extraApps.push(instance);
  return instance;
}

/**
 * The directory the rest of this file runs on. createPhoneCountryDirectory reads the PUBLIC view of a country, which carries no `status` (it only returns ACTIVE
 * countries), so its `status === 'ACTIVE'` test never holds and every number is refused (production bug reported by the 'country directory' tests below). While that bug
 * is present the file runs on this equivalent directory so everything else is still proven; once it is fixed the real one is used.
 */
const equivalentDirectory = (geo: Pick<GeographyService, 'getCountry' | 'getActiveCountries'>): PhoneCountryDirectory => ({
  async active(isoAlpha2) {
    try {
      return { dialingCode: (await geo.getCountry(isoAlpha2, { management: false })).dialingCode };
    } catch (err) {
      if ((err as { code?: string }).code === 'COUNTRY_NOT_FOUND') return null;
      throw err;
    }
  },
  async defaultCountry() {
    const active = await geo.getActiveCountries();
    return active.length === 1 ? active[0]!.code : undefined;
  },
});
let directoryBug = false;
const directoryFor = (geo: GeographyService): PhoneCountryDirectory => (directoryBug ? equivalentDirectory(geo) : createPhoneCountryDirectory(geo));
const freshGeography = () =>
  new GeographyService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true, readiness: new ReadinessRegistry() });

function captureLogs() {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, stop: () => write.mockRestore() };
}

/** Publishes a COUNTRY-scoped value through the real change workflow: draft, submit, approve by a second actor, publish. */
async function setCountryValue(key: string, country: string, value: unknown): Promise<void> {
  const cr = await configuration.createChangeRequest(
    { parameterKey: key, scopeType: 'COUNTRY', scopeRef: country, value, reason: 'ID-003 integration test' },
    'itest-requester',
  );
  await configuration.submit(cr.changeRequestId, 'itest-requester');
  await configuration.approve(cr.changeRequestId, 'itest-approver');
  await configuration.publish(cr.changeRequestId, 'itest-requester');
}

/** Creates a country in geography: PLANNED, INACTIVE or ACTIVE (a country becomes ACTIVE only after it was created PLANNED with its locale and time zone). */
async function makeCountry(alpha2: string, alpha3: string, numeric: string, dialingCode: string, status: 'PLANNED' | 'ACTIVE' | 'INACTIVE'): Promise<void> {
  await iso.database.transaction(async (trx) => {
    const created = await sql<{ country_id: string }>`INSERT INTO geography.countries
        (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
      VALUES (${alpha2}, ${alpha3}, ${numeric}, 'geography.country.us.name', 'PLANNED', ${dialingCode}, 'USD', 'en-US', 'KILOMETERS', 'MONDAY', 'DMY', '24_HOUR') RETURNING country_id`.execute(
      trx,
    );
    const id = created.rows[0]!.country_id;
    await sql`INSERT INTO geography.country_locales (country_id, locale) VALUES (${id}, 'en-US')`.execute(trx);
    await sql`INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT ${id}, time_zone_id FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles'`.execute(
      trx,
    );
  });
  if (status === 'PLANNED') return;
  await q(`UPDATE geography.countries SET status = 'ACTIVE' WHERE iso_alpha2 = $1`, [alpha2]);
  if (status === 'INACTIVE') await q(`UPDATE geography.countries SET status = 'INACTIVE' WHERE iso_alpha2 = $1`, [alpha2]);
}

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  geographyService = new GeographyService({
    database: iso.database,
    cache: new MemoryConfigCache(),
    env: 'test',
    allowTestKeys: true,
    readiness: new ReadinessRegistry(),
  });
  content = new ContentService({
    database: iso.database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geographyService),
    markets: createMarketDefaultsProvider(geographyService),
  });
  configuration = new ConfigurationService({
    database: iso.database,
    cache: new MemoryConfigCache(),
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geographyService),
  });
  accounts = new AccountService({ database: iso.database, lastSeenTouchSeconds: 0 });
  realPolicy = createPhonePolicyProvider(configuration);
  // two countries that exist but do not accept numbers: one never activated, one deactivated
  await makeCountry('GB', 'GBR', '826', '+44', 'PLANNED');
  await makeCountry('FR', 'FRA', '250', '+33', 'INACTIVE');
  directoryBug = (await createPhoneCountryDirectory(geographyService).active('US')) === null;
  directory = directoryFor(geographyService);
  goodTransport = new ValkeyFakeSmsTransport(valkey, 'test');
  const opened = openFakeSmsInbox(process.env.VALKEY_URL);
  inbox = opened.inbox;
  closeInbox = opened.close;
  await valkey.ping(); // connect now: the limiter bounds every call to a short timeout
  mainLimiter = newLimiter();
  app = await makeApp();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.allSettled(numbers.map((n) => inbox.clear(n)));
  for (const a of extraApps) await a.close();
  deadValkey.disconnect();
  await closeInbox?.();
  await closeValkey(valkey);
  await iso?.drop();
});

// ====================================================================== seeded configuration and managed copy
describe('seeded configuration and content (migration 0011)', () => {
  it('resolves the ten verification.phone.* parameters to the PRD values through the policy provider, with and without a country', async () => {
    expect(await realPolicy.policy()).toEqual(PRD_POLICY);
    expect(await realPolicy.policy('US')).toEqual(PRD_POLICY);
    const { values } = await configuration.resolveMany([...PHONE_POLICY_PARAMETER_KEYS]);
    expect(values.size).toBe(10);
    expect(parsePhoneVerificationPolicy(Object.fromEntries([...values].map(([k, r]) => [k, r.value])))).toEqual(PRD_POLICY);
  });

  it('defines every limit as a CRITICAL, second-approver, required parameter: eight PLATFORM-only security limits and the two trust policies scoped by country and market', async () => {
    const rows = await q<{
      key: string;
      data_type: string;
      owner_role: string;
      approval_policy: string;
      criticality: string;
      is_required: boolean;
      scopes: string[];
    }>(
      `SELECT p.key, p.data_type, p.owner_role, p.approval_policy, p.criticality, p.is_required, array_agg(s.scope_type ORDER BY s.scope_type) AS scopes
         FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id
        WHERE p.key LIKE 'verification.phone.%' GROUP BY p.parameter_id ORDER BY p.key`,
    );
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r, r.key).toMatchObject({ approval_policy: 'SECOND_APPROVER', criticality: 'CRITICAL', is_required: true });
      const policy = r.key.endsWith('max_accounts_per_number') || r.key.endsWith('blocked_line_types');
      expect(r.owner_role, r.key).toBe(policy ? 'trust' : 'security');
      expect(r.scopes, r.key).toEqual(policy ? ['COUNTRY', 'MARKET', 'PLATFORM'] : ['PLATFORM']);
      expect(r.data_type, r.key).toBe(r.key.endsWith('blocked_line_types') ? 'JSON' : 'INTEGER');
    }
  });

  it('reads the CRITICAL limits fresh: nothing is ever written to the configuration cache, and every resolved value says CRITICAL', async () => {
    const cache = new MemoryConfigCache();
    const fresh = new ConfigurationService({ database: iso.database, cache, env: 'test', allowTestKeys: true });
    await createPhonePolicyProvider(fresh).policy();
    await createPhonePolicyProvider(fresh).policy('US');
    expect([...cache.data.keys()].filter((k) => k.includes('verification'))).toEqual([]);
    const { values } = await fresh.resolveMany(['verification.phone.max_attempts', 'verification.phone.code.length', 'verification.phone.blocked_line_types']);
    for (const r of values.values()) expect(r.criticality).toBe('CRITICAL');
  });

  it('refuses an invalid or missing limit instead of defaulting it (the service then fails closed)', () => {
    const good = {
      'verification.phone.code.length': 6,
      'verification.phone.validity_minutes': 10,
      'verification.phone.resend_seconds': 30,
      'verification.phone.max_per_hour': 5,
      'verification.phone.max_per_day': 10,
      'verification.phone.max_attempts': 5,
      'verification.phone.max_accounts_per_number': 1,
      'verification.phone.blocked_line_types': ['VIRTUAL', 'HIGH_RISK'],
      'verification.phone.requests.max_per_hour': 30,
      'verification.phone.number.max_per_hour': 5,
    };
    expect(() => parsePhoneVerificationPolicy(good)).not.toThrow();
    for (const [key, bad] of [
      ['verification.phone.code.length', 3],
      ['verification.phone.code.length', 11],
      ['verification.phone.code.length', '6'],
      ['verification.phone.max_attempts', 0],
      ['verification.phone.max_attempts', null],
      ['verification.phone.max_accounts_per_number', 0],
      ['verification.phone.max_accounts_per_number', 6],
      ['verification.phone.resend_seconds', -1],
      ['verification.phone.validity_minutes', undefined],
      ['verification.phone.blocked_line_types', ['MOBILE']],
      ['verification.phone.blocked_line_types', ['VOIP', 'VOIP']],
      ['verification.phone.blocked_line_types', 'VOIP'],
      ['verification.phone.blocked_line_types', [1]],
      ['verification.phone.number.max_per_hour', 0],
    ] as const)
      expect(() => parsePhoneVerificationPolicy({ ...good, [key]: bad }), `${key}=${String(bad)}`).toThrow(/not available/);
    expect(() => parsePhoneVerificationPolicy({})).toThrow(/not available/);
  });

  it('seeds the 33 phone entries (the SMS and 32 screen texts) as active, content-owned, public copy, and renders EVERY one with its example variable values', async () => {
    const entries = (await content.listEntries()).filter((e) => e.key === 'sms.verification.phone.body' || e.key.startsWith('account.phone.'));
    expect(entries).toHaveLength(33);
    for (const e of entries) {
      expect(e, e.key).toMatchObject({ isActive: true, ownerRole: 'CONTENT' });
      const variables = Object.fromEntries(e.variables.map((v) => [v.name, v.example]));
      const r = await content.render(e.key, { locale: 'en-US', variables });
      expect(r.format, e.key).toBe('text');
      expect(r.value.trim().length, e.key).toBeGreaterThan(0);
      expect(r.value, `${e.key} left a placeholder unresolved`).not.toMatch(/\{[a-z_]+[,}]/);
    }
  });

  it('renders the SMS body for its example values: concise, branded, plural-aware, with no link', async () => {
    const entry = (await content.getEntry('sms.verification.phone.body')).entry;
    const variables = Object.fromEntries(entry.variables.map((v) => [v.name, v.example]));
    const rendered = await content.render('sms.verification.phone.body', { locale: 'en-US', variables });
    expect(rendered.value).toBe('BananaGig: 123456 is your verification code. It expires in 10 minutes. Never share this code.');
    expect(rendered.value.length).toBeLessThanOrEqual(160);
    const one = await content.render('sms.verification.phone.body', { locale: 'en-US', variables: { verification_code: '654321', expiry_minutes: 1 } });
    expect(one.value).toContain('expires in 1 minute.');
    expect(one.value).not.toMatch(/https?:|www\.|\.com/i);
  });

  it('seeds the code as a SENSITIVE_PERSONAL STRING and the expiry as a COUNT, both required, on the SMS body', async () => {
    const body = (await content.getEntry('sms.verification.phone.body')).entry;
    expect(body.contentType).toBe('PLAIN_TEXT');
    expect(Object.fromEntries(body.variables.map((v) => [v.name, [v.type, v.piiClass, v.required]]))).toEqual({
      verification_code: ['STRING', 'SENSITIVE_PERSONAL', true],
      expiry_minutes: ['COUNT', 'NONE', true],
    });
  });

  it('resolves every message key the API and the screens use: error codes, issue codes, status labels', async () => {
    const keysUsed = [
      ...PHONE_ERROR_CODES.filter((c) => c !== 'PHONE_INVALID').map(phoneErrorMessageKey),
      ...PHONE_ISSUE_CODES.map(phoneIssueMessageKey),
      ...(['NONE', 'PENDING', 'VERIFIED'] as const).map(phoneStatusLabelKey),
    ];
    expect(keysUsed).toHaveLength(12 + 6 + 3);
    for (const key of keysUsed) {
      const entry = await content.getEntry(key);
      const variables = Object.fromEntries(entry.entry.variables.map((v) => [v.name, v.example]));
      expect((await content.render(key, { locale: 'en-US', variables })).value.length, key).toBeGreaterThan(0);
    }
  });

  it('renders the SMS through the PRODUCTION renderer from the registry, handing the entry only the variables it defines', async () => {
    const renderer = createContentSmsRenderer(content);
    const r = await renderer.render('sms.verification.phone', { verification_code: '908172', expiry_minutes: 10 }, undefined);
    expect(r.body).toBe('BananaGig: 908172 is your verification code. It expires in 10 minutes. Never share this code.');
    expect(r.templateVersion).toMatch(/^[0-9]+$/);
    // a variable the entry does not define is dropped, not an error
    const extra = await renderer.render('sms.verification.phone', { verification_code: '908172', expiry_minutes: 10, account_id: randomUUID() }, 'en-US');
    expect(extra.body).toBe(r.body);
  });
});

// ====================================================================== the country directory (geography)
describe('createPhoneCountryDirectory over the real geography service', () => {
  const real = () => createPhoneCountryDirectory(freshGeography());

  it('reports the seeded ACTIVE country US with its configured dialing code', async () => {
    expect(await real().active('US')).toEqual({ dialingCode: '+1' });
  });
  it('reports a country that is PLANNED, INACTIVE or unknown as not accepted', async () => {
    const d = real();
    for (const code of ['GB', 'FR', 'ZZ', 'XX']) expect(await d.active(code), code).toBeNull();
  });
  it('names US as the default country while it is the only ACTIVE country', async () => {
    expect(await real().defaultCountry()).toBe('US');
  });
});

// ====================================================================== access control on the real stack
describe('access control', () => {
  it('answers 401 to every phone route without a token and creates, sends and changes nothing', async () => {
    const before = await phoneRowCounts();
    for (const [name, method, url, body] of ROUTES_OF_PHONE) {
      const r = await call(undefined, method, url, { body, ip: null });
      fail(r, 401, 'AUTHENTICATION_REQUIRED');
      expect(String(r.headers['www-authenticate']), name).toContain('Bearer');
      expect(r.headers['cache-control'], name).toBe('no-store');
      // authentication wins over validation
      if (method === 'POST') fail(await call(undefined, 'POST', url, { body: { code: 1, phone: 2, country: 3 } }), 401, 'AUTHENTICATION_REQUIRED');
    }
    fail(await call(undefined, 'GET', `${PHONE}?accountId=x`), 401, 'AUTHENTICATION_REQUIRED');
    expect(await phoneRowCounts()).toEqual(before);
  });

  it('answers 401 INVALID_TOKEN to a forged, expired or foreign-signed token, never creating an account', async () => {
    const accountsBefore = await count('SELECT 1 FROM identity.accounts');
    const other = await createTestKeys('k1');
    const bad = [
      await signToken(keys, { expiresInSec: -3600 }),
      await signToken(other, {}),
      await signToken(keys, { claims: { aud: 'someone-else' } }),
      'a.b.c',
    ];
    for (const token of bad)
      for (const [, method, url, body] of ROUTES_OF_PHONE) fail(await call(undefined, method, url, { body, token, ip: null }), 401, 'INVALID_TOKEN');
    expect(await count('SELECT 1 FROM identity.accounts')).toBe(accountsBefore);
  });

  it('refuses the admin identity context with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED on every phone route, before it validates the body', async () => {
    const before = await phoneRowCounts();
    const token = await adminToken();
    for (const [, method, url, body] of ROUTES_OF_PHONE) {
      fail(await call(undefined, method, url, { body, token }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
      if (method === 'POST') fail(await call(undefined, 'POST', url, { body: { code: 1, extra: 2 }, token }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    }
    expect(await phoneRowCounts()).toEqual(before);
  });

  it('never accepts a number where a string is required: {"phone":2025550142} and {"code":123456} are 400s that add no contact and count no attempt', async () => {
    const a = await newActor('strict');
    const { code } = await addAndSend(a);
    const before = await challengesOf(a.accountId);
    for (const body of [{ code: Number(code) }, { code: [code] }, { code, extra: 1 }, { token: code }, {}]) {
      const r = await call(a, 'POST', `${PHONE}/verification/confirm-code`, { body });
      expect(r.status, r.raw).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      expect(r.raw).not.toContain(code);
    }
    const b = await newActor('strict-b');
    const number = newNumber();
    for (const body of [
      { phone: Number(number.slice(1)) },
      { phone: null },
      { phone: number, accountId: a.accountId },
      { phone: number, extra: true },
      { phone: number, country: 'us' },
      [],
    ]) {
      const r = await call(b, 'POST', PHONE, { body });
      fail(r, 400, 'VALIDATION_FAILED');
      expect(r.raw).not.toContain(number);
      expect(r.raw).not.toContain(number.slice(1));
    }
    expect(await contactsOf(b.accountId)).toEqual([]);
    expect((await challengesOf(a.accountId)).map((c) => c.attempt_count)).toEqual(before.map((c) => c.attempt_count));
    expect(before[0]!.attempt_count).toBe(0);
  });

  it("keeps accounts apart: a request can never name another account, and one account cannot read or use the other's state", async () => {
    const a = await newActor('iso-a');
    const b = await newActor('iso-b');
    const sentA = await addAndSend(a);
    const probe = await call(b, 'GET', `${PHONE}?accountId=${a.accountId}`, { headers: { 'x-account-id': a.accountId, 'x-user-id': a.sub } });
    expect(ok(probe)).toMatchObject({ phoneVerificationStatus: 'NONE', pending: null, primary: null });
    fail(await call(b, 'POST', PHONE, { body: { phone: newNumber(), accountId: a.accountId } }), 400, 'VALIDATION_FAILED');
    const numberB = newNumber();
    ok(await setPhone(b, numberB, { headers: { 'x-account-id': a.accountId } }));
    const sentB = await sendAgain(b, numberB, { sms: 1 });
    expect(sentB.code).not.toBe(sentA.code);
    const wrong = fail(await confirmCode(b, sentA.code), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(wrong.details.attemptsRemaining).toBe(4);
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    expect(ok(await confirmCode(a, sentA.code)).changed).toBe(true);
    expect((await contactsOf(b.accountId))[0]!.status).toBe('PENDING');
  });
});

// ====================================================================== the number: add and canonicalize
describe('POST /account/phone: the initial number', () => {
  it('adds a national number with its country as PENDING / INITIAL_PHONE, answers masked, sends no SMS, audits PHONE_ADDED and emits PhoneContactAdded', async () => {
    const a = await newActor('add-national');
    const number = newNumber();
    const r = await setPhone(a, national(number), { country: 'US' });
    const data = ok(r);
    expect(data.changed).toBe(true);
    expect(data.phone).toEqual({
      phoneVerificationStatus: 'PENDING',
      primary: null,
      pending: { maskedPhone: maskPhone(number), countryCode: 'US', purpose: 'INITIAL_PHONE', status: 'PENDING', lastSentAt: null, expiresAt: null },
    });
    expect(r.raw).not.toContain(number);
    expect(r.raw).not.toContain(number.slice(2));
    const contacts = await contactsOf(a.accountId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      phone_e164: number,
      country_code: 'US',
      status: 'PENDING',
      is_primary: false,
      source: 'USER_ENTERED',
      verified_at: null,
    });
    expect(await challengesOf(a.accountId)).toEqual([]);
    expect(await smsCount(number)).toBe(0);
    const audit = await auditOf(a.accountId);
    expect(audit.map((x) => x.action)).toEqual(['PHONE_ADDED']);
    expect(audit[0]).toMatchObject({ actor: `account:${a.accountId}`, phone_contact_id: contacts[0]!.phone_contact_id, correlation_id: r.cid });
    expect(audit[0]!.changes).toMatchObject({ status: [null, 'PENDING'], maskedPhone: maskPhone(number), countryCode: 'US', purpose: 'INITIAL_PHONE' });
    const events = await eventsOf(a.accountId);
    expect(events.map((x) => x.event_type)).toEqual([PHONE_EVENTS.contactAdded]);
    expect(PhoneContactAddedPayload.parse(events[0]!.payload_json)).toEqual({
      accountId: a.accountId,
      phoneContactId: contacts[0]!.phone_contact_id,
      purpose: 'INITIAL_PHONE',
      source: 'USER_ENTERED',
      status: 'PENDING',
    });
  });

  it('adds an international number without a country, and a national number without a country uses the only ACTIVE country (US)', async () => {
    const a = await newActor('add-international');
    const number = newNumber();
    expect(ok(await setPhone(a, number)).phone.pending.countryCode).toBe('US');
    const b = await newActor('add-default-country');
    const other = newNumber();
    expect(ok(await setPhone(b, national(other))).phone.pending.maskedPhone).toBe(maskPhone(other));
    expect((await contactsOf(b.accountId))[0]!.phone_e164).toBe(other);
  });

  it('canonicalizes to E.164: spaces, dots, dashes, parentheses and a leading +1 all store the same number', async () => {
    const n = newNumber();
    const [area, exch, line] = [n.slice(2, 5), n.slice(5, 8), n.slice(8)];
    const forms = [
      `+1 ${area} ${exch} ${line}`,
      `+1.${area}.${exch}.${line}`,
      `+1-${area}-${exch}-${line}`,
      `+1 (${area}) ${exch}-${line}`,
      `${area}.${exch}.${line}`,
      `1${area}${exch}${line}`,
    ];
    for (const form of forms) {
      const a = await newActor('canon');
      const r = await setPhone(a, form, { country: 'US' });
      const data = ok(r);
      expect(data.phone.pending.maskedPhone, form).toBe(maskPhone(n));
      expect((await contactsOf(a.accountId))[0]!.phone_e164, form).toBe(n);
    }
  });

  it('takes the country from the NUMBER, not from the hint: a +44 number with the hint US is a number of GB, which is not ACTIVE', async () => {
    const a = await newActor('hint');
    const error = fail(await setPhone(a, '+442079460958', { country: 'US' }), 400, 'ACCOUNT_PHONE_INVALID');
    expect(error.details).toEqual({ reason: 'COUNTRY_NOT_SUPPORTED', messageKey: 'account.phone.error.country_not_supported' });
    expect(await contactsOf(a.accountId)).toEqual([]);
  });

  const invalid: [string, unknown, string | undefined, string][] = [
    ['letters', '202-555-CALL', 'US', 'INVALID_CHARACTERS'],
    ['an extension', '+12025550142 x12', undefined, 'INVALID_CHARACTERS'],
    ['an extension with ext.', '+12025550142 ext 12', undefined, 'INVALID_CHARACTERS'],
    ['a pound sign', '+1202555#0142', undefined, 'INVALID_CHARACTERS'],
    ['a right-to-left override', `+1202555${String.fromCodePoint(0x202e)}0142`, undefined, 'INVALID_CHARACTERS'],
    ['a NUL character', `+1202555${String.fromCharCode(0)}0142`, undefined, 'INVALID_CHARACTERS'],
    ['an empty string', '', 'US', 'REQUIRED'],
    ['only spaces', '    ', 'US', 'REQUIRED'],
    ['a too short number', '+1202555', undefined, 'INVALID_NUMBER'],
    ['an impossible US number', '+10002223333', undefined, 'INVALID_NUMBER'],
    ['a short national number in an unknown country', '12345', 'ZZ', 'COUNTRY_NOT_SUPPORTED'],
    ['an unknown country hint', '2025550142', 'ZZ', 'COUNTRY_NOT_SUPPORTED'],
    ['a non-geographic number (+800)', '+80012345678', undefined, 'COUNTRY_NOT_SUPPORTED'],
    ['a number of a country that is PLANNED', '+442079460958', undefined, 'COUNTRY_NOT_SUPPORTED'],
    ['a number of a country that is INACTIVE', '+33142685300', undefined, 'COUNTRY_NOT_SUPPORTED'],
  ];
  it.each(invalid)(
    'refuses %s with 400 ACCOUNT_PHONE_INVALID (%s), a message key, no echo of the value, and stores nothing',
    async (_label, phone, country, reason) => {
      const a = await newActor('invalid');
      const before = await phoneRowCounts();
      const r = await setPhone(a, phone, { country });
      const error = fail(r, 400, 'ACCOUNT_PHONE_INVALID');
      expect(error).toMatchObject({ category: 'VALIDATION', details: { reason, messageKey: phoneIssueMessageKey(reason as never) } });
      for (const v of [phone as string, String(phone).trim()]) if (v.length > 4) expect(r.raw).not.toContain(v);
      expect(await phoneRowCounts()).toEqual(before);
    },
  );

  it('is idempotent for the same number in any format (changed:false), and a different number supersedes the pending one, closing its challenge', async () => {
    const a = await newActor('idem');
    const first = newNumber();
    ok(await setPhone(a, first));
    const sent = await sendAgain(a, first, { sms: 1 });
    const again = ok(await setPhone(a, national(first), { country: 'US' }));
    expect(again.changed).toBe(false);
    expect(await contactsOf(a.accountId)).toHaveLength(1);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ invalidated_at: null, delivery_status: 'SENT' });
    const second = newNumber();
    expect(ok(await setPhone(a, second)).changed).toBe(true);
    const contacts = await contactsOf(a.accountId);
    expect(contacts.map((c) => [c.phone_e164, c.status, c.disabled_reason])).toEqual([
      [first, 'DISABLED', 'SUPERSEDED'],
      [second, 'PENDING', null],
    ]);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED' });
    // the superseded number's code verifies nothing: the new pending number has no code yet, and the wrong guess is not counted
    fail(await confirmCode(a, sent.code), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(await challengesOf(a.accountId)).toHaveLength(1);
    expect((await auditOf(a.accountId)).map((x) => x.action)).toEqual(['PHONE_ADDED', 'PHONE_VERIFICATION_REQUESTED', 'PHONE_ADDED']);
  });
});

// ====================================================================== line type policy
describe('the line-type policy of the market', () => {
  it('stores a MOBILE snapshot for an accepted number (the default policy blocks line types, so a lookup was needed)', async () => {
    const a = await newActor('line-mobile');
    ok(await setPhone(a, newNumber()));
    const c = (await contactsOf(a.accountId))[0]!;
    expect(c.line_type).toBe('MOBILE');
    expect(c.line_type_checked_at).toBeInstanceOf(Date);
  });

  it.each([
    ['902', 'VIRTUAL'],
    ['904', 'HIGH_RISK'],
  ])(
    'refuses a %s number (%s) with 400 ACCOUNT_PHONE_NOT_ACCEPTED: nothing is stored, nothing is sent, no detail names the vendor result',
    async (suffix, lineType) => {
      const a = await newActor(`line-${lineType}`);
      const number = newNumber(suffix);
      const before = await phoneRowCounts();
      const r = await setPhone(a, number);
      const error = fail(r, 400, 'ACCOUNT_PHONE_NOT_ACCEPTED');
      expect(error).toMatchObject({ category: 'VALIDATION', details: { reason: 'LINE_POLICY', messageKey: 'account.phone.error.not_accepted' } });
      expect(r.raw).not.toContain(lineType);
      expect(r.raw).not.toContain(number);
      expect(await contactsOf(a.accountId)).toEqual([]);
      expect(await phoneRowCounts()).toEqual(before);
      expect(await smsCount(number)).toBe(0);
      fail(await send(a), 409, 'ACCOUNT_PHONE_NOT_PENDING');
      expect(await smsCount(number)).toBe(0);
    },
  );

  it('accepts a VOIP (901) and a LANDLINE (903) number under the seeded policy and keeps the snapshot', async () => {
    for (const [suffix, lineType] of [
      ['901', 'VOIP'],
      ['903', 'LANDLINE'],
    ] as const) {
      const a = await newActor(`line-${lineType}`);
      ok(await setPhone(a, newNumber(suffix)));
      expect((await contactsOf(a.accountId))[0]!.line_type).toBe(lineType);
    }
  });

  it('refuses a VOIP number when the market blocks VOIP (policy override): nothing stored, nothing sent', async () => {
    const strict = await makeApp({ policy: { blockedLineTypes: ['VIRTUAL', 'HIGH_RISK', 'VOIP'] } });
    const a = await newActor('line-voip-blocked');
    const number = newNumber('901');
    fail(await setPhone(a, number, { app: strict }), 400, 'ACCOUNT_PHONE_NOT_ACCEPTED');
    expect(await contactsOf(a.accountId)).toEqual([]);
    expect(await smsCount(number)).toBe(0);
    ok(await setPhone(a, newNumber(), { app: strict }));
  });

  it('answers 503 ACCOUNT_PHONE_RISK_UNAVAILABLE (retryable, generic) when the lookup fails (905): nothing stored, nothing sent, and a later working number is accepted', async () => {
    const a = await newActor('line-lookup-fails');
    const number = newNumber('905');
    const before = await phoneRowCounts();
    const r = await setPhone(a, number);
    const error = fail(r, 503, 'ACCOUNT_PHONE_RISK_UNAVAILABLE');
    expect(error).toMatchObject({
      category: 'DEPENDENCY',
      message: 'The phone number could not be checked right now',
      details: { retryable: true, messageKey: 'account.phone.error.risk_unavailable' },
    });
    expect(Object.keys(error.details).sort()).toEqual(['messageKey', 'retryable']);
    expect(r.raw).not.toContain(number);
    expect(await phoneRowCounts()).toEqual(before);
    ok(await setPhone(a, newNumber()));
  });

  it('answers 503 for a lookup that never returns, within the lookup timeout, and stores nothing', async () => {
    const hanging: PhoneIntelligence = { lookup: () => new Promise(() => undefined) };
    const slow = await makeApp({ intelligence: hanging });
    const a = await newActor('line-timeout');
    const r = await setPhone(a, newNumber(), { app: slow });
    fail(r, 503, 'ACCOUNT_PHONE_RISK_UNAVAILABLE');
    expect(await contactsOf(a.accountId)).toEqual([]);
  }, 20_000);

  it("does not call the vendor again for a number that is already this account's pending number, and does not call it when the market blocks nothing", async () => {
    const counting = new CountingIntelligence();
    const watched = await makeApp({ intelligence: counting });
    const a = await newActor('line-counting');
    const number = newNumber();
    ok(await setPhone(a, number, { app: watched }));
    ok(await setPhone(a, national(number), { country: 'US', app: watched }));
    expect(counting.calls).toEqual([number]);
    const open = await makeApp({ intelligence: counting, policy: { blockedLineTypes: [] } });
    const b = await newActor('line-none-blocked');
    const free = newNumber('902');
    ok(await setPhone(b, free, { app: open }));
    expect(counting.calls).toEqual([number]);
    const c = (await contactsOf(b.accountId))[0]!;
    expect([c.line_type, c.line_type_checked_at]).toEqual([null, null]);
  });

  it('applies the snapshot again at send and at confirmation when the market starts to block the line type (no new lookup)', async () => {
    const counting = new CountingIntelligence();
    const lenient = await makeApp({ intelligence: counting, policy: { blockedLineTypes: ['HIGH_RISK'], resendSeconds: 0 } });
    const blocksVoip = await makeApp({ intelligence: counting, policy: { blockedLineTypes: ['VOIP', 'HIGH_RISK'], resendSeconds: 0 } });
    const a = await newActor('line-reapply');
    const number = newNumber('901');
    ok(await setPhone(a, number, { app: lenient }));
    const sent = await sendAgain(a, number, { app: lenient, sms: 1 });
    expect(counting.calls).toEqual([number]);
    fail(await send(a, { app: blocksVoip }), 400, 'ACCOUNT_PHONE_NOT_ACCEPTED');
    expect(await smsCount(number)).toBe(1);
    fail(await confirmCode(a, sent.code, { app: blocksVoip }), 400, 'ACCOUNT_PHONE_NOT_ACCEPTED');
    expect((await contactsOf(a.accountId))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
    expect(counting.calls).toEqual([number]);
    // the stricter market is gone again: the same code verifies
    expect(ok(await confirmCode(a, sent.code, { app: lenient })).changed).toBe(true);
  });
});

// ====================================================================== send
describe('POST /account/phone/verification/send: the verification SMS', () => {
  it('answers 409 ACCOUNT_PHONE_NOT_PENDING when there is no number waiting, and sends nothing', async () => {
    const a = await newActor('send-nothing');
    const before = await phoneRowCounts();
    const error = fail(await send(a), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    expect(error).toMatchObject({ category: 'CONFLICT', details: { messageKey: 'account.phone.error.not_pending' } });
    expect(await phoneRowCounts()).toEqual(before);
  });

  it('sends the code: ISO times, the configured code length and validity, a resend countdown, and a SENT challenge that stores a hash only', async () => {
    const a = await newActor('send-ok');
    const number = newNumber();
    ok(await setPhone(a, number));
    const r = await send(a);
    const data = ok(r);
    expect(Object.keys(data).sort()).toEqual(['codeLength', 'expiresAt', 'phone', 'resendAvailableAt', 'sentAt', 'validityMinutes']);
    expect(data).toMatchObject({ codeLength: 6, validityMinutes: 10 });
    for (const field of ['sentAt', 'expiresAt', 'resendAvailableAt']) expect(new Date(data[field]).toISOString()).toBe(data[field]);
    expect(new Date(data.expiresAt).getTime() - new Date(data.sentAt).getTime()).toBeGreaterThan(9 * 60_000);
    expect(new Date(data.expiresAt).getTime() - new Date(data.sentAt).getTime()).toBeLessThanOrEqual(10 * 60_000 + 2000);
    expect(new Date(data.resendAvailableAt).getTime() - new Date(data.sentAt).getTime()).toBeGreaterThan(25_000);
    expect(data.phone).toMatchObject({ phoneVerificationStatus: 'PENDING', pending: { maskedPhone: maskPhone(number), lastSentAt: data.sentAt } });
    const challenges = await challengesOf(a.accountId);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({
      purpose: 'INITIAL_PHONE',
      attempt_count: 0,
      used_at: null,
      invalidated_at: null,
      delivery_status: 'SENT',
      correlation_id: r.cid,
    });
    expect(challenges[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenges[0]!.last_sent_at).toBeInstanceOf(Date);
    const message = (await inbox.wait(number, 1))[0]!;
    expect(r.raw).not.toContain(extractSmsCode(message.body)!);
    delivered.add(extractSmsCode(message.body)!);
  });

  it('delivers exactly ONE concise SMS to the E.164 number: branded, the code, the expiry, no link, no account id, no placeholder, the request correlation id', async () => {
    const a = await newActor('send-sms');
    const { number, message, code, cid } = await addAndSend(a);
    const messages = await inbox.messages(number);
    expect(messages).toHaveLength(1);
    expect(message.body).toBe(`${SMS_PREFIX} ${code} is your verification code. It expires in 10 minutes. Never share this code.`);
    expect(message.body.startsWith(SMS_PREFIX)).toBe(true);
    expect(message.body.length).toBeLessThanOrEqual(160);
    expect(message.body).not.toMatch(/https?:|:\/\/|www\.|\.com|bit\.ly/i);
    expect(message.body).not.toContain(a.accountId);
    expect(message.body).not.toContain(a.sub);
    expect(message.body).not.toContain(number);
    expect(message.body).not.toMatch(/\{|\}|verification_code|expiry_minutes|undefined|null/);
    expect(message.correlationId).toBe(cid);
    expect(Number.isNaN(Date.parse(message.at))).toBe(false);
    // the code is not guessable from the account, the number or the time: another account gets a different one
    const b = await newActor('send-sms-b');
    const other = await addAndSend(b);
    expect(other.code).not.toBe(code);
  });

  it('issues a different code every time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const a = await newActor('send-codes');
      seen.add((await addAndSend(a)).code);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('writes PhoneVerificationSent with identifiers and the expiry only, never the number, the code or a hash', async () => {
    const a = await newActor('send-event');
    const { number, code } = await addAndSend(a);
    const challenge = (await challengesOf(a.accountId))[0]!;
    const contact = (await contactsOf(a.accountId))[0]!;
    const sent = (await eventsOf(a.accountId)).filter((e) => e.event_type === PHONE_EVENTS.verificationSent);
    expect(sent).toHaveLength(1);
    expect(PhoneVerificationSentPayload.parse(sent[0]!.payload_json)).toEqual({
      accountId: a.accountId,
      phoneContactId: contact.phone_contact_id,
      challengeId: challenge.challenge_id,
      purpose: 'INITIAL_PHONE',
      expiresAt: challenge.expires_at.toISOString(),
    });
    expect(sent[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${a.accountId}` });
    const text = JSON.stringify(sent[0]!.payload_json);
    for (const secret of [number, number.slice(1), code, challenge.code_hash]) expect(text).not.toContain(secret);
  });
});

// ====================================================================== confirm
describe('POST /account/phone/verification/confirm-code', () => {
  it('verifies the number with the SMS code: changed:true, /account/me reports VERIFIED with a masked primary, the challenge is consumed, one PHONE_VERIFIED audit row and one PhoneVerified event', async () => {
    const a = await newActor('confirm-ok');
    const { number, code } = await addAndSend(a);
    const r = await confirmCode(a, code);
    const data = ok(r);
    expect(data.changed).toBe(true);
    expect(data.phone).toMatchObject({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(number), countryCode: 'US', source: 'USER_ENTERED' },
      pending: null,
    });
    expect(new Date(data.phone.primary.verifiedAt).toISOString()).toBe(data.phone.primary.verifiedAt);
    expect(r.raw).not.toContain(number);
    const contact = (await contactsOf(a.accountId))[0]!;
    expect(contact).toMatchObject({ status: 'VERIFIED', is_primary: true, phone_e164: number });
    expect(contact.verified_at).toBeInstanceOf(Date);
    const challenge = (await challengesOf(a.accountId))[0]!;
    expect(challenge.used_at).toBeInstanceOf(Date);
    expect(challenge.invalidated_at).toBeNull();
    const audit = (await auditOf(a.accountId)).filter((x) => x.action === 'PHONE_VERIFIED');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toMatchObject({
      status: ['PENDING', 'VERIFIED'],
      maskedPhone: maskPhone(number),
      purpose: 'INITIAL_PHONE',
      challengeId: challenge.challenge_id,
    });
    expect(audit[0]!.correlation_id).toBe(r.cid);
    const events = (await eventsOf(a.accountId)).filter((e) => e.event_type === PHONE_EVENTS.verified);
    expect(events).toHaveLength(1);
    expect(PhoneVerifiedPayload.parse(events[0]!.payload_json)).toEqual({
      accountId: a.accountId,
      phoneContactId: contact.phone_contact_id,
      purpose: 'INITIAL_PHONE',
      replacedPhoneContactId: null,
    });
    const account = ok(await me(a));
    expect(account.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(account.contacts).toEqual({ emailVerified: false, phoneVerified: true, contactsVerified: false });
  });

  it('counts wrong codes: 400 with the attempts remaining and a message key, and the fifth wrong attempt locks the verification (429, no Retry-After); even the right code is then refused', async () => {
    const a = await newActor('confirm-wrong');
    const { code, number } = await addAndSend(a);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const e = fail(await confirmCode(a, wrongCode(code)), 400, 'ACCOUNT_PHONE_CODE_INVALID');
      expect(e).toMatchObject({ category: 'VALIDATION', details: { attemptsRemaining: 5 - attempt, messageKey: 'account.phone.error.code_invalid' } });
      expect(ok(await detail(a)).attemptsRemaining).toBe(5 - attempt);
    }
    const locked = await confirmCode(a, wrongCode(code));
    const error = fail(locked, 429, 'ACCOUNT_PHONE_VERIFICATION_LOCKED');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.phone.error.verification_locked' } });
    expect(locked.headers['retry-after']).toBeUndefined();
    fail(await confirmCode(a, code), 429, 'ACCOUNT_PHONE_VERIFICATION_LOCKED');
    const c = (await challengesOf(a.accountId))[0]!;
    expect(c).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED', used_at: null });
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    const audit = await auditOf(a.accountId);
    expect(audit.filter((x) => x.action === 'PHONE_VERIFICATION_FAILED')).toHaveLength(5);
    expect(audit.filter((x) => x.action === 'PHONE_VERIFICATION_LOCKED')).toHaveLength(1);
    const failed = (await eventsOf(a.accountId))
      .filter((e) => e.event_type === PHONE_EVENTS.verificationFailed)
      .map((e) => PhoneVerificationFailedPayload.parse(e.payload_json));
    expect(failed.map((f) => [f.attemptCount, f.locked])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
    expect(JSON.stringify([audit, failed])).not.toContain(number);
  });

  it('recovers from a lock with a new code (cooldown removed): the new SMS verifies, the locked code stays dead', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('confirm-recover');
    const first = await addAndSend(a, { app: fast });
    for (let i = 0; i < 5; i++) await confirmCode(a, wrongCode(first.code), { app: fast });
    fail(await confirmCode(a, first.code, { app: fast }), 429, 'ACCOUNT_PHONE_VERIFICATION_LOCKED');
    const second = await sendAgain(a, first.number, { app: fast, sms: 2 });
    expect(second.code).not.toBe(first.code);
    expect(ok(await confirmCode(a, second.code, { app: fast })).changed).toBe(true);
  });

  it('counts a well-formed code of the wrong length as a wrong attempt too (the length is a configuration value, not a shape rule)', async () => {
    const a = await newActor('confirm-length');
    await addAndSend(a);
    for (const code of ['1234', '1234567', '0000000000']) fail(await confirmCode(a, code), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(3);
  });

  it('answers EXPIRED for the right and for a wrong code on an expired challenge, counts no attempt, and a new send recovers', async () => {
    const a = await newActor('confirm-expired');
    const number = newNumber();
    ok(await setPhone(a, number));
    await insertExpiredChallenge(a.accountId, '424242');
    for (const code of ['424242', '000001']) {
      const e = fail(await confirmCode(a, code), 400, 'ACCOUNT_PHONE_CODE_EXPIRED');
      expect(e).toMatchObject({ category: 'VALIDATION', details: { messageKey: 'account.phone.error.code_expired' } });
    }
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    const fresh = await sendAgain(a, number, { sms: 1 });
    expect(ok(await confirmCode(a, fresh.code)).changed).toBe(true);
  });

  it('is idempotent when repeated: changed:false, no new audit row or event, the verified timestamp unchanged', async () => {
    const a = await newActor('confirm-repeat');
    const { code } = await addAndSend(a);
    ok(await confirmCode(a, code));
    const before = { counts: await phoneRowCounts(), contact: (await contactsOf(a.accountId))[0] };
    for (const c of [code, wrongCode(code), '1234']) {
      const again = ok(await confirmCode(a, c));
      expect(again.changed).toBe(false);
      expect(again.phone.phoneVerificationStatus).toBe('VERIFIED');
    }
    expect(await phoneRowCounts()).toEqual(before.counts);
    expect((await contactsOf(a.accountId))[0]!.verified_at).toEqual(before.contact!.verified_at);
  });

  it('answers 409 ACCOUNT_PHONE_NOT_PENDING with nothing to verify, and CODE_INVALID (no attempt counted) for a pending number that was never sent a code', async () => {
    const a = await newActor('confirm-nothing');
    fail(await confirmCode(a, '123456'), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    ok(await setPhone(a, newNumber()));
    fail(await confirmCode(a, '123456'), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(await challengesOf(a.accountId)).toEqual([]);
  });

  it('answers CODE_USED for the code of an SMS a resend superseded (no attempt counted), and the new code works', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('confirm-superseded');
    const first = await addAndSend(a, { app: fast });
    const second = await sendAgain(a, first.number, { app: fast, sms: 2 });
    expect(second.code).not.toBe(first.code);
    const e = fail(await confirmCode(a, first.code, { app: fast }), 400, 'ACCOUNT_PHONE_CODE_USED');
    expect(e.details).toEqual({ messageKey: 'account.phone.error.code_used' });
    const challenges = await challengesOf(a.accountId);
    expect(challenges.map((c) => [c.invalidation_reason, c.attempt_count])).toEqual([
      ['SUPERSEDED', 0],
      [null, 0],
    ]);
    expect(ok(await confirmCode(a, second.code, { app: fast })).changed).toBe(true);
  });

  it('never lets concurrent wrong guesses exceed the maximum: exactly five attempts are counted, the rest say locked', async () => {
    const a = await newActor('confirm-race-wrong');
    const { code } = await addAndSend(a);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => confirmCode(a, wrongCode(code), { ip: `198.51.100.${i + 1}` })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 400)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(8);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED' });
    fail(await confirmCode(a, code), 429, 'ACCOUNT_PHONE_VERIFICATION_LOCKED');
  });

  it('verifies EXACTLY once when two requests carry the right code at the same time: one changed:true, one idempotent, one audit row, one event', async () => {
    const a = await newActor('confirm-race-right');
    const { code } = await addAndSend(a);
    const results = await Promise.all([
      confirmCode(a, code, { ip: '198.51.100.201' }),
      confirmCode(a, code, { ip: '198.51.100.202' }),
      confirmCode(a, code, { ip: '198.51.100.203' }),
    ]);
    const changed = results.map((r) => ok(r).changed).sort();
    expect(changed).toEqual([false, false, true]);
    expect((await auditOf(a.accountId)).filter((x) => x.action === 'PHONE_VERIFIED')).toHaveLength(1);
    expect((await eventsOf(a.accountId)).filter((e) => e.event_type === PHONE_EVENTS.verified)).toHaveLength(1);
  });
});

// ====================================================================== cooldown and caps
describe('resend cooldown and caps', () => {
  it('answers a resend inside the cooldown with 429 ACCOUNT_PHONE_RESEND_TOO_SOON and a Retry-After equal to details.retryAfterSeconds, sends exactly ONE SMS, and keeps the first code valid', async () => {
    const a = await newActor('cooldown');
    const { number, code } = await addAndSend(a);
    const r = await send(a);
    const error = fail(r, 429, 'ACCOUNT_PHONE_RESEND_TOO_SOON');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.phone.error.resend_too_soon' } });
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(r.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(await smsCount(number)).toBe(1);
    expect((await challengesOf(a.accountId)).map((c) => c.invalidated_at)).toEqual([null]);
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
  });

  it('reports the resend countdown on GET /account/phone and clears it when the cooldown is over', async () => {
    const a = await newActor('cooldown-detail');
    await addAndSend(a);
    const d = ok(await detail(a));
    expect(new Date(d.resendAvailableAt).getTime()).toBeGreaterThan(Date.now());
    const noWait = await makeApp({ policy: { resendSeconds: 0 } });
    expect(ok(await detail(a, { app: noWait })).resendAvailableAt).toBeNull();
  });

  it('resends after the cooldown: two SMS, two different codes, the first code is CODE_USED, and the new one verifies', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('resend');
    const first = await addAndSend(a, { app: fast });
    const second = await sendAgain(a, first.number, { app: fast, sms: 2 });
    expect(await smsCount(first.number)).toBe(2);
    expect(second.code).not.toBe(first.code);
    fail(await confirmCode(a, first.code, { app: fast }), 400, 'ACCOUNT_PHONE_CODE_USED');
    expect(ok(await confirmCode(a, second.code, { app: fast })).changed).toBe(true);
  });

  it('enforces the hourly cap from the database: the third send is 429 ACCOUNT_PHONE_SEND_LIMIT with a Retry-After close to one hour and no third SMS', async () => {
    const low = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 2 } });
    const a = await newActor('cap-hour');
    const { number } = await addAndSend(a, { app: low });
    ok(await send(a, { app: low }));
    const r = await send(a, { app: low });
    const error = fail(r, 429, 'ACCOUNT_PHONE_SEND_LIMIT');
    expect(error.details.messageKey).toBe('account.phone.error.send_limit');
    expect(error.details.retryAfterSeconds).toBeGreaterThan(3500);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(r.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(await smsCount(number)).toBe(2);
  });

  it('enforces the daily cap too: with the hourly cap out of the way the third send of the day is 429 SEND_LIMIT with a Retry-After of about a day', async () => {
    const low = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 100, maxPerDay: 2 } });
    const a = await newActor('cap-day');
    const { number } = await addAndSend(a, { app: low });
    ok(await send(a, { app: low }));
    const error = fail(await send(a, { app: low }), 429, 'ACCOUNT_PHONE_SEND_LIMIT');
    expect(error.details.retryAfterSeconds).toBeGreaterThan(80_000);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    expect(await smsCount(number)).toBe(2);
  });

  it('counts the cap per account: another account is not held back by it', async () => {
    const low = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 1 } });
    const a = await newActor('cap-a');
    const b = await newActor('cap-b');
    await addAndSend(a, { app: low });
    fail(await send(a, { app: low }), 429, 'ACCOUNT_PHONE_SEND_LIMIT');
    await addAndSend(b, { app: low });
  });

  it('does not spend the per-number budget on a send that the cooldown refuses', async () => {
    const prefix = limiterPrefix();
    const tight = await makeApp({ limiter: newLimiter(prefix), policy: { numberPerHour: 2 } });
    const a = await newActor('cap-budget');
    const { number } = await addAndSend(a, { app: tight });
    for (let i = 0; i < 4; i++) fail(await send(a, { app: tight }), 429, 'ACCOUNT_PHONE_RESEND_TOO_SOON');
    const numberKeys = await valkey.keys(`${prefix}phone-verification:number:*`);
    expect(numberKeys).toHaveLength(1);
    expect(await valkey.get(numberKeys[0]!)).toBe('1');
    expect(await smsCount(number)).toBe(1);
  });
});

// ====================================================================== read model
describe('GET /account/phone and GET /account/me', () => {
  it('walks NONE, PENDING (set), PENDING (sent), after a wrong code, and VERIFIED on both reads', async () => {
    const a = await newActor('read-walk');
    const none = ok(await detail(a));
    expect(none).toEqual({
      phoneVerificationStatus: 'NONE',
      primary: null,
      pending: null,
      resendAvailableAt: null,
      attemptsRemaining: null,
      codeLength: 6,
      validityMinutes: 10,
    });
    expect(ok(await me(a)).phone).toEqual({ phoneVerificationStatus: 'NONE', primary: null, pending: null });
    expect(ok(await me(a)).contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    const number = newNumber();
    ok(await setPhone(a, number));
    const pending = ok(await detail(a));
    expect(pending).toMatchObject({ phoneVerificationStatus: 'PENDING', resendAvailableAt: null, attemptsRemaining: null, codeLength: 6, validityMinutes: 10 });
    expect(pending.pending).toMatchObject({ lastSentAt: null, expiresAt: null });
    const sent = await sendAgain(a, number, { sms: 1 });
    const afterSend = ok(await detail(a));
    expect(afterSend.attemptsRemaining).toBe(5);
    expect(afterSend.pending.lastSentAt).toBe(sent.data.sentAt);
    expect(afterSend.pending.expiresAt).toBe(sent.data.expiresAt);
    fail(await confirmCode(a, wrongCode(sent.code)), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(ok(await detail(a)).attemptsRemaining).toBe(4);
    expect(ok(await me(a)).phone.phoneVerificationStatus).toBe('PENDING');
    ok(await confirmCode(a, sent.code));
    const done = ok(await detail(a));
    expect(done).toMatchObject({ phoneVerificationStatus: 'VERIFIED', pending: null, resendAvailableAt: null, attemptsRemaining: null });
    expect(done.primary).toMatchObject({ maskedPhone: maskPhone(number), countryCode: 'US', source: 'USER_ENTERED' });
    expect(ok(await me(a)).phone).toEqual({ phoneVerificationStatus: 'VERIFIED', primary: done.primary, pending: null });
  });

  it('derives the contacts summary from both statuses: phone only, email only, and both (contactsVerified)', async () => {
    const a = await newActor('contacts');
    expect(ok(await me(a)).contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    await verified(a);
    expect(ok(await me(a)).contacts).toEqual({ emailVerified: false, phoneVerified: true, contactsVerified: false });
    // the email is verified through the email routes of the same app
    const address = `contacts-${randomUUID()}@example.test`;
    ok(await call(a, 'POST', '/account/email', { body: { email: address } }));
    ok(await call(a, 'POST', '/account/email/verification/send', { body: {} }));
    const mail = emailSender.sent.filter((m) => m.to === address).at(-1)!;
    ok(await call(a, 'POST', '/account/email/verification/confirm-code', { body: { code: String(mail.variables.verification_code) } }));
    const account = ok(await me(a));
    expect(account.email.emailVerificationStatus).toBe('VERIFIED');
    expect(account.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(account.contacts).toEqual({ emailVerified: true, phoneVerified: true, contactsVerified: true });
    // an account with only a verified email
    const b = await newActor('contacts-email-only');
    const other = `contacts-${randomUUID()}@example.test`;
    ok(await call(b, 'POST', '/account/email', { body: { email: other } }));
    ok(await call(b, 'POST', '/account/email/verification/send', { body: {} }));
    const otherMail = emailSender.sent.filter((m) => m.to === other).at(-1)!;
    ok(await call(b, 'POST', '/account/email/verification/confirm-code', { body: { code: String(otherMail.variables.verification_code) } }));
    expect(ok(await me(b)).contacts).toEqual({ emailVerified: true, phoneVerified: false, contactsVerified: false });
  });

  it('is masked at every stage: no response of the read model contains the number, its national form or its digits', async () => {
    const a = await newActor('read-masked');
    const number = newNumber();
    const responses: Res[] = [];
    responses.push(await setPhone(a, national(number), { country: 'US' }));
    const sent = await sendAgain(a, number, { sms: 1 });
    responses.push(await detail(a), await me(a));
    responses.push(await confirmCode(a, sent.code), await detail(a), await me(a));
    for (const r of responses) {
      for (const word of [number, number.slice(1), number.slice(2), national(number)]) expect(r.raw, `${r.method} ${r.url} holds ${word}`).not.toContain(word);
    }
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });
});

// ====================================================================== changing the number
describe('changing the verified number', () => {
  it('keeps the old primary active while the new number is pending, sends to the new number only, and swaps the primary on verification', async () => {
    const a = await newActor('change');
    const old = await verified(a);
    const fresh = newNumber();
    const set = await setPhone(a, fresh);
    const pending = ok(set);
    expect(pending.changed).toBe(true);
    expect(pending.phone).toMatchObject({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(old.number) },
      pending: { maskedPhone: maskPhone(fresh), purpose: 'CHANGE_PHONE', status: 'REPLACEMENT_PENDING' },
    });
    expect((await contactsOf(a.accountId)).map((c) => [c.phone_e164, c.status, c.is_primary])).toEqual([
      [old.number, 'VERIFIED', true],
      [fresh, 'REPLACEMENT_PENDING', false],
    ]);
    const changeEvents = (await eventsOf(a.accountId)).filter((e) => e.event_type === PHONE_EVENTS.changeRequested);
    expect(changeEvents).toHaveLength(1);
    const contacts = await contactsOf(a.accountId);
    expect(PhoneChangeRequestedPayload.parse(changeEvents[0]!.payload_json)).toEqual({
      accountId: a.accountId,
      phoneContactId: contacts[1]!.phone_contact_id,
      replacesPhoneContactId: contacts[0]!.phone_contact_id,
    });
    const smsBefore = await smsCount(old.number);
    const sent = await sendAgain(a, fresh, { sms: 1, app: await makeApp({ policy: { resendSeconds: 0 } }) });
    expect(await smsCount(old.number)).toBe(smsBefore);
    expect((await challengesOf(a.accountId)).at(-1)!.purpose).toBe('CHANGE_PHONE');
    expect(ok(await me(a)).phone.primary.maskedPhone).toBe(maskPhone(old.number));
    // the old number's code is not accepted for the new one, and the new code swaps the primary
    const swapped = ok(await confirmCode(a, sent.code));
    expect(swapped.changed).toBe(true);
    expect(swapped.phone).toMatchObject({ primary: { maskedPhone: maskPhone(fresh) }, pending: null });
    expect((await contactsOf(a.accountId)).map((c) => [c.phone_e164, c.status, c.is_primary, c.disabled_reason])).toEqual([
      [old.number, 'DISABLED', false, 'REPLACED'],
      [fresh, 'VERIFIED', true, null],
    ]);
    // rows written by one transaction share a timestamp, so the order inside a verification is not asserted
    const actions = (await auditOf(a.accountId)).map((x) => x.action);
    expect(actions.slice(0, 5)).toEqual([
      'PHONE_ADDED',
      'PHONE_VERIFICATION_REQUESTED',
      'PHONE_VERIFIED',
      'PHONE_CHANGE_REQUESTED',
      'PHONE_VERIFICATION_REQUESTED',
    ]);
    expect(actions.slice(5).sort()).toEqual(['PHONE_PRIMARY_CHANGED', 'PHONE_VERIFIED']);
    const changed = (await auditOf(a.accountId)).find((x) => x.action === 'PHONE_PRIMARY_CHANGED')!;
    expect(changed.changes).toMatchObject({ from: maskPhone(old.number), to: maskPhone(fresh) });
    const verifiedEvents = (await eventsOf(a.accountId))
      .filter((e) => e.event_type === PHONE_EVENTS.verified)
      .map((e) => PhoneVerifiedPayload.parse(e.payload_json));
    expect(verifiedEvents.at(-1)).toMatchObject({ purpose: 'CHANGE_PHONE', replacedPhoneContactId: contacts[0]!.phone_contact_id });
  });

  it('withdraws a pending change when the verified number is entered again, and entering the primary with nothing pending is a no-op', async () => {
    const a = await newActor('change-withdraw');
    const old = await verified(a);
    expect(ok(await setPhone(a, old.number)).changed).toBe(false);
    ok(await setPhone(a, newNumber()));
    const withdrawn = ok(await setPhone(a, national(old.number), { country: 'US' }));
    expect(withdrawn.changed).toBe(true);
    expect(withdrawn.phone.pending).toBeNull();
    expect((await contactsOf(a.accountId)).map((c) => [c.status, c.disabled_reason])).toEqual([
      ['VERIFIED', null],
      ['DISABLED', 'SUPERSEDED'],
    ]);
  });

  it('replaces a pending change by a newer candidate: the first candidate is SUPERSEDED, its code is dead, and only the newest can verify', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('change-newer');
    await verified(a);
    const first = newNumber();
    ok(await setPhone(a, first, { app: fast }));
    const firstSent = await sendAgain(a, first, { app: fast, sms: 1 });
    const second = newNumber();
    ok(await setPhone(a, second, { app: fast }));
    fail(await confirmCode(a, firstSent.code, { app: fast }), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    const secondSent = await sendAgain(a, second, { app: fast, sms: 1 });
    expect(ok(await confirmCode(a, secondSent.code, { app: fast })).changed).toBe(true);
    expect((await contactsOf(a.accountId)).map((c) => c.status)).toEqual(['DISABLED', 'DISABLED', 'VERIFIED']);
    expect((await contactsOf(a.accountId)).map((c) => c.phone_e164).slice(1)).toEqual([first, second]);
  });

  it('keeps a changing account on its old primary when the new number turns out to be verified elsewhere', async () => {
    const owner = await newActor('change-owner');
    const taken = await verified(owner);
    const a = await newActor('change-blocked');
    const old = await verified(a);
    ok(await setPhone(a, taken.number));
    const sent = await sendAgain(a, taken.number, { sms: 2, app: await makeApp({ policy: { resendSeconds: 0 } }) });
    const error = fail(await confirmCode(a, sent.code), 409, 'ACCOUNT_PHONE_UNAVAILABLE');
    expect(error).toMatchObject({ category: 'CONFLICT', details: { reason: 'NUMBER_UNAVAILABLE', messageKey: 'account.phone.error.unavailable' } });
    expect(ok(await me(a)).phone.primary.maskedPhone).toBe(maskPhone(old.number));
    expect((await contactsOf(a.accountId)).map((c) => [c.status, c.is_primary])).toEqual([
      ['VERIFIED', true],
      ['REPLACEMENT_PENDING', false],
    ]);
  });
});

// ====================================================================== a number verified on another account
describe('a number verified on another account (no enumeration)', () => {
  it('answers a second account exactly as for a fresh number while it only sets and sends, and refuses only when it proves the number: 409 ACCOUNT_PHONE_UNAVAILABLE', async () => {
    const owner = await newActor('dup-owner');
    const { number } = await verified(owner);
    const fresh = newNumber();
    const claimant = await newActor('dup-claimant');
    const control = await newActor('dup-control');
    const setTaken = await setPhone(claimant, number);
    const setFresh = await setPhone(control, fresh);
    ok(setTaken);
    ok(setFresh);
    expect(shape(setTaken.body.data)).toEqual(shape(setFresh.body.data));
    expect(setTaken.body.data.changed).toBe(true);
    const sentTaken = await send(claimant);
    const sentFresh = await send(control);
    expect(shape(sentTaken.body)).toEqual(shape(sentFresh.body));
    expect(Object.keys(ok(sentTaken)).sort()).toEqual(Object.keys(ok(sentFresh)).sort());
    expect((await inbox.wait(number, 2)).length).toBe(2); // the owner's SMS and the claimant's
    const claimantCode = extractSmsCode((await inbox.messages(number)).at(-1)!.body)!;
    delivered.add(claimantCode);
    // the claimant proves the phone: only now does it learn that the number is taken
    const refused = await confirmCode(claimant, claimantCode);
    const error = fail(refused, 409, 'ACCOUNT_PHONE_UNAVAILABLE');
    expect(error).toMatchObject({ category: 'CONFLICT', details: { reason: 'NUMBER_UNAVAILABLE', messageKey: 'account.phone.error.unavailable' } });
    expect(refused.raw).not.toContain(owner.accountId);
    expect(refused.raw).not.toContain(number);
    // nothing changed: the claim is still pending, the challenge is unused, the owner keeps the number
    expect((await contactsOf(claimant.accountId))[0]).toMatchObject({ status: 'PENDING', is_primary: false, verified_at: null });
    expect((await challengesOf(claimant.accountId))[0]).toMatchObject({ used_at: null, attempt_count: 0 });
    expect((await contactsOf(owner.accountId))[0]).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(ok(await me(claimant)).phone.phoneVerificationStatus).toBe('PENDING');
    expect((await auditOf(claimant.accountId)).map((x) => x.action)).toEqual(['PHONE_ADDED', 'PHONE_VERIFICATION_REQUESTED']);
  });

  it('allows the same number pending on two accounts at once: whoever proves the phone first owns it and the other gets 409', async () => {
    const number = newNumber();
    const fast = await makeApp({ policy: { resendSeconds: 0, numberPerHour: 20 } });
    const first = await newActor('dup-first');
    const second = await newActor('dup-second');
    ok(await setPhone(first, number, { app: fast }));
    ok(await setPhone(second, number, { app: fast }));
    const sentFirst = await sendAgain(first, number, { sms: 1, app: fast });
    const sentSecond = await sendAgain(second, number, { sms: 2, app: fast });
    expect(ok(await confirmCode(second, sentSecond.code, { app: fast })).changed).toBe(true);
    fail(await confirmCode(first, sentFirst.code, { app: fast }), 409, 'ACCOUNT_PHONE_UNAVAILABLE');
    expect((await contactsOf(first.accountId))[0]!.status).toBe('PENDING');
  });

  it('never has two accounts verified on one number under the default policy, even when both confirm at the same moment', async () => {
    const number = newNumber();
    const fast = await makeApp({ policy: { resendSeconds: 0, numberPerHour: 20 } });
    const actors = await Promise.all(['race-a', 'race-b', 'race-c'].map((l) => newActor(l)));
    const codes: string[] = [];
    for (const [i, a] of actors.entries()) {
      ok(await setPhone(a, number, { app: fast }));
      codes.push((await sendAgain(a, number, { sms: i + 1, app: fast })).code);
    }
    const results = await Promise.all(actors.map((a, i) => confirmCode(a, codes[i]!, { app: fast })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await count(`SELECT 1 FROM identity.phone_contacts WHERE phone_e164 = $1 AND status = 'VERIFIED'`, [number])).toBe(1);
  });
});

// ====================================================================== audit, events and secrecy
describe('audit trail, events and secrecy', () => {
  it('keeps every plaintext out of the audit rows, the events and the challenge rows: no number, no digits of it, no code, no hash', async () => {
    const a = await newActor('plaintext');
    const sent = await addAndSend(a);
    fail(await confirmCode(a, wrongCode(sent.code)), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(ok(await confirmCode(a, sent.code)).changed).toBe(true);
    const audit = JSON.stringify(await auditOf(a.accountId));
    const events = JSON.stringify(await eventsOf(a.accountId));
    const challenges = JSON.stringify(await challengesOf(a.accountId));
    for (const [what, text] of [
      ['audit', audit],
      ['events', events],
      ['challenges', challenges],
    ] as const) {
      for (const secret of [sent.number, sent.number.slice(1), sent.number.slice(2), sent.code]) expect(text, `${what} holds ${secret}`).not.toContain(secret);
    }
    expect(audit).toContain(maskPhone(sent.number));
    expect(audit + events).not.toMatch(/[0-9a-f]{64}/);
    expect(challenges).toMatch(/[0-9a-f]{64}/);
    const rows = await q<{ t: string }>(
      `SELECT 'audit' AS t FROM identity.account_audit_events WHERE changes::text LIKE $1
       UNION ALL SELECT 'outbox' FROM integration.outbox_events WHERE payload_json::text LIKE $1
       UNION ALL SELECT 'challenges' FROM identity.phone_verification_challenges WHERE correlation_id LIKE $1`,
      [`%${sent.number.slice(2)}%`],
    );
    expect(rows).toEqual([]);
  });

  it('writes the events in the identity_account aggregate with the request correlation ids and the user actor', async () => {
    const a = await newActor('events');
    const number = newNumber();
    const added = await setPhone(a, number);
    ok(added);
    const sent = await sendAgain(a, number, { sms: 1 });
    const confirmed = await confirmCode(a, sent.code);
    ok(confirmed);
    const events = await eventsOf(a.accountId);
    expect(events.map((e) => e.event_type).sort()).toEqual([PHONE_EVENTS.contactAdded, PHONE_EVENTS.verificationSent, PHONE_EVENTS.verified].sort());
    for (const e of events) expect(e).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${a.accountId}` });
    expect(events.find((e) => e.event_type === PHONE_EVENTS.contactAdded)!.correlation_id).toBe(added.cid);
    expect(events.find((e) => e.event_type === PHONE_EVENTS.verificationSent)!.correlation_id).toBe(sent.cid);
    expect(events.find((e) => e.event_type === PHONE_EVENTS.verified)!.correlation_id).toBe(confirmed.cid);
  });

  it('writes no code, number, hash key or credential to any log line, across successes, failures, a delivery failure, a lookup failure and a limiter outage', async () => {
    const logs = captureLogs();
    const a = await newActor('logs');
    const b = await newActor('logs-b');
    const sentA = await addAndSend(a);
    fail(await send(a), 429, 'ACCOUNT_PHONE_RESEND_TOO_SOON');
    fail(await confirmCode(a, wrongCode(sentA.code)), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    fail(await setPhone(b, 'not-a-number-marker'), 400, 'ACCOUNT_PHONE_INVALID');
    expect(ok(await confirmCode(a, sentA.code)).changed).toBe(true);
    const down = await makeApp({ transport: new DisabledSmsTransport() });
    const numberB = newNumber();
    ok(await setPhone(b, numberB, { app: down }));
    fail(await send(b, { app: down }), 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    const lookup = newNumber('905');
    fail(await setPhone(b, lookup), 503, 'ACCOUNT_PHONE_RISK_UNAVAILABLE');
    const outage = await makeApp({ limiter: new ValkeyRateLimiter(deadValkey, { prefix: limiterPrefix(), commandTimeoutMs: 300 }) });
    const c = await newActor('logs-c');
    fail(await setPhone(c, newNumber(), { app: outage }), 503, 'ACCOUNT_UNAVAILABLE');
    logs.stop();
    const logged = logs.lines.join('\n');
    expect(logged).toContain('request completed');
    expect(logged).toContain('rate limiter unavailable');
    expect(logged).toContain('verification SMS could not be delivered');
    expect(logged).toContain('line-type lookup failed');
    const forbidden = [
      ...numbers,
      ...numbers.map((n) => n.slice(1)),
      ...numbers.map((n) => national(n)),
      ...[...delivered].map((x) => `"${x}"`),
      HASH_KEY,
      a.token,
      b.token,
      a.sub,
      'not-a-number-marker',
      'Bearer ',
    ];
    for (const secret of forbidden) expect(logged, `a log line contains ${secret.slice(0, 16)}`).not.toContain(secret);
    expect(logged).not.toMatch(/[0-9a-f]{64}/);
  });

  it('keeps Valkey free of plaintext: the sink keys are hashes of the number, the limiter keys are opaque, and nothing holds a number or a code in its key', async () => {
    const prefix = limiterPrefix();
    const watched = await makeApp({ limiter: newLimiter(prefix) });
    const a = await newActor('valkey-keys');
    const number = newNumber();
    const ip = '203.0.113.201';
    ok(await setPhone(a, number, { app: watched, ip }));
    ok(await send(a, { app: watched, ip }));
    const sent = { code: extractSmsCode((await inbox.wait(number, 1))[0]!.body)! };
    delivered.add(sent.code);
    const sinkKeys = await valkey.keys('bananagig:fake-sms:*');
    expect(sinkKeys.length).toBeGreaterThan(0);
    for (const key of sinkKeys) expect(key, key).toMatch(/^bananagig:fake-sms:[0-9a-f]{64}$/);
    for (const key of sinkKeys) for (const secret of [number, number.slice(1), number.slice(2)]) expect(key).not.toContain(secret);
    const stored = await valkey.keys(`${prefix}*`);
    expect(stored.map((k) => k.slice(prefix.length).split(':').slice(0, 2).join(':')).sort()).toEqual([
      'phone-verification:account',
      'phone-verification:ip',
      'phone-verification:number',
    ]);
    for (const key of stored) {
      for (const secret of [number, number.slice(1), number.slice(2), ip, sent.code]) expect(key).not.toContain(secret);
      const [name, dimension, value] = key.slice(prefix.length).split(':') as [string, string, string];
      expect(name).toBe('phone-verification');
      expect(value).toBe(dimension === 'account' ? a.accountId : value);
      if (dimension !== 'account') expect(value).toMatch(/^[0-9a-f]{32}$/);
      const ttl = await valkey.ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(3600);
    }
    expect(stored).toContain(`${prefix}phone-verification:number:${hashDimension(HASH_KEY, 'phone', number)}`);
    expect(stored).toContain(`${prefix}phone-verification:ip:${hashDimension(HASH_KEY, 'ip', ip)}`);
  });
});

// ====================================================================== abuse limits on a real Valkey
describe('abuse limits through a real Valkey', () => {
  it('refuses the request over the per-account limit with 429 ACCOUNT_PHONE_RATE_LIMITED and a Retry-After, counting nothing for the refused request', async () => {
    const low = await makeApp({ policy: { requestsPerHour: 3, resendSeconds: 0 }, limiter: newLimiter() });
    const a = await newActor('limit-account');
    const number = newNumber();
    const anyIp = () => ({ app: low, ip: nextIp() }); // a different source address each time: only the account dimension can refuse
    ok(await setPhone(a, number, anyIp())); // 1
    ok(await send(a, anyIp())); // 2
    const code = extractSmsCode((await inbox.wait(number, 1))[0]!.body)!;
    fail(await confirmCode(a, wrongCode(code), anyIp()), 400, 'ACCOUNT_PHONE_CODE_INVALID'); // 3
    const refused = await confirmCode(a, wrongCode(code), anyIp()); // 4: over the limit
    const error = fail(refused, 429, 'ACCOUNT_PHONE_RATE_LIMITED');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.phone.error.rate_limited' } });
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(refused.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(Object.keys(error.details).sort()).toEqual(['messageKey', 'retryAfterSeconds']);
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(1);
    expect(ok(await detail(a, { app: low })).attemptsRemaining).toBe(4);
    const b = await newActor('limit-account-b');
    ok(await setPhone(b, newNumber(), { app: low }));
  });

  it('limits a source address across accounts without ever saying so: the answer has the same shape as the account limit', async () => {
    const low = await makeApp({ policy: { requestsPerHour: 3, resendSeconds: 0 }, limiter: newLimiter() });
    const a = await newActor('limit-ip-a');
    const b = await newActor('limit-ip-b');
    const c = await newActor('limit-ip-c');
    const sharedIp = '198.51.100.77';
    const number = newNumber();
    ok(await setPhone(a, number, { app: low, ip: sharedIp })); // 1
    ok(await send(a, { app: low, ip: sharedIp })); // 2
    fail(await confirmCode(a, '000000', { app: low, ip: sharedIp }), 400, 'ACCOUNT_PHONE_CODE_INVALID'); // 3
    const accountLimited = fail(await confirmCode(a, '000000', { app: low, ip: sharedIp }), 429, 'ACCOUNT_PHONE_RATE_LIMITED');
    const ipLimited = fail(await setPhone(b, newNumber(), { app: low, ip: sharedIp }), 429, 'ACCOUNT_PHONE_RATE_LIMITED');
    expect(shape(ipLimited.details)).toEqual(shape(accountLimited.details));
    expect(ipLimited.message).toBe(accountLimited.message);
    expect(Object.keys(ipLimited).sort()).toEqual(Object.keys(accountLimited).sort());
    for (const text of [JSON.stringify(ipLimited), JSON.stringify(accountLimited)]) expect(text).not.toMatch(/\bip\b|source|number|device|client|198\.51/i);
    expect(await contactsOf(b.accountId)).toEqual([]);
    ok(await setPhone(b, newNumber(), { app: low, ip: nextIp() }));
    ok(await setPhone(c, newNumber(), { app: low, ip: null }));
  });

  it('limits the sends to one number across accounts and sources (SMS flooding): the third account is refused, nothing is sent for it', async () => {
    const low = await makeApp({ policy: { numberPerHour: 2, resendSeconds: 0 }, limiter: newLimiter() });
    const victim = newNumber();
    const senders = [await newActor('flood-a'), await newActor('flood-b'), await newActor('flood-c')];
    for (const s of senders) ok(await setPhone(s, victim, { app: low }));
    ok(await send(senders[0]!, { app: low }));
    ok(await send(senders[1]!, { app: low }));
    const refused = await send(senders[2]!, { app: low });
    const error = fail(refused, 429, 'ACCOUNT_PHONE_RATE_LIMITED');
    expect(refused.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(JSON.stringify(error)).not.toMatch(/\bnumber\b|victim|\+1/i);
    expect(await inbox.wait(victim, 2)).toHaveLength(2);
    expect(await smsCount(victim)).toBe(2);
    expect(await challengesOf(senders[2]!.accountId)).toEqual([]);
  });

  it('fails CLOSED when the limiter is down: setting the number and sending answer 503 ACCOUNT_UNAVAILABLE (generic), create and send nothing, while confirming and reading still work', async () => {
    const a = await newActor('outage');
    const { number, code } = await addAndSend(a);
    const outage = await makeApp({ limiter: new ValkeyRateLimiter(deadValkey, { prefix: limiterPrefix(), commandTimeoutMs: 300 }) });
    const c = await newActor('outage-c');
    const set = await setPhone(c, newNumber(), { app: outage });
    const error = fail(set, 503, 'ACCOUNT_UNAVAILABLE');
    expect(error).toMatchObject({ category: 'DEPENDENCY', message: 'The account service is temporarily unavailable' });
    expect(error.details).toBeUndefined();
    for (const leak of ['RATE_LIMITER', 'valkey', 'Valkey', 'redis', '127.0.0.1', ':1']) expect(set.raw).not.toContain(leak);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(await contactsOf(c.accountId)).toEqual([]);
    const fast = await makeApp({
      policy: { resendSeconds: 0 },
      limiter: new ValkeyRateLimiter(deadValkey, { prefix: limiterPrefix(), commandTimeoutMs: 300 }),
    });
    fail(await send(a, { app: fast }), 503, 'ACCOUNT_UNAVAILABLE');
    expect(await smsCount(number)).toBe(1);
    expect(await challengesOf(a.accountId)).toHaveLength(1);
    // the attempt counter in PostgreSQL still protects confirmation, so confirming does not need the limiter
    expect(ok(await detail(a, { app: outage })).phoneVerificationStatus).toBe('PENDING');
    fail(await confirmCode(a, wrongCode(code), { app: outage }), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect(ok(await confirmCode(a, code, { app: outage })).changed).toBe(true);
  });

  it('does not limit anything when no limiter is configured, and the database limits (cooldown) still apply', async () => {
    const bare = await makeApp({ limiter: null });
    const a = await newActor('nolimiter');
    const { number } = await addAndSend(a, { app: bare });
    fail(await send(a, { app: bare }), 429, 'ACCOUNT_PHONE_RESEND_TOO_SOON');
    expect(await smsCount(number)).toBe(1);
  });
});

// ====================================================================== delivery failures
describe('delivery failures', () => {
  it('answers 503 ACCOUNT_PHONE_DELIVERY_FAILED (retryable false) when SMS delivery is disabled, closes the challenge, starts no cooldown, and a later send works', async () => {
    const disabled = await makeApp({ transport: new DisabledSmsTransport() });
    const a = await newActor('disabled');
    const number = newNumber();
    ok(await setPhone(a, number, { app: disabled }));
    const r = await send(a, { app: disabled });
    const error = fail(r, 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    expect(error).toMatchObject({
      category: 'DEPENDENCY',
      message: 'The verification text could not be sent',
      details: { retryable: false, messageKey: 'account.phone.error.delivery_failed' },
    });
    expect(Object.keys(error.details).sort()).toEqual(['messageKey', 'retryable']);
    for (const leak of [number, 'provider', 'NOT_CONFIGURED', 'SMS_TRANSPORT']) expect(r.raw).not.toContain(leak);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED', last_sent_at: null });
    // no cooldown: the next attempt reaches the transport again instead of waiting
    fail(await send(a, { app: disabled }), 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    expect(await smsCount(number)).toBe(0);
    const working = await sendAgain(a, number, { sms: 1 });
    expect(ok(await confirmCode(a, working.code)).changed).toBe(true);
  });

  it('answers a retryable failure of the provider as retryable: true, and the failed code never verifies', async () => {
    let attempts = 0;
    const flaky: SmsTransport = {
      deliver: async () => {
        attempts += 1;
        throw new SmsDeliveryError('UNAVAILABLE', 'the provider is down', true);
      },
    };
    const down = await makeApp({ transport: flaky });
    const a = await newActor('flaky');
    ok(await setPhone(a, newNumber(), { app: down }));
    const error = fail(await send(a, { app: down }), 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    expect(error.details).toEqual({ retryable: true, messageKey: 'account.phone.error.delivery_failed' });
    expect(attempts).toBe(1);
    fail(await confirmCode(a, '123456', { app: down }), 400, 'ACCOUNT_PHONE_CODE_INVALID');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
  });

  it('treats an unexpected transport failure as a retryable delivery failure without any detail of the cause', async () => {
    const broken: SmsTransport = {
      deliver: async () => {
        throw new Error('socket hang up 10.1.2.3 password=hunter2');
      },
    };
    const down = await makeApp({ transport: broken });
    const a = await newActor('broken');
    ok(await setPhone(a, newNumber(), { app: down }));
    const r = await send(a, { app: down });
    fail(r, 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    for (const leak of ['hunter2', '10.1.2.3', 'socket']) expect(r.raw).not.toContain(leak);
  });

  it('counts failed deliveries towards the hourly cap, so a failing provider cannot be hammered either', async () => {
    const down = await makeApp({ transport: new DisabledSmsTransport(), policy: { maxPerHour: 2, resendSeconds: 0 } });
    const a = await newActor('failcap');
    ok(await setPhone(a, newNumber(), { app: down }));
    fail(await send(a, { app: down }), 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    fail(await send(a, { app: down }), 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    fail(await send(a, { app: down }), 429, 'ACCOUNT_PHONE_SEND_LIMIT');
  });

  it('answers the generic 503 when the SMS sink itself (Valkey) is unreachable, retryable, and nothing leaks', async () => {
    const deadSink = await makeApp({ transport: new ValkeyFakeSmsTransport(deadValkey, 'test') });
    const a = await newActor('deadsink');
    ok(await setPhone(a, newNumber(), { app: deadSink }));
    const r = await send(a, { app: deadSink });
    const error = fail(r, 503, 'ACCOUNT_PHONE_DELIVERY_FAILED');
    expect(error.details.retryable).toBe(true);
    for (const leak of ['valkey', 'redis', 'ECONNREFUSED', '127.0.0.1']) expect(r.raw.toLowerCase()).not.toContain(leak.toLowerCase());
  }, 20_000);
});

// ====================================================================== account status gates
describe('account status gates the phone routes', () => {
  it('refuses a SUSPENDED account on all four routes with 403 ACCOUNT_SUSPENDED (no SMS, no change) and serves it again once reactivated', async () => {
    const a = await newActor('suspended');
    const { number, code } = await addAndSend(a);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'integration test' });
    const before = await phoneRowCounts();
    for (const [, method, url, body] of ROUTES_OF_PHONE) {
      const error = fail(await call(a, method, url, { body: method === 'POST' && url.endsWith('confirm-code') ? { code } : body }), 403, 'ACCOUNT_SUSPENDED');
      expect(error.category).toBe('AUTHORIZATION');
    }
    expect(await phoneRowCounts()).toEqual(before);
    expect(await smsCount(number)).toBe(1);
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest', reason: 'integration test' });
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
  });

  it('refuses a CLOSED account with 403 ACCOUNT_CLOSED, and a closed account cannot receive a number', async () => {
    const a = await newActor('closed');
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(a.accountId, 'CLOSED', { actor: 'system:itest', reason: 'integration test' });
    for (const [, method, url, body] of ROUTES_OF_PHONE) fail(await call(a, method, url, { body }), 403, 'ACCOUNT_CLOSED');
    expect(await contactsOf(a.accountId)).toEqual([]);
  });
});

// ====================================================================== the client address behind the proxy (DEBT-0055)
describe('DEBT-0055: the client address is the entry the trusted proxy wrote', () => {
  const confirmNothing = (a: Actor, appOf: FastifyInstance, forwarded: string | null) =>
    call(a, 'POST', `${PHONE}/verification/confirm-code`, { body: { code: '123456' }, app: appOf, ip: forwarded });

  it('with one proxy hop, requests with the forwarding chains "spoof-a, real" and "spoof-b, real" land in the SAME source-address bucket', async () => {
    const prefix = limiterPrefix();
    const hop1 = await makeApp({ hops: 1, limiter: newLimiter(prefix) });
    const a = await newActor('ip-a');
    const b = await newActor('ip-b');
    const real = '203.0.113.50';
    fail(await confirmNothing(a, hop1, `spoof-a, ${real}`), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    fail(await confirmNothing(b, hop1, `spoof-b, ${real}`), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    fail(await confirmNothing(a, hop1, `198.51.100.99, 10.0.0.1, ${real}`), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    const ipKeys = await valkey.keys(`${prefix}phone-verification:ip:*`);
    expect(ipKeys).toEqual([`${prefix}phone-verification:ip:${hashDimension(HASH_KEY, 'ip', real)}`]);
    expect(await valkey.get(ipKeys[0]!)).toBe('3');
    // a different real address is a different bucket
    fail(await confirmNothing(a, hop1, `spoof-a, 203.0.113.51`), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    expect(await valkey.keys(`${prefix}phone-verification:ip:*`)).toHaveLength(2);
  });

  it('with one proxy hop a client cannot evade the source-address limit by varying its own forwarding entry', async () => {
    const low = await makeApp({ hops: 1, policy: { requestsPerHour: 3 }, limiter: newLimiter() });
    const real = '203.0.113.60';
    const results: Res[] = [];
    for (let i = 0; i < 4; i++) results.push(await confirmNothing(await newActor(`ip-evade-${i}`), low, `evade-${i}, ${real}`));
    expect(results.map((r) => r.status)).toEqual([409, 409, 409, 429]);
    expect(results[3]!.body.error.code).toBe('ACCOUNT_PHONE_RATE_LIMITED');
  });

  it('with zero proxy hops the forwarding header is ignored entirely: every request lands in the socket address bucket', async () => {
    const prefix = limiterPrefix();
    const hop0 = await makeApp({ hops: 0, limiter: newLimiter(prefix) });
    const a = await newActor('ip-zero-a');
    const b = await newActor('ip-zero-b');
    fail(await confirmNothing(a, hop0, 'spoof-a, 203.0.113.70'), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    fail(await confirmNothing(b, hop0, '198.51.100.1'), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    fail(await confirmNothing(b, hop0, null), 409, 'ACCOUNT_PHONE_NOT_PENDING');
    const ipKeys = await valkey.keys(`${prefix}phone-verification:ip:*`);
    expect(ipKeys).toEqual([`${prefix}phone-verification:ip:${hashDimension(HASH_KEY, 'ip', '127.0.0.1')}`]);
    expect(await valkey.get(ipKeys[0]!)).toBe('3');
  });

  it('with zero proxy hops a client cannot create buckets (or leave its own) by choosing a header', async () => {
    const low = await makeApp({ hops: 0, policy: { requestsPerHour: 2 }, limiter: newLimiter() });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await confirmNothing(await newActor(`ip-zero-${i}`), low, `10.20.30.${i}`)).status);
    expect(statuses).toEqual([409, 409, 429]);
  });
});

// ====================================================================== public surface and the whole run
describe('public endpoints and the whole run', () => {
  it('exposes no phone number, code or hash on the public content and geography endpoints: the copy is public reference text, and the SMS cannot be rendered without the values', async () => {
    const templated = ['sms.verification.phone.body', 'account.phone.verify.intro', 'account.phone.verify.resend_wait'];
    const plain = (await content.listEntries()).map((e) => e.key).filter((k) => k.startsWith('account.phone.') && !templated.includes(k));
    expect(plain).toHaveLength(30);
    const locales = await call(undefined, 'GET', '/content/locales', { ip: null });
    const countries = await call(undefined, 'GET', '/geography/countries', { ip: null });
    const copy = await call(undefined, 'POST', '/content/resolve-many', { body: { keys: plain, locale: 'en-US' }, ip: null });
    for (const r of [locales, countries, copy]) expect(r.status, r.raw.slice(0, 200)).toBe(200);
    expect(copy.body.data.items).toHaveLength(30);
    const bare = await call(undefined, 'POST', '/content/resolve', { body: { key: 'sms.verification.phone.body', locale: 'en-US' }, ip: null });
    expect(bare.status).toBe(400);
    expect(bare.body.error.details).toMatchObject({ reason: 'MISSING_REQUIRED_VARIABLE' });
    const text = [locales, countries, copy, bare].map((r) => r.raw).join('\n');
    expect(numbers.length).toBeGreaterThan(40);
    expect(delivered.size).toBeGreaterThan(20);
    for (const secret of [...numbers, ...numbers.map((n) => n.slice(2)), ...[...delivered].map((c) => `"${c}"`), HASH_KEY]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/phone_e164|code_hash|line_type/);
  });

  it('keeps the invariants of the whole run: one primary per account, one open candidate per account, no open challenge on a closed contact, hashes only, a number verified once under the default policy', async () => {
    expect(await q(`SELECT account_id FROM identity.phone_contacts WHERE is_primary GROUP BY account_id HAVING count(*) > 1`)).toEqual([]);
    expect(
      await q(`SELECT account_id FROM identity.phone_contacts WHERE status IN ('PENDING', 'REPLACEMENT_PENDING') GROUP BY account_id HAVING count(*) > 1`),
    ).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k ON k.phone_contact_id = c.phone_contact_id
          WHERE c.used_at IS NULL AND c.invalidated_at IS NULL AND k.status NOT IN ('PENDING', 'REPLACEMENT_PENDING')`,
      ),
    ).toEqual([]);
    expect(await q(`SELECT 1 FROM identity.phone_verification_challenges WHERE code_hash !~ '^[0-9a-f]{64}$'`)).toEqual([]);
    for (const code of delivered) expect(await q(`SELECT 1 FROM identity.phone_verification_challenges WHERE code_hash = $1`, [code])).toEqual([]);
    expect(await q(`SELECT 1 FROM identity.phone_contacts WHERE phone_e164 !~ '^\\+[1-9][0-9]{6,14}$'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM identity.phone_contacts WHERE status = 'VERIFIED' AND NOT is_primary`)).toEqual([]);
    expect(
      await q(`SELECT phone_e164 FROM identity.phone_contacts WHERE status = 'VERIFIED' GROUP BY phone_e164 HAVING count(DISTINCT account_id) > 1`),
    ).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM identity.accounts a WHERE EXISTS (SELECT 1 FROM identity.phone_contacts c WHERE c.account_id = a.account_id AND c.is_primary) AND a.status = 'PENDING'`,
      ),
    ).toEqual([]);
  });

  it('sent every phone response of this run with Cache-Control: no-store, exactly the documented shapes, and Retry-After only on 429s', async () => {
    const phoneResponses = transcript.filter((r) => r.url.startsWith('/api/v1/account/phone') || r.url === '/api/v1/account/me');
    expect(phoneResponses.length).toBeGreaterThan(300);
    for (const r of phoneResponses.filter((x) => x.body !== undefined)) {
      expect(r.headers['cache-control'], `${r.method} ${r.url} ${r.status}`).toBe('no-store');
      if (r.status !== 429) expect(r.headers['retry-after'], `${r.method} ${r.url} ${r.status}`).toBeUndefined();
      expect(Object.keys(r.body).sort(), r.raw.slice(0, 120)).toEqual(r.status === 200 ? ['data', 'meta'] : ['error']);
    }
    const secrets = [...[...delivered].map((c) => `"${c}"`), HASH_KEY, ...numbers, ...numbers.map((n) => n.slice(2))];
    for (const r of transcript.filter((x) => x.url.startsWith('/api/v1/account/'))) {
      const text = `${r.raw}\n${JSON.stringify(r.headers)}`;
      for (const secret of secrets) if (text.includes(secret)) throw new Error(`${r.method} ${r.url} ${r.status} contains ${secret.slice(0, 20)}`);
    }
    for (const r of phoneResponses.filter((x) => x.status >= 400)) expect(ErrorResponse.safeParse(r.body).success, r.raw.slice(0, 160)).toBe(true);
    for (const r of phoneResponses.filter((x) => x.status === 200)) expect(r.body.meta.correlationId).toBe(r.cid);
  });

  it('exhausted every phone error code of the contract at least once across the run', () => {
    const seen = new Set(transcript.filter((r) => r.status >= 400 && r.body?.error?.code).map((r) => r.body.error.code as string));
    const missing = PHONE_ERROR_CODES.filter((c) => !seen.has(`ACCOUNT_${c}`));
    expect(missing).toEqual([]);
  });
});

// ====================================================================== country and market policy through the real configuration registry
describe('country-scoped policy (accounts per number, blocked line types)', () => {
  it('a COUNTRY-scoped accounts-per-number value of 2 for US resolves to 2 for US and 1 for no country; two accounts then verify one number and the third is refused', async () => {
    await setCountryValue('verification.phone.max_accounts_per_number', 'US', 2);
    expect((await realPolicy.policy('US')).maxAccountsPerNumber).toBe(2);
    expect((await realPolicy.policy()).maxAccountsPerNumber).toBe(1);
    expect((await realPolicy.policy('CA')).maxAccountsPerNumber).toBe(1);
    const { values } = await configuration.resolveMany(['verification.phone.max_accounts_per_number'], { country: 'US' });
    expect(values.get('verification.phone.max_accounts_per_number')).toMatchObject({ value: 2, criticality: 'CRITICAL', sourceScope: 'COUNTRY' });
    const number = newNumber();
    const noCooldown = await makeApp({ policy: { resendSeconds: 0, numberPerHour: 50 } });
    // policyWith spreads the real per-country policy first, so the COUNTRY value of 2 still applies in this app
    const first = await newActor('count-first');
    const second = await newActor('count-second');
    const third = await newActor('count-third');
    for (const [i, a] of [first, second, third].entries()) {
      ok(await setPhone(a, number, { app: noCooldown }));
      const sent = await sendAgain(a, number, { sms: i + 1, app: noCooldown });
      if (i < 2) expect(ok(await confirmCode(a, sent.code, { app: noCooldown })).changed).toBe(true);
      else {
        const error = fail(await confirmCode(a, sent.code, { app: noCooldown }), 409, 'ACCOUNT_PHONE_UNAVAILABLE');
        expect(error.details.reason).toBe('NUMBER_UNAVAILABLE');
      }
    }
    expect(await count(`SELECT 1 FROM identity.phone_contacts WHERE phone_e164 = $1 AND status = 'VERIFIED'`, [number])).toBe(2);
    expect((await contactsOf(third.accountId))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
    // the guard trigger enforces the same ceiling on its own, with the value the service would pass
    const refused = (await rejection(
      iso.database.transaction(async (trx) => {
        await sql`SELECT set_config('app.phone_max_accounts', '2', true)`.execute(trx);
        await sql`UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE account_id = ${third.accountId} AND status = 'PENDING'`.execute(
          trx,
        );
      }),
    )) as { detail?: string } | undefined;
    expect(refused?.detail).toBe('identity_rule:PHONE_NUMBER_CAP');
    expect((await contactsOf(third.accountId))[0]!.status).toBe('PENDING');
  });

  it('a COUNTRY-scoped blocked_line_types of [] for US stops the vendor lookup: a VIRTUAL number is accepted and no snapshot is stored', async () => {
    const counting = new CountingIntelligence();
    const watched = await makeApp({ intelligence: counting });
    const before = await newActor('blocked-before');
    const virtual = newNumber('902');
    fail(await setPhone(before, virtual, { app: watched }), 400, 'ACCOUNT_PHONE_NOT_ACCEPTED');
    expect(counting.calls).toEqual([virtual]);
    await setCountryValue('verification.phone.blocked_line_types', 'US', []);
    expect((await realPolicy.policy('US')).blockedLineTypes).toEqual([]);
    expect((await realPolicy.policy()).blockedLineTypes).toEqual(['VIRTUAL', 'HIGH_RISK']);
    const after = await newActor('blocked-after');
    const calls = counting.calls.length;
    ok(await setPhone(after, virtual, { app: watched }));
    expect(counting.calls.length).toBe(calls);
    const c = (await contactsOf(after.accountId))[0]!;
    expect([c.status, c.line_type, c.line_type_checked_at]).toEqual(['PENDING', null, null]);
    // and a high-risk number is accepted as well: the country decides
    ok(await setPhone(await newActor('blocked-after-2'), newNumber('904'), { app: watched }));
  });
});

// ====================================================================== a second ACTIVE country
describe('a second ACTIVE country sharing the +1 calling code', () => {
  let both: FastifyInstance;
  let caDirectory: PhoneCountryDirectory;
  beforeAll(async () => {
    await makeCountry('CA', 'CAN', '124', '+1', 'ACTIVE');
    // a fresh geography service: the first one cached the list of active countries
    caDirectory = directoryFor(freshGeography());
    both = await makeApp({ countries: caDirectory });
  });

  /** A fresh valid Canadian (416) number that the fake classifier calls MOBILE. */
  const caNumber = (): string => {
    for (;;) {
      const line = randomInt(0, 900);
      const n = `+1416555${randomInt(10)}${String(line).padStart(3, '0')}`;
      if (numbers.includes(n)) continue;
      numbers.push(n);
      return n;
    }
  };

  it('stores the country of the NUMBER: a +1 416 number is CA, whatever the hint says', async () => {
    const a = await newActor('ca-number');
    const n = caNumber();
    const set = ok(await setPhone(a, n, { app: both, country: 'US' }));
    expect(set.phone.pending.countryCode).toBe('CA');
    expect((await contactsOf(a.accountId))[0]!.country_code).toBe('CA');
    const b = await newActor('ca-national');
    const m = caNumber();
    expect(ok(await setPhone(b, `(${m.slice(2, 5)}) ${m.slice(5, 8)}-${m.slice(8)}`, { app: both, country: 'CA' })).phone.pending.countryCode).toBe('CA');
  });

  it('still stores a US number as US', async () => {
    const a = await newActor('ca-us');
    expect(ok(await setPhone(a, newNumber(), { app: both })).phone.pending.countryCode).toBe('US');
  });

  it('needs a country for a national number now that two countries are ACTIVE: COUNTRY_REQUIRED, nothing stored', async () => {
    const a = await newActor('ca-required');
    const error = fail(await setPhone(a, '(416) 555-0123', { app: both }), 400, 'ACCOUNT_PHONE_INVALID');
    expect(error.details).toEqual({ reason: 'COUNTRY_REQUIRED', messageKey: 'account.phone.error.country_required' });
    expect(await contactsOf(a.accountId)).toEqual([]);
  });

  it("applies the policy of the number's country: the US override (2 accounts per number) does not apply to a CA number", async () => {
    const number = caNumber();
    const noCooldown = await makeApp({ policy: { resendSeconds: 0, numberPerHour: 50 }, countries: caDirectory });
    const first = await newActor('ca-first');
    const second = await newActor('ca-second');
    for (const [i, a] of [first, second].entries()) {
      ok(await setPhone(a, number, { app: noCooldown }));
      const sent = await sendAgain(a, number, { sms: i + 1, app: noCooldown });
      if (i === 0) expect(ok(await confirmCode(a, sent.code, { app: noCooldown })).changed).toBe(true);
      else fail(await confirmCode(a, sent.code, { app: noCooldown }), 409, 'ACCOUNT_PHONE_UNAVAILABLE');
    }
    expect((await realPolicy.policy('CA')).maxAccountsPerNumber).toBe(1);
    expect((await realPolicy.policy('US')).maxAccountsPerNumber).toBe(2);
  });
});
