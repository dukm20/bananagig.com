// ID-002 email contact and verification over HTTP, with the REAL services on one real, isolated PostgreSQL (migration 0010 seeds the eight
// verification.email.* parameters and the 34 account.email.* copy entries), the real configuration registry (CRITICAL limits, read fresh), the real
// content registry and email renderer, the production SMTP adapter delivering to Mailpit, the production Valkey rate limiter on a real Valkey, the real auth
// plugin and forged-but-signed tokens. The account comes from the verified token only; this file proves the checkpoint's integration list end to end:
// the initial address, the send, the delivered message, the code and the magic link, wrong and expired codes, idempotent repeats, cooldown and caps, an
// address verified elsewhere (no enumeration), changing the primary address, the audit trail and events, abuse limits, fail-closed behavior and secrecy.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AccountService,
  EmailVerificationService,
  hashMagicToken,
  hashVerificationCode,
  parseEmailVerificationPolicy,
  type EmailVerificationPolicy,
  type VerificationPolicyProvider,
} from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import {
  AccountEmailResponse,
  CORRELATION_HEADER,
  EMAIL_ERROR_CODES,
  EMAIL_EVENTS,
  EMAIL_ISSUE_CODES,
  EMAIL_VERIFICATION_STATUSES,
  EmailChangeRequestedPayload,
  EmailContactAddedPayload,
  EmailVerificationFailedPayload,
  EmailVerificationSentPayload,
  EmailVerifiedPayload,
  ErrorResponse,
  emailErrorMessageKey,
  emailIssueMessageKey,
  emailStatusLabelKey,
  maskEmail,
} from '@bananagig/contracts';
import { ContentService } from '@bananagig/content';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { SmtpEmailSender, ValkeyRateLimiter, closeValkey, createValkey, type EmailSender, type RateLimiter } from '@bananagig/platform';
import {
  createIsolatedDatabase,
  deleteMailpitMessagesTo,
  extractVerification,
  mailpitMessagesTo,
  waitForMailpitMessages,
  type IsolatedDatabase,
} from '@bananagig/testing';
import { buildApp } from './app';
import { createContentEmailRenderer, createVerificationLinkBuilder, createVerificationPolicyProvider } from './modules/account/email-wiring';

// ---------------------------------------------------------------- the real stack
const HASH_KEY = 'itest-verification-hash-key-'.concat('k'.repeat(24));
const cfg = loadConfig({
  service: 'bananagig-api',
  env: { NODE_ENV: 'test', VERIFICATION_HASH_SECRET: HASH_KEY, ...(process.env.VALKEY_URL ? { VALKEY_URL: process.env.VALKEY_URL } : {}) },
});
const SMTP = {
  host: process.env.SMTP_HOST ?? '127.0.0.1',
  port: Number(process.env.SMTP_PORT ?? 11025),
  from: 'no-reply@bananagig.localhost',
  insecureLocal: true,
};
const FROM = SMTP.from;
const SUBJECT = 'Your BananaGig verification code';

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let content: ContentService;
let realPolicy: VerificationPolicyProvider;
let goodSender: SmtpEmailSender;
let mainLimiter: RateLimiter;
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
const addresses: string[] = [];
/** Every code and magic-link token that was delivered, so the secrecy checks know what must never show up anywhere else. */
const delivered = { codes: new Set<string>(), tokens: new Set<string>() };

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
  return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.7`;
};
const newAddress = (label = 'ana'): string => {
  const a = `${label}-${randomUUID()}@example.test`;
  addresses.push(a);
  return a;
};
const localOf = (address: string): string => address.split('@')[0]!;

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

const EMAIL = '/account/email';
const me = (a: Actor, o?: CallOptions) => call(a, 'GET', '/account/me', o);
const detail = (a: Actor, o?: CallOptions) => call(a, 'GET', EMAIL, o);
const setEmail = (a: Actor, email: unknown, o?: CallOptions) => call(a, 'POST', EMAIL, { ...o, body: { email } });
const send = (a: Actor, o?: CallOptions) => call(a, 'POST', `${EMAIL}/verification/send`, { ...o, body: {} });
const confirmCode = (a: Actor, code: unknown, o?: CallOptions) => call(a, 'POST', `${EMAIL}/verification/confirm-code`, { ...o, body: { code } });
const confirmLink = (a: Actor, token: unknown, o?: CallOptions) => call(a, 'POST', `${EMAIL}/verification/confirm-link`, { ...o, body: { token } });
const ROUTES_OF_EMAIL: [string, 'GET' | 'POST', string, unknown][] = [
  ['getAccountEmail', 'GET', EMAIL, undefined],
  ['setAccountEmail', 'POST', EMAIL, { email: 'ana@example.test' }],
  ['sendAccountEmailVerification', 'POST', `${EMAIL}/verification/send`, {}],
  ['confirmAccountEmailCode', 'POST', `${EMAIL}/verification/confirm-code`, { code: '123456' }],
  ['confirmAccountEmailLink', 'POST', `${EMAIL}/verification/confirm-link`, { token: 'a'.repeat(43) }],
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

// ---------------------------------------------------------------- the mailbox (Mailpit)
interface Mail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string[]>;
  code: string | null;
  token: string | null;
  url: string | null;
}
/** Waits for `count` messages to the address and returns them oldest first, with the code and link extracted; registers what was delivered. */
async function mailOf(address: string, count = 1): Promise<Mail[]> {
  const messages = await waitForMailpitMessages(address.toLowerCase(), count);
  return messages.map((m) => {
    const x = extractVerification(m);
    if (x.code) delivered.codes.add(x.code);
    if (x.token) delivered.tokens.add(x.token);
    return { to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers, ...x };
  });
}
const inboxSize = async (address: string): Promise<number> => (await mailpitMessagesTo(address.toLowerCase())).length;

/** Sets the address and sends the verification; returns what the mailbox received. */
async function addAndSend(a: Actor, o: { address?: string; app?: FastifyInstance; mails?: number } = {}) {
  const address = o.address ?? newAddress();
  ok(await setEmail(a, address, { app: o.app }));
  return { address, ...(await sendAgain(a, address, { app: o.app, mails: o.mails ?? 1 })) };
}
async function sendAgain(a: Actor, address: string, o: { app?: FastifyInstance; mails: number }) {
  const r = await send(a, { app: o.app });
  const data = ok(r);
  const mails = await mailOf(address, o.mails);
  const mail = mails[mails.length - 1]!;
  return { data, mail, code: mail.code!, token: mail.token!, cid: r.cid };
}
/** Adds an address, sends, enters the code: a VERIFIED primary address. */
async function verified(a: Actor, o: { address?: string } = {}) {
  const sent = await addAndSend(a, o);
  expect(ok(await confirmCode(a, sent.code)).changed).toBe(true);
  return sent;
}

// ---------------------------------------------------------------- the database
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const contactsOf = (accountId: string) =>
  q<{
    email_contact_id: string;
    email_normalized: string;
    status: string;
    is_primary: boolean;
    source: string;
    verified_at: Date | null;
    disabled_reason: string | null;
  }>(
    `SELECT email_contact_id, email_normalized, status, is_primary, source, verified_at, disabled_reason FROM identity.email_contacts WHERE account_id = $1 ORDER BY created_at, email_contact_id`,
    [accountId],
  );
const challengesOf = (accountId: string) =>
  q<{
    challenge_id: string;
    email_contact_id: string;
    purpose: string;
    code_hash: string;
    magic_token_hash: string;
    expires_at: Date;
    used_at: Date | null;
    consumed_via: string | null;
    attempt_count: number;
    invalidated_at: Date | null;
    invalidation_reason: string | null;
    delivery_status: string;
    last_sent_at: Date | null;
    created_at: Date;
    correlation_id: string;
  }>(
    `SELECT c.* FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
      WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
    [accountId],
  );
const auditOf = (accountId: string) =>
  q<{ action: string; actor: string; changes: Json; correlation_id: string; email_contact_id: string }>(
    `SELECT action, actor, changes, correlation_id, email_contact_id FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'EMAIL%' ORDER BY occurred_at, audit_event_id`,
    [accountId],
  );
const eventsOf = (accountId: string) =>
  q<{ event_type: string; aggregate_type: string; actor_type: string; actor_id: string; correlation_id: string; payload_json: Json }>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.email-%' ORDER BY created_at, event_type`,
    [accountId],
  );
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const emailRowCounts = async () => ({
  contacts: await count('SELECT 1 FROM identity.email_contacts'),
  challenges: await count('SELECT 1 FROM identity.email_verification_challenges'),
  audit: await count(`SELECT 1 FROM identity.account_audit_events WHERE action LIKE 'EMAIL%'`),
  events: await count(`SELECT 1 FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.email-%'`),
});

/**
 * An EXPIRED challenge for the account's pending address. Time belongs to the database and the guard triggers make created_at and expires_at immutable,
 * so the row is inserted with explicit past timestamps and hashes computed with the same key the service uses. The contact must have no open challenge.
 */
async function insertExpiredChallenge(accountId: string, code: string, token: string): Promise<string> {
  const contact = (await contactsOf(accountId)).find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING')!;
  const challengeId = randomUUID();
  await q(
    `INSERT INTO identity.email_verification_challenges (challenge_id, email_contact_id, purpose, code_hash, magic_token_hash, expires_at, created_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, now() - interval '5 minutes', now() - interval '15 minutes', 'itest-expired')`,
    [
      challengeId,
      contact.email_contact_id,
      contact.status === 'PENDING' ? 'INITIAL_EMAIL' : 'CHANGE_EMAIL',
      hashVerificationCode(HASH_KEY, challengeId, code),
      hashMagicToken(HASH_KEY, token),
    ],
  );
  await q(`UPDATE identity.email_verification_challenges SET delivery_status = 'SENT', last_sent_at = now() - interval '14 minutes' WHERE challenge_id = $1`, [
    challengeId,
  ]);
  return challengeId;
}

// ---------------------------------------------------------------- variants of the app over the same database
const limiterPrefix = (): string => `itest:${randomUUID()}:`;
const newLimiter = (prefix = limiterPrefix()): ValkeyRateLimiter => new ValkeyRateLimiter(valkey, { prefix, commandTimeoutMs: 1000 });
const policyWith = (over: Partial<EmailVerificationPolicy>): VerificationPolicyProvider => ({
  policy: async () => ({ ...(await realPolicy.policy()), ...over }),
});
const renderer = () => createContentEmailRenderer(content);

interface Variant {
  policy?: Partial<EmailVerificationPolicy>;
  sender?: EmailSender;
  /** undefined: the shared limiter; null: no limiter at all. */
  limiter?: RateLimiter | null;
}
async function makeApp(v: Variant = {}): Promise<FastifyInstance> {
  const emailVerification = new EmailVerificationService({
    database: iso.database,
    policy: v.policy ? policyWith(v.policy) : realPolicy,
    sender: v.sender ?? goodSender,
    linkFor: createVerificationLinkBuilder(cfg.identity.webPublicUrl),
    hashSecret: HASH_KEY,
    ...(v.limiter === null ? {} : { rateLimiter: v.limiter ?? mainLimiter }),
  });
  const instance = await buildApp({
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
    geography: geographyService,
    accounts,
    emailVerification,
    readiness: async () => ({}),
  });
  await instance.ready();
  extraApps.push(instance);
  return instance;
}
let geographyService: GeographyService;

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
  configuration = new ConfigurationService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database: iso.database, lastSeenTouchSeconds: 0 });
  realPolicy = createVerificationPolicyProvider(configuration);
  goodSender = new SmtpEmailSender(SMTP, renderer());
  await valkey.ping(); // connect now: the limiter bounds every call to a short timeout
  mainLimiter = newLimiter();
  app = await makeApp();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.allSettled(addresses.map((a) => deleteMailpitMessagesTo(a.toLowerCase())));
  for (const a of extraApps) await a.close();
  deadValkey.disconnect();
  await closeValkey(valkey);
  await iso?.drop();
});

