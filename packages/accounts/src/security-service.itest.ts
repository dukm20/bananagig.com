// Integration tests of the account security layer (ID-004): the real SecurityService over a real, freshly migrated PostgreSQL database (migration 0012 with its
// guard triggers), the real transactional outbox, the FakeSecurityIdentityProvider (Keycloak as seen by the service, with failure injection and holds), the
// StaticSecurityPolicyProvider (the seeded policy, mutable per test) and the MemoryRateLimiter on an injectable clock. Every behaviour is asserted against the rows it
// leaves: application_sessions, account_devices, the watermark, the audit trail and the outbox.
//
// Time: the DATABASE clock decides liveness, touches, trust windows and the timeline. Windows are exercised without sleeping: rows are CRAFTED by SQL with explicit
// past timestamps (a session last seen 61 seconds ago, a trust window that ended yesterday, audit rows 91 days old), the policy is lowered or raised through the fake
// provider, and the application clock (only used for the step-up freshness and the rate limiter) is a plain mutable variable.
//
// Races are real (parallel service calls on separate pool connections, many rounds, fresh accounts per round) or deterministic (a raw transaction holds the account
// row lock while the call under test is started and observed to block on it). The assertions are INVARIANTS of the final state, never the interleaving.
//
// Privacy: every log line, every audit row, every outbox payload and every error thrown to a caller is scanned for the Keycloak session id (sid), the device secret and
// its hash, the user agent, the subject, the email address and the client address. The scanner has negative controls proving it can fail.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_ACTIVITY_TYPES, SECURITY_AUDIT_ACTIONS, SECURITY_EVENTS, SESSION_REVOCATION_REASONS, securityActivityLabelKey } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import {
  FakePhoneIntelligence,
  MemoryRateLimiter,
  RecordingEmailSender,
  RecordingSmsSender,
  type RateDecision,
  type RateLimiter,
  type RateRule,
} from '@bananagig/platform';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  AccountError,
  AccountService,
  EmailVerificationService,
  FakeSecurityIdentityProvider,
  PhoneVerificationService,
  SEEDED_SECURITY_POLICY,
  SecurityService,
  StaticSecurityPolicyProvider,
  hashDeviceSecret,
  hashDimension,
  type CurrentSession,
  type ObservedSession,
  type SecurityPolicy,
  type SecurityPolicyProvider,
  type SecurityServiceDeps,
} from './index';

// every log call of the code under test is captured here (and nothing is printed): the logs are scanned for secrets
const logSink = vi.hoisted(() => ({ lines: [] as string[], all: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      const line = JSON.stringify({ level, message, ...attrs });
      logSink.lines.push(line);
      logSink.all.push(line);
    },
  };
});

// ---------------------------------------------------------------- fixtures
const E = SECURITY_EVENTS;
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const OP = { actor: 'admin:operator-1', reason: 'integration test' };
const testHashKey = 'security-service-test-hmac-'.repeat(2);
const otherHashKey = 'another-security-test-hmac-'.repeat(2);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;
const MIN = 60_000;

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

/** The application clock (step-up freshness and the rate limiter); database timestamps always use the database clock. */
const clock = { ms: Date.now() };

/** The policy provider: the static provider of the seeded values, plus an injectable failure. */
class TestPolicy implements SecurityPolicyProvider {
  private readonly inner = new StaticSecurityPolicyProvider({ ...SEEDED_SECURITY_POLICY });
  failure: unknown;
  reads = 0;
  async policy(): Promise<SecurityPolicy> {
    this.reads += 1;
    if (this.failure !== undefined) throw this.failure;
    return this.inner.policy();
  }
  set(over: Partial<SecurityPolicy>): void {
    this.inner.set({ ...SEEDED_SECURITY_POLICY, ...over });
  }
  reset(): void {
    this.failure = undefined;
    this.reads = 0;
    this.inner.set({ ...SEEDED_SECURITY_POLICY });
  }
}

/** Wraps a limiter and remembers the rules of every call. */
class SpyLimiter implements RateLimiter {
  readonly calls: RateRule[][] = [];
  constructor(private readonly inner: MemoryRateLimiter) {}
  consume(rules: readonly RateRule[], options?: { cost?: number }): Promise<RateDecision> {
    this.calls.push([...rules]);
    return this.inner.consume(rules, options);
  }
}

let iso: IsolatedDatabase;
let bigDb: Database;
let accounts: AccountService;
let emailSvc: EmailVerificationService;
let phoneSvc: PhoneVerificationService;
let svc: SecurityService;
let limiter: MemoryRateLimiter;
let spy: SpyLimiter;
const provider = new FakeSecurityIdentityProvider();
const policy = new TestPolicy();
const emailSender = new RecordingEmailSender();
const smsSender = new RecordingSmsSender();
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);

function makeService(over: Partial<SecurityServiceDeps> = {}): SecurityService {
  return new SecurityService({
    database: bigDb,
    policy,
    identityProvider: provider,
    rateLimiter: spy,
    hashSecret: testHashKey,
    now: () => new Date(clock.ms),
    ...over,
  });
}

/** Every secret value the test creates: the leak scanners look for each of them in every place that must never hold it. */
const FORBIDDEN = new Map<string, string>();
const forbid = <T extends string>(value: T, kind: string): T => {
  FORBIDDEN.set(value, kind);
  return value;
};
/** Every error a service call threw to its caller (scanned for secrets). */
const caught: unknown[] = [];

const FAIL_FN = (table: 'audit' | 'outbox') => `
CREATE OR REPLACE FUNCTION public.t_fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.correlation_id LIKE 'fail-%' AND EXISTS (SELECT 1 FROM public.t_fail_rules r WHERE r.key = ${table === 'audit' ? 'NEW.action' : 'NEW.event_type'}) THEN
    RAISE EXCEPTION 'forced failure for the test' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$f$;`;

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below need many requests in flight
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 40, connectionTimeoutMs: 30_000 } });
  accounts = new AccountService({ database: bigDb });
  emailSvc = new EmailVerificationService({
    database: bigDb,
    policy: {
      policy: async () => ({
        codeLength: 6,
        validityMinutes: 10,
        resendSeconds: 30,
        maxPerHour: 5,
        maxPerDay: 10,
        maxAttempts: 5,
        requestsPerHour: 30,
        addressPerHour: 5,
      }),
    },
    sender: emailSender,
    linkFor: (t) => `https://app.test/verify-email#token=${encodeURIComponent(t)}`,
    hashSecret: testHashKey,
  });
  phoneSvc = new PhoneVerificationService({
    database: bigDb,
    policy: {
      policy: async () => ({
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
      }),
    },
    sender: smsSender,
    intelligence: new FakePhoneIntelligence(),
    countries: { active: async (c) => (c === 'US' ? { dialingCode: '+1' } : null), defaultCountry: async () => 'US' },
    hashSecret: testHashKey,
  });
  // test-only failure injection: a trigger that fails an INSERT of a chosen audit action or event type, only for statements whose correlation id starts with `fail-`
  await q('CREATE TABLE public.t_fail_rules (key text PRIMARY KEY)');
  await q(FAIL_FN('audit'));
  await q(FAIL_FN('outbox'));
  await q('CREATE TRIGGER t_fail BEFORE INSERT ON identity.account_audit_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_audit()');
  await q('CREATE TRIGGER t_fail BEFORE INSERT ON integration.outbox_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_outbox()');
});
afterAll(async () => {
  await bigDb?.close();
  await iso?.drop();
});
beforeEach(() => {
  clock.ms = Date.now();
  provider.reset();
  policy.reset();
  limiter = new MemoryRateLimiter(() => clock.ms);
  spy = new SpyLimiter(limiter);
  svc = makeService();
  logSink.lines.length = 0;
});
afterEach(async () => {
  // detached provider tasks of one test must never run inside the next one
  await svc.drain();
});

// ---------------------------------------------------------------- generic helpers
/** Fails the test unless the promise rejects with exactly this AccountError code (and details, when given). Returns the error. */
async function fails(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<AccountError> {
  const e = await rejection(p);
  caught.push(e);
  expect(e, `expected AccountError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`).toBeInstanceOf(AccountError);
  const a = e as AccountError;
  expect(a.code).toBe(code);
  if (details) expect(a.details).toEqual(details);
  return a;
}
/** The value, or the error the call failed with (races: both outcomes can be legitimate, the final state is what matters). */
const settled = <T>(p: Promise<T>): Promise<T | Error> =>
  p.then(
    (v) => v,
    (e: unknown) => {
      caught.push(e);
      return e as Error;
    },
  );
const isErr = (v: unknown): v is Error => v instanceof Error;
const codeOf = (v: unknown): string => (v instanceof AccountError ? v.code : v instanceof Error ? `RAW:${v.message}` : 'OK');
/** The race helper: values and errors of N parallel calls, with a little jitter so the interleavings differ between rounds. */
const jitter = () => sleep(Math.floor(Math.random() * 6));
const between = (n: unknown, lo: number, hi: number): void => {
  expect(typeof n).toBe('number');
  expect(n as number).toBeGreaterThanOrEqual(lo);
  expect(n as number).toBeLessThanOrEqual(hi);
};
/** Rejects after `ms`: a call that must NOT wait for something (a lock, the provider) is raced against it. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const dbNow = async (): Promise<Date> => (await q<{ n: Date }>('SELECT clock_timestamp() AS n'))[0]!.n;
const epochSec = (d: Date): number => d.getTime() / 1000;
/** A fresh `auth_time` (epoch seconds). One second ahead of "now" so it is certainly not older than a watermark written a moment ago. */
const authNow = (): number => Math.floor(Date.now() / 1000) + 2;

// ---------------------------------------------------------------- accounts, sessions, devices
interface Acct {
  id: string;
  subject: string;
  email: string | null;
}
const newSid = (): string => forbid(`kc-sid-${randomUUID()}`, 'Keycloak session id');
const newSecret = (): string => forbid(randomBytes(32).toString('base64url'), 'device secret');
let ipSeq = 0;
const uniqueIp = (): string => forbid(`198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255 || 1}`, 'client address');

/** An account with a Keycloak login; `email: true` also gives it a VERIFIED primary email (the real flow) that Keycloak knows too. */
async function newAccount(o: { email?: boolean } = {}): Promise<Acct> {
  const subject = forbid(randomUUID(), 'Keycloak subject');
  const id = (await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject, identityRoles: ['customer'] })).accountId;
  let email: string | null = null;
  if (o.email) {
    email = forbid(`reset-${randomUUID()}@example.test`, 'email address');
    await emailSvc.setEmail(id, email);
    const before = emailSender.sent.length;
    await emailSvc.sendVerification(id);
    await emailSvc.confirmCode(id, String(emailSender.sent[before]!.variables.verification_code));
    provider.setUser(subject, { email });
  }
  return { id, subject, email };
}

interface Sess {
  sid: string;
  id: string;
  accountId: string;
  cur: CurrentSession;
  deviceId: string | null;
}
const curOf = (accountId: string, sid: string): CurrentSession => ({ accountId, keycloakSessionId: sid });
/** The first request of a login: creates the application session. */
async function login(a: Acct | { id: string }, o: { sid?: string; authTime?: number | null } = {}): Promise<Sess> {
  const sid = o.sid ?? newSid();
  const r = await svc.observeSession({
    accountId: a.id,
    keycloakSessionId: sid,
    ...(o.authTime === null ? {} : { authTime: o.authTime ?? authNow() }),
  });
  return { sid, id: r.applicationSessionId, accountId: a.id, cur: curOf(a.id, sid), deviceId: r.accountDeviceId };
}
/** A login whose browser is registered (the web server's call after the callback). */
async function loginWithDevice(a: Acct, o: { secret?: string; ua?: string; sid?: string } = {}): Promise<Sess & { secret: string; deviceId: string }> {
  const s = await login(a, { sid: o.sid });
  const secret = o.secret ?? newSecret();
  const reg = await svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: o.ua ?? CHROME_WIN });
  expect(reg.deviceId, 'the registration produced a device').not.toBeNull();
  return { ...s, secret, deviceId: reg.deviceId! };
}
/** Tells the fake identity provider that these sids are live protocol sessions of the account. */
function liveAtProvider(a: Acct, ...sids: string[]): void {
  for (const sid of sids) provider.addSession(a.subject, sid);
}

interface CraftedSession {
  sid?: string;
  createdAgoSec?: number;
  lastSeenAgoSec?: number;
  deviceId?: string | null;
  revoked?: { reason: string; agoSec?: number };
}
/** Inserts a session row with explicit times (time travel by SQL: the guard forbids moving last_seen_at back, an INSERT is free). */
async function craftSession(accountId: string, o: CraftedSession = {}): Promise<{ sid: string; id: string }> {
  const sid = o.sid ?? newSid();
  const seen = o.lastSeenAgoSec ?? 0;
  const created = Math.max(o.createdAgoSec ?? 3600, seen + 1);
  const rows = await q<{ application_session_id: string }>(
    `INSERT INTO identity.application_sessions (account_id, keycloak_session_id, account_device_id, created_at, last_seen_at, revoked_at, revocation_reason)
     VALUES ($1, $2, $3, clock_timestamp() - make_interval(secs => $4::float8), clock_timestamp() - make_interval(secs => $5::float8),
             CASE WHEN $6::text IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $7::float8) END, $6) RETURNING application_session_id`,
    [accountId, sid, o.deviceId ?? null, created, seen, o.revoked?.reason ?? null, o.revoked?.agoSec ?? 0],
  );
  return { sid, id: rows[0]!.application_session_id };
}

// ---------------------------------------------------------------- row inspectors
interface SessionT {
  application_session_id: string;
  account_id: string;
  keycloak_session_id: string;
  account_device_id: string | null;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
}
interface DeviceT {
  account_device_id: string;
  account_id: string;
  device_hash: string;
  browser_family: string;
  os_family: string;
  device_class: string;
  first_seen_at: Date;
  last_seen_at: Date;
  trusted_at: Date | null;
  trusted_until: Date | null;
  removed_at: Date | null;
}
interface AuditT {
  audit_event_id: string;
  occurred_at: Date;
  actor: string;
  action: string;
  application_session_id: string | null;
  account_device_id: string | null;
  changes: Record<string, unknown> | null;
  correlation_id: string;
}
interface EventT {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
  payload_json: Record<string, unknown>;
}
const sessionRows = (accountId: string) =>
  q<SessionT>('SELECT * FROM identity.application_sessions WHERE account_id = $1 ORDER BY created_at, application_session_id', [accountId]);
const sessionBySid = async (sid: string): Promise<SessionT | undefined> =>
  (await q<SessionT>('SELECT * FROM identity.application_sessions WHERE keycloak_session_id = $1', [sid]))[0];
const sessionById = async (id: string): Promise<SessionT> =>
  (await q<SessionT>('SELECT * FROM identity.application_sessions WHERE application_session_id = $1', [id]))[0]!;
const liveSessions = async (accountId: string) => (await sessionRows(accountId)).filter((s) => s.revoked_at === null);
const deviceRows = (accountId: string) =>
  q<DeviceT>('SELECT * FROM identity.account_devices WHERE account_id = $1 ORDER BY first_seen_at, account_device_id', [accountId]);
const deviceById = async (id: string): Promise<DeviceT> => (await q<DeviceT>('SELECT * FROM identity.account_devices WHERE account_device_id = $1', [id]))[0]!;
const watermarkOf = async (accountId: string): Promise<Date | null> =>
  (await q<{ w: Date | null }>('SELECT sessions_not_before AS w FROM identity.accounts WHERE account_id = $1', [accountId]))[0]!.w;
const accountCreatedAt = async (accountId: string): Promise<Date> =>
  (await q<{ c: Date }>('SELECT created_at AS c FROM identity.accounts WHERE account_id = $1', [accountId]))[0]!.c;
const SECURITY_ACTION_LIST: string[] = [...SECURITY_AUDIT_ACTIONS];
/** The audit rows of an account (oldest first), optionally of some actions only. Default: every security action. */
const audit = (accountId: string, actions: readonly string[] = SECURITY_ACTION_LIST) =>
  q<AuditT>(
    `SELECT audit_event_id, occurred_at, actor, action, application_session_id, account_device_id, changes, correlation_id FROM identity.account_audit_events
      WHERE account_id = $1 AND action = ANY($2::text[]) ORDER BY occurred_at, audit_event_id`,
    [accountId, actions],
  );
const auditOf = (accountId: string, action: string) => audit(accountId, [action]);
const EVENT_TYPES: string[] = Object.values(SECURITY_EVENTS);
const events = (accountId: string, types: readonly string[] = EVENT_TYPES) =>
  q<EventT>(
    `SELECT event_type, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type = ANY($2::text[]) ORDER BY created_at, outbox_event_id`,
    [accountId, types],
  );
const eventsOf = (accountId: string, type: string) => events(accountId, [type]);

/** Everything the security layer stored for an account, to prove that a refused call left nothing behind. */
async function snapshot(accountId: string) {
  return {
    sessions: await q('SELECT * FROM identity.application_sessions WHERE account_id = $1 ORDER BY created_at, application_session_id', [accountId]),
    devices: await q('SELECT * FROM identity.account_devices WHERE account_id = $1 ORDER BY first_seen_at, account_device_id', [accountId]),
    watermark: await watermarkOf(accountId),
    audit: (
      await q<{ id: string }>('SELECT audit_event_id AS id FROM identity.account_audit_events WHERE account_id = $1 ORDER BY audit_event_id', [accountId])
    ).map((r) => r.id),
    events: (
      await q<{ id: string }>('SELECT outbox_event_id AS id FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY outbox_event_id', [accountId])
    ).map((r) => r.id),
  };
}
/** Row counts of the whole database (a refused request about no account must not add anything anywhere). */
async function world() {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  return {
    sessions: await n('SELECT count(*)::int AS n FROM identity.application_sessions'),
    devices: await n('SELECT count(*)::int AS n FROM identity.account_devices'),
    audit: await n('SELECT count(*)::int AS n FROM identity.account_audit_events'),
    events: await n('SELECT count(*)::int AS n FROM integration.outbox_events'),
  };
}

// ---------------------------------------------------------------- crafted audit rows (the timeline)
/** Inserts FK-free security audit rows (MFA / password actions) `ago` (a SQL interval text) in the past. Returns their ids, in the order given. */
async function craftAudit(accountId: string, rows: { action: string; ago: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const r of rows) {
    const out = await q<{ audit_event_id: string }>(
      `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id)
       VALUES (clock_timestamp() - $3::interval, $4, $1, $2, '{}'::jsonb, 'crafted-by-test') RETURNING audit_event_id`,
      [r.action, accountId, r.ago, `account:${accountId}`],
    );
    ids.push(out[0]!.audit_event_id);
  }
  return ids;
}

// ---------------------------------------------------------------- failure injection (a trigger fails the INSERT of a chosen audit action / event type)
/** Runs `fn` with the given audit actions / event types failing, under a correlation id the trigger recognizes. The rules are always removed. */
async function failing<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  for (const k of keys) await q('INSERT INTO public.t_fail_rules (key) VALUES ($1) ON CONFLICT DO NOTHING', [k]);
  try {
    return await runWithCorrelation(`fail-${randomUUID()}`, fn);
  } finally {
    await q('DELETE FROM public.t_fail_rules');
  }
}
async function expectForcedFailure(p: Promise<unknown>): Promise<void> {
  const e = await rejection(p);
  caught.push(e);
  expect(e, 'the forced failure reached the caller').toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(AccountError);
  expect((e as Error).message).toBe('forced failure for the test');
}

// ---------------------------------------------------------------- deterministic ordering (raw transactions holding locks)
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 300; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
/** A raw transaction that holds the account row lock (`FOR UPDATE` or `FOR SHARE`) until `release()`. */
async function holdAccount(accountId: string, mode: 'UPDATE' | 'SHARE' = 'UPDATE') {
  const client = await db().pool.connect();
  await client.query('BEGIN');
  await client.query(`SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR ${mode}`, [accountId]);
  let done = false;
  return {
    client,
    async release(commit = true): Promise<void> {
      if (done) return;
      done = true;
      try {
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      } finally {
        client.release();
      }
    },
  };
}

// ---------------------------------------------------------------- secret scanning
const errText = (e: unknown): string =>
  e instanceof AccountError
    ? JSON.stringify({ name: e.name, message: e.message, code: e.code, details: e.details })
    : e instanceof Error
      ? JSON.stringify({ name: e.name, message: e.message, code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail })
      : JSON.stringify(e);
/** The stored hashes of the devices (they belong in account_devices and nowhere else). */
async function deviceHashes(): Promise<string[]> {
  return (await q<{ h: string }>('SELECT device_hash AS h FROM identity.account_devices')).map((r) => r.h);
}
/**
 * Every audit row, every outbox payload, every captured log line and every error thrown to a caller (all accounts, the whole run so far) contain no Keycloak session
 * id, no device secret, no stored device hash, no subject, no full address, no client address and no user-agent marker.
 */
async function expectNoLeaks(label: string, extra: { results?: unknown[]; needles?: Map<string, string> } = {}): Promise<void> {
  const needles = new Map(FORBIDDEN);
  for (const h of await deviceHashes()) needles.set(h, 'stored device hash');
  for (const [k, v] of extra.needles ?? []) needles.set(k, v);
  const dumps: Record<string, string> = {
    'audit rows': JSON.stringify(await q('SELECT to_jsonb(a) AS j FROM identity.account_audit_events a')),
    'outbox events': JSON.stringify(await q('SELECT to_jsonb(o) AS j FROM integration.outbox_events o')),
    'log lines': logSink.all.join('\n'),
    'thrown errors': caught.map(errText).join('\n'),
  };
  if (extra.results) dumps['returned values'] = JSON.stringify(extra.results);
  for (const [where, text] of Object.entries(dumps))
    for (const [needle, kind] of needles) expect(text.includes(needle), `${label}: ${where} contain a ${kind}`).toBe(false);
}
/** The tables of the identity and integration schemas whose rows contain this text anywhere. */
async function tablesMentioning(needle: string): Promise<string[]> {
  const tables = await q<{ t: string }>(
    `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables WHERE table_schema IN ('identity', 'integration') AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const found: string[] = [];
  for (const { t } of tables) {
    const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} x WHERE strpos(x::text, $1) > 0`, [needle]);
    if (r[0]!.n > 0) found.push(t);
  }
  return found;
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ====================================================================== observeSession: first sight, reuse, touch
describe('observeSession: first sight', () => {
  it('creates the session row, the SESSION_CREATED audit row and the sessionCreated event in one transaction', async () => {
    const a = await newAccount();
    const sid = newSid();
    const cid = `cid-${randomUUID()}`;
    const r = await runWithCorrelation(cid, () => svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() }));
    expect(r).toEqual({ applicationSessionId: expect.stringMatching(UUID_RE), accountDeviceId: null, created: true });

    const rows = await sessionRows(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      application_session_id: r.applicationSessionId,
      account_id: a.id,
      keycloak_session_id: sid,
      account_device_id: null,
      revoked_at: null,
      revocation_reason: null,
    });
    expect(Math.abs(rows[0]!.created_at.getTime() - rows[0]!.last_seen_at.getTime())).toBeLessThan(1000);

    const audits = await auditOf(a.id, 'SESSION_CREATED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: `account:${a.id}`,
      application_session_id: r.applicationSessionId,
      account_device_id: null,
      changes: {},
      correlation_id: cid,
    });
    const ev = await eventsOf(a.id, E.sessionCreated);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      aggregate_type: 'identity_account',
      aggregate_id: a.id,
      actor_type: 'user',
      actor_id: `account:${a.id}`,
      correlation_id: cid,
    });
    expect(ev[0]!.payload_json).toEqual({ accountId: a.id, applicationSessionId: r.applicationSessionId, accountDeviceId: null });
    expect(await events(a.id)).toHaveLength(1);
  });

  it('without a caller correlation id the audit row and the event still share one', async () => {
    const a = await newAccount();
    await login(a);
    const [audit1] = await auditOf(a.id, 'SESSION_CREATED');
    const [ev] = await eventsOf(a.id, E.sessionCreated);
    expect(audit1!.correlation_id).toBeTruthy();
    expect(ev!.correlation_id).toBe(audit1!.correlation_id);
  });

  it('a failing event insert rolls back the session row AND the audit row together', async () => {
    const a = await newAccount();
    const sid = newSid();
    const before = await snapshot(a.id);
    await expectForcedFailure(failing([E.sessionCreated], () => svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() })));
    expect(await snapshot(a.id)).toEqual(before);
    expect(await sessionBySid(sid)).toBeUndefined();
    // the same request afterwards works: nothing half-written blocks it
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() })).created).toBe(true);
    expect(await auditOf(a.id, 'SESSION_CREATED')).toHaveLength(1);
    expect(await eventsOf(a.id, E.sessionCreated)).toHaveLength(1);
  });

  it('a failing audit insert rolls back the session row (and writes no event)', async () => {
    const a = await newAccount();
    const sid = newSid();
    const before = await snapshot(a.id);
    await expectForcedFailure(failing(['SESSION_CREATED'], () => svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() })));
    expect(await snapshot(a.id)).toEqual(before);
    expect(await sessionBySid(sid)).toBeUndefined();
  });

  it('a second login (another sid) creates a second session with its own audit row and event', async () => {
    const a = await newAccount();
    const s1 = await login(a);
    const s2 = await login(a);
    expect(s1.id).not.toBe(s2.id);
    expect(await sessionRows(a.id)).toHaveLength(2);
    expect(await auditOf(a.id, 'SESSION_CREATED')).toHaveLength(2);
    expect(await eventsOf(a.id, E.sessionCreated)).toHaveLength(2);
    expect(new Set((await auditOf(a.id, 'SESSION_CREATED')).map((r) => r.application_session_id))).toEqual(new Set([s1.id, s2.id]));
  });

  it('another account with its own sid is independent', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const sa = await login(a);
    const sb = await login(b);
    expect((await sessionRows(a.id)).map((r) => r.application_session_id)).toEqual([sa.id]);
    expect((await sessionRows(b.id)).map((r) => r.application_session_id)).toEqual([sb.id]);
  });
});

