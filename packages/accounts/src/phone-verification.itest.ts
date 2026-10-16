// Integration tests of the phone contact and its SMS verification (ID-003): the real AccountService and PhoneVerificationService over a real, freshly migrated
// PostgreSQL database, the real transactional outbox, the RecordingSmsSender (the code is read back from the SMS variables, exactly as the person reads it from the
// text), the FakePhoneIntelligence, a fake country directory and the MemoryRateLimiter with an injectable clock. The limits are a mutable fake policy seeded with the
// PRD values; it records which country it was asked for. Every behaviour is asserted against the rows it leaves: contacts, challenges, audit and outbox events.
//
// Time: the DATABASE clock decides expiry, cooldown and the hourly and daily caps. Expiry is tested with challenge rows crafted by SQL (past created_at and
// expires_at, hashes computed with the production function); the cooldown and the caps by changing the fake policy. Races are real (parallel service calls) or
// deterministic (calls queued behind a held account row lock, so their order is fixed).
//
// Structure: the scenarios of the email verification (email-verification.itest.ts) are mirrored for the phone (without the magic link), then the phone specifics are
// added: national input and countries, line-type policy and the vendor lookup, the accounts-per-number maximum (policy, race and guard) and the number rate dimension.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_EVENTS, maskPhone } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import {
  FakePhoneIntelligence,
  MemoryRateLimiter,
  RecordingEmailSender,
  RecordingSmsSender,
  SmsDeliveryError,
  type PhoneIntelligence,
  type PhoneIntelligenceResult,
  type RateDecision,
  type RateLimiter,
  type RateRule,
  type SmsMessage,
  type SmsSendResult,
  type SmsSender,
} from '@bananagig/platform';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  AccountError,
  AccountService,
  EmailVerificationService,
  PHONE_LOOKUP_TIMEOUT_MS,
  PHONE_POLICY_KEYS,
  PhoneVerificationService,
  canonicalizePhone,
  hashDimension,
  hashPhoneCode,
  hashVerificationCode,
  parsePhoneVerificationPolicy,
  type PhoneCountryDirectory,
  type PhonePolicyProvider,
  type PhoneVerificationDeps,
  type PhoneVerificationPolicy,
  type SendPhoneVerificationResult,
} from './index';

// every log call of the code under test is captured here (and nothing is printed): the logs are scanned for secrets
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

// ---------------------------------------------------------------- fixtures
const E = PHONE_EVENTS;
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const OP = { actor: 'admin:operator-1', reason: 'integration test' };
const testHashKey = 'phone-verification-test-hmac-'.repeat(2);
const otherHashKey = 'another-test-hmac-'.repeat(3);
/** The PRD values (SV-03.01, SV-03.02, CU-03.06) plus the two abuse limits seeded by migration 0011. */
const PRD: PhoneVerificationPolicy = {
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

/** A mutable fake of the configuration-backed policy provider: a global policy, per-country overrides, and a record of the countries it was asked for. */
class FakePolicy implements PhonePolicyProvider {
  current: PhoneVerificationPolicy = { ...PRD };
  overrides = new Map<string, Partial<PhoneVerificationPolicy>>();
  asked: (string | undefined)[] = [];
  failure: unknown;
  async policy(country?: string): Promise<PhoneVerificationPolicy> {
    this.asked.push(country);
    if (this.failure !== undefined) throw this.failure;
    return { ...this.current, ...(country ? this.overrides.get(country) : undefined) };
  }
  reset(): void {
    this.current = { ...PRD, blockedLineTypes: [...PRD.blockedLineTypes] };
    this.overrides.clear();
    this.asked = [];
    this.failure = undefined;
  }
}

/** The geography side: which countries accept numbers (with their configured dialing code) and the default for a national number. */
class FakeCountries implements PhoneCountryDirectory {
  table = new Map<string, { dialingCode: string }>();
  def: string | undefined;
  asked: string[] = [];
  async active(iso: string): Promise<{ dialingCode: string } | null> {
    this.asked.push(iso);
    return this.table.get(iso) ?? null;
  }
  async defaultCountry(): Promise<string | undefined> {
    return this.def;
  }
  reset(): void {
    this.table = new Map([['US', { dialingCode: '+1' }]]);
    this.def = 'US';
    this.asked = [];
  }
  activate(iso: string, dialingCode: string): void {
    this.table.set(iso, { dialingCode });
  }
}

/** The vendor lookup double: the deterministic FakePhoneIntelligence, a record of every call, and a hook to answer anything else. */
class SpyIntelligence implements PhoneIntelligence {
  calls: { e164: string; country: string }[] = [];
  hook: ((e164: string, country: string) => Promise<PhoneIntelligenceResult>) | undefined;
  private readonly inner = new FakePhoneIntelligence();
  lookup(e164: string, country: string): Promise<PhoneIntelligenceResult> {
    this.calls.push({ e164, country });
    return this.hook ? this.hook(e164, country) : this.inner.lookup(e164);
  }
  reset(): void {
    this.calls = [];
    this.hook = undefined;
  }
}

/** A sender that records EVERY attempt (also the failing one, so a test can read the code that never arrived) and fails on demand with anything. */
class ScriptedSender implements SmsSender {
  readonly seen: SmsMessage[] = [];
  next: unknown;
  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.seen.push(message);
    if (this.next !== undefined) {
      const failure = this.next;
      this.next = undefined;
      throw failure;
    }
    return { messageId: `scripted-${this.seen.length}`, templateVersion: null };
  }
}

/** A sender whose next delivery stays in flight until the test releases it (a slow SMS gateway). */
class GatedSender implements SmsSender {
  readonly seen: SmsMessage[] = [];
  private gate: Promise<void> | undefined;
  holdNext(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.seen.push(message);
    const gate = this.gate;
    this.gate = undefined;
    if (gate) await gate;
    return { messageId: `gated-${this.seen.length}`, templateVersion: null };
  }
}

/** Wraps a limiter and remembers the rules of every call. */
class SpyLimiter implements RateLimiter {
  readonly calls: RateRule[][] = [];
  constructor(private readonly inner: RateLimiter) {}
  consume(rules: readonly RateRule[], options?: { cost?: number }): Promise<RateDecision> {
    this.calls.push([...rules]);
    return this.inner.consume(rules, options);
  }
}

let iso: IsolatedDatabase;
let bigDb: Database;
let accounts: AccountService;
let emailSvc: EmailVerificationService;
let ph: PhoneVerificationService;
const policy = new FakePolicy();
const countries = new FakeCountries();
const intel = new SpyIntelligence();
const sms = new RecordingSmsSender();
const emailSender = new RecordingEmailSender();
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);

function makeService(over: Partial<PhoneVerificationDeps> = {}): PhoneVerificationService {
  return new PhoneVerificationService({
    database: bigDb,
    policy,
    sender: sms,
    intelligence: intel,
    countries,
    hashSecret: testHashKey,
    ...over,
  });
}
const setPolicy = (over: Partial<PhoneVerificationPolicy>): void => {
  policy.current = { ...PRD, blockedLineTypes: [...PRD.blockedLineTypes], ...over };
};

/** A country that exists in geography (the foreign key of phone_contacts) but is PLANNED there: whether it ACCEPTS numbers is decided by the fake directory. */
async function seedCountry(alpha2: string, alpha3: string, numeric: string, dialingCode: string): Promise<void> {
  const c = await db().pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ country_id: string }>(
      `INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale,
                                        distance_unit, first_day_of_week, date_format_code, time_format_code)
       VALUES ($1, $2, $3, 'geography.country.us.name', 'PLANNED', $4, 'USD', 'en-US', 'KILOMETERS', 'MONDAY', 'DMY', '24_HOUR') RETURNING country_id`,
      [alpha2, alpha3, numeric, dialingCode],
    );
    await c.query('INSERT INTO geography.country_locales (country_id, locale) VALUES ($1, $2)', [r.rows[0]!.country_id, 'en-US']);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below need more requests in flight
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 28, connectionTimeoutMs: 20_000 } });
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
  ph = makeService();
  await seedCountry('CA', 'CAN', '124', '+1');
  await seedCountry('GB', 'GBR', '826', '+44');
  await seedCountry('DE', 'DEU', '276', '+49');
});
afterAll(async () => {
  await bigDb?.close();
  await iso?.drop();
});
beforeEach(() => {
  policy.reset();
  countries.reset();
  intel.reset();
  sms.sent.length = 0;
  sms.failNext = undefined;
  logSink.lines.length = 0;
});

// ---------------------------------------------------------------- generic helpers
/** Fails the test unless the promise rejects with exactly this AccountError code (and details, when given). Returns the error. */
async function fails(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<AccountError> {
  const e = await rejection(p);
  expect(e, `expected AccountError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`).toBeInstanceOf(AccountError);
  const a = e as AccountError;
  expect(a.code).toBe(code);
  if (details) expect(a.details).toEqual(details);
  return a;
}
/** The value, or the error the call failed with (races: both outcomes can be legitimate, the final state is what matters). */
const settled = <T>(p: Promise<T>): Promise<T | AccountError> =>
  p.then(
    (v) => v,
    (e: unknown) => e as AccountError,
  );
const between = (n: unknown, lo: number, hi: number): void => {
  expect(typeof n).toBe('number');
  expect(n as number).toBeGreaterThanOrEqual(lo);
  expect(n as number).toBeLessThanOrEqual(hi);
};
/** The shape of a value: types instead of values (dates, strings, numbers), so two answers can be compared without their timestamps and ids. */
const shapeOf = (v: unknown): unknown =>
  v instanceof Date
    ? 'Date'
    : Array.isArray(v)
      ? v.map(shapeOf)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
        : v === null
          ? null
          : typeof v;
/** A code that is certainly not `code`. */
const wrongCode = (code: string): string => String((Number(code) + 1) % 10 ** code.length).padStart(code.length, '0');
const codeOf = (m: SmsMessage): string => String(m.variables.verification_code);

async function newAccount(): Promise<string> {
  return (await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] })).accountId;
}

// ---------------------------------------------------------------- numbers (unique per call; the last three digits select the fake line type)
const AREAS = ['202', '212', '213', '305', '310', '312', '404', '415', '512', '617', '702', '713', '718', '818', '917'];
const SPECIAL = new Set(['901', '902', '903', '904', '905']);
let usSeq = 0;
let usSpecialSeq = 0;
let caSeq = 0;
let gbSeq = 0;
let deSeq = 0;
/** A fresh valid US mobile number (the fake lookup answers MOBILE). */
function usNumber(): string {
  for (;;) {
    const n = usSeq++;
    const line = String(1000 + Math.floor(n / AREAS.length));
    if (SPECIAL.has(line.slice(1))) continue;
    return `+1${AREAS[n % AREAS.length]}555${line}`;
  }
}
/** A fresh valid US number whose last three digits are `suffix` (901 VOIP, 902 VIRTUAL, 903 LANDLINE, 904 HIGH_RISK, 905 lookup failure). */
function usNumberEnding(suffix: '901' | '902' | '903' | '904' | '905'): string {
  const n = usSpecialSeq++;
  return `+1${AREAS[n % AREAS.length]}555${1 + (Math.floor(n / AREAS.length) % 9)}${suffix}`;
}
/** A fresh valid Canadian number (a +1 number that belongs to CA, not US). */
function caNumber(): string {
  for (;;) {
    const line = String(1000 + caSeq++);
    if (SPECIAL.has(line.slice(1))) continue;
    return `+1416555${line}`;
  }
}
function gbNumber(): string {
  for (;;) {
    const tail = String(100000 + gbSeq++);
    if (SPECIAL.has(tail.slice(-3))) continue;
    return `+447400${tail}`;
  }
}
function deNumber(): string {
  for (;;) {
    const tail = String(10000000 + deSeq++);
    if (SPECIAL.has(tail.slice(-3))) continue;
    return `+49151${tail}`;
  }
}
/** The national format of a US number as a person types it: (202) 555-1000. */
const nationalUs = (e164: string): string => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
const nationalDigits = (e164: string): string => e164.slice(2);

// ---------------------------------------------------------------- reading what the person reads in the SMS
interface Issued {
  id: string;
  phone: string;
  code: string;
  message: SmsMessage;
  sent: SendPhoneVerificationResult;
}
/** An account with a pending number and a delivered verification SMS (the code read back from the message). */
async function pendingWithSms(
  o: { id?: string; phone?: string; service?: PhoneVerificationService; texts?: { sent: readonly SmsMessage[] } } = {},
): Promise<Issued> {
  const id = o.id ?? (await newAccount());
  const phone = o.phone ?? usNumber();
  const service = o.service ?? ph;
  const texts = o.texts ?? sms;
  await service.setPhone(id, phone);
  const before = texts.sent.length;
  const sent = await service.sendVerification(id);
  const message = texts.sent[before]!;
  return { id, phone, code: codeOf(message), message, sent };
}
/** A resend: returns the new message's code. */
async function resend(id: string, service: PhoneVerificationService = ph): Promise<{ code: string; message: SmsMessage }> {
  const before = sms.sent.length;
  await service.sendVerification(id);
  const message = sms.sent[before]!;
  return { code: codeOf(message), message };
}
/** An account whose number is VERIFIED through the code. */
async function verifiedAccount(phone = usNumber()): Promise<Issued & { contactId: string }> {
  const issued = await pendingWithSms({ phone });
  await ph.confirmCode(issued.id, issued.code);
  return { ...issued, contactId: (await contactOf(issued.id, phone)).phone_contact_id };
}
/** Verifies the email of an account through the real email flow. */
async function verifyEmail(id: string): Promise<string> {
  const address = `mail-${randomUUID()}@example.test`;
  await emailSvc.setEmail(id, address);
  const before = emailSender.sent.length;
  await emailSvc.sendVerification(id);
  await emailSvc.confirmCode(id, String(emailSender.sent[before]!.variables.verification_code));
  return address;
}

// ---------------------------------------------------------------- row inspectors
interface ContactT {
  phone_contact_id: string;
  account_id: string;
  phone_e164: string;
  country_code: string;
  status: string;
  is_primary: boolean;
  source: string;
  line_type: string | null;
  line_type_checked_at: Date | null;
  verified_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}
interface ChallengeT {
  challenge_id: string;
  phone_contact_id: string;
  purpose: string;
  code_hash: string;
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  attempt_count: number;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  delivery_status: string;
  last_sent_at: Date | null;
  correlation_id: string;
}
interface AuditT {
  action: string;
  actor: string;
  phone_contact_id: string | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string;
}
interface EventT {
  event_type: string;
  aggregate_type: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
  payload_json: Record<string, unknown>;
}
const contactsOf = (id: string) =>
  q<ContactT>(
    `SELECT phone_contact_id, account_id, phone_e164, country_code, status, is_primary, source, line_type, line_type_checked_at, verified_at, disabled_at, disabled_reason
       FROM identity.phone_contacts WHERE account_id = $1 ORDER BY created_at, phone_contact_id`,
    [id],
  );
/** The newest row of a number on an account. */
const contactOf = async (id: string, phone: string): Promise<ContactT> => (await contactsOf(id)).filter((c) => c.phone_e164 === phone).at(-1)!;
const liveContacts = async (id: string) => (await contactsOf(id)).filter((c) => c.status !== 'DISABLED');
const challengesOf = (id: string) =>
  q<ChallengeT>(
    `SELECT c.challenge_id, c.phone_contact_id, c.purpose, c.code_hash, c.expires_at, c.created_at, c.used_at, c.attempt_count,
            c.invalidated_at, c.invalidation_reason, c.delivery_status, c.last_sent_at, c.correlation_id
       FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k USING (phone_contact_id)
      WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
    [id],
  );
const openChallenges = async (id: string) => (await challengesOf(id)).filter((c) => c.used_at === null && c.invalidated_at === null);
/** The phone audit rows of an account, oldest first (account creation rows are not phone rows). */
const audit = (id: string) =>
  q<AuditT>(
    `SELECT action, actor, phone_contact_id, changes, reason, correlation_id FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'PHONE\\_%' ORDER BY occurred_at, audit_event_id`,
    [id],
  );
const auditOf = async (id: string, action: string) => (await audit(id)).filter((a) => a.action === action);
const events = (id: string) =>
  q<EventT>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.phone-%' ORDER BY created_at, outbox_event_id`,
    [id],
  );
const eventsOf = async (id: string, type: string) => (await events(id)).filter((e) => e.event_type === type);
const textsTo = (phone: string) => sms.sent.filter((m) => m.to === phone);

/** Everything the phone feature stored for an account, to prove that a refused call left nothing behind. */
async function snapshot(id: string) {
  return {
    contacts: await q('SELECT * FROM identity.phone_contacts WHERE account_id = $1 ORDER BY created_at, phone_contact_id', [id]),
    challenges: await q(
      `SELECT c.* FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k USING (phone_contact_id) WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
      [id],
    ),
    audit: (
      await q<{ audit_event_id: string }>('SELECT audit_event_id FROM identity.account_audit_events WHERE account_id = $1 ORDER BY audit_event_id', [id])
    ).map((r) => r.audit_event_id),
    events: (
      await q<{ outbox_event_id: string }>('SELECT outbox_event_id FROM integration.outbox_events WHERE aggregate_id = $1 ORDER BY outbox_event_id', [id])
    ).map((r) => r.outbox_event_id),
  };
}
/** Global row counts of the phone feature (an unknown or refused request must not add anything anywhere). */
async function phoneWorld() {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  return {
    contacts: await n('SELECT count(*)::int AS n FROM identity.phone_contacts'),
    challenges: await n('SELECT count(*)::int AS n FROM identity.phone_verification_challenges'),
    audit: await n("SELECT count(*)::int AS n FROM identity.account_audit_events WHERE action LIKE 'PHONE\\_%'"),
    events: await n("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.phone-%'"),
  };
}
/** The number of accounts that hold a number VERIFIED. */
async function holdersOf(phone: string): Promise<number> {
  return (
    await q<{ n: number }>(`SELECT count(DISTINCT account_id)::int AS n FROM identity.phone_contacts WHERE phone_e164 = $1 AND status = 'VERIFIED'`, [phone])
  )[0]!.n;
}
/** The invariants that must hold after any interleaving (checked for every account of this database). */
async function expectPhoneInvariants(): Promise<void> {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  expect(
    await n(`SELECT count(*)::int AS n FROM (SELECT account_id FROM identity.phone_contacts WHERE is_primary GROUP BY account_id HAVING count(*) > 1) x`),
    'two primaries',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM (SELECT account_id FROM identity.phone_contacts WHERE status IN ('PENDING', 'REPLACEMENT_PENDING') GROUP BY account_id HAVING count(*) > 1) x`,
    ),
    'two open candidates',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM (SELECT phone_e164 FROM identity.phone_contacts WHERE status = 'VERIFIED' GROUP BY phone_e164 HAVING count(DISTINCT account_id) > 5) x`,
    ),
    'a verified number on more accounts than the structural ceiling',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k USING (phone_contact_id)
      WHERE c.used_at IS NULL AND c.invalidated_at IS NULL AND k.status NOT IN ('PENDING', 'REPLACEMENT_PENDING')`),
    'an open challenge on a contact that is not pending',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k USING (phone_contact_id)
      WHERE c.used_at IS NOT NULL AND NOT (k.status = 'VERIFIED' OR k.disabled_reason = 'REPLACED')`),
    'a consumed challenge whose number is not (or was never) verified',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM identity.phone_contacts p WHERE p.status = 'PENDING' AND EXISTS (SELECT 1 FROM identity.phone_contacts x WHERE x.account_id = p.account_id AND x.is_primary)`,
    ),
    'an initial pending number next to a primary',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM identity.phone_contacts WHERE status = 'REPLACEMENT_PENDING' AND NOT EXISTS (SELECT 1 FROM identity.phone_contacts x WHERE x.account_id = phone_contacts.account_id AND x.is_primary)`,
    ),
    'a replacement candidate without a primary',
  ).toBe(0);
}

// ---------------------------------------------------------------- crafted challenges (time travel by SQL)
interface CraftOptions {
  code: string;
  /** created_at = now - this many seconds. */
  createdSecondsAgo: number;
  /** expires_at = now + this many seconds (negative: already expired). */
  expiresInSeconds: number;
  /** Close the challenge right away (a historic, superseded send). */
  closeAs?: 'SUPERSEDED' | 'LOCKED';
  /** The hash to store instead of the production hash of the code (tampering tests). */
  hash?: (challengeId: string) => string;
}
/** Inserts an open challenge with explicit times for the contact and the production hash of a known code. Returns the challenge id. */
async function craftChallenge(contactId: string, o: CraftOptions): Promise<string> {
  const challengeId = randomUUID();
  const status = (await q<{ status: string }>('SELECT status FROM identity.phone_contacts WHERE phone_contact_id = $1', [contactId]))[0]!.status;
  await q(
    `INSERT INTO identity.phone_verification_challenges (challenge_id, phone_contact_id, purpose, code_hash, created_at, expires_at, correlation_id)
     VALUES ($1, $2, $3, $4, clock_timestamp() - make_interval(secs => $5::float8), clock_timestamp() + make_interval(secs => $6::float8), 'crafted-by-test')`,
    [
      challengeId,
      contactId,
      status === 'PENDING' ? 'INITIAL_PHONE' : 'CHANGE_PHONE',
      o.hash ? o.hash(challengeId) : hashPhoneCode(testHashKey, challengeId, o.code),
      o.createdSecondsAgo,
      o.expiresInSeconds,
    ],
  );
  if (o.closeAs)
    await q(`UPDATE identity.phone_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = $2 WHERE challenge_id = $1`, [
      challengeId,
      o.closeAs,
    ]);
  return challengeId;
}
const KNOWN_CODE = '123456';

// ---------------------------------------------------------------- secrets scanning
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX64_TEXT = /\b[0-9a-f]{64}\b/g;
const TIME_TEXT = /\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const stripNoise = (text: string): string => text.replace(UUID_TEXT, '').replace(HEX64_TEXT, '').replace(TIME_TEXT, '');
/** A numeric code is short: ids, hashes and timestamps are removed first so a chance digit run inside them cannot make a scan flaky. */
const mentionsCode = (text: string, code: string): boolean => new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`).test(stripNoise(text));
/** Every way the full number can be written: E.164, without the plus, national digits, the usual US layouts. */
function numberVariants(e164: string): string[] {
  const v = [e164, e164.slice(1), e164.slice(-10)];
  if (/^\+1\d{10}$/.test(e164)) {
    const [a, b, c] = [e164.slice(2, 5), e164.slice(5, 8), e164.slice(8)];
    v.push(`(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`);
  }
  return v;
}
const MASKED_NUMBER = /\+\*+\d{2,4}/g;

/** The names of the tables of the identity and integration schemas whose rows contain this text anywhere. */
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
interface Secrets {
  codes: string[];
  numbers: string[];
}
/** The secrets of a set of messages (what the person received) and the numbers of an account's contacts. */
async function secretsOf(id: string, messages: readonly SmsMessage[]): Promise<Secrets> {
  return { codes: messages.map(codeOf), numbers: (await contactsOf(id)).map((c) => c.phone_e164) };
}
/**
 * The audit rows, the outbox payloads, the challenge and contact rows (except the number column of the contacts) and every log line of an account contain no code, no
 * hash and no full number (a masked number and ids are allowed). Returns the texts scanned so a test can add its own assertions.
 */
async function expectNoSecrets(id: string, s: Secrets): Promise<{ audit: string; outbox: string; logs: string; challenges: string; contacts: string }> {
  const hashes = (await challengesOf(id)).map((c) => c.code_hash);
  const auditText = JSON.stringify(await q('SELECT to_jsonb(a) AS j FROM identity.account_audit_events a WHERE a.account_id = $1', [id]));
  const outboxText = JSON.stringify(await q('SELECT to_jsonb(o) AS j FROM integration.outbox_events o WHERE o.aggregate_id = $1', [id]));
  const challengeText = JSON.stringify(
    await q(
      `SELECT to_jsonb(c) AS j FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k USING (phone_contact_id) WHERE k.account_id = $1`,
      [id],
    ),
  );
  const contactText = JSON.stringify(await q(`SELECT to_jsonb(c) - 'phone_e164' AS j FROM identity.phone_contacts c WHERE c.account_id = $1`, [id]));
  const logsText = logSink.lines.join('\n');
  const dumps = { audit: auditText, outbox: outboxText, logs: logsText, challenges: challengeText, contacts: contactText };
  for (const [where, text] of Object.entries(dumps)) {
    for (const c of s.codes) expect(mentionsCode(text, c), `${where} contains a verification code`).toBe(false);
    if (where !== 'challenges') for (const h of hashes) expect(text.includes(h), `${where} contains a stored hash`).toBe(false);
    for (const n of s.numbers)
      for (const variant of numberVariants(n)) expect(stripNoise(text).includes(variant), `${where} contains the full number`).toBe(false);
  }
  expect(outboxText.replace(MASKED_NUMBER, ''), 'outbox payloads carry identifiers only').not.toMatch(/\+\d{7,}/);
  expect(auditText.replace(MASKED_NUMBER, ''), 'audit rows hold masked numbers only').not.toMatch(/\+\d{7,}/);
  expect(logsText.replace(MASKED_NUMBER, ''), 'log lines hold masked numbers only').not.toMatch(/\+\d{7,}/);
  return { audit: auditText, outbox: outboxText, logs: logsText, challenges: challengeText, contacts: contactText };
}

// ---------------------------------------------------------------- deterministic ordering
async function lockWaiters(atLeast: number): Promise<void> {
  for (let n = 0; n < 250; n++) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    await sleep(20);
  }
  throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
}
/**
 * Runs service calls in a fixed order: a raw transaction holds the account row lock, the calls start one by one and queue behind it (every service
 * transaction takes that lock first), then the lock is released and they run in arrival order.
 */
async function inOrder(accountId: string, ...calls: (() => Promise<unknown>)[]): Promise<unknown[]> {
  const holder = await db().pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
    const running: Promise<unknown>[] = [];
    for (const call of calls) {
      running.push(settled(call()));
      await lockWaiters(running.length);
    }
    await holder.query('COMMIT');
    return await Promise.all(running);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}