// ====================================================================== seeded configuration and managed copy
describe('seeded configuration and content (migration 0010)', () => {
  const PRD = { codeLength: 6, validityMinutes: 10, resendSeconds: 30, maxPerHour: 5, maxPerDay: 10, maxAttempts: 5, requestsPerHour: 30, addressPerHour: 5 };

  it('resolves the eight verification.email.* parameters to the PRD values through the policy provider and the policy parser', async () => {
    expect(await realPolicy.policy()).toEqual(PRD);
    const { values } = await configuration.resolveMany([
      'verification.email.code.length',
      'verification.email.validity_minutes',
      'verification.email.resend_seconds',
      'verification.email.max_per_hour',
      'verification.email.max_per_day',
      'verification.email.max_attempts',
      'verification.email.requests.max_per_hour',
      'verification.email.address.max_per_hour',
    ]);
    expect(values.size).toBe(8);
    expect(parseEmailVerificationPolicy(Object.fromEntries([...values].map(([k, r]) => [k, r.value])))).toEqual(PRD);
  });

  it('defines every limit as a CRITICAL, security-owned, second-approver, PLATFORM-scope integer parameter', async () => {
    const rows = await q<{
      key: string;
      data_type: string;
      owner_role: string;
      approval_policy: string;
      criticality: string;
      is_required: boolean;
      scopes: string[];
    }>(
      `SELECT p.key, p.data_type, p.owner_role, p.approval_policy, p.criticality, p.is_required, array_agg(s.scope_type) AS scopes
         FROM configuration.parameters p JOIN configuration.parameter_scopes s ON s.parameter_id = p.parameter_id
        WHERE p.key LIKE 'verification.email.%' GROUP BY p.parameter_id ORDER BY p.key`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows)
      expect(r, r.key).toMatchObject({
        data_type: 'INTEGER',
        owner_role: 'security',
        approval_policy: 'SECOND_APPROVER',
        criticality: 'CRITICAL',
        is_required: true,
        scopes: ['PLATFORM'],
      });
  });

  it('reads the CRITICAL limits fresh: nothing is ever written to the configuration cache, and every resolved value says CRITICAL', async () => {
    const cache = new MemoryConfigCache();
    const fresh = new ConfigurationService({ database: iso.database, cache, env: 'test', allowTestKeys: true });
    await createVerificationPolicyProvider(fresh).policy();
    await createVerificationPolicyProvider(fresh).policy();
    expect([...cache.data.keys()].filter((k) => k.includes('verification'))).toEqual([]);
    const { values } = await fresh.resolveMany(['verification.email.max_attempts', 'verification.email.code.length']);
    for (const r of values.values()) expect(r.criticality).toBe('CRITICAL');
  });

  it('refuses an invalid or missing limit instead of defaulting it (the service then fails closed)', () => {
    const good = Object.fromEntries(
      Object.entries({
        'verification.email.code.length': 6,
        'verification.email.validity_minutes': 10,
        'verification.email.resend_seconds': 30,
        'verification.email.max_per_hour': 5,
        'verification.email.max_per_day': 10,
        'verification.email.max_attempts': 5,
        'verification.email.requests.max_per_hour': 30,
        'verification.email.address.max_per_hour': 5,
      }),
    );
    expect(() => parseEmailVerificationPolicy(good)).not.toThrow();
    for (const [key, bad] of [
      ['verification.email.code.length', 3],
      ['verification.email.code.length', 11],
      ['verification.email.code.length', 6.5],
      ['verification.email.code.length', '6'],
      ['verification.email.max_attempts', 0],
      ['verification.email.max_attempts', null],
      ['verification.email.resend_seconds', -1],
      ['verification.email.validity_minutes', undefined],
    ] as const)
      expect(() => parseEmailVerificationPolicy({ ...good, [key]: bad }), `${key}=${String(bad)}`).toThrow(/not available/);
    expect(() => parseEmailVerificationPolicy({})).toThrow(/not available/);
  });

  it('seeds the 34 account.email.* entries as active, content-owned, public copy, and renders EVERY one with its example variable values', async () => {
    const entries = (await content.listEntries()).filter((e) => e.key.startsWith('account.email.'));
    expect(entries).toHaveLength(34);
    for (const e of entries) {
      expect(e, e.key).toMatchObject({ isActive: true, ownerRole: 'CONTENT', sensitivity: 'PUBLIC' });
      const variables = Object.fromEntries(e.variables.map((v) => [v.name, v.example]));
      const r = await content.render(e.key, { locale: 'en-US', variables });
      expect(r.format, e.key).toBe(e.contentType === 'EMAIL_BODY' ? 'html' : 'text');
      expect(r.value.trim().length, e.key).toBeGreaterThan(0);
      expect(r.value, `${e.key} left a placeholder unresolved`).not.toMatch(/\{[a-z_]+[,}]/);
    }
  });

  it('renders the verification body from its typed variables: the code in <strong>, the link as a hardened anchor, a plural-aware expiry', async () => {
    const body = await content.render('account.email.verification.body', {
      locale: 'en-US',
      variables: { verification_code: '123456', verification_url: 'https://app.bananagig.example/verify-email#token=example', expiry_minutes: 10 },
    });
    expect(body.format).toBe('html');
    expect(body.value).toContain('<strong>123456</strong>');
    expect(body.value).toMatch(/<a href="https:\/\/app\.bananagig\.example\/verify-email#token=example" rel="noopener noreferrer nofollow">/);
    expect(body.value).toContain('10 minutes');
    const one = await content.render('account.email.verification.body', {
      locale: 'en-US',
      variables: { verification_code: '123456', verification_url: 'https://app.bananagig.example/verify-email#token=example', expiry_minutes: 1 },
    });
    expect(one.value).toContain('1 minute.');
    const subject = await content.render('account.email.verification.subject', { locale: 'en-US' });
    expect(subject.value).toBe(SUBJECT);
    expect(subject.format).toBe('text');
  });

  it('seeds the code and the link as SENSITIVE_PERSONAL typed variables (STRING, URL, COUNT) of the email body, and no variable on the subject', async () => {
    const body = (await content.getEntry('account.email.verification.body')).entry;
    expect(body.contentType).toBe('EMAIL_BODY');
    expect(Object.fromEntries(body.variables.map((v) => [v.name, [v.type, v.piiClass, v.required]]))).toEqual({
      verification_code: ['STRING', 'SENSITIVE_PERSONAL', true],
      verification_url: ['URL', 'SENSITIVE_PERSONAL', true],
      expiry_minutes: ['COUNT', 'NONE', true],
    });
    const subject = (await content.getEntry('account.email.verification.subject')).entry;
    expect(subject.contentType).toBe('EMAIL_SUBJECT');
    expect(subject.variables).toEqual([]);
  });

  it('resolves every message key the API and the screens use: error codes, issue codes, status labels', async () => {
    const keysUsed = [
      ...EMAIL_ERROR_CODES.filter((c) => c !== 'EMAIL_INVALID').map(emailErrorMessageKey),
      ...EMAIL_ISSUE_CODES.map(emailIssueMessageKey),
      ...EMAIL_VERIFICATION_STATUSES.map(emailStatusLabelKey),
    ];
    expect(keysUsed).toHaveLength(11 + 5 + 3);
    for (const key of keysUsed) {
      const entry = await content.getEntry(key);
      const variables = Object.fromEntries(entry.entry.variables.map((v) => [v.name, v.example]));
      expect((await content.render(key, { locale: 'en-US', variables })).value.length, key).toBeGreaterThan(0);
    }
  });

  it('renders the verification email through the PRODUCTION email renderer: the subject and the body from the registry, the body also as plain text', async () => {
    // The renderer passes ONE variable set to both templates. The subject entry defines no variables, so a strict registry must not be handed any.
    const r = await renderer().render(
      'account.email.verification',
      { verification_code: '123456', verification_url: 'https://app.bananagig.example/verify-email#token=example', expiry_minutes: 10 },
      undefined,
    );
    expect(r.subject).toBe(SUBJECT);
    expect(r.html).toContain('<strong>123456</strong>');
    expect(r.text).toContain('123456');
    expect(r.text).not.toContain('<');
    expect(r.templateVersion).toMatch(/^[0-9]+$/);
  });
});

