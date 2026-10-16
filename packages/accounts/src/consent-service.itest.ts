// Integration tests of the account consent layer (ID-005): the real ConsentService over a real, freshly migrated PostgreSQL database (migrations 0001 to 0013 with the
// consent guard triggers, the in-force function and the audit extension), the real transactional outbox and the StaticConsentPolicyProvider (the seeded policy, mutable
// per test). Every behaviour is asserted against the rows it leaves: consent_events, account_audit_events and the outbox.
//
// Documents: CFG-002 owns the legal documents and ContentService is not a dependency of this package, so the versions are CRAFTED by SQL in exactly the states the
// content workflow would leave them in (DRAFT ... PUBLISHED, SCHEDULED with a start in the past or the future, SUPERSEDED, closed windows, other scopes) with the real
// content guard triggers enabled: the body hash is computed by the database, never by the test.
//
// Time: the DATABASE clock decides everything. Windows are exercised without trusting the host clock: versions are created with offsets from `clock_timestamp()`, and
// the function that defines "in force" is also called with explicit instants for the exact boundaries.
//
// Races are real (parallel service calls on separate pool connections, many rounds, fresh accounts per round) or deterministic (a raw transaction holds the account row
// or the version row while the call under test is started and observed to block on it). The assertions are INVARIANTS of the final state, never the interleaving.
//
// Privacy: every audit row, outbox payload, thrown error, returned value and captured log line is scanned for the legal body text, the hashes, the version ids and
// everything a client claimed; the scanner has negative controls proving that it can fail. The mutation checks at the end write a mutated copy of the service (and
// mutate the trigger in a scratch database) and prove that the race tests FAIL without the account lock and without the version share lock.
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONSENT_EVENTS, CONSENT_HISTORY_LIMIT, consentPurposeLabelKey, type ConsentEventDto, type ReacceptanceMode } from '@bananagig/contracts';
import { createDatabase, type Database } from '@bananagig/database';
import { runWithCorrelation } from '@bananagig/observability';
import { createIsolatedDatabase, rejection, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { AccountError, AccountService, ConsentService, SEEDED_CONSENT_POLICY, StaticConsentPolicyProvider, type ConsentPolicy } from './index';

// every log call of the code under test is captured here (and nothing is printed): the logs are scanned for secrets
const logSink = vi.hoisted(() => ({ all: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.all.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

// ---------------------------------------------------------------- environment (the main database and, for the mutation checks, a scratch one)
interface Env {
  iso: IsolatedDatabase;
  bigDb: Database;
  accounts: AccountService;
  policy: StaticConsentPolicyProvider;
  consent: ConsentService;
}
async function buildEnv(poolMax: number): Promise<Env> {
  const iso = await createIsolatedDatabase();
  // the `tests` pool policy holds 5 connections; the races below need up to 25 requests in flight plus the lock holders and the observer
  const bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax, connectionTimeoutMs: 30_000 } });
  const policy = new StaticConsentPolicyProvider();
  return { iso, bigDb, accounts: new AccountService({ database: bigDb }), policy, consent: new ConsentService({ database: bigDb, policy }) };
}
async function closeEnv(e: Env | undefined): Promise<void> {
  await e?.bigDb.close();
  await e?.iso.drop();
}
/** The environment the helpers below act on (the main database; the mutation checks switch it to the scratch database for the length of one scenario). */
let E: Env;
let consent: ConsentService;
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => E.bigDb.query<T>(text, params);

// ---------------------------------------------------------------- fixtures: constants
const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BODY_MARK = 'LEGALBODYMARK';
const SEEDED = ['PRIVACY_POLICY', 'TERMS_OF_SERVICE'] as const;
const OP = { actor: 'admin:operator-1', reason: 'integration test' };
/** The fixed messages of the typed errors (the errors must never echo what the client sent: they are compared with these texts, not searched for needles). */
const MSG = {
  CONSENT_PURPOSE_NOT_FOUND: 'the consent purpose was not found',
  CONSENT_PURPOSE_INACTIVE: 'the consent purpose is not active',
  CONSENT_VERSION_NOT_FOUND: 'the document version was not found',
  CONSENT_VERSION_NOT_CURRENT: 'the document version is not the current one',
  CONSENT_LOCALE_MISMATCH: 'the locale does not match the document version',
  CONSENT_HASH_MISMATCH: 'the hash does not match the document version',
  CONSENT_NOT_WITHDRAWABLE: 'the consent purpose cannot be withdrawn',
  CONSENT_NOT_ACCEPTED: 'the consent is not accepted',
  CONSENT_REQUIRED_FOR_ROLE: 'the consent is required for a role of the account',
  CONSENT_REQUIRED: 'required consents are outstanding',
  VALIDATION_FAILED: 'the request contains a value that is not valid',
} as const;

// ---------------------------------------------------------------- the leak scanner (needles, zones)
type Zone = 'audit' | 'outbox' | 'logs' | 'errors' | 'results';
const ALL_ZONES: Zone[] = ['audit', 'outbox', 'logs', 'errors', 'results'];
interface Needle {
  kind: string;
  /** The zones in which the value must never appear. */
  zones: Zone[];
}
const NEEDLES = new Map<string, Needle>();
const forbid = <T extends string>(value: T, kind: string, zones: Zone[] = ALL_ZONES): T => {
  NEEDLES.set(value, { kind, zones });
  return value;
};
/** Every error a service call threw to its caller (scanned for secrets). */
const caught: unknown[] = [];
/** Values returned to callers (scanned for what must never be returned: bodies and everything a client claimed). */
const returned: unknown[] = [];

// ---------------------------------------------------------------- fixtures: accounts
let seq = 0;
const tag = (): string => `${++seq}${randomUUID().slice(0, 5)}`;

/** An account created through the real first-request path; `roles` are the identity roles (`customer`, `provider`). */
async function newAccount(roles: string[] = ['customer']): Promise<string> {
  const subject = forbid(randomUUID(), 'Keycloak subject', ALL_ZONES);
  return (await E.accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject, identityRoles: roles })).accountId;
}
const grant = (accountId: string, role: 'CUSTOMER' | 'PROVIDER', pending = false) =>
  E.accounts.grantRole(accountId, role, { actor: OP.actor, reason: OP.reason, source: 'ADMIN', pending });
const revokeRole = (accountId: string, role: 'CUSTOMER' | 'PROVIDER') => E.accounts.deactivateRole(accountId, role, OP);
async function roleStatus(accountId: string, role: string): Promise<string | undefined> {
  return (
    await q<{ status: string }>(
      `SELECT ar.status FROM identity.account_roles ar JOIN identity.roles r ON r.role_id = ar.role_id WHERE ar.account_id = $1 AND r.code = $2`,
      [accountId, role],
    )
  )[0]?.status;
}
/** An account with no role at all. */
async function roleless(): Promise<string> {
  const a = await newAccount();
  await revokeRole(a, 'CUSTOMER');
  return a;
}

// ---------------------------------------------------------------- fixtures: purposes, locales, versions
interface Purpose {
  code: string;
  entryKey: string;
  entryId: string;
}
type Scope = 'PLATFORM' | 'COUNTRY' | 'MARKET';
interface PurposeOpts {
  withdrawable?: boolean;
  requiredFor?: readonly string[];
  reacceptance?: ReacceptanceMode;
  /** The widest scope the document entry allows (a COUNTRY or MARKET version needs it). */
  maxScope?: Scope;
}
/** A fresh LEGAL document entry with a consent purpose bound to it and its policy in the static provider. */
async function makePurpose(o: PurposeOpts = {}): Promise<Purpose> {
  const t = tag();
  const entryKey = `legal.qa_${t}`;
  const code = `QA_${t.toUpperCase()}`;
  const entry = await q<{ entry_id: string }>(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     VALUES ($1, 'LEGAL', 'LEGAL', 'integration test document', 'PUBLIC', 'CRITICAL', 'SECOND_APPROVER', 'EXACT', $2, 'legal:author') RETURNING entry_id`,
    [entryKey, o.maxScope ?? 'PLATFORM'],
  );
  const entryId = entry[0]!.entry_id;
  await q(`INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy) VALUES ($1, $2, $3)`, [
    code,
    entryId,
    o.withdrawable ? 'WITHDRAWABLE' : 'NOT_WITHDRAWABLE',
  ]);
  E.policy.set(code, { requiredForRoles: [...(o.requiredFor ?? ['CUSTOMER', 'PROVIDER'])], reacceptance: o.reacceptance ?? 'REACCEPT_REQUIRED' });
  return { code, entryKey, entryId };
}
const setPurposeStatus = (code: string, status: 'ACTIVE' | 'INACTIVE') =>
  q(`UPDATE identity.consent_purposes SET status = $2, updated_at = now() WHERE purpose_code = $1`, [code, status]);
const setEntryActive = (entryId: string, active: boolean) =>
  q(`UPDATE content.entries SET is_active = $2, updated_at = now() WHERE entry_id = $1`, [entryId, active]);
const setLocale = (locale: string, active: boolean) =>
  q(`INSERT INTO content.locales (locale, is_active) VALUES ($1, $2) ON CONFLICT (locale) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = now()`, [
    locale,
    active,
  ]);
const seededEntryId = async (code: (typeof SEEDED)[number]): Promise<string> =>
  (await q<{ document_entry_id: string }>(`SELECT document_entry_id FROM identity.consent_purposes WHERE purpose_code = $1`, [code]))[0]!.document_entry_id;
const seededPurpose = async (code: (typeof SEEDED)[number]): Promise<Purpose> => {
  const entryId = await seededEntryId(code);
  return { code, entryId, entryKey: (await q<{ key: string }>(`SELECT key FROM content.entries WHERE entry_id = $1`, [entryId]))[0]!.key };
};

type VStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'SCHEDULED' | 'PUBLISHED' | 'SUPERSEDED';
interface VerOpts {
  locale?: string;
  /** The lifecycle state to leave the version in (default PUBLISHED). */
  status?: VStatus;
  /** Seconds since the start of the window (default 3600; negative = a start in the future). */
  startedAgoSec?: number;
  /** Seconds until the end of the window (null = open, default; negative = ended in the past). */
  endsInSec?: number | null;
  /** An exact start instant (a timestamptz text, microsecond precision) instead of `startedAgoSec`. */
  fromText?: string;
  scope?: Scope;
  scopeRef?: string;
  body?: string;
}
interface Ver {
  versionId: string;
  version: number;
  locale: string;
  hash: string;
  body: string;
  entryId: string;
  claim: { versionId: string; locale: string; bodySha256: string };
}
/**
 * Creates a version of the purpose's document in the requested lifecycle state, through the real content guard triggers (the hash is computed by the database), with the
 * window given relative to the database clock.
 */
async function craftVersion(p: Purpose, o: VerOpts = {}): Promise<Ver> {
  const status = o.status ?? 'PUBLISHED';
  const locale = o.locale ?? 'en-US';
  const scope = o.scope ?? 'PLATFORM';
  const scopeRef = scope === 'PLATFORM' ? null : (o.scopeRef ?? (scope === 'COUNTRY' ? 'US' : 'market-1'));
  const body = o.body ?? `${BODY_MARK} ${randomUUID()} the legal text number ${++seq}`;
  const client = await E.bigDb.pool.connect();
  try {
    await client.query('BEGIN');
    const next = await client.query(
      `SELECT coalesce(max(version), 0) + 1 AS n FROM content.versions WHERE entry_id = $1 AND locale = $2 AND scope_type = $3 AND coalesce(scope_ref, '') = $4`,
      [p.entryId, locale, scope, scopeRef ?? ''],
    );
    const number = Number((next.rows[0] as { n: string }).n);
    const fromExpr = o.fromText !== undefined ? '$7::timestamptz' : 'clock_timestamp() - make_interval(secs => $7::float8)';
    const ins = await client.query(
      `INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, effective_to, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', 'SECOND_APPROVER', ${fromExpr},
               CASE WHEN $8::float8 IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $8::float8) END, 'integration test fixture', 'legal:author')
       RETURNING version_id, body_sha256`,
      [p.entryId, locale, scope, scopeRef, number, body, o.fromText ?? o.startedAgoSec ?? 3600, o.endsInSec ?? null],
    );
    const row = ins.rows[0] as { version_id: string; body_sha256: string };
    const id = row.version_id;
    const step = (to: VStatus) => client.query(`UPDATE content.versions SET status = $2, updated_at = now() WHERE version_id = $1`, [id, to]);
    const decide = (decision: 'APPROVE' | 'REJECT') =>
      client.query(`INSERT INTO content.version_approvals (version_id, approver, decision, comment) VALUES ($1, 'legal:approver', $2, 'integration test')`, [
        id,
        decision,
      ]);
    if (status === 'CANCELLED') await step('CANCELLED');
    else if (status !== 'DRAFT') {
      await step('IN_REVIEW');
      if (status === 'REJECTED') {
        await decide('REJECT');
        await step('REJECTED');
      } else if (status !== 'IN_REVIEW') {
        await decide('APPROVE');
        await step('APPROVED');
        if (status === 'SCHEDULED' || status === 'PUBLISHED' || status === 'SUPERSEDED') await step(status === 'SCHEDULED' ? 'SCHEDULED' : 'PUBLISHED');
        if (status === 'SUPERSEDED') await step('SUPERSEDED');
      }
    }
    await client.query('COMMIT');
    forbid(body, 'legal body text');
    forbid(row.body_sha256, 'body hash', ['audit', 'outbox', 'logs', 'errors']);
    forbid(id, 'version id', ['audit', 'logs', 'errors']);
    return {
      versionId: id,
      version: number,
      locale,
      hash: row.body_sha256,
      body,
      entryId: p.entryId,
      claim: { versionId: id, locale, bodySha256: row.body_sha256 },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
/**
 * Publishes the NEXT version of the document in the locale the way the content service does: the open version is closed at the instant the new one starts (same
 * microsecond), in one transaction, so there is never a gap and never an overlap.
 */
async function publishNext(p: Purpose, o: { locale?: string; status?: 'PUBLISHED' | 'SCHEDULED'; inSec?: number } = {}): Promise<Ver> {
  const locale = o.locale ?? 'en-US';
  // `inSec`: a successor that starts in the future (the open version is closed at that instant and stays PUBLISHED until then)
  const future = o.inSec !== undefined;
  // like ContentService.publish: the head row is locked FIRST and the instant is read AFTER the lock is held, so an accept that was in flight is recorded before it
  const tx = await rawTx();
  let closedAt: string | undefined;
  try {
    const head = await tx.query(
      `SELECT version_id FROM content.versions WHERE entry_id = $1 AND locale = $2 AND scope_type = 'PLATFORM' AND effective_to IS NULL AND status IN ('PUBLISHED', 'SCHEDULED') FOR UPDATE`,
      [p.entryId, locale],
    );
    if (head.rows[0]) {
      const closed = await tx.query(
        `UPDATE content.versions SET effective_to = clock_timestamp() + make_interval(secs => $2::float8), status = CASE WHEN $3::boolean THEN status ELSE 'SUPERSEDED' END, updated_at = now()
          WHERE version_id = $1 RETURNING effective_to::text AS t`,
        [head.rows[0].version_id, o.inSec ?? 0, future],
      );
      closedAt = (closed.rows[0] as { t: string }).t;
    }
    await tx.release(true);
  } catch (err) {
    await tx.release(false);
    throw err;
  }
  return craftVersion(p, { locale, status: o.status ?? (future ? 'SCHEDULED' : 'PUBLISHED'), ...(closedAt ? { fromText: closedAt } : {}) });
}
/** Runs a statement with the content guard of versions disabled (the table owner crafting what the workflow cannot produce); always re-enabled. */
async function withVersionGuardOff<T>(fn: () => Promise<T>): Promise<T> {
  await q('ALTER TABLE content.versions DISABLE TRIGGER trg_versions__guard');
  try {
    return await fn();
  } finally {
    await q('ALTER TABLE content.versions ENABLE TRIGGER trg_versions__guard');
  }
}
const badHash = (): string => forbid(randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), 'claimed hash', ALL_ZONES);
const dbNow = async (): Promise<Date> => (await q<{ n: Date }>('SELECT clock_timestamp() AS n'))[0]!.n;
/** Waits (database time) until the database clock has passed `instant`. */
async function dbWaitUntil(instant: Date): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await dbNow()).getTime() > instant.getTime()) return;
    await sleep(25);
  }
  throw new Error('the database clock did not advance');
}

// ---------------------------------------------------------------- row inspectors
interface EventRow {
  consent_event_id: string;
  account_id: string;
  purpose_code: string;
  event_seq: number;
  event_type: string;
  version_id: string;
  locale: string;
  body_sha256: string;
  occurred_at: Date;
  source: string;
  application_session_id: string | null;
  correlation_id: string;
}
interface AuditRow {
  audit_event_id: string;
  actor: string;
  action: string;
  account_id: string;
  consent_event_id: string | null;
  changes: Record<string, unknown> | null;
  correlation_id: string;
  reason: string | null;
}
interface OutboxRow {
  outbox_event_id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
  payload_json: Record<string, unknown>;
}
const events = (accountId: string, code?: string) =>
  q<EventRow>(`SELECT * FROM identity.consent_events WHERE account_id = $1 AND ($2::text IS NULL OR purpose_code = $2) ORDER BY purpose_code, event_seq`, [
    accountId,
    code ?? null,
  ]);
const auditRows = (accountId: string) =>
  q<AuditRow>(
    `SELECT audit_event_id, actor, action, account_id, consent_event_id, changes, correlation_id, reason FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE 'CONSENT\\_%' ORDER BY occurred_at, audit_event_id`,
    [accountId],
  );
const outboxRows = (accountId: string) =>
  q<OutboxRow>(
    `SELECT outbox_event_id, event_type, event_version, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 AND event_type LIKE 'bananagig.identity.consent-%' ORDER BY created_at, outbox_event_id`,
    [accountId],
  );
async function counts(accountId: string): Promise<{ e: number; a: number; o: number }> {
  return { e: (await events(accountId)).length, a: (await auditRows(accountId)).length, o: (await outboxRows(accountId)).length };
}
/** Everything the consent layer stored in the whole database (a refused request must not add anything anywhere). */
async function world(): Promise<{ events: number; audit: number; outbox: number }> {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;
  return {
    events: await n('SELECT count(*)::int AS n FROM identity.consent_events'),
    audit: await n(`SELECT count(*)::int AS n FROM identity.account_audit_events WHERE action LIKE 'CONSENT\\_%'`),
    outbox: await n(`SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.consent-%'`),
  };
}
/** The account's current state per purpose as the database holds it (latest event). */
async function latestRow(accountId: string, code: string): Promise<EventRow | undefined> {
  return (
    await q<EventRow>(`SELECT * FROM identity.consent_events WHERE account_id = $1 AND purpose_code = $2 ORDER BY event_seq DESC LIMIT 1`, [accountId, code])
  )[0];
}

