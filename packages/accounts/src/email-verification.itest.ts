// Integration tests of the email contact and its verification (ID-002): the real AccountService and EmailVerificationService over a real, freshly
// migrated PostgreSQL database, the real transactional outbox, the RecordingEmailSender (the code and the magic-link token are read back from the message
// variables, exactly as the person would read them from the mail) and the MemoryRateLimiter with an injectable clock. The limits are a mutable fake policy
// seeded with the PRD values. Every behaviour is asserted against the rows it leaves: contacts, challenges, audit and outbox events.
//
// Time: the DATABASE clock decides expiry, cooldown and the hourly and daily caps. Expiry is tested with challenge rows crafted by SQL (past created_at and
// expires_at, hashes computed with the production functions); the cooldown and the caps by changing the fake policy. Races are real (parallel service
// calls), or deterministic (calls queued behind a held account row lock, so their order is fixed).
//
// Checkpoint test numbers (#n) refer to the ID-002 test list.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_EVENTS, maskEmail } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import {
  EmailDeliveryError,
  MemoryRateLimiter,
  RecordingEmailSender,
  type EmailMessage,
  type EmailSendResult,
  type EmailSender,
  type RateDecision,
  type RateLimiter,
  type RateRule,
} from '@bananagig/platform';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import {
  AccountError,
  AccountService,
  EMAIL_POLICY_KEYS,
  EmailVerificationService,
  hashDimension,
  hashMagicToken,
  hashVerificationCode,
  parseEmailVerificationPolicy,
  type EmailVerificationDeps,
  type EmailVerificationPolicy,
  type SendVerificationResult,
  type VerificationPolicyProvider,
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
const E = EMAIL_EVENTS;
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const OP = { actor: 'admin:operator-1', reason: 'integration test' };
const testHashKey = 'email-verification-test-hmac-'.repeat(2);
const otherHashKey = 'another-test-hmac-'.repeat(3);
/** The PRD values (SV-03.01, CU-03.06) plus the two abuse limits seeded by migration 0010. */
const PRD: EmailVerificationPolicy = {
  codeLength: 6,
  validityMinutes: 10,
  resendSeconds: 30,
  maxPerHour: 5,
  maxPerDay: 10,
  maxAttempts: 5,
  requestsPerHour: 30,
  addressPerHour: 5,
};

/** A mutable fake of the configuration-backed policy provider. */
class FakePolicy implements VerificationPolicyProvider {
  current: EmailVerificationPolicy = { ...PRD };
  failure: unknown;
  async policy(): Promise<EmailVerificationPolicy> {
    if (this.failure !== undefined) throw this.failure;
    return { ...this.current };
  }
  reset(): void {
    this.current = { ...PRD };
    this.failure = undefined;
  }
}

/** A sender that records EVERY attempt (also the failing one, so a test can read the code that never arrived) and fails on demand with anything. */
class ScriptedSender implements EmailSender {
  readonly seen: EmailMessage[] = [];
  next: unknown;
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.seen.push(message);
    if (this.next !== undefined) {
      const failure = this.next;
      this.next = undefined;
      throw failure;
    }
    return { messageId: `scripted-${this.seen.length}`, templateVersion: null };
  }
}

/** A sender whose next delivery stays in flight until the test releases it (a slow SMTP relay). */
class GatedSender implements EmailSender {
  readonly seen: EmailMessage[] = [];
  private gate: Promise<void> | undefined;
  holdNext(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  async send(message: EmailMessage): Promise<EmailSendResult> {
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
let ev: EmailVerificationService;
const policy = new FakePolicy();
const sender = new RecordingEmailSender();
const db = () => iso.database;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db().query<T>(text, params);

const linkFor = (token: string): string => `https://app.test/verify-email#token=${encodeURIComponent(token)}`;
function makeService(over: Partial<EmailVerificationDeps> = {}): EmailVerificationService {
  return new EmailVerificationService({ database: bigDb, policy, sender, linkFor, hashSecret: testHashKey, ...over });
}
const setPolicy = (over: Partial<EmailVerificationPolicy>): void => {
  policy.current = { ...PRD, ...over };
};

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below need more requests in flight
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 28, connectionTimeoutMs: 20_000 } });
  accounts = new AccountService({ database: bigDb });
  ev = makeService();
});
afterAll(async () => {
  await bigDb?.close();
  await iso?.drop();
});
beforeEach(() => {
  policy.reset();
  sender.sent.length = 0;
  sender.failNext = undefined;
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

const addr = (tag = 'u'): string => `${tag}-${randomUUID()}@example.test`;
const localPart = (address: string): string => address.split('@')[0]!;
const fakeToken = (): string => randomBytes(32).toString('base64url');
/** A code that is certainly not `code`. */
const wrongCode = (code: string): string => String((Number(code) + 1) % 10 ** code.length).padStart(code.length, '0');

async function newAccount(): Promise<string> {
  return (await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] })).accountId;
}

// ---------------------------------------------------------------- reading what the person reads in the mail
const codeOf = (m: EmailMessage): string => String(m.variables.verification_code);
const tokenOf = (m: EmailMessage): string => decodeURIComponent(new URL(String(m.variables.verification_url)).hash.slice('#token='.length));

interface Issued {
  id: string;
  address: string;
  code: string;
  token: string;
  message: EmailMessage;
  sent: SendVerificationResult;
}
/** An account with a pending address and a delivered verification message (the code and the token read back from the message). */
async function pendingWithMail(
  o: { id?: string; address?: string; service?: EmailVerificationService; mail?: { sent: readonly EmailMessage[] } } = {},
): Promise<Issued> {
  const id = o.id ?? (await newAccount());
  const address = o.address ?? addr('p');
  const service = o.service ?? ev;
  const mail = o.mail ?? sender;
  await service.setEmail(id, address);
  const before = mail.sent.length;
  const sent = await service.sendVerification(id);
  const message = mail.sent[before]!;
  return { id, address, code: codeOf(message), token: tokenOf(message), message, sent };
}
/** A resend: returns the new message's code and token. */
async function resend(id: string, service: EmailVerificationService = ev): Promise<{ code: string; token: string; message: EmailMessage }> {
  const before = sender.sent.length;
  await service.sendVerification(id);
  const message = sender.sent[before]!;
  return { code: codeOf(message), token: tokenOf(message), message };
}
/** An account whose address is VERIFIED through the code. */
async function verifiedAccount(address = addr('v')): Promise<Issued & { contactId: string }> {
  const issued = await pendingWithMail({ address });
  await ev.confirmCode(issued.id, issued.code);
  return { ...issued, contactId: (await contactOf(issued.id, address)).email_contact_id };
}

// ---------------------------------------------------------------- row inspectors
interface ContactT {
  email_contact_id: string;
  email_normalized: string;
  status: string;
  is_primary: boolean;
  source: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}
interface ChallengeT {
  challenge_id: string;
  email_contact_id: string;
  purpose: string;
  code_hash: string;
  magic_token_hash: string;
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  consumed_via: string | null;
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
  email_contact_id: string | null;
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
    `SELECT email_contact_id, email_normalized, status, is_primary, source, verified_at, disabled_at, disabled_reason
       FROM identity.email_contacts WHERE account_id = $1 ORDER BY created_at, email_contact_id`,
    [id],
  );
/** The newest row of an address on an account. */
const contactOf = async (id: string, address: string): Promise<ContactT> => (await contactsOf(id)).filter((c) => c.email_normalized === address).at(-1)!;
const liveContacts = async (id: string) => (await contactsOf(id)).filter((c) => c.status !== 'DISABLED');
const challengesOf = (id: string) =>
  q<ChallengeT>(
    `SELECT c.challenge_id, c.email_contact_id, c.purpose, c.code_hash, c.magic_token_hash, c.expires_at, c.created_at, c.used_at, c.consumed_via, c.attempt_count,
            c.invalidated_at, c.invalidation_reason, c.delivery_status, c.last_sent_at, c.correlation_id
       FROM identity.email_verification_challenges c JOIN identity.email_contacts k USING (email_contact_id)
      WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
    [id],
  );
const openChallenges = async (id: string) => (await challengesOf(id)).filter((c) => c.used_at === null && c.invalidated_at === null);
/** The email audit rows of an account, oldest first (account creation rows are not email rows). */
const audit = (id: string) =>
  q<AuditT>(
    `SELECT action, actor, email_contact_id, changes, reason, correlation_id FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'EMAIL\\_%' ORDER BY occurred_at, audit_event_id`,
    [id],
  );
const auditOf = async (id: string, action: string) => (await audit(id)).filter((a) => a.action === action);
const events = (id: string) =>
  q<EventT>(
    `SELECT event_type, aggregate_type, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.email-%' ORDER BY created_at, outbox_event_id`,
    [id],
  );
const eventsOf = async (id: string, type: string) => (await events(id)).filter((e) => e.event_type === type);
const mailsTo = (address: string) => sender.sent.filter((m) => m.to === address);