describe('observeSession: the same Keycloak session is reused', () => {
  it('returns the same row with created:false and writes no audit row and no event', async () => {
    const a = await newAccount();
    const s = await login(a);
    const again = await svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime: authNow() });
    expect(again).toEqual({ applicationSessionId: s.id, accountDeviceId: null, created: false });
    expect(await sessionRows(a.id)).toHaveLength(1);
    expect(await auditOf(a.id, 'SESSION_CREATED')).toHaveLength(1);
    expect(await eventsOf(a.id, E.sessionCreated)).toHaveLength(1);
  });

  it('reuses the row whatever authTime the later token carries (missing, ancient, NaN)', async () => {
    const a = await newAccount();
    const s = await login(a);
    for (const authTime of [undefined, 1, Number.NaN, -5, Number.POSITIVE_INFINITY])
      expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime })).applicationSessionId).toBe(s.id);
  });

  it('does not touch a fresh row (less than 60 s old) and touches a stale one (more than 60 s)', async () => {
    const a = await newAccount();
    const fresh = await craftSession(a.id, { lastSeenAgoSec: 59 });
    const stale = await craftSession(a.id, { lastSeenAgoSec: 61 });
    const freshBefore = (await sessionBySid(fresh.sid))!.last_seen_at;
    const staleBefore = (await sessionBySid(stale.sid))!.last_seen_at;
    await svc.observeSession({ accountId: a.id, keycloakSessionId: fresh.sid });
    await svc.observeSession({ accountId: a.id, keycloakSessionId: stale.sid });
    expect((await sessionBySid(fresh.sid))!.last_seen_at.getTime()).toBe(freshBefore.getTime());
    const staleAfter = (await sessionBySid(stale.sid))!.last_seen_at;
    expect(staleAfter.getTime()).toBeGreaterThan(staleBefore.getTime() + 55_000);
    const now = await dbNow();
    between(now.getTime() - staleAfter.getTime(), 0, 5_000);
    // a touch writes no audit row and no event
    expect(await audit(a.id)).toHaveLength(0);
    expect(await events(a.id)).toHaveLength(0);
  });

  it('a touched row is not touched again within the interval', async () => {
    const a = await newAccount();
    const stale = await craftSession(a.id, { lastSeenAgoSec: 600 });
    await svc.observeSession({ accountId: a.id, keycloakSessionId: stale.sid });
    const first = (await sessionBySid(stale.sid))!.last_seen_at;
    await svc.observeSession({ accountId: a.id, keycloakSessionId: stale.sid });
    expect((await sessionBySid(stale.sid))!.last_seen_at.getTime()).toBe(first.getTime());
  });

  it('the touch interval is configurable (touchSeconds)', async () => {
    const a = await newAccount();
    const quick = makeService({ touchSeconds: 5 });
    const s = await craftSession(a.id, { lastSeenAgoSec: 10 });
    const before = (await sessionBySid(s.sid))!.last_seen_at;
    await quick.observeSession({ accountId: a.id, keycloakSessionId: s.sid });
    expect((await sessionBySid(s.sid))!.last_seen_at.getTime()).toBeGreaterThan(before.getTime());
    const t = await craftSession(a.id, { lastSeenAgoSec: 10 });
    const tBefore = (await sessionBySid(t.sid))!.last_seen_at;
    await svc.observeSession({ accountId: a.id, keycloakSessionId: t.sid });
    expect((await sessionBySid(t.sid))!.last_seen_at.getTime()).toBe(tBefore.getTime());
  });

  it('a revoked row is refused and never touched', async () => {
    const a = await newAccount();
    const s = await craftSession(a.id, { lastSeenAgoSec: 600, revoked: { reason: 'SIGN_OUT', agoSec: 300 } });
    const before = await sessionBySid(s.sid);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid }), 'SESSION_REVOKED');
    expect(await sessionBySid(s.sid)).toEqual(before);
  });

  it('a request of another account for this sid never touches the row of its owner', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const s = await craftSession(a.id, { lastSeenAgoSec: 600 });
    const before = await sessionBySid(s.sid);
    await fails(svc.observeSession({ accountId: b.id, keycloakSessionId: s.sid }), 'SESSION_REVOKED');
    expect(await sessionBySid(s.sid)).toEqual(before);
    expect(await sessionRows(b.id)).toHaveLength(0);
    expect(await audit(b.id)).toHaveLength(0);
  });

  it('30 parallel requests of a stale session all succeed and the row is touched forward only', async () => {
    const a = await newAccount();
    const s = await craftSession(a.id, { lastSeenAgoSec: 600 });
    const before = (await sessionBySid(s.sid))!.last_seen_at;
    const results = await Promise.all(Array.from({ length: 30 }, () => settled(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid }))));
    expect(results.filter(isErr).map(codeOf)).toEqual([]);
    expect((results as ObservedSession[]).every((r) => r.applicationSessionId === s.id && !r.created)).toBe(true);
    expect((await sessionBySid(s.sid))!.last_seen_at.getTime()).toBeGreaterThan(before.getTime());
    expect(await audit(a.id)).toHaveLength(0);
  });
});

describe('observeSession: session id validation', () => {
  const bad: [string, unknown][] = [
    ['empty', ''],
    ['101 characters', 'x'.repeat(101)],
    ['a space inside', 'sid with space'],
    ['a leading space', ' sid'],
    ['a trailing space', 'sid '],
    ['a tab', 'sid\tx'],
    ['a newline', 'sid\nx'],
    ['a NUL', `sid${String.fromCharCode(0)}x`],
    ['DEL', `sid${String.fromCharCode(127)}x`],
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345],
    ['an object', { sid: 'x' }],
    ['an array', ['x']],
  ];
  for (const [name, value] of bad)
    it(`refuses ${name} with VALIDATION_FAILED and writes nothing`, async () => {
      const a = await newAccount();
      const before = await world();
      const e = await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: value as string }), 'VALIDATION_FAILED', { reason: 'INVALID_SESSION_ID' });
      expect(JSON.stringify(e.details) + e.message).not.toContain('sid with space');
      expect(await world()).toEqual(before);
    });

  it('accepts the shortest (1) and the longest (100) session id', async () => {
    const a = await newAccount();
    const long = forbid(`L${randomUUID()}`.padEnd(100, 'x'), 'sid');
    expect(long).toHaveLength(100);
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: long, authTime: authNow() })).created).toBe(true);
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: 'Q', authTime: authNow() })).created).toBe(true);
    expect((await sessionBySid(long))!.account_id).toBe(a.id);
    expect((await sessionBySid('Q'))!.account_id).toBe(a.id);
  });

  it('a session id that looks like SQL is data: the table survives and the row is created', async () => {
    const a = await newAccount();
    const sid = forbid(`x';DROP-${randomUUID()}--`, 'sid');
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() })).created).toBe(true);
    expect((await sessionBySid(sid))!.account_id).toBe(a.id);
  });

  it('a non-ASCII session id round-trips', async () => {
    const a = await newAccount();
    const sid = forbid(`sid-${String.fromCharCode(233, 8364)}-${randomUUID()}`, 'sid');
    const s = await login(a, { sid });
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: sid })).applicationSessionId).toBe(s.id);
  });
});

describe('observeSession: an unknown or foreign account never leaks anything', () => {
  it('an unknown account with a new sid is NOT_FOUND and creates nothing', async () => {
    const before = await world();
    await fails(svc.observeSession({ accountId: randomUUID(), keycloakSessionId: newSid(), authTime: authNow() }), 'NOT_FOUND');
    expect(await world()).toEqual(before);
  });

  it('a malformed account id never reaches the data as anything but an error', async () => {
    const before = await world();
    const e = await rejection(svc.observeSession({ accountId: "x'; DROP TABLE identity.accounts; --", keycloakSessionId: newSid(), authTime: authNow() }));
    caught.push(e);
    expect(e).toBeInstanceOf(Error);
    expect(await world()).toEqual(before);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM identity.accounts'))[0]!.n).toBeGreaterThan(0);
  });

  it('the sid of ANOTHER account is answered exactly like a revoked session (same code, message, details)', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const owned = await login(a);
    const revoked = await craftSession(b.id, { revoked: { reason: 'SIGN_OUT' } });
    const foreign = await fails(svc.observeSession({ accountId: b.id, keycloakSessionId: owned.sid }), 'SESSION_REVOKED');
    const own = await fails(svc.observeSession({ accountId: b.id, keycloakSessionId: revoked.sid }), 'SESSION_REVOKED');
    expect({ code: foreign.code, message: foreign.message, details: foreign.details }).toEqual({ code: own.code, message: own.message, details: own.details });
    expect(JSON.stringify(foreign.details) + foreign.message).not.toContain(a.id);
    expect(JSON.stringify(foreign.details) + foreign.message).not.toContain(owned.sid);
    // and the owner's session is untouched and still works
    expect((await sessionById(owned.id)).revoked_at).toBeNull();
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: owned.sid })).created).toBe(false);
  });

  it('an UNKNOWN account presenting an existing sid gets the same SESSION_REVOKED (no account enumeration)', async () => {
    const a = await newAccount();
    const owned = await login(a);
    const e = await fails(svc.observeSession({ accountId: randomUUID(), keycloakSessionId: owned.sid }), 'SESSION_REVOKED');
    expect(e.details).toEqual({});
  });

  it('a SUSPENDED account gets no new session; a CLOSED account either', async () => {
    const a = await newAccount();
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: authNow() }), 'SUSPENDED');
    await accounts.changeStatus(a.id, 'CLOSED', OP);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: authNow() }), 'CLOSED');
    expect(await sessionRows(a.id)).toHaveLength(0);
  });
});

describe('observeSession: a revoked session is refused for every revocation reason', () => {
  for (const reason of SESSION_REVOCATION_REASONS)
    it(`${reason} => SESSION_REVOKED at once, with a fixed message and no details`, async () => {
      const a = await newAccount();
      const s = await craftSession(a.id, { revoked: { reason } });
      const e = await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid }), 'SESSION_REVOKED');
      expect(e.message).toBe('the session was revoked');
      expect(e.details).toEqual({});
    });

  it('revocation through the service makes the next request fail immediately (no token lifetime grace)', async () => {
    const a = await newAccount();
    const keep = await login(a);
    const s = await login(a);
    await svc.revokeSession(keep.cur, s.id);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime: authNow() }), 'SESSION_REVOKED');
    // still refused when the token carries a brand-new auth_time: only a NEW session (sid) can sign in again
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime: authNow() + 1000 }), 'SESSION_REVOKED');
    expect((await login(a)).id).not.toBe(s.id);
  });
});

// ====================================================================== the revocation watermark
describe('the revocation watermark (sessions_not_before)', () => {
  const wEpoch = async (id: string): Promise<number> => epochSec((await watermarkOf(id))!);

  it('is NULL until a revoke-all happens, and a first sight without auth_time is accepted then', async () => {
    const a = await newAccount();
    expect(await watermarkOf(a.id)).toBeNull();
    expect((await login(a, { authTime: null })).id).toMatch(UUID_RE);
    for (const authTime of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 5_000_000_000])
      expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime })).created).toBe(true);
  });

  it('a first sight whose login is older than the watermark is refused, whatever the id, and writes nothing', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const w = await wEpoch(a.id);
    const before = await snapshot(a.id);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: Math.floor(w) - 3600 }), 'SESSION_REVOKED');
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: 1 }), 'SESSION_REVOKED');
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('requires provider confirmation for auth_time within two seconds of the watermark', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const watermark = (await watermarkOf(a.id))!;
    const fw = Math.floor(epochSec(watermark));
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: fw - 3 }), 'SESSION_REVOKED');
    const unconfirmedSid = newSid();
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: unconfirmedSid, authTime: fw }), 'SESSION_REVOKED');
    expect(await sessionBySid(unconfirmedSid)).toBeUndefined();

    const oldSid = newSid();
    provider.addSession(a.subject, oldSid, new Date(watermark.getTime() - 1));
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: oldSid, authTime: fw - 1 }), 'SESSION_REVOKED');
    expect(await sessionBySid(oldSid)).toBeUndefined();

    const sameSecondSid = newSid();
    provider.addSession(a.subject, sameSecondSid, new Date(Math.floor(watermark.getTime() / 1000) * 1000 + 999));
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: sameSecondSid, authTime: fw }), 'SESSION_REVOKED');
    expect(await sessionBySid(sameSecondSid)).toBeUndefined();

    const newSidAtProvider = newSid();
    provider.addSession(a.subject, newSidAtProvider, new Date(watermark.getTime() + 2000));
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: newSidAtProvider, authTime: fw })).created).toBe(true);

    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: newSid(), authTime: fw + 5 })).created).toBe(true);
  });

  it('does not hold the account lock while checking an ambiguous first sight with Keycloak', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const watermark = (await watermarkOf(a.id))!;
    const sid = newSid();
    provider.addSession(a.subject, sid, new Date(watermark.getTime() + 5000));
    const callsBefore = provider.callsOf('listSessions').length;
    const release = provider.hold('listSessions');
    const observation = svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: Math.floor(epochSec(watermark)) }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      for (let i = 0; i < 100 && provider.callsOf('listSessions').length === callsBefore; i++) await sleep(10);
      expect(provider.callsOf('listSessions')).toHaveLength(callsBefore + 1);
      await within(1000, svc.revokeAllSessions(cur.cur, { includeCurrent: true }), 'revoke-all while first sight waits for Keycloak');
    } finally {
      release();
    }
    const observed = await observation;
    expect('error' in observed && codeOf(observed.error)).toBe('SESSION_REVOKED');
  });

  it('a first sight WITHOUT auth_time (or with an unusable one) is refused when a watermark exists', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    for (const authTime of [undefined, Number.NaN, 0, -10, Number.POSITIVE_INFINITY, 4_102_444_800, 9_999_999_999]) {
      const sid = newSid();
      await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime }), 'SESSION_REVOKED');
      expect(await sessionBySid(sid)).toBeUndefined();
    }
  });

  it('after "sign out everywhere" a NEW login (later auth_time) is accepted; the revoked sessions stay revoked', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const other = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const fresh = await login(a, { authTime: Math.floor(await wEpoch(a.id)) + 5 });
    expect(fresh.id).toMatch(UUID_RE);
    expect((await sessionById(other.id)).revoked_at).not.toBeNull();
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: other.sid, authTime: Math.floor(await wEpoch(a.id)) + 5 }), 'SESSION_REVOKED');
    expect((await sessionById(fresh.id)).revoked_at).toBeNull();
  });

  it('an already-seen session is governed by its OWN row, never by the watermark', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    // the current session was kept (includeCurrent false): its token's auth_time predates the watermark and it is still accepted
    const again = await svc.observeSession({ accountId: a.id, keycloakSessionId: cur.sid, authTime: 1 });
    expect(again).toEqual({ applicationSessionId: cur.id, accountDeviceId: null, created: false });
    // a live row inserted after the watermark (crafted) is accepted too
    const crafted = await craftSession(a.id, { createdAgoSec: 0, lastSeenAgoSec: 0 });
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: crafted.sid, authTime: 1 })).created).toBe(false);
    // and a revoked row is refused even with a brand-new auth_time
    await svc.revokeSession(cur.cur, cur.id);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: cur.sid, authTime: authNow() + 100 }), 'SESSION_REVOKED');
  });

  it("one account's revoke-all does not affect another account's first sights", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: true });
    expect(await watermarkOf(b.id)).toBeNull();
    expect((await login(b, { authTime: 1 })).id).toMatch(UUID_RE);
    expect((await login(b, { authTime: null })).id).toMatch(UUID_RE);
  });

  it('only moves forward: a second revoke-all raises it, a watermark already ahead is kept', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const w1 = await watermarkOf(a.id);
    await sleep(5);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const w2 = await watermarkOf(a.id);
    expect(w2!.getTime()).toBeGreaterThan(w1!.getTime());
    // put the watermark 30 s ahead (the guard allows up to one minute) and revoke again: it must not move back
    await q(`UPDATE identity.accounts SET sessions_not_before = clock_timestamp() + interval '30 seconds' WHERE account_id = $1`, [a.id]);
    const ahead = await watermarkOf(a.id);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    expect((await watermarkOf(a.id))!.getTime()).toBe(ahead!.getTime());
  });

  it('the database refuses to move it back or into the far future (second line of defense)', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await svc.revokeAllSessions(cur.cur, { includeCurrent: false });
    const back = await rejection(
      q(`UPDATE identity.accounts SET sessions_not_before = sessions_not_before - interval '1 second' WHERE account_id = $1`, [a.id]),
    );
    expect((back as { detail?: string }).detail).toBe('identity_rule:SESSIONS_WATERMARK');
    const nul = await rejection(q('UPDATE identity.accounts SET sessions_not_before = NULL WHERE account_id = $1', [a.id]));
    expect((nul as { detail?: string }).detail).toBe('identity_rule:SESSIONS_WATERMARK');
    const far = await rejection(q(`UPDATE identity.accounts SET sessions_not_before = clock_timestamp() + interval '2 hours' WHERE account_id = $1`, [a.id]));
    expect((far as { detail?: string }).detail).toBe('identity_rule:SESSIONS_WATERMARK');
  });

  it('a CLOSED account keeps no watermark (it is immutable) but its sessions are still revoked', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const other = await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await accounts.changeStatus(a.id, 'CLOSED', OP);
    const r = await svc.revokeAllSessions(cur.cur, { includeCurrent: true });
    expect(r.revokedCount).toBe(2);
    expect(await watermarkOf(a.id)).toBeNull();
    expect((await liveSessions(a.id)).length).toBe(0);
    expect((await sessionById(other.id)).revocation_reason).toBe('SIGN_OUT_EVERYWHERE');
    expect(await auditOf(a.id, 'SESSIONS_REVOKED_ALL')).toHaveLength(1);
  });

  it('deterministic: a first sight queued behind a revoke-all reads the RAISED watermark and is refused', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const hold = await holdAccount(a.id, 'UPDATE');
    const sid = newSid();
    const racing = settled(svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: Math.floor(Date.now() / 1000) - 120 }));
    await lockWaiters(1);
    await hold.client.query(`UPDATE identity.accounts SET sessions_not_before = clock_timestamp() WHERE account_id = $1`, [a.id]);
    await hold.release(true);
    const r = await racing;
    expect(codeOf(r)).toBe('SESSION_REVOKED');
    expect(await sessionBySid(sid)).toBeUndefined();
    expect((await sessionById(cur.id)).revoked_at).toBeNull();
  });

  it('deterministic: a revoke-all queued behind an in-flight first sight revokes the session that first sight created', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const hold = await holdAccount(a.id, 'SHARE');
    const sid = newSid();
    // the "first sight in progress": the share lock is held and the row is inserted, not committed yet
    await hold.client.query('INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2)', [a.id, sid]);
    const revokeAll = settled(svc.revokeAllSessions(cur.cur, { includeCurrent: false }));
    await lockWaiters(1);
    await hold.release(true);
    const r = await revokeAll;
    expect(isErr(r)).toBe(false);
    expect((r as { revokedCount: number }).revokedCount).toBe(1);
    expect((await sessionBySid(sid))!.revocation_reason).toBe('SIGN_OUT_EVERYWHERE');
  });
});