// ====================================================================== add the initial phone
describe('setPhone: the first number', () => {
  it('adds a PENDING number: masked summary, PHONE_ADDED audit, ContactAdded event, a line-type snapshot, and no SMS is sent yet', async () => {
    const id = await newAccount();
    const phone = usNumber();
    const r = await ph.setPhone(id, phone);
    expect(r.changed).toBe(true);
    expect(r.phone).toEqual({
      phoneVerificationStatus: 'PENDING',
      primary: null,
      pending: { maskedPhone: maskPhone(phone), countryCode: 'US', purpose: 'INITIAL_PHONE', status: 'PENDING', lastSentAt: null, expiresAt: null },
    });
    const [c] = await contactsOf(id);
    expect(c).toMatchObject({
      phone_e164: phone,
      country_code: 'US',
      status: 'PENDING',
      is_primary: false,
      source: 'USER_ENTERED',
      line_type: 'MOBILE',
      verified_at: null,
      disabled_at: null,
      disabled_reason: null,
    });
    expect(c!.line_type_checked_at).toBeInstanceOf(Date);
    expect(await challengesOf(id)).toEqual([]);
    expect(sms.sent).toEqual([]);

    const a = await audit(id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'PHONE_ADDED', actor: `account:${id}`, phone_contact_id: c!.phone_contact_id, reason: null });
    expect(a[0]!.changes).toEqual({
      status: [null, 'PENDING'],
      maskedPhone: maskPhone(phone),
      countryCode: 'US',
      purpose: 'INITIAL_PHONE',
      lineType: 'MOBILE',
    });

    const added = await eventsOf(id, E.contactAdded);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${id}` });
    expect(added[0]!.payload_json).toEqual({
      accountId: id,
      phoneContactId: c!.phone_contact_id,
      purpose: 'INITIAL_PHONE',
      source: 'USER_ENTERED',
      status: 'PENDING',
    });
    expect(await eventsOf(id, E.changeRequested)).toEqual([]);
    expect(await events(id)).toHaveLength(1);
  });

  it('the audit row names the contact by id and the number only masked', async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, phone);
    const text = JSON.stringify(await audit(id));
    expect(text).toContain(maskPhone(phone));
    for (const v of numberVariants(phone)) expect(text).not.toContain(v);
  });

  it('the same number again changes nothing: changed false, one contact, one audit row, one event (also in another spelling)', async () => {
    const id = await newAccount();
    const phone = usNumber();
    const first = await ph.setPhone(id, phone);
    const calls = intel.calls.length;
    const before = await snapshot(id);
    const again = await ph.setPhone(id, phone);
    const respelled = await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    expect(again).toEqual({ changed: false, phone: first.phone });
    expect(respelled).toEqual({ changed: false, phone: first.phone });
    expect(await snapshot(id)).toEqual(before);
    expect(await contactsOf(id)).toHaveLength(1);
    expect(await audit(id)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
    expect(intel.calls.length, "no vendor lookup for a number that is already the account's own pending number").toBe(calls);
  });

  it('an unknown account is NOT_FOUND and nothing is written', async () => {
    const world = await phoneWorld();
    await fails(ph.setPhone(randomUUID(), usNumber()), 'NOT_FOUND');
    await fails(ph.confirmCode(randomUUID(), KNOWN_CODE), 'NOT_FOUND');
    await fails(ph.sendVerification(randomUUID()), 'NOT_FOUND');
    expect(await phoneWorld()).toEqual(world);
    expect(sms.sent).toEqual([]);
  });

  it('a different number supersedes the pending one: the old contact is DISABLED SUPERSEDED and its challenge is closed CONTACT_DISABLED', async () => {
    const first = await pendingWithSms({ phone: usNumber() });
    const second = usNumber();
    const r = await ph.setPhone(first.id, second);
    expect(r.changed).toBe(true);
    expect(r.phone.pending).toEqual({
      maskedPhone: maskPhone(second),
      countryCode: 'US',
      purpose: 'INITIAL_PHONE',
      status: 'PENDING',
      lastSentAt: null,
      expiresAt: null,
    });
    const [old, fresh] = await contactsOf(first.id);
    expect(old).toMatchObject({ phone_e164: first.phone, status: 'DISABLED', disabled_reason: 'SUPERSEDED', is_primary: false });
    expect(old!.disabled_at).toBeInstanceOf(Date);
    expect(fresh).toMatchObject({ phone_e164: second, status: 'PENDING' });
    expect((await liveContacts(first.id)).map((c) => c.phone_e164)).toEqual([second]);

    const [challenge] = await challengesOf(first.id);
    expect(challenge).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    expect(challenge!.invalidated_at).toBeInstanceOf(Date);

    const added = await auditOf(first.id, 'PHONE_ADDED');
    expect(added).toHaveLength(2);
    expect(added[1]!.changes).toEqual({
      status: [null, 'PENDING'],
      maskedPhone: maskPhone(second),
      countryCode: 'US',
      purpose: 'INITIAL_PHONE',
      lineType: 'MOBILE',
      supersededContactId: old!.phone_contact_id,
    });
    expect(await eventsOf(first.id, E.contactAdded)).toHaveLength(2);
  });

  it('after the number was replaced, the old code does not verify the old number (the new one has no challenge yet)', async () => {
    const first = await pendingWithSms();
    await ph.setPhone(first.id, usNumber());
    await fails(ph.confirmCode(first.id, first.code), 'PHONE_CODE_INVALID');
    expect((await liveContacts(first.id))[0]!.status).toBe('PENDING');
    expect(await auditOf(first.id, 'PHONE_VERIFIED')).toEqual([]);
  });

  it('asks the policy for the country of the number (US), and the directory for that country', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    expect(policy.asked).toEqual(['US']);
    expect(countries.asked).toContain('US');
  });
});

describe('setPhone: input forms and countries', () => {
  const SPELLINGS: [string, (e: string) => string, string | undefined][] = [
    ['E.164', (e) => e, undefined],
    ['E.164 with spaces and a country code layout', (e) => `+1 ${e.slice(2, 5)} ${e.slice(5, 8)} ${e.slice(8)}`, undefined],
    ['international with parentheses and dashes', (e) => `+1 (${e.slice(2, 5)}) ${e.slice(5, 8)}-${e.slice(8)}`, undefined],
    ['international with dots', (e) => `+1.${e.slice(2, 5)}.${e.slice(5, 8)}.${e.slice(8)}`, undefined],
    ['national with the country US', nationalUs, 'US'],
    ['national with dashes and the country US', (e) => `${e.slice(2, 5)}-${e.slice(5, 8)}-${e.slice(8)}`, 'US'],
    ['national digits only and the country US', nationalDigits, 'US'],
    ['national with the trunk prefix 1 and the country US', (e) => `1-${e.slice(2, 5)}-${e.slice(5, 8)}-${e.slice(8)}`, 'US'],
    ['national with the directory default (no country given)', nationalUs, undefined],
    ['national digits only with the directory default', nationalDigits, undefined],
    ['surrounding blanks', (e) => `   ${e}  `, undefined],
    ['non-breaking spaces', (e) => `+1${String.fromCodePoint(0xa0)}${e.slice(2)}`, undefined],
    [
      'full-width digits (NFKC)',
      (e) => `${String.fromCodePoint(0xff0b)}${[...e.slice(1)].map((d) => String.fromCodePoint(0xff10 + Number(d))).join('')}`,
      undefined,
    ],
  ];
  it.each(SPELLINGS)('stores E.164 without any formatting for %s', async (_name, spell, country) => {
    const id = await newAccount();
    const phone = usNumber();
    const r = await ph.setPhone(id, spell(phone), country ? { country } : {});
    expect(r.changed).toBe(true);
    const [c] = await contactsOf(id);
    expect(c).toMatchObject({ phone_e164: phone, country_code: 'US', status: 'PENDING' });
    expect(c!.phone_e164).toMatch(/^\+[1-9][0-9]{6,14}$/);
    expect(r.phone.pending).toMatchObject({ maskedPhone: maskPhone(phone), countryCode: 'US' });
  });

  it('a canonicalised number can be sent to: the SMS goes to the E.164 whatever the spelling was', async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    await ph.sendVerification(id);
    expect(sms.sent.map((m) => m.to)).toEqual([phone]);
  });

  it('a national number without a country and without a directory default is PHONE_INVALID COUNTRY_REQUIRED', async () => {
    countries.def = undefined;
    const id = await newAccount();
    const phone = usNumber();
    const e = await fails(ph.setPhone(id, nationalUs(phone)), 'PHONE_INVALID');
    expect(e.details).toEqual({ reason: 'COUNTRY_REQUIRED', messageKey: 'account.phone.error.country_required' });
    expect(await contactsOf(id)).toEqual([]);
    // the explicit country still works, and an international number never needs one
    expect((await ph.setPhone(id, nationalUs(phone), { country: 'US' })).changed).toBe(true);
    const other = await newAccount();
    expect((await ph.setPhone(other, usNumber())).changed).toBe(true);
  });

  it('the explicit country wins over the directory default', async () => {
    countries.activate('GB', '+44');
    countries.def = 'US';
    const id = await newAccount();
    const phone = gbNumber();
    const national = `0${phone.slice(3)}`;
    await ph.setPhone(id, national, { country: 'GB' });
    expect((await contactsOf(id))[0]).toMatchObject({ phone_e164: phone, country_code: 'GB' });
    // without it the default (US) reads the same digits as a US number and finds them invalid
    const other = await newAccount();
    await fails(ph.setPhone(other, national), 'PHONE_INVALID');
  });

  it('the country_code is resolved from the NUMBER: a Canadian +1 number is CA although the caller said US', async () => {
    countries.activate('CA', '+1');
    const id = await newAccount();
    const phone = caNumber();
    const r = await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    expect(r.phone.pending).toMatchObject({ countryCode: 'CA' });
    expect((await contactsOf(id))[0]).toMatchObject({ phone_e164: phone, country_code: 'CA' });
    expect(policy.asked).toEqual(['CA']);
    expect((await auditOf(id, 'PHONE_ADDED'))[0]!.changes).toMatchObject({ countryCode: 'CA' });
  });

  it('an international number ignores the country hint', async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, phone, { country: 'GB' });
    expect((await contactsOf(id))[0]).toMatchObject({ phone_e164: phone, country_code: 'US' });
  });

  it('a number of a country that is NOT active is PHONE_INVALID COUNTRY_NOT_SUPPORTED and nothing is written, looked up or consulted', async () => {
    const id = await newAccount();
    const before = await snapshot(id);
    const world = await phoneWorld();
    const e = await fails(ph.setPhone(id, gbNumber()), 'PHONE_INVALID');
    expect(e.details).toEqual({ reason: 'COUNTRY_NOT_SUPPORTED', messageKey: 'account.phone.error.country_not_supported' });
    await fails(ph.setPhone(id, caNumber()), 'PHONE_INVALID', { reason: 'COUNTRY_NOT_SUPPORTED', messageKey: 'account.phone.error.country_not_supported' });
    expect(await snapshot(id)).toEqual(before);
    expect(await phoneWorld()).toEqual(world);
    expect(intel.calls).toEqual([]);
    expect(policy.asked).toEqual([]);
  });

  it('...and becomes acceptable once its country is active', async () => {
    const id = await newAccount();
    const phone = gbNumber();
    await fails(ph.setPhone(id, phone), 'PHONE_INVALID');
    countries.activate('GB', '+44');
    expect((await ph.setPhone(id, phone)).changed).toBe(true);
    expect((await contactsOf(id))[0]).toMatchObject({ phone_e164: phone, country_code: 'GB' });
    expect(policy.asked).toEqual(['GB']);
  });

  it("an active country whose configured dialing code differs from the number's calling code is COUNTRY_NOT_SUPPORTED", async () => {
    countries.activate('US', '+11');
    const id = await newAccount();
    await fails(ph.setPhone(id, usNumber()), 'PHONE_INVALID', { reason: 'COUNTRY_NOT_SUPPORTED', messageKey: 'account.phone.error.country_not_supported' });
    countries.activate('GB', '+45');
    await fails(ph.setPhone(id, gbNumber()), 'PHONE_INVALID', { reason: 'COUNTRY_NOT_SUPPORTED', messageKey: 'account.phone.error.country_not_supported' });
    expect(await contactsOf(id)).toEqual([]);
    expect(intel.calls).toEqual([]);
  });

  it('a second active country works next to the first (GB and DE numbers)', async () => {
    countries.activate('GB', '+44');
    countries.activate('DE', '+49');
    const [a, b] = [await newAccount(), await newAccount()];
    await ph.setPhone(a, gbNumber());
    await ph.setPhone(b, deNumber());
    expect((await contactsOf(a))[0]!.country_code).toBe('GB');
    expect((await contactsOf(b))[0]!.country_code).toBe('DE');
    expect(policy.asked).toEqual(['GB', 'DE']);
  });

  const INVALID: [string, unknown, string, string?][] = [
    ['an empty string', '', 'REQUIRED'],
    ['blanks only', '   ', 'REQUIRED'],
    ['a number', 42, 'REQUIRED'],
    ['null', null, 'REQUIRED'],
    ['undefined', undefined, 'REQUIRED'],
    ['an object', {}, 'REQUIRED'],
    ['letters', 'call me maybe', 'INVALID_CHARACTERS'],
    ['an extension marker', '+12025551000 x12', 'INVALID_CHARACTERS'],
    ['an extension parameter', '+12025551000;ext=5', 'INVALID_CHARACTERS'],
    ['a plus sign inside', '+1202+5551000', 'INVALID_CHARACTERS'],
    ['a plus in parentheses', '(+1) 202 555 1000', 'INVALID_CHARACTERS'],
    ['a tab', '+1\t2025551000', 'INVALID_CHARACTERS'],
    ['a NUL byte', `+1202${String.fromCodePoint(0)}5551000`, 'INVALID_CHARACTERS'],
    ['a bidirectional override', `+1202${String.fromCodePoint(0x202e)}5551000`, 'INVALID_CHARACTERS'],
    ['a zero-width space', `+1202${String.fromCodePoint(0x200b)}5551000`, 'INVALID_CHARACTERS'],
    ['a SQL fragment', "+1202'; DROP TABLE identity.phone_contacts; --", 'INVALID_CHARACTERS'],
    ['Arabic-Indic digits', `+1${String.fromCodePoint(0x662, 0x660, 0x662)}5551000`, 'INVALID_CHARACTERS'],
    ['an HTML fragment', '<b>+12025551000</b>', 'INVALID_CHARACTERS'],
    ['more than 64 characters', `+1${'2'.repeat(63)}`, 'TOO_LONG'],
    ['a very long string', '1'.repeat(5000), 'TOO_LONG'],
    ['too few digits', '+1202555', 'INVALID_NUMBER'],
    ['an unassigned calling code', '+9999999999', 'INVALID_NUMBER'],
    ['a leading zero after the plus', '+0123456789', 'INVALID_NUMBER'],
    ['an emergency number', '+1911', 'INVALID_NUMBER'],
    ['an international call prefix instead of the plus', '0012025551000', 'INVALID_NUMBER'],
    ['a non-geographic number', '+800 1234 5678', 'COUNTRY_NOT_SUPPORTED'],
    ['a country hint in lower case', '(202) 555-1000', 'COUNTRY_NOT_SUPPORTED', 'us'],
    ['a three-letter country hint', '(202) 555-1000', 'COUNTRY_NOT_SUPPORTED', 'USA'],
    ['a national number of the wrong country', '(202) 555-1000', 'INVALID_NUMBER', 'GB'],
  ];
  it.each(INVALID)(
    'refuses %s with PHONE_INVALID (reason and message key), writes nothing, and consults neither policy nor vendor',
    async (_name, input, reason, hint) => {
      const id = await newAccount();
      const before = await snapshot(id);
      const world = await phoneWorld();
      const e = await fails(ph.setPhone(id, input, hint ? { country: hint } : {}), 'PHONE_INVALID');
      expect(e.details).toEqual({ reason, messageKey: `account.phone.error.${reason.toLowerCase()}` });
      expect(await snapshot(id)).toEqual(before);
      expect(await phoneWorld()).toEqual(world);
      expect(sms.sent).toEqual([]);
      expect(intel.calls).toEqual([]);
      expect(policy.asked).toEqual([]);
    },
  );

  it('SPEC: an unknown (but well-formed) default country is COUNTRY_NOT_SUPPORTED [currently INVALID_NUMBER: the numbering library does not throw for it]', async () => {
    const id = await newAccount();
    const e = await fails(ph.setPhone(id, '(202) 555-1000', { country: 'XX' }), 'PHONE_INVALID');
    expect(e.details).toMatchObject({ reason: 'COUNTRY_NOT_SUPPORTED' });
    expect(await contactsOf(id)).toEqual([]);
  });

  it('the refusal of an invalid number never echoes the input', async () => {
    const id = await newAccount();
    const bad = `not-a-number-${randomUUID()}`;
    const e = await fails(ph.setPhone(id, bad), 'PHONE_INVALID');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(bad);
    const digits = '+12025551';
    const e2 = await fails(ph.setPhone(id, digits), 'PHONE_INVALID');
    expect(JSON.stringify({ m: e2.message, d: e2.details })).not.toContain(digits);
  });

  it('an invalid number next to a pending one leaves the pending number and its challenge untouched', async () => {
    const x = await pendingWithSms();
    const before = await snapshot(x.id);
    await fails(ph.setPhone(x.id, '12345'), 'PHONE_INVALID');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('canonicalizePhone is the single canonicalisation: the stored number is exactly its output', async () => {
    const id = await newAccount();
    const phone = usNumber();
    const parsed = canonicalizePhone(nationalUs(phone), 'US');
    expect(parsed).toMatchObject({ ok: true, e164: phone, countryCode: 'US', callingCode: '1' });
    await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    expect((await contactsOf(id))[0]!.phone_e164).toBe(phone);
  });
});

// ====================================================================== send the verification
describe('sendVerification: the SMS and what is stored', () => {
  it('sends ONE SMS: the canonical recipient, the template key and the typed variables (code string, minutes number)', async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    await ph.sendVerification(id);
    expect(sms.sent).toHaveLength(1);
    const m = sms.sent[0]!;
    expect(m.to).toBe(phone);
    expect(m.templateKey).toBe('sms.verification.phone');
    expect(Object.keys(m.variables).sort()).toEqual(['expiry_minutes', 'verification_code']);
    expect(typeof m.variables.verification_code).toBe('string');
    expect(m.variables.verification_code).toMatch(/^[0-9]{6}$/);
    expect(typeof m.variables.expiry_minutes).toBe('number');
    expect(m.variables.expiry_minutes).toBe(10);
    expect(m.locale).toBeUndefined();
    expect(typeof m.correlationId).toBe('string');
    expect(m.correlationId.length).toBeGreaterThan(0);
    expect(Object.keys(m).sort()).toEqual(['correlationId', 'locale', 'templateKey', 'to', 'variables']);
  });

  it('answers with the send times, the policy and the masked state; resendAvailableAt is the creation of the challenge + the cooldown (30 s)', async () => {
    const x = await pendingWithSms();
    const [c] = await challengesOf(x.id);
    expect(x.sent.sentAt.getTime()).toBe(c!.last_sent_at!.getTime());
    expect(x.sent.expiresAt.getTime()).toBe(c!.expires_at.getTime());
    expect(x.sent.resendAvailableAt.getTime()).toBe(c!.created_at.getTime() + 30_000);
    expect(30_000 - (x.sent.resendAvailableAt.getTime() - x.sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(x.sent.codeLength).toBe(6);
    expect(x.sent.validityMinutes).toBe(10);
    expect(x.sent.phone).toEqual({
      phoneVerificationStatus: 'PENDING',
      primary: null,
      pending: {
        maskedPhone: maskPhone(x.phone),
        countryCode: 'US',
        purpose: 'INITIAL_PHONE',
        status: 'PENDING',
        lastSentAt: x.sent.sentAt.toISOString(),
        expiresAt: x.sent.expiresAt.toISOString(),
      },
    });
  });

  it('stores a HASH only: code_hash is the keyed hash bound to the challenge, never the plaintext; the challenge starts SENT with no attempts', async () => {
    const x = await pendingWithSms();
    const [c] = await challengesOf(x.id);
    expect(c!.code_hash).not.toBe(x.code);
    expect(c!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.code_hash).toBe(hashPhoneCode(testHashKey, c!.challenge_id, x.code));
    expect(c).toMatchObject({
      purpose: 'INITIAL_PHONE',
      delivery_status: 'SENT',
      attempt_count: 0,
      used_at: null,
      invalidated_at: null,
      invalidation_reason: null,
    });
    expect(c!.last_sent_at).toBeInstanceOf(Date);
    between(c!.expires_at.getTime() - c!.created_at.getTime(), 600_000, 601_000);
  });

  it('neither the code nor the full number appears anywhere in the challenge, contact (except phone_e164), audit and outbox rows', async () => {
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ph.confirmCode(x.id, x.code);
    await expectNoSecrets(x.id, { codes: [x.code, wrongCode(x.code)], numbers: [x.phone] });
    // the number lives in exactly one table: phone_contacts.phone_e164
    expect(await tablesMentioning(x.phone)).toEqual(['identity.phone_contacts']);
    expect(await tablesMentioning(nationalDigits(x.phone))).toEqual(['identity.phone_contacts']);
  });

  it('records the request in the audit trail (masked number, purpose, challenge id) and the delivery in a Sent event', async () => {
    const x = await pendingWithSms();
    const [c] = await challengesOf(x.id);
    const contactId = (await contactOf(x.id, x.phone)).phone_contact_id;
    const requested = await auditOf(x.id, 'PHONE_VERIFICATION_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actor: `account:${x.id}`, phone_contact_id: contactId });
    expect(requested[0]!.changes).toEqual({ maskedPhone: maskPhone(x.phone), purpose: 'INITIAL_PHONE', challengeId: c!.challenge_id });
    const sent = await eventsOf(x.id, E.verificationSent);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload_json).toEqual({
      accountId: x.id,
      phoneContactId: contactId,
      challengeId: c!.challenge_id,
      purpose: 'INITIAL_PHONE',
      expiresAt: x.sent.expiresAt.toISOString(),
    });
  });

  it('takes the code length and the validity from the policy', async () => {
    setPolicy({ codeLength: 8, validityMinutes: 3 });
    const x = await pendingWithSms();
    expect(x.code).toMatch(/^[0-9]{8}$/);
    expect(x.message.variables.expiry_minutes).toBe(3);
    expect(x.sent).toMatchObject({ codeLength: 8, validityMinutes: 3 });
    const [c] = await challengesOf(x.id);
    between(c!.expires_at.getTime() - c!.created_at.getTime(), 180_000, 181_000);
  });

  it.each([4, 5, 7, 9, 10])('a code of exactly %i digits is generated and verifies', async (length) => {
    setPolicy({ codeLength: length });
    const x = await pendingWithSms();
    expect(x.code).toMatch(new RegExp(`^[0-9]{${length}}$`));
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('passes the preferred locale of the profile to the renderer', async () => {
    const id = await newAccount();
    await accounts.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US' }, { actor: 'account:self' });
    const x = await pendingWithSms({ id });
    expect(x.message.locale).toBe('en-US');
  });

  it('uses the template key of the deps when one is given', async () => {
    const custom = makeService({ templateKey: 'sms.verification.custom' });
    const x = await pendingWithSms({ service: custom });
    expect(x.message.templateKey).toBe('sms.verification.custom');
  });

  it('the correlation id of the request is the message id, the challenge id, the audit id and the event id', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    await runWithCorrelation(correlationId, () => ph.sendVerification(id));
    expect(sms.sent[0]!.correlationId).toBe(correlationId);
    expect((await challengesOf(id))[0]!.correlation_id).toBe(correlationId);
    expect((await auditOf(id, 'PHONE_VERIFICATION_REQUESTED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(id, E.verificationSent))[0]!.correlation_id).toBe(correlationId);
  });

  it('without a request context a correlation id is minted and still shared by the message, the challenge and the audit row', async () => {
    const x = await pendingWithSms();
    const cid = x.message.correlationId;
    expect(cid.length).toBeGreaterThan(0);
    expect((await challengesOf(x.id))[0]!.correlation_id).toBe(cid);
    expect((await auditOf(x.id, 'PHONE_VERIFICATION_REQUESTED'))[0]!.correlation_id).toBe(cid);
  });

  it('each send uses a fresh code, and the hash is bound to its own challenge', async () => {
    setPolicy({ resendSeconds: 0 });
    const first = await pendingWithSms();
    const second = await resend(first.id);
    const challenges = await challengesOf(first.id);
    expect(new Set(challenges.map((c) => c.code_hash)).size).toBe(2);
    expect(challenges[0]!.code_hash).toBe(hashPhoneCode(testHashKey, challenges[0]!.challenge_id, first.code));
    expect(challenges[1]!.code_hash).toBe(hashPhoneCode(testHashKey, challenges[1]!.challenge_id, second.code));
  });

  it('is NOT_PENDING when the account has no number at all, and when it only has a verified primary', async () => {
    const empty = await newAccount();
    await fails(ph.sendVerification(empty), 'PHONE_NOT_PENDING');
    const v = await verifiedAccount();
    const before = await snapshot(v.id);
    await fails(ph.sendVerification(v.id), 'PHONE_NOT_PENDING');
    expect(await snapshot(v.id)).toEqual(before);
    expect(sms.sent).toHaveLength(1); // the verification of v itself
    await fails(ph.sendVerification(randomUUID()), 'NOT_FOUND');
  });

  it('asks the policy for the country of the PENDING number', async () => {
    countries.activate('GB', '+44');
    const id = await newAccount();
    await ph.setPhone(id, gbNumber());
    policy.asked = [];
    await ph.sendVerification(id);
    expect(policy.asked).toEqual(['GB']);
  });

  it('a send never calls the vendor lookup again (the line type is a stored snapshot)', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    expect(intel.calls).toHaveLength(1);
    await ph.sendVerification(id);
    expect(intel.calls).toHaveLength(1);
  });
});

// ====================================================================== resend cooldown
describe('the resend cooldown', () => {
  it('a second send within the cooldown is PHONE_RESEND_TOO_SOON (retryAfterSeconds 1 to 30) and sends and inserts NOTHING', async () => {
    const x = await pendingWithSms();
    const before = await snapshot(x.id);
    const e = await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 30);
    expect(sms.sent).toHaveLength(1);
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('the refused resend leaves the first code working', async () => {
    const x = await pendingWithSms();
    await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('counts from the CREATION of the newest non-failed unused challenge: a challenge crafted 20 s ago leaves about 10 s', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 20, expiresInSeconds: 580 });
    const e = await fails(ph.sendVerification(id), 'PHONE_RESEND_TOO_SOON');
    between(e.details.retryAfterSeconds, 8, 10);
    expect(sms.sent).toEqual([]);
  });

  it('...and a challenge crafted 31 s ago no longer holds a send back', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 31, expiresInSeconds: 569 });
    await ph.sendVerification(id);
    expect(sms.sent).toHaveLength(1);
  });

  it('a FAILED delivery does not start the cooldown: the next send is allowed at once', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    sms.failNext = new SmsDeliveryError('UNAVAILABLE', 'down', true);
    await fails(ph.sendVerification(id), 'PHONE_DELIVERY_FAILED');
    await ph.sendVerification(id);
    expect(sms.sent).toHaveLength(1);
  });

  it('the cooldown counts from the newest SENT challenge of the ACCOUNT: switching the number does not reset it', async () => {
    const x = await pendingWithSms();
    await ph.setPhone(x.id, usNumber());
    const e = await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
    between(e.details.retryAfterSeconds, 1, 30);
    expect(sms.sent).toHaveLength(1);
  });

  it('with a cooldown of 0 a resend supersedes the previous challenge: it is closed SUPERSEDED and only one challenge stays open', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const second = await resend(x.id);
    const challenges = await challengesOf(x.id);
    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({ invalidation_reason: 'SUPERSEDED', used_at: null, delivery_status: 'SENT' });
    expect(challenges[1]).toMatchObject({ invalidation_reason: null, used_at: null, delivery_status: 'SENT' });
    expect(await openChallenges(x.id)).toHaveLength(1);
    expect((await ph.confirmCode(x.id, second.code)).changed).toBe(true);
  });

  it('the cooldown comes from the policy: a longer one is reported in the answer and in the refusal', async () => {
    setPolicy({ resendSeconds: 120 });
    const x = await pendingWithSms();
    expect(120_000 - (x.sent.resendAvailableAt.getTime() - x.sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(x.sent.resendAvailableAt.getTime()).toBeLessThanOrEqual(x.sent.sentAt.getTime() + 120_000);
    const e = await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
    between(e.details.retryAfterSeconds, 31, 120);
  });

  it('verifying ends the cooldown: the first SMS of a change is allowed at once (a used challenge does not hold a send back)', async () => {
    const p = await verifiedAccount();
    await ph.setPhone(p.id, usNumber());
    await ph.sendVerification(p.id);
    expect(sms.sent).toHaveLength(2);
  });

  it('the cooldown is per account: another account can send at once', async () => {
    await pendingWithSms();
    await pendingWithSms();
    expect(sms.sent).toHaveLength(2);
  });
});

// ====================================================================== hourly and daily caps
describe('the hourly and daily caps', () => {
  it('a third send with maxPerHour 2 is PHONE_SEND_LIMIT with retryAfterSeconds up to an hour, and sends nothing', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const x = await pendingWithSms();
    await resend(x.id);
    const before = await snapshot(x.id);
    const e = await fails(ph.sendVerification(x.id), 'PHONE_SEND_LIMIT');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 3590, 3600);
    expect(sms.sent).toHaveLength(2);
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('a third send with maxPerDay 2 is PHONE_SEND_LIMIT with a retry time of up to a day (longer than the hourly one)', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 5, maxPerDay: 2 });
    const x = await pendingWithSms();
    await resend(x.id);
    const e = await fails(ph.sendVerification(x.id), 'PHONE_SEND_LIMIT');
    between(e.details.retryAfterSeconds, 3601, 86_400);
    expect(sms.sent).toHaveLength(2);
  });

  it('with the default policy (5 per hour) the sixth send of an hour is refused', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    for (let i = 0; i < 4; i++) await resend(x.id);
    expect(sms.sent).toHaveLength(5);
    await fails(ph.sendVerification(x.id), 'PHONE_SEND_LIMIT');
    expect(sms.sent).toHaveLength(5);
  });

  it('failed deliveries count towards the caps', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    for (let i = 0; i < 2; i++) {
      sms.failNext = new SmsDeliveryError('UNAVAILABLE', 'down', true);
      await fails(ph.sendVerification(id), 'PHONE_DELIVERY_FAILED');
    }
    await fails(ph.sendVerification(id), 'PHONE_SEND_LIMIT');
    expect(sms.sent).toEqual([]);
    expect(await challengesOf(id)).toHaveLength(2);
  });

  it('the cap is per ACCOUNT, not per contact: switching the number does not reset it', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const id = await newAccount();
    for (let i = 0; i < 2; i++) {
      await ph.setPhone(id, usNumber());
      await ph.sendVerification(id);
    }
    await ph.setPhone(id, usNumber());
    await fails(ph.sendVerification(id), 'PHONE_SEND_LIMIT');
    expect(sms.sent).toHaveLength(2);
  });

  it('the cap is not shared between accounts', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 1 });
    await pendingWithSms();
    await pendingWithSms();
    expect(sms.sent).toHaveLength(2);
  });

  it('sends older than an hour do not count towards the hourly cap', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 5 });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    for (let i = 0; i < 5; i++)
      await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 7200 + i, expiresInSeconds: -6000, closeAs: 'SUPERSEDED' });
    await ph.sendVerification(id);
    expect(sms.sent).toHaveLength(1);
  });

  it('...but they do count towards the daily cap, with a retry time that follows the oldest of them', async () => {
    setPolicy({ resendSeconds: 0, maxPerDay: 5 });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    for (let i = 0; i < 5; i++)
      await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 7200 + i, expiresInSeconds: -6000, closeAs: 'SUPERSEDED' });
    const e = await fails(ph.sendVerification(id), 'PHONE_SEND_LIMIT');
    between(e.details.retryAfterSeconds, 70_000, 86_400 - 7200 + 1);
    expect(sms.sent).toEqual([]);
  });

  it('sends older than a day count towards neither cap', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 1, maxPerDay: 1 });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 90_000, expiresInSeconds: -80_000, closeAs: 'SUPERSEDED' });
    await ph.sendVerification(id);
    expect(sms.sent).toHaveLength(1);
  });

  it('the hourly cap is checked before the daily one (both exhausted: the hourly retry time is reported)', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 1, maxPerDay: 1 });
    const x = await pendingWithSms();
    const e = await fails(ph.sendVerification(x.id), 'PHONE_SEND_LIMIT');
    between(e.details.retryAfterSeconds, 3590, 3600);
  });
});

// ====================================================================== the code verifies
describe('confirmCode: the correct code', () => {
  it('verifies the number: VERIFIED and primary, challenge consumed, audit PHONE_VERIFIED, Verified event', async () => {
    const x = await pendingWithSms();
    const r = await ph.confirmCode(x.id, x.code);
    expect(r.changed).toBe(true);
    expect(r.phone).toEqual({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(x.phone), countryCode: 'US', verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    const c = await contactOf(x.id, x.phone);
    expect(c).toMatchObject({ status: 'VERIFIED', is_primary: true, source: 'USER_ENTERED', disabled_at: null, disabled_reason: null, line_type: 'MOBILE' });
    expect(c.verified_at).toBeInstanceOf(Date);
    expect(r.phone.primary!.verifiedAt).toBe(c.verified_at!.toISOString());

    const [ch] = await challengesOf(x.id);
    expect(ch).toMatchObject({ invalidated_at: null, invalidation_reason: null, attempt_count: 0, delivery_status: 'SENT' });
    expect(ch!.used_at).toBeInstanceOf(Date);

    const verified = await auditOf(x.id, 'PHONE_VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ actor: `account:${x.id}`, phone_contact_id: c.phone_contact_id });
    expect(verified[0]!.changes).toEqual({
      status: ['PENDING', 'VERIFIED'],
      maskedPhone: maskPhone(x.phone),
      purpose: 'INITIAL_PHONE',
      challengeId: ch!.challenge_id,
    });
    expect(await auditOf(x.id, 'PHONE_PRIMARY_CHANGED')).toEqual([]);
    const ve = await eventsOf(x.id, E.verified);
    expect(ve).toHaveLength(1);
    expect(ve[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${x.id}` });
    expect(ve[0]!.payload_json).toEqual({ accountId: x.id, phoneContactId: c.phone_contact_id, purpose: 'INITIAL_PHONE', replacedPhoneContactId: null });
    await expectPhoneInvariants();
  });

  it('is visible in the account context (/account/me): phone VERIFIED and contacts.phoneVerified true', async () => {
    const x = await pendingWithSms();
    const pending = await accounts.getAccountContext(x.id);
    expect(pending.phone.phoneVerificationStatus).toBe('PENDING');
    expect(pending.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
    await ph.confirmCode(x.id, x.code);
    const ctx = await accounts.getAccountContext(x.id);
    expect(ctx.phone).toEqual({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(x.phone), countryCode: 'US', verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    expect(ctx.contacts).toEqual({ emailVerified: false, phoneVerified: true, contactsVerified: false });
  });

  it('contactsVerified is true only when the email is VERIFIED too (phone first, then email)', async () => {
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, x.code);
    expect((await accounts.getAccountContext(x.id)).contacts.contactsVerified).toBe(false);
    await verifyEmail(x.id);
    const ctx = await accounts.getAccountContext(x.id);
    expect(ctx.contacts).toEqual({ emailVerified: true, phoneVerified: true, contactsVerified: true });
    expect(ctx.email.emailVerificationStatus).toBe('VERIFIED');
    expect(ctx.phone.phoneVerificationStatus).toBe('VERIFIED');
  });

  it('contactsVerified is true only when the email is VERIFIED too (email first, then phone)', async () => {
    const id = await newAccount();
    await verifyEmail(id);
    expect((await accounts.getAccountContext(id)).contacts).toEqual({ emailVerified: true, phoneVerified: false, contactsVerified: false });
    const x = await pendingWithSms({ id });
    expect((await accounts.getAccountContext(id)).contacts.contactsVerified).toBe(false);
    await ph.confirmCode(id, x.code);
    expect((await accounts.getAccountContext(id)).contacts).toEqual({ emailVerified: true, phoneVerified: true, contactsVerified: true });
  });

  it('a pending email does not make the contacts verified; a pending phone change does not unverify them', async () => {
    const id = await newAccount();
    await emailSvc.setEmail(id, `pending-${randomUUID()}@example.test`);
    const x = await pendingWithSms({ id });
    await ph.confirmCode(id, x.code);
    expect((await accounts.getAccountContext(id)).contacts).toEqual({ emailVerified: false, phoneVerified: true, contactsVerified: false });
    await verifyEmail(id);
    expect((await accounts.getAccountContext(id)).contacts).toEqual({ emailVerified: true, phoneVerified: true, contactsVerified: true });
    await ph.setPhone(id, usNumber());
    const ctx = await accounts.getAccountContext(id);
    expect(ctx.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(ctx.phone.pending).toMatchObject({ status: 'REPLACEMENT_PENDING' });
    expect(ctx.contacts).toEqual({ emailVerified: true, phoneVerified: true, contactsVerified: true });
  });

  it('a new account has no phone and no verified contacts', async () => {
    const created = await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] });
    expect(created.phone).toEqual({ phoneVerificationStatus: 'NONE', primary: null, pending: null });
    expect(created.contacts).toEqual({ emailVerified: false, phoneVerified: false, contactsVerified: false });
  });

  it('a few wrong attempts before the right code do not block it, and the attempt counter keeps its value', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 2; i++) await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID');
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 2 });
  });

  it('a leading-zero code is compared as text (004217-style codes verify, 4217 does not)', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: '004217', createdSecondsAgo: 5, expiresInSeconds: 600 });
    await fails(ph.confirmCode(id, '4217'), 'PHONE_CODE_INVALID');
    expect((await ph.confirmCode(id, '004217')).changed).toBe(true);
  });

  it('a code with surrounding blanks or another shape is simply a wrong code (counted), never an exception', async () => {
    const x = await pendingWithSms();
    await fails(ph.confirmCode(x.id, ` ${x.code}`), 'PHONE_CODE_INVALID', { attemptsRemaining: 4 });
    await fails(ph.confirmCode(x.id, 'abcdef'), 'PHONE_CODE_INVALID', { attemptsRemaining: 3 });
    await fails(ph.confirmCode(x.id, ''), 'PHONE_CODE_INVALID', { attemptsRemaining: 2 });
    await fails(ph.confirmCode(x.id, '9'.repeat(5000)), 'PHONE_CODE_INVALID', { attemptsRemaining: 1 });
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('confirming with no number and no primary is NOT_PENDING', async () => {
    await fails(ph.confirmCode(await newAccount(), KNOWN_CODE), 'PHONE_NOT_PENDING');
  });

  it('confirming before any send is PHONE_CODE_INVALID and no attempt can be counted (there is no challenge)', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    await fails(ph.confirmCode(id, KNOWN_CODE), 'PHONE_CODE_INVALID');
    expect(await challengesOf(id)).toEqual([]);
    expect(await auditOf(id, 'PHONE_VERIFICATION_FAILED')).toEqual([]);
  });

  it('a code from the SMS of ANOTHER account never verifies this one', async () => {
    const mine = await pendingWithSms();
    const other = await pendingWithSms();
    await fails(ph.confirmCode(mine.id, other.code), 'PHONE_CODE_INVALID');
    expect((await liveContacts(mine.id))[0]!.status).toBe('PENDING');
    expect((await ph.confirmCode(other.id, other.code)).changed).toBe(true);
  });

  it('needs the right key: with another hash key the same code does not verify', async () => {
    const x = await pendingWithSms();
    const stranger = makeService({ hashSecret: otherHashKey });
    await fails(stranger.confirmCode(x.id, x.code), 'PHONE_CODE_INVALID');
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });
});