// ====================================================================== access control on the real stack
describe('access control', () => {
  it('answers 401 to every email route without a token and creates, sends and changes nothing', async () => {
    const before = await emailRowCounts();
    for (const [name, method, url, body] of ROUTES_OF_EMAIL) {
      const r = await call(undefined, method, url, { body, ip: null });
      fail(r, 401, 'AUTHENTICATION_REQUIRED');
      expect(String(r.headers['www-authenticate']), name).toContain('Bearer');
      expect(r.headers['cache-control'], name).toBe('no-store');
      // authentication wins over validation
      if (method === 'POST') fail(await call(undefined, 'POST', url, { body: { code: 1, token: 2, email: 3 } }), 401, 'AUTHENTICATION_REQUIRED');
    }
    fail(await call(undefined, 'GET', `${EMAIL}?accountId=x`), 401, 'AUTHENTICATION_REQUIRED');
    expect(await emailRowCounts()).toEqual(before);
  });

  it('answers 401 INVALID_TOKEN to a forged, expired or foreign-signed token, never creating an account', async () => {
    const before = { ...(await emailRowCounts()), accounts: await count('SELECT 1 FROM identity.accounts') };
    const foreign = await createTestKeys('k-foreign');
    const bad = [
      await signToken(foreign, { claims: { sub: 'forged', azp: 'bananagig-web' } }),
      await signToken(keys, { claims: { sub: 'expired', azp: 'bananagig-web' }, expiresInSec: -120 }),
      await signToken(keys, { claims: { sub: 'aud', azp: 'bananagig-web', aud: 'somebody-else' } }),
    ];
    for (const token of bad)
      for (const [, method, url, body] of ROUTES_OF_EMAIL) fail(await call(undefined, method, url, { body, token }), 401, 'INVALID_TOKEN');
    expect({ ...(await emailRowCounts()), accounts: await count('SELECT 1 FROM identity.accounts') }).toEqual(before);
  });

  it('refuses the admin identity context with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED on every email route, before it validates the body', async () => {
    const before = await emailRowCounts();
    const token = await adminToken();
    for (const [, method, url, body] of ROUTES_OF_EMAIL) {
      fail(await call(undefined, method, url, { body, token }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
      if (method === 'POST') fail(await call(undefined, 'POST', url, { body: { code: 1, extra: 2 }, token }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    }
    expect(await emailRowCounts()).toEqual(before);
  });

  it('never accepts a number where a string is required: {"code":123456} and {"email":123} are 400s that count no attempt and add no contact', async () => {
    const a = await newActor('strict');
    const { code } = await addAndSend(a);
    const before = await challengesOf(a.accountId);
    for (const body of [{ code: Number(code) }, { code: [code] }, { code, extra: 1 }, { token: code }, {}]) {
      const r = await call(a, 'POST', `${EMAIL}/verification/confirm-code`, { body });
      expect(r.status, r.raw).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      expect(r.raw).not.toContain(code);
    }
    const b = await newActor('strict-b');
    for (const body of [{ email: 123 }, { email: null }, { email: 'a@example.test', accountId: a.accountId }, []]) {
      const r = await call(b, 'POST', EMAIL, { body });
      fail(r, 400, 'VALIDATION_FAILED');
    }
    expect(await contactsOf(b.accountId)).toEqual([]);
    expect((await challengesOf(a.accountId)).map((c) => c.attempt_count)).toEqual(before.map((c) => c.attempt_count));
    expect(before[0]!.attempt_count).toBe(0);
  });

  it("keeps accounts apart: a request can never name another account, and one account cannot read or use the other's state", async () => {
    const a = await newActor('iso-a');
    const b = await newActor('iso-b');
    const sentA = await addAndSend(a);
    // B names A everywhere it can: header, query, body
    const probe = await call(b, 'GET', `${EMAIL}?accountId=${a.accountId}`, { headers: { 'x-account-id': a.accountId, 'x-user-id': a.sub } });
    expect(ok(probe)).toMatchObject({ emailVerificationStatus: 'NONE', pending: null, primary: null });
    fail(await call(b, 'POST', EMAIL, { body: { email: newAddress(), accountId: a.accountId } }), 400, 'VALIDATION_FAILED');
    ok(await setEmail(b, newAddress('b'), { headers: { 'x-account-id': a.accountId } }));
    // B has a pending address of its own and a challenge: A's code is simply a wrong code for B and counts against B only
    const addressB = (await contactsOf(b.accountId))[0]!.email_normalized;
    const sentB = await sendAgain(b, addressB, { mails: 1 });
    expect(sentB.code).not.toBe(sentA.code);
    const wrong = fail(await confirmCode(b, sentA.code), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(wrong.details.attemptsRemaining).toBe(4);
    fail(await confirmLink(b, sentA.token), 400, 'ACCOUNT_EMAIL_LINK_INVALID');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    // A's code and link still work for A
    expect(ok(await confirmCode(a, sentA.code)).changed).toBe(true);
    expect((await contactsOf(b.accountId))[0]!.status).toBe('PENDING');
  });
});

// ====================================================================== #14 the initial address
describe('POST /account/email: the initial address (#14)', () => {
  it('adds the address as PENDING / INITIAL_EMAIL, answers masked, sends no email, audits EMAIL_ADDED and emits EmailContactAdded', async () => {
    const a = await newActor('add');
    const address = newAddress('Mixed.Case');
    const typed = `  ${address.toUpperCase()}  `;
    const r = await setEmail(a, typed);
    const data = ok(r);
    expect(data.changed).toBe(true);
    expect(data.email).toEqual({
      emailVerificationStatus: 'PENDING',
      primary: null,
      pending: { maskedEmail: maskEmail(address.toLowerCase()), purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null },
    });
    for (const text of [address, address.toLowerCase(), localOf(address)]) expect(r.raw).not.toContain(text);
    expect(r.headers['cache-control']).toBe('no-store');
    // stored once, in canonical (lower-case, trimmed) form
    const contacts = await contactsOf(a.accountId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      email_normalized: address.toLowerCase(),
      status: 'PENDING',
      is_primary: false,
      source: 'USER_ENTERED',
      verified_at: null,
    });
    // nothing was sent, and no challenge exists yet
    expect(await inboxSize(address)).toBe(0);
    expect(await challengesOf(a.accountId)).toEqual([]);
    // audit + event, with the request's correlation id
    const audit = await auditOf(a.accountId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'EMAIL_ADDED',
      actor: `account:${a.accountId}`,
      correlation_id: r.cid,
      email_contact_id: contacts[0]!.email_contact_id,
    });
    expect(audit[0]!.changes).toMatchObject({ status: [null, 'PENDING'], maskedEmail: maskEmail(address.toLowerCase()), purpose: 'INITIAL_EMAIL' });
    const events = await eventsOf(a.accountId);
    expect(events.map((e) => e.event_type)).toEqual([EMAIL_EVENTS.contactAdded]);
    expect(events[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${a.accountId}`, correlation_id: r.cid });
    expect(events[0]!.payload_json).toEqual({
      accountId: a.accountId,
      emailContactId: contacts[0]!.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'USER_ENTERED',
      status: 'PENDING',
    });
  });

  it('canonicalizes: trims, lower-cases the local part, maps an internationalized domain to punycode, and KEEPS dots and +tags', async () => {
    const id = randomUUID();
    const cases: [string, string][] = [
      [`  Ana.B+Tag-${id}@Example.TEST `, `ana.b+tag-${id}@example.test`],
      [`UPPER-${id}@EXAMPLE.TEST`, `upper-${id}@example.test`],
      [`dots.are.kept.${id}@example.test`, `dots.are.kept.${id}@example.test`],
      [`ana-${id}@b${String.fromCodePoint(0xfc)}cher.example`, `ana-${id}@xn--bcher-kva.example`],
    ];
    for (const [typed, canonical] of cases) {
      const a = await newActor('canon');
      const r = await setEmail(a, typed);
      ok(r);
      expect((await contactsOf(a.accountId))[0]!.email_normalized).toBe(canonical);
      expect(r.raw).not.toContain(canonical);
      expect(r.raw).not.toContain(id);
    }
  });

  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const BEL = String.fromCharCode(7);
  const RLO = String.fromCodePoint(0x202e);
  const invalid: [string, string, string][] = [
    ['an empty string', '', 'REQUIRED'],
    ['only spaces', '    ', 'REQUIRED'],
    ['no at sign', 'plainaddress', 'INVALID_FORMAT'],
    ['two at signs', 'a@@example.test', 'INVALID_FORMAT'],
    ['a missing local part', '@example.test', 'INVALID_FORMAT'],
    ['a missing domain', 'ana@', 'INVALID_FORMAT'],
    ['a single-label domain', 'ana@localhost', 'INVALID_FORMAT'],
    ['a space in the local part', 'a b@example.test', 'INVALID_FORMAT'],
    ['a numeric top-level label', 'ana@example.123', 'INVALID_FORMAT'],
    ['an IP literal', 'ana@[127.0.0.1]', 'INVALID_FORMAT'],
    ['a trailing dot', 'ana@example.test.', 'INVALID_FORMAT'],
    ['a quoted local part', '"ana"@example.test', 'UNSUPPORTED'],
    ['a domain label above 63 characters', `ana@${'d'.repeat(64)}.test`, 'INVALID_FORMAT'],
    ['a local part above 64 characters', `${'x'.repeat(65)}@example.test`, 'TOO_LONG'],
    ['an internationalized local part', `${String.fromCodePoint(0xfc, 0xef)}@example.test`, 'UNSUPPORTED'],
    ['a control character', `a${BEL}@example.test`, 'INVALID_CHARACTERS'],
    ['a bidirectional override', `a${RLO}@example.test`, 'INVALID_CHARACTERS'],
    ['a header-injection attempt', `ana@example.test${CR}${LF}Bcc: evil@example.test`, 'INVALID_CHARACTERS'],
  ];
  it.each(invalid)(
    'rejects %s with 400 ACCOUNT_EMAIL_INVALID, the issue code and its message key, without echoing it, and stores nothing',
    async (_label, typed, reason) => {
      const a = await newActor('invalid');
      const r = await setEmail(a, typed);
      const error = fail(r, 400, 'ACCOUNT_EMAIL_INVALID');
      expect(error.category).toBe('VALIDATION');
      expect(error.details).toEqual({ reason, messageKey: `account.email.error.${reason.toLowerCase()}` });
      if (typed.trim().length > 3) expect(r.raw).not.toContain(typed.trim());
      expect(await contactsOf(a.accountId)).toEqual([]);
      expect(await auditOf(a.accountId)).toEqual([]);
    },
  );

  it('rejects an address above the 1024-character contract limit at the API (VALIDATION_FAILED) and between 255 and 1024 characters in the service (TOO_LONG)', async () => {
    const a = await newActor('toolong');
    fail(await setEmail(a, `${'a'.repeat(1030)}@example.test`), 400, 'VALIDATION_FAILED');
    const r = await setEmail(a, `${'a'.repeat(300)}@example.test`);
    expect(fail(r, 400, 'ACCOUNT_EMAIL_INVALID').details.reason).toBe('TOO_LONG');
    expect(await contactsOf(a.accountId)).toEqual([]);
  });

  it('is idempotent for the same address (any casing: changed:false) and a different address supersedes the pending one, closing its challenge', async () => {
    const a = await newActor('idem');
    const first = newAddress('first');
    const second = newAddress('second');
    expect(ok(await setEmail(a, first)).changed).toBe(true);
    const again = ok(await setEmail(a, first.toUpperCase()));
    expect(again.changed).toBe(false);
    expect(await contactsOf(a.accountId)).toHaveLength(1);
    expect(await auditOf(a.accountId)).toHaveLength(1);
    const sent = await sendAgain(a, first, { mails: 1 });
    // a different address replaces the pending one
    const swap = ok(await setEmail(a, second));
    expect(swap.changed).toBe(true);
    expect(swap.email.pending.maskedEmail).toBe(maskEmail(second));
    const contacts = await contactsOf(a.accountId);
    expect(contacts.map((c) => [c.email_normalized, c.status, c.disabled_reason])).toEqual([
      [first, 'DISABLED', 'SUPERSEDED'],
      [second, 'PENDING', null],
    ]);
    const challenges = await challengesOf(a.accountId);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    // the code that was sent to the first address can no longer verify anything
    fail(await confirmCode(a, sent.code), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    fail(await confirmLink(a, sent.token), 400, 'ACCOUNT_EMAIL_CODE_USED');
    expect((await contactsOf(a.accountId)).filter((c) => c.status === 'VERIFIED')).toEqual([]);
    expect(ok(await detail(a)).emailVerificationStatus).toBe('PENDING');
  });
});

// ====================================================================== #15 and #16 sending
describe('POST /account/email/verification/send: the verification email (#15, #16)', () => {
  it('answers 409 ACCOUNT_EMAIL_NOT_PENDING when there is no address waiting, and sends nothing', async () => {
    const a = await newActor('nopending');
    const error = fail(await send(a), 409, 'ACCOUNT_EMAIL_NOT_PENDING');
    expect(error.category).toBe('CONFLICT');
    expect(error.details.messageKey).toBe('account.email.error.not_pending');
    expect(await challengesOf(a.accountId)).toEqual([]);
  });

  it('sends the code and the link (#15): ISO times, the configured code length and validity, a resend countdown, and a SENT challenge that stores hashes only', async () => {
    const a = await newActor('send');
    const typed = newAddress('Send.Me');
    const sent = await addAndSend(a, { address: typed });
    const d = sent.data;
    expect(Object.keys(d).sort()).toEqual(['codeLength', 'email', 'expiresAt', 'resendAvailableAt', 'sentAt', 'validityMinutes']);
    expect(d).toMatchObject({ codeLength: 6, validityMinutes: 10 });
    for (const t of [d.sentAt, d.expiresAt, d.resendAvailableAt]) expect(new Date(t).toISOString()).toBe(t);
    expect(Math.abs(new Date(d.expiresAt).getTime() - new Date(d.sentAt).getTime() - 600_000)).toBeLessThan(5000);
    // the cooldown runs from the moment the challenge was issued, not from the delivery
    const [issuedChallenge] = await challengesOf(a.accountId);
    expect(new Date(d.resendAvailableAt).getTime()).toBe(issuedChallenge!.created_at.getTime() + 30_000);
    expect(d.email.pending).toMatchObject({ purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: d.sentAt, expiresAt: d.expiresAt });
    // the answer never carries the code, the token or the address
    const r = transcript.at(-1)!; // the send response (addAndSend sent last)
    for (const secret of [sent.code, sent.token, typed.toLowerCase(), localOf(typed)]) expect(r.raw).not.toContain(secret);

    const [c] = await challengesOf(a.accountId);
    expect(c).toMatchObject({ purpose: 'INITIAL_EMAIL', delivery_status: 'SENT', used_at: null, invalidated_at: null, attempt_count: 0 });
    expect(c!.last_sent_at).not.toBeNull();
    expect(c!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.magic_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // keyed hashes: bound to the challenge id and to the server key, and the plaintext is nowhere in the row
    expect(c!.code_hash).toBe(hashVerificationCode(HASH_KEY, c!.challenge_id, sent.code));
    expect(c!.magic_token_hash).toBe(hashMagicToken(HASH_KEY, sent.token));
    const rowText = JSON.stringify(c);
    for (const secret of [sent.code, sent.token, typed.toLowerCase()]) expect(rowText).not.toContain(secret);
    expect(c!.correlation_id).toBe(sent.cid);
  });

  it('delivers exactly ONE well-formed message to Mailpit (#16): registry subject without the code, code and link in the text, a hardened anchor in the HTML', async () => {
    const a = await newActor('mail');
    const typed = newAddress('Mail.Me');
    const sent = await addAndSend(a, { address: typed });
    const inbox = await mailpitMessagesTo(typed.toLowerCase());
    expect(inbox).toHaveLength(1);
    const m = sent.mail;
    expect(m.to).toEqual([typed.toLowerCase()]); // the canonical (lower-case) address
    expect(m.subject).toBe(SUBJECT);
    expect(m.subject).not.toContain(sent.code);
    expect(sent.code).toMatch(/^[0-9]{6}$/);
    expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the link: the public web origin, the verification page, the token in the FRAGMENT only (never a query string the web or API access logs would see)
    const url = new URL(m.url!);
    expect(url.origin).toBe(cfg.identity.webPublicUrl);
    expect(url.pathname).toBe('/verify-email');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#token=${sent.token}`);
    // text part: the code and the link, no markup
    expect(m.text).toContain(sent.code);
    expect(m.text).toContain(m.url!);
    expect(m.text).not.toMatch(/[<>]/);
    // html part: the code in <strong>, the link as an anchor with rel noopener noreferrer nofollow, nothing active
    expect(m.html).toContain(`<strong>${sent.code}</strong>`);
    expect(m.html).toMatch(new RegExp(`<a href="${m.url!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*rel="noopener noreferrer nofollow"`));
    expect(m.html).not.toMatch(/<script|<iframe|<img|<form|onerror|onclick|javascript:/i);
    // the transport headers the adapter promises
    expect(m.headers['x-correlation-id']).toEqual([sent.cid]);
    expect(m.headers['x-bananagig-template']).toEqual(['account.email.verification']);
    expect(m.headers['auto-submitted']).toEqual(['auto-generated']);
    expect(m.headers['from']?.[0]).toContain(FROM);
    // the same correlation id ties the request, the challenge, the audit row, the event and the message together
    expect((await auditOf(a.accountId)).find((x) => x.action === 'EMAIL_VERIFICATION_REQUESTED')!.correlation_id).toBe(sent.cid);
    expect((await eventsOf(a.accountId)).find((x) => x.event_type === EMAIL_EVENTS.verificationSent)!.correlation_id).toBe(sent.cid);
  });

  it('issues a different code and token every time (nothing derives from the address, the account or the time)', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('unique');
    const address = newAddress();
    ok(await setEmail(a, address, { app: fast }));
    const one = await sendAgain(a, address, { app: fast, mails: 1 });
    const two = await sendAgain(a, address, { app: fast, mails: 2 });
    const three = await sendAgain(a, address, { app: fast, mails: 3 });
    expect(new Set([one.code, two.code, three.code]).size).toBeGreaterThan(1);
    expect(new Set([one.token, two.token, three.token]).size).toBe(3);
    expect(await inboxSize(address)).toBe(3);
  });

  it('records the delivery: the EmailVerificationSent event carries identifiers and the expiry only, never the address, code, token or a hash', async () => {
    const a = await newActor('sentevent');
    const sent = await addAndSend(a);
    const [event] = (await eventsOf(a.accountId)).filter((e) => e.event_type === EMAIL_EVENTS.verificationSent);
    const [c] = await challengesOf(a.accountId);
    const contact = (await contactsOf(a.accountId))[0]!;
    expect(EmailVerificationSentPayload.parse(event!.payload_json)).toEqual(event!.payload_json);
    expect(event!.payload_json).toEqual({
      accountId: a.accountId,
      emailContactId: contact.email_contact_id,
      challengeId: c!.challenge_id,
      purpose: 'INITIAL_EMAIL',
      expiresAt: sent.data.expiresAt,
    });
  });
});

// ====================================================================== #17 #19 #20 #21 the code
describe('POST /account/email/verification/confirm-code (#17, #19, #20, #21)', () => {
  it('verifies the address with the emailed code (#17): changed:true, /account/me then reports VERIFIED with a masked primary, and the challenge is consumed by CODE', async () => {
    const a = await newActor('code');
    const before = ok(await me(a)).email;
    expect(before).toEqual({ emailVerificationStatus: 'NONE', primary: null, pending: null });
    const { address, code } = await addAndSend(a);
    expect(ok(await me(a)).email.emailVerificationStatus).toBe('PENDING');
    const r = await confirmCode(a, code);
    const data = ok(r);
    expect(data.changed).toBe(true);
    expect(data.email.emailVerificationStatus).toBe('VERIFIED');
    const after = ok(await me(a)).email;
    expect(after).toEqual({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(address.toLowerCase()), verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    expect(new Date(after.primary.verifiedAt).toISOString()).toBe(after.primary.verifiedAt);
    expect(r.raw).not.toContain(address.toLowerCase());
    const contact = (await contactsOf(a.accountId))[0]!;
    expect(contact).toMatchObject({ status: 'VERIFIED', is_primary: true, source: 'USER_ENTERED', disabled_reason: null });
    expect(contact.verified_at).toBeInstanceOf(Date);
    const [c] = await challengesOf(a.accountId);
    expect(c).toMatchObject({ consumed_via: 'CODE', invalidated_at: null, attempt_count: 0 });
    expect(c!.used_at).toBeInstanceOf(Date);
    const audit = (await auditOf(a.accountId)).find((x) => x.action === 'EMAIL_VERIFIED')!;
    expect(audit.changes).toMatchObject({
      status: ['PENDING', 'VERIFIED'],
      method: 'CODE',
      purpose: 'INITIAL_EMAIL',
      maskedEmail: maskEmail(address.toLowerCase()),
    });
    expect(audit.correlation_id).toBe(r.cid);
    // nothing left to send
    fail(await send(a), 409, 'ACCOUNT_EMAIL_NOT_PENDING');
  });

  it('counts wrong codes (#19): 400 with the attempts remaining and a message key, and the fifth wrong attempt locks the verification (429, no Retry-After)', async () => {
    const a = await newActor('lock');
    const { address, code, token } = await addAndSend(a);
    const wrong = wrongCode(code);
    for (const left of [4, 3, 2, 1]) {
      const error = fail(await confirmCode(a, wrong), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
      expect(error.category).toBe('VALIDATION');
      expect(error.details).toEqual({ attemptsRemaining: left, messageKey: 'account.email.error.code_invalid' });
      expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(5 - left);
      expect(ok(await detail(a)).attemptsRemaining).toBe(left);
    }
    const locked = await confirmCode(a, wrong);
    const error = fail(locked, 429, 'ACCOUNT_EMAIL_VERIFICATION_LOCKED');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.email.error.verification_locked' } });
    expect(locked.headers['retry-after']).toBeUndefined();
    // locked for good: even the RIGHT code and the right link fail, and the counter stays at the maximum
    fail(await confirmCode(a, code), 429, 'ACCOUNT_EMAIL_VERIFICATION_LOCKED');
    fail(await confirmLink(a, token), 429, 'ACCOUNT_EMAIL_VERIFICATION_LOCKED');
    const [c] = await challengesOf(a.accountId);
    expect(c).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED', used_at: null });
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    expect(ok(await detail(a)).attemptsRemaining).toBeNull();
    // audit: five failures, one lock; events: five failures counting 1..5, the last one locked
    const audit = await auditOf(a.accountId);
    expect(audit.filter((x) => x.action === 'EMAIL_VERIFICATION_FAILED').map((x) => x.changes.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(audit.filter((x) => x.action === 'EMAIL_VERIFICATION_LOCKED')).toHaveLength(1);
    const failures = (await eventsOf(a.accountId))
      .filter((e) => e.event_type === EMAIL_EVENTS.verificationFailed)
      .map((e) => EmailVerificationFailedPayload.parse(e.payload_json));
    expect(failures.map((f) => [f.attemptCount, f.locked]).sort()).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
    // a new code is the way out (the cooldown of this app is 30 s, so a variant with none)
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const fresh = await sendAgain(a, address, { app: fast, mails: 2 });
    expect(ok(await confirmCode(a, fresh.code)).changed).toBe(true);
  });

  it('counts a well-formed code of the wrong length as a wrong attempt too (the length is a configuration value, not a shape rule)', async () => {
    const a = await newActor('shortcode');
    const { code } = await addAndSend(a);
    const short = code.slice(0, 4) === '0000' ? '1111' : '0000';
    expect(fail(await confirmCode(a, short), 400, 'ACCOUNT_EMAIL_CODE_INVALID').details.attemptsRemaining).toBe(4);
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(1);
  });

  it('answers EXPIRED (#20) for the right and for a wrong code on an expired challenge, counts no attempt, and a new send recovers', async () => {
    const a = await newActor('expired');
    const address = newAddress();
    ok(await setEmail(a, address));
    const code = '482913';
    const token = randomBytes(32).toString('base64url');
    await insertExpiredChallenge(a.accountId, code, token);
    const expired = fail(await confirmCode(a, code), 400, 'ACCOUNT_EMAIL_CODE_EXPIRED');
    expect(expired).toMatchObject({ category: 'VALIDATION', details: { messageKey: 'account.email.error.code_expired' } });
    fail(await confirmCode(a, wrongCode(code)), 400, 'ACCOUNT_EMAIL_CODE_EXPIRED');
    fail(await confirmLink(a, token), 400, 'ACCOUNT_EMAIL_CODE_EXPIRED');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    // an expired challenge offers no attempts and is not "usable" in the state
    const d = ok(await detail(a));
    expect(d.attemptsRemaining).toBeNull();
    expect(d.pending).toMatchObject({ status: 'PENDING', expiresAt: null });
    // sending again supersedes it (the last send was 14 minutes ago, outside the cooldown) and the new code verifies
    const fresh = await sendAgain(a, address, { mails: 1 });
    expect(ok(await confirmCode(a, fresh.code)).changed).toBe(true);
    expect((await challengesOf(a.accountId)).map((c) => c.invalidation_reason)).toEqual(['SUPERSEDED', null]);
  });

  it('is idempotent when repeated (#21): changed:false, no new audit row or event, the verified timestamp unchanged; the consumed link is idempotent too', async () => {
    const a = await newActor('idemcode');
    const { code, token } = await addAndSend(a);
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
    const snapshot = async () => ({
      audit: (await auditOf(a.accountId)).length,
      events: (await eventsOf(a.accountId)).length,
      contact: await contactsOf(a.accountId),
      challenges: await challengesOf(a.accountId),
    });
    const before = await snapshot();
    for (const repeat of [() => confirmCode(a, code), () => confirmCode(a, code), () => confirmLink(a, token)]) {
      const data = ok(await repeat());
      expect(data.changed).toBe(false);
      expect(data.email.emailVerificationStatus).toBe('VERIFIED');
    }
    // a verified account with nothing pending answers any well-formed code the same way: already verified
    expect(ok(await confirmCode(a, wrongCode(code))).changed).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('answers 409 ACCOUNT_EMAIL_NOT_PENDING with nothing to verify, and CODE_INVALID (no attempt counted) for a pending address that was never sent a code', async () => {
    const a = await newActor('nothing');
    fail(await confirmCode(a, '123456'), 409, 'ACCOUNT_EMAIL_NOT_PENDING');
    ok(await setEmail(a, newAddress()));
    const error = fail(await confirmCode(a, '123456'), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(error.details).toEqual({ messageKey: 'account.email.error.code_invalid' });
    fail(await confirmLink(a, randomBytes(32).toString('base64url')), 400, 'ACCOUNT_EMAIL_LINK_INVALID');
    expect(await challengesOf(a.accountId)).toEqual([]);
  });

  it('answers CODE_USED for the code of a challenge a resend superseded, and the new code works', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('superseded');
    const first = await addAndSend(a, { app: fast });
    const second = await sendAgain(a, first.address, { app: fast, mails: 2 });
    const used = fail(await confirmCode(a, first.code, { app: fast }), 400, 'ACCOUNT_EMAIL_CODE_USED');
    expect(used.details.messageKey).toBe('account.email.error.code_used');
    fail(await confirmLink(a, first.token, { app: fast }), 400, 'ACCOUNT_EMAIL_CODE_USED');
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ invalidation_reason: 'SUPERSEDED', attempt_count: 0 });
    expect(ok(await confirmCode(a, second.code, { app: fast })).changed).toBe(true);
  });
});

// ====================================================================== #18 the magic link
describe('POST /account/email/verification/confirm-link (#18, #20, #21)', () => {
  it('verifies the address with the magic-link token (#18): VERIFIED, consumed by LINK, one EMAIL_VERIFIED audit row and one EmailVerified event', async () => {
    const a = await newActor('link');
    const { address, token } = await addAndSend(a);
    const r = await confirmLink(a, token);
    const data = ok(r);
    expect(data.changed).toBe(true);
    expect(data.email).toMatchObject({ emailVerificationStatus: 'VERIFIED', pending: null, primary: { maskedEmail: maskEmail(address.toLowerCase()) } });
    expect(ok(await me(a)).email.emailVerificationStatus).toBe('VERIFIED');
    const [c] = await challengesOf(a.accountId);
    expect(c).toMatchObject({ consumed_via: 'LINK', attempt_count: 0 });
    const audit = (await auditOf(a.accountId)).filter((x) => x.action === 'EMAIL_VERIFIED');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toMatchObject({ method: 'LINK', status: ['PENDING', 'VERIFIED'] });
    const events = (await eventsOf(a.accountId)).filter((e) => e.event_type === EMAIL_EVENTS.verified);
    expect(events).toHaveLength(1);
    expect(EmailVerifiedPayload.parse(events[0]!.payload_json)).toEqual({
      accountId: a.accountId,
      emailContactId: (await contactsOf(a.accountId))[0]!.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'USER_ENTERED',
      method: 'LINK',
      replacedEmailContactId: null,
    });
    expect(r.raw).not.toContain(token);
  });

  it('is idempotent when repeated (#21), and the code after the link is a no-op success as well', async () => {
    const a = await newActor('idemlink');
    const { code, token } = await addAndSend(a);
    expect(ok(await confirmLink(a, token)).changed).toBe(true);
    const before = { audit: (await auditOf(a.accountId)).length, events: (await eventsOf(a.accountId)).length };
    expect(ok(await confirmLink(a, token)).changed).toBe(false);
    expect(ok(await confirmCode(a, code)).changed).toBe(false);
    expect({ audit: (await auditOf(a.accountId)).length, events: (await eventsOf(a.accountId)).length }).toEqual(before);
  });

  it("cannot tell an unknown token from another account's token: the two answers are identical, and the other account's token still works for its owner", async () => {
    const a = await newActor('linkowner');
    const b = await newActor('linkother');
    const sentA = await addAndSend(a);
    await addAndSend(b);
    const unknown = await confirmLink(b, randomBytes(32).toString('base64url'));
    const foreign = await confirmLink(b, sentA.token);
    const normalize = (r: Res) => ({ status: r.status, error: { ...r.body.error, correlationId: 'x' } });
    expect(fail(unknown, 400, 'ACCOUNT_EMAIL_LINK_INVALID').details).toEqual({ messageKey: 'account.email.error.link_invalid' });
    expect(normalize(foreign)).toEqual(normalize(unknown));
    expect(foreign.raw.length).toBe(unknown.raw.length);
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
    expect(ok(await confirmLink(a, sentA.token)).changed).toBe(true);
  });

  it('counts no attempt for a wrong token: ten unknown tokens leave the code attempts untouched', async () => {
    const a = await newActor('linkattempts');
    const { code } = await addAndSend(a);
    for (let i = 0; i < 10; i++) fail(await confirmLink(a, randomBytes(32).toString('base64url')), 400, 'ACCOUNT_EMAIL_LINK_INVALID');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    expect(ok(await detail(a)).attemptsRemaining).toBe(5);
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
  });

  it('refuses an expired token (EXPIRED) and the token of a challenge that is used up after the address was replaced (CODE_USED)', async () => {
    const a = await newActor('linkexpired');
    ok(await setEmail(a, newAddress()));
    const token = randomBytes(32).toString('base64url');
    await insertExpiredChallenge(a.accountId, '555555', token);
    expect(fail(await confirmLink(a, token), 400, 'ACCOUNT_EMAIL_CODE_EXPIRED').details.messageKey).toBe('account.email.error.code_expired');

    const b = await newActor('linkreplaced');
    const first = await verified(b);
    // the change flow: the consumed token of the FIRST address is idempotent while that address is primary ...
    expect(ok(await confirmLink(b, first.token)).changed).toBe(false);
    const replacement = newAddress('replacement');
    ok(await setEmail(b, replacement));
    const second = await sendAgain(b, replacement, { mails: 1 });
    expect(ok(await confirmCode(b, second.code)).changed).toBe(true);
    // ... and a used-up challenge of an address that is no longer primary is CODE_USED
    fail(await confirmLink(b, first.token), 400, 'ACCOUNT_EMAIL_CODE_USED');
  });

  it('verifies EXACTLY once when a code and a link race: one changed:true, one idempotent changed:false, one audit row, one event', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newActor(`race${round}`);
      const { code, token } = await addAndSend(a);
      const [byCode, byLink] = await Promise.all([confirmCode(a, code), confirmLink(a, token)]);
      const results = [ok(byCode), ok(byLink)];
      expect(results.map((x) => x.changed).sort(), `round ${round}`).toEqual([false, true]);
      for (const x of results) expect(x.email.emailVerificationStatus).toBe('VERIFIED');
      expect((await auditOf(a.accountId)).filter((x) => x.action === 'EMAIL_VERIFIED')).toHaveLength(1);
      expect((await eventsOf(a.accountId)).filter((e) => e.event_type === EMAIL_EVENTS.verified)).toHaveLength(1);
      const [c] = await challengesOf(a.accountId);
      expect(['CODE', 'LINK']).toContain(c!.consumed_via);
      expect((await contactsOf(a.accountId)).filter((x) => x.is_primary)).toHaveLength(1);
    }
  });

  it('never lets concurrent wrong guesses exceed the maximum: exactly five attempts are counted, four answers say wrong, the rest say locked', async () => {
    const a = await newActor('parallel');
    const { code } = await addAndSend(a);
    const results = await Promise.all(Array.from({ length: 8 }, () => confirmCode(a, wrongCode(code))));
    expect(results.map((r) => r.status).sort()).toEqual([400, 400, 400, 400, 429, 429, 429, 429]);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error.details.attemptsRemaining)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED' });
  });
});

// ====================================================================== #22 cooldown and caps
describe('resend cooldown and caps (#22)', () => {
  it('answers a resend inside the cooldown with 429 ACCOUNT_EMAIL_RESEND_TOO_SOON and a Retry-After equal to details.retryAfterSeconds, sends exactly ONE email, and keeps the first code valid', async () => {
    const a = await newActor('cooldown');
    const { address, code } = await addAndSend(a);
    const r = await send(a);
    const error = fail(r, 429, 'ACCOUNT_EMAIL_RESEND_TOO_SOON');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.email.error.resend_too_soon' } });
    const wait = error.details.retryAfterSeconds;
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(30);
    expect(r.headers['retry-after']).toBe(String(wait));
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await inboxSize(address)).toBe(1);
    expect(await challengesOf(a.accountId)).toHaveLength(1);
    // the refused request did not supersede or touch the first challenge
    const d = ok(await detail(a));
    expect(d.attemptsRemaining).toBe(5);
    expect(new Date(d.resendAvailableAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(new Date(d.resendAvailableAt).getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
  });

  it('resends after the cooldown: two messages, two different codes, the first code and link are CODE_USED, and the new one verifies', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } });
    const a = await newActor('resend');
    const first = await addAndSend(a, { app: fast });
    const second = await sendAgain(a, first.address, { app: fast, mails: 2 });
    expect(second.token).not.toBe(first.token);
    expect(await inboxSize(first.address)).toBe(2);
    const challenges = await challengesOf(a.accountId);
    expect(challenges.map((c) => c.invalidation_reason)).toEqual(['SUPERSEDED', null]);
    fail(await confirmCode(a, first.code, { app: fast }), 400, 'ACCOUNT_EMAIL_CODE_USED');
    expect(ok(await confirmLink(a, second.token, { app: fast })).changed).toBe(true);
  });

  it('enforces the hourly cap from the database: the third send in the hour is 429 ACCOUNT_EMAIL_SEND_LIMIT with a Retry-After close to one hour and no third email', async () => {
    const capped = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 2 } });
    const a = await newActor('hourcap');
    const first = await addAndSend(a, { app: capped });
    await sendAgain(a, first.address, { app: capped, mails: 2 });
    const r = await send(a, { app: capped });
    const error = fail(r, 429, 'ACCOUNT_EMAIL_SEND_LIMIT');
    expect(error.details.messageKey).toBe('account.email.error.send_limit');
    expect(error.details.retryAfterSeconds).toBeGreaterThan(3500);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(r.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(await inboxSize(first.address)).toBe(2);
    expect(await challengesOf(a.accountId)).toHaveLength(2);
  });

  it('enforces the daily cap too: with the hourly cap out of the way the third send of the day is 429 SEND_LIMIT with a Retry-After of about a day', async () => {
    const capped = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 50, maxPerDay: 2 } });
    const a = await newActor('daycap');
    const first = await addAndSend(a, { app: capped });
    await sendAgain(a, first.address, { app: capped, mails: 2 });
    const r = await send(a, { app: capped });
    const error = fail(r, 429, 'ACCOUNT_EMAIL_SEND_LIMIT');
    expect(error.details.retryAfterSeconds).toBeGreaterThan(86_000);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    expect(r.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(await inboxSize(first.address)).toBe(2);
  });

  it('counts the cap per account: another account is not held back by it', async () => {
    const capped = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 1 } });
    const a = await newActor('capa');
    const b = await newActor('capb');
    const first = await addAndSend(a, { app: capped });
    fail(await send(a, { app: capped }), 429, 'ACCOUNT_EMAIL_SEND_LIMIT');
    expect((await addAndSend(b, { app: capped })).data.codeLength).toBe(6);
    expect(await inboxSize(first.address)).toBe(1);
  });
});