/** Everything the email feature stored for an account, to prove that a refused call left nothing behind. */
async function snapshot(id: string) {
  return {
    contacts: await q('SELECT * FROM identity.email_contacts WHERE account_id = $1 ORDER BY created_at, email_contact_id', [id]),
    challenges: await q(
      `SELECT c.* FROM identity.email_verification_challenges c JOIN identity.email_contacts k USING (email_contact_id) WHERE k.account_id = $1 ORDER BY c.created_at, c.challenge_id`,
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
/** Global row counts of the email feature (an unknown or refused request must not add anything anywhere). */
async function emailWorld() {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  return {
    contacts: await n('SELECT count(*)::int AS n FROM identity.email_contacts'),
    challenges: await n('SELECT count(*)::int AS n FROM identity.email_verification_challenges'),
    audit: await n("SELECT count(*)::int AS n FROM identity.account_audit_events WHERE action LIKE 'EMAIL\\_%'"),
    events: await n("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.email-%'"),
  };
}
/** The invariants that must hold after any interleaving (checked for every account of this database). */
async function expectEmailInvariants(): Promise<void> {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  expect(
    await n(`SELECT count(*)::int AS n FROM (SELECT account_id FROM identity.email_contacts WHERE is_primary GROUP BY account_id HAVING count(*) > 1) x`),
    'two primaries',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM (SELECT account_id FROM identity.email_contacts WHERE status IN ('PENDING', 'REPLACEMENT_PENDING') GROUP BY account_id HAVING count(*) > 1) x`,
    ),
    'two open candidates',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM (SELECT email_normalized FROM identity.email_contacts WHERE status = 'VERIFIED' GROUP BY email_normalized HAVING count(*) > 1) x`,
    ),
    'a verified address on two accounts',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.email_verification_challenges c JOIN identity.email_contacts k USING (email_contact_id)
      WHERE c.used_at IS NULL AND c.invalidated_at IS NULL AND k.status NOT IN ('PENDING', 'REPLACEMENT_PENDING')`),
    'an open challenge on a contact that is not pending',
  ).toBe(0);
  expect(
    await n(`SELECT count(*)::int AS n FROM identity.email_verification_challenges c JOIN identity.email_contacts k USING (email_contact_id)
      WHERE c.used_at IS NOT NULL AND NOT (k.status = 'VERIFIED' OR k.disabled_reason = 'REPLACED')`),
    'a consumed challenge whose address is not (or was never) verified',
  ).toBe(0);
  expect(
    await n(
      `SELECT count(*)::int AS n FROM identity.email_contacts p WHERE p.status = 'PENDING' AND EXISTS (SELECT 1 FROM identity.email_contacts x WHERE x.account_id = p.account_id AND x.is_primary)`,
    ),
    'an initial pending address next to a primary',
  ).toBe(0);
}

// ---------------------------------------------------------------- crafted challenges (time travel by SQL)
interface CraftOptions {
  code: string;
  token: string;
  /** created_at = now - this many seconds. */
  createdSecondsAgo: number;
  /** expires_at = now + this many seconds (negative: already expired). */
  expiresInSeconds: number;
  /** Close the challenge right away (a historic, superseded send). */
  closeAs?: 'SUPERSEDED';
}
/** Inserts an open challenge with explicit times for the contact and the production hashes of a known code and token. Returns the challenge id. */
async function craftChallenge(contactId: string, o: CraftOptions): Promise<string> {
  const challengeId = randomUUID();
  const status = (await q<{ status: string }>('SELECT status FROM identity.email_contacts WHERE email_contact_id = $1', [contactId]))[0]!.status;
  await q(
    `INSERT INTO identity.email_verification_challenges (challenge_id, email_contact_id, purpose, code_hash, magic_token_hash, created_at, expires_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() - make_interval(secs => $6::float8), clock_timestamp() + make_interval(secs => $7::float8), 'crafted-by-test')`,
    [
      challengeId,
      contactId,
      status === 'PENDING' ? 'INITIAL_EMAIL' : 'CHANGE_EMAIL',
      hashVerificationCode(testHashKey, challengeId, o.code),
      hashMagicToken(testHashKey, o.token),
      o.createdSecondsAgo,
      o.expiresInSeconds,
    ],
  );
  if (o.closeAs)
    await q(`UPDATE identity.email_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = $2 WHERE challenge_id = $1`, [
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
/** A numeric code is short: ids, hashes and timestamps are removed first so a chance digit run inside them cannot make a scan flaky. */
const mentionsCode = (text: string, code: string): boolean =>
  new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`).test(text.replace(UUID_TEXT, '').replace(HEX64_TEXT, '').replace(TIME_TEXT, ''));
const MASKED_TEXT = /[a-z0-9]\*\*\*@[a-z0-9]\*\*\*\.[a-z]+/g;

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
  tokens: string[];
  addresses: string[];
}
/** The secrets of a set of messages (what the person received) and the addresses of an account's contacts. */
async function secretsOf(id: string, messages: readonly EmailMessage[]): Promise<Secrets> {
  return {
    codes: messages.map(codeOf),
    tokens: messages.map(tokenOf),
    addresses: (await contactsOf(id)).map((c) => c.email_normalized),
  };
}
/**
 * The audit rows, the outbox payloads and every log line of an account contain no code, no token, no hash and no full address (a masked address and ids
 * are allowed). Returns the texts scanned so a test can add its own assertions.
 */
async function expectNoSecrets(id: string, s: Secrets): Promise<{ audit: string; outbox: string; logs: string }> {
  const hashes = (await challengesOf(id)).flatMap((c) => [c.code_hash, c.magic_token_hash]);
  const auditText = JSON.stringify(await q('SELECT to_jsonb(a) AS j FROM identity.account_audit_events a WHERE a.account_id = $1', [id]));
  const outboxText = JSON.stringify(await q('SELECT to_jsonb(o) AS j FROM integration.outbox_events o WHERE o.aggregate_id = $1', [id]));
  const logsText = logSink.lines.join('\n');
  for (const [where, text] of Object.entries({ audit: auditText, outbox: outboxText, logs: logsText })) {
    for (const c of s.codes) expect(mentionsCode(text, c), `${where} contains a verification code`).toBe(false);
    for (const t of s.tokens) expect(text.includes(t), `${where} contains a magic-link token`).toBe(false);
    for (const h of hashes) expect(text.includes(h), `${where} contains a stored hash`).toBe(false);
    for (const a of s.addresses) {
      expect(text.includes(a), `${where} contains a full address`).toBe(false);
      expect(text.includes(localPart(a)), `${where} contains the local part of an address`).toBe(false);
    }
  }
  expect(outboxText, 'outbox payloads carry identifiers only').not.toContain('@');
  expect(auditText.replace(MASKED_TEXT, ''), 'audit rows hold masked addresses only').not.toContain('@');
  expect(logsText).not.toContain('@');
  return { audit: auditText, outbox: outboxText, logs: logsText };
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

// ====================================================================== #14 add the initial email
describe('setEmail: the first address (#14)', () => {
  it('adds a PENDING address: masked summary, EMAIL_ADDED audit, ContactAdded event, and no message is sent yet', async () => {
    const id = await newAccount();
    const address = addr('first');
    const r = await ev.setEmail(id, address);
    expect(r.changed).toBe(true);
    expect(r.email).toEqual({
      emailVerificationStatus: 'PENDING',
      primary: null,
      pending: { maskedEmail: maskEmail(address), purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null },
    });
    const [c] = await contactsOf(id);
    expect(c).toMatchObject({
      email_normalized: address,
      status: 'PENDING',
      is_primary: false,
      source: 'USER_ENTERED',
      verified_at: null,
      disabled_at: null,
      disabled_reason: null,
    });
    expect(await challengesOf(id)).toEqual([]);
    expect(sender.sent).toEqual([]);

    const a = await audit(id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'EMAIL_ADDED', actor: `account:${id}`, email_contact_id: c!.email_contact_id, reason: null });
    expect(a[0]!.changes).toEqual({ status: [null, 'PENDING'], maskedEmail: maskEmail(address), purpose: 'INITIAL_EMAIL' });

    const added = await eventsOf(id, E.contactAdded);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${id}` });
    expect(added[0]!.payload_json).toEqual({
      accountId: id,
      emailContactId: c!.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'USER_ENTERED',
      status: 'PENDING',
    });
    expect(await eventsOf(id, E.changeRequested)).toEqual([]);
    expect(await events(id)).toHaveLength(1);
  });

  it('stores the canonical form: trimmed, lower-cased, IDNA domain, and keeps dots and +tags', async () => {
    const id = await newAccount();
    const tag = randomUUID();
    await ev.setEmail(id, `  Ana.B+${tag}@Example.TEST  `);
    expect((await contactsOf(id))[0]!.email_normalized).toBe(`ana.b+${tag}@example.test`);

    const id2 = await newAccount();
    await ev.setEmail(id2, `user-${tag}@B${String.fromCodePoint(0xfc)}cher.example`);
    expect((await contactsOf(id2))[0]!.email_normalized).toBe(`user-${tag}@xn--bcher-kva.example`);
  });

  it('the same address again changes nothing: changed false, one contact, one audit row, one event (also in another spelling)', async () => {
    const id = await newAccount();
    const address = addr('same');
    const first = await ev.setEmail(id, address);
    const before = await snapshot(id);
    const again = await ev.setEmail(id, address);
    const respelled = await ev.setEmail(id, ` ${address.toUpperCase()} `);
    expect(again).toEqual({ changed: false, email: first.email });
    expect(respelled).toEqual({ changed: false, email: first.email });
    expect(await snapshot(id)).toEqual(before);
    expect(await contactsOf(id)).toHaveLength(1);
    expect(await audit(id)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
  });

  const INVALID: [string, unknown, string][] = [
    ['an empty string', '', 'REQUIRED'],
    ['blanks only', '   ', 'REQUIRED'],
    ['a number', 42, 'REQUIRED'],
    ['null', null, 'REQUIRED'],
    ['no @', 'plain.text', 'INVALID_FORMAT'],
    ['two @', 'a@b@example.test', 'INVALID_FORMAT'],
    ['no domain dot', 'a@localhost', 'INVALID_FORMAT'],
    ['an IP literal', 'a@[127.0.0.1]', 'INVALID_FORMAT'],
    ['a space in the local part', 'a b@example.test', 'INVALID_FORMAT'],
    ['a local part over 64 characters', `${'a'.repeat(65)}@example.test`, 'TOO_LONG'],
    ['an address over 1024 characters', `${'a'.repeat(1030)}@example.test`, 'TOO_LONG'],
    ['a non-ASCII local part', `${String.fromCodePoint(0xfc)}ser@example.test`, 'UNSUPPORTED'],
    ['a control character', `a${String.fromCodePoint(0)}b@example.test`, 'INVALID_CHARACTERS'],
    ['a bidirectional override', `a${String.fromCodePoint(0x202e)}b@example.test`, 'INVALID_CHARACTERS'],
  ];
  it.each(INVALID)('refuses %s with EMAIL_INVALID (reason and message key) and writes nothing', async (_name, input, issue) => {
    const id = await newAccount();
    const before = await snapshot(id);
    const world = await emailWorld();
    const e = await fails(ev.setEmail(id, input), 'EMAIL_INVALID');
    expect(e.details).toEqual({ reason: issue, messageKey: `account.email.error.${issue.toLowerCase()}` });
    expect(await snapshot(id)).toEqual(before);
    expect(await emailWorld()).toEqual(world);
    expect(sender.sent).toEqual([]);
  });

  it('the refusal of an invalid address never echoes the address', async () => {
    const id = await newAccount();
    const bad = `not-an-address-${randomUUID()}`;
    const e = await fails(ev.setEmail(id, bad), 'EMAIL_INVALID');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(bad);
  });

  it('an unknown account is NOT_FOUND and nothing is written', async () => {
    const world = await emailWorld();
    await fails(ev.setEmail(randomUUID(), addr()), 'NOT_FOUND');
    await fails(ev.confirmCode(randomUUID(), KNOWN_CODE), 'NOT_FOUND');
    await fails(ev.confirmLink(randomUUID(), fakeToken()), 'EMAIL_LINK_INVALID');
    await fails(ev.bootstrapIdpEmail(randomUUID(), { email: addr(), emailVerified: true, identityProvider: 'google' }, new Set(['google'])), 'NOT_FOUND');
    expect(await emailWorld()).toEqual(world);
  });

  it('a different address supersedes the pending one: the old contact is DISABLED SUPERSEDED and its challenge is closed', async () => {
    const first = await pendingWithMail({ address: addr('one') });
    const second = addr('two');
    const r = await ev.setEmail(first.id, second);
    expect(r.changed).toBe(true);
    expect(r.email.pending).toEqual({ maskedEmail: maskEmail(second), purpose: 'INITIAL_EMAIL', status: 'PENDING', lastSentAt: null, expiresAt: null });
    const [old, fresh] = await contactsOf(first.id);
    expect(old).toMatchObject({ email_normalized: first.address, status: 'DISABLED', disabled_reason: 'SUPERSEDED', is_primary: false });
    expect(old!.disabled_at).toBeInstanceOf(Date);
    expect(fresh).toMatchObject({ email_normalized: second, status: 'PENDING' });
    expect((await liveContacts(first.id)).map((c) => c.email_normalized)).toEqual([second]);

    const [challenge] = await challengesOf(first.id);
    expect(challenge).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    expect(challenge!.invalidated_at).toBeInstanceOf(Date);

    const added = await auditOf(first.id, 'EMAIL_ADDED');
    expect(added).toHaveLength(2);
    expect(added[1]!.changes).toEqual({
      status: [null, 'PENDING'],
      maskedEmail: maskEmail(second),
      purpose: 'INITIAL_EMAIL',
      supersededContactId: old!.email_contact_id,
    });
    expect(await eventsOf(first.id, E.contactAdded)).toHaveLength(2);
  });

  it('after the address was replaced, the old code and the old link do not verify the old address (the new one has no challenge yet)', async () => {
    const first = await pendingWithMail({ address: addr('one') });
    await ev.setEmail(first.id, addr('two'));
    await fails(ev.confirmCode(first.id, first.code), 'EMAIL_CODE_INVALID');
    await fails(ev.confirmLink(first.id, first.token), 'EMAIL_CODE_USED');
    expect((await liveContacts(first.id))[0]!.status).toBe('PENDING');
    expect(await auditOf(first.id, 'EMAIL_VERIFIED')).toEqual([]);
  });
});

// ====================================================================== #15 send the verification
describe('sendVerification: the message and what is stored (#15)', () => {
  it('sends ONE message: the canonical recipient, the template key and the typed variables (code, link, minutes)', async () => {
    const id = await newAccount();
    const address = addr('send');
    await ev.setEmail(id, ` ${address.toUpperCase()} `);
    await ev.sendVerification(id);
    expect(sender.sent).toHaveLength(1);
    const m = sender.sent[0]!;
    expect(m.to).toBe(address);
    expect(m.templateKey).toBe('account.email.verification');
    expect(Object.keys(m.variables).sort()).toEqual(['expiry_minutes', 'verification_code', 'verification_url']);
    expect(typeof m.variables.verification_code).toBe('string');
    expect(m.variables.verification_code).toMatch(/^[0-9]{6}$/);
    expect(m.variables.expiry_minutes).toBe(10);
    expect(tokenOf(m)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.variables.verification_url).toBe(linkFor(tokenOf(m)));
    expect(m.locale).toBeUndefined();
    expect(typeof m.correlationId).toBe('string');
    expect(m.correlationId.length).toBeGreaterThan(0);
    expect(Object.keys(m).sort()).toEqual(['correlationId', 'locale', 'templateKey', 'to', 'variables']);
  });

  it('answers with the send times, the policy and the masked state; resendAvailableAt is sentAt + the cooldown (30 s)', async () => {
    const x = await pendingWithMail();
    const [c] = await challengesOf(x.id);
    expect(x.sent.sentAt.getTime()).toBe(c!.last_sent_at!.getTime());
    expect(x.sent.expiresAt.getTime()).toBe(c!.expires_at.getTime());
    // the cooldown runs from the creation of the challenge (a delivery in flight holds a second send back), which precedes the acceptance by the sender
    expect(30_000 - (x.sent.resendAvailableAt.getTime() - x.sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(x.sent.resendAvailableAt.getTime()).toBeLessThanOrEqual(x.sent.sentAt.getTime() + 30_000);
    expect(x.sent.codeLength).toBe(6);
    expect(x.sent.validityMinutes).toBe(10);
    expect(x.sent.email).toEqual({
      emailVerificationStatus: 'PENDING',
      primary: null,
      pending: {
        maskedEmail: maskEmail(x.address),
        purpose: 'INITIAL_EMAIL',
        status: 'PENDING',
        lastSentAt: x.sent.sentAt.toISOString(),
        expiresAt: x.sent.expiresAt.toISOString(),
      },
    });
  });

  it('stores HASHES only: code_hash and magic_token_hash are the keyed hashes, bound to the challenge, and differ from the plaintext', async () => {
    const x = await pendingWithMail();
    const [c] = await challengesOf(x.id);
    expect(c!.code_hash).not.toBe(x.code);
    expect(c!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.code_hash).toBe(hashVerificationCode(testHashKey, c!.challenge_id, x.code));
    expect(c!.magic_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.magic_token_hash).not.toBe(x.token);
    expect(c!.magic_token_hash).toBe(hashMagicToken(testHashKey, x.token));
    expect(c).toMatchObject({
      purpose: 'INITIAL_EMAIL',
      delivery_status: 'SENT',
      attempt_count: 0,
      used_at: null,
      consumed_via: null,
      invalidated_at: null,
      invalidation_reason: null,
    });
    expect(c!.last_sent_at).toBeInstanceOf(Date);
    const lifetime = c!.expires_at.getTime() - c!.created_at.getTime();
    between(lifetime, 600_000, 601_000);
  });

  it('neither the code nor the token appears anywhere in the database (challenge, contact, audit and outbox rows)', async () => {
    const x = await pendingWithMail();
    await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    expect(await tablesMentioning(x.token)).toEqual([]);
    const text = JSON.stringify({
      challenges: await q('SELECT to_jsonb(c) AS j FROM identity.email_verification_challenges c'),
      contacts: await q('SELECT to_jsonb(c) AS j FROM identity.email_contacts c WHERE account_id = $1', [x.id]),
      audit: await q('SELECT to_jsonb(a) AS j FROM identity.account_audit_events a WHERE account_id = $1', [x.id]),
      outbox: await q('SELECT to_jsonb(o) AS j FROM integration.outbox_events o WHERE aggregate_id = $1', [x.id]),
    });
    expect(mentionsCode(text, x.code)).toBe(false);
    expect(text).not.toContain(x.token);
  });

  it('records the request in the audit trail (masked address, purpose, challenge id) and the delivery in a Sent event', async () => {
    const x = await pendingWithMail();
    const [c] = await challengesOf(x.id);
    const contactId = (await contactOf(x.id, x.address)).email_contact_id;
    const requested = await auditOf(x.id, 'EMAIL_VERIFICATION_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ actor: `account:${x.id}`, email_contact_id: contactId });
    expect(requested[0]!.changes).toEqual({ maskedEmail: maskEmail(x.address), purpose: 'INITIAL_EMAIL', challengeId: c!.challenge_id });
    const sent = await eventsOf(x.id, E.verificationSent);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload_json).toEqual({
      accountId: x.id,
      emailContactId: contactId,
      challengeId: c!.challenge_id,
      purpose: 'INITIAL_EMAIL',
      expiresAt: x.sent.expiresAt.toISOString(),
    });
  });

  it('takes the code length and the validity from the policy', async () => {
    setPolicy({ codeLength: 8, validityMinutes: 3 });
    const x = await pendingWithMail();
    expect(x.code).toMatch(/^[0-9]{8}$/);
    expect(x.message.variables.expiry_minutes).toBe(3);
    expect(x.sent).toMatchObject({ codeLength: 8, validityMinutes: 3 });
    const [c] = await challengesOf(x.id);
    between(c!.expires_at.getTime() - c!.created_at.getTime(), 180_000, 181_000);
  });

  it('passes the preferred locale of the profile to the renderer', async () => {
    const id = await newAccount();
    await accounts.upsertProfile(id, { firstName: 'Ana', lastName: 'Martin', preferredLocale: 'en-US' }, { actor: 'account:self' });
    const x = await pendingWithMail({ id });
    expect(x.message.locale).toBe('en-US');
  });

  it('uses the template key of the deps when one is given', async () => {
    const custom = makeService({ templateKey: 'account.email.custom' });
    const x = await pendingWithMail({ service: custom });
    expect(x.message.templateKey).toBe('account.email.custom');
  });

  it('the correlation id of the request is the message id, the challenge id, the audit id and the event id', async () => {
    const correlationId = `corr-${randomUUID()}`;
    const id = await newAccount();
    await ev.setEmail(id, addr('corr'));
    await runWithCorrelation(correlationId, () => ev.sendVerification(id));
    expect(sender.sent[0]!.correlationId).toBe(correlationId);
    expect((await challengesOf(id))[0]!.correlation_id).toBe(correlationId);
    expect((await auditOf(id, 'EMAIL_VERIFICATION_REQUESTED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(id, E.verificationSent))[0]!.correlation_id).toBe(correlationId);
  });

  it('without a request context a correlation id is minted and still shared by the message, the challenge and the audit row', async () => {
    const x = await pendingWithMail();
    const cid = x.message.correlationId;
    expect(cid.length).toBeGreaterThan(0);
    expect((await challengesOf(x.id))[0]!.correlation_id).toBe(cid);
    expect((await auditOf(x.id, 'EMAIL_VERIFICATION_REQUESTED'))[0]!.correlation_id).toBe(cid);
  });

  it('each send uses a fresh code and a fresh token', async () => {
    setPolicy({ resendSeconds: 0 });
    const first = await pendingWithMail();
    const second = await resend(first.id);
    expect(second.token).not.toBe(first.token);
    const hashes = (await challengesOf(first.id)).map((c) => c.magic_token_hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('is NOT_PENDING when the account has no address at all, and when it only has a verified primary', async () => {
    const empty = await newAccount();
    await fails(ev.sendVerification(empty), 'EMAIL_NOT_PENDING');
    const v = await verifiedAccount();
    const before = await snapshot(v.id);
    await fails(ev.sendVerification(v.id), 'EMAIL_NOT_PENDING');
    expect(await snapshot(v.id)).toEqual(before);
    expect(sender.sent).toHaveLength(1); // the verification of v itself
    await fails(ev.sendVerification(randomUUID()), 'NOT_FOUND'); // an account that does not exist, like every other operation
  });
});

// ====================================================================== #22 resend cooldown
describe('the resend cooldown (#22)', () => {
  it('a second send within the cooldown is EMAIL_RESEND_TOO_SOON (retryAfterSeconds 1 to 30) and sends and inserts NOTHING', async () => {
    const x = await pendingWithMail();
    const before = await snapshot(x.id);
    const e = await fails(ev.sendVerification(x.id), 'EMAIL_RESEND_TOO_SOON');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 30);
    expect(sender.sent).toHaveLength(1);
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('the refused resend leaves the first code working', async () => {
    const x = await pendingWithMail();
    await fails(ev.sendVerification(x.id), 'EMAIL_RESEND_TOO_SOON');
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('a FAILED delivery does not start the cooldown: the next send is allowed at once', async () => {
    const id = await newAccount();
    await ev.setEmail(id, addr('fail'));
    sender.failNext = new EmailDeliveryError('UNAVAILABLE', 'down', true);
    await fails(ev.sendVerification(id), 'EMAIL_DELIVERY_FAILED');
    await ev.sendVerification(id);
    expect(sender.sent).toHaveLength(1);
  });

  it('the cooldown counts from the newest SENT challenge of the ACCOUNT: switching the address does not reset it', async () => {
    const x = await pendingWithMail({ address: addr('one') });
    await ev.setEmail(x.id, addr('two'));
    const e = await fails(ev.sendVerification(x.id), 'EMAIL_RESEND_TOO_SOON');
    between(e.details.retryAfterSeconds, 1, 30);
    expect(sender.sent).toHaveLength(1);
  });

  it('with a cooldown of 0 a resend supersedes the previous challenge: it is closed SUPERSEDED and only one challenge stays open', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const second = await resend(x.id);
    const challenges = await challengesOf(x.id);
    expect(challenges).toHaveLength(2);
    expect(challenges[0]).toMatchObject({ invalidation_reason: 'SUPERSEDED', used_at: null, delivery_status: 'SENT' });
    expect(challenges[1]).toMatchObject({ invalidation_reason: null, used_at: null, delivery_status: 'SENT' });
    expect(await openChallenges(x.id)).toHaveLength(1);
    expect((await ev.confirmCode(x.id, second.code)).changed).toBe(true);
  });

  it('the cooldown comes from the policy: a longer one is reported in the answer and in the refusal', async () => {
    setPolicy({ resendSeconds: 120 });
    const x = await pendingWithMail();
    expect(120_000 - (x.sent.resendAvailableAt.getTime() - x.sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(x.sent.resendAvailableAt.getTime()).toBeLessThanOrEqual(x.sent.sentAt.getTime() + 120_000);
    const e = await fails(ev.sendVerification(x.id), 'EMAIL_RESEND_TOO_SOON');
    between(e.details.retryAfterSeconds, 31, 120);
  });
});

// ====================================================================== #9 hourly and daily caps
describe('the hourly and daily caps (#9)', () => {
  it('a third send with maxPerHour 2 is EMAIL_SEND_LIMIT with retryAfterSeconds up to an hour, and sends nothing', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const x = await pendingWithMail();
    await resend(x.id);
    const before = await snapshot(x.id);
    const e = await fails(ev.sendVerification(x.id), 'EMAIL_SEND_LIMIT');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 3590, 3600);
    expect(sender.sent).toHaveLength(2);
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('a third send with maxPerDay 2 is EMAIL_SEND_LIMIT with a retry time of up to a day (longer than the hourly one)', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 5, maxPerDay: 2 });
    const x = await pendingWithMail();
    await resend(x.id);
    const e = await fails(ev.sendVerification(x.id), 'EMAIL_SEND_LIMIT');
    between(e.details.retryAfterSeconds, 3601, 86_400);
    expect(sender.sent).toHaveLength(2);
  });

  it('failed deliveries count towards the caps', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const id = await newAccount();
    await ev.setEmail(id, addr('cap'));
    for (let i = 0; i < 2; i++) {
      sender.failNext = new EmailDeliveryError('UNAVAILABLE', 'down', true);
      await fails(ev.sendVerification(id), 'EMAIL_DELIVERY_FAILED');
    }
    await fails(ev.sendVerification(id), 'EMAIL_SEND_LIMIT');
    expect(sender.sent).toEqual([]);
    expect(await challengesOf(id)).toHaveLength(2);
  });

  it('the cap is per ACCOUNT, not per contact: switching the address does not reset it', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 2 });
    const id = await newAccount();
    for (const tag of ['a', 'b']) {
      await ev.setEmail(id, addr(tag));
      await ev.sendVerification(id);
    }
    await ev.setEmail(id, addr('c'));
    await fails(ev.sendVerification(id), 'EMAIL_SEND_LIMIT');
    expect(sender.sent).toHaveLength(2);
  });

  it('the cap is not shared between accounts', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 1 });
    await pendingWithMail();
    await pendingWithMail();
    expect(sender.sent).toHaveLength(2);
  });

  it('sends older than an hour do not count towards the hourly cap', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 5 });
    const id = await newAccount();
    await ev.setEmail(id, addr('old'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    for (let i = 0; i < 5; i++)
      await craftChallenge(contactId, { code: KNOWN_CODE, token: fakeToken(), createdSecondsAgo: 7200 + i, expiresInSeconds: -6000, closeAs: 'SUPERSEDED' });
    await ev.sendVerification(id);
    expect(sender.sent).toHaveLength(1);
  });

  it('...but they do count towards the daily cap, with a retry time that follows the oldest of them', async () => {
    setPolicy({ resendSeconds: 0, maxPerDay: 5 });
    const id = await newAccount();
    await ev.setEmail(id, addr('old'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    for (let i = 0; i < 5; i++)
      await craftChallenge(contactId, { code: KNOWN_CODE, token: fakeToken(), createdSecondsAgo: 7200 + i, expiresInSeconds: -6000, closeAs: 'SUPERSEDED' });
    const e = await fails(ev.sendVerification(id), 'EMAIL_SEND_LIMIT');
    between(e.details.retryAfterSeconds, 70_000, 86_400 - 7200 + 1);
    expect(sender.sent).toEqual([]);
  });

  it('sends older than a day count towards neither cap', async () => {
    setPolicy({ resendSeconds: 0, maxPerHour: 1, maxPerDay: 1 });
    const id = await newAccount();
    await ev.setEmail(id, addr('ancient'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    await craftChallenge(contactId, { code: KNOWN_CODE, token: fakeToken(), createdSecondsAgo: 90_000, expiresInSeconds: -80_000, closeAs: 'SUPERSEDED' });
    await ev.sendVerification(id);
    expect(sender.sent).toHaveLength(1);
  });
});

// ====================================================================== #17 the code verifies
describe('confirmCode: the correct code (#17)', () => {
  it('verifies the address: VERIFIED and primary, challenge used by CODE, audit EMAIL_VERIFIED, Verified event', async () => {
    const x = await pendingWithMail();
    const r = await ev.confirmCode(x.id, x.code);
    expect(r.changed).toBe(true);
    expect(r.email).toEqual({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(x.address), verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    const c = await contactOf(x.id, x.address);
    expect(c).toMatchObject({ status: 'VERIFIED', is_primary: true, source: 'USER_ENTERED', disabled_at: null, disabled_reason: null });
    expect(c.verified_at).toBeInstanceOf(Date);
    expect(r.email.primary!.verifiedAt).toBe(c.verified_at!.toISOString());

    const [ch] = await challengesOf(x.id);
    expect(ch).toMatchObject({ consumed_via: 'CODE', invalidated_at: null, invalidation_reason: null, attempt_count: 0 });
    expect(ch!.used_at).toBeInstanceOf(Date);

    const verified = await auditOf(x.id, 'EMAIL_VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ actor: `account:${x.id}`, email_contact_id: c.email_contact_id });
    expect(verified[0]!.changes).toEqual({
      status: ['PENDING', 'VERIFIED'],
      maskedEmail: maskEmail(x.address),
      method: 'CODE',
      purpose: 'INITIAL_EMAIL',
      challengeId: ch!.challenge_id,
    });
    expect(await auditOf(x.id, 'EMAIL_PRIMARY_CHANGED')).toEqual([]);
    const ve = await eventsOf(x.id, E.verified);
    expect(ve).toHaveLength(1);
    expect(ve[0]).toMatchObject({ aggregate_type: 'identity_account', actor_type: 'user', actor_id: `account:${x.id}` });
    expect(ve[0]!.payload_json).toEqual({
      accountId: x.id,
      emailContactId: c.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'USER_ENTERED',
      method: 'CODE',
      replacedEmailContactId: null,
    });
  });

  it('is visible in the account context (/account/me) as emailVerificationStatus VERIFIED', async () => {
    const x = await pendingWithMail();
    expect((await accounts.getAccountContext(x.id)).email.emailVerificationStatus).toBe('PENDING');
    await ev.confirmCode(x.id, x.code);
    const ctx = await accounts.getAccountContext(x.id);
    expect(ctx.email).toEqual({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(x.address), verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
  });

  it('a few wrong attempts before the right code do not block it, and the attempt counter keeps its value', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 2; i++) await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_CODE_INVALID');
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 2, consumed_via: 'CODE' });
  });

  it('a leading-zero code is compared as text (000000-style codes verify)', async () => {
    const id = await newAccount();
    await ev.setEmail(id, addr('zero'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    await craftChallenge(contactId, { code: '004217', token: fakeToken(), createdSecondsAgo: 5, expiresInSeconds: 600 });
    await fails(ev.confirmCode(id, '4217'), 'EMAIL_CODE_INVALID');
    expect((await ev.confirmCode(id, '004217')).changed).toBe(true);
  });

  it('confirming with no address and no primary is NOT_PENDING', async () => {
    await fails(ev.confirmCode(await newAccount(), KNOWN_CODE), 'EMAIL_NOT_PENDING');
  });

  it('confirming before any send is EMAIL_CODE_INVALID and no attempt can be counted (there is no challenge)', async () => {
    const id = await newAccount();
    await ev.setEmail(id, addr('nosend'));
    await fails(ev.confirmCode(id, KNOWN_CODE), 'EMAIL_CODE_INVALID');
    expect(await challengesOf(id)).toEqual([]);
    expect(await auditOf(id, 'EMAIL_VERIFICATION_FAILED')).toEqual([]);
  });
});

// ====================================================================== #19 wrong codes and the lock
describe('wrong codes count attempts and lock the challenge (#19)', () => {
  it('reports the attempts left (4, 3, 2, 1), locks on the 5th, and persists every attempt although the call threw', async () => {
    const x = await pendingWithMail();
    const wrong = wrongCode(x.code);
    for (const remaining of [4, 3, 2, 1]) {
      const e = await fails(ev.confirmCode(x.id, wrong), 'EMAIL_CODE_INVALID');
      expect(e.details).toEqual({ attemptsRemaining: remaining });
      expect((await challengesOf(x.id))[0]!.attempt_count).toBe(5 - remaining);
    }
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 4, invalidated_at: null });
    const locked = await fails(ev.confirmCode(x.id, wrong), 'EMAIL_VERIFICATION_LOCKED');
    expect(locked.details).toEqual({});

    const [ch] = await challengesOf(x.id);
    expect(ch).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED', used_at: null, consumed_via: null });
    expect(ch!.invalidated_at).toBeInstanceOf(Date);
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
    expect((await accounts.getAccountContext(x.id)).email.emailVerificationStatus).toBe('PENDING');
  });

  it('audits FAILED x5 (attempt 1 to 5) and LOCKED x1, and emits Failed events with locked true only on the last', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 5; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const [ch] = await challengesOf(x.id);
    const contactId = (await contactOf(x.id, x.address)).email_contact_id;

    const failed = await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED');
    expect(failed.map((a) => a.changes)).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({ maskedEmail: maskEmail(x.address), attempt, challengeId: ch!.challenge_id })),
    );
    expect(failed.every((a) => a.email_contact_id === contactId && a.actor === `account:${x.id}`)).toBe(true);
    const lockedAudit = await auditOf(x.id, 'EMAIL_VERIFICATION_LOCKED');
    expect(lockedAudit).toHaveLength(1);
    expect(lockedAudit[0]!.changes).toEqual({ maskedEmail: maskEmail(x.address), challengeId: ch!.challenge_id, attempts: 5 });

    const ev5 = await eventsOf(x.id, E.verificationFailed);
    expect(ev5.map((e) => e.payload_json)).toEqual(
      [1, 2, 3, 4, 5].map((attemptCount) => ({
        accountId: x.id,
        emailContactId: contactId,
        challengeId: ch!.challenge_id,
        attemptCount,
        locked: attemptCount === 5,
      })),
    );
  });

  it('after the lock even the correct code (and the link) fails with EMAIL_VERIFICATION_LOCKED, and nothing more is written', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 5; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const before = await snapshot(x.id);
    await fails(ev.confirmCode(x.id, x.code), 'EMAIL_VERIFICATION_LOCKED');
    await fails(ev.confirmLink(x.id, x.token), 'EMAIL_VERIFICATION_LOCKED');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
  });

  it('a resend after a lock issues a fresh challenge that works (the attempts start again at 5)', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    for (let i = 0; i < 5; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const fresh = await resend(x.id);
    expect(fresh.code).toMatch(/^[0-9]{6}$/);
    const e = await fails(ev.confirmCode(x.id, wrongCode(fresh.code)), 'EMAIL_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await ev.confirmCode(x.id, fresh.code)).changed).toBe(true);
    const challenges = await challengesOf(x.id);
    expect(challenges.map((c) => c.invalidation_reason ?? (c.used_at ? 'USED' : 'OPEN'))).toEqual(['LOCKED', 'USED']);
  });

  it('maxAttempts comes from the policy: with 3 the attempts left are 2, 1 and the third locks', async () => {
    setPolicy({ maxAttempts: 3 });
    const x = await pendingWithMail();
    expect((await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_CODE_INVALID')).details).toEqual({ attemptsRemaining: 2 });
    expect((await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_CODE_INVALID')).details).toEqual({ attemptsRemaining: 1 });
    await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 3, invalidation_reason: 'LOCKED' });
  });

  it('maxAttempts 1 locks on the first wrong code', async () => {
    setPolicy({ maxAttempts: 1 });
    const x = await pendingWithMail();
    await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 1, invalidation_reason: 'LOCKED' });
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_LOCKED')).toHaveLength(1);
  });

  it('a lowered maxAttempts locks a challenge that already used its attempts, even for the correct code', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 3; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    setPolicy({ maxAttempts: 3 });
    await fails(ev.confirmCode(x.id, x.code), 'EMAIL_VERIFICATION_LOCKED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 3, invalidation_reason: 'LOCKED', used_at: null });
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
  });

  it('the attempt counter belongs to the challenge: a resend starts a new count', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const fresh = await resend(x.id);
    const e = await fails(ev.confirmCode(x.id, wrongCode(fresh.code)), 'EMAIL_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await challengesOf(x.id)).map((c) => c.attempt_count)).toEqual([2, 1]);
  });

  it('concurrent wrong guesses cannot exceed the maximum: 12 parallel wrong codes leave exactly 5 attempts and one lock', async () => {
    const x = await pendingWithMail();
    const wrong = wrongCode(x.code);
    const results = await Promise.all(Array.from({ length: 12 }, () => settled(ev.confirmCode(x.id, wrong))));
    expect(results.every((r) => r instanceof AccountError)).toBe(true);
    const codes = (results as AccountError[]).map((r) => r.code);
    expect(codes.filter((c) => c === 'EMAIL_CODE_INVALID')).toHaveLength(4);
    expect(codes.filter((c) => c === 'EMAIL_VERIFICATION_LOCKED')).toHaveLength(8);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 5, invalidation_reason: 'LOCKED' });
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED')).toHaveLength(5);
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_LOCKED')).toHaveLength(1);
  });

  it('the error of a wrong code never contains the code, the address or the token', async () => {
    const x = await pendingWithMail();
    const e = await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_CODE_INVALID');
    const text = JSON.stringify({ m: e.message, d: e.details });
    expect(text).not.toContain(x.code);
    expect(text).not.toContain(wrongCode(x.code));
    expect(text).not.toContain(x.address);
    expect(text).not.toContain(x.token);
  });
});

// ====================================================================== #20 expiry
describe('expired codes and links (#20)', () => {
  async function expired() {
    const id = await newAccount();
    const address = addr('exp');
    await ev.setEmail(id, address);
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    const token = fakeToken();
    const challengeId = await craftChallenge(contactId, { code: KNOWN_CODE, token, createdSecondsAgo: 700, expiresInSeconds: -100 });
    return { id, address, contactId, token, challengeId };
  }

  it('the correct code of an expired challenge is EMAIL_CODE_EXPIRED, and NO attempt is counted', async () => {
    const x = await expired();
    const before = await snapshot(x.id);
    await fails(ev.confirmCode(x.id, KNOWN_CODE), 'EMAIL_CODE_EXPIRED');
    await fails(ev.confirmCode(x.id, wrongCode(KNOWN_CODE)), 'EMAIL_CODE_EXPIRED');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 0, used_at: null, invalidated_at: null });
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED')).toEqual([]);
  });

  it('the link of an expired challenge is EMAIL_CODE_EXPIRED too', async () => {
    const x = await expired();
    const before = await snapshot(x.id);
    await fails(ev.confirmLink(x.id, x.token), 'EMAIL_CODE_EXPIRED');
    expect(await snapshot(x.id)).toEqual(before);
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
  });

  it('the summary shows no usable expiry for it (pending.expiresAt null) and the detail shows no attempts left', async () => {
    const x = await expired();
    const summary = await ev.getEmailSummary(x.id);
    expect(summary.pending).toMatchObject({ status: 'PENDING', expiresAt: null });
    expect((await ev.getEmailDetail(x.id)).attemptsRemaining).toBeNull();
  });

  it('a resend replaces an expired challenge (the expired one is superseded) and the new code verifies', async () => {
    const x = await expired();
    const fresh = await resend(x.id);
    const challenges = await challengesOf(x.id);
    expect(challenges.map((c) => c.invalidation_reason)).toEqual(['SUPERSEDED', null]);
    // the expired, superseded code is "used or replaced" and costs no attempt
    await fails(ev.confirmCode(x.id, KNOWN_CODE), 'EMAIL_CODE_USED');
    expect((await ev.confirmCode(x.id, fresh.code)).changed).toBe(true);
  });

  it('a challenge that is still valid verifies while an older expired history sits next to it', async () => {
    const id = await newAccount();
    await ev.setEmail(id, addr('hist'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    await craftChallenge(contactId, { code: '111111', token: fakeToken(), createdSecondsAgo: 700, expiresInSeconds: -100, closeAs: 'SUPERSEDED' });
    await craftChallenge(contactId, { code: '222222', token: fakeToken(), createdSecondsAgo: 5, expiresInSeconds: 595 });
    await fails(ev.confirmCode(id, '111111'), 'EMAIL_CODE_USED');
    expect((await ev.confirmCode(id, '222222')).changed).toBe(true);
  });
});

// ====================================================================== #18 the magic link
describe('confirmLink (#18)', () => {
  it('verifies the address: consumed_via LINK, audit method LINK, Verified event method LINK, VERIFIED summary', async () => {
    const x = await pendingWithMail();
    const r = await ev.confirmLink(x.id, x.token);
    expect(r.changed).toBe(true);
    expect(r.email.emailVerificationStatus).toBe('VERIFIED');
    expect(r.email.primary).toMatchObject({ maskedEmail: maskEmail(x.address), source: 'USER_ENTERED' });
    expect(r.email.pending).toBeNull();
    const c = await contactOf(x.id, x.address);
    expect(c).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(c.verified_at).toBeInstanceOf(Date);
    const [ch] = await challengesOf(x.id);
    expect(ch).toMatchObject({ consumed_via: 'LINK', attempt_count: 0 });
    expect(ch!.used_at).toBeInstanceOf(Date);
    const verified = await auditOf(x.id, 'EMAIL_VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]!.changes).toEqual({
      status: ['PENDING', 'VERIFIED'],
      maskedEmail: maskEmail(x.address),
      method: 'LINK',
      purpose: 'INITIAL_EMAIL',
      challengeId: ch!.challenge_id,
    });
    const ve = await eventsOf(x.id, E.verified);
    expect(ve).toHaveLength(1);
    expect(ve[0]!.payload_json).toMatchObject({ method: 'LINK', replacedEmailContactId: null, purpose: 'INITIAL_EMAIL' });
    expect((await accounts.getAccountContext(x.id)).email.emailVerificationStatus).toBe('VERIFIED');
  });

  it("an unknown token and ANOTHER account's token fail identically with EMAIL_LINK_INVALID, and change nothing", async () => {
    const mine = await pendingWithMail();
    const other = await pendingWithMail();
    const beforeMine = await snapshot(mine.id);
    const beforeOther = await snapshot(other.id);
    const unknown = await fails(ev.confirmLink(mine.id, fakeToken()), 'EMAIL_LINK_INVALID');
    const foreign = await fails(ev.confirmLink(mine.id, other.token), 'EMAIL_LINK_INVALID');
    expect(foreign.message).toBe(unknown.message);
    expect(foreign.details).toEqual(unknown.details);
    expect(await snapshot(mine.id)).toEqual(beforeMine);
    expect(await snapshot(other.id)).toEqual(beforeOther);
    // the owner's token still works for the owner
    expect((await ev.confirmLink(other.id, other.token)).changed).toBe(true);
  });

  it('a token that is one character off is EMAIL_LINK_INVALID', async () => {
    const x = await pendingWithMail();
    const flipped = x.token.slice(0, -1) + (x.token.endsWith('A') ? 'B' : 'A');
    await fails(ev.confirmLink(x.id, flipped), 'EMAIL_LINK_INVALID');
    await fails(ev.confirmLink(x.id, ''), 'EMAIL_LINK_INVALID');
  });

  it('link attempts are not counted: many bad tokens leave the attempt counter at 0 and the code still works', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 12; i++) await fails(ev.confirmLink(x.id, fakeToken()), 'EMAIL_LINK_INVALID');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 0, invalidated_at: null });
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED')).toEqual([]);
    expect(await eventsOf(x.id, E.verificationFailed)).toEqual([]);
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('the link of a superseded challenge is EMAIL_CODE_USED, the new link works', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const fresh = await resend(x.id);
    await fails(ev.confirmLink(x.id, x.token), 'EMAIL_CODE_USED');
    expect((await ev.confirmLink(x.id, fresh.token)).changed).toBe(true);
  });

  it('the link of a locked challenge is EMAIL_VERIFICATION_LOCKED', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 5; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await fails(ev.confirmLink(x.id, x.token), 'EMAIL_VERIFICATION_LOCKED');
  });

  it('the link of a challenge whose delivery failed (a token nobody received) is refused as an invalid code', async () => {
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    const id = await newAccount();
    await svc.setEmail(id, addr('lost'));
    scripted.next = new EmailDeliveryError('UNAVAILABLE', 'down', true);
    await fails(svc.sendVerification(id), 'EMAIL_DELIVERY_FAILED');
    const lost = scripted.seen[0]!;
    await fails(svc.confirmLink(id, tokenOf(lost)), 'EMAIL_CODE_INVALID');
    await fails(svc.confirmCode(id, codeOf(lost)), 'EMAIL_CODE_INVALID');
    expect((await liveContacts(id))[0]!.status).toBe('PENDING');
  });

  it('the link of a withdrawn address (the pending one was replaced) is EMAIL_CODE_USED', async () => {
    const x = await pendingWithMail();
    await ev.setEmail(x.id, addr('other'));
    await fails(ev.confirmLink(x.id, x.token), 'EMAIL_CODE_USED');
    expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toEqual([]);
  });

  it('needs the right key: with another hash key the same code and token do not verify', async () => {
    const x = await pendingWithMail();
    const stranger = makeService({ hashSecret: otherHashKey });
    await fails(stranger.confirmLink(x.id, x.token), 'EMAIL_LINK_INVALID');
    await fails(stranger.confirmCode(x.id, x.code), 'EMAIL_CODE_INVALID');
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
  });
});

// ====================================================================== #21 single use and idempotency
describe('single use and idempotency (#21)', () => {
  it('repeating a successful confirmCode is changed:false and has no second audit row, event or verified_at change', async () => {
    const x = await pendingWithMail();
    const first = await ev.confirmCode(x.id, x.code);
    const before = await snapshot(x.id);
    const verifiedAt = (await contactOf(x.id, x.address)).verified_at!.getTime();
    const again = await ev.confirmCode(x.id, x.code);
    expect(again.changed).toBe(false);
    expect(again.email).toEqual(first.email);
    expect(await snapshot(x.id)).toEqual(before);
    expect((await contactOf(x.id, x.address)).verified_at!.getTime()).toBe(verifiedAt);
    expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
  });

  it('repeating a successful confirmLink is changed:false with no second side effect', async () => {
    const x = await pendingWithMail();
    const first = await ev.confirmLink(x.id, x.token);
    const before = await snapshot(x.id);
    const again = await ev.confirmLink(x.id, x.token);
    expect(again).toEqual({ changed: false, email: first.email });
    expect(await snapshot(x.id)).toEqual(before);
    expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
  });

  it('the code after the link, and the link after the code, are idempotent successes', async () => {
    const viaLink = await pendingWithMail();
    expect((await ev.confirmLink(viaLink.id, viaLink.token)).changed).toBe(true);
    expect((await ev.confirmCode(viaLink.id, viaLink.code)).changed).toBe(false);
    expect((await challengesOf(viaLink.id))[0]!.consumed_via).toBe('LINK');

    const viaCode = await pendingWithMail();
    expect((await ev.confirmCode(viaCode.id, viaCode.code)).changed).toBe(true);
    expect((await ev.confirmLink(viaCode.id, viaCode.token)).changed).toBe(false);
    expect((await challengesOf(viaCode.id))[0]!.consumed_via).toBe('CODE');
    for (const id of [viaLink.id, viaCode.id]) {
      expect(await auditOf(id, 'EMAIL_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(id, E.verified)).toHaveLength(1);
    }
  });

  it('a wrong code after the verification is still the documented idempotent success (the account is already verified) and counts nothing', async () => {
    const x = await verifiedAccount();
    const before = await snapshot(x.id);
    const r = await ev.confirmCode(x.id, wrongCode(x.code));
    expect(r.changed).toBe(false);
    expect(r.email.emailVerificationStatus).toBe('VERIFIED');
    expect(await snapshot(x.id)).toEqual(before);
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED')).toEqual([]);
  });

  it('SPEC #21: the old code after a RESEND is EMAIL_CODE_USED (superseded) [currently EMAIL_CODE_INVALID, a wrong attempt on the new challenge]', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const fresh = await resend(x.id);
    expect(fresh.code).not.toBe(x.code);
    await fails(ev.confirmCode(x.id, x.code), 'EMAIL_CODE_USED');
  });

  it('the old code after a resend never verifies: the address stays PENDING and the new code still works', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const fresh = await resend(x.id);
    const e = await rejection(ev.confirmCode(x.id, x.code));
    expect(e).toBeInstanceOf(AccountError);
    expect(['EMAIL_CODE_USED', 'EMAIL_CODE_INVALID']).toContain((e as AccountError).code);
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
    expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toEqual([]);
    expect((await ev.confirmCode(x.id, fresh.code)).changed).toBe(true);
  });

  it('the link of an address that was later replaced is EMAIL_CODE_USED, not an idempotent success', async () => {
    setPolicy({ resendSeconds: 0 });
    const first = await verifiedAccount(addr('first'));
    const second = await pendingWithMail({ id: first.id, address: addr('second') });
    await ev.confirmCode(first.id, second.code);
    // the first address is no longer the verified one
    await fails(ev.confirmLink(first.id, first.token), 'EMAIL_CODE_USED');
    expect((await contactOf(first.id, second.address)).is_primary).toBe(true);
  });

  it('the link of the verified primary stays an idempotent success while a change is pending', async () => {
    const first = await verifiedAccount(addr('first'));
    await ev.setEmail(first.id, addr('second'));
    const r = await ev.confirmLink(first.id, first.token);
    expect(r.changed).toBe(false);
    expect(r.email.pending).toMatchObject({ status: 'REPLACEMENT_PENDING' });
    expect(await auditOf(first.id, 'EMAIL_VERIFIED')).toHaveLength(1);
  });

  it('a withdrawn pending change: its old code is not an error (the account is verified) but verifies nothing', async () => {
    setPolicy({ resendSeconds: 0 });
    const p = await verifiedAccount(addr('primary'));
    const change = await pendingWithMail({ id: p.id, address: addr('change') });
    await ev.setEmail(p.id, p.address);
    const r = await ev.confirmCode(p.id, change.code);
    expect(r.changed).toBe(false);
    expect((await contactOf(p.id, change.address)).status).toBe('DISABLED');
    await fails(ev.confirmLink(p.id, change.token), 'EMAIL_CODE_USED');
  });
});

// ====================================================================== #23 #24 races
describe('races: a code, a link, a resend and a replacement (#23, #24)', () => {
  it('two simultaneous confirmCode with the correct code: exactly one changed:true, one EMAIL_VERIFIED audit row, one Verified event (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithMail();
      const results = await Promise.all([ev.confirmCode(x.id, x.code), ev.confirmCode(x.id, x.code)]);
      expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
      expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
      expect((await challengesOf(x.id))[0]).toMatchObject({ consumed_via: 'CODE' });
      expect((await liveContacts(x.id)).map((c) => c.status)).toEqual(['VERIFIED']);
    }
  });

  it('a code and a link at the same time verify EXACTLY ONCE (10 rounds with fresh accounts)', async () => {
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithMail();
      const results = await Promise.all([ev.confirmCode(x.id, x.code), ev.confirmLink(x.id, x.token)]);
      expect(results.map((r) => r.changed).sort(), `round ${round}`).toEqual([false, true]);
      const verified = await auditOf(x.id, 'EMAIL_VERIFIED');
      expect(verified).toHaveLength(1);
      const ve = await eventsOf(x.id, E.verified);
      expect(ve).toHaveLength(1);
      const [ch] = await challengesOf(x.id);
      expect(ch!.consumed_via).toBe((verified[0]!.changes as { method: string }).method);
      expect(ch!.consumed_via).toBe(ve[0]!.payload_json.method);
      expect(await auditOf(x.id, 'EMAIL_PRIMARY_CHANGED')).toEqual([]);
    }
    await expectEmailInvariants();
  });

  it('many simultaneous confirmations (3 codes and 3 links) still verify exactly once', async () => {
    const x = await pendingWithMail();
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => ev.confirmCode(x.id, x.code)),
      ...Array.from({ length: 3 }, () => ev.confirmLink(x.id, x.token)),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
  });

  it('deterministic order verify, then resend: the resend fails with NOT_PENDING and nothing more is sent', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const [v, s] = await inOrder(
      x.id,
      () => ev.confirmCode(x.id, x.code),
      () => ev.sendVerification(x.id),
    );
    expect(v).toMatchObject({ changed: true });
    expect(s).toBeInstanceOf(AccountError);
    expect((s as AccountError).code).toBe('EMAIL_NOT_PENDING');
    expect(mailsTo(x.address)).toHaveLength(1);
    expect(await openChallenges(x.id)).toEqual([]);
    expect((await liveContacts(x.id))[0]).toMatchObject({ status: 'VERIFIED', is_primary: true });
  });

  it('deterministic order resend, then verify with the old code: the old code fails, the address stays PENDING, one challenge is open', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    const [s, v] = await inOrder(
      x.id,
      () => ev.sendVerification(x.id),
      () => ev.confirmCode(x.id, x.code),
    );
    expect(s).not.toBeInstanceOf(AccountError);
    expect(v).toBeInstanceOf(AccountError);
    expect(['EMAIL_CODE_USED', 'EMAIL_CODE_INVALID']).toContain((v as AccountError).code);
    expect(mailsTo(x.address)).toHaveLength(2);
    expect(await openChallenges(x.id)).toHaveLength(1);
    expect((await liveContacts(x.id))[0]!.status).toBe('PENDING');
    expect((await ev.confirmCode(x.id, codeOf(mailsTo(x.address)[1]!))).changed).toBe(true);
  });

  it('a resend racing the verification is never a double state (10 rounds, both start orders)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithMail();
      let verifyP: Promise<unknown>;
      let sendP: Promise<unknown>;
      if (round % 2 === 0) {
        verifyP = settled(ev.confirmCode(x.id, x.code));
        sendP = settled(ev.sendVerification(x.id));
      } else {
        sendP = settled(ev.sendVerification(x.id));
        verifyP = settled(ev.confirmCode(x.id, x.code));
      }
      const [v, s] = await Promise.all([verifyP, sendP]);
      const open = await openChallenges(x.id);
      const contact = (await liveContacts(x.id))[0]!;
      if (!(v instanceof AccountError)) {
        // verified first, the resend found nothing pending
        expect(v, `round ${round}`).toMatchObject({ changed: true });
        expect(s).toBeInstanceOf(AccountError);
        expect((s as AccountError).code).toBe('EMAIL_NOT_PENDING');
        expect(contact).toMatchObject({ status: 'VERIFIED', is_primary: true });
        expect(open).toEqual([]);
        expect(mailsTo(x.address)).toHaveLength(1);
      } else {
        // the resend superseded the challenge first, the old code could not verify
        expect(['EMAIL_CODE_USED', 'EMAIL_CODE_INVALID'], `round ${round}`).toContain(v.code);
        expect(s, `round ${round}`).not.toBeInstanceOf(AccountError);
        expect(contact.status).toBe('PENDING');
        expect(open).toHaveLength(1);
        expect(mailsTo(x.address)).toHaveLength(2);
        expect((await ev.confirmCode(x.id, codeOf(mailsTo(x.address)[1]!))).changed).toBe(true);
      }
      expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(x.id, E.verified)).toHaveLength(1);
    }
    await expectEmailInvariants();
  });

  it('two simultaneous sends leave exactly one open challenge, and the code of that challenge verifies', async () => {
    const id = await newAccount();
    const address = addr('double');
    await ev.setEmail(id, address);
    const results = await Promise.all([settled(ev.sendVerification(id)), settled(ev.sendVerification(id))]);
    for (const r of results) if (r instanceof AccountError) expect(['EMAIL_RESEND_TOO_SOON', 'CONFLICT']).toContain(r.code);
    const challenges = await challengesOf(id);
    const open = challenges.filter((c) => c.used_at === null && c.invalidated_at === null);
    expect(open).toHaveLength(1);
    const winner = mailsTo(address).find((m) => hashVerificationCode(testHashKey, open[0]!.challenge_id, codeOf(m)) === open[0]!.code_hash);
    expect(winner, 'the message of the open challenge was sent').toBeDefined();
    expect((await ev.confirmCode(id, codeOf(winner!))).changed).toBe(true);
    await expectEmailInvariants();
  });

  it('a resend while the first delivery is still in flight supersedes it: one open challenge, the newest message verifies, the older code is dead', async () => {
    setPolicy({ resendSeconds: 0 });
    const gated = new GatedSender();
    const svc = makeService({ sender: gated });
    const id = await newAccount();
    await svc.setEmail(id, addr('inflight'));
    const release = gated.holdNext();
    const first = settled(svc.sendVerification(id)); // its challenge is committed, its delivery hangs
    for (let i = 0; gated.seen.length < 1 && i < 500; i++) await sleep(10);
    expect(gated.seen).toHaveLength(1);
    await svc.sendVerification(id); // supersedes the first challenge while the first message is still being delivered
    release();
    const firstResult = await first;
    expect(firstResult instanceof Error ? firstResult instanceof AccountError : true, 'no raw error escapes').toBe(true);
    expect(gated.seen).toHaveLength(2);

    const [older, newer] = await challengesOf(id);
    expect(older).toMatchObject({ invalidation_reason: 'SUPERSEDED', used_at: null });
    expect(newer).toMatchObject({ invalidation_reason: null, used_at: null, delivery_status: 'SENT' });
    expect(await openChallenges(id)).toHaveLength(1);
    expect(await eventsOf(id, E.verificationSent)).toHaveLength(1); // the superseded delivery emits no Sent event
    const [oldMail, newMail] = gated.seen;
    expect(hashVerificationCode(testHashKey, older!.challenge_id, codeOf(oldMail!))).toBe(older!.code_hash);
    expect(hashVerificationCode(testHashKey, newer!.challenge_id, codeOf(newMail!))).toBe(newer!.code_hash);
    const dead = await rejection(svc.confirmCode(id, codeOf(oldMail!)));
    expect(['EMAIL_CODE_USED', 'EMAIL_CODE_INVALID']).toContain((dead as AccountError).code);
    await fails(svc.confirmLink(id, tokenOf(oldMail!)), 'EMAIL_CODE_USED');
    expect((await svc.confirmCode(id, codeOf(newMail!))).changed).toBe(true);
    await expectEmailInvariants();
  });

  it('verifying two different candidates concurrently never makes both primary: only the open candidate can verify (6 rounds)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 6; round++) {
      const first = await pendingWithMail({ address: addr('cand-1') });
      const second = await pendingWithMail({ id: first.id, address: addr('cand-2') }); // supersedes the first candidate
      const [a, b] = await Promise.all([settled(ev.confirmCode(first.id, first.code)), settled(ev.confirmCode(first.id, second.code))]);
      const verified = [a, b].filter((r) => !(r instanceof AccountError) && r.changed);
      expect(verified, `round ${round}`).toHaveLength(1);
      const live = await liveContacts(first.id);
      expect(live.map((c) => [c.email_normalized, c.status, c.is_primary])).toEqual([[second.address, 'VERIFIED', true]]);
      expect((await contactOf(first.id, first.address)).status).toBe('DISABLED');
      expect(await auditOf(first.id, 'EMAIL_VERIFIED')).toHaveLength(1);
      expect(await eventsOf(first.id, E.verified)).toHaveLength(1);
    }
    await expectEmailInvariants();
  });

  it('two concurrent setEmail with different addresses leave exactly ONE open candidate and no raw error (6 rounds, with and without a primary)', async () => {
    for (let round = 0; round < 6; round++) {
      const withPrimary = round % 2 === 1;
      const id = withPrimary ? (await verifiedAccount()).id : await newAccount();
      const [a, b] = [addr('race-a'), addr('race-b')];
      const results = await Promise.all([settled(ev.setEmail(id, a)), settled(ev.setEmail(id, b))]);
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
      expect([a, b]).toContain(live.find((c) => !c.is_primary)!.email_normalized);
      expect(live.find((c) => !c.is_primary)!.status).toBe(withPrimary ? 'REPLACEMENT_PENDING' : 'PENDING');
    }
    await expectEmailInvariants();
  });

  it('a replacement racing the verification of the pending address never leaves two primaries or two candidates (10 rounds, code and link)', async () => {
    for (let round = 0; round < 10; round++) {
      const x = await pendingWithMail();
      const next = addr('next');
      const confirm = round % 2 === 0 ? ev.confirmCode(x.id, x.code) : ev.confirmLink(x.id, x.token);
      const [c, s] = await Promise.all([settled(confirm), settled(ev.setEmail(x.id, next))]);
      expect(s, `round ${round}`).not.toBeInstanceOf(Error);
      const live = await liveContacts(x.id);
      expect(live.filter((l) => l.is_primary).length).toBeLessThanOrEqual(1);
      expect(live.filter((l) => l.status === 'PENDING' || l.status === 'REPLACEMENT_PENDING')).toHaveLength(1);
      if (!(c instanceof AccountError)) {
        // verified first: the new address became a replacement candidate
        expect(live.find((l) => l.is_primary)!.email_normalized).toBe(x.address);
        expect(live.find((l) => l.status === 'REPLACEMENT_PENDING')!.email_normalized).toBe(next);
      } else {
        // replaced first: the old address was withdrawn and never verified
        expect(['EMAIL_CODE_INVALID', 'EMAIL_CODE_USED']).toContain(c.code);
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({ email_normalized: next, status: 'PENDING' });
        expect(await auditOf(x.id, 'EMAIL_VERIFIED')).toEqual([]);
      }
    }
    await expectEmailInvariants();
  });
});

// ====================================================================== #25 duplicates across accounts
describe('the same address on two accounts (#25)', () => {
  it('B can set and send an address that A has VERIFIED, with the same answers as for a fresh address and no error', async () => {
    const a = await verifiedAccount(addr('taken'));
    const bId = await newAccount();
    const cId = await newAccount();
    const fresh = addr('fresh');
    const freshSet = await ev.setEmail(cId, fresh);
    const freshSend = await ev.sendVerification(cId);

    const takenSet = await ev.setEmail(bId, a.address);
    expect(takenSet.changed).toBe(true);
    const takenSend = await ev.sendVerification(bId);
    expect(shapeOf(takenSet)).toEqual(shapeOf(freshSet));
    expect(shapeOf(takenSend)).toEqual(shapeOf(freshSend));
    expect(takenSet.email).toMatchObject({
      emailVerificationStatus: 'PENDING',
      primary: null,
      pending: { status: 'PENDING', purpose: 'INITIAL_EMAIL', maskedEmail: maskEmail(a.address) },
    });
    expect(takenSend).toMatchObject({ codeLength: 6, validityMinutes: 10 });
    // the owner sees nothing of it
    expect((await liveContacts(a.id)).map((c) => c.status)).toEqual(['VERIFIED']);
    expect(mailsTo(a.address)).toHaveLength(2);
  });

  it('B confirming with the correct code gets EMAIL_UNAVAILABLE (ADDRESS_UNAVAILABLE), stays PENDING, and nothing is verified or written', async () => {
    const a = await verifiedAccount(addr('taken'));
    const b = await pendingWithMail({ address: a.address });
    const beforeB = await snapshot(b.id);
    const beforeA = await snapshot(a.id);
    const world = await emailWorld();
    const e = await fails(ev.confirmCode(b.id, b.code), 'EMAIL_UNAVAILABLE', { reason: 'ADDRESS_UNAVAILABLE' });
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(a.id);
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(a.address);
    expect(await snapshot(b.id)).toEqual(beforeB);
    expect(await snapshot(a.id)).toEqual(beforeA);
    expect(await emailWorld()).toEqual(world);
    expect((await liveContacts(b.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false, verified_at: null });
    expect(await auditOf(b.id, 'EMAIL_VERIFIED')).toEqual([]);
    expect(await eventsOf(b.id, E.verified)).toEqual([]);
    expect((await challengesOf(b.id))[0]).toMatchObject({ used_at: null, invalidated_at: null, attempt_count: 0 });
    expect((await accounts.getAccountContext(b.id)).email.emailVerificationStatus).toBe('PENDING');
  });

  it('...and so does the link', async () => {
    const a = await verifiedAccount(addr('taken'));
    const b = await pendingWithMail({ address: a.address });
    const beforeB = await snapshot(b.id);
    await fails(ev.confirmLink(b.id, b.token), 'EMAIL_UNAVAILABLE', { reason: 'ADDRESS_UNAVAILABLE' });
    expect(await snapshot(b.id)).toEqual(beforeB);
  });

  it('nothing is revealed BEFORE the code is proven: a wrong code on B is the same EMAIL_CODE_INVALID as for a free address', async () => {
    const a = await verifiedAccount(addr('taken'));
    const b = await pendingWithMail({ address: a.address });
    const c = await pendingWithMail();
    const onTaken = await fails(ev.confirmCode(b.id, wrongCode(b.code)), 'EMAIL_CODE_INVALID');
    const onFree = await fails(ev.confirmCode(c.id, wrongCode(c.code)), 'EMAIL_CODE_INVALID');
    expect(onTaken.message).toBe(onFree.message);
    expect(onTaken.details).toEqual(onFree.details);
  });

  it('B can recover: a different address verifies normally after the refusal', async () => {
    setPolicy({ resendSeconds: 0 });
    const a = await verifiedAccount(addr('taken'));
    const b = await pendingWithMail({ address: a.address });
    await fails(ev.confirmCode(b.id, b.code), 'EMAIL_UNAVAILABLE');
    const other = await pendingWithMail({ id: b.id, address: addr('mine') });
    expect((await ev.confirmCode(b.id, other.code)).changed).toBe(true);
    expect((await accounts.getAccountContext(b.id)).email.primary).toMatchObject({ maskedEmail: maskEmail(other.address) });
  });

  it('a verified address is released when its owner replaces it: the other account can then verify it', async () => {
    setPolicy({ resendSeconds: 0 });
    const a = await verifiedAccount(addr('shared'));
    const b = await pendingWithMail({ address: a.address });
    await fails(ev.confirmCode(b.id, b.code), 'EMAIL_UNAVAILABLE');
    const move = await pendingWithMail({ id: a.id, address: addr('moved') });
    await ev.confirmCode(a.id, move.code);
    expect((await contactOf(a.id, a.address)).status).toBe('DISABLED');
    expect((await ev.confirmCode(b.id, b.code)).changed).toBe(true);
    expect((await contactOf(b.id, a.address)).status).toBe('VERIFIED');
  });

  it.each([
    ['A verifies first', true],
    ['B verifies first', false],
  ])('two pending accounts with the same address, %s: the first wins, the second gets EMAIL_UNAVAILABLE and stays PENDING', async (_name, aFirst) => {
    const shared = addr('both');
    const a = await pendingWithMail({ address: shared });
    const b = await pendingWithMail({ address: shared });
    const [first, second] = aFirst ? [a, b] : [b, a];
    expect((await ev.confirmCode(first.id, first.code)).changed).toBe(true);
    await fails(ev.confirmCode(second.id, second.code), 'EMAIL_UNAVAILABLE', { reason: 'ADDRESS_UNAVAILABLE' });
    expect((await liveContacts(second.id))[0]!.status).toBe('PENDING');
    expect((await liveContacts(first.id))[0]!.status).toBe('VERIFIED');
    expect(await auditOf(second.id, 'EMAIL_VERIFIED')).toEqual([]);
  });

  it('two accounts verifying the same address concurrently: exactly one VERIFIED, the loser gets EMAIL_UNAVAILABLE (6 rounds, codes and links)', async () => {
    for (let round = 0; round < 6; round++) {
      const shared = addr('contested');
      const a = await pendingWithMail({ address: shared });
      const b = await pendingWithMail({ address: shared });
      const confirm = (x: Issued) => (round % 2 === 0 ? ev.confirmCode(x.id, x.code) : ev.confirmLink(x.id, x.token));
      const results = await Promise.all([settled(confirm(a)), settled(confirm(b))]);
      const winners = results.filter((r) => !(r instanceof AccountError));
      const losers = results.filter((r) => r instanceof AccountError) as AccountError[];
      expect(winners, `round ${round}`).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.code).toBe('EMAIL_UNAVAILABLE');
      expect(losers[0]!.details).toEqual({ reason: 'ADDRESS_UNAVAILABLE' });
      const verified = await q<{ n: number }>(`SELECT count(*)::int AS n FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'VERIFIED'`, [
        shared,
      ]);
      expect(verified[0]!.n).toBe(1);
      const loserIndex = results.findIndex((r) => r instanceof AccountError);
      const loser = loserIndex === 0 ? a : b;
      expect(await auditOf(loser.id, 'EMAIL_VERIFIED')).toEqual([]);
      expect(await eventsOf(loser.id, E.verified)).toEqual([]);
      expect((await liveContacts(loser.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
      expect(await openChallenges(loser.id)).toHaveLength(1);
    }
    await expectEmailInvariants();
  });

  it('the loser of a race for an address keeps its old verified primary: the replacement is rolled back as a whole (8 rounds)', async () => {
    setPolicy({ resendSeconds: 0 });
    for (let round = 0; round < 8; round++) {
      const owner = await verifiedAccount(addr('keep'));
      const shared = addr('prize');
      const change = await pendingWithMail({ id: owner.id, address: shared });
      const rival = await pendingWithMail({ address: shared });
      const start =
        round % 2 === 0
          ? [ev.confirmCode(owner.id, change.code), ev.confirmCode(rival.id, rival.code)]
          : [ev.confirmCode(rival.id, rival.code), ev.confirmCode(owner.id, change.code)];
      const results = await Promise.all(start.map(settled));
      const [ownerResult, rivalResult] = round % 2 === 0 ? results : [results[1], results[0]];
      const verifiedRows = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'VERIFIED'`,
        [shared],
      );
      expect(verifiedRows[0]!.n, `round ${round}`).toBe(1);
      const live = (await liveContacts(owner.id)).map((c) => [c.email_normalized, c.status, c.is_primary]);
      if (ownerResult instanceof AccountError) {
        // the rival won: the owner's old primary was never touched
        expect(ownerResult.code).toBe('EMAIL_UNAVAILABLE');
        expect(rivalResult).toMatchObject({ changed: true });
        expect(live).toEqual([
          [owner.address, 'VERIFIED', true],
          [shared, 'REPLACEMENT_PENDING', false],
        ]);
        expect(await contactOf(owner.id, owner.address)).toMatchObject({ disabled_at: null, disabled_reason: null });
        expect(await auditOf(owner.id, 'EMAIL_PRIMARY_CHANGED')).toEqual([]);
        expect(await auditOf(owner.id, 'EMAIL_VERIFIED')).toHaveLength(1);
        expect(await eventsOf(owner.id, E.verified)).toHaveLength(1);
        expect(await openChallenges(owner.id)).toHaveLength(1);
      } else {
        // the owner won: the old primary was replaced and the rival lost
        expect(ownerResult).toMatchObject({ changed: true });
        expect(rivalResult).toBeInstanceOf(AccountError);
        expect((rivalResult as AccountError).code).toBe('EMAIL_UNAVAILABLE');
        expect(live).toEqual([[shared, 'VERIFIED', true]]);
        expect(await auditOf(owner.id, 'EMAIL_PRIMARY_CHANGED')).toHaveLength(1);
        expect((await liveContacts(rival.id))[0]).toMatchObject({ status: 'PENDING', is_primary: false });
      }
    }
    await expectEmailInvariants();
  });

  /** Verifies a rival's pending contact inside an OPEN transaction (its unique-index entry is uncommitted), runs `during`, then commits. */
  async function withRivalVerifying<T>(rivalId: string, during: () => Promise<T>): Promise<T> {
    const rivalContact = (await liveContacts(rivalId))[0]!.email_contact_id;
    const holder = await db().pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE email_contact_id = $1`,
        [rivalContact],
      );
      await holder.query(
        `UPDATE identity.email_verification_challenges SET used_at = clock_timestamp(), consumed_via = 'CODE' WHERE email_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [rivalContact],
      );
      const running = during();
      await lockWaiters(1); // the service waits on the rival's uncommitted unique entry: it already passed its own pre-check
      await holder.query('COMMIT');
      return await running;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  it('losing on the unique index AFTER the old primary was disabled rolls the whole replacement back (deterministic)', async () => {
    setPolicy({ resendSeconds: 0 });
    const owner = await verifiedAccount(addr('keep'));
    const shared = addr('prize');
    const change = await pendingWithMail({ id: owner.id, address: shared });
    const rival = await pendingWithMail({ address: shared });
    const before = await contactOf(owner.id, owner.address);
    const outcome = await withRivalVerifying(rival.id, () => settled(ev.confirmCode(owner.id, change.code)));
    expect(outcome).toBeInstanceOf(AccountError);
    expect((outcome as AccountError).code).toBe('EMAIL_UNAVAILABLE');
    expect((outcome as AccountError).details).toEqual({ reason: 'ADDRESS_UNAVAILABLE' });
    expect(await contactOf(owner.id, owner.address)).toEqual(before); // still VERIFIED and primary, never disabled
    expect((await liveContacts(owner.id)).map((c) => [c.email_normalized, c.status, c.is_primary])).toEqual([
      [owner.address, 'VERIFIED', true],
      [shared, 'REPLACEMENT_PENDING', false],
    ]);
    expect(await auditOf(owner.id, 'EMAIL_PRIMARY_CHANGED')).toEqual([]);
    expect(await auditOf(owner.id, 'EMAIL_VERIFIED')).toHaveLength(1);
    expect(await eventsOf(owner.id, E.verified)).toHaveLength(1);
    expect(await openChallenges(owner.id)).toHaveLength(1);
    expect((await challengesOf(owner.id)).at(-1)).toMatchObject({ used_at: null, attempt_count: 0 });
    await expectEmailInvariants();
  });

  it('losing on the unique index in a first verification rolls it back too: the contact stays PENDING with its open challenge (deterministic)', async () => {
    const shared = addr('prize');
    const loser = await pendingWithMail({ address: shared });
    const rival = await pendingWithMail({ address: shared });
    const before = await snapshot(loser.id);
    const outcome = await withRivalVerifying(rival.id, () => settled(ev.confirmLink(loser.id, loser.token)));
    expect(outcome).toBeInstanceOf(AccountError);
    expect((outcome as AccountError).code).toBe('EMAIL_UNAVAILABLE');
    expect(await snapshot(loser.id)).toEqual(before);
  });

  it('verified duplicates are impossible at the database level (unique index), pending duplicates are allowed', async () => {
    const shared = addr('db');
    const a = await verifiedAccount(shared);
    const b = await newAccount();
    await ev.setEmail(b, shared); // pending duplicate: fine
    const verifiedRows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM identity.email_contacts WHERE email_normalized = $1`, [shared]);
    expect(verifiedRows[0]!.n).toBe(2);
    const bContact = (await liveContacts(b))[0]!;
    const e = (await rejection(
      q(`UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = now() WHERE email_contact_id = $1`, [
        bContact.email_contact_id,
      ]),
    )) as { code?: string; constraint?: string };
    expect(e.code).toBe('23505');
    expect(e.constraint).toBe('uq_email_contacts__verified_address');
    expect((await liveContacts(a.id))[0]!.status).toBe('VERIFIED');
  });
});

// ====================================================================== #26 change email
describe('changing a verified email (#26)', () => {
  // the cooldown is per account and survives the first verification: the change flow sends a second message at once
  beforeEach(() => setPolicy({ resendSeconds: 0 }));

  it('a new address becomes a REPLACEMENT_PENDING candidate: the verified primary stays VERIFIED and primary, with the change events and audit', async () => {
    const p = await verifiedAccount(addr('old'));
    const candidate = addr('new');
    const r = await ev.setEmail(p.id, candidate);
    expect(r.changed).toBe(true);
    expect(r.email.emailVerificationStatus).toBe('VERIFIED');
    expect(r.email.primary).toEqual({ maskedEmail: maskEmail(p.address), verifiedAt: expect.any(String), source: 'USER_ENTERED' });
    expect(r.email.pending).toEqual({
      maskedEmail: maskEmail(candidate),
      purpose: 'CHANGE_EMAIL',
      status: 'REPLACEMENT_PENDING',
      lastSentAt: null,
      expiresAt: null,
    });

    const primary = await contactOf(p.id, p.address);
    const pending = await contactOf(p.id, candidate);
    expect(primary).toMatchObject({ status: 'VERIFIED', is_primary: true, disabled_at: null });
    expect(pending).toMatchObject({ status: 'REPLACEMENT_PENDING', is_primary: false, source: 'USER_ENTERED', verified_at: null });
    expect((await accounts.getAccountContext(p.id)).email.emailVerificationStatus).toBe('VERIFIED');

    const requested = await auditOf(p.id, 'EMAIL_CHANGE_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ email_contact_id: pending.email_contact_id, actor: `account:${p.id}` });
    expect(requested[0]!.changes).toEqual({
      status: [null, 'REPLACEMENT_PENDING'],
      maskedEmail: maskEmail(candidate),
      purpose: 'CHANGE_EMAIL',
      replacesContactId: primary.email_contact_id,
    });
    const change = await eventsOf(p.id, E.changeRequested);
    expect(change).toHaveLength(1);
    expect(change[0]!.payload_json).toEqual({ accountId: p.id, emailContactId: pending.email_contact_id, replacesEmailContactId: primary.email_contact_id });
    const added = await eventsOf(p.id, E.contactAdded);
    expect(added).toHaveLength(2);
    expect(added[1]!.payload_json).toEqual({
      accountId: p.id,
      emailContactId: pending.email_contact_id,
      purpose: 'CHANGE_EMAIL',
      source: 'USER_ENTERED',
      status: 'REPLACEMENT_PENDING',
    });
    expect(mailsTo(candidate)).toEqual([]);
  });

  it('INITIAL and CHANGE challenge purposes are stored correctly', async () => {
    const p = await verifiedAccount(addr('old'));
    const change = await pendingWithMail({ id: p.id, address: addr('new') });
    const challenges = await challengesOf(p.id);
    expect(challenges.map((c) => c.purpose)).toEqual(['INITIAL_EMAIL', 'CHANGE_EMAIL']);
    expect(change.sent.email.pending).toMatchObject({ purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' });
    expect((await auditOf(p.id, 'EMAIL_VERIFICATION_REQUESTED')).map((a) => (a.changes as { purpose: string }).purpose)).toEqual([
      'INITIAL_EMAIL',
      'CHANGE_EMAIL',
    ]);
    expect((await eventsOf(p.id, E.verificationSent)).map((e) => e.payload_json.purpose)).toEqual(['INITIAL_EMAIL', 'CHANGE_EMAIL']);
  });

  it('verifying the candidate makes it primary and DISABLES the old one as REPLACED, with EMAIL_VERIFIED + EMAIL_PRIMARY_CHANGED and a Verified event naming the replaced contact', async () => {
    const p = await verifiedAccount(addr('old'));
    const next = await pendingWithMail({ id: p.id, address: addr('new') });
    const oldBefore = await contactOf(p.id, p.address);
    const r = await ev.confirmCode(p.id, next.code);
    expect(r.changed).toBe(true);
    expect(r.email.primary).toMatchObject({ maskedEmail: maskEmail(next.address), source: 'USER_ENTERED' });
    expect(r.email.pending).toBeNull();
    expect(r.email.emailVerificationStatus).toBe('VERIFIED');

    const oldAfter = await contactOf(p.id, p.address);
    const newer = await contactOf(p.id, next.address);
    expect(oldAfter).toMatchObject({ status: 'DISABLED', is_primary: false, disabled_reason: 'REPLACED' });
    expect(oldAfter.disabled_at).toBeInstanceOf(Date);
    expect(oldAfter.verified_at!.getTime()).toBe(oldBefore.verified_at!.getTime()); // kept as history
    expect(newer).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect(newer.verified_at).toBeInstanceOf(Date);

    const ch = (await challengesOf(p.id)).at(-1)!;
    expect(ch).toMatchObject({ purpose: 'CHANGE_EMAIL', consumed_via: 'CODE' });
    const verified = (await auditOf(p.id, 'EMAIL_VERIFIED')).at(-1)!;
    expect(verified.changes).toEqual({
      status: ['REPLACEMENT_PENDING', 'VERIFIED'],
      maskedEmail: maskEmail(next.address),
      method: 'CODE',
      purpose: 'CHANGE_EMAIL',
      challengeId: ch.challenge_id,
    });
    const changed = await auditOf(p.id, 'EMAIL_PRIMARY_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ email_contact_id: newer.email_contact_id });
    expect(changed[0]!.changes).toEqual({ from: maskEmail(p.address), to: maskEmail(next.address), replacedContactId: oldAfter.email_contact_id });
    const ve = (await eventsOf(p.id, E.verified)).at(-1)!;
    expect(ve.payload_json).toEqual({
      accountId: p.id,
      emailContactId: newer.email_contact_id,
      purpose: 'CHANGE_EMAIL',
      source: 'USER_ENTERED',
      method: 'CODE',
      replacedEmailContactId: oldAfter.email_contact_id,
    });
    await expectEmailInvariants();
  });

  it('the change can be verified with the link too, and the replaced address does not come back', async () => {
    const p = await verifiedAccount(addr('old'));
    const next = await pendingWithMail({ id: p.id, address: addr('new') });
    expect((await ev.confirmLink(p.id, next.token)).changed).toBe(true);
    expect((await challengesOf(p.id)).at(-1)!.consumed_via).toBe('LINK');
    expect((await liveContacts(p.id)).map((c) => c.email_normalized)).toEqual([next.address]);
    expect(((await eventsOf(p.id, E.verified)).at(-1)!.payload_json as { method: string }).method).toBe('LINK');
  });

  it('a failed (locked) change leaves the verified primary completely intact', async () => {
    const p = await verifiedAccount(addr('old'));
    const next = await pendingWithMail({ id: p.id, address: addr('new') });
    const before = await contactOf(p.id, p.address);
    for (let i = 0; i < 5; i++) await ev.confirmCode(p.id, wrongCode(next.code)).catch(() => undefined);
    await fails(ev.confirmCode(p.id, next.code), 'EMAIL_VERIFICATION_LOCKED');
    expect(await contactOf(p.id, p.address)).toEqual(before);
    expect((await accounts.getAccountContext(p.id)).email).toMatchObject({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(p.address) },
      pending: { status: 'REPLACEMENT_PENDING', expiresAt: null },
    });
    expect(await auditOf(p.id, 'EMAIL_PRIMARY_CHANGED')).toEqual([]);
  });

  it('an abandoned change (never confirmed) leaves the primary intact', async () => {
    const p = await verifiedAccount(addr('old'));
    await pendingWithMail({ id: p.id, address: addr('new') });
    expect((await liveContacts(p.id)).map((c) => [c.status, c.is_primary])).toEqual([
      ['VERIFIED', true],
      ['REPLACEMENT_PENDING', false],
    ]);
    expect((await accounts.getAccountContext(p.id)).email.emailVerificationStatus).toBe('VERIFIED');
  });

  it('setEmail with the current primary withdraws the pending change: the candidate is DISABLED SUPERSEDED and its open challenge CONTACT_DISABLED', async () => {
    const p = await verifiedAccount(addr('old'));
    const next = await pendingWithMail({ id: p.id, address: addr('new') });
    const r = await ev.setEmail(p.id, ` ${p.address.toUpperCase()} `);
    expect(r.changed).toBe(true);
    expect(r.email.pending).toBeNull();
    expect(r.email.primary).toMatchObject({ maskedEmail: maskEmail(p.address) });
    expect(await contactOf(p.id, next.address)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED', is_primary: false });
    expect(await contactOf(p.id, p.address)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect((await challengesOf(p.id)).at(-1)).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED', used_at: null });
    expect(await openChallenges(p.id)).toEqual([]);
    expect(await auditOf(p.id, 'EMAIL_VERIFIED')).toHaveLength(1);
    await expectEmailInvariants();
  });

  it('setEmail with the current primary and no pending change is a no-op', async () => {
    const p = await verifiedAccount(addr('old'));
    const before = await snapshot(p.id);
    const r = await ev.setEmail(p.id, p.address);
    expect(r.changed).toBe(false);
    expect(r.email.emailVerificationStatus).toBe('VERIFIED');
    expect(await snapshot(p.id)).toEqual(before);
  });

  it('a new candidate supersedes the old candidate: one REPLACEMENT_PENDING, the earlier one DISABLED SUPERSEDED, the primary untouched', async () => {
    const p = await verifiedAccount(addr('old'));
    const first = await pendingWithMail({ id: p.id, address: addr('c1') });
    const second = addr('c2');
    const r = await ev.setEmail(p.id, second);
    expect(r.changed).toBe(true);
    expect(await contactOf(p.id, first.address)).toMatchObject({ status: 'DISABLED', disabled_reason: 'SUPERSEDED' });
    expect(await contactOf(p.id, second)).toMatchObject({ status: 'REPLACEMENT_PENDING' });
    expect(await contactOf(p.id, p.address)).toMatchObject({ status: 'VERIFIED', is_primary: true });
    expect((await challengesOf(p.id)).at(-1)).toMatchObject({ invalidation_reason: 'CONTACT_DISABLED' });
    const added = await auditOf(p.id, 'EMAIL_CHANGE_REQUESTED');
    expect(added).toHaveLength(2);
    expect(added[1]!.changes).toMatchObject({
      supersededContactId: (await contactOf(p.id, first.address)).email_contact_id,
      replacesContactId: (await contactOf(p.id, p.address)).email_contact_id,
    });
    await fails(ev.confirmLink(p.id, first.token), 'EMAIL_CODE_USED');
  });

  it('an account can go back to an address it used before: the older row stays DISABLED history and the address verifies again', async () => {
    const p = await verifiedAccount(addr('old'));
    const next = await pendingWithMail({ id: p.id, address: addr('new') });
    await ev.confirmCode(p.id, next.code);
    const back = await pendingWithMail({ id: p.id, address: p.address });
    expect((await ev.confirmCode(p.id, back.code)).changed).toBe(true);
    const rows = (await contactsOf(p.id)).filter((c) => c.email_normalized === p.address);
    expect(rows.map((c) => c.status)).toEqual(['DISABLED', 'VERIFIED']);
    expect((await liveContacts(p.id)).map((c) => c.email_normalized)).toEqual([p.address]);
    await expectEmailInvariants();
  });

  it('the database refuses a PENDING initial address for an account that has a primary, and a replacement without a primary', async () => {
    const p = await verifiedAccount(addr('old'));
    const rule = async (accountId: string, status: string): Promise<{ code?: string; detail?: string }> =>
      (await rejection(
        q(`INSERT INTO identity.email_contacts (account_id, email_normalized, status, source) VALUES ($1, $2, $3, 'USER_ENTERED')`, [
          accountId,
          addr('raw'),
          status,
        ]),
      )) as { code?: string; detail?: string };
    const initial = await rule(p.id, 'PENDING');
    expect(initial.code).toBe('23000');
    expect(initial.detail).toContain('identity_rule:EMAIL_INITIAL_WITH_PRIMARY');
    const lone = await rule(await newAccount(), 'REPLACEMENT_PENDING');
    expect(lone.code).toBe('23000');
    expect(lone.detail).toContain('identity_rule:EMAIL_REPLACEMENT_WITHOUT_PRIMARY');
    expect(await liveContacts(p.id)).toHaveLength(1);
  });

  it('the database never lets a challenge hash be rewritten (a stored code hash cannot be swapped)', async () => {
    const x = await pendingWithMail();
    const e = (await rejection(
      q(`UPDATE identity.email_verification_challenges SET code_hash = $2 WHERE challenge_id = $1`, [
        (await challengesOf(x.id))[0]!.challenge_id,
        'a'.repeat(64),
      ]),
    )) as { code?: string; detail?: string };
    expect(e.code).toBe('23000');
    expect(e.detail).toContain('identity_rule:IMMUTABLE_IDENTITY');
  });
});

// ====================================================================== #27 #28 atomicity, audit and secrets
describe('events, audit and secrets (#27, #28)', () => {
  it('a full flow writes its events in the same transaction as the change: one event per change, aggregate identity_account, identifiers only', async () => {
    const x = await pendingWithMail();
    await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ev.confirmCode(x.id, x.code);
    const next = addr('next');
    await ev.setEmail(x.id, next);
    const types = (await events(x.id)).map((e) => e.event_type);
    // one transaction per change; the two events of the change request share a transaction (no order between them)
    expect(types.slice(0, 4)).toEqual([E.contactAdded, E.verificationSent, E.verificationFailed, E.verified]);
    expect(types.slice(4).sort()).toEqual([E.changeRequested, E.contactAdded].sort());
    for (const e of await events(x.id)) {
      expect(e.aggregate_type).toBe('identity_account');
      expect(e.actor_type).toBe('user');
      expect(e.actor_id).toBe(`account:${x.id}`);
      expect(e.payload_json.accountId).toBe(x.id);
    }
    const published = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.email-%' AND published_at IS NOT NULL`,
      [x.id],
    );
    expect(published[0]!.n).toBe(0); // unpublished: the relay publishes them later
  });

  it('a verification that fails midway (the address is verified elsewhere) leaves NO audit, outbox, contact or challenge change behind', async () => {
    const a = await verifiedAccount(addr('mid'));
    const b = await pendingWithMail({ address: a.address });
    const before = await snapshot(b.id);
    const world = await emailWorld();
    await fails(ev.confirmCode(b.id, b.code), 'EMAIL_UNAVAILABLE');
    await fails(ev.confirmLink(b.id, b.token), 'EMAIL_UNAVAILABLE');
    expect(await snapshot(b.id)).toEqual(before);
    expect(await emailWorld()).toEqual(world);
  });

  it('a change verification that fails midway does not touch the old primary either (the replacement is rolled back as a whole)', async () => {
    setPolicy({ resendSeconds: 0 });
    const owner = await verifiedAccount(addr('owner'));
    const p = await verifiedAccount(addr('mine'));
    const next = await pendingWithMail({ id: p.id, address: owner.address });
    const before = await snapshot(p.id);
    await fails(ev.confirmCode(p.id, next.code), 'EMAIL_UNAVAILABLE');
    expect(await snapshot(p.id)).toEqual(before);
    expect((await contactOf(p.id, p.address)).status).toBe('VERIFIED');
    expect((await contactOf(p.id, p.address)).is_primary).toBe(true);
  });

  it('the payloads of every event and the audit rows of a full flow hold identifiers only: no @, no code, no token, no hash, no address', async () => {
    setPolicy({ resendSeconds: 0 });
    const x = await pendingWithMail();
    for (let i = 0; i < 2; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await ev.confirmCode(x.id, x.code);
    const next = await pendingWithMail({ id: x.id, address: addr('next') });
    const messages = sender.sent.filter((m) => m.to === x.address || m.to === next.address);
    const secrets = await secretsOf(x.id, messages);
    expect(secrets.codes.length).toBeGreaterThanOrEqual(1);
    await expectNoSecrets(x.id, secrets);
  });

  it('a full flow (set, failed delivery, send, wrong codes, lock, resend, verify, change, withdraw) leaks nothing into the audit, outbox or logs', async () => {
    setPolicy({ resendSeconds: 0 });
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted, rateLimiter: new MemoryRateLimiter() });
    const id = await newAccount();
    const address = addr('flow');
    await svc.setEmail(id, address, { clientIp: '203.0.113.7' });
    scripted.next = new EmailDeliveryError('UNAVAILABLE', `down for ${address}`, true);
    await rejection(svc.sendVerification(id, { clientIp: '203.0.113.7' }));
    await svc.sendVerification(id, { clientIp: '203.0.113.7' });
    const wrong = wrongCode(codeOf(scripted.seen.at(-1)!));
    for (let i = 0; i < 5; i++) await svc.confirmCode(id, wrong, { clientIp: '203.0.113.7' }).catch(() => undefined);
    await svc.sendVerification(id, { clientIp: '203.0.113.7' });
    await svc.confirmLink(id, tokenOf(scripted.seen.at(-1)!), { clientIp: '203.0.113.7' });
    const change = addr('change');
    await svc.setEmail(id, change);
    await svc.sendVerification(id);
    await svc.setEmail(id, address); // withdraw
    const secrets = await secretsOf(id, scripted.seen);
    secrets.codes.push(wrong);
    expect(secrets.codes.length).toBeGreaterThanOrEqual(4);
    const texts = await expectNoSecrets(id, secrets);
    expect(texts.logs).toContain('could not be delivered'); // the scan saw the delivery failure log line
    expect(texts.logs).not.toContain('203.0.113.7');
    for (const a of ['203.0.113.7']) {
      expect(texts.audit).not.toContain(a);
      expect(texts.outbox).not.toContain(a);
    }
    expect(await tablesMentioning(secrets.tokens[1]!)).toEqual([]);
  });

  it('the log lines of the failure paths (limiter down, policy down, delivery failed) carry no secret', async () => {
    const limiter = new MemoryRateLimiter();
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithMail({ service: svc });
    limiter.unavailable = true;
    await rejection(svc.setEmail(x.id, addr('late')));
    await rejection(svc.sendVerification(x.id));
    await svc.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    limiter.unavailable = false;
    policy.failure = new Error(`configuration store down; ${x.address} ${x.code} ${x.token}`);
    await rejection(svc.sendVerification(x.id));
    await rejection(svc.confirmCode(x.id, x.code));
    policy.failure = undefined;
    const lines = logSink.lines.join('\n');
    expect(lines).toContain('rate limiter unavailable');
    expect(lines).toContain('policy unavailable');
    const secrets = await secretsOf(x.id, [x.message]);
    await expectNoSecrets(x.id, secrets);
  });

  it('the audit actor is the account itself and no free text (reason) is stored for email actions', async () => {
    const x = await verifiedAccount();
    const rows = await audit(x.id);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.actor).toBe(`account:${x.id}`);
      expect(r.reason).toBeNull();
      expect(r.email_contact_id).not.toBeNull();
    }
  });

  it('one request shares one correlation id across its audit rows and events (verify with a code under a request context)', async () => {
    const x = await pendingWithMail();
    const correlationId = `corr-${randomUUID()}`;
    await runWithCorrelation(correlationId, () => ev.confirmCode(x.id, x.code));
    expect((await auditOf(x.id, 'EMAIL_VERIFIED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(x.id, E.verified))[0]!.correlation_id).toBe(correlationId);
  });

  it('a wrong code under a request context carries its correlation id into the audit and event rows although the call threw', async () => {
    const x = await pendingWithMail();
    const correlationId = `corr-${randomUUID()}`;
    await rejection(runWithCorrelation(correlationId, () => ev.confirmCode(x.id, wrongCode(x.code))));
    expect((await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED'))[0]!.correlation_id).toBe(correlationId);
    expect((await eventsOf(x.id, E.verificationFailed))[0]!.correlation_id).toBe(correlationId);
  });
});

// ====================================================================== #29 rate limits
describe('rate limiting (#29)', () => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_700_000_000_000;
  });
  const limited = () => {
    const limiter = new MemoryRateLimiter(clock);
    return { limiter, spy: new SpyLimiter(limiter), svc: makeService({ rateLimiter: new SpyLimiter(limiter) }) };
  };

  it('the account dimension: exceeding requestsPerHour is EMAIL_RATE_LIMITED with retryAfterSeconds only, and nothing is written', async () => {
    setPolicy({ requestsPerHour: 2 });
    const { svc } = limited();
    const id = await newAccount();
    await svc.setEmail(id, addr('r1'));
    await svc.setEmail(id, addr('r2'));
    const before = await snapshot(id);
    const e = await fails(svc.setEmail(id, addr('r3')), 'EMAIL_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 3600);
    expect(e.message).not.toMatch(/account|ip\b|device|address|dimension|limitedBy/i);
    expect(await snapshot(id)).toEqual(before);
  });

  it('the window resets with the clock: after an hour the account may call again', async () => {
    setPolicy({ requestsPerHour: 1 });
    const { svc } = limited();
    const id = await newAccount();
    await svc.setEmail(id, addr('w1'));
    await fails(svc.setEmail(id, addr('w2')), 'EMAIL_RATE_LIMITED');
    now += 1800_000;
    const e = await fails(svc.setEmail(id, addr('w2')), 'EMAIL_RATE_LIMITED');
    between(e.details.retryAfterSeconds, 1, 1800);
    now += 1801_000;
    expect((await svc.setEmail(id, addr('w3'))).changed).toBe(true);
  });

  it('the ip dimension uses ctx.clientIp: another account behind the same address is limited, a different address is not', async () => {
    setPolicy({ requestsPerHour: 2 });
    const { svc } = limited();
    const [a, b, c, d] = [await newAccount(), await newAccount(), await newAccount(), await newAccount()];
    await svc.setEmail(a, addr('i1'), { clientIp: '198.51.100.10' });
    await svc.setEmail(b, addr('i2'), { clientIp: '198.51.100.10' });
    const e = await fails(svc.setEmail(c, addr('i3'), { clientIp: '198.51.100.10' }), 'EMAIL_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    expect(await liveContacts(c)).toEqual([]);
    expect((await svc.setEmail(d, addr('i4'), { clientIp: '198.51.100.11' })).changed).toBe(true);
    // without a clientIp there is no ip dimension
    expect((await svc.setEmail(c, addr('i5'))).changed).toBe(true);
  });

  it('the device dimension uses ctx.deviceId', async () => {
    setPolicy({ requestsPerHour: 1 });
    const { svc } = limited();
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    await svc.setEmail(a, addr('d1'), { deviceId: 'device-1' });
    await fails(svc.setEmail(b, addr('d2'), { deviceId: 'device-1' }), 'EMAIL_RATE_LIMITED');
    expect((await svc.setEmail(c, addr('d3'), { deviceId: 'device-2' })).changed).toBe(true);
  });

  it('the address dimension counts across accounts: the 6th send to one address is EMAIL_RATE_LIMITED, with no challenge and no message', async () => {
    const { svc } = limited();
    const shared = addr('flood');
    for (let i = 0; i < 5; i++) await pendingWithMail({ address: shared, service: svc });
    expect(mailsTo(shared)).toHaveLength(5);
    const sixth = await newAccount();
    await svc.setEmail(sixth, shared);
    const e = await fails(svc.sendVerification(sixth), 'EMAIL_RATE_LIMITED');
    expect(Object.keys(e.details)).toEqual(['retryAfterSeconds']);
    between(e.details.retryAfterSeconds, 1, 3600);
    expect(mailsTo(shared)).toHaveLength(5);
    expect(await challengesOf(sixth)).toEqual([]);
    // another address is not affected
    expect((await pendingWithMail({ service: svc })).sent.codeLength).toBe(6);
  });

  it('the address limit does not reveal ownership: the refusal is identical whether the address is verified on another account or free', async () => {
    const { svc } = limited();
    const free = addr('free');
    for (let i = 0; i < 5; i++) await pendingWithMail({ address: free, service: svc });
    const owned = addr('owned');
    await pendingWithMail({ address: owned, service: svc }).then((o) => svc.confirmCode(o.id, o.code));
    for (let i = 0; i < 4; i++) await pendingWithMail({ address: owned, service: svc });
    const refusals: AccountError[] = [];
    for (const address of [free, owned]) {
      const id = await newAccount();
      await svc.setEmail(id, address);
      refusals.push(await fails(svc.sendVerification(id), 'EMAIL_RATE_LIMITED'));
    }
    expect(refusals[0]!.message).toBe(refusals[1]!.message);
    expect(Object.keys(refusals[0]!.details)).toEqual(Object.keys(refusals[1]!.details));
    expect(shapeOf(refusals[0]!.details)).toEqual(shapeOf(refusals[1]!.details));
  });

  it('ABUSE: sends refused by the cooldown or the caps do not use up the per-address budget (only delivered emails count) [currently they do]', async () => {
    setPolicy({ addressPerHour: 3 });
    const { svc } = limited();
    const shared = addr('victim');
    const attacker = await pendingWithMail({ address: shared, service: svc }); // one email is sent to the address
    for (let i = 0; i < 5; i++) await rejection(svc.sendVerification(attacker.id)); // refused by the 30 s cooldown: no email leaves
    expect(mailsTo(shared)).toHaveLength(1);
    // the owner of the address (another account) can still receive their two remaining emails of the hour
    const owner = await pendingWithMail({ address: shared, service: svc });
    expect(owner.sent.codeLength).toBe(6);
    expect(mailsTo(shared)).toHaveLength(2);
  });

  it('the addressPerHour limit comes from the policy', async () => {
    setPolicy({ addressPerHour: 1 });
    const { svc } = limited();
    const shared = addr('one');
    await pendingWithMail({ address: shared, service: svc });
    const id = await newAccount();
    await svc.setEmail(id, shared);
    await fails(svc.sendVerification(id), 'EMAIL_RATE_LIMITED');
  });

  it('a refused request consumes nothing from the other dimensions', async () => {
    setPolicy({ addressPerHour: 1, requestsPerHour: 2 });
    const { svc } = limited();
    const shared = addr('shared');
    await pendingWithMail({ address: shared, service: svc }); // uses the only send to this address
    const b = await newAccount();
    await svc.setEmail(b, shared, { clientIp: '192.0.2.50' }); // account b 1, ip 1
    await fails(svc.sendVerification(b, { clientIp: '192.0.2.50' }), 'EMAIL_RATE_LIMITED'); // refused by the address: must not use account or ip
    await svc.setEmail(b, addr('other'), { clientIp: '192.0.2.50' }); // account b 2, ip 2: allowed only if the refusal consumed nothing
    await fails(svc.setEmail(b, addr('third'), { clientIp: '192.0.2.50' }), 'EMAIL_RATE_LIMITED');
  });

  it('the rules handed to the limiter: names, limits, a one-hour window, and opaque keys (no raw IP, no address, no device id)', async () => {
    const spy = new SpyLimiter(new MemoryRateLimiter(clock));
    const svc = makeService({ rateLimiter: spy });
    const id = await newAccount();
    const address = addr('rules');
    const ctx = { clientIp: '203.0.113.9', deviceId: 'device-xyz' };
    await svc.setEmail(id, address, ctx);
    await svc.sendVerification(id, ctx);
    const issued = sender.sent[0]!;
    await svc.confirmCode(id, codeOf(issued), ctx);

    const [setCall, sendCall, confirmCall] = spy.calls;
    const names = (rules: RateRule[] | undefined) => rules!.map((r) => r.name);
    expect(names(setCall)).toEqual(['email-verification:account', 'email-verification:ip', 'email-verification:device']);
    expect(names(sendCall)).toEqual(['email-verification:account', 'email-verification:ip', 'email-verification:device', 'email-verification:address']);
    expect(names(confirmCall)).toEqual(['email-verification:account', 'email-verification:ip', 'email-verification:device']);
    for (const r of [...setCall!, ...sendCall!, ...confirmCall!]) {
      expect(r.windowSeconds).toBe(3600);
      expect(r.limit).toBe(r.name.endsWith(':address') ? PRD.addressPerHour : PRD.requestsPerHour);
    }
    const keys = spy.calls.flat().map((r) => r.key);
    expect(keys.some((k) => k === id)).toBe(true);
    const text = JSON.stringify(spy.calls);
    for (const raw of ['203.0.113.9', 'device-xyz', address, localPart(address)]) expect(text).not.toContain(raw);
    const byName = (rules: RateRule[], name: string) => rules.find((r) => r.name === name)!.key;
    expect(byName(sendCall!, 'email-verification:ip')).toBe(hashDimension(testHashKey, 'ip', '203.0.113.9'));
    expect(byName(sendCall!, 'email-verification:device')).toBe(hashDimension(testHashKey, 'device', 'device-xyz'));
    expect(byName(sendCall!, 'email-verification:address')).toBe(hashDimension(testHashKey, 'email', address));
  });

  it('confirmCode is limited too (EMAIL_RATE_LIMITED), and a refused attempt is not counted as a wrong code', async () => {
    setPolicy({ requestsPerHour: 3 });
    const { svc } = limited();
    const x = await pendingWithMail({ service: svc }); // set + send = 2 requests
    await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_CODE_INVALID'); // 3rd
    await fails(svc.confirmCode(x.id, wrongCode(x.code)), 'EMAIL_RATE_LIMITED');
    await fails(svc.confirmCode(x.id, x.code), 'EMAIL_RATE_LIMITED');
    expect((await challengesOf(x.id))[0]).toMatchObject({ attempt_count: 1, used_at: null });
    expect(await auditOf(x.id, 'EMAIL_VERIFICATION_FAILED')).toHaveLength(1);
  });

  it('the limiter being unavailable FAILS CLOSED for setEmail and sendVerification (UNAVAILABLE, RATE_LIMITER_UNAVAILABLE) and sends nothing', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const x = await pendingWithMail({ service: svc });
    const before = await snapshot(x.id);
    const world = await emailWorld();
    const mails = sender.sent.length;
    limiter.unavailable = true;
    setPolicy({ resendSeconds: 0 }); // the authoritative cooldown is checked before the limiter: lift it so the send reaches the limiter
    await fails(svc.setEmail(x.id, addr('late')), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    await fails(svc.sendVerification(x.id), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    const fresh = await newAccount(); // creating the account is not an email operation
    await fails(svc.setEmail(fresh, addr('fresh')), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    expect(await snapshot(x.id)).toEqual(before);
    expect(sender.sent).toHaveLength(mails);
    expect(await liveContacts(fresh)).toEqual([]);
    expect((await emailWorld()).contacts).toBe(world.contacts);
  });

  it('the limiter being unavailable does NOT block confirmCode and confirmLink (the attempt counter still applies)', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const byCode = await pendingWithMail({ service: svc });
    const byLink = await pendingWithMail({ service: svc });
    limiter.unavailable = true;
    const wrong = await fails(svc.confirmCode(byCode.id, wrongCode(byCode.code)), 'EMAIL_CODE_INVALID');
    expect(wrong.details).toEqual({ attemptsRemaining: 4 });
    expect((await svc.confirmCode(byCode.id, byCode.code)).changed).toBe(true);
    expect((await svc.confirmLink(byLink.id, byLink.token)).changed).toBe(true);
    // and the lock still works without the limiter
    const locked = await pendingWithMail({ service: makeService({ rateLimiter: limiter }) }).catch(() => undefined);
    expect(locked).toBeUndefined(); // set/send are closed while the limiter is down
  });

  it('a recovered limiter lets requests through again', async () => {
    const limiter = new MemoryRateLimiter(clock);
    const svc = makeService({ rateLimiter: limiter });
    const id = await newAccount();
    limiter.unavailable = true;
    await fails(svc.setEmail(id, addr('down')), 'UNAVAILABLE', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    limiter.unavailable = false;
    expect((await svc.setEmail(id, addr('up'))).changed).toBe(true);
  });

  it('without a limiter the database limits alone apply (cooldown and caps still hold)', async () => {
    const x = await pendingWithMail({ service: makeService() });
    await fails(ev.sendVerification(x.id), 'EMAIL_RESEND_TOO_SOON');
  });
});

// ====================================================================== policy failures
describe('the policy fails closed', () => {
  const values = (over: Partial<Record<keyof EmailVerificationPolicy, unknown>> = {}): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(EMAIL_POLICY_KEYS).map(([field, key]) => [
        key,
        field in over ? over[field as keyof EmailVerificationPolicy] : PRD[field as keyof EmailVerificationPolicy],
      ]),
    );
  const provider = (over: Partial<Record<keyof EmailVerificationPolicy, unknown>> = {}): VerificationPolicyProvider => ({
    policy: async () => parseEmailVerificationPolicy(values(over)),
  });

  it('a throwing policy provider is UNAVAILABLE (POLICY_UNAVAILABLE) for setEmail, sendVerification, confirmCode, confirmLink and getEmailDetail, and nothing is written', async () => {
    const x = await pendingWithMail();
    const before = await snapshot(x.id);
    const world = await emailWorld();
    const mails = sender.sent.length;
    policy.failure = new Error('configuration store is down: verification.email.max_attempts');
    const expected = { reason: 'POLICY_UNAVAILABLE' };
    const results = await Promise.all([
      fails(ev.setEmail(x.id, addr('p')), 'UNAVAILABLE', expected),
      fails(ev.sendVerification(x.id), 'UNAVAILABLE', expected),
      fails(ev.confirmCode(x.id, x.code), 'UNAVAILABLE', expected),
      fails(ev.confirmLink(x.id, x.token), 'UNAVAILABLE', expected),
      fails(ev.getEmailDetail(x.id), 'UNAVAILABLE', expected),
    ]);
    for (const e of results) expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/configuration store|max_attempts/);
    expect(await snapshot(x.id)).toEqual(before);
    expect(await emailWorld()).toEqual(world);
    expect(sender.sent).toHaveLength(mails);
    // the cheap summary needs no configuration and keeps working
    expect((await ev.getEmailSummary(x.id)).emailVerificationStatus).toBe('PENDING');
    // and the correct code verifies again as soon as the policy is back
    policy.failure = undefined;
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('a verification can not be completed while the policy is down: a correct code is not accepted without the limits', async () => {
    const x = await pendingWithMail();
    policy.failure = new Error('down');
    await fails(ev.confirmCode(x.id, x.code), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect((await contactOf(x.id, x.address)).status).toBe('PENDING');
  });

  it.each([
    ['a code length below 4', { codeLength: 3 }, 'codeLength'],
    ['a code length above 10', { codeLength: 11 }, 'codeLength'],
    ['a zero validity', { validityMinutes: 0 }, 'validityMinutes'],
    ['a negative cooldown', { resendSeconds: -1 }, 'resendSeconds'],
    ['a zero hourly cap', { maxPerHour: 0 }, 'maxPerHour'],
    ['a fractional daily cap', { maxPerDay: 2.5 }, 'maxPerDay'],
    ['a string attempt limit', { maxAttempts: '5' }, 'maxAttempts'],
    ['a missing request limit', { requestsPerHour: undefined }, 'requestsPerHour'],
    ['a null address limit', { addressPerHour: null }, 'addressPerHour'],
  ])('an invalid policy value (%s) is UNAVAILABLE POLICY_INVALID for every operation, and nothing is written', async (_name, over, field) => {
    const x = await pendingWithMail();
    const before = await snapshot(x.id);
    const mails = sender.sent.length;
    const svc = makeService({ policy: provider(over) });
    const expected = { reason: 'POLICY_INVALID', field };
    await fails(svc.setEmail(x.id, addr('p')), 'UNAVAILABLE', expected);
    await fails(svc.sendVerification(x.id), 'UNAVAILABLE', expected);
    await fails(svc.confirmCode(x.id, x.code), 'UNAVAILABLE', expected);
    await fails(svc.confirmLink(x.id, x.token), 'UNAVAILABLE', expected);
    await fails(svc.getEmailDetail(x.id), 'UNAVAILABLE', expected);
    expect(await snapshot(x.id)).toEqual(before);
    expect(sender.sent).toHaveLength(mails);
  });

  it('valid boundary values are accepted (cooldown 0, code length 4 and 10, attempts 1)', async () => {
    const svc = makeService({ policy: provider({ resendSeconds: 0, codeLength: 10, maxAttempts: 1 }) });
    const x = await pendingWithMail({ service: svc });
    expect(x.code).toMatch(/^[0-9]{10}$/);
    const svc4 = makeService({ policy: provider({ codeLength: 4 }) });
    expect((await pendingWithMail({ service: svc4 })).code).toMatch(/^[0-9]{4}$/);
  });

  it('a provider that hands over an unusable policy without validation sends NO mail and writes no challenge', async () => {
    const x = await pendingWithMail();
    setPolicy({ resendSeconds: 0, codeLength: 99 });
    const before = await snapshot(x.id);
    const mails = sender.sent.length;
    const e = await rejection(ev.sendVerification(x.id));
    expect(e).toBeInstanceOf(Error);
    expect(sender.sent).toHaveLength(mails);
    expect(await snapshot(x.id)).toEqual(before);
  });
});

// ====================================================================== #30 state
describe('the account context reflects the email state (#30)', () => {
  it('NONE, then PENDING, then VERIFIED, in getAccountContext and getEmailSummary', async () => {
    const created = await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject: randomUUID(), identityRoles: ['customer'] });
    const id = created.accountId;
    expect(created.email).toEqual({ emailVerificationStatus: 'NONE', primary: null, pending: null });
    expect(await ev.getEmailSummary(id)).toEqual(created.email);

    const address = addr('state');
    await ev.setEmail(id, address);
    const pending = (await accounts.getAccountContext(id)).email;
    expect(pending.emailVerificationStatus).toBe('PENDING');
    expect(pending.primary).toBeNull();
    expect(pending.pending).toMatchObject({ maskedEmail: maskEmail(address), status: 'PENDING', lastSentAt: null });
    expect(await ev.getEmailSummary(id)).toEqual(pending);

    await ev.sendVerification(id);
    const sent = (await accounts.getAccountContext(id)).email;
    expect(sent.emailVerificationStatus).toBe('PENDING');
    expect(sent.pending!.lastSentAt).not.toBeNull();
    expect(sent.pending!.expiresAt).not.toBeNull();

    await ev.confirmCode(id, codeOf(sender.sent[0]!));
    const verified = (await accounts.getAccountContext(id)).email;
    expect(verified).toEqual({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(address), verifiedAt: expect.any(String), source: 'USER_ENTERED' },
      pending: null,
    });
    expect(await ev.getEmailSummary(id)).toEqual(verified);
  });

  it('getEmailDetail: resendAvailableAt is null before any send, set right after a send, and null again with a cooldown of 0', async () => {
    const id = await newAccount();
    expect((await ev.getEmailDetail(id)).resendAvailableAt).toBeNull();
    await ev.setEmail(id, addr('detail'));
    expect((await ev.getEmailDetail(id)).resendAvailableAt).toBeNull();
    const sent = await ev.sendVerification(id);
    const detail = await ev.getEmailDetail(id);
    expect(detail.resendAvailableAt).toBeInstanceOf(Date);
    expect(detail.resendAvailableAt!.getTime()).toBe(sent.resendAvailableAt.getTime());
    setPolicy({ resendSeconds: 0 });
    expect((await ev.getEmailDetail(id)).resendAvailableAt).toBeNull();
  });

  it('getEmailDetail: attemptsRemaining follows the wrong attempts; codeLength and validityMinutes follow the policy', async () => {
    const id = await newAccount();
    const empty = await ev.getEmailDetail(id);
    expect(empty).toMatchObject({ emailVerificationStatus: 'NONE', attemptsRemaining: null, resendAvailableAt: null, codeLength: 6, validityMinutes: 10 });
    const x = await pendingWithMail({ id });
    expect((await ev.getEmailDetail(id)).attemptsRemaining).toBe(5);
    await ev.confirmCode(id, wrongCode(x.code)).catch(() => undefined);
    expect((await ev.getEmailDetail(id)).attemptsRemaining).toBe(4);
    setPolicy({ codeLength: 8, validityMinutes: 15, maxAttempts: 3 });
    expect(await ev.getEmailDetail(id)).toMatchObject({ attemptsRemaining: 2, codeLength: 8, validityMinutes: 15 });
    await ev.confirmCode(id, x.code).catch(() => undefined);
    setPolicy({});
    const verified = await ev.getEmailDetail(id);
    expect(verified).toMatchObject({ emailVerificationStatus: 'VERIFIED', attemptsRemaining: null, resendAvailableAt: null });
  });

  it('getEmailDetail after a lock shows no attempts left to count and no usable expiry', async () => {
    const x = await pendingWithMail();
    for (let i = 0; i < 5; i++) await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    const detail = await ev.getEmailDetail(x.id);
    expect(detail.attemptsRemaining).toBeNull();
    expect(detail.pending).toMatchObject({ expiresAt: null });
    expect(detail.pending!.lastSentAt).not.toBeNull();
  });

  it('the pending change is part of the summary next to the verified primary', async () => {
    const p = await verifiedAccount(addr('old'));
    const candidate = addr('new');
    await ev.setEmail(p.id, candidate);
    expect(await ev.getEmailSummary(p.id)).toMatchObject({
      emailVerificationStatus: 'VERIFIED',
      primary: { maskedEmail: maskEmail(p.address) },
      pending: { maskedEmail: maskEmail(candidate), purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' },
    });
  });

  it('the full address (and its local part and domain) never appears in any summary, detail, send, confirm or context object', async () => {
    const id = await newAccount();
    const address = addr('masked');
    const collected: unknown[] = [];
    collected.push(await ev.setEmail(id, address));
    collected.push(await ev.getEmailSummary(id));
    collected.push(await ev.getEmailDetail(id));
    const sent = await ev.sendVerification(id);
    collected.push(sent);
    collected.push(await ev.getEmailDetail(id));
    collected.push(await accounts.getAccountContext(id));
    const wrong = await rejection(ev.confirmCode(id, wrongCode(codeOf(sender.sent[0]!))));
    collected.push({ m: (wrong as AccountError).message, d: (wrong as AccountError).details });
    collected.push(await ev.confirmCode(id, codeOf(sender.sent[0]!)));
    collected.push(await ev.confirmCode(id, codeOf(sender.sent[0]!)));
    collected.push(await ev.getEmailDetail(id));
    collected.push(await accounts.getAccountContext(id, { includeProfile: true }));
    const change = addr('changed');
    collected.push(await ev.setEmail(id, change));
    collected.push(await ev.getEmailSummary(id));
    const text = JSON.stringify(collected);
    for (const secret of [address, localPart(address), change, localPart(change), 'example.test', 'example'])
      expect(text, `leaked ${secret}`).not.toContain(secret);
    expect(text).toContain(maskEmail(address));
  });
});

// ====================================================================== delivery failure
describe('delivery failure', () => {
  async function failing(failure: unknown) {
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    const id = await newAccount();
    const address = addr('deliver');
    await svc.setEmail(id, address);
    scripted.next = failure;
    return { id, address, scripted, svc };
  }

  it('a retryable EmailDeliveryError is EMAIL_DELIVERY_FAILED (retryable true); the challenge is FAILED and closed DELIVERY_FAILED; no Sent event; no cooldown; the request is still audited', async () => {
    const f = await failing(new EmailDeliveryError('UNAVAILABLE', 'smtp down', true));
    const e = await fails(f.svc.sendVerification(f.id), 'EMAIL_DELIVERY_FAILED', { retryable: true });
    expect(e.message).not.toContain(f.address);
    const [c] = await challengesOf(f.id);
    expect(c).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED', last_sent_at: null, used_at: null, attempt_count: 0 });
    expect(c!.invalidated_at).toBeInstanceOf(Date);
    expect(await eventsOf(f.id, E.verificationSent)).toEqual([]);
    const requested = await auditOf(f.id, 'EMAIL_VERIFICATION_REQUESTED');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.changes).toMatchObject({ challengeId: c!.challenge_id });
    expect(await openChallenges(f.id)).toEqual([]);
    expect((await ev.getEmailSummary(f.id)).pending).toMatchObject({ lastSentAt: null, expiresAt: null });
    // no cooldown: the next send goes out at once
    const sent = await f.svc.sendVerification(f.id);
    expect(30_000 - (sent.resendAvailableAt.getTime() - sent.sentAt.getTime())).toBeLessThan(5_000);
    expect(sent.resendAvailableAt.getTime()).toBeLessThanOrEqual(sent.sentAt.getTime() + 30_000);
    expect(f.scripted.seen).toHaveLength(2);
    const challenges = await challengesOf(f.id);
    expect(challenges.map((x) => x.delivery_status)).toEqual(['FAILED', 'SENT']);
    expect(await eventsOf(f.id, E.verificationSent)).toHaveLength(1);
  });

  it('a REJECTED error is not retryable', async () => {
    const f = await failing(new EmailDeliveryError('REJECTED', 'mailbox refused', false));
    await fails(f.svc.sendVerification(f.id), 'EMAIL_DELIVERY_FAILED', { retryable: false });
  });

  it('a RENDER_FAILED error is not retryable', async () => {
    const f = await failing(new EmailDeliveryError('RENDER_FAILED', 'template missing', false));
    await fails(f.svc.sendVerification(f.id), 'EMAIL_DELIVERY_FAILED', { retryable: false });
  });

  it('a generic Error from the sender maps to a retryable EMAIL_DELIVERY_FAILED and never leaks its text', async () => {
    const f = await failing(new Error('connect ECONNREFUSED to smtp.internal for hidden-recipient'));
    const e = await fails(f.svc.sendVerification(f.id), 'EMAIL_DELIVERY_FAILED', { retryable: true });
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toMatch(/ECONNREFUSED|smtp\.internal|hidden-recipient/);
    expect(logSink.lines.join('\n')).not.toMatch(/ECONNREFUSED|smtp\.internal|hidden-recipient/);
    expect((await challengesOf(f.id))[0]).toMatchObject({ delivery_status: 'FAILED', invalidation_reason: 'DELIVERY_FAILED' });
  });

  it('the code of a message that was not delivered does not verify (EMAIL_CODE_INVALID, nothing counted)', async () => {
    const f = await failing(new EmailDeliveryError('UNAVAILABLE', 'down', true));
    await rejection(f.svc.sendVerification(f.id));
    const lost = f.scripted.seen[0]!;
    await fails(f.svc.confirmCode(f.id, codeOf(lost)), 'EMAIL_CODE_INVALID');
    expect((await challengesOf(f.id))[0]).toMatchObject({ attempt_count: 0, used_at: null });
    expect((await liveContacts(f.id))[0]!.status).toBe('PENDING');
    expect(await auditOf(f.id, 'EMAIL_VERIFICATION_FAILED')).toEqual([]);
  });

  it('a failed resend closes only its own challenge: the earlier delivered one was already superseded, so nothing is open and a later send recovers', async () => {
    setPolicy({ resendSeconds: 0 });
    const scripted = new ScriptedSender();
    const svc = makeService({ sender: scripted });
    const x = await pendingWithMail({ service: svc, mail: { sent: scripted.seen } });
    scripted.next = new EmailDeliveryError('UNAVAILABLE', 'down', true);
    await rejection(svc.sendVerification(x.id));
    expect(await openChallenges(x.id)).toEqual([]);
    await fails(svc.confirmCode(x.id, x.code), 'EMAIL_CODE_INVALID');
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
});

// ====================================================================== account status
describe('suspended and closed accounts', () => {
  it('a SUSPENDED account is refused (SUSPENDED) by setEmail, sendVerification, confirmCode and confirmLink, and nothing changes; reactivation restores it', async () => {
    const x = await pendingWithMail();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    const before = await snapshot(x.id);
    const mails = sender.sent.length;
    await fails(ev.setEmail(x.id, addr('s')), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(ev.sendVerification(x.id), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(ev.confirmCode(x.id, x.code), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(ev.confirmLink(x.id, x.token), 'SUSPENDED', { status: 'SUSPENDED' });
    expect(await snapshot(x.id)).toEqual(before);
    expect(sender.sent).toHaveLength(mails);
    await accounts.changeStatus(x.id, 'ACTIVE', OP);
    expect((await ev.confirmCode(x.id, x.code)).changed).toBe(true);
  });

  it('a wrong code on a suspended account is refused as SUSPENDED and is not counted', async () => {
    const x = await pendingWithMail();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    await fails(ev.confirmCode(x.id, wrongCode(x.code)), 'SUSPENDED');
    expect((await challengesOf(x.id))[0]!.attempt_count).toBe(0);
  });

  it('a CLOSED account is refused (CLOSED) by every email operation', async () => {
    const x = await pendingWithMail();
    await accounts.changeStatus(x.id, 'SUSPENDED', OP);
    await accounts.changeStatus(x.id, 'CLOSED', OP);
    const before = await snapshot(x.id);
    await fails(ev.setEmail(x.id, addr('c')), 'CLOSED', { status: 'CLOSED' });
    await fails(ev.sendVerification(x.id), 'CLOSED', { status: 'CLOSED' });
    await fails(ev.confirmCode(x.id, x.code), 'CLOSED', { status: 'CLOSED' });
    await fails(ev.confirmLink(x.id, x.token), 'CLOSED', { status: 'CLOSED' });
    await fails(ev.bootstrapIdpEmail(x.id, { email: addr('c'), emailVerified: true, identityProvider: 'google' }, new Set(['google'])), 'CLOSED');
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('a SUSPENDED account is refused by the IdP bootstrap and nothing is persisted', async () => {
    const id = await newAccount();
    await accounts.changeStatus(id, 'SUSPENDED', OP);
    await fails(ev.bootstrapIdpEmail(id, { email: addr('s'), emailVerified: true, identityProvider: 'google' }, new Set(['google'])), 'SUSPENDED');
    expect(await contactsOf(id)).toEqual([]);
  });
});

// ====================================================================== #11 trusted identity provider email
describe('bootstrapIdpEmail: the trust boundary of a provider email (#11)', () => {
  const GOOGLE = new Set(['google']);
  const verifiedClaim = (email: string) => ({ email, emailVerified: true as unknown, identityProvider: 'google' as string | null });

  it('a verified email from a trusted provider becomes a VERIFIED primary (IDP_VERIFIED) with audit, events, no challenge and no message', async () => {
    const id = await newAccount();
    const address = addr('idp');
    const r = await ev.bootstrapIdpEmail(id, verifiedClaim(address), GOOGLE);
    expect(r).toEqual({
      applied: true,
      email: {
        emailVerificationStatus: 'VERIFIED',
        primary: { maskedEmail: maskEmail(address), verifiedAt: expect.any(String), source: 'IDP_VERIFIED' },
        pending: null,
      },
    });
    const [c] = await contactsOf(id);
    expect(c).toMatchObject({ email_normalized: address, status: 'VERIFIED', is_primary: true, source: 'IDP_VERIFIED', disabled_at: null });
    expect(c!.verified_at).toBeInstanceOf(Date);
    expect(await challengesOf(id)).toEqual([]);
    expect(sender.sent).toEqual([]);

    const a = await audit(id);
    expect(a.map((x) => x.action)).toEqual(['EMAIL_ADDED', 'EMAIL_VERIFIED']);
    expect(a[0]!.changes).toEqual({ status: [null, 'VERIFIED'], maskedEmail: maskEmail(address), source: 'IDP_VERIFIED', purpose: 'INITIAL_EMAIL' });
    expect(a[1]!.changes).toEqual({ status: [null, 'VERIFIED'], maskedEmail: maskEmail(address), method: 'IDP', purpose: 'INITIAL_EMAIL' });
    expect(a.every((x) => x.email_contact_id === c!.email_contact_id && x.actor === `account:${id}`)).toBe(true);

    const evs = await events(id);
    expect(evs.map((e) => e.event_type).sort()).toEqual([E.contactAdded, E.verified].sort());
    expect((await eventsOf(id, E.contactAdded))[0]!.payload_json).toEqual({
      accountId: id,
      emailContactId: c!.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'IDP_VERIFIED',
      status: 'VERIFIED',
    });
    expect((await eventsOf(id, E.verified))[0]!.payload_json).toEqual({
      accountId: id,
      emailContactId: c!.email_contact_id,
      purpose: 'INITIAL_EMAIL',
      source: 'IDP_VERIFIED',
      method: 'IDP',
      replacedEmailContactId: null,
    });
    expect((await accounts.getAccountContext(id)).email.emailVerificationStatus).toBe('VERIFIED');
    await expectNoSecrets(id, { codes: [], tokens: [], addresses: [address] });
  });

  it('canonicalizes the provider email before it is stored', async () => {
    const id = await newAccount();
    const tag = randomUUID();
    await ev.bootstrapIdpEmail(id, verifiedClaim(` Mixed.Case+${tag}@Example.TEST `), GOOGLE);
    expect((await contactsOf(id))[0]!.email_normalized).toBe(`mixed.case+${tag}@example.test`);
  });

  const NOT_APPLIED: [string, { email: unknown; emailVerified: unknown; identityProvider: string | null }, ReadonlySet<string>, string][] = [
    ['an untrusted provider', { email: addr('x'), emailVerified: true, identityProvider: 'facebook' }, GOOGLE, 'UNTRUSTED_SOURCE'],
    ['an empty trusted set', { email: addr('x'), emailVerified: true, identityProvider: 'google' }, new Set(), 'UNTRUSTED_SOURCE'],
    ['a realm user (provider null)', { email: addr('x'), emailVerified: true, identityProvider: null }, GOOGLE, 'UNTRUSTED_SOURCE'],
    ['a blank provider', { email: addr('x'), emailVerified: true, identityProvider: '' }, GOOGLE, 'UNTRUSTED_SOURCE'],
    ['email_verified as the string "true"', { email: addr('x'), emailVerified: 'true', identityProvider: 'google' }, GOOGLE, 'NOT_VERIFIED'],
    ['email_verified as the number 1', { email: addr('x'), emailVerified: 1, identityProvider: 'google' }, GOOGLE, 'NOT_VERIFIED'],
    ['email_verified false', { email: addr('x'), emailVerified: false, identityProvider: 'google' }, GOOGLE, 'NOT_VERIFIED'],
    ['email_verified missing', { email: addr('x'), emailVerified: undefined, identityProvider: 'google' }, GOOGLE, 'NOT_VERIFIED'],
    [
      'a verified claim of an untrusted provider that is also not boolean',
      { email: addr('x'), emailVerified: 'yes', identityProvider: 'facebook' },
      GOOGLE,
      'NOT_VERIFIED',
    ],
    ['no email', { email: undefined, emailVerified: true, identityProvider: 'google' }, GOOGLE, 'NO_EMAIL'],
    ['a null email', { email: null, emailVerified: true, identityProvider: 'google' }, GOOGLE, 'NO_EMAIL'],
    ['an empty email', { email: '', emailVerified: true, identityProvider: 'google' }, GOOGLE, 'NO_EMAIL'],
    ['an invalid email', { email: 'not-an-email', emailVerified: true, identityProvider: 'google' }, GOOGLE, 'INVALID_EMAIL'],
  ];
  it.each(NOT_APPLIED)('does not apply %s: applied false with the matching reason, and NOTHING is persisted', async (_name, assertion, trusted, reason) => {
    const id = await newAccount();
    const before = await snapshot(id);
    const world = await emailWorld();
    expect(await ev.bootstrapIdpEmail(id, assertion, trusted)).toEqual({ applied: false, reason });
    expect(await snapshot(id)).toEqual(before);
    expect(await emailWorld()).toEqual(world);
    expect(await contactsOf(id)).toEqual([]);
    expect(await audit(id)).toEqual([]);
    expect((await accounts.getAccountContext(id)).email).toEqual({ emailVerificationStatus: 'NONE', primary: null, pending: null });
  });

  it('an account that already has a pending address keeps it: ACCOUNT_HAS_EMAIL, nothing changes', async () => {
    const x = await pendingWithMail();
    const before = await snapshot(x.id);
    expect(await ev.bootstrapIdpEmail(x.id, verifiedClaim(addr('idp')), GOOGLE)).toEqual({ applied: false, reason: 'ACCOUNT_HAS_EMAIL' });
    expect(await snapshot(x.id)).toEqual(before);
  });

  it('an account that already has a verified primary keeps it: ACCOUNT_HAS_EMAIL, nothing changes (also for a second bootstrap)', async () => {
    const p = await verifiedAccount();
    const before = await snapshot(p.id);
    expect(await ev.bootstrapIdpEmail(p.id, verifiedClaim(addr('idp')), GOOGLE)).toEqual({ applied: false, reason: 'ACCOUNT_HAS_EMAIL' });
    const id = await newAccount();
    const address = addr('twice');
    await ev.bootstrapIdpEmail(id, verifiedClaim(address), GOOGLE);
    const after = await snapshot(id);
    expect(await ev.bootstrapIdpEmail(id, verifiedClaim(address), GOOGLE)).toEqual({ applied: false, reason: 'ACCOUNT_HAS_EMAIL' });
    expect(await snapshot(id)).toEqual(after);
    expect(await snapshot(p.id)).toEqual(before);
  });

  it('an address VERIFIED on another account is ADDRESS_UNAVAILABLE and nothing is written for the second account', async () => {
    const owner = await verifiedAccount(addr('owner'));
    const id = await newAccount();
    const before = await snapshot(id);
    expect(await ev.bootstrapIdpEmail(id, verifiedClaim(owner.address), GOOGLE)).toEqual({ applied: false, reason: 'ADDRESS_UNAVAILABLE' });
    expect(await snapshot(id)).toEqual(before);
    expect(await contactsOf(id)).toEqual([]);
  });

  it('a PENDING claim on another account does not block the trusted provider; that account then fails to verify with EMAIL_UNAVAILABLE', async () => {
    const shared = addr('claimed');
    const pending = await pendingWithMail({ address: shared });
    const id = await newAccount();
    expect((await ev.bootstrapIdpEmail(id, verifiedClaim(shared), GOOGLE)).applied).toBe(true);
    await fails(ev.confirmCode(pending.id, pending.code), 'EMAIL_UNAVAILABLE', { reason: 'ADDRESS_UNAVAILABLE' });
    expect((await liveContacts(pending.id))[0]!.status).toBe('PENDING');
  });

  it('two accounts racing the same provider address: exactly one applies, the other is ADDRESS_UNAVAILABLE (6 rounds)', async () => {
    for (let round = 0; round < 6; round++) {
      const shared = addr('idprace');
      const [a, b] = [await newAccount(), await newAccount()];
      const results = await Promise.all([ev.bootstrapIdpEmail(a, verifiedClaim(shared), GOOGLE), ev.bootstrapIdpEmail(b, verifiedClaim(shared), GOOGLE)]);
      expect(
        results.filter((r) => r.applied),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.filter((r) => !r.applied)).toEqual([{ applied: false, reason: 'ADDRESS_UNAVAILABLE' }]);
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM identity.email_contacts WHERE email_normalized = $1 AND status = 'VERIFIED'`, [
        shared,
      ]);
      expect(rows[0]!.n).toBe(1);
      const loser = results[0]!.applied ? b : a;
      expect(await contactsOf(loser)).toEqual([]);
      expect(await audit(loser)).toEqual([]);
      expect(await events(loser)).toEqual([]);
    }
  });

  it('a provider address lost on the unique index (a rival verified it between the check and the insert) is ADDRESS_UNAVAILABLE and persists nothing (deterministic)', async () => {
    const shared = addr('idprace');
    const rival = await pendingWithMail({ address: shared });
    const id = await newAccount();
    const rivalContact = (await liveContacts(rival.id))[0]!.email_contact_id;
    const holder = await db().pool.connect();
    let result: unknown;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp() WHERE email_contact_id = $1`,
        [rivalContact],
      );
      await holder.query(
        `UPDATE identity.email_verification_challenges SET used_at = clock_timestamp(), consumed_via = 'CODE' WHERE email_contact_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [rivalContact],
      );
      const running = ev.bootstrapIdpEmail(id, verifiedClaim(shared), GOOGLE);
      await lockWaiters(1);
      await holder.query('COMMIT');
      result = await running;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(result).toEqual({ applied: false, reason: 'ADDRESS_UNAVAILABLE' });
    expect(await contactsOf(id)).toEqual([]);
    expect(await audit(id)).toEqual([]);
    expect(await events(id)).toEqual([]);
  });

  it('the same account calling the bootstrap concurrently applies it once', async () => {
    const id = await newAccount();
    const address = addr('same');
    const results = await Promise.all([ev.bootstrapIdpEmail(id, verifiedClaim(address), GOOGLE), ev.bootstrapIdpEmail(id, verifiedClaim(address), GOOGLE)]);
    expect(results.map((r) => (r.applied ? 'applied' : r.reason)).sort()).toEqual(['ACCOUNT_HAS_EMAIL', 'applied']);
    expect(await contactsOf(id)).toHaveLength(1);
    expect(await auditOf(id, 'EMAIL_VERIFIED')).toHaveLength(1);
  });

  it('a provider-verified primary can be replaced like any other: the change is verified by code and the IDP row is REPLACED', async () => {
    const id = await newAccount();
    const original = addr('idp');
    await ev.bootstrapIdpEmail(id, verifiedClaim(original), GOOGLE);
    const next = await pendingWithMail({ id, address: addr('own') });
    expect(next.sent.email.pending).toMatchObject({ purpose: 'CHANGE_EMAIL', status: 'REPLACEMENT_PENDING' });
    expect((await ev.confirmCode(id, next.code)).changed).toBe(true);
    expect(await contactOf(id, original)).toMatchObject({ status: 'DISABLED', disabled_reason: 'REPLACED', source: 'IDP_VERIFIED' });
    const changed = await auditOf(id, 'EMAIL_PRIMARY_CHANGED');
    expect(changed[0]!.changes).toMatchObject({ from: maskEmail(original), to: maskEmail(next.address) });
  });

  it('never asks the policy or the limiter: the trust decision is pure and works while the policy is down', async () => {
    policy.failure = new Error('down');
    const id = await newAccount();
    expect((await ev.bootstrapIdpEmail(id, verifiedClaim(addr('nopolicy')), GOOGLE)).applied).toBe(true);
  });
});

// ====================================================================== the hash is bound to its challenge
describe('hash binding', () => {
  it('copying the code_hash of challenge A into challenge B does not make the code of A verify B', async () => {
    const idA = await newAccount();
    const idB = await newAccount();
    await ev.setEmail(idA, addr('a'));
    await ev.setEmail(idB, addr('b'));
    const contactA = (await liveContacts(idA))[0]!.email_contact_id;
    const contactB = (await liveContacts(idB))[0]!.email_contact_id;
    const challengeA = await craftChallenge(contactA, { code: KNOWN_CODE, token: fakeToken(), createdSecondsAgo: 5, expiresInSeconds: 600 });
    const hashOfA = (await challengesOf(idA))[0]!.code_hash;
    expect(hashOfA).toBe(hashVerificationCode(testHashKey, challengeA, KNOWN_CODE));

    // B is crafted with A's hash copied in (the hash column cannot be updated later; a copy is only possible at insert time)
    const challengeB = randomUUID();
    await q(
      `INSERT INTO identity.email_verification_challenges (challenge_id, email_contact_id, purpose, code_hash, magic_token_hash, created_at, expires_at, correlation_id)
       VALUES ($1, $2, 'INITIAL_EMAIL', $3, $4, clock_timestamp() - interval '5 seconds', clock_timestamp() + interval '10 minutes', 'tampered-by-test')`,
      [challengeB, contactB, hashOfA, hashMagicToken(testHashKey, fakeToken())],
    );
    expect(hashVerificationCode(testHashKey, challengeB, KNOWN_CODE)).not.toBe(hashOfA);
    const e = await fails(ev.confirmCode(idB, KNOWN_CODE), 'EMAIL_CODE_INVALID');
    expect(e.details).toEqual({ attemptsRemaining: 4 });
    expect((await liveContacts(idB))[0]!.status).toBe('PENDING');
    // A still verifies with its own code
    expect((await ev.confirmCode(idA, KNOWN_CODE)).changed).toBe(true);
  });

  it('the same code in two challenges has two different hashes, and the hash depends on the key', () => {
    const [x, y] = [randomUUID(), randomUUID()];
    expect(hashVerificationCode(testHashKey, x, KNOWN_CODE)).not.toBe(hashVerificationCode(testHashKey, y, KNOWN_CODE));
    expect(hashVerificationCode(testHashKey, x, KNOWN_CODE)).not.toBe(hashVerificationCode(otherHashKey, x, KNOWN_CODE));
    expect(hashVerificationCode(testHashKey, x, KNOWN_CODE)).toBe(hashVerificationCode(testHashKey, x, KNOWN_CODE));
    expect(hashMagicToken(testHashKey, 'one')).not.toBe(hashMagicToken(testHashKey, 'two'));
  });

  it('a crafted challenge with a correctly bound hash verifies (the control of the tampering test)', async () => {
    const id = await newAccount();
    await ev.setEmail(id, addr('control'));
    const contactId = (await liveContacts(id))[0]!.email_contact_id;
    const token = fakeToken();
    await craftChallenge(contactId, { code: KNOWN_CODE, token, createdSecondsAgo: 5, expiresInSeconds: 600 });
    expect((await ev.confirmLink(id, token)).changed).toBe(true);
    expect((await challengesOf(id))[0]!.consumed_via).toBe('LINK');
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
       VALUES ('identity_account', $1, 'bananagig.identity.email-verified.v1', 1, 'user', $2::jsonb, 'planted')`,
      [id, JSON.stringify(payload)],
    );

  it('passes on a clean account (the control of the controls)', async () => {
    const x = await pendingWithMail();
    await ev.confirmCode(x.id, wrongCode(x.code)).catch(() => undefined);
    await expectNoSecrets(x.id, await secretsOf(x.id, [x.message]));
  });

  const PLANTS: [string, (x: Issued, h: string) => Promise<unknown> | void, RegExp][] = [
    ['a code in an audit row', (x) => plantAudit(x.id, { note: `typed ${x.code}` }), /audit contains a verification code/],
    ['a token in an audit row', (x) => plantAudit(x.id, { note: x.token }), /audit contains a magic-link token/],
    ['a stored hash in an audit row', (x, h) => plantAudit(x.id, { note: h }), /audit contains a stored hash/],
    ['a full address in an audit row', (x) => plantAudit(x.id, { note: x.address }), /audit contains a full address/],
    ['an unmasked foreign address in an audit row', (x) => plantAudit(x.id, { note: 'someone@else.test' }), /masked addresses only/],
    ['an address in an event payload', (x) => plantEvent(x.id, { accountId: x.id, note: 'someone@else.test' }), /identifiers only/],
    ['a code in an event payload', (x) => plantEvent(x.id, { accountId: x.id, attemptCount: x.code }), /outbox contains a verification code/],
    [
      'a token in a log line',
      (x) => void logSink.lines.push(JSON.stringify({ level: 'info', message: 'oops', t: x.token })),
      /logs contains a magic-link token/,
    ],
    [
      'the local part in a log line',
      (x) => void logSink.lines.push(JSON.stringify({ level: 'info', message: localPart(x.address) })),
      /logs contains the local part/,
    ],
  ];
  it.each(PLANTS)('detects %s', async (_name, plant, expected) => {
    const x = await pendingWithMail();
    const hash = (await challengesOf(x.id))[0]!.code_hash;
    const secrets = await secretsOf(x.id, [x.message]);
    await plant(x, hash);
    const failure = await rejection(expectNoSecrets(x.id, secrets));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(expected);
  });
});