// ====================================================================== wrong codes and the lock
describe('wrong codes count attempts and lock the challenge', () => {
  it('reports the attempts left (4, 3, 2, 1), locks on the 5th, and persists every attempt although the call threw', async () => {
    const x = await pendingWithSms();
    const wrong = wrongCode(x.code);
    for (const remaining of [4, 3, 2, 1]) {
      const e = await fails(ph.confirmCode(x.id, wrong), 'PHONE_CODE_INVALID');
      expect(e.details).toEqual({ attemptsRemaining: remaining });
      expect((await challengesOf(x.id))[0]!.attempt_count).toBe(5 - remaining);
    }
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 4, invalidated_at: null });
    const locked = await fails(ph.confirmCode(x.id, wrong), 'PHONE_VERIFICATION_LOCKED');
    expect(locked.details).toEqual({});

    const [ch] = await challengesOf(x.id);
    expect(ch).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED', used_at: null });
    expect(ch!.invalidated_at).toBeInstanceOf(Date);
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
    expect((await accounts.getAccountContext(x.id)).phone.phoneVerificationStatus).toBe('PENDING');
  });

  it('audits FAILED x5 (attempt 1 to 5) and LOCKED x1, and emits Failed events with locked true only on the last', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 5; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const [ch] = await challengesOf(x.id);
    const contactId = (await contactOf(x.id, x.phone)).phone_contact_id;

    const failed = await auditOf(x.id, 'PHONE_VERIFICATION_FAILED');
    expect(failed.map((a) => a.changes)).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({ maskedPhone: maskPhone(x.phone), attempt, challengeId: ch!.challenge_id })),
    );
    expect(failed.every((a) => a.phone_contact_id === contactId && a.actor === `account:${x.id}`)).toBe(true);
    const lockedAudit = await auditOf(x.id, 'PHONE_VERIFICATION_LOCKED');
    expect(lockedAudit).toHaveLength(1);
    expect(lockedAudit[0]!.changes).toEqual({ maskedPhone: maskPhone(x.phone), challengeId: ch!.challenge_id, attempts: 5 });

    const ev5 = await eventsOf(x.id, E.verificationFailed);
    expect(ev5.map((e) => e.payload_json)).toEqual(
      [1, 2, 3, 4, 5].map((attemptCount) => ({
        accountId: x.id,
        phoneContactId: contactId,
        challengeId: ch!.challenge_id,
        attemptCount,
        locked: attemptCount === 5,
      })),
    );
  });

  it('after the lock even the correct code fails with PHONE_VERIFICATION_LOCKED, and nothing more is written', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 5; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const before = await snapshot(x.id);
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_VERIFICATION_LOCKED');
    await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_VERIFICATION_LOCKED');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
  });

  it('a resend after a lock issues a fresh challenge that works (the attempts start again at 5)', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    for (let i = 0; i < 5; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const fresh = await resend(x.id);
    expect(fresh.code).toMatch(/^[0-9]{6}$/);
    const e = await fails(ph.confirmCode(x.id, wrongCode(fresh.code)), 'PHONE_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await ph.confirmCode(x.id, fresh.code)).changed).toBe(true);
    const challenges = await challengesOf(x.id);
    expect(challenges.map((c) => c.invalidation_reason ?? (c.used_at ? 'USED' : 'OPEN'))).toEqual(['LOCKED', 'USED']);
  });

  it('maxAttempts comes from the policy: with 3 the attempts left are 2, 1 and the third locks', async () => {
    setPolicy({ maxAttempts: 3 });
    const x = await pendingWithSms();
    expect((await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID')).details).toEqual({ attemptsRemaining: 2 });
    expect((await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID')).details).toEqual({ attemptsRemaining: 1 });
    await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 3, invalidation_reason: 'LOCKED' });
  });

  it('maxAttempts 1 locks on the first wrong code', async () => {
    setPolicy({ maxAttempts: 1 });
    const x = await pendingWithSms();
    await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 1, invalidation_reason: 'LOCKED' });
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_LOCKED')).toHaveLength(1);
  });

  it('a lowered maxAttempts locks a challenge that already used its attempts, even for the correct code', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 3; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    setPolicy({ maxAttempts: 3 });
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 3, invalidation_reason: 'LOCKED', used_at: null });
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
  });

  it('the attempt counter belongs to the challenge: a resend starts a new count', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const fresh = await resend(x.id);
    const e = await fails(ph.confirmCode(x.id, wrongCode(fresh.code)), 'PHONE_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await challengesOf(x.id)).map((c) => c.attempt_count)).toEqual([2, 1]);
  });

  it('concurrent wrong guesses cannot exceed the maximum: 12 parallel wrong codes leave exactly 5 attempts and one lock', async () => {
    const x = await pendingWithSms();
    const wrong = wrongCode(x.code);
    const results = await Promise.all(Array.from({ length: 12 }, () => settled(ph.confirmCode(x.id, wrong))));
    expect(results.every((r) => r instanceof AccountError)).toBe(true);
    const codes = (results as AccountError[]).map((r) => r.code);
    expect(codes.filter((c) => c === 'PHONE_CODE_INVALID')).toHaveLength(4);
    expect(codes.filter((c) => c === 'PHONE_VERIFICATION_LOCKED')).toHaveLength(8);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED' });
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_FAILED')).toHaveLength(5);
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_LOCKED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verificationFailed)).toHaveLength(5);
  });

  it('maxAttempts 3: 12 parallel wrong codes leave exactly 3 counted', async () => {
    setPolicy({ maxAttempts: 3 });
    const x = await pendingWithSms();
    const results = await Promise.all(Array.from({ length: 12 }, () => settled(ph.confirmCode(x.id, wrongCode(x.code)))));
    expect(results.every((r) => r instanceof AccountError)).toBe(true);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 3, invalidation_reason: 'LOCKED' });
  });

  it('parallel wrong guesses plus the right code: if the right one wins nothing is left locked, otherwise the lock holds (6 rounds)', async () => {
    for (let round = 0; round < 6; round++) {
      const x = await pendingWithSms();
      const wrong = wrongCode(x.code);
      const results = await Promise.all([...Array.from({ length: 6 }, () => settled(ph.confirmCode(x.id, wrong))), settled(ph.confirmCode(x.id, x.code))]);
      const ch = (await challengesOf(x.id))[0]!;
      expect(ch.attempt_count, `round ${round}`).toBeLessThanOrEqual(5);
      const contact = await contactOf(x.id, x.phone);
      if (contact.status === 'VERIFIED') {
        expect(ch.used_at).not.toBeNull();
        expect(results.filter((r) => !(r instanceof AccountError) && r.changed)).toHaveLength(1);
      } else {
        expect(ch.invalidation_reason).toBe('LOCKED');
        expect(ch.attempt_count).toBe(5);
      }
    }
    await expectPhoneInvariants();
  });

  it('the error of a wrong code never contains the code, the number or its digits', async () => {
    const x = await pendingWithSms();
    const e = await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID');
    const text = JSON.stringify({ m: e.message, d: e.details });
    expect(text).not.toContain(x.code);
    expect(text).not.toContain(wrongCode(x.code));
    for (const v of numberVariants(x.phone)) expect(text).not.toContain(v);
  });

  it('a locked challenge is closed for the cooldown too: a new send is allowed only after the cooldown (locked rows count as issued)', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 5; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
  });
});

// ====================================================================== expiry
describe('expired codes', () => {
  async function expired() {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, phone);
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    const challengeId = await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 700, expiresInSeconds: -100 });
    return { id, phone, contactId, challengeId };
  }

  it('the correct code of an expired challenge is PHONE_CODE_EXPIRED, and NO attempt is counted', async () => {
    const x = await expired();
    const before = await snapshot(x.id);
    await fails(ph.confirmCode(x.id, KNOWN_CODE), 'PHONE_CODE_EXPIRED');
    await fails(ph.confirmCode(x.id, wrongCode(KNOWN_CODE)), 'PHONE_CODE_EXPIRED');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 0, used_at: null, invalidated_at: null });
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_FAILED')).toEqual([]);
  });

  it('a challenge that expires exactly now is expired (a 1 second validity crafted 2 seconds ago)', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 2, expiresInSeconds: -1 });
    await fails(ph.confirmCode(id, KNOWN_CODE), 'PHONE_CODE_EXPIRED');
  });

  it('the validity is relative to the DATABASE clock: a challenge with a few seconds left still verifies', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 595, expiresInSeconds: 5 });
    expect((await ph.confirmCode(id, KNOWN_CODE)).changed).toBe(true);
  });

  it('the summary shows no usable expiry for it (pending.expiresAt null) and the detail shows no attempts left', async () => {
    const x = await expired();
    const summary = await ph.getPhoneSummary(x.id);
    expect(summary.pending).toMatchObject({ status: 'PENDING', expiresAt: null });
    expect((await ph.getPhoneDetail(x.id)).attemptsRemaining).toBeNull();
  });

  it('a resend replaces an expired challenge (the expired one is superseded) and the new code verifies', async () => {
    const x = await expired();
    const fresh = await resend(x.id);
    const challenges = await challengesOf(x.id);
    expect(challenges.map((c) => c.invalidation_reason)).toEqual(['SUPERSEDED', null]);
    // the expired, superseded code is "used or replaced" and costs no attempt
    await fails(ph.confirmCode(x.id, KNOWN_CODE), 'PHONE_CODE_USED');
    expect((await ph.confirmCode(x.id, fresh.code)).changed).toBe(true);
  });

  it('a challenge that is still valid verifies while an older expired history sits next to it', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: '111111', createdSecondsAgo: 700, expiresInSeconds: -100, closeAs: 'SUPERSEDED' });
    await craftChallenge(contactId, { code: '222222', createdSecondsAgo: 5, expiresInSeconds: 595 });
    await fails(ph.confirmCode(id, '111111'), 'PHONE_CODE_USED');
    expect((await ph.confirmCode(id, '222222')).changed).toBe(true);
  });

  it('an expired challenge is not locked by the attempts rule either: attempts already used are irrelevant once it expired', async () => {
    const x = await expired();
    await q('UPDATE identity.phone_verification_challenges SET attempt_count = 1 WHERE challenge_id = $1', [x.challengeId]);
    await fails(ph.confirmCode(x.id, KNOWN_CODE), 'PHONE_CODE_EXPIRED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 1, invalidated_at: null });
  });

  it('the verification of an expired CHANGE leaves the verified primary alone', async () => {
    const p = await verifiedAccount();
    await ph.setPhone(p.id, usNumber());
    const candidate = (await liveContacts(p.id)).find((c) => c.status === 'REPLACEMENT_PENDING')!;
    await craftChallenge(candidate.phone_contact_id, { code: KNOWN_CODE, createdSecondsAgo: 700, expiresInSeconds: -100 });
    await fails(ph.confirmCode(p.id, KNOWN_CODE), 'PHONE_CODE_EXPIRED');
    expect((await contactOf(p.id, p.phone)).status).toBe('VERIFIED');
    expect((await contactOf(p.id, p.phone)).is_primary).toBe(true);
  });
});

// ====================================================================== single use and idempotency
describe('single use and idempotency', () => {
  it('repeating a successful confirmCode is changed:false and has no second audit row, event or verified_at change', async () => {
    const x = await pendingWithSms();
    const first = await ph.confirmCode(x.id, x.code);
    const before = await snapshot(x.id);
    const verifiedAt = (await contactOf(x.id, x.phone)).verified_at!.getTime();
    const again = await ph.confirmCode(x.id, x.code);
    expect(again.changed).toBe(false);
    expect(again.phone).toEqual(first.phone);
    expect(await snapshot(x.id)).toEqual(before);
    expect((await contactOf(x.id, x.phone)).verified_at!.getTime()).toBe(verifiedAt);
    expect(await auditOf(x.id, 'PHONE_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
  });

  it('a wrong code after the verification is still the documented idempotent success (the account is already verified) and counts nothing', async () => {
    const x = await verifiedAccount();
    const before = await snapshot(x.id);
    const r = await ph.confirmCode(x.id, wrongCode(x.code));
    expect(r.changed).toBe(false);
    expect(r.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(await snapshot(x.id)).toEqual(before);
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_FAILED')).toEqual([]);
  });

  it('SPEC: the old code after a RESEND is PHONE_CODE_USED (superseded) and costs no attempt', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const fresh = await resend(x.id);
    expect(fresh.code).not.toBe(x.code);
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_CODE_USED');
    expect((await challengesOf(x.id)).map((c) => c.attempt_count)).toEqual([0, 0]);
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_FAILED')).toEqual([]);
  });

  it('the old code can be tried again and again without ever locking the new challenge', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const fresh = await resend(x.id);
    for (let i = 0; i < 8; i++) await fails(ph.confirmCode(x.id, x.code), 'PHONE_CODE_USED');
    expect((await challengesOf(x.id))[1]).toMatchObject({ attempt_count: 0, invalidated_at: null });
    expect((await ph.confirmCode(x.id, fresh.code)).changed).toBe(true);
  });

  it('the old code after a resend never verifies: the number stays PENDING and the new code still works', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const fresh = await resend(x.id);
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_CODE_USED');
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
    expect(await auditOf(x.id, 'PHONE_VERIFIED')).toEqual([]);
    expect((await ph.confirmCode(x.id, fresh.code)).changed).toBe(true);
  });

  it('a code from two resends back is superseded too (all older codes are dead)', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const second = await resend(x.id);
    const third = await resend(x.id);
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_CODE_USED');
    await fails(ph.confirmCode(x.id, second.code), 'PHONE_CODE_USED');
    expect((await ph.confirmCode(x.id, third.code)).changed).toBe(true);
  });

  it('the code of a number that was later replaced by a verified one stays an idempotent success (the account is verified) and verifies nothing', async () => {
    setPolicy({ resendSeconds: 0 });
    const first = await verifiedAccount();
    const second = await pendingWithSms({ id: first.id, phone: usNumber() });
    await ph.confirmCode(first.id, second.code);
    const r = await ph.confirmCode(first.id, first.code);
    expect(r.changed).toBe(false);
    expect((await contactOf(first.id, second.phone)).is_primary).toBe(true);
    expect((await contactOf(first.id, first.phone)).status).toBe('DISABLED');
  });

  it('a withdrawn pending change: its old code is not an error (the account is verified) but verifies nothing', async () => {
    setPolicy({ resendSeconds: 0 });
    const p = await verifiedAccount();
    const change = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.setPhone(p.id, p.phone);
    const r = await ph.confirmCode(p.id, change.code);
    expect(r.changed).toBe(false);
    expect((await contactOf(p.id, change.phone)).status).toBe('DISABLED');
  });

  it('a delivered code that was consumed cannot be replayed on a later challenge of the same contact', async () => {
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, x.code);
    const hash = (await challengesOf(x.id))[0]!.code_hash;
    expect(hash).toBe(hashPhoneCode(testHashKey, (await challengesOf(x.id))[0]!.challenge_id, x.code));
    await fails(ph.sendVerification(x.id), 'PHONE_NOT_PENDING');
  });
});