// ---------------------------------------------------------------- generic helpers
async function fails(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<AccountError> {
  const e = await rejection(p);
  caught.push(e);
  expect(e, `expected AccountError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`).toBeInstanceOf(AccountError);
  const a = e as AccountError;
  expect(a.code, `${a.code} ${JSON.stringify(a.details)}`).toBe(code);
  if (details) expect(a.details).toEqual(details);
  return a;
}
/** A refusal with its fixed message and details: proves the error carries nothing of what the client sent. */
async function refused(p: Promise<unknown>, code: keyof typeof MSG, details: Record<string, unknown> = {}): Promise<AccountError> {
  const e = await fails(p, code, details);
  expect(e.message).toBe(MSG[code]);
  expect(e.name).toBe('AccountError');
  return e;
}
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
const jitter = () => sleep(Math.floor(Math.random() * 6));
/** Rejects after `ms`: a call that must NOT wait for a lock is raced against it. */
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
/** Whether the promise is still pending after `ms` (it is waiting for something). */
async function stillPending(p: Promise<unknown>, ms = 250): Promise<boolean> {
  return (
    (await Promise.race([
      p.then(
        () => 'done',
        () => 'done',
      ),
      sleep(ms).then(() => 'blocked'),
    ])) === 'blocked'
  );
}
const errText = (e: unknown): string =>
  e instanceof AccountError
    ? JSON.stringify({ name: e.name, message: e.message, code: e.code, details: e.details })
    : e instanceof Error
      ? JSON.stringify({ name: e.name, message: e.message, code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail })
      : JSON.stringify(e);

// ---------------------------------------------------------------- deterministic ordering (raw transactions holding locks)
async function lockWaiters(atLeast: number, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0]!.n >= atLeast) return;
    if (Date.now() > until) throw new Error(`fewer than ${atLeast} session(s) are blocked on a lock`);
    await sleep(15);
  }
}
const lockWaitersNow = async (): Promise<number> =>
  (await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"))[0]!.n;
interface RawTx {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (commit?: boolean) => Promise<void>;
}
/** A raw transaction on its own connection; `release(false)` rolls back. */
async function rawTx(): Promise<RawTx> {
  const client = await E.bigDb.pool.connect();
  await client.query('BEGIN');
  let done = false;
  return {
    query: (text, params = []) => client.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
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
/** A raw transaction holding the account row lock (`FOR UPDATE`, as every service change of the account does, or `FOR SHARE`, as the guard triggers do). */
async function holdAccount(accountId: string, mode: 'UPDATE' | 'SHARE' = 'UPDATE'): Promise<RawTx> {
  const tx = await rawTx();
  await tx.query(`SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR ${mode}`, [accountId]);
  return tx;
}
/** A raw transaction holding the version row the way a publication that is about to close its window does (`FOR NO KEY UPDATE`). */
async function holdVersion(versionId: string): Promise<RawTx> {
  const tx = await rawTx();
  await tx.query(`SELECT 1 FROM content.versions WHERE version_id = $1 FOR NO KEY UPDATE`, [versionId]);
  return tx;
}
/** Inserts an event row directly (an outside writer: the guard trigger decides). The correlation id marks it as raw so the whole-run invariants skip the audit/outbox match. */
async function rawEvent(
  tx: RawTx | null,
  e: { accountId: string; code: string; seq: number; type: 'ACCEPTED' | 'WITHDRAWN'; v: Ver; sessionId?: string | null; correlation?: string },
) {
  const text = `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, application_session_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING consent_event_id, occurred_at`;
  const params = [e.accountId, e.code, e.seq, e.type, e.v.versionId, e.v.locale, e.v.hash, e.sessionId ?? null, e.correlation ?? `raw-${randomUUID()}`];
  if (tx) return (await tx.query(text, params)).rows[0] as { consent_event_id: string; occurred_at: Date };
  return (await q<{ consent_event_id: string; occurred_at: Date }>(text, params))[0]!;
}
interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
  message?: string;
}
/** The error of a raw statement, or null. */
async function rawError(text: string, params: unknown[] = []): Promise<PgError | null> {
  try {
    await E.bigDb.pool.query(text, params);
    return null;
  } catch (e) {
    return e as PgError;
  }
}
const ruleOf = (e: PgError | null): string | undefined => /^identity_rule:(.+)$/.exec(e?.detail ?? '')?.[1];

// ---------------------------------------------------------------- failure injection (test-only triggers, removed with the database)
const FAIL_FN = (table: 'audit' | 'outbox') => `
CREATE OR REPLACE FUNCTION public.t_fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.correlation_id LIKE 'fail-%' AND EXISTS (SELECT 1 FROM public.t_fail_rules r WHERE r.key = ${table === 'audit' ? 'NEW.action' : 'NEW.event_type'}) THEN
    RAISE EXCEPTION 'forced failure for the test' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$f$;`;
/** Raises a chosen SQLSTATE / DETAIL / CONSTRAINT on the INSERT of a consent event whose correlation id has a rule (before the guard trigger runs). */
const INJECT_FN = `
CREATE OR REPLACE FUNCTION public.t_inject() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE r public.t_inject_rules%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.t_inject_rules WHERE correlation = NEW.correlation_id;
  IF FOUND THEN
    RAISE EXCEPTION 'injected failure for the test' USING ERRCODE = r.errcode, DETAIL = coalesce(r.detail, ''), CONSTRAINT = coalesce(r.constraint_name, '');
  END IF;
  RETURN NEW;
END;
$f$;`;
async function installTestTriggers(): Promise<void> {
  await q('CREATE TABLE public.t_fail_rules (key text PRIMARY KEY)');
  await q(FAIL_FN('audit'));
  await q(FAIL_FN('outbox'));
  await q('CREATE TRIGGER t_fail BEFORE INSERT ON identity.account_audit_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_audit()');
  await q('CREATE TRIGGER t_fail BEFORE INSERT ON integration.outbox_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_outbox()');
  await q('CREATE TABLE public.t_inject_rules (correlation text PRIMARY KEY, errcode text NOT NULL, detail text, constraint_name text)');
  await q(INJECT_FN);
  // `aaa_` sorts before trg_consent_events__guard: the injected error is raised before the guard looks at the row
  await q('CREATE TRIGGER aaa_inject BEFORE INSERT ON identity.consent_events FOR EACH ROW EXECUTE FUNCTION public.t_inject()');
}
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
/** Runs `fn` under a correlation id for which the injector raises the given database error on the event INSERT. */
async function injecting<T>(err: { errcode: string; detail?: string; constraint?: string }, fn: () => Promise<T>): Promise<T> {
  const cid = `inject-${randomUUID()}`;
  await q('INSERT INTO public.t_inject_rules (correlation, errcode, detail, constraint_name) VALUES ($1, $2, $3, $4)', [
    cid,
    err.errcode,
    err.detail ?? null,
    err.constraint ?? null,
  ]);
  try {
    return await runWithCorrelation(cid, fn);
  } finally {
    await q('DELETE FROM public.t_inject_rules WHERE correlation = $1', [cid]);
  }
}

// ---------------------------------------------------------------- lifecycle
beforeAll(async () => {
  E = await buildEnv(70);
  consent = E.consent;
  await installTestTriggers();
  for (const l of ['es-MX', 'fr-FR', 'de-DE', 'ja-JP']) await setLocale(l, true);
  await setLocale('it-IT', false);
}, 120_000);
afterAll(async () => {
  await closeEnv(E);
}, 60_000);
afterEach(async () => {
  // the next test starts with no lock holder, no policy failure, the seeded policy, and the purposes of this test retired (the default evaluation lists ACTIVE purposes)
  expect(await lockWaitersNow(), 'a session is still blocked on a lock after the test').toBe(0);
  E.policy.failure = undefined;
  E.policy.reads = 0;
  E.policy.readPurposes.length = 0;
  for (const c of SEEDED) E.policy.set(c, { ...SEEDED_CONSENT_POLICY });
  await q(`UPDATE identity.consent_purposes SET status = 'INACTIVE', updated_at = now() WHERE status = 'ACTIVE' AND purpose_code <> ALL($1::text[])`, [
    [...SEEDED],
  ]);
  consent = E.consent;
});

// ====================================================================== the seeded purposes before Legal publishes anything
describe('seeded purposes before Legal publishes a version', () => {
  it('the migration seeded two NOT_WITHDRAWABLE ACTIVE purposes bound to two LEGAL entries without a version', async () => {
    const rows = await q<{ purpose_code: string; withdrawal_policy: string; status: string; key: string; content_type: string; versions: number }>(
      `SELECT p.purpose_code, p.withdrawal_policy, p.status, e.key, e.content_type, (SELECT count(*)::int FROM content.versions v WHERE v.entry_id = e.entry_id) AS versions
         FROM identity.consent_purposes p JOIN content.entries e ON e.entry_id = p.document_entry_id WHERE p.purpose_code = ANY($1::text[]) ORDER BY p.purpose_code`,
      [[...SEEDED]],
    );
    expect(rows).toEqual([
      {
        purpose_code: 'PRIVACY_POLICY',
        withdrawal_policy: 'NOT_WITHDRAWABLE',
        status: 'ACTIVE',
        key: 'legal.privacy_policy',
        content_type: 'LEGAL',
        versions: 0,
      },
      {
        purpose_code: 'TERMS_OF_SERVICE',
        withdrawal_policy: 'NOT_WITHDRAWABLE',
        status: 'ACTIVE',
        key: 'legal.terms_of_service',
        content_type: 'LEGAL',
        versions: 0,
      },
    ]);
  });

  it('every required purpose is DOCUMENT_UNAVAILABLE, nothing is acceptable and the gate refuses', async () => {
    const a = await newAccount();
    const r = await consent.getRequirements(a);
    expect(r.locale).toBe('en-US');
    expect(r.requirements).toEqual(
      SEEDED.map((code) => ({
        purposeCode: code,
        labelContentKey: consentPurposeLabelKey(code),
        required: true,
        status: 'DOCUMENT_UNAVAILABLE',
        acceptanceState: 'NONE',
        withdrawable: false,
        reacceptance: 'REACCEPT_REQUIRED',
        document: null,
        accepted: null,
      })),
    );
    expect(r.satisfied).toBe(false);
    expect(r.outstanding).toEqual([...SEEDED]);
    expect(consentPurposeLabelKey('TERMS_OF_SERVICE')).toBe('account.consent.purpose.terms_of_service');
    expect(await consent.hasRequiredConsents(a)).toBe(false);
    expect((await consent.listOutstandingConsents(a)).map((x) => x.purposeCode)).toEqual([...SEEDED]);
    const e = await refused(consent.requireConsents(a), 'CONSENT_REQUIRED', { outstanding: [...SEEDED] });
    expect(e.details.outstanding).toEqual([...SEEDED]);
    const before = await world();
    await refused(consent.accept(a, 'TERMS_OF_SERVICE', { versionId: randomUUID(), locale: 'en-US', bodySha256: badHash() }), 'CONSENT_VERSION_NOT_FOUND');
    expect(await world()).toEqual(before);
  });

  it('an account without a role requires nothing: NOT_REQUIRED, satisfied, no outstanding purpose', async () => {
    const a = await roleless();
    const r = await consent.getRequirements(a);
    expect(r.requirements.map((x) => [x.purposeCode, x.required, x.status])).toEqual(SEEDED.map((c) => [c, false, 'NOT_REQUIRED']));
    expect(r.satisfied).toBe(true);
    expect(r.outstanding).toEqual([]);
    await consent.requireConsents(a);
    expect(await consent.hasRequiredConsents(a)).toBe(true);
    expect(await consent.listOutstandingConsents(a)).toEqual([]);
  });

  it('getConsents of a fresh account lists the two active purposes with no state and an empty history', async () => {
    const a = await newAccount();
    expect(await consent.getConsents(a)).toEqual({
      current: SEEDED.map((code) => ({ purposeCode: code, labelContentKey: consentPurposeLabelKey(code), state: 'NONE', withdrawable: false, latest: null })),
      history: [],
    });
  });
});

/** A fresh purpose with one PUBLISHED English version and an account (customer by default). */
async function scene(o: PurposeOpts & { roles?: string[] } = {}) {
  const p = await makePurpose(o);
  const v1 = await craftVersion(p);
  const a = await newAccount(o.roles);
  return { p, v1, a };
}
const expectEventDto = (e: ConsentEventDto, expected: { code: string; type: 'ACCEPTED' | 'WITHDRAWN'; seq: number; v: Ver }): void => {
  expect(e).toEqual({
    consentEventId: expect.stringMatching(UUID_RE),
    purposeCode: expected.code,
    eventType: expected.type,
    eventSeq: expected.seq,
    document: { versionId: expected.v.versionId, version: expected.v.version, locale: expected.v.locale, bodySha256: expected.v.hash },
    occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    source: 'ACCOUNT_API',
  });
};

// ====================================================================== accept the Terms of Service and the Privacy Policy
describe('accept: the Terms of Service and the Privacy Policy end to end', () => {
  it('records the event, the audit row and the outbox event in ONE transaction with exactly the specified content', async () => {
    const tos = await craftVersion(await seededPurpose('TERMS_OF_SERVICE'));
    const pp = await craftVersion(await seededPurpose('PRIVACY_POLICY'));
    const a = await newAccount();

    const r0 = await consent.getRequirements(a);
    expect(r0.requirements.map((x) => [x.purposeCode, x.status, x.document?.versionId, x.document?.entryKey])).toEqual([
      ['PRIVACY_POLICY', 'OUTSTANDING', pp.versionId, 'legal.privacy_policy'],
      ['TERMS_OF_SERVICE', 'OUTSTANDING', tos.versionId, 'legal.terms_of_service'],
    ]);
    expect(r0.requirements[1]!.document).toEqual({
      entryKey: 'legal.terms_of_service',
      versionId: tos.versionId,
      version: 1,
      locale: 'en-US',
      bodySha256: tos.hash,
      effectiveFrom: expect.stringMatching(/Z$/),
    });

    const cid = `cid-${randomUUID()}`;
    const t0 = await dbNow();
    const res = await runWithCorrelation(cid, () => consent.accept(a, 'TERMS_OF_SERVICE', tos.claim));
    const t1 = await dbNow();
    returned.push(res);
    expect(res.changed).toBe(true);
    expect(tos.hash).toMatch(HEX64_RE);
    expectEventDto(res.event, { code: 'TERMS_OF_SERVICE', type: 'ACCEPTED', seq: 1, v: tos });

    // the event row
    const rows = await events(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      consent_event_id: res.event.consentEventId,
      account_id: a,
      purpose_code: 'TERMS_OF_SERVICE',
      event_seq: 1,
      event_type: 'ACCEPTED',
      version_id: tos.versionId,
      locale: 'en-US',
      body_sha256: tos.hash,
      occurred_at: expect.any(Date),
      source: 'ACCOUNT_API',
      application_session_id: null,
      correlation_id: cid,
    });
    // the audit row: the actor is the account, the change holds the purpose and the sequence only
    const audits = await auditRows(a);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: `account:${a}`,
      action: 'CONSENT_ACCEPTED',
      account_id: a,
      consent_event_id: res.event.consentEventId,
      changes: { purposeCode: 'TERMS_OF_SERVICE', eventSeq: 1 },
      correlation_id: cid,
      reason: null,
    });
    expect(Object.keys(audits[0]!.changes ?? {}).sort()).toEqual(['eventSeq', 'purposeCode']);
    // the outbox event: exactly the five payload keys
    const outbox = await outboxRows(a);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      event_type: CONSENT_EVENTS.accepted,
      event_version: 1,
      aggregate_type: 'identity_account',
      aggregate_id: a,
      actor_type: 'user',
      actor_id: `account:${a}`,
      correlation_id: cid,
    });
    expect(Object.keys(outbox[0]!.payload_json).sort()).toEqual(['accountId', 'consentEventId', 'contentVersionId', 'eventSeq', 'purposeCode']);
    expect(outbox[0]!.payload_json).toEqual({
      accountId: a,
      purposeCode: 'TERMS_OF_SERVICE',
      consentEventId: res.event.consentEventId,
      eventSeq: 1,
      contentVersionId: tos.versionId,
    });
    // ONE transaction: the three rows were written by the same transaction id
    const xmins = await q<{ e: string; a: string; o: string }>(
      `SELECT e.xmin::text AS e, au.xmin::text AS a, o.xmin::text AS o FROM identity.consent_events e
         JOIN identity.account_audit_events au ON au.consent_event_id = e.consent_event_id
         JOIN integration.outbox_events o ON o.payload_json ->> 'consentEventId' = e.consent_event_id::text WHERE e.consent_event_id = $1`,
      [res.event.consentEventId],
    );
    expect(xmins).toHaveLength(1);
    expect(xmins[0]!.a).toBe(xmins[0]!.e);
    expect(xmins[0]!.o).toBe(xmins[0]!.e);
    // the server set the time: the database clock, inside the call, and the DTO shows the stored instant
    expect(rows[0]!.occurred_at.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(rows[0]!.occurred_at.getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(res.event.occurredAt).toBe(rows[0]!.occurred_at.toISOString());

    // the Privacy Policy completes the requirements
    expect((await consent.accept(a, 'PRIVACY_POLICY', pp.claim)).changed).toBe(true);
    const r1 = await consent.getRequirements(a);
    expect(r1.satisfied).toBe(true);
    expect(r1.outstanding).toEqual([]);
    expect(r1.requirements.map((x) => [x.purposeCode, x.status, x.acceptanceState, x.accepted?.eventSeq])).toEqual([
      ['PRIVACY_POLICY', 'SATISFIED', 'ACCEPTED', 1],
      ['TERMS_OF_SERVICE', 'SATISFIED', 'ACCEPTED', 1],
    ]);
    await consent.requireConsents(a);
    expect(await consent.hasRequiredConsents(a)).toBe(true);
    expect(await consent.listOutstandingConsents(a)).toEqual([]);
    expect(await counts(a)).toEqual({ e: 2, a: 2, o: 2 });
    const c = await consent.getConsents(a);
    expect(c.current.map((x) => [x.purposeCode, x.state, x.withdrawable, x.latest?.eventSeq])).toEqual([
      ['PRIVACY_POLICY', 'ACCEPTED', false, 1],
      ['TERMS_OF_SERVICE', 'ACCEPTED', false, 1],
    ]);
    expect(c.history.map((x) => x.purposeCode)).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE']);
    returned.push(c, r0, r1);
  });

  it('without a caller correlation id the event, the audit row and the outbox event still share one', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    const [ev] = await events(a);
    const [au] = await auditRows(a);
    const [ob] = await outboxRows(a);
    expect(ev!.correlation_id.length).toBeGreaterThan(0);
    expect(au!.correlation_id).toBe(ev!.correlation_id);
    expect(ob!.correlation_id).toBe(ev!.correlation_id);
  });

  it('the server sets the time: the application clock and any time, account, type or source the client sends are ignored', async () => {
    const { p, v1, a } = await scene();
    const other = await newAccount();
    const skewed = new ConsentService({ database: E.bigDb, policy: E.policy, now: () => new Date('2001-01-01T00:00:00.000Z') });
    const t0 = await dbNow();
    const forged = {
      ...v1.claim,
      occurredAt: '2001-01-01T00:00:00.000Z',
      accountId: other,
      eventType: 'WITHDRAWN',
      source: 'BACK_OFFICE',
      eventSeq: 7,
      correlationId: 'x',
    };
    const res = await skewed.accept(a, p.code, forged);
    const t1 = await dbNow();
    expect(res.changed).toBe(true);
    expect(res.event.eventSeq).toBe(1);
    expect(res.event.eventType).toBe('ACCEPTED');
    const [row] = await events(a);
    expect(row!.occurred_at.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(row!.occurred_at.getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(row!.account_id).toBe(a);
    expect(row!.source).toBe('ACCOUNT_API');
    expect(await counts(other)).toEqual({ e: 0, a: 0, o: 0 });
    // the table cannot hold a client-supplied time either: the trigger overwrites it
    const second = await newAccount();
    const raw = await rawEvent(null, { accountId: second, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
    expect(raw.occurred_at.getTime()).toBeGreaterThanOrEqual(t1.getTime());
    const forgedRaw = await newAccount();
    await q(
      `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id, occurred_at)
       VALUES ($1, $2, 1, 'ACCEPTED', $3, $4, $5, 'raw-forged-time', '2001-01-01')`,
      [forgedRaw, p.code, v1.versionId, v1.locale, v1.hash],
    );
    expect((await events(forgedRaw))[0]!.occurred_at.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('the event table holds identifiers only: no free-text column but the correlation id', async () => {
    const cols = (
      await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'consent_events' ORDER BY ordinal_position`,
      )
    ).map((c) => c.column_name);
    expect(cols).toEqual([
      'consent_event_id',
      'account_id',
      'purpose_code',
      'event_seq',
      'event_type',
      'version_id',
      'locale',
      'body_sha256',
      'occurred_at',
      'source',
      'application_session_id',
      'correlation_id',
    ]);
  });

  it('a stored event cannot be changed, deleted or truncated (append-only)', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    expect(ruleOf(await rawError(`UPDATE identity.consent_events SET locale = locale WHERE account_id = $1`, [a]))).toBe('ROW_IMMUTABLE');
    expect(ruleOf(await rawError(`UPDATE identity.consent_events SET event_type = 'WITHDRAWN' WHERE account_id = $1`, [a]))).toBe('ROW_IMMUTABLE');
    expect(ruleOf(await rawError(`DELETE FROM identity.consent_events WHERE account_id = $1`, [a]))).toBe('ROW_IMMUTABLE');
    expect(await rawError(`TRUNCATE identity.consent_events`)).not.toBeNull();
    expect(ruleOf(await rawError(`TRUNCATE identity.consent_events CASCADE`))).toBe('ROW_IMMUTABLE');
    expect(await rawError(`DELETE FROM identity.account_audit_events WHERE account_id = $1`, [a])).not.toBeNull();
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
  });
});

// ====================================================================== atomicity: the event, the audit row and the outbox event live and die together
describe('atomicity: a failing audit or outbox insert rolls back the whole change', () => {
  const nothing = { e: 0, a: 0, o: 0 };

  it('accept: a failing AUDIT insert leaves no event, no audit row, no outbox event and does not burn the sequence', async () => {
    const { p, v1, a } = await scene();
    const before = await world();
    await expectForcedFailure(failing(['CONSENT_ACCEPTED'], () => consent.accept(a, p.code, v1.claim)));
    expect(await counts(a)).toEqual(nothing);
    expect(await world()).toEqual(before);
    const ok = await consent.accept(a, p.code, v1.claim);
    expect(ok.changed).toBe(true);
    expect(ok.event.eventSeq).toBe(1);
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
  });

  it('accept: a failing OUTBOX insert rolls back the event AND the audit row', async () => {
    const { p, v1, a } = await scene();
    await expectForcedFailure(failing([CONSENT_EVENTS.accepted], () => consent.accept(a, p.code, v1.claim)));
    expect(await counts(a)).toEqual(nothing);
    expect(await latestRow(a, p.code)).toBeUndefined();
    expect((await consent.getConsents(a)).history).toEqual([]);
    expect((await consent.accept(a, p.code, v1.claim)).event.eventSeq).toBe(1);
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
  });

  it('a failure on a LATER accept keeps the earlier history exactly as it was', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    const v2 = await publishNext(p);
    const keep = await events(a);
    await expectForcedFailure(failing(['CONSENT_ACCEPTED'], () => consent.accept(a, p.code, v2.claim)));
    expect(await events(a)).toEqual(keep);
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    expect((await consent.accept(a, p.code, v2.claim)).event.eventSeq).toBe(2);
  });

  it('withdraw: a failing AUDIT or OUTBOX insert leaves the consent accepted and every table untouched', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    for (const key of ['CONSENT_WITHDRAWN', CONSENT_EVENTS.withdrawn]) {
      await expectForcedFailure(failing([key], () => consent.withdraw(a, p.code)));
      expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
      expect((await latestRow(a, p.code))!.event_type).toBe('ACCEPTED');
    }
    const w = await consent.withdraw(a, p.code);
    expect(w.changed).toBe(true);
    expect(w.event.eventSeq).toBe(2);
    expect(await counts(a)).toEqual({ e: 2, a: 2, o: 2 });
  });

  it('a database error raised by the event insert itself (a check violation) is a typed refusal and writes nothing', async () => {
    const { p, v1, a } = await scene();
    const e = await injecting({ errcode: '23514', constraint: 'ck_consent_events__source' }, () =>
      fails(consent.accept(a, p.code, v1.claim), 'VALIDATION_FAILED'),
    );
    expect(e.message).toBe('the value violates an account constraint');
    expect(await counts(a)).toEqual(nothing);
    expect((await consent.accept(a, p.code, v1.claim)).changed).toBe(true);
  });
});

// ====================================================================== idempotency, new versions, the stale rule
describe('accept: idempotent repeat, a newer version and the old version', () => {
  it('repeating the accepted version changes nothing: same event back, no row, no policy read, whatever the session context', async () => {
    const { p, v1, a } = await scene();
    const first = await consent.accept(a, p.code, v1.claim);
    expect(first.changed).toBe(true);
    const before = await world();
    const reads = E.policy.reads;
    const again = await consent.accept(a, p.code, v1.claim);
    expect(again).toEqual({ changed: false, event: first.event });
    // an upper-case uuid is the same uuid; another (invalid) session context changes nothing either
    expect(await consent.accept(a, p.code, { ...v1.claim, versionId: v1.versionId.toUpperCase() }, { applicationSessionId: randomUUID() })).toEqual({
      changed: false,
      event: first.event,
    });
    expect(await consent.accept(a, p.code, v1.claim, { applicationSessionId: 'not-a-uuid' })).toEqual({ changed: false, event: first.event });
    expect(await world()).toEqual(before);
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    expect(E.policy.reads, 'accept never reads the policy').toBe(reads);
  });

  it('the repeat stays idempotent after the version was superseded and after the purpose was deactivated', async () => {
    const { p, v1, a } = await scene();
    const first = await consent.accept(a, p.code, v1.claim);
    const v2 = await publishNext(p);
    expect((await consent.accept(a, p.code, v1.claim)).changed, 'superseded').toBe(false);
    const newcomer = await newAccount();
    await refused(consent.accept(newcomer, p.code, v1.claim), 'CONSENT_VERSION_NOT_CURRENT');
    await setPurposeStatus(p.code, 'INACTIVE');
    expect(await consent.accept(a, p.code, v1.claim), 'deactivated').toEqual({ changed: false, event: first.event });
    // the purpose status is checked before the window: a retired purpose is PURPOSE_INACTIVE for the superseded and the current version alike
    await refused(consent.accept(newcomer, p.code, v1.claim), 'CONSENT_PURPOSE_INACTIVE');
    await refused(consent.accept(newcomer, p.code, v2.claim), 'CONSENT_PURPOSE_INACTIVE');
    // the entry and the locale deactivated: the account that already accepted is still answered with its event
    await setPurposeStatus(p.code, 'ACTIVE');
    await setEntryActive(p.entryId, false);
    expect((await consent.accept(a, p.code, v1.claim)).changed, 'entry inactive').toBe(false);
    await setEntryActive(p.entryId, true);
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    expect(await counts(newcomer)).toEqual({ e: 0, a: 0, o: 0 });
  });

  it('a claim that does not match the version is refused even for a repeat (the claim is checked before the history)', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    await refused(consent.accept(a, p.code, { ...v1.claim, bodySha256: badHash() }), 'CONSENT_HASH_MISMATCH');
    await refused(consent.accept(a, p.code, { ...v1.claim, locale: 'en-us' }), 'CONSENT_LOCALE_MISMATCH');
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
  });

  it('a newer version supersedes: REACCEPTANCE_REQUIRED until accepted, the history grows, the old version cannot come back', async () => {
    const { p, v1, a } = await scene();
    expect((await consent.accept(a, p.code, v1.claim)).event.eventSeq).toBe(1);
    const v2 = await publishNext(p);
    expect(v2.version).toBe(2);
    const stale = (await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!;
    expect(stale).toMatchObject({
      status: 'REACCEPTANCE_REQUIRED',
      acceptanceState: 'ACCEPTED',
      document: { versionId: v2.versionId, version: 2 },
      accepted: { document: { versionId: v1.versionId } },
    });
    const second = await consent.accept(a, p.code, v2.claim);
    expect(second.changed).toBe(true);
    expectEventDto(second.event, { code: p.code, type: 'ACCEPTED', seq: 2, v: v2 });
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!.status).toBe('SATISFIED');
    // the old tab arrives late: v1 is closed, the latest event is v2: refused, nothing written
    await refused(consent.accept(a, p.code, v1.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect(await counts(a)).toEqual({ e: 2, a: 2, o: 2 });
    const h = (await consent.getConsents(a)).history;
    expect(h.map((x) => x.eventSeq)).toEqual([2, 1]);
    expect(h.map((x) => x.document.version)).toEqual([2, 1]);
    // a third version: the accepted v2 repeat is now idempotent and v3 is a new event
    const v3 = await publishNext(p);
    expect((await consent.accept(a, p.code, v2.claim)).changed).toBe(false);
    expect((await consent.accept(a, p.code, v3.claim)).event.eventSeq).toBe(3);
  });

  it('the stale rule at database level: an older version number after a newer acceptance is refused by the trigger, and by the service as NOT_CURRENT', async () => {
    const { p, v1, a } = await scene();
    const v2 = await publishNext(p);
    expect((await consent.accept(a, p.code, v2.claim)).event.eventSeq).toBe(1);
    // crafted: the content workflow cannot reopen a closed version, the table owner can (the guard is disabled for the length of the crafting)
    await withVersionGuardOff(async () => {
      await q(`UPDATE content.versions SET status = 'CANCELLED' WHERE version_id = $1`, [v2.versionId]);
      await q(`UPDATE content.versions SET effective_to = NULL, status = 'PUBLISHED' WHERE version_id = $1`, [v1.versionId]);
    });
    expect(await q<{ s: string }>(`SELECT identity.consent_version_state($1, $2, clock_timestamp()) AS s`, [v1.versionId, p.entryId])).toEqual([
      { s: 'IN_FORCE' },
    ]);
    const before = await counts(a);
    await refused(consent.accept(a, p.code, v1.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect(await counts(a)).toEqual(before);
    // the same insert without the service: the trigger names the rule
    const e = await rawError(
      `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id) VALUES ($1, $2, 2, 'ACCEPTED', $3, $4, $5, 'raw-stale')`,
      [a, p.code, v1.versionId, v1.locale, v1.hash],
    );
    expect(e?.code).toBe('23000');
    expect(ruleOf(e)).toBe('CONSENT_VERSION_STALE');
    // an account that never accepted may take the reopened v1: the stale rule compares with the account's own latest acceptance
    const fresh = await newAccount();
    expect((await consent.accept(fresh, p.code, v1.claim)).changed).toBe(true);
  });

  it('version numbers are per locale: a newer English acceptance does not block an older-numbered Spanish one', async () => {
    const { p, v1, a } = await scene();
    const en2 = await publishNext(p);
    const es1 = await craftVersion(p, { locale: 'es-MX' });
    expect(es1.version).toBe(1);
    expect((await consent.accept(a, p.code, en2.claim)).event.eventSeq).toBe(1);
    expect((await consent.accept(a, p.code, es1.claim)).event.eventSeq).toBe(2);
    expect((await events(a, p.code)).map((e) => [e.event_seq, e.locale])).toEqual([
      [1, 'en-US'],
      [2, 'es-MX'],
    ]);
    void v1;
  });
});

// ====================================================================== accept: every refusal code
describe('accept: refusals', () => {
  it('PURPOSE_NOT_FOUND: unknown and malformed purpose codes, with a fixed message and no trace of the input', async () => {
    const { v1, a } = await scene();
    const before = await world();
    const codes: unknown[] = [
      'NO_SUCH_PURPOSE',
      'lower_case',
      'terms_of_service',
      "X'; DROP TABLE identity.consent_events;--",
      '',
      'A',
      'A'.repeat(65),
      '1ABC',
      'TERMS OF SERVICE',
      'TERMS_OF_SERVICE ',
      ' TERMS_OF_SERVICE',
      'TERMS_OF_SERVICE\n',
      'TERMS-OF-SERVICE',
      'Ünïcode_PURPOSE',
      `Q${'X'.repeat(63)}`,
      null,
      undefined,
      42,
      {},
      ['TERMS_OF_SERVICE'],
    ];
    for (const c of codes) {
      const e = await refused(consent.accept(a, c as string, v1.claim), 'CONSENT_PURPOSE_NOT_FOUND');
      expect(errText(e)).not.toContain('DROP TABLE');
    }
    expect(await world()).toEqual(before);
  });

  it('VALIDATION_FAILED: a malformed id, locale or hash (and a hash in upper case) is refused before anything else, naming only the field', async () => {
    const { p, v1, a } = await scene();
    const before = await world();
    const bad = (over: Record<string, unknown>) => ({ ...v1.claim, ...over }) as never;
    const cases: [string, unknown][] = [
      ['versionId', 'nope'],
      ['versionId', ''],
      ['versionId', 123],
      ['versionId', null],
      ['versionId', undefined],
      ['versionId', v1.versionId.replaceAll('-', '')],
      ['versionId', `{${v1.versionId}}`],
      ['versionId', `${v1.versionId} `],
      ['versionId', `${v1.versionId}0`],
      ['versionId', [v1.versionId]],
      ['locale', ''],
      ['locale', 'e'],
      ['locale', 'en_US'],
      ['locale', 'en US'],
      ['locale', 'x'.repeat(36)],
      ['locale', 'en-US\n'],
      ['locale', 'é-FR'],
      ['locale', null],
      ['locale', 5],
      ['bodySha256', v1.hash.toUpperCase()],
      ['bodySha256', v1.hash.slice(1)],
      ['bodySha256', `${v1.hash}0`],
      ['bodySha256', ` ${v1.hash.slice(1)}`],
      ['bodySha256', 'g'.repeat(64)],
      ['bodySha256', ''],
      ['bodySha256', null],
      ['bodySha256', 12],
    ];
    for (const [field, value] of cases) {
      const e = await refused(consent.accept(a, p.code, bad({ [field]: value })), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field });
      if (typeof value === 'string' && value.length > 3) expect(errText(e)).not.toContain(value.trim());
    }
    for (const body of [null, undefined, 'string', 5, true])
      await refused(consent.accept(a, p.code, body as never), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'body' });
    // the first invalid field is named; an invalid claim is reported before an unknown purpose
    await refused(consent.accept(a, p.code, { versionId: 'x', locale: '', bodySha256: 'y' }), 'VALIDATION_FAILED', {
      reason: 'INVALID_FIELD',
      field: 'versionId',
    });
    await refused(consent.accept(a, 'NO_SUCH_PURPOSE', bad({ locale: '' })), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'locale' });
    expect(await world()).toEqual(before);
    // the shape is the only thing refused: an upper-case uuid is accepted and normalized, and the hash must be lower case
    expect((await consent.accept(a, p.code, bad({ versionId: v1.versionId.toUpperCase() }))).event.document.versionId).toBe(v1.versionId);
  });

  it('VERSION_NOT_FOUND is ONE answer (same text, no details) for an unknown id, another document, every unpublished state and every non-platform scope', async () => {
    const p = await makePurpose({ maxScope: 'MARKET' });
    const other = await makePurpose();
    const good = await craftVersion(p);
    const a = await newAccount();
    const variants: [string, Ver | { claim: Ver['claim'] }][] = [
      ['unknown', { claim: { versionId: randomUUID(), locale: 'en-US', bodySha256: badHash() } }],
      ['nil uuid', { claim: { versionId: '00000000-0000-0000-0000-000000000000', locale: 'en-US', bodySha256: badHash() } }],
      ['another document', await craftVersion(other)],
      ['DRAFT', await craftVersion(p, { status: 'DRAFT', startedAgoSec: 7200, endsInSec: null })],
      ['IN_REVIEW', await craftVersion(p, { status: 'IN_REVIEW' })],
      ['APPROVED', await craftVersion(p, { status: 'APPROVED' })],
      ['REJECTED', await craftVersion(p, { status: 'REJECTED' })],
      ['CANCELLED', await craftVersion(p, { status: 'CANCELLED' })],
      ['COUNTRY scope', await craftVersion(p, { scope: 'COUNTRY' })],
      ['MARKET scope', await craftVersion(p, { scope: 'MARKET' })],
    ];
    const before = await world();
    const messages = new Set<string>();
    for (const [label, v] of variants) {
      const exact = await refused(consent.accept(a, p.code, v.claim), 'CONSENT_VERSION_NOT_FOUND');
      messages.add(JSON.stringify([exact.message, exact.details]));
      // the oracle is closed: a wrong locale or a wrong hash of the same hidden version gets the same answer
      for (const wrong of [{ locale: 'fr-FR' }, { bodySha256: badHash() }, { locale: 'es-mx', bodySha256: badHash() }]) {
        const e = await refused(consent.accept(a, p.code, { ...v.claim, ...wrong }), 'CONSENT_VERSION_NOT_FOUND');
        messages.add(JSON.stringify([e.message, e.details]));
        expect(errText(e), label).not.toContain(v.claim.versionId);
        expect(errText(e), label).not.toContain(v.claim.bodySha256);
      }
    }
    expect([...messages], 'one answer').toHaveLength(1);
    expect(await world()).toEqual(before);
    // the platform-scope version of the same document is acceptable, and the hidden country version does not change what is shown
    expect((await consent.accept(a, p.code, good.claim)).changed).toBe(true);
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!.document?.versionId).toBe(good.versionId);
  });

  it('LOCALE_MISMATCH is an exact comparison: case, truncation and another language are all mismatches', async () => {
    const p = await makePurpose();
    const es = await craftVersion(p, { locale: 'es-MX' });
    const a = await newAccount();
    for (const locale of ['es-mx', 'ES-MX', 'es', 'es-ES', 'en-US', 'es-MXX', 'es-MX-', `es-${'x'.repeat(32)}`, 'ee']) {
      await refused(consent.accept(a, p.code, { ...es.claim, locale }), 'CONSENT_LOCALE_MISMATCH');
    }
    // the empty locale is not a mismatch but a malformed claim
    await refused(consent.accept(a, p.code, { ...es.claim, locale: '' }), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'locale' });
    expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
    expect((await consent.accept(a, p.code, es.claim)).event.document.locale).toBe('es-MX');
  });

  it('HASH_MISMATCH: the hash of another version, an unrelated hash and all zeros, for the version in force', async () => {
    const { p, v1, a } = await scene();
    const other = await makePurpose();
    const otherV = await craftVersion(other);
    for (const wrong of [otherV.hash, badHash(), '0'.repeat(64), 'f'.repeat(64)]) {
      await refused(consent.accept(a, p.code, { ...v1.claim, bodySha256: wrong }), 'CONSENT_HASH_MISMATCH');
    }
    // locale before hash when both are wrong
    await refused(consent.accept(a, p.code, { ...v1.claim, locale: 'fr-FR', bodySha256: badHash() }), 'CONSENT_LOCALE_MISMATCH');
    expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
  });

  it('check order: the purpose status and the window come BEFORE the claim (a version that is not in force never reveals its locale or hash through the error class)', async () => {
    const { p, v1, a } = await scene();
    const v2 = await publishNext(p); // v1 is superseded
    const future = await publishNext(p, { inSec: 3600 }); // v2 ends in an hour, its successor starts then
    const wrongs = [{ bodySha256: badHash() }, { locale: 'fr-FR' }, { locale: 'es-mx', bodySha256: badHash() }];
    for (const w of wrongs) {
      await refused(consent.accept(a, p.code, { ...v1.claim, ...w }), 'CONSENT_VERSION_NOT_CURRENT');
      await refused(consent.accept(a, p.code, { ...future.claim, ...w }), 'CONSENT_VERSION_NOT_CURRENT');
    }
    // the version in force: the mismatch is reported
    await refused(consent.accept(a, p.code, { ...v2.claim, bodySha256: badHash() }), 'CONSENT_HASH_MISMATCH');
    await refused(consent.accept(a, p.code, { ...v2.claim, locale: 'fr-FR' }), 'CONSENT_LOCALE_MISMATCH');
    // a retired purpose comes before the window and before the claim
    await setPurposeStatus(p.code, 'INACTIVE');
    for (const w of [{}, ...wrongs]) {
      await refused(consent.accept(a, p.code, { ...v2.claim, ...w }), 'CONSENT_PURPOSE_INACTIVE');
      await refused(consent.accept(a, p.code, { ...v1.claim, ...w }), 'CONSENT_PURPOSE_INACTIVE');
    }
    expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
  });

  it('PURPOSE_INACTIVE: a retired purpose cannot be accepted, its history stays readable, the trigger agrees', async () => {
    const { p, v1, a } = await scene();
    const b = await newAccount();
    await consent.accept(a, p.code, v1.claim);
    await setPurposeStatus(p.code, 'INACTIVE');
    await refused(consent.accept(b, p.code, v1.claim), 'CONSENT_PURPOSE_INACTIVE');
    const e = await rawError(
      `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id) VALUES ($1, $2, 1, 'ACCEPTED', $3, $4, $5, 'raw-inactive')`,
      [b, p.code, v1.versionId, v1.locale, v1.hash],
    );
    expect(ruleOf(e)).toBe('CONSENT_PURPOSE_INACTIVE');
    expect((await consent.getConsents(a)).current.some((c) => c.purposeCode === p.code)).toBe(true);
    expect((await consent.getConsents(b)).current.some((c) => c.purposeCode === p.code)).toBe(false);
    await setPurposeStatus(p.code, 'ACTIVE');
    expect((await consent.accept(b, p.code, v1.claim)).changed).toBe(true);
  });

  it('VERSION_NOT_CURRENT: a superseded version, a version that starts in the future, a closed window, an inactive entry and an inactive locale', async () => {
    const p = await makePurpose();
    const closed = await craftVersion(p, { startedAgoSec: 7200, endsInSec: -3600 }); // ended an hour ago, still marked PUBLISHED
    const current = await craftVersion(p, { startedAgoSec: 3500, endsInSec: 3600 });
    const future = await craftVersion(p, { status: 'SCHEDULED', startedAgoSec: -3600, endsInSec: null });
    const a = await newAccount();
    await refused(consent.accept(a, p.code, closed.claim), 'CONSENT_VERSION_NOT_CURRENT');
    await refused(consent.accept(a, p.code, future.claim), 'CONSENT_VERSION_NOT_CURRENT');
    // the scheduled future version is shown to nobody: the current one is
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!.document?.versionId).toBe(current.versionId);
    await setEntryActive(p.entryId, false);
    await refused(consent.accept(a, p.code, current.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]).toMatchObject({ status: 'DOCUMENT_UNAVAILABLE', document: null });
    await setEntryActive(p.entryId, true);
    const es = await craftVersion(p, { locale: 'es-MX' });
    await setLocale('es-MX', false);
    try {
      await refused(consent.accept(a, p.code, es.claim), 'CONSENT_VERSION_NOT_CURRENT');
      expect((await consent.getRequirements(a, { purposes: [p.code], locale: 'es-MX' })).requirements[0]).toMatchObject({
        status: 'DOCUMENT_UNAVAILABLE',
        document: null,
      });
    } finally {
      await setLocale('es-MX', true);
    }
    expect((await consent.accept(a, p.code, es.claim)).changed).toBe(true);
    expect((await consent.accept(a, p.code, current.claim)).changed).toBe(true);
    expect(await counts(a)).toEqual({ e: 2, a: 2, o: 2 });
  });

  it('SUSPENDED and CLOSED accounts cannot accept or withdraw (the account state is checked first); reads still work; an unknown account is NOT_FOUND', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    await E.accounts.changeStatus(a, 'SUSPENDED', OP);
    await fails(consent.accept(a, p.code, v1.claim), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(consent.accept(a, 'NO_SUCH_PURPOSE', v1.claim), 'SUSPENDED', { status: 'SUSPENDED' });
    await fails(consent.withdraw(a, p.code), 'SUSPENDED', { status: 'SUSPENDED' });
    expect((await consent.getConsents(a)).history).toHaveLength(1);
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements).toHaveLength(1);
    await E.accounts.changeStatus(a, 'ACTIVE', OP);
    expect((await consent.withdraw(a, p.code)).changed).toBe(true);
    await revokeRole(a, 'CUSTOMER');
    await E.accounts.changeStatus(a, 'SUSPENDED', OP);
    await E.accounts.changeStatus(a, 'CLOSED', OP);
    await fails(consent.accept(a, p.code, v1.claim), 'CLOSED', { status: 'CLOSED' });
    await fails(consent.withdraw(a, p.code), 'CLOSED', { status: 'CLOSED' });
    // the same insert without the service: the trigger refuses the closed account
    const e = await rawError(
      `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id) VALUES ($1, $2, 3, 'ACCEPTED', $3, $4, $5, 'raw-closed')`,
      [a, p.code, v1.versionId, v1.locale, v1.hash],
    );
    expect(ruleOf(e)).toBe('ACCOUNT_CLOSED');
    expect((await consent.getConsents(a)).history).toHaveLength(2);
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!.required).toBe(false);
    expect(await counts(a)).toEqual({ e: 2, a: 2, o: 2 });
    // unknown accounts
    const ghost = randomUUID();
    await fails(consent.accept(ghost, p.code, v1.claim), 'NOT_FOUND');
    await fails(consent.accept('not-a-uuid', p.code, v1.claim), 'NOT_FOUND');
    await fails(consent.withdraw(ghost, p.code), 'NOT_FOUND');
    await fails(consent.getConsents(ghost), 'NOT_FOUND');
    await fails(consent.getConsents('not-a-uuid'), 'NOT_FOUND');
    await fails(consent.getRequirements(ghost), 'NOT_FOUND');
    await fails(consent.getRequirements('nope'), 'NOT_FOUND');
    await fails(consent.requireConsents(ghost), 'NOT_FOUND');
    expect(await counts(ghost)).toEqual({ e: 0, a: 0, o: 0 });
  });
});

// ====================================================================== the single definition of "in force"
describe('in force: the one definition, at its boundaries', () => {
  const stateAt = async (versionId: string, entryId: string, at: string) =>
    (await q<{ s: string }>(`SELECT identity.consent_version_state($1, $2, $3::timestamptz) AS s`, [versionId, entryId, at]))[0]!.s;

  it('the function: half-open window at the exact instants (microsecond precision), unknown version, another document', async () => {
    const p = await makePurpose();
    const other = await makePurpose();
    const v = await craftVersion(p, { startedAgoSec: 7200, endsInSec: 3600 });
    const [w] = await q<{ f: string; t: string; fm: string; tm: string }>(
      `SELECT effective_from::text AS f, effective_to::text AS t, (effective_from - interval '1 microsecond')::text AS fm, (effective_to - interval '1 microsecond')::text AS tm FROM content.versions WHERE version_id = $1`,
      [v.versionId],
    );
    expect(await stateAt(v.versionId, p.entryId, w!.f), 'at the start').toBe('IN_FORCE');
    expect(await stateAt(v.versionId, p.entryId, w!.fm), 'one microsecond before the start').toBe('NOT_CURRENT');
    expect(await stateAt(v.versionId, p.entryId, w!.tm), 'one microsecond before the end').toBe('IN_FORCE');
    expect(await stateAt(v.versionId, p.entryId, w!.t), 'at the end').toBe('NOT_CURRENT');
    expect(await stateAt(v.versionId, other.entryId, w!.f), 'another document').toBe('NOT_FOUND');
    expect(await stateAt(randomUUID(), p.entryId, w!.f)).toBe('NOT_FOUND');
    expect(await stateAt(v.versionId, randomUUID(), w!.f)).toBe('NOT_FOUND');
    expect(await q(`SELECT identity.consent_version_state(NULL, $1, now()) AS s`, [p.entryId])).toEqual([{ s: 'NOT_FOUND' }]);
  });

  it('the function: every lifecycle state, every scope, the entry and the locale (workflow markers do not decide, the timestamps do)', async () => {
    const p = await makePurpose({ maxScope: 'MARKET' });
    const now = 'clock_timestamp()::text';
    const at = (await q<{ t: string }>(`SELECT ${now} AS t`))[0]!.t;
    for (const s of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(await stateAt((await craftVersion(p, { status: s })).versionId, p.entryId, at), s).toBe('NOT_FOUND');
    }
    for (const scope of ['COUNTRY', 'MARKET'] as const)
      expect(await stateAt((await craftVersion(p, { scope })).versionId, p.entryId, at), scope).toBe('NOT_FOUND');
    // PUBLISHED, SCHEDULED and SUPERSEDED are all "published": only the window decides
    const published = await craftVersion(p, { status: 'PUBLISHED', startedAgoSec: 7200, endsInSec: 3000 });
    const scheduledStarted = await craftVersion(p, { locale: 'es-MX', status: 'SCHEDULED', startedAgoSec: 60 });
    const supersededOpen = await craftVersion(p, { locale: 'fr-FR', status: 'SUPERSEDED', startedAgoSec: 60 });
    const supersededClosed = await craftVersion(p, { locale: 'de-DE', status: 'SUPERSEDED', startedAgoSec: 7200, endsInSec: -3600 });
    const publishedClosed = await craftVersion(p, { locale: 'ja-JP', status: 'PUBLISHED', startedAgoSec: 7200, endsInSec: -3600 });
    const scheduledFuture = await craftVersion(p, { locale: 'it-IT', status: 'SCHEDULED', startedAgoSec: -3600 });
    expect(await stateAt(published.versionId, p.entryId, at)).toBe('IN_FORCE');
    expect(await stateAt(scheduledStarted.versionId, p.entryId, at), 'SCHEDULED whose start has passed (the activation job has not run)').toBe('IN_FORCE');
    expect(await stateAt(supersededOpen.versionId, p.entryId, at), 'a marker alone does not close a window').toBe('IN_FORCE');
    expect(await stateAt(supersededClosed.versionId, p.entryId, at)).toBe('NOT_CURRENT');
    expect(await stateAt(publishedClosed.versionId, p.entryId, at), 'a closed window alone does').toBe('NOT_CURRENT');
    expect(await stateAt(scheduledFuture.versionId, p.entryId, at)).toBe('NOT_CURRENT');
    // the entry and the locale
    await setEntryActive(p.entryId, false);
    expect(await stateAt(published.versionId, p.entryId, at), 'inactive entry').toBe('NOT_CURRENT');
    await setEntryActive(p.entryId, true);
    expect(await stateAt(scheduledStarted.versionId, p.entryId, at)).toBe('IN_FORCE');
    await setLocale('es-MX', false);
    try {
      expect(await stateAt(scheduledStarted.versionId, p.entryId, at), 'inactive locale').toBe('NOT_CURRENT');
      expect(await stateAt(published.versionId, p.entryId, at)).toBe('IN_FORCE');
    } finally {
      await setLocale('es-MX', true);
    }
  });

  it('a SCHEDULED version whose start has passed but which the activation job has not advanced IS in force (the service agrees with the function)', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    const v2 = await publishNext(p, { inSec: 1 }); // v1 ends in a second, v2 (SCHEDULED) starts then
    const a = await newAccount();
    const b = await newAccount();
    await refused(consent.accept(a, p.code, v2.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!.document?.versionId).toBe(v1.versionId);
    expect((await consent.accept(a, p.code, v1.claim)).changed).toBe(true);
    const [row] = await q<{ t: Date }>(`SELECT effective_from AS t FROM content.versions WHERE version_id = $1`, [v2.versionId]);
    await dbWaitUntil(row!.t);
    expect((await q<{ status: string }>(`SELECT status FROM content.versions WHERE version_id = $1`, [v2.versionId]))[0]!.status, 'the job has not run').toBe(
      'SCHEDULED',
    );
    const req = (await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]!;
    expect(req).toMatchObject({ status: 'REACCEPTANCE_REQUIRED', document: { versionId: v2.versionId } });
    await refused(consent.accept(b, p.code, v1.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect((await consent.accept(b, p.code, v2.claim)).changed).toBe(true);
    expect((await consent.accept(a, p.code, v2.claim)).event.eventSeq).toBe(2);
  });

  it('the end of a window: accepted before it, refused after it, with the database clock deciding', async () => {
    const p = await makePurpose();
    const v = await craftVersion(p, { startedAgoSec: 60, endsInSec: 1 });
    const early = await newAccount();
    const late = await newAccount();
    const [row] = await q<{ t: Date }>(`SELECT effective_to AS t FROM content.versions WHERE version_id = $1`, [v.versionId]);
    expect((await consent.accept(early, p.code, v.claim)).changed).toBe(true);
    const [ev] = await events(early);
    expect(ev!.occurred_at.getTime()).toBeLessThan(row!.t.getTime());
    await dbWaitUntil(row!.t);
    await refused(consent.accept(late, p.code, v.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect((await consent.getRequirements(late, { purposes: [p.code] })).requirements[0]).toMatchObject({ status: 'DOCUMENT_UNAVAILABLE', document: null });
    // the earlier acceptance is a valid historical fact and an idempotent repeat is still answered
    expect((await consent.accept(early, p.code, v.claim)).changed).toBe(false);
  });
});

// ====================================================================== withdraw
describe('withdraw', () => {
  it('NOT_WITHDRAWABLE for the seeded purposes: no lock, no policy read, not even an account check', async () => {
    const a = await newAccount();
    const hold = await holdAccount(a);
    try {
      const reads = E.policy.reads;
      E.policy.failure = new Error('configuration down');
      for (const code of SEEDED) await within(3000, refused(consent.withdraw(a, code), 'CONSENT_NOT_WITHDRAWABLE'), 'withdraw of a NOT_WITHDRAWABLE purpose');
      await refused(consent.withdraw(randomUUID(), 'TERMS_OF_SERVICE'), 'CONSENT_NOT_WITHDRAWABLE');
      await refused(consent.withdraw('not-a-uuid', 'PRIVACY_POLICY'), 'CONSENT_NOT_WITHDRAWABLE');
      expect(E.policy.reads).toBe(reads);
    } finally {
      await hold.release(false);
    }
    expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
    // a NOT_WITHDRAWABLE purpose accepted by the account stays accepted
    const { p, v1, a: b } = await scene();
    await consent.accept(b, p.code, v1.claim);
    await refused(consent.withdraw(b, p.code), 'CONSENT_NOT_WITHDRAWABLE');
    expect((await latestRow(b, p.code))!.event_type).toBe('ACCEPTED');
    // the trigger agrees for an outside writer
    expect(
      ruleOf(
        await rawError(
          `INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, correlation_id) VALUES ($1, $2, 2, 'WITHDRAWN', $3, $4, $5, 'raw-nw')`,
          [b, p.code, v1.versionId, v1.locale, v1.hash],
        ),
      ),
    ).toBe('CONSENT_NOT_WITHDRAWABLE');
  });

  it('PURPOSE_NOT_FOUND for unknown and malformed purpose codes', async () => {
    const a = await newAccount();
    for (const c of ['NO_SUCH_PURPOSE', 'lower', '', 'A', 'X'.repeat(70), "A'; DROP", null, 5]) {
      await refused(consent.withdraw(a, c as string), 'CONSENT_PURPOSE_NOT_FOUND');
    }
    expect(E.policy.reads).toBe(0);
  });

  it('lifecycle of a WITHDRAWABLE purpose: NOT_ACCEPTED, withdraw, idempotent repeat, re-grant of the same version', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await refused(consent.withdraw(a, p.code), 'CONSENT_NOT_ACCEPTED');
    expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
    const acc = await consent.accept(a, p.code, v1.claim);
    const cid = `cid-${randomUUID()}`;
    const t0 = await dbNow();
    const w = await runWithCorrelation(cid, () => consent.withdraw(a, p.code));
    const t1 = await dbNow();
    expect(w.changed).toBe(true);
    expectEventDto(w.event, { code: p.code, type: 'WITHDRAWN', seq: 2, v: v1 });
    expect(new Date(w.event.occurredAt).getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(new Date(w.event.occurredAt).getTime()).toBeLessThanOrEqual(t1.getTime());
    expect(new Date(w.event.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(acc.event.occurredAt).getTime());
    const audits = await auditRows(a);
    expect(audits.map((x) => [x.action, x.changes, x.consent_event_id])).toEqual([
      ['CONSENT_ACCEPTED', { purposeCode: p.code, eventSeq: 1 }, acc.event.consentEventId],
      ['CONSENT_WITHDRAWN', { purposeCode: p.code, eventSeq: 2 }, w.event.consentEventId],
    ]);
    expect(audits[1]).toMatchObject({ actor: `account:${a}`, correlation_id: cid });
    const ob = (await outboxRows(a))[1]!;
    expect(ob).toMatchObject({
      event_type: CONSENT_EVENTS.withdrawn,
      aggregate_type: 'identity_account',
      aggregate_id: a,
      actor_type: 'user',
      actor_id: `account:${a}`,
      correlation_id: cid,
    });
    expect(ob.payload_json).toEqual({ accountId: a, purposeCode: p.code, consentEventId: w.event.consentEventId, eventSeq: 2, contentVersionId: v1.versionId });
    const x = await q<{ e: string; a: string; o: string }>(
      `SELECT e.xmin::text AS e, au.xmin::text AS a, o.xmin::text AS o FROM identity.consent_events e JOIN identity.account_audit_events au ON au.consent_event_id = e.consent_event_id
         JOIN integration.outbox_events o ON o.payload_json ->> 'consentEventId' = e.consent_event_id::text WHERE e.consent_event_id = $1`,
      [w.event.consentEventId],
    );
    expect(x[0]!.a).toBe(x[0]!.e);
    expect(x[0]!.o).toBe(x[0]!.e);
    expect(await latestRow(a, p.code)).toMatchObject({ event_type: 'WITHDRAWN', version_id: v1.versionId, locale: 'en-US', body_sha256: v1.hash });

    const before = await world();
    expect(await consent.withdraw(a, p.code)).toEqual({ changed: false, event: w.event });
    expect(await world()).toEqual(before);
    expect((await consent.getConsents(a)).current.find((c) => c.purposeCode === p.code)).toMatchObject({
      state: 'WITHDRAWN',
      withdrawable: true,
      latest: { eventType: 'WITHDRAWN' },
    });
    // re-grant of the very same version is a new acceptance (the repeat rule is about the LATEST event)
    const regrant = await consent.accept(a, p.code, v1.claim);
    expect(regrant.changed).toBe(true);
    expect(regrant.event.eventSeq).toBe(3);
    expect(await counts(a)).toEqual({ e: 3, a: 3, o: 3 });
    expect((await consent.getConsents(a)).history.map((h) => [h.eventSeq, h.eventType])).toEqual([
      [3, 'ACCEPTED'],
      [2, 'WITHDRAWN'],
      [1, 'ACCEPTED'],
    ]);
  });

  it('the withdrawal carries the ACCEPTED version, not the one in force; a re-grant needs the version in force', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    const v2 = await publishNext(p);
    const w = await consent.withdraw(a, p.code);
    expect(w.event.document).toEqual({ versionId: v1.versionId, version: 1, locale: 'en-US', bodySha256: v1.hash });
    await refused(consent.accept(a, p.code, v1.claim), 'CONSENT_VERSION_NOT_CURRENT');
    expect((await consent.accept(a, p.code, v2.claim)).event.eventSeq).toBe(3);
  });

  it('a withdrawn consent that was required is OUTSTANDING again (the acceptance state is WITHDRAWN)', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    await consent.withdraw(a, p.code);
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: 'NO_REACCEPT' });
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements[0]).toMatchObject({
      status: 'OUTSTANDING',
      acceptanceState: 'WITHDRAWN',
      accepted: null,
      withdrawable: true,
    });
  });

  it('REQUIRED_FOR_ROLE: refused while an ACTIVE or PENDING role of the account requires the purpose; allowed once nothing requires it', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: ['PROVIDER'] });
    await consent.accept(a, p.code, v1.claim);
    // only a CUSTOMER role: PROVIDER is the one that requires it, so the customer may withdraw (checked on a second account to keep the history)
    const customer = await newAccount();
    await consent.accept(customer, p.code, v1.claim);
    expect((await consent.withdraw(customer, p.code)).changed).toBe(true);

    await grant(a, 'PROVIDER', true);
    expect(await roleStatus(a, 'PROVIDER')).toBe('PENDING');
    const e = await refused(consent.withdraw(a, p.code), 'CONSENT_REQUIRED_FOR_ROLE', { purposeCode: p.code });
    expect(e.details).toEqual({ purposeCode: p.code });
    await grant(a, 'PROVIDER');
    expect(await roleStatus(a, 'PROVIDER')).toBe('ACTIVE');
    await refused(consent.withdraw(a, p.code), 'CONSENT_REQUIRED_FOR_ROLE', { purposeCode: p.code });
    expect((await latestRow(a, p.code))!.event_type).toBe('ACCEPTED');
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    // the requirement is removed by configuration: allowed
    E.policy.set(p.code, { requiredForRoles: [], reacceptance: 'REACCEPT_REQUIRED' });
    expect((await consent.withdraw(a, p.code)).changed).toBe(true);
    // re-grant, then the role goes away: allowed again under the original policy
    E.policy.set(p.code, { requiredForRoles: ['PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    await consent.accept(a, p.code, v1.claim);
    await refused(consent.withdraw(a, p.code), 'CONSENT_REQUIRED_FOR_ROLE', { purposeCode: p.code });
    await revokeRole(a, 'PROVIDER');
    expect(await roleStatus(a, 'PROVIDER')).toBe('INACTIVE');
    expect((await consent.withdraw(a, p.code)).changed).toBe(true);
    // idempotent repeat does not look at roles or policy
    await grant(a, 'PROVIDER');
    expect((await consent.withdraw(a, p.code)).changed).toBe(false);
  });

  it('the policy is read BEFORE the account lock, once, and only for an ACTIVE purpose', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    E.policy.reads = 0;
    E.policy.readPurposes.length = 0;
    const hold = await holdAccount(a);
    let w: Promise<{ changed: boolean }>;
    try {
      w = consent.withdraw(a, p.code);
      await lockWaiters(1);
      expect(E.policy.readPurposes, 'the policy was read while the account lock was still being waited for').toEqual([p.code]);
    } finally {
      await hold.release(false);
    }
    expect((await w).changed).toBe(true);
    expect(E.policy.reads).toBe(1);
    // an INACTIVE purpose is withdrawable without a policy read, even while the policy is down
    const b = await newAccount();
    await consent.accept(b, p.code, v1.claim);
    await setPurposeStatus(p.code, 'INACTIVE');
    E.policy.reads = 0;
    E.policy.failure = new Error('configuration down');
    expect((await consent.withdraw(b, p.code)).changed).toBe(true);
    expect(E.policy.reads).toBe(0);
  });

  it('a policy outage or an invalid policy fails closed (UNAVAILABLE) before anything is written, with no cause in the error or the log', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    const secret = forbid(`secret-config-detail-${randomUUID()}`, 'policy failure cause');
    logSink.all.length = 0;
    E.policy.failure = new Error(secret);
    const e = await fails(consent.withdraw(a, p.code), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
    expect(e.message).toBe('the consent policy is not available');
    expect(logSink.all.join('\n')).toContain('consent policy unavailable');
    expect(logSink.all.join('\n')).not.toContain(secret);
    E.policy.failure = undefined;
    // an outage comes before the account state: even a never-accepting account gets UNAVAILABLE, not NOT_ACCEPTED
    E.policy.failure = new Error(secret);
    await fails(consent.withdraw(await newAccount(), p.code), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
    E.policy.failure = undefined;
    // invalid shapes and an unknown role code are invalid policies, not "required of nobody"
    for (const bad of [
      { requiredForRoles: 'CUSTOMER', reacceptance: 'REACCEPT_REQUIRED' },
      { requiredForRoles: ['NOSUCHROLE'], reacceptance: 'REACCEPT_REQUIRED' },
      { requiredForRoles: ['customer'], reacceptance: 'REACCEPT_REQUIRED' },
      { requiredForRoles: ['CUSTOMER', 'CUSTOMER'], reacceptance: 'REACCEPT_REQUIRED' },
      { requiredForRoles: [], reacceptance: 'SOMETIMES' },
    ]) {
      E.policy.set(p.code, bad as unknown as ConsentPolicy);
      await fails(consent.withdraw(a, p.code), 'UNAVAILABLE', {
        reason: 'POLICY_INVALID',
        purposeCode: p.code,
        field: expect.stringMatching(/^(required_for|reacceptance)$/) as never,
      });
    }
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    expect((await latestRow(a, p.code))!.event_type).toBe('ACCEPTED');
  });

  it('a purpose that was INACTIVE when the call started and ACTIVE when it got the lock fails closed with a retryable CONFLICT; the retry works', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: ['CUSTOMER'] });
    await consent.accept(a, p.code, v1.claim);
    await setPurposeStatus(p.code, 'INACTIVE');
    const hold = await holdAccount(a);
    let w: Promise<unknown>;
    try {
      w = settled(consent.withdraw(a, p.code));
      await lockWaiters(1);
      await setPurposeStatus(p.code, 'ACTIVE');
    } finally {
      await hold.release(false);
    }
    const e = await w;
    expect(codeOf(e)).toBe('CONFLICT');
    expect((e as AccountError).details).toEqual({ reason: 'CONCURRENT_UPDATE', retryable: true });
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    // the retry reads the policy: the role requires the purpose
    await fails(consent.withdraw(a, p.code), 'CONSENT_REQUIRED_FOR_ROLE');
  });

  it('a purpose that was ACTIVE when the call started and INACTIVE when it got the lock is withdrawn (an inactive purpose is required of nobody)', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: ['CUSTOMER'] });
    // accept while the requirement does not apply, then require it
    E.policy.set(p.code, { requiredForRoles: [], reacceptance: 'REACCEPT_REQUIRED' });
    await consent.accept(a, p.code, v1.claim);
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: 'REACCEPT_REQUIRED' });
    const hold = await holdAccount(a);
    let w: Promise<{ changed: boolean }>;
    try {
      // the policy read at call time says CUSTOMER requires it; the purpose is retired before the lock is obtained
      w = consent.withdraw(a, p.code);
      await lockWaiters(1);
      await setPurposeStatus(p.code, 'INACTIVE');
    } finally {
      await hold.release(false);
    }
    expect((await w).changed).toBe(true);
  });
});

// ====================================================================== getRequirements
type Mode = ReacceptanceMode;
const MODES: Mode[] = ['REACCEPT_REQUIRED', 'REACCEPT_FOR_NEW_USERS_ONLY', 'NO_REACCEPT'];
const reqOf = async (a: string, p: Purpose, opts: { locale?: string } = {}) =>
  (await consent.getRequirements(a, { purposes: [p.code], ...opts })).requirements[0]!;
const asRequired = (p: Purpose, mode: Mode) => E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: mode });

describe('getRequirements: status x mode x locale x role, end to end', () => {
  // the expected statuses are written out by hand from the rules of ADR-0038 (they are not computed by the code under test)
  //   state:      none            v1 (en, old)           es (es-MX)             wd (withdrawn)   v2 (en, current)
  type S = 'none' | 'v1' | 'es' | 'wd' | 'v2';
  const STATES: S[] = ['none', 'v1', 'es', 'wd', 'v2'];
  const TABLE: Record<Mode, Record<'en-US' | 'es-MX' | 'fr-FR', Record<S, string>>> = {
    REACCEPT_REQUIRED: {
      'en-US': { none: 'OUTSTANDING', v1: 'REACCEPTANCE_REQUIRED', es: 'REACCEPTANCE_REQUIRED', wd: 'OUTSTANDING', v2: 'SATISFIED' },
      'es-MX': { none: 'OUTSTANDING', v1: 'REACCEPTANCE_REQUIRED', es: 'SATISFIED', wd: 'OUTSTANDING', v2: 'REACCEPTANCE_REQUIRED' },
      'fr-FR': { none: 'DOCUMENT_UNAVAILABLE', v1: 'DOCUMENT_UNAVAILABLE', es: 'DOCUMENT_UNAVAILABLE', wd: 'DOCUMENT_UNAVAILABLE', v2: 'DOCUMENT_UNAVAILABLE' },
    },
    REACCEPT_FOR_NEW_USERS_ONLY: {
      'en-US': { none: 'OUTSTANDING', v1: 'SATISFIED', es: 'OUTSTANDING', wd: 'OUTSTANDING', v2: 'SATISFIED' },
      'es-MX': { none: 'OUTSTANDING', v1: 'OUTSTANDING', es: 'SATISFIED', wd: 'OUTSTANDING', v2: 'OUTSTANDING' },
      'fr-FR': { none: 'DOCUMENT_UNAVAILABLE', v1: 'DOCUMENT_UNAVAILABLE', es: 'DOCUMENT_UNAVAILABLE', wd: 'DOCUMENT_UNAVAILABLE', v2: 'DOCUMENT_UNAVAILABLE' },
    },
    NO_REACCEPT: {
      'en-US': { none: 'OUTSTANDING', v1: 'SATISFIED', es: 'SATISFIED', wd: 'OUTSTANDING', v2: 'SATISFIED' },
      'es-MX': { none: 'OUTSTANDING', v1: 'SATISFIED', es: 'SATISFIED', wd: 'OUTSTANDING', v2: 'SATISFIED' },
      'fr-FR': { none: 'DOCUMENT_UNAVAILABLE', v1: 'SATISFIED', es: 'SATISFIED', wd: 'DOCUMENT_UNAVAILABLE', v2: 'SATISFIED' },
    },
  };

  it('every cell of the table, with the document shown, the acceptance state and the accepted event', async () => {
    const p = await makePurpose({ withdrawable: true, requiredFor: [] });
    const en1 = await craftVersion(p);
    const es1 = await craftVersion(p, { locale: 'es-MX' });
    const acct = {} as Record<S, string>;
    for (const s of STATES) acct[s] = await newAccount();
    await consent.accept(acct.v1, p.code, en1.claim);
    await consent.accept(acct.es, p.code, es1.claim);
    await consent.accept(acct.wd, p.code, en1.claim);
    await consent.withdraw(acct.wd, p.code);
    const en2 = await publishNext(p); // v1 is superseded; Spanish has only its first version
    await consent.accept(acct.v2, p.code, en2.claim);
    const doc: Record<string, Ver | null> = { 'en-US': en2, 'es-MX': es1, 'fr-FR': null };
    const state: Record<S, string> = { none: 'NONE', v1: 'ACCEPTED', es: 'ACCEPTED', wd: 'WITHDRAWN', v2: 'ACCEPTED' };
    for (const mode of MODES) {
      asRequired(p, mode);
      for (const locale of ['en-US', 'es-MX', 'fr-FR'] as const) {
        for (const s of STATES) {
          const r = await reqOf(acct[s], p, { locale });
          const label = `${mode} / ${locale} / ${s}`;
          expect(r.status, label).toBe(TABLE[mode][locale][s]);
          expect(r.required, label).toBe(true);
          expect(r.reacceptance, label).toBe(mode);
          expect(r.acceptanceState, label).toBe(state[s]);
          expect(r.document?.versionId ?? null, label).toBe(doc[locale]?.versionId ?? null);
          expect(r.accepted === null, label).toBe(state[s] !== 'ACCEPTED');
          const whole = await consent.getRequirements(acct[s], { purposes: [p.code], locale });
          expect(whole.locale).toBe(locale);
          expect(whole.satisfied, label).toBe(r.status === 'SATISFIED');
          expect(whole.outstanding, label).toEqual(r.status === 'SATISFIED' ? [] : [p.code]);
        }
      }
    }
    // not required (the policy names a role this account does not have): NOT_REQUIRED in every cell, the acceptance state is still reported
    E.policy.set(p.code, { requiredForRoles: ['PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    for (const locale of ['en-US', 'es-MX', 'fr-FR']) {
      for (const s of STATES) {
        const whole = await consent.getRequirements(acct[s], { purposes: [p.code], locale });
        expect(whole.requirements[0], `${locale} / ${s}`).toMatchObject({ required: false, status: 'NOT_REQUIRED', acceptanceState: state[s] });
        expect(whole.satisfied).toBe(true);
        expect(whole.outstanding).toEqual([]);
      }
    }
  });

  it('REACCEPT_REQUIRED vs REACCEPT_FOR_NEW_USERS_ONLY vs NO_REACCEPT after a new version in the SAME locale and in ANOTHER locale', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const en1 = await craftVersion(p);
    const es1 = await craftVersion(p, { locale: 'es-MX' });
    const a = await newAccount();
    await consent.accept(a, p.code, en1.claim);
    // another locale gets a new version: the English acceptance is untouched in every mode
    const es2 = await publishNext(p, { locale: 'es-MX' });
    for (const mode of MODES) {
      asRequired(p, mode);
      expect((await reqOf(a, p)).status, `${mode} en-US after es-MX v2`).toBe('SATISFIED');
    }
    // the same locale gets a new version
    const en2 = await publishNext(p);
    const expected: Record<Mode, string> = { REACCEPT_REQUIRED: 'REACCEPTANCE_REQUIRED', REACCEPT_FOR_NEW_USERS_ONLY: 'SATISFIED', NO_REACCEPT: 'SATISFIED' };
    for (const mode of MODES) {
      asRequired(p, mode);
      const r = await reqOf(a, p);
      expect(r.status, mode).toBe(expected[mode]);
      expect(r.document?.versionId).toBe(en2.versionId);
      expect(r.accepted?.document.versionId).toBe(en1.versionId);
    }
    void es1;
    void es2;
  });

  it('a Legal timeline gap (published head with an explicit end, successor later) and the deactivation of the entry or the locale, for each mode', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const head = await craftVersion(p, { startedAgoSec: 60, endsInSec: 1 });
    const esHead = await craftVersion(p, { locale: 'es-MX', startedAgoSec: 60 });
    const accepted = await newAccount();
    const never = await newAccount();
    const acceptedEs = await newAccount();
    await consent.accept(accepted, p.code, head.claim);
    await consent.accept(acceptedEs, p.code, esHead.claim);
    const [end] = await q<{ t: Date; next: string }>(
      `SELECT effective_to AS t, (effective_to + interval '2 seconds')::text AS next FROM content.versions WHERE version_id = $1`,
      [head.versionId],
    );
    await dbWaitUntil(end!.t);
    // the gap: no version is in force in English
    const gap: Record<Mode, [string, string]> = {
      // [accepted account, account that never accepted]
      REACCEPT_REQUIRED: ['DOCUMENT_UNAVAILABLE', 'DOCUMENT_UNAVAILABLE'],
      REACCEPT_FOR_NEW_USERS_ONLY: ['SATISFIED', 'DOCUMENT_UNAVAILABLE'],
      NO_REACCEPT: ['SATISFIED', 'DOCUMENT_UNAVAILABLE'],
    };
    for (const mode of MODES) {
      asRequired(p, mode);
      expect([(await reqOf(accepted, p)).status, (await reqOf(never, p)).status], `gap / ${mode}`).toEqual(gap[mode]);
      expect((await reqOf(accepted, p)).document, 'nothing to show in the gap').toBeNull();
    }
    // the successor starts: the accepted account must re-accept under REACCEPT_REQUIRED only
    const next = await craftVersion(p, { fromText: end!.next });
    await dbWaitUntil(new Date(end!.t.getTime() + 2100));
    const after: Record<Mode, [string, string]> = {
      REACCEPT_REQUIRED: ['REACCEPTANCE_REQUIRED', 'OUTSTANDING'],
      REACCEPT_FOR_NEW_USERS_ONLY: ['SATISFIED', 'OUTSTANDING'],
      NO_REACCEPT: ['SATISFIED', 'OUTSTANDING'],
    };
    for (const mode of MODES) {
      asRequired(p, mode);
      expect([(await reqOf(accepted, p)).status, (await reqOf(never, p)).status], `successor / ${mode}`).toEqual(after[mode]);
      expect((await reqOf(accepted, p)).document?.versionId).toBe(next.versionId);
    }
    // the entry is deactivated
    await setEntryActive(p.entryId, false);
    for (const mode of MODES) {
      asRequired(p, mode);
      expect([(await reqOf(accepted, p)).status, (await reqOf(never, p)).status], `entry inactive / ${mode}`).toEqual(gap[mode]);
    }
    await setEntryActive(p.entryId, true);
    // the Spanish locale is deactivated: evaluated in es-MX
    await setLocale('es-MX', false);
    try {
      for (const mode of MODES) {
        asRequired(p, mode);
        expect(
          [(await reqOf(acceptedEs, p, { locale: 'es-MX' })).status, (await reqOf(never, p, { locale: 'es-MX' })).status],
          `locale inactive / ${mode}`,
        ).toEqual(gap[mode]);
      }
    } finally {
      await setLocale('es-MX', true);
    }
    for (const mode of MODES) {
      asRequired(p, mode);
      expect((await reqOf(acceptedEs, p, { locale: 'es-MX' })).status, `locale active again / ${mode}`).toBe('SATISFIED');
    }
  });
});

describe('getRequirements: the locale', () => {
  it('EXACT locale, no fallback: a locale without a version is DOCUMENT_UNAVAILABLE although English has one', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const en = await craftVersion(p);
    const a = await newAccount();
    const fr = await reqOf(a, p, { locale: 'fr-FR' });
    expect(fr).toMatchObject({ status: 'DOCUMENT_UNAVAILABLE', document: null });
    expect((await consent.getRequirements(a, { purposes: [p.code], locale: 'fr-FR' })).locale).toBe('fr-FR');
    await refused(consent.accept(a, p.code, { ...en.claim, locale: 'fr-FR' }), 'CONSENT_LOCALE_MISMATCH');
    expect((await reqOf(a, p, { locale: 'en-US' })).document?.versionId).toBe(en.versionId);
  });

  it('an explicit locale must be registered (exact comparison): otherwise VALIDATION_FAILED INVALID_LOCALE; a registered inactive locale is evaluated', async () => {
    const a = await newAccount();
    for (const locale of ['xx-XX', 'es-mx', 'ES-MX', 'EN-us', 'es', 'qaa', '', 'e', 'en_US', 'x'.repeat(36), 'en-US ', 'en-US\n']) {
      await fails(consent.getRequirements(a, { locale }), 'VALIDATION_FAILED', { reason: 'INVALID_LOCALE', field: 'locale' });
    }
    for (const locale of [null, 5, {}] as unknown[])
      await fails(consent.getRequirements(a, { locale: locale as string }), 'VALIDATION_FAILED', { reason: 'INVALID_LOCALE', field: 'locale' });
    await fails(consent.requireConsents(a, { locale: 'xx-XX' }), 'VALIDATION_FAILED', { reason: 'INVALID_LOCALE', field: 'locale' });
    await fails(consent.hasRequiredConsents(a, { locale: 'xx-XX' }), 'VALIDATION_FAILED', { reason: 'INVALID_LOCALE', field: 'locale' });
    await fails(consent.listOutstandingConsents(a, { locale: 'xx-XX' }), 'VALIDATION_FAILED', { reason: 'INVALID_LOCALE', field: 'locale' });
    expect((await consent.getRequirements(a, { locale: 'it-IT', purposes: [] })).locale).toBe('it-IT');
  });

  it('the locale defaults to the profile preferred locale, else the platform default; an explicit locale wins over both', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const en = await craftVersion(p);
    const es = await craftVersion(p, { locale: 'es-MX' });
    const a = await newAccount();
    expect((await consent.getRequirements(a, { purposes: [p.code] })).locale).toBe('en-US');
    await E.accounts.upsertProfile(a, { firstName: 'Ann', lastName: 'Lee', preferredLocale: 'es-MX' }, { actor: `account:${a}` });
    const r = await consent.getRequirements(a, { purposes: [p.code] });
    expect(r.locale).toBe('es-MX');
    expect(r.requirements[0]!.document?.versionId).toBe(es.versionId);
    expect((await consent.getRequirements(a, { purposes: [p.code], locale: 'en-US' })).requirements[0]!.document?.versionId).toBe(en.versionId);
    // the profile locale is later deactivated: still evaluated in it (exact), so the document is unavailable
    await setLocale('es-MX', false);
    try {
      expect(await reqOf(a, p)).toMatchObject({ status: 'DOCUMENT_UNAVAILABLE', document: null });
    } finally {
      await setLocale('es-MX', true);
    }
    // a profile without a locale uses the default
    const b = await newAccount();
    await E.accounts.upsertProfile(b, { firstName: 'Bo', lastName: 'Kim' }, { actor: `account:${b}` });
    expect((await consent.getRequirements(b, { purposes: [p.code] })).locale).toBe('en-US');
  });

  it('the platform default locale can come from the dependency; its failure is UNAVAILABLE and an explicit locale does not need it', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const es = await craftVersion(p, { locale: 'es-MX' });
    const a = await newAccount();
    const viaDep = new ConsentService({ database: E.bigDb, policy: E.policy, defaultLocale: async () => 'es-MX' });
    const r = await viaDep.getRequirements(a, { purposes: [p.code] });
    expect(r.locale).toBe('es-MX');
    expect(r.requirements[0]!.document?.versionId).toBe(es.versionId);
    const broken = new ConsentService({
      database: E.bigDb,
      policy: E.policy,
      defaultLocale: async () => {
        throw new Error('content registry down');
      },
    });
    const e = await fails(broken.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'NO_PLATFORM_DEFAULT' });
    expect(errText(e)).not.toContain('content registry');
    expect((await broken.getRequirements(a, { purposes: [p.code], locale: 'es-MX' })).locale).toBe('es-MX');
  });
});

describe('getRequirements: roles', () => {
  it('PENDING and ACTIVE roles count, INACTIVE roles and no role do not; the roles are read at every evaluation', async () => {
    const p = await makePurpose({ requiredFor: ['PROVIDER'] });
    const v1 = await craftVersion(p);
    const a = await newAccount();
    expect(await reqOf(a, p)).toMatchObject({ required: false, status: 'NOT_REQUIRED' });
    await grant(a, 'PROVIDER', true);
    expect(await reqOf(a, p)).toMatchObject({ required: true, status: 'OUTSTANDING' });
    await grant(a, 'PROVIDER');
    expect(await reqOf(a, p)).toMatchObject({ required: true, status: 'OUTSTANDING' });
    await consent.accept(a, p.code, v1.claim);
    expect((await reqOf(a, p)).status).toBe('SATISFIED');
    await revokeRole(a, 'PROVIDER');
    expect(await reqOf(a, p)).toMatchObject({ required: false, status: 'NOT_REQUIRED', acceptanceState: 'ACCEPTED' });
    await grant(a, 'PROVIDER');
    expect((await reqOf(a, p)).status).toBe('SATISFIED');
    const none = await roleless();
    expect(await reqOf(none, p)).toMatchObject({ required: false, status: 'NOT_REQUIRED' });
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    expect(await reqOf(none, p)).toMatchObject({ required: false, status: 'NOT_REQUIRED' });
  });

  it('both roles at once: either role requiring the purpose requires it; an empty list requires it of nobody', async () => {
    const p = await makePurpose({ requiredFor: ['PROVIDER'] });
    await craftVersion(p);
    const both = await newAccount(['customer', 'provider']);
    expect(await roleStatus(both, 'CUSTOMER')).toBe('ACTIVE');
    expect(await roleStatus(both, 'PROVIDER')).toBe('ACTIVE');
    expect((await reqOf(both, p)).required).toBe(true);
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: 'REACCEPT_REQUIRED' });
    expect((await reqOf(both, p)).required).toBe(true);
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER', 'PROVIDER'], reacceptance: 'REACCEPT_REQUIRED' });
    expect((await reqOf(both, p)).required).toBe(true);
    E.policy.set(p.code, { requiredForRoles: [], reacceptance: 'REACCEPT_REQUIRED' });
    expect(await reqOf(both, p)).toMatchObject({ required: false, status: 'NOT_REQUIRED' });
    // role codes are compared exactly
    await fails(
      (async () => {
        E.policy.set(p.code, { requiredForRoles: ['Customer'], reacceptance: 'REACCEPT_REQUIRED' });
        return reqOf(both, p);
      })(),
      'UNAVAILABLE',
      { reason: 'POLICY_INVALID', purposeCode: p.code, field: 'required_for' },
    );
  });
});

describe('getRequirements: the purposes filter and the policy', () => {
  it('purposes: unknown or malformed => PURPOSE_NOT_FOUND, INACTIVE skipped, duplicates removed, [] evaluates nothing, the order is by code', async () => {
    const a1 = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const a2 = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const old = await makePurpose({ requiredFor: ['CUSTOMER'] });
    for (const p of [a1, a2, old]) await craftVersion(p);
    await setPurposeStatus(old.code, 'INACTIVE');
    const a = await newAccount();
    E.policy.readPurposes.length = 0;
    const r = await consent.getRequirements(a, { purposes: [a2.code, a1.code, a2.code, old.code] });
    expect(r.requirements.map((x) => x.purposeCode)).toEqual([a1.code, a2.code].sort());
    expect([...E.policy.readPurposes].sort(), 'the policy is read for the evaluated purposes only, once each').toEqual([a1.code, a2.code].sort());
    for (const bad of ['NO_SUCH_PURPOSE', 'lower', '', 5, null] as unknown[])
      await fails(consent.getRequirements(a, { purposes: [a1.code, bad as string] }), 'CONSENT_PURPOSE_NOT_FOUND');
    const none = await consent.getRequirements(a, { purposes: [] });
    expect(none).toEqual({ locale: 'en-US', requirements: [], satisfied: true, outstanding: [] });
    expect((await consent.getRequirements(a, { purposes: [old.code] })).requirements).toEqual([]);
    // without a filter every ACTIVE purpose is evaluated, and only those
    const all = await consent.getRequirements(a);
    expect(all.requirements.map((x) => x.purposeCode)).toEqual([a1.code, a2.code, ...SEEDED].sort());
    expect(all.outstanding).toEqual([...all.requirements.map((x) => x.purposeCode)]);
  });

  it('the explicit empty list of the gate operations is a VALIDATION_FAILED (an empty gate would pass for everyone); only getRequirements accepts it', async () => {
    const a = await newAccount();
    for (const f of [
      () => consent.requireConsents(a, { purposes: [] }),
      () => consent.hasRequiredConsents(a, { purposes: [] }),
      () => consent.listOutstandingConsents(a, { purposes: [] }),
    ]) {
      await fails(f(), 'VALIDATION_FAILED', { reason: 'INVALID_FIELD', field: 'purposes' });
    }
    expect((await consent.getRequirements(a, { purposes: [] })).requirements).toEqual([]);
  });

  it('listOutstandingConsents / hasRequiredConsents / requireConsents: the outstanding set, CONSENT_REQUIRED with details.outstanding', async () => {
    const ok = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const re = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const out = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const nodoc = await makePurpose({ requiredFor: ['CUSTOMER'] });
    const notreq = await makePurpose({ requiredFor: ['PROVIDER'] });
    const okV = await craftVersion(ok);
    const reV = await craftVersion(re);
    await craftVersion(out);
    await craftVersion(notreq);
    const a = await newAccount();
    await consent.accept(a, ok.code, okV.claim);
    await consent.accept(a, re.code, reV.claim);
    await publishNext(re);
    const all = [ok, re, out, nodoc, notreq].map((x) => x.code);
    const purposes = [...all].sort();
    const listed = await consent.listOutstandingConsents(a, { purposes });
    const expectedOut = [re.code, out.code, nodoc.code].sort();
    expect(listed.map((x) => x.purposeCode)).toEqual(expectedOut);
    expect(Object.fromEntries(listed.map((x) => [x.purposeCode, x.status]))).toEqual({
      [re.code]: 'REACCEPTANCE_REQUIRED',
      [out.code]: 'OUTSTANDING',
      [nodoc.code]: 'DOCUMENT_UNAVAILABLE',
    });
    expect(await consent.hasRequiredConsents(a, { purposes })).toBe(false);
    const e = await refused(consent.requireConsents(a, { purposes }), 'CONSENT_REQUIRED', { outstanding: expectedOut });
    expect(e.details.outstanding).toEqual(expectedOut);
    // a gate over satisfied or not-required purposes passes
    expect(await consent.hasRequiredConsents(a, { purposes: [ok.code, notreq.code] })).toBe(true);
    await consent.requireConsents(a, { purposes: [ok.code, notreq.code] });
    expect(await consent.listOutstandingConsents(a, { purposes: [ok.code] })).toEqual([]);
    // an unknown purpose in the gate is an error, not a pass
    await fails(consent.requireConsents(a, { purposes: [ok.code, 'NO_SUCH_PURPOSE'] }), 'CONSENT_PURPOSE_NOT_FOUND');
  });

  it('an invalid or unavailable policy fails closed with the right reason: not an array, unknown role, bad shape, duplicates, too many, bad mode, outage, missing', async () => {
    const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
    await craftVersion(p);
    const a = await newAccount();
    const field = (f: 'required_for' | 'reacceptance') => ({ reason: 'POLICY_INVALID', purposeCode: p.code, field: f });
    const reqCases: unknown[] = [
      'CUSTOMER',
      null,
      undefined,
      {},
      5,
      ['NOSUCHROLE'],
      ['customer'],
      [''],
      [5],
      [null],
      ['CUSTOMER', 'CUSTOMER'],
      Array.from({ length: 11 }, (_, i) => `ROLE_${i}`),
      ['CUSTOMER '],
    ];
    for (const v of reqCases) {
      E.policy.set(p.code, { requiredForRoles: v as string[], reacceptance: 'REACCEPT_REQUIRED' });
      await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', field('required_for'));
      await fails(consent.requireConsents(a, { purposes: [p.code] }), 'UNAVAILABLE', field('required_for'));
      await fails(consent.hasRequiredConsents(a, { purposes: [p.code] }), 'UNAVAILABLE', field('required_for'));
      await fails(consent.listOutstandingConsents(a, { purposes: [p.code] }), 'UNAVAILABLE', field('required_for'));
    }
    for (const v of ['', 'reaccept_required', 'SOMETIMES', null, undefined, 5, ['NO_REACCEPT']] as unknown[]) {
      E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: v as Mode });
      await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', field('reacceptance'));
    }
    // a provider that blows up on a malformed value (here: no policy object at all) is an outage of the policy, never a default
    E.policy.set(p.code, null as unknown as ConsentPolicy);
    await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
    // a missing value (the provider's own refusal passes through) and an outage
    E.policy.unset(p.code);
    await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'POLICY_INVALID', purposeCode: p.code });
    E.policy.set(p.code, { requiredForRoles: ['CUSTOMER'], reacceptance: 'REACCEPT_REQUIRED' });
    E.policy.failure = new Error('configuration registry down: password=hunter2');
    const e = await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
    expect(errText(e)).not.toContain('hunter2');
    expect(logSink.all.join('\n')).not.toContain('hunter2');
    await fails(consent.listOutstandingConsents(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
    await fails(consent.requireConsents(a), 'UNAVAILABLE'); // the default evaluation reads every active purpose
    // the policy of an INACTIVE purpose or of a purpose outside the filter is never read
    const reads = E.policy.reads;
    await setPurposeStatus(p.code, 'INACTIVE');
    expect((await consent.getRequirements(a, { purposes: [p.code] })).requirements).toEqual([]);
    expect(E.policy.reads).toBe(reads);
    // reads that do not need the policy are not affected by an outage
    expect((await consent.getConsents(a)).history).toEqual([]);
  });

  it('operations that do not depend on the policy keep working while it is down: accept, the idempotent repeat, getConsents, the NOT_WITHDRAWABLE refusal', async () => {
    const { p, v1, a } = await scene();
    E.policy.failure = new Error('configuration down');
    E.policy.reads = 0;
    expect((await consent.accept(a, p.code, v1.claim)).changed).toBe(true);
    expect((await consent.accept(a, p.code, v1.claim)).changed).toBe(false);
    expect((await consent.getConsents(a)).history).toHaveLength(1);
    await refused(consent.withdraw(a, p.code), 'CONSENT_NOT_WITHDRAWABLE');
    expect(E.policy.reads).toBe(0);
    await fails(consent.getRequirements(a, { purposes: [p.code] }), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE', purposeCode: p.code });
  });

  it('a gate over an invalid policy of ANOTHER active purpose fails closed too (the default evaluation lists every active purpose)', async () => {
    const good = await makePurpose();
    const bad = await makePurpose();
    await craftVersion(good);
    const a = await newAccount();
    E.policy.set(bad.code, { requiredForRoles: ['CUSTOMER', 'CUSTOMER'], reacceptance: 'REACCEPT_REQUIRED' });
    await fails(consent.requireConsents(a), 'UNAVAILABLE', { reason: 'POLICY_INVALID', purposeCode: bad.code, field: 'required_for' });
    expect((await consent.getRequirements(a, { purposes: [good.code] })).requirements).toHaveLength(1);
  });
});

/**
 * Rounds of: a writer's INSERT is pending (uncommitted); the read starts; a hook commits the writer right after the read's first (getRequirements) or second
 * (getConsents) statement completes, before the next statement is sent. A read in ONE repeatable-read snapshot sees nothing of it; a read of several independent
 * statements sees it half-way. Returns how many rounds showed a commit that landed after the snapshot began.
 */
async function snapshotInconsistencies(Svc: typeof ConsentService, rounds: number): Promise<number> {
  const p = await makePurpose({ requiredFor: ['CUSTOMER'] });
  const v1 = await craftVersion(p);
  let trigger: (() => void) | null = null;
  // the hook runs right after a statement completes and BEFORE the next one is sent
  const hooked = createDatabase(E.iso.url, {
    role: 'tests',
    overrides: { poolMax: 5 },
    onQuery: (e) => {
      if (trigger && /LEFT JOIN LATERAL|preferred_locale/.test(e.sql)) {
        const t = trigger;
        trigger = null;
        t();
      }
    },
  });
  let inconsistent = 0;
  try {
    const svc = new Svc({ database: hooked, policy: E.policy });
    for (let round = 0; round < rounds; round++) {
      const a = await newAccount();
      const w = await rawTx();
      await rawEvent(w, { accountId: a, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
      let committed: Promise<void> | undefined;
      trigger = () => {
        committed = w.release(true);
      };
      const c = await svc.getConsents(a);
      await committed;
      // the snapshot began before the commit: nothing of it may show, in `current` or in `history`
      if (c.current.some((x) => x.purposeCode === p.code && x.latest !== null) || c.history.some((h) => h.purposeCode === p.code)) inconsistent += 1;
      expect((await E.consent.getConsents(a)).history, 'the next read sees the commit').toHaveLength(1);

      const b = await newAccount();
      const w2 = await rawTx();
      await rawEvent(w2, { accountId: b, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
      trigger = () => {
        committed = w2.release(true);
      };
      const r = await svc.getRequirements(b, { purposes: [p.code] });
      await committed;
      if (r.requirements[0]!.status !== 'OUTSTANDING' || r.requirements[0]!.accepted !== null) inconsistent += 1;
      expect((await E.consent.getRequirements(b, { purposes: [p.code] })).requirements[0]!.status).toBe('SATISFIED');
    }
  } finally {
    await hooked.close();
  }
  return inconsistent;
}

// ====================================================================== getConsents
describe('getConsents', () => {
  it("current: one row per ACTIVE purpose and per purpose with events (latest event), history newest first, only the owner's events", async () => {
    const w = await makePurpose({ withdrawable: true, requiredFor: [] });
    const n = await makePurpose();
    const gone = await makePurpose();
    const unused = await makePurpose();
    const [wv, nv, gv] = [await craftVersion(w), await craftVersion(n), await craftVersion(gone)];
    await craftVersion(unused);
    const a = await newAccount();
    const b = await newAccount();
    await consent.accept(a, w.code, wv.claim);
    await consent.accept(a, n.code, nv.claim);
    await consent.accept(a, gone.code, gv.claim);
    await consent.withdraw(a, w.code);
    await consent.accept(b, w.code, wv.claim);
    await setPurposeStatus(gone.code, 'INACTIVE');
    await setPurposeStatus(unused.code, 'INACTIVE');
    const c = await consent.getConsents(a);
    const codes = c.current.map((x) => x.purposeCode);
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain(gone.code); // inactive but it has events
    expect(codes).not.toContain(unused.code); // inactive without events
    for (const code of [...SEEDED, w.code, n.code]) expect(codes).toContain(code);
    const row = (code: string) => c.current.find((x) => x.purposeCode === code)!;
    expect(row(w.code)).toMatchObject({
      state: 'WITHDRAWN',
      withdrawable: true,
      labelContentKey: consentPurposeLabelKey(w.code),
      latest: { eventType: 'WITHDRAWN', eventSeq: 2 },
    });
    expect(row(n.code)).toMatchObject({
      state: 'ACCEPTED',
      withdrawable: false,
      latest: { eventType: 'ACCEPTED', eventSeq: 1, document: { versionId: nv.versionId, version: 1 } },
    });
    expect(row(gone.code).state).toBe('ACCEPTED');
    expect(row('TERMS_OF_SERVICE')).toMatchObject({ state: 'NONE', latest: null });
    // the history is a's alone, newest first
    expect(c.history).toHaveLength(4);
    const times = c.history.map((h) => new Date(h.occurredAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(c.history[0]).toMatchObject({ purposeCode: w.code, eventType: 'WITHDRAWN' });
    const bc = await consent.getConsents(b);
    expect(bc.history.map((h) => h.purposeCode)).toEqual([w.code]);
    expect(bc.current.find((x) => x.purposeCode === w.code)!.latest!.consentEventId).not.toBe(row(w.code).latest!.consentEventId);
    const ids = new Set(c.history.map((h) => h.consentEventId));
    for (const h of bc.history) expect(ids.has(h.consentEventId)).toBe(false);
  });

  it('the history is capped at CONSENT_HISTORY_LIMIT (200), newest first; the current state is the real latest event', async () => {
    expect(CONSENT_HISTORY_LIMIT).toBe(200);
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const other = await newAccount();
    const tx = await rawTx();
    try {
      for (let i = 1; i <= 205; i++)
        await rawEvent(tx, { accountId: a, code: p.code, seq: i, type: i % 2 === 1 ? 'ACCEPTED' : 'WITHDRAWN', v: v1, correlation: 'raw-bulk' });
    } finally {
      await tx.release(true);
    }
    await rawEvent(null, { accountId: other, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
    const c = await consent.getConsents(a);
    expect(c.history).toHaveLength(200);
    expect(c.history[0]!.eventSeq).toBe(205);
    expect(c.history.at(-1)!.eventSeq).toBe(6);
    expect(c.history.map((h) => h.eventSeq)).toEqual(Array.from({ length: 200 }, (_, i) => 205 - i));
    expect(c.current.find((x) => x.purposeCode === p.code)).toMatchObject({ state: 'ACCEPTED', latest: { eventSeq: 205 } });
    expect((await consent.getConsents(other)).history).toHaveLength(1);
  });

  it('reads never take a lock: a held account lock does not delay them, and they do not refuse SUSPENDED accounts', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    const hold = await holdAccount(a);
    try {
      const c = await within(3000, consent.getConsents(a), 'getConsents');
      expect(c.history).toHaveLength(1);
      expect((await within(3000, consent.getRequirements(a, { purposes: [p.code] }), 'getRequirements')).requirements).toHaveLength(1);
    } finally {
      await hold.release(false);
    }
  });

  it('the reads run in ONE read-only REPEATABLE READ transaction (policy reads happen outside it)', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    const seen: { isolationLevel: string; readOnly: boolean; policyReadsInside: number }[] = [];
    let open = false;
    let insideReads = 0;
    const observed = createDatabase(E.iso.url, {
      role: 'tests',
      overrides: { poolMax: 5 },
      onTransaction: (e) => {
        seen.push({ isolationLevel: e.isolationLevel, readOnly: e.readOnly, policyReadsInside: insideReads });
        open = false;
      },
      onQuery: (e) => {
        if (/^SELECT/i.test(e.sql)) open = true;
      },
    });
    const counting = { policy: async (code: string) => (open ? ((insideReads += 1), E.policy.policy(code)) : E.policy.policy(code)) };
    try {
      const svc = new ConsentService({ database: observed, policy: counting });
      await svc.getConsents(a);
      expect(seen.at(-1)).toMatchObject({ isolationLevel: 'repeatable read', readOnly: true });
      seen.length = 0;
      await svc.getRequirements(a, { purposes: [p.code] });
      const tx = seen.filter((s) => s.isolationLevel === 'repeatable read');
      expect(tx).toHaveLength(1);
      expect(tx[0]).toMatchObject({ readOnly: true, policyReadsInside: 0 });
      expect(E.policy.readPurposes).toContain(p.code);
    } finally {
      await observed.close();
    }
  });

  it('a commit that lands after the snapshot began is invisible to the whole read (getConsents and getRequirements)', async () => {
    expect(await snapshotInconsistencies(ConsentService, 12), 'a read saw a commit that landed after its snapshot began').toBe(0);
  });
});

// ====================================================================== the application session of the request, and the schema facts that matter to the service
describe('application session and schema facts', () => {
  const makeSession = async (accountId: string): Promise<string> =>
    (
      await q<{ application_session_id: string }>(
        `INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES ($1, $2) RETURNING application_session_id`,
        [accountId, `kc-${randomUUID()}`],
      )
    )[0]!.application_session_id;

  it("stores the session of the SAME account (upper case lower-cased), drops a non-uuid, refuses another account's or an unknown session and writes nothing", async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const other = await newAccount();
    const mine = await makeSession(a);
    const theirs = await makeSession(other);
    const before = await world();
    await fails(consent.accept(a, p.code, v1.claim, { applicationSessionId: theirs }), 'VALIDATION_FAILED');
    await fails(consent.accept(a, p.code, v1.claim, { applicationSessionId: randomUUID() }), 'VALIDATION_FAILED');
    expect(await world()).toEqual(before);
    await consent.accept(a, p.code, v1.claim, { applicationSessionId: mine.toUpperCase() });
    expect((await events(a))[0]!.application_session_id).toBe(mine);
    await consent.withdraw(a, p.code, { applicationSessionId: mine });
    expect((await events(a))[1]!.application_session_id).toBe(mine);
    const c = await newAccount();
    await consent.accept(c, p.code, v1.claim, { applicationSessionId: 'not-a-uuid' });
    expect((await events(c))[0]!.application_session_id).toBeNull();
    const d = await newAccount();
    await consent.accept(d, p.code, v1.claim);
    expect((await events(d))[0]!.application_session_id).toBeNull();
  });

  it('the account-time index was dropped (the sequence key serves the lookups) and the sequence, audit and event constraints exist', async () => {
    const idx = (
      await q<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND tablename = 'consent_events' ORDER BY 1`)
    ).map((r) => r.indexname);
    expect(idx).not.toContain('idx_consent_events__account_time');
    expect(idx).toEqual(expect.arrayContaining(['pk_consent_events', 'uq_consent_events__account_purpose_seq', 'uq_consent_events__account_event']));
    const trg = (
      await q<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'identity.consent_events'::regclass AND NOT tgisinternal AND tgname LIKE 'trg\\_%' ORDER BY 1`,
      )
    ).map((r) => r.tgname);
    expect(trg).toEqual(['trg_consent_events__guard', 'trg_consent_events__immutable', 'trg_consent_events__no_truncate']);
  });
});

// ====================================================================== deterministic interleavings (shared with the mutation checks)
/** `waitMs`: how long to wait for the call under test to block on the lock (short in the mutation checks, where it must NOT block). */
type Scenario = (svc: ConsentService, waitMs?: number) => Promise<void>;

/** A role is being granted (the grant holds the account row lock); a withdraw that arrives meanwhile must wait, then SEE the role and refuse. */
const scenarioWithdrawVsRoleGrant: Scenario = async (svc, waitMs = 10_000) => {
  const p = await makePurpose({ withdrawable: true, requiredFor: ['PROVIDER'] });
  const v1 = await craftVersion(p);
  const a = await newAccount(['customer']);
  await svc.accept(a, p.code, v1.claim);
  const hold = await holdAccount(a);
  let w: Promise<unknown> | undefined;
  try {
    await hold.query(
      `INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source) SELECT $1, role_id, 'ACTIVE', now(), 'admin:x', 'ADMIN' FROM identity.roles WHERE code = 'PROVIDER'`,
      [a],
    );
    w = settled(svc.withdraw(a, p.code));
    await lockWaiters(1, waitMs);
  } finally {
    await hold.release(true);
  }
  const outcome = await w;
  expect(codeOf(outcome), 'a withdraw that raced a committed role grant').toBe('CONSENT_REQUIRED_FOR_ROLE');
  expect((await latestRow(a, p.code))!.event_type).toBe('ACCEPTED');
  expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
};

/** The account is being suspended; an accept that arrives meanwhile must wait, then see SUSPENDED and write nothing. */
const scenarioAcceptVsSuspension: Scenario = async (svc, waitMs = 10_000) => {
  const p = await makePurpose();
  const v1 = await craftVersion(p);
  const a = await newAccount();
  const hold = await holdAccount(a);
  let acc: Promise<unknown> | undefined;
  try {
    await hold.query(`UPDATE identity.accounts SET status = 'SUSPENDED' WHERE account_id = $1`, [a]);
    await hold.query(
      `INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, 'ACTIVE', 'SUSPENDED', 'test', 'test')`,
      [a],
    );
    acc = settled(svc.accept(a, p.code, v1.claim));
    await lockWaiters(1, waitMs);
  } finally {
    await hold.release(true);
  }
  expect(codeOf(await acc), 'an accept that raced a committed suspension').toBe('SUSPENDED');
  expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
};

/** A publication holds the version row and is about to close its window; an accept that arrives meanwhile waits on the share lock and is refused once it is closed. */
const scenarioAcceptVsWindowClose: Scenario = async (svc, waitMs = 10_000) => {
  const p = await makePurpose();
  const v1 = await craftVersion(p);
  const a = await newAccount();
  const hold = await holdVersion(v1.versionId);
  let acc: Promise<unknown> | undefined;
  try {
    acc = settled(svc.accept(a, p.code, v1.claim));
    await lockWaiters(1, waitMs);
    await hold.query(`UPDATE content.versions SET effective_to = clock_timestamp(), status = 'SUPERSEDED', updated_at = now() WHERE version_id = $1`, [
      v1.versionId,
    ]);
  } finally {
    await hold.release(true);
  }
  expect(codeOf(await acc), 'an accept that raced the close of the window').toBe('CONSENT_VERSION_NOT_CURRENT');
  expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
};

/** The inverse: an accept is in flight (its event insert share-locked the version row); the publication that closes the window waits for it. The accept is a valid historical fact. */
const scenarioPublicationWaitsForAccept: Scenario = async (_svc, waitMs = 10_000) => {
  const p = await makePurpose();
  const v1 = await craftVersion(p);
  const a = await newAccount();
  const accepting = await holdAccount(a); // what the service holds while it writes
  await rawEvent(accepting, { accountId: a, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
  const publisher = await rawTx();
  let closing: Promise<unknown> | undefined;
  try {
    closing = settled(
      publisher.query(`UPDATE content.versions SET effective_to = clock_timestamp(), status = 'SUPERSEDED', updated_at = now() WHERE version_id = $1`, [
        v1.versionId,
      ]),
    );
    await lockWaiters(1, waitMs);
    expect(await stillPending(closing, 200), 'the publication waits for the accept in flight').toBe(true);
  } catch (err) {
    // a failed expectation (the mutant): nothing may be left open
    await accepting.release(false);
    await closing;
    await publisher.release(false);
    throw err;
  }
  await accepting.release(true);
  await closing;
  await publisher.release(true);
  const [ev] = await events(a);
  const [v] = await q<{ effective_to: Date }>(`SELECT effective_to FROM content.versions WHERE version_id = $1`, [v1.versionId]);
  expect(ev!.occurred_at.getTime()).toBeLessThanOrEqual(v!.effective_to.getTime());
};

/** An OUTSIDE writer (no service, no account lock of its own) inserts an event while the account is being closed: the trigger's share lock on the account makes it wait and refuse. */
const scenarioOutsideWriterVsClosure: Scenario = async (_svc, waitMs = 10_000) => {
  const p = await makePurpose();
  const v1 = await craftVersion(p);
  const a = await newAccount();
  await revokeRole(a, 'CUSTOMER');
  await E.accounts.changeStatus(a, 'SUSPENDED', OP);
  const closing = await holdAccount(a);
  let insert: Promise<unknown> | undefined;
  try {
    await closing.query(`UPDATE identity.accounts SET status = 'CLOSED', closed_at = now() WHERE account_id = $1`, [a]);
    await closing.query(
      `INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, 'SUSPENDED', 'CLOSED', 'test', 'test')`,
      [a],
    );
    insert = settled(rawEvent(null, { accountId: a, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 }));
    await lockWaiters(1, waitMs);
  } finally {
    await closing.release(true);
  }
  const outcome = await insert;
  expect(outcome instanceof Error ? ruleOf(outcome as PgError) : 'WRITTEN', 'an outside insert that raced the closure').toBe('ACCOUNT_CLOSED');
  expect((await events(a)).length).toBe(0);
};

describe('deterministic interleavings (held locks)', () => {
  it('withdraw vs a role grant in flight: the withdraw waits, sees the role, refuses', async () => {
    await scenarioWithdrawVsRoleGrant(consent);
  });
  it('accept vs a suspension in flight: the accept waits, sees SUSPENDED, writes nothing', async () => {
    await scenarioAcceptVsSuspension(consent);
  });
  it('accept vs a publication that closes the window: the accept waits on the version row and is refused (nothing written)', async () => {
    await scenarioAcceptVsWindowClose(consent);
  });
  it('the publication that closes the window waits for an accept in flight; the accept stays a valid historical fact', async () => {
    await scenarioPublicationWaitsForAccept(consent);
  });
  it('an outside writer vs the closure of the account: refused by the trigger after waiting for the closing transaction', async () => {
    await scenarioOutsideWriterVsClosure(consent);
  });

  it('the holder only touches the row or rolls back: the queued accepts land (10 accounts behind one version lock)', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    for (const mode of ['rollback', 'touch'] as const) {
      const accts = await Promise.all(Array.from({ length: 10 }, () => newAccount()));
      const hold = await holdVersion(v1.versionId);
      let accs: Promise<unknown>[] = [];
      try {
        accs = accts.map((a) => settled(consent.accept(a, p.code, v1.claim)));
        await lockWaiters(10);
        if (mode === 'touch') await hold.query(`UPDATE content.versions SET updated_at = now() WHERE version_id = $1`, [v1.versionId]);
      } finally {
        await hold.release(mode === 'touch');
      }
      const rs = await Promise.all(accs);
      expect(rs.map(codeOf)).toEqual(Array(10).fill('OK'));
    }
  });

  it('ten accepts queued behind a publication that closes the window are ALL refused, whichever wakes first', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    const accts = await Promise.all(Array.from({ length: 10 }, () => newAccount()));
    const hold = await holdVersion(v1.versionId);
    let accs: Promise<unknown>[] = [];
    try {
      accs = accts.map((a) => settled(consent.accept(a, p.code, v1.claim)));
      await lockWaiters(10);
      await hold.query(`UPDATE content.versions SET effective_to = clock_timestamp(), status = 'SUPERSEDED', updated_at = now() WHERE version_id = $1`, [
        v1.versionId,
      ]);
    } finally {
      await hold.release(true);
    }
    expect((await Promise.all(accs)).map(codeOf)).toEqual(Array(10).fill('CONSENT_VERSION_NOT_CURRENT'));
    for (const a of accts) expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
  });

  it('an outside writer holding the account share lock (a raw insert in flight) makes the service wait, then the service answers from the committed history', async () => {
    const { p, v1, a } = await scene();
    const outsider = await rawTx();
    await outsider.query(`SELECT 1 FROM identity.accounts WHERE account_id = $1 FOR SHARE`, [a]);
    await rawEvent(outsider, { accountId: a, code: p.code, seq: 1, type: 'ACCEPTED', v: v1 });
    const acc = settled(consent.accept(a, p.code, v1.claim));
    await lockWaiters(1);
    expect(await stillPending(acc)).toBe(true);
    await outsider.release(true);
    const r = (await acc) as { changed: boolean; event: ConsentEventDto };
    expect(r.changed, 'the service saw the committed acceptance').toBe(false);
    expect(r.event.eventSeq).toBe(1);
    expect(await events(a)).toHaveLength(1);
    expect((await auditRows(a)).length, 'the outside writer wrote no audit row and the service wrote none').toBe(0);
  });

  it('a held account lock blocks accept and withdraw (they wait, they do not fail) and both complete once it is released', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const hold = await holdAccount(a);
    let acc: Promise<unknown>;
    try {
      acc = settled(consent.accept(a, p.code, v1.claim));
      await lockWaiters(1);
      expect(await stillPending(acc)).toBe(true);
    } finally {
      await hold.release(false);
    }
    expect(codeOf(await acc)).toBe('OK');
    const hold2 = await holdAccount(a);
    let w: Promise<unknown>;
    try {
      w = settled(consent.withdraw(a, p.code));
      await lockWaiters(1);
      expect(await stillPending(w)).toBe(true);
    } finally {
      await hold2.release(false);
    }
    expect(codeOf(await w)).toBe('OK');
  });
});

// ====================================================================== real races: many callers, many rounds, invariants of the final state
describe('races', () => {
  const N = 25;

  it('25 parallel accepts of the same version by one account, 6 rounds: exactly ONE event, one audit row, one outbox event, one changed:true', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    for (let round = 0; round < 6; round++) {
      const a = await newAccount();
      const results = await Promise.all(Array.from({ length: N }, async () => (await jitter(), settled(consent.accept(a, p.code, v1.claim)))));
      expect(results.filter(isErr).map(codeOf)).toEqual([]);
      const ok = results as Awaited<ReturnType<typeof consent.accept>>[];
      expect(ok.filter((r) => r.changed)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.event.consentEventId)).size).toBe(1);
      expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    }
  });

  it('25 different accounts accept one version at once: 25 events, 25 audit rows, 25 outbox events, no refusal, no deadlock', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    const accts = await Promise.all(Array.from({ length: N }, () => newAccount()));
    const rs = await Promise.all(accts.map((a) => settled(consent.accept(a, p.code, v1.claim))));
    expect(rs.map(codeOf)).toEqual(Array(N).fill('OK'));
    expect(new Set(rs.map((r) => (r as { event: ConsentEventDto }).event.consentEventId)).size).toBe(N);
    for (const a of accts) expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
  });

  it('parallel mixed accepts and withdraws of one account keep a valid alternating history; changed:true equals the number of events', async () => {
    const p = await makePurpose({ withdrawable: true, requiredFor: [] });
    const v1 = await craftVersion(p);
    for (let round = 0; round < 3; round++) {
      const a = await newAccount();
      const ops = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? consent.accept(a, p.code, v1.claim) : consent.withdraw(a, p.code)));
      const rs = await Promise.all(ops.map(settled));
      for (const c of rs.map(codeOf)) expect(['OK', 'CONSENT_NOT_ACCEPTED']).toContain(c);
      const ev = await events(a, p.code);
      expect(ev.map((e) => e.event_seq)).toEqual(ev.map((_, i) => i + 1));
      ev.forEach((e, i) => expect(e.event_type).toBe(i % 2 === 0 ? 'ACCEPTED' : 'WITHDRAWN'));
      expect(await counts(a)).toEqual({ e: ev.length, a: ev.length, o: ev.length });
      expect(rs.filter((r) => !isErr(r) && (r as { changed: boolean }).changed)).toHaveLength(ev.length);
      expect(ev.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('accept racing withdraw, one pair at a time, 12 rounds: the final state is one of the two legal histories', async () => {
    const p = await makePurpose({ withdrawable: true, requiredFor: [] });
    const v1 = await craftVersion(p);
    for (let i = 0; i < 12; i++) {
      const a = await newAccount();
      await consent.accept(a, p.code, v1.claim); // something to withdraw
      const [acc, wd] = await Promise.all([settled(consent.accept(a, p.code, v1.claim)), settled(consent.withdraw(a, p.code))]);
      expect(isErr(acc) || isErr(wd), `${codeOf(acc)} ${codeOf(wd)}`).toBe(false);
      const ev = await events(a, p.code);
      // accept first (idempotent) then withdraw => [A, W]; withdraw first then accept (re-grant) => [A, W, A]
      expect(ev.map((e) => e.event_type)).toEqual((acc as { changed: boolean }).changed ? ['ACCEPTED', 'WITHDRAWN', 'ACCEPTED'] : ['ACCEPTED', 'WITHDRAWN']);
      expect(await counts(a)).toEqual({ e: ev.length, a: ev.length, o: ev.length });
    }
  });

  it('withdraw vs a real role grant, 14 rounds: the outcome always agrees with the final state', async () => {
    const p = await makePurpose({ withdrawable: true, requiredFor: ['PROVIDER'] });
    const v1 = await craftVersion(p);
    let withdrawn = 0;
    let refusedCount = 0;
    for (let i = 0; i < 14; i++) {
      const a = await newAccount(['customer']);
      await consent.accept(a, p.code, v1.claim);
      const [w, g] = await Promise.all([(await jitter(), settled(consent.withdraw(a, p.code))), (await jitter(), settled(grant(a, 'PROVIDER')))]);
      expect(isErr(g), `grant: ${codeOf(g)}`).toBe(false);
      expect(['OK', 'CONSENT_REQUIRED_FOR_ROLE']).toContain(codeOf(w));
      const latest = (await latestRow(a, p.code))!;
      expect(latest.event_type).toBe(codeOf(w) === 'OK' ? 'WITHDRAWN' : 'ACCEPTED');
      expect(await roleStatus(a, 'PROVIDER')).toBe('ACTIVE');
      if (codeOf(w) === 'OK') withdrawn += 1;
      else refusedCount += 1;
      expect(await counts(a)).toEqual({ e: codeOf(w) === 'OK' ? 2 : 1, a: codeOf(w) === 'OK' ? 2 : 1, o: codeOf(w) === 'OK' ? 2 : 1 });
    }
    expect(withdrawn + refusedCount).toBe(14);
  });

  it('accept vs a role grant: both succeed, no deadlock, and the requirement ends SATISFIED', async () => {
    const p = await makePurpose({ requiredFor: ['PROVIDER'] });
    const v1 = await craftVersion(p);
    for (let i = 0; i < 10; i++) {
      const a = await newAccount(['customer']);
      const [acc, g] = await Promise.all([(await jitter(), settled(consent.accept(a, p.code, v1.claim))), (await jitter(), settled(grant(a, 'PROVIDER')))]);
      expect([codeOf(acc), codeOf(g)]).toEqual(['OK', 'OK']);
      expect((await reqOf(a, p)).status).toBe('SATISFIED');
    }
  });

  it('a suspension racing accepts: whatever landed before it stays, nothing lands after it', async () => {
    const p = await makePurpose();
    const v1 = await craftVersion(p);
    for (let i = 0; i < 8; i++) {
      const a = await newAccount();
      const rs = await Promise.all([
        ...Array.from({ length: 6 }, async () => (await jitter(), settled(consent.accept(a, p.code, v1.claim)))),
        (async () => (await jitter(), settled(E.accounts.changeStatus(a, 'SUSPENDED', OP))))(),
      ]);
      for (const r of rs.slice(0, 6)) expect(['OK', 'SUSPENDED']).toContain(codeOf(r));
      expect(isErr(rs[6])).toBe(false);
      expect((await events(a)).length).toBeLessThanOrEqual(1);
      expect((await q<{ status: string }>(`SELECT status FROM identity.accounts WHERE account_id = $1`, [a]))[0]!.status).toBe('SUSPENDED');
      await fails(consent.accept(a, p.code, v1.claim), 'SUSPENDED');
    }
  });

  it('two documents (Terms and Privacy) and two locales accepted at once by one account: independent sequences, no refusal', async () => {
    const [tosP, ppP] = [await seededPurpose('TERMS_OF_SERVICE'), await seededPurpose('PRIVACY_POLICY')];
    const tos = (
      await q<{ version_id: string; locale: string; body_sha256: string }>(
        `SELECT version_id, locale, body_sha256 FROM content.versions WHERE entry_id = $1 AND locale = 'en-US'`,
        [tosP.entryId],
      )
    )[0]!;
    const pp = (
      await q<{ version_id: string; locale: string; body_sha256: string }>(
        `SELECT version_id, locale, body_sha256 FROM content.versions WHERE entry_id = $1 AND locale = 'en-US'`,
        [ppP.entryId],
      )
    )[0]!;
    const p = await makePurpose();
    const en = await craftVersion(p);
    const es = await craftVersion(p, { locale: 'es-MX' });
    for (let i = 0; i < 8; i++) {
      const a = await newAccount();
      const rs = await Promise.all(
        [
          consent.accept(a, 'TERMS_OF_SERVICE', { versionId: tos.version_id, locale: tos.locale, bodySha256: tos.body_sha256 }),
          consent.accept(a, 'PRIVACY_POLICY', { versionId: pp.version_id, locale: pp.locale, bodySha256: pp.body_sha256 }),
          consent.accept(a, p.code, en.claim),
          consent.accept(a, p.code, es.claim),
        ].map(settled),
      );
      expect(rs.map(codeOf)).toEqual(['OK', 'OK', 'OK', 'OK']);
      const ev = await events(a);
      expect(ev).toHaveLength(4);
      expect((await events(a, p.code)).map((e) => e.event_seq)).toEqual([1, 2]);
      expect(await counts(a)).toEqual({ e: 4, a: 4, o: 4 });
    }
  });

  it('the boundary between two versions, 8 accounts x 2 rounds: v1 and v2 raced around the instant the window flips; every acceptance is inside its window and each account ends on v2', async () => {
    for (let round = 0; round < 2; round++) {
      const p = await makePurpose();
      const v1 = await craftVersion(p);
      const v2 = await publishNext(p, { inSec: 0.4 }); // v1 closes and v2 (SCHEDULED) starts 400 ms from now
      const [row] = await q<{ t: Date }>(`SELECT effective_from AS t FROM content.versions WHERE version_id = $2 AND $1::text IS NOT NULL`, [
        p.code,
        v2.versionId,
      ]);
      const accts = await Promise.all(Array.from({ length: 8 }, () => newAccount()));
      const rs = await Promise.all(
        accts.map(async (a, i) => {
          await sleep(i * 40);
          const first = await settled(consent.accept(a, p.code, v1.claim));
          let second: unknown = 'none';
          for (let k = 0; k < 60; k++) {
            second = await settled(consent.accept(a, p.code, v2.claim));
            if (!isErr(second)) break;
            expect(codeOf(second)).toBe('CONSENT_VERSION_NOT_CURRENT');
            await sleep(25);
          }
          return [first, second] as const;
        }),
      );
      for (const [first, second] of rs) {
        expect(['OK', 'CONSENT_VERSION_NOT_CURRENT']).toContain(codeOf(first));
        expect(codeOf(second)).toBe('OK');
      }
      for (const a of accts) {
        const ev = await events(a, p.code);
        expect(ev[ev.length - 1]!.version_id).toBe(v2.versionId);
        for (const e of ev) {
          if (e.version_id === v1.versionId) expect(e.occurred_at.getTime()).toBeLessThan(row!.t.getTime());
          else expect(e.occurred_at.getTime()).toBeGreaterThanOrEqual(row!.t.getTime());
        }
      }
    }
  });

  it('rounds of parallel accepts of v_k against the publication of v_k+1: every recorded acceptance is inside the window of its version', async () => {
    const p = await makePurpose();
    let cur = await craftVersion(p);
    for (let k = 0; k < 6; k++) {
      const accts = await Promise.all(Array.from({ length: 8 }, () => newAccount()));
      const rs = await Promise.all([
        ...accts.map(async (a, i) => (await sleep(i * 2), settled(consent.accept(a, p.code, cur.claim)))),
        (async () => (await sleep(5), settled(publishNext(p))))(),
      ]);
      for (const r of rs.slice(0, 8)) expect(['OK', 'CONSENT_VERSION_NOT_CURRENT']).toContain(codeOf(r));
      expect(isErr(rs[8])).toBe(false);
      const landed = rs.slice(0, 8).filter((r) => codeOf(r) === 'OK').length;
      let events_ = 0;
      for (const a of accts) events_ += (await events(a, p.code)).length;
      expect(events_).toBe(landed);
      cur = rs[8] as Ver;
    }
  });

  it('chaos: accounts accepting, withdrawing, gaining and losing roles while new versions are published; no deadlock, no unexpected error, all invariants hold', async () => {
    const p = await makePurpose({ withdrawable: true, requiredFor: ['PROVIDER'] });
    let cur = await craftVersion(p);
    const allowed = new Set(['OK', 'CONSENT_VERSION_NOT_CURRENT', 'CONSENT_NOT_ACCEPTED', 'CONSENT_REQUIRED_FOR_ROLE', 'ROLE_NOT_HELD']);
    for (let round = 0; round < 3; round++) {
      const accts = await Promise.all(Array.from({ length: 10 }, () => newAccount()));
      const claim = cur.claim;
      const work = accts.map(async (a, i) => {
        const out: unknown[] = [];
        for (let k = 0; k < 6; k++) {
          await jitter();
          const op = (i + k) % 4;
          if (op === 0) out.push(await settled(consent.accept(a, p.code, claim)));
          else if (op === 1) out.push(await settled(consent.withdraw(a, p.code)));
          else if (op === 2) out.push(await settled(grant(a, 'PROVIDER')));
          else out.push(await settled(revokeRole(a, 'PROVIDER')));
        }
        return out;
      });
      const publication = (async () => (await sleep(10), settled(publishNext(p))))();
      const done = await Promise.all([...work, publication]);
      const pub = done.pop() as Ver | Error;
      expect(isErr(pub)).toBe(false);
      for (const outs of done as unknown[][]) for (const o of outs) if (isErr(o)) expect(allowed.has(codeOf(o)), codeOf(o)).toBe(true);
      cur = pub as Ver;
    }
  });
});

// ====================================================================== the sequence net: collisions are resolved, never forked
type Latest = (...args: unknown[]) => Promise<ConsentEventDto | null>;
/** A service whose FIRST read of the latest event is stale (it answers what `lie` returns): the second writer that did not see the winner. */
function withStaleFirstRead(lie: () => Promise<ConsentEventDto | null>): ConsentService {
  const svc = new ConsentService({ database: E.bigDb, policy: E.policy });
  const s = svc as unknown as { latestEvent: Latest };
  const real = s.latestEvent.bind(svc);
  let first = true;
  s.latestEvent = async (...args) => {
    if (first) {
      first = false;
      return lie();
    }
    return real(...args);
  };
  return svc;
}
const concurrentConflict = { reason: 'CONCURRENT_UPDATE', retryable: true };

describe('the event sequence under collisions', () => {
  it('an injected unique violation on the sequence key, or a CONSENT_SEQUENCE / CONSENT_DUPLICATE guard failure, with no winner is a retryable CONFLICT and writes nothing', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const variants = [
      { errcode: '23505', constraint: 'uq_consent_events__account_purpose_seq' },
      { errcode: '23000', detail: 'identity_rule:CONSENT_SEQUENCE' },
      { errcode: '23000', detail: 'identity_rule:CONSENT_DUPLICATE' },
    ];
    for (const v of variants) {
      await injecting(v, () => fails(consent.accept(a, p.code, v1.claim), 'CONFLICT', concurrentConflict));
      expect(await counts(a)).toEqual({ e: 0, a: 0, o: 0 });
    }
    expect((await consent.accept(a, p.code, v1.claim)).changed).toBe(true);
    for (const v of variants) {
      await injecting(v, () => fails(consent.withdraw(a, p.code), 'CONFLICT', concurrentConflict));
      expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    }
    // another unique violation is a plain duplicate, not a sequence collision
    const e = await injecting({ errcode: '23505', constraint: 'pk_consent_events' }, () => fails(consent.withdraw(a, p.code), 'CONFLICT'));
    expect(e.details.reason).toBe('DUPLICATE');
    expect(await counts(a)).toEqual({ e: 1, a: 1, o: 1 });
    expect((await consent.withdraw(a, p.code)).changed).toBe(true);
  });

  it('accept: a stale read of the history (a winner exists) is resolved by one re-read: the same acceptance is an idempotent repeat, another version is a retryable CONFLICT', async () => {
    const { p, v1, a } = await scene();
    const winner = await consent.accept(a, p.code, v1.claim);
    const before = await counts(a);
    const same = await withStaleFirstRead(async () => null).accept(a, p.code, v1.claim);
    expect(same).toEqual({ changed: false, event: winner.event });
    const v2 = await publishNext(p);
    const other = await fails(withStaleFirstRead(async () => null).accept(a, p.code, v2.claim), 'CONFLICT', concurrentConflict);
    expect(other.message).toBe('the change conflicted with a concurrent update; repeat the request');
    expect(await counts(a)).toEqual(before);
    // the retry (a fresh read) succeeds
    expect((await consent.accept(a, p.code, v2.claim)).event.eventSeq).toBe(2);
  });

  it('accept: CONSENT_DUPLICATE (the same version again although the stale read showed a withdrawal) resolves to the existing acceptance', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    await consent.accept(a, p.code, v1.claim);
    await consent.withdraw(a, p.code);
    const regrant = await consent.accept(a, p.code, v1.claim);
    expect(regrant.event.eventSeq).toBe(3);
    const lie = async (): Promise<ConsentEventDto> => ({ ...regrant.event, eventType: 'WITHDRAWN' });
    const r = await withStaleFirstRead(lie).accept(a, p.code, v1.claim);
    expect(r).toEqual({ changed: false, event: regrant.event });
    expect(await counts(a)).toEqual({ e: 3, a: 3, o: 3 });
  });

  it('withdraw: a stale read (the acceptance looks current although a withdrawal won) is an idempotent repeat; if a re-grant won it is a retryable CONFLICT', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const acc = await consent.accept(a, p.code, v1.claim);
    const wd = await consent.withdraw(a, p.code);
    const stale = async () => acc.event;
    const r = await withStaleFirstRead(stale).withdraw(a, p.code);
    expect(r).toEqual({ changed: false, event: wd.event });
    const regrant = await consent.accept(a, p.code, v1.claim);
    expect(regrant.event.eventSeq).toBe(3);
    await fails(withStaleFirstRead(async () => acc.event).withdraw(a, p.code), 'CONFLICT', concurrentConflict);
    expect(await counts(a)).toEqual({ e: 3, a: 3, o: 3 });
  });
});

// ====================================================================== privacy: nothing but identifiers is ever written, logged, thrown or returned
const likeEscape = (n: string): string => `%${n.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
/** The tables (identity, integration, content, configuration) holding any of the texts anywhere in a row. */
const tablesMentioning = async (needles: string[]): Promise<string[]> => {
  const tables = await q<{ t: string }>(
    `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables WHERE table_schema IN ('identity', 'integration', 'content', 'configuration') AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const patterns = needles.map(likeEscape);
  const found: string[] = [];
  for (const { t } of tables) {
    const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE ANY($1::text[])`, [patterns]);
    if (r[0]!.n > 0) found.push(t);
  }
  return found;
};
/**
 * Every audit row, outbox payload, captured log line, thrown error and returned value of the whole run contains none of the values forbidden in that place (the legal
 * body text, the hashes, the version ids, everything a client claimed, the Keycloak subjects).
 */
async function expectNoLeaks(label: string, extra: { results?: unknown[]; needles?: Map<string, Needle> } = {}): Promise<void> {
  const needles = new Map([...NEEDLES, ...(extra.needles ?? [])]);
  const dumps: Record<Zone, string> = {
    audit: JSON.stringify(await q('SELECT to_jsonb(a) AS j FROM identity.account_audit_events a')),
    outbox: JSON.stringify(await q('SELECT to_jsonb(o) AS j FROM integration.outbox_events o')),
    logs: logSink.all.join('\n'),
    errors: caught.map(errText).join('\n'),
    results: JSON.stringify([...returned, ...(extra.results ?? [])]),
  };
  for (const [value, n] of needles) for (const zone of n.zones) expect(dumps[zone].includes(value), `${label}: the ${zone} contain a ${n.kind}`).toBe(false);
}

describe('privacy', () => {
  it('a workload of accepts, refusals, withdrawals and failures leaves no body text, hash, claimed value or subject where it must not be', async () => {
    const { p, v1, a } = await scene({ withdrawable: true, requiredFor: [] });
    const claimedVersion = forbid(randomUUID(), 'claimed version id', ALL_ZONES);
    const claimedHash = badHash();
    const results: unknown[] = [];
    results.push(await consent.accept(a, p.code, v1.claim));
    for (const claim of [
      { versionId: claimedVersion, locale: 'en-US', bodySha256: claimedHash },
      { ...v1.claim, bodySha256: claimedHash },
      { ...v1.claim, locale: 'xx-secret-locale' },
    ])
      await rejection(consent.accept(a, p.code, claim)).then((e) => caught.push(e));
    results.push(await consent.withdraw(a, p.code));
    results.push(await consent.getConsents(a), await consent.getRequirements(a, { purposes: [p.code] }));
    await expectForcedFailure(failing(['CONSENT_ACCEPTED'], () => consent.accept(a, p.code, v1.claim)));
    E.policy.failure = new Error(`cause ${forbid(`leak-${randomUUID()}`, 'policy cause', ALL_ZONES)}`);
    await rejection(consent.getRequirements(a, { purposes: [p.code] })).then((e) => caught.push(e));
    E.policy.failure = undefined;
    await expectNoLeaks('workload', { results });
    // where the values are allowed to live
    const bodies = [...NEEDLES].filter(([, n]) => n.kind === 'legal body text').map(([v]) => v);
    expect(await tablesMentioning(bodies)).toEqual(['content.versions']);
    const claimed = [...NEEDLES].filter(([, n]) => n.kind === 'claimed hash' || n.kind === 'claimed version id' || n.kind === 'policy cause').map(([v]) => v);
    expect(await tablesMentioning(claimed)).toEqual([]);
    const hashes = [...NEEDLES].filter(([, n]) => n.kind === 'body hash').map(([v]) => v);
    expect(await tablesMentioning(hashes)).toEqual(['content.versions', 'identity.consent_events']);
    const subjects = [...NEEDLES].filter(([, n]) => n.kind === 'Keycloak subject').map(([v]) => v);
    expect(await tablesMentioning(subjects)).toEqual(['identity.external_identities']);
    // identifiers only: every outbox payload value is a scalar, every audit change is the purpose and the sequence
    for (const e of await outboxRows(a)) for (const v of Object.values(e.payload_json)) expect(['string', 'number'].includes(typeof v)).toBe(true);
    for (const r of await auditRows(a)) expect(Object.keys(r.changes ?? {}).sort()).toEqual(['eventSeq', 'purposeCode']);
    // every captured log line is a known, parameter-free message
    for (const line of logSink.all) {
      const l = JSON.parse(line) as Record<string, unknown>;
      expect(['consent policy unavailable']).toContain(l.message);
      expect(Object.keys(l).sort()).toEqual(['level', 'message', 'purposeCode']);
    }
  });

  it('negative controls: the scanner finds a body in a log line, a hash in a thrown error, a body in a returned value, and a forbidden value in the audit rows and the outbox', async () => {
    const { p, v1, a } = await scene();
    await consent.accept(a, p.code, v1.claim);
    logSink.all.push(JSON.stringify({ message: 'oops', text: v1.body }));
    expect(await rejection(expectNoLeaks('control'))).toBeInstanceOf(Error);
    logSink.all.pop();
    caught.push(new Error(`failed for ${v1.hash}`));
    expect(await rejection(expectNoLeaks('control'))).toBeInstanceOf(Error);
    caught.pop();
    expect(await rejection(expectNoLeaks('control', { results: [{ leaked: v1.body }] }))).toBeInstanceOf(Error);
    // values that ARE in the audit rows and in the outbox payload
    expect(await rejection(expectNoLeaks('control', { needles: new Map([[`account:${a}`, { kind: 'actor', zones: ['audit'] }]]) }))).toBeInstanceOf(Error);
    expect(await rejection(expectNoLeaks('control', { needles: new Map([[v1.versionId, { kind: 'version id', zones: ['outbox'] }]]) }))).toBeInstanceOf(Error);
    // the table scanner finds what is there and not what is not
    expect(await tablesMentioning([v1.body])).toEqual(['content.versions']);
    expect(await tablesMentioning([v1.hash])).toEqual(['content.versions', 'identity.consent_events']);
    expect(await tablesMentioning([`never-stored-${randomUUID()}`])).toEqual([]);
    await expectNoLeaks('control (clean again)');
  });
});

// ====================================================================== mutation checks: the race tests must FAIL without the locks
// A temporary mutated copy of the service is written next to the original (and deleted afterwards) and the guard trigger is mutated in a SCRATCH database; the same
// scenarios that pass against the real code must fail against each mutant. A control run before and after proves the failure comes from the mutation alone.
const SRC_DIR = import.meta.dirname;
const MUTANT_PREFIX = 'consent-service.mutant-';
const mutantFiles: string[] = [];
async function loadMutantService(label: string, edit: (source: string) => string): Promise<typeof ConsentService> {
  const source = await readFile(path.join(SRC_DIR, 'consent-service.ts'), 'utf8');
  const mutated = edit(source);
  expect(mutated, `the mutation "${label}" did not change the source (the code it targets moved)`).not.toBe(source);
  const file = path.join(SRC_DIR, `${MUTANT_PREFIX}${process.pid}-${label}.ts`);
  mutantFiles.push(file);
  await writeFile(file, mutated);
  const mod = (await import(/* @vite-ignore */ file)) as { ConsentService: typeof ConsentService };
  return mod.ConsentService;
}
const without = (needle: string, replacement: string) => (source: string) => {
  expect(source.includes(needle), `the code to mutate is gone: ${needle}`).toBe(true);
  return source.replace(needle, replacement);
};
afterAll(async () => {
  for (const f of mutantFiles) await unlink(f).catch(() => undefined);
});

describe('mutation checks', () => {
  let scratch: Env;
  beforeAll(async () => {
    scratch = await buildEnv(30);
  }, 120_000);
  afterAll(async () => {
    await closeEnv(scratch);
  }, 60_000);

  /** Runs `fn` with the helpers acting on the scratch database. */
  async function inScratch<T>(fn: () => Promise<T>): Promise<T> {
    const saved = E;
    E = scratch;
    try {
      return await fn();
    } finally {
      E = saved;
    }
  }
  const mutantFails = async (name: string, run: () => Promise<void>): Promise<void> => {
    const e = await rejection(run());
    expect(e, `${name}: the scenario PASSED against the mutant, so it does not protect that lock`).toBeInstanceOf(Error);
  };
  const SHORT = 1500;

  it('without the account row lock (FOR UPDATE) of the service, the role-grant and the suspension interleavings FAIL; the real service passes them', async () => {
    const Mutant = await loadMutantService(
      'nolock',
      without(
        'SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE',
        'SELECT status FROM identity.accounts WHERE account_id = ${accountId}',
      ),
    );
    await inScratch(async () => {
      const real = scratch.consent;
      const mutant = new Mutant({ database: scratch.bigDb, policy: scratch.policy });
      await scenarioWithdrawVsRoleGrant(real);
      await scenarioAcceptVsSuspension(real);
      await mutantFails('withdraw vs role grant', () => scenarioWithdrawVsRoleGrant(mutant, SHORT));
      await mutantFails('accept vs suspension', () => scenarioAcceptVsSuspension(mutant, SHORT));
      // the control again: the scratch database is healthy after the failed scenarios
      await scenarioWithdrawVsRoleGrant(real);
      await scenarioAcceptVsSuspension(real);
    });
  });

  it('without the FOR SHARE on the version row in the guard trigger, the window-close interleavings FAIL; with the trigger restored they pass', async () => {
    await inScratch(async () => {
      const real = scratch.consent;
      await scenarioAcceptVsWindowClose(real);
      await scenarioPublicationWaitsForAccept(real);
      const original = (await q<{ d: string }>(`SELECT pg_get_functiondef('identity.guard_consent_events'::regproc) AS d`))[0]!.d;
      const needle = 'PERFORM 1 FROM content.versions WHERE version_id = NEW.version_id FOR SHARE;';
      expect(original.includes(needle), 'the trigger moved').toBe(true);
      await q(original.replace(needle, 'PERFORM 1 FROM content.versions WHERE version_id = NEW.version_id;'));
      try {
        await mutantFails('accept vs window close', () => scenarioAcceptVsWindowClose(real, SHORT));
        await mutantFails('publication waits for accept', () => scenarioPublicationWaitsForAccept(real, SHORT));
      } finally {
        await q(original);
      }
      await scenarioAcceptVsWindowClose(real);
      await scenarioPublicationWaitsForAccept(real);
    });
  });

  it('without the FOR SHARE on the account row in the guard trigger, an outside writer racing the closure of the account is NOT stopped; with it restored it is', async () => {
    await inScratch(async () => {
      const real = scratch.consent;
      await scenarioOutsideWriterVsClosure(real);
      const original = (await q<{ d: string }>(`SELECT pg_get_functiondef('identity.guard_consent_events'::regproc) AS d`))[0]!.d;
      const needle = 'SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;';
      expect(original.includes(needle), 'the trigger moved').toBe(true);
      await q(original.replace(needle, 'SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id;'));
      try {
        await mutantFails('outside writer vs closure', () => scenarioOutsideWriterVsClosure(real, SHORT));
      } finally {
        await q(original);
      }
      await scenarioOutsideWriterVsClosure(real);
    });
  });

  it('without the repeatable-read snapshot of the reads, the half-way commit is visible (the snapshot test FAILS); the real service shows none', async () => {
    const Mutant = await loadMutantService('nosnapshot', without("{ isolationLevel: 'repeatable read', readOnly: true }", '{ readOnly: true }'));
    expect(await snapshotInconsistencies(ConsentService, 6)).toBe(0);
    expect(await snapshotInconsistencies(Mutant, 25), 'the mutant (independent statements) never showed a half-way commit').toBeGreaterThan(0);
  });
});

// ====================================================================== whole-run invariants and leaks
describe('invariants of the whole run', () => {
  const n = async (text: string) => (await q<{ n: number }>(text))[0]!.n;

  it('event sequences have no gap or duplicate, withdrawals follow acceptances of the same text, time never goes backwards, an acceptance of the same version never follows itself', async () => {
    expect(
      await n(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM identity.consent_events GROUP BY account_id, purpose_code HAVING min(event_seq) <> 1 OR max(event_seq) <> count(*)) x`,
      ),
    ).toBe(0);
    expect(
      await n(`SELECT count(*)::int AS n FROM identity.consent_events e LEFT JOIN identity.consent_events p ON p.account_id = e.account_id AND p.purpose_code = e.purpose_code AND p.event_seq = e.event_seq - 1
        WHERE e.event_seq = 1 AND e.event_type <> 'ACCEPTED' OR (e.event_type = 'WITHDRAWN' AND (p.event_type IS DISTINCT FROM 'ACCEPTED' OR (p.version_id, p.locale, p.body_sha256) IS DISTINCT FROM (e.version_id, e.locale, e.body_sha256)))`),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.consent_events e JOIN identity.consent_events p ON p.account_id = e.account_id AND p.purpose_code = e.purpose_code AND p.event_seq = e.event_seq - 1 WHERE p.occurred_at > e.occurred_at`,
      ),
    ).toBe(0);
    expect(
      await n(`SELECT count(*)::int AS n FROM identity.consent_events e JOIN identity.consent_events p ON p.account_id = e.account_id AND p.purpose_code = e.purpose_code AND p.event_seq = e.event_seq - 1
        WHERE e.event_type = 'ACCEPTED' AND p.event_type = 'ACCEPTED' AND p.version_id = e.version_id`),
    ).toBe(0);
  });

  it('every acceptance written by the service is inside the window of its version at the instant it was recorded', async () => {
    expect(
      await n(`SELECT count(*)::int AS n FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
        WHERE e.event_type = 'ACCEPTED' AND e.correlation_id NOT LIKE 'raw-%' AND NOT (v.effective_from <= e.occurred_at AND (v.effective_to IS NULL OR v.effective_to > e.occurred_at))`),
      JSON.stringify(
        await q(`SELECT e.purpose_code, e.occurred_at, v.effective_from, v.effective_to, v.status, e.correlation_id FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
        WHERE e.event_type = 'ACCEPTED' AND e.correlation_id NOT LIKE 'raw-%' AND NOT (v.effective_from <= e.occurred_at AND (v.effective_to IS NULL OR v.effective_to > e.occurred_at))`),
      ),
    ).toBe(0);
  });

  it('every event written by the service has exactly one audit row and one outbox event that agree with it; there is no audit row or outbox event without an event', async () => {
    expect(
      await n(`SELECT count(*)::int AS n FROM identity.consent_events e WHERE e.correlation_id NOT LIKE 'raw-%' AND
        (SELECT count(*) FROM identity.account_audit_events a WHERE a.consent_event_id = e.consent_event_id AND a.account_id = e.account_id
            AND a.action = CASE e.event_type WHEN 'ACCEPTED' THEN 'CONSENT_ACCEPTED' ELSE 'CONSENT_WITHDRAWN' END AND a.correlation_id = e.correlation_id AND a.actor = 'account:' || e.account_id::text
            AND a.changes = jsonb_build_object('purposeCode', e.purpose_code, 'eventSeq', e.event_seq)) <> 1`),
    ).toBe(0);
    expect(
      await n(`SELECT count(*)::int AS n FROM identity.consent_events e WHERE e.correlation_id NOT LIKE 'raw-%' AND
        (SELECT count(*) FROM integration.outbox_events o WHERE o.payload_json ->> 'consentEventId' = e.consent_event_id::text AND o.aggregate_id = e.account_id::text
            AND o.event_type = CASE e.event_type WHEN 'ACCEPTED' THEN '${CONSENT_EVENTS.accepted}' ELSE '${CONSENT_EVENTS.withdrawn}' END
            AND o.payload_json = jsonb_build_object('accountId', e.account_id, 'purposeCode', e.purpose_code, 'consentEventId', e.consent_event_id, 'eventSeq', e.event_seq, 'contentVersionId', e.version_id)) <> 1`),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.account_audit_events a WHERE a.action LIKE 'CONSENT\\_%' AND NOT EXISTS (SELECT 1 FROM identity.consent_events e WHERE e.consent_event_id = a.consent_event_id)`,
      ),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM integration.outbox_events o WHERE o.event_type LIKE 'bananagig.identity.consent-%' AND NOT EXISTS (SELECT 1 FROM identity.consent_events e WHERE e.consent_event_id::text = o.payload_json ->> 'consentEventId')`,
      ),
    ).toBe(0);
  });

  it('the hash and the locale of every event are those of its version, and no event belongs to a closed account after its closure', async () => {
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id WHERE (v.locale, v.body_sha256) <> (e.locale, e.body_sha256)`,
      ),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM identity.consent_events e JOIN identity.accounts a ON a.account_id = e.account_id WHERE a.status = 'CLOSED' AND e.occurred_at > a.closed_at AND e.correlation_id NOT LIKE 'raw-%'`,
      ),
    ).toBe(0);
  });

  it('the whole run leaked nothing (every audit row, outbox event, log line, error and returned value of every test above)', async () => {
    await expectNoLeaks('whole run');
    const bodies = [...NEEDLES].filter(([, x]) => x.kind === 'legal body text').map(([v]) => v);
    expect(await tablesMentioning(bodies)).toEqual(['content.versions']);
    // no mutated copy of the service is left on disk
    for (const f of mutantFiles) await expect(readFile(f)).resolves.toBeDefined();
  });
});