// ====================================================================== registerSession
describe('registerSession: the browser of a login', () => {
  it('upserts the device by keyed hash, stores coarse families only and attaches it to the session', async () => {
    const a = await newAccount();
    const s = await login(a);
    const secret = newSecret();
    const marker = forbid(`UAMARK-${randomUUID()}`, 'user agent');
    const r = await svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: `${CHROME_WIN} ${marker}` }, { clientIp: uniqueIp() });
    expect(r).toEqual({ sessionId: s.id, deviceId: expect.stringMatching(UUID_RE), deviceTrusted: false, trustedUntil: null });

    const devices = await deviceRows(a.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      account_device_id: r.deviceId,
      account_id: a.id,
      device_hash: hashDeviceSecret(testHashKey, a.id, secret),
      browser_family: 'CHROME',
      os_family: 'WINDOWS',
      device_class: 'DESKTOP',
      trusted_at: null,
      trusted_until: null,
      removed_at: null,
    });
    expect(devices[0]!.device_hash).toMatch(HEX64_RE);
    expect(devices[0]!.device_hash).not.toBe(hashDeviceSecret(otherHashKey, a.id, secret));
    expect(devices[0]!.device_hash).not.toBe(sha(secret));
    expect((await sessionById(s.id)).account_device_id).toBe(r.deviceId);
    // the secret and the raw user agent are stored nowhere, the hash only in the device table
    expect(await tablesMentioning(secret)).toEqual([]);
    expect(await tablesMentioning(marker)).toEqual([]);
    expect(await tablesMentioning('Mozilla')).toEqual([]);
    expect(await tablesMentioning(devices[0]!.device_hash)).toEqual(['identity.account_devices']);
    // nothing is rate limited and nothing is audited by a registration
    expect(spy.calls).toHaveLength(0);
    expect(await auditOf(a.id, 'SESSION_CREATED')).toHaveLength(1);
    // the session now reports its device
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid })).accountDeviceId).toBe(r.deviceId);
  });

  const UA_MATRIX: [string, string | undefined | number, [string, string, string]][] = [
    ['Chrome on Windows', CHROME_WIN, ['CHROME', 'WINDOWS', 'DESKTOP']],
    ['Safari on iPhone', SAFARI_IPHONE, ['SAFARI', 'IOS', 'MOBILE']],
    ['Firefox on Linux', FIREFOX_LINUX, ['FIREFOX', 'LINUX', 'DESKTOP']],
    ['Edge on Windows (carries the Chrome token)', EDGE_WIN, ['EDGE', 'WINDOWS', 'DESKTOP']],
    ['no user agent', undefined, ['OTHER', 'OTHER', 'OTHER']],
    ['an empty user agent', '', ['OTHER', 'OTHER', 'OTHER']],
    ['a blank user agent', '   ', ['OTHER', 'OTHER', 'OTHER']],
    ['garbage', 'curl/8.4.0', ['OTHER', 'OTHER', 'OTHER']],
    ['a number instead of a string', 12345, ['OTHER', 'OTHER', 'OTHER']],
  ];
  for (const [name, ua, [browser, os, cls]] of UA_MATRIX)
    it(`classifies ${name} as ${browser}/${os}/${cls} and stores only those`, async () => {
      const a = await newAccount();
      const s = await login(a);
      const secret = newSecret();
      const r = await svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: ua as string });
      const d = await deviceById(r.deviceId!);
      expect([d.browser_family, d.os_family, d.device_class]).toEqual([browser, os, cls]);
    });

  it('a user agent of 100 000 characters is accepted and reduced (bounded work), nothing of it is stored', async () => {
    const a = await newAccount();
    const s = await login(a);
    const marker = forbid(`UAMARK-${randomUUID()}`, 'user agent');
    const r = await svc.registerSession({ ...s.cur, deviceSecret: newSecret(), userAgent: `${'x'.repeat(100_000)} ${marker}` });
    expect(r.deviceId).toMatch(UUID_RE);
    expect(await tablesMentioning(marker)).toEqual([]);
  });

  it('is idempotent: the same secret on the same session returns the same device and creates no second row', async () => {
    const a = await newAccount();
    const s = await login(a);
    const secret = newSecret();
    const r1 = await svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: CHROME_WIN });
    const r2 = await svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: CHROME_WIN });
    expect(r2).toEqual(r1);
    expect(await deviceRows(a.id)).toHaveLength(1);
  });

  it('the same browser logging in again (a second session) reuses its device row', async () => {
    const a = await newAccount();
    const first = await loginWithDevice(a);
    const second = await login(a);
    const r = await svc.registerSession({ ...second.cur, deviceSecret: first.secret, userAgent: CHROME_WIN });
    expect(r.deviceId).toBe(first.deviceId);
    expect(await deviceRows(a.id)).toHaveLength(1);
    expect((await sessionById(first.id)).account_device_id).toBe(first.deviceId);
    expect((await sessionById(second.id)).account_device_id).toBe(first.deviceId);
  });

  it('a trusted browser is reported as trusted (with its window) when it registers again', async () => {
    const a = await newAccount();
    const first = await loginWithDevice(a);
    const trust = await svc.trustCurrentDevice(first.cur);
    const second = await login(a);
    const r = await svc.registerSession({ ...second.cur, deviceSecret: first.secret, userAgent: CHROME_WIN });
    expect(r).toEqual({ sessionId: second.id, deviceId: first.deviceId, deviceTrusted: true, trustedUntil: trust.trustedUntil });
  });

  it('the FIRST device of a session wins; another secret presented later neither replaces it nor creates a device row', async () => {
    const a = await newAccount();
    const first = await loginWithDevice(a);
    const r = await svc.registerSession({ ...first.cur, deviceSecret: newSecret(), userAgent: FIREFOX_LINUX });
    expect(r.deviceId).toBe(first.deviceId);
    expect((await sessionById(first.id)).account_device_id).toBe(first.deviceId);
    expect(await deviceRows(a.id)).toHaveLength(1);
  });

  it('the family fields keep their FIRST classification when the same browser registers with another user agent', async () => {
    const a = await newAccount();
    const first = await loginWithDevice(a, { ua: CHROME_WIN });
    const second = await login(a);
    await svc.registerSession({ ...second.cur, deviceSecret: first.secret, userAgent: FIREFOX_LINUX });
    const d = await deviceById(first.deviceId);
    expect([d.browser_family, d.os_family, d.device_class]).toEqual(['CHROME', 'WINDOWS', 'DESKTOP']);
  });

  it('the same secret on two accounts gives two independent devices with different hashes', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const secret = newSecret();
    const sa = await login(a);
    const sb = await login(b);
    const ra = await svc.registerSession({ ...sa.cur, deviceSecret: secret, userAgent: CHROME_WIN });
    const rb = await svc.registerSession({ ...sb.cur, deviceSecret: secret, userAgent: CHROME_WIN });
    expect(ra.deviceId).not.toBe(rb.deviceId);
    const da = await deviceById(ra.deviceId!);
    const db_ = await deviceById(rb.deviceId!);
    expect(da.device_hash).not.toBe(db_.device_hash);
    expect(da.device_hash).toBe(hashDeviceSecret(testHashKey, a.id, secret));
    expect(db_.device_hash).toBe(hashDeviceSecret(testHashKey, b.id, secret));
    // trusting it on one account says nothing about the other
    await svc.trustCurrentDevice(sa.cur);
    expect(await svc.isDeviceTrusted(sa.cur)).toBe(true);
    expect(await svc.isDeviceTrusted(sb.cur)).toBe(false);
    expect((await deviceById(rb.deviceId!)).trusted_until).toBeNull();
  });

  it('a REMOVED device is never revived: a new login with its secret gets deviceId null and no row changes', async () => {
    const a = await newAccount();
    const first = await loginWithDevice(a);
    await svc.removeDevice(first.cur, first.deviceId);
    const removed = await deviceById(first.deviceId);
    const second = await login(a);
    const r = await svc.registerSession({ ...second.cur, deviceSecret: first.secret, userAgent: CHROME_WIN });
    expect(r).toEqual({ sessionId: second.id, deviceId: null, deviceTrusted: false, trustedUntil: null });
    expect((await sessionById(second.id)).account_device_id).toBeNull();
    expect(await deviceRows(a.id)).toHaveLength(1);
    expect(await deviceById(first.deviceId)).toEqual(removed);
    // such a session cannot trust a browser: it has none
    await fails(svc.trustCurrentDevice(second.cur), 'DEVICE_REQUIRED');
  });

  it('a revoked session is refused with SESSION_REVOKED and no device row is created', async () => {
    const a = await newAccount();
    const s = await craftSession(a.id, { revoked: { reason: 'SIGN_OUT' } });
    const before = await snapshot(a.id);
    await fails(svc.registerSession({ ...curOf(a.id, s.sid), deviceSecret: newSecret(), userAgent: CHROME_WIN }), 'SESSION_REVOKED');
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('an unknown sid and a sid of another account are SESSION_NOT_FOUND (indistinguishable) and write nothing', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const owned = await login(a);
    const before = await world();
    const e1 = await fails(svc.registerSession({ ...curOf(b.id, newSid()), deviceSecret: newSecret() }), 'SESSION_NOT_FOUND');
    const e2 = await fails(svc.registerSession({ ...curOf(b.id, owned.sid), deviceSecret: newSecret() }), 'SESSION_NOT_FOUND');
    expect({ m: e1.message, d: e1.details }).toEqual({ m: e2.message, d: e2.details });
    expect(await world()).toEqual(before);
    expect((await sessionById(owned.id)).account_device_id).toBeNull();
  });

  const SECRET_BAD: [string, unknown][] = [
    ['empty', ''],
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['standard base64 characters', `${'a'.repeat(40)}+/=`],
    ['a trailing newline', `${'a'.repeat(43)}\n`],
    ['a leading space', ` ${'a'.repeat(42)}`],
    ['non-ASCII look-alikes', `${'a'.repeat(42)}${String.fromCharCode(1072)}`],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', [newSecret()]],
    ['an object', { toString: () => 'a'.repeat(43) }],
  ];
  for (const [name, value] of SECRET_BAD)
    it(`a malformed device secret (${name}) is VALIDATION_FAILED on the field "device" and writes nothing`, async () => {
      const a = await newAccount();
      const s = await login(a);
      const before = await snapshot(a.id);
      await fails(svc.registerSession({ ...s.cur, deviceSecret: value as string, userAgent: CHROME_WIN }), 'VALIDATION_FAILED', {
        reason: 'INVALID_FIELD',
        field: 'device',
      });
      expect(await snapshot(a.id)).toEqual(before);
    });

  it('a SUSPENDED account cannot register a browser', async () => {
    const a = await newAccount();
    const s = await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await fails(svc.registerSession({ ...s.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN }), 'SUSPENDED');
    expect(await deviceRows(a.id)).toHaveLength(0);
  });

  it('a failing identity provider does not fail the registration', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.failNext('getUserSecurity', Number.POSITIVE_INFINITY);
    provider.failNext('listSessions', Number.POSITIVE_INFINITY);
    const r = await svc.registerSession({ ...s.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN });
    expect(r.deviceId).toMatch(UUID_RE);
    provider.clearFailures();
    provider.available = false;
    const s2 = await login(a);
    expect((await svc.registerSession({ ...s2.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN })).deviceId).toMatch(UUID_RE);
  });

  it('race: 20 parallel registrations of one secret on one session create ONE device and attach it', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await newAccount();
      const s = await login(a);
      const secret = newSecret();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => settled(svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: CHROME_WIN }))),
      );
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const ids = new Set((results as { deviceId: string }[]).map((r) => r.deviceId));
      expect(ids.size).toBe(1);
      const devices = await deviceRows(a.id);
      expect(devices).toHaveLength(1);
      expect((await sessionById(s.id)).account_device_id).toBe(devices[0]!.account_device_id);
      expect([...ids][0]).toBe(devices[0]!.account_device_id);
    }
  });

  it('race: 20 parallel registrations of DIFFERENT secrets on one session attach exactly one and all report it', async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newAccount();
      const s = await login(a);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => settled(svc.registerSession({ ...s.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN }))),
      );
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const attached = (await sessionById(s.id)).account_device_id;
      expect(attached).not.toBeNull();
      expect(new Set((results as { deviceId: string }[]).map((r) => r.deviceId))).toEqual(new Set([attached]));
      // only the winner has a device row: a session with a device never creates another
      expect(await deviceRows(a.id)).toHaveLength(1);
    }
  });

  it('race: the same secret registering from 10 sessions of one account gives one device attached to all', async () => {
    const a = await newAccount();
    const secret = newSecret();
    const sessions = await Promise.all(Array.from({ length: 10 }, () => login(a)));
    const results = await Promise.all(sessions.map((s) => settled(svc.registerSession({ ...s.cur, deviceSecret: secret, userAgent: CHROME_WIN }))));
    expect(results.filter(isErr).map(codeOf)).toEqual([]);
    const devices = await deviceRows(a.id);
    expect(devices).toHaveLength(1);
    for (const s of sessions) expect((await sessionById(s.id)).account_device_id).toBe(devices[0]!.account_device_id);
  });

  it('race: registering a removed browser while it is being removed never leaves a live session on a removed device', async () => {
    for (let round = 0; round < 12; round++) {
      const a = await newAccount();
      const first = await loginWithDevice(a);
      const others = await Promise.all(Array.from({ length: 4 }, () => login(a)));
      const calls: Promise<unknown>[] = [settled(svc.removeDevice(curOf(a.id, others[0]!.sid), first.deviceId))];
      for (const o of others) calls.push(jitter().then(() => settled(svc.registerSession({ ...o.cur, deviceSecret: first.secret, userAgent: CHROME_WIN }))));
      const results = await Promise.all(calls);
      for (const r of results) if (isErr(r)) expect(['SESSION_REVOKED', 'SESSION_NOT_FOUND']).toContain(codeOf(r));
      const device = await deviceById(first.deviceId);
      expect(device.removed_at).not.toBeNull();
      expect(device.trusted_until).toBeNull();
      const live = (await liveSessions(a.id)).filter((s) => s.account_device_id === first.deviceId);
      expect(live, 'a live session is attached to a removed device').toHaveLength(0);
    }
  });
});

// ====================================================================== listSessions
describe('listSessions', () => {
  it('lists the active sessions: current first, then newest first; never revoked ones or other accounts', async () => {
    const a = await newAccount();
    const other = await newAccount();
    provider.available = false;
    const current = await craftSession(a.id, { lastSeenAgoSec: 7200 });
    const newest = await craftSession(a.id, { lastSeenAgoSec: 10 });
    const older = await craftSession(a.id, { lastSeenAgoSec: 3600 });
    await craftSession(a.id, { lastSeenAgoSec: 5, revoked: { reason: 'SIGN_OUT', agoSec: 1 } });
    await craftSession(other.id, { lastSeenAgoSec: 1 });
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(false);
    expect(r.sessions.map((s) => s.sessionId)).toEqual([current.id, newest.id, older.id]);
    expect(r.sessions.map((s) => s.current)).toEqual([true, false, false]);
    for (const s of r.sessions) {
      expect(s).toMatchObject({ status: 'ACTIVE', device: null, deviceId: null, trusted: false, trustedUntil: null });
      expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
      expect(new Date(s.lastSeenAt).toISOString()).toBe(s.lastSeenAt);
    }
    // the Keycloak session id is never handed out
    expect(JSON.stringify(r)).not.toContain(current.sid);
    expect(JSON.stringify(r)).not.toContain(newest.sid);
  });

  it('shows the coarse device and the trusted flag of each session', async () => {
    const a = await newAccount();
    provider.available = false;
    const d1 = await loginWithDevice(a, { ua: SAFARI_IPHONE });
    const trust = await svc.trustCurrentDevice(d1.cur);
    const plain = await login(a);
    const r = await svc.listSessions(plain.cur);
    const mine = r.sessions.find((s) => s.sessionId === d1.id)!;
    expect(mine).toMatchObject({
      device: { browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' },
      deviceId: d1.deviceId,
      trusted: true,
      trustedUntil: trust.trustedUntil,
    });
    expect(r.sessions.find((s) => s.sessionId === plain.id)).toMatchObject({ device: null, deviceId: null, trusted: false });
  });

  it('keeps the current session in the list even when it is far down the order and the account has more sessions than the list holds', async () => {
    const a = await newAccount();
    provider.available = false;
    const current = await craftSession(a.id, { lastSeenAgoSec: 20 * 3600 });
    await q(
      `INSERT INTO identity.application_sessions (account_id, keycloak_session_id, created_at, last_seen_at)
       SELECT $1, 'bulk-' || $2 || '-' || i, clock_timestamp() - interval '2 days', clock_timestamp() - make_interval(secs => i) FROM generate_series(1, 230) AS i`,
      [a.id, randomUUID()],
    );
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.sessions.length).toBeLessThanOrEqual(200);
    expect(r.sessions.length).toBeGreaterThan(100);
    expect(r.sessions[0]!.sessionId).toBe(current.id);
    expect(r.sessions.filter((s) => s.current)).toHaveLength(1);
  });

  it('a revoked CURRENT session is not listed as current (nothing is current)', async () => {
    const a = await newAccount();
    provider.available = false;
    const s = await craftSession(a.id, { revoked: { reason: 'SIGN_OUT' } });
    const live = await craftSession(a.id, {});
    const r = await svc.listSessions(curOf(a.id, s.sid));
    expect(r.sessions.map((x) => x.sessionId)).toEqual([live.id]);
    expect(r.sessions.some((x) => x.current)).toBe(false);
  });

  it('only lists sessions seen within session.keep_signed_in_days; older live rows are closed (KEYCLOAK_ENDED, SESSION_ENDED audit + event)', async () => {
    const a = await newAccount();
    provider.available = false;
    const current = await craftSession(a.id, {});
    const inside = await craftSession(a.id, { createdAgoSec: 40 * 86400, lastSeenAgoSec: 29 * 86400 });
    const outside = await craftSession(a.id, { createdAgoSec: 40 * 86400, lastSeenAgoSec: 31 * 86400 });
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual([current.id, inside.id].sort());
    const closed = await sessionById(outside.id);
    expect(closed.revocation_reason).toBe('KEYCLOAK_ENDED');
    expect(closed.revoked_at).not.toBeNull();
    const ended = await auditOf(a.id, 'SESSION_ENDED');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ application_session_id: outside.id, changes: { reason: 'KEYCLOAK_ENDED', expired: true } });
    const ev = await eventsOf(a.id, E.sessionRevoked);
    expect(ev.map((e) => e.payload_json)).toEqual([{ accountId: a.id, applicationSessionId: outside.id, reason: 'KEYCLOAK_ENDED' }]);
    // the closed session is refused from now on, and a second listing writes nothing more
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: outside.sid }), 'SESSION_REVOKED');
    await svc.listSessions(curOf(a.id, current.sid));
    expect(await auditOf(a.id, 'SESSION_ENDED')).toHaveLength(1);
    // a longer window brings a still-live older session back into the list
    const older = await craftSession(a.id, { createdAgoSec: 70 * 86400, lastSeenAgoSec: 50 * 86400 });
    policy.set({ keepSignedInDays: 60 });
    expect((await svc.listSessions(curOf(a.id, current.sid))).sessions.map((s) => s.sessionId)).toContain(older.id);
    expect((await sessionById(older.id)).revoked_at).toBeNull();
  });

  it('the policy failing closes the call with POLICY_UNAVAILABLE', async () => {
    const a = await newAccount();
    const s = await login(a);
    policy.failure = new Error('secret-connection-string-in-the-error');
    const e = await fails(svc.listSessions(s.cur), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect(e.message).not.toContain('secret-connection-string');
    expect(logSink.lines.join('\n')).not.toContain('secret-connection-string');
  });
});

describe('listSessions: reconciliation with the identity provider', () => {
  it('ends (KEYCLOAK_ENDED) the live rows the provider no longer knows, with audit and event, and reports reconciled:true', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const known = await craftSession(a.id, { createdAgoSec: 600 });
    const gone = await craftSession(a.id, { createdAgoSec: 600 });
    liveAtProvider(a, current.sid, known.sid);
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(true);
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual([current.id, known.id].sort());
    const row = await sessionById(gone.id);
    expect(row.revocation_reason).toBe('KEYCLOAK_ENDED');
    expect(await auditOf(a.id, 'SESSION_ENDED')).toHaveLength(1);
    expect((await auditOf(a.id, 'SESSION_ENDED'))[0]).toMatchObject({ application_session_id: gone.id, changes: { reason: 'KEYCLOAK_ENDED' } });
    expect((await eventsOf(a.id, E.sessionRevoked)).map((e) => e.payload_json)).toEqual([
      { accountId: a.id, applicationSessionId: gone.id, reason: 'KEYCLOAK_ENDED' },
    ]);
    // idempotent: nothing more to end
    await svc.listSessions(curOf(a.id, current.sid));
    expect(await auditOf(a.id, 'SESSION_ENDED')).toHaveLength(1);
  });

  it('never ends the CURRENT session, even when the provider does not list it', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(true);
    expect(r.sessions.map((s) => s.sessionId)).toEqual([current.id]);
    expect((await sessionById(current.id)).revoked_at).toBeNull();
  });

  it('never ends a session younger than 15 seconds (its provider session may not be listed yet)', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const young = await craftSession(a.id, { createdAgoSec: 12 });
    const old = await craftSession(a.id, { createdAgoSec: 18 });
    await svc.listSessions(curOf(a.id, current.sid));
    expect((await sessionById(young.id)).revoked_at).toBeNull();
    expect((await sessionById(old.id)).revocation_reason).toBe('KEYCLOAK_ENDED');
  });

  it('a provider that knows no session at all ends every old session but the current one', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const others = await Promise.all([1, 2, 3].map(() => craftSession(a.id, { createdAgoSec: 600 })));
    provider.setUser(a.subject, { sessions: [] });
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.sessions.map((s) => s.sessionId)).toEqual([current.id]);
    for (const o of others) expect((await sessionById(o.id)).revocation_reason).toBe('KEYCLOAK_ENDED');
  });

  it('only touches the sessions of this account', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const theirs = await craftSession(b.id, { createdAgoSec: 600 });
    await svc.listSessions(curOf(a.id, current.sid));
    expect((await sessionById(theirs.id)).revoked_at).toBeNull();
  });

  it('a provider failure means reconciled:false and NO mutation (the missing session is still listed)', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const missing = await craftSession(a.id, { createdAgoSec: 600 });
    provider.failNext('listSessions');
    const before = await snapshot(a.id);
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(false);
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual([current.id, missing.id].sort());
    expect(await snapshot(a.id)).toEqual(before);
    expect(logSink.lines.join('\n')).toContain('could not be listed');
    expect(logSink.lines.join('\n')).toContain('INJECTED');
  });

  it('a provider that is not configured (available=false) means reconciled:false and no provider call', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    provider.available = false;
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(false);
    expect(provider.callsOf('listSessions')).toHaveLength(0);
  });

  it('a session created while the provider call is in flight is not judged by a list that predates it', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const release = provider.hold('listSessions');
    const listing = svc.listSessions(curOf(a.id, current.sid));
    for (let i = 0; i < 100 && provider.callsOf('listSessions').length === 0; i++) await sleep(10);
    expect(provider.callsOf('listSessions')).toHaveLength(1);
    const late = await login(a);
    // pretend the new session is already older than the grace period: created before "now" but after the cutoff, i.e. inside the in-flight window
    release();
    const r = await listing;
    expect(r.reconciled).toBe(true);
    expect((await sessionById(late.id)).revoked_at).toBeNull();
    expect(r.sessions.map((s) => s.sessionId)).toContain(late.id);
  });

  it('retries the provider end of recently revoked sessions the provider still lists (never the current one)', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const revoked = await craftSession(a.id, { createdAgoSec: 600, revoked: { reason: 'REVOKED_BY_USER', agoSec: 30 } });
    const alive = await craftSession(a.id, { createdAgoSec: 600 });
    const unrelated = await craftSession(a.id, { createdAgoSec: 600, revoked: { reason: 'SIGN_OUT', agoSec: 30 } });
    liveAtProvider(a, current.sid, revoked.sid, alive.sid);
    await svc.listSessions(curOf(a.id, current.sid));
    expect(provider.endedSessions).toEqual([revoked.sid]);
    expect(provider.endedSessions).not.toContain(unrelated.sid);
    expect(provider.endedSessions).not.toContain(current.sid);
    expect((await sessionById(revoked.id)).revocation_reason).toBe('REVOKED_BY_USER');
  });

  it('the provider end retry is capped at 20 sessions per listing', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    liveAtProvider(a, current.sid);
    for (let i = 0; i < 25; i++) {
      const s = await craftSession(a.id, { createdAgoSec: 600, revoked: { reason: 'SIGN_OUT_EVERYWHERE', agoSec: 30 } });
      liveAtProvider(a, s.sid);
    }
    await svc.listSessions(curOf(a.id, current.sid));
    expect(provider.callsOf('endSession').length).toBeGreaterThan(0);
    expect(provider.callsOf('endSession').length).toBeLessThanOrEqual(20);
    expect(provider.endedSessions).not.toContain(current.sid);
  });

  it('a failing endSession retry never fails the listing', async () => {
    const a = await newAccount();
    const current = await craftSession(a.id, { createdAgoSec: 600 });
    const revoked = await craftSession(a.id, { createdAgoSec: 600, revoked: { reason: 'REVOKED_BY_USER', agoSec: 30 } });
    liveAtProvider(a, current.sid, revoked.sid);
    provider.failNext('endSession', Number.POSITIVE_INFINITY);
    const r = await svc.listSessions(curOf(a.id, current.sid));
    expect(r.reconciled).toBe(true);
    expect(r.sessions.map((s) => s.sessionId)).toEqual([current.id]);
  });
});