// ====================================================================== races
describe('races: a code, a resend and a replacement', () => {
  it('two simultaneous confirmCode with the correct code: exactly one changed:true, one PHONE_VERIFIED audit row, one Verified event (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithSms();
      const results = await Promise.all([ph.confirmCode(x.id, x.code), ph.confirmCode(x.id, x.code)]);
      expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
      expect(await auditOf(x.id, 'PHONE_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
      expect((await challengesOf(x.id))[0]!.used_at).not.toBeNull();
      expect((await liveContacts(x.id)).map((c) => c.status)).toEqual(['VERIFIED']);
    }
    await expectPhoneInvariants();
  });

  it('many simultaneous confirmations (6 parallel) still verify exactly once', async () => {
    const x = await pendingWithSms();
    const results = await Promise.all(Array.from({ length: 6 }, () => ph.confirmCode(x.id, x.code)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await auditOf(x.id, 'PHONE_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
  });

  it('deterministic order verify, then resend: the resend fails with NOT_PENDING and nothing more is sent', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const [v, s] = await inOrder(
      x.id,
      () => ph.confirmCode(x.id, x.code),
      () => ph.sendVerification(x.id),
    );
    expect(v).toMatchObject({ changed: true });
    expect(s).toBeInstanceOf(AccountError);
    expect((s as AccountError).code).toBe('PHONE_NOT_PENDING');
    expect(textsTo(x.phone)).toHaveLength(1);
    expect(await openChallenges(x.id)).toEqual([]);
    expect((await liveContacts(x.id))[0]).toMatchObject({ status: 'VERIFIED', is_primary: true });
  });

  it('deterministic order resend, then verify with the old code: PHONE_CODE_USED, the number stays PENDING, one challenge is open', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    const [s, v] = await inOrder(
      x.id,
      () => ph.sendVerification(x.id),
      () => ph.confirmCode(x.id, x.code),
    );
    expect(s).not.toBeInstanceOf(AccountError);
    expect(v).toBeInstanceOf(AccountError);
    expect((v as AccountError).code).toBe('PHONE_CODE_USED');
    expect(textsTo(x.phone)).toHaveLength(2);
    expect(await openChallenges(x.id)).toHaveLength(1);
    expect((await liveContacts(x.id))[0]!.status).toBe('PENDING');
    expect((await ph.confirmCode(x.id, codeOf(textsTo(x.phone)[1]!))).changed).toBe(true);
  });

  it('a resend racing the verification is never a double state (10 rounds, both start orders)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithSms();
      let verifyP: Promise<unknown>;
      let sendP: Promise<unknown>;
      if (round % 2 === 0) {
        verifyP = settled(ph.confirmCode(x.id, x.code));
        sendP = settled(ph.sendVerification(x.id));
      } else {
        sendP = settled(ph.sendVerification(x.id));
        verifyP = settled(ph.confirmCode(x.id, x.code));
      }
      const [v, s] = await Promise.all([verifyP, sendP]);
      const open = await openChallenges(x.id);
      const contact = (await liveContacts(x.id))[0]!;
      if (!(v instanceof AccountError)) {
        expect(v, `round ${round}`).toMatchObject({ changed: true });
        expect(s).toBeInstanceOf(AccountError);
        expect((s as AccountError).code).toBe('PHONE_NOT_PENDING');
        expect(contact).toMatchObject({ status: 'VERIFIED', is_primary: true });
        expect(open).toEqual([]);
        expect(textsTo(x.phone)).toHaveLength(1);
      } else {
        expect(v.code, `round ${round}`).toBe('PHONE_CODE_USED');
        expect(s, `round ${round}`).not.toBeInstanceOf(AccountError);
        expect(contact.status).toBe('PENDING');
        expect(open).toHaveLength(1);
        expect(textsTo(x.phone)).toHaveLength(2);
        expect((await ph.confirmCode(x.id, codeOf(textsTo(x.phone)[1]!))).changed).toBe(true);
      }
      expect(await auditOf(x.id, 'PHONE_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
    }
    await expectPhoneInvariants();
  });

  it('two simultaneous sends leave exactly one open challenge, and the code of that challenge verifies', async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, phone);
    const results = await Promise.all([settled(ph.sendVerification(id)), settled(ph.sendVerification(id))]);
    for (const r of results) if (r instanceof AccountError) expect(['PHONE_RESEND_TOO_SOON', 'CONFLICT']).toContain(r.code);
    const open = (await challengesOf(id)).filter((c) => c.used_at === null && c.invalidated_at === null);
    expect(open).toHaveLength(1);
    const winner = textsTo(phone).find((m) => hashPhoneCode(testHashKey, open[0]!.challenge_id, codeOf(m)) === open[0]!.code_hash);
    expect(winner, 'the message of the open challenge was sent').toBeDefined();
    expect((await ph.confirmCode(id, codeOf(winner!))).changed).toBe(true);
    await expectPhoneInvariants();
  });

  it('a resend while the first delivery is still in flight supersedes it: one open challenge, the newest SMS verifies, the older code is dead', async () => {
    setPolicy({ resendSeconds: 0 });
    const gated = new GatedSender();
    const svc = makeService({ sender: gated });
    const id = await newAccount();
    await svc.setPhone(id, usNumber());
    const release = gated.holdNext();
    const first = settled(svc.sendVerification(id)); // its challenge is committed, its delivery hangs
    for (let i = 0; i < 500 && gated.seen.length < 1; i++) await sleep(10);
    expect(gated.seen).toHaveLength(1);
    await svc.sendVerification(id); // supersedes the first challenge while the first SMS is still being delivered
    release();
    const firstResult = await first;
    expect(firstResult instanceof Error ? firstResult instanceof AccountError : true, 'no raw error escapes').toBe(true);
    expect(gated.seen).toHaveLength(2);

    const [older, newer] = await challengesOf(id);
    expect(older).toMatchObject({ invalidation_reason: 'SUPERSEDED', used_at: null });
    expect(newer).toMatchObject({ invalidation_reason: null, used_at: null, delivery_status: 'SENT' });
    expect(await openChallenges(id)).toHaveLength(1);
    expect(await eventsOf(id, E.verificationSent)).toHaveLength(1); // the superseded delivery emits no Sent event
    const [oldText, newText] = gated.seen;
    expect(hashPhoneCode(testHashKey, older!.challenge_id, codeOf(oldText!))).toBe(older!.code_hash);
    expect(hashPhoneCode(testHashKey, newer!.challenge_id, codeOf(newText!))).toBe(newer!.code_hash);
    await fails(svc.confirmCode(id, codeOf(oldText!)), 'PHONE_CODE_USED');
    expect((await svc.confirmCode(id, codeOf(newText!))).changed).toBe(true);
    await expectPhoneInvariants();
  });

  it('verifying two different candidates concurrently never makes both primary: only the open candidate can verify (6 rounds)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 6; round++) {
      const first = await pendingWithSms({ phone: usNumber() });
      const second = await pendingWithSms({ id: first.id, phone: usNumber() }); // supersedes the first candidate
      const [a, b] = await Promise.all([settled(ph.confirmCode(first.id, first.code)), settled(ph.confirmCode(first.id, second.code))]);
      const verified = [a, b].filter((r) => !(r instanceof AccountError) && r.changed);
      expect(verified, `round ${round}`).toHaveLength(1);
      const live = await liveContacts(first.id);
      expect(live.map((c) => [c.phone_e164, c.status, c.is_primary])).toEqual([[second.phone, 'VERIFIED', true]]);
      expect((await contactOf(first.id, first.phone)).status).toBe('DISABLED');
      expect(await auditOf(first.id, 'PHONE_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(first.id, E.verified)).toHaveLength(1);
    }
    await expectPhoneInvariants();
  });

  it('two concurrent setPhone with different numbers leave exactly ONE open candidate and no raw error (6 rounds, with and without a primary)', async () => {
    for (let round = 0; round < 6; round++) {
      const withPrimary = round % 2 === 1;
      const id = withPrimary ? (await verifiedAccount()).id : await newAccount();
      const [a, b] = [usNumber(), usNumber()];
      const results = await Promise.all([settled(ph.setPhone(id, a)), settled(ph.setPhone(id, b))]);
      for (const r of results) {
        if (r instanceof AccountError) {
          expect(r.code, `round ${round}`).toBe('CONFLICT');
          expect(r.details.retryable).toBe(true);
        } else {
          expect(r, `round ${round}: ${String(r)}`).toHaveProperty('changed');
        }
      }
      const live = await liveContacts(id);
      expect(live.filter((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING')).toHaveLength(1);
      expect(live.filter((c) => c.is_primary)).toHaveLength(withPrimary ? 1 : 0);
      expect([a, b]).toContain(live.find((c) => !c.is_primary)!.phone_e164);
      expect(live.find((c) => !c.is_primary)!.status).toBe(withPrimary ? 'REPLACEMENT_PENDING' : 'PENDING');
    }
    await expectPhoneInvariants();
  });

  it('two concurrent setPhone with the SAME number create one contact (no unique-index error leaks)', async () => {
    for (let round = 0; round < 4; round++) {
      const id = await newAccount();
      const phone = usNumber();
      const results = await Promise.all([settled(ph.setPhone(id, phone)), settled(ph.setPhone(id, phone))]);
      for (const r of results) if (r instanceof AccountError) expect(r.code).toBe('CONFLICT');
      expect((await liveContacts(id)).map((c) => c.phone_e164)).toEqual([phone]);
      expect(results.filter((r) => !(r instanceof AccountError) && r.changed)).toHaveLength(1);
    }
    await expectPhoneInvariants();
  });

  it('a replacement racing the verification of the pending number never leaves two primaries or two candidates (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithSms();
      const next = usNumber();
      const [c, s] = await Promise.all([settled(ph.confirmCode(x.id, x.code)), settled(ph.setPhone(x.id, next))]);
      expect(s, `round ${round}`).not.toBeInstanceOf(Error);
      const live = await liveContacts(x.id);
      expect(live.filter((l) => l.is_primary).length).toBeLessThanOrEqual(1);
      expect(live.filter((l) => l.status === 'PENDING' || l.status === 'REPLACEMENT_PENDING')).toHaveLength(1);
      if (!(c instanceof AccountError)) {
        expect(live.find((l) => l.is_primary)!.phone_e164).toBe(x.phone);
        expect(live.find((l) => l.status === 'REPLACEMENT_PENDING')!.phone_e164).toBe(next);
      } else {
        expect(['PHONE_CODE_INVALID', 'PHONE_CODE_USED']).toContain(c.code);
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({ phone_e164: next, status: 'PENDING' });
        expect(await auditOf(x.id, 'PHONE_VERIFIED')).toEqual([]);
      }
    }
    await expectPhoneInvariants();
  });

  it('a setPhone queued behind a replacement of the number it saw as pending re-checks the line type before storing it (deterministic)', async () => {
    const x = await pendingWithSms();
    const y = usNumber();
    const callsBefore = intel.calls.length;
    const [first, second] = await inOrder(
      x.id,
      () => ph.setPhone(x.id, y),
      () => ph.setPhone(x.id, x.phone),
    );
    expect(first).toMatchObject({ changed: true });
    expect(second).toMatchObject({ changed: true });
    const live = await liveContacts(x.id);
    expect(live.map((c) => c.phone_e164)).toEqual([x.phone]);
    expect(live[0]).toMatchObject({ status: 'PENDING', line_type: 'MOBILE' });
    // y was classified once; x had to be classified again because its old row was superseded before the second call took the lock
    expect(intel.calls.slice(callsBefore).map((c) => c.e164)).toEqual([y, x.phone]);
    await expectPhoneInvariants();
  });
});

// ====================================================================== the same number on several accounts
describe('the same verified number on several accounts (accounts-per-number maximum)', () => {
  const NOT_AVAILABLE = { reason: 'NUMBER_UNAVAILABLE' };

  /** Verifies a rival's pending contact inside an OPEN transaction that also holds the advisory lock of the number, runs `during`, then commits. */
  async function withRivalHoldingNumber<T>(rivalId: string, phone: string, during: () => Promise<T>): Promise<T> {
    const rivalContact = (await liveContacts(rivalId))[0]!.phone_contact_id;
    const holder = await db().pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`phone:${phone}`]);
      await holder.query(
        `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE phone_contact_id = $1`,
        [rivalContact],
      );
      await holder.query(
        `UPDATE identity.phone_verification_challenges SET used_at = clock_timestamp() WHERE phone_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [rivalContact],
      );
      const running = during();
      await lockWaiters(1); // the service waits on the advisory lock of the number: it already passed its own checks
      await holder.query('COMMIT');
      return await running;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  it('B can set and send a number that A has VERIFIED, with the same answers as for a fresh number and no error', async () => {
    const a = await verifiedAccount();
    const bId = await newAccount();
    const cId = await newAccount();
    const freshSet = await ph.setPhone(cId, usNumber());
    const freshSend = await ph.sendVerification(cId);

    const takenSet = await ph.setPhone(bId, a.phone);
    expect(takenSet.changed).toBe(true);
    const takenSend = await ph.sendVerification(bId);
    expect(shapeOf(takenSet)).toEqual(shapeOf(freshSet));
    expect(shapeOf(takenSend)).toEqual(shapeOf(freshSend));
    expect(takenSet.phone).toMatchObject({
      phoneVerificationStatus: 'PENDING',
      primary: null,
      pending: { status: 'PENDING', purpose: 'INITIAL_PHONE', maskedPhone: maskPhone(a.phone), countryCode: 'US' },
    });
    expect(takenSend).toMatchObject({ codeLength: 6, validityMinutes: 10 });
    // the owner sees nothing of it
    expect((await liveContacts(a.id)).map((c) => c.status)).toEqual(['VERIFIED']);
    expect(textsTo(a.phone)).toHaveLength(2);
  });

  it('a number held by a CLOSED account is free again (a recycled number): B verifies it, the service count and the guard trigger agree (ID-003 review)', async () => {
    const a = await verifiedAccount();
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    await accounts.changeStatus(a.id, 'CLOSED', OP);
    const b = await pendingWithSms({ phone: a.phone });
    const result = await ph.confirmCode(b.id, b.code);
    expect(result.changed).toBe(true);
    expect((await accounts.getAccountContext(b.id)).phone.phoneVerificationStatus).toBe('VERIFIED');
  });

  it('a number held by a SUSPENDED account still counts as held: B gets PHONE_UNAVAILABLE', async () => {
    const a = await verifiedAccount();
    await accounts.changeStatus(a.id, 'SUSPENDED', OP);
    const b = await pendingWithSms({ phone: a.phone });
    await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
  });

  it('B confirming with the correct code gets PHONE_UNAVAILABLE (NUMBER_UNAVAILABLE), stays PENDING, and nothing is verified or written', async () => {
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    const beforeB = await snapshot(b.id);
    const beforeA = await snapshot(a.id);
    const world = await phoneWorld();
    const e = await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
    const text = JSON.stringify({ m: e.message, d: e.details });
    expect(text).not.toContain(a.id);
    for (const v of numberVariants(a.phone)) expect(text).not.toContain(v);
    expect(await snapshot(b.id)).toEqual(beforeB);
    expect(await snapshot(a.id)).toEqual(beforeA);
    expect(await phoneWorld()).toEqual(world);
    expect((await liveContacts(b.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false, verified_at: null });
    expect(await auditOf(b.id, 'PHONE_VERIFIED')).toEqual([]);
    expect(await eventsOf(b.id, E.verified)).toEqual([]);
    expect((await challengesOf(b.id))[0]).toMatchObject({ used_at: null, invalidated_at: null, attempt_count: 0 });
    expect((await accounts.getAccountContext(b.id)).phone.phoneVerificationStatus).toBe('PENDING');
    expect(await holdersOf(a.phone)).toBe(1);
  });

  it('...in whatever spelling the second account entered the number', async () => {
    const a = await verifiedAccount();
    const id = await newAccount();
    await ph.setPhone(id, nationalUs(a.phone), { country: 'US' });
    await ph.sendVerification(id);
    await fails(ph.confirmCode(id, codeOf(textsTo(a.phone).at(-1)!)), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
  });

  it('nothing is revealed BEFORE the code is proven: a wrong code on B is the same PHONE_CODE_INVALID as for a free number', async () => {
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    const c = await pendingWithSms();
    const onTaken = await fails(ph.confirmCode(b.id, wrongCode(b.code)), 'PHONE_CODE_INVALID');
    const onFree = await fails(ph.confirmCode(c.id, wrongCode(c.code)), 'PHONE_CODE_INVALID');
    expect(onTaken.message).toBe(onFree.message);
    expect(onTaken.details).toEqual(onFree.details);
  });

  it('the lock after five wrong codes is identical for a taken and a free number', async () => {
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    const c = await pendingWithSms();
    const outcomes: AccountError[] = [];
    for (const x of [b, c]) {
      for (let i = 0; i < 4; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
      outcomes.push(await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_VERIFICATION_LOCKED'));
    }
    expect(outcomes[0]!.message).toBe(outcomes[1]!.message);
    expect(outcomes[0]!.details).toEqual(outcomes[1]!.details);
  });

  it('B can recover: a different number verifies normally after the refusal', async () => {
    setPolicy({ resendSeconds: 0 });
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE');
    const other = await pendingWithSms({ id: b.id, phone: usNumber() });
    expect((await ph.confirmCode(b.id, other.code)).changed).toBe(true);
    expect((await accounts.getAccountContext(b.id)).phone.primary).toMatchObject({ maskedPhone: maskPhone(other.phone) });
  });

  it('a verified number is released when its owner replaces it: the other account can then verify it with the code it already has', async () => {
    setPolicy({ resendSeconds: 0 });
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE');
    const move = await pendingWithSms({ id: a.id, phone: usNumber() });
    await ph.confirmCode(a.id, move.code);
    expect((await contactOf(a.id, a.phone)).status).toBe('DISABLED');
    expect(await holdersOf(a.phone)).toBe(0);
    expect((await ph.confirmCode(b.id, b.code)).changed).toBe(true);
    expect((await contactOf(b.id, a.phone)).status).toBe('VERIFIED');
    expect(await holdersOf(a.phone)).toBe(1);
  });

  it.each([
    ['A verifies first', true],
    ['B verifies first', false],
  ])('two pending accounts with the same number, %s: the first wins, the second gets PHONE_UNAVAILABLE and stays PENDING', async (_name, aFirst) => {
    const shared = usNumber();
    const a = await pendingWithSms({ phone: shared });
    const b = await pendingWithSms({ phone: shared });
    const [first, second] = aFirst ? [a, b] : [b, a];
    expect((await ph.confirmCode(first.id, first.code)).changed).toBe(true);
    await fails(ph.confirmCode(second.id, second.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
    expect((await liveContacts(second.id))[0]!.status).toBe('PENDING');
    expect((await liveContacts(first.id))[0]!.status).toBe('VERIFIED');
    expect(await auditOf(second.id, 'PHONE_VERIFIED')).toEqual([]);
  });

  it('pending claims are never counted: a PENDING claim on A does not stop B from verifying, and A is refused afterwards', async () => {
    const shared = usNumber();
    const a = await pendingWithSms({ phone: shared });
    const b = await pendingWithSms({ phone: shared });
    expect((await ph.confirmCode(b.id, b.code)).changed).toBe(true);
    await fails(ph.confirmCode(a.id, a.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
  });

  it('the same account is not counted against itself: re-submitting its own verified number is a no-op', async () => {
    const a = await verifiedAccount();
    const r = await ph.setPhone(a.id, a.phone);
    expect(r.changed).toBe(false);
    expect(await holdersOf(a.phone)).toBe(1);
  });

  it('two accounts verifying the same number concurrently: exactly one VERIFIED, the loser gets PHONE_UNAVAILABLE (8 rounds)', async () => {
    for (let round = 0; round < 8; round++) {
      const shared = usNumber();
      const a = await pendingWithSms({ phone: shared });
      const b = await pendingWithSms({ phone: shared });
      const results = await Promise.all([settled(ph.confirmCode(a.id, a.code)), settled(ph.confirmCode(b.id, b.code))]);
      const winners = results.filter((r) => !(r instanceof AccountError));
      const losers = results.filter((r) => r instanceof AccountError) as AccountError[];
      expect(winners, `round ${round}`).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.code).toBe('PHONE_UNAVAILABLE');
      expect(losers[0]!.details).toEqual(NOT_AVAILABLE);
      expect(await holdersOf(shared)).toBe(1);
      const loser = results[0] instanceof AccountError ? a : b;
      expect(await auditOf(loser.id, 'PHONE_VERIFIED')).toEqual([]);
      expect(await eventsOf(loser.id, E.verified)).toEqual([]);
      expect((await liveContacts(loser.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
      expect(await openChallenges(loser.id)).toHaveLength(1);
    }
    await expectPhoneInvariants();
  });

  it('the loser of a race for a number keeps its old verified primary: the replacement is rolled back as a whole (8 rounds)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 8; round++) {
      const owner = await verifiedAccount();
      const shared = usNumber();
      const change = await pendingWithSms({ id: owner.id, phone: shared });
      const rival = await pendingWithSms({ phone: shared });
      const start =
        round % 2 === 0
          ? [ph.confirmCode(owner.id, change.code), ph.confirmCode(rival.id, rival.code)]
          : [ph.confirmCode(rival.id, rival.code), ph.confirmCode(owner.id, change.code)];
      const results = await Promise.all(start.map(settled));
      const [ownerResult, rivalResult] = round % 2 === 0 ? results : [results[1], results[0]];
      expect(await holdersOf(shared), `round ${round}`).toBe(1);
      const live = (await liveContacts(owner.id)).map((c) => [c.phone_e164, c.status, c.is_primary]);
      if (ownerResult instanceof AccountError) {
        expect(ownerResult.code).toBe('PHONE_UNAVAILABLE');
        expect(rivalResult).toMatchObject({ changed: true });
        expect(live).toEqual([
          [owner.phone, 'VERIFIED', true],
          [shared, 'REPLACEMENT_PENDING', false],
        ]);
        expect(await contactOf(owner.id, owner.phone)).toMatchObject({ disabled_at: null, disabled_reason: null });
        expect(await auditOf(owner.id, 'PHONE_PRIMARY_CHANGED')).toEqual([]);
        expect(await auditOf(owner.id, 'PHONE_VERIFIED')).toHaveLength(1);
        expect(await eventsOf(owner.id, E.verified)).toHaveLength(1);
        expect(await openChallenges(owner.id)).toHaveLength(1);
      } else {
        expect(ownerResult).toMatchObject({ changed: true });
        expect(rivalResult).toBeInstanceOf(AccountError);
        expect((rivalResult as AccountError).code).toBe('PHONE_UNAVAILABLE');
        expect(live).toEqual([[shared, 'VERIFIED', true]]);
        expect(await auditOf(owner.id, 'PHONE_PRIMARY_CHANGED')).toHaveLength(1);
        expect((await liveContacts(rival.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
      }
    }
    await expectPhoneInvariants();
  });

  it('a verification waits for the advisory lock of the number, then re-counts: the late account is refused and its change is rolled back (deterministic)', async () => {
    setPolicy({ resendSeconds: 0 });
    const owner = await verifiedAccount();
    const shared = usNumber();
    const change = await pendingWithSms({ id: owner.id, phone: shared });
    const rival = await pendingWithSms({ phone: shared });
    const before = await contactOf(owner.id, owner.phone);
    const outcome = await withRivalHoldingNumber(rival.id, shared, () => settled(ph.confirmCode(owner.id, change.code)));
    expect(outcome).toBeInstanceOf(AccountError);
    expect((outcome as AccountError).code).toBe('PHONE_UNAVAILABLE');
    expect((outcome as AccountError).details).toEqual(NOT_AVAILABLE);
    expect(await contactOf(owner.id, owner.phone)).toEqual(before); // still VERIFIED and primary, never disabled
    expect((await liveContacts(owner.id)).map((c) => [c.phone_e164, c.status, c.is_primary])).toEqual([
      [owner.phone, 'VERIFIED', true],
      [shared, 'REPLACEMENT_PENDING', false],
    ]);
    expect(await auditOf(owner.id, 'PHONE_PRIMARY_CHANGED')).toEqual([]);
    expect(await auditOf(owner.id, 'PHONE_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(owner.id, E.verified)).toHaveLength(1);
    expect(await openChallenges(owner.id)).toHaveLength(1);
    expect((await challengesOf(owner.id)).at(-1)).toMatchObject({ used_at: null, attempt_count: 0 });
    await expectPhoneInvariants();
  });

  it('...and in a first verification the contact stays PENDING with its open challenge (deterministic)', async () => {
    const shared = usNumber();
    const loser = await pendingWithSms({ phone: shared });
    const rival = await pendingWithSms({ phone: shared });
    const before = await snapshot(loser.id);
    const outcome = await withRivalHoldingNumber(rival.id, shared, () => settled(ph.confirmCode(loser.id, loser.code)));
    expect(outcome).toBeInstanceOf(AccountError);
    expect((outcome as AccountError).code).toBe('PHONE_UNAVAILABLE');
    expect(await snapshot(loser.id)).toEqual(before);
  });

  it('...while a verification of ANOTHER number is not held up by the lock of this number', async () => {
    const shared = usNumber();
    const rival = await pendingWithSms({ phone: shared });
    const free = await pendingWithSms();
    const rivalContact = (await liveContacts(rival.id))[0]!.phone_contact_id;
    const holder = await db().pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`phone:${shared}`]);
      await holder.query(
        `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE phone_contact_id = $1`,
        [rivalContact],
      );
      await holder.query(
        `UPDATE identity.phone_verification_challenges SET used_at = clock_timestamp() WHERE phone_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [rivalContact],
      );
      // returns while the other transaction (and its advisory lock) is still open
      expect((await ph.confirmCode(free.id, free.code)).changed).toBe(true);
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await contactOf(free.id, free.phone)).status).toBe('VERIFIED');
  });

  describe('a policy maximum above 1', () => {
    it('with maxAccountsPerNumber 2 two accounts verify the number and the third is refused', async () => {
      setPolicy({ maxAccountsPerNumber: 2 });
      const shared = usNumber();
      const [a, b, c] = [await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared })];
      expect((await ph.confirmCode(a.id, a.code)).changed).toBe(true);
      expect((await ph.confirmCode(b.id, b.code)).changed).toBe(true);
      expect(await holdersOf(shared)).toBe(2);
      const beforeC = await snapshot(c.id);
      await fails(ph.confirmCode(c.id, c.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
      expect(await snapshot(c.id)).toEqual(beforeC);
      expect(await holdersOf(shared)).toBe(2);
    });

    it('raising the maximum later lets the refused account verify with the code it already has', async () => {
      const shared = usNumber();
      const a = await pendingWithSms({ phone: shared });
      const b = await pendingWithSms({ phone: shared });
      await ph.confirmCode(a.id, a.code);
      await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE');
      setPolicy({ maxAccountsPerNumber: 2 });
      expect((await ph.confirmCode(b.id, b.code)).changed).toBe(true);
      expect(await holdersOf(shared)).toBe(2);
    });

    it('lowering the maximum later keeps the existing holders and refuses the next one', async () => {
      setPolicy({ maxAccountsPerNumber: 2 });
      const shared = usNumber();
      const [a, b, c] = [await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared })];
      await ph.confirmCode(a.id, a.code);
      await ph.confirmCode(b.id, b.code);
      setPolicy({ maxAccountsPerNumber: 1 });
      await fails(ph.confirmCode(c.id, c.code), 'PHONE_UNAVAILABLE', NOT_AVAILABLE);
      expect(await holdersOf(shared)).toBe(2);
      expect((await contactOf(a.id, shared)).status).toBe('VERIFIED');
      expect((await contactOf(b.id, shared)).status).toBe('VERIFIED');
    });

    it('a holder that replaces its number frees a slot for the next account', async () => {
      setPolicy({ maxAccountsPerNumber: 2, resendSeconds: 0 });
      const shared = usNumber();
      const [a, b, c] = [await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared }), await pendingWithSms({ phone: shared })];
      await ph.confirmCode(a.id, a.code);
      await ph.confirmCode(b.id, b.code);
      await fails(ph.confirmCode(c.id, c.code), 'PHONE_UNAVAILABLE');
      const move = await pendingWithSms({ id: a.id, phone: usNumber() });
      await ph.confirmCode(a.id, move.code);
      expect((await ph.confirmCode(c.id, c.code)).changed).toBe(true);
      expect(await holdersOf(shared)).toBe(2);
    });

    it.each([
      [2, 5],
      [3, 6],
      [1, 4],
    ])(
      'RACE: with maximum %i, %i accounts verifying one number at once leave exactly the maximum as holders and refuse the rest (no deadlock)',
      async (max, accountCount) => {
        setPolicy({ maxAccountsPerNumber: max });
        for (let round = 0; round < 3; round++) {
          const shared = usNumber();
          const contenders: Issued[] = [];
          for (let i = 0; i < accountCount; i++) contenders.push(await pendingWithSms({ phone: shared }));
          const results = await Promise.all(contenders.map((c) => settled(ph.confirmCode(c.id, c.code))));
          const winners = results.filter((r) => !(r instanceof AccountError));
          const losers = results.filter((r) => r instanceof AccountError) as AccountError[];
          expect(winners, `round ${round}`).toHaveLength(max);
          expect(losers).toHaveLength(accountCount - max);
          for (const l of losers) {
            expect(l.code, `unexpected error ${l.code}`).toBe('PHONE_UNAVAILABLE');
            expect(l.details).toEqual(NOT_AVAILABLE);
          }
          expect(await holdersOf(shared)).toBe(max);
          for (let i = 0; i < accountCount; i++) {
            const state = (await liveContacts(contenders[i]!.id))[0]!;
            expect(state.status).toBe(results[i] instanceof AccountError ? 'PENDING' : 'VERIFIED');
          }
        }
        await expectPhoneInvariants();
      },
    );

    it('the maximum is read per number: two different numbers fill their own slots independently', async () => {
      setPolicy({ maxAccountsPerNumber: 2 });
      const [n1, n2] = [usNumber(), usNumber()];
      const issued = [
        await pendingWithSms({ phone: n1 }),
        await pendingWithSms({ phone: n2 }),
        await pendingWithSms({ phone: n1 }),
        await pendingWithSms({ phone: n2 }),
      ];
      const results = await Promise.all(issued.map((x) => ph.confirmCode(x.id, x.code)));
      expect(results.every((r) => r.changed)).toBe(true);
      expect(await holdersOf(n1)).toBe(2);
      expect(await holdersOf(n2)).toBe(2);
    });
  });

  describe('the guard trigger enforces the maximum again', () => {
    async function pendingOn(phone: string, count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = await newAccount();
        await ph.setPhone(id, phone);
        ids.push(id);
      }
      return ids;
    }
    const verifyRaw = (client: { query: (t: string, p?: unknown[]) => Promise<unknown> }, accountId: string) =>
      client.query(
        `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
        [accountId],
      );

    it('a writer that does not pass the policy value is held to the structural ceiling of 5 accounts per number', async () => {
      const shared = usNumber();
      const ids = await pendingOn(shared, 6);
      for (const id of ids.slice(0, 5))
        await q(
          `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
          [id],
        );
      expect(await holdersOf(shared)).toBe(5);
      const e = (await rejection(
        q(
          `UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE account_id = $1 AND status = 'PENDING'`,
          [ids[5]],
        ),
      )) as { code?: string; detail?: string };
      expect(e.code).toBe('23000');
      expect(e.detail).toContain('identity_rule:PHONE_NUMBER_CAP');
      expect(await holdersOf(shared)).toBe(5);
    });

    it('the transaction setting app.phone_max_accounts lowers the ceiling: with 2 the third account is refused', async () => {
      const shared = usNumber();
      const ids = await pendingOn(shared, 3);
      const client = await db().pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.phone_max_accounts', '2', true)`);
        await verifyRaw(client, ids[0]!);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.phone_max_accounts', '2', true)`);
        await verifyRaw(client, ids[1]!);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.phone_max_accounts', '2', true)`);
        const e = (await rejection(verifyRaw(client, ids[2]!))) as { code?: string; detail?: string };
        expect(e.code).toBe('23000');
        expect(e.detail).toContain('identity_rule:PHONE_NUMBER_CAP');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await holdersOf(shared)).toBe(2);
    });

    it('a setting outside 1 to 5 is ignored (the structural ceiling applies)', async () => {
      const shared = usNumber();
      const ids = await pendingOn(shared, 2);
      const client = await db().pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.phone_max_accounts', '99', true)`);
        await verifyRaw(client, ids[0]!);
        await verifyRaw(client, ids[1]!);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await holdersOf(shared)).toBe(2);
    });
  });
});