// ====================================================================== #25 verified elsewhere
describe('an address verified on another account (#25)', () => {
  it('answers a second account exactly as for a fresh address while it only sets and sends, and refuses only when it proves the mailbox: 409 ACCOUNT_EMAIL_UNAVAILABLE', async () => {
    const owner = await newActor('owner');
    const taken = newAddress('taken');
    await verified(owner, { address: taken });
    const claimant = await newActor('claimant');
    const bystander = await newActor('bystander');
    const fresh = newAddress('taken'); // the same shape (and length) as the taken address

    // set: identical answers
    const setTaken = await setEmail(claimant, taken);
    const setFresh = await setEmail(bystander, fresh);
    expect(setTaken.status).toBe(200);
    expect(shape(setTaken.body.data)).toEqual(shape(setFresh.body.data));
    expect(setTaken.body.data.changed).toBe(true);
    expect(setTaken.raw.length).toBe(setFresh.raw.length);
    expect(setTaken.raw).not.toContain(owner.accountId);
    // send: identical answers, and the message is delivered (the taken address now has two messages: the owner's and this one)
    const sendTaken = await send(claimant);
    const sendFresh = await send(bystander);
    expect(sendTaken.status).toBe(200);
    expect(shape(sendTaken.body.data)).toEqual(shape(sendFresh.body.data));
    expect(sendTaken.raw.length).toBe(sendFresh.raw.length);
    const mails = await mailOf(taken, 2);
    const claimantCode = mails[1]!.code!;
    const claimantToken = mails[1]!.token!;
    const freshCode = (await mailOf(fresh))[0]!.code!;
    // a wrong code: identical answers
    const wrongTaken = await confirmCode(claimant, wrongCode(claimantCode));
    const wrongFresh = await confirmCode(bystander, wrongCode(freshCode));
    expect(wrongTaken.status).toBe(400);
    expect(shape(wrongTaken.body.error.details)).toEqual(shape(wrongFresh.body.error.details));
    expect(wrongTaken.body.error.code).toBe(wrongFresh.body.error.code);
    // the right code proves the mailbox, and only then the conflict is told
    const conflict = await confirmCode(claimant, claimantCode);
    const error = fail(conflict, 409, 'ACCOUNT_EMAIL_UNAVAILABLE');
    expect(error).toMatchObject({ category: 'CONFLICT', details: { reason: 'ADDRESS_UNAVAILABLE', messageKey: 'account.email.error.unavailable' } });
    fail(await confirmLink(claimant, claimantToken), 409, 'ACCOUNT_EMAIL_UNAVAILABLE');
    // nothing changed: the claimant is still pending, the owner is still the one verified holder, and the unverified address has no second verified row
    expect(ok(await detail(claimant))).toMatchObject({ emailVerificationStatus: 'PENDING' });
    expect(await count(`SELECT 1 FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'VERIFIED'`, [taken])).toBe(1);
    expect((await contactsOf(owner.accountId))[0]).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(ok(await confirmCode(bystander, freshCode)).changed).toBe(true);
  });

  it('allows the same address pending on two accounts at once: whoever proves the mailbox first owns it and the other gets 409', async () => {
    const a = await newActor('pendinga');
    const b = await newActor('pendingb');
    const shared = newAddress('shared');
    ok(await setEmail(a, shared));
    ok(await setEmail(b, shared));
    expect(await count(`SELECT 1 FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'PENDING'`, [shared])).toBe(2);
    await sendAgain(a, shared, { mails: 1 });
    await sendAgain(b, shared, { mails: 2 });
    const mails = await mailOf(shared, 2);
    expect(ok(await confirmCode(b, mails[1]!.code!)).changed).toBe(true);
    fail(await confirmCode(a, mails[0]!.code!), 409, 'ACCOUNT_EMAIL_UNAVAILABLE');
    expect(await count(`SELECT 1 FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'VERIFIED'`, [shared])).toBe(1);
    expect((await contactsOf(b.accountId))[0]!.status).toBe('VERIFIED');
    expect((await contactsOf(a.accountId))[0]!.status).toBe('PENDING');
  });

  it('keeps a changing account on its old primary when the new address turns out to be verified elsewhere', async () => {
    const holder = await newActor('holder');
    const contested = newAddress('contested');
    await verified(holder, { address: contested });
    const changer = await newActor('changer');
    const original = newAddress('original');
    await verified(changer, { address: original });
    ok(await setEmail(changer, contested));
    const sent = await sendAgain(changer, contested, { mails: 2 });
    fail(await confirmCode(changer, sent.code), 409, 'ACCOUNT_EMAIL_UNAVAILABLE');
    const after = ok(await me(changer)).email;
    expect(after.primary.maskedEmail).toBe(maskEmail(original.toLowerCase()));
    expect(after).toMatchObject({ emailVerificationStatus: 'VERIFIED', pending: { purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' } });
    expect((await contactsOf(changer.accountId)).map((c) => [c.status, c.is_primary])).toEqual([
      ['VERIFIED', true],
      ['REPLACEMENT_PENDING', false],
    ]);
  });
});

// ====================================================================== #26 changing the primary address
describe('changing the verified address (#26)', () => {
  it('keeps the old primary active while the new address is pending, sends to the new address only, and swaps the primary on verification', async () => {
    const a = await newActor('change');
    const oldAddress = newAddress('old');
    const newOne = newAddress('new');
    await verified(a, { address: oldAddress });
    const oldMask = maskEmail(oldAddress.toLowerCase());

    const set = ok(await setEmail(a, newOne));
    expect(set.changed).toBe(true);
    expect(set.email).toMatchObject({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: oldMask },
      pending: { maskedEmail: maskEmail(newOne.toLowerCase()), purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' },
    });
    const pendingState = ok(await me(a)).email;
    expect(pendingState.primary.maskedEmail).toBe(oldMask);
    expect(pendingState.emailVerificationStatus).toBe('VERIFIED');
    expect(pendingState.pending.status).toBe('REPLACEMENT_PENDING');

    const sent = await sendAgain(a, newOne, { mails: 1 });
    expect(await inboxSize(oldAddress)).toBe(1); // only the original verification, never a message about the change
    expect((await challengesOf(a.accountId)).at(-1)).toMatchObject({ purpose: 'CHANGE_EMAIL' });
    // a wrong code during the change leaves the primary alone
    fail(await confirmCode(a, wrongCode(sent.code)), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(ok(await me(a)).email.primary.maskedEmail).toBe(oldMask);

    const done = ok(await confirmCode(a, sent.code));
    expect(done.changed).toBe(true);
    const after = ok(await me(a)).email;
    expect(after).toEqual({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(newOne.toLowerCase()), verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    const contacts = await contactsOf(a.accountId);
    expect(contacts.map((c) => [c.email_normalized, c.status, c.is_primary, c.disabled_reason])).toEqual([
      [oldAddress.toLowerCase(), 'DISABLED', false, 'REPLACED'],
      [newOne.toLowerCase(), 'VERIFIED', true, null],
    ]);
    // the audit trail and the events tell the story
    const audit = await auditOf(a.accountId);
    expect(audit.map((x) => x.action).sort()).toEqual(
      [
        'EMAIL_ADDED',
        'EMAIL_VERIFICATION_REQUESTED',
        'EMAIL_VERIFIED',
        'EMAIL_CHANGE_REQUESTED',
        'EMAIL_VERIFICATION_REQUESTED',
        'EMAIL_VERIFICATION_FAILED',
        'EMAIL_VERIFIED',
        'EMAIL_PRIMARY_CHANGED',
      ].sort(),
    );
    expect(audit.find((x) => x.action === 'EMAIL_PRIMARY_CHANGED')!.changes).toMatchObject({
      from: oldMask,
      to: maskEmail(newOne.toLowerCase()),
      replacedContactId: contacts[0]!.email_contact_id,
    });
    const events = await eventsOf(a.accountId);
    const requested = events.find((e) => e.event_type === EMAIL_EVENTS.changeRequested)!;
    expect(EmailChangeRequestedPayload.parse(requested.payload_json)).toEqual({
      accountId: a.accountId,
      emailContactId: contacts[1]!.email_contact_id,
      replacesEmailContactId: contacts[0]!.email_contact_id,
    });
    const verifiedEvents = events.filter((e) => e.event_type === EMAIL_EVENTS.verified).map((e) => e.payload_json);
    expect(verifiedEvents).toContainEqual(expect.objectContaining({ purpose: 'CHANGE_EMAIL', replacedEmailContactId: contacts[0]!.email_contact_id }));
    expect(events.filter((e) => e.event_type === EMAIL_EVENTS.contactAdded)).toHaveLength(2);
  });

  it('withdraws a pending change when the verified address is entered again (candidate SUPERSEDED, its challenge closed), and entering the primary with nothing pending is a no-op', async () => {
    const a = await newActor('withdraw');
    const primary = newAddress('primary');
    const candidate = newAddress('candidate');
    await verified(a, { address: primary });
    expect(ok(await setEmail(a, primary)).changed).toBe(false);
    ok(await setEmail(a, candidate));
    const sent = await sendAgain(a, candidate, { mails: 1 });
    const withdrawn = ok(await setEmail(a, primary.toUpperCase()));
    expect(withdrawn.changed).toBe(true);
    expect(withdrawn.email).toMatchObject({ emailVerificationStatus: 'VERIFIED', pending: null });
    expect((await contactsOf(a.accountId)).map((c) => [c.status, c.disabled_reason])).toEqual([
      ['VERIFIED', null],
      ['DISABLED', 'SUPERSEDED'],
    ]);
    expect((await challengesOf(a.accountId)).at(-1)).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    // the withdrawn candidate's link is dead; the primary stays and nothing is pending
    fail(await confirmLink(a, sent.token), 400, 'ACCOUNT_EMAIL_CODE_USED');
    fail(await send(a), 409, 'ACCOUNT_EMAIL_NOT_PENDING');
    expect(ok(await me(a)).email.primary.maskedEmail).toBe(maskEmail(primary.toLowerCase()));
  });

  it('replaces a pending change by a newer candidate: the first candidate is SUPERSEDED and only the newest can verify', async () => {
    const fast = await makeApp({ policy: { resendSeconds: 0 } }); // the cooldown is per account, across addresses
    const a = await newActor('twocandidates');
    await verified(a);
    const one = newAddress('one');
    const two = newAddress('two');
    ok(await setEmail(a, one));
    const sentOne = await sendAgain(a, one, { app: fast, mails: 1 });
    ok(await setEmail(a, two));
    expect((await contactsOf(a.accountId)).map((c) => c.status)).toEqual(['VERIFIED', 'DISABLED', 'REPLACEMENT_PENDING']);
    fail(await confirmCode(a, sentOne.code), 400, 'ACCOUNT_EMAIL_CODE_INVALID'); // the new candidate was never sent a code
    const sentTwo = await sendAgain(a, two, { app: fast, mails: 1 });
    expect(ok(await confirmCode(a, sentTwo.code)).changed).toBe(true);
    expect(ok(await me(a)).email.primary.maskedEmail).toBe(maskEmail(two.toLowerCase()));
  });
});

// ====================================================================== #27 and #28 audit, events, logs
describe('audit trail, events and secrecy (#27, #28)', () => {
  it('writes the ContactAdded / VerificationSent / Verified events with identifiers only, in the identity_account aggregate, with the request correlation ids', async () => {
    const a = await newActor('events');
    const added = await setEmail(a, newAddress());
    const sent = await send(a);
    ok(added);
    ok(sent);
    const address = (await contactsOf(a.accountId))[0]!.email_normalized;
    const { code } = (await mailOf(address))[0]!;
    const verifiedResponse = await confirmCode(a, code!);
    ok(verifiedResponse);
    const events = await eventsOf(a.accountId);
    expect(events.map((e) => e.event_type).sort()).toEqual([EMAIL_EVENTS.contactAdded, EMAIL_EVENTS.verificationSent, EMAIL_EVENTS.verified].sort());
    for (const e of events) expect(e).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${a.accountId}` });
    const byType = Object.fromEntries(events.map((e) => [e.event_type, e]));
    expect(byType[EMAIL_EVENTS.contactAdded]!.correlation_id).toBe(added.cid);
    expect(byType[EMAIL_EVENTS.verificationSent]!.correlation_id).toBe(sent.cid);
    expect(byType[EMAIL_EVENTS.verified]!.correlation_id).toBe(verifiedResponse.cid);
    expect(Object.keys(byType[EMAIL_EVENTS.contactAdded]!.payload_json).sort()).toEqual(Object.keys(EmailContactAddedPayload.shape).sort());
    expect(Object.keys(byType[EMAIL_EVENTS.verificationSent]!.payload_json).sort()).toEqual(Object.keys(EmailVerificationSentPayload.shape).sort());
    expect(Object.keys(byType[EMAIL_EVENTS.verified]!.payload_json).sort()).toEqual(Object.keys(EmailVerifiedPayload.shape).sort());
    // the audit rows are in the same transactions and share the correlation ids
    const audit = await auditOf(a.accountId);
    expect(audit.map((x) => x.action)).toEqual(['EMAIL_ADDED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFIED']);
    expect(audit.map((x) => x.correlation_id)).toEqual([added.cid, sent.cid, verifiedResponse.cid]);
    for (const x of audit) expect(x.actor).toBe(`account:${a.accountId}`);
  });

  it('keeps every plaintext out of the audit rows, the events and the challenge rows: no address, no local part, no code, no token, no hash', async () => {
    const a = await newActor('plaintext');
    const sent = await addAndSend(a);
    fail(await confirmCode(a, wrongCode(sent.code)), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(ok(await confirmLink(a, sent.token)).changed).toBe(true);
    const audit = JSON.stringify(await auditOf(a.accountId));
    const events = JSON.stringify(await eventsOf(a.accountId));
    const challenges = JSON.stringify(await challengesOf(a.accountId));
    for (const [what, text] of [
      ['audit', audit],
      ['events', events],
      ['challenges', challenges],
    ] as const) {
      for (const secret of [sent.address, sent.address.toLowerCase(), localOf(sent.address), sent.token, sent.code])
        expect(text, `${what} holds ${secret}`).not.toContain(secret);
    }
    // masked addresses are all the audit trail knows, and a hash appears only in the challenge row that owns it
    expect(audit).toContain(maskEmail(sent.address.toLowerCase()));
    expect(audit + events).not.toMatch(/[0-9a-f]{64}/);
    expect(challenges).toMatch(/[0-9a-f]{64}/);
    // the one table that holds the full address is the contact itself
    const rowsWithAddress = await q<{ t: string }>(
      `SELECT 'audit' AS t FROM identity.account_audit_events WHERE changes::text LIKE $1
       UNION ALL SELECT 'outbox' FROM integration.outbox_events WHERE payload_json::text LIKE $1
       UNION ALL SELECT 'challenges' FROM identity.email_verification_challenges WHERE correlation_id LIKE $1`,
      [`%${localOf(sent.address)}%`],
    );
    expect(rowsWithAddress).toEqual([]);
  });

  it('writes no code, token, address, hash key or credential to any log line, across successes, failures, a delivery failure and a limiter outage (#28)', async () => {
    const logs = captureLogs();
    const a = await newActor('logs');
    const addressA = newAddress('logs');
    const b = await newActor('logs-b');
    const sentA = await addAndSend(a, { address: addressA });
    fail(await send(a), 429, 'ACCOUNT_EMAIL_RESEND_TOO_SOON');
    fail(await confirmCode(a, wrongCode(sentA.code)), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    fail(await setEmail(b, 'not-an-address-marker'), 400, 'ACCOUNT_EMAIL_INVALID');
    expect(ok(await confirmCode(a, sentA.code)).changed).toBe(true);
    ok(await confirmLink(a, sentA.token));
    // a delivery failure logs the failure, not the message
    const unreachable = await makeApp({ sender: new SmtpEmailSender({ ...SMTP, port: 1, connectionTimeoutMs: 2000 }, renderer()) });
    const addressB = newAddress('logs-failed');
    ok(await setEmail(b, addressB, { app: unreachable }));
    fail(await send(b, { app: unreachable }), 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED');
    // a limiter outage logs the outage, not the request
    const outage = await makeApp({ limiter: new ValkeyRateLimiter(deadValkey, { prefix: limiterPrefix(), commandTimeoutMs: 300 }) });
    const c = await newActor('logs-c');
    fail(await setEmail(c, newAddress('logs-outage'), { app: outage }), 503, 'ACCOUNT_UNAVAILABLE');
    logs.stop();
    const logged = logs.lines.join('\n');
    expect(logged).toContain('request completed');
    expect(logged).toContain('verification email could not be delivered');
    expect(logged).toContain('rate limiter unavailable');
    const forbidden = [
      ...addresses,
      ...addresses.map(localOf),
      ...[...delivered.codes].map((x) => `"${x}"`),
      ...delivered.tokens,
      HASH_KEY,
      a.token,
      b.token,
      a.sub,
      'not-an-address-marker',
      'Bearer ',
    ];
    for (const secret of forbidden) expect(logged, `a log line contains ${secret.slice(0, 16)}`).not.toContain(secret);
    expect(logged).not.toMatch(/[0-9a-f]{64}/);
  });
});

// ====================================================================== #29 abuse limits on a real Valkey
describe('abuse limits through a real Valkey (#29)', () => {
  it('refuses the request over the per-account limit with 429 ACCOUNT_EMAIL_RATE_LIMITED and a Retry-After, counting nothing for the refused request', async () => {
    const prefix = limiterPrefix();
    const low = await makeApp({ policy: { requestsPerHour: 3, resendSeconds: 0 }, limiter: newLimiter(prefix) });
    const a = await newActor('limit-account');
    const address = newAddress();
    const fromAnyIp = () => ({ app: low, ip: nextIp() }); // a different source address each time: only the account dimension can refuse
    ok(await setEmail(a, address, fromAnyIp())); // 1
    ok(await send(a, fromAnyIp())); // 2
    const code = (await mailOf(address))[0]!.code!;
    fail(await confirmCode(a, wrongCode(code), fromAnyIp()), 400, 'ACCOUNT_EMAIL_CODE_INVALID'); // 3
    const refused = await confirmCode(a, wrongCode(code), fromAnyIp()); // 4: over the limit
    const error = fail(refused, 429, 'ACCOUNT_EMAIL_RATE_LIMITED');
    expect(error).toMatchObject({ category: 'RATE_LIMIT', details: { messageKey: 'account.email.error.rate_limited' } });
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(refused.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(Object.keys(error.details).sort()).toEqual(['messageKey', 'retryAfterSeconds']);
    // the refused attempt was not counted against the challenge, and reads are not limited
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(1);
    expect(ok(await detail(a, { app: low })).attemptsRemaining).toBe(4);
    // the limit is per account: another account is unaffected
    const b = await newActor('limit-account-b');
    ok(await setEmail(b, newAddress(), { app: low }));
  });

  it('limits a source address across accounts (the forwarded client address), without ever saying so: the answer has the same shape as the account limit', async () => {
    const prefix = limiterPrefix();
    const low = await makeApp({ policy: { requestsPerHour: 3, resendSeconds: 0 }, limiter: newLimiter(prefix) });
    const a = await newActor('limit-ip-a');
    const b = await newActor('limit-ip-b');
    const c = await newActor('limit-ip-c');
    const sharedIp = '198.51.100.77';
    const addressA = newAddress();
    ok(await setEmail(a, addressA, { app: low, ip: sharedIp })); // 1
    ok(await send(a, { app: low, ip: sharedIp })); // 2
    fail(await confirmCode(a, '000000', { app: low, ip: sharedIp }), 400, 'ACCOUNT_EMAIL_CODE_INVALID'); // 3
    const accountLimited = fail(await confirmCode(a, '000000', { app: low, ip: sharedIp }), 429, 'ACCOUNT_EMAIL_RATE_LIMITED');
    // another account from the SAME source address is limited as well
    const ipLimited = fail(await setEmail(b, newAddress(), { app: low, ip: sharedIp }), 429, 'ACCOUNT_EMAIL_RATE_LIMITED');
    expect(shape(ipLimited.details)).toEqual(shape(accountLimited.details));
    expect(ipLimited.message).toBe(accountLimited.message);
    expect(Object.keys(ipLimited).sort()).toEqual(Object.keys(accountLimited).sort());
    for (const text of [JSON.stringify(ipLimited), JSON.stringify(accountLimited)]) expect(text).not.toMatch(/\bip\b|source|address|device|client|198\.51/i);
    expect(await contactsOf(b.accountId)).toEqual([]);
    // the same request from another address, or without any forwarding header, is not limited; the refusal did not use up b's account allowance
    ok(await setEmail(b, newAddress(), { app: low, ip: nextIp() }));
    ok(await setEmail(c, newAddress(), { app: low, ip: null }));
    ok(await detail(c, { app: low, ip: null }));
  });

  it('limits the sends to one mailbox across accounts and sources (mailbox flooding): the third account is refused, nothing is created for it and no third message is sent', async () => {
    const low = await makeApp({ policy: { addressPerHour: 2, resendSeconds: 0 }, limiter: newLimiter() });
    const victim = newAddress('victim');
    const senders = [await newActor('flood-a'), await newActor('flood-b'), await newActor('flood-c')];
    for (const s of senders) ok(await setEmail(s, victim, { app: low }));
    ok(await send(senders[0]!, { app: low }));
    ok(await send(senders[1]!, { app: low }));
    const refused = await send(senders[2]!, { app: low });
    const error = fail(refused, 429, 'ACCOUNT_EMAIL_RATE_LIMITED');
    expect(refused.headers['retry-after']).toBe(String(error.details.retryAfterSeconds));
    expect(JSON.stringify(error)).not.toMatch(/\baddress\b|mailbox|victim/i);
    expect(await mailOf(victim, 2)).toHaveLength(2);
    expect(await inboxSize(victim)).toBe(2);
    expect(await challengesOf(senders[2]!.accountId)).toEqual([]);
  });

  it('stores only opaque counters in Valkey: no address, no source address, hashed dimensions, and every counter expires within the hour', async () => {
    const prefix = limiterPrefix();
    const low = await makeApp({ limiter: newLimiter(prefix) });
    const a = await newActor('limit-keys');
    const address = newAddress('limitkeys');
    const ip = '203.0.113.201';
    ok(await setEmail(a, address, { app: low, ip }));
    ok(await send(a, { app: low, ip }));
    const stored = await valkey.keys(`${prefix}*`);
    expect(stored.map((k) => k.slice(prefix.length).split(':').slice(0, 2).join(':')).sort()).toEqual([
      'email-verification:account',
      'email-verification:address',
      'email-verification:ip',
    ]);
    for (const key of stored) {
      for (const secret of [address, address.toLowerCase(), localOf(address), ip, 'example.test']) expect(key).not.toContain(secret);
      const [name, dimension, value] = key.slice(prefix.length).split(':') as [string, string, string];
      expect(name).toBe('email-verification');
      expect(value).toBe(dimension === 'account' ? a.accountId : value);
      if (dimension !== 'account') expect(value).toMatch(/^[0-9a-f]{32}$/);
      const ttl = await valkey.ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(3600);
    }
  });

  it('fails CLOSED when the limiter is down: setting the address and sending answer 503 ACCOUNT_UNAVAILABLE (generic), create and send nothing, while confirming and reading still work', async () => {
    const a = await newActor('outage');
    const { address, code, token } = await addAndSend(a); // prepared with a healthy limiter
    const b = await newActor('outage-b');
    const sentB = await addAndSend(b);
    const outage = await makeApp({ limiter: new ValkeyRateLimiter(deadValkey, { prefix: limiterPrefix(), commandTimeoutMs: 300 }) });

    const c = await newActor('outage-c');
    const set = await setEmail(c, newAddress('outage'), { app: outage });
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
    expect(await inboxSize(address)).toBe(1);
    expect(await challengesOf(a.accountId)).toHaveLength(1);

    // the attempt counter in PostgreSQL still protects confirmation, so confirming does not need the limiter
    expect(ok(await detail(a, { app: outage })).emailVerificationStatus).toBe('PENDING');
    fail(await confirmCode(a, wrongCode(code), { app: outage }), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(ok(await confirmCode(a, code, { app: outage })).changed).toBe(true);
    expect(ok(await confirmLink(b, sentB.token, { app: outage })).changed).toBe(true);
    expect(token).toHaveLength(43);
  });

  it('does not limit anything when no limiter is configured, and the database limits (cooldown) still apply', async () => {
    const bare = await makeApp({ limiter: null });
    const a = await newActor('nolimiter');
    const { address } = await addAndSend(a, { app: bare });
    fail(await send(a, { app: bare }), 429, 'ACCOUNT_EMAIL_RESEND_TOO_SOON');
    expect(await inboxSize(address)).toBe(1);
  });
});

// ====================================================================== delivery failures
describe('delivery failures', () => {
  it('answers 503 ACCOUNT_EMAIL_DELIVERY_FAILED (retryable, generic) when the mail server is unreachable, closes the challenge, starts no cooldown, and a later send works', async () => {
    const unreachable = await makeApp({ sender: new SmtpEmailSender({ ...SMTP, port: 1, connectionTimeoutMs: 2000 }, renderer()) });
    const a = await newActor('smtpdown');
    const address = newAddress();
    ok(await setEmail(a, address));
    const r = await send(a, { app: unreachable });
    const error = fail(r, 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED');
    expect(error).toMatchObject({
      category: 'DEPENDENCY',
      message: 'The verification email could not be sent',
      details: { retryable: true, messageKey: 'account.email.error.delivery_failed' },
    });
    expect(Object.keys(error.details).sort()).toEqual(['messageKey', 'retryable']);
    for (const leak of ['ECONNREFUSED', '127.0.0.1', 'smtp', 'SMTP', address.toLowerCase()]) expect(r.raw).not.toContain(leak);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['retry-after']).toBeUndefined();
    // the code never reached anyone: the challenge is FAILED and closed, no cooldown runs, and a made-up code is simply wrong
    const [c] = await challengesOf(a.accountId);
    expect(c).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED', last_sent_at: null, used_at: null });
    const d = ok(await detail(a));
    expect(d.resendAvailableAt).toBeNull();
    expect(d.pending).toMatchObject({ lastSentAt: null, expiresAt: null });
    expect(d.attemptsRemaining).toBeNull();
    fail(await confirmCode(a, '123456'), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect((await challengesOf(a.accountId))[0]!.attempt_count).toBe(0);
    expect((await eventsOf(a.accountId)).filter((e) => e.event_type === EMAIL_EVENTS.verificationSent)).toEqual([]);
    expect(await inboxSize(address)).toBe(0);
    // immediately afterwards, with a working server: it simply works, one message
    const sent = await sendAgain(a, address, { mails: 1 });
    expect(await inboxSize(address)).toBe(1);
    expect(ok(await confirmCode(a, sent.code)).changed).toBe(true);
    expect((await challengesOf(a.accountId)).map((x) => [x.delivery_status, x.invalidation_reason])).toEqual([
      ['FAILED', 'DELIVERY_FAILED'],
      ['SENT', null],
    ]);
  });

  it('reports a message that cannot be rendered as a NON-retryable delivery failure, without any detail of the cause', async () => {
    const broken = await makeApp({
      sender: new SmtpEmailSender(SMTP, {
        render: async () => {
          throw new Error('template exploded with the code 424242 for someone@example.test');
        },
      }),
    });
    const a = await newActor('norender');
    ok(await setEmail(a, newAddress(), { app: broken }));
    const r = await send(a, { app: broken });
    const error = fail(r, 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED');
    expect(error.details).toEqual({ retryable: false, messageKey: 'account.email.error.delivery_failed' });
    expect(r.raw).not.toMatch(/exploded|424242|someone@/);
    expect((await challengesOf(a.accountId))[0]).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED' });
  });

  it('counts failed deliveries towards the hourly cap, so a failing relay cannot be hammered either', async () => {
    const unreachable = await makeApp({
      policy: { resendSeconds: 0, maxPerHour: 2 },
      sender: new SmtpEmailSender({ ...SMTP, port: 1, connectionTimeoutMs: 2000 }, renderer()),
    });
    const good = await makeApp({ policy: { resendSeconds: 0, maxPerHour: 2 } });
    const a = await newActor('failcap');
    const address = newAddress();
    ok(await setEmail(a, address, { app: unreachable }));
    fail(await send(a, { app: unreachable }), 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED');
    fail(await send(a, { app: unreachable }), 503, 'ACCOUNT_EMAIL_DELIVERY_FAILED');
    fail(await send(a, { app: good }), 429, 'ACCOUNT_EMAIL_SEND_LIMIT');
    expect(await inboxSize(address)).toBe(0);
  });
});

// ====================================================================== #30 the read model
describe('the email read model (#30)', () => {
  it('walks GET /account/email and GET /account/me through NONE, PENDING (set), PENDING (sent), after a wrong code, and VERIFIED', async () => {
    const a = await newActor('readmodel');
    const none = ok(await detail(a));
    expect(AccountEmailResponse.safeParse(transcript.at(-1)!.body).success).toBe(true);
    expect(none).toEqual({
      emailVerificationStatus: 'NONE',
      primary: null,
      pending: null,
      resendAvailableAt: null,
      attemptsRemaining: null,
      codeLength: 6,
      validityMinutes: 10,
    });
    expect(ok(await me(a)).email).toEqual({ emailVerificationStatus: 'NONE', primary: null, pending: null });

    const address = newAddress();
    ok(await setEmail(a, address));
    const setState = ok(await detail(a));
    expect(setState).toMatchObject({
      emailVerificationStatus: 'PENDING',
      resendAvailableAt: null,
      attemptsRemaining: null,
      codeLength: 6,
      validityMinutes: 10,
    });
    expect(setState.pending).toMatchObject({ lastSentAt: null, expiresAt: null });

    const sent = await sendAgain(a, address, { mails: 1 });
    const sentState = ok(await detail(a));
    expect(sentState).toMatchObject({ emailVerificationStatus: 'PENDING', attemptsRemaining: 5 });
    expect(sentState.pending).toMatchObject({ lastSentAt: sent.data.sentAt, expiresAt: sent.data.expiresAt });
    fail(await confirmCode(a, wrongCode(sent.code)), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(ok(await detail(a)).attemptsRemaining).toBe(4);
    ok(await confirmCode(a, sent.code));
    expect(ok(await me(a)).email.emailVerificationStatus).toBe('VERIFIED');
  });

  it('shows the countdown, the attempts left and the code policy after a send, and clears them once the address is verified', async () => {
    const a = await newActor('readmodel2');
    const { code, data } = await addAndSend(a);
    const sentState = ok(await detail(a));
    expect(sentState).toMatchObject({ emailVerificationStatus: 'PENDING', attemptsRemaining: 5, codeLength: 6, validityMinutes: 10 });
    expect(sentState.pending).toMatchObject({ purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: data.sentAt, expiresAt: data.expiresAt });
    expect(new Date(sentState.resendAvailableAt).toISOString()).toBe(data.resendAvailableAt);
    fail(await confirmCode(a, wrongCode(code)), 400, 'ACCOUNT_EMAIL_CODE_INVALID');
    expect(ok(await detail(a)).attemptsRemaining).toBe(4);
    expect(ok(await me(a)).email.pending.status).toBe('PENDING');
    ok(await confirmCode(a, code));
    const done = ok(await detail(a));
    expect(done).toMatchObject({
      emailVerificationStatus: 'VERIFIED',
      resendAvailableAt: null,
      attemptsRemaining: null,
      pending: null,
      codeLength: 6,
      validityMinutes: 10,
    });
    expect(done.primary).toMatchObject({ source: 'USER_ENTERED' });
  });

  it('is masked at every stage: no response of the read model contains the address, its local part or its domain', async () => {
    const a = await newActor('masked');
    const address = newAddress('maskedperson');
    const stages: Res[] = [await detail(a), await me(a)];
    stages.push(await setEmail(a, address), await detail(a), await me(a));
    const sent = await sendAgain(a, address, { mails: 1 });
    stages.push(transcript.at(-1)!, await detail(a), await me(a));
    ok(await confirmCode(a, sent.code));
    stages.push(await detail(a), await me(a));
    for (const r of stages) {
      expect(r.status, r.raw).toBe(200);
      for (const text of [address, address.toLowerCase(), localOf(address), 'example.test', 'maskedperson'])
        expect(r.raw, `${r.url} shows ${text}`).not.toContain(text);
    }
    expect(stages.at(-1)!.raw).toContain(maskEmail(address.toLowerCase()));
  });
});

// ====================================================================== account status
describe('account status gates the email routes', () => {
  it('refuses a SUSPENDED account on all five routes with 403 ACCOUNT_SUSPENDED (no mail, no change) and serves it again once reactivated', async () => {
    const a = await newActor('suspended');
    const { address, code } = await addAndSend(a);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'integration test' });
    const before = await emailRowCounts();
    for (const [, method, url, body] of ROUTES_OF_EMAIL) {
      const error = fail(await call(a, method, url, { body: method === 'POST' && url.endsWith('confirm-code') ? { code } : body }), 403, 'ACCOUNT_SUSPENDED');
      expect(error.category).toBe('AUTHORIZATION');
    }
    expect(await emailRowCounts()).toEqual(before);
    expect(await inboxSize(address)).toBe(1);
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest', reason: 'integration test' });
    expect(ok(await confirmCode(a, code)).changed).toBe(true);
  });

  it('refuses a CLOSED account with 403 ACCOUNT_CLOSED, and a closed account cannot receive an address', async () => {
    const a = await newActor('closed');
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(a.accountId, 'CLOSED', { actor: 'system:itest', reason: 'integration test' });
    for (const [, method, url, body] of ROUTES_OF_EMAIL) fail(await call(a, method, url, { body }), 403, 'ACCOUNT_CLOSED');
    expect(await contactsOf(a.accountId)).toEqual([]);
  });
});

// ====================================================================== public surface and the whole run
describe('public endpoints and the whole run', () => {
  it("exposes no address, code, token or hash on the public content and geography endpoints: the copy is public reference text, and the verification email cannot be rendered without the caller's own values", async () => {
    const templated = ['account.email.verification.body', 'account.email.verify.intro', 'account.email.verify.resend_wait'];
    const plain = (await content.listEntries()).map((e) => e.key).filter((k) => k.startsWith('account.email.') && !templated.includes(k));
    expect(plain).toHaveLength(31);
    const locales = await call(undefined, 'GET', '/content/locales', { ip: null });
    const countries = await call(undefined, 'GET', '/geography/countries', { ip: null });
    const copy = await call(undefined, 'POST', '/content/resolve-many', { body: { keys: plain, locale: 'en-US' }, ip: null });
    for (const r of [locales, countries, copy]) expect(r.status, r.raw.slice(0, 200)).toBe(200);
    expect(copy.body.data.items).toHaveLength(31);
    // the verification email template holds no value of its own: without the caller's variables the public API refuses to render it
    const bare = await call(undefined, 'POST', '/content/resolve', { body: { key: 'account.email.verification.body', locale: 'en-US' }, ip: null });
    expect(bare.status).toBe(400);
    expect(bare.body.error.details).toMatchObject({ reason: 'MISSING_REQUIRED_VARIABLE' });
    const text = [locales, countries, copy, bare].map((r) => r.raw).join('\n');
    expect(addresses.length).toBeGreaterThan(20);
    expect(delivered.codes.size).toBeGreaterThan(10);
    for (const secret of [...addresses, ...addresses.map(localOf), ...[...delivered.codes].map((c) => `"${c}"`), ...delivered.tokens, HASH_KEY])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/email_normalized|code_hash|magic_token_hash/);
  });

  it('keeps the invariants of the whole run: one primary per account, a verified address on one account only, no open challenge on a closed contact, hashes only', async () => {
    expect(await q(`SELECT account_id FROM identity.email_contacts WHERE is_primary GROUP BY account_id HAVING count(*) > 1`)).toEqual([]);
    expect(await q(`SELECT email_normalized FROM identity.email_contacts WHERE status = 'VERIFIED' GROUP BY email_normalized HAVING count(*) > 1`)).toEqual([]);
    expect(
      await q(`SELECT account_id FROM identity.email_contacts WHERE status IN ('PENDING', 'REPLACEMENT_PENDING') GROUP BY account_id HAVING count(*) > 1`),
    ).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
          WHERE c.used_at IS NULL AND c.invalidated_at IS NULL AND k.status NOT IN ('PENDING', 'REPLACEMENT_PENDING')`,
      ),
    ).toEqual([]);
    expect(await q(`SELECT 1 FROM identity.email_verification_challenges WHERE code_hash !~ '^[0-9a-f]{64}$' OR magic_token_hash !~ '^[0-9a-f]{64}$'`)).toEqual(
      [],
    );
    for (const code of delivered.codes) expect(await q(`SELECT 1 FROM identity.email_verification_challenges WHERE code_hash = $1`, [code])).toEqual([]);
    expect(await q(`SELECT 1 FROM identity.email_contacts WHERE email_normalized <> lower(email_normalized)`)).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM identity.accounts a WHERE EXISTS (SELECT 1 FROM identity.email_contacts c WHERE c.account_id = a.account_id AND c.is_primary) AND a.status = 'PENDING'`,
      ),
    ).toEqual([]);
  });

  it('sent every email response of this run with Cache-Control: no-store, exactly the documented shapes, and Retry-After only on 429s', async () => {
    const emailResponses = transcript.filter((r) => r.url.startsWith('/api/v1/account/email') || r.url === '/api/v1/account/me');
    expect(emailResponses.length).toBeGreaterThan(300);
    for (const r of emailResponses.filter((x) => x.body !== undefined && x.url.startsWith('/api/v1/account/'))) {
      expect(r.headers['cache-control'], `${r.method} ${r.url} ${r.status}`).toBe('no-store');
      if (r.status !== 429) expect(r.headers['retry-after'], `${r.method} ${r.url} ${r.status}`).toBeUndefined();
      expect(Object.keys(r.body).sort(), r.raw.slice(0, 120)).toEqual(r.status === 200 ? ['data', 'meta'] : ['error']);
    }
    // no response of the run holds a delivered code (as a JSON string value), a token, the hash key, or any full address
    const secrets = [...[...delivered.codes].map((c) => `"${c}"`), ...delivered.tokens, HASH_KEY, ...addresses.filter((a) => a === a.toLowerCase())];
    for (const r of transcript.filter((x) => x.url.startsWith('/api/v1/account/'))) {
      const text = `${r.raw}\n${JSON.stringify(r.headers)}`;
      for (const secret of secrets) if (text.includes(secret)) throw new Error(`${r.method} ${r.url} ${r.status} contains ${secret.slice(0, 20)}`);
    }
    // the responses that are errors all validate against the standard envelope
    for (const r of emailResponses.filter((x) => x.status >= 400 && x.status < 600))
      expect(ErrorResponse.safeParse(r.body).success, r.raw.slice(0, 160)).toBe(true);
    // every "request completed" correlation id the service saw was the caller's: the success bodies echo it
    for (const r of emailResponses.filter((x) => x.status === 200)) expect(r.body.meta.correlationId).toBe(r.cid);
  });
});