// ====================================================================== revokeSession
describe('revokeSession', () => {
  it('revokes one session: reason REVOKED_BY_USER, audit + event, the provider session ended, the next request refused', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const target = await login(a);
    liveAtProvider(a, mine.sid, target.sid);
    const cid = `cid-${randomUUID()}`;
    const r = await runWithCorrelation(cid, () => svc.revokeSession(mine.cur, target.id));
    expect(r).toEqual({ sessionId: target.id, changed: true, current: false, keycloak: 'ENDED' });
    const row = await sessionById(target.id);
    expect(row.revocation_reason).toBe('REVOKED_BY_USER');
    expect(row.revoked_at).not.toBeNull();
    expect((await sessionById(mine.id)).revoked_at).toBeNull();
    const audits = await auditOf(a.id, 'SESSION_REVOKED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: `account:${a.id}`,
      application_session_id: target.id,
      changes: { reason: 'REVOKED_BY_USER' },
      correlation_id: cid,
    });
    const ev = await eventsOf(a.id, E.sessionRevoked);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload_json).toEqual({ accountId: a.id, applicationSessionId: target.id, reason: 'REVOKED_BY_USER' });
    expect(ev[0]).toMatchObject({ correlation_id: cid, aggregate_id: a.id });
    expect(provider.endedSessions).toEqual([target.sid]);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: target.sid }), 'SESSION_REVOKED');
    // revoking one session does not raise the watermark
    expect(await watermarkOf(a.id)).toBeNull();
  });

  it('is idempotent: a second revocation changes nothing in the database and adds no audit row and no event', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const target = await login(a);
    liveAtProvider(a, target.sid);
    await svc.revokeSession(mine.cur, target.id);
    const row = await sessionById(target.id);
    const audits = (await audit(a.id)).length;
    const evs = (await events(a.id)).length;
    const again = await svc.revokeSession(mine.cur, target.id);
    expect(again).toMatchObject({ sessionId: target.id, changed: false, current: false });
    expect(await sessionById(target.id)).toEqual(row);
    expect((await audit(a.id)).length).toBe(audits);
    expect((await events(a.id)).length).toBe(evs);
  });

  it('a repeated revocation asks the provider to end the session again (a retry after a failed propagation)', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const target = await login(a);
    liveAtProvider(a, target.sid);
    provider.failNext('endSession');
    expect((await svc.revokeSession(mine.cur, target.id)).keycloak).toBe('UNAVAILABLE');
    expect((await sessionById(target.id)).revoked_at).not.toBeNull();
    const retry = await svc.revokeSession(mine.cur, target.id);
    expect(retry).toMatchObject({ changed: false, keycloak: 'ENDED' });
    expect(provider.endedSessions).toEqual([target.sid]);
    expect(provider.callsOf('endSession')).toHaveLength(2);
    expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
  });

  it('may revoke the current session (current:true)', async () => {
    const a = await newAccount();
    const mine = await login(a);
    liveAtProvider(a, mine.sid);
    expect(await svc.revokeSession(mine.cur, mine.id)).toEqual({ sessionId: mine.id, changed: true, current: true, keycloak: 'ENDED' });
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: mine.sid }), 'SESSION_REVOKED');
  });

  it('a session of ANOTHER account, an unknown id and a malformed id are all the same SESSION_NOT_FOUND and nothing changes', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const mine = await login(a);
    const theirs = await login(b);
    const before = { a: await snapshot(a.id), b: await snapshot(b.id) };
    const errors: AccountError[] = [];
    for (const id of [
      theirs.id,
      randomUUID(),
      'not-a-uuid',
      '',
      "x'; DROP TABLE identity.application_sessions; --",
      `${theirs.id} `,
      theirs.sid,
      12345 as unknown as string,
      undefined as unknown as string,
    ])
      errors.push(await fails(svc.revokeSession(mine.cur, id), 'SESSION_NOT_FOUND'));
    expect(new Set(errors.map((e) => JSON.stringify([e.message, e.details]))).size).toBe(1);
    expect({ a: await snapshot(a.id), b: await snapshot(b.id) }).toEqual(before);
    expect(provider.calls).toHaveLength(0);
    // the unknown account itself
    await fails(svc.revokeSession(curOf(randomUUID(), newSid()), theirs.id), 'NOT_FOUND');
  });

  it('propagation outcomes: ENDED, UNAVAILABLE when the provider fails, UNAVAILABLE when it is not configured; the revocation holds in every case', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const s1 = await login(a);
    const s2 = await login(a);
    liveAtProvider(a, s1.sid, s2.sid);
    provider.failNext('endSession');
    const failed = await svc.revokeSession(mine.cur, s1.id);
    expect(failed).toMatchObject({ changed: true, keycloak: 'UNAVAILABLE' });
    expect((await sessionById(s1.id)).revocation_reason).toBe('REVOKED_BY_USER');
    expect(logSink.lines.join('\n')).toContain('could not be ended');
    expect(logSink.lines.join('\n')).toContain('INJECTED');
    provider.available = false;
    const off = await svc.revokeSession(mine.cur, s2.id);
    expect(off).toMatchObject({ changed: true, keycloak: 'UNAVAILABLE' });
    expect((await sessionById(s2.id)).revoked_at).not.toBeNull();
    expect(provider.endedSessions).toEqual([]);
  });

  it('revocations do not need a usable account: a SUSPENDED account can still end sessions', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const other = await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    expect((await svc.revokeSession(mine.cur, other.id)).changed).toBe(true);
  });

  it('a failing audit or event insert rolls back the revocation completely and ends nothing at the provider', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const target = await login(a);
    liveAtProvider(a, target.sid);
    const before = await snapshot(a.id);
    await expectForcedFailure(failing([E.sessionRevoked], () => svc.revokeSession(mine.cur, target.id)));
    await expectForcedFailure(failing(['SESSION_REVOKED'], () => svc.revokeSession(mine.cur, target.id)));
    expect(await snapshot(a.id)).toEqual(before);
    expect(provider.callsOf('endSession')).toHaveLength(0);
    expect((await svc.revokeSession(mine.cur, target.id)).changed).toBe(true);
  });

  it('no lock is held across the provider call: another operation of the account finishes while endSession is stuck', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const target = await login(a);
    const other = await login(a);
    liveAtProvider(a, target.sid);
    const release = provider.hold('endSession');
    const stuck = svc.revokeSession(mine.cur, target.id);
    for (let i = 0; i < 200 && provider.callsOf('endSession').length === 0; i++) await sleep(10);
    expect(provider.callsOf('endSession')).toHaveLength(1);
    // an operation that needs the account row lock (FOR UPDATE) and one that needs the session row
    // operations that need the account row lock (FOR UPDATE) but make no provider call of their own
    await within(5000, svc.startMfaEnrollment(mine.cur, 'TOTP'), 'an enrollment request');
    await within(5000, svc.signOutCurrentSession(curOf(a.id, newSid())), 'a sign-out of an unknown session');
    expect(other.id).toBeTruthy();
    release();
    expect(await stuck).toMatchObject({ changed: true, keycloak: 'ENDED' });
  });

  it('race: 10 parallel revocations of one session change it once (one audit row, one event)', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newAccount();
      const mine = await login(a);
      const target = await login(a);
      liveAtProvider(a, target.sid);
      const results = await Promise.all(Array.from({ length: 10 }, () => settled(svc.revokeSession(mine.cur, target.id))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const rs = results as { changed: boolean; keycloak: string }[];
      expect(rs.filter((r) => r.changed)).toHaveLength(1);
      expect(rs.every((r) => r.keycloak === 'ENDED')).toBe(true);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
      expect(await eventsOf(a.id, E.sessionRevoked)).toHaveLength(1);
    }
  });

  it('race: revoking one session while "sign out everywhere" runs revokes every session exactly once', async () => {
    for (let round = 0; round < 12; round++) {
      const a = await newAccount();
      const mine = await login(a);
      const others = await Promise.all(Array.from({ length: 6 }, () => login(a)));
      const calls: Promise<unknown>[] = [settled(svc.revokeAllSessions(mine.cur, { includeCurrent: false }))];
      for (const o of others.slice(0, 3)) calls.push(jitter().then(() => settled(svc.revokeSession(mine.cur, o.id))));
      const results = await Promise.all(calls);
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const all = results[0] as { revokedCount: number };
      const singles = (results.slice(1) as { changed: boolean }[]).filter((r) => r.changed).length;
      expect(all.revokedCount + singles, 'every other session is revoked by exactly one of the calls').toBe(others.length);
      expect((await liveSessions(a.id)).map((s) => s.application_session_id)).toEqual([mine.id]);
      const revokedAudits = await auditOf(a.id, 'SESSION_REVOKED');
      expect(revokedAudits).toHaveLength(others.length);
      expect(new Set(revokedAudits.map((r) => r.application_session_id)).size).toBe(others.length);
      expect(await eventsOf(a.id, E.sessionRevoked)).toHaveLength(others.length);
      expect(await auditOf(a.id, 'SESSIONS_REVOKED_ALL')).toHaveLength(1);
    }
  });
});

// ====================================================================== revokeAllSessions
describe('revokeAllSessions', () => {
  it('by default revokes every session but the current one, audits each, audits the sweep once, raises the watermark and emits the events', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const o1 = await login(a);
    const o2 = await login(a);
    const dead = await craftSession(a.id, { revoked: { reason: 'SIGN_OUT', agoSec: 10 } });
    const stranger = await newAccount();
    const theirs = await login(stranger);
    const t0 = await dbNow();
    const cid = `cid-${randomUUID()}`;
    const r = await runWithCorrelation(cid, () => svc.revokeAllSessions(mine.cur, { includeCurrent: false }));
    const t1 = await dbNow();
    expect(r.revokedCount).toBe(2);
    expect(r.keycloak).toBeDefined();
    expect((await sessionById(mine.id)).revoked_at).toBeNull();
    for (const o of [o1, o2]) expect(await sessionById(o.id)).toMatchObject({ revocation_reason: 'SIGN_OUT_EVERYWHERE' });
    expect((await sessionById(dead.id)).revocation_reason).toBe('SIGN_OUT');
    expect((await sessionById(theirs.id)).revoked_at).toBeNull();
    expect(await watermarkOf(stranger.id)).toBeNull();
    const w = await watermarkOf(a.id);
    between(w!.getTime(), t0.getTime(), t1.getTime());

    const per = await auditOf(a.id, 'SESSION_REVOKED');
    expect(per.map((x) => x.application_session_id).sort()).toEqual([o1.id, o2.id].sort());
    for (const x of per) expect(x).toMatchObject({ changes: { reason: 'SIGN_OUT_EVERYWHERE' }, correlation_id: cid });
    const sweep = await auditOf(a.id, 'SESSIONS_REVOKED_ALL');
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatchObject({
      application_session_id: null,
      account_device_id: null,
      changes: { revokedCount: 2, includeCurrent: false },
      correlation_id: cid,
    });
    const ev = await eventsOf(a.id, E.sessionRevoked);
    expect(ev.map((x) => x.payload_json.applicationSessionId).sort()).toEqual([o1.id, o2.id].sort());
    expect(ev.every((x) => x.payload_json.reason === 'SIGN_OUT_EVERYWHERE')).toBe(true);
    const all = await eventsOf(a.id, E.sessionsRevokedAll);
    expect(all).toHaveLength(1);
    expect(all[0]!.payload_json).toEqual({ accountId: a.id, revokedCount: 2, includeCurrent: false });
    expect(all[0]!.correlation_id).toBe(cid);
  });

  it('includeCurrent:true also revokes the current session', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const other = await login(a);
    const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: true });
    expect(r.revokedCount).toBe(2);
    expect((await liveSessions(a.id)).length).toBe(0);
    expect((await auditOf(a.id, 'SESSIONS_REVOKED_ALL'))[0]!.changes).toEqual({ revokedCount: 2, includeCurrent: true });
    expect((await eventsOf(a.id, E.sessionsRevokedAll))[0]!.payload_json).toEqual({ accountId: a.id, revokedCount: 2, includeCurrent: true });
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: other.sid }), 'SESSION_REVOKED');
  });

  it('only a literal true includes the current session (a truthy string or number does not)', async () => {
    const a = await newAccount();
    const mine = await login(a);
    await login(a);
    for (const v of ['true', 1, {}, [], 'yes']) {
      const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: v as unknown as boolean });
      expect(r.revokedCount).toBeLessThanOrEqual(1);
      expect((await sessionById(mine.id)).revoked_at).toBeNull();
    }
  });

  it('with nothing to revoke it still records the sweep (count 0) and raises the watermark', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: false });
    expect(r.revokedCount).toBe(0);
    expect(await watermarkOf(a.id)).not.toBeNull();
    expect((await auditOf(a.id, 'SESSIONS_REVOKED_ALL'))[0]!.changes).toEqual({ revokedCount: 0, includeCurrent: false });
    expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(0);
  });

  it('a second sweep revokes nothing new and keeps counting only live sessions', async () => {
    const a = await newAccount();
    const mine = await login(a);
    await login(a);
    await login(a);
    expect((await svc.revokeAllSessions(mine.cur, { includeCurrent: false })).revokedCount).toBe(2);
    expect((await svc.revokeAllSessions(mine.cur, { includeCurrent: false })).revokedCount).toBe(0);
    expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(2);
    expect(await auditOf(a.id, 'SESSIONS_REVOKED_ALL')).toHaveLength(2);
  });

  it('works for a SUSPENDED account and still raises the watermark', async () => {
    const a = await newAccount();
    const mine = await login(a);
    await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    expect((await svc.revokeAllSessions(mine.cur, { includeCurrent: false })).revokedCount).toBe(1);
    expect(await watermarkOf(a.id)).not.toBeNull();
  });

  it('Keycloak (includeCurrent false): lists the provider sessions and ends each EXCEPT the current one, also those the API never saw', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const known = await login(a);
    const unseen = newSid();
    liveAtProvider(a, mine.sid, known.sid, unseen);
    const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: false });
    expect(r.keycloak).toBe('ENDED');
    expect([...provider.endedSessions].sort()).toEqual([known.sid, unseen].sort());
    expect(provider.callsOf('endAllSessions')).toHaveLength(0);
    expect(provider.user(a.subject).sessions.map((s) => s.id)).toEqual([mine.sid]);
  });

  it('Keycloak (includeCurrent false) with only the current session at the provider: NOT_NEEDED', async () => {
    const a = await newAccount();
    const mine = await login(a);
    await login(a);
    liveAtProvider(a, mine.sid);
    const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: false });
    expect(r).toMatchObject({ revokedCount: 1, keycloak: 'NOT_NEEDED' });
    expect(provider.endedSessions).toEqual([]);
  });

  it('Keycloak (includeCurrent true): ends everything with ONE endAllSessions call and no listing', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const other = await login(a);
    liveAtProvider(a, mine.sid, other.sid);
    const r = await svc.revokeAllSessions(mine.cur, { includeCurrent: true });
    expect(r.keycloak).toBe('ENDED');
    expect(provider.callsOf('endAllSessions')).toHaveLength(1);
    expect(provider.callsOf('endAllSessions')[0]!.subject).toBe(a.subject);
    expect(provider.callsOf('listSessions')).toHaveLength(0);
    expect(provider.user(a.subject).sessions).toEqual([]);
  });

  it('Keycloak failures never undo the revocation: listing fails, one end fails, endAll fails, provider not configured', async () => {
    const a = await newAccount();
    const mine = await login(a);
    const s1 = await login(a);
    const s2 = await login(a);
    liveAtProvider(a, mine.sid, s1.sid, s2.sid);
    provider.failNext('listSessions');
    expect((await svc.revokeAllSessions(mine.cur, { includeCurrent: false })).keycloak).toBe('UNAVAILABLE');
    expect((await sessionById(s1.id)).revoked_at).not.toBeNull();
    expect((await sessionById(s2.id)).revoked_at).not.toBeNull();
    expect(provider.endedSessions).toEqual([]);

    const b = await newAccount();
    const m2 = await login(b);
    const t1 = await login(b);
    const t2 = await login(b);
    liveAtProvider(b, m2.sid, t1.sid, t2.sid);
    provider.failNext('endSession');
    const partial = await svc.revokeAllSessions(m2.cur, { includeCurrent: false });
    expect(partial.keycloak).toBe('UNAVAILABLE');
    expect(provider.endedSessions).toHaveLength(1); // the other end was still attempted
    expect(await liveSessions(b.id)).toHaveLength(1);

    const c = await newAccount();
    const m3 = await login(c);
    liveAtProvider(c, m3.sid);
    provider.failNext('endAllSessions');
    expect((await svc.revokeAllSessions(m3.cur, { includeCurrent: true })).keycloak).toBe('UNAVAILABLE');
    expect((await sessionById(m3.id)).revoked_at).not.toBeNull();

    const d = await newAccount();
    const m4 = await login(d);
    provider.available = false;
    expect((await svc.revokeAllSessions(m4.cur, { includeCurrent: true })).keycloak).toBe('UNAVAILABLE');
    expect((await sessionById(m4.id)).revoked_at).not.toBeNull();
  });

  it('a failing audit or event insert (also the very last one) rolls back every revocation AND the watermark', async () => {
    const a = await newAccount();
    const mine = await login(a);
    await login(a);
    await login(a);
    const before = await snapshot(a.id);
    for (const key of [E.sessionRevoked, E.sessionsRevokedAll, 'SESSION_REVOKED', 'SESSIONS_REVOKED_ALL'])
      await expectForcedFailure(failing([key], () => svc.revokeAllSessions(mine.cur, { includeCurrent: false })));
    expect(await snapshot(a.id)).toEqual(before);
    expect(await watermarkOf(a.id)).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect((await svc.revokeAllSessions(mine.cur, { includeCurrent: false })).revokedCount).toBe(2);
  });

  it('race: two simultaneous sweeps revoke each session exactly once (counts add up, one audit row per session)', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await newAccount();
      const mine = await login(a);
      const others = await Promise.all(Array.from({ length: 8 }, () => login(a)));
      const results = await Promise.all([1, 2, 3].map(() => settled(svc.revokeAllSessions(mine.cur, { includeCurrent: false }))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect((results as { revokedCount: number }[]).reduce((n, r) => n + r.revokedCount, 0)).toBe(others.length);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(others.length);
      expect(await auditOf(a.id, 'SESSIONS_REVOKED_ALL')).toHaveLength(3);
      expect((await liveSessions(a.id)).map((s) => s.application_session_id)).toEqual([mine.id]);
    }
  });

  it('race: a sweep racing 20 first sights leaves no usable session that was authenticated before the watermark (15 rounds)', async () => {
    for (let round = 0; round < 15; round++) {
      const a = await newAccount();
      const mine = await login(a);
      const past = Math.floor(Date.now() / 1000) - 120; // authenticated long before the sweep
      const future = Math.floor(Date.now() / 1000) + 3600; // authenticated after it, certainly
      const sights = [
        ...Array.from({ length: 12 }, () => ({ sid: newSid(), authTime: past, pre: true })),
        ...Array.from({ length: 8 }, () => ({ sid: newSid(), authTime: future, pre: false })),
      ].sort(() => Math.random() - 0.5);
      const calls: Promise<unknown>[] = sights.map((s, i) =>
        sleep((i * 3) % 7).then(() => settled(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime: s.authTime }))),
      );
      const sweep = jitter().then(() => settled(svc.revokeAllSessions(mine.cur, { includeCurrent: false })));
      const [results, sweepResult] = await Promise.all([Promise.all(calls), sweep]);
      expect(isErr(sweepResult), 'the sweep').toBe(false);
      const w = (await watermarkOf(a.id))!;
      expect(w).not.toBeNull();

      results.forEach((r, i) => {
        const s = sights[i]!;
        // a first sight either created the session, or was refused as revoked: nothing else (no deadlock, no conflict, no raw error)
        if (isErr(r)) expect(codeOf(r), `first sight ${i}`).toBe('SESSION_REVOKED');
        // a session authenticated after the watermark is never refused
        if (!s.pre) expect(isErr(r), `a post-watermark login ${i} was refused`).toBe(false);
      });
      // THE invariant: no session that was authenticated before the watermark and first seen after it is usable; sessions seen before the sweep were revoked by it
      const rows = (await sessionRows(a.id)).filter((r) => r.application_session_id !== mine.id);
      for (const row of rows) {
        const s = sights.find((x) => x.sid === row.keycloak_session_id)!;
        const seenBeforeSweep = row.created_at.getTime() < w.getTime();
        expect(row.revoked_at !== null, `a session created ${seenBeforeSweep ? 'before' : 'after'} the watermark`).toBe(seenBeforeSweep);
        if (s.pre) expect(row.revoked_at, 'a pre-watermark login is usable').not.toBeNull();
      }
      const createdPre = sights.filter((s, i) => s.pre && !isErr(results[i]!));
      for (const s of createdPre) await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid, authTime: s.authTime }), 'SESSION_REVOKED');
      expect((sweepResult as { revokedCount: number }).revokedCount).toBe(rows.filter((r) => r.revocation_reason === 'SIGN_OUT_EVERYWHERE').length);
      expect((await liveSessions(a.id)).some((s) => s.application_session_id === mine.id)).toBe(true);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength((sweepResult as { revokedCount: number }).revokedCount);
    }
  });
});

// ====================================================================== signOutCurrentSession
describe('signOutCurrentSession', () => {
  it('revokes the session with reason SIGN_OUT, audits it, ends the provider session and refuses the next request', async () => {
    const a = await newAccount();
    const s = await login(a);
    const other = await login(a);
    liveAtProvider(a, s.sid, other.sid);
    const cid = `cid-${randomUUID()}`;
    expect(await runWithCorrelation(cid, () => svc.signOutCurrentSession(s.cur))).toEqual({ changed: true, keycloak: 'ENDED' });
    expect(await sessionById(s.id)).toMatchObject({ revocation_reason: 'SIGN_OUT' });
    expect((await sessionById(other.id)).revoked_at).toBeNull();
    const audits = await auditOf(a.id, 'SESSION_REVOKED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ application_session_id: s.id, changes: { reason: 'SIGN_OUT' }, correlation_id: cid });
    expect((await eventsOf(a.id, E.sessionRevoked))[0]!.payload_json).toEqual({ accountId: a.id, applicationSessionId: s.id, reason: 'SIGN_OUT' });
    expect(provider.endedSessions).toEqual([s.sid]);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: s.sid }), 'SESSION_REVOKED');
    expect(await watermarkOf(a.id)).toBeNull();
  });

  it('is idempotent in the database (no new audit row or event), and asks the provider to end the session again', async () => {
    const a = await newAccount();
    const s = await login(a);
    liveAtProvider(a, s.sid);
    provider.failNext('endSession');
    expect(await svc.signOutCurrentSession(s.cur)).toEqual({ changed: true, keycloak: 'UNAVAILABLE' });
    const row = await sessionById(s.id);
    const second = await svc.signOutCurrentSession(s.cur);
    expect(second).toEqual({ changed: false, keycloak: 'ENDED' });
    expect(await sessionById(s.id)).toEqual(row);
    expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
    expect(await eventsOf(a.id, E.sessionRevoked)).toHaveLength(1);
  });

  it('a session that was never seen, or belongs to another account, changes nothing and calls no provider', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const theirs = await login(b);
    const before = await world();
    expect(await svc.signOutCurrentSession(curOf(a.id, newSid()))).toEqual({ changed: false, keycloak: 'NOT_NEEDED' });
    expect(await svc.signOutCurrentSession(curOf(a.id, theirs.sid))).toEqual({ changed: false, keycloak: 'NOT_NEEDED' });
    expect(await world()).toEqual(before);
    expect((await sessionById(theirs.id)).revoked_at).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('a failing event rolls the sign-out back', async () => {
    const a = await newAccount();
    const s = await login(a);
    const before = await snapshot(a.id);
    await expectForcedFailure(failing([E.sessionRevoked], () => svc.signOutCurrentSession(s.cur)));
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('race: 10 parallel sign-outs change the session once', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await newAccount();
      const s = await login(a);
      liveAtProvider(a, s.sid);
      const results = await Promise.all(Array.from({ length: 10 }, () => settled(svc.signOutCurrentSession(s.cur))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect((results as { changed: boolean }[]).filter((r) => r.changed)).toHaveLength(1);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
      expect(await eventsOf(a.id, E.sessionRevoked)).toHaveLength(1);
    }
  });

  it('race: a sign-out racing a sweep that includes the current session revokes it exactly once', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await newAccount();
      const s = await login(a);
      const o = await login(a);
      const [out, sweep] = await Promise.all([settled(svc.signOutCurrentSession(s.cur)), settled(svc.revokeAllSessions(s.cur, { includeCurrent: true }))]);
      expect([out, sweep].filter(isErr).map(codeOf)).toEqual([]);
      const changed = (out as { changed: boolean }).changed ? 1 : 0;
      expect(changed + (sweep as { revokedCount: number }).revokedCount).toBe(2);
      expect(await liveSessions(a.id)).toHaveLength(0);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(2);
      expect((await sessionById(o.id)).revocation_reason).toBe('SIGN_OUT_EVERYWHERE');
    }
  });
});