// ====================================================================== line type, the vendor lookup and the market policy
describe('line type policy and the vendor lookup', () => {
  const REFUSED = { reason: 'LINE_POLICY' };

  it('a VIRTUAL (902) and a HIGH_RISK (904) number are PHONE_NOT_ACCEPTED with the default policy: NOTHING stored and no SMS', async () => {
    for (const suffix of ['902', '904'] as const) {
      const id = await newAccount();
      const before = await snapshot(id);
      const world = await phoneWorld();
      await fails(ph.setPhone(id, usNumberEnding(suffix)), 'PHONE_NOT_ACCEPTED', REFUSED);
      expect(await snapshot(id)).toEqual(before);
      expect(await phoneWorld()).toEqual(world);
      await fails(ph.sendVerification(id), 'PHONE_NOT_PENDING');
      expect(sms.sent).toEqual([]);
    }
  });

  it('VOIP (901) and LANDLINE (903) are accepted by the default policy and the snapshot is stored', async () => {
    for (const [suffix, lineType] of [
      ['901', 'VOIP'],
      ['903', 'LANDLINE'],
    ] as const) {
      const id = await newAccount();
      const phone = usNumberEnding(suffix);
      await ph.setPhone(id, phone);
      const [c] = await contactsOf(id);
      expect(c).toMatchObject({ phone_e164: phone, line_type: lineType, status: 'PENDING' });
      expect(c!.line_type_checked_at).toBeInstanceOf(Date);
      expect((await audit(id))[0]!.changes).toMatchObject({ lineType });
    }
  });

  it('VOIP, VIRTUAL and HIGH_RISK are refused when the policy blocks them (901, 902, 904), LANDLINE (903) stays accepted', async () => {
    setPolicy({ blockedLineTypes: ['VOIP', 'VIRTUAL', 'HIGH_RISK'] });
    for (const suffix of ['901', '902', '904'] as const) await fails(ph.setPhone(await newAccount(), usNumberEnding(suffix)), 'PHONE_NOT_ACCEPTED', REFUSED);
    const id = await newAccount();
    expect((await ph.setPhone(id, usNumberEnding('903'))).changed).toBe(true);
    expect((await contactsOf(id))[0]!.line_type).toBe('LANDLINE');
  });

  it('LANDLINE (903) is refused when the policy blocks LANDLINE', async () => {
    setPolicy({ blockedLineTypes: ['LANDLINE'] });
    const id = await newAccount();
    await fails(ph.setPhone(id, usNumberEnding('903')), 'PHONE_NOT_ACCEPTED', REFUSED);
    expect(await contactsOf(id)).toEqual([]);
    // the same list accepts a MOBILE number
    expect((await ph.setPhone(id, usNumber())).changed).toBe(true);
  });

  const LINE_TYPES: [string, '901' | '902' | '903' | '904', 'VOIP' | 'VIRTUAL' | 'LANDLINE' | 'HIGH_RISK'][] = [
    ['VOIP', '901', 'VOIP'],
    ['VIRTUAL', '902', 'VIRTUAL'],
    ['LANDLINE', '903', 'LANDLINE'],
    ['HIGH_RISK', '904', 'HIGH_RISK'],
  ];
  it.each(LINE_TYPES)(
    '%s: refused when it is the ONLY blocked type, accepted (with the snapshot) when every OTHER type is blocked',
    async (_name, suffix, lineType) => {
      const all = ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] as const;
      setPolicy({ blockedLineTypes: [lineType] });
      await fails(ph.setPhone(await newAccount(), usNumberEnding(suffix)), 'PHONE_NOT_ACCEPTED', REFUSED);
      setPolicy({ blockedLineTypes: all.filter((t) => t !== lineType) });
      const id = await newAccount();
      await ph.setPhone(id, usNumberEnding(suffix));
      expect((await contactsOf(id))[0]!.line_type).toBe(lineType);
    },
  );

  it('a MOBILE number is accepted even when every blockable type is blocked (MOBILE is never blockable)', async () => {
    setPolicy({ blockedLineTypes: ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    expect((await contactsOf(id))[0]!.line_type).toBe('MOBILE');
  });

  it('an UNKNOWN classification is accepted by the default policy and refused when UNKNOWN is blocked', async () => {
    intel.hook = async () => ({ lineType: 'UNKNOWN' });
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    expect((await contactsOf(id))[0]!.line_type).toBe('UNKNOWN');
    setPolicy({ blockedLineTypes: ['UNKNOWN'] });
    await fails(ph.setPhone(await newAccount(), usNumber()), 'PHONE_NOT_ACCEPTED', REFUSED);
  });

  it('a refused number writes no audit row, no event, no contact and does not touch an existing pending number', async () => {
    const x = await pendingWithSms();
    const before = await snapshot(x.id);
    const world = await phoneWorld();
    await fails(ph.setPhone(x.id, usNumberEnding('902')), 'PHONE_NOT_ACCEPTED', REFUSED);
    expect(await snapshot(x.id)).toEqual(before);
    expect(await phoneWorld()).toEqual(world);
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('the refusal does not say which type the number has (no line type in the error)', async () => {
    const e = await fails(ph.setPhone(await newAccount(), usNumberEnding('904')), 'PHONE_NOT_ACCEPTED');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/HIGH_RISK|VIRTUAL|VOIP|LANDLINE|MOBILE/);
  });

  it('a lookup failure (905) is PHONE_RISK_UNAVAILABLE, retryable: nothing stored, no SMS, no number in the log', async () => {
    const id = await newAccount();
    const phone = usNumberEnding('905');
    const before = await snapshot(id);
    const world = await phoneWorld();
    await fails(ph.setPhone(id, phone), 'PHONE_RISK_UNAVAILABLE', { retryable: true });
    expect(await snapshot(id)).toEqual(before);
    expect(await phoneWorld()).toEqual(world);
    expect(sms.sent).toEqual([]);
    expect(logSink.lines.join('\n')).toContain('line-type lookup failed');
    for (const v of numberVariants(phone)) expect(logSink.lines.join('\n')).not.toContain(v);
  });

  it('a lookup failure does not leave the account in a different state than before (a pending number stays, and works)', async () => {
    const x = await pendingWithSms();
    await fails(ph.setPhone(x.id, usNumberEnding('905')), 'PHONE_RISK_UNAVAILABLE');
    expect((await liveContacts(x.id)).map((c) => c.phone_e164)).toEqual([x.phone]);
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('the number is retried successfully once the vendor answers again', async () => {
    const id = await newAccount();
    const phone = usNumberEnding('905');
    await fails(ph.setPhone(id, phone), 'PHONE_RISK_UNAVAILABLE');
    intel.hook = async () => ({ lineType: 'MOBILE' });
    expect((await ph.setPhone(id, phone)).changed).toBe(true);
    expect((await contactsOf(id))[0]).toMatchObject({ phone_e164: phone, line_type: 'MOBILE' });
  });

  it('an EMPTY blocked list makes no lookup at all, stores line_type NULL, accepts every type and writes no lineType in the audit row', async () => {
    setPolicy({ blockedLineTypes: [] });
    for (const suffix of ['901', '902', '903', '904', '905'] as const) {
      const id = await newAccount();
      const phone = usNumberEnding(suffix);
      await ph.setPhone(id, phone);
      const [c] = await contactsOf(id);
      expect(c).toMatchObject({ phone_e164: phone, line_type: null, line_type_checked_at: null, status: 'PENDING' });
      expect((await audit(id))[0]!.changes).not.toHaveProperty('lineType');
    }
    expect(intel.calls).toEqual([]);
  });

  it('with an empty blocked list the whole flow works without a vendor: send and confirm never call it either', async () => {
    setPolicy({ blockedLineTypes: [] });
    intel.hook = async () => {
      throw new Error('the vendor must not be called');
    };
    const x = await pendingWithSms({ phone: usNumberEnding('902') });
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
    expect(intel.calls).toEqual([]);
  });

  it("no lookup for a number that is already the account's pending number", async () => {
    const id = await newAccount();
    const phone = usNumber();
    await ph.setPhone(id, phone);
    expect(intel.calls).toHaveLength(1);
    await ph.setPhone(id, phone);
    await ph.setPhone(id, nationalUs(phone), { country: 'US' });
    expect(intel.calls).toHaveLength(1);
  });

  it("no lookup for a number that is already the account's primary number (withdrawing a pending change)", async () => {
    const p = await verifiedAccount();
    await ph.setPhone(p.id, usNumber());
    const calls = intel.calls.length;
    await ph.setPhone(p.id, p.phone);
    await ph.setPhone(p.id, p.phone);
    expect(intel.calls.length).toBe(calls);
  });

  it('a number added while nothing was blocked is not looked up later either: it stays accepted when the list grows (no snapshot, never blocked)', async () => {
    setPolicy({ blockedLineTypes: [] });
    const id = await newAccount();
    const phone = usNumberEnding('902');
    await ph.setPhone(id, phone);
    setPolicy({ blockedLineTypes: ['VIRTUAL'] });
    expect((await ph.setPhone(id, phone)).changed).toBe(false); // known number: no lookup, no PHONE_RISK_UNAVAILABLE, no refusal
    const sent = await ph.sendVerification(id);
    expect(sent.codeLength).toBe(6);
    expect(intel.calls).toEqual([]);
    expect((await ph.confirmCode(id, codeOf(sms.sent[0]!))).changed).toBe(true);
  });

  it('asks the vendor with the E.164 number and the country of the number', async () => {
    countries.activate('GB', '+44');
    countries.activate('CA', '+1');
    const [us, gb, ca] = [usNumber(), gbNumber(), caNumber()];
    await ph.setPhone(await newAccount(), us);
    await ph.setPhone(await newAccount(), gb);
    await ph.setPhone(await newAccount(), ca);
    expect(intel.calls).toEqual([
      { e164: us, country: 'US' },
      { e164: gb, country: 'GB' },
      { e164: ca, country: 'CA' },
    ]);
  });

  it('asks the vendor exactly once per number added, outside any transaction (no lock is held while the vendor answers)', async () => {
    const id = await newAccount();
    let lockFree = false;
    intel.hook = async () => {
      // a NOWAIT row lock fails with 55P03 if any transaction of the service holds the account row
      await q('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE NOWAIT', [id]);
      lockFree = (await contactsOf(id)).length === 0;
      return { lineType: 'MOBILE' };
    };
    await ph.setPhone(id, usNumber());
    expect(intel.calls).toHaveLength(1);
    expect(lockFree, 'nothing is stored while the vendor is asked').toBe(true);
  });

  it('a slow vendor that still answers in time is accepted', async () => {
    intel.hook = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      return { lineType: 'MOBILE' };
    };
    expect((await ph.setPhone(await newAccount(), usNumber())).changed).toBe(true);
  });

  it('a vendor that never answers is PHONE_RISK_UNAVAILABLE after the timeout, with nothing stored (fake timers)', async () => {
    const id = await newAccount();
    const before = await snapshot(id);
    let hung = 0;
    intel.hook = () => {
      hung++;
      // installed here, synchronously inside the call, so the service's own timer below is the fake one
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      return new Promise<PhoneIntelligenceResult>(() => undefined);
    };
    try {
      const pending = settled(ph.setPhone(id, usNumber()));
      for (let i = 0; i < 2000 && hung === 0; i++) await new Promise((r) => setImmediate(r));
      expect(hung).toBe(1);
      vi.advanceTimersByTime(PHONE_LOOKUP_TIMEOUT_MS - 1);
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      const result = await pending;
      expect(result).toBeInstanceOf(AccountError);
      expect((result as AccountError).code).toBe('PHONE_RISK_UNAVAILABLE');
      expect((result as AccountError).details).toEqual({ retryable: true });
    } finally {
      vi.useRealTimers();
    }
    expect(await snapshot(id)).toEqual(before);
    expect(sms.sent).toEqual([]);
  });

  it('the timeout is five seconds (a documented constant)', () => {
    expect(PHONE_LOOKUP_TIMEOUT_MS).toBe(5000);
  });

  it.each([
    ['rejects with an Error', async () => Promise.reject(new Error('vendor 500 for +12025550100'))],
    ['rejects with a string', async () => Promise.reject('boom')],
    [
      'throws synchronously',
      () => {
        throw new Error('sync boom');
      },
    ],
    ['answers undefined', async () => undefined as unknown as PhoneIntelligenceResult],
    ['answers null', async () => null as unknown as PhoneIntelligenceResult],
  ] as [string, () => Promise<PhoneIntelligenceResult>][])(
    'a vendor that %s fails CLOSED: PHONE_RISK_UNAVAILABLE, nothing stored, no vendor text leaked',
    async (_name, hook) => {
      intel.hook = hook;
      const id = await newAccount();
      const before = await snapshot(id);
      const e = await fails(ph.setPhone(id, usNumber()), 'PHONE_RISK_UNAVAILABLE', { retryable: true });
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/vendor|boom|2025550100/);
      expect(logSink.lines.join('\n')).not.toMatch(/vendor 500|boom|2025550100/);
      expect(await snapshot(id)).toEqual(before);
    },
  );

  it('a vendor that answers an unknown line type never gets a number stored as accepted', async () => {
    intel.hook = async () => ({ lineType: 'SATELLITE' as unknown as 'MOBILE' });
    const id = await newAccount();
    const before = await snapshot(id);
    const e = await rejection(ph.setPhone(id, usNumber()));
    expect(e).toBeInstanceOf(AccountError);
    expect(await snapshot(id)).toEqual(before);
    expect(sms.sent).toEqual([]);
  });

  describe('the policy is tightened after the number was added', () => {
    it('a MOBILE snapshot stays fine whatever the list says (send and confirm succeed without calling the vendor)', async () => {
      const id = await newAccount();
      await ph.setPhone(id, usNumber());
      const calls = intel.calls.length;
      setPolicy({ blockedLineTypes: ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'] });
      await ph.sendVerification(id);
      expect((await ph.confirmCode(id, codeOf(sms.sent[0]!))).changed).toBe(true);
      expect(intel.calls.length).toBe(calls);
    });

    it('a VOIP snapshot stored while only LANDLINE was blocked is refused at SEND once VOIP is blocked, without calling the vendor', async () => {
      setPolicy({ blockedLineTypes: ['LANDLINE'] });
      const id = await newAccount();
      const phone = usNumberEnding('901');
      await ph.setPhone(id, phone);
      expect((await contactsOf(id))[0]!.line_type).toBe('VOIP');
      const calls = intel.calls.length;
      setPolicy({ blockedLineTypes: ['VOIP'] });
      const before = await snapshot(id);
      await fails(ph.sendVerification(id), 'PHONE_NOT_ACCEPTED', { reason: 'LINE_POLICY' });
      expect(await snapshot(id)).toEqual(before);
      expect(sms.sent).toEqual([]);
      expect(intel.calls.length).toBe(calls);
    });

    it('...and at CONFIRM: a code issued under the old policy no longer verifies the number, nothing is consumed or counted, the vendor is not called', async () => {
      setPolicy({ blockedLineTypes: ['LANDLINE'] });
      const x = await pendingWithSms({ phone: usNumberEnding('901') });
      const calls = intel.calls.length;
      setPolicy({ blockedLineTypes: ['VOIP', 'VIRTUAL'] });
      const before = await snapshot(x.id);
      await fails(ph.confirmCode(x.id, x.code), 'PHONE_NOT_ACCEPTED', { reason: 'LINE_POLICY' });
      expect(await snapshot(x.id)).toEqual(before);
      expect((await challengesOf(x.id))[0]).toMatchObject({ used_at: null, attempt_count: 0, invalidated_at: null });
      expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
      expect(await auditOf(x.id, 'PHONE_VERIFIED')).toEqual([]);
      expect(intel.calls.length).toBe(calls);
    });

    it('...and the number verifies again if the policy is relaxed', async () => {
      setPolicy({ blockedLineTypes: ['LANDLINE'] });
      const x = await pendingWithSms({ phone: usNumberEnding('901') });
      setPolicy({ blockedLineTypes: ['VOIP'] });
      await fails(ph.confirmCode(x.id, x.code), 'PHONE_NOT_ACCEPTED');
      setPolicy({ blockedLineTypes: ['VIRTUAL'] });
      expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
    });

    it('a wrong code on such a number is still a counted wrong attempt (the policy refusal needs the right code)', async () => {
      setPolicy({ blockedLineTypes: ['LANDLINE'] });
      const x = await pendingWithSms({ phone: usNumberEnding('901') });
      setPolicy({ blockedLineTypes: ['VOIP'] });
      await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID', { attemptsRemaining: 4 });
    });

    it('a verified primary whose line type is blocked later keeps working: only NEW numbers are judged', async () => {
      setPolicy({ blockedLineTypes: ['LANDLINE'] });
      const p = await verifiedAccount(usNumberEnding('901'));
      setPolicy({ blockedLineTypes: ['VOIP'] });
      expect((await accounts.getAccountContext(p.id)).phone.phoneVerificationStatus).toBe('VERIFIED');
      expect((await ph.setPhone(p.id, p.phone)).changed).toBe(false);
      await fails(ph.setPhone(p.id, usNumberEnding('901')), 'PHONE_NOT_ACCEPTED');
      expect((await contactOf(p.id, p.phone)).status).toBe('VERIFIED');
    });
  });

  describe('country policy', () => {
    it('the provider is asked for the country of the number on every operation (set, send, confirm, detail)', async () => {
      countries.activate('GB', '+44');
      const id = await newAccount();
      await ph.setPhone(id, gbNumber());
      await ph.sendVerification(id);
      await ph.getPhoneDetail(id);
      await ph.confirmCode(id, wrongCode('000000')).catch(() => undefined);
      expect(policy.asked).toEqual(['GB', 'GB', 'GB', 'GB']);
    });

    it('for an account without any number the provider is asked without a country (platform values)', async () => {
      const id = await newAccount();
      await ph.getPhoneDetail(id);
      await ph.confirmCode(id, KNOWN_CODE).catch(() => undefined);
      expect(policy.asked).toEqual([undefined, undefined]);
    });

    it('a country override of blockedLineTypes changes the outcome for that country only (LANDLINE blocked in CA, not in US)', async () => {
      countries.activate('CA', '+1');
      policy.overrides.set('CA', { blockedLineTypes: ['LANDLINE'] });
      const ca = `+1416555${'2903'}`;
      const us = usNumberEnding('903');
      await fails(ph.setPhone(await newAccount(), ca), 'PHONE_NOT_ACCEPTED', { reason: 'LINE_POLICY' });
      expect((await ph.setPhone(await newAccount(), us)).changed).toBe(true);
    });

    it('a country override with an empty blocked list accepts a VIRTUAL number there, while the platform list still refuses it elsewhere', async () => {
      countries.activate('CA', '+1');
      policy.overrides.set('CA', { blockedLineTypes: [] });
      const calls = intel.calls.length;
      const id = await newAccount();
      await ph.setPhone(id, `+1416555${'2902'}`);
      expect(intel.calls.length).toBe(calls); // an empty list needs no lookup
      expect((await contactsOf(id))[0]).toMatchObject({ country_code: 'CA', line_type: null });
      await fails(ph.setPhone(await newAccount(), usNumberEnding('902')), 'PHONE_NOT_ACCEPTED');
    });

    it('a country override of maxAccountsPerNumber changes the outcome for that country only (2 in CA, 1 in US)', async () => {
      countries.activate('CA', '+1');
      policy.overrides.set('CA', { maxAccountsPerNumber: 2 });
      const ca = caNumber();
      const us = usNumber();
      const caAccounts = [await pendingWithSms({ phone: ca }), await pendingWithSms({ phone: ca }), await pendingWithSms({ phone: ca })];
      const usAccounts = [await pendingWithSms({ phone: us }), await pendingWithSms({ phone: us })];
      expect((await ph.confirmCode(caAccounts[0]!.id, caAccounts[0]!.code)).changed).toBe(true);
      expect((await ph.confirmCode(caAccounts[1]!.id, caAccounts[1]!.code)).changed).toBe(true);
      await fails(ph.confirmCode(caAccounts[2]!.id, caAccounts[2]!.code), 'PHONE_UNAVAILABLE');
      expect((await ph.confirmCode(usAccounts[0]!.id, usAccounts[0]!.code)).changed).toBe(true);
      await fails(ph.confirmCode(usAccounts[1]!.id, usAccounts[1]!.code), 'PHONE_UNAVAILABLE');
      expect(await holdersOf(ca)).toBe(2);
      expect(await holdersOf(us)).toBe(1);
    });

    it('the limits of the country (cooldown, attempts, code length) come from its override too', async () => {
      countries.activate('GB', '+44');
      policy.overrides.set('GB', { codeLength: 8, maxAttempts: 2, resendSeconds: 0 });
      const x = await pendingWithSms({ phone: gbNumber() });
      expect(x.code).toMatch(/^[0-9]{8}$/);
      await resend(x.id); // no cooldown in GB
      const second = textsTo(x.phone).at(-1)!;
      await fails(ph.confirmCode(x.id, wrongCode(codeOf(second))), 'PHONE_CODE_INVALID', { attemptsRemaining: 1 });
      await fails(ph.confirmCode(x.id, wrongCode(codeOf(second))), 'PHONE_VERIFICATION_LOCKED');
    });

    it("a change to a number of another country uses the candidate's country policy", async () => {
      countries.activate('GB', '+44');
      policy.overrides.set('GB', { maxAccountsPerNumber: 2 });
      const shared = gbNumber();
      const [p1, p2] = [await verifiedAccount(), await verifiedAccount()];
      const c1 = await pendingWithSms({ id: p1.id, phone: shared });
      const c2 = await pendingWithSms({ id: p2.id, phone: shared });
      policy.asked = [];
      expect((await ph.confirmCode(p1.id, c1.code)).changed).toBe(true);
      expect(policy.asked).toEqual(['GB']);
      expect((await ph.confirmCode(p2.id, c2.code)).changed).toBe(true);
      expect(await holdersOf(shared)).toBe(2);
    });
  });
});

// ====================================================================== change phone
describe('changing a verified phone', () => {
  // the cooldown is per account: lift it where a test sends twice in a row
  beforeEach(() => setPolicy({ resendSeconds: 0 }));

  it('a new number becomes a REPLACEMENT_PENDING candidate: the verified primary stays VERIFIED and primary, with the change events and audit', async () => {
    const p = await verifiedAccount();
    const candidate = usNumber();
    const r = await ph.setPhone(p.id, candidate);
    expect(r.changed).toBe(true);
    expect(r.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(r.phone.primary).toEqual({ maskedPhone: maskPhone(p.phone), countryCode: 'US', verifiedAt: expect.any(String), source: 'USER_ENTERED' });
    expect(r.phone.pending).toEqual({
      maskedPhone: maskPhone(candidate),
      countryCode: 'US',
      purpose: 'CHANGE_PHONE',
      status: 'REPLACEMENT_PENDING',
      lastSentAt: null,
      expiresAt: null,
    });

    const primary = await contactOf(p.id, p.phone);
    const pending = await contactOf(p.id, candidate);
    expect(primary).toMatchObject({ status: 'VERIFIED', is_primary: true, disabled_at: null });
    expect(pending).toMatchObject({ status: 'REPLACEMENT_PENDING', is_primary: false, source: 'USER_ENTERED', verified_at: null });
    expect((await accounts.getAccountContext(p.id)).phone.phoneVerificationStatus).toBe('VERIFIED');

    const requested = await auditOf(p.id, 'PHONE_CHANGE_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ phone_contact_id: pending.phone_contact_id, actor: `account:${p.id}` });
    expect(requested[0]!.changes).toEqual({
      status: [null, 'REPLACEMENT_PENDING'],
      maskedPhone: maskPhone(candidate),
      countryCode: 'US',
      purpose: 'CHANGE_PHONE',
      lineType: 'MOBILE',
      replacesContactId: primary.phone_contact_id,
    });
    const change = await eventsOf(p.id, E.changeRequested);
    expect(change).toHaveLength(1);
    expect(change[0]!.payload_json).toEqual({ accountId: p.id, phoneContactId: pending.phone_contact_id, replacesPhoneContactId: primary.phone_contact_id });
    const added = await eventsOf(p.id, E.contactAdded);
    expect(added).toHaveLength(2);
    expect(added[1]!.payload_json).toEqual({
      accountId: p.id,
      phoneContactId: pending.phone_contact_id,
      purpose: 'CHANGE_PHONE',
      source: 'USER_ENTERED',
      status: 'REPLACEMENT_PENDING',
    });
    expect(textsTo(candidate)).toEqual([]);
  });

  it('INITIAL and CHANGE challenge purposes are stored correctly (challenge, audit and event)', async () => {
    const p = await verifiedAccount();
    const change = await pendingWithSms({ id: p.id, phone: usNumber() });
    const challenges = await challengesOf(p.id);
    expect(challenges.map((c) => c.purpose)).toEqual(['INITIAL_PHONE', 'CHANGE_PHONE']);
    expect(change.sent.phone.pending).toMatchObject({ purpose: 'CHANGE_PHONE', status: 'REPLACEMENT_PENDING' });
    expect((await auditOf(p.id, 'PHONE_VERIFICATION_REQUESTED')).map((a) => (a.changes as { purpose: string }).purpose)).toEqual([
      'INITIAL_PHONE',
      'CHANGE_PHONE',
    ]);
    expect((await eventsOf(p.id, E.verificationSent)).map((e) => e.payload_json.purpose)).toEqual(['INITIAL_PHONE', 'CHANGE_PHONE']);
    expect((await eventsOf(p.id, E.contactAdded)).map((e) => e.payload_json.purpose)).toEqual(['INITIAL_PHONE', 'CHANGE_PHONE']);
  });

  it('verifying the candidate makes it primary and DISABLES the old one as REPLACED, with PHONE_VERIFIED + PHONE_PRIMARY_CHANGED (masked from/to) and a Verified event naming the replaced contact', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    const oldBefore = await contactOf(p.id, p.phone);
    const r = await ph.confirmCode(p.id, next.code);
    expect(r.changed).toBe(true);
    expect(r.phone.primary).toMatchObject({ maskedPhone: maskPhone(next.phone), source: 'USER_ENTERED' });
    expect(r.phone.pending).toBeNull();
    expect(r.phone.phoneVerificationStatus).toBe('VERIFIED');

    const oldAfter = await contactOf(p.id, p.phone);
    const newer = await contactOf(p.id, next.phone);
    expect(oldAfter).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
    expect(oldAfter.disabled_at).toBeInstanceOf(Date);
    expect(oldAfter.verified_at!.getTime()).toBe(oldBefore.verified_at!.getTime()); // kept as history
    expect(newer).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(newer.verified_at).toBeInstanceOf(Date);

    const ch = (await challengesOf(p.id)).at(-1)!;
    expect(ch).toMatchObject({ purpose: 'CHANGE_PHONE' });
    expect(ch.used_at).toBeInstanceOf(Date);
    const verified = (await auditOf(p.id, 'PHONE_VERIFIED')).at(-1)!;
    expect(verified.changes).toEqual({
      status: ['REPLACEMENT_PENDING', 'VERIFIED'],
      maskedPhone: maskPhone(next.phone),
      purpose: 'CHANGE_PHONE',
      challengeId: ch.challenge_id,
    });
    const changed = await auditOf(p.id, 'PHONE_PRIMARY_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ phone_contact_id: newer.phone_contact_id });
    expect(changed[0]!.changes).toEqual({ from: maskPhone(p.phone), to: maskPhone(next.phone), replacedContactId: oldAfter.phone_contact_id });
    const ve = (await eventsOf(p.id, E.verified)).at(-1)!;
    expect(ve.payload_json).toEqual({
      accountId: p.id,
      phoneContactId: newer.phone_contact_id,
      purpose: 'CHANGE_PHONE',
      replacedPhoneContactId: oldAfter.phone_contact_id,
    });
    await expectPhoneInvariants();
  });

  it('the account context shows the new primary and no pending number after the change', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, next.code);
    const ctx = await accounts.getAccountContext(p.id);
    expect(ctx.phone).toEqual({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(next.phone), countryCode: 'US', verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
  });

  it("the old number's account-count slot is released after the replacement", async () => {
    const p = await verifiedAccount();
    expect(await holdersOf(p.phone)).toBe(1);
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    expect(await holdersOf(p.phone)).toBe(1); // still the primary until the replacement verifies
    await ph.confirmCode(p.id, next.code);
    expect(await holdersOf(p.phone)).toBe(0);
    expect(await holdersOf(next.phone)).toBe(1);
    const other = await pendingWithSms({ phone: p.phone });
    expect((await ph.confirmCode(other.id, other.code)).changed).toBe(true);
  });

  it('a failed (locked) change leaves the verified primary completely intact', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    const before = await contactOf(p.id, p.phone);
    for (let i = 0; i < 5; i++) await ph.confirmCode(p.id, wrongCode(next.code)).catch(() => undefined);
    await fails(ph.confirmCode(p.id, next.code), 'PHONE_VERIFICATION_LOCKED');
    expect(await contactOf(p.id, p.phone)).toEqual(before);
    expect((await accounts.getAccountContext(p.id)).phone).toMatchObject({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(p.phone) },
      pending: { status: 'REPLACEMENT_PENDING', expiresAt: null },
    });
    expect(await auditOf(p.id, 'PHONE_PRIMARY_CHANGED')).toEqual([]);
  });

  it('wrong codes on a change are answered as for any pending number (the verified primary is not consulted)', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    const e = await fails(ph.confirmCode(p.id, wrongCode(next.code)), 'PHONE_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
  });

  it('an abandoned change (never confirmed) leaves the primary intact', async () => {
    const p = await verifiedAccount();
    await pendingWithSms({ id: p.id, phone: usNumber() });
    expect((await liveContacts(p.id)).map((c) => [c.status, c.is_primary])).toEqual([
      ['VERIFIED', true],
      ['REPLACEMENT_PENDING', false],
    ]);
    expect((await accounts.getAccountContext(p.id)).phone.phoneVerificationStatus).toBe('VERIFIED');
  });

  it('setPhone with the current primary withdraws the pending change: the candidate is DISABLED SUPERSEDED and its open challenge CONTACT_DISABLED', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    const r = await ph.setPhone(p.id, nationalUs(p.phone), { country: 'US' });
    expect(r.changed).toBe(true);
    expect(r.phone.pending).toBeNull();
    expect(r.phone.primary).toMatchObject({ maskedPhone: maskPhone(p.phone) });
    expect(await contactOf(p.id, next.phone)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED', is_primary: false });
    expect(await contactOf(p.id, p.phone)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect((await challengesOf(p.id)).at(-1)).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    expect(await openChallenges(p.id)).toEqual([]);
    expect(await auditOf(p.id, 'PHONE_VERIFIED')).toHaveLength(1);
    await expectPhoneInvariants();
  });

  it('setPhone with the current primary and no pending change is a no-op', async () => {
    const p = await verifiedAccount();
    const before = await snapshot(p.id);
    const r = await ph.setPhone(p.id, p.phone);
    expect(r.changed).toBe(false);
    expect(r.phone.phoneVerificationStatus).toBe('VERIFIED');
    expect(await snapshot(p.id)).toEqual(before);
  });

  it('a new candidate supersedes the old candidate: one REPLACEMENT_PENDING, the earlier one DISABLED SUPERSEDED, the primary untouched', async () => {
    const p = await verifiedAccount();
    const first = await pendingWithSms({ id: p.id, phone: usNumber() });
    const second = usNumber();
    const r = await ph.setPhone(p.id, second);
    expect(r.changed).toBe(true);
    expect(await contactOf(p.id, first.phone)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED' });
    expect(await contactOf(p.id, second)).toMatchObject({ status: 'REPLACEMENT_PENDING' });
    expect(await contactOf(p.id, p.phone)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect((await challengesOf(p.id)).at(-1)).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED' });
    const added = await auditOf(p.id, 'PHONE_CHANGE_REQUESTED');
    expect(added).toHaveLength(2);
    expect(added[1]!.changes).toMatchObject({
      supersededContactId: (await contactOf(p.id, first.phone)).phone_contact_id,
      replacesContactId: (await contactOf(p.id, p.phone)).phone_contact_id,
    });
    await fails(ph.confirmCode(p.id, first.code), 'PHONE_CODE_INVALID');
  });

  it('the code of a withdrawn candidate does not verify its replacement and is not an attempt on it', async () => {
    const p = await verifiedAccount();
    const first = await pendingWithSms({ id: p.id, phone: usNumber() });
    const second = await pendingWithSms({ id: p.id, phone: usNumber() });
    await fails(ph.confirmCode(p.id, first.code), 'PHONE_CODE_INVALID', { attemptsRemaining: 4 });
    expect((await challengesOf(p.id)).at(-1)).toMatchObject({ attempt_count: 1 });
    expect((await ph.confirmCode(p.id, second.code)).changed).toBe(true);
  });

  it('an account can go back to a number it used before: the older row stays DISABLED history and the number verifies again', async () => {
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, next.code);
    const back = await pendingWithSms({ id: p.id, phone: p.phone });
    expect((await ph.confirmCode(p.id, back.code)).changed).toBe(true);
    const rows = (await contactsOf(p.id)).filter((c) => c.phone_e164 === p.phone);
    expect(rows.map((c) => c.status)).toEqual(['DISABLED', 'VERIFIED']);
    expect((await liveContacts(p.id)).map((c) => c.phone_e164)).toEqual([p.phone]);
    await expectPhoneInvariants();
  });

  it('two changes in a row keep one primary and a full audit chain (PHONE_PRIMARY_CHANGED twice, from -> to masked)', async () => {
    const p = await verifiedAccount();
    const n2 = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, n2.code);
    const n3 = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, n3.code);
    const changed = await auditOf(p.id, 'PHONE_PRIMARY_CHANGED');
    expect(changed.map((a) => [(a.changes as { from: string }).from, (a.changes as { to: string }).to])).toEqual([
      [maskPhone(p.phone), maskPhone(n2.phone)],
      [maskPhone(n2.phone), maskPhone(n3.phone)],
    ]);
    expect((await liveContacts(p.id)).map((c) => c.phone_e164)).toEqual([n3.phone]);
    expect((await contactsOf(p.id)).filter((c) => c.disabled_reason === 'REPLACED')).toHaveLength(2);
  });

  it('a change verification that fails midway (the number is verified on another account) does not touch the old primary', async () => {
    const owner = await verifiedAccount();
    const p = await verifiedAccount();
    const next = await pendingWithSms({ id: p.id, phone: owner.phone });
    const before = await snapshot(p.id);
    await fails(ph.confirmCode(p.id, next.code), 'PHONE_UNAVAILABLE');
    expect(await snapshot(p.id)).toEqual(before);
    expect((await contactOf(p.id, p.phone)).status).toBe('VERIFIED');
    expect((await contactOf(p.id, p.phone)).is_primary).toBe(true);
  });

  it('a change to a number of another active country keeps the primary until it verifies, then both country codes are right', async () => {
    countries.activate('GB', '+44');
    const p = await verifiedAccount();
    const gb = await pendingWithSms({ id: p.id, phone: gbNumber() });
    expect((await accounts.getAccountContext(p.id)).phone).toMatchObject({
      primary: { countryCode: 'US' },
      pending: { countryCode: 'GB', purpose: 'CHANGE_PHONE' },
    });
    await ph.confirmCode(p.id, gb.code);
    expect((await accounts.getAccountContext(p.id)).phone).toMatchObject({ primary: { countryCode: 'GB' }, pending: null });
  });

  it('a pending change is independent of the email: replacing the phone never touches the email contact', async () => {
    const p = await verifiedAccount();
    const address = await verifyEmail(p.id);
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, next.code);
    const ctx = await accounts.getAccountContext(p.id);
    expect(ctx.email.emailVerificationStatus).toBe('VERIFIED');
    expect(ctx.contacts.contactsVerified).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain(address);
  });

  it('the database refuses a PENDING initial number for an account that has a primary, and a replacement without a primary', async () => {
    const p = await verifiedAccount();
    const rule = async (accountId: string, status: string): Promise<{ code?: string; detail?: string }> =>
      (await rejection(
        q(`INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', $3, 'USER_ENTERED')`, [
          accountId,
          usNumber(),
          status,
        ]),
      )) as { code?: string; detail?: string };
    const initial = await rule(p.id, 'PENDING');
    expect(initial.code).toBe('23000');
    expect(initial.detail).toContain('identity_rule:PHONE_INITIAL_WITH_PRIMARY');
    const lone = await rule(await newAccount(), 'REPLACEMENT_PENDING');
    expect(lone.code).toBe('23000');
    expect(lone.detail).toContain('identity_rule:PHONE_REPLACEMENT_WITHOUT_PRIMARY');
    expect(await liveContacts(p.id)).toHaveLength(1);
  });
});

// ====================================================================== database guards seen through the service
describe('database guards of the phone tables', () => {
  const rule = async (text: string, params: unknown[]): Promise<{ code?: string; detail?: string; constraint?: string }> =>
    (await rejection(q(text, params))) as { code?: string; detail?: string; constraint?: string };

  it('a phone contact is never born VERIFIED', async () => {
    const e = await rule(
      `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, is_primary, source, verified_at) VALUES ($1, $2, 'US', 'VERIFIED', true, 'USER_ENTERED', now())`,
      [await newAccount(), usNumber()],
    );
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_STATUS_TRANSITION');
  });

  it('the database never lets a challenge hash be rewritten (a stored code hash cannot be swapped)', async () => {
    const x = await pendingWithSms();
    const e = await rule(`UPDATE identity.phone_verification_challenges SET code_hash = $2 WHERE challenge_id = $1`, [
      (await challengesOf(x.id))[0]!.challenge_id,
      'a'.repeat(64),
    ]);
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:IMMUTABLE_IDENTITY');
  });

  it('the number of a contact cannot be rewritten', async () => {
    const x = await pendingWithSms();
    const e = await rule(`UPDATE identity.phone_contacts SET phone_e164 = $2 WHERE account_id = $1`, [x.id, usNumber()]);
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:IMMUTABLE_IDENTITY');
  });

  it('a phone contact cannot be deleted, and neither can a challenge', async () => {
    const x = await pendingWithSms();
    const c = await rule(`DELETE FROM identity.phone_contacts WHERE account_id = $1`, [x.id]);
    expect(c.detail).toContain('identity_rule:NOT_DELETABLE');
    const ch = await rule(`DELETE FROM identity.phone_verification_challenges WHERE challenge_id = $1`, [(await challengesOf(x.id))[0]!.challenge_id]);
    expect(ch.detail).toContain('identity_rule:NOT_DELETABLE');
  });

  it('a DISABLED contact never changes again', async () => {
    const x = await pendingWithSms();
    await ph.setPhone(x.id, usNumber());
    const e = await rule(`UPDATE identity.phone_contacts SET updated_at = now() WHERE phone_contact_id = $1`, [
      (await contactOf(x.id, x.phone)).phone_contact_id,
    ]);
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:IMMUTABLE_IDENTITY');
  });

  it('the verified primary cannot be disabled except by a replacement', async () => {
    const p = await verifiedAccount();
    const e = await rule(
      `UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = now(), disabled_reason = 'REPLACED' WHERE phone_contact_id = $1`,
      [p.contactId],
    );
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_PRIMARY_NOT_REPLACEABLE');
  });

  it('a number becomes VERIFIED only as the primary number', async () => {
    const x = await pendingWithSms();
    const e = await rule(`UPDATE identity.phone_contacts SET status = 'VERIFIED', verified_at = now() WHERE account_id = $1 AND status = 'PENDING'`, [x.id]);
    expect(e.code === '23000' || e.code === '23514').toBe(true);
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
  });

  it('the attempt counter only counts up, one attempt at a time', async () => {
    const x = await pendingWithSms();
    const e = await rule(`UPDATE identity.phone_verification_challenges SET attempt_count = 2 WHERE challenge_id = $1`, [
      (await challengesOf(x.id))[0]!.challenge_id,
    ]);
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_CHALLENGE_ATTEMPTS');
  });

  it('a challenge cannot be consumed without its number being verified (checked at commit)', async () => {
    const x = await pendingWithSms();
    const e = await rule(`UPDATE identity.phone_verification_challenges SET used_at = now() WHERE phone_contact_id = $1`, [
      (await contactOf(x.id, x.phone)).phone_contact_id,
    ]);
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_CHALLENGE_CONSUMPTION');
  });

  it('a challenge is issued only with the purpose that matches the status of its number', async () => {
    const x = await pendingWithSms();
    const contactId = (await contactOf(x.id, x.phone)).phone_contact_id;
    const e = await rule(
      `INSERT INTO identity.phone_verification_challenges (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'CHANGE_PHONE', $2, now() + interval '10 minutes', 'x')`,
      [contactId, 'b'.repeat(64)],
    );
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_CHALLENGE_PURPOSE');
  });

  it('a challenge can only be issued for a pending number (a superseded number takes none)', async () => {
    const x = await pendingWithSms();
    const old = await contactOf(x.id, x.phone);
    await ph.setPhone(x.id, usNumber());
    const e = await rule(
      `INSERT INTO identity.phone_verification_challenges (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'INITIAL_PHONE', $2, now() + interval '10 minutes', 'x')`,
      [old.phone_contact_id, 'd'.repeat(64)],
    );
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:PHONE_CHALLENGE_NOT_OPEN');
  });

  it('only one open challenge per contact exists (unique index)', async () => {
    const x = await pendingWithSms();
    const contactId = (await contactOf(x.id, x.phone)).phone_contact_id;
    const e = await rule(
      `INSERT INTO identity.phone_verification_challenges (phone_contact_id, purpose, code_hash, expires_at, correlation_id) VALUES ($1, 'INITIAL_PHONE', $2, now() + interval '10 minutes', 'x')`,
      [contactId, 'c'.repeat(64)],
    );
    expect(e.code).toBe('23505');
    expect(e.constraint).toBe('uq_phone_verification_challenges__open_per_contact');
  });

  it('a closed account cannot receive a phone contact (guard) and the service reports CLOSED first', async () => {
    const id = await newAccount();
    await accounts.changeStatus(id, 'SUSPENDED', OP);
    await accounts.changeStatus(id, 'CLOSED', OP);
    const e = await rule(
      `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'US', 'PENDING', 'USER_ENTERED')`,
      [id, usNumber()],
    );
    expect(e.detail).toContain('identity_rule:ACCOUNT_CLOSED');
    await fails(ph.setPhone(id, usNumber()), 'CLOSED', { status: 'CLOSED' });
  });

  it('an audit row can only name a contact of the audited account', async () => {
    const [a, b] = [await pendingWithSms(), await pendingWithSms()];
    const e = await rule(
      `INSERT INTO identity.account_audit_events (actor, action, account_id, phone_contact_id, changes, correlation_id) VALUES ('t', 'PHONE_ADDED', $1, $2, '{}'::jsonb, 'x')`,
      [a.id, (await contactOf(b.id, b.phone)).phone_contact_id],
    );
    expect(e.code).toBe('23503');
  });

  it('a PHONE audit action needs a contact, any other action must not carry one', async () => {
    const x = await pendingWithSms();
    const noContact = await rule(
      `INSERT INTO identity.account_audit_events (actor, action, account_id, changes, correlation_id) VALUES ('t', 'PHONE_ADDED', $1, '{}'::jsonb, 'x')`,
      [x.id],
    );
    expect(noContact.code).toBe('23514');
    const withContact = await rule(
      `INSERT INTO identity.account_audit_events (actor, action, account_id, phone_contact_id, changes, correlation_id) VALUES ('t', 'PROFILE_UPDATED', $1, $2, '{}'::jsonb, 'x')`,
      [x.id, (await contactOf(x.id, x.phone)).phone_contact_id],
    );
    expect(withContact.code).toBe('23514');
  });

  it('the stored number must be E.164 and the country code two capital letters', async () => {
    const id = await newAccount();
    const bad = await rule(
      `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, '2025551000', 'US', 'PENDING', 'USER_ENTERED')`,
      [id],
    );
    expect(bad.code).toBe('23514');
    const badCountry = await rule(
      `INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source) VALUES ($1, $2, 'us', 'PENDING', 'USER_ENTERED')`,
      [id, usNumber()],
    );
    expect(badCountry.code).toBe('23514');
  });
});

// ====================================================================== events, audit and secrets
describe('events, audit and secrets', () => {
  it('a full flow writes its events in the same transaction as the change: one event per change, aggregate identity_account, identifiers only', async () => {
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ph.confirmCode(x.id, x.code);
    await ph.setPhone(x.id, usNumber());
    const types = (await events(x.id)).map((e) => e.event_type);
    expect(types.slice(0, 4)).toEqual([E.contactAdded, E.verificationSent, E.verificationFailed, E.verified]);
    expect(types.slice(4).sort()).toEqual([E.changeRequested, E.contactAdded].sort());
    for (const e of await events(x.id)) {
      expect(e.aggregate_type).toBe('identity_account');
      expect(e.actor_type).toBe('user');
      expect(e.actor_id).toBe(`account:${x.id}`);
      expect(e.payload_json.accountId).toBe(x.id);
    }
    const published = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.phone-%' AND published_at IS NOT NULL`,
      [x.id],
    );
    expect(published[0]!.n).toBe(0); // unpublished: the relay publishes them later
  });

  it('every event payload holds identifiers and counters only (no number, no code, no hash, no masked number)', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ph.confirmCode(x.id, x.code);
    const next = await pendingWithSms({ id: x.id, phone: usNumber() });
    await ph.confirmCode(x.id, next.code);
    const allowed = new Set([
      'accountId',
      'phoneContactId',
      'challengeId',
      'purpose',
      'source',
      'status',
      'expiresAt',
      'attemptCount',
      'locked',
      'replacedPhoneContactId',
      'replacesPhoneContactId',
    ]);
    for (const e of await events(x.id)) {
      for (const key of Object.keys(e.payload_json)) expect(allowed.has(key), `${e.event_type} carries ${key}`).toBe(true);
      expect(JSON.stringify(e.payload_json)).not.toContain('*');
    }
  });

  it('a verification that fails midway (the number is verified elsewhere) leaves NO audit, outbox, contact or challenge change behind', async () => {
    const a = await verifiedAccount();
    const b = await pendingWithSms({ phone: a.phone });
    const before = await snapshot(b.id);
    const world = await phoneWorld();
    await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE');
    await fails(ph.confirmCode(b.id, b.code), 'PHONE_UNAVAILABLE');
    expect(await snapshot(b.id)).toEqual(before);
    expect(await phoneWorld()).toEqual(world);
  });

  it('a verification refused by the line policy leaves no outbox event behind either', async () => {
    setPolicy({ blockedLineTypes: ['LANDLINE'] });
    const x = await pendingWithSms({ phone: usNumberEnding('901') });
    setPolicy({ blockedLineTypes: ['VOIP'] });
    const world = await phoneWorld();
    await fails(ph.confirmCode(x.id, x.code), 'PHONE_NOT_ACCEPTED');
    expect(await phoneWorld()).toEqual(world);
  });

  it('a wrong code DOES leave its audit row and Failed event (the attempt is committed although the call threw)', async () => {
    const x = await pendingWithSms();
    const world = await phoneWorld();
    await rejection(ph.confirmCode(x.id, wrongCode(x.code)));
    const after = await phoneWorld();
    expect(after.audit).toBe(world.audit + 1);
    expect(after.events).toBe(world.events + 1);
  });

  it('the payloads of every event and the audit rows of a full flow hold identifiers only: no code, no hash, no full number', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithSms();
    for (let i = 0; i < 2; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ph.confirmCode(x.id, x.code);
    const next = await pendingWithSms({ id: x.id, phone: usNumber() });
    const secrets = await secretsOf(
      x.id,
      sms.sent.filter((m) => m.to === x.phone || m.to === next.phone),
    );
    secrets.codes.push(wrongCode(x.code));
    expect(secrets.codes.length).toBeGreaterThanOrEqual(2);
    await expectNoSecrets(x.id, secrets);
  });

  it('a full flow (set, failed delivery, send, wrong codes, lock, resend, verify, change, withdraw) leaks nothing into the audit, outbox, challenge rows or logs', async () => {
    setPolicy({ resendSeconds: 0 });
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted, rateLimiter: new MemoryRateLimiter() });
    const id = await newAccount();
    const phone = usNumber();
    await svc.setPhone(id, phone, { clientIp: '203.0.113.7' });
    scripted.next = new SmsDeliveryError('UNAVAILABLE', `down for ${phone}`, true);
    await rejection(svc.sendVerification(id, { clientIp: '203.0.113.7' }));
    await svc.sendVerification(id, { clientIp: '203.0.113.7' });
    const wrong = wrongCode(codeOf(scripted.seen.at(-1)!));
    for (let i = 0; i < 5; i++) await svc.confirmCode(id, wrong, { clientIp: '203.0.113.7' }).catch(() => undefined);
    await svc.sendVerification(id, { clientIp: '203.0.113.7' });
    await svc.confirmCode(id, codeOf(scripted.seen.at(-1)!), { clientIp: '203.0.113.7' });
    const change = usNumber();
    await svc.setPhone(id, change);
    await svc.sendVerification(id);
    await svc.setPhone(id, phone); // withdraw
    const secrets = await secretsOf(id, scripted.seen);
    secrets.codes.push(wrong);
    expect(secrets.codes.length).toBeGreaterThanOrEqual(4);
    const texts = await expectNoSecrets(id, secrets);
    expect(texts.logs).toContain('could not be delivered'); // the scan saw the delivery failure log line
    expect(texts.logs).not.toContain('203.0.113.7');
    expect(texts.audit).not.toContain('203.0.113.7');
    expect(texts.outbox).not.toContain('203.0.113.7');
    expect(await tablesMentioning(change)).toEqual(['identity.phone_contacts']);
  });

  it('the log lines of the failure paths (limiter down, policy down, delivery failed, lookup failed) carry no secret', async () => {
    const limiter = new MemoryRateLimiter();
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithSms({ service: svc });
    limiter.unavailable = true;
    await rejection(svc.setPhone(x.id, usNumber()));
    await rejection(svc.sendVerification(x.id));
    await svc.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    limiter.unavailable = false;
    policy.failure = new Error(`configuration store down; ${x.phone} ${x.code}`);
    await rejection(svc.sendVerification(x.id));
    await rejection(svc.confirmCode(x.id, x.code));
    policy.failure = undefined;
    await rejection(svc.setPhone(x.id, usNumberEnding('905')));
    sms.failNext = new SmsDeliveryError('UNAVAILABLE', `smtp down ${x.phone}`, true);
    setPolicy({ resendSeconds: 0 });
    await rejection(svc.sendVerification(x.id));
    const lines = logSink.lines.join('\n');
    expect(lines).toContain('rate limiter unavailable');
    expect(lines).toContain('policy unavailable');
    expect(lines).toContain('lookup failed');
    expect(lines).toContain('could not be delivered');
    await expectNoSecrets(x.id, await secretsOf(x.id, [x.message]));
  });

  it('the audit actor is the account itself and no free text (reason) is stored for phone actions', async () => {
    const x = await verifiedAccount();
    const rows = await audit(x.id);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.actor).toBe(`account:${x.id}`);
      expect(r.reason).toBeNull();
      expect(r.phone_contact_id).not.toBeNull();
    }
  });

  it('one request shares one correlation id across its audit rows and events (verify with a code under a request context)', async () => {
    const x = await pendingWithSms();
    const correlationId = `corr-${randomUUID()}`;
    await runWithCorrelation(correlationId, () => ph.confirmCode(x.id, x.code));
    expect((await auditOf(x.id, 'PHONE_VERIFIED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(x.id, E.verified))[0]!.correlation_id).toBe(correlationId);
  });

  it('a wrong code under a request context carries its correlation id into the audit and event rows although the call threw', async () => {
    const x = await pendingWithSms();
    const correlationId = `corr-${randomUUID()}`;
    await rejection(runWithCorrelation(correlationId, () => ph.confirmCode(x.id, wrongCode(x.code))));
    expect((await auditOf(x.id, 'PHONE_VERIFICATION_FAILED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(x.id, E.verificationFailed))[0]!.correlation_id).toBe(correlationId);
  });

  it('setPhone under a request context shares its correlation id between the audit rows and the events of a change', async () => {
    const p = await verifiedAccount();
    const correlationId = `corr-${randomUUID()}`;
    await runWithCorrelation(correlationId, () => ph.setPhone(p.id, usNumber()));
    expect((await auditOf(p.id, 'PHONE_CHANGE_REQUESTED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(p.id, E.changeRequested))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(p.id, E.contactAdded)).at(-1)!.correlation_id).toBe(correlationId);
  });
});

// ====================================================================== rate limits
describe('rate limiting', () => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_700_000_000_000;
  });
  const limited = () => {
    const limiter = new MemoryRateLimiter(clock);
    const spy = new SpyLimiter(limiter);
    return { limiter, spy, svc: makeService({ rateLimiter: spy }) };
  };

  it('the account dimension: exceeding requestsPerHour is PHONE_RATE_LIMITED with retryAfterSeconds only; nothing is written and the vendor is not asked', async () => {
    setPolicy({ requestsPerHour: 2 });
    const { svc } = limited();
    const id = await newAccount();
    await svc.setPhone(id, usNumber());
    await svc.setPhone(id, usNumber());
    const before = await snapshot(id);
    const calls = intel.calls.length;
    const e = await fails(svc.setPhone(id, usNumber()), 'PHONE_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 3600);
    expect(e.message).not.toMatch(/account|ip\b|device|number|phone|dimension|limitedBy/i);
    expect(await snapshot(id)).toEqual(before);
    expect(intel.calls.length, 'the limiter is consumed before the paid vendor lookup').toBe(calls);
  });

  it('the window resets with the clock: after an hour the account may call again', async () => {
    setPolicy({ requestsPerHour: 1 });
    const { svc } = limited();
    const id = await newAccount();
    await svc.setPhone(id, usNumber());
    await fails(svc.setPhone(id, usNumber()), 'PHONE_RATE_LIMITED');
    now += 1800_000;
    const e = await fails(svc.setPhone(id, usNumber()), 'PHONE_RATE_LIMITED');
    between(e.details.retryAfterSeconds, 1, 1800);
    now += 1801_000;
    expect((await svc.setPhone(id, usNumber())).changed).toBe(true);
  });

  it('the ip dimension uses ctx.clientIp: another account behind the same address is limited, a different address is not', async () => {
    setPolicy({ requestsPerHour: 2 });
    const { svc } = limited();
    const [a, b, c, d] = [await newAccount(), await newAccount(), await newAccount(), await newAccount()];
    await svc.setPhone(a, usNumber(), { clientIp: '198.51.100.10' });
    await svc.setPhone(b, usNumber(), { clientIp: '198.51.100.10' });
    const e = await fails(svc.setPhone(c, usNumber(), { clientIp: '198.51.100.10' }), 'PHONE_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    expect(await liveContacts(c)).toEqual([]);
    expect((await svc.setPhone(d, usNumber(), { clientIp: '198.51.100.11' })).changed).toBe(true);
    // without a clientIp there is no ip dimension
    expect((await svc.setPhone(c, usNumber())).changed).toBe(true);
  });

  it('the device dimension uses ctx.deviceId', async () => {
    setPolicy({ requestsPerHour: 1 });
    const { svc } = limited();
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    await svc.setPhone(a, usNumber(), { deviceId: 'device-1' });
    await fails(svc.setPhone(b, usNumber(), { deviceId: 'device-1' }), 'PHONE_RATE_LIMITED');
    expect((await svc.setPhone(c, usNumber(), { deviceId: 'device-2' })).changed).toBe(true);
  });

  it('the number dimension counts across accounts: the 6th send to one number is PHONE_RATE_LIMITED, with no challenge and no SMS', async () => {
    const { svc } = limited();
    const shared = usNumber();
    for (let i = 0; i < 5; i++) await pendingWithSms({ phone: shared, service: svc });
    expect(textsTo(shared)).toHaveLength(5);
    const sixth = await newAccount();
    await svc.setPhone(sixth, shared);
    const e = await fails(svc.sendVerification(sixth), 'PHONE_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 3600);
    expect(textsTo(shared)).toHaveLength(5);
    expect(await challengesOf(sixth)).toEqual([]);
    // another number is not affected
    expect((await pendingWithSms({ service: svc })).sent.codeLength).toBe(6);
  });

  it('the number dimension does not reveal ownership: the refusal is identical whether the number is verified on another account or free', async () => {
    const { svc } = limited();
    const free = usNumber();
    for (let i = 0; i < 5; i++) await pendingWithSms({ phone: free, service: svc });
    const owned = usNumber();
    await pendingWithSms({ phone: owned, service: svc }).then((o) => svc.confirmCode(o.id, o.code));
    for (let i = 0; i < 4; i++) await pendingWithSms({ phone: owned, service: svc });
    const refusals: AccountError[] = [];
    for (const phone of [free, owned]) {
      const id = await newAccount();
      await svc.setPhone(id, phone);
      refusals.push(await fails(svc.sendVerification(id), 'PHONE_RATE_LIMITED'));
    }
    expect(refusals[0]!.message).toBe(refusals[1]!.message);
    expect(Object.keys(refusals[0]!.details)).toEqual(Object.keys(refusals[1]!.details));
    expect(shapeOf(refusals[0]!.details)).toEqual(shapeOf(refusals[1]!.details));
  });

  it('the number dimension is keyed by the CANONICAL number: another spelling of the same number shares the budget', async () => {
    setPolicy({ numberPerHour: 2 });
    const { svc } = limited();
    const shared = usNumber();
    await pendingWithSms({ phone: shared, service: svc });
    const b = await newAccount();
    await svc.setPhone(b, nationalUs(shared), { country: 'US' });
    await svc.sendVerification(b);
    const c = await newAccount();
    await svc.setPhone(c, `+1 ${shared.slice(2, 5)} ${shared.slice(5)}`);
    await fails(svc.sendVerification(c), 'PHONE_RATE_LIMITED');
  });

  it('REFUSED sends (cooldown, hour cap, day cap) do not spend the per-number budget', async () => {
    setPolicy({ numberPerHour: 3 });
    const { svc, spy } = limited();
    const shared = usNumber();
    const attacker = await pendingWithSms({ phone: shared, service: svc }); // one SMS is sent to the number
    const consumed = spy.calls.length;
    for (let i = 0; i < 5; i++) await fails(svc.sendVerification(attacker.id), 'PHONE_RESEND_TOO_SOON');
    expect(spy.calls.length, 'a refused send never reaches the limiter').toBe(consumed);
    expect(textsTo(shared)).toHaveLength(1);
    // the owner of the number (another account) still has the two remaining texts of the hour
    await pendingWithSms({ phone: shared, service: svc });
    await pendingWithSms({ phone: shared, service: svc });
    expect(textsTo(shared)).toHaveLength(3);
    await fails(svc.sendVerification((await pendingAccountWithoutSend(svc, shared)).id), 'PHONE_RATE_LIMITED');
  });

  it('concurrent sends of one account: one text goes out and the per-number budget is spent once (the limiter is charged under the account lock; ID-003 review)', async () => {
    setPolicy({ numberPerHour: 10 });
    const { svc, spy } = limited();
    const shared = usNumber();
    const acc = await pendingAccountWithoutSend(svc, shared);
    const before = spy.calls.length;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.sendVerification(acc.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'PHONE_RESEND_TOO_SOON' });
    expect(textsTo(shared)).toHaveLength(1);
    expect(spy.calls.length - before, 'one consume for one text').toBe(1);
  });

  it('...also when the refusal is the hourly or daily cap', async () => {
    setPolicy({ numberPerHour: 4, resendSeconds: 0, maxPerHour: 1 });
    const { svc, spy } = limited();
    const shared = usNumber();
    const a = await pendingWithSms({ phone: shared, service: svc });
    const consumed = spy.calls.length;
    for (let i = 0; i < 3; i++) await fails(svc.sendVerification(a.id), 'PHONE_SEND_LIMIT');
    expect(spy.calls.length).toBe(consumed);
  });

  async function pendingAccountWithoutSend(svc: PhoneVerificationService, phone: string): Promise<{ id: string }> {
    const id = await newAccount();
    await svc.setPhone(id, phone);
    return { id };
  }

  it('a FAILED delivery spends the per-number budget (the SMS was attempted and costs money)', async () => {
    setPolicy({ numberPerHour: 2, resendSeconds: 0 });
    const { svc } = limited();
    const id = await newAccount();
    await svc.setPhone(id, usNumber());
    for (let i = 0; i < 2; i++) {
      sms.failNext = new SmsDeliveryError('UNAVAILABLE', 'down', true);
      await fails(svc.sendVerification(id), 'PHONE_DELIVERY_FAILED');
    }
    await fails(svc.sendVerification(id), 'PHONE_RATE_LIMITED');
    expect(sms.sent).toEqual([]);
  });

  it('the numberPerHour limit comes from the policy', async () => {
    setPolicy({ numberPerHour: 1 });
    const { svc } = limited();
    const shared = usNumber();
    await pendingWithSms({ phone: shared, service: svc });
    const id = await newAccount();
    await svc.setPhone(id, shared);
    await fails(svc.sendVerification(id), 'PHONE_RATE_LIMITED');
  });

  it('a refused request consumes nothing from the other dimensions', async () => {
    setPolicy({ numberPerHour: 1, requestsPerHour: 2 });
    const { svc } = limited();
    const shared = usNumber();
    await pendingWithSms({ phone: shared, service: svc }); // uses the only send to this number
    const b = await newAccount();
    await svc.setPhone(b, shared, { clientIp: '192.0.2.50' }); // account b 1, ip 1
    await fails(svc.sendVerification(b, { clientIp: '192.0.2.50' }), 'PHONE_RATE_LIMITED'); // refused by the number: must not use account or ip
    await svc.setPhone(b, usNumber(), { clientIp: '192.0.2.50' }); // account b 2, ip 2: allowed only if the refusal consumed nothing
    await fails(svc.setPhone(b, usNumber(), { clientIp: '192.0.2.50' }), 'PHONE_RATE_LIMITED');
  });

  it('the rules handed to the limiter: names, limits, a one-hour window, and opaque keys (no raw IP, no number, no device id)', async () => {
    const spy = new SpyLimiter(new MemoryRateLimiter(clock));
    const svc = makeService({ rateLimiter: spy });
    const id = await newAccount();
    const phone = usNumber();
    const ctx = { clientIp: '203.0.113.9', deviceId: 'device-xyz' };
    await svc.setPhone(id, phone, ctx);
    await svc.sendVerification(id, ctx);
    const issued = sms.sent[0]!;
    await svc.confirmCode(id, codeOf(issued), ctx);

    const [setCall, sendCall, confirmCall] = spy.calls;
    const names = (rules: RateRule[] | undefined) => rules!.map((r) => r.name);
    expect(names(setCall)).toEqual(['phone-verification:account', 'phone-verification:ip', 'phone-verification:device']);
    expect(names(sendCall)).toEqual(['phone-verification:account', 'phone-verification:ip', 'phone-verification:device', 'phone-verification:number']);
    expect(names(confirmCall)).toEqual(['phone-verification:account', 'phone-verification:ip', 'phone-verification:device']);
    for (const r of [...setCall!, ...sendCall!, ...confirmCall!]) {
      expect(r.windowSeconds).toBe(3600);
      expect(r.limit).toBe(r.name.endsWith(':number') ? PRD.numberPerHour : PRD.requestsPerHour);
    }
    const keys = spy.calls.flat().map((r) => r.key);
    expect(keys.some((k) => k === id)).toBe(true);
    const text = JSON.stringify(spy.calls);
    for (const raw of ['203.0.113.9', 'device-xyz', ...numberVariants(phone)]) expect(text).not.toContain(raw);
    const byName = (rules: RateRule[], name: string) => rules.find((r) => r.name === name)!.key;
    expect(byName(sendCall!, 'phone-verification:ip')).toBe(hashDimension(testHashKey, 'ip', '203.0.113.9'));
    expect(byName(sendCall!, 'phone-verification:device')).toBe(hashDimension(testHashKey, 'device', 'device-xyz'));
    expect(byName(sendCall!, 'phone-verification:number')).toBe(hashDimension(testHashKey, 'phone', phone));
  });

  it('the phone number key differs from an email key of the same text and from the ip key (separate dimension spaces)', () => {
    const value = '+12025551000';
    expect(hashDimension(testHashKey, 'phone', value)).not.toBe(hashDimension(testHashKey, 'email', value));
    expect(hashDimension(testHashKey, 'phone', value)).not.toBe(hashDimension(testHashKey, 'ip', value));
    expect(hashDimension(testHashKey, 'phone', value)).not.toBe(hashDimension(otherHashKey, 'phone', value));
    expect(hashDimension(testHashKey, 'phone', value)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('confirmCode is limited too (PHONE_RATE_LIMITED), and a refused attempt is not counted as a wrong code', async () => {
    setPolicy({ requestsPerHour: 3 });
    const { svc } = limited();
    const x = await pendingWithSms({ service: svc }); // set + send = 2 requests
    await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID'); // 3rd
    await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'PHONE_RATE_LIMITED');
    await fails(svc.confirmCode(x.id, x.code), 'PHONE_RATE_LIMITED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 1, used_at: null });
    expect(await auditOf(x.id, 'PHONE_VERIFICATION_FAILED')).toHaveLength(1);
  });

  it('the limiter being unavailable FAILS CLOSED for setPhone and sendVerification (UNAVAILABLE, RATE_LIMITER_UNAVAILABLE): nothing is sent, stored or looked up', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithSms({ service: svc });
    const before = await snapshot(x.id);
    const world = await phoneWorld();
    const texts = sms.sent.length;
    const calls = intel.calls.length;
    limiter.unavailable = true;
    setPolicy({ resendSeconds: 0 }); // the authoritative cooldown is checked before the limiter: lift it so the send reaches the limiter
    await fails(svc.setPhone(x.id, usNumber()), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    await fails(svc.sendVerification(x.id), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    const fresh = await newAccount();
    await fails(svc.setPhone(fresh, usNumber()), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    expect(await snapshot(x.id)).toEqual(before);
    expect(sms.sent).toHaveLength(texts);
    expect(await liveContacts(fresh)).toEqual([]);
    expect((await phoneWorld()).contacts).toBe(world.contacts);
    expect(intel.calls.length).toBe(calls);
    expect(logSink.lines.join('\n')).toContain('rate limiter unavailable');
  });

  it('the limiter being unavailable does NOT block confirmCode: wrong codes are still counted and the right code still verifies', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithSms({ service: svc });
    limiter.unavailable = true;
    const wrong = await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID');
    expect(wrong.details).toEqual({ attemptsRemaining: 4 });
    expect((await svc.confirmCode(x.id, x.code)).changed).toBe(true);
    // set/send are closed while the limiter is down
    await expect(pendingWithSms({ service: makeService({ rateLimiter: limiter }) })).rejects.toBeInstanceOf(AccountError);
  });

  it('with the limiter down the attempt counter still locks the challenge', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithSms({ service: svc });
    limiter.unavailable = true;
    for (let i = 0; i < 4; i++) await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'PHONE_CODE_INVALID');
    await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'PHONE_VERIFICATION_LOCKED');
    await fails(svc.confirmCode(x.id, x.code), 'PHONE_VERIFICATION_LOCKED');
  });

  it('a recovered limiter lets requests through again', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const id = await newAccount();
    limiter.unavailable = true;
    await fails(svc.setPhone(id, usNumber()), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    limiter.unavailable = false;
    expect((await svc.setPhone(id, usNumber())).changed).toBe(true);
  });

  it('without a limiter the database limits alone apply (cooldown and caps still hold)', async () => {
    const x = await pendingWithSms({ service: makeService() });
    await fails(ph.sendVerification(x.id), 'PHONE_RESEND_TOO_SOON');
  });

  it('an invalid number consumes nothing from the limiter (it is refused before the limits are touched)', async () => {
    const { svc, spy } = limited();
    const id = await newAccount();
    await fails(svc.setPhone(id, 'not a number'), 'PHONE_INVALID');
    await fails(svc.setPhone(id, gbNumber()), 'PHONE_INVALID');
    expect(spy.calls).toEqual([]);
  });
});

// ====================================================================== policy failures
describe('the policy fails closed', () => {
  const values = (over: Partial<Record<keyof PhoneVerificationPolicy, unknown>> = {}): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(PHONE_POLICY_KEYS).map(([field, key]) => [
        key,
        field in over ? over[field as keyof PhoneVerificationPolicy] : PRD[field as keyof PhoneVerificationPolicy],
      ]),
    );
  const provider = (over: Partial<Record<keyof PhoneVerificationPolicy, unknown>> = {}): PhonePolicyProvider => ({
    policy: async () => parsePhoneVerificationPolicy(values(over)),
  });

  it('a throwing policy provider is UNAVAILABLE (POLICY_UNAVAILABLE) for setPhone, sendVerification, confirmCode and getPhoneDetail, and nothing is written', async () => {
    const x = await pendingWithSms();
    const before = await snapshot(x.id);
    const world = await phoneWorld();
    const texts = sms.sent.length;
    policy.failure = new Error('configuration store is down: verification.phone.max_attempts');
    const expected = { reason: 'POLICY_UNAVAILABLE' };
    const results = await Promise.all([
      fails(ph.setPhone(x.id, usNumber()), 'UNAVAILABLE', expected),
      fails(ph.sendVerification(x.id), 'UNAVAILABLE', expected),
      fails(ph.confirmCode(x.id, x.code), 'UNAVAILABLE', expected),
      fails(ph.getPhoneDetail(x.id), 'UNAVAILABLE', expected),
    ]);
    for (const e of results) expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/configuration store|max_attempts/);
    expect(await snapshot(x.id)).toEqual(before);
    expect(await phoneWorld()).toEqual(world);
    expect(sms.sent).toHaveLength(texts);
    expect(intel.calls).toHaveLength(1); // the lookup of pendingWithSms only: a policy outage stops setPhone before the vendor
    // the cheap summary needs no configuration and keeps working
    expect((await ph.getPhoneSummary(x.id)).phoneVerificationStatus).toBe('PENDING');
    // and the correct code verifies again as soon as the policy is back
    policy.failure = undefined;
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('a policy that fails with an AccountError keeps its own error (a provider can report POLICY_INVALID itself)', async () => {
    policy.failure = new AccountError('UNAVAILABLE', 'x', { reason: 'POLICY_INVALID', field: 'maxAttempts' });
    await fails(ph.setPhone(await newAccount(), usNumber()), 'UNAVAILABLE', { reason: 'POLICY_INVALID', field: 'maxAttempts' });
  });

  it('a verification can not be completed while the policy is down: a correct code is not accepted without the limits', async () => {
    const x = await pendingWithSms();
    policy.failure = new Error('down');
    await fails(ph.confirmCode(x.id, x.code), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
  });

  it('the policy outage is logged without its cause', async () => {
    policy.failure = new Error('secret-connection-string-in-the-error');
    await rejection(ph.setPhone(await newAccount(), usNumber()));
    const lines = logSink.lines.join('\n');
    expect(lines).toContain('policy unavailable');
    expect(lines).not.toContain('secret-connection-string');
  });

  it.each([
    ['a code length below 4', { codeLength: 3 }, 'codeLength'],
    ['a code length above 10', { codeLength: 11 }, 'codeLength'],
    ['a zero validity', { validityMinutes: 0 }, 'validityMinutes'],
    ['a negative cooldown', { resendSeconds: -1 }, 'resendSeconds'],
    ['a zero hourly cap', { maxPerHour: 0 }, 'maxPerHour'],
    ['a fractional daily cap', { maxPerDay: 2.5 }, 'maxPerDay'],
    ['a string attempt limit', { maxAttempts: '5' }, 'maxAttempts'],
    ['zero accounts per number', { maxAccountsPerNumber: 0 }, 'maxAccountsPerNumber'],
    ['more than 5 accounts per number', { maxAccountsPerNumber: 6 }, 'maxAccountsPerNumber'],
    ['a missing blocked list', { blockedLineTypes: undefined }, 'blockedLineTypes'],
    ['a blocked list that is a string', { blockedLineTypes: 'VOIP' }, 'blockedLineTypes'],
    ['a blocked list that blocks MOBILE', { blockedLineTypes: ['MOBILE'] }, 'blockedLineTypes'],
    ['a blocked list with an unknown type', { blockedLineTypes: ['SATELLITE'] }, 'blockedLineTypes'],
    ['a blocked list with a duplicate', { blockedLineTypes: ['VOIP', 'VOIP'] }, 'blockedLineTypes'],
    ['a blocked list with a non-string', { blockedLineTypes: [1] }, 'blockedLineTypes'],
    ['a missing request limit', { requestsPerHour: undefined }, 'requestsPerHour'],
    ['a null number limit', { numberPerHour: null }, 'numberPerHour'],
    ['an infinite number limit', { numberPerHour: Number.POSITIVE_INFINITY }, 'numberPerHour'],
  ])('an invalid policy value (%s) is UNAVAILABLE POLICY_INVALID for every operation, and nothing is written', async (_name, over, field) => {
    const x = await pendingWithSms();
    const before = await snapshot(x.id);
    const texts = sms.sent.length;
    const svc = makeService({ policy: provider(over) });
    const expected = { reason: 'POLICY_INVALID', field };
    await fails(svc.setPhone(x.id, usNumber()), 'UNAVAILABLE', expected);
    await fails(svc.sendVerification(x.id), 'UNAVAILABLE', expected);
    await fails(svc.confirmCode(x.id, x.code), 'UNAVAILABLE', expected);
    await fails(svc.getPhoneDetail(x.id), 'UNAVAILABLE', expected);
    expect(await snapshot(x.id)).toEqual(before);
    expect(sms.sent).toHaveLength(texts);
  });

  it.each([
    ['a code length of 12', { codeLength: 12 }, 'codeLength'],
    ['5 accounts per number is fine but 9 is not', { maxAccountsPerNumber: 9 }, 'maxAccountsPerNumber'],
    ['a negative number limit', { numberPerHour: -3 }, 'numberPerHour'],
  ])('a provider that hands over an unvalidated policy with %s is refused by the service itself', async (_name, over, field) => {
    setPolicy(over as Partial<PhoneVerificationPolicy>);
    const x = await newAccount();
    await fails(ph.setPhone(x, usNumber()), 'UNAVAILABLE', { reason: 'POLICY_INVALID', field });
    expect(await contactsOf(x)).toEqual([]);
    expect(sms.sent).toEqual([]);
  });

  it('valid boundary values are accepted (cooldown 0, code length 4 and 10, attempts 1, 5 accounts per number, every type blocked)', async () => {
    const svc = makeService({
      policy: provider({
        resendSeconds: 0,
        codeLength: 10,
        maxAttempts: 1,
        maxAccountsPerNumber: 5,
        blockedLineTypes: ['LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK'],
      }),
    });
    const x = await pendingWithSms({ service: svc });
    expect(x.code).toMatch(/^[0-9]{10}$/);
    const svc4 = makeService({ policy: provider({ codeLength: 4 }) });
    expect((await pendingWithSms({ service: svc4 })).code).toMatch(/^[0-9]{4}$/);
  });

  it('an invalid number is refused as a number BEFORE the policy is read (a policy outage does not turn it into UNAVAILABLE)', async () => {
    policy.failure = new Error('down');
    await fails(ph.setPhone(await newAccount(), 'garbage'), 'PHONE_INVALID');
  });
});

// ====================================================================== state
describe('the account context reflects the phone state', () => {
  it('NONE, then PENDING, then VERIFIED, in getAccountContext and getPhoneSummary', async () => {
    const created = await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] });
    const id = created.accountId;
    expect(created.phone).toEqual({ phoneVerificationStatus: 'NONE', primary: null, pending: null });
    expect(await ph.getPhoneSummary(id)).toEqual(created.phone);

    const phone = usNumber();
    await ph.setPhone(id, phone);
    const pending = (await accounts.getAccountContext(id)).phone;
    expect(pending.phoneVerificationStatus).toBe('PENDING');
    expect(pending.primary).toBeNull();
    expect(pending.pending).toMatchObject({ maskedPhone: maskPhone(phone), status: 'PENDING', lastSentAt: null });
    expect(await ph.getPhoneSummary(id)).toEqual(pending);

    await ph.sendVerification(id);
    const sent = (await accounts.getAccountContext(id)).phone;
    expect(sent.phoneVerificationStatus).toBe('PENDING');
    expect(sent.pending!.lastSentAt).not.toBeNull();
    expect(sent.pending!.expiresAt).not.toBeNull();

    await ph.confirmCode(id, codeOf(sms.sent[0]!));
    const verified = (await accounts.getAccountContext(id)).phone;
    expect(verified).toEqual({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(phone), countryCode: 'US', verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    expect(await ph.getPhoneSummary(id)).toEqual(verified);
  });

  it('getPhoneDetail: resendAvailableAt is null before any send, set right after a send, and null again with a cooldown of 0', async () => {
    const id = await newAccount();
    expect((await ph.getPhoneDetail(id)).resendAvailableAt).toBeNull();
    await ph.setPhone(id, usNumber());
    expect((await ph.getPhoneDetail(id)).resendAvailableAt).toBeNull();
    const sent = await ph.sendVerification(id);
    const detail = await ph.getPhoneDetail(id);
    expect(detail.resendAvailableAt).toBeInstanceOf(Date);
    expect(detail.resendAvailableAt!.getTime()).toBe(sent.resendAvailableAt.getTime());
    setPolicy({ resendSeconds: 0 });
    expect((await ph.getPhoneDetail(id)).resendAvailableAt).toBeNull();
  });

  it('getPhoneDetail: attemptsRemaining follows the wrong attempts; codeLength and validityMinutes follow the policy', async () => {
    const id = await newAccount();
    const empty = await ph.getPhoneDetail(id);
    expect(empty).toMatchObject({ phoneVerificationStatus: 'NONE', attemptsRemaining: null, resendAvailableAt: null, codeLength: 6, validityMinutes: 10 });
    const x = await pendingWithSms({ id });
    expect((await ph.getPhoneDetail(id)).attemptsRemaining).toBe(5);
    await ph.confirmCode(id, wrongCode(x.code)).catch(() => undefined);
    expect((await ph.getPhoneDetail(id)).attemptsRemaining).toBe(4);
    setPolicy({ codeLength: 8, validityMinutes: 15, maxAttempts: 3 });
    expect(await ph.getPhoneDetail(id)).toMatchObject({ attemptsRemaining: 2, codeLength: 8, validityMinutes: 15 });
    await ph.confirmCode(id, x.code).catch(() => undefined);
    setPolicy({});
    const verified = await ph.getPhoneDetail(id);
    expect(verified).toMatchObject({ phoneVerificationStatus: 'VERIFIED', attemptsRemaining: null, resendAvailableAt: null });
  });

  it('getPhoneDetail contains every field of the summary plus the four detail fields, and nothing else', async () => {
    const x = await pendingWithSms();
    const detail = await ph.getPhoneDetail(x.id);
    expect(Object.keys(detail).sort()).toEqual([
      'attemptsRemaining',
      'codeLength',
      'pending',
      'phoneVerificationStatus',
      'primary',
      'resendAvailableAt',
      'validityMinutes',
    ]);
    expect(detail.pending).toMatchObject({ maskedPhone: maskPhone(x.phone), countryCode: 'US', purpose: 'INITIAL_PHONE', status: 'PENDING' });
  });

  it('getPhoneDetail after a lock shows no attempts left to count and no usable expiry', async () => {
    const x = await pendingWithSms();
    for (let i = 0; i < 5; i++) await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const detail = await ph.getPhoneDetail(x.id);
    expect(detail.attemptsRemaining).toBeNull();
    expect(detail.pending).toMatchObject({ expiresAt: null });
    expect(detail.pending!.lastSentAt).not.toBeNull();
  });

  it('getPhoneDetail of a pending change reports the change attempts, not the primary', async () => {
    const p = await verifiedAccount();
    setPolicy({ resendSeconds: 0 });
    const next = await pendingWithSms({ id: p.id, phone: usNumber() });
    await ph.confirmCode(p.id, wrongCode(next.code)).catch(() => undefined);
    const detail = await ph.getPhoneDetail(p.id);
    expect(detail.attemptsRemaining).toBe(4);
    expect(detail.phoneVerificationStatus).toBe('VERIFIED');
    expect(detail.pending).toMatchObject({ purpose: 'CHANGE_PHONE' });
  });

  it('the pending change is part of the summary next to the verified primary', async () => {
    const p = await verifiedAccount();
    const candidate = usNumber();
    await ph.setPhone(p.id, candidate);
    expect(await ph.getPhoneSummary(p.id)).toMatchObject({
      phoneVerificationStatus: 'VERIFIED',
      primary: { maskedPhone: maskPhone(p.phone) },
      pending: { maskedPhone: maskPhone(candidate), purpose: 'CHANGE_PHONE', status: 'REPLACEMENT_PENDING' },
    });
  });

  it('the summary of an unknown account is NONE (nothing to read), not an error', async () => {
    expect(await ph.getPhoneSummary(randomUUID())).toEqual({ phoneVerificationStatus: 'NONE', primary: null, pending: null });
  });

  it('the full number never appears in any summary, detail, send, confirm or context object (only the masked form)', async () => {
    const id = await newAccount();
    const phone = usNumber();
    const collected: unknown[] = [];
    collected.push(await ph.setPhone(id, nationalUs(phone), { country: 'US' }));
    collected.push(await ph.getPhoneSummary(id));
    collected.push(await ph.getPhoneDetail(id));
    collected.push(await ph.sendVerification(id));
    collected.push(await ph.getPhoneDetail(id));
    collected.push(await accounts.getAccountContext(id));
    const wrong = await rejection(ph.confirmCode(id, wrongCode(codeOf(sms.sent[0]!))));
    collected.push({ m: (wrong as AccountError).message, d: (wrong as AccountError).details });
    collected.push(await ph.confirmCode(id, codeOf(sms.sent[0]!)));
    collected.push(await ph.confirmCode(id, codeOf(sms.sent[0]!)));
    collected.push(await ph.getPhoneDetail(id));
    collected.push(await accounts.getAccountContext(id, { includeProfile: true }));
    const change = usNumber();
    collected.push(await ph.setPhone(id, change));
    collected.push(await ph.getPhoneSummary(id));
    const text = JSON.stringify(collected);
    for (const secret of [...numberVariants(phone), ...numberVariants(change)]) expect(text, `leaked ${secret}`).not.toContain(secret);
    expect(text).toContain(maskPhone(phone));
    expect(text).not.toContain(codeOf(sms.sent[0]!));
  });
});

// ====================================================================== delivery failure
describe('delivery failure', () => {
  async function failing(failure: unknown) {
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    const id = await newAccount();
    const phone = usNumber();
    await svc.setPhone(id, phone);
    scripted.next = failure;
    return { id, phone, scripted, svc };
  }

  it('a retryable SmsDeliveryError is PHONE_DELIVERY_FAILED (retryable true); the challenge is FAILED and closed DELIVERY_FAILED; no Sent event; no cooldown; the request is still audited', async () => {
    const f = await failing(new SmsDeliveryError('UNAVAILABLE', 'gateway down', true));
    const e = await fails(f.svc.sendVerification(f.id), 'PHONE_DELIVERY_FAILED', { retryable: true });
    for (const v of numberVariants(f.phone)) expect(e.message).not.toContain(v);
    const [c] = await challengesOf(f.id);
    expect(c).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED', last_sent_at: null, used_at: null, attempt_count: 0 });
    expect(c!.invalidated_at).toBeInstanceOf(Date);
    expect(await eventsOf(f.id, E.verificationSent)).toEqual([]);
    const requested = await auditOf(f.id, 'PHONE_VERIFICATION_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.changes).toMatchObject({ challengeId: c!.challenge_id });
    expect(await openChallenges(f.id)).toEqual([]);
    expect((await ph.getPhoneSummary(f.id)).pending).toMatchObject({ lastSentAt: null, expiresAt: null });
    // no cooldown: the next send goes out at once
    const sent = await f.svc.sendVerification(f.id);
    expect(30_000 - (sent.resendAvailableAt.getTime() - sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(sent.resendAvailableAt.getTime()).toBeLessThanOrEqual(sent.sentAt.getTime() + 30_000);
    expect(f.scripted.seen).toHaveLength(2);
    expect((await challengesOf(f.id)).map((x) => x.delivery_status)).toEqual(['FAILED', 'SENT']);
    expect(await eventsOf(f.id, E.verificationSent)).toHaveLength(1);
  });

  it.each([
    ['REJECTED', 'the number was refused by the gateway'],
    ['RENDER_FAILED', 'template missing'],
    ['NOT_CONFIGURED', 'no SMS provider is configured'],
  ] as const)('a %s error is not retryable', async (code, message) => {
    const f = await failing(new SmsDeliveryError(code, message, false));
    await fails(f.svc.sendVerification(f.id), 'PHONE_DELIVERY_FAILED', { retryable: false });
    expect((await challengesOf(f.id))[0]).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED' });
  });

  it('a generic Error from the sender maps to a retryable PHONE_DELIVERY_FAILED and never leaks its text', async () => {
    const f = await failing(new Error('connect ECONNREFUSED to sms.internal for hidden-recipient'));
    const e = await fails(f.svc.sendVerification(f.id), 'PHONE_DELIVERY_FAILED', { retryable: true });
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/ECONNREFUSED|sms\.internal|hidden-recipient/);
    expect(logSink.lines.join('\n')).not.toMatch(/ECONNREFUSED|sms\.internal|hidden-recipient/);
    expect((await challengesOf(f.id))[0]).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED' });
  });

  it('a sender that throws a non-Error value is handled the same way', async () => {
    const f = await failing('plain string failure');
    await fails(f.svc.sendVerification(f.id), 'PHONE_DELIVERY_FAILED', { retryable: true });
  });

  it('the failure is logged with the challenge id and the failure class, without the number or the code', async () => {
    const f = await failing(new SmsDeliveryError('REJECTED', `refused ${usNumber()}`, false));
    await rejection(f.svc.sendVerification(f.id));
    const line = logSink.lines.find((l) => l.includes('could not be delivered'))!;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: 'warn', code: 'REJECTED', retryable: false, challengeId: (await challengesOf(f.id))[0]!.challenge_id });
    for (const v of numberVariants(f.phone)) expect(line).not.toContain(v);
    expect(line).not.toContain(codeOf(f.scripted.seen[0]!));
  });

  it('the code of a message that was not delivered does not verify (PHONE_CODE_INVALID, nothing counted)', async () => {
    const f = await failing(new SmsDeliveryError('UNAVAILABLE', 'down', true));
    await rejection(f.svc.sendVerification(f.id));
    const lost = f.scripted.seen[0]!;
    await fails(f.svc.confirmCode(f.id, codeOf(lost)), 'PHONE_CODE_INVALID');
    expect((await challengesOf(f.id))[0]).toMatchObject({ attempt_count: 0, used_at: null });
    expect((await liveContacts(f.id))[0]!.status).toBe('PENDING');
    expect(await auditOf(f.id, 'PHONE_VERIFICATION_FAILED')).toEqual([]);
  });

  it('a failed resend closes only its own challenge: the earlier delivered one was already superseded, so nothing is open and a later send recovers', async () => {
    setPolicy({ resendSeconds: 0 });
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    const x = await pendingWithSms({ service: svc, texts: { sent: scripted.seen } });
    scripted.next = new SmsDeliveryError('UNAVAILABLE', 'down', true);
    await rejection(svc.sendVerification(x.id));
    expect(await openChallenges(x.id)).toEqual([]);
    await fails(svc.confirmCode(x.id, x.code), 'PHONE_CODE_INVALID');
    await svc.sendVerification(x.id);
    expect(await openChallenges(x.id)).toHaveLength(1);
    expect((await svc.confirmCode(x.id, codeOf(scripted.seen.at(-1)!))).changed).toBe(true);
  });

  it('sendVerification with a missing account or nothing pending sends nothing at all', async () => {
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    await rejection(svc.sendVerification(randomUUID()));
    await rejection(svc.sendVerification(await newAccount()));
    expect(scripted.seen).toEqual([]);
  });

  it('the SMS is delivered OUTSIDE any transaction: while the gateway hangs the account row is free and the challenge is already committed', async () => {
    const gated = new GatedSender();
    const svc = makeService({ sender: gated });
    const id = await newAccount();
    await svc.setPhone(id, usNumber());
    const release = gated.holdNext();
    const sending = settled(svc.sendVerification(id));
    for (let i = 0; i < 500 && gated.seen.length < 1; i++) await sleep(10);
    expect(gated.seen).toHaveLength(1);
    await q('SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR UPDATE NOWAIT', [id]); // would fail with 55P03 if a transaction held the row
    const [c] = await challengesOf(id);
    expect(c).toMatchObject({ delivery_status: 'PENDING', last_sent_at: null, invalidated_at: null });
    // a code typed before the delivery is acknowledged is a normal (wrong) attempt on the committed challenge
    await fails(svc.confirmCode(id, wrongCode(codeOf(gated.seen[0]!))), 'PHONE_CODE_INVALID');
    release();
    expect(await sending).toMatchObject({ codeLength: 6 });
    expect((await challengesOf(id))[0]).toMatchObject({ delivery_status: 'SENT' });
  });
});

// ====================================================================== account status
describe('suspended and closed accounts', () => {
  it('a SUSPENDED account is refused (SUSPENDED) by setPhone, sendVerification and confirmCode, and nothing changes; reactivation restores it', async () => {
    const x = await pendingWithSms();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    const before = await snapshot(x.id);
    const texts = sms.sent.length;
    await fails(ph.setPhone(x.id, usNumber()), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(ph.sendVerification(x.id), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(ph.confirmCode(x.id, x.code), 'SUSPENDED', { status: 'SUSPENDED' });
    expect(await snapshot(x.id)).toEqual(before);
    expect(sms.sent).toHaveLength(texts);
    await accounts.changeStatus(x.id, 'ACTIVE', OP);
    expect((await ph.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('a wrong code on a suspended account is refused as SUSPENDED and is not counted', async () => {
    const x = await pendingWithSms();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    await fails(ph.confirmCode(x.id, wrongCode(x.code)), 'SUSPENDED');
    expect((await challengesOf(x.id))[0]!.attempt_count).toBe(0);
  });

  it('a SUSPENDED account cannot verify a correct code and the number stays PENDING', async () => {
    const x = await pendingWithSms();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    await fails(ph.confirmCode(x.id, x.code), 'SUSPENDED');
    expect((await contactOf(x.id, x.phone)).status).toBe('PENDING');
    expect(await auditOf(x.id, 'PHONE_VERIFIED')).toEqual([]);
  });

  it('a CLOSED account is refused (CLOSED) by every phone operation', async () => {
    const x = await pendingWithSms();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    await accounts.changeStatus(x.id, 'CLOSED', OP);
    const before = await snapshot(x.id);
    await fails(ph.setPhone(x.id, usNumber()), 'CLOSED', { status: 'CLOSED' });
    await fails(ph.sendVerification(x.id), 'CLOSED', { status: 'CLOSED' });
    await fails(ph.confirmCode(x.id, x.code), 'CLOSED', { status: 'CLOSED' });
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('a suspended account that never had a number is refused the same way', async () => {
    const id = await newAccount();
    await accounts.changeStatus(id, 'SUSPENDED', OP);
    await fails(ph.setPhone(id, usNumber()), 'SUSPENDED');
    await fails(ph.sendVerification(id), 'SUSPENDED');
    await fails(ph.confirmCode(id, KNOWN_CODE), 'SUSPENDED');
    expect(await contactsOf(id)).toEqual([]);
  });

  it('the summary of a suspended account can still be read (reading is not an operation)', async () => {
    const x = await pendingWithSms();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    expect((await ph.getPhoneSummary(x.id)).phoneVerificationStatus).toBe('PENDING');
  });
});

// ====================================================================== the hash is bound to its challenge
describe('hash binding', () => {
  it('copying the code_hash of challenge A into challenge B does not make the code of A verify B', async () => {
    const idA = await newAccount();
    const idB = await newAccount();
    await ph.setPhone(idA, usNumber());
    await ph.setPhone(idB, usNumber());
    const contactA = (await liveContacts(idA))[0]!.phone_contact_id;
    const contactB = (await liveContacts(idB))[0]!.phone_contact_id;
    const challengeA = await craftChallenge(contactA, { code: KNOWN_CODE, createdSecondsAgo: 5, expiresInSeconds: 600 });
    const hashOfA = (await challengesOf(idA))[0]!.code_hash;
    expect(hashOfA).toBe(hashPhoneCode(testHashKey, challengeA, KNOWN_CODE));

    // B is crafted with A's hash copied in (the hash column cannot be updated later; a copy is only possible at insert time)
    const challengeB = await craftChallenge(contactB, { code: KNOWN_CODE, createdSecondsAgo: 5, expiresInSeconds: 600, hash: () => hashOfA });
    expect(hashPhoneCode(testHashKey, challengeB, KNOWN_CODE)).not.toBe(hashOfA);
    const e = await fails(ph.confirmCode(idB, KNOWN_CODE), 'PHONE_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await liveContacts(idB))[0]!.status).toBe('PENDING');
    // A still verifies with its own code
    expect((await ph.confirmCode(idA, KNOWN_CODE)).changed).toBe(true);
  });

  it('the phone hash of a code differs from the email hash of the same code and challenge (separate hash domains)', () => {
    const challenge = randomUUID();
    expect(hashPhoneCode(testHashKey, challenge, KNOWN_CODE)).not.toBe(hashVerificationCode(testHashKey, challenge, KNOWN_CODE));
  });

  it('an EMAIL-domain hash planted in a phone challenge never verifies the phone', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, {
      code: KNOWN_CODE,
      createdSecondsAgo: 5,
      expiresInSeconds: 600,
      hash: (challengeId) => hashVerificationCode(testHashKey, challengeId, KNOWN_CODE),
    });
    await fails(ph.confirmCode(id, KNOWN_CODE), 'PHONE_CODE_INVALID');
    expect((await liveContacts(id))[0]!.status).toBe('PENDING');
  });

  it('the same code in two challenges has two different hashes, and the hash depends on the key and on the code', () => {
    const [x, y] = [randomUUID(), randomUUID()];
    expect(hashPhoneCode(testHashKey, x, KNOWN_CODE)).not.toBe(hashPhoneCode(testHashKey, y, KNOWN_CODE));
    expect(hashPhoneCode(testHashKey, x, KNOWN_CODE)).not.toBe(hashPhoneCode(otherHashKey, x, KNOWN_CODE));
    expect(hashPhoneCode(testHashKey, x, KNOWN_CODE)).not.toBe(hashPhoneCode(testHashKey, x, '654321'));
    expect(hashPhoneCode(testHashKey, x, KNOWN_CODE)).toBe(hashPhoneCode(testHashKey, x, KNOWN_CODE));
    expect(hashPhoneCode(testHashKey, x, KNOWN_CODE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a crafted challenge with a correctly bound hash verifies (the control of the tampering test)', async () => {
    const id = await newAccount();
    await ph.setPhone(id, usNumber());
    const contactId = (await liveContacts(id))[0]!.phone_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, createdSecondsAgo: 5, expiresInSeconds: 600 });
    expect((await ph.confirmCode(id, KNOWN_CODE)).changed).toBe(true);
  });
});

// ====================================================================== the scanners are not vacuous
describe('the secret scanner detects what it is meant to detect (negative controls)', () => {
  const plantAudit = (id: string, changes: Record<string, unknown>) =>
    q(
      `INSERT INTO identity.account_audit_events (actor, action, account_id, changes, correlation_id) VALUES ('planted-by-test', 'PROFILE_UPDATED', $1, $2::jsonb, 'planted')`,
      [id, JSON.stringify(changes)],
    );
  const plantEvent = (id: string, payload: Record<string, unknown>) =>
    q(
      `INSERT INTO integration.outbox_events (aggregate_type, aggregate_id, event_type, event_version, actor_type, payload_json, correlation_id)
       VALUES ('identity_account', $1, 'bananagig.identity.phone-verified.v1', 1, 'user', $2::jsonb, 'planted')`,
      [id, JSON.stringify(payload)],
    );

  it('passes on a clean account (the control of the controls)', async () => {
    const x = await pendingWithSms();
    await ph.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await expectNoSecrets(x.id, await secretsOf(x.id, [x.message]));
  });

  const PLANTS: [string, (x: Issued, hash: string) => Promise<unknown> | void, RegExp][] = [
    ['a code in an audit row', (x) => plantAudit(x.id, { note: `typed ${x.code}` }), /audit contains a verification code/],
    ['a stored hash in an audit row', (x, h) => plantAudit(x.id, { note: h }), /audit contains a stored hash/],
    ['the E.164 number in an audit row', (x) => plantAudit(x.id, { note: x.phone }), /audit contains the full number/],
    ['the national digits in an audit row', (x) => plantAudit(x.id, { note: nationalDigits(x.phone) }), /audit contains the full number/],
    ['a formatted number in an audit row', (x) => plantAudit(x.id, { note: nationalUs(x.phone) }), /audit contains the full number/],
    ['an unmasked foreign number in an audit row', (x) => plantAudit(x.id, { note: '+14155550000' }), /masked numbers only/],
    ['a number in an event payload', (x) => plantEvent(x.id, { accountId: x.id, note: x.phone }), /outbox contains the full number/],
    ['an unmasked foreign number in an event payload', (x) => plantEvent(x.id, { accountId: x.id, note: '+14155550000' }), /identifiers only/],
    ['a code in an event payload', (x) => plantEvent(x.id, { accountId: x.id, attemptCount: x.code }), /outbox contains a verification code/],
    [
      'a code in a log line',
      (x) => void logSink.lines.push(JSON.stringify({ level: 'info', message: 'oops', c: x.code })),
      /logs contains a verification code/,
    ],
    ['the number in a log line', (x) => void logSink.lines.push(JSON.stringify({ level: 'info', message: x.phone })), /logs contains the full number/],
    [
      'the national digits in a log line',
      (x) => void logSink.lines.push(JSON.stringify({ level: 'info', message: nationalDigits(x.phone) })),
      /logs contains the full number/,
    ],
    ['a stored hash in a log line', (x, h) => void logSink.lines.push(JSON.stringify({ level: 'info', message: h })), /logs contains a stored hash/],
  ];
  it.each(PLANTS)('detects %s', async (_name, plant, expected) => {
    const x = await pendingWithSms();
    const hash = (await challengesOf(x.id))[0]!.code_hash;
    const secrets = await secretsOf(x.id, [x.message]);
    await plant(x, hash);
    const failure = await rejection(expectNoSecrets(x.id, secrets));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(expected);
  });

  it('the number scan finds the number in phone_contacts only (the table scanner is not vacuous either)', async () => {
    const x = await pendingWithSms();
    expect(await tablesMentioning(x.phone)).toEqual(['identity.phone_contacts']);
    await plantAudit(x.id, { note: x.phone });
    expect(await tablesMentioning(x.phone)).toEqual(['identity.account_audit_events', 'identity.phone_contacts']);
  });
});