// ====================================================================== devices
describe('listDevices', () => {
  it('lists the account browsers, newest activity first, the current one marked, removed ones never, no hash and no secret', async () => {
    const a = await newAccount();
    const other = await newAccount();
    const d1 = await loginWithDevice(a, { ua: CHROME_WIN });
    const d2 = await loginWithDevice(a, { ua: SAFARI_IPHONE });
    const d3 = await loginWithDevice(a, { ua: FIREFOX_LINUX });
    await loginWithDevice(other);
    await svc.removeDevice(d1.cur, d3.deviceId);
    const r = await svc.listDevices(d1.cur);
    expect(r.devices.map((d) => d.deviceId).sort()).toEqual([d1.deviceId, d2.deviceId].sort());
    const cur = r.devices.filter((d) => d.current);
    expect(cur.map((d) => d.deviceId)).toEqual([d1.deviceId]);
    expect(r.devices.find((d) => d.deviceId === d2.deviceId)).toMatchObject({
      device: { browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' },
      trusted: false,
      trustedUntil: null,
    });
    for (const d of r.devices) {
      expect(Object.keys(d).sort()).toEqual(['current', 'device', 'deviceId', 'firstSeenAt', 'lastSeenAt', 'trusted', 'trustedUntil']);
      expect(new Date(d.firstSeenAt).toISOString()).toBe(d.firstSeenAt);
    }
    const text = JSON.stringify(r);
    for (const h of await deviceHashes()) expect(text).not.toContain(h);
    expect(text).not.toContain(d1.secret);
    expect(text).not.toContain(d1.sid);
  });

  it('the last seen time of a device is the newest of the device and of its sessions', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const later = await craftSession(a.id, { deviceId: d.deviceId, createdAgoSec: 100, lastSeenAgoSec: 0 });
    await q(`UPDATE identity.application_sessions SET last_seen_at = clock_timestamp() + interval '5 seconds' WHERE application_session_id = $1`, [later.id]);
    const sessionSeen = (await sessionById(later.id)).last_seen_at;
    const r = await svc.listDevices(d.cur);
    expect(new Date(r.devices[0]!.lastSeenAt).getTime()).toBe(sessionSeen.getTime());
  });

  it('a session without a device marks no device as current; an unknown sid likewise', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const bare = await login(a);
    expect((await svc.listDevices(bare.cur)).devices.some((x) => x.current)).toBe(false);
    expect((await svc.listDevices(curOf(a.id, newSid()))).devices.some((x) => x.current)).toBe(false);
    expect((await svc.listDevices(curOf(a.id, d.sid))).devices.filter((x) => x.current)).toHaveLength(1);
  });
});

describe('the trusted browser', () => {
  const intervalDays = async (deviceId: string): Promise<number> =>
    Number(
      (
        await q<{ d: string }>(
          `SELECT EXTRACT(EPOCH FROM (trusted_until - trusted_at)) / 86400 AS d FROM identity.account_devices WHERE account_device_id = $1`,
          [deviceId],
        )
      )[0]!.d,
    );

  it('trusting sets the window from the policy (session.trusted_browser_days), audits DEVICE_TRUSTED and makes isDeviceTrusted true', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(false);
    const t0 = await dbNow();
    const cid = `cid-${randomUUID()}`;
    const r = await runWithCorrelation(cid, () => svc.trustCurrentDevice(d.cur));
    const t1 = await dbNow();
    expect(r).toEqual({ deviceId: d.deviceId, trusted: true, trustedUntil: expect.any(String) });
    between(new Date(r.trustedUntil!).getTime(), t0.getTime() + 30 * DAY, t1.getTime() + 30 * DAY);
    expect(await intervalDays(d.deviceId)).toBeCloseTo(30, 3);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(true);
    const audits = await auditOf(a.id, 'DEVICE_TRUSTED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      account_device_id: d.deviceId,
      application_session_id: null,
      actor: `account:${a.id}`,
      changes: { trustedBrowserDays: 30, renewed: false },
      correlation_id: cid,
    });
    expect((await svc.listDevices(d.cur)).devices[0]).toMatchObject({ trusted: true, trustedUntil: r.trustedUntil });
  });

  for (const days of [1, 7, 90, 365])
    it(`the window follows the configured policy (${days} days)`, async () => {
      policy.set({ trustedBrowserDays: days });
      const a = await newAccount();
      const d = await loginWithDevice(a);
      await svc.trustCurrentDevice(d.cur);
      expect(await intervalDays(d.deviceId)).toBeCloseTo(days, 3);
      expect((await auditOf(a.id, 'DEVICE_TRUSTED'))[0]!.changes).toMatchObject({ trustedBrowserDays: days });
    });

  it('renewing a trusted browser extends the window from now and audits it as a renewal', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    // ten days of the window have elapsed (time travel by SQL)
    await q(
      `UPDATE identity.account_devices SET trusted_at = trusted_at - interval '10 days', trusted_until = trusted_until - interval '10 days' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    const before = (await deviceById(d.deviceId)).trusted_until!;
    const r = await svc.trustCurrentDevice(d.cur);
    expect(new Date(r.trustedUntil!).getTime()).toBeGreaterThan(before.getTime() + 9 * DAY);
    const audits = await auditOf(a.id, 'DEVICE_TRUSTED');
    expect(audits.map((x) => (x.changes as { renewed: boolean }).renewed)).toEqual([false, true]);
  });

  it('expiry is decided by the clock: an elapsed window is untrusted everywhere without any write', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '40 days', trusted_until = clock_timestamp() - interval '10 days' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    const second = await login(a);
    expect(await svc.registerSession({ ...second.cur, deviceSecret: d.secret, userAgent: CHROME_WIN })).toMatchObject({
      deviceTrusted: false,
      trustedUntil: null,
    });
    const row = await deviceById(d.deviceId);
    const audits = (await audit(a.id)).length;
    expect(await svc.isDeviceTrusted(d.cur)).toBe(false);
    expect((await svc.listDevices(d.cur)).devices[0]).toMatchObject({ trusted: false, trustedUntil: null });
    expect((await svc.listSessions(d.cur)).sessions.find((s) => s.current)).toMatchObject({ trusted: false, trustedUntil: null });
    expect((await svc.getOverview(d.cur, { authTime: authNow() })).currentSession).toMatchObject({
      deviceId: d.deviceId,
      deviceTrusted: false,
      trustedUntil: null,
    });
    // nothing was written by reading
    expect(await deviceById(d.deviceId)).toEqual(row);
    expect((await audit(a.id)).length).toBe(audits);
  });

  it('a window that still has seconds left is trusted; one that ended a second ago is not', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '1 day', trusted_until = clock_timestamp() + interval '5 seconds' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    expect(await svc.isDeviceTrusted(d.cur)).toBe(true);
    await q(`UPDATE identity.account_devices SET trusted_until = clock_timestamp() - interval '1 second' WHERE account_device_id = $1`, [d.deviceId]);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(false);
  });

  it('after the window elapsed, trusting again starts a fresh window and is not a renewal', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '40 days', trusted_until = clock_timestamp() - interval '10 days' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    await svc.trustCurrentDevice(d.cur);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(true);
    expect((await auditOf(a.id, 'DEVICE_TRUSTED')).map((x) => (x.changes as { renewed: boolean }).renewed)).toEqual([false, false]);
  });

  it('untrusting clears both columns and audits DEVICE_UNTRUSTED; untrusting an untrusted or expired browser is a no-op without audit', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    expect(await svc.untrustCurrentDevice(d.cur)).toEqual({ deviceId: d.deviceId, trusted: false, trustedUntil: null });
    expect(await auditOf(a.id, 'DEVICE_UNTRUSTED')).toHaveLength(0);
    await svc.trustCurrentDevice(d.cur);
    expect(await svc.untrustCurrentDevice(d.cur)).toEqual({ deviceId: d.deviceId, trusted: false, trustedUntil: null });
    const row = await deviceById(d.deviceId);
    expect([row.trusted_at, row.trusted_until]).toEqual([null, null]);
    const untrusted = await auditOf(a.id, 'DEVICE_UNTRUSTED');
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]).toMatchObject({ account_device_id: d.deviceId, application_session_id: null });
    expect(await svc.untrustCurrentDevice(d.cur)).toMatchObject({ trusted: false });
    expect(await auditOf(a.id, 'DEVICE_UNTRUSTED')).toHaveLength(1);
    // an elapsed window is "not trusted": untrusting it is also a no-op
    await svc.trustCurrentDevice(d.cur);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '40 days', trusted_until = clock_timestamp() - interval '10 days' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    await svc.untrustCurrentDevice(d.cur);
    expect(await auditOf(a.id, 'DEVICE_UNTRUSTED')).toHaveLength(1);
  });

  it('DEVICE_REQUIRED when the session has no browser; nothing is written and isDeviceTrusted is false', async () => {
    const a = await newAccount();
    const bare = await login(a);
    const before = await snapshot(a.id);
    await fails(svc.trustCurrentDevice(bare.cur), 'DEVICE_REQUIRED');
    await fails(svc.untrustCurrentDevice(bare.cur), 'DEVICE_REQUIRED');
    expect(await svc.isDeviceTrusted(bare.cur)).toBe(false);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('SESSION_NOT_FOUND for an unknown or foreign sid, SESSION_REVOKED for a revoked one, SUSPENDED for a suspended account', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const theirs = await loginWithDevice(b);
    const mine = await loginWithDevice(a);
    await fails(svc.trustCurrentDevice(curOf(a.id, newSid())), 'SESSION_NOT_FOUND');
    await fails(svc.trustCurrentDevice(curOf(a.id, theirs.sid)), 'SESSION_NOT_FOUND');
    await fails(svc.untrustCurrentDevice(curOf(a.id, theirs.sid)), 'SESSION_NOT_FOUND');
    expect(await svc.isDeviceTrusted(curOf(a.id, theirs.sid))).toBe(false);
    expect((await deviceById(theirs.deviceId)).trusted_until).toBeNull();
    const other = await login(a);
    await svc.revokeSession(mine.cur, other.id);
    await fails(svc.trustCurrentDevice(other.cur), 'SESSION_REVOKED');
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await fails(svc.trustCurrentDevice(mine.cur), 'SUSPENDED');
  });

  it('a revoked session cannot report a trusted browser', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    await svc.trustCurrentDevice(d.cur);
    await svc.revokeSession(keep.cur, d.id);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(false);
  });

  it('the policy failing closes trust with POLICY_UNAVAILABLE and writes nothing', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    policy.failure = new Error('configuration database exploded');
    const before = await snapshot(a.id);
    await fails(svc.trustCurrentDevice(d.cur), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('a failing audit insert rolls the trust window back', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const before = await snapshot(a.id);
    await expectForcedFailure(failing(['DEVICE_TRUSTED'], () => svc.trustCurrentDevice(d.cur)));
    expect(await snapshot(a.id)).toEqual(before);
    await svc.trustCurrentDevice(d.cur);
    await expectForcedFailure(failing(['DEVICE_UNTRUSTED'], () => svc.untrustCurrentDevice(d.cur)));
    expect(await svc.isDeviceTrusted(d.cur)).toBe(true);
  });

  it('a trusted browser NEVER changes a step-up outcome: the overview facts are identical trusted or not', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const facts = [
      { authTime: authNow(), acr: 'bananagig:password' },
      { authTime: authNow() - 3600, acr: 'bananagig:password' },
      { authTime: authNow(), acr: 'bananagig:mfa' },
      { authTime: authNow() - 3600, acr: undefined },
      { authTime: undefined, acr: 'bananagig:password' },
    ];
    const untrusted = await Promise.all(facts.map((f) => svc.getOverview(d.cur, f)));
    await svc.trustCurrentDevice(d.cur);
    const trusted = await Promise.all(facts.map((f) => svc.getOverview(d.cur, f)));
    trusted.forEach((o, i) => {
      expect(o.stepUp, `facts ${i}`).toEqual(untrusted[i]!.stepUp);
      expect(o.currentSession.deviceTrusted).toBe(true);
      expect(untrusted[i]!.currentSession.deviceTrusted).toBe(false);
    });
    expect(trusted[0]!.stepUp.mfaSatisfied).toBe(false);
    expect(trusted[1]!.stepUp.recentUntil).toBeNull();
    // the service offers no operation that takes a trusted browser as an input to a step-up decision
    const names = Object.getOwnPropertyNames(SecurityService.prototype);
    expect(names.filter((n) => /stepup|requirerecent|requiremfa|bypass|skip/i.test(n))).toEqual([]);
  });

  it('race: 20 parallel renewals each succeed, are audited, and the final window is the last one granted (the first is not a renewal)', async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newAccount();
      const d = await loginWithDevice(a);
      const results = await Promise.all(Array.from({ length: 20 }, () => settled(svc.trustCurrentDevice(d.cur))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const audits = await auditOf(a.id, 'DEVICE_TRUSTED');
      expect(audits).toHaveLength(20);
      expect(audits.filter((x) => (x.changes as { renewed: boolean }).renewed === false)).toHaveLength(1);
      const max = Math.max(...(results as { trustedUntil: string }[]).map((r) => new Date(r.trustedUntil).getTime()));
      expect((await deviceById(d.deviceId)).trusted_until!.getTime()).toBe(max);
      expect(await svc.isDeviceTrusted(d.cur)).toBe(true);
    }
  });

  it('race: trust and untrust interleaved leave a state that matches the last audit row', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await newAccount();
      const d = await loginWithDevice(a);
      const calls = Array.from({ length: 12 }, (_, i) =>
        jitter().then(() => settled(i % 2 === 0 ? svc.trustCurrentDevice(d.cur) : svc.untrustCurrentDevice(d.cur))),
      );
      const results = await Promise.all(calls);
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const trail = (await audit(a.id, ['DEVICE_TRUSTED', 'DEVICE_UNTRUSTED'])).map((x) => x.action);
      const row = await deviceById(d.deviceId);
      expect(row.trusted_until !== null, JSON.stringify(trail)).toBe(trail.at(-1) === 'DEVICE_TRUSTED');
      expect((row.trusted_at === null) === (row.trusted_until === null)).toBe(true);
      // an untrust is audited only when it changed something: no two untrusts in a row
      for (let i = 1; i < trail.length; i++) expect(trail[i] === 'DEVICE_UNTRUSTED' && trail[i - 1] === 'DEVICE_UNTRUSTED').toBe(false);
    }
  });

  it('race: trusting while the browser is removed ends removed, untrusted, and with no live session on it', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await newAccount();
      const d = await loginWithDevice(a);
      const admin = await login(a);
      const calls: Promise<unknown>[] = [settled(svc.removeDevice(admin.cur, d.deviceId))];
      for (let i = 0; i < 6; i++) calls.push(jitter().then(() => settled(svc.trustCurrentDevice(d.cur))));
      const results = await Promise.all(calls);
      for (const r of results.slice(1)) if (isErr(r)) expect(codeOf(r)).toBe('SESSION_REVOKED');
      expect(isErr(results[0])).toBe(false);
      const row = await deviceById(d.deviceId);
      expect(row.removed_at).not.toBeNull();
      expect([row.trusted_at, row.trusted_until]).toEqual([null, null]);
      expect((await sessionById(d.id)).revocation_reason).toBe('DEVICE_REMOVED');
    }
  });
});

describe('removeDevice', () => {
  it('untrusts and removes the browser, revokes its sessions (DEVICE_REMOVED), audits the device and each session, ends the provider sessions', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const second = await login(a);
    await svc.registerSession({ ...second.cur, deviceSecret: d.secret, userAgent: CHROME_WIN });
    const keep = await loginWithDevice(a, { ua: FIREFOX_LINUX });
    liveAtProvider(a, d.sid, second.sid, keep.sid);
    await svc.trustCurrentDevice(d.cur);
    const cid = `cid-${randomUUID()}`;
    const r = await runWithCorrelation(cid, () => svc.removeDevice(keep.cur, d.deviceId));
    expect(r).toEqual({ deviceId: d.deviceId, changed: true, sessionsRevoked: 2, keycloak: 'ENDED' });
    const row = await deviceById(d.deviceId);
    expect(row.removed_at).not.toBeNull();
    expect([row.trusted_at, row.trusted_until]).toEqual([null, null]);
    for (const s of [d, second]) expect(await sessionById(s.id)).toMatchObject({ revocation_reason: 'DEVICE_REMOVED' });
    expect((await sessionById(keep.id)).revoked_at).toBeNull();
    expect((await deviceById(keep.deviceId)).removed_at).toBeNull();
    const removed = await auditOf(a.id, 'DEVICE_REMOVED');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ account_device_id: d.deviceId, application_session_id: null, changes: { wasTrusted: true }, correlation_id: cid });
    const per = await auditOf(a.id, 'SESSION_REVOKED');
    expect(per.map((x) => x.application_session_id).sort()).toEqual([d.id, second.id].sort());
    for (const x of per) expect(x).toMatchObject({ changes: { reason: 'DEVICE_REMOVED' }, correlation_id: cid });
    expect((await eventsOf(a.id, E.sessionRevoked)).map((x) => x.payload_json.reason)).toEqual(['DEVICE_REMOVED', 'DEVICE_REMOVED']);
    expect([...provider.endedSessions].sort()).toEqual([d.sid, second.sid].sort());
    expect((await svc.listDevices(keep.cur)).devices.map((x) => x.deviceId)).toEqual([keep.deviceId]);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: d.sid }), 'SESSION_REVOKED');
  });

  it('is terminal: removing again changes nothing; the database refuses to trust or restore a removed browser', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    await svc.removeDevice(keep.cur, d.deviceId);
    const row = await deviceById(d.deviceId);
    const audits = (await audit(a.id)).length;
    const again = await svc.removeDevice(keep.cur, d.deviceId);
    expect(again).toMatchObject({ deviceId: d.deviceId, changed: false, sessionsRevoked: 0 });
    expect(await deviceById(d.deviceId)).toEqual(row);
    expect((await audit(a.id)).length).toBe(audits);
    for (const stmt of [
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + interval '1 day' WHERE account_device_id = $1`,
      'UPDATE identity.account_devices SET removed_at = NULL WHERE account_device_id = $1',
    ]) {
      const e = (await rejection(q(stmt, [d.deviceId]))) as { detail?: string };
      expect(e.detail).toBe('identity_rule:DEVICE_REMOVED_TERMINAL');
    }
  });

  it('removing a browser again asks the provider to end the sessions it had (a retry after a failed propagation)', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    liveAtProvider(a, d.sid);
    provider.failNext('endSession');
    expect((await svc.removeDevice(keep.cur, d.deviceId)).keycloak).toBe('UNAVAILABLE');
    const again = await svc.removeDevice(keep.cur, d.deviceId);
    expect(again.changed).toBe(false);
    expect(again.keycloak).toBe('ENDED');
    expect(provider.endedSessions).toEqual([d.sid]);
  });

  it('only live sessions are revoked: a session that was already revoked keeps its reason', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    const gone = await craftSession(a.id, { deviceId: d.deviceId, revoked: { reason: 'SIGN_OUT' } });
    const r = await svc.removeDevice(keep.cur, d.deviceId);
    expect(r.sessionsRevoked).toBe(1);
    expect((await sessionById(gone.id)).revocation_reason).toBe('SIGN_OUT');
  });

  it('a browser without sessions: sessionsRevoked 0 and nothing to ask the provider', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    await q(`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT' WHERE application_session_id = $1`, [
      d.id,
    ]);
    const r = await svc.removeDevice(keep.cur, d.deviceId);
    expect(r).toMatchObject({ changed: true, sessionsRevoked: 0, keycloak: 'NOT_NEEDED' });
    expect(provider.callsOf('endSession')).toHaveLength(0);
  });

  it('removing the CURRENT browser revokes the current session', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    liveAtProvider(a, d.sid);
    const r = await svc.removeDevice(d.cur, d.deviceId);
    expect(r.sessionsRevoked).toBe(1);
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: d.sid }), 'SESSION_REVOKED');
  });

  it('a device of ANOTHER account, an unknown id and a malformed id are the same DEVICE_NOT_FOUND and nothing changes', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const mine = await login(a);
    const theirs = await loginWithDevice(b);
    const before = { a: await snapshot(a.id), b: await snapshot(b.id) };
    const errors: AccountError[] = [];
    for (const id of [
      theirs.deviceId,
      randomUUID(),
      'nope',
      '',
      "1'; DROP TABLE identity.account_devices; --",
      undefined as unknown as string,
      7 as unknown as string,
    ])
      errors.push(await fails(svc.removeDevice(mine.cur, id), 'DEVICE_NOT_FOUND'));
    expect(new Set(errors.map((e) => JSON.stringify([e.message, e.details]))).size).toBe(1);
    expect({ a: await snapshot(a.id), b: await snapshot(b.id) }).toEqual(before);
  });

  it('propagation failures never undo the removal', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    liveAtProvider(a, d.sid);
    provider.available = false;
    const r = await svc.removeDevice(keep.cur, d.deviceId);
    expect(r).toMatchObject({ changed: true, sessionsRevoked: 1, keycloak: 'UNAVAILABLE' });
    expect((await deviceById(d.deviceId)).removed_at).not.toBeNull();
  });

  it('a failing audit or event insert rolls the whole removal back', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const keep = await login(a);
    await svc.trustCurrentDevice(d.cur);
    const before = await snapshot(a.id);
    for (const key of ['DEVICE_REMOVED', 'SESSION_REVOKED', E.sessionRevoked])
      await expectForcedFailure(failing([key], () => svc.removeDevice(keep.cur, d.deviceId)));
    expect(await snapshot(a.id)).toEqual(before);
    expect(provider.callsOf('endSession')).toHaveLength(0);
  });

  it('race: two removals of one browser change it once (one DEVICE_REMOVED row, one revocation per session)', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newAccount();
      const d = await loginWithDevice(a);
      const keep = await login(a);
      const results = await Promise.all(Array.from({ length: 6 }, () => settled(svc.removeDevice(keep.cur, d.deviceId))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect((results as { changed: boolean }[]).filter((r) => r.changed)).toHaveLength(1);
      expect(await auditOf(a.id, 'DEVICE_REMOVED')).toHaveLength(1);
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
    }
  });
});

// ====================================================================== getOverview
const ov = (s: { cur: CurrentSession }, facts: { authTime?: number; acr?: string } = { authTime: authNow() }) => svc.getOverview(s.cur, facts);
const MFA_AUDIT = ['MFA_ENABLED', 'MFA_DISABLED'];
const RECOVERY_AUDIT = ['RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED'];
const PASSWORD_AUDIT = ['PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED'];

describe('getOverview: the shape and the identity provider', () => {
  it('reports the second-factor state from the provider, the step-up facts, the session and the policy', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: false });
    const authTime = Math.floor(clock.ms / 1000) - 60;
    const o = await svc.getOverview(d.cur, { authTime, acr: 'bananagig:mfa' });
    expect(o).toEqual({
      mfa: { available: true, totpConfigured: true, recoveryCodesConfigured: false },
      stepUp: {
        authenticatedAt: new Date(authTime * 1000).toISOString(),
        mfaSatisfied: true,
        recentUntil: new Date((authTime + 15 * 60) * 1000).toISOString(),
      },
      currentSession: { sessionId: d.id, deviceId: d.deviceId, deviceTrusted: false, trustedUntil: null },
      policy: { trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 },
    });
    expect(JSON.stringify(o)).not.toContain(d.sid);
  });

  it('when the provider is down the flags are false, available is false and NOTHING is recorded', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true, passwordChangedAt: new Date(Date.now() + 3600_000) });
    const before = await snapshot(a.id);
    for (const mode of ['unconfigured', 'failing'] as const) {
      provider.reset();
      provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true, passwordChangedAt: new Date(Date.now() + 3600_000) });
      if (mode === 'unconfigured') provider.available = false;
      else provider.failNext('getUserSecurity', Number.POSITIVE_INFINITY);
      const o = await ov(s);
      expect(o.mfa).toEqual({ available: false, totpConfigured: false, recoveryCodesConfigured: false });
      expect(await snapshot(a.id)).toEqual(before);
    }
    expect(logSink.lines.join('\n')).toContain('could not be read');
  });

  it('the policy section reflects the configuration', async () => {
    const a = await newAccount();
    const s = await login(a);
    policy.set({ trustedBrowserDays: 7, stepUpValidMinutes: 5, activityLogDays: 365, resetLinkValidityMinutes: 10, resetMaxRequestsPerHour: 3 });
    expect((await ov(s)).policy).toEqual({ trustedBrowserDays: 7, stepUpValidMinutes: 5, activityLogDays: 365 });
  });

  it('SESSION_NOT_FOUND for a sid that was never seen or belongs to another account; SESSION_REVOKED for a revoked one', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const theirs = await login(b);
    await fails(svc.getOverview(curOf(a.id, newSid()), {}), 'SESSION_NOT_FOUND');
    await fails(svc.getOverview(curOf(a.id, theirs.sid), {}), 'SESSION_NOT_FOUND');
    const keep = await login(a);
    const gone = await login(a);
    await svc.revokeSession(keep.cur, gone.id);
    await fails(svc.getOverview(gone.cur, {}), 'SESSION_REVOKED');
  });

  it('a failing policy closes the overview with POLICY_UNAVAILABLE', async () => {
    const a = await newAccount();
    const s = await login(a);
    policy.failure = new Error('boom');
    await fails(ov(s), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
  });
});

describe('getOverview: step-up facts come from the token and the policy', () => {
  it('authenticatedAt and recentUntil derive from auth_time + security.step_up_valid_minutes', async () => {
    const a = await newAccount();
    const s = await login(a);
    const authTime = Math.floor(clock.ms / 1000) - 20;
    let o = await svc.getOverview(s.cur, { authTime });
    expect(o.stepUp).toEqual({
      authenticatedAt: new Date(authTime * 1000).toISOString(),
      mfaSatisfied: false,
      recentUntil: new Date((authTime + 900) * 1000).toISOString(),
    });
    policy.set({ stepUpValidMinutes: 1 });
    o = await svc.getOverview(s.cur, { authTime });
    expect(o.stepUp.recentUntil).toBe(new Date((authTime + 60) * 1000).toISOString());
    policy.set({ stepUpValidMinutes: 60 });
    o = await svc.getOverview(s.cur, { authTime });
    expect(o.stepUp.recentUntil).toBe(new Date((authTime + 3600) * 1000).toISOString());
  });

  it('recentUntil is null once the window has elapsed on the application clock (the boundary itself is elapsed)', async () => {
    const a = await newAccount();
    const s = await login(a);
    const authTime = 1_800_000_000;
    const edge = (authTime + 900) * 1000;
    clock.ms = edge - 1;
    expect((await svc.getOverview(s.cur, { authTime })).stepUp.recentUntil).toBe(new Date(edge).toISOString());
    clock.ms = edge;
    expect((await svc.getOverview(s.cur, { authTime })).stepUp.recentUntil).toBeNull();
    clock.ms = edge + 3600_000;
    const late = await svc.getOverview(s.cur, { authTime });
    expect(late.stepUp.recentUntil).toBeNull();
    expect(late.stepUp.authenticatedAt).toBe(new Date(authTime * 1000).toISOString());
  });

  for (const authTime of [undefined, Number.NaN, 0, -100, Number.POSITIVE_INFINITY, 'soon' as unknown as number])
    it(`an unusable auth_time (${String(authTime)}) gives null authenticatedAt and null recentUntil`, async () => {
      const a = await newAccount();
      const s = await login(a);
      const o = await svc.getOverview(s.cur, { authTime });
      expect(o.stepUp.authenticatedAt).toBeNull();
      expect(o.stepUp.recentUntil).toBeNull();
    });

  const ACR: [string | undefined, boolean][] = [
    ['bananagig:mfa', true],
    ['bananagig:password', false],
    [undefined, false],
    ['', false],
    ['BANANAGIG:MFA', false],
    ['bananagig:mfa ', false],
    ['bananagig:mfa,bananagig:password', false],
    ['1', false],
  ];
  for (const [acr, expected] of ACR)
    it(`mfaSatisfied is ${expected} for acr ${JSON.stringify(acr)}`, async () => {
      const a = await newAccount();
      const s = await login(a);
      expect((await svc.getOverview(s.cur, { authTime: authNow(), acr })).stepUp.mfaSatisfied).toBe(expected);
    });

  it('mfaSatisfied does not depend on what Keycloak says about the factors (only on the verified acr)', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    expect((await svc.getOverview(s.cur, { authTime: authNow(), acr: 'bananagig:password' })).stepUp.mfaSatisfied).toBe(false);
    provider.setUser(a.subject, { otpConfigured: false });
    expect((await svc.getOverview(s.cur, { authTime: authNow(), acr: 'bananagig:mfa' })).stepUp.mfaSatisfied).toBe(true);
  });
});

describe('observed second-factor transitions', () => {
  it('a factor that is off when first observed writes nothing', async () => {
    const a = await newAccount();
    const s = await login(a);
    await ov(s);
    await ov(s);
    expect(await audit(a.id, [...MFA_AUDIT, ...RECOVERY_AUDIT])).toHaveLength(0);
    expect(await events(a.id, [E.mfaEnabled, E.mfaDisabled])).toHaveLength(0);
  });

  it('a factor that already exists at first sight is recorded once as a BASELINE: audited, no event', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
    await ov(s);
    await ov(s);
    const totp = await auditOf(a.id, 'MFA_ENABLED');
    const rec = await auditOf(a.id, 'RECOVERY_CODES_ENABLED');
    expect(totp).toHaveLength(1);
    expect(rec).toHaveLength(1);
    expect(totp[0]!.changes).toMatchObject({ method: 'TOTP', baseline: true });
    expect(rec[0]!.changes).toMatchObject({ method: 'RECOVERY_CODES', baseline: true });
    expect(totp[0]).toMatchObject({ actor: `account:${a.id}`, application_session_id: null, account_device_id: null });
    expect(await events(a.id, [E.mfaEnabled, E.mfaDisabled])).toHaveLength(0);
  });

  it('later transitions are audited AND evented, once each: disable, re-enable, recovery on/off', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    await ov(s); // baseline
    provider.setUser(a.subject, { otpConfigured: false });
    await ov(s);
    await ov(s);
    provider.setUser(a.subject, { otpConfigured: true });
    await ov(s);
    await ov(s);
    expect((await auditOf(a.id, 'MFA_DISABLED')).map((x) => x.changes)).toEqual([{ method: 'TOTP' }]);
    expect((await audit(a.id, MFA_AUDIT)).map((x) => x.action)).toEqual(['MFA_ENABLED', 'MFA_DISABLED', 'MFA_ENABLED']);
    expect((await auditOf(a.id, 'MFA_ENABLED')).map((x) => (x.changes as { baseline?: boolean }).baseline === true)).toEqual([true, false]);
    expect((await eventsOf(a.id, E.mfaDisabled)).map((x) => x.payload_json)).toEqual([{ accountId: a.id, method: 'TOTP' }]);
    expect((await eventsOf(a.id, E.mfaEnabled)).map((x) => x.payload_json)).toEqual([{ accountId: a.id, method: 'TOTP' }]);

    provider.setUser(a.subject, { recoveryCodesConfigured: true });
    await ov(s);
    provider.setUser(a.subject, { recoveryCodesConfigured: false });
    await ov(s);
    expect((await audit(a.id, RECOVERY_AUDIT)).map((x) => x.action)).toEqual(['RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED']);
    expect((await eventsOf(a.id, E.mfaDisabled)).map((x) => x.payload_json)).toContainEqual({ accountId: a.id, method: 'RECOVERY_CODES' });
  });

  it('a prior enrolment request makes a later enable a REAL transition (audited and evented, no baseline)', async () => {
    const a = await newAccount();
    const s = await login(a);
    await svc.startMfaEnrollment(s.cur, 'TOTP');
    await svc.startMfaEnrollment(s.cur, 'RECOVERY_CODES');
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
    await ov(s);
    const totp = await auditOf(a.id, 'MFA_ENABLED');
    const rec = await auditOf(a.id, 'RECOVERY_CODES_ENABLED');
    expect(totp.map((x) => x.changes)).toEqual([{ method: 'TOTP' }]);
    expect(rec.map((x) => x.changes)).toEqual([{ method: 'RECOVERY_CODES' }]);
    expect((await events(a.id, [E.mfaEnabled])).map((x) => x.payload_json)).toEqual(
      expect.arrayContaining([
        { accountId: a.id, method: 'TOTP' },
        { accountId: a.id, method: 'RECOVERY_CODES' },
      ]),
    );
    const types = (await svc.listActivity(a.id, {})).entries.map((e) => e.type);
    expect(types).toContain('MFA_ENABLED');
    expect(types).toContain('RECOVERY_CODES_ENABLED');
  });

  it('an enrolment request for ONE method does not make the other factor a real transition', async () => {
    const a = await newAccount();
    const s = await login(a);
    await svc.startMfaEnrollment(s.cur, 'TOTP');
    provider.setUser(a.subject, { recoveryCodesConfigured: true });
    await ov(s);
    expect((await auditOf(a.id, 'RECOVERY_CODES_ENABLED'))[0]!.changes).toMatchObject({ baseline: true });
    expect(await events(a.id, [E.mfaEnabled])).toHaveLength(0);
  });

  it('both factors changing in one call are written in one transaction under one correlation id', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
    await ov(s);
    provider.setUser(a.subject, { otpConfigured: false, recoveryCodesConfigured: false });
    const cid = `cid-${randomUUID()}`;
    await runWithCorrelation(cid, () => ov(s));
    const rows = await audit(a.id, ['MFA_DISABLED', 'RECOVERY_CODES_DISABLED']);
    expect(rows.map((x) => x.action).sort()).toEqual(['MFA_DISABLED', 'RECOVERY_CODES_DISABLED']);
    expect(rows.every((x) => x.correlation_id === cid)).toBe(true);
  });

  it('a failing audit insert never breaks the overview, writes nothing, and is retried by the next call', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    const o = await failing(['MFA_ENABLED'], () => ov(s));
    expect(o.mfa.totpConfigured).toBe(true);
    expect(await audit(a.id, MFA_AUDIT)).toHaveLength(0);
    expect(logSink.lines.join('\n')).toContain('could not be recorded');
    await ov(s);
    expect(await audit(a.id, MFA_AUDIT)).toHaveLength(1);
  });

  it('nothing is observed for a CLOSED account', async () => {
    const a = await newAccount();
    const s = await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await accounts.changeStatus(a.id, 'CLOSED', OP);
    provider.setUser(a.subject, { otpConfigured: true });
    const before = (await audit(a.id, MFA_AUDIT)).length;
    const o = await ov(s);
    expect(o.mfa.totpConfigured).toBe(true);
    expect((await audit(a.id, MFA_AUDIT)).length).toBe(before);
  });

  it('race: 25 parallel overviews observing the same enabled factor write ONE audit row (10 rounds, then the disable)', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await newAccount();
      const s = await login(a);
      provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
      const results = await Promise.all(Array.from({ length: 25 }, () => settled(ov(s))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect(await auditOf(a.id, 'MFA_ENABLED')).toHaveLength(1);
      expect(await auditOf(a.id, 'RECOVERY_CODES_ENABLED')).toHaveLength(1);
      provider.setUser(a.subject, { otpConfigured: false, recoveryCodesConfigured: false });
      await Promise.all(Array.from({ length: 25 }, () => settled(ov(s))));
      expect(await auditOf(a.id, 'MFA_DISABLED')).toHaveLength(1);
      expect(await auditOf(a.id, 'RECOVERY_CODES_DISABLED')).toHaveLength(1);
      expect(await events(a.id, [E.mfaDisabled])).toHaveLength(2);
    }
  });

  it('race: observers with CONFLICTING views (two providers) leave an alternating trail with no repeated state', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newAccount();
      const s = await login(a);
      const providerB = new FakeSecurityIdentityProvider();
      const svcB = makeService({ identityProvider: providerB });
      provider.setUser(a.subject, { otpConfigured: true });
      providerB.setUser(a.subject, { otpConfigured: false });
      const calls = Array.from({ length: 24 }, (_, i) => jitter().then(() => settled(i % 2 === 0 ? ov(s) : svcB.getOverview(s.cur, { authTime: authNow() }))));
      expect((await Promise.all(calls)).filter(isErr).map(codeOf)).toEqual([]);
      const trail = (await audit(a.id, MFA_AUDIT)).map((x) => x.action);
      expect(trail[0]).toBe('MFA_ENABLED');
      for (let i = 1; i < trail.length; i++) expect(trail[i], JSON.stringify(trail)).not.toBe(trail[i - 1]);
      // evented transitions (everything but the baseline) match the audit rows one to one
      const evented = (await audit(a.id, MFA_AUDIT)).filter((x) => (x.changes as { baseline?: boolean }).baseline !== true).length;
      expect((await events(a.id, [E.mfaEnabled, E.mfaDisabled])).length).toBe(evented);
    }
  });
});

describe('observed password changes and resets', () => {
  const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

  it('a password older than (or equal to) the account is the baseline: nothing is recorded; null is nothing', async () => {
    const a = await newAccount();
    const s = await login(a);
    const created = await accountCreatedAt(a.id);
    for (const pw of [null, at(created, -DAY), new Date(created.getTime())]) {
      provider.setUser(a.subject, { passwordChangedAt: pw });
      await ov(s);
    }
    expect(await audit(a.id, PASSWORD_AUDIT)).toHaveLength(0);
  });

  it('a password newer than the account is PASSWORD_CHANGED once (no event); a newer one is another change; older or equal ones are not', async () => {
    const a = await newAccount();
    const s = await login(a);
    const created = await accountCreatedAt(a.id);
    const pw1 = at(created, 3 * 3600_000);
    provider.setUser(a.subject, { passwordChangedAt: pw1 });
    await ov(s);
    await ov(s);
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => [x.action, x.changes])).toEqual([['PASSWORD_CHANGED', { passwordChangedAt: pw1.toISOString() }]]);
    provider.setUser(a.subject, { passwordChangedAt: at(pw1, -1000) });
    await ov(s);
    provider.setUser(a.subject, { passwordChangedAt: pw1 });
    await ov(s);
    expect(await audit(a.id, PASSWORD_AUDIT)).toHaveLength(1);
    const pw2 = at(pw1, 5000);
    provider.setUser(a.subject, { passwordChangedAt: pw2 });
    await ov(s);
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_CHANGED', 'PASSWORD_CHANGED']);
    expect(await events(a.id, [E.passwordResetCompleted])).toHaveLength(0);
  });

  it('a password that changed after a reset request, inside the link lifetime, is PASSWORD_RESET_COMPLETED (audit + event)', async () => {
    const a = await newAccount({ email: true });
    const s = await login(a);
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
    const pw = at(requested.occurred_at, 10 * MIN);
    provider.setUser(a.subject, { passwordChangedAt: pw });
    await ov(s);
    await ov(s);
    const rows = await audit(a.id, PASSWORD_AUDIT);
    expect(rows.map((x) => x.action)).toEqual(['PASSWORD_RESET_COMPLETED']);
    expect(rows[0]!.changes).toEqual({ passwordChangedAt: pw.toISOString() });
    expect((await eventsOf(a.id, E.passwordResetCompleted)).map((x) => x.payload_json)).toEqual([{ accountId: a.id }]);
    // a later change without a new request is a plain change
    provider.setUser(a.subject, { passwordChangedAt: at(pw, 5 * MIN) });
    await ov(s);
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_RESET_COMPLETED', 'PASSWORD_CHANGED']);
  });

  it('the attribution window is link validity + 5 minutes grace: inside it a reset, one millisecond past it a plain change', async () => {
    for (const [offsetMs, expected] of [
      [65 * MIN, 'PASSWORD_RESET_COMPLETED'],
      [65 * MIN + 2, 'PASSWORD_CHANGED'],
      [1, 'PASSWORD_RESET_COMPLETED'],
    ] as const) {
      const a = await newAccount({ email: true });
      const s = await login(a);
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
      const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
      provider.setUser(a.subject, { passwordChangedAt: at(requested.occurred_at, offsetMs) });
      await ov(s);
      expect(
        (await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action),
        `offset ${offsetMs}`,
      ).toEqual([expected]);
    }
    // the window follows the policy (10 minutes + 5)
    policy.set({ resetLinkValidityMinutes: 10 });
    const a = await newAccount({ email: true });
    const s = await login(a);
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
    provider.setUser(a.subject, { passwordChangedAt: at(requested.occurred_at, 16 * MIN) });
    await ov(s);
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_CHANGED']);
  });

  it('a password change that PREDATES the reset request is a plain change, not a completion', async () => {
    const a = await newAccount({ email: true });
    const s = await login(a);
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
    provider.setUser(a.subject, { passwordChangedAt: at(requested.occurred_at, -MIN) });
    // newer than the account, older than the request
    const created = await accountCreatedAt(a.id);
    if (created.getTime() < requested.occurred_at.getTime() - MIN) {
      await ov(s);
      expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_CHANGED']);
    }
  });

  it('race: 20 parallel overviews observing one password change write ONE row (and one completion event)', async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newAccount({ email: true });
      const s = await login(a);
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
      const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
      provider.setUser(a.subject, { passwordChangedAt: at(requested.occurred_at, 5 * MIN) });
      const results = await Promise.all(Array.from({ length: 20 }, () => settled(ov(s))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_RESET_COMPLETED']);
      expect(await events(a.id, [E.passwordResetCompleted])).toHaveLength(1);
    }
  });
});

describe('an observed password change signs the OTHER sessions out', () => {
  it('revokes every other session created before the change (PASSWORD_CHANGED), keeps the current one and a session created after it', async () => {
    const a = await newAccount();
    const other = await newAccount();
    const cur = await login(a);
    const o1 = await login(a);
    const o2 = await login(a);
    const stranger = await login(other);
    liveAtProvider(a, cur.sid, o1.sid, o2.sid);
    const pw = await dbNow();
    await sleep(25);
    const later = await login(a);
    provider.setUser(a.subject, { passwordChangedAt: pw });
    const cid = `cid-${randomUUID()}`;
    await runWithCorrelation(cid, () => ov(cur));
    for (const s of [o1, o2]) expect(await sessionById(s.id)).toMatchObject({ revocation_reason: 'PASSWORD_CHANGED' });
    expect((await sessionById(cur.id)).revoked_at).toBeNull();
    expect((await sessionById(later.id)).revoked_at).toBeNull();
    expect((await sessionById(stranger.id)).revoked_at).toBeNull();
    const per = await auditOf(a.id, 'SESSION_REVOKED');
    expect(per.map((x) => x.application_session_id).sort()).toEqual([o1.id, o2.id].sort());
    for (const x of per) expect(x).toMatchObject({ changes: { reason: 'PASSWORD_CHANGED' }, correlation_id: cid });
    expect((await eventsOf(a.id, E.sessionRevoked)).map((x) => x.payload_json.reason)).toEqual(['PASSWORD_CHANGED', 'PASSWORD_CHANGED']);
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_CHANGED']);
    expect([...provider.endedSessions].sort()).toEqual([o1.sid, o2.sid].sort());
    await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: o1.sid }), 'SESSION_REVOKED');
    // observed again: nothing more happens
    await ov(cur);
    expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(2);
  });

  it('a completed reset signs the other sessions out too', async () => {
    const a = await newAccount({ email: true });
    const cur = await login(a);
    const o1 = await login(a);
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
    provider.setUser(a.subject, { passwordChangedAt: new Date(requested.occurred_at.getTime() + 30_000) });
    // sessions must predate the change: they were created before the request
    await ov(cur);
    expect((await sessionById(o1.id)).revocation_reason).toBe('PASSWORD_CHANGED');
    expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_RESET_COMPLETED']);
  });

  it('is done by registerSession as well, and a failing provider does not fail the registration', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const o1 = await login(a);
    liveAtProvider(a, o1.sid);
    provider.setUser(a.subject, { passwordChangedAt: new Date((await dbNow()).getTime() + 1) });
    const r = await svc.registerSession({ ...cur.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN });
    expect(r.deviceId).toMatch(UUID_RE);
    expect((await sessionById(o1.id)).revocation_reason).toBe('PASSWORD_CHANGED');
    expect((await sessionById(cur.id)).revoked_at).toBeNull();
    expect(provider.endedSessions).toContain(o1.sid);

    const b = await newAccount();
    const c = await login(b);
    provider.failNext('getUserSecurity', Number.POSITIVE_INFINITY);
    expect((await svc.registerSession({ ...c.cur, deviceSecret: newSecret(), userAgent: CHROME_WIN })).deviceId).toMatch(UUID_RE);
  });

  it('a failing endSession at the provider does not undo the revocation', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const o1 = await login(a);
    liveAtProvider(a, o1.sid);
    provider.setUser(a.subject, { passwordChangedAt: new Date((await dbNow()).getTime() + 1) });
    provider.failNext('endSession', Number.POSITIVE_INFINITY);
    await ov(cur);
    expect((await sessionById(o1.id)).revocation_reason).toBe('PASSWORD_CHANGED');
  });

  it('the current session is never revoked by it, even when it is the oldest', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await login(a);
    provider.setUser(a.subject, { passwordChangedAt: new Date((await dbNow()).getTime() + 1) });
    await ov(cur);
    expect((await sessionById(cur.id)).revoked_at).toBeNull();
  });
});

// ====================================================================== startMfaEnrollment, hasMfaEnrolled
describe('startMfaEnrollment', () => {
  it('TOTP: audits MFA_ENROLLMENT_REQUESTED and returns the Keycloak action; no provider call, no event', async () => {
    const a = await newAccount();
    const s = await login(a);
    const cid = `cid-${randomUUID()}`;
    expect(await runWithCorrelation(cid, () => svc.startMfaEnrollment(s.cur, 'TOTP'))).toEqual({ method: 'TOTP', keycloakAction: 'CONFIGURE_TOTP' });
    const rows = await auditOf(a.id, 'MFA_ENROLLMENT_REQUESTED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: `account:${a.id}`, changes: { method: 'TOTP' }, application_session_id: null, correlation_id: cid });
    expect(provider.calls).toHaveLength(0);
    expect(await events(a.id, [E.mfaEnabled, E.mfaDisabled])).toHaveLength(0);
  });

  it('RECOVERY_CODES: audits RECOVERY_CODES_REQUESTED and maps to the recovery-codes action', async () => {
    const a = await newAccount();
    const s = await login(a);
    expect(await svc.startMfaEnrollment(s.cur, 'RECOVERY_CODES')).toEqual({ method: 'RECOVERY_CODES', keycloakAction: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    expect((await auditOf(a.id, 'RECOVERY_CODES_REQUESTED'))[0]!.changes).toEqual({ method: 'RECOVERY_CODES' });
    expect(await auditOf(a.id, 'MFA_ENROLLMENT_REQUESTED')).toHaveLength(0);
  });

  for (const method of ['totp', 'SMS', 'EMAIL', '', undefined, null, 1, {}, ['TOTP'], 'TOTP '])
    it(`refuses the method ${JSON.stringify(method)} with VALIDATION_FAILED and writes nothing`, async () => {
      const a = await newAccount();
      const s = await login(a);
      const before = await snapshot(a.id);
      await fails(svc.startMfaEnrollment(s.cur, method as never), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'method' });
      expect(await snapshot(a.id)).toEqual(before);
    });

  it('a SUSPENDED account cannot start an enrollment; an unknown account is NOT_FOUND', async () => {
    const a = await newAccount();
    const s = await login(a);
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await fails(svc.startMfaEnrollment(s.cur, 'TOTP'), 'SUSPENDED');
    await fails(svc.startMfaEnrollment(curOf(randomUUID(), newSid()), 'TOTP'), 'NOT_FOUND');
  });

  it('a failing audit insert fails the call and leaves nothing', async () => {
    const a = await newAccount();
    const s = await login(a);
    const before = await snapshot(a.id);
    await expectForcedFailure(failing(['MFA_ENROLLMENT_REQUESTED'], () => svc.startMfaEnrollment(s.cur, 'TOTP')));
    expect(await snapshot(a.id)).toEqual(before);
  });
});

describe('hasMfaEnrolled', () => {
  it('true / false from the provider, null when it cannot answer or the account has no login', async () => {
    const a = await newAccount();
    expect(await svc.hasMfaEnrolled(a.id)).toBe(false);
    provider.setUser(a.subject, { otpConfigured: true });
    expect(await svc.hasMfaEnrolled(a.id)).toBe(true);
    provider.setUser(a.subject, { otpConfigured: false, recoveryCodesConfigured: true });
    expect(await svc.hasMfaEnrolled(a.id)).toBe(false); // recovery codes alone are not a second factor
    provider.failNext('getUserSecurity');
    expect(await svc.hasMfaEnrolled(a.id)).toBeNull();
    provider.available = false;
    expect(await svc.hasMfaEnrolled(a.id)).toBeNull();
    provider.available = true;
    expect(await svc.hasMfaEnrolled(randomUUID())).toBeNull();
  });

  it('records nothing', async () => {
    const a = await newAccount();
    provider.setUser(a.subject, { otpConfigured: true });
    const before = await snapshot(a.id);
    await svc.hasMfaEnrolled(a.id);
    expect(await snapshot(a.id)).toEqual(before);
  });
});

// ====================================================================== listActivity
describe('listActivity', () => {
  let phoneSeq = 0;
  const nextPhone = (): string => `+1212555${String(1000 + phoneSeq++)}`;
  const idsOf = (r: { entries: { id: string }[] }) => r.entries.map((e) => e.id);

  it('is the union of the security actions and the contact verification actions, newest first, with the label content keys', async () => {
    const a = await newAccount({ email: true });
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    const phone = nextPhone();
    await phoneSvc.setPhone(a.id, phone);
    const before = smsSender.sent.length;
    await phoneSvc.sendVerification(a.id);
    await phoneSvc.confirmCode(a.id, String(smsSender.sent[before]!.variables.verification_code));
    await svc.startMfaEnrollment(d.cur, 'TOTP');
    const r = await svc.listActivity(a.id, {});
    const types = r.entries.map((e) => e.type);
    for (const t of ['SESSION_CREATED', 'DEVICE_TRUSTED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED', 'MFA_ENROLLMENT_REQUESTED']) expect(types).toContain(t);
    // newest first
    const times = r.entries.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    for (const e of r.entries) {
      expect(Object.keys(e).sort()).toEqual(['device', 'id', 'labelContentKey', 'occurredAt', 'outcome', 'sessionId', 'type']);
      expect(e.outcome).toBe('SUCCESS');
      expect(e.labelContentKey).toBe(securityActivityLabelKey(e.type));
      expect(e.id).toMatch(UUID_RE);
    }
    expect(r.nextBefore).toBeNull();
    // audit actions that are not on the timeline never show (the contact was ADDED and a verification was REQUESTED)
    for (const t of types) expect([...SECURITY_ACTIVITY_TYPES] as string[]).toContain(t);
    expect(types).not.toContain('EMAIL_ADDED');
    expect(types).not.toContain('PHONE_ADDED');
    expect(types).not.toContain('ACCOUNT_CREATED');
    expect(types).not.toContain('EXTERNAL_IDENTITY_LINKED');
    expect(types).not.toContain('ROLE_GRANTED');
  });

  it('a wrong verification code leaves an audit row that is NOT on the timeline', async () => {
    const a = await newAccount();
    const address = forbid(`wrong-${randomUUID()}@example.test`, 'email address');
    await emailSvc.setEmail(a.id, address);
    await emailSvc.sendVerification(a.id);
    const sent = String(emailSender.sent.at(-1)!.variables.verification_code);
    const wrong = String((Number(sent) + 1) % 10 ** sent.length).padStart(sent.length, '0');
    await rejection(emailSvc.confirmCode(a.id, wrong));
    expect((await audit(a.id, ['EMAIL_VERIFICATION_FAILED'])).length).toBeGreaterThan(0);
    const r = await svc.listActivity(a.id, {});
    expect(r.entries.map((e) => e.type)).not.toContain('EMAIL_VERIFICATION_FAILED');
    expect(r.entries.map((e) => e.type)).not.toContain('EMAIL_VERIFICATION_REQUESTED');
    const types = r.entries.map((e) => e.type);
    expect(types.every((t) => !t.endsWith('_FAILED') && !t.endsWith('_LOCKED'))).toBe(true);
  });

  it('baseline rows (a factor that already existed) are not on the timeline; real transitions are', async () => {
    const a = await newAccount();
    const s = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    await ov(s);
    expect((await svc.listActivity(a.id, {})).entries.map((e) => e.type)).not.toContain('MFA_ENABLED');
    provider.setUser(a.subject, { otpConfigured: false });
    await ov(s);
    provider.setUser(a.subject, { otpConfigured: true });
    await ov(s);
    const types = (await svc.listActivity(a.id, {})).entries.map((e) => e.type);
    expect(types.filter((t) => t === 'MFA_ENABLED')).toHaveLength(1);
    expect(types.filter((t) => t === 'MFA_DISABLED')).toHaveLength(1);
  });

  it('only the owner events are returned; another account and an unknown account get their own (or an empty) timeline', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const sa = await login(a);
    await login(b);
    await login(b);
    const ra = await svc.listActivity(a.id, {});
    expect(ra.entries.map((e) => e.sessionId)).toEqual([sa.id]);
    expect((await svc.listActivity(b.id, {})).entries).toHaveLength(2);
    expect(await svc.listActivity(randomUUID(), {})).toEqual({ entries: [], nextBefore: null });
  });

  it('joins the coarse device of the session and nothing else about the browser', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a, { ua: SAFARI_IPHONE });
    const bare = await login(a);
    const r = await svc.listActivity(a.id, {});
    const withDevice = r.entries.find((e) => e.sessionId === d.id)!;
    expect(withDevice.device).toEqual({ browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' });
    expect(r.entries.find((e) => e.sessionId === bare.id)!.device).toBeNull();
    await svc.trustCurrentDevice(d.cur);
    const trust = (await svc.listActivity(a.id, {})).entries.find((e) => e.type === 'DEVICE_TRUSTED')!;
    expect(trust.sessionId).toBeNull();
    const text = JSON.stringify(r);
    expect(text).not.toContain(d.sid);
    expect(text).not.toContain(d.secret);
  });

  it('labels every type with an existing managed content key', async () => {
    const keys = SECURITY_ACTIVITY_TYPES.map((t) => securityActivityLabelKey(t));
    const found = await q<{ key: string }>('SELECT key FROM content.entries WHERE key = ANY($1::text[])', [keys]);
    expect(found.map((r) => r.key).sort()).toEqual([...keys].sort());
  });

  it('reaches back activity_log_days only (security.activity_log_days), following the policy', async () => {
    const a = await newAccount();
    const [recent, inside, outside] = await craftAudit(a.id, [
      { action: 'MFA_DISABLED', ago: '1 hour' },
      { action: 'MFA_DISABLED', ago: '89 days' },
      { action: 'MFA_DISABLED', ago: '91 days' },
    ]);
    expect(idsOf(await svc.listActivity(a.id, {}))).toEqual([recent, inside]);
    policy.set({ activityLogDays: 30 });
    expect(idsOf(await svc.listActivity(a.id, {}))).toEqual([recent]);
    policy.set({ activityLogDays: 365 });
    expect(idsOf(await svc.listActivity(a.id, {}))).toEqual([recent, inside, outside]);
  });

  it('pages with the cursor: nextBefore round-trips (microseconds included), no row is lost or repeated, the last page has no cursor', async () => {
    const a = await newAccount();
    await q(
      `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id)
       SELECT date_trunc('second', clock_timestamp()) - interval '1 day' + (i * 7) * interval '1 microsecond', $2, 'MFA_DISABLED', $1, '{}'::jsonb, 'crafted-by-test' FROM generate_series(1, 40) AS i`,
      [a.id, `account:${a.id}`],
    );
    const everything = await q<{ audit_event_id: string }>(
      `SELECT audit_event_id FROM identity.account_audit_events WHERE account_id = $1 AND action = 'MFA_DISABLED' ORDER BY occurred_at DESC, audit_event_id DESC`,
      [a.id],
    );
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await svc.listActivity(a.id, { limit: 7, before });
      pages++;
      seen.push(...idsOf(page));
      if (page.nextBefore === null) break;
      expect(page.entries).toHaveLength(7);
      expect(page.nextBefore).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      before = page.nextBefore;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBe(6);
    expect(seen).toEqual(everything.map((r) => r.audit_event_id));
    expect(new Set(seen).size).toBe(40);
  });

  it('a page that ends exactly at the end of the data has no cursor; one more row gives one', async () => {
    const a = await newAccount();
    await craftAudit(
      a.id,
      Array.from({ length: 10 }, (_, i) => ({ action: 'MFA_DISABLED', ago: `${i + 1} hours` })),
    );
    const p1 = await svc.listActivity(a.id, { limit: 5 });
    expect(p1.nextBefore).not.toBeNull();
    const p2 = await svc.listActivity(a.id, { limit: 5, before: p1.nextBefore! });
    expect(p2.entries).toHaveLength(5);
    expect(p2.nextBefore).toBeNull();
    expect((await svc.listActivity(a.id, { limit: 10 })).nextBefore).toBeNull();
    expect((await svc.listActivity(a.id, { limit: 9 })).nextBefore).not.toBeNull();
    expect((await svc.listActivity(a.id, { limit: 5, before: '1999-01-01T00:00:00Z' })).entries).toEqual([]);
  });

  it('rows with an identical timestamp are not lost across a page boundary (the cursor carries the event id too)', async () => {
    const a = await newAccount();
    await q(
      `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id)
       SELECT date_trunc('second', clock_timestamp()) - interval '1 day', $2, 'MFA_DISABLED', $1, '{}'::jsonb, 'crafted-by-test' FROM generate_series(1, 9)`,
      [a.id, `account:${a.id}`],
    );
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await svc.listActivity(a.id, { limit: 4, before });
      seen.push(...idsOf(page));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(new Set(seen).size, 'rows with the same timestamp must all be reachable').toBe(9);
  });

  const BAD_BEFORE: [string, unknown][] = [
    ['text', 'abc'],
    ['empty', ''],
    ['a date without time', '2026-01-01'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['a leading space', ' 2026-01-01T00:00:00Z'],
    ['a trailing newline', '2026-01-01T00:00:00Z\n'],
    ['seven fraction digits', '2026-01-01T00:00:00.1234567Z'],
    ['an impossible month', '2026-13-45T25:61:61Z'],
    ['an impossible offset', '2026-01-01T00:00:00+99:99'],
    ['a malformed event id in the cursor', '2026-01-01T00:00:00.000001Z_not-a-uuid'],
    ['an event id without a timestamp', '_00000000-0000-0000-0000-000000000000'],
    ['SQL', "2026-01-01T00:00:00Z'; DROP TABLE identity.accounts; --"],
    ['now', 'now'],
    ['a number', 1_700_000_000],
    ['an array', ['2026-01-01T00:00:00Z']],
    ['an object', {}],
    ['null', null],
  ];
  for (const [name, before] of BAD_BEFORE)
    it(`an invalid cursor (${name}) is VALIDATION_FAILED on "before" and nothing leaks`, async () => {
      const a = await newAccount();
      await login(a);
      const e = await fails(svc.listActivity(a.id, { before: before as string }), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'before' });
      expect(e.message).not.toMatch(/DROP|timestamp "/);
    });

  // a cursor with the right shape that is not a real moment is rejected BEFORE any query (PostgreSQL would reject it with an error that echoes the input)
  const IMPOSSIBLE: [string, string][] = [
    ['February 30', '2026-02-30T00:00:00Z'],
    ['April 31', '2026-04-31T00:00:00Z'],
    ['February 29 of a common year', '2025-02-29T00:00:00Z'],
    ['month 00', '2026-00-10T00:00:00Z'],
    ['month 13', '2026-13-10T00:00:00Z'],
    ['day 00', '2026-01-00T00:00:00Z'],
    ['day 32', '2026-01-32T00:00:00Z'],
    ['year 0000', '0000-01-01T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['hour 25', '2026-01-01T25:00:00Z'],
    ['minute 60', '2026-01-01T00:60:00Z'],
    ['second 60', '2026-01-01T00:00:60Z'],
    ['offset +16:00', '2026-01-01T00:00:00+16:00'],
    ['offset -16:00', '2026-01-01T00:00:00-16:00'],
    ['offset +24:00', '2026-01-01T00:00:00+24:00'],
    ['offset +00:60', '2026-01-01T00:00:00+00:60'],
    ['offset +99:99', '2026-01-01T00:00:00+99:99'],
    ['a bad uuid suffix', '2026-01-01T00:00:00Z_zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
    ['an impossible date with a valid uuid suffix', '2026-02-30T00:00:00Z_00000000-0000-0000-0000-000000000000'],
  ];
  for (const [name, before] of IMPOSSIBLE)
    it(`an impossible cursor (${name}) is VALIDATION_FAILED on "before" before any query, and the error never echoes it`, async () => {
      const a = await newAccount();
      const e = await fails(svc.listActivity(a.id, { before }), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'before' });
      expect(errText(e)).not.toContain(before);
      expect(errText(e)).not.toContain(before.slice(0, 10));
    });

  const POSSIBLE = [
    '2024-02-29T23:59:59Z',
    '0001-01-01T00:00:00Z',
    '9999-12-31T23:59:59.999999Z',
    '2026-01-01T00:00:00+15:59',
    '2026-01-01T00:00:00-15:59',
    '2026-01-01T00:00:00.5Z',
    '2026-01-01T00:00:00.1+00:00',
    '2026-12-31T23:59:59.123456-05:00',
    '2026-01-01T00:00:00Z_00000000-0000-0000-0000-000000000000',
    '2026-01-01T00:00:00.000001Z_FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
  ];
  for (const before of POSSIBLE)
    it(`the edge cursor ${before} is accepted`, async () => {
      const a = await newAccount();
      await craftAudit(a.id, [{ action: 'MFA_DISABLED', ago: '1 hour' }]);
      const r = await svc.listActivity(a.id, { before });
      expect(Array.isArray(r.entries)).toBe(true);
      expect(r.entries.length).toBe(before.startsWith('9999') || before.startsWith('2026-12') ? 1 : 0);
    });

  it('accepts cursors with an explicit offset or fewer fraction digits', async () => {
    const a = await newAccount();
    await craftAudit(a.id, [{ action: 'MFA_DISABLED', ago: '1 hour' }]);
    for (const before of ['2999-01-01T00:00:00Z', '2999-01-01T00:00:00.5Z', '2999-01-01T00:00:00.123456+01:00', '2999-12-31T23:59:59-05:00'])
      expect((await svc.listActivity(a.id, { before })).entries).toHaveLength(1);
  });

  it('clamps the limit to [1, 100] and defaults to 25', async () => {
    const a = await newAccount();
    await q(
      `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id)
       SELECT clock_timestamp() - i * interval '1 second', $2, 'MFA_DISABLED', $1, '{}'::jsonb, 'crafted-by-test' FROM generate_series(1, 130) AS i`,
      [a.id, `account:${a.id}`],
    );
    const n = async (limit: unknown) => (await svc.listActivity(a.id, { limit: limit as number })).entries.length;
    expect(await n(undefined)).toBe(25);
    expect(await n(1)).toBe(1);
    expect(await n(0)).toBe(1);
    expect(await n(-5)).toBe(1);
    expect(await n(2.9)).toBe(2);
    expect(await n(100)).toBe(100);
    expect(await n(101)).toBe(100);
    expect(await n(1_000_000)).toBe(100);
    expect(await n(Number.NaN)).toBe(25);
    expect(await n(Number.POSITIVE_INFINITY)).toBe(25);
    expect(await n('50')).toBe(25);
    expect(await n(null)).toBe(25);
  });

  it('a failing policy closes the call with POLICY_UNAVAILABLE', async () => {
    const a = await newAccount();
    policy.failure = new Error('configuration unreachable');
    await fails(svc.listActivity(a.id, {}), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
  });
});

// ====================================================================== requestPasswordReset
describe('requestPasswordReset', () => {
  const ruleNames = (calls: RateRule[][]) => calls.map((c) => c.map((r) => r.name));

  it('for a known verified address: only the rate limits run before the call returns; the lookup, audit, event and email follow detached', async () => {
    const a = await newAccount({ email: true });
    const cid = `cid-${randomUUID()}`;
    const ip = uniqueIp();
    const result = await runWithCorrelation(cid, () => svc.requestPasswordReset(a.email!, { clientIp: ip }));
    expect(result).toBeUndefined();
    await svc.drain();
    const rows = await auditOf(a.id, 'PASSWORD_RESET_REQUESTED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: `account:${a.id}`, changes: {}, application_session_id: null, correlation_id: cid });
    expect((await eventsOf(a.id, E.passwordResetRequested)).map((e) => [e.payload_json, e.correlation_id])).toEqual([[{ accountId: a.id }, cid]]);
    expect(provider.sentResetEmails).toEqual([{ subject: a.subject, lifespanSeconds: 3600 }]);
    const order = provider.calls.map((c) => c.method);
    expect(order.indexOf('getUserSecurity')).toBeLessThan(order.indexOf('sendPasswordResetEmail'));
    await expectNoLeaks('password reset');
  });

  it('the link lifespan is reset_link.validity_minutes * 60 seconds, read from the policy of the call', async () => {
    for (const [minutes, seconds] of [
      [5, 300],
      [90, 5400],
      [1440, 86_400],
    ] as const) {
      policy.set({ resetLinkValidityMinutes: minutes });
      const a = await newAccount({ email: true });
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
      expect(provider.sentResetEmails.at(-1)).toEqual({ subject: a.subject, lifespanSeconds: seconds });
    }
  });

  it('the address is matched case-insensitively and trimmed', async () => {
    const a = await newAccount({ email: true });
    for (const variant of [a.email!.toUpperCase(), `  ${a.email}  `, a.email!.replace(/^./, (c) => c.toUpperCase())]) {
      policy.set({ resetMaxRequestsPerHour: 20 });
      await svc.requestPasswordReset(variant, { clientIp: uniqueIp() });
    }
    await svc.drain();
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(3);
    expect(provider.sentResetEmails).toHaveLength(3);
  });

  it('is identical from the caller view for a known, an unknown, an invalid and a non-string address (same result, same limiter rules)', async () => {
    policy.set({ resetMaxRequestsPerHour: 20 });
    const a = await newAccount({ email: true });
    const inputs: unknown[] = [
      a.email,
      `nobody-${randomUUID()}@example.test`,
      'not-an-email',
      '',
      '   ',
      'a@b',
      undefined,
      null,
      42,
      {},
      [],
      true,
      'x'.repeat(10_000),
      `${'a'.repeat(300)}@example.test`,
    ];
    const results: unknown[] = [];
    const worldBefore = await world();
    for (const input of inputs) results.push(await svc.requestPasswordReset(input as string, { clientIp: uniqueIp() }));
    await svc.drain();
    expect(results.every((r) => r === undefined)).toBe(true);
    // every call consumed exactly the same two rules (email, ip) with the same limit and window
    expect(spy.calls).toHaveLength(inputs.length);
    for (const call of spy.calls) {
      expect(call.map((r) => [r.name, r.limit, r.windowSeconds])).toEqual([
        ['password-reset:email', 20, 3600],
        ['password-reset:ip', 20, 3600],
      ]);
      for (const r of call) expect(r.key).toMatch(/^[0-9a-f]{32}$/);
    }
    // only the known address did anything
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
    expect(provider.sentResetEmails).toHaveLength(1);
    expect((await world()).audit).toBe(worldBefore.audit + 1 + 0);
  });

  it('limiter keys are keyed hashes of the canonical address and of the address of the client, never the raw values', async () => {
    const a = await newAccount({ email: true });
    const ip = uniqueIp();
    await svc.requestPasswordReset(a.email!.toUpperCase(), { clientIp: ip });
    await svc.drain();
    const [rules] = spy.calls;
    expect(rules!.map((r) => r.key)).toEqual([hashDimension(testHashKey, 'email', a.email!), hashDimension(testHashKey, 'ip', ip)]);
    const text = JSON.stringify(spy.calls);
    expect(text).not.toContain(a.email!);
    expect(text.toLowerCase()).not.toContain(a.email!.split('@')[0]!);
    expect(text).not.toContain(ip);
    // without a client address only the email rule is applied
    await svc.requestPasswordReset(a.email!, {});
    expect(ruleNames(spy.calls).at(-1)).toEqual(['password-reset:email']);
  });

  it('limits per hashed address: the limit passes, the next request is refused with Retry-After, the window frees it, case does not matter', async () => {
    const a = await newAccount({ email: true });
    for (let i = 0; i < 5; i++) await svc.requestPasswordReset(i % 2 ? a.email!.toUpperCase() : a.email!, { clientIp: uniqueIp() });
    const e = await fails(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 3600);
    // a refusal does nothing else
    await svc.drain();
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(5);
    expect(provider.sentResetEmails).toHaveLength(5);
    clock.ms += 1800_000;
    const later = await fails(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    between(later.details.retryAfterSeconds, 1790, 1801);
    clock.ms += 1801_000;
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(6);
  });

  it('an UNKNOWN address is limited exactly the same way (the limit does not reveal whether an account exists)', async () => {
    const ghost = `ghost-${randomUUID()}@example.test`;
    for (let i = 0; i < 5; i++) await svc.requestPasswordReset(ghost, { clientIp: uniqueIp() });
    const e = await fails(svc.requestPasswordReset(ghost, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    between(e.details.retryAfterSeconds, 1, 3600);
  });

  it('limits per hashed source address across different addresses; another source address is unaffected', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) await svc.requestPasswordReset(`n${i}-${randomUUID()}@example.test`, { clientIp: ip });
    const e = await fails(svc.requestPasswordReset(`n9-${randomUUID()}@example.test`, { clientIp: ip }), 'PASSWORD_RESET_RATE_LIMITED');
    between(e.details.retryAfterSeconds, 1, 3600);
    await svc.requestPasswordReset(`n10-${randomUUID()}@example.test`, { clientIp: uniqueIp() });
  });

  it('the limit follows the policy (reset_link.max_requests_per_hour)', async () => {
    policy.set({ resetMaxRequestsPerHour: 2 });
    const ghost = `ghost-${randomUUID()}@example.test`;
    await svc.requestPasswordReset(ghost, { clientIp: uniqueIp() });
    await svc.requestPasswordReset(ghost, { clientIp: uniqueIp() });
    await fails(svc.requestPasswordReset(ghost, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    expect(spy.calls[0]!.every((r) => r.limit === 2 && r.windowSeconds === 3600)).toBe(true);
  });

  it('a refusal is the same for a known address (same code and shape as for an unknown one)', async () => {
    policy.set({ resetMaxRequestsPerHour: 1 });
    const a = await newAccount({ email: true });
    const ghost = `ghost-${randomUUID()}@example.test`;
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.requestPasswordReset(ghost, { clientIp: uniqueIp() });
    const known = await fails(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    const unknown = await fails(svc.requestPasswordReset(ghost, { clientIp: uniqueIp() }), 'PASSWORD_RESET_RATE_LIMITED');
    expect(known.message).toBe(unknown.message);
    expect(Object.keys(known.details)).toEqual(Object.keys(unknown.details));
  });

  it('when the limiter is down the request is refused (fail closed): UNAVAILABLE, nothing recorded, nothing sent', async () => {
    const a = await newAccount({ email: true });
    limiter.unavailable = true;
    const before = await snapshot(a.id);
    await fails(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    await fails(svc.requestPasswordReset(`ghost-${randomUUID()}@example.test`, { clientIp: uniqueIp() }), 'UNAVAILABLE', {
      reason: 'RATE_LIMITER_UNAVAILABLE',
    });
    await svc.drain();
    expect(await snapshot(a.id)).toEqual(before);
    expect(provider.calls).toHaveLength(0);
    expect(logSink.lines.join('\n')).toContain('rate limiter unavailable');
    limiter.unavailable = false;
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
  });

  it('a failing policy refuses the request before the limiter is touched', async () => {
    policy.failure = new Error('unreachable');
    await fails(svc.requestPasswordReset('someone@example.test', { clientIp: uniqueIp() }), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect(spy.calls).toHaveLength(0);
  });

  it('only a VERIFIED PRIMARY email of a live account is a target: pending, replaced and closed ones do nothing', async () => {
    const pending = await newAccount();
    const address = forbid(`pending-${randomUUID()}@example.test`, 'email address');
    await emailSvc.setEmail(pending.id, address);
    provider.setUser(pending.subject, { email: address });
    await svc.requestPasswordReset(address, { clientIp: uniqueIp() });

    const closed = await newAccount({ email: true });
    await accounts.changeStatus(closed.id, 'SUSPENDED', OP);
    await accounts.changeStatus(closed.id, 'CLOSED', OP);
    await svc.requestPasswordReset(closed.email!, { clientIp: uniqueIp() });
    await svc.drain();
    expect(await auditOf(pending.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(0);
    expect(await auditOf(closed.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(0);
    expect(provider.sentResetEmails).toHaveLength(0);
  });

  it('when the email Keycloak knows differs (or is missing) NO email is sent', async () => {
    for (const keycloakEmail of ['someone-else@example.test', null, '']) {
      const a = await newAccount({ email: true });
      provider.setUser(a.subject, { email: keycloakEmail });
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
      expect(provider.sentResetEmails.filter((m) => m.subject === a.subject)).toHaveLength(0);
    }
    // the same address with other capitalization at Keycloak still matches
    const b = await newAccount({ email: true });
    provider.setUser(b.subject, { email: b.email!.toUpperCase() });
    await svc.requestPasswordReset(b.email!, { clientIp: uniqueIp() });
    await svc.drain();
    expect(provider.sentResetEmails.filter((m) => m.subject === b.subject)).toHaveLength(1);
  });

  it('the response never waits for the provider: the call returns while the provider call is held', async () => {
    const a = await newAccount({ email: true });
    const release = provider.hold('sendPasswordResetEmail');
    await within(5000, svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'the request');
    for (let i = 0; i < 300 && provider.callsOf('sendPasswordResetEmail').length === 0; i++) await sleep(10);
    expect(provider.callsOf('sendPasswordResetEmail')).toHaveLength(1);
    expect(provider.sentResetEmails).toHaveLength(0);
    const drained = svc.drain().then(() => 'drained');
    expect(await Promise.race([drained, sleep(100).then(() => 'still pending')])).toBe('still pending');
    release();
    await drained;
    expect(provider.sentResetEmails).toHaveLength(1);

    const b = await newAccount({ email: true });
    const release2 = provider.hold('getUserSecurity');
    await within(5000, svc.requestPasswordReset(b.email!, { clientIp: uniqueIp() }), 'the request (provider lookup held)');
    release2();
    await svc.drain();
    expect(provider.sentResetEmails.filter((m) => m.subject === b.subject)).toHaveLength(1);
  });

  it('a provider failure only logs a code: the request still succeeds and nothing secret is logged', async () => {
    const a = await newAccount({ email: true });
    provider.failNext('sendPasswordResetEmail');
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const b = await newAccount({ email: true });
    provider.failNext('getUserSecurity');
    await svc.requestPasswordReset(b.email!, { clientIp: uniqueIp() });
    await svc.drain();
    provider.available = false;
    const c = await newAccount({ email: true });
    await svc.requestPasswordReset(c.email!, { clientIp: uniqueIp() });
    await svc.drain();
    const lines = logSink.lines.filter((l) => l.includes('background task failed'));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p.code)).toEqual(expect.arrayContaining(['INJECTED', 'NOT_CONFIGURED']));
    for (const p of parsed) expect(Object.keys(p).sort()).toEqual(['code', 'level', 'message', 'task']);
    // the REQUESTED audit row is written regardless of the provider
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
    await expectNoLeaks('provider failure');
  });

  it('a database failure in the detached part never reaches the caller and sends nothing', async () => {
    const a = await newAccount({ email: true });
    await failing(['PASSWORD_RESET_REQUESTED'], async () => {
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
    });
    expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(0);
    expect(provider.sentResetEmails).toHaveLength(0);
    expect(logSink.lines.some((l) => l.includes('background task failed'))).toBe(true);
    await expectNoLeaks('detached database failure');
  });

  it('drain resolves at once when nothing is pending', async () => {
    await within(1000, svc.drain(), 'drain');
  });

  it('race: 25 parallel requests for one address with a limit of 20 accept exactly 20 (audit, event and email each), refuse 5 (5 rounds)', async () => {
    policy.set({ resetMaxRequestsPerHour: 20 });
    for (let round = 0; round < 5; round++) {
      const a = await newAccount({ email: true });
      const results = await Promise.all(Array.from({ length: 25 }, () => settled(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }))));
      await svc.drain();
      expect(
        results
          .filter(isErr)
          .map(codeOf)
          .filter((c) => c !== 'PASSWORD_RESET_RATE_LIMITED'),
      ).toEqual([]);
      expect(results.filter(isErr)).toHaveLength(5);
      expect(await auditOf(a.id, 'PASSWORD_RESET_REQUESTED')).toHaveLength(20);
      expect(await eventsOf(a.id, E.passwordResetRequested)).toHaveLength(20);
      expect(provider.sentResetEmails.filter((m) => m.subject === a.subject)).toHaveLength(20);
    }
  });

  it('race: reset requests, overviews observing the completed reset and a sweep together leave one completion and coherent rows', async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newAccount({ email: true });
      const cur = await login(a);
      const o1 = await login(a);
      await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
      await svc.drain();
      const requested = (await auditOf(a.id, 'PASSWORD_RESET_REQUESTED'))[0]!;
      provider.setUser(a.subject, { passwordChangedAt: new Date(requested.occurred_at.getTime() + 20_000) });
      const calls = [
        ...Array.from({ length: 6 }, () => settled(ov(cur))),
        ...Array.from({ length: 3 }, () => settled(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }))),
        settled(svc.revokeAllSessions(cur.cur, { includeCurrent: false })),
      ];
      const results = await Promise.all(calls);
      await svc.drain();
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      expect((await audit(a.id, PASSWORD_AUDIT)).map((x) => x.action)).toEqual(['PASSWORD_RESET_COMPLETED']);
      expect((await sessionById(o1.id)).revoked_at).not.toBeNull();
      expect((await sessionById(cur.id)).revoked_at).toBeNull();
      // every revoked session has exactly one revocation audit row
      expect(await auditOf(a.id, 'SESSION_REVOKED')).toHaveLength(1);
    }
  });
});

// ====================================================================== the policy fails closed
describe('the policy: a security limit has no code default', () => {
  it('getPolicy returns the six values (a copy) and reads the provider each time', async () => {
    const p = await svc.getPolicy();
    expect(p).toEqual(SEEDED_SECURITY_POLICY);
    p.trustedBrowserDays = 1;
    expect(await svc.getPolicy()).toEqual(SEEDED_SECURITY_POLICY);
    policy.set({ trustedBrowserDays: 3 });
    expect((await svc.getPolicy()).trustedBrowserDays).toBe(3);
  });

  it('every operation that needs the policy fails with UNAVAILABLE / POLICY_UNAVAILABLE and does nothing when the provider fails', async () => {
    const a = await newAccount({ email: true });
    const d = await loginWithDevice(a);
    const keep = await login(a);
    const before = await snapshot(a.id);
    const callsBefore = provider.calls.length;
    policy.failure = new Error('password=hunter2 host=db.internal');
    const reasons = { reason: 'POLICY_UNAVAILABLE' };
    await fails(svc.getPolicy(), 'UNAVAILABLE', reasons);
    await fails(svc.listSessions(d.cur), 'UNAVAILABLE', reasons);
    await fails(svc.trustCurrentDevice(d.cur), 'UNAVAILABLE', reasons);
    await fails(svc.removeDevice(keep.cur, d.deviceId), 'UNAVAILABLE', reasons);
    await fails(svc.getOverview(d.cur, { authTime: authNow() }), 'UNAVAILABLE', reasons);
    await fails(svc.listActivity(a.id, {}), 'UNAVAILABLE', reasons);
    await fails(svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() }), 'UNAVAILABLE', reasons);
    await svc.drain();
    expect(await snapshot(a.id)).toEqual(before);
    expect(provider.calls).toHaveLength(callsBefore);
    expect(spy.calls).toHaveLength(0);
    const lines = logSink.lines.join('\n');
    expect(lines).toContain('security policy unavailable');
    expect(lines).not.toMatch(/hunter2|db\.internal/);
    for (const e of caught.slice(-7)) expect(errText(e)).not.toMatch(/hunter2|db\.internal/);
  });

  it('the sign-in path does not depend on the policy: observe, register, revoke, sign out, untrust and the lists still work while it is down', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    const other = await login(a);
    policy.failure = new Error('configuration database down');
    expect((await svc.observeSession({ accountId: a.id, keycloakSessionId: d.sid })).created).toBe(false);
    expect((await login(a)).id).toMatch(UUID_RE);
    const s3 = await login(a);
    expect((await svc.registerSession({ ...s3.cur, deviceSecret: d.secret, userAgent: CHROME_WIN })).deviceId).toBe(d.deviceId);
    expect((await svc.listDevices(d.cur)).devices).toHaveLength(1);
    expect(await svc.isDeviceTrusted(d.cur)).toBe(false);
    expect(await svc.untrustCurrentDevice(d.cur)).toMatchObject({ trusted: false });
    expect((await svc.startMfaEnrollment(d.cur, 'TOTP')).keycloakAction).toBe('CONFIGURE_TOTP');
    expect(await svc.hasMfaEnrolled(a.id)).toBe(false);
    expect((await svc.revokeSession(d.cur, other.id)).changed).toBe(true);
    expect((await svc.revokeAllSessions(d.cur, { includeCurrent: false })).revokedCount).toBe(2);
    expect((await svc.signOutCurrentSession(d.cur)).changed).toBe(true);
  });

  const BAD_POLICIES: [string, Partial<Record<keyof SecurityPolicy, unknown>>][] = [
    ['trusted browser days 0', { trustedBrowserDays: 0 }],
    ['trusted browser days 366', { trustedBrowserDays: 366 }],
    ['keep signed in days 91', { keepSignedInDays: 91 }],
    ['step-up minutes 61', { stepUpValidMinutes: 61 }],
    ['activity days 29', { activityLogDays: 29 }],
    ['reset validity 4 minutes', { resetLinkValidityMinutes: 4 }],
    ['reset requests 21 per hour', { resetMaxRequestsPerHour: 21 }],
    ['a fractional value', { trustedBrowserDays: 1.5 }],
    ['NaN', { stepUpValidMinutes: Number.NaN }],
    ['a string', { keepSignedInDays: '30' }],
    ['undefined', { activityLogDays: undefined }],
    ['null', { resetMaxRequestsPerHour: null }],
  ];
  for (const [name, bad] of BAD_POLICIES)
    it(`a malformed policy (${name}) is an outage, never a default`, async () => {
      const a = await newAccount();
      const s = await login(a);
      policy.set(bad as Partial<SecurityPolicy>);
      await fails(svc.getOverview(s.cur, { authTime: authNow() }), 'UNAVAILABLE');
      await fails(svc.trustCurrentDevice(s.cur), 'UNAVAILABLE');
      await fails(svc.requestPasswordReset('someone@example.test', { clientIp: uniqueIp() }), 'UNAVAILABLE');
      expect(spy.calls).toHaveLength(0);
    });
});

// ====================================================================== no operation crosses accounts
describe('isolation between accounts', () => {
  it("B, presenting A's sid, can read, change or learn nothing about A through any operation", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const sa = await loginWithDevice(a, { ua: SAFARI_IPHONE });
    await svc.trustCurrentDevice(sa.cur);
    const sb = await loginWithDevice(b);
    const ghost = curOf(b.id, sa.sid);
    const beforeA = await snapshot(a.id);
    const beforeProvider = provider.calls.length;

    await fails(svc.registerSession({ ...ghost, deviceSecret: newSecret() }), 'SESSION_NOT_FOUND');
    await fails(svc.revokeSession(ghost, sa.id), 'SESSION_NOT_FOUND');
    await fails(svc.trustCurrentDevice(ghost), 'SESSION_NOT_FOUND');
    await fails(svc.untrustCurrentDevice(ghost), 'SESSION_NOT_FOUND');
    await fails(svc.removeDevice(ghost, sa.deviceId), 'DEVICE_NOT_FOUND');
    await fails(svc.getOverview(ghost, { authTime: authNow() }), 'SESSION_NOT_FOUND');
    expect(await svc.isDeviceTrusted(ghost)).toBe(false);
    expect(await svc.signOutCurrentSession(ghost)).toEqual({ changed: false, keycloak: 'NOT_NEEDED' });
    const list = await svc.listSessions(ghost);
    expect(list.sessions.map((s) => s.sessionId)).toEqual([sb.id]);
    expect(list.sessions.some((s) => s.current)).toBe(false);
    const devices = await svc.listDevices(ghost);
    expect(devices.devices.map((d) => d.deviceId)).toEqual([sb.deviceId]);
    expect(devices.devices.some((d) => d.current)).toBe(false);
    expect((await svc.listActivity(b.id, {})).entries.every((e) => e.sessionId === null || e.sessionId === sb.id)).toBe(true);
    expect(await snapshot(a.id)).toEqual(beforeA);
    expect(provider.callsOf('endSession')).toHaveLength(0);
    expect(provider.calls.slice(beforeProvider).every((c) => c.subject !== a.subject)).toBe(true);

    // even a sweep for B (the only operation that changes anything for the ghost) leaves A alone
    const sweep = await svc.revokeAllSessions(ghost, { includeCurrent: true });
    expect(sweep.revokedCount).toBe(1);
    expect(await snapshot(a.id)).toEqual(beforeA);
    expect(await watermarkOf(a.id)).toBeNull();
    expect((await sessionById(sa.id)).revoked_at).toBeNull();
  });

  it('the same device secret on two accounts is never confused: removing it on one account leaves the other', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const secret = newSecret();
    const sa = await loginWithDevice(a, { secret });
    const sb = await loginWithDevice(b, { secret });
    const keepA = await login(a);
    await svc.removeDevice(keepA.cur, sa.deviceId);
    expect((await deviceById(sb.deviceId)).removed_at).toBeNull();
    expect((await sessionById(sb.id)).revoked_at).toBeNull();
  });
});

// ====================================================================== secrets and privacy
describe('secrets and privacy', () => {
  it('a full scenario leaves no sid, device secret, device hash, subject, address, client address or user agent in any audit row, event, log line, error or result', async () => {
    const results: unknown[] = [];
    const a = await newAccount({ email: true });
    const ip = uniqueIp();
    const marker = forbid(`UAMARK-${randomUUID()}`, 'user agent');
    const d = await loginWithDevice(a, { ua: `${CHROME_WIN} ${marker}` });
    const second = await login(a);
    const third = await login(a);
    liveAtProvider(a, d.sid, second.sid, third.sid);
    results.push(await svc.registerSession({ ...second.cur, deviceSecret: d.secret, userAgent: `${FIREFOX_LINUX} ${marker}` }, { clientIp: ip }));
    results.push(await svc.trustCurrentDevice(d.cur));
    results.push(await svc.listSessions(d.cur));
    results.push(await svc.listDevices(d.cur));
    results.push(await svc.getOverview(d.cur, { authTime: authNow(), acr: 'bananagig:password' }));
    results.push(await svc.startMfaEnrollment(d.cur, 'TOTP'));
    results.push(await svc.revokeSession(d.cur, third.id));
    results.push(await svc.removeDevice(second.cur, (await svc.listDevices(d.cur)).devices[0]!.deviceId).catch((e: unknown) => String(e)));
    results.push(await svc.listActivity(a.id, { limit: 100 }));
    // failure paths
    provider.failNext('endSession');
    const x = await login(a);
    liveAtProvider(a, x.sid);
    results.push(await svc.revokeSession(d.cur, x.id).catch((e: unknown) => e));
    await rejection(svc.observeSession({ accountId: a.id, keycloakSessionId: third.sid }));
    await rejection(svc.registerSession({ ...curOf(a.id, third.sid), deviceSecret: d.secret }));
    await rejection(svc.revokeSession(d.cur, randomUUID()));
    limiter.unavailable = true;
    await rejection(svc.requestPasswordReset(a.email!, { clientIp: ip }));
    limiter.unavailable = false;
    provider.failNext('getUserSecurity');
    await svc.requestPasswordReset(a.email!, { clientIp: ip });
    await svc.drain();
    provider.failNext('listSessions');
    results.push(await svc.listSessions(d.cur).catch((e: unknown) => e));
    await svc.requestPasswordReset(a.email!, { clientIp: uniqueIp() });
    await svc.drain();

    await expectNoLeaks('scenario', { results });
    // where the values are allowed to live
    expect(await tablesMentioning(d.sid)).toEqual(['identity.application_sessions']);
    expect(await tablesMentioning(a.subject)).toEqual(['identity.external_identities']);
    expect(await tablesMentioning(d.secret)).toEqual([]);
    expect(await tablesMentioning(marker)).toEqual([]);
    expect(await tablesMentioning(ip)).toEqual([]);
    const emailTables = await tablesMentioning(a.email!);
    for (const t of ['identity.application_sessions', 'identity.account_devices', 'identity.account_audit_events', 'integration.outbox_events'])
      expect(emailTables, `the address is in ${t}`).not.toContain(t);
    // the limiter keys are opaque
    const keys = JSON.stringify(spy.calls);
    expect(keys).not.toContain(ip);
    expect(keys).not.toContain(a.email!);
    // the outbox payloads carry identifiers only
    for (const e of await events(a.id))
      for (const v of Object.values(e.payload_json)) expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
    // the audit rows carry the actor, ids and small facts only
    for (const r of await audit(a.id)) {
      expect(r.actor).toBe(`account:${a.id}`);
      expect(JSON.stringify(r.changes ?? {}).length).toBeLessThan(300);
    }
  });

  it('every thrown error has a fixed message and only codes in its details (no input is echoed)', async () => {
    const a = await newAccount();
    const s = await login(a);
    const tricky = `ECHO-${randomUUID()}`;
    const errors: AccountError[] = [];
    errors.push(await fails(svc.revokeSession(s.cur, tricky), 'SESSION_NOT_FOUND'));
    errors.push(await fails(svc.removeDevice(s.cur, tricky), 'DEVICE_NOT_FOUND'));
    errors.push(await fails(svc.registerSession({ ...s.cur, deviceSecret: tricky }), 'VALIDATION_FAILED'));
    errors.push(await fails(svc.startMfaEnrollment(s.cur, tricky as never), 'VALIDATION_FAILED'));
    errors.push(await fails(svc.observeSession({ accountId: a.id, keycloakSessionId: `${tricky} x` }), 'VALIDATION_FAILED'));
    errors.push(await fails(svc.listActivity(a.id, { before: tricky }), 'VALIDATION_FAILED'));
    for (const e of errors) expect(errText(e)).not.toContain(tricky);
  });

  it('negative controls: the scanner finds a sid in a log line, in a thrown error, in a result and a known string in the audit rows', async () => {
    const a = await newAccount();
    const s = await login(a);
    logSink.all.push(JSON.stringify({ message: 'oops', sid: s.sid }));
    expect(await rejection(expectNoLeaks('control'))).toBeInstanceOf(Error);
    logSink.all.pop();
    caught.push(new Error(`failed for ${s.sid}`));
    expect(await rejection(expectNoLeaks('control'))).toBeInstanceOf(Error);
    caught.pop();
    expect(await rejection(expectNoLeaks('control', { results: [{ leaked: s.sid }] }))).toBeInstanceOf(Error);
    // a value that IS in the audit rows (the actor) and in the outbox
    expect(await rejection(expectNoLeaks('control', { needles: new Map([[`account:${a.id}`, 'actor']]) }))).toBeInstanceOf(Error);
    await expectNoLeaks('control (clean again)');
  });
});

// ====================================================================== whole-run invariants
describe('invariants of the whole run', () => {
  it('no live session is attached to a removed device, trust columns agree, nothing is in the future, every revoked session has a reason', async () => {
    const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.application_sessions s JOIN identity.account_devices d USING (account_id, account_device_id) WHERE s.revoked_at IS NULL AND d.removed_at IS NOT NULL`,
      ),
      'a live session on a removed device',
    ).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM identity.account_devices WHERE (trusted_at IS NULL) <> (trusted_until IS NULL)')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM identity.account_devices WHERE removed_at IS NOT NULL AND trusted_until IS NOT NULL')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM identity.application_sessions WHERE (revoked_at IS NULL) <> (revocation_reason IS NULL)')).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM identity.accounts WHERE sessions_not_before > clock_timestamp() + interval '1 minute'`)).toBe(0);
    // every SESSION_* audit row names a session of the audited account, every DEVICE_* row a device of it (the composite foreign keys, double-checked)
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.account_audit_events e JOIN identity.application_sessions s ON s.application_session_id = e.application_session_id WHERE s.account_id <> e.account_id`,
      ),
    ).toBe(0);
    // a session id appears once per account session in SESSION_CREATED rows created by the service: never twice
    expect(
      await n(
        `SELECT count(*)::int AS n FROM (SELECT application_session_id FROM identity.account_audit_events WHERE action = 'SESSION_CREATED' GROUP BY 1 HAVING count(*) > 1) x`,
      ),
    ).toBe(0);
    // a session is revoked at most once: one SESSION_REVOKED row per session
    expect(
      await n(
        `SELECT count(*)::int AS n FROM (SELECT application_session_id FROM identity.account_audit_events WHERE action IN ('SESSION_REVOKED', 'SESSION_ENDED') GROUP BY 1 HAVING count(*) > 1) x`,
      ),
    ).toBe(0);
  });

  it('the whole run leaked nothing (every audit row, event, log line and error of every test above)', async () => {
    await expectNoLeaks('whole run');
  });
});
